import { describe, it, expect } from 'vitest';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
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
import { events } from '../../src/server/db/schema.js';

const SMTP = { type: 'smtp', url: 'smtp://u:p@h:587', from: 'S <s@x>' };
const linkFrom = (text: string) => text.match(/http:\/\/localhost:3000\/auth\/[A-Za-z0-9_-]+/)![0];
const cookieOf = (res: Response) => res.headers.get('set-cookie')!.split(';')[0]!;

async function boot() {
  const photosDir = await tmpDir(); const dataDir = await tmpDir();
  await mkdir(join(photosDir, 'Clients'), { recursive: true });
  const config = loadConfig({ DATA_DIR: dataDir, PHOTOS_DIR: photosDir, BASE_URL: 'http://localhost:3000', SESSION_SECRET: 'x'.repeat(32) });
  const db = openDb(':memory:'); migrate(db);
  const app = createApp({ db, config, photosDir, webRoot: photosDir });
  const mail = memoryTransport();
  const handlers = { ...makeEmailHandlers(() => mail, 'localhost'), ...makePreviewHandlers(photosDir) };
  const drain = async () => { while ((await runOnce(db, handlers)) === 'ran') { /* */ } };
  const api = (path: string, init: RequestInit & { cookie?: string } = {}) =>
    app.request(path, { ...init, headers: { 'content-type': 'application/json', 'x-requested-with': 'fetch', ...(init.cookie ? { cookie: init.cookie } : {}), ...(init.headers ?? {}) } });
  const post = (path: string, body: unknown, cookie: string) => api(path, { method: 'POST', body: JSON.stringify(body), cookie });
  const json = async <T,>(res: Response) => (await res.json()) as T;
  const token = createSetupToken(db);
  await api('/api/setup', { method: 'POST', body: JSON.stringify({ token, ownerEmail: 'owner@x.com', studioName: 'S', email: SMTP }) }); await drain();
  const owner = cookieOf(await app.request(linkFrom(mail.sent.at(-1)!.text), { redirect: 'manual' }));
  const c = defaultClientJson('Smith'); c.emails = ['sarah@x.com', 'tom@x.com'];
  const p = defaultProjectJson('Wedding'); p.allowance = { included: 2, extraPrice: 1500, slots: 2 };
  await mkdir(join(photosDir, 'Clients/Smith/Wedding/raw'), { recursive: true });
  await writeJsonAtomic(join(photosDir, 'Clients/Smith/client.json'), c);
  await writeJsonAtomic(join(photosDir, 'Clients/Smith/Wedding/project.json'), p);
  for (const n of ['a', 'b', 'c']) await makeTiffAs(join(photosDir, `Clients/Smith/Wedding/raw/${n}.dng`));
  await rescan(db, photosDir); await indexProjectMedia(db, photosDir, p.id!); await drain();
  const signIn = async (email: string) => {
    const before = mail.sent.length;
    await post('/api/auth/request', { email }, ''); await drain();
    return cookieOf(await app.request(linkFrom(mail.sent[before]!.text), { redirect: 'manual' }));
  };
  const sarah = await signIn('sarah@x.com'); const tom = await signIn('tom@x.com');
  return { db, api, post, json, mail, drain, owner, sarah, tom, pid: p.id! };
}
type Summary = { selectionVersion: number; confirmed: number; pending: number; entitlement: number };
type PhotoItem = { id: string; pick: null | { state: string; byEmail: string; locked: boolean }; comments: { open: number; total: number }; previewReady: boolean };
type Detail = { selection: Summary; state: { production: string }; comments: { culling: boolean }; progress: { done: number; total: number } };

describe('portal api', () => {
  it('walks a shared culling round: pick, conflict, extras request, grant, finish, locked', async () => {
    const { db, api, post, json, mail, drain, owner, sarah, tom, pid } = await boot();
    let detail = await json<Detail>(await api(`/api/projects/${pid}`, { cookie: sarah }));
    expect(detail.state.production).toBe('culling'); expect(detail.selection).toMatchObject({ entitlement: 2, confirmed: 0 });
    expect(db.select().from(events).all().filter((e) => e.type === 'viewed')).toHaveLength(1);
    await api(`/api/projects/${pid}`, { cookie: sarah });
    expect(db.select().from(events).all().filter((e) => e.type === 'viewed')).toHaveLength(1); // throttled
    const photos = await json<PhotoItem[]>(await api(`/api/projects/${pid}/photos`, { cookie: sarah }));
    expect(photos).toHaveLength(3); expect(photos.every((p) => p.previewReady)).toBe(true);
    const [a, b, c] = photos.map((p) => p.id) as [string, string, string];
    let v = detail.selection.selectionVersion;
    let r = await post(`/api/projects/${pid}/picks`, { photoId: a, picked: true, selectionVersion: v }, sarah);
    expect(r.status).toBe(200); v = (await json<{ summary: Summary }>(r)).summary.selectionVersion;
    r = await post(`/api/projects/${pid}/picks`, { photoId: b, picked: true, selectionVersion: v - 1 }, tom);
    expect(r.status).toBe(409); expect((await json<{ selectionVersion: number }>(r)).selectionVersion).toBe(v);
    r = await post(`/api/projects/${pid}/picks`, { photoId: b, picked: true, selectionVersion: v }, tom); v = (await json<{ summary: Summary }>(r)).summary.selectionVersion;
    r = await post(`/api/projects/${pid}/picks`, { photoId: c, picked: true, selectionVersion: v }, sarah);
    const s = (await json<{ summary: Summary }>(r)).summary; v = s.selectionVersion;
    expect(s).toMatchObject({ confirmed: 2, pending: 1 });
    r = await post(`/api/projects/${pid}/finish`, { selectionVersion: v }, sarah);
    expect(r.status).toBe(422); expect(await json<{ error: string }>(r)).toEqual({ error: 'pending_picks' });
    const before = mail.sent.length;
    expect((await post(`/api/projects/${pid}/extras-request`, { count: 1 }, sarah)).status).toBe(200); await drain();
    expect(mail.sent.length).toBe(before + 1); expect(mail.sent.at(-1)!.subject).toMatch(/1 extra photos/);
    expect((await post(`/api/projects/${pid}/grant`, { delta: 1 }, sarah)).status).toBe(401);
    r = await post(`/api/projects/${pid}/grant`, { delta: 1 }, owner);
    expect(await json<Summary>(r)).toMatchObject({ entitlement: 3, confirmed: 3, pending: 0 });
    detail = await json<Detail>(await api(`/api/projects/${pid}`, { cookie: sarah })); v = detail.selection.selectionVersion;
    expect((await post(`/api/projects/${pid}/finish`, { selectionVersion: v - 1 }, sarah)).status).toBe(409);
    r = await post(`/api/projects/${pid}/finish`, { selectionVersion: v }, tom);
    expect(r.status).toBe(200); expect(await json<{ round: number; count: number }>(r)).toEqual({ round: 1, count: 3 });
    await drain(); expect(mail.sent.at(-1)).toMatchObject({ to: 'owner@x.com' });
    detail = await json<Detail>(await api(`/api/projects/${pid}`, { cookie: sarah }));
    expect(detail.state.production).toBe('editing'); expect(detail.progress).toEqual({ done: 0, total: 3 });
    const after = await json<PhotoItem[]>(await api(`/api/projects/${pid}/photos`, { cookie: sarah }));
    expect(after.every((p) => p.pick?.locked)).toBe(true);
    expect((await post(`/api/projects/${pid}/picks`, { photoId: a, picked: false, selectionVersion: detail.selection.selectionVersion }, sarah)).status).toBe(422);
  });
  it('comments: client adds within toggle, admin resolves, counts surface on photos', async () => {
    const { api, post, json, owner, sarah, pid } = await boot();
    const [a] = (await json<PhotoItem[]>(await api(`/api/projects/${pid}/photos`, { cookie: sarah }))).map((p) => p.id);
    const r = await post(`/api/photos/${a}/comments`, { text: 'soften', x: 0.1, y: 0.1, w: 0.2, h: 0.2 }, sarah);
    expect(r.status).toBe(201); const c = await json<{ id: string }>(r);
    expect((await post(`/api/photos/${a}/comments`, { text: '' }, sarah)).status).toBe(422);
    expect((await post(`/api/comments/${c.id}/resolve`, { resolved: true }, sarah)).status).toBe(401);
    expect((await post(`/api/comments/${c.id}/resolve`, { resolved: true }, owner)).status).toBe(200);
    expect((await post(`/api/comments/nope/resolve`, { resolved: true }, owner)).status).toBe(404);
    expect(await json<unknown[]>(await api(`/api/photos/${a}/comments`, { cookie: sarah }))).toHaveLength(1);
    const photos = await json<PhotoItem[]>(await api(`/api/projects/${pid}/photos`, { cookie: sarah }));
    expect(photos.find((p) => p.id === a)?.comments).toEqual({ open: 0, total: 1 });
    expect((await api(`/api/photos/${a}/comments`)).status).toBe(404);
    expect((await post(`/api/photos/${a}/comments`, { text: 'x' }, '')).status).toBe(404);
  });
  it('admin allowance and cancel-round; invalid allowance refused', async () => {
    const { api, post, json, owner, sarah, pid } = await boot();
    let r = await post(`/api/projects/${pid}/allowance`, { included: 5 }, owner);
    expect(await json<Summary>(r)).toMatchObject({ entitlement: 5 });
    const [a] = (await json<PhotoItem[]>(await api(`/api/projects/${pid}/photos`, { cookie: sarah }))).map((p) => p.id);
    const sel = await json<{ summary: Summary }>(await api(`/api/projects/${pid}/selection`, { cookie: sarah }));
    await post(`/api/projects/${pid}/picks`, { photoId: a, picked: true, selectionVersion: sel.summary.selectionVersion }, sarah);
    expect((await post(`/api/projects/${pid}/cancel-round`, {}, owner)).status).toBe(200);
    expect((await json<{ picks: unknown[] }>(await api(`/api/projects/${pid}/selection`, { cookie: sarah }))).picks).toEqual([]);
    r = await post(`/api/projects/${pid}/allowance`, { included: -1 }, owner); expect(r.status).toBe(400);
  });
});
