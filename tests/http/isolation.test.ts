import { describe, it, expect } from 'vitest';
import { Hono } from 'hono';
import { eq, sql } from 'drizzle-orm';
import { clients, projects, photos, comments, sessions, users, events, jobs } from '../../src/server/db/schema.js';
import { asSystem, withStudio } from '../../src/server/db/tenancy.js';
import { sessionMiddleware, type AppEnv } from '../../src/server/http/session.js';
import { requestTx, onError } from '../../src/server/app.js';
import { boot } from './boot.js';

async function twoStudios() {
  const b = await boot();
  const seed = async (tag: string) => {
    const { cookie, studioId } = await b.signupOwner(`${tag}-owner@x.com`, `${tag} Studio`);
    const { clientId, projectId } = await b.seedProject(cookie, { client: `${tag} Client`, emails: [`${tag}-client@x.com`], title: `${tag} Wedding`, included: 3 });
    const [photoId] = await b.addCulling(studioId, projectId, ['a']);
    const comment = await b.json<{ id: string }>(await b.post(`/api/photos/${photoId}/comments`, { text: `${tag} note` }, cookie));
    const token = await b.json<{ id: string; token: string }>(await b.post('/api/access/tokens', { name: `${tag} Mac`, scope: 'read+write' }, cookie));
    const [owner] = await b.json<{ id: string }[]>(await b.api('/api/users', { cookie }));
    const [job] = await asSystem(b.db, (tx) => tx.select().from(jobs).where(eq(jobs.studioId, studioId)).limit(1));
    return { cookie, studioId, clientId, projectId, photoId: photoId!, commentId: comment.id, tokenId: token.id, token: token.token, userId: owner!.id, jobId: job!.id, tag };
  };
  return { ...b, A: await seed('Alpha'), B: await seed('Beta') };
}
const snapshot = (db: Parameters<typeof asSystem>[0], studioId: string) => asSystem(db, async (tx) => JSON.stringify(await Promise.all([
  tx.select().from(clients).where(eq(clients.studioId, studioId)), tx.select().from(projects).where(eq(projects.studioId, studioId)),
  tx.select().from(photos).where(eq(photos.studioId, studioId)), tx.select().from(comments).where(eq(comments.studioId, studioId)),
  tx.select({ id: sessions.id, h: sessions.tokenHash }).from(sessions).where(eq(sessions.studioId, studioId)), tx.select().from(users).where(eq(users.studioId, studioId)),
  tx.select({ n: sql<number>`count(*)` }).from(events).where(eq(events.studioId, studioId)),
])));

describe('tenant isolation over HTTP', () => {
  it('every id-bearing route refuses another Studio\'s ids and leaks nothing', async () => {
    const { app, api, db, A, B } = await twoStudios();
    const idFor = (path: string) =>
      path.startsWith('/api/clients/') ? A.clientId : path.startsWith('/api/users/') ? A.userId : path.startsWith('/api/comments/') ? A.commentId
      : path.startsWith('/api/access/tokens/') ? A.tokenId : path.startsWith('/api/jobs/') ? A.jobId : A.projectId;
    const routes = app.routes.filter((r) => r.method !== 'ALL' && /:(id|photoId|token)\b/.test(r.path) && r.path !== '/auth/:token');
    expect(routes.length).toBeGreaterThan(25);
    const before = await snapshot(db, A.studioId);
    for (const r of routes) {
      const path = r.path.replace(':photoId', A.photoId).replace(':id', idFor(r.path));
      const plugin = path.startsWith('/api/plugin/');
      const res = await api(path, { method: r.method, ...(r.method === 'GET' ? {} : { body: '{}' }), ...(plugin ? { bearer: B.token } : { cookie: B.cookie }) });
      const body = await res.text();
      expect({ route: `${r.method} ${r.path}`, status: [400, 401, 403, 404].includes(res.status) }).toEqual({ route: `${r.method} ${r.path}`, status: true });
      for (const secret of [A.projectId, A.photoId, A.clientId, 'Alpha']) expect(body, `${r.method} ${r.path}`).not.toContain(secret);
    }
    expect(await snapshot(db, A.studioId)).toBe(before);
  });
  it('lists never mix Studios', async () => {
    const { api, json, A, B } = await twoStudios();
    const text = JSON.stringify(await Promise.all(['/api/projects', '/api/clients', '/api/users', '/api/access/tokens', '/api/dashboard', '/api/jobs?state=done'].map(async (p) => json(await api(p, { cookie: B.cookie })))));
    expect(text).toContain('Beta'); expect(text).not.toContain('Alpha'); expect(text).not.toContain(A.projectId);
    expect(JSON.stringify(await json(await api('/api/plugin/projects', { bearer: B.token })))).not.toContain(A.projectId);
  });
  it('no session: reads nothing', async () => {
    const { api, A } = await twoStudios();
    for (const p of ['/api/projects', `/api/projects/${A.projectId}`, `/api/photos/${A.photoId}/preview`, `/api/photos/${A.photoId}/comments`, '/api/me']) {
      const res = await api(p); const body = await res.text();
      expect([200, 401, 404]).toContain(res.status); expect(body).not.toContain('Alpha'); expect(body).not.toContain(A.photoId);
    }
  });
  it('a request that fails after writing changes nothing', async () => {
    const { db, A } = await twoStudios();
    const app = new Hono<AppEnv>();
    app.onError(onError);
    app.use('*', sessionMiddleware(db));
    app.use('/api/*', requestTx(db));
    app.post('/api/boom', async (c) => { await c.get('db').insert(events).values({ actor: 'test', type: 'boom', payload: {} }); throw new Error('after write'); });
    app.post('/api/refuse', async (c) => { await c.get('db').insert(events).values({ actor: 'test', type: 'refuse', payload: {} }); return c.json({ error: 'nope' }, 422); });
    const headers = { cookie: A.cookie, 'x-requested-with': 'fetch' };
    expect((await app.request('/api/boom', { method: 'POST', headers })).status).toBe(500);
    expect((await app.request('/api/refuse', { method: 'POST', headers })).status).toBe(422);
    const types = (await withStudio(db, A.studioId, (tx) => tx.select().from(events))).map((e) => e.type);
    expect(types).not.toContain('boom'); expect(types).not.toContain('refuse');
  });
});
