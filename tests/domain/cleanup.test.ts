import { describe, it, expect } from 'vitest';
import { eq } from 'drizzle-orm';
import { photos, picks, projects, events } from '../../src/server/db/schema.js';
import type { Db } from '../../src/server/db/client.js';
import { withStudio } from '../../src/server/db/tenancy.js';
import { setPick } from '../../src/server/domain/selection.js';
import { finishRound } from '../../src/server/domain/transitions.js';
import { sweepCullingPreviews } from '../../src/server/domain/cleanup.js';
import { photoKey, type PhotoVariant } from '../../src/server/storage.js';
import { boot } from '../http/boot.js';

const DAY = 864e5;
const VARIANTS: PhotoVariant[] = ['original', 'preview', 'medium', 'thumb'];

/** One Studio, one project with two culling RAWs (one picked), a final, and a Library photo; the round is finished when `finish` is set. */
let n = 0; // sign-in requests are rate limited per email, in process
async function setup(finish = true) {
  const b = await boot(); const tag = ++n;
  const { cookie, studioId } = await b.signupOwner(`o${tag}@x.com`, 'S');
  const { projectId } = await b.seedProject(cookie, { included: 40, emails: [`cl${tag}@x.com`] });
  const [a, c] = await b.addCulling(studioId, projectId, ['a', 'c']);
  const extra = (id: string, o: { projectId: string | null; stage: 'final' | 'culling' }) => withStudio(b.db, studioId, async (tx) => {
    await tx.insert(photos).values({ id, projectId: o.projectId, inLibrary: o.projectId === null, relPath: `x/${id}.jpg`, stage: o.stage, kind: 'photo', checksum: id });
  }).then(() => Promise.all(VARIANTS.map((v) => b.storage.put(photoKey(studioId, id, v), new Uint8Array([1]), 'image/jpeg'))));
  await extra('fin', { projectId, stage: 'final' }); await extra('lib', { projectId: null, stage: 'final' });
  const version = async (tx: Db) => (await tx.select().from(projects).where(eq(projects.id, projectId)))[0]!.selectionVersion;
  await withStudio(b.db, studioId, async (tx) => { await setPick(tx, { projectId, photoId: a!, picked: true, byEmail: 'c@x', expectedVersion: await version(tx) }); await tx.update(picks).set({ pickedAt: '2026-01-01T00:00:00Z' }); });
  if (finish) await withStudio(b.db, studioId, async (tx) => finishRound(tx, { projectId, actor: 'o@x.com', expectedVersion: await version(tx), baseUrl: BASE }));
  const keys = (id: string) => VARIANTS.map((v) => photoKey(studioId, id, v));
  const present = (id: string) => b.storage.keys().filter((k) => keys(id).includes(k)).length;
  const purged = (id: string) => withStudio(b.db, studioId, async (tx) => (await tx.select().from(photos).where(eq(photos.id, id)))[0]!.purgedAt);
  return { ...b, tag, studioId, projectId, a: a!, c: c!, present, purged, cookie, at: (days: number) => new Date(Date.now() + days * DAY) };
}
const BASE = 'http://localhost:3000';

describe('sweepCullingPreviews', () => {
  it('29 days after finishing nothing is purged', async () => {
    const t = await setup();
    expect(await sweepCullingPreviews(t.db, t.storage, t.at(29))).toEqual({ purged: 0 });
    expect(t.present(t.a)).toBe(VARIANTS.length); expect(await t.purged(t.a)).toBeNull();
  });
  it('30 days after finishing culling objects are deleted and rows kept with their picks', async () => {
    const t = await setup();
    expect(await sweepCullingPreviews(t.db, t.storage, t.at(30.01))).toEqual({ purged: 2 });
    for (const id of [t.a, t.c]) { expect(t.present(id)).toBe(0); expect(await t.purged(id)).not.toBeNull(); }
    const kept = await withStudio(t.db, t.studioId, async (tx) => ({ rows: await tx.select().from(photos).where(eq(photos.stage, 'culling')), picks: await tx.select().from(picks) }));
    expect(kept.rows).toHaveLength(2); expect(kept.picks.map((p) => p.photoId)).toEqual([t.a]);
    // Admins still list the purged rows (flagged); a Client does not see them.
    const list = await t.json<{ id: string; purged: boolean }[]>(await t.api(`/api/projects/${t.projectId}/photos?stage=culling`, { cookie: t.cookie }));
    expect(list.map((p) => [p.id, p.purged]).sort()).toEqual([[t.a, true], [t.c, true]].sort());
    const client = await t.signIn(`cl${t.tag}@x.com`);
    expect(await t.json(await t.api(`/api/projects/${t.projectId}/photos?stage=culling`, { cookie: client }))).toEqual([]);
  });
  it('a reopened round is not purged', async () => {
    const t = await setup();
    await withStudio(t.db, t.studioId, async (tx) => { await tx.update(projects).set({ productionState: 'culling' }).where(eq(projects.id, t.projectId)); });
    expect(await sweepCullingPreviews(t.db, t.storage, t.at(40))).toEqual({ purged: 0 });
    expect(t.present(t.a)).toBe(VARIANTS.length);
  });
  it('a project whose round never finished is not purged', async () => {
    const t = await setup(false);
    expect(await sweepCullingPreviews(t.db, t.storage, t.at(400))).toEqual({ purged: 0 });
  });
  it('finals and Library photos are never touched', async () => {
    const t = await setup();
    await sweepCullingPreviews(t.db, t.storage, t.at(31));
    for (const id of ['fin', 'lib']) { expect(t.present(id)).toBe(VARIANTS.length); expect(await t.purged(id)).toBeNull(); }
  });
  it('a second run purges nothing', async () => {
    const t = await setup();
    await sweepCullingPreviews(t.db, t.storage, t.at(31));
    expect(await sweepCullingPreviews(t.db, t.storage, t.at(32))).toEqual({ purged: 0 });
  });
  it('a failed storage delete leaves purgedAt unset so the next run retries', async () => {
    const t = await setup();
    const del = t.storage.delete; t.storage.delete = async () => { throw new Error('r2 down'); };
    await expect(sweepCullingPreviews(t.db, t.storage, t.at(31))).rejects.toThrow('r2 down');
    expect(await t.purged(t.a)).toBeNull();
    t.storage.delete = del;
    expect(await sweepCullingPreviews(t.db, t.storage, t.at(31))).toEqual({ purged: 2 });
  });
  it('uses the latest finished_culling event', async () => {
    const t = await setup();
    await withStudio(t.db, t.studioId, async (tx) => { await tx.insert(events).values({ projectId: t.projectId, actor: 'x', type: 'finished_culling', payload: {}, at: t.at(20).toISOString() }); });
    expect(await sweepCullingPreviews(t.db, t.storage, t.at(31))).toEqual({ purged: 0 });
    expect(await sweepCullingPreviews(t.db, t.storage, t.at(51))).toEqual({ purged: 2 });
  });
});
