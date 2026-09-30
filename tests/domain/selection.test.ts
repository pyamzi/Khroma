import { describe, it, expect } from 'vitest';
import { eq } from 'drizzle-orm';
import { clients, projects, photos, picks, events } from '../../src/server/db/schema.js';
import type { Db } from '../../src/server/db/client.js';
import { setPick, summary, grantSlots, setIncluded, currentPicks, Conflict, SelectionError } from '../../src/server/domain/selection.js';
import { defaultProjectMeta } from '../../src/server/domain/meta.js';
import { studioTestDb, pgFail } from '../helpers.js';

const P = '01993840-0000-7000-8000-0000000000aa';

async function seed(included = 2) {
  const { db } = await studioTestDb();
  const meta = defaultProjectMeta('W'); meta.allowance = { included, extraPrice: 1500 };
  await db.insert(clients).values({ id: 'c1', name: 'A', emails: ['s@x', 't@x'] });
  await db.insert(projects).values({ id: P, clientId: 'c1', productionState: 'culling', metadataJson: meta as Record<string, unknown> });
  for (const n of ['a', 'b', 'c', 'd']) await db.insert(photos).values({ id: n, projectId: P, relPath: `raw/${n}.dng`, stage: 'culling', kind: 'photo', checksum: n });
  await db.insert(photos).values({ id: 'f', projectId: P, relPath: 'finals/f.jpg', stage: 'final', kind: 'photo', checksum: 'f' });
  return { db };
}
const v = async (db: Db) => (await db.select({ v: projects.selectionVersion }).from(projects).where(eq(projects.id, P)))[0]!.v;
const pick = async (db: Db, photoId: string, by = 's@x', picked = true) => setPick(db, { projectId: P, photoId, picked, byEmail: by, expectedVersion: await v(db) });
const at = (db: Db, id: string, t: string) => db.update(picks).set({ pickedAt: t }).where(eq(picks.photoId, id));

describe('selection', () => {
  it('two emails share one selection; a photo counts once', async () => {
    const { db } = await seed();
    await pick(db, 'a', 's@x'); await pick(db, 'a', 't@x');
    const s = await summary(db, P);
    expect(s.confirmed).toBe(1); expect(s.pending).toBe(0); expect(s.entitlement).toBe(2);
    expect(await currentPicks(db, P)).toHaveLength(1);
  });
  it('confirms in picked_at order and marks the overflow pending', async () => {
    const { db } = await seed(2);
    for (const [i, id] of ['a', 'b', 'c'].entries()) { await pick(db, id); await at(db, id, `2026-01-01T00:00:0${i}Z`); }
    await pick(db, 'd');
    const rows = Object.fromEntries((await currentPicks(db, P)).map((p) => [p.photoId, p.state]));
    expect(rows).toEqual({ a: 'confirmed', b: 'confirmed', c: 'pending', d: 'pending' });
    expect(await summary(db, P)).toMatchObject({ confirmed: 2, pending: 2 });
  });
  it('unpicking a confirmed pick promotes the oldest pending one', async () => {
    const { db } = await seed(1);
    await pick(db, 'a'); await at(db, 'a', '2026-01-01T00:00:00Z');
    await pick(db, 'b');
    expect((await currentPicks(db, P)).find((p) => p.photoId === 'b')?.state).toBe('pending');
    await pick(db, 'a', 't@x', false);
    expect(await currentPicks(db, P)).toEqual([expect.objectContaining({ photoId: 'b', state: 'confirmed' })]);
  });
  it('rejects a stale version with the current one attached', async () => {
    const { db } = await seed();
    const stale = await v(db);
    await setPick(db, { projectId: P, photoId: 'a', picked: true, byEmail: 's@x', expectedVersion: stale });
    const err = await setPick(db, { projectId: P, photoId: 'b', picked: true, byEmail: 't@x', expectedVersion: stale }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(Conflict); expect((err as Conflict).selectionVersion).toBe(stale + 1);
    expect(await currentPicks(db, P)).toHaveLength(1);
  });
  it('grants promote pending picks; a negative grant demotes; a reference grants once', async () => {
    const { db } = await seed(1);
    await pick(db, 'a'); await at(db, 'a', '2026-01-01T00:00:00Z');
    await pick(db, 'b');
    let s = await grantSlots(db, { projectId: P, delta: 1, reason: 'gift', actor: 'owner@x' });
    expect(s).toMatchObject({ entitlement: 2, confirmed: 2, pending: 0, deficit: 0 });
    s = await grantSlots(db, { projectId: P, delta: -1, reason: 'refund', actor: 'owner@x', reference: 're_1' });
    expect(s).toMatchObject({ entitlement: 1, confirmed: 1, pending: 1, deficit: 0 });
    expect(await pgFail(grantSlots(db, { projectId: P, delta: -1, reason: 'refund', actor: 'owner@x', reference: 're_1' }))).toMatch(/duplicate key/); // same reference twice
    expect((await summary(db, P)).entitlement).toBe(1);
  });
  it('submitted-round picks are locked and count first', async () => {
    const { db } = await seed(2);
    await db.insert(picks).values({ projectId: P, photoId: 'a', round: 1, byEmail: 's@x', state: 'confirmed', pickedAt: '2026-01-01T00:00:00Z' });
    await db.update(projects).set({ currentRound: 2 }).where(eq(projects.id, P));
    await expect(pick(db, 'a', 's@x', false)).rejects.toThrow(SelectionError);
    await pick(db, 'b'); await at(db, 'b', '2026-01-02T00:00:00Z');
    await pick(db, 'c');
    expect(await summary(db, P)).toMatchObject({ submitted: 1, confirmed: 1, pending: 1, round: 2 });
    expect((await currentPicks(db, P)).find((p) => p.photoId === 'a')?.locked).toBe(true);
  });
  it('a negative grant below the submitted count is a deficit; setIncluded refuses to go below submitted', async () => {
    const { db } = await seed(1);
    await db.insert(picks).values({ projectId: P, photoId: 'a', round: 1, byEmail: 's@x', state: 'confirmed' });
    await db.update(projects).set({ currentRound: 2 }).where(eq(projects.id, P));
    const s = await grantSlots(db, { projectId: P, delta: -1, reason: 'refund', actor: 'owner@x' });
    expect(s.deficit).toBe(1);
    await expect(setIncluded(db, { projectId: P, included: 0, actor: 'owner@x' })).rejects.toThrow(SelectionError);
    expect((await setIncluded(db, { projectId: P, included: 5, actor: 'owner@x' })).entitlement).toBe(4);
  });
  it('refuses picks on finals or foreign photos and when not culling', async () => {
    const { db } = await seed();
    await expect(pick(db, 'f')).rejects.toThrow(SelectionError);
    await expect(pick(db, 'zzz')).rejects.toThrow(SelectionError);
    await db.update(projects).set({ productionState: 'editing' }).where(eq(projects.id, P));
    await expect(pick(db, 'a')).rejects.toThrow(/not_culling/);
    expect((await db.select().from(events)).filter((e) => e.type === 'picked')).toHaveLength(0);
  });
  it('refuses a grant that would take entitlement below zero', async () => {
    const { db } = await seed(0);
    await expect(grantSlots(db, { projectId: P, delta: -1, reason: 'release', actor: 'owner@x' })).rejects.toMatchObject({ code: 'negative_entitlement' });
    expect((await grantSlots(db, { projectId: P, delta: 2, reason: 'gift', actor: 'owner@x' })).entitlement).toBe(2);
    await expect(grantSlots(db, { projectId: P, delta: -3, reason: 'refund', actor: 'owner@x' })).rejects.toMatchObject({ code: 'negative_entitlement' });
    expect((await summary(db, P)).entitlement).toBe(2); // nothing corrupted
  });
  it('a no-op unpick does not bump the version', async () => {
    const { db } = await seed();
    const before = await v(db);
    await pick(db, 'a', 's@x', false);
    expect(await v(db)).toBe(before);
    await pick(db, 'a'); expect(await v(db)).toBe(before + 1);
    await pick(db, 'a'); expect(await v(db)).toBe(before + 1); // duplicate pick is a no-op too
  });
});
