import type { Context, MiddlewareHandler } from 'hono';
import { getCookie, setCookie, deleteCookie } from 'hono/cookie';
import type { Db } from '../db/client.js';
import { asSystem } from '../db/tenancy.js';
import type { Storage } from '../storage.js';
import { sessionFromToken, type SessionRow } from '../auth/magic.js';

export const COOKIE = 'og_session';
/** `db` is the request's transaction (bound to the session's Studio); `root` is the pool, for system routes only. */
export type AppEnv = { Variables: { session: SessionRow | null; sessionToken: string | null; db: Db; root: Db; storage: Storage } };

/** Cookie sessions for people; `Authorization: Bearer ogp_…` for the Lightroom plugin. The lookup crosses Studios, so it runs as system. */
export function sessionMiddleware(root: Db): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    const bearer = c.req.header('authorization')?.match(/^Bearer\s+(ogp_[A-Za-z0-9_-]+)$/)?.[1] ?? null;
    const token = bearer ?? getCookie(c, COOKIE) ?? null;
    c.set('root', root); c.set('sessionToken', token);
    c.set('session', token ? await asSystem(root, (tx) => sessionFromToken(tx, token)) : null);
    await next();
  };
}
export function setSessionCookie(c: Context, token: string, secure: boolean) {
  setCookie(c, COOKIE, token, { httpOnly: true, secure, sameSite: 'Lax', path: '/', maxAge: 30 * 86400 });
}
export function clearSessionCookie(c: Context) { deleteCookie(c, COOKIE, { path: '/' }); }
