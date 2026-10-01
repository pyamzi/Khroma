import { loadConfig } from '../../src/server/config.js';
import { createApp } from '../../src/server/app.js';
import { createAuth } from '../../src/server/auth/better.js';
import { runOnce } from '../../src/server/jobs/queue.js';
import { makeEmailHandlers } from '../../src/server/email/send.js';
import { memoryTransport } from '../../src/server/email/transport.js';
import { memoryStorage } from '../../src/server/storage.js';
import { withStudio } from '../../src/server/db/tenancy.js';
import { addPhoto, makePreviewHandlers } from '../../src/server/domain/photos.js';
import { tiffBytes } from '../fixtures/make.js';
import { testDb, tmpDir } from '../helpers.js';

export const BASE = 'http://localhost:3000';
export const linkFrom = (text: string) => text.match(/http:\/\/localhost:3000\/auth\/[A-Za-z0-9_-]+/)![0];
export const cookieOf = (res: Response) => res.headers.get('set-cookie')!.split(';')[0]!;
export type Init = RequestInit & { cookie?: string; bearer?: string };

/** The whole app in-process on a fresh database: memory storage, memory mail, jobs drained on demand. */
export async function boot() {
  const db = await testDb(); const storage = memoryStorage(); const mail = memoryTransport();
  const config = loadConfig({ DATABASE_URL: 'pglite://memory', BASE_URL: BASE });
  const auth = createAuth({ root: db, config, getTransport: () => mail });
  const app = createApp({ db, config, storage, auth, webRoot: await tmpDir() });
  const handlers = { ...makeEmailHandlers(() => mail, 'localhost'), ...makePreviewHandlers(storage) };
  const drain = async () => { while ((await runOnce(db, handlers)) === 'ran') { /* drain */ } };
  const api = (path: string, init: Init = {}) => app.request(path, { ...init, headers: {
    ...(init.body instanceof FormData ? {} : { 'content-type': 'application/json' }), 'x-requested-with': 'fetch',
    ...(init.cookie ? { cookie: init.cookie } : {}), ...(init.bearer ? { authorization: `Bearer ${init.bearer}` } : {}), ...(init.headers ?? {}) } });
  const post = (path: string, body: unknown, cookie: string, method = 'POST') => api(path, { method, body: JSON.stringify(body), cookie });
  const json = async <T,>(res: Response) => (await res.json()) as T;
  /** Redeem the newest link sent to `email` (optionally from one Studio) and return the session cookie. */
  const redeemLatest = async (email: string, studioName?: string) => {
    const m = mail.sent.filter((x) => x.to === email.toLowerCase() && (!studioName || x.fromName === studioName)).at(-1)!;
    return cookieOf(await app.request(linkFrom(m.text), { redirect: 'manual' }));
  };
  const signIn = async (email: string, studioName?: string) => { await post('/api/auth/request', { email }, ''); await drain(); return redeemLatest(email, studioName); };
  const signupOwner = async (email: string, studioName: string) => {
    await post('/api/signup', { email, studioName, over18: true }, ''); await drain();
    const cookie = await redeemLatest(email); // an unconfirmed Studio's first email comes from the platform
    const me = await json<{ studio: { id: string } }>(await api('/api/me', { cookie }));
    return { cookie, studioId: me.studio.id };
  };
  /** Adds culling RAWs raw/<name>.dng with previews rendered. */
  const addCulling = async (studioId: string, projectId: string, names: string[]) => {
    const ids: string[] = [];
    for (const n of names) ids.push((await withStudio(db, studioId, async (tx) => addPhoto(tx, storage, { projectId, relPath: `raw/${n}.dng`, stage: 'culling', bytes: await tiffBytes(), name: `${n}.dng` }))).photoId);
    await drain(); return ids;
  };
  /** Owner-created client + project through the API. */
  const seedProject = async (owner: string, o: { client?: string; emails?: string[]; title?: string; included?: number; extraPrice?: number } = {}) => {
    const cl = await json<{ id: string }>(await post('/api/clients', { name: o.client ?? 'Smith', emails: o.emails ?? [] }, owner));
    const p = await json<{ id: string }>(await post('/api/projects', { clientId: cl.id, title: o.title ?? 'Wedding', included: o.included ?? 0, extraPrice: o.extraPrice ?? 0 }, owner));
    return { clientId: cl.id, projectId: p.id };
  };
  return { db, app, auth, storage, mail, config, drain, api, post, json, signIn, signupOwner, redeemLatest, addCulling, seedProject };
}
