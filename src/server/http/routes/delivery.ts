import { Hono } from 'hono';
import { z } from 'zod';
import type { AppEnv } from '../session.js';
import { loadProject, loadPhoto, requireKind } from '../access.js';
import { publishFinals, requestDownload, favoritesOf, setFavorite, viewerKey, DeliveryError } from '../../domain/delivery.js';
import type { Config } from '../../config.js';

const Publish = z.object({ photoIds: z.array(z.string().min(1)).min(1).max(1000), expectedVersion: z.number().int() });
const Download = z.object({ photoId: z.string().min(1).optional() });
const Favorite = z.object({ favorite: z.boolean() });

export const deliveryRoutes = (config: Config) => new Hono<AppEnv>()
  .post('/api/projects/:id/publish', requireKind('admin'), loadProject(), async (c) => {
    const b = Publish.safeParse(await c.req.json().catch(() => null)); if (!b.success) return c.json({ error: 'invalid body' }, 400);
    try { return c.json(await publishFinals(c.get('db'), c.get('storage'), { projectId: c.get('project').id, ...b.data, actor: c.get('session')!.subject, baseUrl: config.baseUrl })); }
    catch (e) { if (e instanceof DeliveryError) return c.json({ error: e.code }, e.code === 'conflict' ? 409 : 422); throw e; }
  })
  .get('/api/projects/:id/favorites', loadProject(), async (c) => c.json(await favoritesOf(c.get('db'), c.get('project').id, viewerKey(c.get('session')!))))
  // guests and tokens: H2b
  .post('/api/photos/:photoId/favorite', requireKind('client', 'admin'), loadPhoto(), async (c) => {
    const b = Favorite.safeParse(await c.req.json().catch(() => null)); if (!b.success) return c.json({ error: 'invalid body' }, 400);
    const ph = c.get('photo'); if (!ph.projectId || ph.stage !== 'final' || !ph.live) return c.json({ error: 'not found' }, 404);
    await setFavorite(c.get('db'), { photoId: ph.id, viewerKey: viewerKey(c.get('session')!), favorite: b.data.favorite });
    return c.json({ ok: true });
  })
  .post('/api/projects/:id/download', requireKind('client', 'admin'), loadProject(), async (c) => {
    const b = Download.safeParse(await c.req.json().catch(() => null)); if (!b.success) return c.json({ error: 'invalid body' }, 400);
    try {
      const r = await requestDownload(c.get('db'), c.get('storage'), { projectId: c.get('project').id, photoId: b.data.photoId, actor: c.get('session')!.subject });
      return 'url' in r ? c.json(r) : c.json(r, 202);
    } catch (e) { if (e instanceof DeliveryError) return c.json({ error: e.code === 'not_found' ? 'not found' : e.code }, e.code === 'not_found' ? 404 : 403); throw e; }
  });
