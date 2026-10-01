import type { Db } from '../db/client.js';
import { runOnce, recoverLeases, type Handlers } from './queue.js';

export type WorkerOpts = {
  intervalMs: number;
  /** Claim only these kinds. Pass the kinds `handlers` covers: a kind with no handler here would be parked in needs_review. */
  kinds?: readonly string[];
  /** Call `onIdleExit` once nothing has been claimed for this long, and stop. */
  exitWhenIdleMs?: number;
  onIdleExit?: () => void;
  /** Runs before each claim pass; its failures are logged and never block the pass. */
  onTick?: () => Promise<void>;
};

/** One in-process worker per machine; claims use SKIP LOCKED, so more machines are safe. */
export function startWorker(root: Db, handlers: Handlers, opts: WorkerOpts): () => void {
  let stopped = false; let busy = false; let lastWork = Date.now();
  const tick = async () => {
    if (stopped || busy) return; busy = true;
    try {
      await opts.onTick?.().catch((e) => console.error('[jobs] onTick failed', e));
      while (!stopped && (await runOnce(root, handlers, Date.now(), opts.kinds)) === 'ran') lastWork = Date.now();
    }
    catch (e) { console.error('[jobs] worker error', e); }
    finally { busy = false; }
    if (!stopped && opts.exitWhenIdleMs !== undefined && Date.now() - lastWork >= opts.exitWhenIdleMs) { stopped = true; clearInterval(timer); opts.onIdleExit?.(); }
  };
  const timer = setInterval(tick, opts.intervalMs);
  void recoverLeases(root, Date.now()).catch((e) => console.error('[jobs] lease recovery failed', e)).then(tick);
  return () => { stopped = true; clearInterval(timer); };
}
