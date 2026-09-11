import type { Context, MiddlewareHandler } from 'hono';
import { getCookie, setCookie, deleteCookie } from 'hono/cookie';
import type { Db } from '../db/client.js';
import { sessionFromToken, type SessionRow } from '../auth/magic.js';

export const COOKIE = 'og_session';
export type AppEnv = { Variables: { session: SessionRow | null; sessionToken: string | null; db: Db } };

export function dbMiddleware(db: Db): MiddlewareHandler<AppEnv> {
  return async (c, next) => { c.set('db', db); await next(); };
}
export function sessionMiddleware(db: Db): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    const token = getCookie(c, COOKIE) ?? null;
    c.set('sessionToken', token); c.set('session', token ? sessionFromToken(db, token) : null);
    await next();
  };
}
export function setSessionCookie(c: Context, token: string, secure: boolean) {
  setCookie(c, COOKIE, token, { httpOnly: true, secure, sameSite: 'Lax', path: '/', maxAge: 30 * 86400 });
}
export function clearSessionCookie(c: Context) { deleteCookie(c, COOKIE, { path: '/' }); }
