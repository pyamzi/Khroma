import { Hono } from 'hono';
import { z } from 'zod';
import { readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { eq } from 'drizzle-orm';
import type { AppEnv } from '../session.js';
import { requireKind, loadProject, isAdmin, type ProjectRow } from '../access.js';
import { fail } from '../errors.js';
import { clients, projects } from '../../db/schema.js';
import { ProjectJson } from '../../fs/schemas.js';
import { isReserved } from '../../fs/paths.js';
import { createClient, updateClient, createProject, updateProjectHuman, setExtraPrice, markShot, reorderPhotos, setCover, setSharedFiles, projectEvents, projectInsights, HUMAN_PATCH } from '../../domain/admin.js';
import { adoptDuplicate, remapPhoto } from '../../domain/identity.js';
import { getStudio } from '../../domain/settings.js';

const summaryOf = (p: ProjectRow) => ({ id: p.id, title: ProjectJson.parse(p.metadataJson).title, date: p.date, folderPath: p.folderPath, state: { booking: p.bookingState, production: p.productionState, archivedAt: p.archivedAt }, available: p.available, transferPending: p.transferPending });
const Emails = z.array(z.string().email());
const ClientBody = z.object({ name: z.string().min(1), emails: Emails.default([]), phone: z.string().optional(), notes: z.string().optional() });
const ProjectBody = z.object({ clientId: z.string().min(1), title: z.string().min(1), date: z.string().nullable().optional(), included: z.number().int().min(0).optional(), extraPrice: z.number().int().min(0).optional(), assignedTo: z.string().nullable().optional() });

/** Non-media files inside a project folder, one level deep plus documents/, with the shared flag. */
async function projectFiles(photosDir: string, p: ProjectRow): Promise<{ rel: string; size: number; shared: boolean }[]> {
  const meta = ProjectJson.parse(p.metadataJson); const skip = new Set([meta.folders.culling, meta.folders.finals, 'project.json']);
  const out: { rel: string; size: number; shared: boolean }[] = [];
  const walk = async (rel: string) => {
    const abs = join(photosDir, p.folderPath, rel); let ds; try { ds = await readdir(abs, { withFileTypes: true }); } catch { return; }
    for (const d of ds) {
      const r = rel ? `${rel}/${d.name}` : d.name; if (d.name.startsWith('.') || skip.has(r) || isReserved(r)) continue;
      if (d.isDirectory()) { if (rel === '') await walk(r); }
      else if (d.isFile()) { const s = await stat(join(abs, d.name)); out.push({ rel: r, size: s.size, shared: meta.sharedFiles.includes(r) }); }
    }
  };
  await walk('');
  return out.sort((a, b) => a.rel.localeCompare(b.rel));
}

export const adminRoutes = (photosDir: string) => new Hono<AppEnv>()
  // client-facing: shared files only
  .get('/api/projects/:id/files', loadProject(), async (c) => {
    const files = await projectFiles(photosDir, c.get('project'));
    return c.json(isAdmin(c.get('db'), c.get('session')) ? files : files.filter((f) => f.shared).map(({ rel, size }) => ({ rel, size })));
  })
  .get('/api/clients', requireKind('admin'), (c) => {
    const db = c.get('db'); const ps = db.select().from(projects).all();
    return c.json(db.select().from(clients).all().map((cl) => ({ id: cl.id, name: cl.name, emails: cl.emails, folderPath: cl.folderPath, available: cl.available, projects: ps.filter((p) => p.clientId === cl.id).length })));
  })
  .post('/api/clients', requireKind('admin'), async (c) => {
    const b = ClientBody.safeParse(await c.req.json().catch(() => null)); if (!b.success) return c.json({ error: 'invalid body' }, 400);
    try { return c.json(await createClient(c.get('db'), photosDir, { name: b.data.name, emails: b.data.emails, actor: c.get('session')!.subject }), 201); } catch (e) { return fail(c, e); }
  })
  .get('/api/clients/:id', requireKind('admin'), (c) => {
    const db = c.get('db'); const cl = db.select().from(clients).where(eq(clients.id, c.req.param('id'))).get(); if (!cl) return c.json({ error: 'not found' }, 404);
    return c.json({ ...cl, projects: db.select().from(projects).where(eq(projects.clientId, cl.id)).all().map(summaryOf) });
  })
  .patch('/api/clients/:id', requireKind('admin'), async (c) => {
    const b = ClientBody.partial().safeParse(await c.req.json().catch(() => null)); if (!b.success) return c.json({ error: 'invalid body' }, 400);
    try { await updateClient(c.get('db'), photosDir, { clientId: c.req.param('id'), patch: b.data, actor: c.get('session')!.subject }); return c.json({ ok: true }); } catch (e) { return fail(c, e); }
  })
  .post('/api/projects', requireKind('admin'), async (c) => {
    const b = ProjectBody.safeParse(await c.req.json().catch(() => null)); if (!b.success) return c.json({ error: 'invalid body' }, 400);
    const st = getStudio(c.get('db'));
    try { return c.json(await createProject(c.get('db'), photosDir, { ...b.data, included: b.data.included ?? st.defaultIncluded, extraPrice: b.data.extraPrice ?? st.defaultExtraPrice, actor: c.get('session')!.subject }), 201); } catch (e) { return fail(c, e); }
  })
  .patch('/api/projects/:id', requireKind('admin'), loadProject(), async (c) => {
    const body = await c.req.json().catch(() => null); if (!body || typeof body !== 'object') return c.json({ error: 'invalid body' }, 400);
    const patch = Object.fromEntries(Object.entries(body as Record<string, unknown>).filter(([k]) => (HUMAN_PATCH as readonly string[]).includes(k)));
    if (Object.keys(patch).length !== Object.keys(body as object).length) return c.json({ error: 'invalid' }, 400);
    try { return c.json(await updateProjectHuman(c.get('db'), photosDir, { projectId: c.get('project').id, patch: patch as never, actor: c.get('session')!.subject })); } catch (e) { return fail(c, e); }
  })
  .post('/api/projects/:id/price', requireKind('admin'), loadProject(), async (c) => {
    const b = z.object({ extraPrice: z.number().int().min(0) }).safeParse(await c.req.json().catch(() => null)); if (!b.success) return c.json({ error: 'invalid body' }, 400);
    try { await setExtraPrice(c.get('db'), photosDir, { projectId: c.get('project').id, extraPrice: b.data.extraPrice, actor: c.get('session')!.subject }); return c.json({ ok: true }); } catch (e) { return fail(c, e); }
  })
  .post('/api/projects/:id/shot', requireKind('admin'), loadProject(), async (c) => {
    try { await markShot(c.get('db'), photosDir, { projectId: c.get('project').id, actor: c.get('session')!.subject }); return c.json({ ok: true }); } catch (e) { return fail(c, e); }
  })
  .post('/api/projects/:id/photos/order', requireKind('admin'), loadProject(), async (c) => {
    const b = z.object({ ids: z.array(z.string()).min(1) }).safeParse(await c.req.json().catch(() => null)); if (!b.success) return c.json({ error: 'invalid body' }, 400);
    try { reorderPhotos(c.get('db'), { projectId: c.get('project').id, ids: b.data.ids, actor: c.get('session')!.subject }); return c.json({ ok: true }); } catch (e) { return fail(c, e); }
  })
  .post('/api/projects/:id/cover', requireKind('admin'), loadProject(), async (c) => {
    const b = z.object({ photoId: z.string().nullable() }).safeParse(await c.req.json().catch(() => null)); if (!b.success) return c.json({ error: 'invalid body' }, 400);
    try { await setCover(c.get('db'), photosDir, { projectId: c.get('project').id, photoId: b.data.photoId, actor: c.get('session')!.subject }); return c.json({ ok: true }); } catch (e) { return fail(c, e); }
  })
  .post('/api/projects/:id/share-file', requireKind('admin'), loadProject(), async (c) => {
    const b = z.object({ rel: z.string().min(1), shared: z.boolean() }).safeParse(await c.req.json().catch(() => null)); if (!b.success) return c.json({ error: 'invalid body' }, 400);
    try { return c.json({ sharedFiles: await setSharedFiles(c.get('db'), photosDir, { projectId: c.get('project').id, rel: b.data.rel, shared: b.data.shared, actor: c.get('session')!.subject }) }); } catch (e) { return fail(c, e); }
  })
  .get('/api/projects/:id/events', requireKind('admin'), loadProject(), (c) => c.json(projectEvents(c.get('db'), c.get('project').id, Number(c.req.query('limit') ?? 100))))
  .get('/api/projects/:id/insights', requireKind('admin'), loadProject(), (c) => c.json(projectInsights(c.get('db'), c.get('project').id)))
  .post('/api/projects/:id/photos/remap', requireKind('admin'), loadProject(), async (c) => {
    const b = z.object({ missingPhotoId: z.string().min(1), newPhotoId: z.string().min(1) }).safeParse(await c.req.json().catch(() => null)); if (!b.success) return c.json({ error: 'invalid body' }, 400);
    try { remapPhoto(c.get('db'), { projectId: c.get('project').id, ...b.data, actor: c.get('session')!.subject }); return c.json({ ok: true }); } catch (e) { return fail(c, e); }
  })
  .post('/api/issues/adopt', requireKind('admin'), async (c) => {
    const b = z.object({ path: z.string().min(1) }).safeParse(await c.req.json().catch(() => null)); if (!b.success) return c.json({ error: 'invalid body' }, 400);
    try { return c.json(await adoptDuplicate(c.get('db'), photosDir, { rel: b.data.path, actor: c.get('session')!.subject })); } catch (e) { return fail(c, e); }
  });
