import { describe, it, expect } from 'vitest';
import { eq } from 'drizzle-orm';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpDir } from '../helpers.js';
import { openDb, migrate } from '../../src/server/db/client.js';
import { clients, projects, photos, picks, events } from '../../src/server/db/schema.js';
import { setPick, summary, grantSlots, setIncluded, currentPicks, Conflict, SelectionError } from '../../src/server/domain/selection.js';
import { defaultProjectJson } from '../../src/server/fs/schemas.js';

const P = '01993840-0000-7000-8000-0000000000aa';

async function seed(included = 2) {
  const root = await tmpDir(); await mkdir(join(root, 'Clients/A/W'), { recursive: true });
  const db = openDb(':memory:'); migrate(db);
  const meta = defaultProjectJson('W'); meta.id = P; meta.allowance = { included, extraPrice: 1500, slots: included };
  db.insert(clients).values({ id: 'c1', folderPath: 'Clients/A', name: 'A', emails: ['s@x', 't@x'] }).run();
  db.insert(projects).values({ id: P, clientId: 'c1', folderPath: 'Clients/A/W', productionState: 'culling', metadataJson: meta as Record<string, unknown> }).run();
  for (const n of ['a', 'b', 'c', 'd']) db.insert(photos).values({ id: n, projectId: P, relPath: `raw/${n}.dng`, stage: 'culling', kind: 'photo', checksum: n }).run();
  db.insert(photos).values({ id: 'f', projectId: P, relPath: 'finals/f.jpg', stage: 'final', kind: 'photo', checksum: 'f' }).run();
  return { db, root };
}
const v = (db: ReturnType<typeof openDb>) => db.select({ v: projects.selectionVersion }).from(projects).where(eq(projects.id, P)).get()!.v;
const pick = (db: ReturnType<typeof openDb>, photoId: string, by = 's@x', picked = true) => setPick(db, { projectId: P, photoId, picked, byEmail: by, expectedVersion: v(db) });

describe('selection', () => {
  it('two emails share one selection; a photo counts once', async () => {
    const { db } = await seed();
    pick(db, 'a', 's@x'); pick(db, 'a', 't@x');
    const s = summary(db, P);
    expect(s.confirmed).toBe(1); expect(s.pending).toBe(0); expect(s.entitlement).toBe(2);
    expect(currentPicks(db, P)).toHaveLength(1);
  });
  it('confirms in picked_at order and marks the overflow pending', async () => {
    const { db } = await seed(2);
    for (const [i, id] of ['a', 'b', 'c'].entries()) { pick(db, id); db.update(picks).set({ pickedAt: `2026-01-01T00:00:0${i}Z` }).where(eq(picks.photoId, id)).run(); }
    pick(db, 'd');
    const rows = Object.fromEntries(currentPicks(db, P).map((p) => [p.photoId, p.state]));
    expect(rows).toEqual({ a: 'confirmed', b: 'confirmed', c: 'pending', d: 'pending' });
    expect(summary(db, P)).toMatchObject({ confirmed: 2, pending: 2 });
  });
  it('unpicking a confirmed pick promotes the oldest pending one', async () => {
    const { db } = await seed(1);
    pick(db, 'a'); db.update(picks).set({ pickedAt: '2026-01-01T00:00:00Z' }).where(eq(picks.photoId, 'a')).run();
    pick(db, 'b');
    expect(currentPicks(db, P).find((p) => p.photoId === 'b')?.state).toBe('pending');
    pick(db, 'a', 't@x', false);
    expect(currentPicks(db, P)).toEqual([expect.objectContaining({ photoId: 'b', state: 'confirmed' })]);
  });
  it('rejects a stale version with the current one attached', async () => {
    const { db } = await seed();
    const stale = v(db);
    setPick(db, { projectId: P, photoId: 'a', picked: true, byEmail: 's@x', expectedVersion: stale });
    let err: unknown; try { setPick(db, { projectId: P, photoId: 'b', picked: true, byEmail: 't@x', expectedVersion: stale }); } catch (e) { err = e; }
    expect(err).toBeInstanceOf(Conflict); expect((err as Conflict).selectionVersion).toBe(stale + 1);
    expect(currentPicks(db, P)).toHaveLength(1);
  });
  it('grants promote pending picks; a negative grant demotes; a reference grants once', async () => {
    const { db, root } = await seed(1);
    pick(db, 'a'); db.update(picks).set({ pickedAt: '2026-01-01T00:00:00Z' }).where(eq(picks.photoId, 'a')).run();
    pick(db, 'b');
    let s = await grantSlots(db, root, { projectId: P, delta: 1, reason: 'gift', actor: 'owner@x' });
    expect(s).toMatchObject({ entitlement: 2, confirmed: 2, pending: 0, deficit: 0 });
    s = await grantSlots(db, root, { projectId: P, delta: -1, reason: 'refund', actor: 'owner@x', reference: 're_1' });
    expect(s).toMatchObject({ entitlement: 1, confirmed: 1, pending: 1, deficit: 0 });
    await expect(grantSlots(db, root, { projectId: P, delta: -1, reason: 'refund', actor: 'owner@x', reference: 're_1' })).rejects.toThrow(/UNIQUE/); // same reference twice
    expect(summary(db, P).entitlement).toBe(1);
  });
  it('submitted-round picks are locked and count first', async () => {
    const { db } = await seed(2);
    db.insert(picks).values({ projectId: P, photoId: 'a', round: 1, byEmail: 's@x', state: 'confirmed', pickedAt: '2026-01-01T00:00:00Z' }).run();
    db.update(projects).set({ currentRound: 2 }).where(eq(projects.id, P)).run();
    expect(() => pick(db, 'a', 's@x', false)).toThrow(SelectionError);
    pick(db, 'b'); db.update(picks).set({ pickedAt: '2026-01-02T00:00:00Z' }).where(eq(picks.photoId, 'b')).run();
    pick(db, 'c');
    expect(summary(db, P)).toMatchObject({ submitted: 1, confirmed: 1, pending: 1, round: 2 });
    expect(currentPicks(db, P).find((p) => p.photoId === 'a')?.locked).toBe(true);
  });
  it('a negative grant below the submitted count is a deficit; setIncluded refuses to go below submitted', async () => {
    const { db, root } = await seed(1);
    db.insert(picks).values({ projectId: P, photoId: 'a', round: 1, byEmail: 's@x', state: 'confirmed' }).run();
    db.update(projects).set({ currentRound: 2 }).where(eq(projects.id, P)).run();
    const s = await grantSlots(db, root, { projectId: P, delta: -1, reason: 'refund', actor: 'owner@x' });
    expect(s.deficit).toBe(1);
    await expect(setIncluded(db, root, { projectId: P, included: 0, actor: 'owner@x' })).rejects.toThrow(SelectionError);
    expect((await setIncluded(db, root, { projectId: P, included: 5, actor: 'owner@x' })).entitlement).toBe(4);
  });
  it('refuses picks on finals, missing, or foreign photos and when not culling', async () => {
    const { db } = await seed();
    expect(() => pick(db, 'f')).toThrow(SelectionError);
    expect(() => pick(db, 'zzz')).toThrow(SelectionError);
    db.update(projects).set({ productionState: 'editing' }).where(eq(projects.id, P)).run();
    expect(() => pick(db, 'a')).toThrow(/not_culling/);
    expect(db.select().from(events).all().filter((e) => e.type === 'picked')).toHaveLength(0);
  });

  it('refuses a grant that would take entitlement below zero', async () => {
    const { db, root } = await seed(0);
    await expect(grantSlots(db, root, { projectId: P, delta: -1, reason: 'release', actor: 'owner@x' })).rejects.toMatchObject({ code: 'negative_entitlement' });
    expect((await grantSlots(db, root, { projectId: P, delta: 2, reason: 'gift', actor: 'owner@x' })).entitlement).toBe(2);
    await expect(grantSlots(db, root, { projectId: P, delta: -3, reason: 'refund', actor: 'owner@x' })).rejects.toMatchObject({ code: 'negative_entitlement' });
    expect(summary(db, P).entitlement).toBe(2); // nothing corrupted
  });
  it('a no-op unpick does not bump the version', async () => {
    const { db } = await seed();
    const before = v(db);
    pick(db, 'a', 's@x', false);
    expect(v(db)).toBe(before);
    pick(db, 'a'); expect(v(db)).toBe(before + 1);
    pick(db, 'a'); expect(v(db)).toBe(before + 1); // duplicate pick is a no-op too
  });
  it('picks on photos that vanished are dropped from the open round and may be unpicked', async () => {
    const { db } = await seed(5);
    pick(db, 'a'); pick(db, 'b');
    db.update(photos).set({ missing: true }).where(eq(photos.id, 'a')).run();
    expect(() => pick(db, 'a')).toThrow(/unknown_photo/);          // cannot pick a missing photo
    pick(db, 'c');                                                 // any change recomputes
    expect(currentPicks(db, P).map((p) => p.photoId).sort()).toEqual(['b', 'c']);
    expect(db.select().from(events).all().some((e) => e.type === 'pick_dropped_missing')).toBe(true);
    pick(db, 'a', 's@x', false);                                   // unpicking a missing photo is harmless
  });
});
