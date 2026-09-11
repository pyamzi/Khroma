import chokidar from 'chokidar';
import { join, relative, sep, basename } from 'node:path';
import type { Db } from '../db/client.js';
import { projects } from '../db/schema.js';
import { rescan } from './index.js';
import { indexProjectMedia } from './photos.js';

const STRUCTURAL = new Set(['client.json', 'project.json']);
export type WatcherOpts = { debounceMs?: number; stabilityMs?: number; sweepMs?: number; onIdle?: () => void };

/**
 * Debounced, serialized disk → database reconciliation for Clients/.
 * Filesystem events give responsiveness; a periodic full sweep guarantees convergence,
 * because fs.watch drops events under load (observed on macOS) and inotify queues overflow.
 */
export async function startWatcher(db: Db, photosDir: string, opts: WatcherOpts = {}): Promise<() => void> {
  const debounceMs = opts.debounceMs ?? 1500;
  let needRescan = false; const dirtyProjects = new Set<string>();
  let timer: NodeJS.Timeout | null = null; let running = false; let again = false;

  const projectFor = (rel: string): string | null => {
    let best: { id: string; folderPath: string } | null = null;
    for (const p of db.select({ id: projects.id, folderPath: projects.folderPath }).from(projects).all())
      if ((rel === p.folderPath || rel.startsWith(p.folderPath + '/')) && (!best || p.folderPath.length > best.folderPath.length)) best = p;
    return best?.id ?? null;
  };

  const drain = async () => {
    if (running) { again = true; return; } running = true;
    try {
      do {
        again = false;
        if (needRescan) { needRescan = false; await rescan(db, photosDir); for (const p of db.select({ id: projects.id }).from(projects).all()) dirtyProjects.add(p.id); }
        const ids = [...dirtyProjects]; dirtyProjects.clear();
        for (const id of ids) { try { await indexProjectMedia(db, photosDir, id); } catch (e) { console.error('[watcher] index failed', id, e); } }
      } while (again);
    } finally { running = false; opts.onIdle?.(); }
  };
  const schedule = () => { if (timer) clearTimeout(timer); timer = setTimeout(() => { timer = null; void drain(); }, debounceMs); };

  const onEvent = (kind: string, abs: string) => {
    const rel = relative(photosDir, abs).split(sep).join('/');
    if (!rel.startsWith('Clients/')) return;
    if (rel.split('/').some((s) => s === '.cache' || s === '.trash' || s.endsWith('.tmp'))) return;
    if (STRUCTURAL.has(basename(abs)) || kind === 'addDir' || kind === 'unlinkDir') needRescan = true;
    else { const id = projectFor(rel); if (id) dirtyProjects.add(id); else needRescan = true; }
    schedule();
  };

  const w = chokidar.watch(join(photosDir, 'Clients'), {
    ignoreInitial: true, persistent: true,
    ignored: (p: string) => /(^|[\\/])\.(cache|trash)([\\/]|$)/.test(p) || p.endsWith('.tmp'),
    awaitWriteFinish: { stabilityThreshold: opts.stabilityMs ?? 2000, pollInterval: 200 },
  });
  for (const ev of ['add', 'change', 'unlink', 'addDir', 'unlinkDir'] as const) w.on(ev, (p: string) => onEvent(ev, p));
  w.on('error', (e) => console.error('[watcher]', e));
  await new Promise<void>((resolve, reject) => { w.once('ready', resolve); w.once('error', reject); });
  const sweep = setInterval(() => { needRescan = true; schedule(); }, opts.sweepMs ?? 60_000);
  return () => { clearInterval(sweep); if (timer) clearTimeout(timer); void w.close(); };
}
