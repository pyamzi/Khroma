import { sql } from 'drizzle-orm';
import type { Db } from './client.js';

/** One transaction bound to one Studio: row-level security hides every other Studio's rows. */
export function withStudio<T>(db: Db, studioId: string, fn: (tx: Db) => Promise<T>): Promise<T> {
  return db.transaction(async (tx) => {
    await tx.execute(sql`set local role og_app`);
    await tx.execute(sql`select set_config('app.studio_id', ${studioId}, true)`);
    return fn(tx as unknown as Db);
  });
}

/** Cross-Studio transaction (sign-in lookup, signup, job claiming). Keep these few and small. */
export function asSystem<T>(db: Db, fn: (tx: Db) => Promise<T>): Promise<T> {
  return db.transaction(async (tx) => {
    await tx.execute(sql`set local role og_app`);
    await tx.execute(sql`select set_config('app.system', 'on', true)`);
    return fn(tx as unknown as Db);
  });
}

/** No Studio: tenant tables read empty and reject writes. */
export function anonTx<T>(db: Db, fn: (tx: Db) => Promise<T>): Promise<T> {
  return db.transaction(async (tx) => {
    await tx.execute(sql`set local role og_app`);
    return fn(tx as unknown as Db);
  });
}
