import type { Db } from '../db/client.js';
import { runOnce, recoverLeases, type Handlers } from './queue.js';

/** One in-process worker per app machine; claims use SKIP LOCKED, so more machines are safe. */
export function startWorker(root: Db, handlers: Handlers, opts: { intervalMs: number }): () => void {
  let stopped = false; let busy = false;
  const tick = async () => {
    if (stopped || busy) return; busy = true;
    try { while (!stopped && (await runOnce(root, handlers)) === 'ran') { /* drain */ } }
    catch (e) { console.error('[jobs] worker error', e); }
    finally { busy = false; }
  };
  const timer = setInterval(tick, opts.intervalMs);
  void recoverLeases(root, Date.now()).catch((e) => console.error('[jobs] lease recovery failed', e)).then(tick);
  return () => { stopped = true; clearInterval(timer); };
}
