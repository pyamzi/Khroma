import { createHash, randomBytes } from 'node:crypto';
import { and, eq, isNull } from 'drizzle-orm';
import type { Db } from '../db/client.js';
import { sessions, studios } from '../db/schema.js';
import { newId } from '../ids.js';

// Sessions are looked up by token before any Studio is known, so every function here takes a system transaction.
export type SessionRow = typeof sessions.$inferSelect;
export const TTL = { client: 30 * 864e5, admin: 15 * 60_000, session: 30 * 864e5 } as const;
export const hashToken = (t: string) => createHash('sha256').update(t).digest('hex');
export const randomToken = () => randomBytes(32).toString('base64url');
const iso = (ms: number) => new Date(ms).toISOString();

/** Only the hash is stored; the raw token goes into the email and nowhere else. */
export async function createMagicLink(db: Db, o: { kind: 'client' | 'admin'; email: string; studioId: string; now?: number }): Promise<{ token: string; expiresAt: string }> {
  const now = o.now ?? Date.now(); const token = randomToken(); const expiresAt = iso(now + TTL[o.kind]);
  await db.insert(sessions).values({ id: newId(), studioId: o.studioId, kind: o.kind, subject: o.email.toLowerCase(), loginTokenHash: hashToken(token), expiresAt });
  return { token, expiresAt };
}

/** Single use: the login hash is cleared and replaced by a session token hash. */
export async function redeemMagicLink(db: Db, token: string, now = Date.now()): Promise<{ sessionToken: string; session: SessionRow } | null> {
  const [row] = await db.select().from(sessions).where(and(eq(sessions.loginTokenHash, hashToken(token)), isNull(sessions.redeemedAt))).limit(1).for('update');
  if (!row || Date.parse(row.expiresAt) <= now) return null;
  const sessionToken = randomToken();
  const [session] = await db.update(sessions).set({ loginTokenHash: null, redeemedAt: iso(now), tokenHash: hashToken(sessionToken), expiresAt: iso(now + TTL.session) })
    .where(eq(sessions.id, row.id)).returning();
  if (session!.kind === 'admin') await db.update(studios).set({ confirmedAt: iso(now) }).where(and(eq(studios.id, session!.studioId), isNull(studios.confirmedAt))); // the owner proved the address
  return { sessionToken, session: session! };
}

export async function sessionFromToken(db: Db, token: string, now = Date.now()): Promise<SessionRow | null> {
  const [row] = await db.select().from(sessions).where(eq(sessions.tokenHash, hashToken(token))).limit(1);
  return row && Date.parse(row.expiresAt) > now ? row : null;
}
export async function signOut(db: Db, token: string): Promise<void> {
  await db.update(sessions).set({ tokenHash: null, expiresAt: iso(0) }).where(eq(sessions.tokenHash, hashToken(token)));
}
