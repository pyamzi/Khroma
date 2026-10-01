# H2 Library and Uploads Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A Studio uploads photos from the browser straight to R2 and sees them in its Library within a minute, the Lightroom plugin sends culling previews instead of RAWs, and Clients receive published finals and download them from R2.

**Architecture:** The browser asks the App for a presigned R2 PUT URL, uploads directly, then tells the App the upload is complete, which queues a `process_upload` job. Heavy job kinds (`process_upload`, `preview`, `build_zip`) run on a Fly machine in a `worker` process group that the App starts through the Fly Machines API when such jobs are pending and that exits after 60 idle seconds; without Fly credentials (tests, local dev) the App's own worker runs every kind. Clients get originals and gallery ZIPs through 10-minute presigned R2 GET URLs.

**Tech Stack:** Node 22, Hono, Drizzle 0.45 pg-core, PGlite (tests), sharp, exiftool, `heif-convert` (libheif-examples), `zip`, aws4fetch, React 18 + Tailwind, Playwright, Lightroom Lua SDK.

**Spec:** `docs/superpowers/specs/2026-09-30-opengallery-hosted-design.md` (§4 Library, §7 data model, §12 item 2). Rules it inherits: `docs/superpowers/specs/2026-09-10-opengallery-design.md` §5–§6 and §10 (publishing, download entitlement).

**Runs after:** `docs/superpowers/plans/2026-10-01-h1-5-better-auth.md` (sign-in moves to Better Auth; H1.5 has two migrations: `0002_auth.sql` and `0003_retire_h1_sessions.sql`). Where this plan says "admin" or "session", it means H1.5's `Viewer`.

**Scope decision (made by the planner; the owner declined to choose):** "Finals delivery from R2" means the delivery core: publish drafts to live, the Client finals view, favorites, and single and ZIP downloads. Share passwords and guests, music and slideshow, sections, order and cover, and gallery expiry move to a follow-up milestone (H2b). The half-built Milestone 5 worktree (`OpenGallery.worktrees/implement-opengallery-milestone-5`) is reference only; its download-entitlement and publish-guard rules are ported below, nothing is copied from its file-based code.

## Global Constraints

- Library upload formats: JPEG, PNG, WebP, HEIC (HEIC is converted to JPEG); **50 MB per file** (52,428,800 bytes).
- Web sizes: **400, 1280, 2048 px** long edge, JPEG. Variant names: `thumb` (400), `medium` (1280), `preview` (2048), each with a `.draft` twin for unpublished finals.
- Culling previews: `in_library = false`, never counted, never in the Library view, purged **30 days** after the Client finishes picking.
- The Plan's photo count covers Library photos only (`in_library = true`, `status <> 'failed'`). Enforcing the cap is H5; H2 only makes the count correct.
- Presigned PUT URLs live **15 minutes**; presigned download URLs live **10 minutes** (old spec §10).
- Every new tenant table or column follows H1 tenancy: `studio_id` default from the setting, FORCE RLS, an index led by `studio_id`, composite FKs. `npm run check:tenancy` must stay `ok`.
- Commit-then-call: rows commit before any job's outside call; storage objects written by the browser arrive after their row exists.
- Gates (spec §12): a 20 MB JPEG goes from upload to visible in the Library in **under 60 seconds** on the deployed stack; culling previews are excluded from counts.

## Review Focus

1. **Upload completed but object missing or truncated** (browser closed mid-PUT, then `complete` called). Expect the job to mark the photo `failed` with an event, not crash or loop. Test in Task 5.
2. **A file whose extension lies** (`.jpg` that is a PDF, `.heic` that is a PNG). Expect `failed`, object deleted, never served. Test in Task 4.
3. **The plugin re-sends the same RAW's preview** (re-run, or the RAW was re-developed). Expect the same photo id, picks and comments kept, image replaced only when the bytes changed. Test in Task 6.
4. **Download requested while a ZIP is building, or after a new final is published.** Expect `preparing` and then a ZIP of the current live set; a stale ZIP is never served for a newer set. Test in Task 8.
5. **A Client from Studio A, or a Team member of Studio B, guessing a Library photo id or a project download URL.** Expect 404 everywhere. Test in Task 5 and Task 8.

---

## File Structure

| File | Responsibility |
| --- | --- |
| `src/server/db/schema.ts`, `src/server/db/migrations/0004_library.sql` | Photo columns for Library and processing state |
| `src/server/storage.ts` | Adds `presignPut`, `presignGet`, `copy`, `exists`; dev upload route support for memory storage |
| `src/server/jobs/queue.ts`, `src/server/jobs/worker.ts`, `src/server/jobs/wake.ts`, `src/server/worker.ts` | Job kinds per machine, waking and idling the processing machine |
| `src/server/media/sniff.ts`, `src/server/media/metadata.ts`, `src/server/media/convert.ts`, `src/server/media/previews.ts` | WebP signature, EXIF/keywords/caption, HEIC→JPEG, three web sizes |
| `src/server/domain/library.ts`, `src/server/http/routes/library.ts` | Library uploads, processing job, listing, delete, stale-upload sweep |
| `src/server/domain/photos.ts`, `src/server/http/routes/plugin.ts`, `plugin/OpenGallery.lrplugin/*` | Culling previews from the plugin |
| `src/server/domain/delivery.ts`, `src/server/http/routes/delivery.ts` | Publish, favorites, download entitlement, single and ZIP downloads |
| `src/server/domain/cleanup.ts` | 30-day culling purge |
| `src/web/admin/Library.tsx`, `src/web/pages/Gallery.tsx` | Library view with uploads; Client finals gallery |

---

### Task 1: Library columns on `photos`

**Files:**
- Modify: `src/server/db/schema.ts` (photos table), `src/server/http/access.ts` (`loadPhoto`), `src/server/domain/photos.ts` (`addPhoto`)
- Create: `src/server/db/migrations/0004_library.sql` via `npm run db:generate`, then append the data fix by hand
- Test: `tests/db.test.ts`, `tests/http/access.test.ts`, `tests/domain/photos.test.ts`

**Interfaces:**
- Produces: `photos.projectId: string | null`; `photos.inLibrary: boolean` (default `true`); `photos.status: 'uploading' | 'processing' | 'ready' | 'failed'` (default `'ready'`); `photos.keywords: string[]` (jsonb, default `[]`); `photos.caption: string | null`; `photos.createdAt: string` (default now, same `now()` helper as other tables); `photos.readyAt: string | null`; `photos.purgedAt: string | null`. Index `photos_studio_library` on `(studio_id, in_library, created_at)`.
- `loadPhoto()` accepts a photo with `projectId === null` only for an admin of the same Studio; everyone else gets 404.
- `addPhoto` sets `inLibrary: o.stage !== 'culling'` (existing rows are fixed by the migration's UPDATE).

- [ ] **Step 1: Write the failing tests**

```ts
// tests/db.test.ts
it('a Library photo needs no project and defaults to in_library ready', async () => {
  const { db } = await studioTestDb();
  await db.insert(photos).values({ id: 'p1', projectId: null, relPath: 'library/p1/a.jpg', stage: 'final', kind: 'photo', checksum: '' });
  const [r] = await db.select().from(photos);
  expect(r).toMatchObject({ projectId: null, inLibrary: true, status: 'ready', keywords: [], purgedAt: null });
  expect(r!.createdAt).toMatch(/^\d{4}-\d\d-\d\dT/);
});
// tests/domain/photos.test.ts
it('addPhoto keeps culling RAWs out of the Library', async () => {
  // addPhoto(stage: 'culling') → inLibrary false; addPhoto(stage: 'final') → inLibrary true
});
// tests/http/access.test.ts
it('a Library photo is reachable by its Studio admin only', async () => {
  // owner A: 200 on /api/photos/:id/preview once ready; client of A: 404; owner B: 404
});
```

- [ ] **Step 2: Run them and see them fail**

Run: `npx vitest run tests/db.test.ts tests/http/access.test.ts tests/domain/photos.test.ts`
Expected: FAIL (`project_id` not null violation; unknown columns).

- [ ] **Step 3: Change the schema, generate `0004_library.sql`, and append `UPDATE photos SET in_library = false WHERE stage = 'culling';`**

`projectId` loses `.notNull()`; the composite FK `(studio_id, project_id)` stays (a null `project_id` skips the check under MATCH SIMPLE). Keep `photos_project_path` unchanged; null project rows never collide. Update `loadPhoto` as described.

- [ ] **Step 4: Run the tests and the tenancy gate**

Run: `npx vitest run tests/db.test.ts tests/http/access.test.ts tests/check-tenancy.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit** — `feat(db): Library columns on photos`

---

### Task 2: Presigned URLs, copy and exists in storage

**Files:**
- Modify: `src/server/storage.ts`, `src/server/app.ts` (dev route, CSP), `src/server/index.ts`
- Create: `deploy/r2-cors.json`
- Test: `tests/storage.test.ts`, `tests/http/app.test.ts`

**Interfaces:**
- Produces on `Storage`:
  - `presignPut(key: string, contentType: string, ttlSec: number): Promise<string>`
  - `presignGet(key: string, ttlSec: number, downloadName?: string): Promise<string>`; with `downloadName` the URL carries `response-content-disposition=attachment; filename="<name>"`
  - `copy(fromKey: string, toKey: string): Promise<void>`
  - `exists(key: string): Promise<boolean>`
- `memoryStorage()` presigns to `/dev/storage/<encoded key>`; `createApp` mounts `PUT` and `GET /dev/storage/*` only when `storage.dev === true` (memory storage sets `dev: true`).
- `zipKey(studioId: string, projectId: string, hash: string)` → `z/<studioId>/<projectId>/<hash>.zip` (outside `s/` so an R2 lifecycle rule can expire it).
- CSP gains `connect-src 'self' https://*.r2.cloudflarestorage.com`.

- [ ] **Step 1: Write the failing tests**

```ts
it('r2 presignPut signs a 15-minute PUT for the exact key', async () => {
  const url = new URL(await r2Storage(cfg).presignPut('s/a/p/b/original', 'image/jpeg', 900));
  expect(url.pathname).toBe('/opengallery-media/s/a/p/b/original');
  expect(url.searchParams.get('X-Amz-Expires')).toBe('900');
  expect(url.searchParams.get('X-Amz-Signature')).toMatch(/^[0-9a-f]{64}$/);
});
it('r2 presignGet sets an attachment filename', async () => {
  const url = new URL(await r2Storage(cfg).presignGet('k', 600, 'a "b".jpg'));
  expect(url.searchParams.get('response-content-disposition')).toBe('attachment; filename="a b.jpg"');
});
it('r2 copy sends x-amz-copy-source and exists maps 404 to false', async () => { /* fetch stub records requests */ });
it('memory storage round-trips through the dev route', async () => {
  // PUT bytes to the URL from presignPut via app.request, then storage.getBytes(key) equals them; GET of a presignGet URL returns them
});
it('the dev route does not exist with R2 storage', async () => { /* 404 */ });
```

- [ ] **Step 2: Run them and see them fail** — `npx vitest run tests/storage.test.ts tests/http/app.test.ts`

- [ ] **Step 3: Implement** with aws4fetch `aws.sign(url, { method, aws: { signQuery: true } })` and `X-Amz-Expires` set on the URL before signing. Strip `"` and `\` from download names. `copy` is a PUT with `x-amz-copy-source: /<bucket>/<key>`; `exists` is a HEAD. Write `deploy/r2-cors.json` allowing `PUT` and `GET` from `https://opengallery.fly.dev` and `http://localhost:3000` with header `content-type`, max age 3600.

- [ ] **Step 4: Run them and see them pass**

- [ ] **Step 5: Commit** — `feat(storage): presigned URLs, copy, exists`

---

### Task 3: Job kinds per machine and the processing machine

**Files:**
- Modify: `src/server/jobs/queue.ts`, `src/server/jobs/worker.ts`, `src/server/config.ts`, `src/server/index.ts`, `fly.toml`, `Dockerfile`, `package.json` (`worker` script not needed; build already compiles `src/server/worker.ts`)
- Create: `src/server/jobs/wake.ts`, `src/server/worker.ts`
- Test: `tests/jobs/queue.test.ts`, `tests/jobs/wake.test.ts`, `tests/config.test.ts`

**Interfaces:**
- `HEAVY_KINDS = ['process_upload', 'preview', 'build_zip'] as const` exported from `queue.ts`.
- `claimNext(root, now, kinds?: readonly string[], leaseMs?)` and `runOnce(root, handlers, now?, kinds?)`: when `kinds` is given only those kinds are claimed.
- `startWorker(root, handlers, { intervalMs, kinds?, exitWhenIdleMs?, onIdleExit?, onTick? })`: `onTick` runs before each claim pass; with `exitWhenIdleMs` the worker calls `onIdleExit()` after that long with nothing claimed.
- `makeWaker(o: { appName: string; token: string; fetch?: typeof fetch; minIntervalMs?: number }): () => Promise<void>`: lists `GET https://api.machines.dev/v1/apps/<app>/machines?metadata.fly_process_group=worker` once (cached), then `POST .../machines/<id>/start` with `Authorization: Bearer <token>`. It treats 200 and "already started" (409/412) as success and calls the API at most once per `minIntervalMs` (default 3000).
- `pendingHeavy(root: Db, now: number): Promise<boolean>` (system transaction, `LIMIT 1`).
- Config: `FLY_API_TOKEN` (optional) and `FLY_APP_NAME` (set by Fly) give `config.processing = { mode: 'remote', appName, token }`; otherwise `{ mode: 'local' }`.
- App (`index.ts`): in local mode the in-process worker runs all handlers. In remote mode it runs only `send_email`, and its `onTick` calls the waker when `pendingHeavy` is true.
- `src/server/worker.ts`: loads config and storage, runs `startWorker` with the heavy handlers, `intervalMs: 500`, `exitWhenIdleMs: 60_000`, and `onIdleExit` closes the DB and calls `process.exit(0)`.
- `fly.toml`: `[processes] app = "node dist/server/index.js"`, `worker = "node dist/server/worker.js"`; `http_service.processes = ["app"]`; a `[[vm]]` for `processes = ["worker"]` with `size = "shared-cpu-2x"`, `memory = "2gb"`; worker `restart.policy = "no"`.
- Dockerfile runtime apt adds `libheif-examples zip`.

- [ ] **Step 1: Write the failing tests**

```ts
it('claimNext only claims the requested kinds', async () => {
  // enqueue send_email and process_upload; claimNext(db, now, ['send_email']) returns the email job; the upload stays pending
});
it('an idle worker exits after exitWhenIdleMs', async () => { /* exitWhenIdleMs: 50, intervalMs: 10; onIdleExit called once */ });
it('the waker starts the worker machine once per interval', async () => {
  // fetch stub: list returns [{ id: 'm1' }]; two calls 1 ms apart → one POST to /v1/apps/og/machines/m1/start with bearer token
});
it('the waker treats an already-started machine as success', async () => { /* start returns 412 → resolves */ });
it('remote mode needs both FLY_API_TOKEN and FLY_APP_NAME', () => { /* loadConfig → processing.mode */ });
```

- [ ] **Step 2: Run them and see them fail** — `npx vitest run tests/jobs tests/config.test.ts`

- [ ] **Step 3: Implement** as specified. `claimNext` adds `inArray(jobs.kind, kinds)` when `kinds` is given.

- [ ] **Step 4: Run them and see them pass**, then `npx tsc --noEmit -p .`

- [ ] **Step 5: Commit** — `feat(jobs): run heavy jobs on a Fly worker machine`

---

### Task 4: Media: WebP, metadata, HEIC, three sizes

**Files:**
- Modify: `src/server/media/sniff.ts`, `src/server/media/previews.ts`, `src/server/domain/photos.ts` (`makePreviewHandlers` writes `medium` too), `src/server/http/routes/photos.ts` (`size=medium`)
- Create: `src/server/media/metadata.ts`, `src/server/media/convert.ts`
- Test: `tests/media/sniff.test.ts`, `tests/media/metadata.test.ts`, `tests/media/previews.test.ts`, `tests/domain/photos.test.ts`

**Interfaces:**
- `sniffBytes` accepts `.webp` (`RIFF....WEBP`) as `{ kind: 'photo', format: 'webp' }`.
- `PhotoVariant` adds `'medium' | 'medium.draft'`; `MEDIUM_EDGE = 1280` next to `PREVIEW_EDGE` and `THUMB_EDGE`.
- `renderSizes(src: Uint8Array): Promise<{ thumb: Buffer; medium: Buffer; preview: Buffer; width: number; height: number }>`: width and height are the source's oriented size. It uses `extractPreview` for `preview`, then resizes that to `medium` and `thumb`.
- `readMetadata(bytes: Uint8Array): Promise<{ capturedAt: string | null; keywords: string[]; caption: string | null }>` runs `exiftool -j -n -DateTimeOriginal -Subject -Keywords -Description -Caption-Abstract -ImageDescription` on a temp copy. Keywords are the deduplicated union of `Subject` and `Keywords`; the caption is the first non-empty of `Description`, `Caption-Abstract`, `ImageDescription`; `capturedAt` is ISO or null. If exiftool is missing it returns empty values.
- `heicToJpeg(bytes: Uint8Array): Promise<Buffer>` runs `heif-convert -q 92 in.heic out.jpg` and throws `PreviewError` on failure.
- The preview job writes `thumb`, `medium` and `preview` (and their `.draft` twins).

- [ ] **Step 1: Write the failing tests**

```ts
it('sniffs webp and rejects a .webp that is a png', async () => { /* sharp webp bytes → webp; png bytes named a.webp → null */ });
it.skipIf(!hasExiftool)('reads date, Lightroom keywords and caption', async () => {
  // write a JPEG, then `exiftool -overwrite_original -DateTimeOriginal="2024:06:01 10:00:00" -Subject=beach -Subject=dusk -Description="Couple on the pier"`
  expect(await readMetadata(bytes)).toEqual({ capturedAt: '2024-06-01T10:00:00.000Z', keywords: ['beach', 'dusk'], caption: 'Couple on the pier' });
});
it('renderSizes keeps the source size and caps each edge', async () => {
  const r = await renderSizes(await jpegBytes(3000, 2000));
  expect([r.width, r.height]).toEqual([3000, 2000]);
  expect((await sharp(r.medium).metadata()).width).toBe(1280);
  expect((await sharp(r.thumb).metadata()).width).toBe(400);
});
it.skipIf(!hasHeifConvert)('converts HEIC to JPEG', async () => { /* fixture made by `heif-enc` if present */ });
it('the preview job writes the medium size', async () => { /* addPhoto → drain → storage has s/<studio>/p/<id>/medium */ });
```

- [ ] **Step 2: Run them and see them fail** — `npx vitest run tests/media tests/domain/photos.test.ts`
- [ ] **Step 3: Implement as specified**
- [ ] **Step 4: Run them and see them pass**
- [ ] **Step 5: Commit** — `feat(media): webp, metadata, heic, 1280 size`

---

### Task 5: Library uploads, processing, listing

**Files:**
- Create: `src/server/domain/library.ts`, `src/server/http/routes/library.ts`
- Modify: `src/server/app.ts` (mount), `src/server/index.ts` and `src/server/worker.ts` (handlers, hourly sweep)
- Test: `tests/domain/library.test.ts`, `tests/http/library.test.ts`

**Interfaces:**
- `MAX_UPLOAD_BYTES = 52_428_800`; `LIBRARY_EXT = ['.jpg', '.jpeg', '.png', '.webp', '.heic']`.
- `class LibraryError extends Error { code: 'unsupported' | 'too_large' | 'not_found' }`.
- `startUpload(db, storage, o: { name: string; size: number }): Promise<{ photoId: string; uploadUrl: string; contentType: string }>` inserts `{ projectId: null, stage: 'final', live: true, inLibrary: true, status: 'uploading', relPath: 'library/<id>/<sanitized name>', checksum: '' }` and presigns `original` for 900 s.
- `completeUpload(db, photoId): Promise<void>` changes `uploading` to `processing` and enqueues `process_upload` with idempotency key `process:<photoId>`. A photo already `processing` or `ready` is a no-op. Anything else throws `not_found`.
- `makeLibraryHandlers(storage): Handlers` with `process_upload`: it reads the original, sniffs it, and converts HEIC (replacing `original` with JPEG bytes). It then runs `renderSizes` and `readMetadata`, writes the sizes, and sets `status 'ready'`, `readyAt`, `width`, `height`, `capturedAt`, `keywords`, `caption`, and `checksum = sha256(original)`.
  - A missing object, failed sniff, or failed render sets `status 'failed'`, deletes the objects, and inserts event `upload_failed` with `{ photoId, reason }`. The job itself succeeds.
- `libraryPage(db, o: { cursor?: string; limit: number }): Promise<{ total: number; items: LibraryItem[]; nextCursor: string | null }>`.
  - `LibraryItem = { id; status; width; height; capturedAt; createdAt; readyAt; projectId; projectTitle: string | null }`.
  - It returns rows where `in_library` and status ≠ `failed`, newest first; the cursor is the last `createdAt|id`.
  - `total` counts the same rows.
- `deleteLibraryPhoto(db, storage, photoId)`: Library-only photos (`projectId === null`); deletes the row and every variant.
- `sweepStaleUploads(root, storage, now)`: rows still `uploading` after 1 hour are deleted with their object. It runs hourly next to `sweepUnconfirmedStudios` (H1 deferred minor: orphaned objects).
- Routes (admin only): `POST /api/library/uploads` `{ name, size }` → 201 `{ photoId, uploadUrl, contentType }`; 413 `too_large`; 415 `unsupported`. `POST /api/library/uploads/:photoId/complete` → 200. `GET /api/library?cursor=&limit=` (limit default 60, max 200). `DELETE /api/library/:photoId` → 200 or 404.

- [ ] **Step 1: Write the failing tests**

```ts
it('upload → complete → ready with sizes and metadata', async () => {
  const s = await boot(); const owner = (await s.signupOwner('o@x.com', 'A')).cookie;
  const up = await s.json<{ photoId: string; uploadUrl: string }>(await s.post('/api/library/uploads', { name: 'a.jpg', size: 1000 }, owner));
  await s.app.request(up.uploadUrl, { method: 'PUT', body: await jpegBytes(3000, 2000), headers: { 'content-type': 'image/jpeg' } });
  expect((await s.post(`/api/library/uploads/${up.photoId}/complete`, {}, owner)).status).toBe(200);
  await s.drain();
  const page = await s.json<{ total: number; items: { id: string; status: string; width: number }[] }>(await s.api('/api/library', { cookie: owner }));
  expect(page.total).toBe(1); expect(page.items[0]).toMatchObject({ id: up.photoId, status: 'ready', width: 3000 });
});
it('refuses 50 MB + 1 byte and a .gif', async () => { /* 413 too_large; 415 unsupported */ });
it('complete without an uploaded object ends failed, not retried', async () => { /* drain → status failed, event upload_failed, job done */ });
it('a .jpg that is a PDF ends failed and its object is deleted', async () => { /* storage.keys() has no s/<studio>/p/<id>/ keys */ });
it('complete twice queues one job', async () => {});
it('culling previews are not in the Library total', async () => { /* addCulling 3 RAWs + 1 upload → total 1 */ });
it('another Studio and a Client get 404 on list, complete, delete and preview', async () => {});
it('stale uploading rows are swept after an hour', async () => {});
```

- [ ] **Step 2: Run them and see them fail** — `npx vitest run tests/domain/library.test.ts tests/http/library.test.ts`
- [ ] **Step 3: Implement as specified**
- [ ] **Step 4: Run them and see them pass**
- [ ] **Step 5: Commit** — `feat(library): direct-to-R2 uploads and processing`

---

### Task 6: Culling previews from the Lightroom plugin

**Files:**
- Modify: `src/server/domain/photos.ts`, `src/server/http/routes/plugin.ts`, `src/server/domain/finals.ts` (unique-violation race), `plugin/OpenGallery.lrplugin/OGApi.lua`, `plugin/OpenGallery.lrplugin/Info.lua`
- Create: `plugin/OpenGallery.lrplugin/OGSendCulling.lua`
- Test: `tests/http/plugin.test.ts`, `tests/domain/finals.test.ts`, `tests/plugin/api_test.lua`, `tests/plugin/luac.test.ts` (already compiles every `.lua`)

**Interfaces:**
- `addCullingPreview(db, storage, o: { projectId: string; relPath: string; bytes: Uint8Array; name: string }): Promise<{ photoId: string; created: boolean; replaced: boolean }>`
  - `relPath` is normalized to `raw/<basename>`; the file must sniff as JPEG.
  - It inserts `{ stage: 'culling', inLibrary: false, status: 'ready' }`.
  - The same `(projectId, relPath)` with the same checksum returns the existing id, with `created: false, replaced: false`.
  - A different checksum overwrites `original`, updates the checksum, and re-queues `preview`, keeping the id, picks and comments.
  - It calls `onCullingMediaAdded`.
- Route `POST /api/plugin/projects/:id/culling` (write scope, multipart `file`, `relPath`) → 201 created, 200 otherwise; 415 when not JPEG; 413 over 30 MB.
- `uploadFinal` maps a `photos_project_path` unique violation (`pgCode(e) === '23505'`) to `FinalsError('conflict')` → 409 (H1 deferred minor).
- Lua: `OGApi:uploadCulling(projectId, { filePath, relPath })`. A Library menu item "Send for culling to OpenGallery…" lets the user pick a project. For each selected photo it calls `photo:requestJpegThumbnail(2048, 2048, cb)`, writes the JPEG to a temp file, and uploads it with `relPath = 'raw/' .. LrPathUtils.leafName(photo:getRawMetadata('path'))`. It shows a progress scope and a summary dialog with counts sent, unchanged and failed.

- [ ] **Step 1: Write the failing tests**

```ts
it('the plugin sends a culling preview that is not a Library photo', async () => {
  // POST multipart → 201; /api/projects/:id/photos?stage=culling lists raw/IMG_1.CR3; /api/library total stays 0; project moves to culling
});
it('re-sending the same preview is a no-op; changed bytes replace it and keep picks', async () => {});
it('refuses a non-JPEG preview with 415', async () => {});
it('two concurrent same-name final uploads give 201 and 409, never 500', async () => {});
```

Add to `tests/plugin/api_test.lua`: `uploadCulling` of the test JPEG, then `resolve` returns its id for `raw/<name>`.

- [ ] **Step 2: Run them and see them fail** — `npx vitest run tests/http/plugin.test.ts tests/domain/finals.test.ts tests/plugin`
- [ ] **Step 3: Implement as specified**
- [ ] **Step 4: Run them and see them pass**
- [ ] **Step 5: Commit** — `feat(plugin): send culling previews instead of RAWs`

---

### Task 7: Publish finals

**Files:**
- Create: `src/server/domain/delivery.ts`, `src/server/http/routes/delivery.ts`
- Modify: `src/server/email/templates.ts` (`gallery_ready`), `src/server/app.ts`, `src/web/admin/Project.tsx` (Publish button)
- Test: `tests/domain/delivery.test.ts`, `tests/http/delivery.test.ts`

**Interfaces:**
- `class DeliveryError extends Error { code: 'conflict' | 'invalid' | 'not_found' | 'unavailable' | 'no_finals' | 'disabled' | 'review' | 'unpaid' }`
- `publishFinals(db, storage, o: { projectId: string; photoIds: string[]; expectedVersion: number; actor: string; baseUrl: string }): Promise<{ published: number }>`. The guard ports M5's rules:
  - `conflict` when `stateVersion !== expectedVersion`.
  - `invalid` when any of these hold:
    - the project is archived or its booking is cancelled
    - `productionState` is not in `editing` or `delivered`
    - selection `deficit > 0` or `pending > 0`
    - any invoice has `needsReview`
    - a listed photo is not a final with `draftRelPath`
  - Steps, in order:
    1. Copy `draft`→`original`, `preview.draft`→`preview`, `medium.draft`→`medium`, `thumb.draft`→`thumb`.
    2. In the request transaction, set `live: true, draftRelPath: null, inLibrary: true`.
    3. Set each source RAW's `editState` to `'done'`.
    4. Set `productionState: 'delivered'` and bump `stateVersion`.
    5. Record event `finals_published` `{ photoIds }`.
    6. When `meta.notifyOnPublish`, queue a `gallery_ready` email to every Client email with key `gallery:<projectId>:<newStateVersion>:<email>`, URL `<baseUrl>/p/<id>/gallery`.
    7. Delete the `.draft` objects.
  - A retry after a failed commit is idempotent, because copying the same draft again yields the same live bytes. Add a `ponytail:` comment naming that window.
- `POST /api/projects/:id/publish` (admin) `{ photoIds, expectedVersion }` → 200 `{ published }`; 409 `conflict`; 422 other codes.
- `gallery_ready` template vars: `studio`, `project`, `url`.

- [ ] **Step 1: Write the failing tests**

```ts
it('a draft is invisible to the Client until published, then visible', async () => {});
it('publishing a replacement keeps the photo id and swaps the bytes the Client sees', async () => {});
it('a stale expectedVersion is 409 and changes nothing', async () => {});
it('pending picks or a deficit refuse publishing', async () => {});
it('the source RAW becomes done and the project delivered', async () => {});
it('notifyOnPublish queues one gallery_ready email per Client address', async () => {});
it('published finals count as Library photos', async () => { /* /api/library total rises by the published count */ });
```

- [ ] **Step 2: Run them and see them fail** — `npx vitest run tests/domain/delivery.test.ts tests/http/delivery.test.ts`
- [ ] **Step 3: Implement as specified.** The admin Project page lists drafts with a "Publish N" button sending the current `stateVersion`; on 409 it reloads.
- [ ] **Step 4: Run them and see them pass**
- [ ] **Step 5: Commit** — `feat(delivery): publish finals from R2`

---

### Task 8: Client gallery, favorites, downloads

**Files:**
- Modify: `src/server/domain/delivery.ts`, `src/server/http/routes/delivery.ts`, `src/server/worker.ts` and `src/server/index.ts` (handler), `src/web/router.ts`, `src/web/pages/ProjectHome.tsx` (link when delivered)
- Create: `src/web/pages/Gallery.tsx`
- Test: `tests/domain/delivery.test.ts`, `tests/http/delivery.test.ts`, `tests/e2e/gallery.spec.ts`

**Interfaces:**
- `downloadStatus(db, projectId): Promise<{ allowed: boolean; reason: 'unavailable' | 'no_finals' | 'disabled' | 'review' | 'unpaid' | null }>`. Reasons, in order:
  - `unavailable`: the project is archived or its booking is cancelled.
  - `no_finals`: there is no live final.
  - `disabled`: `meta.downloads === 'none'`.
  - `review`: an invoice has `needsReview`, or the selection `deficit > 0`.
  - `unpaid`: a non-voided invoice has `paidAmount - refundedAmount < amount + tax`.

  With zero invoices the project counts as settled. `downloads: 'password'` is treated as `'client'` until H2b.
- `liveSetHash(rows: { id: string; checksum: string }[]): string`: the sha256 of the sorted `id:checksum` lines.
- `requestDownload(db, storage, o: { projectId: string; photoId?: string; actor: string }): Promise<{ url: string } | { preparing: true }>`.
  - It throws a `DeliveryError` with the reason when downloads are not allowed.
  - For a single photo: `presignGet(original, 600, basename(relPath))`.
  - For all photos: if `exists(zipKey(...hash))`, return its presigned URL (`<project title>.zip`). Otherwise enqueue `build_zip` with `{ projectId, hash }` under idempotency key `zip:<projectId>:<hash>`, and return `{ preparing: true }`.
  - It records event `downloaded` `{ item }` when a URL is issued.
- `build_zip` handler (heavy):
  - It recomputes the live set and ends quietly if the hash changed.
  - It downloads the originals into a temp dir under unique names: `basename(relPath)`, with ` (2)` and so on for duplicates.
  - It runs `zip -q -0 -X`, then `put`s the result to `zipKey`.
- Routes:
  - `GET /api/projects/:id/favorites` → `{ counts: Record<photoId, number>, mine: string[] }` over live finals.
  - `POST /api/photos/:photoId/favorite` `{ favorite: boolean }` → client or admin, live finals only.
  - `POST /api/projects/:id/download` `{ photoId? }` → 200 `{ url }` / 202 `{ preparing: true }` / 403 `{ error: reason }`.
- Web `/p/:id/gallery`:
  - The grid uses `size=medium` images, and the existing `Viewer` uses `size=preview`.
  - A heart toggles the favorite; a "Favorites" filter is included.
  - "Download" in the viewer sets `location.href` to the URL. "Download all" polls every 3 s while `preparing`.
  - The sheet copy reads: "Single photos save to Photos; the ZIP goes to Files."

- [ ] **Step 1: Write the failing tests**

```ts
it('downloadStatus reasons in order', async () => { /* zero invoices → allowed; partial invoice → unpaid; needsReview → review; downloads none → disabled; archived → unavailable; no live → no_finals */ });
it('single download returns a 10-minute signed URL for the live original only', async () => {});
it('download all is preparing, then a ZIP of exactly the live finals', async () => {
  // 202 → drain → 200 url; storage bytes at zipKey list the live names via `unzip -l` on a temp file; a draft is absent
});
it('publishing another final makes a new ZIP, never the stale one', async () => {});
it('a Client of another project or Studio gets 404 on favorites and download', async () => {});
it('favorites count across sessions and list mine', async () => {});
```

Playwright `tests/e2e/gallery.spec.ts` (iPhone 13 viewport):
1. The owner publishes a draft.
2. The Client opens `/p/:id/gallery` and sees one photo.
3. The Client hearts it and filters favorites.
4. "Download all" eventually yields a link.

- [ ] **Step 2: Run them and see them fail** — `npx vitest run tests/domain/delivery.test.ts tests/http/delivery.test.ts`
- [ ] **Step 3: Implement as specified**
- [ ] **Step 4: Run them and see them pass**, plus `npm run test:e2e -- tests/e2e/gallery.spec.ts`
- [ ] **Step 5: Commit** — `feat(delivery): client gallery, favorites, downloads from R2`

---

### Task 9: 30-day culling cleanup

**Files:**
- Create: `src/server/domain/cleanup.ts`
- Modify: `src/server/index.ts` (daily), `src/server/http/routes/projects.ts` (hide purged culling photos from Clients)
- Test: `tests/domain/cleanup.test.ts`

**Interfaces:**
- `CULLING_RETENTION_DAYS = 30`.
- `sweepCullingPreviews(root: Db, storage: Storage, now: Date): Promise<{ purged: number }>`. It runs in a system transaction to find candidates, then works per Studio with `withStudio`.
  - A project is a candidate when it has a `finished_culling` event at least 30 days before `now`, its `productionState !== 'culling'` (no reopened round), and it still has culling photos with `purgedAt IS NULL`.
  - For those photos it deletes `original`, `preview`, `medium` and `thumb`, and sets `purgedAt`.
  - Rows, picks, comments and source links stay. The sweep is idempotent.
- `/api/projects/:id/photos?stage=culling` omits purged rows for non-admins; admins see them with `purged: true`.

- [ ] **Step 1: Write the failing tests**

```ts
it('29 days after finishing nothing is purged', async () => {});
it('30 days after finishing culling objects are deleted and rows kept with their picks', async () => {});
it('a reopened round is not purged', async () => {});
it('finals and Library photos are never touched', async () => {});
it('a second run purges nothing', async () => {});
```

- [ ] **Step 2: Run them and see them fail** — `npx vitest run tests/domain/cleanup.test.ts`
- [ ] **Step 3: Implement as specified**; the daily run reuses the hourly sweeper's timer, running once per UTC day.
- [ ] **Step 4: Run them and see them pass**
- [ ] **Step 5: Commit** — `feat(cleanup): purge culling previews 30 days after picking`

---

### Task 10: Library view

**Files:**
- Create: `src/web/admin/Library.tsx`
- Modify: `src/web/router.ts` (`admin_library` at `/admin/library`), `src/web/App.tsx`, `src/web/admin/Shell.tsx` (nav item "Library"), `src/web/admin/api.ts`
- Test: `tests/e2e/admin.spec.ts`

**Interfaces:**
- Consumes the Task 5 routes.
- The header shows "`N` photos".
- Drop zone plus file picker (`accept=".jpg,.jpeg,.png,.webp,.heic"`, multiple). Each file:
  1. `POST /uploads`
  2. `XMLHttpRequest` PUT to `uploadUrl`, so progress can be shown
  3. `POST /complete`
- Files over 50 MB or of another type are refused in the browser with the server's wording, before any request.
- The grid is newest first. It uses `size=thumb` images and shows "Processing…" placeholders. While any item is processing it polls `GET /api/library` every 2 s. Failed uploads show once with "Couldn't process this file".
- "Load more" uses `nextCursor`.

- [ ] **Step 1: Write the failing e2e test**: the owner opens `/admin/library`, uploads `tests/fixtures` JPEG via `setInputFiles`, sees the header read "1 photo" (singular for one), and the thumbnail loads (naturalWidth > 0).
- [ ] **Step 2: Run it and see it fail** — `npm run test:e2e -- tests/e2e/admin.spec.ts`
- [ ] **Step 3: Implement as specified**
- [ ] **Step 4: Run it and see it pass**, then the full suite: `npx vitest run && npx tsc --noEmit -p . && npx tsc -p tsconfig.web.json --noEmit`
- [ ] **Step 5: Commit** — `feat(web): Library view with uploads`

---

### Task 11: Deploy and gates

**Files:**
- Modify: `docs/deploy.md` (worker machine, Fly token, R2 CORS and lifecycle, gate queries)
- Create: `docs/gates/h2-library.md`

**Owner actions (they hold the credentials):**
1. `fly tokens create deploy -a opengallery` and store it with `fly secrets set -a opengallery --stage FLY_API_TOKEN=…` (or the clipboard script with a new `fly` mode if preferred).
2. Approve the agent running:
   - `npx wrangler r2 bucket cors set opengallery-media --file deploy/r2-cors.json`
   - `npx wrangler r2 bucket lifecycle add opengallery-media zips z/ --expire-days 7`

- [ ] **Step 1: Deploy** — `fly deploy -a opengallery`, then `fly status` shows one started `app` machine and one `worker` machine that stops within about a minute.
- [ ] **Step 2: Gate 1, upload-to-visible.** Upload a 20 MB JPEG in `/admin/library` on the deployed app, then run in Neon (`npx neon@latest psql`):

```sql
begin; set local role og_system;
select extract(epoch from (ready_at::timestamptz - created_at::timestamptz)) as seconds from photos where in_library order by created_at desc limit 1;
rollback;
```

Expected: `seconds < 60`. Record three runs, cold worker and warm worker, in `docs/gates/h2-library.md`.

- [ ] **Step 3: Gate 2, culling excluded.** Send 5 previews from Lightroom with the plugin to a test project. The Library header count does not change, and the culling grid shows 5. Record it.
- [ ] **Step 4: Run** `npm run check:tenancy` against Neon, which prints `ok`, and the full suite. Commit the gate record — `docs: H2 gates`.

---

## Deferred to H2b (follow-up milestone)

Share passwords and guest sessions, music and slideshow, sections, order and cover, gallery expiry and the reminder email, retiring a live final, and download codes for `downloads: 'password'`.
