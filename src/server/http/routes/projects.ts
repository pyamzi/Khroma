import { Hono } from 'hono';
import { eq, and } from 'drizzle-orm';
import type { AppEnv } from '../session.js';
import { listProjectsFor, loadProject, requireKind, isAdmin, type ProjectRow } from '../access.js';
import { photos } from '../../db/schema.js';
import { approveTransfer, rescan } from '../../fs/index.js';
import { ProjectJson } from '../../fs/schemas.js';

const summary = (p: ProjectRow) => ({
  id: p.id, title: ProjectJson.parse(p.metadataJson).title, date: p.date, folderPath: p.folderPath,
  state: { booking: p.bookingState, production: p.productionState, archivedAt: p.archivedAt },
  available: p.available, transferPending: p.transferPending,
});

export const projectRoutes = (photosDir: string) => new Hono<AppEnv>()
  .get('/api/projects', (c) => c.json(listProjectsFor(c.get('db'), c.get('session')).map(summary)))
  .get('/api/projects/:id', loadProject(), (c) => {
    const p = c.get('project');
    const rows = c.get('db').select().from(photos).where(and(eq(photos.projectId, p.id), eq(photos.missing, false))).all();
    return c.json({ ...summary(p), counts: {
      culling: rows.filter((r) => r.stage === 'culling').length,
      final: rows.filter((r) => r.stage === 'final' && !r.draftRelPath).length,
      drafts: rows.filter((r) => r.draftRelPath).length,
    } });
  })
  .get('/api/projects/:id/photos', loadProject(), (c) => {
    const admin = isAdmin(c.get('db'), c.get('session'));
    const rows = c.get('db').select().from(photos).where(and(eq(photos.projectId, c.get('project').id), eq(photos.missing, false))).all()
      .filter((r) => admin || !r.draftRelPath)
      .sort((a, b) => a.sortOrder - b.sortOrder || (a.capturedAt ?? '').localeCompare(b.capturedAt ?? '') || a.relPath.localeCompare(b.relPath));
    return c.json(rows.map((r) => ({ id: r.id, relPath: r.relPath, stage: r.stage, kind: r.kind, width: r.width, height: r.height, section: r.section, hasDraft: !!r.draftRelPath })));
  })
  .post('/api/projects/:id/approve-transfer', requireKind('admin'), async (c) => {
    try { await approveTransfer(c.get('db'), photosDir, c.req.param('id'), c.get('session')!.subject); }
    catch (e) { return c.json({ error: (e as Error).message }, 409); }
    await rescan(c.get('db'), photosDir); // refresh the issues snapshot
    return c.json({ ok: true });
  });
