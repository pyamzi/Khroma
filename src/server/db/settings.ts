import { eq } from 'drizzle-orm';
import type { Db } from './client.js';
import { settings } from './schema.js';

export function getSetting<T = unknown>(db: Db, key: string): T | null {
  const row = db.select().from(settings).where(eq(settings.key, key)).get();
  return row ? (row.value as T) : null;
}
export function setSetting(db: Db, key: string, value: unknown): void {
  db.insert(settings).values({ key, value }).onConflictDoUpdate({ target: settings.key, set: { value } }).run();
}
export function deleteSetting(db: Db, key: string): void {
  db.delete(settings).where(eq(settings.key, key)).run();
}
