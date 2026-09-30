import { describe, it, expect } from 'vitest';
import { events, sessions } from '../../src/server/db/schema.js';
import { asSystem, withStudio } from '../../src/server/db/tenancy.js';
import { hashToken } from '../../src/server/auth/magic.js';
import { boot as bootApp } from './boot.js';

async function boot() {
  const b = await bootApp();
  const { cookie: owner, studioId } = await b.signupOwner('owner@x.com', 'S');
  const { projectId: pid } = await b.seedProject(owner, { emails: ['sarah@x.com', 'tom@x.com'], included: 2, extraPrice: 1500 });
  await b.addCulling(studioId, pid, ['a', 'b', 'c']);
  const sarah = await b.signIn('sarah@x.com'); const tom = await b.signIn('tom@x.com');
  const viewed = async () => (await withStudio(b.db, studioId, (tx) => tx.select().from(events))).filter((e) => e.type === 'viewed');
  return { ...b, owner, sarah, tom, pid, studioId, viewed };
}
type Summary = { selectionVersion: number; confirmed: number; pending: number; entitlement: number };
type PhotoItem = { id: string; pick: null | { state: string; byEmail: string; locked: boolean }; comments: { open: number; total: number }; previewReady: boolean };
type Detail = { selection: Summary; state: { production: string }; comments: { culling: boolean }; progress: { done: number; total: number } };

describe('portal api', () => {
  it('walks a shared culling round: pick, conflict, extras request, grant, finish, locked', async () => {
    const { api, post, json, mail, drain, owner, sarah, tom, pid, viewed } = await boot();
    let detail = await json<Detail>(await api(`/api/projects/${pid}`, { cookie: sarah }));
    expect(detail.state.production).toBe('culling'); expect(detail.selection).toMatchObject({ entitlement: 2, confirmed: 0 });
    expect(await viewed()).toHaveLength(1);
    await api(`/api/projects/${pid}`, { cookie: sarah });
    expect(await viewed()).toHaveLength(1); // throttled
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
    expect((await post(`/api/photos/${a}/comments`, { text: 'x' }, '')).status).toBe(401); // no session: role check first
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

  it('a project-scoped guest session can view but not pick, finish, or comment', async () => {
    const { db, api, post, json, pid, studioId } = await boot();
    await asSystem(db, (tx) => tx.insert(sessions).values({ id: 'g1', studioId, kind: 'guest', subject: 'Guest 1', projectId: pid, tokenHash: hashToken('guest-token'), expiresAt: '2999-01-01T00:00:00Z' }));
    const guest = 'og_session=guest-token';
    const photos = await json<PhotoItem[]>(await api(`/api/projects/${pid}/photos`, { cookie: guest }));
    expect(photos).toHaveLength(3);
    const sel = await json<{ summary: Summary }>(await api(`/api/projects/${pid}/selection`, { cookie: guest }));
    expect((await post(`/api/projects/${pid}/picks`, { photoId: photos[0]!.id, picked: true, selectionVersion: sel.summary.selectionVersion }, guest)).status).toBe(401);
    expect((await post(`/api/projects/${pid}/finish`, { selectionVersion: sel.summary.selectionVersion }, guest)).status).toBe(401);
    expect((await post(`/api/photos/${photos[0]!.id}/comments`, { text: 'hi' }, guest)).status).toBe(401);
    expect((await api(`/api/photos/${photos[0]!.id}/comments`, { cookie: guest })).status).toBe(200);
  });
});
