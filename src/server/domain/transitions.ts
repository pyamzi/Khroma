import { and, eq, isNull } from 'drizzle-orm';
import type { Db } from '../db/client.js';
import { projects, photos, picks, events, users, invoices } from '../db/schema.js';
import { ProjectJson } from '../fs/schemas.js';
import { writeProjection } from '../fs/index.js';
import { sendEmail } from '../email/send.js';
import { getSetting } from '../db/settings.js';
import { Conflict, recompute, summary } from './selection.js';

export class TransitionError extends Error {
  constructor(public code: 'not_culling' | 'no_picks' | 'pending_picks' | 'unpaid_extras' | 'needs_review' | 'deficit' | 'not_active') { super(code); this.name = 'TransitionError'; }
}
const row = (db: Db, id: string) => { const r = db.select().from(projects).where(eq(projects.id, id)).get(); if (!r) throw new Error(`unknown project ${id}`); return r; };
const active = (r: ReturnType<typeof row>) => r.available && !r.transferPending && r.archivedAt === null && r.bookingState !== 'cancelled';

/** The assignee if they are a user, else every user. */
export function adminRecipients(db: Db, projectId: string): string[] {
  const meta = ProjectJson.parse(row(db, projectId).metadataJson);
  const all = db.select({ email: users.email }).from(users).all().map((u) => u.email);
  return meta.assignedTo && all.includes(meta.assignedTo) ? [meta.assignedTo] : all;
}

/** First usable culling photo: not_started | shot → culling. Never regresses a later state. */
export async function onCullingMediaIndexed(db: Db, photosDir: string, projectId: string): Promise<boolean> {
  const r = row(db, projectId);
  if (!active(r) || !['not_started', 'shot'].includes(r.productionState)) return false;
  const usable = db.select({ id: photos.id }).from(photos).where(and(eq(photos.projectId, projectId), eq(photos.stage, 'culling'), eq(photos.missing, false))).get();
  if (!usable) return false;
  db.transaction((tx) => {
    tx.update(projects).set({ productionState: 'culling', stateVersion: r.stateVersion + 1 }).where(and(eq(projects.id, projectId), eq(projects.stateVersion, r.stateVersion))).run();
    tx.insert(events).values({ projectId, actor: 'system', type: 'production_changed', payload: { from: r.productionState, to: 'culling' } }).run();
  });
  await writeProjection(db, photosDir, projectId);
  return true;
}

/** Freeze the current round into the finished_culling event, lock its picks, open the next round, move to editing, notify the studio. */
export async function finishRound(db: Db, photosDir: string, o: { projectId: string; actor: string; expectedVersion: number; baseUrl: string }): Promise<{ round: number; photoIds: string[] }> {
  const result = db.transaction((tx) => {
    const d = tx as unknown as Db; const r = row(d, o.projectId);
    if (r.selectionVersion !== o.expectedVersion) throw new Conflict(r.selectionVersion);
    if (!active(r)) throw new TransitionError('not_active');
    if (r.productionState !== 'culling') throw new TransitionError('not_culling');
    recompute(d, o.projectId);
    const s = summary(d, o.projectId);
    if (s.confirmed + s.pending === 0) throw new TransitionError('no_picks');
    if (s.pending > 0) throw new TransitionError('pending_picks');
    if (s.deficit > 0) throw new TransitionError('deficit');
    if (d.select({ id: invoices.id }).from(invoices).where(and(eq(invoices.projectId, o.projectId), eq(invoices.kind, 'extras'), isNull(invoices.paidAt), isNull(invoices.voidedAt))).get()) throw new TransitionError('unpaid_extras');
    if (d.select({ id: invoices.id }).from(invoices).where(and(eq(invoices.projectId, o.projectId), eq(invoices.needsReview, true))).get()) throw new TransitionError('needs_review');
    const photoIds = d.select({ id: picks.photoId }).from(picks).where(and(eq(picks.projectId, o.projectId), eq(picks.round, r.currentRound))).orderBy(picks.pickedAt, picks.photoId).all().map((p) => p.id);
    d.insert(events).values({ projectId: o.projectId, actor: o.actor, type: 'finished_culling', payload: { round: r.currentRound, photoIds } }).run();
    d.insert(events).values({ projectId: o.projectId, actor: 'system', type: 'production_changed', payload: { from: 'culling', to: 'editing' } }).run();
    d.update(projects).set({ productionState: 'editing', currentRound: r.currentRound + 1, stateVersion: r.stateVersion + 1, selectionVersion: r.selectionVersion + 1 }).where(eq(projects.id, o.projectId)).run();
    const meta = ProjectJson.parse(r.metadataJson); const studio = getSetting<string>(d, 'studioName') ?? 'OpenGallery';
    for (const to of adminRecipients(d, o.projectId))
      sendEmail(d, { to, template: 'culling_finished', vars: { studio, project: meta.title, count: String(photoIds.length), by: o.actor, url: `${o.baseUrl}/p/${o.projectId}` }, key: `culling_finished:${o.projectId}:${r.currentRound}:${to}` });
    return { round: r.currentRound, photoIds };
  });
  await writeProjection(db, photosDir, o.projectId);
  return result;
}

/** Admin clears the open round (for example when no photos were usable). Submitted rounds are untouched. */
export async function cancelRound(db: Db, photosDir: string, o: { projectId: string; actor: string }): Promise<void> {
  db.transaction((tx) => {
    const d = tx as unknown as Db; const r = row(d, o.projectId);
    const n = d.delete(picks).where(and(eq(picks.projectId, o.projectId), eq(picks.round, r.currentRound))).run().changes;
    d.insert(events).values({ projectId: o.projectId, actor: o.actor, type: 'round_cancelled', payload: { round: r.currentRound, removed: n } }).run();
    d.update(projects).set({ selectionVersion: r.selectionVersion + 1 }).where(eq(projects.id, o.projectId)).run();
  });
  await writeProjection(db, photosDir, o.projectId);
}

/** Local mode: no payment; tell the studio. Idempotent per project, round, count, and recipient. */
export function requestExtras(db: Db, o: { projectId: string; count: number; byEmail: string; baseUrl: string }): void {
  db.transaction((tx) => {
    const d = tx as unknown as Db; const r = row(d, o.projectId); const meta = ProjectJson.parse(r.metadataJson);
    const studio = getSetting<string>(d, 'studioName') ?? 'OpenGallery';
    const dup = d.select({ payload: events.payload }).from(events).where(and(eq(events.projectId, o.projectId), eq(events.type, 'extras_requested'))).all()
      .some((e) => { const p = e.payload as { count?: number; round?: number }; return p.count === o.count && p.round === r.currentRound; });
    if (dup) return; // same request already recorded for this round; the email job is keyed the same way
    d.insert(events).values({ projectId: o.projectId, actor: o.byEmail, type: 'extras_requested', payload: { count: o.count, round: r.currentRound } }).run();
    for (const to of adminRecipients(d, o.projectId))
      sendEmail(d, { to, template: 'extras_requested', vars: { studio, project: meta.title, count: String(o.count), by: o.byEmail, url: `${o.baseUrl}/p/${o.projectId}` }, key: `extras_requested:${o.projectId}:${r.currentRound}:${o.count}:${to}` });
  });
}
