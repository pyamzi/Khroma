import { describe, it, expect } from 'vitest';
import { mkdir, rename } from 'node:fs/promises';
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

const SMTP = { type: 'smtp', url: 'smtp://u:p@h:587', from: 'S <s@x>' };

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
  const setupOwner = async () => {
    const token = createSetupToken(db);
    const res = await api('/api/setup', { method: 'POST', body: JSON.stringify({ token, ownerEmail: 'owner@x.com', studioName: 'S', email: SMTP }) });
    expect(res.status).toBe(200); await drain();
    return app.request(linkFrom(mail.sent.at(-1)!.text), { redirect: 'manual' });
  };
  return { db, app, api, mail, drain, photosDir, setupOwner };
}
const linkFrom = (text: string) => text.match(/http:\/\/localhost:3000\/auth\/[A-Za-z0-9_-]+/)![0];
const cookieOf = (res: Response) => res.headers.get('set-cookie')!.split(';')[0]!;

describe('app', () => {
  it('bootstraps with SMTP only, signs the owner in, gates the api until then', async () => {
    const { db, api, app, mail, drain } = await boot();
    expect((await (await api('/healthz')).json()).setup).toBe('unconfigured');
    expect((await api('/api/projects')).status).toBe(503);
    const token = createSetupToken(db);
    let res = await api('/api/setup', { method: 'POST', body: JSON.stringify({ token, ownerEmail: 'owner@x.com', studioName: 'S', email: SMTP }) });
    expect(res.status).toBe(200);
    await drain(); expect(mail.sent).toHaveLength(1);
    expect((await api('/api/projects')).status).toBe(503);              // still awaiting verification
    const link = linkFrom(mail.sent[0]!.text);
    res = await app.request(link, { redirect: 'manual' });
    expect(res.status).toBe(302); expect(res.headers.get('location')).toBe('/');
    const cookie = cookieOf(res); expect(cookie).toMatch(/^og_session=/); expect(res.headers.get('set-cookie')).toMatch(/HttpOnly/);
    expect((await (await api('/healthz')).json()).setup).toBe('complete');
    expect(await (await api('/api/me', { cookie })).json()).toMatchObject({ kind: 'admin', isAdmin: true });
    expect((await app.request(link, { redirect: 'manual' })).headers.get('location')).toMatch(/error=expired/); // single use
    expect((await api('/api/issues', { cookie })).status).toBe(200);
    await api('/api/auth/signout', { method: 'POST', cookie });
    expect((await api('/api/me', { cookie })).status).toBe(401);
  });
  it('serves a client only their project and its previews', async () => {
    const { db, api, app, mail, drain, photosDir, setupOwner } = await boot();
    await setupOwner();
    const c = defaultClientJson('Smith'); c.emails = ['sarah@x.com']; const p = defaultProjectJson('Wedding'); const q = defaultProjectJson('Other');
    await mkdir(join(photosDir, 'Clients/Smith/Wedding/raw'), { recursive: true }); await mkdir(join(photosDir, 'Clients/Jones/Other'), { recursive: true });
    await writeJsonAtomic(join(photosDir, 'Clients/Smith/client.json'), c);
    await writeJsonAtomic(join(photosDir, 'Clients/Smith/Wedding/project.json'), p);
    await writeJsonAtomic(join(photosDir, 'Clients/Jones/client.json'), defaultClientJson('Jones'));
    await writeJsonAtomic(join(photosDir, 'Clients/Jones/Other/project.json'), q);
    await makeTiffAs(join(photosDir, 'Clients/Smith/Wedding/raw/a.dng'));
    await rescan(db, photosDir); await indexProjectMedia(db, photosDir, p.id!); await drain();

    await api('/api/auth/request', { method: 'POST', body: JSON.stringify({ email: 'Sarah@x.com' }) }); await drain();
    expect(mail.sent).toHaveLength(2);
    const res = await app.request(linkFrom(mail.sent[1]!.text), { redirect: 'manual' }); const cookie = cookieOf(res);
    const list = await (await api('/api/projects', { cookie })).json() as { id: string }[];
    expect(list.map((x) => x.id)).toEqual([p.id]);
    expect((await api(`/api/projects/${q.id}`, { cookie })).status).toBe(404);
    expect((await api(`/api/projects/${q.id}/photos`, { cookie })).status).toBe(404);
    const photos = await (await api(`/api/projects/${p.id}/photos`, { cookie })).json() as { id: string }[];
    expect(photos).toHaveLength(1);
    const img = await api(`/api/photos/${photos[0]!.id}/preview?size=thumb`, { cookie });
    expect(img.status).toBe(200); expect(img.headers.get('content-type')).toBe('image/jpeg');
    expect((await api(`/api/photos/${photos[0]!.id}/preview`)).status).toBe(404);          // no session → not found, no leak
    expect((await api(`/api/projects/${p.id}/approve-transfer`, { method: 'POST', cookie })).status).toBe(401); // client is not admin
    await api('/api/auth/request', { method: 'POST', body: JSON.stringify({ email: 'stranger@x.com' }) }); await drain();
    expect(mail.sent).toHaveLength(2);                                                        // unknown email: nothing sent, same 200
  });
  it('admin approves a cross-client transfer and the issue clears', async () => {
    const { db, api, app, mail, photosDir, setupOwner } = await boot();
    const owner = await setupOwner(); const cookie = cookieOf(owner);
    const p = defaultProjectJson('Wedding');
    await mkdir(join(photosDir, 'Clients/Smith/Wedding'), { recursive: true }); await mkdir(join(photosDir, 'Clients/Other'), { recursive: true });
    await writeJsonAtomic(join(photosDir, 'Clients/Smith/client.json'), defaultClientJson('Smith'));
    await writeJsonAtomic(join(photosDir, 'Clients/Other/client.json'), defaultClientJson('Other'));
    await writeJsonAtomic(join(photosDir, 'Clients/Smith/Wedding/project.json'), p);
    await rescan(db, photosDir);
    await rename(join(photosDir, 'Clients/Smith/Wedding'), join(photosDir, 'Clients/Other/Wedding'));
    await rescan(db, photosDir);
    expect((await (await api('/api/issues', { cookie })).json() as { kind: string }[]).map((i) => i.kind)).toEqual(['transfer_pending']);
    expect((await api(`/api/projects/${p.id}/approve-transfer`, { method: 'POST', cookie })).status).toBe(200);
    expect(await (await api('/api/issues', { cookie })).json()).toEqual([]);
    expect((await (await api(`/api/projects/${p.id}`, { cookie })).json() as { transferPending: boolean; available: boolean })).toMatchObject({ transferPending: false, available: true });
    expect((await api(`/api/projects/${p.id}/approve-transfer`, { method: 'POST', cookie })).status).toBe(409); // nothing pending now
    void mail; void app;
  });
  it('rejects state-changing requests without the fetch header', async () => {
    const { app } = await boot();
    const res = await app.request('/api/auth/request', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"email":"a@x"}' });
    expect(res.status).toBe(403);
  });
  it('sets security headers', async () => {
    const { api } = await boot(); const res = await api('/healthz');
    expect(res.headers.get('x-content-type-options')).toBe('nosniff');
    expect(res.headers.get('content-security-policy')).toContain("default-src 'self'");
  });
});
