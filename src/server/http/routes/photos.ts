import { Hono } from 'hono';
import type { AppEnv } from '../session.js';
import { loadPhoto, isAdmin } from '../access.js';
import { photoKey } from '../../storage.js';

/** Serves only rendered previews; originals are never exposed. */
export const photoRoutes = () => new Hono<AppEnv>()
  .get('/api/photos/:photoId/preview', loadPhoto(), async (c) => {
    const photo = c.get('photo'); const admin = await isAdmin(c.get('db'), c.get('session'));
    const draft = admin && c.req.query('draft') === '1' && !!photo.draftRelPath;
    if (!draft && !photo.live) return c.json({ error: 'not found' }, 404);
    const size = c.req.query('size') === 'thumb' ? 'thumb' : 'preview';
    const obj = await c.get('storage').get(photoKey(photo.studioId, photo.id, draft ? `${size}.draft` : size));
    if (!obj) return c.json({ error: 'not ready' }, 404);
    c.header('content-type', 'image/jpeg'); c.header('content-length', String(obj.size)); c.header('cache-control', 'private, max-age=3600');
    return c.body(obj.body);
  });
