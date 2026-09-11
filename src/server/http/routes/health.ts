import { Hono } from 'hono';
import type { AppEnv } from '../session.js';
import { setupState } from '../../auth/bootstrap.js';
import { resolveTransport } from '../../email/transport.js';
import type { Config } from '../../config.js';

export const health = (config: Config) => new Hono<AppEnv>().get('/healthz', (c) => {
  const db = c.get('db');
  return c.json({ ok: true, setup: setupState(db), email: resolveTransport(db, config) !== null });
});
