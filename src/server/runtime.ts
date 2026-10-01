import type { Config } from './config.js';
import { openDb } from './db/client.js';
import { memoryStorage, r2Storage, type Storage } from './storage.js';
import type { Handlers } from './jobs/queue.js';
import { makePreviewHandlers } from './domain/photos.js';
import { makeLibraryHandlers } from './domain/library.js';

/** The database and storage every machine needs, whichever process group it runs. */
export async function openRuntime(config: Config) {
  const { db, close } = await openDb(config.databaseUrl, { migrate: config.databaseUrl.startsWith('pglite:') }); // Postgres migrates in the release step
  if (!config.r2) console.warn('[boot] R2 not configured: photos are kept in memory and lost on restart (local dev only)');
  const storage = config.r2 ? r2Storage(config.r2) : memoryStorage();
  return { db, close, storage };
}

/** Handlers for the HEAVY_KINDS jobs. Tasks that add a heavy kind register it here, so the app (local mode) and the worker machine agree. */
export function makeHeavyHandlers(storage: Storage): Handlers {
  return { ...makePreviewHandlers(storage), ...makeLibraryHandlers(storage) };
}
