import { Hono } from 'hono';
import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { Readable } from 'node:stream';
import type { AppEnv } from '../session.js';
import { loadPhoto } from '../access.js';
import { cachePaths } from '../../fs/photos.js';

/** Serves only app-generated cache files; originals are never exposed by path. */
export const photoRoutes = (photosDir: string) => new Hono<AppEnv>()
  .get('/api/photos/:photoId/preview', loadPhoto(), async (c) => {
    const { preview, thumb } = cachePaths(photosDir, c.get('project'), c.get('photo').id);
    const file = c.req.query('size') === 'thumb' ? thumb : preview;
    const s = await stat(file).catch(() => null);
    if (!s) return c.json({ error: 'not ready' }, 404);
    c.header('content-type', 'image/jpeg'); c.header('content-length', String(s.size)); c.header('cache-control', 'private, max-age=3600');
    return c.body(Readable.toWeb(createReadStream(file)) as ReadableStream);
  });
