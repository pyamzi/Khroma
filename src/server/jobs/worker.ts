import type { Db } from '../db/client.js';
import { runOnce, recoverLeases, type Handlers } from './queue.js';

/** ponytail: single in-process worker; the NAS runs one app container. Split out if a second process ever appears. */
export function startWorker(db: Db, handlers: Handlers, opts: { intervalMs: number }): () => void {
  recoverLeases(db, Date.now());
  let stopped = false; let busy = false;
  const tick = async () => {
    if (stopped || busy) return; busy = true;
    try { while (!stopped && (await runOnce(db, handlers)) === 'ran') { /* drain */ } }
    catch (e) { console.error('[jobs] worker error', e); }
    finally { busy = false; }
  };
  const timer = setInterval(tick, opts.intervalMs); void tick();
  return () => { stopped = true; clearInterval(timer); };
}
