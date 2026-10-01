import { Hono, type ErrorHandler, type MiddlewareHandler } from 'hono';
import { serveStatic } from '@hono/node-server/serve-static';
import { bodyLimit } from 'hono/body-limit';
import type { Db } from './db/client.js';
import type { Config } from './config.js';
import type { Storage } from './storage.js';
import type { Auth } from './auth/better.js';
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
    c.header('content-security-policy', "default-src 'self'; img-src 'self' data: blob:; style-src 'self' 'unsafe-inline'; media-src 'self'");
  });
  // CSRF: a custom header cannot be sent cross-origin without a preflight, which is never granted (no CORS).
  app.use('/api/*', async (c, next) => {
    const bearer = (c.req.header('authorization') ?? '').startsWith('Bearer '); // no cookie, no CSRF
    if (!bearer && c.req.method !== 'GET' && c.req.method !== 'HEAD' && c.req.header('x-requested-with') !== 'fetch') return c.json({ error: 'forbidden' }, 403);
    await next();
  });
  app.use('/api/*', bodyLimit({ maxSize: MAX_BODY_BYTES, onError: (c) => c.json({ error: 'too_large' }, 413) }));
  app.use('*', sessionMiddleware(db));
  app.use('*', async (c, next) => { c.set('storage', storage); await next(); });
  app.route('/', systemRoutes(config)); // registered before the request transaction: these open their own system transactions
  app.get('/api/ba/magic-link/verify', (c) => auth.handler(c.req.raw)); // the only Better Auth route that is public; sign-in links are sent by the job queue
  app.use('/api/*', requestTx(db));
  app.route('/', meRoutes()); app.route('/', projectRoutes()); app.route('/', photoRoutes());
  app.route('/', selectionRoutes(config)); app.route('/', commentRoutes());
  app.route('/', adminRoutes()); app.route('/', settingsRoutes(config)); app.route('/', dashboardRoutes()); app.route('/', pluginRoutes());
  app.use('/assets/*', serveStatic({ root: webRoot }));
  app.get('*', serveStatic({ root: webRoot, path: 'index.html' }));
  return app;
}
