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
    const q = c.req.query('size'); const size = q === 'thumb' || q === 'medium' ? q : 'preview';
    const key = (v: 'thumb' | 'medium' | 'preview') => photoKey(photo.studioId, photo.id, draft ? `${v}.draft` : v);
    // photos rendered before the medium size existed have no medium object: serve their preview
    const obj = await c.get('storage').get(key(size)) ?? (size === 'medium' ? await c.get('storage').get(key('preview')) : null);
    if (!obj) return c.json({ error: 'not ready' }, 404);
    c.header('content-type', 'image/jpeg'); c.header('content-length', String(obj.size)); c.header('cache-control', 'private, max-age=3600');
    return c.body(obj.body);
  });
