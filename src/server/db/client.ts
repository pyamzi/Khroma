import Database from 'better-sqlite3';
import { drizzle, type BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import { migrate as drizzleMigrate } from 'drizzle-orm/better-sqlite3/migrator';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import * as schema from './schema.js';

export type Db = BetterSQLite3Database<typeof schema>;

export function openDb(file: string): Db {
  const sqlite = new Database(file);
  if (file !== ':memory:') sqlite.pragma('journal_mode = WAL');
  sqlite.pragma('foreign_keys = ON');
  sqlite.pragma('busy_timeout = 5000');
  return drizzle(sqlite, { schema });
}

export function migrate(db: Db): void {
  const here = dirname(fileURLToPath(import.meta.url));
  drizzleMigrate(db, { migrationsFolder: join(here, 'migrations') });
}
