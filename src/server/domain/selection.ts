import { and, eq, lt, asc, sql } from 'drizzle-orm';
import type { Db } from '../db/client.js';
import { projects, photos, picks, slotGrants, events } from '../db/schema.js';
import { ProjectJson } from '../fs/schemas.js';
import { entitlementOf, writeProjection } from '../fs/index.js';
import { newId } from '../fs/ids.js';

export class Conflict extends Error { constructor(public selectionVersion: number) { super('conflict'); this.name = 'Conflict'; } }
export class SelectionError extends Error {
  constructor(public code: 'locked' | 'unknown_photo' | 'not_culling' | 'below_submitted' | 'negative_entitlement') { super(code); this.name = 'SelectionError'; }
}
export type SelectionSummary = { round: number; selectionVersion: number; included: number; entitlement: number; submitted: number; confirmed: number; pending: number; deficit: number; extraPrice: number };

function project(db: Db, id: string) {
  const row = db.select().from(projects).where(eq(projects.id, id)).get();
  if (!row) throw new Error(`unknown project ${id}`);
  return row;
}
export function entitlement(db: Db, projectId: string): number { return entitlementOf(db, project(db, projectId)); }

/** Submitted rounds stay confirmed; current-round picks are confirmed in picked_at order up to what is left. */
export function recompute(db: Db, projectId: string): void {
  const row = project(db, projectId);
  // a pick on a photo that vanished from disk cannot be edited or delivered; drop it from the open round
  for (const gone of db.select({ photoId: picks.photoId }).from(picks).innerJoin(photos, eq(photos.id, picks.photoId)).where(and(eq(picks.projectId, projectId), eq(picks.round, row.currentRound), eq(photos.missing, true))).all()) {
    db.delete(picks).where(and(eq(picks.projectId, projectId), eq(picks.photoId, gone.photoId))).run();
    db.insert(events).values({ projectId, actor: 'system', type: 'pick_dropped_missing', payload: { photoId: gone.photoId } }).run();
  }
  const ent = entitlementOf(db, row);
  const submitted = db.select({ n: sql<number>`count(*)` }).from(picks).where(and(eq(picks.projectId, projectId), lt(picks.round, row.currentRound))).get()!.n;
  const current = db.select().from(picks).where(and(eq(picks.projectId, projectId), eq(picks.round, row.currentRound))).orderBy(asc(picks.pickedAt), asc(picks.photoId)).all();
  let free = Math.max(0, ent - Number(submitted));
  for (const p of current) {
    const state = free > 0 ? 'confirmed' : 'pending'; if (free > 0) free--;
    if (p.state !== state) db.update(picks).set({ state }).where(and(eq(picks.projectId, projectId), eq(picks.photoId, p.photoId))).run();
  }
}

export function summary(db: Db, projectId: string): SelectionSummary {
  const row = project(db, projectId); const meta = ProjectJson.parse(row.metadataJson);
  const ent = entitlementOf(db, row);
  const all = db.select().from(picks).where(eq(picks.projectId, projectId)).all();
  const submitted = all.filter((p) => p.round < row.currentRound).length;
  const cur = all.filter((p) => p.round === row.currentRound);
  return {
    round: row.currentRound, selectionVersion: row.selectionVersion, included: meta.allowance.included, entitlement: ent, submitted,
    confirmed: cur.filter((p) => p.state === 'confirmed').length, pending: cur.filter((p) => p.state === 'pending').length,
    deficit: Math.max(0, submitted - ent), extraPrice: meta.allowance.extraPrice,
  };
}

export function currentPicks(db: Db, projectId: string) {
  const row = project(db, projectId);
  return db.select().from(picks).where(eq(picks.projectId, projectId)).all()
    .map((p) => ({ photoId: p.photoId, byEmail: p.byEmail, state: p.state, round: p.round, locked: p.round < row.currentRound }));
}

/** One shared selection per project. Carries the caller's selectionVersion; stale → Conflict with the current one. */
export function setPick(db: Db, o: { projectId: string; photoId: string; picked: boolean; byEmail: string; expectedVersion: number }): SelectionSummary {
  return db.transaction((tx) => {
    const d = tx as unknown as Db;
    const row = project(d, o.projectId);
    if (row.selectionVersion !== o.expectedVersion) throw new Conflict(row.selectionVersion);
    if (row.productionState !== 'culling') throw new SelectionError('not_culling');
    const ph = d.select().from(photos).where(and(eq(photos.id, o.photoId), eq(photos.projectId, o.projectId))).get();
    if (!ph || ph.stage !== 'culling' || (o.picked && ph.missing)) throw new SelectionError('unknown_photo'); // unpicking a vanished photo is allowed
    const existing = d.select().from(picks).where(and(eq(picks.projectId, o.projectId), eq(picks.photoId, o.photoId))).get();
    if (existing && existing.round < row.currentRound) throw new SelectionError('locked');
    const actor = o.byEmail.toLowerCase();
    let changed = false;
    if (o.picked && !existing) {
      d.insert(picks).values({ projectId: o.projectId, photoId: o.photoId, round: row.currentRound, byEmail: actor, state: 'pending' }).run();
      d.insert(events).values({ projectId: o.projectId, actor, type: 'picked', payload: { photoId: o.photoId } }).run(); changed = true;
    } else if (!o.picked && existing) {
      d.delete(picks).where(and(eq(picks.projectId, o.projectId), eq(picks.photoId, o.photoId))).run();
      d.insert(events).values({ projectId: o.projectId, actor, type: 'unpicked', payload: { photoId: o.photoId } }).run(); changed = true;
    }
    if (!changed) return summary(d, o.projectId); // a repeated or duplicate request must not invalidate anyone else's version
    d.update(projects).set({ selectionVersion: row.selectionVersion + 1 }).where(eq(projects.id, o.projectId)).run();
    recompute(d, o.projectId);
    return summary(d, o.projectId);
  });
}

/** Append-only entitlement change; `reference` is unique so one provider transaction grants once. */
export async function grantSlots(db: Db, photosDir: string, o: { projectId: string; delta: number; reason: 'gift' | 'purchase' | 'refund' | 'release'; actor: string; reference?: string }): Promise<SelectionSummary> {
  db.transaction((tx) => {
    const d = tx as unknown as Db;
    if (entitlementOf(d, project(d, o.projectId)) + o.delta < 0) throw new SelectionError('negative_entitlement'); // a deficit is measured against submitted picks, never as negative slots
    d.insert(slotGrants).values({ id: newId(), projectId: o.projectId, delta: o.delta, reason: o.reason, actor: o.actor, reference: o.reference ?? null }).run();
    d.insert(events).values({ projectId: o.projectId, actor: o.actor, type: 'slots_granted', payload: { delta: o.delta, reason: o.reason, reference: o.reference ?? null } }).run();
    d.update(projects).set({ selectionVersion: sql`${projects.selectionVersion} + 1` }).where(eq(projects.id, o.projectId)).run();
    recompute(d, o.projectId);
  });
  await writeProjection(db, photosDir, o.projectId);
  return summary(db, o.projectId);
}

/** Admin changes the included allowance; never below what has already been submitted. */
export async function setIncluded(db: Db, photosDir: string, o: { projectId: string; included: number; actor: string }): Promise<SelectionSummary> {
  db.transaction((tx) => {
    const d = tx as unknown as Db;
    const row = project(d, o.projectId); const meta = ProjectJson.parse(row.metadataJson);
    const submitted = Number(d.select({ n: sql<number>`count(*)` }).from(picks).where(and(eq(picks.projectId, o.projectId), lt(picks.round, row.currentRound))).get()!.n);
    const granted = entitlementOf(d, row) - meta.allowance.included;
    if (o.included + granted < submitted) throw new SelectionError('below_submitted');
    meta.allowance.included = o.included;
    d.update(projects).set({ metadataJson: meta as Record<string, unknown>, selectionVersion: row.selectionVersion + 1 }).where(eq(projects.id, o.projectId)).run();
    d.insert(events).values({ projectId: o.projectId, actor: o.actor, type: 'allowance_changed', payload: { included: o.included } }).run();
    recompute(d, o.projectId);
  });
  await writeProjection(db, photosDir, o.projectId);
  return summary(db, o.projectId);
}
