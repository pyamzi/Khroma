import { Hono } from 'hono';
import { z } from 'zod';
import type { AppEnv } from '../session.js';
import { requireKind } from '../access.js';
import { fail } from '../errors.js';
import { startUpload, completeUpload, libraryPage, libraryStatus, deleteLibraryPhoto } from '../../domain/library.js';

const Upload = z.object({ name: z.string().min(1).max(255), size: z.number().int().positive() });
const Page = z.object({ cursor: z.string().regex(/^[^|]+\|[^|]+$/).optional(), limit: z.coerce.number().int().min(1).max(200).default(60) });

/** The Studio's Library. Admin only; RLS keeps every other Studio's ids at 404. */
export const libraryRoutes = () => new Hono<AppEnv>()
  .post('/api/library/uploads', requireKind('admin'), async (c) => {
    const b = Upload.safeParse(await c.req.json().catch(() => null)); if (!b.success) return c.json({ error: 'invalid body' }, 400);
    try { return c.json(await startUpload(c.get('db'), c.get('storage'), b.data), 201); } catch (e) { return fail(c, e); }
  })
  .post('/api/library/uploads/:photoId/complete', requireKind('admin'), async (c) => {
    try { await completeUpload(c.get('db'), c.req.param('photoId')); return c.json({ ok: true }); } catch (e) { return fail(c, e); }
  })
  .get('/api/library', requireKind('admin'), async (c) => {
    const q = Page.safeParse({ cursor: c.req.query('cursor') || undefined, limit: c.req.query('limit') || undefined }); if (!q.success) return c.json({ error: 'invalid query' }, 400);
    return c.json(await libraryPage(c.get('db'), q.data));
  })
  .get('/api/library/status', requireKind('admin'), async (c) => {
    const ids = z.array(z.string().min(1).max(64)).min(1).max(100).safeParse((c.req.query('ids') ?? '').split(',').filter(Boolean)); if (!ids.success) return c.json({ error: 'invalid query' }, 400);
    return c.json(await libraryStatus(c.get('db'), ids.data));
  })
  .delete('/api/library/:photoId', requireKind('admin'), async (c) => {
    try { await deleteLibraryPhoto(c.get('db'), c.get('storage'), c.req.param('photoId')); return c.json({ ok: true }); } catch (e) { return fail(c, e); }
  });
