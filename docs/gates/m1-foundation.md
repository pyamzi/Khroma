# Milestone 1 gate record: Foundation

**Date:** 2026-09-11
**Branch:** agents/implement-opengallery-milestone-1 at `7f16824` (this record is committed on top)
**Spec:** docs/superpowers/specs/2026-09-10-opengallery-design.md, section 18 gates *Identity*, *Minimum install*, *Write policy*
**Plan:** docs/superpowers/plans/2026-09-10-m1-foundation.md

## Automated evidence

`npm run typecheck && npm test` on Node 24.18.0 with exiftool 13.55:

```
 Test Files  19 passed (19)
      Tests  72 passed | 1 skipped (73)
```

The one skipped test needs a real RAW file (`OPENGALLERY_RAW_FIXTURE`); no RAW exists on the dev machine. The exiftool path is exercised in CI's Ubuntu image once a fixture is added.

| Gate | Tests |
|---|---|
| Identity | `tests/fs/index.test.ts` (rename while stopped keeps id + child rows; missing → unavailable, returns on reappearance; duplicate ids quarantined; wrong depth flagged and not indexed; cross-client move held then approved, second scan does not flip-flop; machine field restored from db while human field kept; malformed json keeps last good state), `tests/fs/photos.test.ts` (renamed RAW is missing + new, never merged) |
| Minimum install | `tests/http/app.test.ts` (bootstrap with SMTP only; api 503 until the owner redeems the link; link single-use; cookie HttpOnly; unknown email gets the same 200 and no mail; no-session preview is 404; client cannot call admin routes; transfer approval clears the issue), `tests/auth/bootstrap.test.ts`, `tests/email/email.test.ts` (no transport → visible job failure; listmonk transport against a local server) |
| Write policy | `tests/fs/paths.test.ts` (traversal, absolute, symlink escape), `tests/fs/media.test.ts` (signature mismatch, unknown type, empty file rejected), `tests/fs/photos.test.ts` (unsupported files skipped; SMB-discovered files go through the same sniff; new finals staged as drafts; a draft never touches the live file; external overwrite of a live final logged as `replaced_externally`) |
| Recovery (partial, M1 scope) | `tests/jobs/queue.test.ts` (idempotency key dedup, backoff, failed after 3, needs_review not retried, expired leases recovered), `tests/jobs/inbox.test.ts` |

## Manual checks against the built server

Run with `npm run build`, `node dist/server/index.js` on port 3124, a seeded tree (two clients, one project with one RAW), and a local SMTP capture server.

1. **Bootstrap with a dead SMTP, then recover.** `/api/setup` with `smtp://u:p@127.0.0.1:1` returned 200; the `send_email` job showed `pending, attempts 1, Error: connect ECONNREFUSED 127.0.0.1:1`; `/healthz` reported `awaiting_verification`; `/api/projects` returned 503. After pointing the settings row at a working SMTP and restarting, the **same job id** completed (`done, attempts 2`). The link arrived over SMTP; redeeming it set `setup: complete`, `/api/me` returned the owner as admin, and a second visit redirected to `/signin?error=expired`.
2. **Stopped-state cross-client move.** With the server stopped, `Clients/Smith/Wedding` was moved to `Clients/Other/Wedding`. On boot: 1 issue, `transfer_pending`; the project showed `available: false, transferPending: true` with its photo count intact. `POST /api/projects/:id/approve-transfer` returned ok; afterwards `available: true`, client `Other`, `state_version 2` in the database and `"stateVersion": 2` in `project.json`, photo count 1, issues empty. Signing in as the old client listed no projects; the new client listed `Wedding`.

## Environment notes

- Node 26 has no prebuilt `better-sqlite3`; the project pins Node 24 via `.node-version` (engine floor stays `>=22`).
- chokidar 4 on macOS dropped all events in about 1 run in 25 after `ready`. The watcher now awaits `ready` and runs a full sweep every 60 s so dropped events heal; the test polls for convergence.
- Docker is not installed on the dev machine. `compose.yml` and the CI workflow were validated as YAML; the image build and the compose smoke run are exercised by CI on tags and must be repeated on the NAS at install time.
- `npm audit --audit-level=high` exits 0 after upgrading drizzle-orm, nodemailer, sharp, vite, and vitest.

## ponytail ceilings introduced in M1

- `quickHash`: sha256 of size + first/last 64 KiB, not the full file. Upgrade if collisions ever matter.
- Sign-in rate limit is an in-process map. Move to SQLite if a second process appears.
- Single in-process job worker with 60 s leases.
- `currentIssues()` is a module-level snapshot of the last rescan, not persisted.
