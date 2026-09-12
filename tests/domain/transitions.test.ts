import { describe, it, expect } from 'vitest';
import { eq } from 'drizzle-orm';
import { mkdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpDir } from '../helpers.js';
import { makeTiffAs } from '../fixtures/make.js';
import { openDb, migrate } from '../../src/server/db/client.js';
import { projects, picks, events, jobs, users, invoices } from '../../src/server/db/schema.js';
import { rescan } from '../../src/server/fs/index.js';
import { indexProjectMedia } from '../../src/server/fs/photos.js';
import { writeJsonAtomic, readJson } from '../../src/server/fs/json.js';
import { defaultClientJson, defaultProjectJson, ProjectJson } from '../../src/server/fs/schemas.js';
import { setPick } from '../../src/server/domain/selection.js';
import { finishRound, cancelRound, requestExtras, adminRecipients } from '../../src/server/domain/transitions.js';

async function seed(included = 3) {
  const root = await tmpDir(); const db = openDb(':memory:'); migrate(db);
  const p = defaultProjectJson('W'); p.allowance = { included, extraPrice: 1500, slots: included }; p.assignedTo = 'sam@x';
  await mkdir(join(root, 'Clients/A/W/raw'), { recursive: true });
  await writeJsonAtomic(join(root, 'Clients/A/client.json'), { ...defaultClientJson('A'), emails: ['s@x.com'] });
  await writeJsonAtomic(join(root, 'Clients/A/W/project.json'), p);
  db.insert(users).values([{ id: 'u1', email: 'owner@x', role: 'owner' }, { id: 'u2', email: 'sam@x', role: 'member' }]).run();
  await rescan(db, root);
  return { db, root, pid: p.id!, dir: join(root, 'Clients/A/W') };
}
const prod = (db: ReturnType<typeof openDb>, id: string) => db.select().from(projects).where(eq(projects.id, id)).get()!;
const pick = (db: ReturnType<typeof openDb>, pid: string, photoId: string, picked = true) => setPick(db, { projectId: pid, photoId, picked, byEmail: 's@x', expectedVersion: prod(db, pid).selectionVersion });
const cullingIds = (db: ReturnType<typeof openDb>) => db.$client.prepare("select id from photos where stage='culling' order by rel_path").all().map((r) => (r as { id: string }).id);

describe('transitions', () => {
  it('the first usable RAW moves not_started → culling, bumps stateVersion, projects to disk; later files never regress', async () => {
    const { db, root, pid, dir } = await seed();
    expect(prod(db, pid).productionState).toBe('not_started');
    await makeTiffAs(join(dir, 'raw/a.dng'));
    await indexProjectMedia(db, root, pid);
    const row = prod(db, pid);
    expect(row.productionState).toBe('culling'); expect(row.stateVersion).toBe(2);
    const file = await readJson(join(dir, 'project.json'), ProjectJson);
    expect(file.ok && file.data.state.production).toBe('culling');
    db.update(projects).set({ productionState: 'editing' }).where(eq(projects.id, pid)).run();
    await makeTiffAs(join(dir, 'raw/b.dng')); await indexProjectMedia(db, root, pid);
    expect(prod(db, pid).productionState).toBe('editing');
  });
  it('finish under allowance freezes the round, locks picks, opens round 2, moves to editing, emails the assignee', async () => {
    const { db, root, pid, dir } = await seed(40);
    for (const n of ['a', 'b']) await makeTiffAs(join(dir, `raw/${n}.dng`));
    await indexProjectMedia(db, root, pid);
    const [a, b] = cullingIds(db) as [string, string];
    pick(db, pid, a); db.update(picks).set({ pickedAt: '2026-01-01T00:00:00Z' }).where(eq(picks.photoId, a)).run(); pick(db, pid, b);
    const r = await finishRound(db, root, { projectId: pid, actor: 's@x', expectedVersion: prod(db, pid).selectionVersion, baseUrl: 'https://g' });
    expect(r).toEqual({ round: 1, photoIds: [a, b] });
    const row = prod(db, pid);
    expect(row.productionState).toBe('editing'); expect(row.currentRound).toBe(2);
    const ev = db.select().from(events).all().find((e) => e.type === 'finished_culling')!;
    expect(ev.payload).toEqual({ round: 1, photoIds: [a, b] });
    const job = db.select().from(jobs).all().find((j) => j.kind === 'send_email')!;
    expect(job.payload).toMatchObject({ to: 'sam@x', template: 'culling_finished', vars: { count: '2' } });
    expect(() => pick(db, pid, a, false)).toThrow(/not_culling/);
    const file = await readJson(join(dir, 'project.json'), ProjectJson);
    expect(file.ok && file.data.state.production).toBe('editing');
  });
  it('refuses to finish with zero picks, pending picks, an unpaid extras invoice, a review item, or when not culling', async () => {
    const { db, root, pid, dir } = await seed(1);
    for (const n of ['a', 'b']) await makeTiffAs(join(dir, `raw/${n}.dng`));
    await indexProjectMedia(db, root, pid);
    const [a, b] = cullingIds(db) as [string, string];
    const fin = () => finishRound(db, root, { projectId: pid, actor: 's@x', expectedVersion: prod(db, pid).selectionVersion, baseUrl: 'https://g' });
    await expect(fin()).rejects.toMatchObject({ code: 'no_picks' });
    pick(db, pid, a); db.update(picks).set({ pickedAt: '2026-01-01T00:00:00Z' }).where(eq(picks.photoId, a)).run(); pick(db, pid, b);
    await expect(fin()).rejects.toMatchObject({ code: 'pending_picks' });
    pick(db, pid, b, false);
    db.insert(invoices).values({ id: 'i1', projectId: pid, kind: 'extras', amount: 1500, currency: 'usd' }).run();
    await expect(fin()).rejects.toMatchObject({ code: 'unpaid_extras' });
    db.update(invoices).set({ voidedAt: 'now' }).where(eq(invoices.id, 'i1')).run();
    db.insert(invoices).values({ id: 'i2', projectId: pid, kind: 'adjustment', amount: 0, currency: 'usd', needsReview: true }).run();
    await expect(fin()).rejects.toMatchObject({ code: 'needs_review' });
    db.update(invoices).set({ needsReview: false }).where(eq(invoices.id, 'i2')).run();
    await expect(finishRound(db, root, { projectId: pid, actor: 's@x', expectedVersion: 0, baseUrl: 'https://g' })).rejects.toThrow(/conflict/);
    await expect(fin()).resolves.toMatchObject({ round: 1 });
    await expect(fin()).rejects.toMatchObject({ code: 'not_culling' });
    expect(prod(db, pid).stateVersion).toBe(3); // culling (2) → editing (3)
  });
  it('cancel round clears current picks and records an event; extras request emails admins once per count', async () => {
    const { db, root, pid, dir } = await seed(1);
    await makeTiffAs(join(dir, 'raw/a.dng')); await indexProjectMedia(db, root, pid);
    const [a] = cullingIds(db) as [string];
    pick(db, pid, a);
    await cancelRound(db, root, { projectId: pid, actor: 'owner@x' });
    expect(db.select().from(picks).all()).toHaveLength(0);
    expect(db.select().from(events).all().some((e) => e.type === 'round_cancelled')).toBe(true);
    requestExtras(db, { projectId: pid, count: 3, byEmail: 's@x', baseUrl: 'https://g' });
    requestExtras(db, { projectId: pid, count: 3, byEmail: 's@x', baseUrl: 'https://g' });
    const mails = db.select().from(jobs).all().filter((j) => j.kind === 'send_email');
    expect(mails).toHaveLength(1);
    expect(db.select().from(events).all().filter((e) => e.type === 'extras_requested')).toHaveLength(1); // event log is idempotent too
    requestExtras(db, { projectId: pid, count: 4, byEmail: 's@x', baseUrl: 'https://g' });
    expect(db.select().from(events).all().filter((e) => e.type === 'extras_requested')).toHaveLength(2); // a different count is a new request expect(mails[0]!.payload).toMatchObject({ to: 'sam@x', template: 'extras_requested', vars: { count: '3' } });
    expect(adminRecipients(db, pid)).toEqual(['sam@x']);
    db.delete(users).where(eq(users.email, 'sam@x')).run();
    expect(adminRecipients(db, pid)).toEqual(['owner@x']);
  });

  it('finish never freezes a photo that vanished before submission', async () => {
    const { db, root, pid, dir } = await seed(5);
    for (const n of ['a', 'b']) await makeTiffAs(join(dir, `raw/${n}.dng`));
    await indexProjectMedia(db, root, pid);
    const [a, b] = cullingIds(db) as [string, string];
    pick(db, pid, a); pick(db, pid, b);
    await rm(join(dir, 'raw/a.dng')); await indexProjectMedia(db, root, pid);
    const r = await finishRound(db, root, { projectId: pid, actor: 's@x', expectedVersion: prod(db, pid).selectionVersion, baseUrl: 'https://g' });
    expect(r.photoIds).toEqual([b]);
  });
});
