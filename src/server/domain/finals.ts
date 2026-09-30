import { basename, extname } from 'node:path';
import { and, desc, eq, inArray, lt } from 'drizzle-orm';
import type { Db } from '../db/client.js';
import { photos, picks, comments, events } from '../db/schema.js';
import { ProjectMeta } from './meta.js';
import { sniffBytes, sha256 } from '../media/sniff.js';
import { photoKey, type Storage } from '../storage.js';
import { getSetting } from '../db/settings.js';
import { enqueue } from '../jobs/queue.js';
import { newId } from '../ids.js';
import { addComment } from './comments.js';
import { project as projectRow } from './selection.js';

export class FinalsError extends Error { constructor(public code: 'invalid' | 'not_found' | 'live_until_published' | 'unsupported' | 'too_large') { super(code); this.name = 'FinalsError'; } }
const OK_EXT = new Set(['.jpg', '.jpeg', '.png']);
const project = (db: Db, id: string) => projectRow(db, id).catch(() => { throw new FinalsError('not_found'); });

/** Upload a rendered final as a draft keyed to its source RAW. Names never collide across sources; re-uploads replace the same source's draft. */
export async function uploadFinal(db: Db, storage: Storage, o: { projectId: string; name: string; bytes: Uint8Array; sourcePhotoId?: string | null; uploadId: string; checksum?: string; actor: string }) {
  const p = await project(db, o.projectId); const meta = ProjectMeta.parse(p.metadataJson);
  const name = basename(o.name.replace(/\\/g, '/')).replace(/^\.+/, '').trim(); const ext = extname(name).toLowerCase();
  if (!name || !OK_EXT.has(ext) || !o.uploadId) throw new FinalsError('invalid');
  const lim = (await getSetting<{ mediaBytes?: number }>(db, 'limits'))?.mediaBytes ?? 20 * 1024 ** 3; if (o.bytes.byteLength > lim) throw new FinalsError('too_large');
  const [source] = o.sourcePhotoId ? await db.select().from(photos).where(and(eq(photos.id, o.sourcePhotoId), eq(photos.projectId, o.projectId), eq(photos.stage, 'culling'))).limit(1) : [];
  if (o.sourcePhotoId && !source) throw new FinalsError('not_found');
  const sn = sniffBytes(o.bytes, name); if (!sn || sn.kind !== 'photo') throw new FinalsError('unsupported');
  const finalsRoot = meta.folders.finals;
  const rows = await db.select().from(photos).where(and(eq(photos.projectId, o.projectId), eq(photos.stage, 'final')));
  // choose the live path: the same source may replace its own final; a different source gets a suffixed name
  const stem = name.slice(0, -ext.length);
  let livePath = `${finalsRoot}/${name}`; let n = 2;
  let existing = rows.find((r) => r.relPath === livePath);
  while (existing && (existing.sourcePhotoId ?? null) !== (source?.id ?? null)) { livePath = `${finalsRoot}/${stem} (${n++})${ext}`; existing = rows.find((r) => r.relPath === livePath); }
  const draftPath = `${finalsRoot}/.draft/${basename(livePath)}`;
  const checksum = sha256(o.bytes);
  if (existing && existing.draftRelPath === draftPath && existing.checksum === checksum) return { photoId: existing.id, relPath: livePath, draftRelPath: draftPath, replaced: false, idempotent: true };
  let photoId: string; let replaced = false;
  if (existing) {
    photoId = existing.id; replaced = true;
    await db.update(photos).set({ draftRelPath: draftPath, checksum, sourcePhotoId: source?.id ?? existing.sourcePhotoId }).where(eq(photos.id, existing.id));
  } else {
    photoId = newId();
    await db.insert(photos).values({ id: photoId, projectId: o.projectId, relPath: livePath, draftRelPath: draftPath, live: false, stage: 'final', kind: 'photo', sourcePhotoId: source?.id ?? null, checksum });
  }
  await storage.put(photoKey(p.studioId, photoId, 'draft'), o.bytes, sn.format === 'png' ? 'image/png' : 'image/jpeg');
  await enqueue(db, { kind: 'preview', payload: { photoId }, idempotencyKey: `preview:${photoId}:${checksum}:d` });
  await db.insert(events).values({ projectId: o.projectId, actor: o.actor, type: 'final_uploaded', payload: { photoId, uploadId: o.uploadId, relPath: livePath, replaced } });
  return { photoId, relPath: livePath, draftRelPath: draftPath, replaced, idempotent: false };
}

/** A draft that was never published can be withdrawn; a live final waits for publication tooling. */
export async function deleteFinal(db: Db, storage: Storage, o: { projectId: string; photoId: string; actor: string }): Promise<void> {
  const p = await project(db, o.projectId);
  const [row] = await db.select().from(photos).where(and(eq(photos.id, o.photoId), eq(photos.projectId, o.projectId), eq(photos.stage, 'final'))).limit(1);
  if (!row) throw new FinalsError('not_found');
  if (row.live) throw new FinalsError('live_until_published');
  await db.delete(comments).where(eq(comments.photoId, row.id));
  await db.delete(photos).where(eq(photos.id, row.id));
  await db.insert(events).values({ projectId: o.projectId, actor: o.actor, type: 'final_removed', payload: { photoId: row.id, relPath: row.relPath } });
  for (const v of ['original', 'draft', 'preview', 'thumb', 'preview.draft', 'thumb.draft'] as const) await storage.delete(photoKey(p.studioId, row.id, v));
}

/** Initial lookup: project-relative paths → photo ids. Case-sensitive, exact. */
export async function resolvePaths(db: Db, projectId: string, paths: string[]): Promise<Record<string, string | null>> {
  const rows = await db.select({ id: photos.id, relPath: photos.relPath }).from(photos).where(eq(photos.projectId, projectId));
  const byPath = new Map(rows.map((r) => [r.relPath, r.id]));
  return Object.fromEntries(paths.map((p) => [p, byPath.get(p.replace(/\\/g, '/').replace(/^\/+/, '')) ?? null]));
}

export async function pluginPicks(db: Db, projectId: string) {
  const p = await project(db, projectId);
  const rows = await db.select({ photoId: picks.photoId, round: picks.round, relPath: photos.relPath }).from(picks).innerJoin(photos, eq(photos.id, picks.photoId))
    .where(and(eq(picks.projectId, projectId), lt(picks.round, p.currentRound), eq(picks.state, 'confirmed')));
  const [fin] = await db.select().from(events).where(and(eq(events.projectId, projectId), eq(events.type, 'finished_culling'))).orderBy(desc(events.at)).limit(1);
  return { round: p.currentRound - 1, submittedAt: fin?.at ?? null, picks: rows };
}

export function hintFor(c: { x: number | null; y: number | null; w: number | null; h: number | null; t: number | null }): string | null {
  if (c.t !== null) { const m = Math.floor(c.t / 60); const s = Math.floor(c.t % 60); return `${m}:${String(s).padStart(2, '0')}`; }
  if (c.x === null || c.y === null) return null;
  const cx = c.x + (c.w ?? 0) / 2; const cy = c.y + (c.h ?? 0) / 2;
  const col = cx < 1 / 3 ? 'left' : cx > 2 / 3 ? 'right' : ''; const row = cy < 1 / 3 ? 'top' : cy > 2 / 3 ? 'bottom' : '';
  return row && col ? `${row}-${col}` : row || col || 'centre';
}

/** Comments on this project's finals and RAWs, with the source RAW for finals so Lightroom can show them on the catalog photo. */
export async function pluginComments(db: Db, projectId: string, since?: string) {
  const ph = new Map((await db.select().from(photos).where(eq(photos.projectId, projectId))).map((r) => [r.id, r]));
  if (ph.size === 0) return [];
  const rows = await db.select().from(comments).where(inArray(comments.photoId, [...ph.keys()])).orderBy(comments.createdAt);
  return rows.filter((c) => !since || c.createdAt > since).map((c) => {
    const p = ph.get(c.photoId)!; const src = p.sourcePhotoId ? ph.get(p.sourcePhotoId) : null;
    return { id: c.id, photoId: c.photoId, relPath: p.relPath, stage: p.stage, sourcePhotoId: src?.id ?? null, sourceRelPath: src?.relPath ?? null, author: c.author, text: c.text, hint: hintFor(c), createdAt: c.createdAt, resolvedAt: c.resolvedAt };
  });
}
export const replyFromPlugin = (db: Db, o: { photoId: string; author: string; text: string }) => addComment(db, { photoId: o.photoId, author: o.author, isAdmin: true, input: { text: o.text } });

/** Photographers' machines report which submitted RAWs changed; `done` is server-derived and never overwritten. */
export async function reportProgress(db: Db, o: { projectId: string; reports: { photoId: string; state: 'editing' | 'none' }[]; actor: string }): Promise<{ updated: number; skipped: number }> {
  const p = await project(db, o.projectId);
  const submitted = new Set((await db.select({ id: picks.photoId }).from(picks).where(and(eq(picks.projectId, o.projectId), lt(picks.round, p.currentRound)))).map((r) => r.id));
  return db.transaction(async (tx) => {
    let updated = 0; let skipped = 0;
    for (const r of o.reports) {
      const [row] = await tx.select().from(photos).where(and(eq(photos.id, r.photoId), eq(photos.projectId, o.projectId))).limit(1);
      if (!row || row.stage !== 'culling' || !submitted.has(row.id) || row.editState === 'done' || row.editState === r.state) { skipped++; continue; }
      await tx.update(photos).set({ editState: r.state }).where(eq(photos.id, row.id)); updated++;
    }
    if (updated) await tx.insert(events).values({ projectId: o.projectId, actor: o.actor, type: 'edit_progress', payload: { updated } });
    return { updated, skipped };
  });
}
