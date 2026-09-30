import { describe, it, expect } from 'vitest';
import { eq } from 'drizzle-orm';
import { clients, projects, photos, picks, events, jobs, users, invoices } from '../../src/server/db/schema.js';
import type { Db } from '../../src/server/db/client.js';
import { asSystem, withStudio } from '../../src/server/db/tenancy.js';
import { defaultProjectMeta } from '../../src/server/domain/meta.js';
import { setPick } from '../../src/server/domain/selection.js';
import { finishRound, cancelRound, requestExtras, adminRecipients, onCullingMediaAdded } from '../../src/server/domain/transitions.js';
import { studioTestDb, makeStudio } from '../helpers.js';

const pid = 'p1';
async function seed(included = 3, photoIds: string[] = []) {
  const s = await studioTestDb(); const { db } = s;
  const p = defaultProjectMeta('W'); p.allowance = { included, extraPrice: 1500 }; p.assignedTo = 'sam@x';
  await db.insert(users).values({ id: 'u2', email: 'sam@x', role: 'member' });
  await db.insert(clients).values({ id: 'c1', name: 'A', emails: ['s@x.com'] });
  await db.insert(projects).values({ id: pid, clientId: 'c1', metadataJson: p as Record<string, unknown> });
  await addCulling(db, photoIds);
  return s;
}
async function addCulling(db: Db, ids: string[]) {
  for (const id of ids) await db.insert(photos).values({ id, projectId: pid, relPath: `raw/${id}.dng`, stage: 'culling', kind: 'photo', checksum: id });
  if (ids.length) await onCullingMediaAdded(db, pid);
}
const prod = async (db: Db) => (await db.select().from(projects).where(eq(projects.id, pid)))[0]!;
const pick = async (db: Db, photoId: string, picked = true) => setPick(db, { projectId: pid, photoId, picked, byEmail: 's@x', expectedVersion: (await prod(db)).selectionVersion });

describe('transitions', () => {
  it('the first culling photo moves not_started → culling and bumps stateVersion; later photos never regress', async () => {
    const { db } = await seed();
    expect((await prod(db)).productionState).toBe('not_started');
    expect(await onCullingMediaAdded(db, pid)).toBe(false); // nothing to cull yet
    await addCulling(db, ['a']);
    const row = await prod(db);
    expect(row.productionState).toBe('culling'); expect(row.stateVersion).toBe(2);
    await db.update(projects).set({ productionState: 'editing' }).where(eq(projects.id, pid));
    await addCulling(db, ['b']);
    expect((await prod(db)).productionState).toBe('editing');
  });
  it('finish under allowance freezes the round, locks picks, opens round 2, moves to editing, emails the assignee', async () => {
    const { db } = await seed(40, ['a', 'b']);
    await pick(db, 'a'); await db.update(picks).set({ pickedAt: '2026-01-01T00:00:00Z' }).where(eq(picks.photoId, 'a')); await pick(db, 'b');
    const r = await finishRound(db, { projectId: pid, actor: 's@x', expectedVersion: (await prod(db)).selectionVersion, baseUrl: 'https://g' });
    expect(r).toEqual({ round: 1, photoIds: ['a', 'b'] });
    const row = await prod(db);
    expect(row.productionState).toBe('editing'); expect(row.currentRound).toBe(2);
    const ev = (await db.select().from(events)).find((e) => e.type === 'finished_culling')!;
    expect(ev.payload).toEqual({ round: 1, photoIds: ['a', 'b'] });
    const job = (await db.select().from(jobs)).find((j) => j.kind === 'send_email')!;
    expect(job.payload).toMatchObject({ to: 'sam@x', template: 'culling_finished', vars: { count: '2', studio: 'Test Studio' } });
    await expect(pick(db, 'a', false)).rejects.toThrow(/not_culling/);
  });
  it('refuses to finish with zero picks, pending picks, an unpaid extras invoice, a review item, or when not culling', async () => {
    const { db } = await seed(1, ['a', 'b']);
    const fin = async () => finishRound(db, { projectId: pid, actor: 's@x', expectedVersion: (await prod(db)).selectionVersion, baseUrl: 'https://g' });
    await expect(fin()).rejects.toMatchObject({ code: 'no_picks' });
    await pick(db, 'a'); await db.update(picks).set({ pickedAt: '2026-01-01T00:00:00Z' }).where(eq(picks.photoId, 'a')); await pick(db, 'b');
    await expect(fin()).rejects.toMatchObject({ code: 'pending_picks' });
    await pick(db, 'b', false);
    await db.insert(invoices).values({ id: 'i1', projectId: pid, kind: 'extras', amount: 1500, currency: 'usd' });
    await expect(fin()).rejects.toMatchObject({ code: 'unpaid_extras' });
    await db.update(invoices).set({ voidedAt: 'now' }).where(eq(invoices.id, 'i1'));
    await db.insert(invoices).values({ id: 'i2', projectId: pid, kind: 'adjustment', amount: 0, currency: 'usd', needsReview: true });
    await expect(fin()).rejects.toMatchObject({ code: 'needs_review' });
    await db.update(invoices).set({ needsReview: false }).where(eq(invoices.id, 'i2'));
    await expect(finishRound(db, { projectId: pid, actor: 's@x', expectedVersion: 0, baseUrl: 'https://g' })).rejects.toThrow(/conflict/);
    await expect(fin()).resolves.toMatchObject({ round: 1 });
    await expect(fin()).rejects.toMatchObject({ code: 'not_culling' });
    expect((await prod(db)).stateVersion).toBe(3); // culling (2) → editing (3)
  });
  it('cancel round clears current picks and records an event; extras request emails admins once per count', async () => {
    const { db } = await seed(1, ['a']);
    await pick(db, 'a');
    await cancelRound(db, { projectId: pid, actor: 'owner@x' });
    expect(await db.select().from(picks)).toHaveLength(0);
    expect((await db.select().from(events)).some((e) => e.type === 'round_cancelled')).toBe(true);
    await requestExtras(db, { projectId: pid, count: 3, byEmail: 's@x', baseUrl: 'https://g' });
    await requestExtras(db, { projectId: pid, count: 3, byEmail: 's@x', baseUrl: 'https://g' });
    const mails = (await db.select().from(jobs)).filter((j) => j.kind === 'send_email');
    expect(mails).toHaveLength(1);
    expect(mails[0]!.payload).toMatchObject({ to: 'sam@x', template: 'extras_requested', vars: { count: '3' } });
    expect((await db.select().from(events)).filter((e) => e.type === 'extras_requested')).toHaveLength(1); // event log is idempotent too
    await requestExtras(db, { projectId: pid, count: 4, byEmail: 's@x', baseUrl: 'https://g' });
    expect((await db.select().from(events)).filter((e) => e.type === 'extras_requested')).toHaveLength(2); // a different count is a new request
    expect(await adminRecipients(db, pid)).toEqual(['sam@x']);
    await db.delete(users).where(eq(users.email, 'sam@x'));
    expect(await adminRecipients(db, pid)).toEqual(['owner@x']);
  });
  it('finishing emails this Studio\'s Team only', async () => {
    const { db, studioId } = await seed(5, ['a']);
    await makeStudio(db, { ownerEmail: 'other-owner@x' });
    const meta = defaultProjectMeta('W'); meta.allowance = { included: 5, extraPrice: 0 };
    await db.update(projects).set({ metadataJson: meta as Record<string, unknown> }).where(eq(projects.id, pid)); // no assignee: every Team member
    await pick(db, 'a');
    await withStudio(db, studioId, async (tx) => finishRound(tx, { projectId: pid, actor: 's@x', expectedVersion: (await prod(tx)).selectionVersion, baseUrl: 'https://g' }));
    const to = (await asSystem(db, (tx) => tx.select().from(jobs))).map((j) => (j.payload as { to: string }).to).sort();
    expect(to).toEqual(['owner@x', 'sam@x']);
  });
});
