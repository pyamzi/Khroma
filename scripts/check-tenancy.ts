import { openDb } from '../src/server/db/client.js';
import { checkTenancy } from '../src/server/db/check.js';

const url = process.env.DATABASE_URL;
if (!url) { console.error('DATABASE_URL is required'); process.exit(1); }
const { db, close } = await openDb(url);
const problems = await checkTenancy(db);
await close();
if (problems.length) { for (const p of problems) console.error(`FAIL ${p}`); process.exit(1); }
console.log('ok: og_app is not a superuser and cannot bypass RLS; app transactions run as og_app; every tenant table forces RLS with a policy; two Studios cannot see each other');
