import { serve } from '@hono/node-server';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import sharp from 'sharp';
import { loadConfig } from '../../src/server/config.js';
import { openDb, migrate } from '../../src/server/db/client.js';
import { createApp } from '../../src/server/app.js';
import { createSetupToken, completeSetup, markSetupComplete } from '../../src/server/auth/bootstrap.js';
import { startWorker } from '../../src/server/jobs/worker.js';
import { makeEmailHandlers } from '../../src/server/email/send.js';
import { memoryTransport, type Mail } from '../../src/server/email/transport.js';
import { rescan } from '../../src/server/fs/index.js';
import { indexProjectMedia, makePreviewHandlers } from '../../src/server/fs/photos.js';
import { runOnce } from '../../src/server/jobs/queue.js';
import { writeJsonAtomic } from '../../src/server/fs/json.js';
import { defaultClientJson, defaultProjectJson } from '../../src/server/fs/schemas.js';

/** The real app in-process: memory mail, one client with three RAWs and an allowance of 2. Serves dist/web. */
export async function startTestServer() {
  const photosDir = await mkdtemp(join(tmpdir(), 'og-e2e-')); await mkdir(join(photosDir, 'Clients'), { recursive: true });
  const port = 3300 + Math.floor(Math.random() * 500); const baseUrl = `http://127.0.0.1:${port}`;
  const config = loadConfig({ DATA_DIR: photosDir, PHOTOS_DIR: photosDir, BASE_URL: baseUrl, SESSION_SECRET: 'x'.repeat(32) });
  const db = openDb(':memory:'); migrate(db);
  const mail = memoryTransport();
  const handlers = { ...makeEmailHandlers(() => mail, '127.0.0.1'), ...makePreviewHandlers(photosDir) };
  const token = createSetupToken(db);
  completeSetup(db, { token, ownerEmail: 'owner@x.com', studioName: 'E2E Studio', email: { type: 'smtp', url: 'smtp://u:p@h:587', from: 'S <s@x>' }, baseUrl, secret: config.sessionSecret });
  markSetupComplete(db);
  const c = defaultClientJson('Smith'); c.emails = ['sarah@x.com'];
  const p = defaultProjectJson('Wedding'); p.allowance = { included: 2, extraPrice: 1500, slots: 2 };
  await mkdir(join(photosDir, 'Clients/Smith/Wedding/raw'), { recursive: true });
  await writeJsonAtomic(join(photosDir, 'Clients/Smith/client.json'), c);
  await writeJsonAtomic(join(photosDir, 'Clients/Smith/Wedding/project.json'), p);
  for (const [i, n] of ['a', 'b', 'c'].entries()) await sharp({ create: { width: 600, height: 400, channels: 3, background: ['#c33', '#3c3', '#33c'][i]! } }).tiff().toFile(join(photosDir, `Clients/Smith/Wedding/raw/${n}.dng`));
  await rescan(db, photosDir); await indexProjectMedia(db, photosDir, p.id!);
  while ((await runOnce(db, handlers)) === 'ran') { /* previews */ }
  mail.sent.length = 0; // drop the setup email
  const stopWorker = startWorker(db, handlers, { intervalMs: 200 });
  const server = serve({ fetch: createApp({ db, config, photosDir, webRoot: './dist/web' }).fetch, port });
  return { baseUrl, projectId: p.id!, db, mailbox: (): Mail[] => mail.sent, async stop() { stopWorker(); server.close(); await rm(photosDir, { recursive: true, force: true }); } };
}
