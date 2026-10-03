import type { Db } from '../db/client.js';
import { studios } from '../db/schema.js';

/** The current Studio's name. `db` must be a Studio transaction. */
export async function studioName(db: Db): Promise<string> {
  const [s] = await db.select({ name: studios.name }).from(studios).limit(1);
  return s?.name ?? 'Kreate';
}
