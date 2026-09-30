import { and, eq } from 'drizzle-orm';
import type { Db } from '../db/client.js';
import { webhookInbox } from '../db/schema.js';

/** Insert a verified delivery; false when this provider event id was already seen. Not Studio-scoped. */
export async function recordWebhook(db: Db, provider: string, eventId: string, objectId: string | null, payload: unknown): Promise<boolean> {
  return (await db.insert(webhookInbox).values({ provider, eventId, objectId, payload }).onConflictDoNothing().returning({ e: webhookInbox.eventId })).length === 1;
}
export async function markApplied(db: Db, provider: string, eventId: string): Promise<void> {
  await db.update(webhookInbox).set({ state: 'applied' }).where(and(eq(webhookInbox.provider, provider), eq(webhookInbox.eventId, eventId)));
}
