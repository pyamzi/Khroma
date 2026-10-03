import { mkdir, rename, unlink, writeFile } from 'node:fs/promises';
import { basename, extname, join } from 'node:path';
import { and, desc, eq, inArray, lt } from 'drizzle-orm';
import type { Db } from '../db/client.js';
import { photos, projects, picks, comments, events } from '../db/schema.js';
import { ProjectJson } from '../fs/schemas.js';
import { quickHash, sniff } from '../fs/media.js';
import { cachePaths } from '../fs/photos.js';
import { getSetting } from '../db/settings.js';
import { enqueue } from '../jobs/queue.js';
import { newId } from '../fs/ids.js';
import { addComment } from './comments.js';

export class FinalsError extends Error { constructor(public code: 'invalid' | 'not_found' | 'live_until_published' | 'unsupported' | 'too_large') { super(code); this.name = 'FinalsError'; } }
const OK_EXT = new Set(['.jpg', '.jpeg', '.png']);
const project = (db: Db, id: string) => { const r = db.select().from(projects).where(eq(projects.id, id)).get(); if (!r) throw new FinalsError('not_found'); return r; };

/** Upload a rendered final into finals/.draft/, keyed to its source RAW. Names never collide across sources; re-uploads replace the same source's draft. */
export async function uploadFinal(db: Db, photosDir: string, o: { projectId: string; name: string; bytes: Buffer; sourcePhotoId?: string | null; uploadId: string; checksum?: string; actor: string }) {
  const p = project(db, o.projectId); const meta = ProjectJson.parse(p.metadataJson);
  const name = basename(o.name.replace(/\\/g, '/')).replace(/^\.+/, '').trim(); const ext = extname(name).toLowerCase();
  if (!name || !OK_EXT.has(ext) || !o.uploadId) throw new FinalsError('invalid');
  const lim = getSetting<{ mediaBytes?: number }>(db, 'limits')?.mediaBytes ?? 20 * 1024 ** 3; if (o.bytes.length > lim) throw new FinalsError('too_large');
  const source = o.sourcePhotoId ? db.select().from(photos).where(and(eq(photos.id, o.sourcePhotoId), eq(photos.projectId, o.projectId), eq(photos.stage, 'culling'))).get() ?? null : null;
  if (o.sourcePhotoId && !source) throw new FinalsError('not_found');
  const finalsRoot = meta.folders.finals; const dir = join(photosDir, p.folderPath);
  const rows = db.select().from(photos).where(and(eq(photos.projectId, o.projectId), eq(photos.stage, 'final'))).all();
  // choose the live path: the same source may replace its own final; a different source gets a suffixed name
  const stem = name.slice(0, -ext.length);
  let livePath = `${finalsRoot}/${name}`; let n = 2;
  let existing = rows.find((r) => r.relPath === livePath);
  while (existing && (existing.sourcePhotoId ?? null) !== (source?.id ?? null)) { livePath = `${finalsRoot}/${stem} (${n++})${ext}`; existing = rows.find((r) => r.relPath === livePath); }
  const draftPath = `${finalsRoot}/.draft/${basename(livePath)}`; const draftAbs = join(dir, draftPath);
  await mkdir(join(dir, finalsRoot, '.draft'), { recursive: true });
  const part = `${draftAbs}.part`;
  try { await writeFile(part, o.bytes); await rename(part, draftAbs); } catch (e) { await unlink(part).catch(() => {}); throw e; }
  const sn = await sniff(draftAbs); if (!sn || sn.kind !== 'photo') { await unlink(draftAbs).catch(() => {}); throw new FinalsError('unsupported'); }
  const checksum = await quickHash(draftAbs);
  if (existing && existing.draftRelPath === draftPath && existing.checksum === checksum) return { photoId: existing.id, relPath: livePath, draftRelPath: draftPath, replaced: false, idempotent: true };
  let photoId: string; let replaced = false;
  if (existing) {
    photoId = existing.id; replaced = true;
    db.update(photos).set({ draftRelPath: draftPath, checksum, sourcePhotoId: source?.id ?? existing.sourcePhotoId, missing: false }).where(eq(photos.id, existing.id)).run();
  } else {
    photoId = newId();
    db.insert(photos).values({ id: photoId, projectId: o.projectId, relPath: livePath, draftRelPath: draftPath, live: false, stage: 'final', kind: 'photo', sourcePhotoId: source?.id ?? null, checksum }).run();
  }
  enqueue(db, { kind: 'preview', payload: { photoId }, idempotencyKey: `preview:${photoId}:${checksum}:d` });
  db.insert(events).values({ projectId: o.projectId, actor: o.actor, type: 'final_uploaded', payload: { photoId, uploadId: o.uploadId, relPath: livePath, replaced } }).run();
  return { photoId, relPath: livePath, draftRelPath: draftPath, replaced, idempotent: false };
}

/** A draft that was never published can be withdrawn; a live final waits for publication tooling (M5). */
export async function deleteFinal(db: Db, photosDir: string, o: { projectId: string; photoId: string; actor: string }): Promise<void> {
  const p = project(db, o.projectId);
  const row = db.select().from(photos).where(and(eq(photos.id, o.photoId), eq(photos.projectId, o.projectId), eq(photos.stage, 'final'))).get();
  if (!row) throw new FinalsError('not_found');
  if (row.live) throw new FinalsError('live_until_published');
  if (row.draftRelPath) await unlink(join(photosDir, p.folderPath, row.draftRelPath)).catch(() => {});
  for (const v of ['live', 'draft'] as const) { const c = cachePaths(photosDir, p, row.id, v); await unlink(c.preview).catch(() => {}); await unlink(c.thumb).catch(() => {}); }
  db.delete(comments).where(eq(comments.photoId, row.id)).run();
  db.delete(photos).where(eq(photos.id, row.id)).run();
  db.insert(events).values({ projectId: o.projectId, actor: o.actor, type: 'final_removed', payload: { photoId: row.id, relPath: row.relPath } }).run();
}

/** Initial lookup: project-relative paths → photo ids. Case-sensitive, exact. */
export function resolvePaths(db: Db, projectId: string, paths: string[]): Record<string, string | null> {
  const rows = db.select({ id: photos.id, relPath: photos.relPath }).from(photos).where(and(eq(photos.projectId, projectId), eq(photos.missing, false))).all();
  const byPath = new Map(rows.map((r) => [r.relPath, r.id]));
  return Object.fromEntries(paths.map((p) => [p, byPath.get(p.replace(/\\/g, '/').replace(/^\/+/, '')) ?? null]));
}

export function pluginPicks(db: Db, projectId: string) {
  const p = project(db, projectId);
  const rows = db.select({ photoId: picks.photoId, round: picks.round, relPath: photos.relPath, missing: photos.missing }).from(picks).innerJoin(photos, eq(photos.id, picks.photoId))
    .where(and(eq(picks.projectId, projectId), lt(picks.round, p.currentRound), eq(picks.state, 'confirmed'))).all();
  const fin = db.select().from(events).where(and(eq(events.projectId, projectId), eq(events.type, 'finished_culling'))).orderBy(desc(events.at)).limit(1).get();
  return { round: p.currentRound - 1, submittedAt: fin?.at ?? null, picks: rows.filter((r) => !r.missing).map(({ photoId, round, relPath }) => ({ photoId, round, relPath })) };
}

export function hintFor(c: { x: number | null; y: number | null; w: number | null; h: number | null; t: number | null }): string | null {
  if (c.t !== null) { const m = Math.floor(c.t / 60); const s = Math.floor(c.t % 60); return `${m}:${String(s).padStart(2, '0')}`; }
  if (c.x === null || c.y === null) return null;
  const cx = c.x + (c.w ?? 0) / 2; const cy = c.y + (c.h ?? 0) / 2;
  const col = cx < 1 / 3 ? 'left' : cx > 2 / 3 ? 'right' : ''; const row = cy < 1 / 3 ? 'top' : cy > 2 / 3 ? 'bottom' : '';
  return row && col ? `${row}-${col}` : row || col || 'centre';
}

/** Comments on this project's finals and RAWs, with the source RAW for finals so Lightroom can show them on the catalog photo. */
export function pluginComments(db: Db, projectId: string, since?: string) {
  const ph = new Map(db.select().from(photos).where(eq(photos.projectId, projectId)).all().map((r) => [r.id, r]));
  const rows = db.select().from(comments).where(inArray(comments.photoId, [...ph.keys()].length ? [...ph.keys()] : ['-'])).orderBy(comments.createdAt).all();
  return rows.filter((c) => !since || c.createdAt > since).map((c) => {
    const p = ph.get(c.photoId)!; const src = p.sourcePhotoId ? ph.get(p.sourcePhotoId) : null;
    return { id: c.id, photoId: c.photoId, relPath: p.relPath, stage: p.stage, sourcePhotoId: src?.id ?? null, sourceRelPath: src?.relPath ?? null, author: c.author, text: c.text, hint: hintFor(c), createdAt: c.createdAt, resolvedAt: c.resolvedAt };
  });
}
export const replyFromPlugin = (db: Db, o: { photoId: string; author: string; text: string }) => addComment(db, { photoId: o.photoId, author: o.author, isAdmin: true, input: { text: o.text } });

/** Photographers' machines report which submitted RAWs changed; `done` is server-derived (M5) and never overwritten. */
export function reportProgress(db: Db, o: { projectId: string; reports: { photoId: string; state: 'editing' | 'none' }[]; actor: string }): { updated: number; skipped: number } {
  const p = project(db, o.projectId);
  const submitted = new Set(db.select({ id: picks.photoId }).from(picks).where(and(eq(picks.projectId, o.projectId), lt(picks.round, p.currentRound))).all().map((r) => r.id));
  let updated = 0; let skipped = 0;
  db.transaction((tx) => {
    for (const r of o.reports) {
      const row = tx.select().from(photos).where(and(eq(photos.id, r.photoId), eq(photos.projectId, o.projectId))).get();
      if (!row || row.stage !== 'culling' || !submitted.has(row.id) || row.editState === 'done' || row.editState === r.state) { skipped++; continue; }
      tx.update(photos).set({ editState: r.state }).where(eq(photos.id, row.id)).run(); updated++;
    }
    if (updated) tx.insert(events).values({ projectId: o.projectId, actor: o.actor, type: 'edit_progress', payload: { updated } }).run();
  });
  return { updated, skipped };
}
