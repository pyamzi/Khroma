import { serve } from '@hono/node-server';
import { loadConfig } from './config.js';
import { openDb } from './db/client.js';
import { createApp } from './app.js';
import { startWorker } from './jobs/worker.js';
import { makeEmailHandlers } from './email/send.js';
import { smtpTransport } from './email/transport.js';
import { memoryStorage, r2Storage } from './storage.js';
import { makePreviewHandlers } from './domain/photos.js';
import { sweepUnconfirmedStudios } from './auth/signup.js';

async function main() {
  const config = loadConfig(process.env);
  const { db, close } = await openDb(config.databaseUrl, { migrate: config.databaseUrl.startsWith('pglite:') }); // Postgres migrates in the release step
  if (!config.r2) console.warn('[boot] R2 not configured: photos are kept in memory and lost on restart (local dev only)');
  if (!config.smtpUrl) console.warn('[boot] SMTP_URL not set: emails stay queued until it is');
  const storage = config.r2 ? r2Storage(config.r2) : memoryStorage();
  const transport = config.smtpUrl ? smtpTransport(config.smtpUrl, config.emailFrom) : null;
  const handlers = { ...makeEmailHandlers(() => transport, new URL(config.baseUrl).hostname), ...makePreviewHandlers(storage) };
  const stopWorker = startWorker(db, handlers, { intervalMs: 2000 });
  const sweep = () => void sweepUnconfirmedStudios(db).then((n) => n && console.log(`[sweep] removed ${n} unconfirmed studios`)).catch((e) => console.error('[sweep]', e));
  const sweeper = setInterval(sweep, 3600_000); sweep();
  const server = serve({ fetch: createApp({ db, config, storage }).fetch, port: config.port }, () => console.log(`[boot] listening on ${config.port}`));
  const shutdown = () => { stopWorker(); clearInterval(sweeper); server.close(() => void close().finally(() => process.exit(0))); };
  process.on('SIGINT', shutdown); process.on('SIGTERM', shutdown);
}
main().catch((e) => { console.error(e); process.exit(1); });
