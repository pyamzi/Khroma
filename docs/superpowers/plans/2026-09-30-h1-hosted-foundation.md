# H1 Hosted Foundation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn the milestone-4 OpenGallery app into a multi-tenant service on Postgres and object storage, with public Studio signup, deployable to Fly.io with Neon and Cloudflare R2.

**Architecture:** Postgres row-level security isolates Studios: every tenant table carries `studio_id` (defaulted from a per-transaction setting) and a policy, and the app always runs as a non-superuser role, so a query that forgets its Studio returns nothing instead of another Studio's rows. Each HTTP request and each job runs inside one transaction bound to one Studio; the few cross-Studio operations (sign-in lookup, signup, job claiming) run in an explicit system transaction. The folder tree, watcher, JSON sidecars, and NAS bootstrap are deleted; photo files live in a `Storage` adapter (memory in tests, R2 in production).

**Tech Stack:** Node 22, TypeScript strict, Hono, Drizzle ORM 0.45 (`pg-core`), `pg` 8 (production), `@electric-sql/pglite` 0.5 (tests and local dev), `aws4fetch` 1.0 (R2), sharp + exiftool, nodemailer (SMTP), Vitest, Playwright, Fly.io, Neon.

**Spec:** `docs/superpowers/specs/2026-09-30-opengallery-hosted-design.md` (§2 porting, §3 accounts, §7 data model, §12 H1). Glossary: `CONTEXT.md`. Decisions: `docs/adr/0001-hosted-multi-tenant-service.md`.

## Starting point and rulings made while planning

- **Base:** branch `feat/h1-hosted-foundation` from `agents/implement-opengallery-milestone-4` (commit `0870b5a`), then merge `main` into it so the spec, glossary, ADRs, and `free-media-mcp/` come along. On `.gitignore` conflicts keep both sides' lines; on `docs/` conflicts keep `main`'s version.
- **Milestone 5 is not ported.** Its work exists only as uncommitted files in `/Users/pyamzi/Documents/Github/OpenGallery.worktrees/implement-opengallery-milestone-5`. Do not touch that worktree. H2 (finals delivery from R2) decides what to carry over.
- **Tenant isolation uses Postgres row-level security** rather than the spec §7 "scoped query helper and a lint test": RLS fails closed in the database for every query, including ones written later. A schema test fails if any table with a `studio_id` column lacks forced RLS and a policy (Task 1).
- **A Team member's email belongs to one Studio** (globally unique `users.email`). A Client's email may appear in many Studios; signing in sends one link per Studio.
- **Signup creates the Studio row immediately**, not on confirmation, because the confirmation email job must belong to a Studio. An unconfirmed Studio has no session and cannot be used. Signing up again with the same email sends a sign-in link and creates nothing.
- **Deleted features:** Files browser, file issues, folder transfer approval, duplicate adoption, photo remap, project shared files (attachments on disk), per-Studio email transport settings, the setup CLI and bootstrap, `photos.missing`, `clients/projects.available`, `projects.transferPending`, `projects.lastIndexedAt`, and every `folderPath`. The Lightroom plugin API keeps its response shapes, with `folderPath` returned as `''`; the plugin itself is reworked in H2.
- **Culling photos have no ingest path in H1.** The watcher is gone and plugin uploads arrive in H2, so tests, the e2e harness, and local dev create photos with `addPhoto` (Task 7).

## Global Constraints

- Node 22, TypeScript `strict`, ESM with `.js` import suffixes (the existing convention). Keep zod 3 (do not upgrade).
- Dependencies: add `pg ^8.23.0`, `aws4fetch ^1.0.20`; dev add `@electric-sql/pglite ^0.5.8`, `@types/pg ^8.23.1`. Remove `better-sqlite3`, `@types/better-sqlite3`, `chokidar`. PGlite is only imported dynamically, never in the production path.
- The app connects to Postgres as role `og_app` (non-superuser, `NOLOGIN`, reached with `SET ROLE og_app`). Migrations run as the database owner.
- Setting names: `app.studio_id` (the current Studio) and `app.system` (`'on'` for cross-Studio operations). Both are set with `set_config(name, value, true)`, so they end with the transaction.
- Timestamps stay ISO-8601 strings in `text` columns (`2026-09-30T12:34:56.789Z`), default `to_char(now() at time zone 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')`, so string comparisons in the code keep working.
- Storage keys: `s/<studioId>/p/<photoId>/<variant>`, variants `original`, `draft`, `preview`, `preview.draft`, `thumb`, `thumb.draft`. Preview long edge 2048 px, thumb 400 px (unchanged).
- Email: every message is sent from `EMAIL_FROM` (an address) with the Studio's name as display name and the Studio's first owner as reply-to (spec §3).
- Minimum age 18: signup requires `over18: true` (spec §3).
- Commit after every task with a conventional prefix and the trailer `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.

### Port rules (apply to every ported file)

| SQLite code | Postgres code |
| --- | --- |
| `q.get()` | `(await q.limit(1))[0]` (return `undefined` when absent) |
| `q.all()` | `await q` |
| `q.run()` | `await q` |
| `q.run().changes` | `(await q.returning({ id: t.id })).length` |
| `db.transaction((tx) => …)` | `await db.transaction(async (tx) => …)`; delete every `tx as unknown as Db` cast |
| functions touching the db | `async`, returning `Promise<…>`; callers `await` them |
| `sql<number>\`count(*)\`` / `sum()` | wrap in `Number(…)` (Postgres returns strings for bigint and numeric) |
| test `toThrow(/UNIQUE/)` | `rejects.toThrow(/duplicate key|unique/i)` |
| test `toThrow(/FOREIGN KEY/)` | `rejects.toThrow(/foreign key/i)` |
| `photosDir` parameters, `writeProjection(...)` calls | delete |
| `photos.missing` / `available` / `transferPending` conditions | delete the condition and the branch it guards |

Every ported test case is kept unless this plan names it for deletion. Test files run with `npx vitest run <paths>`; until Task 8 the full suite and `npm run typecheck` are expected to fail on files not yet ported, and each task's verification runs only its own test files.

## Review Focus

1. **One email, two roles across Studios:** `sam@x.com` is a Team member of Studio A and a Client of Studio B. Signing in sends two links; each session sees only its own Studio. Test in Task 5.
2. **No session touches tenant data:** a request or job with no Studio set reads zero tenant rows and cannot insert. Tests in Task 1 (database) and Task 8 (HTTP).
3. **A request fails after writing:** a handler that writes and then throws must roll the whole request back. Test in Task 8.
4. **Inviting an email that belongs to another Studio:** returns `exists` (409) and reveals nothing about the other Studio. Test in Task 7.
5. **Cross-Studio ids in URLs:** every route that takes an id answers 404 or 401 when the id belongs to another Studio, including photo previews. Route-sweep test in Task 8.

---

### Task 1: Postgres schema, migrations, and row-level security

**Files:**
- Modify: `package.json`, `drizzle.config.ts`, `vitest.config.ts`
- Rewrite: `src/server/db/schema.ts`, `src/server/db/client.ts`, `src/server/db/settings.ts`
- Create: `src/server/db/tenancy.ts`, `src/server/ids.ts`, `src/server/db/migrations/` (regenerated; delete the old SQLite migrations and `meta/`)
- Delete: `src/server/fs/ids.ts`, `src/server/db/secrets.ts`
- Rewrite: `tests/helpers.ts`, `tests/db.test.ts`; Create: `tests/tenancy.test.ts`

**Interfaces:**
- Produces:
  - `type Db = PgDatabase<PgQueryResultHKT, typeof schema>` from `db/client.ts` (transactions are assignable to it).
  - `openDb(url: string, o?: { migrate?: boolean }): Promise<{ db: Db; close(): Promise<void> }>`. A `url` of `pglite://memory` or `pglite://<dir>` uses PGlite (dynamic import). Any `postgres://` URL uses a `pg.Pool` whose `connect` event runs `SET ROLE og_app`. With `migrate: true`, migrations run as owner before the role is set.
  - `withStudio<T>(db: Db, studioId: string, fn: (tx: Db) => Promise<T>): Promise<T>` and `asSystem<T>(db: Db, fn: (tx: Db) => Promise<T>): Promise<T>` in `db/tenancy.ts`.
  - `getSetting<T>(db, key): Promise<T | null>`, `setSetting(db, key, value): Promise<void>`, `deleteSetting(db, key): Promise<void>`, all scoped by RLS.
  - `newId(): string` in `src/server/ids.ts`.
  - Test helpers: `testDb(): Promise<Db>` and `makeStudio(db: Db, o?: { name?: string; ownerEmail?: string }): Promise<{ studioId: string; ownerId: string }>`.

- [ ] **Step 1: Branch and dependencies.** Create the branch per "Starting point", merge `main`, update `package.json` per Global Constraints, set `drizzle.config.ts` to `dialect: 'postgresql'`, run `npm install`.

- [ ] **Step 2: Write the failing tenancy and constraint tests.**

`tests/tenancy.test.ts`:

```ts
it('each Studio sees and changes only its own rows', async () => {
  const db = await testDb(); const a = await makeStudio(db, { ownerEmail: 'a@x.com' }); const b = await makeStudio(db, { ownerEmail: 'b@x.com' });
  await withStudio(db, a.studioId, (tx) => tx.insert(clients).values({ id: 'ca', name: 'A client', emails: ['c@x.com'] }));
  expect(await withStudio(db, b.studioId, (tx) => tx.select().from(clients))).toEqual([]);
  expect(await withStudio(db, b.studioId, (tx) => tx.update(clients).set({ name: 'hacked' }).where(eq(clients.id, 'ca')).returning({ id: clients.id }))).toEqual([]);
  await expect(withStudio(db, b.studioId, (tx) => tx.insert(clients).values({ id: 'x', studioId: a.studioId, name: 'n', emails: [] }))).rejects.toThrow(/row-level security/i);
});
it('no Studio set: reads nothing, cannot insert', async () => {
  const db = await testDb(); const a = await makeStudio(db);
  await withStudio(db, a.studioId, (tx) => tx.insert(clients).values({ id: 'ca', name: 'A', emails: [] }));
  expect(await db.transaction((tx) => tx.select().from(clients))).toEqual([]);
  await expect(db.transaction((tx) => tx.insert(clients).values({ id: 'y', name: 'n', emails: [] }))).rejects.toThrow();
});
it('asSystem sees every Studio', async () => { /* two studios, one client each → asSystem select returns 2 */ });
it('every table with a studio_id column has forced RLS and a policy; studios too', async () => {
  // query pg_class / pg_policies as owner via asSystem: for each table in information_schema.columns where column_name = 'studio_id', plus 'studios':
  // expect relrowsecurity = true, relforcerowsecurity = true, and at least one row in pg_policies
});
it('the app role is not a superuser', async () => { /* select rolsuper from pg_roles where rolname = current_user → false; current_user = 'og_app' */ });
```

`tests/db.test.ts`, ported: keep "one unpaid extras invoice per project", "duplicate job idempotency keys" (now duplicate within one Studio; the same key in two Studios is allowed; add that assertion), "project whose client does not exist" (`/foreign key/i`), "stores settings" (scoped: Studio B does not see A's setting). Delete "enables foreign keys". Add: `jobs.next_at` stores `Date.now()` exactly.

- [ ] **Step 3: Run to verify failure.** `npx vitest run tests/tenancy.test.ts tests/db.test.ts`. Expected: FAIL, imports unresolved.

- [ ] **Step 4: Rewrite `schema.ts` in `pg-core`.**
  - Column mapping: `integer({mode:'boolean'})` → `boolean`; `text({mode:'json'})` → `jsonb`; `real` → `doublePrecision`; `events.id` → `serial('id').primaryKey()`; `jobs.next_at` and `jobs.leased_until` → `bigint(..., { mode: 'number' })`; timestamps per Global Constraints.
  - New table `studios`: `id text pk`, `name text not null`, `created_at`.
  - Tenant column on every table except `studios` and `webhook_inbox`: `text('studio_id').notNull().default(sql\`current_setting('app.studio_id')\`).references(() => studios.id, { onDelete: 'cascade' })`.
  - Drop columns: `clients.folder_path`, `clients.available`, `projects.folder_path`, `projects.available`, `projects.transfer_pending`, `projects.last_indexed_at`, `photos.missing`. Add `clients.phone text not null default ''`, `clients.notes text not null default ''`.
  - Indexes: drop the two folder indexes; `jobs` idempotency unique becomes `(studio_id, idempotency_key)`; `settings` primary key becomes `(studio_id, key)`; `users.email` stays globally unique; keep the rest, including the partial unique index on open extras invoices.

- [ ] **Step 5: Generate migrations.** Run `npx drizzle-kit generate --name=schema`, then `npx drizzle-kit generate --custom --name=tenancy` and fill the custom file with:

```sql
DO $$ BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'og_app') THEN CREATE ROLE og_app NOLOGIN; END IF;
END $$;
GRANT og_app TO CURRENT_USER;
GRANT USAGE ON SCHEMA public TO og_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO og_app;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO og_app;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO og_app;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT USAGE, SELECT ON SEQUENCES TO og_app;
DO $$ DECLARE t text; BEGIN
  FOR t IN SELECT table_name FROM information_schema.columns WHERE table_schema = 'public' AND column_name = 'studio_id' LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY; ALTER TABLE %I FORCE ROW LEVEL SECURITY', t, t);
    EXECUTE format($p$CREATE POLICY tenant ON %I USING (studio_id = current_setting('app.studio_id', true) OR current_setting('app.system', true) = 'on') WITH CHECK (studio_id = current_setting('app.studio_id', true) OR current_setting('app.system', true) = 'on')$p$, t);
  END LOOP;
END $$;
ALTER TABLE studios ENABLE ROW LEVEL SECURITY; ALTER TABLE studios FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant ON studios USING (id = current_setting('app.studio_id', true) OR current_setting('app.system', true) = 'on') WITH CHECK (id = current_setting('app.studio_id', true) OR current_setting('app.system', true) = 'on');
```

- [ ] **Step 6: Implement `openDb`, `withStudio`, `asSystem`, settings, `newId`.** `withStudio` opens a transaction, runs `select set_config('app.studio_id', ${studioId}, true)`, then calls `fn(tx)`; `asSystem` does the same with `set_config('app.system', 'on', true)`. Test helpers:

```ts
let template: Promise<PGlite> | undefined; // one migrated database per test worker, cloned per test (~90 ms)
export async function testDb(): Promise<Db> {
  template ??= (async () => { const pg = new PGlite(); await migratePglite(pg); return pg; })();
  const pg = await (await template).clone(); await pg.exec('SET ROLE og_app');
  return drizzle(pg, { schema });
}
```

`makeStudio` inserts a `studios` row and an owner `users` row through `asSystem`, with explicit `studioId`. Its default owner email is unique per call (`owner-<n>@x.com`) unless `ownerEmail` is given.

- [ ] **Step 7: Run the tests.** `npx vitest run tests/tenancy.test.ts tests/db.test.ts`. Expected: PASS.

- [ ] **Step 8: Commit.** `feat(h1): postgres schema with row-level security per studio`.

---

### Task 2: Delete the folder layer and move what survives

**Files:**
- Delete: `src/server/fs/index.ts`, `fs/watcher.ts`, `fs/json.ts`, `fs/paths.ts`, `fs/photos.ts`, `src/server/domain/identity.ts`, `domain/files.ts`, `src/server/auth/bootstrap.ts`, `src/server/cli.ts`, `src/server/http/routes/files.ts`, `routes/issues.ts`, `routes/setup.ts`, `tests/fs/index.test.ts`, `tests/fs/json.test.ts`, `tests/fs/paths.test.ts`, `tests/fs/photos.test.ts`, `tests/fs/projection.test.ts`, `tests/fs/watcher.test.ts`, `tests/fs/schemas.test.ts`, `tests/domain/identity.test.ts`, `tests/domain/files.test.ts`, `tests/auth/bootstrap.test.ts`, `src/web/admin/Files.tsx`, `src/web/pages/Setup.tsx`
- Move and rewrite: `fs/schemas.ts` → `src/server/domain/meta.ts`; `fs/media.ts` → `src/server/media/sniff.ts`; `fs/previews.ts` → `src/server/media/previews.ts`
- Tests: `tests/domain/meta.test.ts` (new), `tests/media/sniff.test.ts` (from `tests/fs/media.test.ts`), `tests/media/previews.test.ts` (from `tests/fs/previews.test.ts`)

**Interfaces:**
- Produces:
  - `ProjectMeta` (zod), the old `ProjectJson` minus `schemaVersion`, `id`, `stateVersion`, `state`, `sharedFiles`, and `allowance.slots`.
  - `defaultProjectMeta(title: string): ProjectMeta`.
  - `type Sniffed` (unchanged).
  - `sniffBytes(bytes: Uint8Array, name: string): Sniffed | null`.
  - `sha256(bytes: Uint8Array): string` (a full hash; it replaces `quickHash`).
  - `PreviewError`.
  - `extractPreview(src: Uint8Array, maxEdge?: number): Promise<{ jpeg: Buffer; width: number; height: number }>` (embedded RAW JPEG first via exiftool on a temp file, then sharp).
  - `makeThumb(src: Uint8Array, maxEdge: number): Promise<Buffer>`.

- [ ] **Step 1: Write failing tests.** `meta.test.ts`: the default meta parses with `allowance: { included: 0, extraPrice: 0 }`, `folders: { culling: 'raw', finals: 'finals' }`, `downloads: 'client'`; an unknown key such as `sharedFiles` is stripped; a negative `included` is rejected. Port `media.test.ts` and `previews.test.ts` to bytes (for example `sniffBytes(await readFile(f), 'a.jpg')`), keeping every case.
- [ ] **Step 2: Run to verify failure.** `npx vitest run tests/domain/meta.test.ts tests/media`. Expected: FAIL, modules missing.
- [ ] **Step 3: Implement the three modules and delete the listed files.**
- [ ] **Step 4: Run the tests.** `npx vitest run tests/domain/meta.test.ts tests/media`. Expected: PASS.
- [ ] **Step 5: Commit.** `refactor(h1): delete the folder layer; metadata and media work on bytes`.

---

### Task 3: Storage adapter

**Files:**
- Create: `src/server/storage.ts`, `tests/storage.test.ts`

**Interfaces:**
- Produces:
  - `interface Storage { put(key: string, body: Uint8Array, contentType: string): Promise<void>; get(key: string): Promise<{ body: ReadableStream<Uint8Array>; size: number; contentType: string } | null>; getBytes(key: string): Promise<Uint8Array | null>; delete(key: string): Promise<void> }`.
  - `memoryStorage(): Storage & { keys(): string[] }`.
  - `r2Storage(o: { accountId: string; accessKeyId: string; secretAccessKey: string; bucket: string; fetch?: typeof fetch }): Storage`.
  - `type PhotoVariant = 'original' | 'draft' | 'preview' | 'preview.draft' | 'thumb' | 'thumb.draft'`.
  - `photoKey(studioId: string, photoId: string, variant: PhotoVariant): string`.

- [ ] **Step 1: Write failing tests.**
  - `memoryStorage` round-trips bytes and content type, `get` returns `null` for a missing key, and `delete` is idempotent.
  - `photoKey('s1', 'p1', 'thumb.draft') === 's/s1/p/p1/thumb.draft'`.
  - `r2Storage` with a stub `fetch`:
    - `put` sends `PUT https://<accountId>.r2.cloudflarestorage.com/<bucket>/s/s1/p/p1/original` with `content-type` and an `authorization` header starting `AWS4-HMAC-SHA256`.
    - `get` maps 404 to `null`.
    - `delete` sends `DELETE`.
    - A 500 from R2 throws an error naming the status.
- [ ] **Step 2: Run to verify failure.** `npx vitest run tests/storage.test.ts`.
- [ ] **Step 3: Implement.** R2 uses `new AwsClient({ accessKeyId, secretAccessKey, service: 's3', region: 'auto' })` and `client.fetch(url, init)`. Keys are URL-encoded per path segment.
- [ ] **Step 4: Run the tests.** Expected: PASS.
- [ ] **Step 5: Commit.** `feat(h1): storage adapter for memory and R2`.

---

### Task 4: Jobs and platform email

**Files:**
- Rewrite: `src/server/jobs/queue.ts`, `jobs/worker.ts`, `jobs/inbox.ts`, `src/server/email/transport.ts`, `email/send.ts`
- Tests: port `tests/jobs/queue.test.ts`, `tests/jobs/inbox.test.ts`, `tests/email/email.test.ts`

**Interfaces:**
- Consumes: `Db`, `withStudio`, `asSystem`, `testDb`, `makeStudio` (Task 1).
- Produces:
  - `type Handler = (payload: unknown, ctx: { db: Db; jobId: string; studioId: string }) => Promise<void>`.
  - `enqueue(db: Db, o: { kind: string; payload: unknown; idempotencyKey?: string; runAt?: number; now?: number; studioId?: string }): Promise<{ id: string; created: boolean }>`. Pass `studioId` only when `db` is a system transaction.
  - `claimNext(db: Db, now: number, leaseMs?: number): Promise<JobRow | null>` (system transaction, `FOR UPDATE SKIP LOCKED`).
  - `runOnce(db: Db, handlers: Handlers, now?: number): Promise<'ran' | 'idle'>`. It claims as system, runs the handler inside `withStudio(db, job.studioId, …)`, and records the outcome as system.
  - `recoverLeases(db: Db, now: number): Promise<number>`.
  - `retryJob(db: Db, id: string): Promise<void>` (Studio-scoped).
  - `startWorker(db: Db, handlers: Handlers, o: { intervalMs: number }): () => void`.
  - `recordWebhook(db, provider, eventId, objectId, payload): Promise<boolean>` and `markApplied(db, provider, eventId): Promise<void>`, both system.
  - `type Mail = { to: string; subject: string; text: string; html: string; messageId: string; fromName: string; replyTo: string | null }`.
  - `smtpTransport(url: string, fromAddress: string): Transport`, which sends `from: { name: fromName, address: fromAddress }`.
  - `memoryTransport()`.
  - `sendEmail(db: Db, o: { to: string; template: TemplateName; vars: Record<string, string>; key: string; studioId?: string }): Promise<void>`.
  - `makeEmailHandlers(getTransport: () => Transport | null, domain: string): Handlers`. Its handler reads the Studio name and first owner (`users` where `role = 'owner'`, ordered by `created_at`) through `ctx.db`.

- [ ] **Step 1: Port the tests, and add:**
  - `enqueue` in a system transaction with `studioId: a` creates a job visible to `withStudio(a)` and invisible to `withStudio(b)`.
  - The same idempotency key in two Studios creates two jobs.
  - A handler receives `ctx.studioId` equal to the job's Studio and can read that Studio's rows but not another's.
  - Two consecutive `claimNext` calls with two pending jobs return different jobs.
  - A `send_email` job in Studio "Lumen Photo" whose owner is `own@x.com` produces `fromName: 'Lumen Photo'` and `replyTo: 'own@x.com'`.
  - Delete the listmonk cases.
- [ ] **Step 2: Run to verify failure.** `npx vitest run tests/jobs tests/email`.
- [ ] **Step 3: Implement.** Hold the job's claim transaction only for the claim itself. Mark the handler's own transaction with `// ponytail: handler runs inside one studio transaction, external call included; split into short transactions if job volume grows`.
- [ ] **Step 4: Run the tests.** Expected: PASS.
- [ ] **Step 5: Commit.** `feat(h1): studio-scoped jobs and platform email`.

---

### Task 5: Magic links, cross-Studio sign-in, and signup

**Files:**
- Rewrite: `src/server/auth/magic.ts`
- Create: `src/server/auth/signin.ts`, `src/server/auth/signup.ts`
- Tests: port `tests/auth/magic.test.ts`; create `tests/auth/signin.test.ts`, `tests/auth/signup.test.ts`

**Interfaces:**
- Consumes: Task 1 and Task 4 (`sendEmail` with `studioId`).
- Produces:
  - `createMagicLink(db: Db, o: { kind: 'client' | 'admin'; email: string; studioId: string; now?: number }): Promise<{ token: string; expiresAt: string }>`.
  - `redeemMagicLink(db: Db, token: string, now?: number): Promise<{ sessionToken: string; session: SessionRow } | null>`.
  - `sessionFromToken(db: Db, token: string, now?: number): Promise<SessionRow | null>`.
  - `signOut(db: Db, token: string): Promise<void>`.
  - `requestSignIn(db: Db, o: { email: string; baseUrl: string; now?: number }): Promise<number>`, which returns the number of links sent.
  - `signup(db: Db, o: { email: string; studioName: string; baseUrl: string; now?: number }): Promise<{ created: boolean }>`.
  - Every function here takes a **system** transaction.

- [ ] **Step 1: Write failing tests.**
  - `signin.test.ts`:
    - Review Focus 1: `sam@x.com` is an owner in Studio A and a Client email in Studio B, so `requestSignIn` returns 2, queues two `magic_link` emails (one per Studio, each job in its Studio), and the two redeemed sessions carry `studioId` A (kind `admin`) and B (kind `client`).
    - An unknown email returns 0 and queues nothing.
    - Email matching is case-insensitive.
  - `signup.test.ts`:
    - A new email creates one Studio with the given name, one owner user, and one magic-link email; `created: true`.
    - The same email again returns `created: false`, creates no Studio, and sends a sign-in link.
    - An email that is already a Team member of another Studio returns `created: false` and sends that member's sign-in link.
  - Port `magic.test.ts`: single use, expiry, and sign-out; sessions carry `studioId`.
- [ ] **Step 2: Run to verify failure.** `npx vitest run tests/auth`.
- [ ] **Step 3: Implement.** Client lookup uses `clients.emails @> ${JSON.stringify([email])}::jsonb`. Store emails lowercase everywhere they are written.
- [ ] **Step 4: Run the tests.** Expected: PASS.
- [ ] **Step 5: Commit.** `feat(h1): studio signup and cross-studio sign-in links`.

---

### Task 6: Port the culling and comment rules

**Files:**
- Rewrite: `src/server/domain/selection.ts`, `domain/transitions.ts`, `domain/comments.ts`, `domain/tokens.ts`
- Create: `src/server/domain/studio.ts`
- Tests: port `tests/domain/selection.test.ts`, `tests/domain/transitions.test.ts`, `tests/domain/comments.test.ts`, `tests/domain/tokens.test.ts`

**Interfaces:**
- Consumes: `ProjectMeta` (Task 2), `sendEmail` (Task 4).
- Produces: every existing export, now `async` and without `photosDir`:
  - `entitlement(db, projectId): Promise<number>`, which absorbs the old `entitlementOf`.
  - `setPick`, `summary`, `currentPicks`, `recompute`, `grantSlots(db, o)`, `setIncluded(db, o)`.
  - `finishRound(db, o)`, `cancelRound(db, o)`, `requestExtras(db, o)`, `adminRecipients(db, projectId)`.
  - `onCullingMediaAdded(db, projectId): Promise<boolean>`, renamed from `onCullingMediaIndexed`.
  - `addComment`, `listComments`, `resolveComment`, `commentCounts`.
  - `createPluginToken`, `listPluginTokens`, `revokePluginToken`.
  - `studioName(db: Db): Promise<string>` in `domain/studio.ts`, which reads `studios.name` for the current Studio.

- [ ] **Step 1: Port the tests.** Seed each test with `makeStudio` and run it inside `withStudio`. Delete "picks on photos that vanished are dropped" (there is no `missing`). Keep every other case, including the version conflict, grant reference uniqueness (now `/duplicate key|unique/i`), and the finish guards. Add: `finishRound` emails every Team member of this Studio and none of another Studio's.
- [ ] **Step 2: Run to verify failure.** `npx vitest run tests/domain/selection.test.ts tests/domain/transitions.test.ts tests/domain/comments.test.ts tests/domain/tokens.test.ts`.
- [ ] **Step 3: Port the four modules and add `studio.ts`.** Apply the port rules.
- [ ] **Step 4: Run the tests.** Expected: PASS.
- [ ] **Step 5: Commit.** `refactor(h1): culling, comment, and token rules on postgres`.

---

### Task 7: Studio admin, settings, dashboard, photos, and finals

**Files:**
- Rewrite: `src/server/domain/admin.ts`, `domain/settings.ts`, `domain/dashboard.ts`, `domain/finals.ts`
- Create: `src/server/domain/photos.ts`
- Tests: port `tests/domain/admin.test.ts`, `tests/domain/settings.test.ts`, `tests/domain/dashboard.test.ts`, `tests/domain/finals.test.ts`; create `tests/domain/photos.test.ts`

**Interfaces:**
- Consumes: Tasks 1–6, `Storage` and `photoKey` (Task 3), `sniffBytes`, `sha256`, `extractPreview`, `makeThumb` (Task 2).
- Produces:
  - Admin:
    - `createClient(db, o: { name; emails; phone?; notes?; actor }): Promise<{ id: string }>`.
    - `updateClient(db, o)`.
    - `createProject(db, o): Promise<{ id: string }>`.
    - `updateProjectHuman(db, o): Promise<ProjectMeta>`, where `HUMAN_PATCH` loses `folders` and `sharedFiles`.
    - `setExtraPrice`, `markShot`, `reorderPhotos`, `setCover`, `projectEvents`, `projectInsights`.
  - Settings:
    - `StudioSettings` loses `from` and `studioName` stays.
    - `getStudio(db)` reads the name from `studios` and the rest from the `studio` setting; `setStudio(db, patch, actor)` updates both.
    - `inviteUser(db, o)` maps a unique violation on `users.email` to `TeamError('exists')`.
    - `listUsers`, `updateUser`, `removeUser`, `listJobs`, `retryJobById`.
  - `dashboard(db, now?)`, with the issues block removed.
  - `addPhoto(db: Db, storage: Storage, o: { projectId: string; relPath: string; stage: 'culling' | 'final'; bytes: Uint8Array; name: string; sourcePhotoId?: string | null }): Promise<{ photoId: string }>`:
    - It sniffs the bytes (rejecting unsupported ones with `PhotoError('unsupported')`), stores `original`, and inserts the row with `checksum = sha256`.
    - It enqueues `preview` keyed `preview:<photoId>:<checksum>`, and calls `onCullingMediaAdded` for the culling stage.
  - `makePreviewHandlers(storage: Storage): Handlers`. Its `preview` handler renders live (`original` → `preview`, `thumb`) and, when `draftRelPath` is set, the draft (`draft` → `preview.draft`, `thumb.draft`), then sets width and height. A `PreviewError` records a `preview_failed` event.
  - `uploadFinal(db, storage, o)` and `deleteFinal(db, storage, o)` keep their rules, with draft bytes at `photoKey(..., 'draft')`.
  - `resolvePaths`, `pluginPicks`, `pluginComments`, `replyFromPlugin`, and `reportProgress` become async.

- [ ] **Step 1: Write and port the tests.**
  - `photos.test.ts`:
    - A JPEG goes through `addPhoto` and then the preview job, which writes the `original`, `preview`, and `thumb` keys under `s/<studio>/p/<photo>/`, sets width and height, and moves a `not_started` project to `culling`.
    - A `.txt` file is refused.
    - A draft upload produces `.draft` variants and leaves the live keys alone.
  - Port `admin.test.ts`: remove the folder assertions and delete the share-file cases.
  - Port `settings.test.ts`: delete the email-transport cases and add Review Focus 4 (inviting `b-owner@x.com`, an owner in Studio B, from Studio A rejects with `exists`, and A's user list is unchanged).
  - Port `dashboard.test.ts`: delete the issues case.
  - Port `finals.test.ts` to storage keys.
- [ ] **Step 2: Run to verify failure.** `npx vitest run tests/domain`.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run the tests.** `npx vitest run tests/domain tests/media tests/storage.test.ts`. Expected: PASS.
- [ ] **Step 5: Commit.** `feat(h1): studio admin and photos on object storage`.

---

### Task 8: HTTP layer, request transactions, and the isolation sweep

**Files:**
- Rewrite: `src/server/http/session.ts`, `http/access.ts`, `http/errors.ts`, `src/server/app.ts`, and every file in `src/server/http/routes/`
- Create: `src/server/http/routes/signup.ts`
- Tests: port `tests/http/access.test.ts`, `tests/http/admin.test.ts`, `tests/http/plugin.test.ts`, `tests/http/portal.test.ts`, `tests/http/ratelimit.test.ts`; rewrite `tests/http/app.test.ts`; create `tests/http/isolation.test.ts`, `tests/http/boot.ts` (shared test app factory)

**Interfaces:**
- Consumes: everything above.
- Produces:
  - `createApp(o: { db: Db; config: Config; storage: Storage; webRoot?: string }): Hono<AppEnv>`.
  - `AppEnv.Variables = { session: SessionRow | null; sessionToken: string | null; db: Db; root: Db; storage: Storage }`, where `db` is the request's transaction.
  - Routes keep their paths, minus the deleted ones: `/api/files*`, `/api/issues*`, `/api/setup`, `approve-transfer`, `photos/remap`, `share-file`, `/api/projects/:id/files`, `/api/settings/email*`.
  - New `POST /api/signup` with body `{ email, studioName (1–80 chars), over18: true }`. It always answers `{ ok: true }` for a valid body and is rate-limited like `/api/auth/request`.
  - `/api/me` adds `studio: { id, name }`.
  - `/healthz` returns `{ ok: true }` after `select 1`.

- [ ] **Step 1: Write the failing tests.**
  - `isolation.test.ts` covers Review Focus 2, 3, and 5:
    - The route sweep seeds Studios A and B with a client, project, culling photo (via `addPhoto` plus a drained preview job), comment, and plugin token each. For every route in `app.routes` whose path has `:id`, `:photoId`, or `:token` (except `/auth/:token`), it substitutes A's ids and requests with B's owner cookie (and B's plugin bearer for `/api/plugin/*`). It asserts the status is 401, 403, or 404, and that the body contains none of A's ids or names.
    - Unauthenticated: `GET /api/projects` returns `[]` or 401, and nothing from A appears.
    - Rollback: build a `new Hono<AppEnv>()` with the same middleware plus a test route that inserts an `events` row and then throws. The response is 500, and a fresh `withStudio` read finds no such event.
  - `app.test.ts`, rewritten:
    - Signup, then redeem the emailed link, which yields an owner cookie with `/api/me` returning `isAdmin: true` and `studio.name`.
    - The link works only once.
    - `over18: false` returns 400.
    - The client sign-in and preview flow, with photos seeded via `addPhoto`.
    - The existing CSRF-header and security-header cases.
  - Port the remaining HTTP tests on the shared `tests/http/boot.ts`, which creates a `testDb`, `memoryStorage`, `memoryTransport`, a `drain()` that runs jobs through `runOnce`, and a `signupOwner(email, studioName)`.
- [ ] **Step 2: Run to verify failure.** `npx vitest run tests/http`.
- [ ] **Step 3: Implement the middleware chain.** It runs in this order:
  1. Security headers.
  2. CSRF header.
  3. Session: `asSystem` lookup.
  4. Request transaction.
  5. Routes.

  The request transaction:

```ts
export function requestTx(root: Db): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    const run = async (tx: Db) => { c.set('db', tx); await next(); if (c.error) throw c.error; }; // rethrow so a failed request rolls back
    const s = c.get('session');
    if (s) await withStudio(root, s.studioId, run); else await root.transaction(run);
  };
}
```

  `canAccessProject` adds `p.studioId === s.studioId`. The `/auth/:token` redeem, `/api/auth/request`, and `/api/signup` routes use `asSystem(c.get('root'), …)`. The photo preview route streams `storage.get(photoKey(...))` and answers 404 when the object is absent.
- [ ] **Step 4: Run the whole suite and the typecheck.** Run `npm test` and `npx tsc -p tsconfig.json --noEmit`. Expected: every test passes and there are 0 type errors. Web type errors are fixed in Task 9.
- [ ] **Step 5: Commit.** `feat(h1): request transactions per studio and signup route`.

---

### Task 9: Boot, config, web app, end-to-end harness, and CI

**Files:**
- Rewrite: `src/server/config.ts`, `src/server/index.ts`, `src/server/http/routes/health.ts`, `.env.example`, `package.json` scripts (drop `cli`, add `migrate`, `check:tenancy`), `tests/config.test.ts`, `tests/e2e/server.ts`, `tests/e2e/harness.test.ts`, `tests/e2e/demo.ts`, `tests/e2e/admin.spec.ts`, `tests/e2e/culling.spec.ts`, `.github/workflows/ci.yml`
- Unchanged but must pass: `tests/plugin/api.test.ts` + `api_test.lua` (they rely on seeded relPaths `raw/a.dng`, `raw/b.dng` and final collision naming `finals/DSC_0001 (2).jpg`)
- Create: `src/server/migrate.ts`, `src/web/pages/Signup.tsx`
- Modify: `src/web/App.tsx`, `src/web/router.ts`, `src/web/pages/SignIn.tsx`, `src/web/admin/Shell.tsx`, `src/web/admin/Settings.tsx`, `src/web/admin/Project.tsx`, `src/web/admin/api.ts`
- Delete: `compose.yml`

**Interfaces:**
- Produces:
  - `loadConfig(env)` returns `{ databaseUrl, baseUrl, port, smtpUrl?, emailFrom, r2?: { accountId; accessKeyId; secretAccessKey; bucket }, secureCookies, production }`.
    - Env: `DATABASE_URL` (required), `BASE_URL`, `PORT`, `SMTP_URL`, `EMAIL_FROM` (default `no-reply@<BASE_URL host>`), and `R2_ACCOUNT_ID`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`, `R2_BUCKET`, which are all-or-none.
    - When `NODE_ENV=production`, it requires `SMTP_URL` and the R2 variables, and rejects a `pglite:` database URL.
  - `npm run migrate` (`node dist/server/migrate.js`) migrates `DATABASE_URL` as owner.
  - `npm run dev` uses `DATABASE_URL=pglite://.data/dev` with migrations on open and memory storage when R2 is unset, and logs a one-line warning.
  - Web route `/signup`.

- [ ] **Step 1: Write the failing tests.**
  - `config.test.ts`:
    - A production config without the R2 variables throws naming them.
    - A partial R2 set throws.
    - `pglite:` in production throws.
    - Defaults apply.
  - `tests/web/build.test.ts` still builds.
  - Rewrite the e2e harness to boot `testDb`, `memoryStorage`, and a Studio "E2E Studio" via `signup('owner@x.com')`, with a client `sarah@x.com`, allowance 2, and three culling photos `raw/a.dng`, `raw/b.dng`, `raw/c.dng` added with `addPhoto` and previews drained. `startTestServer()` keeps its return surface (`baseUrl`, `projectId`, `db`, `signInLink(email)`, `mailbox()`, `stop()`).
  - `harness.test.ts` asserts `/healthz` returns `{ ok: true }` instead of `setup: 'complete'`.
  - `admin.spec.ts` drops the Files and email-test steps and adds a signup step that fills `/signup`, opens the emailed link, and lands on Dashboard.
- [ ] **Step 2: Run to verify failure.** `npx vitest run tests/config.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement.**
  - Boot order: config → `openDb(url, { migrate: url.startsWith('pglite:') })` → storage → worker with email and preview handlers → server.
  - Web changes:
    - Remove the health-gated Setup and route unauthenticated users to SignIn, with a "Create a studio" link to `/signup`.
    - Drop Files from nav, the Email and Issues cards and the From field from Settings, and "Open folder" from Project.
    - The Signup page posts `{ email, studioName, over18 }` and shows "Check your email".
  - CI: drop the exiftool-less assumptions (keep the `libimage-exiftool-perl` install), and add `npm run build` before e2e (already there).
- [ ] **Step 4: Verify.** Run `npm test && npm run typecheck && npm run test:e2e`. Expected: all pass. Then run the grep below; expected: no output.

```bash
grep -rn -E "folderPath|/api/files|/api/issues|approve-transfer|setup-token|listmonk|PHOTOS_DIR|DATA_DIR|sharedFiles" src tests --include=*.ts --include=*.tsx | grep -v "folderPath: ''"
```

- [ ] **Step 5: Commit.** `feat(h1): hosted boot, signup page, and e2e on postgres`.

---

### Task 10: Deploy to Fly.io with Neon and R2

**Files:**
- Rewrite: `Dockerfile`
- Create: `fly.toml`, `scripts/check-tenancy.ts`, `docs/deploy.md`

**Interfaces:**
- Consumes: `npm run migrate`, `loadConfig`.
- Produces:
  - A running App at `https://<app>.fly.dev`.
  - `npm run check:tenancy`, which connects to `DATABASE_URL` and verifies the database, as described in Step 2.

- [ ] **Step 1: Dockerfile and `fly.toml`.**
  - Dockerfile:
    - Remove the `VOLUME`, `DATA_DIR`, `PHOTOS_DIR`, and `ffmpeg` (video is later).
    - Keep `libimage-exiftool-perl`.
    - Set the `HEALTHCHECK` to `/healthz`.
  - `fly.toml`:
    - `primary_region = "ord"` (Chicago, closest to Madison), and `[deploy] release_command = "npm run migrate"`.
    - `[http_service] internal_port = 3000`, `force_https = true`, `auto_stop_machines = "off"`, and `min_machines_running = 1` (always on).
    - `[[vm]] size = "shared-cpu-1x"`, `memory = "2gb"`.
    - `[checks]` hitting `/healthz`.
- [ ] **Step 2: Write `scripts/check-tenancy.ts`.** It connects to `DATABASE_URL` and checks that:
  - `og_app` exists and is not a superuser.
  - Every table with `studio_id`, plus `studios`, has RLS enabled and forced, with a policy.
  - Inside a transaction it rolls back, two temporary Studios cannot see each other's rows.

  It exits 1 with the failing check named.
- [ ] **Step 3: Write `docs/deploy.md`.** It covers:
  - The owner steps.
  - The exact commands.
  - How to roll back with `fly releases`.
  - How to restore Neon to a point in time.
- [ ] **Step 4: Deploy (needs the owner's accounts).**
  - Stop and ask the owner if any item below is missing. Do not create accounts.
  - Owner steps:
    - `fly auth login`.
    - Create a Neon project in `aws-us-east-2` and copy its pooled `DATABASE_URL`.
    - Create an R2 bucket `opengallery-media` and an R2 API token scoped to it.
    - Provide the transactional email provider's SMTP URL and a verified `EMAIL_FROM`.
  - Then run:

```bash
fly launch --no-deploy --copy-config --name opengallery
fly secrets set DATABASE_URL=... SMTP_URL=... EMAIL_FROM=... R2_ACCOUNT_ID=... R2_ACCESS_KEY_ID=... R2_SECRET_ACCESS_KEY=... R2_BUCKET=opengallery-media BASE_URL=https://opengallery.fly.dev
fly deploy
DATABASE_URL=... npm run check:tenancy
curl -fsS https://opengallery.fly.dev/healthz
```

  Expected: the release command migrates, `check:tenancy` prints `ok` for every check, and `/healthz` returns `{"ok":true}`.
- [ ] **Step 5: Gate check from a clean checkout.** In a fresh clone of the branch, `npm ci && npm test && fly deploy` succeeds. Then, signing up at `/signup` with a real inbox delivers the link, and the link signs in.
- [ ] **Step 6: Commit.** `chore(h1): fly deploy with neon and r2`.

---

## Self-review

- **Spec coverage (§12 H1):**
  - Postgres and `studio_id`: Tasks 1, 4–8.
  - R2 adapter: Tasks 3 and 7.
  - Studio signup: Tasks 5, 8, and 9.
  - Deleting the folder layer: Task 2.
  - Deploying to Fly with Neon: Task 10.
  - Gates: tenant isolation is the Task 8 sweep plus Task 1 and Task 10 checks; the ported suite is green in Tasks 8–9; the deploy from a clean checkout is Task 10.
  - §3 accounts: Tasks 5, 8, and 9. §7 tables: Task 1 (`public_links` and `usage_months` belong to H4 and H5 and are not created here). §2 porting: Tasks 2 and 4–8.
- **Deliberately not here:**
  - Uploads UI, processing machines, and plugin rework (H2).
  - Descriptions and search (H3).
  - Connector and OAuth (H4).
  - Plans and Stripe (H5).
  - Legal pages (H6).
  - Account deletion (the `on delete cascade` foreign keys make it one statement later).
- **Type consistency:** `Db`, `withStudio`, `asSystem`, `Storage`, `photoKey`, `addPhoto`, `sendEmail({ studioId })`, and `runOnce(db, handlers)` match across Tasks 1–10.
