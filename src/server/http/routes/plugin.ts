import { Hono } from 'hono';
import { z } from 'zod';
import { eq } from 'drizzle-orm';
import type { AppEnv } from '../session.js';
import { requireKind, requireScope, loadProject, listProjectsFor } from '../access.js';
import { fail } from '../errors.js';
import { clients, photos } from '../../db/schema.js';
import { ProjectMeta } from '../../domain/meta.js';
import { getStudio } from '../../domain/settings.js';
import { createProject } from '../../domain/admin.js';
import { uploadFinal, deleteFinal, resolvePaths, pluginPicks, pluginComments, replyFromPlugin, reportProgress, FinalsError } from '../../domain/finals.js';
import { CommentError } from '../../domain/comments.js';
import { addCullingPreview, PhotoError } from '../../domain/photos.js';

const VERSION = '0.1.0';
const failPlugin = (c: Parameters<typeof fail>[0], e: unknown) => {
  if (e instanceof FinalsError) return c.json({ error: e.code }, e.code === 'not_found' ? 404 : e.code === 'live_until_published' || e.code === 'conflict' ? 409 : e.code === 'too_large' ? 413 : e.code === 'unsupported' ? 415 : 400);
  if (e instanceof PhotoError) return c.json({ error: e.code }, e.code === 'too_large' ? 413 : e.code === 'unsupported' ? 415 : 400);
  if (e instanceof CommentError) return c.json({ error: e.code }, 422);
  return fail(c, e);
};

/** Plugin response shapes are unchanged from the folder era; `folderPath` is always '' until the H2 plugin rework. */
export const pluginRoutes = () => new Hono<AppEnv>()
  .use('/api/plugin/*', requireKind('plugin'))
  .get('/api/plugin/me', async (c) => { const s = c.get('session')!; return c.json({ name: s.nickname, scope: s.scope, projectId: s.projectId, studio: (await getStudio(c.get('db'))).studioName, version: VERSION }); })
  .get('/api/plugin/projects', async (c) => {
    const db = c.get('db'); const cl = new Map((await db.select().from(clients)).map((x) => [x.id, x.name]));
    return c.json((await listProjectsFor(db, c.get('session'))).map((p) => { const m = ProjectMeta.parse(p.metadataJson); return { id: p.id, title: m.title, folderPath: '', client: cl.get(p.clientId) ?? '', state: { booking: p.bookingState, production: p.productionState }, folders: m.folders }; }));
  })
  .get('/api/plugin/clients', async (c) => c.json((await c.get('db').select({ id: clients.id, name: clients.name }).from(clients)).map((x) => ({ ...x, folderPath: '' }))))
  .post('/api/plugin/projects', requireScope('write'), async (c) => {
    const s = c.get('session')!; if (s.projectId) return c.json({ error: 'read_only' }, 403); // a project-scoped token cannot create projects
    const b = z.object({ clientId: z.string().min(1), title: z.string().min(1) }).safeParse(await c.req.json().catch(() => null)); if (!b.success) return c.json({ error: 'invalid body' }, 400);
    try { const r = await createProject(c.get('db'), { ...b.data, actor: s.subject }); return c.json({ id: r.id, folderPath: '', title: b.data.title }, 201); } catch (e) { return failPlugin(c, e); }
  })
  .post('/api/plugin/projects/:id/resolve', loadProject(), async (c) => {
    const b = z.object({ paths: z.array(z.string()).max(2000) }).safeParse(await c.req.json().catch(() => null)); if (!b.success) return c.json({ error: 'invalid body' }, 400);
    return c.json({ paths: await resolvePaths(c.get('db'), c.get('project').id, b.data.paths) });
  })
  .post('/api/plugin/projects/:id/finals', requireScope('write'), loadProject(), async (c) => {
    const body = await c.req.parseBody().catch(() => ({} as Record<string, unknown>)); const f = body['file'];
    if (!(f instanceof File)) return c.json({ error: 'invalid body' }, 400);
    const str = (k: string) => (typeof body[k] === 'string' ? (body[k] as string) : undefined);
    try {
      const r = await uploadFinal(c.get('db'), c.get('storage'), { projectId: c.get('project').id, name: str('name') ?? f.name, bytes: new Uint8Array(await f.arrayBuffer()), sourcePhotoId: str('sourcePhotoId') || null, uploadId: str('uploadId') ?? '', checksum: str('checksum'), actor: c.get('session')!.subject });
      return c.json(r, r.idempotent ? 200 : 201);
    } catch (e) { return failPlugin(c, e); }
  })
  .post('/api/plugin/projects/:id/culling', requireScope('write'), loadProject(), async (c) => {
    const body = await c.req.parseBody().catch(() => ({} as Record<string, unknown>)); const f = body['file']; const relPath = body['relPath'];
    if (!(f instanceof File) || typeof relPath !== 'string') return c.json({ error: 'invalid body' }, 400);
    try {
      const r = await addCullingPreview(c.get('db'), c.get('storage'), { projectId: c.get('project').id, relPath, bytes: new Uint8Array(await f.arrayBuffer()), name: f.name });
      return c.json(r, r.created ? 201 : 200);
    } catch (e) { return failPlugin(c, e); }
  })
  .delete('/api/plugin/finals/:photoId', requireScope('write'), async (c) => {
    const db = c.get('db'); const [ph] = await db.select({ projectId: photos.projectId }).from(photos).where(eq(photos.id, c.req.param('photoId'))).limit(1);
    if (!ph?.projectId || !(await listProjectsFor(db, c.get('session'))).some((p) => p.id === ph.projectId)) return c.json({ error: 'not_found' }, 404);
    try { await deleteFinal(db, c.get('storage'), { projectId: ph.projectId, photoId: c.req.param('photoId'), actor: c.get('session')!.subject }); return c.json({ ok: true }); } catch (e) { return failPlugin(c, e); }
  })
  .get('/api/plugin/projects/:id/picks', loadProject(), async (c) => c.json(await pluginPicks(c.get('db'), c.get('project').id)))
  .get('/api/plugin/projects/:id/comments', loadProject(), async (c) => c.json(await pluginComments(c.get('db'), c.get('project').id, c.req.query('since') || undefined)))
  .post('/api/plugin/photos/:photoId/comments', requireScope('write'), async (c) => {
    const db = c.get('db'); const [ph] = await db.select({ projectId: photos.projectId }).from(photos).where(eq(photos.id, c.req.param('photoId'))).limit(1);
    if (!ph?.projectId || !(await listProjectsFor(db, c.get('session'))).some((p) => p.id === ph.projectId)) return c.json({ error: 'not_found' }, 404);
    const b = z.object({ text: z.string().min(1).max(2000) }).safeParse(await c.req.json().catch(() => null)); if (!b.success) return c.json({ error: 'invalid body' }, 400);
    try { return c.json(await replyFromPlugin(db, { photoId: c.req.param('photoId'), author: c.get('session')!.subject, text: b.data.text }), 201); } catch (e) { return failPlugin(c, e); }
  })
  .post('/api/plugin/projects/:id/progress', requireScope('write'), loadProject(), async (c) => {
    const b = z.object({ reports: z.array(z.object({ photoId: z.string().min(1), state: z.enum(['editing', 'none']) })).max(5000) }).safeParse(await c.req.json().catch(() => null)); if (!b.success) return c.json({ error: 'invalid body' }, 400);
    return c.json(await reportProgress(c.get('db'), { projectId: c.get('project').id, reports: b.data.reports, actor: c.get('session')!.subject }));
  });
