# OpenGallery Milestone 4: Lightroom Classic Plugin — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A Lightroom Classic Publish Service that mirrors projects as publish collections, uploads finals as drafts keyed to their source RAW, pulls the client's submitted picks into Lightroom as flags and a collection, shows client comments in Lightroom's Comments panel with replies, and reports editing progress; plus the server side that makes that possible: plugin tokens with scopes, a `/api/plugin` surface, and an Access section in Settings.

**Architecture:** Server: plugin tokens are `sessions` rows of kind `plugin` authenticated by `Authorization: Bearer`, scoped `read` or `read+write` and optionally to one project; `/api/plugin/*` routes are thin wrappers over the existing domains (`admin.createProject`, `comments`, `selection`) plus a new `finals` domain (draft upload keyed by source photo, collision-safe naming, idempotent by upload id) and `progress`. Plugin: one pure Lua API module (`OGApi.lua`) with an injectable HTTP adapter, so it is tested outside Lightroom against the real server; `OGPublishProvider.lua` wires the SDK's export/publish hooks to it; two library menu items (Sync picks, Report progress). Every `.lua` file is syntax-checked by the SDK's `luac` in the test suite.

**Tech Stack:** As M3, plus Lua 5.1-compatible plugin code (Lightroom embeds Lua 5.1; the Homebrew `lua` 5.5 runs the module tests, so the code avoids 5.2+ features), the SDK's `luac` at `References/.../Lua Compiler/mac/luac`, `curl` for the test-only HTTP adapter.

**Spec:** `docs/superpowers/specs/2026-09-10-opengallery-design.md` §5 (plugin tokens), §9 (the plugin), §3 (draft staging, one copy), §18 gate *Publication* (the M4 part: renamed exports, identical basenames from different RAWs, several finals per RAW, replacement drafts), §21 milestone 4.

## Global Constraints

- M1–M3 constraints apply.
- **Plugin tokens:** created only by an admin in Settings → Access; the raw token is shown once; stored hashed in `sessions` (`kind='plugin'`, `scope` `read` or `read+write`, `projectId` null or one project, `nickname` = token name, `subject` = creating admin's email, 1-year expiry). Bearer requests are exempt from the `x-requested-with` CSRF rule (no cookie is involved) but never from access scoping.
- **Uploads land in `finals/.draft/`** (spec §3, §9). Names on collision: if a different source already owns `<name>`, use `<name> (2).<ext>` and so on; the same source re-uploading `<name>` replaces its own draft. The same `uploadId` with the same checksum is idempotent. A live final is never overwritten by an upload; deleting a live final from Lightroom is refused until publication exists (M5) with `409 live_until_published`.
- **Source linking:** `photos.source_photo_id` links a final to its culling RAW; progress `done` remains server-derived from a *live* linked final (M5), so M4 only ever writes `editing` / `none`.
- **Picks for the plugin** are submitted-round confirmed picks only, with the RAW's current project-relative path.
- **Comments to Lightroom:** every comment on a final or on its source RAW, with a position hint derived from the region centre (`top-left`, `top`, `top-right`, `left`, `centre`, `right`, `bottom-left`, `bottom`, `bottom-right`) or a timestamp for videos.
- Lua: 5.1-compatible (no `goto`, no integer division, `table.unpack or unpack`), no globals except SDK imports, every file passes `luac -p`.
- Commit after every task; gate commits on typecheck **and** tests.

## File structure

```
src/server/
  domain/tokens.ts             createPluginToken, listPluginTokens, revokePluginToken
  domain/finals.ts             uploadFinal, deleteFinal, pluginPicks, pluginComments (with hints), reportProgress, resolvePaths
  http/session.ts              bearer auth in sessionMiddleware
  http/access.ts               plugin kind in canAccessProject; requireScope('write')
  http/routes/plugin.ts        /api/plugin/*
  http/routes/settings.ts      + /api/access/tokens
  app.ts                       CSRF exemption for bearer; mount
src/web/admin/Settings.tsx     Access card (create/revoke tokens, copy once)
plugin/OpenGallery.lrplugin/
  Info.lua, json.lua, OGApi.lua, OGLrHttp.lua, OGPublishProvider.lua, OGSyncPicks.lua, OGProgress.lua, OGUtil.lua
tests/http/plugin.test.ts, tests/domain/finals.test.ts, tests/domain/tokens.test.ts
tests/plugin/luac.test.ts (syntax), tests/plugin/api.test.ts (Lua module vs live server), tests/plugin/curl_http.lua, tests/plugin/api_test.lua
docs/plugin.md, docs/plugin-testing.md, docs/gates/m4-plugin.md
package.json: "plugin:zip"; CI: upload the zip as an artifact
```

---

### Task 1: Plugin tokens, bearer auth, plugin access scoping

**Files:** `src/server/domain/tokens.ts`, `src/server/http/session.ts`, `src/server/http/access.ts`, `src/server/app.ts`, `tests/domain/tokens.test.ts`

**Interfaces:**
```ts
export function createPluginToken(db, o: { name: string; scope: 'read' | 'read+write'; projectId?: string | null; actor: string }): { id: string; token: string }   // token = 'ogp_' + 43 base64url chars
export function listPluginTokens(db): { id; name; scope; projectId; createdAt; expiresAt; lastUsedAt? }[]
export function revokePluginToken(db, o: { id: string; actor: string }): void
```
- `sessionMiddleware`: if no cookie and header `Authorization: Bearer ogp_…`, `sessionFromToken(db, token)`; sets `c.var.session` (kind plugin) and `sessionToken`.
- `canAccessProject`: `plugin` → `ok` when project is available, not transfer-pending, not archived, and (`s.projectId` null or equal). `requireScope('write')` → 403 `{ error: 'read_only' }` when scope lacks `write`.
- `app.ts` CSRF check: skip when `Authorization` header starts with `Bearer `.

Tests: create → token shape, hashed at rest, listed without the secret; bearer resolves a plugin session; scope read cannot write; project-scoped token cannot access another project; revoke → 401.

### Task 2: Finals domain — upload drafts keyed by source, resolve paths, picks, comments with hints, progress

**Files:** `src/server/domain/finals.ts`, `tests/domain/finals.test.ts`

**Interfaces:**
```ts
export class FinalsError extends Error { code: 'invalid' | 'not_found' | 'live_until_published' | 'unsupported' | 'too_large' }
export async function uploadFinal(db, photosDir, o: { projectId; name: string; bytes: Buffer; sourcePhotoId?: string | null; uploadId: string; checksum?: string; actor: string }): Promise<{ photoId: string; relPath: string; draftRelPath: string; replaced: boolean; idempotent: boolean }>
export async function deleteFinal(db, photosDir, o: { projectId; photoId; actor }): Promise<void>
export function resolvePaths(db, projectId, paths: string[]): Record<string, string | null>
export function pluginPicks(db, projectId): { round: number; submittedAt: string | null; picks: { photoId: string; relPath: string; round: number }[] }
export function pluginComments(db, projectId, since?: string): { id; photoId; relPath; sourcePhotoId: string | null; sourceRelPath: string | null; author; text; hint: string | null; createdAt; resolvedAt; stage }[]
export function reportProgress(db, o: { projectId; reports: { photoId: string; state: 'editing' | 'none' }[]; actor }): { updated: number; skipped: number }   // only culling photos in submitted picks; never touches 'done'
export const hintFor = (c: { x: number | null; y: number | null; w: number | null; h: number | null; t: number | null }) => string | null
```
- `uploadFinal`: validates name (basename, `.jpg`/`.jpeg`/`.png` only, sniffed as photo), size ≤ media limit; target live path `finals/<name>`; if a row exists for that live path with a *different* `sourcePhotoId` → pick the next free `<stem> (n).<ext>`; writes `finals/.draft/<name>` (mkdir), computes `quickHash`; idempotent when an existing row for the same source has the same checksum; upserts the photo row (`stage final`, `live` false for new rows, `draftRelPath`, `sourcePhotoId`, `checksum`); enqueues preview; event `final_uploaded` `{ photoId, uploadId, replaced }`.
- `deleteFinal`: draft-only row → remove file + row (+ its `.cache` renditions), event `final_removed`; `live` row → throw `live_until_published`.
- `pluginComments` joins comments → photos; for finals with `sourcePhotoId` also returns the source relPath; `hint` from region centre or `t`.

Tests: two RAW sources uploading the same basename → `f.jpg` and `f (2).jpg`; same source re-upload with new bytes → replaced draft, same row; same uploadId+checksum → idempotent; live final delete → 409; draft delete removes file; picks only submitted; comments carry hints; progress ignores non-submitted and `done`.

### Task 3: Plugin routes and Access API + Settings UI

**Files:** `src/server/http/routes/plugin.ts`, `src/server/http/routes/settings.ts` (tokens), `src/server/app.ts`, `src/web/admin/Settings.tsx` (Access card), `src/web/admin/api.ts`, `tests/http/plugin.test.ts`

Routes (all `requireKind('plugin')`; mutations also `requireScope('write')`):
- `GET /api/plugin/me` → `{ name, scope, projectId, studio, version }`
- `GET /api/plugin/projects` → `[{ id, title, folderPath, client, state, folders }]` (respecting a project-scoped token)
- `GET /api/plugin/clients` → `[{ id, name }]`; `POST /api/plugin/projects { clientId, title }` → created summary
- `POST /api/plugin/projects/:id/resolve { paths }` → `{ paths: { [rel]: photoId | null } }`
- `POST /api/plugin/projects/:id/finals` multipart `file`, fields `name`, `sourcePhotoId?`, `uploadId`, `checksum?` → 201 upload result (200 when idempotent)
- `DELETE /api/plugin/finals/:photoId` → `{ ok }` or 409
- `GET /api/plugin/projects/:id/picks`, `GET /api/plugin/projects/:id/comments?since=`, `POST /api/plugin/photos/:photoId/comments { text }`, `POST /api/plugin/projects/:id/progress { reports }`
Admin: `GET /api/access/tokens`, `POST /api/access/tokens { name, scope, projectId? }` → `{ id, token }`, `DELETE /api/access/tokens/:id`. Settings → Access card: list, create (shows the token once with a copy button and the install hint), revoke.

Test: full flow over HTTP with a bearer token: me, projects, resolve, upload two finals from two sources with the same name, re-upload, picks after a client finishes, comments with hints, reply, progress, delete draft, delete live → 409, read-only token → 403 on upload, project-scoped token → 404 on another project.

### Task 4: The plugin — pure API module, JSON, HTTP adapter, syntax gate, module test against the live server

**Files:** `plugin/OpenGallery.lrplugin/json.lua`, `OGApi.lua`, `OGLrHttp.lua`, `OGUtil.lua`, `tests/plugin/curl_http.lua`, `tests/plugin/api_test.lua`, `tests/plugin/api.test.ts`, `tests/plugin/luac.test.ts`

- `json.lua`: encode/decode for objects, arrays, strings (with escapes and `\uXXXX`), numbers, booleans, null (→ `json.null` sentinel), 5.1-compatible.
- `OGApi.lua`: `OGApi.new{ baseUrl, token, http }` where `http.get(url, headers) → body, status`, `http.post(url, body, headers) → body, status`, `http.postMultipart(url, chunks, headers) → body, status`, `http.delete(url, headers)`; methods return `result` or `nil, err`. `OGApi.hintPosition` is server-side; the module only passes text through.
- `OGLrHttp.lua`: the Lightroom adapter over `LrHttp.get/post/postMultipart` (delete via `LrHttp.post(url, '', headers, 'DELETE')`), headers as `{ { field = 'Authorization', value = … } }`.
- `tests/plugin/curl_http.lua`: test-only adapter using `io.popen('curl …')` with `-w '\n%{http_code}'`.
- `tests/plugin/api_test.lua`: takes `baseUrl token fixtureJpeg` args and walks: me → projects → resolve → upload (two sources, same name) → picks → comments → addComment → progress → delete; asserts with plain `assert`, prints `OK`.
- `tests/plugin/api.test.ts`: starts the e2e harness (client finishes a round via the API first so picks exist), creates a plugin token through the admin API, runs `lua tests/plugin/api_test.lua …` with `execFile`, expects exit 0 and `OK`. Skips when `lua` is not on PATH (CI installs it with `apt-get install lua5.4`).
- `tests/plugin/luac.test.ts`: runs the SDK's `luac -p` (path from `LRC_SDK_DIR` env, default `References/LrC_15.3_202604090947-8f3672ed.release_SDK/Lua Compiler/mac/luac`) over every `plugin/**/*.lua`; skips when the compiler is absent (CI) and additionally runs `luac -p` from the Homebrew Lua when present.

### Task 5: The plugin — publish provider, sync picks, progress, Info.lua

**Files:** `plugin/OpenGallery.lrplugin/Info.lua`, `OGPublishProvider.lua`, `OGSyncPicks.lua`, `OGProgress.lua`, `docs/plugin.md`, `docs/plugin-testing.md`, `package.json` (`plugin:zip`), `.github/workflows/ci.yml` (lua + artifact)

- `Info.lua`: `LrSdkVersion = 6.0`, `LrSdkMinimumVersion = 6.0`, `LrToolkitIdentifier = 'app.opengallery.lightroom'`, `LrPluginName = 'OpenGallery'`, `LrExportServiceProvider = { title = 'OpenGallery', file = 'OGPublishProvider.lua' }`, `LrLibraryMenuItems = { { title = 'OpenGallery: Sync picks', file = 'OGSyncPicks.lua' }, { title = 'OpenGallery: Report editing progress', file = 'OGProgress.lua' } }`, `VERSION`.
- `OGPublishProvider.lua`:
  - `exportServiceProvider.supportsIncrementalPublish = 'only'`, `allowFileFormats = { 'JPEG' }`, `allowColorSpaces = { 'sRGB' }`, `hideSections = { 'exportLocation', 'video' }`, `canExportVideo = false`, `exportPresetFields = { serverUrl, token, mountPath, quality }`.
  - `sectionsForTopOfDialog`: Server URL, Token (password field), NAS mount path (with a Browse button), and "Verify connection" (calls `me`, shows studio name).
  - `getCollectionBehaviorInfo`: `{ defaultCollectionName = 'Finals', defaultCollectionCanBeDeleted = true, canAddCollection = true, maxCollectionSetDepth = 0 }`.
  - `viewForCollectionSettings` / `endDialogForCollectionSettings`: a popup of projects fetched from the server (title · client), "New project…" (client popup + title), and a Stage switch (Finals only in M4; Culling shown disabled "milestone 4 note"). Stores `projectId`, `projectTitle`, `folderPath` in the collection settings; `exportSession:recordRemoteCollectionId(projectId)` on first publish.
  - `processRenderedPhotos`: for each rendition: the catalog photo's source id from `photo:getPropertyForPlugin(_PLUGIN, 'ogSourceId')`, else resolve by path (`photo:getRawMetadata('path')` under `mountPath` → project-relative path → `resolve`), store it; `rendition:waitForRender()`; `uploadFinal` with `name = leafName(renderedPath)`, `uploadId = photo uuid .. ':' .. os.time()`; `rendition:recordPublishedPhotoId(result.photoId)`; progress scope per photo; on error, `rendition:uploadFailed(msg)`.
  - `deletePhotosFromPublishedCollection`: `deleteFinal` per remote id; a `live_until_published` refusal is reported and the photo is left published.
  - `canAddCommentsToService = true`; `getCommentsFromPublishedCollection`: one `comments` call per collection, grouped by final `photoId`, mapped to `{ commentId, commentText = (hint and hint .. ': ' or '') .. text, dateCreated, username = author }`; `addCommentToPublishedPhoto` → `addComment`.
  - `metadataThatTriggersRepublish`: `{ default = false, title = true, caption = true, keywords = false, gps = false }` (edits are tracked by Lightroom's own develop-change detection).
- `OGSyncPicks.lua` (LrTasks.startAsyncTask): loads settings from the first OpenGallery publish service (`catalog:getPublishServices(_PLUGIN.id)`), for each collection with a `projectId`: `picks` → for each `relPath` → `catalog:findPhotoByPath(mountPath/folderPath/relPath)` → in one `catalog:withWriteAccessDo`: set `pickStatus = 1`, add to a regular collection `<title> – Picks` (created under a set "OpenGallery" if absent), store `ogSourceId`; previously flagged photos not in the new list (tracked in `catalog:getPropertyForPlugin(_PLUGIN, 'flagged:'..projectId)`) have their flag cleared only if still `1`. Summary dialog with counts and unresolved paths.
- `OGProgress.lua`: for each synced project, compare each pick photo's `lastEditTime` with the stored `submittedAt`; report `editing` for edited ones, `none` otherwise; dialog with counts. (Automatic 5-minute reporting is a later refinement; a menu item is the M4 deliverable.)
- Docs: `docs/plugin.md` (install via Plug-in Manager, token, NAS mount path, publish workflow, Sync picks, comments) and `docs/plugin-testing.md` (the manual checklist for the in-app spike).
- `npm run plugin:zip` → `dist/OpenGallery.lrplugin.zip`; CI: `apt-get install lua5.4`, run tests, `actions/upload-artifact` for the zip.

### Task 6: In-app spike and gate

- Install the plugin from the repo path in Lightroom Classic 15.5.1 via the Plug-in Manager; create the publish service against `npm run demo`'s server with a token from Settings → Access; publish two JPEGs from a small catalog whose RAWs live under the demo photos dir; run Sync picks after the demo client finishes a round; check the Comments panel. Record every step and result in `docs/gates/m4-plugin.md` — including anything that could not be exercised.

## Self-review notes

- Spec §9 coverage: publish service shape (T5), collections mirror projects with stored ids (T5), initial path lookup then stored ids (T5, `ogSourceId`), whole-file uploads with checksums to `.draft/` with collision naming and source linking (T2/T3), sort order → gallery order (`imposeSortOrderOnPublishedCollection` deferred to M5 with publication), Publish-to-client menu item (M5), sync picks idempotent with plugin-owned flags (T5), comments in the Comments panel with hints and replies (T2/T5), editing progress reports keyed by source (T2/T5; automatic timer deferred), failures via Lightroom's standard error path (T5), XMP setting warning (T5 dialog text), zipped `.lrplugin` (T5).
- Deferred and recorded: culling-rendition uploads, retirement of live finals, automatic progress timer, release asset on tags (M11).
