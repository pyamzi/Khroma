import { z } from 'zod';
import { desc, eq, inArray } from 'drizzle-orm';
import type { Db } from '../db/client.js';
import { users, jobs, events, studios } from '../db/schema.js';
import { getSetting, setSetting } from '../db/settings.js';
import { pgCode } from '../db/errors.js';
import { sendSignInLink } from '../auth/signin.js';
import { retryJob } from '../jobs/queue.js';
import { newId } from '../ids.js';

export const StudioSettings = z.object({
  studioName: z.string().trim().min(1).max(80), timezone: z.string().min(1).default('UTC'),
  currency: z.string().regex(/^[a-z]{3}$/).default('usd'), defaultIncluded: z.number().int().min(0).default(0), defaultExtraPrice: z.number().int().min(0).default(0), reviewUrl: z.string().default(''),
});
export type StudioSettings = z.infer<typeof StudioSettings>;
export type UserRow = typeof users.$inferSelect; export type JobRow = typeof jobs.$inferSelect;

/** The name lives on the Studio row; the rest in the `studio` setting. `db` is a Studio transaction. */
export async function getStudio(db: Db): Promise<StudioSettings> {
  const [s] = await db.select().from(studios).limit(1);
  const { studioName: _ignored, ...rest } = (await getSetting<Partial<StudioSettings>>(db, 'studio')) ?? {};
  return StudioSettings.parse({ ...rest, studioName: s?.name ?? 'OpenGallery' });
}
export async function setStudio(db: Db, patch: Partial<StudioSettings>, actor: string): Promise<StudioSettings> {
  const next = StudioSettings.parse({ ...(await getStudio(db)), ...patch });
  const { studioName, ...rest } = next;
  const [s] = await db.select({ id: studios.id }).from(studios).limit(1);
  await db.update(studios).set({ name: studioName }).where(eq(studios.id, s!.id));
  await setSetting(db, 'studio', rest);
  await db.insert(events).values({ actor, type: 'settings_changed', payload: { keys: Object.keys(patch) } });
  return next;
}

export class TeamError extends Error { constructor(public code: 'last_owner' | 'not_found' | 'exists' | 'self' | 'forbidden') { super(code); this.name = 'TeamError'; } }
export const listUsers = (db: Db): Promise<UserRow[]> => db.select().from(users).orderBy(users.createdAt);
const ownerCount = async (db: Db) => (await db.select({ id: users.id }).from(users).where(eq(users.role, 'owner'))).length;
const user = async (db: Db, id: string) => (await db.select().from(users).where(eq(users.id, id)).limit(1))[0];

/** H1: a Team member belongs to one Studio, so an email already on any Team is `exists` (without saying which). */
export async function inviteUser(db: Db, o: { email: string; role: 'owner' | 'member'; actor: string; baseUrl: string }): Promise<UserRow> {
  const email = o.email.trim().toLowerCase();
  const [s] = await db.select({ id: studios.id }).from(studios).limit(1);
  const id = newId();
  try {
    await db.transaction(async (sp) => { await sp.insert(users).values({ id, email, role: o.role }); }); // savepoint: a duplicate leaves the request usable
  } catch (e) { if (pgCode(e) === '23505') throw new TeamError('exists'); throw e; }
  await sendSignInLink(db, { email, studioId: s!.id, kind: 'admin', baseUrl: o.baseUrl });
  await db.insert(events).values({ actor: o.actor, type: 'user_invited', payload: { id, email, role: o.role } });
  return (await user(db, id))!;
}
export async function updateUser(db: Db, o: { userId: string; patch: { role?: 'owner' | 'member'; notifyDownloads?: 'off' | 'digest' | 'each'; name?: string }; actor: string }): Promise<UserRow> {
  const u = await user(db, o.userId); if (!u) throw new TeamError('not_found');
  if (o.patch.role === 'member' && u.role === 'owner' && (await ownerCount(db)) <= 1) throw new TeamError('last_owner');
  await db.update(users).set(o.patch).where(eq(users.id, o.userId));
  await db.insert(events).values({ actor: o.actor, type: 'user_updated', payload: { id: o.userId, keys: Object.keys(o.patch) } });
  return (await user(db, o.userId))!;
}
export async function removeUser(db: Db, o: { userId: string; actor: string }): Promise<void> {
  const u = await user(db, o.userId); if (!u) throw new TeamError('not_found');
  if (u.email === o.actor.toLowerCase()) throw new TeamError('self');
  if (u.role === 'owner' && (await ownerCount(db)) <= 1) throw new TeamError('last_owner');
  await db.delete(users).where(eq(users.id, o.userId));
  await db.insert(events).values({ actor: o.actor, type: 'user_removed', payload: { id: o.userId, email: u.email } });
}

/** Without a state filter: everything that is not done. */
export async function listJobs(db: Db, o: { state?: JobRow['state']; limit?: number } = {}): Promise<JobRow[]> {
  const where = o.state ? eq(jobs.state, o.state) : inArray(jobs.state, ['pending', 'running', 'failed', 'needs_review']);
  return db.select().from(jobs).where(where).orderBy(desc(jobs.createdAt)).limit(o.limit ?? 200);
}
export async function retryJobById(db: Db, id: string): Promise<JobRow> {
  const [j] = await db.select().from(jobs).where(eq(jobs.id, id)).limit(1); if (!j) throw new TeamError('not_found');
  if (j.state !== 'failed' && j.state !== 'needs_review') throw new TeamError('forbidden');
  await retryJob(db, id); return (await db.select().from(jobs).where(eq(jobs.id, id)))[0]!;
}
