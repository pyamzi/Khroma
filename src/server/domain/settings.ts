import { z } from 'zod';
import { desc, eq, inArray } from 'drizzle-orm';
import type { Db } from '../db/client.js';
import { users, jobs, events } from '../db/schema.js';
import { getSetting, setSetting } from '../db/settings.js';
import { resolveTransport, type EmailConfig } from '../email/transport.js';
import { sendEmail } from '../email/send.js';
import { createMagicLink } from '../auth/magic.js';
import { retryJob } from '../jobs/queue.js';
import { newId } from '../fs/ids.js';
import type { Config } from '../config.js';

export const StudioSettings = z.object({
  studioName: z.string().min(1).default('OpenGallery'), from: z.string().default(''), timezone: z.string().min(1).default('UTC'),
  currency: z.string().regex(/^[a-z]{3}$/).default('usd'), defaultIncluded: z.number().int().min(0).default(0), defaultExtraPrice: z.number().int().min(0).default(0), reviewUrl: z.string().default(''),
});
export type StudioSettings = z.infer<typeof StudioSettings>;
export type UserRow = typeof users.$inferSelect; export type JobRow = typeof jobs.$inferSelect;

export function getStudio(db: Db): StudioSettings {
  const name = getSetting<string>(db, 'studioName');
  return StudioSettings.parse({ ...(getSetting<Partial<StudioSettings>>(db, 'studio') ?? {}), ...(name ? { studioName: name } : {}) });
}
export function setStudio(db: Db, patch: Partial<StudioSettings>, actor: string): StudioSettings {
  const next = StudioSettings.parse({ ...getStudio(db), ...patch });
  setSetting(db, 'studio', next); setSetting(db, 'studioName', next.studioName);
  db.insert(events).values({ actor, type: 'settings_changed', payload: { keys: Object.keys(patch) } }).run();
  return next;
}
export function setEmailConfig(db: Db, cfg: EmailConfig, actor: string): void {
  setSetting(db, 'email', cfg); db.insert(events).values({ actor, type: 'settings_changed', payload: { keys: ['email'] } }).run();
}
export function emailStatus(db: Db, config: Config) {
  const t = resolveTransport(db, config);
  const id = getSetting<string>(db, 'email.lastTestJob');
  const j = id ? db.select().from(jobs).where(eq(jobs.id, id)).get() : null;
  return { configured: t !== null, describe: t?.describe() ?? null, lastTest: j ? { jobId: j.id, state: j.state, lastError: j.lastError, at: j.createdAt } : null };
}
/** Queues a test message; the job's state is the delivery evidence. */
export function sendDeliveryTest(db: Db, o: { to: string; actor: string }): { jobId: string } {
  const key = `test:${o.to}:${Date.now()}`;
  sendEmail(db, { to: o.to, template: 'test_delivery', vars: { studio: getStudio(db).studioName }, key });
  const j = db.select().from(jobs).where(eq(jobs.idempotencyKey, `email:${key}`)).get()!;
  setSetting(db, 'email.lastTestJob', j.id);
  db.insert(events).values({ actor: o.actor, type: 'email_test_sent', payload: { to: o.to, jobId: j.id } }).run();
  return { jobId: j.id };
}

export class TeamError extends Error { constructor(public code: 'last_owner' | 'not_found' | 'exists' | 'self' | 'forbidden') { super(code); this.name = 'TeamError'; } }
export const listUsers = (db: Db): UserRow[] => db.select().from(users).orderBy(users.createdAt).all();
const ownerCount = (db: Db) => db.select().from(users).where(eq(users.role, 'owner')).all().length;

export function inviteUser(db: Db, o: { email: string; role: 'owner' | 'member'; actor: string; baseUrl: string; studio: string }): UserRow {
  const email = o.email.trim().toLowerCase();
  if (db.select().from(users).where(eq(users.email, email)).get()) throw new TeamError('exists');
  const id = newId();
  db.transaction((tx) => {
    const d = tx as unknown as Db;
    tx.insert(users).values({ id, email, role: o.role }).run();
    const link = createMagicLink(d, { kind: 'admin', email });
    sendEmail(d, { to: email, template: 'magic_link', vars: { studio: o.studio, url: `${o.baseUrl}/auth/${link.token}` }, key: `invite:${id}:${Date.now()}` });
    tx.insert(events).values({ actor: o.actor, type: 'user_invited', payload: { id, email, role: o.role } }).run();
  });
  return db.select().from(users).where(eq(users.id, id)).get()!;
}
export function updateUser(db: Db, o: { userId: string; patch: { role?: 'owner' | 'member'; notifyDownloads?: 'off' | 'digest' | 'each'; name?: string }; actor: string }): UserRow {
  const u = db.select().from(users).where(eq(users.id, o.userId)).get(); if (!u) throw new TeamError('not_found');
  if (o.patch.role === 'member' && u.role === 'owner' && ownerCount(db) <= 1) throw new TeamError('last_owner');
  db.update(users).set(o.patch).where(eq(users.id, o.userId)).run();
  db.insert(events).values({ actor: o.actor, type: 'user_updated', payload: { id: o.userId, keys: Object.keys(o.patch) } }).run();
  return db.select().from(users).where(eq(users.id, o.userId)).get()!;
}
export function removeUser(db: Db, o: { userId: string; actor: string }): void {
  const u = db.select().from(users).where(eq(users.id, o.userId)).get(); if (!u) throw new TeamError('not_found');
  if (u.email === o.actor.toLowerCase()) throw new TeamError('self');
  if (u.role === 'owner' && ownerCount(db) <= 1) throw new TeamError('last_owner');
  db.delete(users).where(eq(users.id, o.userId)).run();
  db.insert(events).values({ actor: o.actor, type: 'user_removed', payload: { id: o.userId, email: u.email } }).run();
}

/** Without a state filter: everything that is not done. */
export function listJobs(db: Db, o: { state?: JobRow['state']; limit?: number } = {}): JobRow[] {
  const where = o.state ? eq(jobs.state, o.state) : inArray(jobs.state, ['pending', 'running', 'failed', 'needs_review']);
  return db.select().from(jobs).where(where).orderBy(desc(jobs.createdAt)).limit(o.limit ?? 200).all();
}
export function retryJobById(db: Db, id: string): JobRow {
  const j = db.select().from(jobs).where(eq(jobs.id, id)).get(); if (!j) throw new TeamError('not_found');
  if (j.state !== 'failed' && j.state !== 'needs_review') throw new TeamError('forbidden');
  retryJob(db, id); return db.select().from(jobs).where(eq(jobs.id, id)).get()!;
}
