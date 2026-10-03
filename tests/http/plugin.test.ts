import { describe, it, expect } from 'vitest';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import sharp from 'sharp';
import { tmpDir } from '../helpers.js';
import { makeTiffAs } from '../fixtures/make.js';
import { openDb, migrate } from '../../src/server/db/client.js';
import { loadConfig } from '../../src/server/config.js';
import { createApp } from '../../src/server/app.js';
import { createSetupToken } from '../../src/server/auth/bootstrap.js';
import { runOnce } from '../../src/server/jobs/queue.js';
import { makeEmailHandlers } from '../../src/server/email/send.js';
import { memoryTransport } from '../../src/server/email/transport.js';
import { rescan } from '../../src/server/fs/index.js';
import { indexProjectMedia, makePreviewHandlers } from '../../src/server/fs/photos.js';
import { writeJsonAtomic } from '../../src/server/fs/json.js';
import { defaultClientJson, defaultProjectJson } from '../../src/server/fs/schemas.js';

const SMTP = { type: 'smtp', url: 'smtp://u:p@h:587', from: 'S <s@x>' };
const linkFrom = (text: string) => text.match(/http:\/\/localhost:3000\/auth\/[A-Za-z0-9_-]+/)![0];
const cookieOf = (res: Response) => res.headers.get('set-cookie')!.split(';')[0]!;
const jpeg = (bg = '#c33') => sharp({ create: { width: 40, height: 30, channels: 3, background: bg } }).jpeg().toBuffer();

async function boot() {
  const photosDir = await tmpDir(); const dataDir = await tmpDir();
  await mkdir(join(photosDir, 'Clients'), { recursive: true });
  const config = loadConfig({ DATA_DIR: dataDir, PHOTOS_DIR: photosDir, BASE_URL: 'http://localhost:3000', SESSION_SECRET: 'x'.repeat(32) });
  const db = openDb(':memory:'); migrate(db);
  const app = createApp({ db, config, photosDir, webRoot: photosDir });
  const mail = memoryTransport(); const handlers = { ...makeEmailHandlers(() => mail, 'localhost'), ...makePreviewHandlers(photosDir) };
  const drain = async () => { while ((await runOnce(db, handlers)) === 'ran') { /* */ } };
  const api = (path: string, init: RequestInit & { cookie?: string; bearer?: string } = {}) =>
    app.request(path, { ...init, headers: { ...(init.body instanceof FormData ? {} : { 'content-type': 'application/json' }), ...(init.cookie ? { cookie: init.cookie, 'x-requested-with': 'fetch' } : {}), ...(init.bearer ? { authorization: `Bearer ${init.bearer}` } : {}), ...(init.headers ?? {}) } });
  const json = async <T,>(res: Response) => (await res.json()) as T;
  const token = createSetupToken(db);
  await api('/api/setup', { method: 'POST', headers: { 'x-requested-with': 'fetch' }, body: JSON.stringify({ token, ownerEmail: 'owner@x.com', studioName: 'S', email: SMTP }) }); await drain();
  const owner = cookieOf(await app.request(linkFrom(mail.sent.at(-1)!.text), { redirect: 'manual' }));
  const c = defaultClientJson('Smith'); c.emails = ['sarah@x.com']; const p = defaultProjectJson('Wedding'); p.allowance = { included: 5, extraPrice: 0, slots: 5 };
  const q = defaultProjectJson('Other');
  await mkdir(join(photosDir, 'Clients/Smith/Wedding/raw'), { recursive: true }); await mkdir(join(photosDir, 'Clients/Smith/Other'), { recursive: true });
  await writeJsonAtomic(join(photosDir, 'Clients/Smith/client.json'), c); await writeJsonAtomic(join(photosDir, 'Clients/Smith/Wedding/project.json'), p); await writeJsonAtomic(join(photosDir, 'Clients/Smith/Other/project.json'), q);
  for (const n of ['a', 'b']) await makeTiffAs(join(photosDir, `Clients/Smith/Wedding/raw/${n}.dng`));
  await rescan(db, photosDir); await indexProjectMedia(db, photosDir, p.id!); await drain();
  const sarah = await (async () => { const before = mail.sent.length; await api('/api/auth/request', { method: 'POST', headers: { 'x-requested-with': 'fetch' }, body: JSON.stringify({ email: 'sarah@x.com' }) }); await drain(); return cookieOf(await app.request(linkFrom(mail.sent[before]!.text), { redirect: 'manual' })); })();
  const mint = async (body: unknown) => (await json<{ id: string; token: string }>(await api('/api/access/tokens', { method: 'POST', body: JSON.stringify(body), cookie: owner })));
  return { db, api, json, drain, owner, sarah, pid: p.id!, qid: q.id!, mint };
}
type Photo = { id: string; relPath: string; pick: null | { locked: boolean } };

describe('plugin api', () => {
  it('walks the plugin flow with a bearer token', async () => {
    const { api, json, drain, owner, sarah, pid, qid, mint } = await boot();
    expect((await api('/api/plugin/me')).status).toBe(401);
    expect((await api('/api/plugin/me', { cookie: owner })).status).toBe(401); // admins are not plugins
    const rw = await mint({ name: 'Sam', scope: 'read+write' });
    const ro = await mint({ name: 'Viewer', scope: 'read' });
    const scoped = await mint({ name: 'One', scope: 'read+write', projectId: qid });
    expect(await json<{ name: string; studio: string }>(await api('/api/plugin/me', { bearer: rw.token }))).toMatchObject({ name: 'Sam', scope: 'read+write', studio: 'S' });
    const projects = await json<{ id: string; title: string; client: string; folders: { finals: string } }[]>(await api('/api/plugin/projects', { bearer: rw.token }));
    expect(projects.map((p) => p.title).sort()).toEqual(['Other', 'Wedding']); expect(projects[0]!.client).toBe('Smith');
    expect((await json<unknown[]>(await api('/api/plugin/projects', { bearer: scoped.token }))).length).toBe(1);
    expect((await api(`/api/plugin/projects/${pid}/picks`, { bearer: scoped.token })).status).toBe(404); // scoped to Other
    // resolve paths → source ids
    const res = await json<{ paths: Record<string, string | null> }>(await api(`/api/plugin/projects/${pid}/resolve`, { method: 'POST', bearer: rw.token, body: JSON.stringify({ paths: ['raw/a.dng', 'raw/b.dng', 'raw/nope.dng'] }) }));
    const a = res.paths['raw/a.dng']!; const b = res.paths['raw/b.dng']!; expect(a && b).toBeTruthy(); expect(res.paths['raw/nope.dng']).toBeNull();
    // upload two finals with the same name from two sources; read-only token refused
    const up = async (token: string, name: string, src: string, uploadId: string, bg = '#c33') => { const fd = new FormData(); fd.append('file', new Blob([await jpeg(bg)], { type: 'image/jpeg' }), name); fd.append('name', name); fd.append('sourcePhotoId', src); fd.append('uploadId', uploadId); return api(`/api/plugin/projects/${pid}/finals`, { method: 'POST', body: fd, bearer: token }); };
    expect((await up(ro.token, 'DSC_1.jpg', a, 'u0')).status).toBe(403);
    let r = await up(rw.token, 'DSC_1.jpg', a, 'u1'); expect(r.status).toBe(201); const f1 = await json<{ photoId: string; relPath: string }>(r);
    r = await up(rw.token, 'DSC_1.jpg', b, 'u2'); expect(r.status).toBe(201); const f2 = await json<{ photoId: string; relPath: string }>(r);
    expect([f1.relPath, f2.relPath]).toEqual(['finals/DSC_1.jpg', 'finals/DSC_1 (2).jpg']);
    r = await up(rw.token, 'DSC_1.jpg', a, 'u1'); expect(r.status).toBe(200); expect((await json<{ idempotent: boolean }>(r)).idempotent).toBe(true);
    await drain();
    // drafts are invisible to the client, visible to the admin, and the client cannot fetch their preview
    expect((await json<Photo[]>(await api(`/api/projects/${pid}/photos?stage=final`, { cookie: sarah }))).length).toBe(0);
    expect((await json<Photo[]>(await api(`/api/projects/${pid}/photos?stage=final`, { cookie: owner }))).length).toBe(2);
    expect((await api(`/api/photos/${f1.photoId}/preview?size=thumb`, { cookie: sarah })).status).toBe(404);
    expect((await api(`/api/photos/${f1.photoId}/preview?size=thumb&draft=1`, { cookie: owner })).status).toBe(200);
    // client picks and finishes → plugin sees submitted picks
    const sel = await json<{ summary: { selectionVersion: number } }>(await api(`/api/projects/${pid}/selection`, { cookie: sarah }));
    await api(`/api/projects/${pid}/picks`, { method: 'POST', cookie: sarah, body: JSON.stringify({ photoId: a, picked: true, selectionVersion: sel.summary.selectionVersion }) });
    expect((await json<{ picks: unknown[] }>(await api(`/api/plugin/projects/${pid}/picks`, { bearer: rw.token }))).picks).toEqual([]);
    const sel2 = await json<{ summary: { selectionVersion: number } }>(await api(`/api/projects/${pid}/selection`, { cookie: sarah }));
    expect((await api(`/api/projects/${pid}/finish`, { method: 'POST', cookie: sarah, body: JSON.stringify({ selectionVersion: sel2.summary.selectionVersion }) })).status).toBe(200);
    const picks = await json<{ round: number; picks: { photoId: string; relPath: string }[] }>(await api(`/api/plugin/projects/${pid}/picks`, { bearer: rw.token }));
    expect(picks).toMatchObject({ round: 1, picks: [{ photoId: a, relPath: 'raw/a.dng' }] });
    // comments with hints, a reply from Lightroom, progress
    await api(`/api/photos/${a}/comments`, { method: 'POST', cookie: sarah, body: JSON.stringify({ text: 'brighter', x: 0.7, y: 0.7, w: 0.2, h: 0.2 }) });
    const cs = await json<{ text: string; hint: string | null; relPath: string }[]>(await api(`/api/plugin/projects/${pid}/comments`, { bearer: rw.token }));
    expect(cs).toEqual([expect.objectContaining({ text: 'brighter', hint: 'bottom-right', relPath: 'raw/a.dng' })]);
    expect((await api(`/api/plugin/photos/${a}/comments`, { method: 'POST', bearer: rw.token, body: JSON.stringify({ text: 'will do' }) })).status).toBe(201);
    expect((await json<unknown[]>(await api(`/api/plugin/projects/${pid}/comments`, { bearer: rw.token }))).length).toBe(2);
    expect(await json<unknown>(await api(`/api/plugin/projects/${pid}/progress`, { method: 'POST', bearer: rw.token, body: JSON.stringify({ reports: [{ photoId: a, state: 'editing' }, { photoId: b, state: 'editing' }] }) }))).toEqual({ updated: 1, skipped: 1 });
    expect((await json<{ progress: { done: number; total: number } }>(await api(`/api/projects/${pid}`, { cookie: sarah }))).progress).toEqual({ done: 0, total: 1 });
    // delete a draft; a scoped token cannot touch it; a live final is refused
    expect((await api(`/api/plugin/finals/${f2.photoId}`, { method: 'DELETE', bearer: scoped.token })).status).toBe(404);
    expect((await api(`/api/plugin/finals/${f2.photoId}`, { method: 'DELETE', bearer: rw.token })).status).toBe(200);
    expect((await api(`/api/plugin/finals/${f2.photoId}`, { method: 'DELETE', bearer: rw.token })).status).toBe(404);
    // create a project from the plugin; a scoped token cannot
    const cl = await json<{ id: string }[]>(await api('/api/plugin/clients', { bearer: rw.token }));
    expect((await api('/api/plugin/projects', { method: 'POST', bearer: scoped.token, body: JSON.stringify({ clientId: cl[0]!.id, title: 'X' }) })).status).toBe(403);
    expect((await api('/api/plugin/projects', { method: 'POST', bearer: rw.token, body: JSON.stringify({ clientId: cl[0]!.id, title: 'Engagement' }) })).status).toBe(201);
    // revoke → 401
    expect((await api(`/api/access/tokens/${rw.id}`, { method: 'DELETE', cookie: owner })).status).toBe(200);
    expect((await api('/api/plugin/me', { bearer: rw.token })).status).toBe(401);
    expect((await json<{ id: string }[]>(await api('/api/access/tokens', { cookie: owner }))).map((t) => t.id).sort()).toEqual([ro.id, scoped.id].sort());
  });
});
