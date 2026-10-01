import { Hono } from 'hono';
import { eq, and, lt } from 'drizzle-orm';
import type { AppEnv } from '../session.js';
import { listProjectsFor, loadProject, isAdmin, type ProjectRow } from '../access.js';
import { photos, picks, events } from '../../db/schema.js';
import type { Db } from '../../db/client.js';
import { ProjectMeta } from '../../domain/meta.js';
import { summary } from '../../domain/selection.js';
import { commentCounts } from '../../domain/comments.js';
import { previewVersion } from '../../domain/photos.js';

export const summaryOf = (p: ProjectRow) => ({
  id: p.id, clientId: p.clientId, title: ProjectMeta.parse(p.metadataJson).title, date: p.date,
  state: { booking: p.bookingState, production: p.productionState, archivedAt: p.archivedAt },
});

// ponytail: per-machine view throttle; a second machine may record one extra view per hour.
const viewed = new Map<string, number>();
async function recordView(db: Db, sessionId: string, projectId: string, actor: string) {
  const key = `${sessionId}:${projectId}`; const now = Date.now();
  if ((viewed.get(key) ?? 0) > now - 3600_000) return;
  viewed.set(key, now); await db.insert(events).values({ projectId, actor, type: 'viewed', payload: {} });
}

export const projectRoutes = () => new Hono<AppEnv>()
  .get('/api/projects', async (c) => c.json((await listProjectsFor(c.get('db'), c.get('session'))).map(summaryOf)))
  .get('/api/projects/:id', loadProject(), async (c) => {
    const db = c.get('db'); const p = c.get('project'); const s = c.get('session')!; const meta = ProjectMeta.parse(p.metadataJson);
    if (s.kind !== 'admin') await recordView(db, s.id, p.id, s.subject);
    const rows = await db.select().from(photos).where(eq(photos.projectId, p.id));
    const submittedIds = new Set((await db.select({ id: picks.photoId }).from(picks).where(and(eq(picks.projectId, p.id), lt(picks.round, p.currentRound)))).map((r) => r.id));
    const done = rows.filter((r) => submittedIds.has(r.id) && r.editState === 'done').length;
    return c.json({
      ...summaryOf(p), stateVersion: p.stateVersion, viewerEmail: s.subject, selection: await summary(db, p.id), comments: meta.comments, progress: { done, total: submittedIds.size },
      counts: { culling: rows.filter((r) => r.stage === 'culling').length, final: rows.filter((r) => r.stage === 'final' && !r.draftRelPath).length, drafts: rows.filter((r) => r.draftRelPath).length },
    });
  })
  .get('/api/projects/:id/photos', loadProject(), async (c) => {
    const db = c.get('db'); const p = c.get('project'); const admin = await isAdmin(db, c.get('session'));
    const q = c.req.query('stage');
    const stage: 'culling' | 'final' = q === 'culling' || q === 'final' ? q : ['culling', 'editing'].includes(p.productionState) ? 'culling' : 'final';
    const pickBy = new Map((await db.select().from(picks).where(eq(picks.projectId, p.id))).map((k) => [k.photoId, k]));
    const cc = await commentCounts(db, p.id);
    const rows = (await db.select().from(photos).where(and(eq(photos.projectId, p.id), eq(photos.stage, stage))))
      .filter((r) => admin || r.live)
      .sort((a, b) => a.sortOrder - b.sortOrder || (a.capturedAt ?? '').localeCompare(b.capturedAt ?? '') || a.relPath.localeCompare(b.relPath));
    return c.json(rows.map((r) => {
      const k = pickBy.get(r.id);
      return {
        id: r.id, relPath: r.relPath, stage: r.stage, kind: r.kind, width: r.width, height: r.height, section: r.section, hasDraft: !!r.draftRelPath, previewReady: r.width !== null, v: previewVersion(r),
        pick: k ? { state: k.state, byEmail: k.byEmail, locked: k.round < p.currentRound } : null, comments: cc[r.id] ?? { open: 0, total: 0 },
      };
    }));
  });
