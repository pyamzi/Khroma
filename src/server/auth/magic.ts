import { createHash, randomBytes } from 'node:crypto';
import { and, eq, isNull } from 'drizzle-orm';
import type { Db } from '../db/client.js';
import { sessions } from '../db/schema.js';
import { newId } from '../fs/ids.js';

export type SessionRow = typeof sessions.$inferSelect;
export const TTL = { client: 30 * 864e5, admin: 15 * 60_000, session: 30 * 864e5 } as const;
export const hashToken = (t: string) => createHash('sha256').update(t).digest('hex');
export const randomToken = () => randomBytes(32).toString('base64url');
const iso = (ms: number) => new Date(ms).toISOString();

/** Only the hash is stored; the raw token goes into the email and nowhere else. */
export function createMagicLink(db: Db, o: { kind: 'client' | 'admin'; email: string; now?: number }) {
  const now = o.now ?? Date.now(); const token = randomToken(); const expiresAt = iso(now + TTL[o.kind]);
  db.insert(sessions).values({ id: newId(), kind: o.kind, subject: o.email.toLowerCase(), loginTokenHash: hashToken(token), expiresAt }).run();
  return { token, expiresAt };
}

/** Single use: the login hash is cleared and replaced by a session token hash. */
export function redeemMagicLink(db: Db, token: string, now = Date.now()) {
  return db.transaction((tx) => {
    const row = tx.select().from(sessions).where(and(eq(sessions.loginTokenHash, hashToken(token)), isNull(sessions.redeemedAt))).get();
    if (!row || Date.parse(row.expiresAt) <= now) return null;
    const sessionToken = randomToken();
    tx.update(sessions).set({ loginTokenHash: null, redeemedAt: iso(now), tokenHash: hashToken(sessionToken), expiresAt: iso(now + TTL.session) }).where(eq(sessions.id, row.id)).run();
    return { sessionToken, session: tx.select().from(sessions).where(eq(sessions.id, row.id)).get()! };
  });
}

export function sessionFromToken(db: Db, token: string, now = Date.now()): SessionRow | null {
  const row = db.select().from(sessions).where(eq(sessions.tokenHash, hashToken(token))).get();
  return row && Date.parse(row.expiresAt) > now ? row : null;
}
export function signOut(db: Db, token: string): void {
  db.update(sessions).set({ tokenHash: null, expiresAt: iso(0) }).where(eq(sessions.tokenHash, hashToken(token))).run();
}
