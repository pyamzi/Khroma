import { and, eq, lt, asc, sql, sum } from 'drizzle-orm';
import type { Db } from '../db/client.js';
import { projects, photos, picks, slotGrants, events } from '../db/schema.js';
import { ProjectMeta } from './meta.js';
import { newId } from '../ids.js';

export class Conflict extends Error { constructor(public selectionVersion: number) { super('conflict'); this.name = 'Conflict'; } }
export class SelectionError extends Error {
  constructor(public code: 'locked' | 'unknown_photo' | 'not_culling' | 'below_submitted' | 'negative_entitlement') { super(code); this.name = 'SelectionError'; }
}
export type SelectionSummary = { round: number; selectionVersion: number; included: number; entitlement: number; submitted: number; confirmed: number; pending: number; deficit: number; extraPrice: number };
export type ProjectRow = typeof projects.$inferSelect;

/** `lock` takes the row lock that serializes version checks between concurrent requests. */
export async function project(db: Db, id: string, lock = false): Promise<ProjectRow> {
  const q = db.select().from(projects).where(eq(projects.id, id)).limit(1);
  const [row] = lock ? await q.for('update') : await q;
  if (!row) throw new Error(`unknown project ${id}`);
  return row;
}
async function entitlementOf(db: Db, row: ProjectRow): Promise<number> {
  const [g] = await db.select({ s: sum(slotGrants.delta) }).from(slotGrants).where(eq(slotGrants.projectId, row.id));
  return ProjectMeta.parse(row.metadataJson).allowance.included + Number(g?.s ?? 0);
}
export async function entitlement(db: Db, projectId: string): Promise<number> { return entitlementOf(db, await project(db, projectId)); }
const submittedCount = async (db: Db, row: ProjectRow) =>
  Number((await db.select({ n: sql<number>`count(*)` }).from(picks).where(and(eq(picks.projectId, row.id), lt(picks.round, row.currentRound))))[0]!.n);

/** Submitted rounds stay confirmed; current-round picks are confirmed in picked_at order up to what is left. */
export async function recompute(db: Db, projectId: string): Promise<void> {
  const row = await project(db, projectId);
  const current = await db.select().from(picks).where(and(eq(picks.projectId, projectId), eq(picks.round, row.currentRound))).orderBy(asc(picks.pickedAt), asc(picks.photoId));
  let free = Math.max(0, (await entitlementOf(db, row)) - (await submittedCount(db, row)));
  for (const p of current) {
    const state = free > 0 ? 'confirmed' : 'pending'; if (free > 0) free--;
    if (p.state !== state) await db.update(picks).set({ state }).where(and(eq(picks.projectId, projectId), eq(picks.photoId, p.photoId)));
  }
}

export async function summary(db: Db, projectId: string): Promise<SelectionSummary> {
  const row = await project(db, projectId); const meta = ProjectMeta.parse(row.metadataJson);
  const ent = await entitlementOf(db, row);
  const all = await db.select().from(picks).where(eq(picks.projectId, projectId));
  const submitted = all.filter((p) => p.round < row.currentRound).length;
  const cur = all.filter((p) => p.round === row.currentRound);
  return {
    round: row.currentRound, selectionVersion: row.selectionVersion, included: meta.allowance.included, entitlement: ent, submitted,
    confirmed: cur.filter((p) => p.state === 'confirmed').length, pending: cur.filter((p) => p.state === 'pending').length,
    deficit: Math.max(0, submitted - ent), extraPrice: meta.allowance.extraPrice,
  };
}

export async function currentPicks(db: Db, projectId: string) {
  const row = await project(db, projectId);
  return (await db.select().from(picks).where(eq(picks.projectId, projectId)))
    .map((p) => ({ photoId: p.photoId, byEmail: p.byEmail, state: p.state, round: p.round, locked: p.round < row.currentRound }));
}

/** One shared selection per project. Carries the caller's selectionVersion; stale → Conflict with the current one. */
export function setPick(db: Db, o: { projectId: string; photoId: string; picked: boolean; byEmail: string; expectedVersion: number }): Promise<SelectionSummary> {
  return db.transaction(async (d) => {
    const row = await project(d, o.projectId, true);
    if (row.selectionVersion !== o.expectedVersion) throw new Conflict(row.selectionVersion);
    if (row.productionState !== 'culling') throw new SelectionError('not_culling');
    const [ph] = await d.select().from(photos).where(and(eq(photos.id, o.photoId), eq(photos.projectId, o.projectId))).limit(1);
    if (!ph || ph.stage !== 'culling') throw new SelectionError('unknown_photo');
    const [existing] = await d.select().from(picks).where(and(eq(picks.projectId, o.projectId), eq(picks.photoId, o.photoId))).limit(1);
    if (existing && existing.round < row.currentRound) throw new SelectionError('locked');
    const actor = o.byEmail.toLowerCase();
    let changed = false;
    if (o.picked && !existing) {
      await d.insert(picks).values({ projectId: o.projectId, photoId: o.photoId, round: row.currentRound, byEmail: actor, state: 'pending' });
      await d.insert(events).values({ projectId: o.projectId, actor, type: 'picked', payload: { photoId: o.photoId } }); changed = true;
    } else if (!o.picked && existing) {
      await d.delete(picks).where(and(eq(picks.projectId, o.projectId), eq(picks.photoId, o.photoId)));
      await d.insert(events).values({ projectId: o.projectId, actor, type: 'unpicked', payload: { photoId: o.photoId } }); changed = true;
    }
    if (!changed) return summary(d, o.projectId); // a repeated or duplicate request must not invalidate anyone else's version
    await d.update(projects).set({ selectionVersion: row.selectionVersion + 1 }).where(eq(projects.id, o.projectId));
    await recompute(d, o.projectId);
    return summary(d, o.projectId);
  });
}

/** Append-only entitlement change; `reference` is unique so one provider transaction grants once. */
export function grantSlots(db: Db, o: { projectId: string; delta: number; reason: 'gift' | 'purchase' | 'refund' | 'release'; actor: string; reference?: string }): Promise<SelectionSummary> {
  return db.transaction(async (d) => {
    const row = await project(d, o.projectId, true);
    if ((await entitlementOf(d, row)) + o.delta < 0) throw new SelectionError('negative_entitlement'); // a deficit is measured against submitted picks, never as negative slots
    await d.insert(slotGrants).values({ id: newId(), projectId: o.projectId, delta: o.delta, reason: o.reason, actor: o.actor, reference: o.reference ?? null });
    await d.insert(events).values({ projectId: o.projectId, actor: o.actor, type: 'slots_granted', payload: { delta: o.delta, reason: o.reason, reference: o.reference ?? null } });
    await d.update(projects).set({ selectionVersion: sql`${projects.selectionVersion} + 1` }).where(eq(projects.id, o.projectId));
    await recompute(d, o.projectId);
    return summary(d, o.projectId);
  });
}

/** Admin changes the included allowance; never below what has already been submitted. */
export function setIncluded(db: Db, o: { projectId: string; included: number; actor: string }): Promise<SelectionSummary> {
  return db.transaction(async (d) => {
    const row = await project(d, o.projectId, true); const meta = ProjectMeta.parse(row.metadataJson);
    const granted = (await entitlementOf(d, row)) - meta.allowance.included;
    if (o.included + granted < (await submittedCount(d, row))) throw new SelectionError('below_submitted');
    meta.allowance.included = o.included;
    await d.update(projects).set({ metadataJson: meta as Record<string, unknown>, selectionVersion: row.selectionVersion + 1 }).where(eq(projects.id, o.projectId));
    await d.insert(events).values({ projectId: o.projectId, actor: o.actor, type: 'allowance_changed', payload: { included: o.included } });
    await recompute(d, o.projectId);
    return summary(d, o.projectId);
  });
}
