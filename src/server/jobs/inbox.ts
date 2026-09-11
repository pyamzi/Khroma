import { and, eq } from 'drizzle-orm';
import type { Db } from '../db/client.js';
import { webhookInbox } from '../db/schema.js';

/** Insert a verified delivery; false when this provider event id was already seen. */
export function recordWebhook(db: Db, provider: string, eventId: string, objectId: string | null, payload: unknown): boolean {
  const r = db.insert(webhookInbox).values({ provider, eventId, objectId, payload }).onConflictDoNothing().run();
  return r.changes === 1;
}
export function markApplied(db: Db, provider: string, eventId: string): void {
  db.update(webhookInbox).set({ state: 'applied' }).where(and(eq(webhookInbox.provider, provider), eq(webhookInbox.eventId, eventId))).run();
}
