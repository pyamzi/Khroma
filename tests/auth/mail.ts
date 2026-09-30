import { eq } from 'drizzle-orm';
import { jobs } from '../../src/server/db/schema.js';
import { asSystem } from '../../src/server/db/tenancy.js';
import type { Db } from '../../src/server/db/client.js';

/** Queued emails, newest last, with the sign-in token when there is one. */
export async function queuedMail(db: Db) {
  const rows = await asSystem(db, (tx) => tx.select().from(jobs).where(eq(jobs.kind, 'send_email')).orderBy(jobs.createdAt));
  return rows.map((j) => {
    const p = j.payload as { to: string; template: string; vars: Record<string, string> };
    return { studioId: j.studioId, to: p.to, template: p.template, vars: p.vars, token: p.vars.url?.match(/\/auth\/([\w-]+)$/)?.[1] ?? null };
  });
}
