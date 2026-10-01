import { describe, it, expect, vi } from 'vitest';
import { makeWaker, pendingHeavy, wakeOnPending } from '../../src/server/jobs/wake.js';
import { enqueue, claimNext } from '../../src/server/jobs/queue.js';
import { startWorker } from '../../src/server/jobs/worker.js';
import { withStudio } from '../../src/server/db/tenancy.js';
import { testDb, makeStudio } from '../helpers.js';

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
function stub(startStatus = 200) {
  const calls: { url: string; method: string; auth: string | null }[] = [];
  const fetch = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    const u = String(url); const method = init?.method ?? 'GET';
    calls.push({ url: u, method, auth: new Headers(init?.headers).get('authorization') });
    return method === 'GET' ? json([{ id: 'm1' }]) : json({}, startStatus);
  }) as unknown as typeof globalThis.fetch;
  return { fetch, calls };
}

describe('makeWaker', () => {
  it('starts the worker machine once per interval', async () => {
    const { fetch, calls } = stub(); const wake = makeWaker({ appName: 'og', token: 't0k', fetch });
    await wake();
    for (const [, init] of vi.mocked(fetch).mock.calls) expect(init?.signal).toBeInstanceOf(AbortSignal); // a hung Machines API times out await new Promise((r) => setTimeout(r, 1)); await wake();
    expect(calls).toEqual([
      { url: 'https://api.machines.dev/v1/apps/og/machines?metadata.fly_process_group=worker', method: 'GET', auth: 'Bearer t0k' },
      { url: 'https://api.machines.dev/v1/apps/og/machines/m1/start', method: 'POST', auth: 'Bearer t0k' },
    ]);
  });
  it('lists machines once and starts again after the interval', async () => {
    const { fetch, calls } = stub(); const wake = makeWaker({ appName: 'og', token: 't', fetch, minIntervalMs: 5 });
    await wake(); await new Promise((r) => setTimeout(r, 10)); await wake();
    expect(calls.map((c) => c.method)).toEqual(['GET', 'POST', 'POST']);
  });
  it.each([409, 412])('treats %i (already started) as success', async (status) => {
    const { fetch } = stub(status); await expect(makeWaker({ appName: 'og', token: 't', fetch })()).resolves.toBeUndefined();
  });
  it('rejects on other failures and retries the machine list next time', async () => {
    const { fetch, calls } = stub(500); const wake = makeWaker({ appName: 'og', token: 't', fetch, minIntervalMs: 0 });
    await expect(wake()).rejects.toThrow(/500/);
    await expect(wake()).rejects.toThrow(/500/);
    expect(calls.filter((c) => c.method === 'GET')).toHaveLength(2);
  });
  it('rejects when no worker machine exists', async () => {
    const fetch = (async () => json([])) as unknown as typeof globalThis.fetch;
    await expect(makeWaker({ appName: 'og', token: 't', fetch })()).rejects.toThrow(/no worker machine/);
  });
});

describe('pendingHeavy', () => {
  it('is true only for a due heavy job that can be claimed', async () => {
    const db = await testDb(); const { studioId } = await makeStudio(db); const T = 1_700_000_000_000;
    const add = (kind: string, runAt: number) => withStudio(db, studioId, (tx) => enqueue(tx, { kind, payload: {}, runAt }));
    expect(await pendingHeavy(db, T)).toBe(false);
    await add('send_email', T); expect(await pendingHeavy(db, T)).toBe(false);
    await add('preview', T + 1000); expect(await pendingHeavy(db, T)).toBe(false); // not due yet
    expect(await pendingHeavy(db, T + 1000)).toBe(true);
    await claimNext(db, T + 1000, ['preview']); expect(await pendingHeavy(db, T + 1001)).toBe(false); // already running
  });
  it('counts a heavy job left running past its lease (a crashed worker), not one still leased', async () => {
    const db = await testDb(); const { studioId } = await makeStudio(db); const T = 1_700_000_000_000;
    await withStudio(db, studioId, (tx) => enqueue(tx, { kind: 'preview', payload: {}, runAt: T }));
    await claimNext(db, T, ['preview']); // running, leased until T + 60_000
    expect(await pendingHeavy(db, T + 59_000)).toBe(false);
    expect(await pendingHeavy(db, T + 61_000)).toBe(true);
  });
});

describe('wakeOnPending', () => {
  it('never holds up light claims, even when the Machines API hangs', async () => {
    const db = await testDb(); const { studioId } = await makeStudio(db); let ran = 0;
    await withStudio(db, studioId, (tx) => enqueue(tx, { kind: 'preview', payload: {} })); // heavy job pending: the wake fires
    await withStudio(db, studioId, (tx) => enqueue(tx, { kind: 'send_email', payload: {} }));
    const fetch = vi.fn(() => new Promise<Response>(() => {})) as unknown as typeof globalThis.fetch; // never resolves
    const stop = startWorker(db, { send_email: async () => { ran++; } }, { intervalMs: 10, kinds: ['send_email'], onTick: wakeOnPending(db, makeWaker({ appName: 'og', token: 't', fetch })) });
    await vi.waitFor(() => expect(ran).toBe(1), { timeout: 1000 }); stop();
    expect(fetch).toHaveBeenCalled();
  });
  it('logs a failed wake instead of throwing', async () => {
    const db = await testDb(); const { studioId } = await makeStudio(db);
    await withStudio(db, studioId, (tx) => enqueue(tx, { kind: 'preview', payload: {} }));
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    await wakeOnPending(db, async () => { throw new Error('fly down'); })();
    await vi.waitFor(() => expect(err).toHaveBeenCalledWith('[wake]', expect.any(Error))); err.mockRestore();
  });
});
