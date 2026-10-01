import { serve } from '@hono/node-server';
import sharp from 'sharp';
import { eq } from 'drizzle-orm';
import { loadConfig } from '../../src/server/config.js';
import { openDb } from '../../src/server/db/client.js';
import { asSystem, withStudio } from '../../src/server/db/tenancy.js';
import { users } from '../../src/server/db/schema.js';
import { createApp } from '../../src/server/app.js';
import { createAuth } from '../../src/server/auth/better.js';
import { signup } from '../../src/server/auth/signup.js';
import { startWorker } from '../../src/server/jobs/worker.js';
import { runOnce } from '../../src/server/jobs/queue.js';
import { makeEmailHandlers } from '../../src/server/email/send.js';
import { memoryTransport, type Mail } from '../../src/server/email/transport.js';
import { memoryStorage } from '../../src/server/storage.js';
import { createClient, createProject } from '../../src/server/domain/admin.js';
import { addPhoto, makePreviewHandlers } from '../../src/server/domain/photos.js';

/** The real app in-process on in-memory Postgres: Studio "E2E Studio" (owner@x.com), client sarah@x.com, three RAWs, allowance 2. Serves dist/web. */
export async function startTestServer() {
  const port = 3300 + Math.floor(Math.random() * 500); const baseUrl = `http://127.0.0.1:${port}`;
  const config = loadConfig({ DATABASE_URL: 'pglite://memory', BASE_URL: baseUrl });
  const { db, close } = await openDb(config.databaseUrl, { migrate: true });
  const storage = memoryStorage(); const mail = memoryTransport();
  const handlers = { ...makeEmailHandlers(() => mail, '127.0.0.1'), ...makePreviewHandlers(storage) };
  await asSystem(db, (tx) => signup(tx, { email: 'owner@x.com', studioName: 'E2E Studio', baseUrl }));
  const [{ studioId }] = (await asSystem(db, (tx) => tx.select({ studioId: users.studioId }).from(users).where(eq(users.email, 'owner@x.com')))) as [{ studioId: string }];
  const projectId = await withStudio(db, studioId, async (tx) => {
    const c = await createClient(tx, { name: 'Smith', emails: ['sarah@x.com'], actor: 'seed' });
    const p = await createProject(tx, { clientId: c.id, title: 'Wedding', included: 2, extraPrice: 1500, actor: 'seed' });
    for (const [i, n] of ['a', 'b', 'c'].entries()) {
      const bytes = await sharp({ create: { width: 600, height: 400, channels: 3, background: ['#c33', '#3c3', '#33c'][i]! } }).tiff().toBuffer();
      await addPhoto(tx, storage, { projectId: p.id, relPath: `raw/${n}.dng`, stage: 'culling', bytes, name: `${n}.dng` });
    }
    return p.id;
  });
  while ((await runOnce(db, handlers)) === 'ran') { /* previews and the signup email */ }
  mail.sent.length = 0; // drop the signup email
  const stopWorker = startWorker(db, handlers, { intervalMs: 200 });
  const server = serve({ fetch: createApp({ db, config, storage, auth: createAuth({ root: db, config, getTransport: () => mail }), webRoot: './dist/web' }).fetch, port });
  const signInLink = async (email: string): Promise<string> => {
    const before = mail.sent.length;
    await fetch(`${baseUrl}/api/auth/request`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-requested-with': 'fetch' }, body: JSON.stringify({ email }) });
    for (let i = 0; i < 50 && mail.sent.length <= before; i++) await new Promise((r) => setTimeout(r, 100));
    return mail.sent[before]!.text.match(/https?:\/\/[^\s]+\/auth\/[A-Za-z0-9_-]+/)![0];
  };
  return { baseUrl, projectId, studioId, db, mailbox: (): Mail[] => mail.sent, signInLink, async stop() { stopWorker(); await new Promise((r) => server.close(r)); await close(); } };
}
