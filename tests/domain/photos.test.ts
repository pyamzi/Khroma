import { describe, it, expect } from 'vitest';
import { eq } from 'drizzle-orm';
import sharp from 'sharp';
import { clients, projects, photos, events } from '../../src/server/db/schema.js';
import { memoryStorage, photoKey } from '../../src/server/storage.js';
import { runOnce } from '../../src/server/jobs/queue.js';
import { addPhoto, makePreviewHandlers, PhotoError } from '../../src/server/domain/photos.js';
import { uploadFinal } from '../../src/server/domain/finals.js';
import { defaultProjectMeta } from '../../src/server/domain/meta.js';
import { jpegBytes } from '../fixtures/make.js';
import { studioTestDb } from '../helpers.js';

async function seed() {
  const s = await studioTestDb(); const storage = memoryStorage();
  await s.db.insert(clients).values({ id: 'c1', name: 'A', emails: [] });
  await s.db.insert(projects).values({ id: 'p1', clientId: 'c1', metadataJson: defaultProjectMeta('W') as Record<string, unknown> });
  const drain = async () => { while ((await runOnce(s.db, makePreviewHandlers(storage))) === 'ran') { /* drain */ } };
  return { ...s, storage, drain };
}

describe('photos', () => {
  it('stores the original, renders preview and thumb, sets size, and starts culling', async () => {
    const { db, studioId, storage, drain } = await seed();
    const { photoId } = await addPhoto(db, storage, { projectId: 'p1', relPath: 'raw/a.jpg', stage: 'culling', bytes: await jpegBytes(3000, 2000), name: 'a.jpg' });
    await drain();
    const k = (v: Parameters<typeof photoKey>[2]) => photoKey(studioId, photoId, v);
    expect(storage.keys().sort()).toEqual([k('original'), k('preview'), k('thumb')].sort());
    expect(storage.keys().every((key) => key.startsWith(`s/${studioId}/p/${photoId}/`))).toBe(true);
    expect((await sharp((await storage.getBytes(k('preview')))!).metadata()).width).toBe(2048);
    expect((await sharp((await storage.getBytes(k('thumb')))!).metadata()).width).toBe(400);
    const [row] = await db.select().from(photos).where(eq(photos.id, photoId));
    expect([row!.width, row!.height, row!.live, row!.checksum.length]).toEqual([2048, 1365, true, 64]);
    expect((await db.select().from(projects))[0]!.productionState).toBe('culling');
  });
  it('addPhoto keeps culling RAWs out of the Library', async () => {
    const { db, storage } = await seed();
    const culling = await addPhoto(db, storage, { projectId: 'p1', relPath: 'raw/a.jpg', stage: 'culling', bytes: await jpegBytes(300, 200), name: 'a.jpg' });
    const final = await addPhoto(db, storage, { projectId: 'p1', relPath: 'finals/a.jpg', stage: 'final', bytes: await jpegBytes(300, 200), name: 'a.jpg' });
    const inLib = async (id: string) => (await db.select().from(photos).where(eq(photos.id, id)))[0]!.inLibrary;
    expect([await inLib(culling.photoId), await inLib(final.photoId)]).toEqual([false, true]);
  });
  it('refuses unsupported bytes', async () => {
    const { db, storage } = await seed();
    await expect(addPhoto(db, storage, { projectId: 'p1', relPath: 'raw/a.txt', stage: 'culling', bytes: Buffer.from('hello'), name: 'a.txt' })).rejects.toBeInstanceOf(PhotoError);
    await expect(addPhoto(db, storage, { projectId: 'p1', relPath: 'raw/a.jpg', stage: 'culling', bytes: Buffer.from('not a jpeg'), name: 'a.jpg' })).rejects.toMatchObject({ code: 'unsupported' });
    expect(storage.keys()).toEqual([]);
  });
  it('a draft upload renders .draft variants and leaves the live ones alone', async () => {
    const { db, studioId, storage, drain } = await seed();
    const raw = await addPhoto(db, storage, { projectId: 'p1', relPath: 'raw/a.jpg', stage: 'culling', bytes: await jpegBytes(), name: 'a.jpg' });
    const live = await addPhoto(db, storage, { projectId: 'p1', relPath: 'finals/a.jpg', stage: 'final', bytes: await jpegBytes(100, 50), name: 'a.jpg', sourcePhotoId: raw.photoId });
    await drain();
    const liveThumb = await storage.getBytes(photoKey(studioId, live.photoId, 'thumb'));
    const up = await uploadFinal(db, storage, { projectId: 'p1', name: 'a.jpg', bytes: await jpegBytes(60, 60), sourcePhotoId: raw.photoId, uploadId: 'u1', actor: 'plugin' });
    expect(up).toMatchObject({ photoId: live.photoId, replaced: true, draftRelPath: 'finals/.draft/a.jpg' });
    await drain();
    for (const v of ['draft', 'preview.draft', 'thumb.draft'] as const) expect(await storage.getBytes(photoKey(studioId, live.photoId, v))).not.toBeNull();
    expect(await storage.getBytes(photoKey(studioId, live.photoId, 'thumb'))).toEqual(liveThumb);
    expect((await sharp((await storage.getBytes(photoKey(studioId, live.photoId, 'thumb.draft')))!).metadata()).width).toBe(60);
  });
  it('an undecodable image records preview_failed and does not retry', async () => {
    const { db, storage, drain } = await seed();
    const tiffHeaderOnly = Buffer.from('49492a0008000000', 'hex');
    await addPhoto(db, storage, { projectId: 'p1', relPath: 'raw/bad.dng', stage: 'culling', bytes: tiffHeaderOnly, name: 'bad.dng' });
    await drain();
    expect((await db.select().from(events)).map((e) => e.type)).toContain('preview_failed');
  });
});
