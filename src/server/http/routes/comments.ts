import { Hono } from 'hono';
import { z } from 'zod';
import { eq } from 'drizzle-orm';
import type { AppEnv } from '../session.js';
import { loadPhoto, requireKind, isAdmin } from '../access.js';
import { addComment, listComments, resolveComment, CommentError } from '../../domain/comments.js';
import { comments } from '../../db/schema.js';

const Input = z.object({ text: z.string(), x: z.number().optional(), y: z.number().optional(), w: z.number().optional(), h: z.number().optional(), t: z.number().optional() });

export const commentRoutes = () => new Hono<AppEnv>()
  .get('/api/photos/:photoId/comments', loadPhoto(), async (c) => c.json(await listComments(c.get('db'), c.get('photo').id)))
  .post('/api/photos/:photoId/comments', requireKind('client', 'admin'), loadPhoto(), async (c) => {
    const b = Input.safeParse(await c.req.json().catch(() => null)); if (!b.success) return c.json({ error: 'invalid body' }, 400);
    const db = c.get('db'); const s = c.get('session')!;
    try { return c.json(await addComment(db, { photoId: c.get('photo').id, author: s.subject, isAdmin: await isAdmin(db, s), input: b.data }), 201); }
    catch (e) { if (e instanceof CommentError) return c.json({ error: e.code }, 422); throw e; }
  })
  .post('/api/comments/:id/resolve', requireKind('admin'), async (c) => {
    const db = c.get('db'); const id = c.req.param('id');
    if (!(await db.select({ id: comments.id }).from(comments).where(eq(comments.id, id)).limit(1)).length) return c.json({ error: 'not found' }, 404);
    const b = z.object({ resolved: z.boolean() }).safeParse(await c.req.json().catch(() => null)); if (!b.success) return c.json({ error: 'invalid body' }, 400);
    return c.json(await resolveComment(db, { commentId: id, actor: c.get('session')!.subject, resolved: b.data.resolved }));
  });
