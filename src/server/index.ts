import { serve } from '@hono/node-server';
import { loadConfig } from './config.js';
import { openRuntime, makeHeavyHandlers } from './runtime.js';
import { createApp } from './app.js';
import { createAuth } from './auth/better.js';
import { startWorker } from './jobs/worker.js';
import { makeWaker, wakeOnPending } from './jobs/wake.js';
import { makeEmailHandlers } from './email/send.js';
import { smtpTransport } from './email/transport.js';
import { sweepUnconfirmedStudios } from './auth/signup.js';
import { makeSignInHandlers } from './auth/signin.js';
import { makeDeliveryHandlers } from './domain/delivery.js';
import { sweepStaleUploads } from './domain/library.js';
import { sweepCullingPreviews } from './domain/cleanup.js';

async function main() {
  const config = loadConfig(process.env);
  const { db, close, storage } = await openRuntime(config);
  if (!config.smtpUrl) console.warn('[boot] SMTP_URL not set: emails stay queued until it is');
  const transport = config.smtpUrl ? smtpTransport(config.smtpUrl, config.emailFrom) : null;
  const auth = createAuth({ root: db, config, getTransport: () => transport });
  const light = { ...makeEmailHandlers(() => transport, new URL(config.baseUrl).hostname), ...makeSignInHandlers(auth, config), ...makeDeliveryHandlers(storage) };
  // Remote: heavy jobs run on the Fly worker machine, which this machine starts when they are pending. Local: this machine runs everything.
  // Either way it claims exactly the kinds it has handlers for.
  const remote = config.processing.mode === 'remote' ? makeWaker(config.processing) : null;
  const handlers = remote ? light : { ...light, ...makeHeavyHandlers(storage) };
  const onTick = remote ? wakeOnPending(db, remote) : undefined;
  const stopWorker = startWorker(db, handlers, { intervalMs: 2000, kinds: Object.keys(handlers), onTick });
  const sweep = () => {
    void sweepUnconfirmedStudios(db).then((n) => n && console.log(`[sweep] removed ${n} unconfirmed studios`)).catch((e) => console.error('[sweep]', e));
    void sweepStaleUploads(db, storage, Date.now()).then((n) => n && console.log(`[sweep] removed ${n} stale uploads`)).catch((e) => console.error('[sweep]', e));
    const day = new Date().toISOString().slice(0, 10); // culling purge: once per UTC day, off the same timer; a failed run retries next tick
    if (day === lastPurgeDay) return;
    void sweepCullingPreviews(db, storage, new Date()).then((r) => { lastPurgeDay = day; if (r.purged) console.log(`[sweep] purged ${r.purged} culling previews`); }).catch((e) => console.error('[sweep]', e));
  };
  let lastPurgeDay = '';
  const sweeper = setInterval(sweep, 3600_000); sweep();
  const server = serve({ fetch: createApp({ db, config, storage, auth }).fetch, port: config.port }, () => console.log(`[boot] listening on ${config.port}`));
  const shutdown = () => { stopWorker(); clearInterval(sweeper); server.close(() => void close().finally(() => process.exit(0))); };
  process.on('SIGINT', shutdown); process.on('SIGTERM', shutdown);
}
main().catch((e) => { console.error(e); process.exit(1); });
