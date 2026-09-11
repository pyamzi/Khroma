import { join } from 'node:path';
import { mkdirSync } from 'node:fs';
import { loadConfig } from './config.js';
import { openDb, migrate } from './db/client.js';
import { createSetupToken } from './auth/bootstrap.js';

const [cmd] = process.argv.slice(2);
const config = loadConfig(process.env);
mkdirSync(config.dataDir, { recursive: true });
const db = openDb(join(config.dataDir, 'opengallery.db')); migrate(db);
if (cmd === 'setup-token') {
  const token = createSetupToken(db);
  console.log(`Open this URL within 15 minutes:\n\n  ${config.baseUrl}/setup?token=${token}\n`);
} else { console.error('usage: opengallery setup-token'); process.exit(2); }
