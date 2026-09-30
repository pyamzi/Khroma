import { and, eq, isNull } from 'drizzle-orm';
import type { Db } from '../db/client.js';
import { projects, photos, picks, events, users, invoices } from '../db/schema.js';
import { ProjectMeta } from './meta.js';
import { sendEmail } from '../email/send.js';
import { studioName } from './studio.js';
import { Conflict, project, recompute, summary, type ProjectRow } from './selection.js';

export class TransitionError extends Error {
  constructor(public code: 'not_culling' | 'no_picks' | 'pending_picks' | 'unpaid_extras' | 'needs_review' | 'deficit' | 'not_active') { super(code); this.name = 'TransitionError'; }
}
const active = (r: ProjectRow) => r.archivedAt === null && r.bookingState !== 'cancelled';

/** The assignee if they are a Team member, else every Team member. */
export async function adminRecipients(db: Db, projectId: string): Promise<string[]> {
  const meta = ProjectMeta.parse((await project(db, projectId)).metadataJson);
  const all = (await db.select({ email: users.email }).from(users)).map((u) => u.email);
  return meta.assignedTo && all.includes(meta.assignedTo) ? [meta.assignedTo] : all;
}

/** First culling photo: not_started | shot → culling. Never regresses a later state. */
export async function onCullingMediaAdded(db: Db, projectId: string): Promise<boolean> {
  return db.transaction(async (d) => {
    const r = await project(d, projectId, true);
    if (!active(r) || !['not_started', 'shot'].includes(r.productionState)) return false;
    const [usable] = await d.select({ id: photos.id }).from(photos).where(and(eq(photos.projectId, projectId), eq(photos.stage, 'culling'))).limit(1);
    if (!usable) return false;
    await d.update(projects).set({ productionState: 'culling', stateVersion: r.stateVersion + 1 }).where(eq(projects.id, projectId));
    await d.insert(events).values({ projectId, actor: 'system', type: 'production_changed', payload: { from: r.productionState, to: 'culling' } });
    return true;
  });
}

/** Freeze the current round into the finished_culling event, lock its picks, open the next round, move to editing, notify the Studio. */
export function finishRound(db: Db, o: { projectId: string; actor: string; expectedVersion: number; baseUrl: string }): Promise<{ round: number; photoIds: string[] }> {
  return db.transaction(async (d) => {
    const r = await project(d, o.projectId, true);
    if (r.selectionVersion !== o.expectedVersion) throw new Conflict(r.selectionVersion);
    if (!active(r)) throw new TransitionError('not_active');
    if (r.productionState !== 'culling') throw new TransitionError('not_culling');
    await recompute(d, o.projectId);
    const s = await summary(d, o.projectId);
    if (s.confirmed + s.pending === 0) throw new TransitionError('no_picks');
    if (s.pending > 0) throw new TransitionError('pending_picks');
    if (s.deficit > 0) throw new TransitionError('deficit');
    if ((await d.select({ id: invoices.id }).from(invoices).where(and(eq(invoices.projectId, o.projectId), eq(invoices.kind, 'extras'), isNull(invoices.paidAt), isNull(invoices.voidedAt))).limit(1)).length) throw new TransitionError('unpaid_extras');
    if ((await d.select({ id: invoices.id }).from(invoices).where(and(eq(invoices.projectId, o.projectId), eq(invoices.needsReview, true))).limit(1)).length) throw new TransitionError('needs_review');
    const photoIds = (await d.select({ id: picks.photoId }).from(picks).where(and(eq(picks.projectId, o.projectId), eq(picks.round, r.currentRound))).orderBy(picks.pickedAt, picks.photoId)).map((p) => p.id);
    await d.insert(events).values({ projectId: o.projectId, actor: o.actor, type: 'finished_culling', payload: { round: r.currentRound, photoIds } });
    await d.insert(events).values({ projectId: o.projectId, actor: 'system', type: 'production_changed', payload: { from: 'culling', to: 'editing' } });
    await d.update(projects).set({ productionState: 'editing', currentRound: r.currentRound + 1, stateVersion: r.stateVersion + 1, selectionVersion: r.selectionVersion + 1 }).where(eq(projects.id, o.projectId));
    const meta = ProjectMeta.parse(r.metadataJson); const studio = await studioName(d);
    for (const to of await adminRecipients(d, o.projectId))
      await sendEmail(d, { to, template: 'culling_finished', vars: { studio, project: meta.title, count: String(photoIds.length), by: o.actor, url: `${o.baseUrl}/p/${o.projectId}` }, key: `culling_finished:${o.projectId}:${r.currentRound}:${to}` });
    return { round: r.currentRound, photoIds };
  });
}

/** Admin clears the open round (for example when no photos were usable). Submitted rounds are untouched. */
export function cancelRound(db: Db, o: { projectId: string; actor: string }): Promise<void> {
  return db.transaction(async (d) => {
    const r = await project(d, o.projectId, true);
    const n = (await d.delete(picks).where(and(eq(picks.projectId, o.projectId), eq(picks.round, r.currentRound))).returning({ id: picks.photoId })).length;
    await d.insert(events).values({ projectId: o.projectId, actor: o.actor, type: 'round_cancelled', payload: { round: r.currentRound, removed: n } });
    await d.update(projects).set({ selectionVersion: r.selectionVersion + 1 }).where(eq(projects.id, o.projectId));
  });
}

/** No payment yet; tell the Studio. Idempotent per project, round, count, and recipient. */
export function requestExtras(db: Db, o: { projectId: string; count: number; byEmail: string; baseUrl: string }): Promise<void> {
  return db.transaction(async (d) => {
    const r = await project(d, o.projectId, true); const meta = ProjectMeta.parse(r.metadataJson);
    const dup = (await d.select({ payload: events.payload }).from(events).where(and(eq(events.projectId, o.projectId), eq(events.type, 'extras_requested'))))
      .some((e) => { const p = e.payload as { count?: number; round?: number }; return p.count === o.count && p.round === r.currentRound; });
    if (dup) return; // same request already recorded for this round; the email job is keyed the same way
    await d.insert(events).values({ projectId: o.projectId, actor: o.byEmail, type: 'extras_requested', payload: { count: o.count, round: r.currentRound } });
    const studio = await studioName(d);
    for (const to of await adminRecipients(d, o.projectId))
      await sendEmail(d, { to, template: 'extras_requested', vars: { studio, project: meta.title, count: String(o.count), by: o.byEmail, url: `${o.baseUrl}/p/${o.projectId}` }, key: `extras_requested:${o.projectId}:${r.currentRound}:${o.count}:${to}` });
  });
}
