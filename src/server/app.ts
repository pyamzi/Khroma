import { Hono } from 'hono';
import { serveStatic } from '@hono/node-server/serve-static';
import type { Db } from './db/client.js';
import type { Config } from './config.js';
import { sessionMiddleware, dbMiddleware, type AppEnv } from './http/session.js';
import { setupState } from './auth/bootstrap.js';
import { health } from './http/routes/health.js';
import { setup } from './http/routes/setup.js';
import { auth } from './http/routes/auth.js';
import { projectRoutes } from './http/routes/projects.js';
import { photoRoutes } from './http/routes/photos.js';
import { issueRoutes } from './http/routes/issues.js';

export type AppDeps = { db: Db; config: Config; photosDir: string; webRoot?: string };

export function createApp({ db, config, photosDir, webRoot = './dist/web' }: AppDeps): Hono<AppEnv> {
  const app = new Hono<AppEnv>();
  app.use('*', dbMiddleware(db));
  app.use('*', async (c, next) => {
    await next();
    c.header('x-content-type-options', 'nosniff');
    c.header('x-frame-options', 'DENY');
    c.header('referrer-policy', 'same-origin');
    c.header('content-security-policy', "default-src 'self'; img-src 'self' data: blob:; style-src 'self' 'unsafe-inline'; media-src 'self'");
  });
  // CSRF: a custom header cannot be sent cross-origin without a preflight, which is never granted (no CORS).
  app.use('/api/*', async (c, next) => {
    if (c.req.method !== 'GET' && c.req.method !== 'HEAD' && c.req.header('x-requested-with') !== 'fetch') return c.json({ error: 'forbidden' }, 403);
    await next();
  });
  app.use('*', sessionMiddleware(db));
  app.use('/api/*', async (c, next) => {
    if (c.req.path !== '/api/setup' && setupState(db) !== 'complete') return c.json({ error: 'setup_required', setup: setupState(db) }, 503);
    await next();
  });
  app.route('/', health(config)); app.route('/', setup(config)); app.route('/', auth(config));
  app.route('/', projectRoutes(photosDir)); app.route('/', photoRoutes(photosDir)); app.route('/', issueRoutes());
  app.use('/assets/*', serveStatic({ root: webRoot }));
  app.get('*', serveStatic({ root: webRoot, path: 'index.html' }));
  return app;
}
