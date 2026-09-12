import { and, eq, lte, or, isNull, lt } from 'drizzle-orm';
import type { Db } from '../db/client.js';
import { jobs } from '../db/schema.js';
import { newId } from '../fs/ids.js';

/** Throw from a handler when the outcome is uncertain and must not be retried blindly. */
export class NeedsReview extends Error { constructor(msg: string) { super(msg); this.name = 'NeedsReview'; } }
export type Handler = (payload: unknown, ctx: { db: Db; jobId: string }) => Promise<void>;
export type Handlers = Record<string, Handler>;
export type JobRow = typeof jobs.$inferSelect;
export const BACKOFF_MS = [60_000, 300_000, 1_800_000] as const;
export const MAX_ATTEMPTS = 3;

/** Commit locally first; the worker makes the outside call. A duplicate key returns the existing job. */
export function enqueue(db: Db, o: { kind: string; payload: unknown; idempotencyKey?: string; runAt?: number; now?: number }): { id: string; created: boolean } {
  const id = newId();
  if (o.idempotencyKey) {
    const existing = db.select({ id: jobs.id }).from(jobs).where(eq(jobs.idempotencyKey, o.idempotencyKey)).get();
    if (existing) return { id: existing.id, created: false };
  }
  db.insert(jobs).values({ id, kind: o.kind, payload: o.payload, idempotencyKey: o.idempotencyKey ?? null, nextAt: o.runAt ?? o.now ?? Date.now() }).run();
  return { id, created: true };
}

export function claimNext(db: Db, now: number, leaseMs = 60_000): JobRow | null {
  return db.transaction((tx) => {
    const row = tx.select().from(jobs)
      .where(and(eq(jobs.state, 'pending'), lte(jobs.nextAt, now), or(isNull(jobs.leasedUntil), lt(jobs.leasedUntil, now))))
      .orderBy(jobs.nextAt).limit(1).get();
    if (!row) return null;
    tx.update(jobs).set({ state: 'running', leasedUntil: now + leaseMs, attempts: row.attempts + 1 }).where(eq(jobs.id, row.id)).run();
    return { ...row, state: 'running' as const, attempts: row.attempts + 1 };
  });
}

export async function runOnce(db: Db, handlers: Handlers, now = Date.now()): Promise<'ran' | 'idle'> {
  const job = claimNext(db, now); if (!job) return 'idle';
  const handler = handlers[job.kind];
  try {
    if (!handler) throw new NeedsReview(`no handler for kind ${job.kind}`);
    await handler(job.payload, { db, jobId: job.id });
    db.update(jobs).set({ state: 'done', leasedUntil: null, lastError: null }).where(eq(jobs.id, job.id)).run();
  } catch (e) {
    const msg = e instanceof Error ? `${e.name}: ${e.message}` : String(e);
    if (e instanceof NeedsReview) db.update(jobs).set({ state: 'needs_review', leasedUntil: null, lastError: msg }).where(eq(jobs.id, job.id)).run();
    else if (job.attempts >= MAX_ATTEMPTS) db.update(jobs).set({ state: 'failed', leasedUntil: null, lastError: msg }).where(eq(jobs.id, job.id)).run();
    else db.update(jobs).set({ state: 'pending', leasedUntil: null, lastError: msg, nextAt: now + BACKOFF_MS[job.attempts - 1]! }).where(eq(jobs.id, job.id)).run();
  }
  return 'ran';
}

/** After a crash, jobs left 'running' past their lease go back to pending. */
export function recoverLeases(db: Db, now: number): number {
  return db.update(jobs).set({ state: 'pending', leasedUntil: null }).where(and(eq(jobs.state, 'running'), lt(jobs.leasedUntil, now))).run().changes;
}

/** Only terminal, reviewable states can be retried; a done job would repeat its side effect and a running one would double-execute. */
export function retryJob(db: Db, id: string): void {
  const j = db.select({ state: jobs.state }).from(jobs).where(eq(jobs.id, id)).get();
  if (!j) throw new Error('unknown job');
  if (j.state !== 'failed' && j.state !== 'needs_review') throw new Error(`job is ${j.state}, not retryable`);
  db.update(jobs).set({ state: 'pending', attempts: 0, nextAt: Date.now(), leasedUntil: null, lastError: null }).where(eq(jobs.id, id)).run();
}
