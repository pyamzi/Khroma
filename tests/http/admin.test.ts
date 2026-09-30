import { describe, it, expect } from 'vitest';
import { boot as bootApp } from './boot.js';
import { withStudio } from '../../src/server/db/tenancy.js';
import { addPhoto } from '../../src/server/domain/photos.js';
import { jpegBytes } from '../fixtures/make.js';

async function boot() {
  const b = await bootApp();
  const { cookie: owner, studioId } = await b.signupOwner('owner@x.com', 'S');
  const { projectId: pid } = await b.seedProject(owner, { emails: ['sarah@x.com'], included: 2, extraPrice: 1500 });
  const [raw] = await b.addCulling(studioId, pid, ['a']);
  const fin = await withStudio(b.db, studioId, async (tx) => addPhoto(tx, b.storage, { projectId: pid, relPath: 'finals/f.jpg', stage: 'final', bytes: await jpegBytes(), name: 'f.jpg' }));
  await b.drain();
  return { ...b, owner, studioId, pid, rawId: raw!, finalId: fin.photoId };
}

describe('admin api', () => {
  it('clients and projects: create with defaults, patch human fields, price, shot, order, cover, events, insights', async () => {
    const { api, post, json, owner, signIn, pid, finalId } = await boot();
    await post('/api/settings/studio', { defaultIncluded: 30, defaultExtraPrice: 2000 }, owner, 'PATCH');
    let r = await post('/api/clients', { name: 'Jones', emails: ['j@x.com'], phone: '555', notes: 'n' }, owner); expect(r.status).toBe(201); const cl = await json<{ id: string }>(r);
    expect(await json<{ phone: string; notes: string }>(await api(`/api/clients/${cl.id}`, { cookie: owner }))).toMatchObject({ phone: '555', notes: 'n', projects: [] });
    r = await post('/api/projects', { clientId: cl.id, title: 'Headshots', date: '2026-09-01' }, owner); expect(r.status).toBe(201); const np = await json<{ id: string }>(r);
    let d = await json<{ selection: { included: number; extraPrice: number }; title: string }>(await api(`/api/projects/${np.id}`, { cookie: owner }));
    expect(d.selection).toMatchObject({ included: 30, extraPrice: 2000 });
    expect((await post(`/api/projects/${np.id}`, { title: 'Headshots 2026', downloads: 'none' }, owner, 'PATCH')).status).toBe(200);
    expect((await post(`/api/projects/${np.id}`, { allowance: { included: 1 } }, owner, 'PATCH')).status).toBe(400);
    expect((await post(`/api/projects/${np.id}/price`, { extraPrice: 900 }, owner)).status).toBe(200);
    expect((await post(`/api/projects/${np.id}/shot`, {}, owner)).status).toBe(200);
    expect((await post(`/api/projects/${np.id}/shot`, {}, owner)).status).toBe(422);
    d = await json<typeof d>(await api(`/api/projects/${np.id}`, { cookie: owner })); expect(d.title).toBe('Headshots 2026'); expect(d.selection.extraPrice).toBe(900);
    expect((await post(`/api/projects/${pid}/photos/order`, { ids: [finalId] }, owner)).status).toBe(200);
    expect((await post(`/api/projects/${pid}/cover`, { photoId: finalId }, owner)).status).toBe(200);
    const sarah = await signIn('sarah@x.com');
    expect((await api(`/api/projects/${pid}/events`, { cookie: sarah })).status).toBe(401);
    expect((await json<unknown[]>(await api(`/api/projects/${pid}/events`, { cookie: owner }))).length).toBeGreaterThan(0);
    await api(`/api/projects/${pid}`, { cookie: sarah });
    expect((await json<{ views: number }>(await api(`/api/projects/${pid}/insights`, { cookie: owner }))).views).toBe(1);
  });
  it('settings: owner-only studio, team roles, jobs', async () => {
    const { api, post, json, owner, drain, redeemLatest } = await boot();
    let r = await post('/api/users/invite', { email: 'sam@x.com', role: 'member' }, owner); expect(r.status).toBe(201); const sam = await json<{ id: string }>(r);
    await drain(); const samCookie = await redeemLatest('sam@x.com');
    expect((await post('/api/settings/studio', { studioName: 'X' }, samCookie, 'PATCH')).status).toBe(403);
    expect((await post('/api/settings/studio', { studioName: 'Klaus Studio' }, owner, 'PATCH')).status).toBe(200);
    expect((await json<{ studio: { studioName: string } }>(await api('/api/settings', { cookie: samCookie }))).studio.studioName).toBe('Klaus Studio');
    expect((await json<{ studio: { name: string } }>(await api('/api/me', { cookie: samCookie }))).studio.name).toBe('Klaus Studio');
    expect((await post('/api/users/invite', { email: 'sam@x.com', role: 'member' }, owner)).status).toBe(409);
    expect((await post(`/api/users/${sam.id}`, { notifyDownloads: 'each' }, samCookie, 'PATCH')).status).toBe(200);
    expect((await post(`/api/users/${sam.id}`, { role: 'owner' }, samCookie, 'PATCH')).status).toBe(403);
    const users = await json<{ id: string; email: string }[]>(await api('/api/users', { cookie: owner }));
    const me = users.find((u) => u.email === 'owner@x.com')!;
    expect((await api(`/api/users/${me.id}`, { method: 'DELETE', cookie: owner })).status).toBe(422);
    expect((await api(`/api/users/${sam.id}`, { method: 'DELETE', cookie: samCookie })).status).toBe(403);
    expect((await api(`/api/users/${sam.id}`, { method: 'DELETE', cookie: owner })).status).toBe(200);
    expect(await json<unknown[]>(await api('/api/jobs', { cookie: owner }))).toEqual([]);
    expect((await json<unknown[]>(await api('/api/jobs?state=done', { cookie: owner }))).length).toBeGreaterThan(0);
  });
  it('dashboard returns the four blocks', async () => {
    const { api, post, json, owner, signIn, pid, rawId } = await boot();
    const sarah = await signIn('sarah@x.com');
    const sel = await json<{ summary: { selectionVersion: number } }>(await api(`/api/projects/${pid}/selection`, { cookie: sarah }));
    await post(`/api/projects/${pid}/picks`, { photoId: rawId, picked: true, selectionVersion: sel.summary.selectionVersion }, sarah);
    const sel2 = await json<{ summary: { selectionVersion: number } }>(await api(`/api/projects/${pid}/selection`, { cookie: sarah }));
    expect((await post(`/api/projects/${pid}/finish`, { selectionVersion: sel2.summary.selectionVersion }, sarah)).status).toBe(200);
    expect((await api('/api/dashboard', { cookie: sarah })).status).toBe(401);
    const d = await json<{ waitingOnYou: { reason: string; projectId: string }[]; money: unknown[]; upcoming: unknown[] }>(await api('/api/dashboard', { cookie: owner }));
    expect(d.waitingOnYou).toEqual(expect.arrayContaining([expect.objectContaining({ reason: 'culling_finished', projectId: pid })]));
    expect(d.money).toEqual([]);
  });
});
