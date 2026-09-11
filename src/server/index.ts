import { serve } from '@hono/node-server';
import { join } from 'node:path';
import { mkdir } from 'node:fs/promises';
import { loadConfig } from './config.js';
import { openDb, migrate } from './db/client.js';
import { createApp } from './app.js';
import { rescan } from './fs/index.js';
import { indexProjectMedia, makePreviewHandlers } from './fs/photos.js';
import { startWatcher } from './fs/watcher.js';
import { startWorker } from './jobs/worker.js';
import { makeEmailHandlers } from './email/send.js';
import { resolveTransport } from './email/transport.js';
import { projects } from './db/schema.js';

async function main() {
  const config = loadConfig(process.env);
  await mkdir(config.dataDir, { recursive: true });
  await mkdir(join(config.photosDir, 'Clients'), { recursive: true });
  const db = openDb(join(config.dataDir, 'opengallery.db')); migrate(db);

  const handlers = { ...makeEmailHandlers(() => resolveTransport(db, config), new URL(config.baseUrl).hostname), ...makePreviewHandlers(config.photosDir) };
  const stopWorker = startWorker(db, handlers, { intervalMs: 2000 });

  const report = await rescan(db, config.photosDir);
  console.log(`[boot] ${report.clients} clients, ${report.projects} projects, ${report.issues.length} issues`);
  for (const p of db.select({ id: projects.id }).from(projects).all()) {
    await indexProjectMedia(db, config.photosDir, p.id).catch((e) => console.error('[boot] index', p.id, e));
  }
  const stopWatcher = await startWatcher(db, config.photosDir);

  const server = serve({ fetch: createApp({ db, config, photosDir: config.photosDir }).fetch, port: config.port }, () => console.log(`[boot] listening on ${config.port}`));
  const shutdown = () => { stopWatcher(); stopWorker(); server.close(); process.exit(0); };
  process.on('SIGINT', shutdown); process.on('SIGTERM', shutdown);
}
main().catch((e) => { console.error(e); process.exit(1); });
