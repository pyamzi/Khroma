import { Hono } from 'hono';
import { z } from 'zod';
import { eq } from 'drizzle-orm';
import type { AppEnv } from '../session.js';
import { requireKind, requireScope, loadProject, listProjectsFor } from '../access.js';
import { fail } from '../errors.js';
import { clients, photos } from '../../db/schema.js';
import { ProjectJson } from '../../fs/schemas.js';
import { getStudio } from '../../domain/settings.js';
import { createProject } from '../../domain/admin.js';
import { uploadFinal, deleteFinal, resolvePaths, pluginPicks, pluginComments, replyFromPlugin, reportProgress, FinalsError } from '../../domain/finals.js';
import { CommentError } from '../../domain/comments.js';

const VERSION = '0.1.0';
const failPlugin = (c: Parameters<typeof fail>[0], e: unknown) => {
  if (e instanceof FinalsError) return c.json({ error: e.code }, e.code === 'not_found' ? 404 : e.code === 'live_until_published' ? 409 : e.code === 'too_large' ? 413 : e.code === 'unsupported' ? 415 : 400);
  if (e instanceof CommentError) return c.json({ error: e.code }, 422);
  return fail(c, e);
};

export const pluginRoutes = (photosDir: string) => new Hono<AppEnv>()
  .use('/api/plugin/*', requireKind('plugin'))
  .get('/api/plugin/me', (c) => { const s = c.get('session')!; return c.json({ name: s.nickname, scope: s.scope, projectId: s.projectId, studio: getStudio(c.get('db')).studioName, version: VERSION }); })
  .get('/api/plugin/projects', (c) => {
    const db = c.get('db'); const cl = new Map(db.select().from(clients).all().map((x) => [x.id, x.name]));
    return c.json(listProjectsFor(db, c.get('session')).map((p) => { const m = ProjectJson.parse(p.metadataJson); return { id: p.id, title: m.title, folderPath: p.folderPath, client: cl.get(p.clientId) ?? '', state: { booking: p.bookingState, production: p.productionState }, folders: m.folders }; }));
  })
  .get('/api/plugin/clients', (c) => c.json(c.get('db').select({ id: clients.id, name: clients.name, folderPath: clients.folderPath }).from(clients).where(eq(clients.available, true)).all()))
  .post('/api/plugin/projects', requireScope('write'), async (c) => {
    const s = c.get('session')!; if (s.projectId) return c.json({ error: 'read_only' }, 403); // a project-scoped token cannot create projects
    const b = z.object({ clientId: z.string().min(1), title: z.string().min(1) }).safeParse(await c.req.json().catch(() => null)); if (!b.success) return c.json({ error: 'invalid body' }, 400);
    try { const r = await createProject(c.get('db'), photosDir, { ...b.data, actor: s.subject }); return c.json({ id: r.id, folderPath: r.folderPath, title: b.data.title }, 201); } catch (e) { return failPlugin(c, e); }
  })
  .post('/api/plugin/projects/:id/resolve', loadProject(), async (c) => {
    const b = z.object({ paths: z.array(z.string()).max(2000) }).safeParse(await c.req.json().catch(() => null)); if (!b.success) return c.json({ error: 'invalid body' }, 400);
    return c.json({ paths: resolvePaths(c.get('db'), c.get('project').id, b.data.paths) });
  })
  .post('/api/plugin/projects/:id/finals', requireScope('write'), loadProject(), async (c) => {
    const body = await c.req.parseBody(); const f = body['file'];
    if (!(f instanceof File)) return c.json({ error: 'invalid body' }, 400);
    const str = (k: string) => (typeof body[k] === 'string' ? (body[k] as string) : undefined);
    try {
      const r = await uploadFinal(c.get('db'), photosDir, { projectId: c.get('project').id, name: str('name') ?? f.name, bytes: Buffer.from(await f.arrayBuffer()), sourcePhotoId: str('sourcePhotoId') || null, uploadId: str('uploadId') ?? '', checksum: str('checksum'), actor: c.get('session')!.subject });
      return c.json(r, r.idempotent ? 200 : 201);
    } catch (e) { return failPlugin(c, e); }
  })
  .delete('/api/plugin/finals/:photoId', requireScope('write'), async (c) => {
    const db = c.get('db'); const ph = db.select({ projectId: photos.projectId }).from(photos).where(eq(photos.id, c.req.param('photoId'))).get();
    if (!ph || !listProjectsFor(db, c.get('session')).some((p) => p.id === ph.projectId)) return c.json({ error: 'not_found' }, 404);
    try { await deleteFinal(db, photosDir, { projectId: ph.projectId, photoId: c.req.param('photoId'), actor: c.get('session')!.subject }); return c.json({ ok: true }); } catch (e) { return failPlugin(c, e); }
  })
  .get('/api/plugin/projects/:id/picks', loadProject(), (c) => c.json(pluginPicks(c.get('db'), c.get('project').id)))
  .get('/api/plugin/projects/:id/comments', loadProject(), (c) => c.json(pluginComments(c.get('db'), c.get('project').id, c.req.query('since') || undefined)))
  .post('/api/plugin/photos/:photoId/comments', requireScope('write'), async (c) => {
    const db = c.get('db'); const ph = db.select({ projectId: photos.projectId }).from(photos).where(eq(photos.id, c.req.param('photoId'))).get();
    if (!ph || !listProjectsFor(db, c.get('session')).some((p) => p.id === ph.projectId)) return c.json({ error: 'not_found' }, 404);
    const b = z.object({ text: z.string().min(1).max(2000) }).safeParse(await c.req.json().catch(() => null)); if (!b.success) return c.json({ error: 'invalid body' }, 400);
    try { return c.json(replyFromPlugin(db, { photoId: c.req.param('photoId'), author: c.get('session')!.subject, text: b.data.text }), 201); } catch (e) { return failPlugin(c, e); }
  })
  .post('/api/plugin/projects/:id/progress', requireScope('write'), loadProject(), async (c) => {
    const b = z.object({ reports: z.array(z.object({ photoId: z.string().min(1), state: z.enum(['editing', 'none']) })).max(5000) }).safeParse(await c.req.json().catch(() => null)); if (!b.success) return c.json({ error: 'invalid body' }, 400);
    return c.json(reportProgress(c.get('db'), { projectId: c.get('project').id, reports: b.data.reports, actor: c.get('session')!.subject }));
  });
