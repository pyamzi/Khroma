import { basename, extname } from 'node:path';
import { and, count, desc, eq, isNull, lt, ne, sql } from 'drizzle-orm';
import sharp from 'sharp';
import type { Db } from '../db/client.js';
import { photos, projects, events, comments } from '../db/schema.js';
import { asSystem } from '../db/tenancy.js';
import { photoKey, type PhotoVariant, type Storage } from '../storage.js';
import { sniffBytes, sha256 } from '../media/sniff.js';
import { renderSizes, heicToJpeg } from '../media/convert.js';
import { readMetadata } from '../media/metadata.js';
import { enqueue, type Handlers } from '../jobs/queue.js';
import { newId } from '../ids.js';

export const MAX_UPLOAD_BYTES = 52_428_800;
export const LIBRARY_EXT = ['.jpg', '.jpeg', '.png', '.webp', '.heic'];
const CONTENT_TYPE: Record<string, string> = { '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.webp': 'image/webp', '.heic': 'image/heic' };
const VARIANTS: PhotoVariant[] = ['original', 'thumb', 'medium', 'preview'];
const STALE_UPLOAD_MS = 3600_000;
export class LibraryError extends Error { constructor(public code: 'unsupported' | 'too_large' | 'not_found') { super(code); this.name = 'LibraryError'; } }

/** Records the photo as `uploading` and returns a URL the browser PUTs the original to, with exactly `contentType`. */
export async function startUpload(db: Db, storage: Storage, o: { name: string; size: number }): Promise<{ photoId: string; uploadUrl: string; contentType: string }> {
  const name = basename(o.name.replace(/\\/g, '/')).replace(/^\.+/, '').trim(); const ext = extname(name).toLowerCase();
  if (!LIBRARY_EXT.includes(ext)) throw new LibraryError('unsupported');
  if (o.size > MAX_UPLOAD_BYTES) throw new LibraryError('too_large');
  const photoId = newId(); const contentType = CONTENT_TYPE[ext]!;
  const [row] = await db.insert(photos).values({ id: photoId, projectId: null, relPath: `library/${photoId}/${name}`, stage: 'final', live: true, inLibrary: true, kind: 'photo', status: 'uploading', checksum: '' })
    .returning({ studioId: photos.studioId });
  // R2 signs content-type, so the browser must send exactly this; memory storage (tests, local dev) does not enforce it.
  // R2 does not enforce the declared size either: process_upload re-checks the stored size.
  const uploadUrl = await storage.presignPut(photoKey(row!.studioId, photoId, 'original'), contentType, 900);
  return { photoId, uploadUrl, contentType };
}

/** The browser finished its PUT. Repeats are no-ops; one job per photo. */
export async function completeUpload(db: Db, photoId: string): Promise<void> {
  const [p] = await db.select({ status: photos.status }).from(photos).where(and(eq(photos.id, photoId), isNull(photos.projectId))).limit(1);
  if (p?.status === 'processing' || p?.status === 'ready') return;
  if (p?.status !== 'uploading') throw new LibraryError('not_found');
  await db.update(photos).set({ status: 'processing' }).where(eq(photos.id, photoId));
  await enqueue(db, { kind: 'process_upload', payload: { photoId }, idempotencyKey: `process:${photoId}` });
}

/** Never throws for a bad upload: the photo ends `failed`, its objects are deleted, and the job is done. Storage outages still throw and retry. */
export function makeLibraryHandlers(storage: Storage): Handlers {
  return {
    process_upload: async (payload, { db, studioId }) => {
      const { photoId } = payload as { photoId: string };
      const [p] = await db.select().from(photos).where(eq(photos.id, photoId)).limit(1);
      if (!p || p.status !== 'processing') return;
      const key = (v: PhotoVariant) => photoKey(studioId, p.id, v);
      const fail = async (reason: string) => {
        await db.update(photos).set({ status: 'failed' }).where(eq(photos.id, p.id));
        for (const v of VARIANTS) await storage.delete(key(v));
        await db.insert(events).values({ projectId: null, actor: 'system', type: 'upload_failed', payload: { photoId: p.id, reason } });
      };
      const obj = await storage.get(key('original'));
      if (!obj) return fail('missing object');
      if (obj.size > MAX_UPLOAD_BYTES) { await obj.body.cancel(); return fail('too large'); }
      let bytes: Uint8Array = new Uint8Array(await new Response(obj.body).arrayBuffer());
      let out: { sizes: Awaited<ReturnType<typeof renderSizes>>; meta: Awaited<ReturnType<typeof readMetadata>> }; let heic = false;
      try {
        const sn = sniffBytes(bytes, basename(p.relPath));
        if (!sn || sn.kind !== 'photo') throw new Error('unsupported or mismatched file');
        if (sn.format === 'heic') { bytes = await heicToJpeg(bytes); heic = true; }
        // renderSizes decodes leniently (RAW previews); a half-uploaded file must fail here instead
        else await sharp(bytes, { failOn: 'truncated' }).resize(64).toBuffer();
        out = { sizes: await renderSizes(bytes), meta: await readMetadata(bytes) };
      } catch (e) { return fail((e as Error).message); }
      if (heic) await storage.put(key('original'), bytes, 'image/jpeg'); // a HEIC original is kept as its JPEG
      await storage.put(key('preview'), out.sizes.preview, 'image/jpeg');
      await storage.put(key('medium'), out.sizes.medium, 'image/jpeg');
      await storage.put(key('thumb'), out.sizes.thumb, 'image/jpeg');
      await db.update(photos).set({
        status: 'ready', readyAt: new Date().toISOString(), width: out.sizes.width, height: out.sizes.height,
        capturedAt: out.meta.capturedAt, keywords: out.meta.keywords, caption: out.meta.caption, checksum: sha256(bytes),
      }).where(and(eq(photos.id, p.id), eq(photos.status, 'processing'))); // the sweep may have failed it meanwhile
    },
  };
}

export type LibraryItem = { id: string; status: string; width: number | null; height: number | null; capturedAt: string | null; createdAt: string; readyAt: string | null; projectId: string | null; projectTitle: string | null };

/** Newest first. The cursor is the last item's `createdAt|id`: rows can share a created_at, so id breaks the tie. */
export async function libraryPage(db: Db, o: { cursor?: string; limit: number }): Promise<{ total: number; items: LibraryItem[]; nextCursor: string | null }> {
  const inLibrary = and(eq(photos.inLibrary, true), ne(photos.status, 'failed'));
  const [at, id] = o.cursor ? o.cursor.split('|') : [];
  const rows = await db.select({
    id: photos.id, status: photos.status, width: photos.width, height: photos.height, capturedAt: photos.capturedAt, createdAt: photos.createdAt,
    readyAt: photos.readyAt, projectId: photos.projectId, projectTitle: sql<string | null>`${projects.metadataJson}->>'title'`,
  }).from(photos).leftJoin(projects, eq(projects.id, photos.projectId))
    .where(and(inLibrary, o.cursor ? sql`(${photos.createdAt}, ${photos.id}) < (${at}, ${id})` : undefined))
    .orderBy(desc(photos.createdAt), desc(photos.id)).limit(o.limit + 1);
  const [{ n }] = await db.select({ n: count() }).from(photos).where(inLibrary) as [{ n: number }];
  const items = rows.slice(0, o.limit); const last = items.at(-1);
  return { total: n, items, nextCursor: rows.length > o.limit && last ? `${last.createdAt}|${last.id}` : null };
}

/** Library-only photos (no project): the row and every object. */
export async function deleteLibraryPhoto(db: Db, storage: Storage, photoId: string): Promise<void> {
  const [p] = await db.select().from(photos).where(and(eq(photos.id, photoId), isNull(photos.projectId))).limit(1);
  if (!p) throw new LibraryError('not_found');
  await db.delete(comments).where(eq(comments.photoId, p.id));
  await db.delete(photos).where(eq(photos.id, p.id));
  for (const v of VARIANTS) await storage.delete(photoKey(p.studioId, p.id, v));
}

/**
 * Hourly, across Studios. Uploads never completed within an hour are deleted; uploads still processing after an hour
 * (their job ran out of retries) end failed with an upload_failed event. Rows first, then objects (best effort).
 */
export async function sweepStaleUploads(root: Db, storage: Storage, now: number): Promise<number> {
  const old = lt(photos.createdAt, new Date(now - STALE_UPLOAD_MS).toISOString());
  const [gone, stuck] = await asSystem(root, async (tx) => {
    const gone = await tx.delete(photos).where(and(eq(photos.status, 'uploading'), old)).returning({ id: photos.id, studioId: photos.studioId });
    const stuck = await tx.update(photos).set({ status: 'failed' }).where(and(eq(photos.status, 'processing'), old)).returning({ id: photos.id, studioId: photos.studioId });
    for (const s of stuck) await tx.insert(events).values({ studioId: s.studioId, projectId: null, actor: 'system', type: 'upload_failed', payload: { photoId: s.id, reason: 'processing timed out' } });
    return [gone, stuck];
  });
  for (const g of [...gone, ...stuck]) for (const v of VARIANTS) await storage.delete(photoKey(g.studioId, g.id, v)).catch((e) => console.error('[sweep] upload object', g.id, e));
  return gone.length + stuck.length;
}
