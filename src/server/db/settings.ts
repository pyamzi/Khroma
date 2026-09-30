import { eq } from 'drizzle-orm';
import type { Db } from './client.js';
import { settings } from './schema.js';

// Scoped to the transaction's Studio by row-level security.
export async function getSetting<T = unknown>(db: Db, key: string): Promise<T | null> {
  const [row] = await db.select().from(settings).where(eq(settings.key, key)).limit(1);
  return row ? (row.value as T) : null;
}
export async function setSetting(db: Db, key: string, value: unknown): Promise<void> {
  await db.insert(settings).values({ key, value }).onConflictDoUpdate({ target: [settings.studioId, settings.key], set: { value } });
}
export async function deleteSetting(db: Db, key: string): Promise<void> {
  await db.delete(settings).where(eq(settings.key, key));
}
