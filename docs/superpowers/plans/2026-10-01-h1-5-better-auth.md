# H1.5 Better Auth Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Team members and Clients sign in through Better Auth magic links instead of H1's hand-rolled magic links and sessions, with every H1 rule kept: one link per Studio, 15-minute Team links, 30-day Client links, no usable link stored in the jobs table, Studio isolation unchanged.

**Architecture:** Better Auth (`better-auth` 1.7.x with `@better-auth/drizzle-adapter`) owns people and sessions in four global `auth_*` tables that the tenant roles cannot read. A Better Auth session carries two extra fields, `studioId` and `kind`. They are set by our `/auth/continue` route after the magic link verifies, from a signed callback URL that names the Studio and kind. The session middleware turns that into the same `Viewer` shape H1's access rules already use, so routes and access checks do not change. Lightroom plugin bearer tokens (`ogp_…`) stay in H1's `sessions` table.

**Tech Stack:** better-auth 1.7.x and its magic-link plugin, @better-auth/drizzle-adapter, Drizzle 0.45 pg-core, Hono, PGlite for tests.

**Spec:** `docs/superpowers/specs/2026-09-30-opengallery-hosted-design.md` §3 (sign-in rules). This plan changes how they are implemented, not what they are.

## Global Constraints

- Link lifetimes: **15 minutes** for Team members, **30 days** for Clients (spec §3). Sessions last **30 days**.
- One link per Studio the email belongs to: Team member where it is in `users`, Client where it is in `clients.emails` (H1 `requestSignIn`).
- No usable sign-in link or token is ever stored in `jobs.payload` (H1 review fix #6). Verification tokens are stored hashed.
- `og_app` and `og_system` have **no privileges** on `auth_*` tables. `npm run check:tenancy` asserts it.
- Only these Better Auth endpoints are reachable over HTTP: `GET /api/ba/magic-link/verify`. Sign-in requests go through our rate-limited `POST /api/auth/request`; sign-out goes through `POST /api/auth/signout`.
- Secrets: `BETTER_AUTH_SECRET` (required in production, at least 32 characters) and `BETTER_AUTH_URL` (defaults to `BASE_URL`). Both are already staged on Fly.
- Better Auth runs on the root pool and is never called inside a Studio or system transaction. PGlite has one connection, so a nested call would deadlock the tests.
- Existing H1 people sessions are dropped by the migration; everyone signs in once more. Plugin tokens keep working.

## Review Focus

1. **A Team member clicks a link 16 minutes after it was sent.** Expect "link expired" on the sign-in page, and no session left behind. Test in Task 3.
2. **Someone edits the callback URL in an emailed link** to name another Studio, or `kind=admin`. Expect the signature check to refuse it, sign the session out, and show "link expired". Test in Task 3.
3. **An email that is a Team member in Studio A and a Client in Studio B** gets two links. Each signs into its own Studio with the right kind, and switching links switches Studios. Test in Task 3.
4. **A direct POST to Better Auth's own sign-in endpoint**, bypassing our rate limit, sends no email and creates no user. Test in Task 2.
5. **The email transport fails while sending a sign-in link.** Expect the job to retry, with no link in `jobs.payload` and the earlier, unsent verification simply expiring. Test in Task 4.

---

## File Structure

| File | Responsibility |
| --- | --- |
| `src/server/db/schema.ts`, `src/server/db/migrations/0002_auth.sql` | `auth_users`, `auth_sessions` (+ `studio_id`, `kind`), `auth_accounts`, `auth_verifications`; revoke tenant roles; retire H1 people sessions |
| `src/server/auth/better.ts` | `createAuth()` factory: Better Auth config, magic-link plugin, email sending |
| `src/server/auth/continue.ts` | Signed callback URLs and the Studio binding after verification |
| `src/server/auth/magic.ts` | Shrinks to token helpers for plugin tokens |
| `src/server/auth/signin.ts`, `src/server/auth/signup.ts`, `src/server/email/send.ts`, `src/server/jobs/queue.ts` | Sign-in emails as a system job |
| `src/server/http/session.ts`, `src/server/http/access.ts`, `src/server/http/routes/auth.ts`, `src/server/app.ts` | `Viewer`, the session middleware, routes |
| `tests/http/boot.ts`, `tests/e2e/server.ts` | Two-hop sign-in in the test harnesses |

---

### Task 1: Auth tables, revoked from tenant roles

**Files:**
- Modify: `package.json` (add `better-auth`, `@better-auth/drizzle-adapter` at the same 1.7.x version), `src/server/db/schema.ts`, `src/server/db/check.ts`, `src/server/config.ts`
- Create: `src/server/db/migrations/0002_auth.sql` via `npm run db:generate`, then append the hand-written lines below
- Test: `tests/check-tenancy.test.ts`, `tests/db.test.ts`, `tests/config.test.ts`

**Interfaces:**
- Produces Drizzle tables `authUsers` (`auth_users`), `authSessions` (`auth_sessions`), `authAccounts` (`auth_accounts`), `authVerifications` (`auth_verifications`). Generate their columns from Better Auth's core schema with `npx auth@latest generate`, then rename the tables. `authSessions` adds nullable `studioId` (`studio_id`, text, FK to `studios.id` on delete cascade) and `kind` (`text`, enum `'admin' | 'client'`). There is no RLS, because these are not tenant tables; the next line keeps tenant code out instead.
- Hand-written SQL appended to `0002_auth.sql`:
  - `REVOKE ALL ON auth_users, auth_sessions, auth_accounts, auth_verifications FROM og_app, og_system;`
  - `DELETE FROM sessions WHERE kind IN ('admin', 'client');`
  - `ALTER TABLE sessions DROP COLUMN login_token_hash, DROP COLUMN redeemed_at;`
- `checkTenancy` adds a problem `"og_app can read auth_<name>"` when `has_table_privilege('og_app', t, 'SELECT')` is true for any `auth_%` table, and likewise for `og_system`.
- Config: `betterAuthSecret: string` and `betterAuthUrl: string`. Production throws `"BETTER_AUTH_SECRET is required in production"` when the secret is missing or under 32 characters. Dev and tests default to a fixed 32-character dev secret.

- [ ] **Step 1: Write the failing tests**

```ts
it('tenant roles cannot touch auth tables', async () => {
  const db = await testDb();
  expect(await checkTenancy(db)).toEqual([]);
  await db.execute(sql`grant select on auth_sessions to og_app`);
  expect(await checkTenancy(db)).toContain('og_app can read auth_sessions');
});
it('production needs a 32-character BETTER_AUTH_SECRET', () => {
  expect(() => loadConfig({ ...prod, BETTER_AUTH_SECRET: 'short' })).toThrow(/BETTER_AUTH_SECRET/);
  expect(loadConfig({ ...prod, BETTER_AUTH_SECRET: 'x'.repeat(32) }).betterAuthUrl).toBe('https://og.example');
});
```

- [ ] **Step 2: Run them and see them fail** — `npx vitest run tests/check-tenancy.test.ts tests/config.test.ts`
- [ ] **Step 3: Install, generate, write the schema and migration, extend `checkTenancy` and config**
- [ ] **Step 4: Run them and see them pass**, plus `npx vitest run tests/tenancy.test.ts tests/db.test.ts`
- [ ] **Step 5: Commit** — `feat(auth): Better Auth tables out of tenant reach`

---

### Task 2: The Better Auth instance

**Files:**
- Create: `src/server/auth/better.ts`
- Modify: `src/server/app.ts` (`AppDeps.auth`, mount the verify route), `src/server/index.ts`
- Test: `tests/auth/better.test.ts`

**Interfaces:**
- `createAuth(o: { root: Db; config: Config; getTransport: () => Transport | null }): Auth`, where `type Auth = ReturnType<typeof betterAuth>` with these options:
  - `secret: config.betterAuthSecret`, `baseURL: config.betterAuthUrl`, `basePath: '/api/ba'`
  - `database: drizzleAdapter(root, { provider: 'pg', schema: { user: authUsers, session: authSessions, account: authAccounts, verification: authVerifications } })`
  - `session: { expiresIn: 30 * 86400, additionalFields: { studioId: { type: 'string', required: false, input: false }, kind: { type: 'string', required: false, input: false } } }`
  - `advanced: { cookiePrefix: 'og' }`
  - `plugins: [magicLink({ expiresIn: 30 * 86400, storeToken: 'hashed', sendMagicLink })]`. The 30 days is the Client maximum; the 15-minute Team limit is enforced in Task 3.
- `sendMagicLink({ email, url, metadata })` requires `metadata.studioId` and `metadata.kind`, and throws `Error('sign-in links are sent by the job queue only')` otherwise.
  - It reads the Studio's name and `confirmedAt`, and the first owner's email, in an `asSystem` transaction.
  - It renders the existing `magic_link` template with `{ studio, url }` and sends through `getTransport()`, with `fromName` the Studio name if confirmed, else `'OpenGallery'`, and `replyTo` the owner. With no transport it throws.
- `createApp` mounts only `app.get('/api/ba/magic-link/verify', (c) => auth.handler(c.req.raw))`, before `requestTx`. Every other `/api/ba/*` path answers 404.
- Before writing code, confirm in `node_modules/better-auth` typings that `auth.api.signInMagicLink` accepts `body.metadata`, and that `session.additionalFields` appear on `auth.api.getSession()`'s `session`. If either is missing, stop and report; do not work around it.

- [ ] **Step 1: Write the failing tests**

```ts
it('signInMagicLink emails a verify link and stores only a hash', async () => {
  const { auth, mail, root, studioId } = await authHarness(); // local helper in this test file: testDb() + makeStudio() + memoryTransport() + createAuth()
  await auth.api.signInMagicLink({ body: { email: 'a@x.com', callbackURL: '/auth/continue?x=1', metadata: { studioId, kind: 'client' } }, headers: new Headers() });
  const link = mail.sent.at(-1)!.text.match(/http:\/\/localhost:3000\/api\/ba\/magic-link\/verify\?token=([^&\s]+)/)!;
  const [v] = await root.select().from(authVerifications);
  expect(v!.value).not.toContain(link[1]);
});
it('a direct POST to Better Auth sign-in is not reachable', async () => {
  const s = await boot();
  expect((await s.api('/api/ba/sign-in/magic-link', { method: 'POST', body: JSON.stringify({ email: 'v@x.com' }) })).status).toBe(404);
  expect(s.mail.sent).toHaveLength(0);
});
it('sendMagicLink refuses calls without Studio metadata', async () => { /* rejects; no mail */ });
```

- [ ] **Step 2: Run them and see them fail** — `npx vitest run tests/auth/better.test.ts`
- [ ] **Step 3: Implement as specified**
- [ ] **Step 4: Run them and see them pass**
- [ ] **Step 5: Commit** — `feat(auth): Better Auth instance with magic links`

---

### Task 3: Signed callback and Studio binding

**Files:**
- Create: `src/server/auth/continue.ts`
- Modify: `src/server/http/routes/auth.ts` (add `GET /auth/continue`; `GET /auth/:token` now redirects to `/signin?error=expired` for old H1 links)
- Test: `tests/auth/continue.test.ts`

**Interfaces:**
- `continueUrl(secret: string, o: { studioId: string; kind: 'admin' | 'client'; iat: number }): string` returns `/auth/continue?studio=<id>&kind=<kind>&iat=<ms>&sig=<base64url HMAC-SHA256 of "studio|kind|iat">`.
- `verifyContinue(secret: string, q: Record<string, string | undefined>, now: number): { studioId: string; kind: 'admin' | 'client' } | null` compares signatures with `timingSafeEqual`. It returns null for a bad signature, for `kind === 'admin'` when `now - iat > 15 * 60_000`, and for `kind === 'client'` when `now - iat > 30 * 864e5`.
- `bindSession(root: Db, o: { sessionId: string; email: string; studioId: string; kind: 'admin' | 'client'; now: number }): Promise<boolean>`. In an `asSystem` read it checks that the email is in `users` (admin) or in some `clients.emails` (client) of that Studio, then sets `auth_sessions.studio_id` and `kind` on the root connection. For admin, it sets `studios.confirmed_at` if null, which moves the H1 rule from `redeemMagicLink`. It returns false when the email is not a member.
- `GET /auth/continue` (a system route, before `requestTx`):
  1. Get the session with `auth.api.getSession({ headers })`; with none, redirect to `/signin?error=expired`.
  2. Run `verifyContinue`; if it fails, call `auth.api.signOut({ headers })` and redirect to `/signin?error=expired`, passing on the sign-out's `set-cookie`.
  3. Run `bindSession`; if it returns false, do the same sign-out and redirect.
  4. Otherwise redirect to `/`.

- [ ] **Step 1: Write the failing tests**

```ts
it('a Client link signs in to that Studio as client', async () => { /* follow verify → continue; /api/me = { kind: 'client', studio: { id: A } } */ });
it('a Team link older than 15 minutes is refused and leaves no session', async () => { /* iat = now - 16 min → /signin?error=expired; /api/me 401 */ });
it('a Client link 29 days old still works', async () => {});
it('a tampered studio or kind fails the signature', async () => { /* edit studio=B in the callback → expired */ });
it('one email, Team in A and Client in B: each link binds its own Studio', async () => {});
it('the first owner sign-in confirms the Studio', async () => {});
it('an H1 /auth/<token> link now says expired', async () => {});
```

- [ ] **Step 2: Run them and see them fail** — `npx vitest run tests/auth/continue.test.ts`
- [ ] **Step 3: Implement as specified**
- [ ] **Step 4: Run them and see them pass**
- [ ] **Step 5: Commit** — `feat(auth): signed callback binds a session to one Studio`

---

### Task 4: Sign-in emails as a system job

**Files:**
- Modify: `src/server/jobs/queue.ts`, `src/server/auth/signin.ts`, `src/server/auth/signup.ts`, `src/server/email/send.ts` (drop the `magic` option), `src/server/auth/magic.ts` (keep only `hashToken`, `randomToken`), `src/server/index.ts`
- Test: `tests/jobs/queue.test.ts`, `tests/auth/signin.test.ts`, `tests/auth/signup.test.ts`, `tests/email/email.test.ts`

**Interfaces:**
- `queue.ts` adds `type SystemHandler = { system: true; run: (payload: unknown, ctx: { root: Db; jobId: string; studioId: string }) => Promise<void> }`; `Handlers` values become `Handler | SystemHandler`.
  - `runOnce` runs a `SystemHandler` on `root` outside any transaction, then marks the job done in its own `asSystem` transaction.
  - Failure handling is the same as for normal handlers: backoff, `NeedsReview`, `failed`.
- `sendSignInLink(db, o)` keeps its signature. It enqueues kind `send_magic_link` with payload `{ email, kind }` and idempotency key `magic:<studioId>:<email>:<now>`, for the given `studioId`.
- `makeSignInHandlers(auth: Auth, config: Config): Handlers` returns `{ send_magic_link: { system: true, run } }`. `run` calls `auth.api.signInMagicLink({ body: { email, callbackURL: continueUrl(secret, { studioId, kind, iat: Date.now() }), metadata: { studioId, kind } }, headers: new Headers() })`.
- `createMagicLink`, `redeemMagicLink`, `sessionFromToken`'s people path, `signOut`, `TTL.admin` and `TTL.client` are deleted. Plugin tokens keep `hashToken`, `randomToken` and the `sessions` table.

- [ ] **Step 1: Write the failing tests**

```ts
it('a system handler runs outside any transaction and its job ends done', async () => {});
it('no sign-in link or token is ever stored in jobs', async () => {
  // requestSignIn → drain; for every jobs row, JSON.stringify(payload) matches neither /token/i nor /magic-link\/verify/
});
it('a transport failure retries the job and the next attempt sends a fresh working link', async () => {});
it('signup sends one link from OpenGallery; after confirming, links come from the Studio name', async () => {});
```

- [ ] **Step 2: Run them and see them fail** — `npx vitest run tests/jobs tests/auth tests/email`
- [ ] **Step 3: Implement as specified**
- [ ] **Step 4: Run them and see them pass**
- [ ] **Step 5: Commit** — `feat(auth): sign-in emails mint Better Auth links at send time`

---

### Task 5: `Viewer`, session middleware, sign-out, test harnesses

**Files:**
- Modify: `src/server/http/session.ts`, `src/server/http/access.ts`, `src/server/http/routes/auth.ts`, `src/server/app.ts`, `tests/http/boot.ts`, `tests/e2e/server.ts`, any test that builds a `SessionRow` by hand
- Test: the full suite

**Interfaces:**
- `type Viewer = { id: string; studioId: string; kind: 'admin' | 'client' | 'guest' | 'plugin' | 'mcp'; subject: string; projectId: string | null; scope: string; nickname: string | null }`. `AppEnv.Variables.session` becomes `Viewer | null`. `access.ts` and routes take `Viewer` wherever they took `SessionRow`; the field names are unchanged.
- `sessionMiddleware(root, auth)`:
  - `Bearer ogp_…` → the H1 `sessions` lookup (plugin tokens), mapped to `Viewer`.
  - Otherwise `auth.api.getSession({ headers: c.req.raw.headers })`. With `session.studioId` and `session.kind` set, it gives `Viewer { id: session.id, studioId, kind, subject: user.email.toLowerCase(), projectId: null, scope: 'read', nickname: null }`; otherwise `null`.
  - Neither path runs for `/assets/*` (H1 deferred minor).
- `POST /api/auth/signout` calls `auth.api.signOut({ headers })`, forwards its `set-cookie`, and returns `{ ok: true }`.
- `setSessionCookie`, `clearSessionCookie` and `COOKIE` are deleted. Guest sessions (H2b) will use Better Auth's anonymous plugin or a plugin-style token, to be decided there.
- `boot().redeemLatest` and `startTestServer().signInLink` follow two hops: verify, which sets Better Auth's cookie and redirects to `/auth/continue?…`, then continue with that cookie. They return the final cookie string. `linkFrom` matches `/api/ba/magic-link/verify?token=…`.

- [ ] **Step 1: Update the harnesses first; the suite goes red where it still expects H1 links**
- [ ] **Step 2: Run** `npx vitest run` and list the failures
- [ ] **Step 3: Implement `Viewer`, the middleware and sign-out; fix the remaining type errors**
- [ ] **Step 4: Run the gates** — `npx vitest run && npx tsc --noEmit -p . && npm run test:e2e`. Expected: everything passes, including `tests/http/isolation.test.ts` unchanged.
- [ ] **Step 5: Commit** — `refactor(auth): sessions come from Better Auth`

---

### Task 6: Deploy and verify

**Files:**
- Modify: `docs/deploy.md` (Better Auth secrets, the one-time sign-out), `.env.example` (`BETTER_AUTH_SECRET`, `BETTER_AUTH_URL`)

- [ ] **Step 1: Check the staged secrets** — `fly secrets list -a opengallery` shows `BETTER_AUTH_SECRET` and `BETTER_AUTH_URL`, with `BETTER_AUTH_URL` = `https://opengallery.fly.dev`.
- [ ] **Step 2: Deploy** — `fly deploy -a opengallery`. Expected: the release step's migration passes and `/healthz` returns 200.
- [ ] **Step 3: Tenancy gate** — from the main checkout, after `npm ci`: `DATABASE_URL="$(npx -y neon@latest connection-string --project-id holy-violet-48717844 --pooled --role-name neondb_owner --database-name neondb)" npm run check:tenancy` prints `ok`, which now includes the auth-table privilege check.
- [ ] **Step 4: Real sign-in** — the owner requests a link at `/signin`, gets the email, clicks it, and lands signed in to their Studio. A second click on the same link shows "link expired".
- [ ] **Step 5: Commit** — `docs: H1.5 Better Auth deploy notes`

---

## Not in H1.5

Passwords, social sign-in and passkeys; Better Auth's organization plugin (Studios stay our own `studios` and `users` tables); guest share sessions (H2b); OAuth for the Claude connector (H4, on the Connector with `workers-oauth-provider`).
