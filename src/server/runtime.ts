import type { Config } from './config.js';
import { openDb } from './db/client.js';
import { memoryStorage, r2Storage } from './storage.js';

/** The database and storage every machine needs, whichever process group it runs. */
export async function openRuntime(config: Config) {
  const { db, close } = await openDb(config.databaseUrl, { migrate: config.databaseUrl.startsWith('pglite:') }); // Postgres migrates in the release step
  if (!config.r2) console.warn('[boot] R2 not configured: photos are kept in memory and lost on restart (local dev only)');
  const storage = config.r2 ? r2Storage(config.r2) : memoryStorage();
  return { db, close, storage };
}
