import { describe, it, expect } from 'vitest';
import { eq } from 'drizzle-orm';
import sharp from 'sharp';
import { clients, projects, photos, events, jobs } from '../../src/server/db/schema.js';
import { memoryStorage, photoKey } from '../../src/server/storage.js';
import { defaultProjectMeta } from '../../src/server/domain/meta.js';
import { addPhoto } from '../../src/server/domain/photos.js';
import { sha256 } from '../../src/server/media/sniff.js';
import { startUpload, completeUpload, makeLibraryHandlers, libraryPage, deleteLibraryPhoto, sweepStaleUploads, LibraryError, MAX_UPLOAD_BYTES } from '../../src/server/domain/library.js';
import { jpegBytes, tiffBytes } from '../fixtures/make.js';
import { withStudio } from '../../src/server/db/tenancy.js';
import { studioTestDb, testDb, makeStudio } from '../helpers.js';

async function seed() {
  const s = await studioTestDb(); const storage = memoryStorage();
  const process = (photoId: string) => (makeLibraryHandlers(storage).process_upload as (p: unknown, ctx: unknown) => Promise<void>)({ photoId }, { db: s.db, jobId: 'j', studioId: s.studioId });
  /** start → put bytes at the original's key → complete. */
  const upload = async (name: string, bytes: Uint8Array | null) => {
    const up = await startUpload(s.db, storage, { name, size: bytes?.byteLength ?? 1 });
    if (bytes) await storage.put(photoKey(s.studioId, up.photoId, 'original'), bytes, up.contentType);
    await completeUpload(s.db, up.photoId); return up;
  };
  const row = async (id: string) => (await s.db.select().from(photos).where(eq(photos.id, id)))[0];
  const keysOf = (id: string) => storage.keys().filter((k) => k.includes(`/p/${id}/`));
  return { ...s, storage, process, upload, row, keysOf };
}
const err = (p: Promise<unknown>) => p.then(() => null, (e: unknown) => (e instanceof LibraryError ? e.code : e));

describe('library domain', () => {
  it('startUpload validates the name and size, sanitizes the path and returns the content type to send', async () => {
    const { db, storage, studioId, row } = await seed();
    expect(await err(startUpload(db, storage, { name: 'a.jpg', size: MAX_UPLOAD_BYTES + 1 }))).toBe('too_large');
    expect(await err(startUpload(db, storage, { name: 'a.gif', size: 10 }))).toBe('unsupported');
    expect(await err(startUpload(db, storage, { name: 'noext', size: 10 }))).toBe('unsupported');
    const up = await startUpload(db, storage, { name: '../../etc/.x/IMG 1.JPG', size: 10 });
    expect(up.contentType).toBe('image/jpeg');
    expect(up.uploadUrl).toContain(encodeURIComponent(studioId)); expect(up.uploadUrl).toMatch(/\/original$/);
    expect(await row(up.photoId)).toMatchObject({ projectId: null, stage: 'final', live: true, inLibrary: true, status: 'uploading', relPath: `library/${up.photoId}/IMG 1.JPG`, checksum: '' });
    expect((await startUpload(db, storage, { name: 'b.heic', size: 10 })).contentType).toBe('image/heic');
    expect((await startUpload(db, storage, { name: 'b.webp', size: 10 })).contentType).toBe('image/webp');
    expect((await startUpload(db, storage, { name: 'b.png', size: 10 })).contentType).toBe('image/png');
  });

  it('process_upload renders sizes, reads metadata and marks the photo ready', async () => {
    const { storage, studioId, process, upload, row } = await seed();
    const bytes = await sharp(await jpegBytes(3000, 2000)).withExif({ IFD0: { ImageDescription: 'Sunset' } }).jpeg().toBuffer();
    const up = await upload('a.jpg', bytes);
    expect((await row(up.photoId))!.status).toBe('processing');
    await process(up.photoId);
    const r = (await row(up.photoId))!;
    expect(r).toMatchObject({ status: 'ready', width: 3000, height: 2000, caption: 'Sunset', checksum: sha256(bytes) });
    expect(r.readyAt).toBeTruthy();
    for (const v of ['thumb', 'medium', 'preview'] as const) expect(await storage.exists(photoKey(studioId, up.photoId, v))).toBe(true);
  });

  it('a missing, lying or truncated object ends failed: objects deleted, upload_failed event, no throw', async () => {
    const { db, process, upload, row, keysOf } = await seed();
    const full = await sharp({ create: { width: 1200, height: 900, channels: 3, noise: { type: 'gaussian', mean: 128, sigma: 30 } } }).jpeg().toBuffer();
    const cases = { missing: null, pdf: Buffer.from('%PDF-1.4 not a photo at all'), truncated: full.subarray(0, full.length / 2) };
    for (const [name, bytes] of Object.entries(cases)) {
      const up = await upload(`${name}.jpg`, bytes);
      await expect(process(up.photoId)).resolves.toBeUndefined();
      expect((await row(up.photoId))!.status, name).toBe('failed');
      expect(keysOf(up.photoId), name).toEqual([]);
      const ev = (await db.select().from(events).where(eq(events.type, 'upload_failed'))).find((e) => (e.payload as { photoId: string }).photoId === up.photoId);
      expect(ev, name).toMatchObject({ projectId: null, payload: { photoId: up.photoId, reason: expect.any(String) } });
    }
  });

  it('completeUpload queues one job; processing and ready are no-ops; failed or a project photo is not_found', async () => {
    const { db, storage, process, upload, row } = await seed();
    const up = await upload('a.jpg', await jpegBytes());
    await completeUpload(db, up.photoId);
    expect(await db.select().from(jobs).where(eq(jobs.kind, 'process_upload'))).toHaveLength(1);
    await process(up.photoId); expect((await row(up.photoId))!.status).toBe('ready');
    await completeUpload(db, up.photoId);
    expect((await row(up.photoId))!.status).toBe('ready');
    expect(await db.select().from(jobs).where(eq(jobs.kind, 'process_upload'))).toHaveLength(1);
    const bad = await upload('b.jpg', null); await process(bad.photoId);
    expect(await err(completeUpload(db, bad.photoId))).toBe('not_found');
    expect(await err(completeUpload(db, 'nope'))).toBe('not_found');
    await db.insert(clients).values({ id: 'c1', name: 'S', emails: [] });
    await db.insert(projects).values({ id: 'p1', clientId: 'c1', metadataJson: defaultProjectMeta('W') as Record<string, unknown> });
    const pp = await addPhoto(db, storage, { projectId: 'p1', relPath: 'raw/a.dng', stage: 'culling', bytes: await tiffBytes(), name: 'a.dng' });
    expect(await err(completeUpload(db, pp.photoId))).toBe('not_found');
    expect(await err(deleteLibraryPhoto(db, storage, pp.photoId))).toBe('not_found');
  });

  it('libraryPage: newest first, failed and culling excluded, stable cursor across rows sharing created_at', async () => {
    const { db, storage, upload, process } = await seed();
    await db.insert(clients).values({ id: 'c1', name: 'S', emails: [] });
    await db.insert(projects).values({ id: 'p1', clientId: 'c1', metadataJson: defaultProjectMeta('Wedding') as Record<string, unknown> });
    await addPhoto(db, storage, { projectId: 'p1', relPath: 'raw/a.dng', stage: 'culling', bytes: await tiffBytes(), name: 'a.dng' });
    const same = '2020-01-01T00:00:00.000Z';
    const ids = ['a', 'b', 'c', 'd', 'e'].map((x) => `00000000-0000-0000-0000-00000000000${x}`);
    for (const id of ids) await db.insert(photos).values({ id, projectId: id === ids[0] ? 'p1' : null, relPath: `finals/${id}.jpg`, stage: 'final', kind: 'photo', checksum: 'x', createdAt: same });
    const failed = await upload('f.jpg', null); await process(failed.photoId);
    const seen: string[] = []; let cursor: string | undefined; let pages = 0;
    do {
      const p = await libraryPage(db, { cursor, limit: 2 }); pages++;
      expect(p.total).toBe(5);
      seen.push(...p.items.map((i) => i.id)); cursor = p.nextCursor ?? undefined;
    } while (cursor);
    expect(pages).toBe(3);
    expect(seen).toEqual([...ids].reverse());
    const first = (await libraryPage(db, { limit: 60 })).items.find((i) => i.id === ids[0]);
    expect(first).toMatchObject({ projectId: 'p1', projectTitle: 'Wedding', status: 'ready', createdAt: same });
  });

  it('deleteLibraryPhoto removes the row and every variant', async () => {
    const { db, storage, process, upload, row, keysOf } = await seed();
    const up = await upload('a.jpg', await jpegBytes()); await process(up.photoId);
    expect(keysOf(up.photoId).length).toBe(4);
    await deleteLibraryPhoto(db, storage, up.photoId);
    expect(await row(up.photoId)).toBeUndefined(); expect(keysOf(up.photoId)).toEqual([]);
    expect(await err(deleteLibraryPhoto(db, storage, up.photoId))).toBe('not_found');
  });

  it('a retry after the HEIC original was already replaced by its JPEG finishes instead of failing', async () => {
    const { storage, studioId, process, upload, row } = await seed();
    const jpeg = await jpegBytes(300, 200); // the state a first attempt leaves when it converted, wrote original, then a size put threw
    const up = await upload('IMG_1.heic', jpeg);
    await process(up.photoId);
    expect(await row(up.photoId)).toMatchObject({ status: 'ready', width: 300, checksum: sha256(jpeg) });
    expect(await storage.getBytes(photoKey(studioId, up.photoId, 'original'))).toEqual(new Uint8Array(jpeg));
  });

  it('the sweep fails processing rows older than an hour only when their job is dead or missing', async () => {
    const root = await testDb(); const { studioId } = await makeStudio(root); const storage = memoryStorage(); const now = Date.now();
    const hourAgo = new Date(now - 61 * 60_000).toISOString();
    const ids = await withStudio(root, studioId, async (tx) => {
      const ids: Record<string, string> = {};
      for (const n of ['pending', 'failed', 'review', 'nojob', 'fresh']) {
        const u = await startUpload(tx, storage, { name: `${n}.jpg`, size: 10 }); ids[n] = u.photoId;
        await storage.put(photoKey(studioId, u.photoId, 'original'), await jpegBytes(), 'image/jpeg'); await completeUpload(tx, u.photoId);
        if (n !== 'fresh') await tx.update(photos).set({ createdAt: hourAgo }).where(eq(photos.id, u.photoId));
      }
      await storage.put(photoKey(studioId, ids.failed!, 'thumb'), await jpegBytes(), 'image/jpeg');
      await tx.update(jobs).set({ state: 'failed' }).where(eq(jobs.idempotencyKey, `process:${ids.failed}`));
      await tx.update(jobs).set({ state: 'needs_review' }).where(eq(jobs.idempotencyKey, `process:${ids.review}`));
      await tx.update(jobs).set({ state: 'running' }).where(eq(jobs.idempotencyKey, `process:${ids.pending}`)); // running counts as alive too
      for (const n of ['nojob', 'fresh']) await tx.delete(jobs).where(eq(jobs.idempotencyKey, `process:${ids[n]}`));
      return ids;
    });
    expect(await sweepStaleUploads(root, storage, now)).toBe(3);
    const [rows, evs] = await withStudio(root, studioId, async (tx) => [await tx.select().from(photos), await tx.select().from(events).where(eq(events.type, 'upload_failed'))] as const);
    const st = (n: string) => rows.find((r) => r.id === ids[n])!.status;
    expect({ pending: st('pending'), failed: st('failed'), review: st('review'), nojob: st('nojob'), fresh: st('fresh') })
      .toEqual({ pending: 'processing', failed: 'failed', review: 'failed', nojob: 'failed', fresh: 'processing' });
    for (const n of ['failed', 'review', 'nojob']) expect(storage.keys().filter((k) => k.includes(`/p/${ids[n]}/`)), n).toEqual([]);
    for (const n of ['pending', 'fresh']) expect(storage.keys(), n).toContain(photoKey(studioId, ids[n]!, 'original'));
    expect(evs.map((e) => (e.payload as { photoId: string }).photoId).sort()).toEqual([ids.failed, ids.review, ids.nojob].sort());
    expect(evs[0]).toMatchObject({ projectId: null, studioId, payload: { reason: 'processing timed out' } });
  });
});
