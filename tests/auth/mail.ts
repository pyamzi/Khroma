import { eq } from 'drizzle-orm';
import { jobs } from '../../src/server/db/schema.js';
import { asSystem } from '../../src/server/db/tenancy.js';
import type { Db } from '../../src/server/db/client.js';
import { runOnce } from '../../src/server/jobs/queue.js';
import { makeEmailHandlers } from '../../src/server/email/send.js';
import { memoryTransport } from '../../src/server/email/transport.js';

/** Sends every queued email and returns them in queue order, each with its job's Studio and the sign-in token from the sent text. */
export async function queuedMail(db: Db) {
  const rows = await asSystem(db, (tx) => tx.select().from(jobs).where(eq(jobs.kind, 'send_email')).orderBy(jobs.createdAt));
  const t = memoryTransport(); const handlers = makeEmailHandlers(() => t, 'test');
  while ((await runOnce(db, handlers)) === 'ran') { /* send */ }
  return rows.map((j) => {
    const p = j.payload as { to: string; template: string; vars: Record<string, string>; key: string };
    const m = t.sent.find((x) => x.messageId === `<email:${p.key}@test>`);
    return { studioId: j.studioId, to: p.to, template: p.template, vars: p.vars, fromName: m?.fromName ?? null, token: m?.text.match(/\/auth\/([\w-]+)/)?.[1] ?? null };
  });
}
