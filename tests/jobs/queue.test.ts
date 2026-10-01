import { describe, it, expect } from 'vitest';
import { eq, sql } from 'drizzle-orm';
import { jobs, clients } from '../../src/server/db/schema.js';
import { withStudio, asSystem } from '../../src/server/db/tenancy.js';
import type { Db } from '../../src/server/db/client.js';
import { enqueue, runOnce, recoverLeases, claimNext, retryJob, NeedsReview, BACKOFF_MS } from '../../src/server/jobs/queue.js';
import { testDb, makeStudio } from '../helpers.js';

const T0 = 1_700_000_000_000;
async function fresh() { const db = await testDb(); const { studioId } = await makeStudio(db); return { db, studioId, as: <T>(f: (tx: Db) => Promise<T>) => withStudio(db, studioId, f) }; }
const allJobs = (db: Db) => asSystem(db, (tx) => tx.select().from(jobs));
const oneJob = async (db: Db) => (await allJobs(db))[0]!;

describe('jobs', () => {
  it('deduplicates by idempotency key', async () => {
    const { as } = await fresh();
    const a = await as((tx) => enqueue(tx, { kind: 'x', payload: {}, idempotencyKey: 'k1', now: T0 }));
    const b = await as((tx) => enqueue(tx, { kind: 'x', payload: {}, idempotencyKey: 'k1', now: T0 }));
    expect(a.created).toBe(true); expect(b.created).toBe(false); expect(b.id).toBe(a.id);
  });
  it('runs a job and marks it done', async () => {
    const { db, as } = await fresh(); const seen: unknown[] = [];
    await as((tx) => enqueue(tx, { kind: 'echo', payload: { v: 1 }, now: T0 }));
    expect(await runOnce(db, { echo: async (p) => { seen.push(p); } }, T0)).toBe('ran');
    expect(seen).toEqual([{ v: 1 }]);
    expect((await oneJob(db)).state).toBe('done');
    expect(await runOnce(db, {}, T0)).toBe('idle');
  });
  it('retries with backoff then fails', async () => {
    const { db, as } = await fresh(); await as((tx) => enqueue(tx, { kind: 'boom', payload: {}, now: T0 }));
    const h = { boom: async () => { throw new Error('nope'); } };
    await runOnce(db, h, T0);
    let row = await oneJob(db);
    expect(row.state).toBe('pending'); expect(row.attempts).toBe(1); expect(row.nextAt).toBe(T0 + BACKOFF_MS[0]!); expect(row.lastError).toMatch(/nope/);
    expect(await runOnce(db, h, T0 + 1)).toBe('idle');           // not due yet
    await runOnce(db, h, row.nextAt);
    row = await oneJob(db); expect(row.attempts).toBe(2); expect(row.nextAt).toBe(T0 + BACKOFF_MS[0]! + BACKOFF_MS[1]!);
    await runOnce(db, h, row.nextAt);
    row = await oneJob(db);
    expect(row.state).toBe('failed'); expect(row.attempts).toBe(3);
    await as((tx) => retryJob(tx, row.id));
    expect((await oneJob(db)).state).toBe('pending');
    await expect(as((tx) => retryJob(tx, row.id))).rejects.toThrow(/not retryable/); // pending now
    await runOnce(db, { boom: async () => {} }, Date.now() + 1); // retry schedules at the real clock
    expect((await oneJob(db)).state).toBe('done');
    await expect(as((tx) => retryJob(tx, row.id))).rejects.toThrow(/done/);
    await expect(as((tx) => retryJob(tx, 'nope'))).rejects.toThrow(/unknown/);
  });
  it('parks a job in needs_review without retrying', async () => {
    const { db, as } = await fresh(); await as((tx) => enqueue(tx, { kind: 'r', payload: {}, now: T0 }));
    await runOnce(db, { r: async () => { throw new NeedsReview('provider ambiguous'); } }, T0);
    const row = await oneJob(db);
    expect(row.state).toBe('needs_review'); expect(row.lastError).toMatch(/ambiguous/);
    expect(await runOnce(db, { r: async () => {} }, T0 + 1e9)).toBe('idle');
  });
  it('parks a job with no handler in needs_review', async () => {
    const { db, as } = await fresh(); await as((tx) => enqueue(tx, { kind: 'unknown_kind', payload: {}, now: T0 }));
    await runOnce(db, {}, T0);
    expect((await oneJob(db)).state).toBe('needs_review');
  });
  it('recovers expired leases after a crash', async () => {
    const { db, as } = await fresh(); const { id } = await as((tx) => enqueue(tx, { kind: 'x', payload: {}, now: T0 }));
    expect((await claimNext(db, T0, 1000))?.id).toBe(id);
    expect(await claimNext(db, T0 + 500)).toBeNull();
    expect(await recoverLeases(db, T0 + 500)).toBe(0);
    expect(await recoverLeases(db, T0 + 2000)).toBe(1);
    expect((await asSystem(db, (tx) => tx.select().from(jobs).where(eq(jobs.id, id))))[0]?.state).toBe('pending');
  });
  it('runs a future job only when due', async () => {
    const { db, as } = await fresh(); await as((tx) => enqueue(tx, { kind: 'x', payload: {}, runAt: T0 + 5000 }));
    expect(await runOnce(db, { x: async () => {} }, T0)).toBe('idle');
    expect(await runOnce(db, { x: async () => {} }, T0 + 5000)).toBe('ran');
  });
  it('claims different jobs on consecutive calls', async () => {
    const { db, as } = await fresh();
    await as((tx) => enqueue(tx, { kind: 'x', payload: {}, now: T0 })); await as((tx) => enqueue(tx, { kind: 'x', payload: {}, now: T0 }));
    const a = await claimNext(db, T0); const b = await claimNext(db, T0);
    expect(a && b && a.id !== b.id).toBe(true);
    expect(await claimNext(db, T0)).toBeNull();
  });
});

describe('jobs across Studios', () => {
  it('a system enqueue with studioId belongs to that Studio only', async () => {
    const db = await testDb(); const a = await makeStudio(db); const b = await makeStudio(db);
    await asSystem(db, (tx) => enqueue(tx, { kind: 'x', payload: {}, studioId: a.studioId, now: T0 }));
    expect(await withStudio(db, a.studioId, (tx) => tx.select().from(jobs))).toHaveLength(1);
    expect(await withStudio(db, b.studioId, (tx) => tx.select().from(jobs))).toHaveLength(0);
  });
  it('the same idempotency key in two Studios creates two jobs', async () => {
    const db = await testDb(); const a = await makeStudio(db); const b = await makeStudio(db);
    const r1 = await asSystem(db, (tx) => enqueue(tx, { kind: 'x', payload: {}, idempotencyKey: 'k', studioId: a.studioId }));
    const r2 = await asSystem(db, (tx) => enqueue(tx, { kind: 'x', payload: {}, idempotencyKey: 'k', studioId: b.studioId }));
    expect([r1.created, r2.created]).toEqual([true, true]);
  });
  it('a handler runs inside its job\'s Studio', async () => {
    const db = await testDb(); const a = await makeStudio(db); const b = await makeStudio(db);
    await withStudio(db, a.studioId, (tx) => tx.insert(clients).values({ id: 'ca', name: 'A', emails: [] }));
    await withStudio(db, b.studioId, (tx) => tx.insert(clients).values({ id: 'cb', name: 'B', emails: [] }));
    await withStudio(db, a.studioId, (tx) => enqueue(tx, { kind: 'look', payload: {}, now: T0 }));
    let seen: { studioId: string; names: string[] } | undefined;
    await runOnce(db, { look: async (_p, ctx) => { seen = { studioId: ctx.studioId, names: (await ctx.db.select().from(clients)).map((c) => c.name) }; } }, T0);
    expect(seen).toEqual({ studioId: a.studioId, names: ['A'] });
  });
  it('a system handler runs outside any transaction and its job ends done', async () => {
    const { db, studioId, as } = await fresh(); const { id } = await as((tx) => enqueue(tx, { kind: 'sys', payload: { v: 1 }, now: T0 }));
    let seen: unknown;
    await runOnce(db, { sys: { system: true, run: async (p, ctx) => {
      const row = async <T,>(q: ReturnType<typeof sql>) => { const r = await ctx.root.execute<T>(q); return ('rows' in r ? r.rows : r)[0] as T; };
      // inside a transaction now() is frozen at its start; outside, each statement gets its own now()
      const a = await row<{ role: string; t: string }>(sql`select current_user as role, now()::text as t`);
      await ctx.root.execute(sql`select pg_sleep(0.01)`);
      const b = await row<{ t: string }>(sql`select now()::text as t`);
      seen = { p, root: ctx.root === db, jobId: ctx.jobId, studioId: ctx.studioId, role: a.role, fresh: a.t !== b.t };
    } } }, T0);
    expect(seen).toEqual({ p: { v: 1 }, root: true, jobId: id, studioId, role: 'postgres', fresh: true }); // no og_* role, no open transaction
    expect((await oneJob(db)).state).toBe('done');
  });
  it('a failing system handler backs off like any other', async () => {
    const { db, as } = await fresh(); await as((tx) => enqueue(tx, { kind: 'sys', payload: {}, now: T0 }));
    await runOnce(db, { sys: { system: true, run: async () => { throw new Error('smtp down'); } } }, T0);
    expect(await oneJob(db)).toMatchObject({ state: 'pending', attempts: 1, nextAt: T0 + BACKOFF_MS[0]!, lastError: 'Error: smtp down' });
  });
  it('a failed handler\'s writes roll back', async () => {
    const { db, as } = await fresh(); await as((tx) => enqueue(tx, { kind: 'w', payload: {}, now: T0 }));
    await runOnce(db, { w: async (_p, ctx) => { await ctx.db.insert(clients).values({ id: 'c', name: 'n', emails: [] }); throw new Error('after write'); } }, T0);
    expect(await as((tx) => tx.select().from(clients))).toEqual([]);
  });
});
