/** Boot the e2e harness for manual poking: prints a signed-in link for the seeded client. `npm run demo` */
import { startTestServer } from './server.js';
const srv = await startTestServer();
await fetch(`${srv.baseUrl}/api/auth/request`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-requested-with': 'fetch' }, body: JSON.stringify({ email: 'sarah@x.com' }) });
for (let i = 0; i < 50 && srv.mailbox().length === 0; i++) await new Promise((r) => setTimeout(r, 100));
const link = srv.mailbox()[0]?.text.match(/https?:\/\/[^\s]+\/auth\/[A-Za-z0-9_-]+/)?.[0];
console.log(`\nDemo server: ${srv.baseUrl}\nSign in as sarah@x.com: ${link}\n`);
process.on('SIGINT', () => { void srv.stop().then(() => process.exit(0)); });
