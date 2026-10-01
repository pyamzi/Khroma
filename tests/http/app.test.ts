import { describe, it, expect } from 'vitest';
import { boot, linkFrom, cookieOf, BASE } from './boot.js';
import { createApp } from '../../src/server/app.js';
import { createAuth } from '../../src/server/auth/better.js';
import { loadConfig } from '../../src/server/config.js';
import { memoryTransport } from '../../src/server/email/transport.js';
import { r2Storage } from '../../src/server/storage.js';
import { testDb, tmpDir } from '../helpers.js';

describe('app', () => {
  it('signup emails a link that signs the new owner in once', async () => {
    const { api, post, app, mail, drain } = await boot();
    const r = await post('/api/signup', { email: 'Owner@X.com', studioName: 'Lumen', over18: true }, '');
    expect(r.status).toBe(200); expect(await r.json()).toEqual({ ok: true });
    await drain(); expect(mail.sent).toHaveLength(1); expect(mail.sent[0]).toMatchObject({ to: 'owner@x.com', fromName: 'OpenGallery' }); // unconfirmed: the platform speaks
    const link = linkFrom(mail.sent[0]!.text);
    const verify = await app.request(link, { redirect: 'manual' });
    expect(verify.status).toBe(302); expect(new URL(verify.headers.get('location')!).pathname).toBe('/auth/continue');
    expect(verify.headers.get('set-cookie')).toMatch(/^og\.session_token=[^;]+;.*HttpOnly/i);
    const cookie = cookieOf(verify);
    expect((await app.request(verify.headers.get('location')!, { redirect: 'manual', headers: { cookie } })).headers.get('location')).toBe('/');
    expect(await (await api('/api/me', { cookie })).json()).toMatchObject({ kind: 'admin', isAdmin: true, studio: { name: 'Lumen' } });
    const again = await app.request(link, { redirect: 'manual' }); // single use: no new session, and without one the callback says expired
    expect(again.headers.get('set-cookie')).toBeNull();
    expect((await app.request(again.headers.get('location')!, { redirect: 'manual' })).headers.get('location')).toBe('/signin?error=expired');
    const out = await api('/api/auth/signout', { method: 'POST', cookie });
    expect(await out.json()).toEqual({ ok: true }); expect(out.headers.get('set-cookie')).toMatch(/og\.session_token=;/);
    expect((await api('/api/me', { cookie })).status).toBe(401);
  });
  it('an H1 /auth/<token> link now says expired', async () => {
    const { app } = await boot();
    const res = await app.request('/auth/Zm9vYmFyYmF6cXV4MTIzNDU2Nzg5MGFiY2RlZmdoaWo', { redirect: 'manual' });
    expect(res.status).toBe(302); expect(res.headers.get('location')).toBe('/signin?error=expired');
  });
  it('signup validates its body and never reveals whether the email exists', async () => {
    const { post, mail, drain } = await boot();
    expect((await post('/api/signup', { email: 'a@x.com', studioName: 'S', over18: false }, '')).status).toBe(400);
    expect((await post('/api/signup', { email: 'a@x.com', studioName: '', over18: true }, '')).status).toBe(400);
    expect((await post('/api/signup', { email: 'nope', studioName: 'S', over18: true }, '')).status).toBe(400);
    const first = await post('/api/signup', { email: 'a@x.com', studioName: 'S', over18: true }, '');
    const again = await post('/api/signup', { email: 'a@x.com', studioName: 'T', over18: true }, '');
    expect([first.status, await first.json()]).toEqual([again.status, await again.json()]);
    await drain(); expect(mail.sent.map((m) => [m.to, m.fromName])).toEqual([['a@x.com', 'OpenGallery'], ['a@x.com', 'OpenGallery']]);
  });
  it('serves a client only their project and its previews', async () => {
    const { api, post, json, mail, drain, redeemLatest, signupOwner, seedProject, addCulling } = await boot();
    const { cookie: owner, studioId } = await signupOwner('owner@x.com', 'S');
    const p = await seedProject(owner, { emails: ['sarah@x.com'] }); const q = await seedProject(owner, { client: 'Jones', title: 'Other' });
    await addCulling(studioId, p.projectId, ['a']);
    const before = mail.sent.length;
    await post('/api/auth/request', { email: 'Sarah@x.com' }, ''); await drain();
    expect(mail.sent.length).toBe(before + 1);
    const cookie = await redeemLatest('sarah@x.com');
    expect((await json<{ id: string }[]>(await api('/api/projects', { cookie }))).map((x) => x.id)).toEqual([p.projectId]);
    expect((await api(`/api/projects/${q.projectId}`, { cookie })).status).toBe(404);
    expect((await api(`/api/projects/${q.projectId}/photos`, { cookie })).status).toBe(404);
    const photos = await json<{ id: string }[]>(await api(`/api/projects/${p.projectId}/photos`, { cookie }));
    expect(photos).toHaveLength(1);
    const img = await api(`/api/photos/${photos[0]!.id}/preview?size=thumb`, { cookie });
    expect(img.status).toBe(200); expect(img.headers.get('content-type')).toBe('image/jpeg');
    expect((await img.arrayBuffer()).byteLength).toBeGreaterThan(100);
    expect((await api(`/api/photos/${photos[0]!.id}/preview?size=medium`, { cookie })).status).toBe(200);
    expect((await api(`/api/photos/${photos[0]!.id}/preview`)).status).toBe(404); // no session → not found, no leak
    await post('/api/auth/request', { email: 'stranger@x.com' }, ''); await drain();
    expect(mail.sent.length).toBe(before + 1); // unknown email: nothing sent, same 200
  });
  it('healthz pings the database', async () => {
    const { api } = await boot();
    expect(await (await api('/healthz')).json()).toEqual({ ok: true });
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
  it('memory storage round-trips through the dev route, with no session', async () => {
    const { app, storage } = await boot();
    const put = await app.request(await storage.presignPut('s/a b/p/1/original', 'image/jpeg', 900), { method: 'PUT', body: new Uint8Array([1, 2, 3]), headers: { 'content-type': 'image/jpeg' } });
    expect(put.status).toBe(200);
    expect([...(await storage.getBytes('s/a b/p/1/original'))!]).toEqual([1, 2, 3]);
    expect(await storage.exists('s/a b/p/1/original')).toBe(true);
    const got = await app.request(await storage.presignGet('s/a b/p/1/original', 600, 'x.jpg'));
    expect([got.status, got.headers.get('content-type'), got.headers.get('content-disposition'), [...new Uint8Array(await got.arrayBuffer())]]).toEqual([200, 'image/jpeg', 'attachment; filename="x.jpg"', [1, 2, 3]]);
    expect((await app.request('/dev/storage/nope')).status).toBe(404);
    await storage.copy('s/a b/p/1/original', 's/a b/p/1/draft');
    expect([...(await storage.getBytes('s/a b/p/1/draft'))!]).toEqual([1, 2, 3]);
  });
  it('the dev route does not exist with R2 storage', async () => {
    const db = await testDb(); const config = loadConfig({ DATABASE_URL: 'pglite://memory', BASE_URL: BASE });
    const storage = r2Storage({ accountId: 'acc', accessKeyId: 'AK', secretAccessKey: 'SK', bucket: 'b', fetch: (async () => new Response('nope', { status: 500 })) as typeof fetch });
    const app = createApp({ db, config, storage, auth: createAuth({ root: db, config, getTransport: () => memoryTransport() }), webRoot: await tmpDir() });
    expect((await app.request('/dev/storage/k', { method: 'PUT', body: 'x' })).status).toBe(404);
    expect((await app.request('/dev/storage/k')).status).toBe(404);
  });
  it('the CSP lets the browser PUT to R2', async () => {
    const { app } = await boot();
    expect((await app.request('/healthz')).headers.get('content-security-policy')).toContain("connect-src 'self' https://*.r2.cloudflarestorage.com");
  });
});
