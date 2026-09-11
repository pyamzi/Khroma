# OpenGallery Milestone 1: Foundation — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A running OpenGallery server that indexes the `/photos` tree by stable ID, extracts RAW previews, runs background jobs, sends email over SMTP, bootstraps its first owner, authenticates clients and admins by magic link, and serves project photos only to entitled sessions.

**Architecture:** One Node process: Hono HTTP API + a chokidar folder watcher + an in-process job worker, all over one SQLite file (Drizzle). The filesystem under `/photos` is the content interface; SQLite owns identity, sessions, jobs. Every write to a provider or mailbox is committed locally as a job first, then executed by the worker with an idempotency key. A minimal React shell (setup, sign-in, home) proves the loop end to end.

**Tech Stack:** Node 22, TypeScript (strict), Hono + @hono/node-server, Drizzle ORM + better-sqlite3, Zod, chokidar 4, sharp, exiftool (system binary), nodemailer, Vite + React + Tailwind, Vitest, Docker Compose.

**Spec:** `docs/superpowers/specs/2026-09-10-opengallery-design.md` (Revision 2). This plan implements section 21 milestone 1: compose profiles, schema and migrations with constraints, stable IDs and watcher reconciliation, RAW preview extraction, `jobs` and `webhook_inbox`, SMTP adapter with bundled templates, bootstrap, auth, access middleware, backup/restore doc. Gates: identity, minimum install, write policy.

## Global Constraints

- Node 22, TypeScript `strict: true`, ESM (`"type": "module"`). No CommonJS.
- SQLite in WAL mode with `foreign_keys = ON`. One file at `$DATA_DIR/opengallery.db`. Never on an SMB mount (documented, not enforced).
- All filesystem paths are resolved server-side beneath their root; traversal and symlink escapes throw. Reserved directories: `.draft`, `.cache`, `.trash`.
- Photos and clients/projects are keyed by immutable UUID `id`, never by path. Paths are locations.
- Machine-owned JSON fields (`id`, `schemaVersion`, `stateVersion`, `state`, `allowance`, `sharePassword`, `integrations`) are projections; external edits are overwritten from the database and bannered, never applied.
- Commit locally, then call out: any email or provider call is a `jobs` row first. Job idempotency keys are unique.
- Magic links are single-use, hashed at rest. Client links live 30 days, admin links 15 minutes. Session cookies: `httpOnly`, `secure` (outside tests), `sameSite=lax`.
- No login path without email. No seeded accounts. No debug mode.
- Every test uses a temp directory and an in-memory or temp SQLite file; nothing touches the developer's real `/photos`.
- Commit after every task. Commit messages: conventional prefix (`feat:`, `test:`, `chore:`, `docs:`), body optional, trailer `Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>`.
- `ponytail:` comments mark deliberate simplifications with a stated ceiling.

## File structure

```
package.json, tsconfig.json, vitest.config.ts, vite.config.ts, drizzle.config.ts
Dockerfile, compose.yml, .env.example
src/server/
  index.ts                  boot: config → db+migrate → rescan → watcher → worker → http
  config.ts                 env → Config (zod)
  app.ts                    Hono app assembly (routes + middleware)
  db/schema.ts              Drizzle tables (spec §4 + settings)
  db/client.ts              openDb(), pragmas, migrate()
  db/migrations/            drizzle-kit output (committed SQL)
  db/settings.ts            get/set typed settings
  fs/paths.ts               resolveInside(), isReserved(), PathError
  fs/ids.ts                 newId()
  fs/json.ts                readJson(), writeJsonAtomic()
  fs/schemas.ts             ClientJson/ProjectJson zod, MACHINE_FIELDS, defaults
  fs/media.ts               sniff(): signature + extension allowlist, quickHash()
  fs/previews.ts            extractPreview(), makeThumb()
  fs/index.ts               rescan(): classify folders by ID, issues, moves, unavailable
  fs/photos.ts              indexProjectMedia(): raw/ + finals/ + .draft rows, .cache previews
  fs/watcher.ts             chokidar → debounce → rescan/index jobs
  jobs/queue.ts             enqueue(), claimNext(), runOnce(), recoverLeases(), NeedsReview
  jobs/worker.ts            startWorker(): loop
  jobs/inbox.ts             recordWebhook(): dedup insert
  email/templates.ts        bundled templates: magic_link, test_delivery
  email/transport.ts        Transport, smtpTransport(), listmonkTransport(), memoryTransport()
  email/send.ts             sendEmail(): enqueue 'send_email'; handler
  auth/magic.ts             createMagicLink(), redeemMagicLink(), sessionFromCookie()
  auth/bootstrap.ts         createSetupToken(), completeSetup()
  http/session.ts           session middleware (cookie → c.var.session)
  http/access.ts            requireKind(), loadProject(), loadPhoto() — the one scoping function
  http/routes/health.ts     GET /healthz
  http/routes/setup.ts      POST /api/setup
  http/routes/auth.ts       POST /api/auth/request, GET /auth/:token, POST /api/auth/signout, GET /api/me
  http/routes/projects.ts   GET /api/projects, GET /api/projects/:id, GET /api/projects/:id/photos
  http/routes/photos.ts     GET /api/photos/:id/preview
  http/routes/issues.ts     GET /api/issues (admin)
  cli.ts                    `opengallery setup-token`
src/web/                    Vite React shell: main.tsx, App.tsx, pages/Setup.tsx, pages/SignIn.tsx, pages/Home.tsx, index.css
tests/                      vitest, mirrors src/server; tests/helpers.ts (tmp dirs, db, fixtures)
docs/install.md, docs/backup-restore.md
```

---

### Task 1: Project scaffold and test harness

**Files:**
- Create: `package.json`, `tsconfig.json`, `vitest.config.ts`, `.gitignore` (modify), `tests/helpers.ts`, `tests/smoke.test.ts`

**Interfaces:**
- Produces: `tests/helpers.ts` exports `tmpDir(): Promise<string>` (auto-removed after test) used by every later test.

- [ ] **Step 1: Write package.json**

```json
{
  "name": "opengallery",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "license": "AGPL-3.0-only",
  "engines": { "node": ">=22" },
  "scripts": {
    "dev": "tsx watch src/server/index.ts",
    "build": "tsc -p tsconfig.json && vite build",
    "start": "node dist/server/index.js",
    "cli": "tsx src/server/cli.ts",
    "test": "vitest run",
    "test:watch": "vitest",
    "typecheck": "tsc -p tsconfig.json --noEmit",
    "db:generate": "drizzle-kit generate"
  },
  "dependencies": {
    "@hono/node-server": "^1.13.0",
    "better-sqlite3": "^11.5.0",
    "chokidar": "^4.0.1",
    "drizzle-orm": "^0.36.0",
    "hono": "^4.6.0",
    "nodemailer": "^6.9.16",
    "sharp": "^0.33.5",
    "zod": "^3.23.8"
  },
  "devDependencies": {
    "@tailwindcss/vite": "^4.0.0",
    "@types/better-sqlite3": "^7.6.11",
    "@types/node": "^22.7.0",
    "@types/nodemailer": "^6.4.16",
    "@types/react": "^18.3.11",
    "@types/react-dom": "^18.3.1",
    "@vitejs/plugin-react": "^4.3.2",
    "drizzle-kit": "^0.28.0",
    "react": "^18.3.1",
    "react-dom": "^18.3.1",
    "tailwindcss": "^4.0.0",
    "tsx": "^4.19.1",
    "typescript": "^5.6.3",
    "vite": "^5.4.8",
    "vitest": "^2.1.2"
  }
}
```

- [ ] **Step 2: Write tsconfig.json and vitest.config.ts**

`tsconfig.json`:
```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "outDir": "dist",
    "rootDir": "src",
    "jsx": "react-jsx",
    "types": ["node"],
    "noUncheckedIndexedAccess": true
  },
  "include": ["src/server/**/*.ts", "src/server/**/*.tsx"]
}
```

`vitest.config.ts`:
```ts
import { defineConfig } from 'vitest/config';
export default defineConfig({
  test: { include: ['tests/**/*.test.ts'], testTimeout: 20000, pool: 'forks' },
});
```

- [ ] **Step 3: Write tests/helpers.ts and a smoke test**

`tests/helpers.ts`:
```ts
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach } from 'vitest';

const created: string[] = [];
export async function tmpDir(): Promise<string> {
  const d = await mkdtemp(join(tmpdir(), 'og-'));
  created.push(d);
  return d;
}
afterEach(async () => {
  while (created.length) await rm(created.pop()!, { recursive: true, force: true });
});
```

`tests/smoke.test.ts`:
```ts
import { describe, it, expect } from 'vitest';
import { stat } from 'node:fs/promises';
import { tmpDir } from './helpers.js';

describe('harness', () => {
  it('creates a temp dir', async () => {
    const d = await tmpDir();
    expect((await stat(d)).isDirectory()).toBe(true);
  });
});
```

- [ ] **Step 4: Install and run**

Run: `npm install && npm test`
Expected: 1 test passed. (If `sharp` fails to install on the dev Mac, run `npm rebuild sharp`.)

- [ ] **Step 5: Update .gitignore and commit**

Append to `.gitignore`: `dist/`, `.cache/`, `*.db`, `*.db-wal`, `*.db-shm`, `coverage/`.

```bash
git add package.json package-lock.json tsconfig.json vitest.config.ts tests .gitignore
git commit -m "chore: scaffold TypeScript project with vitest harness"
```

---

### Task 2: Config from environment

**Files:**
- Create: `src/server/config.ts`, `tests/config.test.ts`, `.env.example`

**Interfaces:**
- Produces: `loadConfig(env: NodeJS.ProcessEnv): Config` and type `Config = { dataDir, photosDir, baseUrl, sessionSecret, port, smtpUrl?, listmonkUrl?, listmonkToken?, secureCookies }`.

- [ ] **Step 1: Write the failing test**

`tests/config.test.ts`:
```ts
import { describe, it, expect } from 'vitest';
import { loadConfig } from '../src/server/config.js';

const base = { DATA_DIR: '/tmp/d', PHOTOS_DIR: '/tmp/p', BASE_URL: 'https://g.example', SESSION_SECRET: 'x'.repeat(32) };

describe('loadConfig', () => {
  it('parses required values and defaults', () => {
    const c = loadConfig(base);
    expect(c.port).toBe(3000);
    expect(c.secureCookies).toBe(true);
    expect(c.smtpUrl).toBeUndefined();
  });
  it('rejects a short session secret', () => {
    expect(() => loadConfig({ ...base, SESSION_SECRET: 'short' })).toThrow(/SESSION_SECRET/);
  });
  it('turns off secure cookies for http base urls', () => {
    expect(loadConfig({ ...base, BASE_URL: 'http://localhost:3000' }).secureCookies).toBe(false);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run tests/config.test.ts`
Expected: FAIL, cannot find module `../src/server/config.js`.

- [ ] **Step 3: Implement**

`src/server/config.ts`:
```ts
import { z } from 'zod';

const Env = z.object({
  DATA_DIR: z.string().min(1),
  PHOTOS_DIR: z.string().min(1),
  BASE_URL: z.string().url(),
  SESSION_SECRET: z.string().min(32, 'SESSION_SECRET must be at least 32 characters'),
  PORT: z.coerce.number().int().positive().default(3000),
  SMTP_URL: z.string().url().optional(),
  LISTMONK_URL: z.string().url().optional(),
  LISTMONK_TOKEN: z.string().optional(),
});

export type Config = {
  dataDir: string; photosDir: string; baseUrl: string; sessionSecret: string; port: number;
  smtpUrl?: string; listmonkUrl?: string; listmonkToken?: string; secureCookies: boolean;
};

export function loadConfig(env: NodeJS.ProcessEnv): Config {
  const e = Env.parse(env);
  return {
    dataDir: e.DATA_DIR, photosDir: e.PHOTOS_DIR, baseUrl: e.BASE_URL.replace(/\/$/, ''),
    sessionSecret: e.SESSION_SECRET, port: e.PORT, smtpUrl: e.SMTP_URL,
    listmonkUrl: e.LISTMONK_URL, listmonkToken: e.LISTMONK_TOKEN,
    secureCookies: e.BASE_URL.startsWith('https://'),
  };
}
```

`.env.example`:
```
# Required
DATA_DIR=/data
PHOTOS_DIR=/photos
BASE_URL=https://gallery.example.com
SESSION_SECRET=change-me-to-32-plus-random-characters
PORT=3000

# Email transport: set ONE of these. Required before the app is usable.
SMTP_URL=smtp://user:pass@smtp.example.com:587
# LISTMONK_URL=http://listmonk:9000
# LISTMONK_TOKEN=

# Cloudflare tunnel (compose)
CLOUDFLARE_TUNNEL_TOKEN=
```

- [ ] **Step 4: Run tests**

Run: `npx vitest run tests/config.test.ts`
Expected: 3 passed.

- [ ] **Step 5: Commit**

```bash
git add src/server/config.ts tests/config.test.ts .env.example
git commit -m "feat: typed config from environment"
```

---

### Task 3: Database schema, migrations, settings

**Files:**
- Create: `src/server/db/schema.ts`, `src/server/db/client.ts`, `src/server/db/settings.ts`, `drizzle.config.ts`, `src/server/db/migrations/` (generated), `tests/db.test.ts`

**Interfaces:**
- Produces: `openDb(file: string): Db` (`':memory:'` allowed), `migrate(db)`, type `Db`, all table objects from `schema.ts` (`users, clients, projects, photos, picks, slotGrants, favorites, comments, sessions, invoices, reservations, webhookInbox, jobs, events, settings`), `getSetting(db, key)`, `setSetting(db, key, value)`.

- [ ] **Step 1: Write the failing test**

`tests/db.test.ts`:
```ts
import { describe, it, expect } from 'vitest';
import { openDb, migrate } from '../src/server/db/client.js';
import { invoices, projects, clients, jobs } from '../src/server/db/schema.js';
import { getSetting, setSetting } from '../src/server/db/settings.js';

function fresh() { const db = openDb(':memory:'); migrate(db); return db; }

describe('database', () => {
  it('enables foreign keys and WAL-compatible journal', () => {
    const db = fresh();
    expect(db.$client.pragma('foreign_keys', { simple: true })).toBe(1);
  });
  it('allows only one unpaid extras invoice per project', () => {
    const db = fresh();
    db.insert(clients).values({ id: 'c1', folderPath: 'Clients/A', name: 'A', emails: ['a@x'] }).run();
    db.insert(projects).values({ id: 'p1', clientId: 'c1', folderPath: 'Clients/A/P', metadataJson: {} }).run();
    const row = { projectId: 'p1', kind: 'extras' as const, amount: 100, tax: 0, currency: 'usd' };
    db.insert(invoices).values({ id: 'i1', ...row }).run();
    expect(() => db.insert(invoices).values({ id: 'i2', ...row }).run()).toThrow(/UNIQUE/);
    db.insert(invoices).values({ id: 'i3', ...row, paidAt: new Date().toISOString(), paidAmount: 100 }).run();
  });
  it('rejects duplicate job idempotency keys', () => {
    const db = fresh();
    db.insert(jobs).values({ id: 'j1', kind: 'x', payload: {}, idempotencyKey: 'k', nextAt: 0 }).run();
    expect(() => db.insert(jobs).values({ id: 'j2', kind: 'x', payload: {}, idempotencyKey: 'k', nextAt: 0 }).run()).toThrow(/UNIQUE/);
  });
  it('stores settings', () => {
    const db = fresh();
    setSetting(db, 'studioName', 'Test Studio');
    expect(getSetting(db, 'studioName')).toBe('Test Studio');
    expect(getSetting(db, 'missing')).toBeNull();
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run tests/db.test.ts`
Expected: FAIL, missing modules.

- [ ] **Step 3: Write the schema**

`src/server/db/schema.ts`:
```ts
import { sqliteTable, text, integer, real, uniqueIndex, index } from 'drizzle-orm/sqlite-core';
import { sql } from 'drizzle-orm';

const now = () => sql`(strftime('%Y-%m-%dT%H:%M:%fZ','now'))`;

export const users = sqliteTable('users', {
  id: text('id').primaryKey(),
  email: text('email').notNull().unique(),
  name: text('name').notNull().default(''),
  role: text('role', { enum: ['owner', 'member'] }).notNull(),
  notifyDownloads: text('notify_downloads', { enum: ['off', 'digest', 'each'] }).notNull().default('digest'),
  createdAt: text('created_at').notNull().default(now()),
});

export const clients = sqliteTable('clients', {
  id: text('id').primaryKey(),
  folderPath: text('folder_path').notNull(),            // relative to PHOTOS_DIR
  available: integer('available', { mode: 'boolean' }).notNull().default(true),
  stateVersion: integer('state_version').notNull().default(1),
  name: text('name').notNull(),
  emails: text('emails', { mode: 'json' }).$type<string[]>().notNull(),
  stripeCustomerId: text('stripe_customer_id'),
  listmonkSubscriberId: integer('listmonk_subscriber_id'),
  referralCode: text('referral_code'),
}, (t) => ({ folderIdx: uniqueIndex('clients_folder').on(t.folderPath) }));

export const projects = sqliteTable('projects', {
  id: text('id').primaryKey(),
  clientId: text('client_id').notNull().references(() => clients.id),
  folderPath: text('folder_path').notNull(),
  available: integer('available', { mode: 'boolean' }).notNull().default(true),
  transferPending: integer('transfer_pending', { mode: 'boolean' }).notNull().default(false),
  stateVersion: integer('state_version').notNull().default(1),
  bookingState: text('booking_state').notNull().default('inquiry'),
  productionState: text('production_state').notNull().default('not_started'),
  archivedAt: text('archived_at'),
  date: text('date'),
  currentRound: integer('current_round').notNull().default(1),
  metadataJson: text('metadata_json', { mode: 'json' }).$type<Record<string, unknown>>().notNull(),
}, (t) => ({ folderIdx: uniqueIndex('projects_folder').on(t.folderPath) }));

export const photos = sqliteTable('photos', {
  id: text('id').primaryKey(),
  projectId: text('project_id').notNull().references(() => projects.id),
  relPath: text('rel_path').notNull(),                  // relative to project folder
  draftRelPath: text('draft_rel_path'),
  stage: text('stage', { enum: ['culling', 'final'] }).notNull(),
  kind: text('kind', { enum: ['photo', 'video'] }).notNull(),
  sourcePhotoId: text('source_photo_id'),
  checksum: text('checksum').notNull(),
  width: integer('width'), height: integer('height'),
  capturedAt: text('captured_at'),
  sortOrder: integer('sort_order').notNull().default(0),
  section: text('section'),
  editState: text('edit_state', { enum: ['none', 'editing', 'done'] }).notNull().default('none'),
  missing: integer('missing', { mode: 'boolean' }).notNull().default(false),
}, (t) => ({ pathIdx: uniqueIndex('photos_project_path').on(t.projectId, t.relPath) }));

export const picks = sqliteTable('picks', {
  projectId: text('project_id').notNull().references(() => projects.id),
  photoId: text('photo_id').notNull().references(() => photos.id),
  round: integer('round').notNull(),
  byEmail: text('by_email').notNull(),
  pickedAt: text('picked_at').notNull().default(now()),
  state: text('state', { enum: ['confirmed', 'pending'] }).notNull().default('pending'),
}, (t) => ({ one: uniqueIndex('picks_project_photo').on(t.projectId, t.photoId) }));

export const slotGrants = sqliteTable('slot_grants', {
  id: text('id').primaryKey(),
  projectId: text('project_id').notNull().references(() => projects.id),
  delta: integer('delta').notNull(),
  reason: text('reason', { enum: ['purchase', 'gift', 'refund', 'release'] }).notNull(),
  reference: text('reference'),
  actor: text('actor').notNull(),
  at: text('at').notNull().default(now()),
}, (t) => ({ ref: uniqueIndex('slot_grants_reference').on(t.reference) }));

export const favorites = sqliteTable('favorites', {
  photoId: text('photo_id').notNull().references(() => photos.id),
  sessionId: text('session_id').notNull(),
}, (t) => ({ one: uniqueIndex('favorites_one').on(t.photoId, t.sessionId) }));

export const comments = sqliteTable('comments', {
  id: text('id').primaryKey(),
  photoId: text('photo_id').notNull().references(() => photos.id),
  author: text('author').notNull(),
  stage: text('stage', { enum: ['culling', 'final'] }).notNull(),
  x: real('x'), y: real('y'), w: real('w'), h: real('h'), t: real('t'),
  text: text('text').notNull(),
  createdAt: text('created_at').notNull().default(now()),
  resolvedAt: text('resolved_at'),
});

export const sessions = sqliteTable('sessions', {
  id: text('id').primaryKey(),
  kind: text('kind', { enum: ['client', 'admin', 'guest', 'plugin', 'mcp'] }).notNull(),
  subject: text('subject').notNull(),                   // email, or guest nickname
  projectId: text('project_id'),
  scope: text('scope').notNull().default('read'),
  loginTokenHash: text('login_token_hash'),             // magic link, cleared on redeem
  tokenHash: text('token_hash'),                        // session/bearer token
  expiresAt: text('expires_at').notNull(),
  redeemedAt: text('redeemed_at'),
  nickname: text('nickname'),
  createdAt: text('created_at').notNull().default(now()),
}, (t) => ({ login: uniqueIndex('sessions_login_token').on(t.loginTokenHash), tok: uniqueIndex('sessions_token').on(t.tokenHash) }));

export const invoices = sqliteTable('invoices', {
  id: text('id').primaryKey(),
  projectId: text('project_id').notNull().references(() => projects.id),
  kind: text('kind', { enum: ['deposit', 'balance', 'final', 'extras', 'package', 'adjustment'] }).notNull(),
  amount: integer('amount').notNull(),
  tax: integer('tax').notNull().default(0),
  currency: text('currency').notNull(),
  stripeId: text('stripe_id'),
  paidAmount: integer('paid_amount').notNull().default(0),
  paidAt: text('paid_at'),
  paidVia: text('paid_via', { enum: ['stripe', 'manual'] }),
  refundedAmount: integer('refunded_amount').notNull().default(0),
  needsReview: integer('needs_review', { mode: 'boolean' }).notNull().default(false),
  voidedAt: text('voided_at'),
  createdAt: text('created_at').notNull().default(now()),
}, (t) => ({
  oneOpenExtras: uniqueIndex('invoices_one_open_extras').on(t.projectId).where(sql`kind = 'extras' AND paid_at IS NULL AND voided_at IS NULL`),
}));

export const reservations = sqliteTable('reservations', {
  id: text('id').primaryKey(),
  projectId: text('project_id').notNull().references(() => projects.id),
  kind: text('kind', { enum: ['call', 'shoot'] }).notNull(),
  adminId: text('admin_id'),
  startsAt: text('starts_at').notNull(), endsAt: text('ends_at').notNull(),
  localDate: text('local_date').notNull(),
  state: text('state', { enum: ['held', 'confirmed', 'expired', 'cancelled'] }).notNull(),
  expiresAt: text('expires_at'),
}, (t) => ({ byDate: index('reservations_date').on(t.localDate, t.state) }));

export const webhookInbox = sqliteTable('webhook_inbox', {
  provider: text('provider').notNull(),
  eventId: text('event_id').notNull(),
  objectId: text('object_id'),
  payload: text('payload', { mode: 'json' }).$type<unknown>().notNull(),
  state: text('state', { enum: ['received', 'applied'] }).notNull().default('received'),
  receivedAt: text('received_at').notNull().default(now()),
}, (t) => ({ one: uniqueIndex('inbox_provider_event').on(t.provider, t.eventId) }));

export const jobs = sqliteTable('jobs', {
  id: text('id').primaryKey(),
  kind: text('kind').notNull(),
  payload: text('payload', { mode: 'json' }).$type<unknown>().notNull(),
  idempotencyKey: text('idempotency_key'),
  attempts: integer('attempts').notNull().default(0),
  nextAt: integer('next_at').notNull(),                 // epoch ms
  leasedUntil: integer('leased_until'),
  state: text('state', { enum: ['pending', 'running', 'done', 'failed', 'needs_review'] }).notNull().default('pending'),
  lastError: text('last_error'),
  createdAt: text('created_at').notNull().default(now()),
}, (t) => ({ key: uniqueIndex('jobs_idempotency').on(t.idempotencyKey), due: index('jobs_due').on(t.state, t.nextAt) }));

export const events = sqliteTable('events', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  projectId: text('project_id'),
  actor: text('actor').notNull(),
  type: text('type').notNull(),
  payload: text('payload', { mode: 'json' }).$type<unknown>().notNull().default({}),
  at: text('at').notNull().default(now()),
}, (t) => ({ byProject: index('events_project').on(t.projectId, t.at) }));

export const settings = sqliteTable('settings', {
  key: text('key').primaryKey(),
  value: text('value', { mode: 'json' }).$type<unknown>().notNull(),
});
```

- [ ] **Step 4: Write client.ts, settings.ts, drizzle.config.ts and generate the migration**

`src/server/db/client.ts`:
```ts
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
```

`src/server/db/settings.ts`:
```ts
import { eq } from 'drizzle-orm';
import type { Db } from './client.js';
import { settings } from './schema.js';

export function getSetting<T = unknown>(db: Db, key: string): T | null {
  const row = db.select().from(settings).where(eq(settings.key, key)).get();
  return row ? (row.value as T) : null;
}
export function setSetting(db: Db, key: string, value: unknown): void {
  db.insert(settings).values({ key, value }).onConflictDoUpdate({ target: settings.key, set: { value } }).run();
}
```

`drizzle.config.ts`:
```ts
import { defineConfig } from 'drizzle-kit';
export default defineConfig({ dialect: 'sqlite', schema: './src/server/db/schema.ts', out: './src/server/db/migrations' });
```

Run: `npm run db:generate`
Expected: `src/server/db/migrations/0000_*.sql` and `meta/` created. Open the SQL and confirm it contains `CREATE UNIQUE INDEX "invoices_one_open_extras" ... WHERE kind = 'extras' AND paid_at IS NULL AND voided_at IS NULL`. Migrations are copied to `dist/` by the build (Task 17 adds the copy step); tests read them from `src/`.

- [ ] **Step 5: Run tests**

Run: `npx vitest run tests/db.test.ts`
Expected: 4 passed.

- [ ] **Step 6: Commit**

```bash
git add src/server/db drizzle.config.ts tests/db.test.ts
git commit -m "feat: sqlite schema, migrations, settings store"
```

---

### Task 4: Safe path resolution

**Files:**
- Create: `src/server/fs/paths.ts`, `tests/fs/paths.test.ts`

**Interfaces:**
- Produces: `resolveInside(root: string, rel: string): Promise<string>` (absolute path, throws `PathError` on traversal or symlink escape), `isReserved(rel: string): boolean`, `RESERVED_DIRS = ['.draft', '.cache', '.trash']`, `class PathError extends Error`.

- [ ] **Step 1: Write the failing test**

`tests/fs/paths.test.ts`:
```ts
import { describe, it, expect } from 'vitest';
import { mkdir, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpDir } from '../helpers.js';
import { resolveInside, isReserved, PathError } from '../../src/server/fs/paths.js';

describe('resolveInside', () => {
  it('resolves a normal relative path', async () => {
    const root = await tmpDir();
    await mkdir(join(root, 'Clients/A'), { recursive: true });
    expect(await resolveInside(root, 'Clients/A')).toBe(join(root, 'Clients/A'));
  });
  it('rejects traversal', async () => {
    const root = await tmpDir();
    await expect(resolveInside(root, '../etc/passwd')).rejects.toBeInstanceOf(PathError);
    await expect(resolveInside(root, 'Clients/../../x')).rejects.toBeInstanceOf(PathError);
    await expect(resolveInside(root, '/absolute')).rejects.toBeInstanceOf(PathError);
  });
  it('rejects a symlink that escapes the root', async () => {
    const root = await tmpDir();
    const outside = await tmpDir();
    await writeFile(join(outside, 'secret'), 'x');
    await symlink(outside, join(root, 'link'));
    await expect(resolveInside(root, 'link/secret')).rejects.toBeInstanceOf(PathError);
  });
  it('allows a path whose leaf does not exist yet', async () => {
    const root = await tmpDir();
    expect(await resolveInside(root, 'Clients/new.json')).toBe(join(root, 'Clients/new.json'));
  });
  it('knows reserved directories', () => {
    expect(isReserved('Clients/A/P/.draft/x.jpg')).toBe(true);
    expect(isReserved('Clients/A/P/finals/x.jpg')).toBe(false);
    expect(isReserved('.trash')).toBe(true);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run tests/fs/paths.test.ts`
Expected: FAIL, missing module.

- [ ] **Step 3: Implement**

`src/server/fs/paths.ts`:
```ts
import { realpath } from 'node:fs/promises';
import { isAbsolute, join, normalize, relative, resolve, sep, dirname } from 'node:path';

export const RESERVED_DIRS = ['.draft', '.cache', '.trash'] as const;
export class PathError extends Error { constructor(msg: string) { super(msg); this.name = 'PathError'; } }

export function isReserved(rel: string): boolean {
  return normalize(rel).split(sep).some((p) => (RESERVED_DIRS as readonly string[]).includes(p));
}

/** Resolve `rel` under `root`; the deepest existing ancestor must realpath inside `root`. */
export async function resolveInside(root: string, rel: string): Promise<string> {
  if (isAbsolute(rel)) throw new PathError('absolute path not allowed');
  const abs = resolve(root, normalize(rel));
  const rootAbs = resolve(root);
  const inside = (p: string) => { const r = relative(rootAbs, p); return r === '' || (!r.startsWith('..') && !isAbsolute(r)); };
  if (!inside(abs)) throw new PathError(`escapes root: ${rel}`);
  // walk up to the deepest existing path and realpath it (symlink check)
  let probe = abs;
  for (;;) {
    try { const real = await realpath(probe); if (!inside(real) && real !== await realpath(rootAbs)) throw new PathError(`symlink escapes root: ${rel}`); break; }
    catch (e) { if (e instanceof PathError) throw e; const up = dirname(probe); if (up === probe) break; probe = up; }
  }
  return abs;
}

export function projectRel(root: string, abs: string): string { return relative(resolve(root), abs).split(sep).join('/'); }
export { join };
```

- [ ] **Step 4: Run tests**

Run: `npx vitest run tests/fs/paths.test.ts`
Expected: 5 passed.

- [ ] **Step 5: Commit**

```bash
git add src/server/fs/paths.ts tests/fs/paths.test.ts
git commit -m "feat: safe path resolution with traversal and symlink checks"
```

---

### Task 5: IDs, atomic JSON, and the two file schemas

**Files:**
- Create: `src/server/fs/ids.ts`, `src/server/fs/json.ts`, `src/server/fs/schemas.ts`, `tests/fs/json.test.ts`, `tests/fs/schemas.test.ts`

**Interfaces:**
- Produces: `newId(): string`; `readJson<T>(file: string, schema: ZodType<T>): Promise<{ ok: true, data: T } | { ok: false, error: string, missing?: boolean }>`; `writeJsonAtomic(file: string, data: unknown): Promise<void>`; zod schemas `ClientJson`, `ProjectJson` with inferred types; `MACHINE_FIELDS: readonly (keyof ProjectJson)[]`; `defaultClientJson(name)`, `defaultProjectJson(title)`; `splitFields(p: ProjectJson): { human: Partial<ProjectJson>, machine: Partial<ProjectJson> }`.

- [ ] **Step 1: Write the failing tests**

`tests/fs/json.test.ts`:
```ts
import { describe, it, expect } from 'vitest';
import { readFile, readdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';
import { tmpDir } from '../helpers.js';
import { readJson, writeJsonAtomic } from '../../src/server/fs/json.js';

const S = z.object({ a: z.number() });
describe('json', () => {
  it('writes atomically and leaves no temp file', async () => {
    const d = await tmpDir();
    await writeJsonAtomic(join(d, 'x.json'), { a: 1 });
    expect(JSON.parse(await readFile(join(d, 'x.json'), 'utf8'))).toEqual({ a: 1 });
    expect(await readdir(d)).toEqual(['x.json']);
  });
  it('reads and validates', async () => {
    const d = await tmpDir();
    await writeFile(join(d, 'bad.json'), '{ not json');
    await writeFile(join(d, 'wrong.json'), '{"a":"str"}');
    expect((await readJson(join(d, 'bad.json'), S)).ok).toBe(false);
    expect((await readJson(join(d, 'wrong.json'), S)).ok).toBe(false);
    const missing = await readJson(join(d, 'none.json'), S);
    expect(missing.ok === false && missing.missing).toBe(true);
    await writeJsonAtomic(join(d, 'ok.json'), { a: 2 });
    const r = await readJson(join(d, 'ok.json'), S);
    expect(r.ok && r.data.a).toBe(2);
  });
});
```

`tests/fs/schemas.test.ts`:
```ts
import { describe, it, expect } from 'vitest';
import { ProjectJson, ClientJson, defaultProjectJson, defaultClientJson, splitFields, MACHINE_FIELDS } from '../../src/server/fs/schemas.js';

describe('schemas', () => {
  it('defaults are valid and carry ids', () => {
    const p = ProjectJson.parse(defaultProjectJson('Wedding'));
    expect(p.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(p.folders).toEqual({ culling: 'raw', finals: 'finals' });
    const c = ClientJson.parse(defaultClientJson('Smith'));
    expect(c.emails).toEqual([]);
  });
  it('accepts a file without an id (assigned later)', () => {
    const r = ProjectJson.safeParse({ schemaVersion: 1, title: 'X' });
    expect(r.success).toBe(true);
  });
  it('rejects unknown schema versions', () => {
    expect(ProjectJson.safeParse({ schemaVersion: 9, title: 'X' }).success).toBe(false);
  });
  it('splits human from machine fields', () => {
    const p = ProjectJson.parse(defaultProjectJson('X'));
    const { human, machine } = splitFields(p);
    expect(Object.keys(machine).sort()).toEqual([...MACHINE_FIELDS].sort());
    expect(human).toHaveProperty('title');
    expect(human).not.toHaveProperty('id');
  });
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `npx vitest run tests/fs`
Expected: FAIL, missing modules.

- [ ] **Step 3: Implement**

`src/server/fs/ids.ts`:
```ts
import { randomUUID } from 'node:crypto';
export function newId(): string { return randomUUID(); }
```

`src/server/fs/json.ts`:
```ts
import { readFile, writeFile, rename, unlink } from 'node:fs/promises';
import { dirname, join, basename } from 'node:path';
import { randomBytes } from 'node:crypto';
import type { ZodType } from 'zod';

export type ReadResult<T> = { ok: true; data: T } | { ok: false; error: string; missing?: boolean };

export async function readJson<T>(file: string, schema: ZodType<T>): Promise<ReadResult<T>> {
  let raw: string;
  try { raw = await readFile(file, 'utf8'); }
  catch (e) { const code = (e as NodeJS.ErrnoException).code; return { ok: false, error: String(e), missing: code === 'ENOENT' }; }
  let parsed: unknown;
  try { parsed = JSON.parse(raw); } catch (e) { return { ok: false, error: `invalid JSON: ${(e as Error).message}` }; }
  const r = schema.safeParse(parsed);
  return r.success ? { ok: true, data: r.data } : { ok: false, error: r.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ') };
}

export async function writeJsonAtomic(file: string, data: unknown): Promise<void> {
  const tmp = join(dirname(file), `.${basename(file)}.${randomBytes(4).toString('hex')}.tmp`);
  try { await writeFile(tmp, JSON.stringify(data, null, 2) + '\n', 'utf8'); await rename(tmp, file); }
  catch (e) { await unlink(tmp).catch(() => {}); throw e; }
}
```

`src/server/fs/schemas.ts`:
```ts
import { z } from 'zod';
import { newId } from './ids.js';

export const ClientJson = z.object({
  schemaVersion: z.literal(1),
  id: z.string().uuid().optional(),
  stateVersion: z.number().int().default(1),
  name: z.string().min(1),
  emails: z.array(z.string().email()).default([]),
  phone: z.string().default(''),
  stripeCustomerId: z.string().nullable().default(null),
  listmonkSubscriberId: z.number().nullable().default(null),
  referralCode: z.string().nullable().default(null),
  notes: z.string().default(''),
});
export type ClientJson = z.infer<typeof ClientJson>;

export const ProjectJson = z.object({
  schemaVersion: z.literal(1),
  id: z.string().uuid().optional(),
  stateVersion: z.number().int().default(1),
  title: z.string().min(1),
  state: z.object({ booking: z.string(), production: z.string(), archivedAt: z.string().nullable() })
    .default({ booking: 'inquiry', production: 'not_started', archivedAt: null }),
  date: z.string().nullable().default(null),
  package: z.string().nullable().default(null),
  assignedTo: z.string().nullable().default(null),
  folders: z.object({ culling: z.string(), finals: z.string() }).default({ culling: 'raw', finals: 'finals' }),
  allowance: z.object({ included: z.number().int().min(0), extraPrice: z.number().int().min(0), slots: z.number().int().min(0) })
    .default({ included: 0, extraPrice: 0, slots: 0 }),
  downloads: z.enum(['client', 'password', 'none']).default('client'),
  comments: z.object({ culling: z.boolean(), finals: z.boolean() }).default({ culling: true, finals: true }),
  notifyOnPublish: z.boolean().default(false),
  sharePassword: z.string().nullable().default(null),
  music: z.string().nullable().default(null),
  cover: z.string().nullable().default(null),
  expiresAt: z.string().nullable().default(null),
  offers: z.record(z.boolean()).default({}),
  portfolioRelease: z.boolean().default(false),
  showOffers: z.boolean().default(true),
  integrations: z.object({ docusealSubmissionId: z.string().nullable() }).default({ docusealSubmissionId: null }),
});
export type ProjectJson = z.infer<typeof ProjectJson>;

export const MACHINE_FIELDS = ['id', 'schemaVersion', 'stateVersion', 'state', 'allowance', 'sharePassword', 'integrations'] as const satisfies readonly (keyof ProjectJson)[];

export function defaultClientJson(name: string): ClientJson { return ClientJson.parse({ schemaVersion: 1, id: newId(), name }); }
export function defaultProjectJson(title: string): ProjectJson { return ProjectJson.parse({ schemaVersion: 1, id: newId(), title }); }

export function splitFields(p: ProjectJson): { human: Partial<ProjectJson>; machine: Partial<ProjectJson> } {
  const human: Record<string, unknown> = {}; const machine: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(p)) ((MACHINE_FIELDS as readonly string[]).includes(k) ? machine : human)[k] = v;
  return { human: human as Partial<ProjectJson>, machine: machine as Partial<ProjectJson> };
}
```

- [ ] **Step 4: Run tests**

Run: `npx vitest run tests/fs`
Expected: all passed (paths + json + schemas).

- [ ] **Step 5: Commit**

```bash
git add src/server/fs/ids.ts src/server/fs/json.ts src/server/fs/schemas.ts tests/fs/json.test.ts tests/fs/schemas.test.ts
git commit -m "feat: ids, atomic json, client/project file schemas"
```

---

### Task 6: Rescan — clients and projects by stable ID

**Files:**
- Create: `src/server/fs/index.ts`, `tests/fs/index.test.ts`

**Interfaces:**
- Consumes: `openDb/migrate`, `readJson/writeJsonAtomic`, `ClientJson/ProjectJson/MACHINE_FIELDS`, `newId`, `resolveInside`.
- Produces:
  - `rescan(db: Db, photosDir: string): Promise<RescanReport>` where `RescanReport = { clients: number; projects: number; issues: Issue[] }` and `Issue = { kind: 'malformed' | 'wrong_depth' | 'duplicate_id' | 'missing' | 'transfer_pending' | 'machine_field_edited'; path: string; id?: string; detail?: string }`.
  - `approveTransfer(db: Db, projectId: string, actor: string): void`.
  - `currentIssues(): Issue[]` (module-level, replaced on each rescan; recomputed on startup, never persisted).
  - `projectDir(photosDir, row)` helper returning the absolute folder for a project row.

- [ ] **Step 1: Write the failing tests**

`tests/fs/index.test.ts`:
```ts
import { describe, it, expect } from 'vitest';
import { mkdir, rename, writeFile, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { eq } from 'drizzle-orm';
import { tmpDir } from '../helpers.js';
import { openDb, migrate } from '../../src/server/db/client.js';
import { clients, projects, photos } from '../../src/server/db/schema.js';
import { rescan, approveTransfer } from '../../src/server/fs/index.js';
import { defaultClientJson, defaultProjectJson } from '../../src/server/fs/schemas.js';
import { writeJsonAtomic } from '../../src/server/fs/json.js';

async function seed(root: string) {
  const c = defaultClientJson('Smith'); const p = defaultProjectJson('Wedding');
  await mkdir(join(root, 'Clients/Smith/Wedding/raw'), { recursive: true });
  await writeJsonAtomic(join(root, 'Clients/Smith/client.json'), c);
  await writeJsonAtomic(join(root, 'Clients/Smith/Wedding/project.json'), p);
  return { c, p };
}
function fresh() { const db = openDb(':memory:'); migrate(db); return db; }

describe('rescan', () => {
  it('indexes a client and project by id', async () => {
    const root = await tmpDir(); const db = fresh(); const { c, p } = await seed(root);
    const r = await rescan(db, root);
    expect(r.clients).toBe(1); expect(r.projects).toBe(1); expect(r.issues).toEqual([]);
    expect(db.select().from(projects).where(eq(projects.id, p.id!)).get()?.folderPath).toBe('Clients/Smith/Wedding');
    expect(db.select().from(clients).where(eq(clients.id, c.id!)).get()?.folderPath).toBe('Clients/Smith');
  });
  it('assigns an id to a hand-dropped file and writes it back', async () => {
    const root = await tmpDir(); const db = fresh();
    await mkdir(join(root, 'Clients/Jones/Shoot'), { recursive: true });
    await writeFile(join(root, 'Clients/Jones/client.json'), JSON.stringify({ schemaVersion: 1, name: 'Jones' }));
    await writeFile(join(root, 'Clients/Jones/Shoot/project.json'), JSON.stringify({ schemaVersion: 1, title: 'Shoot' }));
    await rescan(db, root);
    const back = JSON.parse(await readFile(join(root, 'Clients/Jones/Shoot/project.json'), 'utf8'));
    expect(back.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(db.select().from(projects).all()[0]?.id).toBe(back.id);
  });
  it('keeps identity and child rows across a rename made while stopped', async () => {
    const root = await tmpDir(); const db = fresh(); const { p } = await seed(root);
    await rescan(db, root);
    db.insert(photos).values({ id: 'ph1', projectId: p.id!, relPath: 'raw/a.nef', stage: 'culling', kind: 'photo', checksum: 'x' }).run();
    await rename(join(root, 'Clients/Smith'), join(root, 'Clients/Smith Family'));
    await rename(join(root, 'Clients/Smith Family/Wedding'), join(root, 'Clients/Smith Family/Wedding 2026'));
    const r = await rescan(db, root);
    expect(r.issues).toEqual([]);
    const row = db.select().from(projects).where(eq(projects.id, p.id!)).get()!;
    expect(row.folderPath).toBe('Clients/Smith Family/Wedding 2026'); expect(row.available).toBe(true);
    expect(db.select().from(photos).where(eq(photos.projectId, p.id!)).all()).toHaveLength(1);
    expect(db.select().from(projects).all()).toHaveLength(1);
  });
  it('marks a missing folder unavailable instead of deleting it', async () => {
    const root = await tmpDir(); const db = fresh(); const { p } = await seed(root);
    await rescan(db, root);
    await rm(join(root, 'Clients/Smith/Wedding'), { recursive: true });
    const r = await rescan(db, root);
    expect(r.issues.map((i) => i.kind)).toContain('missing');
    expect(db.select().from(projects).where(eq(projects.id, p.id!)).get()?.available).toBe(false);
  });
  it('quarantines duplicate ids', async () => {
    const root = await tmpDir(); const db = fresh(); const { p } = await seed(root);
    await rescan(db, root);
    await mkdir(join(root, 'Clients/Smith/Wedding copy'), { recursive: true });
    await writeJsonAtomic(join(root, 'Clients/Smith/Wedding copy/project.json'), p);
    const r = await rescan(db, root);
    expect(r.issues.filter((i) => i.kind === 'duplicate_id')).toHaveLength(2);
    expect(db.select().from(projects).where(eq(projects.id, p.id!)).get()?.available).toBe(false);
  });
  it('flags wrong depth and does not index it', async () => {
    const root = await tmpDir(); const db = fresh();
    await mkdir(join(root, 'Clients/Loose'), { recursive: true });
    await writeJsonAtomic(join(root, 'Clients/Loose/project.json'), defaultProjectJson('Loose'));
    const r = await rescan(db, root);
    expect(r.issues[0]?.kind).toBe('wrong_depth');
    expect(db.select().from(projects).all()).toHaveLength(0);
  });
  it('holds a cross-client move until approved', async () => {
    const root = await tmpDir(); const db = fresh(); const { p } = await seed(root);
    await mkdir(join(root, 'Clients/Other'), { recursive: true });
    await writeJsonAtomic(join(root, 'Clients/Other/client.json'), defaultClientJson('Other'));
    await rescan(db, root);
    await rename(join(root, 'Clients/Smith/Wedding'), join(root, 'Clients/Other/Wedding'));
    const r = await rescan(db, root);
    expect(r.issues.map((i) => i.kind)).toContain('transfer_pending');
    let row = db.select().from(projects).where(eq(projects.id, p.id!)).get()!;
    expect(row.available).toBe(false); expect(row.transferPending).toBe(true);
    approveTransfer(db, p.id!, 'owner@x');
    row = db.select().from(projects).where(eq(projects.id, p.id!)).get()!;
    expect(row.available).toBe(true);
    expect(db.select().from(clients).where(eq(clients.id, row.clientId)).get()?.name).toBe('Other');
  });
  it('restores an externally edited machine field and reports it', async () => {
    const root = await tmpDir(); const db = fresh(); const { p } = await seed(root);
    await rescan(db, root);
    const file = join(root, 'Clients/Smith/Wedding/project.json');
    const edited = { ...p, allowance: { included: 999, extraPrice: 0, slots: 999 }, title: 'Renamed by hand' };
    await writeJsonAtomic(file, edited);
    const r = await rescan(db, root);
    expect(r.issues.map((i) => i.kind)).toContain('machine_field_edited');
    const back = JSON.parse(await readFile(file, 'utf8'));
    expect(back.allowance.included).toBe(0);      // restored from db
    expect(back.title).toBe('Renamed by hand');    // human field kept
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run tests/fs/index.test.ts`
Expected: FAIL, missing module.

- [ ] **Step 3: Implement**

`src/server/fs/index.ts`:
```ts
import { readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { eq, sql } from 'drizzle-orm';
import type { Db } from '../db/client.js';
import { clients, projects, events } from '../db/schema.js';
import { readJson, writeJsonAtomic } from './json.js';
import { ClientJson, ProjectJson, MACHINE_FIELDS, splitFields } from './schemas.js';
import { newId } from './ids.js';

export type Issue = { kind: 'malformed' | 'wrong_depth' | 'duplicate_id' | 'missing' | 'transfer_pending' | 'machine_field_edited'; path: string; id?: string; detail?: string };
export type RescanReport = { clients: number; projects: number; issues: Issue[] };

let issues: Issue[] = [];
export function currentIssues(): Issue[] { return issues; }
export function projectDir(photosDir: string, row: { folderPath: string }): string { return join(photosDir, row.folderPath); }

async function subdirs(abs: string): Promise<string[]> {
  try { return (await readdir(abs, { withFileTypes: true })).filter((d) => d.isDirectory() && !d.name.startsWith('.')).map((d) => d.name); }
  catch { return []; }
}
async function exists(p: string) { return stat(p).then(() => true, () => false); }

type Found<T> = { rel: string; abs: string; data: T };

export async function rescan(db: Db, photosDir: string): Promise<RescanReport> {
  const found: Issue[] = [];
  const clientsRoot = join(photosDir, 'Clients');
  const seenClients: Found<ClientJson>[] = [];
  const seenProjects: (Found<ProjectJson> & { clientId: string })[] = [];

  for (const cname of await subdirs(clientsRoot)) {
    const cabs = join(clientsRoot, cname); const crel = `Clients/${cname}`;
    if (await exists(join(cabs, 'project.json'))) { found.push({ kind: 'wrong_depth', path: crel, detail: 'project.json directly under Clients/' }); continue; }
    const cr = await readJson(join(cabs, 'client.json'), ClientJson);
    if (!cr.ok) { if (!cr.missing) found.push({ kind: 'malformed', path: crel, detail: cr.error }); continue; }
    if (!cr.data.id) { cr.data.id = newId(); await writeJsonAtomic(join(cabs, 'client.json'), cr.data); }
    seenClients.push({ rel: crel, abs: cabs, data: cr.data });
    for (const pname of await subdirs(cabs)) {
      const pabs = join(cabs, pname); const prel = `${crel}/${pname}`;
      if (await exists(join(pabs, 'client.json'))) { found.push({ kind: 'wrong_depth', path: prel, detail: 'client.json nested inside a client' }); continue; }
      const pr = await readJson(join(pabs, 'project.json'), ProjectJson);
      if (!pr.ok) { if (!pr.missing) found.push({ kind: 'malformed', path: prel, detail: pr.error }); continue; }
      if (!pr.data.id) { pr.data.id = newId(); await writeJsonAtomic(join(pabs, 'project.json'), pr.data); }
      seenProjects.push({ rel: prel, abs: pabs, data: pr.data, clientId: cr.data.id });
    }
  }

  // duplicate ids → quarantine every location
  const dupe = <T extends { data: { id?: string } }>(list: T[]) => {
    const byId = new Map<string, T[]>();
    for (const f of list) byId.set(f.data.id!, [...(byId.get(f.data.id!) ?? []), f]);
    const bad = new Set<string>();
    for (const [id, fs] of byId) if (fs.length > 1) { bad.add(id); for (const f of fs) found.push({ kind: 'duplicate_id', path: (f as unknown as Found<unknown>).rel, id }); }
    return bad;
  };
  const badClients = dupe(seenClients); const badProjects = dupe(seenProjects);

  const restores: Promise<void>[] = [];
  db.transaction((tx) => {
    const seenClientIds = new Set<string>();
    for (const c of seenClients) {
      if (badClients.has(c.data.id!)) { tx.update(clients).set({ available: false }).where(eq(clients.id, c.data.id!)).run(); continue; }
      seenClientIds.add(c.data.id!);
      tx.insert(clients).values({ id: c.data.id!, folderPath: c.rel, name: c.data.name, emails: c.data.emails, stripeCustomerId: c.data.stripeCustomerId, listmonkSubscriberId: c.data.listmonkSubscriberId, referralCode: c.data.referralCode, available: true })
        .onConflictDoUpdate({ target: clients.id, set: { folderPath: c.rel, name: c.data.name, emails: c.data.emails, available: true } }).run();
    }
    for (const row of tx.select().from(clients).all()) if (!seenClientIds.has(row.id) && row.available) { tx.update(clients).set({ available: false }).where(eq(clients.id, row.id)).run(); found.push({ kind: 'missing', path: row.folderPath, id: row.id }); }

    const seenProjectIds = new Set<string>();
    for (const p of seenProjects) {
      const id = p.data.id!;
      if (badProjects.has(id) || badClients.has(p.clientId)) { tx.update(projects).set({ available: false }).where(eq(projects.id, id)).run(); continue; }
      seenProjectIds.add(id);
      const existing = tx.select().from(projects).where(eq(projects.id, id)).get();
      if (!existing) {
        tx.insert(projects).values({ id, clientId: p.clientId, folderPath: p.rel, date: p.data.date, bookingState: p.data.state.booking, productionState: p.data.state.production, archivedAt: p.data.state.archivedAt, metadataJson: p.data as Record<string, unknown> }).run();
        continue;
      }
      if (existing.clientId !== p.clientId && !existing.transferPending) {
        tx.update(projects).set({ folderPath: p.rel, available: false, transferPending: true, metadataJson: { ...(existing.metadataJson), pendingClientId: p.clientId } }).where(eq(projects.id, id)).run();
        found.push({ kind: 'transfer_pending', path: p.rel, id }); continue;
      }
      if (existing.transferPending) { found.push({ kind: 'transfer_pending', path: p.rel, id }); continue; }
      // machine fields are projections of the db; restore them if the file drifted
      const stored = ProjectJson.parse(existing.metadataJson);
      const projection = { ...stored, id, stateVersion: existing.stateVersion, state: { booking: existing.bookingState, production: existing.productionState, archivedAt: existing.archivedAt } };
      const drift = MACHINE_FIELDS.filter((k) => JSON.stringify(p.data[k]) !== JSON.stringify(projection[k]));
      const merged = { ...projection, ...splitFields(p.data).human };
      if (drift.length) { found.push({ kind: 'machine_field_edited', path: p.rel, id, detail: drift.join(',') }); restores.push(writeJsonAtomic(join(p.abs, 'project.json'), merged)); }
      tx.update(projects).set({ folderPath: p.rel, available: true, date: merged.date, metadataJson: merged as Record<string, unknown> }).where(eq(projects.id, id)).run();
    }
    for (const row of tx.select().from(projects).all()) if (!seenProjectIds.has(row.id) && row.available) { tx.update(projects).set({ available: false }).where(eq(projects.id, row.id)).run(); found.push({ kind: 'missing', path: row.folderPath, id: row.id }); }
  });
  await Promise.all(restores);

  issues = found;
  return { clients: seenClients.length - badClients.size, projects: seenProjects.length - badProjects.size, issues: found };
}

export function approveTransfer(db: Db, projectId: string, actor: string): void {
  db.transaction((tx) => {
    const row = tx.select().from(projects).where(eq(projects.id, projectId)).get();
    if (!row?.transferPending) throw new Error('no transfer pending');
    const meta = row.metadataJson as Record<string, unknown>; const to = meta['pendingClientId'] as string; delete meta['pendingClientId'];
    tx.update(projects).set({ clientId: to, transferPending: false, available: true, stateVersion: sql`${projects.stateVersion} + 1`, metadataJson: meta }).where(eq(projects.id, projectId)).run();
    tx.insert(events).values({ projectId, actor, type: 'transferred', payload: { from: row.clientId, to } }).run();
  });
}
```

better-sqlite3 transactions are synchronous, so file restores are collected in `restores` and awaited after the transaction commits; `rescan` resolves only once they are on disk.

- [ ] **Step 4: Run tests**

Run: `npx vitest run tests/fs/index.test.ts`
Expected: 8 passed.

- [ ] **Step 5: Commit**

```bash
git add src/server/fs/index.ts tests/fs/index.test.ts
git commit -m "feat: rescan clients and projects by stable id with issue reporting"
```

---

### Task 7: Media signatures, quick hash, RAW previews

**Files:**
- Create: `src/server/fs/media.ts`, `src/server/fs/previews.ts`, `tests/fs/media.test.ts`, `tests/fs/previews.test.ts`, `tests/fixtures/make.ts`

**Interfaces:**
- Produces:
  - `sniff(file: string): Promise<Sniffed | null>` where `Sniffed = { kind: 'photo' | 'video' | 'document' | 'audio'; format: 'jpeg' | 'png' | 'heic' | 'raw' | 'mp4' | 'mov' | 'pdf' | 'mp3' | 'm4a' | 'wav' }`. Returns `null` for unsupported or mismatched extension/signature.
  - `quickHash(file: string): Promise<string>` — sha256 over `size:first64KiB:last64KiB`.
  - `extractPreview(src: string, out: string, maxEdge?: number): Promise<{ width: number; height: number }>` — exiftool embedded preview first, sharp decode second, throws `PreviewError` otherwise.
  - `makeThumb(src: string, out: string, maxEdge: number): Promise<void>`.
  - `EXIFTOOL = process.env.EXIFTOOL_PATH ?? 'exiftool'`.
- `tests/fixtures/make.ts` exports `makeJpeg(file, w, h)`, `makeTiffAs(file, ext)`, `writeBytes(file, hex)` for tests.

- [ ] **Step 1: Write fixture helpers and failing tests**

`tests/fixtures/make.ts`:
```ts
import sharp from 'sharp';
import { writeFile } from 'node:fs/promises';
export async function makeJpeg(file: string, w = 64, h = 48) { await sharp({ create: { width: w, height: h, channels: 3, background: '#4a90e2' } }).jpeg().toFile(file); }
export async function makePng(file: string) { await sharp({ create: { width: 8, height: 8, channels: 3, background: '#000' } }).png().toFile(file); }
export async function makeTiffAs(file: string) { await sharp({ create: { width: 32, height: 24, channels: 3, background: '#c33' } }).tiff().toFile(file); }
export async function writeBytes(file: string, hex: string) { await writeFile(file, Buffer.from(hex.replace(/\s+/g, ''), 'hex')); }
```

`tests/fs/media.test.ts`:
```ts
import { describe, it, expect } from 'vitest';
import { join } from 'node:path';
import { writeFile } from 'node:fs/promises';
import { tmpDir } from '../helpers.js';
import { makeJpeg, makePng, makeTiffAs, writeBytes } from '../fixtures/make.js';
import { sniff, quickHash } from '../../src/server/fs/media.js';

describe('sniff', () => {
  it('identifies jpeg, png, tiff-based raw, mp4, pdf, mp3', async () => {
    const d = await tmpDir();
    await makeJpeg(join(d, 'a.jpg')); await makePng(join(d, 'b.png')); await makeTiffAs(join(d, 'c.dng'));
    await writeBytes(join(d, 'd.mp4'), '00000018 66747970 69736f6d 00000200 69736f6d 69736f32');
    await writeFile(join(d, 'e.pdf'), '%PDF-1.4\n%');
    await writeBytes(join(d, 'f.mp3'), '494433 03000000 00');
    expect(await sniff(join(d, 'a.jpg'))).toEqual({ kind: 'photo', format: 'jpeg' });
    expect(await sniff(join(d, 'b.png'))).toEqual({ kind: 'photo', format: 'png' });
    expect(await sniff(join(d, 'c.dng'))).toEqual({ kind: 'photo', format: 'raw' });
    expect(await sniff(join(d, 'd.mp4'))).toEqual({ kind: 'video', format: 'mp4' });
    expect(await sniff(join(d, 'e.pdf'))).toEqual({ kind: 'document', format: 'pdf' });
    expect(await sniff(join(d, 'f.mp3'))).toEqual({ kind: 'audio', format: 'mp3' });
  });
  it('rejects a mismatched extension and unknown types', async () => {
    const d = await tmpDir();
    await makeJpeg(join(d, 'fake.nef'));            // jpeg bytes, raw extension
    await writeFile(join(d, 'x.exe'), 'MZ');
    await writeFile(join(d, 'y.jpg'), 'not an image');
    expect(await sniff(join(d, 'fake.nef'))).toBeNull();
    expect(await sniff(join(d, 'x.exe'))).toBeNull();
    expect(await sniff(join(d, 'y.jpg'))).toBeNull();
  });
});
describe('quickHash', () => {
  it('is stable and changes with content', async () => {
    const d = await tmpDir();
    await makeJpeg(join(d, 'a.jpg')); await makeJpeg(join(d, 'b.jpg'), 65, 48);
    expect(await quickHash(join(d, 'a.jpg'))).toBe(await quickHash(join(d, 'a.jpg')));
    expect(await quickHash(join(d, 'a.jpg'))).not.toBe(await quickHash(join(d, 'b.jpg')));
  });
});
```

`tests/fs/previews.test.ts`:
```ts
import { describe, it, expect } from 'vitest';
import { join } from 'node:path';
import sharp from 'sharp';
import { tmpDir } from '../helpers.js';
import { makeJpeg, makeTiffAs } from '../fixtures/make.js';
import { extractPreview, makeThumb, PreviewError } from '../../src/server/fs/previews.js';

describe('previews', () => {
  it('falls back to sharp for a raw without an embedded preview', async () => {
    const d = await tmpDir(); await makeTiffAs(join(d, 'x.dng'));
    const r = await extractPreview(join(d, 'x.dng'), join(d, 'x.jpg'), 16);
    expect(r).toEqual({ width: 16, height: 12 });
    expect((await sharp(join(d, 'x.jpg')).metadata()).format).toBe('jpeg');
  });
  it('throws PreviewError for an undecodable file', async () => {
    const d = await tmpDir(); await sharp({ create: { width: 2, height: 2, channels: 3, background: '#000' } }).png().toFile(join(d, 'p.png'));
    await expect(extractPreview(join(d, 'missing.cr2'), join(d, 'o.jpg'))).rejects.toBeInstanceOf(PreviewError);
  });
  it('makes a thumbnail', async () => {
    const d = await tmpDir(); await makeJpeg(join(d, 'a.jpg'), 640, 480);
    await makeThumb(join(d, 'a.jpg'), join(d, 't.jpg'), 100);
    expect((await sharp(join(d, 't.jpg')).metadata()).width).toBe(100);
  });
  it.skipIf(!process.env.OPENGALLERY_RAW_FIXTURE)('uses the embedded preview of a real RAW', async () => {
    const d = await tmpDir();
    const r = await extractPreview(process.env.OPENGALLERY_RAW_FIXTURE!, join(d, 'r.jpg'), 2048);
    expect(Math.max(r.width, r.height)).toBeLessThanOrEqual(2048);
  });
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `npx vitest run tests/fs/media.test.ts tests/fs/previews.test.ts`
Expected: FAIL, missing modules. Also run `exiftool -ver`; if missing on the dev Mac, `brew install exiftool`.

- [ ] **Step 3: Implement media.ts**

`src/server/fs/media.ts`:
```ts
import { open, stat } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { extname } from 'node:path';

export type Sniffed = { kind: 'photo' | 'video' | 'document' | 'audio'; format: 'jpeg' | 'png' | 'heic' | 'raw' | 'mp4' | 'mov' | 'pdf' | 'mp3' | 'm4a' | 'wav' };

const RAW_EXT = new Set(['.nef', '.cr2', '.cr3', '.arw', '.dng', '.raf', '.orf', '.rw2', '.pef', '.srw']);
const EXT: Record<string, Sniffed> = {
  '.jpg': { kind: 'photo', format: 'jpeg' }, '.jpeg': { kind: 'photo', format: 'jpeg' }, '.png': { kind: 'photo', format: 'png' },
  '.heic': { kind: 'photo', format: 'heic' }, '.mp4': { kind: 'video', format: 'mp4' }, '.m4v': { kind: 'video', format: 'mp4' },
  '.mov': { kind: 'video', format: 'mov' }, '.pdf': { kind: 'document', format: 'pdf' }, '.mp3': { kind: 'audio', format: 'mp3' },
  '.m4a': { kind: 'audio', format: 'm4a' }, '.wav': { kind: 'audio', format: 'wav' },
};

async function head(file: string, n = 16): Promise<Buffer> {
  const fh = await open(file, 'r'); try { const b = Buffer.alloc(n); const { bytesRead } = await fh.read(b, 0, n, 0); return b.subarray(0, bytesRead); } finally { await fh.close(); }
}
function isTiff(b: Buffer) { return b.length >= 4 && ((b[0] === 0x49 && b[1] === 0x49 && b[2] === 0x2a && b[3] === 0) || (b[0] === 0x4d && b[1] === 0x4d && b[2] === 0 && b[3] === 0x2a)); }
function isFtyp(b: Buffer, brands: string[]) { return b.length >= 12 && b.subarray(4, 8).toString() === 'ftyp' && brands.some((x) => b.subarray(8, 12).toString().startsWith(x)); }

export async function sniff(file: string): Promise<Sniffed | null> {
  const ext = extname(file).toLowerCase(); const b = await head(file);
  if (RAW_EXT.has(ext)) {
    const ok = isTiff(b) || (ext === '.cr3' && isFtyp(b, ['crx'])) || (ext === '.raf' && b.subarray(0, 8).toString() === 'FUJIFILM') || (ext === '.rw2' && b[0] === 0x49 && b[1] === 0x49 && b[2] === 0x55);
    return ok ? { kind: 'photo', format: 'raw' } : null;
  }
  const want = EXT[ext]; if (!want) return null;
  const ok = ({
    jpeg: () => b[0] === 0xff && b[1] === 0xd8, png: () => b.subarray(0, 4).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47])),
    heic: () => isFtyp(b, ['heic', 'heix', 'mif1']), mp4: () => isFtyp(b, ['isom', 'iso2', 'mp41', 'mp42', 'avc1', 'M4V']),
    mov: () => isFtyp(b, ['qt']), pdf: () => b.subarray(0, 4).toString() === '%PDF',
    mp3: () => b.subarray(0, 3).toString() === 'ID3' || (b[0] === 0xff && (b[1]! & 0xe0) === 0xe0), m4a: () => isFtyp(b, ['M4A']),
    wav: () => b.subarray(0, 4).toString() === 'RIFF' && b.subarray(8, 12).toString() === 'WAVE',
  } as Record<Sniffed['format'], () => boolean>)[want.format]();
  return ok ? want : null;
}

/** ponytail: sha256 of size + first/last 64 KiB, not the whole file; full hashing 5,000 RAWs on a NAS is too slow. Upgrade to full hash if collisions ever matter. */
export async function quickHash(file: string): Promise<string> {
  const { size } = await stat(file); const fh = await open(file, 'r');
  try {
    const n = 64 * 1024; const a = Buffer.alloc(Math.min(n, size)); const z = Buffer.alloc(Math.min(n, size));
    await fh.read(a, 0, a.length, 0); await fh.read(z, 0, z.length, Math.max(0, size - z.length));
    return createHash('sha256').update(String(size)).update(a).update(z).digest('hex');
  } finally { await fh.close(); }
}
```

- [ ] **Step 4: Implement previews.ts**

`src/server/fs/previews.ts`:
```ts
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import sharp from 'sharp';

const run = promisify(execFile);
export const EXIFTOOL = process.env.EXIFTOOL_PATH ?? 'exiftool';
export class PreviewError extends Error { constructor(msg: string) { super(msg); this.name = 'PreviewError'; } }

async function embedded(src: string): Promise<Buffer | null> {
  for (const tag of ['JpgFromRaw', 'PreviewImage', 'OtherImage']) {
    try {
      const { stdout } = await run(EXIFTOOL, ['-b', `-${tag}`, src], { encoding: 'buffer', maxBuffer: 64 * 1024 * 1024 });
      if (stdout.length > 1024 && stdout[0] === 0xff && stdout[1] === 0xd8) return stdout;
    } catch { /* tag absent or exiftool missing: fall through */ }
  }
  return null;
}

export async function extractPreview(src: string, out: string, maxEdge = 2048): Promise<{ width: number; height: number }> {
  const input: Buffer | string = (await embedded(src)) ?? src;
  try {
    const info = await sharp(input, { failOn: 'none' }).rotate().resize({ width: maxEdge, height: maxEdge, fit: 'inside', withoutEnlargement: true }).jpeg({ quality: 82 }).toFile(out);
    return { width: info.width, height: info.height };
  } catch (e) { throw new PreviewError(`no usable preview for ${src}: ${(e as Error).message}`); }
}

export async function makeThumb(src: string, out: string, maxEdge: number): Promise<void> {
  await sharp(src, { failOn: 'none' }).rotate().resize({ width: maxEdge, height: maxEdge, fit: 'inside', withoutEnlargement: true }).jpeg({ quality: 75 }).toFile(out);
}
```

- [ ] **Step 5: Run tests**

Run: `npx vitest run tests/fs/media.test.ts tests/fs/previews.test.ts`
Expected: all passed (the real-RAW test skips unless `OPENGALLERY_RAW_FIXTURE` points at a RAW file; run it once manually with a NEF/CR2 from the studio and confirm `exiftool` extraction is what produced it by checking the output is larger than the sharp fallback would give).

- [ ] **Step 6: Commit**

```bash
git add src/server/fs/media.ts src/server/fs/previews.ts tests/fixtures/make.ts tests/fs/media.test.ts tests/fs/previews.test.ts
git commit -m "feat: media signature sniffing, quick hash, RAW preview extraction"
```

---

### Task 8: Job queue, worker, webhook inbox

**Files:**
- Create: `src/server/jobs/queue.ts`, `src/server/jobs/worker.ts`, `src/server/jobs/inbox.ts`, `tests/jobs/queue.test.ts`, `tests/jobs/inbox.test.ts`

**Interfaces:**
- Consumes: `Db`, `jobs`, `webhookInbox` tables, `newId`.
- Produces:
  - `class NeedsReview extends Error`
  - `type Handler = (payload: unknown, ctx: { db: Db; jobId: string }) => Promise<void>`; `type Handlers = Record<string, Handler>`
  - `enqueue(db, opts: { kind: string; payload: unknown; idempotencyKey?: string; runAt?: number }): { id: string; created: boolean }` — a duplicate key returns the existing id with `created: false`.
  - `claimNext(db, now: number, leaseMs = 60_000): JobRow | null`
  - `runOnce(db, handlers, now = Date.now()): Promise<'ran' | 'idle'>`
  - `recoverLeases(db, now: number): number`
  - `BACKOFF_MS = [60_000, 300_000, 1_800_000]`, `MAX_ATTEMPTS = 3`
  - `startWorker(db, handlers, opts: { intervalMs: number }): () => void` (returns stop)
  - `recordWebhook(db, provider: string, eventId: string, objectId: string | null, payload: unknown): boolean` (false when duplicate); `markApplied(db, provider, eventId): void`.

- [ ] **Step 1: Write the failing tests**

`tests/jobs/queue.test.ts`:
```ts
import { describe, it, expect } from 'vitest';
import { eq } from 'drizzle-orm';
import { openDb, migrate } from '../../src/server/db/client.js';
import { jobs } from '../../src/server/db/schema.js';
import { enqueue, runOnce, recoverLeases, claimNext, NeedsReview, BACKOFF_MS } from '../../src/server/jobs/queue.js';

function fresh() { const db = openDb(':memory:'); migrate(db); return db; }
const T0 = 1_700_000_000_000;

describe('jobs', () => {
  it('deduplicates by idempotency key', () => {
    const db = fresh();
    const a = enqueue(db, { kind: 'x', payload: {}, idempotencyKey: 'k1' });
    const b = enqueue(db, { kind: 'x', payload: {}, idempotencyKey: 'k1' });
    expect(a.created).toBe(true); expect(b.created).toBe(false); expect(b.id).toBe(a.id);
  });
  it('runs a job and marks it done', async () => {
    const db = fresh(); const seen: unknown[] = [];
    enqueue(db, { kind: 'echo', payload: { v: 1 } });
    expect(await runOnce(db, { echo: async (p) => { seen.push(p); } }, T0)).toBe('ran');
    expect(seen).toEqual([{ v: 1 }]);
    expect(db.select().from(jobs).get()?.state).toBe('done');
    expect(await runOnce(db, {}, T0)).toBe('idle');
  });
  it('retries with backoff then fails', async () => {
    const db = fresh(); enqueue(db, { kind: 'boom', payload: {} });
    const h = { boom: async () => { throw new Error('nope'); } };
    await runOnce(db, h, T0);
    let row = db.select().from(jobs).get()!;
    expect(row.state).toBe('pending'); expect(row.attempts).toBe(1); expect(row.nextAt).toBe(T0 + BACKOFF_MS[0]!); expect(row.lastError).toMatch(/nope/);
    expect(await runOnce(db, h, T0 + 1)).toBe('idle');           // not due yet
    await runOnce(db, h, row.nextAt); await runOnce(db, h, T0 + 10 * 60_000 + BACKOFF_MS[1]!);
    row = db.select().from(jobs).get()!;
    expect(row.state).toBe('failed'); expect(row.attempts).toBe(3);
  });
  it('parks a job in needs_review without retrying', async () => {
    const db = fresh(); enqueue(db, { kind: 'r', payload: {} });
    await runOnce(db, { r: async () => { throw new NeedsReview('provider ambiguous'); } }, T0);
    const row = db.select().from(jobs).get()!;
    expect(row.state).toBe('needs_review'); expect(row.lastError).toMatch(/ambiguous/);
  });
  it('recovers expired leases after a crash', () => {
    const db = fresh(); const { id } = enqueue(db, { kind: 'x', payload: {} });
    expect(claimNext(db, T0, 1000)?.id).toBe(id);
    expect(claimNext(db, T0 + 500)).toBeNull();
    expect(recoverLeases(db, T0 + 2000)).toBe(1);
    expect(db.select().from(jobs).where(eq(jobs.id, id)).get()?.state).toBe('pending');
  });
  it('runs a future job only when due', async () => {
    const db = fresh(); enqueue(db, { kind: 'x', payload: {}, runAt: T0 + 5000 });
    expect(await runOnce(db, { x: async () => {} }, T0)).toBe('idle');
    expect(await runOnce(db, { x: async () => {} }, T0 + 5000)).toBe('ran');
  });
});
```

`tests/jobs/inbox.test.ts`:
```ts
import { describe, it, expect } from 'vitest';
import { openDb, migrate } from '../../src/server/db/client.js';
import { webhookInbox } from '../../src/server/db/schema.js';
import { recordWebhook, markApplied } from '../../src/server/jobs/inbox.js';

describe('webhook inbox', () => {
  it('stores once per provider event id', () => {
    const db = openDb(':memory:'); migrate(db);
    expect(recordWebhook(db, 'stripe', 'evt_1', 'in_1', { a: 1 })).toBe(true);
    expect(recordWebhook(db, 'stripe', 'evt_1', 'in_1', { a: 1 })).toBe(false);
    expect(recordWebhook(db, 'docuseal', 'evt_1', null, {})).toBe(true);
    markApplied(db, 'stripe', 'evt_1');
    expect(db.select().from(webhookInbox).all().map((r) => r.state).sort()).toEqual(['applied', 'received']);
  });
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `npx vitest run tests/jobs`
Expected: FAIL, missing modules.

- [ ] **Step 3: Implement queue.ts, worker.ts, inbox.ts**

`src/server/jobs/queue.ts`:
```ts
import { and, eq, lte, or, isNull, lt, sql } from 'drizzle-orm';
import type { Db } from '../db/client.js';
import { jobs } from '../db/schema.js';
import { newId } from '../fs/ids.js';

export class NeedsReview extends Error { constructor(msg: string) { super(msg); this.name = 'NeedsReview'; } }
export type Handler = (payload: unknown, ctx: { db: Db; jobId: string }) => Promise<void>;
export type Handlers = Record<string, Handler>;
export type JobRow = typeof jobs.$inferSelect;
export const BACKOFF_MS = [60_000, 300_000, 1_800_000] as const;
export const MAX_ATTEMPTS = 3;

export function enqueue(db: Db, o: { kind: string; payload: unknown; idempotencyKey?: string; runAt?: number }): { id: string; created: boolean } {
  const id = newId();
  if (o.idempotencyKey) {
    const existing = db.select({ id: jobs.id }).from(jobs).where(eq(jobs.idempotencyKey, o.idempotencyKey)).get();
    if (existing) return { id: existing.id, created: false };
  }
  db.insert(jobs).values({ id, kind: o.kind, payload: o.payload, idempotencyKey: o.idempotencyKey ?? null, nextAt: o.runAt ?? Date.now() }).run();
  return { id, created: true };
}

export function claimNext(db: Db, now: number, leaseMs = 60_000): JobRow | null {
  return db.transaction((tx) => {
    const row = tx.select().from(jobs)
      .where(and(eq(jobs.state, 'pending'), lte(jobs.nextAt, now), or(isNull(jobs.leasedUntil), lt(jobs.leasedUntil, now))))
      .orderBy(jobs.nextAt).limit(1).get();
    if (!row) return null;
    tx.update(jobs).set({ state: 'running', leasedUntil: now + leaseMs, attempts: row.attempts + 1 }).where(eq(jobs.id, row.id)).run();
    return { ...row, state: 'running', attempts: row.attempts + 1 };
  });
}

export async function runOnce(db: Db, handlers: Handlers, now = Date.now()): Promise<'ran' | 'idle'> {
  const job = claimNext(db, now); if (!job) return 'idle';
  const handler = handlers[job.kind];
  try {
    if (!handler) throw new NeedsReview(`no handler for kind ${job.kind}`);
    await handler(job.payload, { db, jobId: job.id });
    db.update(jobs).set({ state: 'done', leasedUntil: null, lastError: null }).where(eq(jobs.id, job.id)).run();
  } catch (e) {
    const msg = e instanceof Error ? `${e.name}: ${e.message}` : String(e);
    if (e instanceof NeedsReview) db.update(jobs).set({ state: 'needs_review', leasedUntil: null, lastError: msg }).where(eq(jobs.id, job.id)).run();
    else if (job.attempts >= MAX_ATTEMPTS) db.update(jobs).set({ state: 'failed', leasedUntil: null, lastError: msg }).where(eq(jobs.id, job.id)).run();
    else db.update(jobs).set({ state: 'pending', leasedUntil: null, lastError: msg, nextAt: now + BACKOFF_MS[job.attempts - 1]! }).where(eq(jobs.id, job.id)).run();
  }
  return 'ran';
}

export function recoverLeases(db: Db, now: number): number {
  return db.update(jobs).set({ state: 'pending', leasedUntil: null }).where(and(eq(jobs.state, 'running'), lt(jobs.leasedUntil, now))).run().changes;
}

export function retryJob(db: Db, id: string): void {
  db.update(jobs).set({ state: 'pending', attempts: 0, nextAt: Date.now(), lastError: null }).where(eq(jobs.id, id)).run();
}
export const jobsSql = sql; // re-export for callers that need raw fragments
```

`src/server/jobs/worker.ts`:
```ts
import type { Db } from '../db/client.js';
import { runOnce, recoverLeases, type Handlers } from './queue.js';

export function startWorker(db: Db, handlers: Handlers, opts: { intervalMs: number }): () => void {
  recoverLeases(db, Date.now());
  let stopped = false; let busy = false;
  const tick = async () => {
    if (stopped || busy) return; busy = true;
    try { while (!stopped && (await runOnce(db, handlers)) === 'ran') { /* drain */ } }
    catch (e) { console.error('[jobs] worker error', e); }
    finally { busy = false; }
  };
  const timer = setInterval(tick, opts.intervalMs); void tick();
  return () => { stopped = true; clearInterval(timer); };
}
```

`src/server/jobs/inbox.ts`:
```ts
import { and, eq } from 'drizzle-orm';
import type { Db } from '../db/client.js';
import { webhookInbox } from '../db/schema.js';

export function recordWebhook(db: Db, provider: string, eventId: string, objectId: string | null, payload: unknown): boolean {
  const r = db.insert(webhookInbox).values({ provider, eventId, objectId, payload }).onConflictDoNothing().run();
  return r.changes === 1;
}
export function markApplied(db: Db, provider: string, eventId: string): void {
  db.update(webhookInbox).set({ state: 'applied' }).where(and(eq(webhookInbox.provider, provider), eq(webhookInbox.eventId, eventId))).run();
}
```

- [ ] **Step 4: Run tests**

Run: `npx vitest run tests/jobs`
Expected: 7 passed.

- [ ] **Step 5: Commit**

```bash
git add src/server/jobs tests/jobs
git commit -m "feat: sqlite job queue with leases, backoff, needs_review; webhook inbox"
```

---

### Task 9: Index project media and generate previews

**Files:**
- Create: `src/server/fs/photos.ts`, `tests/fs/photos.test.ts`
- Modify: `src/server/db/schema.ts` (add `lastIndexedAt` to `projects`), regenerate migration.

**Interfaces:**
- Consumes: `sniff`, `quickHash`, `extractPreview`, `makeThumb`, `enqueue`, `Handlers`, `isReserved`, `resolveInside`, `projectDir`.
- Produces:
  - `indexProjectMedia(db, photosDir, projectId): Promise<IndexReport>` with `IndexReport = { added: number; updated: number; missing: number; drafts: number; skipped: string[] }`.
  - `previewHandlers: Handlers` containing `preview` (payload `{ photoId }`), registered by the boot code.
  - `cachePaths(photosDir, projectRow, photoId) → { preview: string; thumb: string }` under `<project>/.cache/`.
  - `PREVIEW_EDGE = 2048`, `THUMB_EDGE = 400`.

- [ ] **Step 1: Add `lastIndexedAt` and regenerate the migration**

In `src/server/db/schema.ts`, inside `projects`, after `currentRound`: `lastIndexedAt: text('last_indexed_at'),`.

Run: `npm run db:generate`
Expected: a new `0001_*.sql` adding the column. Run `npx vitest run tests/db.test.ts` and confirm it still passes.

- [ ] **Step 2: Write the failing test**

`tests/fs/photos.test.ts`:
```ts
import { describe, it, expect } from 'vitest';
import { mkdir, rename, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { eq } from 'drizzle-orm';
import { tmpDir } from '../helpers.js';
import { makeJpeg, makeTiffAs } from '../fixtures/make.js';
import { openDb, migrate } from '../../src/server/db/client.js';
import { photos, jobs, events } from '../../src/server/db/schema.js';
import { rescan } from '../../src/server/fs/index.js';
import { indexProjectMedia, previewHandlers, cachePaths } from '../../src/server/fs/photos.js';
import { runOnce } from '../../src/server/jobs/queue.js';
import { writeJsonAtomic } from '../../src/server/fs/json.js';
import { defaultClientJson, defaultProjectJson } from '../../src/server/fs/schemas.js';

async function project(root: string) {
  const c = defaultClientJson('Smith'); const p = defaultProjectJson('Wedding');
  await mkdir(join(root, 'Clients/Smith/Wedding/raw'), { recursive: true });
  await mkdir(join(root, 'Clients/Smith/Wedding/finals/Ceremony'), { recursive: true });
  await writeJsonAtomic(join(root, 'Clients/Smith/client.json'), c);
  await writeJsonAtomic(join(root, 'Clients/Smith/Wedding/project.json'), p);
  const db = openDb(':memory:'); migrate(db); await rescan(db, root);
  return { db, pid: p.id!, dir: join(root, 'Clients/Smith/Wedding') };
}
async function drain(db: ReturnType<typeof openDb>) { while ((await runOnce(db, previewHandlers)) === 'ran') { /* */ } }

describe('indexProjectMedia', () => {
  it('indexes raw files as culling photos and finals with sections', async () => {
    const root = await tmpDir(); const { db, pid, dir } = await project(root);
    await makeTiffAs(join(dir, 'raw/a.dng')); await makeTiffAs(join(dir, 'raw/b.dng'));
    await makeJpeg(join(dir, 'finals/Ceremony/c.jpg')); await writeFile(join(dir, 'raw/notes.txt'), 'x');
    const r = await indexProjectMedia(db, root, pid);
    expect(r.added).toBe(3); expect(r.skipped).toEqual(['raw/notes.txt']);
    const rows = db.select().from(photos).where(eq(photos.projectId, pid)).all();
    expect(rows.filter((p) => p.stage === 'culling')).toHaveLength(2);
    expect(rows.find((p) => p.relPath === 'finals/Ceremony/c.jpg')?.section).toBe('Ceremony');
    expect(db.select().from(jobs).all().filter((j) => j.kind === 'preview')).toHaveLength(3);
  });
  it('is a no-op for unchanged files and updates on content change', async () => {
    const root = await tmpDir(); const { db, pid, dir } = await project(root);
    await makeTiffAs(join(dir, 'raw/a.dng'));
    await indexProjectMedia(db, root, pid);
    let r = await indexProjectMedia(db, root, pid); expect(r).toMatchObject({ added: 0, updated: 0 });
    await makeJpeg(join(dir, 'raw/a.dng'));                    // wrong bytes now → unsupported, treated as missing
    r = await indexProjectMedia(db, root, pid); expect(r.missing).toBe(1);
    expect(db.select().from(photos).all()[0]?.missing).toBe(true);
  });
  it('marks a renamed raw as missing + new, never merges', async () => {
    const root = await tmpDir(); const { db, pid, dir } = await project(root);
    await makeTiffAs(join(dir, 'raw/a.dng')); await indexProjectMedia(db, root, pid);
    await rename(join(dir, 'raw/a.dng'), join(dir, 'raw/z.dng'));
    const r = await indexProjectMedia(db, root, pid);
    expect(r).toMatchObject({ added: 1, missing: 1 });
    expect(db.select().from(photos).all()).toHaveLength(2);
  });
  it('treats new finals after first index as drafts, and .draft files as drafts', async () => {
    const root = await tmpDir(); const { db, pid, dir } = await project(root);
    await makeJpeg(join(dir, 'finals/live.jpg'));
    await indexProjectMedia(db, root, pid);                          // first index: live
    await makeJpeg(join(dir, 'finals/new.jpg'));
    await mkdir(join(dir, 'finals/.draft'), { recursive: true }); await makeJpeg(join(dir, 'finals/.draft/staged.jpg'));
    const r = await indexProjectMedia(db, root, pid);
    expect(r.drafts).toBe(2);
    const rows = db.select().from(photos).all();
    expect(rows.find((p) => p.relPath === 'finals/new.jpg')?.draftRelPath).toBe('finals/.draft/new.jpg');
    expect((await stat(join(dir, 'finals/.draft/new.jpg'))).isFile()).toBe(true);
    expect(rows.find((p) => p.relPath === 'finals/staged.jpg')?.draftRelPath).toBe('finals/.draft/staged.jpg');
    expect(rows.find((p) => p.relPath === 'finals/live.jpg')?.draftRelPath).toBeNull();
  });
  it('preview job writes cache files and records failure as an event', async () => {
    const root = await tmpDir(); const { db, pid, dir } = await project(root);
    await makeTiffAs(join(dir, 'raw/a.dng')); await makeJpeg(join(dir, 'finals/f.jpg'));
    await indexProjectMedia(db, root, pid); await drain(db);
    for (const p of db.select().from(photos).all()) {
      const { preview, thumb } = cachePaths(root, { folderPath: 'Clients/Smith/Wedding' }, p.id);
      expect((await stat(thumb)).isFile()).toBe(true);
      if (p.stage === 'culling') expect((await stat(preview)).isFile()).toBe(true);
      expect(p.width).toBeGreaterThan(0);
    }
    await writeFile(join(dir, 'raw/bad.nef'), Buffer.from('49492a00', 'hex')); // valid TIFF header, no image
    await indexProjectMedia(db, root, pid); await drain(db);
    expect(db.select().from(events).all().some((e) => e.type === 'preview_failed')).toBe(true);
  });
});
```

- [ ] **Step 3: Run to verify it fails**

Run: `npx vitest run tests/fs/photos.test.ts`
Expected: FAIL, missing module.

- [ ] **Step 4: Implement**

`src/server/fs/photos.ts`:
```ts
import { readdir, mkdir, rename } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { eq } from 'drizzle-orm';
import type { Db } from '../db/client.js';
import { photos, projects, events } from '../db/schema.js';
import { ProjectJson } from './schemas.js';
import { sniff, quickHash } from './media.js';
import sharp from 'sharp';
import { extractPreview, makeThumb, PreviewError } from './previews.js';
import { enqueue, type Handlers } from '../jobs/queue.js';
import { newId } from './ids.js';
import { RESERVED_DIRS } from './paths.js';

export const PREVIEW_EDGE = 2048; export const THUMB_EDGE = 400;
export type IndexReport = { added: number; updated: number; missing: number; drafts: number; skipped: string[] };

export function cachePaths(photosDir: string, row: { folderPath: string }, photoId: string) {
  const base = join(photosDir, row.folderPath, '.cache');
  return { preview: join(base, 'previews', `${photoId}.jpg`), thumb: join(base, 'thumbs', `${photoId}.jpg`) };
}

async function walk(abs: string, rel: string, out: { abs: string; rel: string }[], includeReserved = false) {
  let entries; try { entries = await readdir(abs, { withFileTypes: true }); } catch { return; }
  for (const e of entries) {
    if (e.name.startsWith('.') && !(includeReserved && e.name === '.draft')) continue;
    const a = join(abs, e.name); const r = rel ? `${rel}/${e.name}` : e.name;
    if (e.isDirectory()) { if ((RESERVED_DIRS as readonly string[]).includes(e.name) && e.name !== '.draft') continue; await walk(a, r, out, false); }
    else if (e.isFile()) out.push({ abs: a, rel: r });
  }
}

export async function indexProjectMedia(db: Db, photosDir: string, projectId: string): Promise<IndexReport> {
  const proj = db.select().from(projects).where(eq(projects.id, projectId)).get();
  if (!proj) throw new Error(`unknown project ${projectId}`);
  const meta = ProjectJson.parse(proj.metadataJson); const dir = join(photosDir, proj.folderPath);
  const firstIndex = proj.lastIndexedAt === null;
  const report: IndexReport = { added: 0, updated: 0, missing: 0, drafts: 0, skipped: [] };

  const files: { abs: string; rel: string; stage: 'culling' | 'final' }[] = [];
  const raw: { abs: string; rel: string }[] = []; await walk(join(dir, meta.folders.culling), meta.folders.culling, raw);
  const fin: { abs: string; rel: string }[] = []; await walk(join(dir, meta.folders.finals), meta.folders.finals, fin, true);
  files.push(...raw.map((f) => ({ ...f, stage: 'culling' as const })), ...fin.map((f) => ({ ...f, stage: 'final' as const })));

  const existing = new Map(db.select().from(photos).where(eq(photos.projectId, projectId)).all().map((p) => [p.relPath, p]));
  const seen = new Set<string>();
  const draftPrefix = `${meta.folders.finals}/.draft/`;

  for (const f of files) {
    const s = await sniff(f.abs);
    if (!s || (s.kind !== 'photo' && s.kind !== 'video')) { report.skipped.push(f.rel); continue; }
    const isDraftFile = f.rel.startsWith(draftPrefix);
    let livePath = isDraftFile ? `${meta.folders.finals}/${f.rel.slice(draftPrefix.length)}` : f.rel;
    let draftPath: string | null = isDraftFile ? f.rel : null;
    const prior = existing.get(livePath);
    // a new file in finals/ after the first index is not live yet: stage it
    if (f.stage === 'final' && !isDraftFile && !prior && !firstIndex) {
      draftPath = `${draftPrefix}${f.rel.slice(meta.folders.finals.length + 1)}`;
      await mkdir(dirname(join(dir, draftPath)), { recursive: true }); await rename(f.abs, join(dir, draftPath)); f.abs = join(dir, draftPath);
    }
    seen.add(livePath);
    const checksum = await quickHash(f.abs);
    const section = f.stage === 'final' ? (() => { const parts = livePath.split('/'); return parts.length > 2 ? parts[1]! : null; })() : null;
    if (!prior) {
      const id = newId();
      db.insert(photos).values({ id, projectId, relPath: livePath, draftRelPath: draftPath, stage: f.stage, kind: s.kind, checksum, section, sortOrder: 0 }).run();
      report.added++; if (draftPath) report.drafts++;
      enqueue(db, { kind: 'preview', payload: { photoId: id }, idempotencyKey: `preview:${id}:${checksum}` });
    } else {
      const changed = prior.checksum !== checksum || prior.missing || prior.draftRelPath !== draftPath;
      if (changed) {
        db.update(photos).set({ checksum, missing: false, draftRelPath: draftPath ?? (isDraftFile ? draftPath : prior.draftRelPath), section }).where(eq(photos.id, prior.id)).run();
        report.updated++; if (draftPath) report.drafts++;
        enqueue(db, { kind: 'preview', payload: { photoId: prior.id }, idempotencyKey: `preview:${prior.id}:${checksum}` });
      }
    }
  }
  for (const [rel, p] of existing) if (!seen.has(rel) && !p.missing) { db.update(photos).set({ missing: true }).where(eq(photos.id, p.id)).run(); report.missing++; }
  db.update(projects).set({ lastIndexedAt: new Date().toISOString() }).where(eq(projects.id, projectId)).run();
  return report;
}

export function makePreviewHandlers(photosDir: string): Handlers {
  return {
    preview: async (payload, { db }) => {
      const { photoId } = payload as { photoId: string };
      const p = db.select().from(photos).where(eq(photos.id, photoId)).get(); if (!p || p.missing || p.kind === 'video') return; // video posters: milestone 10
      const proj = db.select().from(projects).where(eq(projects.id, p.projectId)).get()!;
      const src = join(photosDir, proj.folderPath, p.draftRelPath ?? p.relPath);
      const { preview, thumb } = cachePaths(photosDir, proj, p.id);
      await mkdir(dirname(preview), { recursive: true }); await mkdir(dirname(thumb), { recursive: true });
      try {
        let dims: { width: number; height: number };
        if (p.stage === 'culling') { dims = await extractPreview(src, preview, PREVIEW_EDGE); await makeThumb(preview, thumb, THUMB_EDGE); }
        else { await makeThumb(src, thumb, THUMB_EDGE); const m = await sharp(src).metadata(); dims = { width: m.width ?? 0, height: m.height ?? 0 }; }
        db.update(photos).set({ width: dims.width, height: dims.height }).where(eq(photos.id, p.id)).run();
      } catch (e) {
        if (!(e instanceof PreviewError)) throw e;
        db.insert(events).values({ projectId: p.projectId, actor: 'system', type: 'preview_failed', payload: { photoId: p.id, relPath: p.relPath, error: e.message } }).run();
      }
    },
  };
}
// tests import a ready-made handler set bound to the photos dir they pass in
export const previewHandlers: Handlers = { preview: (payload, ctx) => makePreviewHandlers(process.env.PHOTOS_DIR ?? '').preview!(payload, ctx) };
```

The test passes `root` as the photos dir: add `process.env.PHOTOS_DIR = root;` right after `const root = await tmpDir();` in the preview test so `previewHandlers` resolves the same directory.

- [ ] **Step 5: Run tests**

Run: `npx vitest run tests/fs/photos.test.ts`
Expected: 5 passed.

- [ ] **Step 6: Commit**

```bash
git add src/server/db src/server/fs/photos.ts tests/fs/photos.test.ts
git commit -m "feat: index project media, stage new finals as drafts, preview jobs"
```

---

### Task 10: Folder watcher

**Files:**
- Create: `src/server/fs/watcher.ts`, `tests/fs/watcher.test.ts`

**Interfaces:**
- Consumes: `rescan`, `indexProjectMedia`, `projects` table.
- Produces: `startWatcher(db, photosDir, opts: { debounceMs?: number; stabilityMs?: number; onIdle?: () => void }): () => void`. Structural changes (`client.json`, `project.json`, directory add/remove under `Clients/`) schedule a `rescan`; media changes schedule `indexProjectMedia` for the owning project. Both are debounced and serialized; `onIdle` fires after each drained batch (tests use it).

- [ ] **Step 1: Write the failing test**

`tests/fs/watcher.test.ts`:
```ts
import { describe, it, expect } from 'vitest';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpDir } from '../helpers.js';
import { makeTiffAs } from '../fixtures/make.js';
import { openDb, migrate } from '../../src/server/db/client.js';
import { photos, projects } from '../../src/server/db/schema.js';
import { startWatcher } from '../../src/server/fs/watcher.js';
import { writeJsonAtomic } from '../../src/server/fs/json.js';
import { defaultClientJson, defaultProjectJson } from '../../src/server/fs/schemas.js';

const idle = (set: (fn: () => void) => void) => new Promise<void>((r) => set(r));

describe('watcher', () => {
  it('picks up a new project and then its media', async () => {
    const root = await tmpDir(); await mkdir(join(root, 'Clients'), { recursive: true });
    const db = openDb(':memory:'); migrate(db);
    let onIdle = () => {};
    const stop = startWatcher(db, root, { debounceMs: 100, stabilityMs: 100, onIdle: () => onIdle() });
    try {
      const wait = idle((fn) => { onIdle = fn; });
      await mkdir(join(root, 'Clients/Smith/Wedding/raw'), { recursive: true });
      await writeJsonAtomic(join(root, 'Clients/Smith/client.json'), defaultClientJson('Smith'));
      await writeJsonAtomic(join(root, 'Clients/Smith/Wedding/project.json'), defaultProjectJson('Wedding'));
      await wait;
      expect(db.select().from(projects).all()).toHaveLength(1);
      const wait2 = idle((fn) => { onIdle = fn; });
      await makeTiffAs(join(root, 'Clients/Smith/Wedding/raw/a.dng'));
      await wait2;
      expect(db.select().from(photos).all().map((p) => p.relPath)).toEqual(['raw/a.dng']);
    } finally { stop(); }
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run tests/fs/watcher.test.ts`
Expected: FAIL, missing module.

- [ ] **Step 3: Implement**

`src/server/fs/watcher.ts`:
```ts
import chokidar from 'chokidar';
import { join, relative, sep, basename } from 'node:path';
import type { Db } from '../db/client.js';
import { projects } from '../db/schema.js';
import { rescan } from './index.js';
import { indexProjectMedia } from './photos.js';

const STRUCTURAL = new Set(['client.json', 'project.json']);

export function startWatcher(db: Db, photosDir: string, opts: { debounceMs?: number; stabilityMs?: number; onIdle?: () => void } = {}): () => void {
  const debounceMs = opts.debounceMs ?? 1500;
  let needRescan = false; const dirtyProjects = new Set<string>(); let timer: NodeJS.Timeout | null = null; let running = false; let again = false;

  const projectFor = (rel: string): string | null => {
    let best: { id: string; folderPath: string } | null = null;
    for (const p of db.select({ id: projects.id, folderPath: projects.folderPath }).from(projects).all())
      if ((rel === p.folderPath || rel.startsWith(p.folderPath + '/')) && (!best || p.folderPath.length > best.folderPath.length)) best = p;
    return best?.id ?? null;
  };

  const drain = async () => {
    if (running) { again = true; return; } running = true;
    try {
      do {
        again = false;
        if (needRescan) { needRescan = false; await rescan(db, photosDir); for (const p of db.select({ id: projects.id }).from(projects).all()) dirtyProjects.add(p.id); }
        const ids = [...dirtyProjects]; dirtyProjects.clear();
        for (const id of ids) { try { await indexProjectMedia(db, photosDir, id); } catch (e) { console.error('[watcher] index failed', id, e); } }
      } while (again);
    } finally { running = false; opts.onIdle?.(); }
  };
  const schedule = () => { if (timer) clearTimeout(timer); timer = setTimeout(() => { timer = null; void drain(); }, debounceMs); };

  const onEvent = (kind: string, abs: string) => {
    const rel = relative(photosDir, abs).split(sep).join('/');
    if (!rel.startsWith('Clients/')) return;
    if (rel.split('/').some((s) => s === '.cache' || s === '.trash' || s.endsWith('.tmp'))) return;
    if (STRUCTURAL.has(basename(abs)) || kind === 'addDir' || kind === 'unlinkDir') needRescan = true;
    else { const id = projectFor(rel); if (id) dirtyProjects.add(id); else needRescan = true; }
    schedule();
  };

  const w = chokidar.watch(join(photosDir, 'Clients'), {
    ignoreInitial: true, persistent: true,
    ignored: (p) => /(^|[\\/])\.(cache|trash)([\\/]|$)/.test(p) || p.endsWith('.tmp'),
    awaitWriteFinish: { stabilityThreshold: opts.stabilityMs ?? 2000, pollInterval: 200 },
  });
  for (const ev of ['add', 'change', 'unlink', 'addDir', 'unlinkDir'] as const) w.on(ev, (p) => onEvent(ev, p));
  return () => { if (timer) clearTimeout(timer); void w.close(); };
}
```

- [ ] **Step 4: Run tests**

Run: `npx vitest run tests/fs/watcher.test.ts`
Expected: 1 passed. If chokidar 4 complains about the `ignored` function signature, use `ignored: (p: string) => ...` with the explicit type.

- [ ] **Step 5: Commit**

```bash
git add src/server/fs/watcher.ts tests/fs/watcher.test.ts
git commit -m "feat: debounced folder watcher driving rescan and media indexing"
```

---

### Task 11: Email transport, templates, and send-as-a-job

**Files:**
- Create: `src/server/email/templates.ts`, `src/server/email/transport.ts`, `src/server/email/send.ts`, `tests/email/email.test.ts`

**Interfaces:**
- Consumes: `enqueue`, `Handlers`, `getSetting/setSetting`, `Config`.
- Produces:
  - `type Mail = { to: string; subject: string; text: string; html: string; messageId: string }`
  - `interface Transport { send(m: Mail): Promise<void>; describe(): string }`
  - `smtpTransport(url: string, from: string): Transport`, `listmonkTransport(url: string, token: string, from: string, templateId: number): Transport`, `memoryTransport(): Transport & { sent: Mail[] }`
  - `type EmailConfig = { type: 'smtp'; url: string; from: string } | { type: 'listmonk'; url: string; token: string; from: string; templateId: number }`; stored under setting key `email`.
  - `resolveTransport(db, config): Transport | null` (settings first, then env `SMTP_URL`/`LISTMONK_*`).
  - `renderTemplate(name: TemplateName, vars: Record<string, string>): { subject: string; text: string; html: string }` with `TemplateName = 'magic_link' | 'test_delivery'`.
  - `sendEmail(db, o: { to: string; template: TemplateName; vars: Record<string, string>; key: string }): void` — enqueues `send_email` with idempotency key `email:${key}`.
  - `makeEmailHandlers(getTransport: () => Transport | null, domain: string): Handlers`.

- [ ] **Step 1: Write the failing test**

`tests/email/email.test.ts`:
```ts
import { describe, it, expect } from 'vitest';
import { createServer } from 'node:http';
import { openDb, migrate } from '../../src/server/db/client.js';
import { jobs } from '../../src/server/db/schema.js';
import { runOnce } from '../../src/server/jobs/queue.js';
import { renderTemplate } from '../../src/server/email/templates.js';
import { memoryTransport, listmonkTransport } from '../../src/server/email/transport.js';
import { sendEmail, makeEmailHandlers } from '../../src/server/email/send.js';

describe('email', () => {
  it('renders the magic link template', () => {
    const r = renderTemplate('magic_link', { studio: 'Test Studio', url: 'https://g/x/abc' });
    expect(r.subject).toContain('Test Studio'); expect(r.text).toContain('https://g/x/abc'); expect(r.html).toContain('href="https://g/x/abc"');
  });
  it('sends through a job with a stable message id and dedups by key', async () => {
    const db = openDb(':memory:'); migrate(db); const t = memoryTransport();
    sendEmail(db, { to: 'a@x', template: 'test_delivery', vars: { studio: 'S' }, key: 'test:1' });
    sendEmail(db, { to: 'a@x', template: 'test_delivery', vars: { studio: 'S' }, key: 'test:1' });
    expect(db.select().from(jobs).all()).toHaveLength(1);
    await runOnce(db, makeEmailHandlers(() => t, 'g.example'));
    expect(t.sent).toHaveLength(1); expect(t.sent[0]?.messageId).toBe('<email:test:1@g.example>');
  });
  it('fails the job visibly when no transport is configured', async () => {
    const db = openDb(':memory:'); migrate(db);
    sendEmail(db, { to: 'a@x', template: 'test_delivery', vars: { studio: 'S' }, key: 'k' });
    await runOnce(db, makeEmailHandlers(() => null, 'g'));
    expect(db.select().from(jobs).get()?.lastError).toMatch(/no email transport/);
  });
  it('posts to listmonk tx api', async () => {
    const bodies: unknown[] = [];
    const srv = createServer((req, res) => { let b = ''; req.on('data', (c) => (b += c)); req.on('end', () => { bodies.push({ url: req.url, auth: req.headers.authorization, body: JSON.parse(b) }); res.end('{"data":true}'); }); });
    await new Promise<void>((r) => srv.listen(0, r)); const port = (srv.address() as { port: number }).port;
    try {
      const t = listmonkTransport(`http://127.0.0.1:${port}`, 'tok', 'S <s@x>', 7);
      await t.send({ to: 'a@x', subject: 'Hi', text: 'T', html: '<p>T</p>', messageId: '<m@x>' });
      expect(bodies[0]).toMatchObject({ url: '/api/tx', auth: 'token tok', body: { subscriber_email: 'a@x', template_id: 7, data: { subject: 'Hi', html: '<p>T</p>', text: 'T' } } });
    } finally { srv.close(); }
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run tests/email`
Expected: FAIL, missing modules.

- [ ] **Step 3: Implement**

`src/server/email/templates.ts`:
```ts
export type TemplateName = 'magic_link' | 'test_delivery';
const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));
const shell = (title: string, body: string) => `<!doctype html><html><body style="font-family:-apple-system,system-ui,sans-serif;max-width:560px;margin:40px auto;padding:0 20px;color:#111"><h1 style="font-size:20px">${esc(title)}</h1>${body}</body></html>`;

const T: Record<TemplateName, (v: Record<string, string>) => { subject: string; text: string; html: string }> = {
  magic_link: (v) => ({
    subject: `Sign in to ${v.studio}`,
    text: `Tap to sign in to ${v.studio}:\n\n${v.url}\n\nThis link works once and expires soon. If you did not request it, ignore this email.`,
    html: shell(`Sign in to ${v.studio ?? ''}`, `<p><a href="${esc(v.url ?? '')}" style="display:inline-block;padding:12px 18px;background:#111;color:#fff;border-radius:10px;text-decoration:none">Sign in</a></p><p style="color:#666;font-size:13px">This link works once and expires soon.</p>`),
  }),
  test_delivery: (v) => ({
    subject: `${v.studio}: email delivery works`,
    text: `This is a test message from ${v.studio}. Email is configured correctly.`,
    html: shell(`${v.studio ?? ''}: email delivery works`, `<p>Email is configured correctly.</p>`),
  }),
};
export function renderTemplate(name: TemplateName, vars: Record<string, string>) { return T[name](vars); }
```

`src/server/email/transport.ts`:
```ts
import nodemailer from 'nodemailer';
import type { Db } from '../db/client.js';
import { getSetting } from '../db/settings.js';
import type { Config } from '../config.js';

export type Mail = { to: string; subject: string; text: string; html: string; messageId: string };
export interface Transport { send(m: Mail): Promise<void>; describe(): string }
export type EmailConfig = { type: 'smtp'; url: string; from: string } | { type: 'listmonk'; url: string; token: string; from: string; templateId: number };

export function smtpTransport(url: string, from: string): Transport {
  const t = nodemailer.createTransport(url);
  return { describe: () => `smtp ${new URL(url).host}`, async send(m) { await t.sendMail({ from, to: m.to, subject: m.subject, text: m.text, html: m.html, messageId: m.messageId }); } };
}
export function listmonkTransport(url: string, token: string, from: string, templateId: number): Transport {
  return {
    describe: () => `listmonk ${url}`,
    async send(m) {
      const res = await fetch(`${url.replace(/\/$/, '')}/api/tx`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `token ${token}` },
        body: JSON.stringify({ subscriber_email: m.to, template_id: templateId, from_email: from, headers: [{ 'Message-ID': m.messageId }], data: { subject: m.subject, html: m.html, text: m.text } }) });
      if (!res.ok) throw new Error(`listmonk tx failed: ${res.status} ${await res.text()}`);
    },
  };
}
export function memoryTransport(): Transport & { sent: Mail[] } {
  const sent: Mail[] = []; return { sent, describe: () => 'memory', async send(m) { sent.push(m); } };
}
export function resolveTransport(db: Db, config: Config): Transport | null {
  const s = getSetting<EmailConfig>(db, 'email');
  if (s?.type === 'smtp') return smtpTransport(s.url, s.from);
  if (s?.type === 'listmonk') return listmonkTransport(s.url, s.token, s.from, s.templateId);
  if (config.smtpUrl) return smtpTransport(config.smtpUrl, `OpenGallery <no-reply@${new URL(config.baseUrl).hostname}>`);
  return null;
}
```

`src/server/email/send.ts`:
```ts
import type { Db } from '../db/client.js';
import { enqueue, type Handlers } from '../jobs/queue.js';
import { renderTemplate, type TemplateName } from './templates.js';
import type { Transport } from './transport.js';

export function sendEmail(db: Db, o: { to: string; template: TemplateName; vars: Record<string, string>; key: string }): void {
  enqueue(db, { kind: 'send_email', payload: o, idempotencyKey: `email:${o.key}` });
}
export function makeEmailHandlers(getTransport: () => Transport | null, domain: string): Handlers {
  return {
    send_email: async (payload) => {
      const o = payload as { to: string; template: TemplateName; vars: Record<string, string>; key: string };
      const t = getTransport(); if (!t) throw new Error('no email transport configured');
      const r = renderTemplate(o.template, o.vars);
      await t.send({ to: o.to, ...r, messageId: `<email:${o.key}@${domain}>` });
    },
  };
}
```

- [ ] **Step 4: Run tests**

Run: `npx vitest run tests/email`
Expected: 4 passed.

- [ ] **Step 5: Commit**

```bash
git add src/server/email tests/email
git commit -m "feat: email transport (smtp, listmonk, memory), bundled templates, send-as-job"
```

---

### Task 12: Magic links and sessions

**Files:**
- Create: `src/server/auth/magic.ts`, `src/server/http/session.ts`, `tests/auth/magic.test.ts`

**Interfaces:**
- Consumes: `sessions` table, `sendEmail`, `Config`.
- Produces:
  - `TTL = { client: 30 * 864e5, admin: 15 * 60_000, session: 30 * 864e5 }`
  - `createMagicLink(db, o: { kind: 'client' | 'admin'; email: string; now?: number }): { token: string; expiresAt: string }`
  - `redeemMagicLink(db, token: string, now?: number): { sessionToken: string; session: SessionRow } | null` — single use.
  - `sessionFromToken(db, token: string, now?: number): SessionRow | null`
  - `signOut(db, token: string): void`
  - `hashToken(t: string): string`, `randomToken(): string`
  - Hono middleware `sessionMiddleware(db)` that reads cookie `og_session` and sets `c.set('session', SessionRow | null)`; `setSessionCookie(c, token, secure)`, `clearSessionCookie(c)`. `COOKIE = 'og_session'`.
  - Type `AppEnv = { Variables: { session: SessionRow | null } }` for Hono generics.

- [ ] **Step 1: Write the failing test**

`tests/auth/magic.test.ts`:
```ts
import { describe, it, expect } from 'vitest';
import { openDb, migrate } from '../../src/server/db/client.js';
import { createMagicLink, redeemMagicLink, sessionFromToken, signOut, TTL } from '../../src/server/auth/magic.js';

const T0 = 1_700_000_000_000;
function fresh() { const db = openDb(':memory:'); migrate(db); return db; }

describe('magic links', () => {
  it('redeems once and yields a session', () => {
    const db = fresh(); const { token } = createMagicLink(db, { kind: 'client', email: 'a@x', now: T0 });
    const r = redeemMagicLink(db, token, T0 + 1000)!;
    expect(r.session.kind).toBe('client'); expect(r.session.subject).toBe('a@x');
    expect(redeemMagicLink(db, token, T0 + 2000)).toBeNull();          // single use
    expect(sessionFromToken(db, r.sessionToken, T0 + 3000)?.id).toBe(r.session.id);
    expect(sessionFromToken(db, token, T0 + 3000)).toBeNull();          // login token is not a session token
  });
  it('expires client links after 30 days and admin links after 15 minutes', () => {
    const db = fresh();
    const c = createMagicLink(db, { kind: 'client', email: 'a@x', now: T0 });
    const a = createMagicLink(db, { kind: 'admin', email: 'o@x', now: T0 });
    expect(redeemMagicLink(db, c.token, T0 + TTL.client + 1)).toBeNull();
    expect(redeemMagicLink(db, a.token, T0 + TTL.admin + 1)).toBeNull();
    expect(redeemMagicLink(db, createMagicLink(db, { kind: 'admin', email: 'o@x', now: T0 }).token, T0 + TTL.admin - 1)).not.toBeNull();
  });
  it('sessions expire and can be signed out', () => {
    const db = fresh(); const { token } = createMagicLink(db, { kind: 'client', email: 'a@x', now: T0 });
    const { sessionToken } = redeemMagicLink(db, token, T0)!;
    expect(sessionFromToken(db, sessionToken, T0 + TTL.session + 1)).toBeNull();
    expect(sessionFromToken(db, sessionToken, T0 + 1)).not.toBeNull();
    signOut(db, sessionToken);
    expect(sessionFromToken(db, sessionToken, T0 + 1)).toBeNull();
  });
  it('stores only hashes', () => {
    const db = fresh(); const { token } = createMagicLink(db, { kind: 'client', email: 'a@x', now: T0 });
    const raw = db.$client.prepare('select login_token_hash from sessions').get() as { login_token_hash: string };
    expect(raw.login_token_hash).not.toBe(token); expect(raw.login_token_hash).toHaveLength(64);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run tests/auth`
Expected: FAIL, missing module.

- [ ] **Step 3: Implement**

`src/server/auth/magic.ts`:
```ts
import { createHash, randomBytes } from 'node:crypto';
import { and, eq, isNull } from 'drizzle-orm';
import type { Db } from '../db/client.js';
import { sessions } from '../db/schema.js';
import { newId } from '../fs/ids.js';

export type SessionRow = typeof sessions.$inferSelect;
export const TTL = { client: 30 * 864e5, admin: 15 * 60_000, session: 30 * 864e5 } as const;
export const hashToken = (t: string) => createHash('sha256').update(t).digest('hex');
export const randomToken = () => randomBytes(32).toString('base64url');
const iso = (ms: number) => new Date(ms).toISOString();

export function createMagicLink(db: Db, o: { kind: 'client' | 'admin'; email: string; now?: number }) {
  const now = o.now ?? Date.now(); const token = randomToken(); const expiresAt = iso(now + TTL[o.kind]);
  db.insert(sessions).values({ id: newId(), kind: o.kind, subject: o.email.toLowerCase(), loginTokenHash: hashToken(token), expiresAt }).run();
  return { token, expiresAt };
}

export function redeemMagicLink(db: Db, token: string, now = Date.now()) {
  return db.transaction((tx) => {
    const row = tx.select().from(sessions).where(and(eq(sessions.loginTokenHash, hashToken(token)), isNull(sessions.redeemedAt))).get();
    if (!row || Date.parse(row.expiresAt) <= now) return null;
    const sessionToken = randomToken();
    tx.update(sessions).set({ loginTokenHash: null, redeemedAt: iso(now), tokenHash: hashToken(sessionToken), expiresAt: iso(now + TTL.session) }).where(eq(sessions.id, row.id)).run();
    return { sessionToken, session: tx.select().from(sessions).where(eq(sessions.id, row.id)).get()! };
  });
}

export function sessionFromToken(db: Db, token: string, now = Date.now()): SessionRow | null {
  const row = db.select().from(sessions).where(eq(sessions.tokenHash, hashToken(token))).get();
  return row && Date.parse(row.expiresAt) > now ? row : null;
}
export function signOut(db: Db, token: string): void {
  db.update(sessions).set({ tokenHash: null, expiresAt: iso(0) }).where(eq(sessions.tokenHash, hashToken(token))).run();
}
```

`src/server/http/session.ts`:
```ts
import type { Context, MiddlewareHandler } from 'hono';
import { getCookie, setCookie, deleteCookie } from 'hono/cookie';
import type { Db } from '../db/client.js';
import { sessionFromToken, type SessionRow } from '../auth/magic.js';

export const COOKIE = 'og_session';
export type AppEnv = { Variables: { session: SessionRow | null; sessionToken: string | null } };

export function sessionMiddleware(db: Db): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    const token = getCookie(c, COOKIE) ?? null;
    c.set('sessionToken', token); c.set('session', token ? sessionFromToken(db, token) : null);
    await next();
  };
}
export function setSessionCookie(c: Context, token: string, secure: boolean) {
  setCookie(c, COOKIE, token, { httpOnly: true, secure, sameSite: 'Lax', path: '/', maxAge: 30 * 86400 });
}
export function clearSessionCookie(c: Context) { deleteCookie(c, COOKIE, { path: '/' }); }
```

- [ ] **Step 4: Run tests**

Run: `npx vitest run tests/auth`
Expected: 4 passed.

- [ ] **Step 5: Commit**

```bash
git add src/server/auth/magic.ts src/server/http/session.ts tests/auth
git commit -m "feat: single-use hashed magic links and cookie sessions"
```

---

### Task 13: Bootstrap — setup token, first owner, email verification

**Files:**
- Create: `src/server/auth/bootstrap.ts`, `src/server/cli.ts`, `tests/auth/bootstrap.test.ts`

**Interfaces:**
- Consumes: `users`, `settings`, `createMagicLink`, `sendEmail`, `resolveTransport`, `EmailConfig`.
- Produces:
  - `createSetupToken(db, now?): string` — stores `sha256` under setting `setup.tokenHash` with 15-minute expiry; refuses if setup is complete.
  - `completeSetup(db, o: { token: string; ownerEmail: string; studioName: string; email: EmailConfig; baseUrl: string; now?: number }): { ok: true } | { ok: false; error: string }` — verifies token, creates the owner, stores `studioName` and `email` settings, enqueues an admin magic link email with key `setup:<userId>`, clears the token. Setup is *complete* only when that link is redeemed (`markSetupComplete` called by the auth route, Task 15).
  - `setupState(db): 'unconfigured' | 'awaiting_verification' | 'complete'`
  - `markSetupComplete(db): void`
  - CLI: `npm run cli -- setup-token` prints the setup URL.

- [ ] **Step 1: Write the failing test**

`tests/auth/bootstrap.test.ts`:
```ts
import { describe, it, expect } from 'vitest';
import { openDb, migrate } from '../../src/server/db/client.js';
import { users, jobs } from '../../src/server/db/schema.js';
import { getSetting } from '../../src/server/db/settings.js';
import { createSetupToken, completeSetup, setupState, markSetupComplete } from '../../src/server/auth/bootstrap.js';

const T0 = 1_700_000_000_000; const email = { type: 'smtp' as const, url: 'smtp://u:p@h:587', from: 'S <s@x>' };
function fresh() { const db = openDb(':memory:'); migrate(db); return db; }

describe('bootstrap', () => {
  it('walks unconfigured → awaiting_verification → complete', () => {
    const db = fresh(); expect(setupState(db)).toBe('unconfigured');
    const token = createSetupToken(db, T0);
    const r = completeSetup(db, { token, ownerEmail: 'Owner@X.com', studioName: 'S', email, baseUrl: 'https://g', now: T0 + 1000 });
    expect(r.ok).toBe(true);
    expect(setupState(db)).toBe('awaiting_verification');
    expect(db.select().from(users).get()).toMatchObject({ email: 'owner@x.com', role: 'owner' });
    expect(getSetting(db, 'email')).toEqual(email);
    const job = db.select().from(jobs).get()!; expect(job.kind).toBe('send_email');
    expect((job.payload as { vars: { url: string } }).vars.url).toMatch(/^https:\/\/g\/auth\//);
    markSetupComplete(db); expect(setupState(db)).toBe('complete');
  });
  it('rejects a wrong, expired, or reused token', () => {
    const db = fresh(); const token = createSetupToken(db, T0);
    expect(completeSetup(db, { token: 'nope', ownerEmail: 'o@x', studioName: 'S', email, baseUrl: 'https://g', now: T0 }).ok).toBe(false);
    expect(completeSetup(db, { token, ownerEmail: 'o@x', studioName: 'S', email, baseUrl: 'https://g', now: T0 + 16 * 60_000 }).ok).toBe(false);
    const t2 = createSetupToken(db, T0);
    expect(completeSetup(db, { token: t2, ownerEmail: 'o@x', studioName: 'S', email, baseUrl: 'https://g', now: T0 }).ok).toBe(true);
    expect(completeSetup(db, { token: t2, ownerEmail: 'o@x', studioName: 'S', email, baseUrl: 'https://g', now: T0 }).ok).toBe(false);
  });
  it('refuses new setup tokens once complete', () => {
    const db = fresh(); const token = createSetupToken(db, T0);
    completeSetup(db, { token, ownerEmail: 'o@x', studioName: 'S', email, baseUrl: 'https://g', now: T0 }); markSetupComplete(db);
    expect(() => createSetupToken(db, T0)).toThrow(/complete/);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run tests/auth/bootstrap.test.ts`
Expected: FAIL, missing module.

- [ ] **Step 3: Implement**

`src/server/auth/bootstrap.ts`:
```ts
import type { Db } from '../db/client.js';
import { users } from '../db/schema.js';
import { getSetting, setSetting } from '../db/settings.js';
import { createMagicLink, hashToken, randomToken } from './magic.js';
import { sendEmail } from '../email/send.js';
import type { EmailConfig } from '../email/transport.js';
import { newId } from '../fs/ids.js';

type SetupToken = { hash: string; expiresAt: number };
const SETUP_TTL = 15 * 60_000;

export function setupState(db: Db): 'unconfigured' | 'awaiting_verification' | 'complete' {
  if (getSetting<boolean>(db, 'setup.complete')) return 'complete';
  return db.select({ id: users.id }).from(users).get() ? 'awaiting_verification' : 'unconfigured';
}
export function markSetupComplete(db: Db): void { setSetting(db, 'setup.complete', true); }

export function createSetupToken(db: Db, now = Date.now()): string {
  if (setupState(db) === 'complete') throw new Error('setup is already complete');
  const token = randomToken();
  setSetting(db, 'setup.token', { hash: hashToken(token), expiresAt: now + SETUP_TTL } satisfies SetupToken);
  return token;
}

export function completeSetup(db: Db, o: { token: string; ownerEmail: string; studioName: string; email: EmailConfig; baseUrl: string; now?: number }): { ok: true } | { ok: false; error: string } {
  const now = o.now ?? Date.now();
  const t = getSetting<SetupToken>(db, 'setup.token');
  if (!t || t.hash !== hashToken(o.token)) return { ok: false, error: 'invalid setup token' };
  if (t.expiresAt <= now) return { ok: false, error: 'setup token expired; run setup-token again' };
  const email = o.ownerEmail.trim().toLowerCase();
  db.transaction((tx) => {
    setSetting(tx as unknown as Db, 'setup.token', null);
    const id = newId();
    tx.insert(users).values({ id, email, role: 'owner' }).onConflictDoNothing().run();
    setSetting(tx as unknown as Db, 'studioName', o.studioName); setSetting(tx as unknown as Db, 'email', o.email);
    const link = createMagicLink(tx as unknown as Db, { kind: 'admin', email, now });
    sendEmail(tx as unknown as Db, { to: email, template: 'magic_link', vars: { studio: o.studioName, url: `${o.baseUrl}/auth/${link.token}` }, key: `setup:${id}:${now}` });
  });
  return { ok: true };
}
```

`src/server/cli.ts`:
```ts
import { loadConfig } from './config.js';
import { openDb, migrate } from './db/client.js';
import { createSetupToken } from './auth/bootstrap.js';
import { join } from 'node:path';

const [cmd] = process.argv.slice(2);
const config = loadConfig(process.env);
const db = openDb(join(config.dataDir, 'opengallery.db')); migrate(db);
if (cmd === 'setup-token') {
  const token = createSetupToken(db);
  console.log(`Open this URL within 15 minutes:\n\n  ${config.baseUrl}/setup?token=${token}\n`);
} else { console.error('usage: opengallery setup-token'); process.exit(2); }
```

- [ ] **Step 4: Run tests**

Run: `npx vitest run tests/auth/bootstrap.test.ts`
Expected: 3 passed.

- [ ] **Step 5: Commit**

```bash
git add src/server/auth/bootstrap.ts src/server/cli.ts tests/auth/bootstrap.test.ts
git commit -m "feat: token-gated bootstrap creating the first owner and verifying email"
```

---

### Task 14: Access middleware — the one scoping function

**Files:**
- Create: `src/server/http/access.ts`, `tests/http/access.test.ts`

**Interfaces:**
- Consumes: `AppEnv`, `SessionRow`, `projects`, `clients`, `photos`, `users`.
- Produces:
  - `canAccessProject(db, session: SessionRow | null, project: ProjectRow): 'ok' | 'forbidden' | 'not_found'` — the single rule set. Admins (users table row exists for the session subject): any project. Clients: email in `client.emails`, project `available`, not `transferPending`, not archived. Guests: `session.projectId === project.id` and same availability rules. Plugin/MCP: handled in later milestones (return `forbidden` for now).
  - `requireKind(...kinds: SessionRow['kind'][]): MiddlewareHandler<AppEnv>` → 401 JSON when no session or wrong kind.
  - `loadProject(): MiddlewareHandler<AppEnv & { Variables: { project: ProjectRow } }>` reading `:id`, applying `canAccessProject`, 404 for `not_found` **and** `forbidden` (no existence leak), sets `c.var.project`.
  - `loadPhoto(): MiddlewareHandler<...& { photo: PhotoRow }>` reading `:photoId`, resolving its project server-side, same rule.
  - `listProjectsFor(db, session): ProjectRow[]`.

- [ ] **Step 1: Write the failing test**

`tests/http/access.test.ts`:
```ts
import { describe, it, expect } from 'vitest';
import { openDb, migrate } from '../../src/server/db/client.js';
import { clients, projects, photos, users, sessions } from '../../src/server/db/schema.js';
import { canAccessProject, listProjectsFor } from '../../src/server/http/access.js';

function fresh() {
  const db = openDb(':memory:'); migrate(db);
  db.insert(clients).values([{ id: 'c1', folderPath: 'Clients/A', name: 'A', emails: ['sarah@x'] }, { id: 'c2', folderPath: 'Clients/B', name: 'B', emails: ['bob@x'] }]).run();
  db.insert(projects).values([
    { id: 'p1', clientId: 'c1', folderPath: 'Clients/A/P1', metadataJson: {} },
    { id: 'p2', clientId: 'c2', folderPath: 'Clients/B/P2', metadataJson: {} },
    { id: 'p3', clientId: 'c1', folderPath: 'Clients/A/P3', metadataJson: {}, available: false },
    { id: 'p4', clientId: 'c1', folderPath: 'Clients/A/P4', metadataJson: {}, archivedAt: '2026-01-01T00:00:00Z' },
    { id: 'p5', clientId: 'c1', folderPath: 'Clients/A/P5', metadataJson: {}, transferPending: true },
  ]).run();
  db.insert(users).values({ id: 'u1', email: 'owner@x', role: 'owner' }).run();
  const s = (id: string, kind: 'client' | 'admin' | 'guest', subject: string, projectId: string | null = null) => ({ id, kind, subject, projectId, expiresAt: '2999-01-01T00:00:00Z', scope: 'read', loginTokenHash: null, tokenHash: null, redeemedAt: null, nickname: null, createdAt: '' });
  return { db, sarah: s('s1', 'client', 'sarah@x'), bob: s('s2', 'client', 'bob@x'), owner: s('s3', 'admin', 'owner@x'), guest: s('s4', 'guest', 'Guest 1', 'p1'), impostor: s('s5', 'admin', 'nobody@x') };
}
const P = (db: ReturnType<typeof openDb>, id: string) => db.select().from(projects).all().find((p) => p.id === id)!;

describe('canAccessProject', () => {
  it('clients see only their own available projects', () => {
    const { db, sarah, bob } = fresh();
    expect(canAccessProject(db, sarah, P(db, 'p1'))).toBe('ok');
    expect(canAccessProject(db, bob, P(db, 'p1'))).toBe('forbidden');
    expect(canAccessProject(db, sarah, P(db, 'p3'))).toBe('forbidden');   // unavailable
    expect(canAccessProject(db, sarah, P(db, 'p4'))).toBe('forbidden');   // archived
    expect(canAccessProject(db, sarah, P(db, 'p5'))).toBe('forbidden');   // transfer pending
    expect(canAccessProject(db, null, P(db, 'p1'))).toBe('forbidden');
  });
  it('admins see everything; an admin session without a users row sees nothing', () => {
    const { db, owner, impostor } = fresh();
    for (const id of ['p1', 'p2', 'p3', 'p4', 'p5']) expect(canAccessProject(db, owner, P(db, id))).toBe('ok');
    expect(canAccessProject(db, impostor, P(db, 'p1'))).toBe('forbidden');
  });
  it('guests are bound to their session project', () => {
    const { db, guest } = fresh();
    expect(canAccessProject(db, guest, P(db, 'p1'))).toBe('ok');
    expect(canAccessProject(db, guest, P(db, 'p2'))).toBe('forbidden');
  });
  it('lists projects per session', () => {
    const { db, sarah, owner, guest } = fresh();
    expect(listProjectsFor(db, sarah).map((p) => p.id)).toEqual(['p1']);
    expect(listProjectsFor(db, owner)).toHaveLength(5);
    expect(listProjectsFor(db, guest).map((p) => p.id)).toEqual(['p1']);
  });
  void sessions; void photos;
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run tests/http/access.test.ts`
Expected: FAIL, missing module.

- [ ] **Step 3: Implement**

`src/server/http/access.ts`:
```ts
import type { MiddlewareHandler } from 'hono';
import { eq } from 'drizzle-orm';
import type { Db } from '../db/client.js';
import { clients, projects, photos, users } from '../db/schema.js';
import type { SessionRow } from '../auth/magic.js';
import type { AppEnv } from './session.js';

export type ProjectRow = typeof projects.$inferSelect; export type PhotoRow = typeof photos.$inferSelect;
export type Access = 'ok' | 'forbidden' | 'not_found';

function isAdmin(db: Db, s: SessionRow) { return s.kind === 'admin' && !!db.select({ id: users.id }).from(users).where(eq(users.email, s.subject)).get(); }
function servable(p: ProjectRow) { return p.available && !p.transferPending && p.archivedAt === null; }

/** The one scoping rule. Every project-bound route goes through here. */
export function canAccessProject(db: Db, s: SessionRow | null, p: ProjectRow): Access {
  if (!s) return 'forbidden';
  if (s.kind === 'admin') return isAdmin(db, s) ? 'ok' : 'forbidden';
  if (!servable(p)) return 'forbidden';
  if (s.kind === 'client') {
    const c = db.select({ emails: clients.emails }).from(clients).where(eq(clients.id, p.clientId)).get();
    return c?.emails.map((e) => e.toLowerCase()).includes(s.subject.toLowerCase()) ? 'ok' : 'forbidden';
  }
  if (s.kind === 'guest') return s.projectId === p.id ? 'ok' : 'forbidden';
  return 'forbidden'; // plugin / mcp: milestones 4 and 10
}

export function listProjectsFor(db: Db, s: SessionRow | null): ProjectRow[] {
  return db.select().from(projects).all().filter((p) => canAccessProject(db, s, p) === 'ok');
}

export function requireKind(...kinds: SessionRow['kind'][]): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    const s = c.get('session');
    if (!s || !kinds.includes(s.kind) || (s.kind === 'admin' && !isAdmin(c.get('db'), s))) return c.json({ error: 'unauthorized' }, 401);
    await next();
  };
}
export function loadProject(): MiddlewareHandler<AppEnv & { Variables: { project: ProjectRow } }> {
  return async (c, next) => {
    const db = c.get('db'); const p = db.select().from(projects).where(eq(projects.id, c.req.param('id')!)).get();
    if (!p || canAccessProject(db, c.get('session'), p) !== 'ok') return c.json({ error: 'not found' }, 404);
    c.set('project', p); await next();
  };
}
export function loadPhoto(): MiddlewareHandler<AppEnv & { Variables: { project: ProjectRow; photo: PhotoRow } }> {
  return async (c, next) => {
    const db = c.get('db'); const ph = db.select().from(photos).where(eq(photos.id, c.req.param('photoId')!)).get();
    const p = ph && db.select().from(projects).where(eq(projects.id, ph.projectId)).get();
    if (!ph || !p || canAccessProject(db, c.get('session'), p) !== 'ok') return c.json({ error: 'not found' }, 404);
    c.set('project', p); c.set('photo', ph); await next();
  };
}
```

`AppEnv` needs `db` in Variables. Update `src/server/http/session.ts`: `export type AppEnv = { Variables: { session: SessionRow | null; sessionToken: string | null; db: Db } };` and add `dbMiddleware(db)` that sets `c.set('db', db)`.

- [ ] **Step 4: Run tests**

Run: `npx vitest run tests/http/access.test.ts tests/auth`
Expected: all passed.

- [ ] **Step 5: Commit**

```bash
git add src/server/http/access.ts src/server/http/session.ts tests/http/access.test.ts
git commit -m "feat: single access-scoping rule for projects and photos"
```

---

### Task 15: HTTP routes, app assembly, boot

**Files:**
- Create: `src/server/app.ts`, `src/server/index.ts`, `src/server/http/routes/health.ts`, `src/server/http/routes/setup.ts`, `src/server/http/routes/auth.ts`, `src/server/http/routes/projects.ts`, `src/server/http/routes/photos.ts`, `src/server/http/routes/issues.ts`, `tests/http/app.test.ts`

**Interfaces:**
- Consumes: everything above.
- Produces: `createApp(deps: AppDeps): Hono<AppEnv>` where `AppDeps = { db: Db; config: Config; photosDir: string }`; `main()` in `index.ts`.
- Routes:
  - `GET /healthz` → `{ ok: true, setup: 'unconfigured'|'awaiting_verification'|'complete', email: boolean }` (200 always).
  - `POST /api/setup` `{ token, ownerEmail, studioName, email: EmailConfig }` → 200 `{ ok: true }` or 400 `{ error }`. Any other `/api/*` route returns 503 `{ error: 'setup_required' }` until setup state is `complete`, except `/api/setup`, `/healthz`, and `/auth/:token`.
  - `POST /api/auth/request` `{ email }` → always 200 `{ ok: true }` (no account enumeration). Creates an admin link if the email is a user, a client link if the email appears in any `clients.emails`, otherwise sends nothing. Rate limit: 5 per email and 20 per IP per 15 minutes (in-memory map; `ponytail:` per-process, fine for one NAS).
  - `GET /auth/:token` → redeem; on success set cookie and redirect `/`; on first admin redeem while `awaiting_verification`, call `markSetupComplete`. Failure redirects `/signin?error=expired`.
  - `POST /api/auth/signout` → clears session.
  - `GET /api/me` → `{ kind, subject, isAdmin }` or 401.
  - `GET /api/projects` → `listProjectsFor` as `{ id, title, date, folderPath, state }`.
  - `GET /api/projects/:id` → project summary + counts.
  - `GET /api/projects/:id/photos` → `[{ id, relPath, stage, kind, width, height, hasDraft }]` for non-missing photos; drafts excluded for non-admins.
  - `GET /api/photos/:photoId/preview?size=thumb|preview` → JPEG from `.cache`; 404 until generated; `Cache-Control: private, max-age=3600`.
  - `GET /api/issues` (admin) → `currentIssues()`.
  - `POST /api/projects/:id/approve-transfer` (admin) → `approveTransfer`.
  - Security headers on every response: `X-Content-Type-Options: nosniff`, `X-Frame-Options: DENY`, `Referrer-Policy: same-origin`, `Content-Security-Policy: default-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'`. CSRF: state-changing `/api/*` requests must carry `X-Requested-With: fetch` (a custom header cannot be sent cross-origin without CORS preflight, which is never granted).

- [ ] **Step 1: Write the failing end-to-end test (this is also the minimum-install gate)**

`tests/http/app.test.ts`:
```ts
import { describe, it, expect } from 'vitest';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpDir } from '../helpers.js';
import { makeTiffAs } from '../fixtures/make.js';
import { openDb, migrate } from '../../src/server/db/client.js';
import { loadConfig } from '../../src/server/config.js';
import { createApp } from '../../src/server/app.js';
import { createSetupToken } from '../../src/server/auth/bootstrap.js';
import { jobs } from '../../src/server/db/schema.js';
import { runOnce } from '../../src/server/jobs/queue.js';
import { makeEmailHandlers } from '../../src/server/email/send.js';
import { memoryTransport } from '../../src/server/email/transport.js';
import { rescan } from '../../src/server/fs/index.js';
import { indexProjectMedia } from '../../src/server/fs/photos.js';
import { makePreviewHandlers } from '../../src/server/fs/photos.js';
import { writeJsonAtomic } from '../../src/server/fs/json.js';
import { defaultClientJson, defaultProjectJson } from '../../src/server/fs/schemas.js';

async function boot() {
  const photosDir = await tmpDir(); const dataDir = await tmpDir();
  await mkdir(join(photosDir, 'Clients'), { recursive: true });
  const config = loadConfig({ DATA_DIR: dataDir, PHOTOS_DIR: photosDir, BASE_URL: 'http://localhost:3000', SESSION_SECRET: 'x'.repeat(32) });
  const db = openDb(':memory:'); migrate(db);
  const app = createApp({ db, config, photosDir });
  const mail = memoryTransport();
  const handlers = { ...makeEmailHandlers(() => mail, 'localhost'), ...makePreviewHandlers(photosDir) };
  const drain = async () => { while ((await runOnce(db, handlers)) === 'ran') { /* */ } };
  const api = (path: string, init: RequestInit & { cookie?: string } = {}) => app.request(path, { ...init, headers: { 'content-type': 'application/json', 'x-requested-with': 'fetch', ...(init.cookie ? { cookie: init.cookie } : {}), ...(init.headers ?? {}) } });
  return { db, app, api, mail, drain, photosDir };
}
const linkFrom = (text: string) => text.match(/http:\/\/localhost:3000\/auth\/[A-Za-z0-9_-]+/)![0];
const cookieOf = (res: Response) => res.headers.get('set-cookie')!.split(';')[0]!;

describe('app', () => {
  it('bootstraps with SMTP only, signs the owner in, gates the api until then', async () => {
    const { db, api, app, mail, drain } = await boot();
    expect((await (await api('/healthz')).json()).setup).toBe('unconfigured');
    expect((await api('/api/projects')).status).toBe(503);
    const token = createSetupToken(db);
    let res = await api('/api/setup', { method: 'POST', body: JSON.stringify({ token, ownerEmail: 'owner@x.com', studioName: 'S', email: { type: 'smtp', url: 'smtp://u:p@h:587', from: 'S <s@x>' } }) });
    expect(res.status).toBe(200);
    await drain(); expect(mail.sent).toHaveLength(1);
    expect((await api('/api/projects')).status).toBe(503);              // still awaiting verification
    res = await app.request(linkFrom(mail.sent[0]!.text), { redirect: 'manual' });
    expect(res.status).toBe(302); expect(res.headers.get('location')).toBe('/');
    const cookie = cookieOf(res); expect(cookie).toMatch(/^og_session=/); expect(res.headers.get('set-cookie')).toMatch(/HttpOnly/);
    expect((await (await api('/healthz')).json()).setup).toBe('complete');
    expect(await (await api('/api/me', { cookie })).json()).toMatchObject({ kind: 'admin', isAdmin: true });
    expect((await app.request(linkFrom(mail.sent[0]!.text), { redirect: 'manual' })).headers.get('location')).toMatch(/error=expired/); // single use
  });
  it('serves a client only their project and its previews', async () => {
    const { db, api, app, mail, drain, photosDir } = await boot();
    const token = createSetupToken(db);
    await api('/api/setup', { method: 'POST', body: JSON.stringify({ token, ownerEmail: 'owner@x.com', studioName: 'S', email: { type: 'smtp', url: 'smtp://u:p@h:587', from: 'S <s@x>' } }) });
    await drain(); await app.request(linkFrom(mail.sent[0]!.text), { redirect: 'manual' });
    const c = defaultClientJson('Smith'); c.emails = ['sarah@x.com']; const p = defaultProjectJson('Wedding'); const q = defaultProjectJson('Other');
    await mkdir(join(photosDir, 'Clients/Smith/Wedding/raw'), { recursive: true }); await mkdir(join(photosDir, 'Clients/Jones/Other'), { recursive: true });
    await writeJsonAtomic(join(photosDir, 'Clients/Smith/client.json'), c);
    await writeJsonAtomic(join(photosDir, 'Clients/Smith/Wedding/project.json'), p);
    await writeJsonAtomic(join(photosDir, 'Clients/Jones/client.json'), defaultClientJson('Jones'));
    await writeJsonAtomic(join(photosDir, 'Clients/Jones/Other/project.json'), q);
    await makeTiffAs(join(photosDir, 'Clients/Smith/Wedding/raw/a.dng'));
    await rescan(db, photosDir); await indexProjectMedia(db, photosDir, p.id!); await drain();

    await api('/api/auth/request', { method: 'POST', body: JSON.stringify({ email: 'sarah@x.com' }) }); await drain();
    const res = await app.request(linkFrom(mail.sent[1]!.text), { redirect: 'manual' }); const cookie = cookieOf(res);
    const list = await (await api('/api/projects', { cookie })).json() as { id: string }[];
    expect(list.map((x) => x.id)).toEqual([p.id]);
    expect((await api(`/api/projects/${q.id}`, { cookie })).status).toBe(404);
    const photos = await (await api(`/api/projects/${p.id}/photos`, { cookie })).json() as { id: string }[];
    expect(photos).toHaveLength(1);
    const img = await api(`/api/photos/${photos[0]!.id}/preview?size=thumb`, { cookie });
    expect(img.status).toBe(200); expect(img.headers.get('content-type')).toBe('image/jpeg');
    expect((await api(`/api/photos/${photos[0]!.id}/preview`)).status).toBe(404);          // no session → not found, no leak
    await api('/api/auth/request', { method: 'POST', body: JSON.stringify({ email: 'stranger@x.com' }) }); await drain();
    expect(mail.sent).toHaveLength(2);                                                        // unknown email: nothing sent, same 200
  });
  it('rejects state-changing requests without the fetch header', async () => {
    const { app } = await boot();
    const res = await app.request('/api/auth/request', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"email":"a@x"}' });
    expect(res.status).toBe(403);
  });
  it('sets security headers', async () => {
    const { api } = await boot(); const res = await api('/healthz');
    expect(res.headers.get('x-content-type-options')).toBe('nosniff'); expect(res.headers.get('content-security-policy')).toContain("default-src 'self'");
  });
  void jobs;
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run tests/http/app.test.ts`
Expected: FAIL, missing `app.js`.

- [ ] **Step 3: Implement routes**

`src/server/http/routes/health.ts`:
```ts
import { Hono } from 'hono';
import type { AppEnv } from '../session.js';
import { setupState } from '../../auth/bootstrap.js';
import { resolveTransport } from '../../email/transport.js';
import type { Config } from '../../config.js';
export const health = (config: Config) => new Hono<AppEnv>().get('/healthz', (c) => {
  const db = c.get('db'); return c.json({ ok: true, setup: setupState(db), email: resolveTransport(db, config) !== null });
});
```

`src/server/http/routes/setup.ts`:
```ts
import { Hono } from 'hono';
import { z } from 'zod';
import type { AppEnv } from '../session.js';
import { completeSetup } from '../../auth/bootstrap.js';
import type { Config } from '../../config.js';
const Body = z.object({ token: z.string(), ownerEmail: z.string().email(), studioName: z.string().min(1),
  email: z.discriminatedUnion('type', [z.object({ type: z.literal('smtp'), url: z.string().url(), from: z.string().min(3) }), z.object({ type: z.literal('listmonk'), url: z.string().url(), token: z.string().min(1), from: z.string().min(3), templateId: z.number().int() })]) });
export const setup = (config: Config) => new Hono<AppEnv>().post('/api/setup', async (c) => {
  const b = Body.safeParse(await c.req.json().catch(() => null)); if (!b.success) return c.json({ error: 'invalid body' }, 400);
  const r = completeSetup(c.get('db'), { ...b.data, baseUrl: config.baseUrl });
  return r.ok ? c.json({ ok: true }) : c.json({ error: r.error }, 400);
});
```

`src/server/http/routes/auth.ts`:
```ts
import { Hono } from 'hono';
import { z } from 'zod';
import { eq } from 'drizzle-orm';
import type { AppEnv } from '../session.js';
import { setSessionCookie, clearSessionCookie } from '../session.js';
import { createMagicLink, redeemMagicLink, signOut } from '../../auth/magic.js';
import { setupState, markSetupComplete } from '../../auth/bootstrap.js';
import { sendEmail } from '../../email/send.js';
import { getSetting } from '../../db/settings.js';
import { users, clients } from '../../db/schema.js';
import type { Config } from '../../config.js';

// ponytail: in-process rate limit; per-NAS single process. Move to sqlite if a second process ever appears.
const hits = new Map<string, number[]>();
function limited(key: string, max: number, windowMs = 15 * 60_000): boolean {
  const now = Date.now(); const arr = (hits.get(key) ?? []).filter((t) => t > now - windowMs); arr.push(now); hits.set(key, arr); return arr.length > max;
}

export const auth = (config: Config) => new Hono<AppEnv>()
  .post('/api/auth/request', async (c) => {
    const b = z.object({ email: z.string().email() }).safeParse(await c.req.json().catch(() => null)); if (!b.success) return c.json({ error: 'invalid body' }, 400);
    const email = b.data.email.toLowerCase(); const ip = c.req.header('cf-connecting-ip') ?? c.req.header('x-forwarded-for') ?? 'local';
    if (limited(`e:${email}`, 5) || limited(`ip:${ip}`, 20)) return c.json({ ok: true });
    const db = c.get('db'); const studio = getSetting<string>(db, 'studioName') ?? 'OpenGallery';
    const isUser = !!db.select({ id: users.id }).from(users).where(eq(users.email, email)).get();
    const isClient = db.select({ emails: clients.emails }).from(clients).all().some((r) => r.emails.map((e) => e.toLowerCase()).includes(email));
    const kind = isUser ? 'admin' : isClient ? 'client' : null;
    if (kind) { const link = createMagicLink(db, { kind, email }); sendEmail(db, { to: email, template: 'magic_link', vars: { studio, url: `${config.baseUrl}/auth/${link.token}` }, key: `magic:${email}:${Date.now()}` }); }
    return c.json({ ok: true });
  })
  .get('/auth/:token', (c) => {
    const db = c.get('db'); const r = redeemMagicLink(db, c.req.param('token'));
    if (!r) return c.redirect('/signin?error=expired');
    if (r.session.kind === 'admin' && setupState(db) === 'awaiting_verification') markSetupComplete(db);
    setSessionCookie(c, r.sessionToken, config.secureCookies); return c.redirect('/');
  })
  .post('/api/auth/signout', (c) => { const t = c.get('sessionToken'); if (t) signOut(c.get('db'), t); clearSessionCookie(c); return c.json({ ok: true }); })
  .get('/api/me', (c) => {
    const s = c.get('session'); if (!s) return c.json({ error: 'unauthorized' }, 401);
    const isAdmin = s.kind === 'admin' && !!c.get('db').select({ id: users.id }).from(users).where(eq(users.email, s.subject)).get();
    return c.json({ kind: s.kind, subject: s.subject, isAdmin, projectId: s.projectId });
  });
```

`src/server/http/routes/projects.ts`:
```ts
import { Hono } from 'hono';
import { eq, and } from 'drizzle-orm';
import type { AppEnv } from '../session.js';
import { listProjectsFor, loadProject, requireKind } from '../access.js';
import { photos } from '../../db/schema.js';
import { approveTransfer } from '../../fs/index.js';
import { ProjectJson } from '../../fs/schemas.js';

const summary = (p: { id: string; folderPath: string; date: string | null; bookingState: string; productionState: string; metadataJson: unknown }) =>
  ({ id: p.id, title: ProjectJson.parse(p.metadataJson).title, date: p.date, folderPath: p.folderPath, state: { booking: p.bookingState, production: p.productionState } });

export const projectRoutes = () => new Hono<AppEnv>()
  .get('/api/projects', (c) => c.json(listProjectsFor(c.get('db'), c.get('session')).map(summary)))
  .get('/api/projects/:id', loadProject(), (c) => {
    const p = c.get('project'); const rows = c.get('db').select().from(photos).where(and(eq(photos.projectId, p.id), eq(photos.missing, false))).all();
    return c.json({ ...summary(p), counts: { culling: rows.filter((r) => r.stage === 'culling').length, final: rows.filter((r) => r.stage === 'final' && !r.draftRelPath).length, drafts: rows.filter((r) => r.draftRelPath).length } });
  })
  .get('/api/projects/:id/photos', loadProject(), (c) => {
    const admin = c.get('session')?.kind === 'admin';
    const rows = c.get('db').select().from(photos).where(and(eq(photos.projectId, c.get('project').id), eq(photos.missing, false))).all()
      .filter((r) => admin || !r.draftRelPath).sort((a, b) => a.sortOrder - b.sortOrder || (a.capturedAt ?? '').localeCompare(b.capturedAt ?? '') || a.relPath.localeCompare(b.relPath));
    return c.json(rows.map((r) => ({ id: r.id, relPath: r.relPath, stage: r.stage, kind: r.kind, width: r.width, height: r.height, section: r.section, hasDraft: !!r.draftRelPath })));
  })
  .post('/api/projects/:id/approve-transfer', requireKind('admin'), (c) => { approveTransfer(c.get('db'), c.req.param('id'), c.get('session')!.subject); return c.json({ ok: true }); });
```

`src/server/http/routes/photos.ts`:
```ts
import { Hono } from 'hono';
import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { Readable } from 'node:stream';
import type { AppEnv } from '../session.js';
import { loadPhoto } from '../access.js';
import { cachePaths } from '../../fs/photos.js';

export const photoRoutes = (photosDir: string) => new Hono<AppEnv>()
  .get('/api/photos/:photoId/preview', loadPhoto(), async (c) => {
    const { preview, thumb } = cachePaths(photosDir, c.get('project'), c.get('photo').id);
    const file = c.req.query('size') === 'thumb' ? thumb : preview;
    const s = await stat(file).catch(() => null); if (!s) return c.json({ error: 'not ready' }, 404);
    c.header('content-type', 'image/jpeg'); c.header('content-length', String(s.size)); c.header('cache-control', 'private, max-age=3600');
    return c.body(Readable.toWeb(createReadStream(file)) as ReadableStream);
  });
```

`src/server/http/routes/issues.ts`:
```ts
import { Hono } from 'hono';
import type { AppEnv } from '../session.js';
import { requireKind } from '../access.js';
import { currentIssues } from '../../fs/index.js';
export const issueRoutes = () => new Hono<AppEnv>().get('/api/issues', requireKind('admin'), (c) => c.json(currentIssues()));
```

- [ ] **Step 4: Assemble the app and the boot file**

`src/server/app.ts`:
```ts
import { Hono } from 'hono';
import { serveStatic } from '@hono/node-server/serve-static';
import type { Db } from './db/client.js';
import type { Config } from './config.js';
import { sessionMiddleware, dbMiddleware, type AppEnv } from './http/session.js';
import { setupState } from './auth/bootstrap.js';
import { health } from './http/routes/health.js';
import { setup } from './http/routes/setup.js';
import { auth } from './http/routes/auth.js';
import { projectRoutes } from './http/routes/projects.js';
import { photoRoutes } from './http/routes/photos.js';
import { issueRoutes } from './http/routes/issues.js';

export type AppDeps = { db: Db; config: Config; photosDir: string };

export function createApp({ db, config, photosDir }: AppDeps): Hono<AppEnv> {
  const app = new Hono<AppEnv>();
  app.use('*', dbMiddleware(db));
  app.use('*', async (c, next) => {
    await next();
    c.header('x-content-type-options', 'nosniff'); c.header('x-frame-options', 'DENY'); c.header('referrer-policy', 'same-origin');
    c.header('content-security-policy', "default-src 'self'; img-src 'self' data: blob:; style-src 'self' 'unsafe-inline'; media-src 'self'");
  });
  app.use('/api/*', async (c, next) => {
    if (c.req.method !== 'GET' && c.req.method !== 'HEAD' && c.req.header('x-requested-with') !== 'fetch') return c.json({ error: 'forbidden' }, 403);
    await next();
  });
  app.use('*', sessionMiddleware(db));
  app.use('/api/*', async (c, next) => {
    if (c.req.path !== '/api/setup' && setupState(db) !== 'complete') return c.json({ error: 'setup_required', setup: setupState(db) }, 503);
    await next();
  });
  app.route('/', health(config)); app.route('/', setup(config)); app.route('/', auth(config));
  app.route('/', projectRoutes()); app.route('/', photoRoutes(photosDir)); app.route('/', issueRoutes());
  app.use('/assets/*', serveStatic({ root: './dist/web' }));
  app.get('*', serveStatic({ root: './dist/web', path: 'index.html' }));
  return app;
}
```

`src/server/index.ts`:
```ts
import { serve } from '@hono/node-server';
import { join } from 'node:path';
import { mkdir } from 'node:fs/promises';
import { loadConfig } from './config.js';
import { openDb, migrate } from './db/client.js';
import { createApp } from './app.js';
import { rescan } from './fs/index.js';
import { indexProjectMedia, makePreviewHandlers } from './fs/photos.js';
import { startWatcher } from './fs/watcher.js';
import { startWorker } from './jobs/worker.js';
import { makeEmailHandlers } from './email/send.js';
import { resolveTransport } from './email/transport.js';
import { projects } from './db/schema.js';

async function main() {
  const config = loadConfig(process.env);
  await mkdir(config.dataDir, { recursive: true }); await mkdir(join(config.photosDir, 'Clients'), { recursive: true });
  const db = openDb(join(config.dataDir, 'opengallery.db')); migrate(db);
  const handlers = { ...makeEmailHandlers(() => resolveTransport(db, config), new URL(config.baseUrl).hostname), ...makePreviewHandlers(config.photosDir) };
  const stopWorker = startWorker(db, handlers, { intervalMs: 2000 });
  const report = await rescan(db, config.photosDir);
  console.log(`[boot] ${report.clients} clients, ${report.projects} projects, ${report.issues.length} issues`);
  for (const p of db.select({ id: projects.id }).from(projects).all()) await indexProjectMedia(db, config.photosDir, p.id).catch((e) => console.error('[boot] index', p.id, e));
  const stopWatcher = startWatcher(db, config.photosDir);
  const server = serve({ fetch: createApp({ db, config, photosDir: config.photosDir }).fetch, port: config.port }, () => console.log(`[boot] listening on ${config.port}`));
  const shutdown = () => { stopWatcher(); stopWorker(); server.close(); process.exit(0); };
  process.on('SIGINT', shutdown); process.on('SIGTERM', shutdown);
}
main().catch((e) => { console.error(e); process.exit(1); });
```

Add to `src/server/http/session.ts`: `export function dbMiddleware(db: Db): MiddlewareHandler<AppEnv> { return async (c, next) => { c.set('db', db); await next(); }; }`.

- [ ] **Step 5: Run the full suite and typecheck**

Run: `npm run typecheck && npm test`
Expected: all tests pass, no type errors. Fix any `AppEnv` generic mismatches by giving each route file's `Hono<AppEnv>` the same `AppEnv` type from `session.ts`.

- [ ] **Step 6: Commit**

```bash
git add src/server/app.ts src/server/index.ts src/server/http tests/http/app.test.ts
git commit -m "feat: http api, setup and auth routes, entitled project/photo access, boot"
```

---

### Task 16: Web shell — setup, sign-in, home

**Files:**
- Create: `vite.config.ts`, `src/web/index.html`, `src/web/main.tsx`, `src/web/App.tsx`, `src/web/api.ts`, `src/web/pages/Setup.tsx`, `src/web/pages/SignIn.tsx`, `src/web/pages/Home.tsx`, `src/web/index.css`, `tests/web/build.test.ts`
- Modify: `package.json` scripts (`build` copies migrations), `tsconfig.web.json`

**Interfaces:**
- Consumes: the JSON routes from Task 15.
- Produces: `dist/web/index.html` + `dist/web/assets/*` served by `app.ts`. `api.ts` exports `api<T>(path, init?)` that always sends `X-Requested-With: fetch` and `credentials: 'same-origin'`.

- [ ] **Step 1: Vite and the shell**

`vite.config.ts`:
```ts
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
export default defineConfig({ root: 'src/web', plugins: [react(), tailwindcss()], build: { outDir: '../../dist/web', emptyOutDir: true }, server: { proxy: { '/api': 'http://localhost:3000', '/auth': 'http://localhost:3000', '/healthz': 'http://localhost:3000' } } });
```

`tsconfig.web.json`:
```json
{ "compilerOptions": { "target": "ES2022", "module": "ESNext", "moduleResolution": "Bundler", "jsx": "react-jsx", "strict": true, "skipLibCheck": true, "noEmit": true, "lib": ["ES2022", "DOM"] }, "include": ["src/web"] }
```

`package.json` scripts: `"build": "tsc -p tsconfig.json && cp -R src/server/db/migrations dist/server/db/ && vite build"`, `"typecheck": "tsc -p tsconfig.json --noEmit && tsc -p tsconfig.web.json"`, `"dev:web": "vite"`.

`src/web/index.html`:
```html
<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover"><meta name="apple-mobile-web-app-capable" content="yes"><title>OpenGallery</title></head><body><div id="root"></div><script type="module" src="/main.tsx"></script></body></html>
```

`src/web/index.css`:
```css
@import "tailwindcss";
:root { color-scheme: light dark; }
body { font-family: -apple-system, BlinkMacSystemFont, "SF Pro Text", system-ui, sans-serif; -webkit-font-smoothing: antialiased; padding: env(safe-area-inset-top) env(safe-area-inset-right) env(safe-area-inset-bottom) env(safe-area-inset-left); }
```

`src/web/api.ts`:
```ts
export class ApiError extends Error { constructor(public status: number, msg: string) { super(msg); } }
export async function api<T>(path: string, init: RequestInit = {}): Promise<T> {
  const res = await fetch(path, { credentials: 'same-origin', ...init, headers: { 'content-type': 'application/json', 'x-requested-with': 'fetch', ...(init.headers ?? {}) } });
  if (!res.ok) throw new ApiError(res.status, (await res.json().catch(() => ({ error: res.statusText }))).error);
  return res.json() as Promise<T>;
}
```

`src/web/main.tsx`:
```tsx
import { createRoot } from 'react-dom/client';
import './index.css';
import { App } from './App';
createRoot(document.getElementById('root')!).render(<App />);
```

`src/web/App.tsx`:
```tsx
import { useEffect, useState } from 'react';
import { api } from './api';
import { Setup } from './pages/Setup';
import { SignIn } from './pages/SignIn';
import { Home } from './pages/Home';

type Health = { setup: 'unconfigured' | 'awaiting_verification' | 'complete'; email: boolean };
type Me = { kind: string; subject: string; isAdmin: boolean };

export function App() {
  const [health, setHealth] = useState<Health | null>(null);
  const [me, setMe] = useState<Me | null | undefined>(undefined);
  useEffect(() => { void api<Health>('/healthz').then(setHealth); void api<Me>('/api/me').then(setMe).catch(() => setMe(null)); }, []);
  const path = window.location.pathname;
  if (!health || me === undefined) return null;
  if (path === '/setup' || health.setup === 'unconfigured') return <Setup state={health.setup} />;
  if (health.setup === 'awaiting_verification') return <Setup state={health.setup} />;
  if (!me) return <SignIn />;
  return <Home me={me} />;
}
```

`src/web/pages/Setup.tsx`:
```tsx
import { useState } from 'react';
import { api } from '../api';
export function Setup({ state }: { state: string }) {
  const token = new URLSearchParams(window.location.search).get('token') ?? '';
  const [f, setF] = useState({ ownerEmail: '', studioName: '', smtpUrl: '', from: '' });
  const [msg, setMsg] = useState<string | null>(null);
  if (state === 'awaiting_verification') return <main className="mx-auto max-w-md p-6"><h1 className="text-2xl font-semibold">Check your email</h1><p className="mt-2 text-neutral-600">We sent a sign-in link to the owner address. Open it to finish setup.</p></main>;
  if (!token) return <main className="mx-auto max-w-md p-6"><h1 className="text-2xl font-semibold">Setup</h1><p className="mt-2 text-neutral-600">Run <code>opengallery setup-token</code> on the server and open the URL it prints.</p></main>;
  const submit = async (e: React.FormEvent) => { e.preventDefault(); setMsg(null);
    try { await api('/api/setup', { method: 'POST', body: JSON.stringify({ token, ownerEmail: f.ownerEmail, studioName: f.studioName, email: { type: 'smtp', url: f.smtpUrl, from: f.from } }) }); window.location.href = '/'; }
    catch (err) { setMsg((err as Error).message); } };
  const field = (k: keyof typeof f, label: string, type = 'text', ph = '') => <label className="block"><span className="text-sm text-neutral-600">{label}</span><input required type={type} placeholder={ph} value={f[k]} onChange={(e) => setF({ ...f, [k]: e.target.value })} className="mt-1 w-full rounded-xl border border-neutral-300 px-3 py-3 text-base" /></label>;
  return <main className="mx-auto max-w-md p-6"><h1 className="text-2xl font-semibold">Set up OpenGallery</h1>
    <form onSubmit={submit} className="mt-6 space-y-4">
      {field('studioName', 'Studio name')}{field('ownerEmail', 'Your email', 'email')}{field('smtpUrl', 'SMTP URL', 'url', 'smtp://user:pass@host:587')}{field('from', 'From address', 'text', 'Studio <hello@studio.com>')}
      {msg && <p className="text-red-600 text-sm">{msg}</p>}
      <button className="w-full rounded-xl bg-black py-3 text-white text-base font-medium">Send my sign-in link</button>
    </form></main>;
}
```

`src/web/pages/SignIn.tsx`:
```tsx
import { useState } from 'react';
import { api } from '../api';
export function SignIn() {
  const [email, setEmail] = useState(''); const [sent, setSent] = useState(false);
  const expired = new URLSearchParams(window.location.search).get('error') === 'expired';
  const submit = async (e: React.FormEvent) => { e.preventDefault(); await api('/api/auth/request', { method: 'POST', body: JSON.stringify({ email }) }); setSent(true); };
  return <main className="mx-auto max-w-md p-6 pt-24"><h1 className="text-3xl font-semibold">Sign in</h1>
    {expired && <p className="mt-2 text-amber-700">That link has expired or was already used. Request a new one.</p>}
    {sent ? <p className="mt-4 text-neutral-600">If that address is on file, a sign-in link is on its way.</p> :
      <form onSubmit={submit} className="mt-6 space-y-4"><input required type="email" autoComplete="email" placeholder="you@example.com" value={email} onChange={(e) => setEmail(e.target.value)} className="w-full rounded-xl border border-neutral-300 px-3 py-3 text-base" />
        <button className="w-full rounded-xl bg-black py-3 text-white text-base font-medium">Email me a link</button></form>}
  </main>;
}
```

`src/web/pages/Home.tsx`:
```tsx
import { useEffect, useState } from 'react';
import { api } from '../api';
type Project = { id: string; title: string; date: string | null; state: { booking: string; production: string } };
type Photo = { id: string; stage: string; width: number | null; height: number | null };
export function Home({ me }: { me: { kind: string; subject: string; isAdmin: boolean } }) {
  const [projects, setProjects] = useState<Project[]>([]); const [open, setOpen] = useState<Project | null>(null); const [photos, setPhotos] = useState<Photo[]>([]);
  useEffect(() => { void api<Project[]>('/api/projects').then(setProjects); }, []);
  useEffect(() => { if (open) void api<Photo[]>(`/api/projects/${open.id}/photos`).then(setPhotos); }, [open]);
  const signout = async () => { await api('/api/auth/signout', { method: 'POST' }); window.location.reload(); };
  if (open) return <main className="p-2"><button onClick={() => setOpen(null)} className="p-3 text-blue-600">‹ Back</button><h1 className="px-3 text-2xl font-semibold">{open.title}</h1>
    <div className="mt-3 grid grid-cols-3 gap-0.5">{photos.map((p) => <img key={p.id} src={`/api/photos/${p.id}/preview?size=thumb`} loading="lazy" className="aspect-square w-full object-cover bg-neutral-200" alt="" />)}</div></main>;
  return <main className="mx-auto max-w-2xl p-6"><header className="flex items-baseline justify-between"><h1 className="text-3xl font-semibold">{me.isAdmin ? 'Projects' : 'Your projects'}</h1><button onClick={signout} className="text-sm text-neutral-500">Sign out</button></header>
    <ul className="mt-6 divide-y divide-neutral-200">{projects.map((p) => <li key={p.id}><button onClick={() => setOpen(p)} className="flex w-full items-center justify-between py-4 text-left"><span><span className="block text-lg">{p.title}</span><span className="text-sm text-neutral-500">{p.date ?? 'No date'} · {p.state.production.replace('_', ' ')}</span></span><span className="text-neutral-400">›</span></button></li>)}
      {projects.length === 0 && <li className="py-8 text-neutral-500">Nothing here yet.</li>}</ul></main>;
}
```

- [ ] **Step 2: Build test**

`tests/web/build.test.ts`:
```ts
import { describe, it, expect } from 'vitest';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { stat } from 'node:fs/promises';
describe('web build', () => {
  it('produces dist/web/index.html', async () => {
    await promisify(execFile)('npx', ['vite', 'build'], { cwd: process.cwd() });
    expect((await stat('dist/web/index.html')).isFile()).toBe(true);
  }, 120_000);
});
```

- [ ] **Step 3: Run**

Run: `npm run typecheck && npx vitest run tests/web/build.test.ts`
Expected: pass. Then `npm run build && DATA_DIR=/tmp/ogd PHOTOS_DIR=/tmp/ogp BASE_URL=http://localhost:3000 SESSION_SECRET=$(head -c 48 /dev/urandom | base64) npm start` in one terminal, `npm run cli -- setup-token` with the same env in another, open the printed URL, fill the form with a real SMTP URL (or a local MailHog `smtp://localhost:1025`), open the emailed link, see "Projects". Drop a client/project folder with a RAW into `/tmp/ogp/Clients/` and confirm the thumbnail appears.

- [ ] **Step 4: Commit**

```bash
git add vite.config.ts tsconfig.web.json package.json src/web tests/web
git commit -m "feat: iOS-first web shell with setup, sign-in, and project list"
```

---

### Task 17: Docker image, Compose with profiles, install and backup docs

**Files:**
- Create: `Dockerfile`, `compose.yml`, `docs/install.md`, `docs/backup-restore.md`, `.dockerignore`, `.github/workflows/ci.yml`

- [ ] **Step 1: Dockerfile and .dockerignore**

`Dockerfile`:
```dockerfile
FROM node:22-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
RUN npm run build && npm prune --omit=dev

FROM node:22-bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends libimage-exiftool-perl ffmpeg ca-certificates && rm -rf /var/lib/apt/lists/*
WORKDIR /app
ENV NODE_ENV=production DATA_DIR=/data PHOTOS_DIR=/photos PORT=3000
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY --from=build /app/package.json ./
VOLUME ["/data", "/photos"]
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s CMD node -e "fetch('http://127.0.0.1:3000/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "dist/server/index.js"]
```

`.dockerignore`: `node_modules`, `dist`, `.git`, `References`, `docs`, `tests`, `*.db*`.

- [ ] **Step 2: compose.yml with profiles**

```yaml
services:
  opengallery:
    image: ghcr.io/pyamzi/opengallery:latest
    build: .
    restart: unless-stopped
    env_file: .env
    volumes:
      - ${DATA_ROOT:-./data}:/data          # local NAS disk, never SMB
      - ${PHOTOS_ROOT:-./photos}:/photos     # the folder tree you also share over SMB
    ports:
      - "127.0.0.1:3000:3000"                # only the tunnel reaches it from outside

  cloudflared:
    image: cloudflare/cloudflared:latest
    restart: unless-stopped
    command: tunnel --no-autoupdate run --token ${CLOUDFLARE_TUNNEL_TOKEN}
    depends_on: [opengallery]

  listmonk:
    profiles: [listmonk]
    image: listmonk/listmonk:latest
    restart: unless-stopped
    ports: ["127.0.0.1:9000:9000"]
    environment:
      LISTMONK_app__address: 0.0.0.0:9000
      LISTMONK_db__host: listmonk-db
      LISTMONK_db__user: listmonk
      LISTMONK_db__password: ${LISTMONK_DB_PASSWORD:-listmonk}
      LISTMONK_db__database: listmonk
    depends_on: [listmonk-db]
  listmonk-db:
    profiles: [listmonk]
    image: postgres:16-alpine
    restart: unless-stopped
    environment: { POSTGRES_USER: listmonk, POSTGRES_PASSWORD: "${LISTMONK_DB_PASSWORD:-listmonk}", POSTGRES_DB: listmonk }
    volumes: ["${DATA_ROOT:-./data}/listmonk-db:/var/lib/postgresql/data"]

  docuseal:
    profiles: [docuseal]
    image: docuseal/docuseal:latest
    restart: unless-stopped
    ports: ["127.0.0.1:3001:3000"]
    volumes: ["${DATA_ROOT:-./data}/docuseal:/data"]
```

Run: `docker compose config` — expected: valid; `docker compose --profile listmonk config` lists five services.

- [ ] **Step 3: docs/install.md and docs/backup-restore.md**

`docs/install.md` covers, in this order: prerequisites (UGOS Docker, a domain on Cloudflare, an SMTP account); `git clone`, `cp .env.example .env`, fill `SESSION_SECRET` with `openssl rand -base64 48`, `BASE_URL`, `SMTP_URL`, `CLOUDFLARE_TUNNEL_TOKEN`; `docker compose up -d`; `docker compose exec opengallery node dist/server/cli.js setup-token`; open the URL, finish the form, open the emailed link; share `PHOTOS_ROOT` over SMB from UGOS; optional `--profile listmonk` / `--profile docuseal`; upgrading with `docker compose pull && docker compose up -d`.

`docs/backup-restore.md` states exactly: what to back up (`DATA_ROOT` including `opengallery.db`, `-wal`, `-shm`; `PHOTOS_ROOT`; `DATA_ROOT/listmonk-db` and `DATA_ROOT/docuseal` if enabled), how (stop the stack or use a UGOS snapshot that captures both roots at the same instant; never copy the `.db` alone while running), that reindexing `/photos` alone does not restore sessions, jobs, or (later) invoices, and a restore rehearsal: restore both roots to a scratch path, run `docker compose up` with those paths, check `/healthz` and that a known project lists its photos.

- [ ] **Step 4: CI**

`.github/workflows/ci.yml`:
```yaml
name: ci
on: [push, pull_request]
jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with: { node-version: 22, cache: npm }
      - run: sudo apt-get update && sudo apt-get install -y libimage-exiftool-perl
      - run: npm ci
      - run: npm run typecheck
      - run: npm test
      - run: npm audit --audit-level=high
      - uses: gitleaks/gitleaks-action@v2
        env: { GITHUB_TOKEN: "${{ secrets.GITHUB_TOKEN }}" }
  image:
    needs: test
    if: startsWith(github.ref, 'refs/tags/v')
    runs-on: ubuntu-latest
    permissions: { contents: read, packages: write }
    steps:
      - uses: actions/checkout@v4
      - uses: docker/setup-qemu-action@v3
      - uses: docker/setup-buildx-action@v3
      - uses: docker/login-action@v3
        with: { registry: ghcr.io, username: "${{ github.actor }}", password: "${{ secrets.GITHUB_TOKEN }}" }
      - uses: docker/build-push-action@v6
        with: { push: true, platforms: linux/amd64,linux/arm64, tags: "ghcr.io/${{ github.repository }}:${{ github.ref_name }},ghcr.io/${{ github.repository }}:latest" }
```

- [ ] **Step 5: Build the image locally and run the minimum-install flow inside it**

Run: `docker compose build && DATA_ROOT=/tmp/og-data PHOTOS_ROOT=/tmp/og-photos docker compose up -d opengallery && docker compose exec opengallery node dist/server/cli.js setup-token`
Expected: image builds; `/healthz` at `http://127.0.0.1:3000/healthz` returns `setup: "unconfigured"`; the setup URL prints. Complete setup via a real SMTP account, confirm the email arrives and signs you in. `docker compose down`.

- [ ] **Step 6: Commit**

```bash
git add Dockerfile .dockerignore compose.yml docs/install.md docs/backup-restore.md .github
git commit -m "chore: docker image, compose with optional profiles, install and backup docs, CI"
```

---

### Task 18: Milestone gate — run the acceptance checks and record them

**Files:**
- Create: `docs/gates/m1-foundation.md`

Spec §18 gates for this milestone: **Identity**, **Minimum install**, **Write policy**. Most evidence is automated above; this task runs it all, does the two manual checks, and writes the record.

- [ ] **Step 1: Automated evidence**

Run: `npm run typecheck && npm test`
Expected: green. Map tests to gates:
- Identity → `tests/fs/index.test.ts` (rename while stopped, missing, duplicate, wrong depth, transfer approval, machine-field restore) and `tests/fs/photos.test.ts` (renamed RAW shows missing + new).
- Minimum install → `tests/http/app.test.ts` (bootstrap with SMTP only, api gated until verified, single-use link, unknown email gets nothing, no-session preview is 404).
- Write policy → `tests/fs/paths.test.ts` (traversal, symlink), `tests/fs/media.test.ts` (signature mismatch rejected, unknown types rejected), `tests/fs/photos.test.ts` (unsupported skipped; SMB-discovered files go through the same sniff).

- [ ] **Step 2: Manual checks**

1. **Stopped-state move, real disk:** with the container stopped, in Finder move a populated project into another client's folder. Start. `/api/issues` shows `transfer_pending`; the client cannot list it; approve via `POST /api/projects/:id/approve-transfer`; it appears again with the same id and photos.
2. **Transport outage:** set an unreachable `SMTP_URL`, request a sign-in link; the job lands in `failed` after 3 attempts with a readable `last_error` (inspect with `sqlite3 data/opengallery.db 'select state,last_error from jobs'`). Fix the URL, restart; `recoverLeases` and the backoff timer retry nothing automatically (attempts exhausted), so requesting a new link works. Record both.

- [ ] **Step 3: Write the record**

`docs/gates/m1-foundation.md`: date, commit hash, the test command output summary (counts), the two manual results, and any `ponytail:` ceilings introduced in M1 (quick hash, in-process rate limit, single-process job worker) so M2+ know them.

- [ ] **Step 4: Commit and tag**

```bash
git add docs/gates/m1-foundation.md
git commit -m "docs: milestone 1 gate record"
git tag m1-foundation
```

---

## Self-review notes

- **Spec coverage (milestone 1 list):** compose profiles (T17), schema and migrations with constraints (T3, T9), stable IDs and watcher reconciliation (T6, T10), RAW preview extraction (T7, T9), `jobs` and `webhook_inbox` (T8), SMTP adapter with bundled templates (T11), bootstrap (T13), auth (T12, T15), access middleware (T14), backup/restore doc (T17). Gates (T18). listmonk transactional transport is included (T11) so the "listmonk transport" variant of the minimum-install gate can be run later in M8.
- **Out of scope for M1, by design:** picks, comments, drafts publication, invoices, reservations, CSRF tokens beyond the fetch-header rule (a token form arrives with the first HTML form that posts in M2), rate limiting on downloads (M5), guest sessions (M5).
- **Type consistency:** `AppEnv` carries `session`, `sessionToken`, `db`. `loadProject`/`loadPhoto` set `project`/`photo`. `cachePaths(photosDir, { folderPath }, photoId)` is used identically in T9 and T15. `makePreviewHandlers(photosDir)` is the boot-time form; `previewHandlers` is the env-bound test convenience.
