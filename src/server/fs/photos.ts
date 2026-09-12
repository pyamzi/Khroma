import { readdir, mkdir, rename } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { eq } from 'drizzle-orm';
import sharp from 'sharp';
import type { Db } from '../db/client.js';
import { photos, projects, events } from '../db/schema.js';
import { ProjectJson } from './schemas.js';
import { sniff, quickHash } from './media.js';
import { extractPreview, makeThumb, PreviewError } from './previews.js';
import { enqueue, type Handlers } from '../jobs/queue.js';
import { newId } from './ids.js';
import { RESERVED_DIRS } from './paths.js';
import { onCullingMediaIndexed } from '../domain/transitions.js';

export const PREVIEW_EDGE = 2048;
export const THUMB_EDGE = 400;
export type IndexReport = { added: number; updated: number; missing: number; drafts: number; skipped: string[] };

export function cachePaths(photosDir: string, row: { folderPath: string }, photoId: string) {
  const base = join(photosDir, row.folderPath, '.cache');
  return { preview: join(base, 'previews', `${photoId}.jpg`), thumb: join(base, 'thumbs', `${photoId}.jpg`) };
}

type Entry = { abs: string; rel: string };
async function walk(abs: string, rel: string, out: Entry[], allowDraft: boolean): Promise<void> {
  let entries; try { entries = await readdir(abs, { withFileTypes: true }); } catch { return; }
  for (const e of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    const isDraft = e.name === '.draft';
    if (e.name.startsWith('.') && !(allowDraft && isDraft)) continue;
    if ((RESERVED_DIRS as readonly string[]).includes(e.name) && !isDraft) continue;
    const a = join(abs, e.name); const r = `${rel}/${e.name}`;
    if (e.isDirectory()) await walk(a, r, out, false);
    else if (e.isFile()) out.push({ abs: a, rel: r });
  }
}

/**
 * Reconcile raw/ and finals/ with the photos table. Files are matched by path; a renamed
 * file is one missing row plus one new row, never a merge. New finals after the first index
 * are staged into finals/.draft/ so what the client sees only changes on publish.
 */
export async function indexProjectMedia(db: Db, photosDir: string, projectId: string): Promise<IndexReport> {
  const proj = db.select().from(projects).where(eq(projects.id, projectId)).get();
  if (!proj) throw new Error(`unknown project ${projectId}`);
  const meta = ProjectJson.parse(proj.metadataJson); const dir = join(photosDir, proj.folderPath);
  const firstIndex = proj.lastIndexedAt === null;
  const report: IndexReport = { added: 0, updated: 0, missing: 0, drafts: 0, skipped: [] };
  const finalsRoot = meta.folders.finals; const draftPrefix = `${finalsRoot}/.draft/`;

  const raw: Entry[] = []; await walk(join(dir, meta.folders.culling), meta.folders.culling, raw, false);
  const fin: Entry[] = []; await walk(join(dir, finalsRoot), finalsRoot, fin, true);
  const files = [...raw.map((f) => ({ ...f, stage: 'culling' as const })), ...fin.map((f) => ({ ...f, stage: 'final' as const }))];

  const existing = new Map(db.select().from(photos).where(eq(photos.projectId, projectId)).all().map((p) => [p.relPath, p]));
  type Seen = { checksum: string; draftPath: string | null; kind: 'photo' | 'video'; section: string | null; stage: 'culling' | 'final' };
  const seen = new Map<string, Seen>(); // keyed by live path; checksum is of the draft when one exists, else the live file

  for (const f of files) {
    const s = await sniff(f.abs);
    if (!s || (s.kind !== 'photo' && s.kind !== 'video')) { report.skipped.push(f.rel); continue; }
    const isDraftFile = f.rel.startsWith(draftPrefix);
    const livePath = isDraftFile ? `${finalsRoot}/${f.rel.slice(draftPrefix.length)}` : f.rel;
    let draftPath: string | null = isDraftFile ? f.rel : null;
    let abs = f.abs;
    if (f.stage === 'final' && !isDraftFile && !existing.has(livePath) && !firstIndex) {
      // a new file in finals/ after the first index is not live yet: stage it
      draftPath = `${draftPrefix}${f.rel.slice(finalsRoot.length + 1)}`;
      abs = join(dir, draftPath);
      await mkdir(dirname(abs), { recursive: true }); await rename(f.abs, abs);
    }
    if (seen.get(livePath)?.draftPath && !draftPath) continue; // the draft already represents this path
    const section = f.stage === 'final' ? (() => { const parts = livePath.split('/'); return parts.length > 2 ? parts[1]! : null; })() : null;
    seen.set(livePath, { checksum: await quickHash(abs), draftPath, kind: s.kind, section, stage: f.stage });
  }

  for (const [livePath, cur] of seen) {
    const prior = existing.get(livePath);
    if (!prior) {
      const id = newId();
      db.insert(photos).values({ id, projectId, relPath: livePath, draftRelPath: cur.draftPath, stage: cur.stage, kind: cur.kind, checksum: cur.checksum, section: cur.section }).run();
      report.added++; if (cur.draftPath) report.drafts++;
      enqueue(db, { kind: 'preview', payload: { photoId: id }, idempotencyKey: `preview:${id}:${cur.checksum}` });
      continue;
    }
    const draftChanged = prior.draftRelPath !== cur.draftPath;
    const contentChanged = prior.checksum !== cur.checksum;
    if (!draftChanged && !contentChanged && !prior.missing) continue;
    if (contentChanged && !cur.draftPath && !prior.draftRelPath && prior.stage === 'final' && !prior.missing) {
      // the live file itself was overwritten outside the app; there is no second copy to restore
      db.insert(events).values({ projectId, actor: 'system', type: 'replaced_externally', payload: { photoId: prior.id, relPath: livePath } }).run();
    }
    db.update(photos).set({ checksum: cur.checksum, missing: false, draftRelPath: cur.draftPath, section: cur.section }).where(eq(photos.id, prior.id)).run();
    report.updated++; if (cur.draftPath && draftChanged) report.drafts++;
    enqueue(db, { kind: 'preview', payload: { photoId: prior.id }, idempotencyKey: `preview:${prior.id}:${cur.checksum}` });
  }
  for (const [rel, p] of existing) if (!seen.has(rel) && !p.missing) { db.update(photos).set({ missing: true }).where(eq(photos.id, p.id)).run(); report.missing++; }
  db.update(projects).set({ lastIndexedAt: new Date().toISOString() }).where(eq(projects.id, projectId)).run();
  if (report.added > 0 || report.updated > 0) await onCullingMediaIndexed(db, photosDir, projectId);
  return report;
}

export function makePreviewHandlers(photosDir: string): Handlers {
  return {
    preview: async (payload, { db }) => {
      const { photoId } = payload as { photoId: string };
      const p = db.select().from(photos).where(eq(photos.id, photoId)).get();
      if (!p || p.missing || p.kind === 'video') return; // video posters arrive in milestone 10
      const proj = db.select().from(projects).where(eq(projects.id, p.projectId)).get()!;
      const src = join(photosDir, proj.folderPath, p.draftRelPath ?? p.relPath);
      const { preview, thumb } = cachePaths(photosDir, proj, p.id);
      await mkdir(dirname(preview), { recursive: true }); await mkdir(dirname(thumb), { recursive: true });
      try {
        let dims: { width: number; height: number };
        if (p.stage === 'culling') { dims = await extractPreview(src, preview, PREVIEW_EDGE); await makeThumb(preview, thumb, THUMB_EDGE); }
        else { await makeThumb(src, thumb, THUMB_EDGE); const m = await sharp(src).metadata(); dims = { width: m.width ?? 0, height: m.height ?? 0 }; }
        db.update(photos).set({ width: dims.width, height: dims.height }).where(eq(photos.id, p.id)).run();
      } catch (e) {
        if (!(e instanceof PreviewError)) throw e;
        db.insert(events).values({ projectId: p.projectId, actor: 'system', type: 'preview_failed', payload: { photoId: p.id, relPath: p.relPath, error: e.message } }).run();
      }
    },
  };
}
