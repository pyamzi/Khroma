import { sql } from 'drizzle-orm';
import type { Db } from './client.js';

// A slow client or a stuck handler must not pin a pooled connection: every app transaction carries its own limits.
const LIMITS = sql`select set_config('statement_timeout', '30s', true), set_config('idle_in_transaction_session_timeout', '60s', true)`;

/** Long work inside a transaction (a job, a publish) must not trip the 60 s idle limit between its statements: Postgres would kill the connection mid-job. */
export const extendIdle = (tx: Db, ms: number) => tx.execute(sql`select set_config('idle_in_transaction_session_timeout', ${`${ms}ms`}, true)`);

/** One transaction bound to one Studio: row-level security hides every other Studio's rows. */
export function withStudio<T>(db: Db, studioId: string, fn: (tx: Db) => Promise<T>): Promise<T> {
  return db.transaction(async (tx) => {
    await tx.execute(sql`set local role og_app`);
    await tx.execute(sql`select set_config('statement_timeout', '30s', true), set_config('idle_in_transaction_session_timeout', '60s', true), set_config('app.studio_id', ${studioId}, true)`);
    return fn(tx as unknown as Db);
  });
}

/** Cross-Studio transaction (sign-in lookup, signup, job claiming). Keep these few and small; never nest one inside a request transaction. */
export function asSystem<T>(db: Db, fn: (tx: Db) => Promise<T>): Promise<T> {
  return db.transaction(async (tx) => {
    await tx.execute(sql`set local role og_system`);
    await tx.execute(LIMITS);
    return fn(tx as unknown as Db);
  });
}

/** No Studio: tenant tables read empty and reject writes. */
export function anonTx<T>(db: Db, fn: (tx: Db) => Promise<T>): Promise<T> {
  return db.transaction(async (tx) => {
    await tx.execute(sql`set local role og_app`);
    await tx.execute(LIMITS);
    return fn(tx as unknown as Db);
  });
}
