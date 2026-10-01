import { and, eq, lte, or, isNull, lt, gte, inArray } from 'drizzle-orm';
import type { Db } from '../db/client.js';
import { jobs } from '../db/schema.js';
import { asSystem, withStudio } from '../db/tenancy.js';
import { newId } from '../ids.js';

/** Throw from a handler when the outcome is uncertain and must not be retried blindly. */
export class NeedsReview extends Error { constructor(msg: string) { super(msg); this.name = 'NeedsReview'; } }
/** Runs inside one transaction bound to the job's Studio; its writes roll back if it throws. */
export type Handler = (payload: unknown, ctx: { db: Db; jobId: string; studioId: string }) => Promise<void>;
/** Runs on the pool outside any transaction, for work that opens its own (Better Auth's root-only tables); the job is marked done afterwards. */
export type SystemHandler = { system: true; run: (payload: unknown, ctx: { root: Db; jobId: string; studioId: string }) => Promise<void> };
export type Handlers = Record<string, Handler | SystemHandler>;
export type JobRow = typeof jobs.$inferSelect;
export const BACKOFF_MS = [60_000, 300_000, 1_800_000] as const;
export const MAX_ATTEMPTS = 3;
/** Jobs that need the processing machine's CPU and memory (image work, zips). Everything else is light and runs on the app machine. */
export const HEAVY_KINDS = ['process_upload', 'preview', 'build_zip'] as const;

/**
 * Commit locally first; the worker makes the outside call. A duplicate key (per Studio) returns the existing job.
 * `db` is a Studio transaction, or a system transaction with `studioId` set.
 */
export async function enqueue(db: Db, o: { kind: string; payload: unknown; idempotencyKey?: string; runAt?: number; now?: number; studioId?: string }): Promise<{ id: string; created: boolean }> {
  const id = newId();
  const [row] = await db.insert(jobs).values({ id, ...(o.studioId ? { studioId: o.studioId } : {}), kind: o.kind, payload: o.payload, idempotencyKey: o.idempotencyKey ?? null, nextAt: o.runAt ?? o.now ?? Date.now() })
    .onConflictDoNothing().returning({ id: jobs.id });
  if (row) return { id, created: true };
  const [existing] = await db.select({ id: jobs.id }).from(jobs)
    .where(and(eq(jobs.idempotencyKey, o.idempotencyKey!), o.studioId ? eq(jobs.studioId, o.studioId) : undefined)).limit(1);
  return { id: existing!.id, created: false };
}

/** Leases the next due job of any Studio (of the given `kinds`, when set). Concurrent workers skip each other's rows. */
export function claimNext(root: Db, now: number, kinds?: readonly string[], leaseMs = 60_000): Promise<JobRow | null> {
  return asSystem(root, async (tx) => {
    const [row] = await tx.select().from(jobs)
      .where(and(eq(jobs.state, 'pending'), lte(jobs.nextAt, now), or(isNull(jobs.leasedUntil), lt(jobs.leasedUntil, now)), kinds ? inArray(jobs.kind, [...kinds]) : undefined))
      .orderBy(jobs.nextAt).limit(1).for('update', { skipLocked: true });
    if (!row) return null;
    await tx.update(jobs).set({ state: 'running', leasedUntil: now + leaseMs, attempts: row.attempts + 1 }).where(eq(jobs.id, row.id));
    return { ...row, state: 'running' as const, attempts: row.attempts + 1 };
  });
}

// ponytail: the handler's transaction stays open across its external call (email, render); split into short transactions if job volume grows.
// A machine must only claim kinds it has handlers for: a missing handler parks the job in needs_review, which would strand work meant for the other machine.
export async function runOnce(root: Db, handlers: Handlers, now = Date.now(), kinds?: readonly string[]): Promise<'ran' | 'idle'> {
  const job = await claimNext(root, now, kinds); if (!job) return 'idle';
  const handler = handlers[job.kind];
  try {
    if (!handler) throw new NeedsReview(`no handler for kind ${job.kind}`);
    const done = (tx: Db) => tx.update(jobs).set({ state: 'done', leasedUntil: null, lastError: null }).where(eq(jobs.id, job.id));
    if (typeof handler === 'function') await withStudio(root, job.studioId, async (tx) => { await handler(job.payload, { db: tx, jobId: job.id, studioId: job.studioId }); await done(tx); });
    else { await handler.run(job.payload, { root, jobId: job.id, studioId: job.studioId }); await asSystem(root, done); }
  } catch (e) {
    const msg = e instanceof Error ? `${e.name}: ${e.message}` : String(e);
    console.error(`[jobs] ${job.kind} ${job.id} failed (attempt ${job.attempts}): ${msg}`);
    const set = e instanceof NeedsReview ? { state: 'needs_review' as const, leasedUntil: null, lastError: msg }
      : job.attempts >= MAX_ATTEMPTS ? { state: 'failed' as const, leasedUntil: null, lastError: msg }
      : { state: 'pending' as const, leasedUntil: null, lastError: msg, nextAt: now + BACKOFF_MS[job.attempts - 1]! };
    await asSystem(root, (tx) => tx.update(jobs).set(set).where(eq(jobs.id, job.id)));
  }
  return 'ran';
}

/**
 * After a crash, jobs left 'running' past their lease go back to pending, unless they have used all their attempts:
 * a job that keeps killing its worker (an OOM on one photo) is failed instead of looping forever.
 * Pass `kinds` so a machine recovers only jobs it would run itself, never another machine's.
 */
export async function recoverLeases(root: Db, now: number, kinds?: readonly string[]): Promise<number> {
  return asSystem(root, async (tx) => {
    const expired = and(eq(jobs.state, 'running'), lt(jobs.leasedUntil, now), kinds ? inArray(jobs.kind, [...kinds]) : undefined);
    const failed = await tx.update(jobs).set({ state: 'failed', leasedUntil: null, lastError: 'worker died during the job' })
      .where(and(expired, gte(jobs.attempts, MAX_ATTEMPTS))).returning({ id: jobs.id });
    const retried = await tx.update(jobs).set({ state: 'pending', leasedUntil: null }).where(expired).returning({ id: jobs.id }); // the failed rows no longer match 'running'
    return failed.length + retried.length;
  });
}

/** Only terminal, reviewable states can be retried; a done job would repeat its side effect and a running one would double-execute. */
export async function retryJob(db: Db, id: string): Promise<void> {
  const [j] = await db.select({ state: jobs.state }).from(jobs).where(eq(jobs.id, id)).limit(1);
  if (!j) throw new Error('unknown job');
  if (j.state !== 'failed' && j.state !== 'needs_review') throw new Error(`job is ${j.state}, not retryable`);
  await db.update(jobs).set({ state: 'pending', attempts: 0, nextAt: Date.now(), leasedUntil: null, lastError: null }).where(eq(jobs.id, id));
}
