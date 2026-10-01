import { and, eq } from 'drizzle-orm';
import sharp from 'sharp';
import type { Db } from '../db/client.js';
import { photos, events } from '../db/schema.js';
import { photoKey, type PhotoVariant, type Storage } from '../storage.js';
import { sniffBytes, sha256 } from '../media/sniff.js';
import { extractPreview, makeThumb, PreviewError, PREVIEW_EDGE, MEDIUM_EDGE, THUMB_EDGE } from '../media/previews.js';
import { enqueue, type Handlers } from '../jobs/queue.js';
import { newId } from '../ids.js';
import { pgCode } from '../db/errors.js';
import { project } from './selection.js';
import { onCullingMediaAdded } from './transitions.js';

export { PREVIEW_EDGE, MEDIUM_EDGE, THUMB_EDGE };
export class PhotoError extends Error { constructor(public code: 'unsupported' | 'invalid' | 'too_large') { super(code); this.name = 'PhotoError'; } }

/** Stores the original, records the photo, and queues its previews. `relPath` is the logical path within the project, e.g. raw/a.dng. */
export async function addPhoto(db: Db, storage: Storage, o: { projectId: string; relPath: string; stage: 'culling' | 'final'; bytes: Uint8Array; name: string; sourcePhotoId?: string | null }): Promise<{ photoId: string }> {
  const sn = sniffBytes(o.bytes, o.name);
  if (!sn || (sn.kind !== 'photo' && sn.kind !== 'video')) throw new PhotoError('unsupported');
  const p = await project(db, o.projectId); const photoId = newId(); const checksum = sha256(o.bytes);
  await db.insert(photos).values({ id: photoId, projectId: o.projectId, relPath: o.relPath, stage: o.stage, inLibrary: o.stage !== 'culling', kind: sn.kind, checksum, sourcePhotoId: o.sourcePhotoId ?? null });
  await storage.put(photoKey(p.studioId, photoId, 'original'), o.bytes, contentType(o.name, sn.format));
  await enqueue(db, { kind: 'preview', payload: { photoId }, idempotencyKey: `preview:${photoId}:${checksum}` });
  if (o.stage === 'culling') await onCullingMediaAdded(db, o.projectId);
  return { photoId };
}
export const MAX_CULLING_BYTES = 30 * 1024 * 1024;

/**
 * A client-facing culling photo from the 2048 px JPEG preview Lightroom renders (the RAW itself never leaves the photographer's machine).
 * It is keyed by `raw/<basename>`; the same path with the same bytes is a no-op, changed bytes replace the preview and keep the id, picks and comments.
 * `name` is informational: `relPath` carries the RAW's name, so the preview is sniffed as a JPEG regardless of it.
 */
export async function addCullingPreview(db: Db, storage: Storage, o: { projectId: string; relPath: string; bytes: Uint8Array; name: string }): Promise<{ photoId: string; created: boolean; replaced: boolean }> {
  const leaf = o.relPath.split(/[\\/]/).pop()!.replace(/^\.+/, '').trim();
  if (!leaf) throw new PhotoError('invalid');
  if (o.bytes.byteLength > MAX_CULLING_BYTES) throw new PhotoError('too_large');
  if (sniffBytes(o.bytes, 'preview.jpg')?.format !== 'jpeg') throw new PhotoError('unsupported');
  const relPath = `raw/${leaf}`; const checksum = sha256(o.bytes);
  const find = async () => (await db.select().from(photos).where(and(eq(photos.projectId, o.projectId), eq(photos.relPath, relPath), eq(photos.stage, 'culling'))).limit(1))[0];
  let ex = await find();
  if (!ex) {
    // the savepoint lets a lost race (unique violation) fall through to the replace path instead of aborting the caller's transaction
    try { return { ...(await db.transaction((tx) => addPhoto(tx, storage, { projectId: o.projectId, relPath, stage: 'culling', bytes: o.bytes, name: 'preview.jpg' }))), created: true, replaced: false }; }
    catch (e) { if (pgCode(e) !== '23505' || !(ex = await find())) throw e; }
  }
  if (ex.checksum === checksum) return { photoId: ex.id, created: false, replaced: false };
  const p = await project(db, o.projectId);
  await storage.put(photoKey(p.studioId, ex.id, 'original'), o.bytes, 'image/jpeg');
  await db.update(photos).set({ checksum }).where(eq(photos.id, ex.id)); // width/height follow when the new preview job runs
  await enqueue(db, { kind: 'preview', payload: { photoId: ex.id }, idempotencyKey: `preview:${ex.id}:${checksum}` });
  return { photoId: ex.id, created: false, replaced: true };
}
const TYPES: Record<string, string> = { jpeg: 'image/jpeg', png: 'image/png', webp: 'image/webp', heic: 'image/heic', mp4: 'video/mp4', mov: 'video/quicktime' };
export const contentType = (_name: string, format: string) => TYPES[format] ?? 'application/octet-stream';

/** Live and draft renditions never share an object; client routes serve only the live one. */
export function makePreviewHandlers(storage: Storage): Handlers {
  return {
    preview: async (payload, { db, studioId }) => {
      const { photoId } = payload as { photoId: string };
      const [p] = await db.select().from(photos).where(eq(photos.id, photoId)).limit(1);
      if (!p || p.kind === 'video') return; // video posters arrive later
      const render = async (src: PhotoVariant, preview: PhotoVariant, medium: PhotoVariant, thumb: PhotoVariant) => {
        const bytes = await storage.getBytes(photoKey(studioId, p.id, src));
        if (!bytes) throw new PreviewError(`no ${src} object`);
        const r = await extractPreview(bytes, PREVIEW_EDGE);
        await storage.put(photoKey(studioId, p.id, preview), r.jpeg, 'image/jpeg');
        await storage.put(photoKey(studioId, p.id, medium), await makeThumb(r.jpeg, MEDIUM_EDGE), 'image/jpeg');
        await storage.put(photoKey(studioId, p.id, thumb), await makeThumb(r.jpeg, THUMB_EDGE), 'image/jpeg');
        if (p.stage === 'culling') return { width: r.width, height: r.height };
        const m = await sharp(bytes).metadata(); return { width: m.width ?? r.width, height: m.height ?? r.height }; // finals report their full size
      };
      try {
        let dims: { width: number; height: number } | null = null;
        if (p.live) dims = await render('original', 'preview', 'medium', 'thumb');
        if (p.draftRelPath) { const d = await render('draft', 'preview.draft', 'medium.draft', 'thumb.draft'); dims ??= d; }
        if (dims) await db.update(photos).set({ width: dims.width, height: dims.height }).where(eq(photos.id, p.id));
      } catch (e) {
        if (!(e instanceof PreviewError)) throw e;
        await db.insert(events).values({ projectId: p.projectId, actor: 'system', type: 'preview_failed', payload: { photoId: p.id, relPath: p.relPath, error: e.message } });
      }
    },
  };
}
