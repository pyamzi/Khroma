import { createHmac, timingSafeEqual } from 'node:crypto';
import { and, eq, isNull, sql } from 'drizzle-orm';
import type { Db } from '../db/client.js';
import { asSystem } from '../db/tenancy.js';
import { authSessions, clients, studios, users } from '../db/schema.js';

type Kind = 'admin' | 'client';
const MAX_AGE: Record<Kind, number> = { admin: 15 * 60_000, client: 30 * 864e5 };
// The email is last, so a `|` inside it cannot shift the other fields; any mismatch still fails the signature
const sign = (secret: string, studioId: string, kind: Kind, iat: number | string, email: string) => createHmac('sha256', secret).update(`${studioId}|${kind}|${iat}|${email}`).digest('base64url');

/** The callbackURL handed to Better Auth: names the Studio, kind, and email, signed so a link for one Studio or person cannot be pointed at another. */
export function continueUrl(secret: string, o: { studioId: string; kind: Kind; iat: number | string; email: string }): string {
  const email = o.email.toLowerCase();
  return `/auth/continue?${new URLSearchParams({ studio: o.studioId, kind: o.kind, iat: String(o.iat), email, sig: sign(secret, o.studioId, o.kind, o.iat, email) })}`;
}

export function verifyContinue(secret: string, q: Record<string, string | undefined>, now: number): { studioId: string; kind: Kind; email: string } | null {
  const { studio, kind, iat, sig } = q; const email = q.email?.toLowerCase();
  if (!studio || (kind !== 'admin' && kind !== 'client') || !iat || !email || !sig) return null;
  const want = Buffer.from(sign(secret, studio, kind, iat, email)); const got = Buffer.from(sig);
  if (want.length !== got.length || !timingSafeEqual(want, got)) return null;
  if (!(now - Number(iat) <= MAX_AGE[kind])) return null; // also refuses a non-numeric iat
  return { studioId: studio, kind, email };
}

/** Pins a Better Auth session to one Studio and kind, if the email is a member of it. The auth_* tables are root-only, so that write uses `root`, never a system transaction. */
export async function bindSession(root: Db, o: { sessionId: string; email: string; studioId: string; kind: Kind; now: number }): Promise<boolean> {
  const member = await asSystem(root, async (tx) => {
    const rows = o.kind === 'admin'
      ? await tx.select({ id: users.id }).from(users).where(and(eq(users.studioId, o.studioId), eq(users.email, o.email))).limit(1)
      : await tx.select({ id: clients.id }).from(clients).where(and(eq(clients.studioId, o.studioId), sql`${clients.emails} ? ${o.email}`)).limit(1);
    if (rows.length > 0 && o.kind === 'admin') await tx.update(studios).set({ confirmedAt: new Date(o.now).toISOString() }).where(and(eq(studios.id, o.studioId), isNull(studios.confirmedAt))); // the owner proved the address
    return rows.length > 0;
  });
  if (!member) return false;
  await root.update(authSessions).set({ studioId: o.studioId, kind: o.kind }).where(eq(authSessions.id, o.sessionId));
  return true;
}
