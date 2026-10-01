import { loadConfig } from './config.js';
import { openRuntime, makeHeavyHandlers } from './runtime.js';
import { startWorker } from './jobs/worker.js';
import { HEAVY_KINDS } from './jobs/queue.js';

/** The processing machine (Fly process group `worker`): the app starts it when heavy jobs are pending, and it exits after a minute with nothing to do. */
async function main() {
  const config = loadConfig(process.env);
  const { db, close, storage } = await openRuntime(config);
  const handlers = makeHeavyHandlers(storage);
  // Claim only kinds that have a handler yet, or the rest would be parked in needs_review.
  const kinds = HEAVY_KINDS.filter((k) => k in handlers);
  console.log(`[worker] up; claiming ${kinds.join(', ')}`);
  startWorker(db, handlers, { intervalMs: 500, kinds, exitWhenIdleMs: 60_000, onIdleExit: () => { console.log('[worker] idle, exiting'); void close().finally(() => process.exit(0)); } });
  const shutdown = () => void close().finally(() => process.exit(0));
  process.on('SIGINT', shutdown); process.on('SIGTERM', shutdown);
}
main().catch((e) => { console.error(e); process.exit(1); });
