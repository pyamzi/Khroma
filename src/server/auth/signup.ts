import { eq } from 'drizzle-orm';
import type { Db } from '../db/client.js';
import { studios, users } from '../db/schema.js';
import { pgCode } from '../db/errors.js';
import { newId } from '../ids.js';
import { sendSignInLink } from './signin.js';

/**
 * A new email gets a Studio, its owner row, and a sign-in link. An email that is already a Team member gets its
 * existing Studio's link and nothing is created, so the response never reveals which happened. `db` is a system transaction.
 */
export async function signup(db: Db, o: { email: string; studioName: string; baseUrl: string; now?: number }): Promise<{ created: boolean }> {
  const email = o.email.toLowerCase();
  const [existing] = await db.select({ studioId: users.studioId }).from(users).where(eq(users.email, email)).limit(1);
  if (existing) {
    await sendSignInLink(db, { email, studioId: existing.studioId, kind: 'admin', baseUrl: o.baseUrl, now: o.now });
    return { created: false };
  }
  const studioId = newId();
  try {
    await db.transaction(async (sp) => { // savepoint: a concurrent signup for the same email loses cleanly
      await sp.insert(studios).values({ id: studioId, name: o.studioName.trim() });
      await sp.insert(users).values({ id: newId(), studioId, email, role: 'owner' });
    });
  } catch (e) { if (pgCode(e) === '23505') return { created: false }; throw e; }
  await sendSignInLink(db, { email, studioId, kind: 'admin', baseUrl: o.baseUrl, now: o.now });
  return { created: true };
}
