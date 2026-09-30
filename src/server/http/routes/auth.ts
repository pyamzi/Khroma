import { Hono } from 'hono';
import { z } from 'zod';
import type { AppEnv } from '../session.js';
import { setSessionCookie, clearSessionCookie } from '../session.js';
import { isAdmin } from '../access.js';
import { asSystem } from '../../db/tenancy.js';
import { studios } from '../../db/schema.js';
import { redeemMagicLink, signOut } from '../../auth/magic.js';
import { requestSignIn } from '../../auth/signin.js';
import { signup } from '../../auth/signup.js';
import type { Config } from '../../config.js';

// ponytail: in-process rate limit per app machine; move to Postgres or the edge if abuse spreads across machines.
const hits = new Map<string, number[]>();
const MAX_KEYS = 5000;
export function limited(key: string, max: number, now = Date.now(), windowMs = 15 * 60_000): boolean {
  if (hits.size >= MAX_KEYS) for (const [k, ts] of hits) if (!ts.some((t) => t > now - windowMs)) hits.delete(k); // sweep expired keys
  if (hits.size >= MAX_KEYS && !hits.has(key)) return true; // still full of live keys: refuse new ones rather than grow
  const arr = (hits.get(key) ?? []).filter((t) => t > now - windowMs); arr.push(now); hits.set(key, arr);
  return arr.length > max;
}
export const _hits = hits;
const ipOf = (c: { req: { header(n: string): string | undefined } }) => c.req.header('fly-client-ip') ?? c.req.header('x-forwarded-for')?.split(',')[0]?.trim() ?? 'local';

const Signup = z.object({ email: z.string().email(), studioName: z.string().trim().min(1).max(80), over18: z.literal(true) });

/** Routes that cross Studios. They run before the request transaction and open their own system transactions. */
export const systemRoutes = (config: Config) => new Hono<AppEnv>()
  .get('/healthz', async (c) => { await asSystem(c.get('root'), (tx) => tx.select({ id: studios.id }).from(studios).limit(1)); return c.json({ ok: true }); })
  .post('/api/auth/request', async (c) => {
    const b = z.object({ email: z.string().email() }).safeParse(await c.req.json().catch(() => null));
    if (!b.success) return c.json({ error: 'invalid body' }, 400);
    const email = b.data.email.toLowerCase();
    // always 200: no account enumeration, and a limited caller learns nothing either
    if (limited(`e:${email}`, 5) || limited(`ip:${ipOf(c)}`, 20)) return c.json({ ok: true });
    await asSystem(c.get('root'), (tx) => requestSignIn(tx, { email, baseUrl: config.baseUrl }));
    return c.json({ ok: true });
  })
  .post('/api/signup', async (c) => {
    const b = Signup.safeParse(await c.req.json().catch(() => null));
    if (!b.success) return c.json({ error: 'invalid body' }, 400);
    const email = b.data.email.toLowerCase();
    if (limited(`e:${email}`, 5) || limited(`ip:${ipOf(c)}`, 20)) return c.json({ ok: true });
    await asSystem(c.get('root'), (tx) => signup(tx, { email, studioName: b.data.studioName, baseUrl: config.baseUrl }));
    return c.json({ ok: true }); // same answer whether or not the email already had a Studio
  })
  .get('/auth/:token', async (c) => {
    const r = await asSystem(c.get('root'), (tx) => redeemMagicLink(tx, c.req.param('token')));
    if (!r) return c.redirect('/signin?error=expired');
    setSessionCookie(c, r.sessionToken, config.secureCookies);
    return c.redirect('/');
  })
  .post('/api/auth/signout', async (c) => {
    const t = c.get('sessionToken'); if (t) await asSystem(c.get('root'), (tx) => signOut(tx, t));
    clearSessionCookie(c); return c.json({ ok: true });
  });

export const meRoutes = () => new Hono<AppEnv>()
  .get('/api/me', async (c) => {
    const s = c.get('session'); if (!s) return c.json({ error: 'unauthorized' }, 401);
    const [studio] = await c.get('db').select({ id: studios.id, name: studios.name }).from(studios).limit(1);
    return c.json({ kind: s.kind, subject: s.subject, isAdmin: await isAdmin(c.get('db'), s), projectId: s.projectId, studio });
  });
