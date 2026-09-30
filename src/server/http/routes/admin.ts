import { Hono } from 'hono';
import { z } from 'zod';
import { eq } from 'drizzle-orm';
import type { AppEnv } from '../session.js';
import { requireKind, loadProject } from '../access.js';
import { fail } from '../errors.js';
import { clients, projects } from '../../db/schema.js';
import { summaryOf } from './projects.js';
import { createClient, updateClient, createProject, updateProjectHuman, setExtraPrice, markShot, reorderPhotos, setCover, projectEvents, projectInsights, HUMAN_PATCH } from '../../domain/admin.js';
import { getStudio } from '../../domain/settings.js';

const Emails = z.array(z.string().email());
const ClientBody = z.object({ name: z.string().min(1), emails: Emails.default([]), phone: z.string().max(40).optional(), notes: z.string().max(5000).optional() });
const ProjectBody = z.object({ clientId: z.string().min(1), title: z.string().min(1), date: z.string().nullable().optional(), included: z.number().int().min(0).optional(), extraPrice: z.number().int().min(0).optional(), assignedTo: z.string().nullable().optional() });

export const adminRoutes = () => new Hono<AppEnv>()
  .get('/api/clients', requireKind('admin'), async (c) => {
    const db = c.get('db'); const ps = await db.select().from(projects);
    return c.json((await db.select().from(clients)).map((cl) => ({ id: cl.id, name: cl.name, emails: cl.emails, projects: ps.filter((p) => p.clientId === cl.id).length })));
  })
  .post('/api/clients', requireKind('admin'), async (c) => {
    const b = ClientBody.safeParse(await c.req.json().catch(() => null)); if (!b.success) return c.json({ error: 'invalid body' }, 400);
    try { return c.json(await createClient(c.get('db'), { ...b.data, actor: c.get('session')!.subject }), 201); } catch (e) { return fail(c, e); }
  })
  .get('/api/clients/:id', requireKind('admin'), async (c) => {
    const db = c.get('db'); const [cl] = await db.select().from(clients).where(eq(clients.id, c.req.param('id'))).limit(1); if (!cl) return c.json({ error: 'not found' }, 404);
    return c.json({ ...cl, projects: (await db.select().from(projects).where(eq(projects.clientId, cl.id))).map(summaryOf) });
  })
  .patch('/api/clients/:id', requireKind('admin'), async (c) => {
    const b = ClientBody.partial().safeParse(await c.req.json().catch(() => null)); if (!b.success) return c.json({ error: 'invalid body' }, 400);
    try { await updateClient(c.get('db'), { clientId: c.req.param('id'), patch: b.data, actor: c.get('session')!.subject }); return c.json({ ok: true }); } catch (e) { return fail(c, e); }
  })
  .post('/api/projects', requireKind('admin'), async (c) => {
    const b = ProjectBody.safeParse(await c.req.json().catch(() => null)); if (!b.success) return c.json({ error: 'invalid body' }, 400);
    const st = await getStudio(c.get('db'));
    try { return c.json(await createProject(c.get('db'), { ...b.data, included: b.data.included ?? st.defaultIncluded, extraPrice: b.data.extraPrice ?? st.defaultExtraPrice, actor: c.get('session')!.subject }), 201); } catch (e) { return fail(c, e); }
  })
  .patch('/api/projects/:id', requireKind('admin'), loadProject(), async (c) => {
    const body = await c.req.json().catch(() => null); if (!body || typeof body !== 'object') return c.json({ error: 'invalid body' }, 400);
    const patch = Object.fromEntries(Object.entries(body as Record<string, unknown>).filter(([k]) => (HUMAN_PATCH as readonly string[]).includes(k)));
    if (Object.keys(patch).length !== Object.keys(body as object).length) return c.json({ error: 'invalid' }, 400);
    try { return c.json(await updateProjectHuman(c.get('db'), { projectId: c.get('project').id, patch: patch as never, actor: c.get('session')!.subject })); } catch (e) { return fail(c, e); }
  })
  .post('/api/projects/:id/price', requireKind('admin'), loadProject(), async (c) => {
    const b = z.object({ extraPrice: z.number().int().min(0) }).safeParse(await c.req.json().catch(() => null)); if (!b.success) return c.json({ error: 'invalid body' }, 400);
    try { await setExtraPrice(c.get('db'), { projectId: c.get('project').id, extraPrice: b.data.extraPrice, actor: c.get('session')!.subject }); return c.json({ ok: true }); } catch (e) { return fail(c, e); }
  })
  .post('/api/projects/:id/shot', requireKind('admin'), loadProject(), async (c) => {
    try { await markShot(c.get('db'), { projectId: c.get('project').id, actor: c.get('session')!.subject }); return c.json({ ok: true }); } catch (e) { return fail(c, e); }
  })
  .post('/api/projects/:id/photos/order', requireKind('admin'), loadProject(), async (c) => {
    const b = z.object({ ids: z.array(z.string()).min(1) }).safeParse(await c.req.json().catch(() => null)); if (!b.success) return c.json({ error: 'invalid body' }, 400);
    try { await reorderPhotos(c.get('db'), { projectId: c.get('project').id, ids: b.data.ids, actor: c.get('session')!.subject }); return c.json({ ok: true }); } catch (e) { return fail(c, e); }
  })
  .post('/api/projects/:id/cover', requireKind('admin'), loadProject(), async (c) => {
    const b = z.object({ photoId: z.string().nullable() }).safeParse(await c.req.json().catch(() => null)); if (!b.success) return c.json({ error: 'invalid body' }, 400);
    try { await setCover(c.get('db'), { projectId: c.get('project').id, photoId: b.data.photoId, actor: c.get('session')!.subject }); return c.json({ ok: true }); } catch (e) { return fail(c, e); }
  })
  .get('/api/projects/:id/events', requireKind('admin'), loadProject(), async (c) => c.json(await projectEvents(c.get('db'), c.get('project').id, Math.min(500, Number(c.req.query('limit') ?? 100) || 100))))
  .get('/api/projects/:id/insights', requireKind('admin'), loadProject(), async (c) => c.json(await projectInsights(c.get('db'), c.get('project').id)));
