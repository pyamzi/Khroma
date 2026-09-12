import { Hono } from 'hono';
import { eq, and, lt } from 'drizzle-orm';
import type { AppEnv } from '../session.js';
import { listProjectsFor, loadProject, requireKind, isAdmin, type ProjectRow } from '../access.js';
import { photos, picks, events } from '../../db/schema.js';
import type { Db } from '../../db/client.js';
import { approveTransfer, rescan } from '../../fs/index.js';
import { ProjectJson } from '../../fs/schemas.js';
import { summary } from '../../domain/selection.js';
import { commentCounts } from '../../domain/comments.js';

const summaryOf = (p: ProjectRow) => ({
  id: p.id, title: ProjectJson.parse(p.metadataJson).title, date: p.date, folderPath: p.folderPath,
  state: { booking: p.bookingState, production: p.productionState, archivedAt: p.archivedAt },
  available: p.available, transferPending: p.transferPending,
});

// ponytail: per-process view throttle; one process per NAS.
const viewed = new Map<string, number>();
function recordView(db: Db, sessionId: string, projectId: string, actor: string) {
  const key = `${sessionId}:${projectId}`; const now = Date.now();
  if ((viewed.get(key) ?? 0) > now - 3600_000) return;
  viewed.set(key, now); db.insert(events).values({ projectId, actor, type: 'viewed', payload: {} }).run();
}

export const projectRoutes = (photosDir: string) => new Hono<AppEnv>()
  .get('/api/projects', (c) => c.json(listProjectsFor(c.get('db'), c.get('session')).map(summaryOf)))
  .get('/api/projects/:id', loadProject(), (c) => {
    const db = c.get('db'); const p = c.get('project'); const s = c.get('session')!; const meta = ProjectJson.parse(p.metadataJson);
    if (s.kind !== 'admin') recordView(db, s.id, p.id, s.subject);
    const rows = db.select().from(photos).where(and(eq(photos.projectId, p.id), eq(photos.missing, false))).all();
    const submittedIds = new Set(db.select({ id: picks.photoId }).from(picks).where(and(eq(picks.projectId, p.id), lt(picks.round, p.currentRound))).all().map((r) => r.id));
    const done = rows.filter((r) => submittedIds.has(r.id) && r.editState === 'done').length;
    return c.json({
      ...summaryOf(p), viewerEmail: s.subject, selection: summary(db, p.id), comments: meta.comments, progress: { done, total: submittedIds.size },
      counts: { culling: rows.filter((r) => r.stage === 'culling').length, final: rows.filter((r) => r.stage === 'final' && !r.draftRelPath).length, drafts: rows.filter((r) => r.draftRelPath).length },
    });
  })
  .get('/api/projects/:id/photos', loadProject(), (c) => {
    const db = c.get('db'); const p = c.get('project'); const admin = isAdmin(db, c.get('session'));
    const q = c.req.query('stage');
    const stage: 'culling' | 'final' = q === 'culling' || q === 'final' ? q : ['culling', 'editing'].includes(p.productionState) ? 'culling' : 'final';
    const pickBy = new Map(db.select().from(picks).where(eq(picks.projectId, p.id)).all().map((k) => [k.photoId, k]));
    const cc = commentCounts(db, p.id);
    const rows = db.select().from(photos).where(and(eq(photos.projectId, p.id), eq(photos.missing, false), eq(photos.stage, stage))).all()
      .filter((r) => admin || !r.draftRelPath)
      .sort((a, b) => a.sortOrder - b.sortOrder || (a.capturedAt ?? '').localeCompare(b.capturedAt ?? '') || a.relPath.localeCompare(b.relPath));
    return c.json(rows.map((r) => {
      const k = pickBy.get(r.id);
      return {
        id: r.id, relPath: r.relPath, stage: r.stage, kind: r.kind, width: r.width, height: r.height, section: r.section, hasDraft: !!r.draftRelPath, previewReady: r.width !== null,
        pick: k ? { state: k.state, byEmail: k.byEmail, locked: k.round < p.currentRound } : null, comments: cc[r.id] ?? { open: 0, total: 0 },
      };
    }));
  })
  .post('/api/projects/:id/approve-transfer', requireKind('admin'), async (c) => {
    try { await approveTransfer(c.get('db'), photosDir, c.req.param('id'), c.get('session')!.subject); }
    catch (e) { return c.json({ error: (e as Error).message }, 409); }
    await rescan(c.get('db'), photosDir); // refresh the issues snapshot
    return c.json({ ok: true });
  });
