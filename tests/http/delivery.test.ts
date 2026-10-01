import { describe, it, expect } from 'vitest';
import sharp from 'sharp';
import { runOnce } from '../../src/server/jobs/queue.js';
import { boot as bootApp } from './boot.js';

const jpeg = (bg = '#c33') => sharp({ create: { width: 40, height: 30, channels: 3, background: bg } }).jpeg().toBuffer();
type Photo = { id: string; hasDraft: boolean; v: string };

/** A project in editing with two drafts uploaded from Lightroom and the client's pick submitted. */
async function boot() {
  const b = await bootApp();
  const { cookie: owner, studioId } = await b.signupOwner('owner@x.com', 'S');
  const { projectId: pid } = await b.seedProject(owner, { emails: ['sarah@x.com', 'tom@x.com'], included: 5 });
  const [a, c] = await b.addCulling(studioId, pid, ['a', 'b']);
  const sarah = await b.signIn('sarah@x.com');
  const { token } = await b.json<{ token: string }>(await b.post('/api/access/tokens', { name: 'Sam', scope: 'read+write' }, owner));
  const upload = async (name: string, src: string, uploadId: string, bg = '#c33') => {
    const fd = new FormData(); fd.append('file', new Blob([await jpeg(bg)], { type: 'image/jpeg' }), name); fd.append('name', name); fd.append('sourcePhotoId', src); fd.append('uploadId', uploadId);
    return b.json<{ photoId: string }>(await b.api(`/api/plugin/projects/${pid}/finals`, { method: 'POST', body: fd, bearer: token }));
  };
  const f1 = (await upload('A.jpg', a!, 'u1')).photoId; const f2 = (await upload('B.jpg', c!, 'u2')).photoId; await b.drain();
  const sel = await b.json<{ summary: { selectionVersion: number } }>(await b.api(`/api/projects/${pid}/selection`, { cookie: sarah }));
  await b.api(`/api/projects/${pid}/picks`, { method: 'POST', cookie: sarah, body: JSON.stringify({ photoId: a, picked: true, selectionVersion: sel.summary.selectionVersion }) });
  const sel2 = await b.json<{ summary: { selectionVersion: number } }>(await b.api(`/api/projects/${pid}/selection`, { cookie: sarah }));
  expect((await b.api(`/api/projects/${pid}/finish`, { method: 'POST', cookie: sarah, body: JSON.stringify({ selectionVersion: sel2.summary.selectionVersion }) })).status).toBe(200);
  const version = async () => (await b.json<{ stateVersion: number }>(await b.api(`/api/projects/${pid}`, { cookie: owner }))).stateVersion;
  const publish = async (photoIds: string[], expectedVersion?: number) => b.post(`/api/projects/${pid}/publish`, { photoIds, expectedVersion: expectedVersion ?? await version() }, owner);
  const clientPhotos = async () => b.json<Photo[]>(await b.api(`/api/projects/${pid}/photos?stage=final`, { cookie: sarah }));
  const libraryTotal = async () => (await b.json<{ total: number }>(await b.api('/api/library', { cookie: owner }))).total;
  return { ...b, owner, sarah, pid, f1, f2, a: a!, upload, version, publish, clientPhotos, libraryTotal };
}

describe('publish api', () => {
  it('a draft is invisible to the Client until published, then visible; stale versions are 409 and change nothing', async () => {
    const { api, sarah, pid, f1, f2, version, publish, clientPhotos } = await boot();
    expect(await clientPhotos()).toEqual([]);
    expect((await api(`/api/photos/${f1}/preview?size=thumb`, { cookie: sarah })).status).toBe(404);
    const v = await version();
    const stale = await publish([f1], v - 1); expect(stale.status).toBe(409);
    expect(await clientPhotos()).toEqual([]);
    expect((await publish([f1, 'nope'])).status).toBe(422); // unknown photo: nothing published
    expect(await clientPhotos()).toEqual([]);
    const ok = await publish([f1]); expect(ok.status).toBe(200); expect(await ok.json()).toEqual({ published: 1 });
    expect((await clientPhotos()).map((p) => p.id)).toEqual([f1]); // f2 is still a draft
    expect((await api(`/api/photos/${f1}/preview?size=thumb`, { cookie: sarah })).status).toBe(200);
    expect((await api(`/api/photos/${f2}/preview?size=thumb`, { cookie: sarah })).status).toBe(404);
    expect(await version()).toBe(v + 1);
    expect((await api(`/api/projects/${pid}/publish`, { method: 'POST', cookie: sarah, body: JSON.stringify({ photoIds: [f2], expectedVersion: v + 1 }) })).status).toBe(401); // clients cannot publish (requireKind)
  });

  it('publishing a replacement keeps the photo id and swaps the bytes the Client sees', async () => {
    const { api, sarah, upload, drain, publish, clientPhotos, f1, a } = await boot();
    await publish([f1]); const v1 = (await clientPhotos())[0]!.v; expect(v1).toMatch(/^[0-9a-f]{12}$/);
    const before = Buffer.from(await (await api(`/api/photos/${f1}/preview?size=thumb`, { cookie: sarah })).arrayBuffer());
    const r = await upload('A.jpg', a, 'u3', '#33c'); expect(r.photoId).toBe(f1); await drain();
    expect(Buffer.from(await (await api(`/api/photos/${f1}/preview?size=thumb`, { cookie: sarah })).arrayBuffer()).equals(before)).toBe(true); // unchanged until published
    const mid = (await clientPhotos())[0]!.v; // the replacement's checksum has landed but the Client still sees the old bytes
    expect((await publish([f1])).status).toBe(200);
    const v2 = (await clientPhotos())[0]!.v; expect(v2).not.toBe(v1); expect(v2).not.toBe(mid); // the cached preview URL changes at publish
    const after = Buffer.from(await (await api(`/api/photos/${f1}/preview?size=thumb`, { cookie: sarah })).arrayBuffer());
    expect(after.equals(before)).toBe(false);
    const { data } = await sharp(after).raw().toBuffer({ resolveWithObject: true }); expect(data[2]! > data[0]!).toBe(true); // blue now
  });

  it('published finals count as Library photos', async () => {
    const { libraryTotal, publish, f1, f2 } = await boot();
    const n = await libraryTotal();
    await publish([f1, f2]); expect(await libraryTotal()).toBe(n + 2);
  });

  it('the project is delivered, the source RAW is done, and notifyOnPublish queues one email per Client address', async () => {
    const { api, post, owner, pid, f1, publish, mail, drain } = await boot();
    expect((await post(`/api/projects/${pid}`, { notifyOnPublish: true }, owner, 'PATCH')).status).toBe(200);
    await publish([f1]); await drain();
    const detail = await (await api(`/api/projects/${pid}`, { cookie: owner })).json() as { state: { production: string }; progress: { done: number } };
    expect(detail.state.production).toBe('delivered'); expect(detail.progress.done).toBe(1);
    const sent = mail.sent.filter((m) => m.subject.includes('ready'));
    expect(sent.map((m) => m.to).sort()).toEqual(['sarah@x.com', 'tom@x.com']);
    expect(sent[0]!.text).toContain(`/p/${pid}/gallery`);
  });

  it('a storage failure in the delete job leaves the publish done; the job retries and drafts then go', async () => {
    const { storage, db, handlers, drain, publish, f1, f2, clientPhotos } = await boot();
    const del = storage.delete; let down = true;
    storage.delete = async (k) => { if (down) throw new Error('r2 down'); await del(k); };
    expect((await publish([f1, f2])).status).toBe(200); await drain(); // the delete job fails once and is backed off
    expect((await clientPhotos()).length).toBe(2);
    expect(storage.keys().some((k) => k.endsWith(`/${f1}/draft`))).toBe(true);
    down = false; expect(await runOnce(db, handlers, Date.now() + 120_000)).toBe('ran');
    expect(storage.keys().some((k) => k.endsWith('/draft') || k.endsWith('.draft'))).toBe(false);
  });
});
