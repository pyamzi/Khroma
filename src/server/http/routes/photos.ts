import { Hono } from 'hono';
import { createReadStream } from 'node:fs';
import { lstat } from 'node:fs/promises';
import { relative } from 'node:path';
import { Readable } from 'node:stream';
import type { AppEnv } from '../session.js';
import { loadPhoto, isAdmin } from '../access.js';
import { resolveInside } from '../../fs/paths.js';
import { cachePaths } from '../../fs/photos.js';

/** Serves only app-generated cache files; originals are never exposed by path. */
export const photoRoutes = (photosDir: string) => new Hono<AppEnv>()
  .get('/api/photos/:photoId/preview', loadPhoto(), async (c) => {
    const photo = c.get('photo'); const admin = isAdmin(c.get('db'), c.get('session'));
    const variant = admin && c.req.query('draft') === '1' && photo.draftRelPath ? 'draft' : 'live';
    if (variant === 'live' && !photo.live) return c.json({ error: 'not found' }, 404);
    const { preview, thumb } = cachePaths(photosDir, c.get('project'), photo.id, variant);
    const file = c.req.query('size') === 'thumb' ? thumb : preview;
    await resolveInside(photosDir, relative(photosDir, file)).catch(() => null);
    const s = await lstat(file).catch(() => null);
    if (!s || !s.isFile() || s.isSymbolicLink()) return c.json({ error: 'not ready' }, 404);
    c.header('content-type', 'image/jpeg'); c.header('content-length', String(s.size)); c.header('cache-control', 'private, max-age=3600');
    return c.body(Readable.toWeb(createReadStream(file)) as ReadableStream);
  });
