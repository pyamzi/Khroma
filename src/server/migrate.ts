import { openDb } from './db/client.js';

/** Release step: migrate DATABASE_URL as its owner, then exit. */
const url = process.env.DATABASE_URL;
if (!url) { console.error('DATABASE_URL is required'); process.exit(1); }
const { close } = await openDb(url, { migrate: true });
await close();
console.log('[migrate] done');
