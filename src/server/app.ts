import { Hono, type ErrorHandler, type MiddlewareHandler } from 'hono';
import { serveStatic } from '@hono/node-server/serve-static';
import { bodyLimit } from 'hono/body-limit';
import type { Db } from './db/client.js';
import type { Config } from './config.js';
import type { Storage } from './storage.js';
import type { Auth } from './auth/better.js';
import { createHash } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { continueUrl, verifyContinue } from './auth/continue.js';
import { authVerifications } from './db/schema.js';
import { withStudio, anonTx } from './db/tenancy.js';
import { sessionMiddleware, type AppEnv } from './http/session.js';
import { systemRoutes, meRoutes } from './http/routes/auth.js';
import { projectRoutes } from './http/routes/projects.js';
import { photoRoutes } from './http/routes/photos.js';
import { selectionRoutes } from './http/routes/selection.js';
import { commentRoutes } from './http/routes/comments.js';
import { adminRoutes } from './http/routes/admin.js';
import { settingsRoutes } from './http/routes/settings.js';
import { dashboardRoutes } from './http/routes/dashboard.js';
import { pluginRoutes } from './http/routes/plugin.js';
import { libraryRoutes } from './http/routes/library.js';

export type AppDeps = { db: Db; config: Config; storage: Storage; auth: Auth; webRoot?: string };

class Rollback extends Error {}
/**
 * One transaction per request, bound to the session's Studio (or to no Studio). A request that throws or answers
 * 4xx/5xx changes nothing: the transaction rolls back. The body is read first, so a slow client never holds a connection.
 */
export function requestTx(root: Db): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    if (c.req.method !== 'GET' && c.req.method !== 'HEAD') {
      // Hono caches what is read here for the handler; multipart must be read as form data to keep its boundary
      const form = /^(multipart\/form-data|application\/x-www-form-urlencoded)/.test(c.req.header('content-type') ?? '');
      await (form ? c.req.formData() : c.req.arrayBuffer()).catch(() => undefined); // a malformed body fails in the handler's own parse
    }
    const run = async (tx: Db) => {
      c.set('db', tx); await next();
      if (c.error) throw c.error;
      if (c.res.status >= 400) throw new Rollback();
    };
    const s = c.get('session');
    try { if (s) await withStudio(root, s.studioId, run); else await anonTx(root, run); }
    catch (e) { if (!(e instanceof Rollback) && e !== c.error) throw e; } // the response is already set; onError already ran
  };
}
export const MAX_BODY_BYTES = 100 * 1024 * 1024; // ponytail: finals arrive as JPEGs through the app until H2 moves uploads to presigned R2 URLs
export const onError: ErrorHandler<AppEnv> = (e, c) => { console.error('[http]', c.req.method, c.req.path, e); return c.json({ error: 'internal' }, 500); };

export function createApp({ db, config, storage, auth, webRoot = './dist/web' }: AppDeps): Hono<AppEnv> {
  const app = new Hono<AppEnv>();
  app.onError(onError);
  app.use('*', async (c, next) => {
    await next();
    c.header('x-content-type-options', 'nosniff');
    c.header('x-frame-options', 'DENY');
    c.header('referrer-policy', 'same-origin');
    c.header('content-security-policy', "default-src 'self'; img-src 'self' data: blob:; style-src 'self' 'unsafe-inline'; media-src 'self'; connect-src 'self' https://*.r2.cloudflarestorage.com");
  });
  // CSRF: a custom header cannot be sent cross-origin without a preflight, which is never granted (no CORS).
  app.use('/api/*', async (c, next) => {
    const bearer = (c.req.header('authorization') ?? '').startsWith('Bearer '); // no cookie, no CSRF
    if (!bearer && c.req.method !== 'GET' && c.req.method !== 'HEAD' && c.req.header('x-requested-with') !== 'fetch') return c.json({ error: 'forbidden' }, 403);
    await next();
  });
  app.use('/api/*', bodyLimit({ maxSize: MAX_BODY_BYTES, onError: (c) => c.json({ error: 'too_large' }, 413) }));
  app.use('*', sessionMiddleware(db, auth));
  app.use('*', async (c, next) => { c.set('storage', storage); await next(); });
  app.route('/', systemRoutes(config, auth)); // registered before the request transaction: these open their own system transactions
  // The only Better Auth route that is public; sign-in links are sent by the job queue. Better Auth reads callbackURL from the clicked link, so a user could edit it
  // and turn a stale token into a session that never passes /auth/continue. Refuse before the token is consumed unless the callback is our own signed, unexpired one,
  // minted for the email the token was sent to.
  app.get('/api/ba/magic-link/verify', async (c) => {
    let callbackURL: string | null = null;
    try {
      const cb = new URL(c.req.query('callbackURL') ?? '', config.baseUrl);
      const v = cb.origin === new URL(config.baseUrl).origin && cb.pathname === '/auth/continue' ? verifyContinue(config.betterAuthSecret, Object.fromEntries(cb.searchParams), Date.now()) : null;
      // Better Auth's own lookup (hashed token, `magic-link:` prefix). A consumed token has no row: Better Auth answers it with INVALID_TOKEN to our callback.
      const id = `magic-link:${createHash('sha256').update(c.req.query('token') ?? '').digest('base64url')}`;
      const [row] = v ? await db.select({ value: authVerifications.value }).from(authVerifications).where(eq(authVerifications.identifier, id)).limit(1) : [];
      const sentTo = row ? String((JSON.parse(row.value) as { email?: unknown }).email).toLowerCase() : null;
      if (v && (!sentTo || sentTo === v.email)) callbackURL = continueUrl(config.betterAuthSecret, { ...v, iat: cb.searchParams.get('iat')! }); // rebuilt from the checked values only
    } catch { /* unparseable callback */ }
    if (!callbackURL) return c.redirect('/signin?error=expired');
    // Better Auth also honours these two from the link; either would send a new user, or a consumed link's error, somewhere other than our callback
    const url = new URL(c.req.url); url.searchParams.delete('newUserCallbackURL'); url.searchParams.delete('errorCallbackURL');
    url.searchParams.set('callbackURL', encodeURIComponent(callbackURL)); // Better Auth decodes the parsed value once more; this keeps it exactly our URL
    return auth.handler(new Request(url, { method: c.req.method, headers: c.req.raw.headers }));
  });
  app.use('/api/*', requestTx(db));
  app.route('/', meRoutes()); app.route('/', projectRoutes()); app.route('/', photoRoutes());
  app.route('/', selectionRoutes(config)); app.route('/', commentRoutes());
  app.route('/', adminRoutes()); app.route('/', settingsRoutes(config)); app.route('/', dashboardRoutes()); app.route('/', pluginRoutes()); app.route('/', libraryRoutes());
  if (storage.dev) { // memory storage only: stands in for R2's presigned URLs, outside /api/* on purpose (no CSRF header, body limit or transaction; the URL is the capability)
    const keyOf = (path: string) => decodeURIComponent(path.slice('/dev/storage/'.length));
    app.put('/dev/storage/*', async (c) => {
      await storage.put(keyOf(c.req.path), new Uint8Array(await c.req.arrayBuffer()), c.req.header('content-type') ?? 'application/octet-stream');
      return c.body(null, 200);
    });
    app.get('/dev/storage/*', async (c) => {
      const o = await storage.get(keyOf(c.req.path)); if (!o) return c.json({ error: 'not_found' }, 404);
      const disposition = c.req.query('response-content-disposition');
      return new Response(o.body, { headers: { 'content-type': o.contentType, 'content-length': String(o.size), ...(disposition ? { 'content-disposition': disposition } : {}) } });
    });
  }
  app.use('/assets/*', serveStatic({ root: webRoot }));
  app.get('*', serveStatic({ root: webRoot, path: 'index.html' }));
  return app;
}
