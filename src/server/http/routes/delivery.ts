import { Hono } from 'hono';
import { z } from 'zod';
import type { AppEnv } from '../session.js';
import { loadProject, requireKind } from '../access.js';
import { publishFinals, DeliveryError } from '../../domain/delivery.js';
import type { Config } from '../../config.js';

const Publish = z.object({ photoIds: z.array(z.string().min(1)).min(1).max(1000), expectedVersion: z.number().int() });

export const deliveryRoutes = (config: Config) => new Hono<AppEnv>()
  .post('/api/projects/:id/publish', requireKind('admin'), loadProject(), async (c) => {
    const b = Publish.safeParse(await c.req.json().catch(() => null)); if (!b.success) return c.json({ error: 'invalid body' }, 400);
    try { return c.json(await publishFinals(c.get('db'), c.get('storage'), { projectId: c.get('project').id, ...b.data, actor: c.get('session')!.subject, baseUrl: config.baseUrl })); }
    catch (e) { if (e instanceof DeliveryError) return c.json({ error: e.code }, e.code === 'conflict' ? 409 : 422); throw e; }
  });
