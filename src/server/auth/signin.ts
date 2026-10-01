import { and, asc, eq, sql } from 'drizzle-orm';
import type { Db } from '../db/client.js';
import type { Config } from '../config.js';
import { clients, studios, users } from '../db/schema.js';
import { asSystem } from '../db/tenancy.js';
import { enqueue, type Handlers } from '../jobs/queue.js';
import { continueUrl } from './continue.js';
import type { Auth } from './better.js';

type Kind = 'admin' | 'client';

/** Queues a sign-in email to `kind` for one Studio. The job holds no link: Better Auth mints it when the email is sent. `db` is a system transaction or that Studio's transaction. */
export async function sendSignInLink(db: Db, o: { email: string; studioId: string; kind: Kind; baseUrl: string; now?: number }): Promise<void> {
  const now = o.now ?? Date.now();
  await enqueue(db, { kind: 'send_magic_link', payload: { email: o.email, kind: o.kind }, idempotencyKey: `magic:${o.studioId}:${o.email}:${now}`, studioId: o.studioId });
}

/** The sign-in email job. Reads what the mail needs, commits, and only then calls Better Auth, which writes to root-only tables on its own connection. */
export function makeSignInHandlers(auth: Auth, config: Config): Handlers {
  return {
    send_magic_link: { system: true, async run(payload, { root, studioId }) {
      const { email, kind } = payload as { email: string; kind: Kind };
      const { fromName, replyTo } = await asSystem(root, async (tx) => {
        const [s] = await tx.select({ name: studios.name, confirmedAt: studios.confirmedAt }).from(studios).where(eq(studios.id, studioId)).limit(1);
        const [owner] = await tx.select({ email: users.email }).from(users).where(and(eq(users.studioId, studioId), eq(users.role, 'owner'))).orderBy(asc(users.createdAt)).limit(1);
        return { fromName: s?.confirmedAt ? s.name : 'OpenGallery', replyTo: owner?.email ?? null }; // an unconfirmed Studio's chosen name is not trusted yet
      });
      await auth.api.signInMagicLink({ body: { email, callbackURL: continueUrl(config.betterAuthSecret, { studioId, kind, iat: Date.now() }), metadata: { studioId, kind, fromName, replyTo } }, headers: new Headers() });
    } },
  };
}

/** One link per Studio the email belongs to: admin where it is a Team member, client elsewhere. Returns the number sent. `db` is a system transaction. */
export async function requestSignIn(db: Db, o: { email: string; baseUrl: string; now?: number }): Promise<number> {
  const email = o.email.toLowerCase();
  const kinds = new Map<string, Kind>();
  for (const c of await db.selectDistinct({ studioId: clients.studioId }).from(clients).where(sql`${clients.emails} @> ${JSON.stringify([email])}::jsonb`)) kinds.set(c.studioId, 'client');
  for (const u of await db.select({ studioId: users.studioId }).from(users).where(eq(users.email, email))) kinds.set(u.studioId, 'admin');
  for (const [studioId, kind] of kinds) await sendSignInLink(db, { email, studioId, kind, baseUrl: o.baseUrl, now: o.now });
  return kinds.size;
}
