import { describe, it, expect } from 'vitest';
import { eq } from 'drizzle-orm';
import { openDb, migrate } from '../../src/server/db/client.js';
import { jobs } from '../../src/server/db/schema.js';
import { enqueue, runOnce, recoverLeases, claimNext, retryJob, NeedsReview, BACKOFF_MS } from '../../src/server/jobs/queue.js';

function fresh() { const db = openDb(':memory:'); migrate(db); return db; }
const T0 = 1_700_000_000_000;

describe('jobs', () => {
  it('deduplicates by idempotency key', () => {
    const db = fresh();
    const a = enqueue(db, { kind: 'x', payload: {}, idempotencyKey: 'k1', now: T0 });
    const b = enqueue(db, { kind: 'x', payload: {}, idempotencyKey: 'k1', now: T0 });
    expect(a.created).toBe(true); expect(b.created).toBe(false); expect(b.id).toBe(a.id);
  });
  it('runs a job and marks it done', async () => {
    const db = fresh(); const seen: unknown[] = [];
    enqueue(db, { kind: 'echo', payload: { v: 1 }, now: T0 });
    expect(await runOnce(db, { echo: async (p) => { seen.push(p); } }, T0)).toBe('ran');
    expect(seen).toEqual([{ v: 1 }]);
    expect(db.select().from(jobs).get()?.state).toBe('done');
    expect(await runOnce(db, {}, T0)).toBe('idle');
  });
  it('retries with backoff then fails', async () => {
    const db = fresh(); enqueue(db, { kind: 'boom', payload: {}, now: T0 });
    const h = { boom: async () => { throw new Error('nope'); } };
    await runOnce(db, h, T0);
    let row = db.select().from(jobs).get()!;
    expect(row.state).toBe('pending'); expect(row.attempts).toBe(1); expect(row.nextAt).toBe(T0 + BACKOFF_MS[0]!); expect(row.lastError).toMatch(/nope/);
    expect(await runOnce(db, h, T0 + 1)).toBe('idle');           // not due yet
    await runOnce(db, h, row.nextAt);
    row = db.select().from(jobs).get()!; expect(row.attempts).toBe(2); expect(row.nextAt).toBe(T0 + BACKOFF_MS[0]! + BACKOFF_MS[1]!);
    await runOnce(db, h, row.nextAt);
    row = db.select().from(jobs).get()!;
    expect(row.state).toBe('failed'); expect(row.attempts).toBe(3);
    retryJob(db, row.id);
    expect(db.select().from(jobs).get()?.state).toBe('pending');
  });
  it('parks a job in needs_review without retrying', async () => {
    const db = fresh(); enqueue(db, { kind: 'r', payload: {}, now: T0 });
    await runOnce(db, { r: async () => { throw new NeedsReview('provider ambiguous'); } }, T0);
    const row = db.select().from(jobs).get()!;
    expect(row.state).toBe('needs_review'); expect(row.lastError).toMatch(/ambiguous/);
    expect(await runOnce(db, { r: async () => {} }, T0 + 1e9)).toBe('idle');
  });
  it('parks a job with no handler in needs_review', async () => {
    const db = fresh(); enqueue(db, { kind: 'unknown_kind', payload: {}, now: T0 });
    await runOnce(db, {}, T0);
    expect(db.select().from(jobs).get()?.state).toBe('needs_review');
  });
  it('recovers expired leases after a crash', () => {
    const db = fresh(); const { id } = enqueue(db, { kind: 'x', payload: {}, now: T0 });
    expect(claimNext(db, T0, 1000)?.id).toBe(id);
    expect(claimNext(db, T0 + 500)).toBeNull();
    expect(recoverLeases(db, T0 + 500)).toBe(0);
    expect(recoverLeases(db, T0 + 2000)).toBe(1);
    expect(db.select().from(jobs).where(eq(jobs.id, id)).get()?.state).toBe('pending');
  });
  it('runs a future job only when due', async () => {
    const db = fresh(); enqueue(db, { kind: 'x', payload: {}, runAt: T0 + 5000 });
    expect(await runOnce(db, { x: async () => {} }, T0)).toBe('idle');
    expect(await runOnce(db, { x: async () => {} }, T0 + 5000)).toBe('ran');
  });
});
