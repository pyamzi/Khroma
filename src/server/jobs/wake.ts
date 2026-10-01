import { and, eq, inArray, isNull, lt, lte, or } from 'drizzle-orm';
import type { Db } from '../db/client.js';
import { jobs } from '../db/schema.js';
import { asSystem } from '../db/tenancy.js';
import { HEAVY_KINDS } from './queue.js';

const API = 'https://api.machines.dev/v1';
const TIMEOUT_MS = 5000;

/**
 * Returns a function that starts the stopped worker machine through the Fly Machines API.
 * The machine is found once (by its process group) and the API is called at most once per `minIntervalMs`.
 */
export function makeWaker(o: { appName: string; token: string; fetch?: typeof fetch; minIntervalMs?: number }): () => Promise<void> {
  const doFetch = o.fetch ?? fetch; const minIntervalMs = o.minIntervalMs ?? 3000;
  const headers = { Authorization: `Bearer ${o.token}` };
  let machineId: string | undefined; let last = -Infinity;
  return async () => {
    const now = Date.now(); if (now - last < minIntervalMs) return; last = now;
    try {
      if (!machineId) {
        const res = await doFetch(`${API}/apps/${o.appName}/machines?metadata.fly_process_group=worker`, { headers, signal: AbortSignal.timeout(TIMEOUT_MS) });
        if (!res.ok) throw new Error(`listing worker machines failed: ${res.status}`);
        machineId = ((await res.json()) as { id: string }[])[0]?.id;
        if (!machineId) throw new Error('no worker machine found');
      }
      const res = await doFetch(`${API}/apps/${o.appName}/machines/${machineId}/start`, { method: 'POST', headers, signal: AbortSignal.timeout(TIMEOUT_MS) });
      if (!res.ok && res.status !== 409 && res.status !== 412) throw new Error(`starting worker machine failed: ${res.status}`); // 409/412: already started
    } catch (e) { machineId = undefined; throw e; } // look the machine up again next time (it may have been replaced)
  };
}

/** True when a heavy job needs the worker: due and pending, or left running past its lease (the worker died mid-job). Its own system transaction: never hold one across the wake-up call. */
export function pendingHeavy(root: Db, now: number): Promise<boolean> {
  return asSystem(root, async (tx) => (await tx.select({ id: jobs.id }).from(jobs)
    .where(and(inArray(jobs.kind, [...HEAVY_KINDS]), or(
      and(eq(jobs.state, 'pending'), lte(jobs.nextAt, now), or(isNull(jobs.leasedUntil), lt(jobs.leasedUntil, now))),
      and(eq(jobs.state, 'running'), lt(jobs.leasedUntil, now)))))
    .limit(1)).length > 0);
}

/**
 * An `onTick` for the app's worker: checks for heavy work and wakes the machine in the background.
 * It returns at once, so a slow or hung Machines API never delays the light jobs claimed in the same tick.
 */
export function wakeOnPending(root: Db, wake: () => Promise<void>): () => Promise<void> {
  return async () => { void pendingHeavy(root, Date.now()).then((due) => { if (due) return wake(); }).catch((e) => console.error('[wake]', e)); };
}
