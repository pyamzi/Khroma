import { Hono } from 'hono';
import { z } from 'zod';
import type { AppEnv } from '../session.js';
import { completeSetup } from '../../auth/bootstrap.js';
import type { Config } from '../../config.js';

const Body = z.object({
  token: z.string().min(1), ownerEmail: z.string().email(), studioName: z.string().min(1),
  email: z.discriminatedUnion('type', [
    z.object({ type: z.literal('smtp'), url: z.string().url(), from: z.string().min(3) }),
    z.object({ type: z.literal('listmonk'), url: z.string().url(), token: z.string().min(1), from: z.string().min(3), templateId: z.number().int() }),
  ]),
});

export const setup = (config: Config) => new Hono<AppEnv>().post('/api/setup', async (c) => {
  const b = Body.safeParse(await c.req.json().catch(() => null));
  if (!b.success) return c.json({ error: 'invalid body' }, 400);
  const r = completeSetup(c.get('db'), { ...b.data, baseUrl: config.baseUrl, secret: config.sessionSecret });
  return r.ok ? c.json({ ok: true }) : c.json({ error: r.error }, 400);
});
