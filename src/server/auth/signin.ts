import { eq, sql } from 'drizzle-orm';
import type { Db } from '../db/client.js';
import { clients, studios, users } from '../db/schema.js';
import { sendEmail } from '../email/send.js';

/** Emails `kind` a sign-in link for one Studio. `db` is a system transaction or that Studio's transaction. */
export async function sendSignInLink(db: Db, o: { email: string; studioId: string; kind: 'admin' | 'client'; baseUrl: string; now?: number }): Promise<void> {
  const now = o.now ?? Date.now();
  const [s] = await db.select({ name: studios.name, confirmedAt: studios.confirmedAt }).from(studios).where(eq(studios.id, o.studioId)).limit(1);
  // the token is minted by the email job when it sends (email/send.ts), so no usable link ever rests in the jobs table
  await sendEmail(db, { to: o.email, template: 'magic_link', vars: { studio: s?.confirmedAt ? s.name : 'OpenGallery' }, key: `magic:${o.studioId}:${o.email}:${now}`, studioId: o.studioId, magic: { kind: o.kind, baseUrl: o.baseUrl } });
}

/** One link per Studio the email belongs to: admin where it is a Team member, client elsewhere. Returns the number sent. `db` is a system transaction. */
export async function requestSignIn(db: Db, o: { email: string; baseUrl: string; now?: number }): Promise<number> {
  const email = o.email.toLowerCase();
  const kinds = new Map<string, 'admin' | 'client'>();
  for (const c of await db.selectDistinct({ studioId: clients.studioId }).from(clients).where(sql`${clients.emails} @> ${JSON.stringify([email])}::jsonb`)) kinds.set(c.studioId, 'client');
  for (const u of await db.select({ studioId: users.studioId }).from(users).where(eq(users.email, email))) kinds.set(u.studioId, 'admin');
  for (const [studioId, kind] of kinds) await sendSignInLink(db, { email, studioId, kind, baseUrl: o.baseUrl, now: o.now });
  return kinds.size;
}
