import { describe, it, expect } from 'vitest';
import sharp from 'sharp';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { runOnce } from '../../src/server/jobs/queue.js';
import { tmpDir } from '../helpers.js';
import { _hits } from '../../src/server/http/routes/auth.js';
import { boot as bootApp } from './boot.js';

const jpeg = (bg = '#c33') => sharp({ create: { width: 40, height: 30, channels: 3, background: bg } }).jpeg().toBuffer();
type Photo = { id: string; hasDraft: boolean; v: string };

/** A project in editing with two drafts uploaded from Lightroom and the client's pick submitted. */
async function boot() {
  _hits.clear(); // sign-in requests are rate limited in process; every test here signs in several people
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
  const download = (body: { photoId?: string }, cookie = sarah) => b.post(`/api/projects/${pid}/download`, body, cookie);
  /** The entry names of the ZIP behind a download URL, and the URL's file name. */
  const zipNames = async (url: string) => {
    const res = await b.app.request(url); expect(res.status).toBe(200);
    const f = join(await tmpDir(), 'g.zip'); await writeFile(f, Buffer.from(await res.arrayBuffer()));
    return (await promisify(execFile)('unzip', ['-Z1', f])).stdout.trim().split('\n').sort();
  };
  return { ...b, owner, sarah, pid, f1, f2, a: a!, upload, version, publish, clientPhotos, libraryTotal, download, zipNames };
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

describe('client gallery', () => {
  it('single download is a signed URL to the live original; drafts and RAWs are 404', async () => {
    const { app, json, f1, f2, a, publish, download, storage } = await boot();
    const none = await download({}); expect(none.status).toBe(403); expect(await json(none)).toEqual({ error: 'no_finals' });
    await publish([f1]);
    const res = await download({ photoId: f1 }); expect(res.status).toBe(200);
    const { url } = await json<{ url: string }>(res); expect(decodeURIComponent(url)).toContain('filename="A.jpg"');
    const got = await app.request(url); expect(got.headers.get('content-disposition')).toContain('A.jpg');
    const live = storage.keys().find((k) => k.endsWith(`/${f1}/original`))!;
    expect(Buffer.from(await got.arrayBuffer()).equals(Buffer.from((await storage.getBytes(live))!))).toBe(true);
    for (const id of [f2, a]) expect((await download({ photoId: id })).status).toBe(404);
  });

  it('download all is preparing, then a ZIP of exactly the live finals', async () => {
    const { json, db, f1, publish, download, drain, zipNames } = await boot();
    await publish([f1]); // f2 stays a draft
    const first = await download({}); expect(first.status).toBe(202); expect(await first.json()).toEqual({ preparing: true });
    expect((await download({})).status).toBe(202); // still building: the same job
    expect((await db.select().from((await import('../../src/server/db/schema.js')).jobs)).filter((j) => j.kind === 'build_zip')).toHaveLength(1);
    await drain();
    const ok = await download({}); expect(ok.status).toBe(200);
    const { url } = await json<{ url: string }>(ok); expect(decodeURIComponent(url)).toContain('filename="Wedding.zip"');
    expect(await zipNames(url)).toEqual(['A.jpg']);
  });

  it('publishing another final makes a new ZIP, never the stale one', async () => {
    const { app, json, storage, f1, f2, a, publish, download, drain, upload, zipNames } = await boot();
    await publish([f1]);
    expect((await download({})).status).toBe(202); // requested while building ...
    await publish([f2]); await drain(); // ... then a new final lands: the old job ends quietly
    expect((await download({})).status).toBe(202);
    await drain();
    const url1 = (await json<{ url: string }>(await download({}))).url; expect(await zipNames(url1)).toEqual(['A.jpg', 'B.jpg']);
    // a replacement changes the bytes of A, not the set of ids; a ZIP built before its publish must not be served after it
    await upload('A.jpg', a, 'u3', '#33c'); await drain();
    expect((await download({})).status).toBe(202); await drain();
    const mid = (await json<{ url: string }>(await download({}))).url;
    await publish([f1]);
    expect((await download({})).status).toBe(202); await drain();
    const url2 = (await json<{ url: string }>(await download({}))).url; expect([url1, mid]).not.toContain(url2);
    const live = (await storage.getBytes(storage.keys().find((k) => k.endsWith(`/${f1}/original`))!))!;
    expect(Buffer.from(await (await app.request(url2)).arrayBuffer()).indexOf(Buffer.from(live))).toBeGreaterThan(0); // stored (-0): the new A's bytes are in the ZIP verbatim
  });

  it('a Client of another project or Studio gets 404 on favorites and download', async () => {
    const { api, post, signIn, signupOwner, seedProject, owner, pid, f1, publish } = await boot();
    await publish([f1]);
    const { projectId: other } = await seedProject(owner, { emails: ['zed@x.com'], title: 'Other' });
    const zed = await signIn('zed@x.com');
    const { cookie: o2 } = await signupOwner('o2@x.com', 'S2'); await seedProject(o2, { emails: ['eve@x.com'] });
    const eve = await signIn('eve@x.com', 'S2');
    for (const c of [zed, eve, o2]) {
      expect((await api(`/api/projects/${pid}/favorites`, { cookie: c })).status).toBe(404);
      expect((await post(`/api/projects/${pid}/download`, {}, c)).status).toBe(404);
      expect((await post(`/api/projects/${pid}/download`, { photoId: f1 }, c)).status).toBe(404);
      expect((await post(`/api/photos/${f1}/favorite`, { favorite: true }, c)).status).toBe(404);
    }
    expect((await post(`/api/projects/${other}/download`, { photoId: f1 }, zed)).status).toBe(404); // own project, someone else's photo
  });

  it('favorites count across sessions and list mine', async () => {
    const { api, post, json, signIn, owner, sarah, pid, f1, f2, a, publish } = await boot();
    const favs = (cookie: string) => api(`/api/projects/${pid}/favorites`, { cookie }).then((r) => json<{ counts: Record<string, number>; mine: string[] }>(r));
    const heart = (id: string, favorite: boolean, cookie: string) => post(`/api/photos/${id}/favorite`, { favorite }, cookie);
    expect((await heart(f1, true, sarah)).status).toBe(404); // a draft
    await publish([f1, f2]);
    expect((await heart(a, true, sarah)).status).toBe(404); // a culling RAW
    expect((await heart(f1, true, sarah)).status).toBe(200); expect((await heart(f1, true, sarah)).status).toBe(200); // idempotent
    const tom = await signIn('tom@x.com');
    await heart(f1, true, tom); await heart(f2, true, tom); await heart(f2, true, owner);
    expect(await favs(sarah)).toEqual({ counts: { [f1]: 2, [f2]: 2 }, mine: [f1] });
    const sarah2 = await signIn('sarah@x.com'); // a new session: hearts follow the person
    expect((await favs(sarah2)).mine).toEqual([f1]);
    await heart(f1, false, sarah2);
    expect(await favs(sarah)).toEqual({ counts: { [f1]: 1, [f2]: 2 }, mine: [] });
    expect((await favs(owner)).mine).toEqual([f2]);
  });

  it('downloads are refused with the reason when not allowed', async () => {
    const { post, json, owner, pid, f1, publish, download } = await boot();
    await publish([f1]);
    expect((await post(`/api/projects/${pid}`, { downloads: 'none' }, owner, 'PATCH')).status).toBe(200);
    const r = await download({}); expect(r.status).toBe(403); expect(await json(r)).toEqual({ error: 'disabled' });
  });
});
