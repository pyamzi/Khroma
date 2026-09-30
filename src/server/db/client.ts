import type { PgDatabase, PgQueryResultHKT } from 'drizzle-orm/pg-core';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { mkdir } from 'node:fs/promises';
import pg from 'pg';
import * as schema from './schema.js';

export type Db = PgDatabase<PgQueryResultHKT, typeof schema>;
export const migrationsFolder = join(dirname(fileURLToPath(import.meta.url)), 'migrations');

/**
 * `pglite://memory` or `pglite://<dir>` → in-process PGlite (tests, local dev); anything else → node-postgres pool.
 * The connection stays the owner role; every app transaction drops to og_app itself (db/tenancy.ts), which is pooler-safe.
 */
export async function openDb(url: string, o: { migrate?: boolean } = {}): Promise<{ db: Db; close(): Promise<void> }> {
  if (url.startsWith('pglite:')) {
    const { PGlite } = await import('@electric-sql/pglite');
    const { drizzle } = await import('drizzle-orm/pglite');
    const dir = url.slice('pglite://'.length);
    if (dir !== 'memory') await mkdir(dir, { recursive: true }); // PGlite creates the data dir but not its parents
    const pg = new PGlite(dir === 'memory' ? undefined : dir);
    const db = drizzle(pg, { schema });
    if (o.migrate) await (await import('drizzle-orm/pglite/migrator')).migrate(db, { migrationsFolder });
    return { db: db as unknown as Db, close: () => pg.close() };
  }
  const { drizzle } = await import('drizzle-orm/node-postgres');
  const pool = makePool(url);
  const db = drizzle(pool, { schema });
  if (o.migrate) await (await import('drizzle-orm/node-postgres/migrator')).migrate(db, { migrationsFolder });
  return { db: db as unknown as Db, close: () => pool.end() };
}

/** The production pool. A backend that drops while idle (Neon suspend, pooler restart) is logged and replaced, never fatal. */
export function makePool(url: string): pg.Pool {
  const pool = new pg.Pool({ connectionString: url, max: 20, connectionTimeoutMillis: 10_000, idleTimeoutMillis: 30_000 });
  pool.on('error', (e) => console.error('[db] idle client error', e.message));
  return pool;
}
