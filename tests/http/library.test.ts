import { describe, it, expect } from 'vitest';
import { eq } from 'drizzle-orm';
import { photos, events, jobs } from '../../src/server/db/schema.js';
import { asSystem, withStudio } from '../../src/server/db/tenancy.js';
import { photoKey } from '../../src/server/storage.js';
import { MAX_UPLOAD_BYTES, sweepStaleUploads } from '../../src/server/domain/library.js';
import { jpegBytes } from '../fixtures/make.js';
import { boot } from './boot.js';

type Up = { photoId: string; uploadUrl: string; contentType: string };
type Page = { total: number; items: { id: string; status: string; width: number }[]; nextCursor: string | null };

let n = 0; // sign-in requests are rate limited per email, in process
async function setup() {
  const s = await boot(); const { cookie: owner, studioId } = await s.signupOwner(`o${++n}@x.com`, 'A');
  const start = async (name: string, cookie = owner) => s.json<Up>(await s.post('/api/library/uploads', { name, size: 1000 }, cookie));
  const put = (up: Up, body: Uint8Array) => s.app.request(up.uploadUrl, { method: 'PUT', body, headers: { 'content-type': up.contentType } });
  const complete = (id: string, cookie = owner) => s.post(`/api/library/uploads/${id}/complete`, {}, cookie);
  const page = async (cookie = owner) => s.json<Page>(await s.api('/api/library', { cookie }));
  const status = async (id: string) => (await withStudio(s.db, studioId, (tx) => tx.select().from(photos).where(eq(photos.id, id))))[0]?.status;
  const jobsOf = () => withStudio(s.db, studioId, (tx) => tx.select().from(jobs).where(eq(jobs.kind, 'process_upload')));
  return { ...s, owner, studioId, start, put, complete, page, status, jobsOf };
}

describe('library over HTTP', () => {
  it('upload → complete → ready with sizes and metadata', async () => {
    const s = await boot(); const owner = (await s.signupOwner('o@x.com', 'A')).cookie;
    const up = await s.json<{ photoId: string; uploadUrl: string }>(await s.post('/api/library/uploads', { name: 'a.jpg', size: 1000 }, owner));
    await s.app.request(up.uploadUrl, { method: 'PUT', body: await jpegBytes(3000, 2000), headers: { 'content-type': 'image/jpeg' } });
    expect((await s.post(`/api/library/uploads/${up.photoId}/complete`, {}, owner)).status).toBe(200);
    await s.drain();
    const page = await s.json<{ total: number; items: { id: string; status: string; width: number }[] }>(await s.api('/api/library', { cookie: owner }));
    expect(page.total).toBe(1); expect(page.items[0]).toMatchObject({ id: up.photoId, status: 'ready', width: 3000 });
    expect((await s.api(`/api/photos/${up.photoId}/preview?size=thumb`, { cookie: owner })).status).toBe(200);
  });

  it('refuses 50 MB + 1 byte and a .gif', async () => {
    const s = await setup();
    const big = await s.post('/api/library/uploads', { name: 'a.jpg', size: MAX_UPLOAD_BYTES + 1 }, s.owner);
    expect(big.status).toBe(413); expect(await big.json()).toEqual({ error: 'too_large' });
    const gif = await s.post('/api/library/uploads', { name: 'a.gif', size: 10 }, s.owner);
    expect(gif.status).toBe(415); expect(await gif.json()).toEqual({ error: 'unsupported' });
    expect((await s.post('/api/library/uploads', { name: 'a.jpg', size: MAX_UPLOAD_BYTES }, s.owner)).status).toBe(201);
    expect((await s.post('/api/library/uploads', { name: 'a.jpg' }, s.owner)).status).toBe(400);
  });

  it('complete without an uploaded object ends failed, not retried', async () => {
    const s = await setup(); const up = await s.start('a.jpg');
    expect((await s.complete(up.photoId)).status).toBe(200);
    await s.drain();
    expect(await s.status(up.photoId)).toBe('failed');
    expect((await s.jobsOf()).map((j) => [j.state, j.attempts])).toEqual([['done', 1]]);
    const ev = await withStudio(s.db, s.studioId, (tx) => tx.select().from(events).where(eq(events.type, 'upload_failed')));
    expect(ev).toMatchObject([{ projectId: null, payload: { photoId: up.photoId } }]);
    expect((await s.page()).total).toBe(0);
  });

  it('a .jpg that is a PDF ends failed and its object is deleted', async () => {
    const s = await setup(); const up = await s.start('a.jpg');
    await s.put(up, Buffer.from('%PDF-1.4\n%fake'));
    expect(s.storage.keys()).toContain(photoKey(s.studioId, up.photoId, 'original'));
    await s.complete(up.photoId); await s.drain();
    expect(await s.status(up.photoId)).toBe('failed');
    expect(s.storage.keys().filter((k) => k.startsWith(`s/${s.studioId}/p/${up.photoId}/`))).toEqual([]);
    expect((await s.api(`/api/photos/${up.photoId}/preview`, { cookie: s.owner })).status).toBe(404);
  });

  it('complete twice queues one job', async () => {
    const s = await setup(); const up = await s.start('a.jpg'); await s.put(up, await jpegBytes());
    expect((await s.complete(up.photoId)).status).toBe(200);
    expect((await s.complete(up.photoId)).status).toBe(200);
    expect(await s.jobsOf()).toHaveLength(1);
    await s.drain(); expect(await s.status(up.photoId)).toBe('ready');
    expect((await s.complete(up.photoId)).status).toBe(200);
    expect(await s.jobsOf()).toHaveLength(1);
  });

  it('culling previews are not in the Library total', async () => {
    const s = await setup();
    const { projectId } = await s.seedProject(s.owner);
    await s.addCulling(s.studioId, projectId, ['a', 'b', 'c']);
    const up = await s.start('a.png'); expect(up.contentType).toBe('image/png');
    await s.put(up, await jpegBytes()); // wrong signature for .png: still counted until processed
    expect((await s.page()).total).toBe(1);
  });

  it('another Studio and a Client get 404 on list, complete, delete and preview', async () => {
    const s = await setup(); const up = await s.start('a.jpg'); await s.put(up, await jpegBytes());
    await s.complete(up.photoId); await s.drain();
    const other = (await s.signupOwner(`b${n}@x.com`, 'B')).cookie;
    await s.seedProject(s.owner, { emails: [`c${n}@x.com`] }); const client = await s.signIn(`c${n}@x.com`);
    for (const cookie of [other, client]) {
      const list = await s.api('/api/library', { cookie });
      expect([200, 401]).toContain(list.status); expect(await list.text()).not.toContain(up.photoId);
      for (const res of [await s.complete(up.photoId, cookie), await s.api(`/api/library/${up.photoId}`, { method: 'DELETE', cookie })]) {
        expect([401, 404]).toContain(res.status); expect(await res.text()).not.toContain(up.photoId);
      }
      expect((await s.api(`/api/photos/${up.photoId}/preview`, { cookie })).status).toBe(404);
    }
    expect((await s.api('/api/library', { cookie: other })).status).toBe(200);
    expect((await s.complete(up.photoId, other)).status).toBe(404);
    expect((await s.api(`/api/library/${up.photoId}`, { method: 'DELETE', cookie: other })).status).toBe(404);
    expect(await s.status(up.photoId)).toBe('ready');
    expect((await s.api(`/api/library/${up.photoId}`, { method: 'DELETE', cookie: s.owner })).status).toBe(200);
    expect((await s.api(`/api/library/${up.photoId}`, { method: 'DELETE', cookie: s.owner })).status).toBe(404);
  });

  it('pages with limit and cursor; limit is capped at 200', async () => {
    const s = await setup();
    for (const n of ['a', 'b', 'c']) await s.start(`${n}.jpg`);
    const p1 = await s.json<Page>(await s.api('/api/library?limit=2', { cookie: s.owner }));
    expect(p1.items).toHaveLength(2); expect(p1.total).toBe(3);
    const p2 = await s.json<Page>(await s.api(`/api/library?limit=2&cursor=${encodeURIComponent(p1.nextCursor!)}`, { cookie: s.owner }));
    expect(p2.items).toHaveLength(1); expect(p2.nextCursor).toBeNull();
    expect((await s.api('/api/library?limit=201', { cookie: s.owner })).status).toBe(400);
    expect((await s.api('/api/library?cursor=garbage', { cookie: s.owner })).status).toBe(400);
  });

  it('stale uploading rows are swept after an hour', async () => {
    const s = await setup(); const stale = await s.start('a.jpg'); const fresh = await s.start('b.jpg');
    await s.put(stale, await jpegBytes()); await s.put(fresh, await jpegBytes());
    const now = Date.now();
    await withStudio(s.db, s.studioId, (tx) => tx.update(photos).set({ createdAt: new Date(now - 61 * 60_000).toISOString() }).where(eq(photos.id, stale.photoId)));
    expect(await sweepStaleUploads(s.db, s.storage, now)).toBe(1);
    expect(await s.status(stale.photoId)).toBeUndefined();
    expect(await s.storage.exists(photoKey(s.studioId, stale.photoId, 'original'))).toBe(false);
    expect(await s.status(fresh.photoId)).toBe('uploading');
    expect(await s.storage.exists(photoKey(s.studioId, fresh.photoId, 'original'))).toBe(true);
    expect(await asSystem(s.db, (tx) => tx.select().from(photos).where(eq(photos.status, 'uploading')))).toHaveLength(1);
  });
});
