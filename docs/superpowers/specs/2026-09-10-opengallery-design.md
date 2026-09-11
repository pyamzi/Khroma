# OpenGallery — Design Spec

**Date:** 2026-09-10
**Status:** Draft for review
**Scope:** Core product (v1). Deferred items are listed at the end and get their own specs.
**Revision 2 (2026-09-10):** merges the audit pass. Stable identity, guarded state, webhook dedup, reservations, shared selection, and draft/live publication are kept. Ledger, revision store, chunked uploads, and durable-operation protocol are replaced by smaller mechanisms that keep the same guarantees. Build order re-sequenced so a client-visible product exists early.

## 1. What this is

A self-hosted replacement for Pixieset that runs on a UGREEN NAS. One photographer studio, many team members, many clients. It covers the full client lifecycle: inquiry, discovery call, proposal, contract, deposit, shoot, client culling of RAW previews, editing progress, final gallery, payment-gated downloads, offers, and email marketing.

The organizing idea: **the NAS folder tree is the app's content interface.** Photos, legal documents, forms, packages, and music are plain files in a structure the app understands. SQLite owns the facts files cannot safely coordinate: identity, workflow state, selections, invoices, reservations, sessions, jobs. JSON files carry human-editable metadata plus read-only projections of those facts. Photographers work in Lightroom Classic against RAWs on the NAS share; clients use an iOS-first web app. The admin side feels like Google Drive with a project overlay.

Design language everywhere: Apple Human Interface Guidelines. One clear thing per screen, direct manipulation, system fades behind the photos.

### Non-goals (v1)
- Multi-tenant SaaS. One install, one studio, one currency.
- Watermarking, likes counters, social buttons, per-gallery themes, custom domains per gallery.
- In-app photo or video editing, presets.
- Task-level Kanban (sub-tasks, checklists, due dates per task).
- Native App Store app (designed for, not built).
- A general ledger. Stripe is the ledger; the app tracks invoices and receipts.

## 2. Architecture and deployment

One Docker Compose stack on the NAS, exposed through a Cloudflare Tunnel on the studio's domain.

| Service | Role | Image |
|---|---|---|
| `opengallery` | The app: API, web UI, folder watcher, background jobs, MCP endpoint | built here |
| `listmonk` + `postgres` | Optional: email lists, campaigns, transactional templates | stock |
| `docuseal` | Optional: contracts and signatures | stock |
| `cloudflared` | Sole public ingress; the app still needs outbound access to SMTP and configured providers | stock |

**App stack:** Node 22 + TypeScript. Hono for HTTP. React + Tailwind front end served by the same process (Vite build). SQLite via Drizzle, WAL mode, foreign keys on, one file on the data volume. `sharp` for image work, `exiftool` for embedded RAW previews, `ffmpeg` for video and audio, `yt-dlp` for YouTube extraction. Background jobs run in-process on a SQLite-backed queue; no Redis.

**Routes via tunnel:** `gallery.<domain>` → app, `mail.<domain>` → listmonk, `sign.<domain>` → DocuSeal. listmonk and DocuSeal keep their own admin UIs; the app links to them. No SSO in v1.

**Volumes:** `/data` (SQLite, jobs, settings) and `/photos` (the folder tree, also exported over SMB to photographers). SQLite lives on local NAS storage, never an SMB mount. Backups must capture `/data` (including the WAL), `/photos`, and the data directories of any enabled optional service in one quiesced snapshot or a database-native backup, and a restore must be rehearsed. Reindexing `/photos` alone does not restore picks, invoices, or publication state.

**Minimum install:** app + tunnel + a working transactional email transport (direct SMTP with bundled templates, or listmonk). listmonk marketing, DocuSeal, and Stripe are optional and their features hide until configured (section 11).

**Photographer machines:** mount the `/photos` share over SMB. Lightroom Classic catalogs live locally on each machine and reference RAWs on the share. XMP sidecars carry edits between catalogs. The plugin (section 9) is installed in each catalog.

## 3. Storage layout

```
/photos/
  Clients/                          structured; the app owns this shape
    <Client Name>/                  client.json
      <Project Name>/               project.json
        raw/                        RAWs (+ .xmp), videos for culling
        finals/                     live JPEGs + videos the client sees
          .draft/                   pending replacements/additions, not yet published
          <Section>/                optional: subfolders become gallery sections
        documents/                  contracts, invoices, form submissions
        .cache/                     app-generated previews; disposable
        <anything else>             plain files, shareable with client by toggle
  Templates/                        structured
    Forms/*.json
    Packages/*.json
    Offers/*.json
    availability.json
  Music/                            structured
    Library/                        tracks dropped in by hand
    YouTube/                        tracks extracted from YouTube
  .trash/                           deleted and retired items, emptied after 30 days
  <anything else>/                  freeform, browser-visible, never indexed
```

**One copy of every photo.** RAWs exist once in `raw/`. Finals exist once in `finals/`, plus at most one pending draft per file in `finals/.draft/`. Publishing renames the draft over the live file and moves the old live file to `.trash/`. There is no revision store.

### Identity
- A folder is a client because it contains `client.json`; a project because it contains `project.json`. Clients are direct children of `Clients/`; projects are direct children of clients. Folders at the wrong depth are flagged in the Files browser and not served.
- Both files carry `schemaVersion` and an immutable UUID `id`. The UI allocates IDs. A hand-dropped file without an `id` gets one assigned on first index and is written back; only machine-owned fields (section 3, Ownership) require an explicit admin action to take effect.
- **Paths are locations, not identities.** On startup and on every full rescan the app matches folders by ID before deciding anything was removed, so moves and renames made while the app was stopped are recognised. Same-client renames and moves keep IDs, picks, comments, and events. A folder whose ID is missing is marked *unavailable* and its project stops being served; nothing is cascaded away. Trash keeps IDs and records for 30 days; purge keeps invoice and audit rows as tombstones.
- **Cross-client moves** require an admin confirmation in the Files browser because they change who can see the project. A cross-client move detected on disk marks the project unavailable to clients until an admin approves it.
- **Duplicate IDs** (a copied folder) quarantine both locations until an admin picks the original; the copy is adopted with new IDs and no picks, invoices, or reservations. The app never merges by title, path, or content.
- **Photos** are database rows with their own ID and a project-relative path (`raw/DSC_0412.NEF`). A rename or move done through the app keeps the row. A rename detected on disk shows as one missing and one new file until an admin remaps it; the app never guesses identity from basenames. The UI warns that renaming RAWs also breaks Lightroom's own path references.

### Ownership of `project.json` fields
- **Human fields** (title, date, notes, assignee, folders, download rule, comment toggles, music, cover, expiry, offers, notifyOnPublish) are editable in the UI or any text editor. Conflicting edits are field-level last-write-wins.
- **Machine fields** (`id`, `state`, `allowance`, `sharePassword`, integration IDs, `stateVersion`) are projections of SQLite. An external edit to a machine field shows a banner and is overwritten from the database; it is never replayed as a command. So editing `allowance.purchased` in Finder cannot grant photos.
- The app writes JSON through a same-directory temp file and atomic rename. Media and PDFs are written fully, checksummed, then renamed into place before the database references them; an orphaned temp file is cleaned up, never treated as a publication or a payment.

### Watcher
chokidar over `Clients/`, `Templates/`, `Music/`. Waits for files to stop changing, validates signatures and size, then queues idempotent ingestion keyed by path and checksum. Files the app wrote itself (matched by checksum) are a no-op. New files in `finals/` land as unlinked drafts (moved into `.draft/`) until published. An external overwrite of a live file becomes live immediately, because there is no second copy to restore; it is logged as a `replaced_externally` event and shown to the admin. To stage a replacement without changing what the client sees, drop it into `.draft/`. Malformed or unsupported JSON keeps the last good state with a file-specific banner.

### Write policy
All paths resolve server-side beneath their allowed root; traversal and symlink escapes are rejected. Originals are never executable or served as HTML. Whole-file uploads with a checksum and retry; no chunking in v1. Limits are studio-configurable with these defaults:

| Actor | Where | What |
|---|---|---|
| Admin Files browser | any non-reserved path under `/photos` | create, move, rename, trash, upload any type; attachments to 2 GB, media to 20 GB; unrecognised types are download-only |
| Client (assigned form only) | that project's `documents/<submission-id>/` | JPEG, PNG, PDF; 20 MB per file, 10 files; server-named |
| Plugin (project-scoped token) | `finals/.draft/` and culling renditions of the resolved project | JPEG to 100 MB, batches of 20; server-named on collision |
| Settings and template editors | `Templates/`, `Music/Library/` | schema-valid JSON to 1 MB; MP3, M4A, WAV to 200 MB |
| Background jobs and verified webhooks | `documents/`, `.cache/`, `Music/YouTube/` | validated PDFs, previews, extracted MP3 |

SMB-discovered media goes through the same signature and size validation as uploads. Reserved directories (`.draft/`, `.cache/`, `.trash/`) and the two JSON files cannot be written through general upload. Freeform folders are browsable but not shareable with clients until moved into a project.

### `client.json`
```json
{ "schemaVersion": 1, "id": "01993840-0000-7000-8000-000000000001", "stateVersion": 1,
  "name": "Smith Family", "emails": ["sarah@example.com", "tom@example.com"], "phone": "",
  "stripeCustomerId": null, "listmonkSubscriberId": null, "referralCode": "SARAH100", "notes": "" }
```

### `project.json`
```json
{
  "schemaVersion": 1,
  "id": "01993840-0000-7000-8000-000000000002",
  "stateVersion": 7,
  "title": "Wedding 2026",
  "state": { "booking": "booked", "production": "culling", "archivedAt": null },
  "date": "2026-06-14",
  "package": "wedding-full-day",
  "assignedTo": "sam@studio.example",
  "folders": { "culling": "raw", "finals": "finals" },
  "allowance": { "included": 40, "extraPrice": 1500, "slots": 43 },
  "downloads": "client",
  "comments": { "culling": true, "finals": true },
  "notifyOnPublish": false,
  "sharePassword": "…",
  "music": "Library/first-dance.mp3",
  "cover": "finals/DSC_0999.jpg",
  "expiresAt": "2027-06-14",
  "offers": { "anniversary-15": true, "prints-16x20": true },
  "portfolioRelease": false,
  "showOffers": true,
  "integrations": { "docusealSubmissionId": null }
}
```
Prices are integer cents in the studio currency. `downloads` is `client`, `password`, or `none`. `allowance.slots` is the projected total entitlement (`included` + purchased + gifted) and is machine-owned. Invoices are not in the file; they live in SQLite (section 4). Contract and payment status are derived badges, not stored state (section 10).

## 4. Data model (SQLite)

Thirteen tables. Provider IDs are stored; provider data is not, beyond the amounts needed to show what is owed.

| Table | Purpose | Key columns |
|---|---|---|
| `users` | Admin team | email, name, role (`owner`/`member`), notify_downloads (`off`/`digest`/`each`) |
| `clients` | Identity + projection of `client.json` | id, folder_path, available, state_version, name, emails (JSON), stripe_customer_id, listmonk_subscriber_id, referral_code |
| `projects` | Identity + state + projection | id, client_id, folder_path, available, state_version, booking_state, production_state, archived_at, date, current_round, metadata_json |
| `photos` | Logical media | id, project_id, rel_path, draft_rel_path (nullable), stage (`culling`/`final`), kind (`photo`/`video`), source_photo_id (nullable, final → RAW), checksum, width, height, captured_at, sort_order, section, edit_state (`none`/`editing`/`done`) |
| `picks` | One shared selection per project | project_id, photo_id, round, by_email, picked_at, state (`confirmed`/`pending`); unique (project_id, photo_id) |
| `slot_grants` | Append-only entitlement changes | project_id, delta, reason (`purchase`/`gift`/`refund`/`release`), reference (unique per provider transaction), actor, at |
| `favorites` | Guest hearts on finals | photo_id, session_id |
| `comments` | Region/timestamp comments | photo_id, author, stage, x, y, w, h (nullable 0–1), t (video seconds, nullable), text, created_at, resolved_at |
| `sessions` | Magic links, guests, tokens | kind (`client`/`admin`/`guest`/`plugin`/`mcp`), token_hash, subject, project_id, scope, expires_at, nickname |
| `invoices` | Every amount owed or charged | id, project_id, kind (`deposit`/`balance`/`final`/`extras`/`package`/`adjustment`), amount, tax, currency, stripe_id (invoice or checkout session), paid_amount, paid_at, paid_via (`stripe`/`manual`), refunded_amount, needs_review, voided_at |
| `reservations` | Call and shoot capacity | project_id, kind (`call`/`shoot`), admin_id (calls), starts_at, ends_at, local_date, state (`held`/`confirmed`/`expired`/`cancelled`), expires_at |
| `webhook_inbox` | Verified deliveries, deduplicated | provider, event_id (unique per provider), object_id, payload, state (`received`/`applied`), received_at |
| `jobs` | Background work and provider calls | id, kind, payload, idempotency_key (unique), attempts, next_at, state, last_error |
| `events` | Append-only activity log | project_id, actor, type, payload (JSON), at |

**Derived, never stored:** entitlement = `included` + Σ`slot_grants.delta`; paid status per invoice from `paid_amount` vs `amount`; project payment badge from its invoices; contract badge from the DocuSeal submission state or a manual attestation event.

**Rules the schema enforces:** one open selection round per project (`current_round` + picks in that round); one unpaid `extras` invoice per project (partial unique index); unique provider transaction references in `slot_grants` and `webhook_inbox`; unique job idempotency keys. `events`, `slot_grants`, and `webhook_inbox` are append-only. The `finished_culling` event's payload holds the frozen list of photo IDs for that round; that is the round snapshot.

**Commit, then call.** Any command that touches a provider first commits its local change and a job row in one transaction, then the job worker calls the provider using the job ID as the idempotency key and stores the returned ID. A job that fails after the provider may have succeeded is retried with the same key; if the provider cannot confirm either way, the job is marked `needs_review` and shown in Settings → Jobs rather than retried blindly. Emails are jobs too, with a stable Message-ID; delivery is at-least-once.

**Webhooks:** verify signature, insert into `webhook_inbox` (duplicate event IDs are dropped), acknowledge, then apply in one transaction that updates the invoice or grant, runs the guarded transition, writes the event, and marks the inbox row applied. Two different event IDs for one payment are still deduplicated by the transaction reference on the grant or invoice. Stale or out-of-order events trigger a fetch of the provider's current object.

**Nightly reconcile** lists open invoices and unapplied jobs, asks each configured provider for current state, and either applies the difference or opens a review item. Startup re-queues jobs whose worker died mid-run.

Migrations are versioned and run at startup.

## 5. Auth and access

- **Bootstrap:** the operator runs a local setup command that prints a single-use token; the setup page takes it, creates the first owner, configures SMTP or listmonk, and sends and redeems a test magic link before anything else is enabled. There is no login path without email; recovery is the same local command.
- **Clients** sign in by magic link (single-use, 30-day validity, hashed). A client sees projects whose `client.json` lists their email and whose project is available and not archived.
- **Admins** sign in by magic link (15-minute validity). Roles: `owner` (everything) and `member` (everything except billing settings, integration keys, team management).
- **Guests** open a share link and enter the gallery password. They get a project-scoped guest session and may enter a nickname. Guests view and favorite; they cannot comment. Guest downloads follow section 10.
- **Cookies:** `httpOnly`, `secure`, `sameSite=lax`. CSRF token on every state-changing route. Rate limits per IP and per email on sign-in, per session on downloads.
- **Access middleware:** every photo, pick, comment, favorite, and file route resolves the resource's project server-side and checks the session is entitled to it. Clients may name a project ID but ownership is never trusted from the request. Unavailable, transfer-pending, cancelled, or archived projects are never served to clients or guests. One scoping function; routes cannot bypass it.
- **Downloads:** per-request signed URLs, 10-minute expiry, bound to the requesting session, re-checked against entitlement at fetch time. Zips stream, never touch disk. Every download is an event.
- **Plugin** and **MCP tokens** are created in Settings → Access, hashed, scoped (`read` or `read+write`, plugin tokens also project-scoped), revocable.

## 6. Client portal (iOS-first PWA)

Mobile-first, installable as a standalone PWA with the studio icon. Built to HIG: system font, Dynamic Type, 44pt targets, large titles, bottom sheets, safe-area insets, swipe-back, pull to refresh, light/dark from system. All screens use the same REST API the MCP uses, so a Capacitor or SwiftUI app later needs no backend changes.

**Sign in.** Email → magic link → in. One project lands directly; several show a list.

**Project home.** Title, date, one status line that says what to do now:
- `Pick your favorites · 23 of 40` + Continue
- `We're editing · 23 of 40 done` + progress bar
- `Your gallery is ready` + grid
Secondary row: Documents (shared files, contracts, invoices, forms to fill), Share, Referral code, Help.

**Culling grid.** Edge-to-edge thumbnails (embedded RAW previews), three across, pinch to change density. Tap opens the viewer; swipe for next; heart to pick. Filter: All / Picked. Sort: capture time. Bottom bar: `23 of 40`; above entitlement it becomes the extras bar: `1 extra photo · $15 · Checkout`.

**Shared selection.** All client emails on a project share one selection; a photo counts once. Entitlement is `included` + net slot grants. After every pick, unpick, grant, or reversal the app recomputes which picks are `confirmed` and which are `pending` in one transaction: picks from submitted rounds first, then current picks by `picked_at`. Every write carries the project's `stateVersion`; a stale write gets a conflict and the grid refreshes rather than overwriting another person's change.

**Extras.** Checkout creates an `extras` invoice for the current pending count at the current price and opens Stripe Checkout. Only one unpaid extras invoice exists per project; a second tap reuses it. Picks may change while paying, the invoice does not: verified payment grants exactly that many slots (one `slot_grants` row keyed by the Stripe transaction), then picks are recomputed. Surplus slots stay with the project. To change quantity the client cancels the checkout (the invoice is voided) and starts again. Without Stripe, the bar reads "Request N extra photos" and the admin grants or invoices manually.

**Gifts and refunds.** An admin gift is a `slot_grants` row with reason `gift`. A refund of unused slots is a negative grant plus a Stripe refund job. A refund or dispute that removes slots already used makes the excess current picks `pending` again, pauses Finish, publication, and downloads, and opens a billing review item; delivered files and submitted snapshots are untouched.

**Finish culling.** The allowance is a maximum, not a quota. Finish needs an open round with at least one pick, no pending picks, no unpaid extras invoice, and no billing review. The sheet shows the real count ("Send 25 picks?"). Submission freezes the round's photo IDs into the `finished_culling` event, locks those picks, increments `current_round`, and notifies the assigned admin. With zero usable photos the client sees an action-required message and the admin can cancel the round.

**Viewer.** Photo on black. Heart bottom-right; pin count bottom-left when comments are on for that stage. Drag on the image (long-press to start on touch) draws a region; a text field anchors to it. Pins are numbered dots. Videos show a poster and play inline; comments on videos carry a timestamp instead of a region. Swipe down closes.

**Editing progress.** Bar from `photos.edit_state` over the submitted round's IDs. `done` requires a live final whose `source_photo_id` is that RAW; a final never marks a RAW done by filename inference. A slot deficit, if any, is shown separately. Optional per-photo badge (project setting).

**Final gallery.** Same grid, sections from `finals/` subfolders, cover at top, `sort_order`. Only live files are served, including cover, thumbnails, slideshow, and downloads; a draft never changes what the client sees. Top bar: Download (single / all, per rule); **Unlock downloads** when an invoice is outstanding (opens the Stripe Hosted Invoice Page, or shows manual-payment instructions in local billing); a review notice when payment state needs review. `downloads: none` shows no unlock. Share uses the native share sheet with link + password. Slideshow: Play button on the cover starts the project's track and a crossfade slideshow of stills only.

**Guests.** Password screen over a blurred cover with studio name and "Book your own session." Favorites filter shows hearts from all guests. Guest download unlock uses the download code (section 10).

**Offers.** Cards in the gallery's visual language, never during culling, never on the password screen, never over a photo, no motion or timers. Placements: unlock card (opens an **additional round** over un-picked photos using remaining slots and the extras flow), inline card at most one per 30 photos (dismissable per session), end card (one, not dismissable). Additional rounds exclude previously submitted photos, never touch earlier snapshots, and never regress `delivered`. Only signed-in clients can open them. Per-project on/off per offer and a global `showOffers` switch.

**Forms.** An assigned form appears under Documents with a "Fill in" badge; fields render as native controls; submission writes PDF + JSON + attachments to `documents/<submission-id>/`.

**Expiry.** `expiresAt` archives the gallery (admin-visible only). Reminder email 7 days before.

**Known iOS limit:** zip downloads land in Files; single photo saves to Photos. The sheet says so.

## 7. Admin

Three-pane layout (sidebar, list, detail) on desktop; tab bar + push navigation on phone.

**Sidebar:** Dashboard, Files, Clients, Calendar, Settings.

**Dashboard.** Four blocks, nothing else: Money (outstanding invoices, overdue in red, resend), Waiting on client (unsigned, culling idle, unpaid, with age), Waiting on you (culling finished, unresolved comments, drafts not published, inquiries not proposed, review items), Upcoming (shoots and calls by date).

**Files.** Drive-style browser of `/photos`. Create folder, upload, drag to move, rename, delete to `.trash/`, under section 3's identity and write rules; an unsupported move explains what is needed (for example, confirm a cross-client transfer). Client and project folders carry badges and a derived status pill. **List / Board** toggle: Board columns are the derived pipeline (section 10); dragging a card runs the matching guarded command and fails visibly if the guard is not met. Filters: mine / everyone / archived. Search covers client names, project names, photo filenames.

**Project detail.** Header: title, client, date, status pill with contract and payment badges, context-aware action bar (only actions valid now; the rest under "…"). Segments:
- **Photos:** current stage grid with pick/comment badges; pending extras dashed; drafts marked; drag to reorder finals; set cover; open viewer with reply/resolve controls. **Publish to client** promotes selected drafts to live in one transaction and queues one ready/added email. Manual SMB finals and plugin finals follow the same rule.
- **Activity:** events timeline; unresolved comments and review items pinned to top.
- **Insights:** views, unique visitors, favorites, downloads, activity by day, per-visitor list, per-offer taps and conversions, inquiries sourced from this gallery.
- **Details:** human fields of `project.json` as a form; machine fields read-only with explicit actions beside them (grant slots, change price, transitions, reservations). Reducing `included` below the submitted count opens the deficit workflow rather than silently invalidating picks. Files in the project folder with the **Share with client** toggle.

**Clients.** List; detail shows projects, contact info, open invoices, listmonk lists, referral credits.

**Calendar.** Month view of shoots, discovery calls, and tentative holds (hollow dots). Edit availability inline. ICS feed URL per admin.

**Settings (one page, grouped):** Studio (name, logo, sender, timezone, currency, defaults for allowance, prices, installment split, balance-due days, hold hours); Team (members, invites, per-member download notifications); Email (SMTP or listmonk transport, delivery test, transport health); Integrations (Stripe, DocuSeal, listmonk marketing, later Printful; features hide when unset, existing invoices stay visible); Templates (bundled email templates or listmonk equivalents); Forms builder; Packages; Offers; Music (library + YouTube field); Access (MCP tokens, plugin tokens, calendar feed); Jobs (pending, failed, needs-review, with retry).

**Download notifications.** Per admin: Off / Daily digest (9am, grouped by project) / Every download. First download of a project always notifies.

## 8. Templates, forms, packages, offers, calendar, music

**Forms** (`Templates/Forms/*.json`): builder with fields short text, long text, single choice, multiple choice, date, yes/no, file. Reorder, required flag. Attached to packages (sent after booking) or sent ad hoc. Each submission gets its own folder under `documents/`, so repeats never overwrite.

**Packages** (`Templates/Packages/*.json`): name, price, included picks, extra price, installment override, duration, attached forms, contract policy (`required` with a DocuSeal template ID, or `not_required`), public page on/off. **A package with a required contract always uses the proposal → contract → installments flow** (section 10). Only `not_required` packages, such as mini-sessions, may sell directly from their public page: the date picker reserves capacity, Stripe Checkout charges the full price and tax as one `package` invoice, and verified payment with a valid reservation confirms the booking and sends forms once. Without Stripe, public pages create inquiries.

**Offers** (`Templates/Offers/*.json`): title, one line, image, button label, action (`unlock` / `prints` / `link` / `stripe_price`), placement (`unlock` / `inline` / `end`), default on/off.

**Availability** (`Templates/availability.json`): studio IANA timezone, working days, blackout dates, shoots per local date, call hours and slot length. The file describes capacity; `reservations` owns what is held or confirmed.

**Reservations.** Creating a hold runs in one serialized SQLite transaction: expire elapsed holds, check availability and capacity, insert the reservation. Shoots consume one unit of that local date's capacity; calls reserve non-overlapping intervals per admin, and an admin's shoots block their call times. Store the UTC instant plus local date and timezone; reject nonexistent DST times and require an explicit offset for ambiguous ones. Public Checkout holds last 30 minutes; deposit holds last `holdHours` (default 72). Verified payment converts an unexpired hold to `confirmed` in the same transaction that records the payment. Expiry releases capacity and queues a job to void the unpaid invoice, which re-checks payment state before acting. A late payment after expiry re-acquires capacity if free; if not, the payment is recorded, no booking is made, the admin sees a conflict, and a refund job is queued (or a refund-due task for manual payments). Editing availability never evicts existing reservations; rescheduling reserves the new slot and releases the old one atomically.

**Music** (`Music/`): picker lists tracks with their source folder. YouTube: paste URL → job runs `yt-dlp` + ffmpeg → 192 kbps MP3 with title and source URL in tags → `Music/YouTube/`. Licensing of tracks used in client galleries is the studio's responsibility.

## 9. Lightroom Classic plugin

A **Publish Service** (same mechanism as Lightroom's Flickr plugin), configured once with server URL and a plugin token. The plugin setting "NAS mount path" maps `/photos/Clients/...` to the local mount for the initial lookup; after that the plugin stores the server's project and photo IDs per catalog photo and resolves current paths from them. An ambiguous or missing mapping asks the photographer to relink.

- **Publish collections mirror projects** and store the project ID. Creating one creates a project through the API; projects created elsewhere appear on refresh. Each collection has a Culling / Finals switch. Finals collections render full-res JPEGs (quality configurable). Culling collections upload edited-preview renditions linked to the existing RAW; they never replace a source file.
- **Publish** uploads whole files by multipart POST in batches of 20 with the source photo ID, desired display name, an upload ID, and a checksum. The server writes to `finals/.draft/`, names on collision rather than overwriting another source's file, and links the final to its RAW via `source_photo_id`. Files the server wrote are recognised by checksum so the watcher does not import them twice. Lightroom's custom sort order becomes gallery order. Removing a photo from the collection proposes retiring the live file; the file stays live until the retirement is published.
- **Publish to client** is a collection menu item and an admin button: one transaction promotes complete drafts to live (rename, old file to `.trash/`) and queues one email. `notifyOnPublish: true` runs that same operation after a complete batch. A manual retry never sends a second email for the same batch. Culling-preview uploads never mark a project delivered.
- **Sync picks** (service menu, also on plugin load): pulls the submitted rounds' confirmed picks, resolves current source paths by ID, and in one Lightroom write transaction sets flag = Pick and adds to a regular collection `<Project> – Picks`. Idempotent. Un-picks only revert flags the plugin set. Open-round and pending picks are not pulled. Unresolvable photos are listed in a summary dialog.
- **Comments** appear in Lightroom's Comments panel via the publish-service comment hooks. Region comments carry a position hint ("top-left: …"); video comments carry the timestamp. Replies from the panel post back.
- **Editing progress:** a background task every 5 minutes reports RAWs whose sidecar changed since round submission as `editing`, keyed by source ID. The server sets `done` when a live final links to that source; reports never overwrite a server-derived `done`; retiring the last linked final recomputes progress without regressing `delivered`. Reports merge per source across photographers.
- **Failures:** unreachable server fails the publish with Lightroom's standard error and leaves photos "to be published." Videos are never handled by the plugin. The plugin turns on "automatically write changes into XMP" and warns if it is off.

Plugin code: one Lua module for the HTTP API with no Lightroom dependencies, one for Lightroom glue. Shipped as a zipped `.lrplugin` on each release. Milestone 6 starts with a small spike proving the publish-service hooks and ID mapping before the full build.

## 10. Booking pipeline and payments

### State
Two persisted state columns and two derived badges.

| Dimension | Values |
|---|---|
| `booking_state` | `inquiry` → `call` → `proposed` → `awaiting_deposit` → `booked`; or `cancelled` |
| `production_state` | `not_started` → `shot` → `culling` → `editing` → `delivered` |
| Contract badge (derived) | `not_required` / `pending` / `signed`, from the DocuSeal submission or a manual attestation event |
| Payment badge (derived) | `unpaid` / `partial` / `paid` / `needs_review`, from the project's invoices |
| `archived_at` | restricts access independently of the above |

The board shows booking columns until production starts, then production columns; cancelled and archived are filters. "Signed," "balance due," "ready for shoot," and "paid" are badges, not columns. Ready-for-shoot means a confirmed reservation, a satisfied contract policy, and all pre-shoot invoices paid.

### Transitions
Every entry point (UI, board, plugin, MCP, webhook, scheduler) calls one transition service with `stateVersion` checks. Backward or unsupported moves fail visibly; an audited admin correction can move state but cannot invent a payment or a signature.

| Command | Guard | Effect |
|---|---|---|
| Book call / send proposal | valid call reservation / priced proposal | booking → `call` / `proposed` |
| Contract satisfied | verified DocuSeal signature, manual attestation, or `not_required` policy on the accepted proposal | hold the shoot date (section 8); if held, issue deposit invoice and booking → `awaiting_deposit`; no capacity means a visible conflict |
| Deposit paid | unique Stripe transaction or manual receipt; hold still valid or re-acquired | reservation → `confirmed`, booking → `booked`, send package forms once |
| Package paid (contract-free) | unique full payment with valid reservation | same as deposit paid, one `package` invoice |
| Balance / final paid | unique transaction or manual receipt | invoice settled; badges and download entitlement update; nothing else |
| Mark shot | admin, production `not_started` | production → `shot` |
| First usable RAW ingested | active project, production `not_started` or `shot` | open round 1, production → `culling`; later files never regress it |
| Finish round | section 6 guards, production `culling` | freeze round, production → `editing` |
| Publish finals | complete drafts, no slot deficit or review, production `editing` or `delivered`, or an explicit admin direct-delivery command for a project with no culling | production → `delivered`; first publication issues the final invoice |
| Additional round | section 6 guards | that round only; production stays `delivered` |
| Cancel / archive / restore | explicit admin command; archive also on expiry | cancel releases reservations and lists refund tasks; archive controls access; no provider event undoes either |

Provider events for cancelled or archived projects still record money facts but never reopen access or start workflows.

### Proposal and installments
1. Inquiry creates client + project and records the source. The reply offers call slots.
2. The app sends a **proposal**: line items, tax, credits, the installment split, and terms. Acceptance is recorded locally with a version; it does not create a Stripe Quote (a Quote would generate its own full-value invoice). Only invoices below are billable.
3. Contract via DocuSeal, or manual attestation in local mode. Once satisfied, the date is held and the deposit invoice issued. Zero deposit confirms the hold immediately.
4. Deposit paid confirms the booking. The balance invoice is issued `balanceDueDays` before the shoot (default 14), or immediately if already inside that window.
5. The final invoice is issued on first publication of finals and gates downloads together with any earlier unpaid invoice. Viewing never requires payment; publishing never marks anything paid.

**Split.** Default 30% deposit, 50% balance, 20% final. Deposit and balance round down to cents; the final takes the remainder so the three sum exactly to the accepted total. Overrides may be percentages or fixed amounts and must produce non-negative installments that sum to the total. Tax is allocated per installment in the same proportions; no installment re-taxes the whole package. If the studio requires tax and it is not configured, acceptance and checkout are blocked rather than assuming zero. Scope changes after acceptance create an `adjustment` invoice (positive or a credit); settled invoices are never edited.

**Invoices.** One row per installment, extras purchase, package sale, or adjustment; at most one active Stripe object each. Installments use Stripe Invoices and the client pays on the **Stripe Hosted Invoice Page**; extras and contract-free packages use Stripe Checkout. Replacing an invoice voids the old Stripe object and keeps the row's history. Zero-amount installments create no Stripe object and count as settled.

**Mark paid manually (Venmo/Zelle)** records amount, reference, actor, and time on the invoice, not a toggle; partial receipts stay partial. For a Stripe-linked invoice the app also marks it paid out-of-band at Stripe through a job so it cannot be collected twice. Overpayment shows as a refund-due item. A settlement the app cannot match stays `needs_review`.

**Refunds.** A refund records `refunded_amount` on the invoice and, for extras, a negative slot grant (section 6). A price correction is an `adjustment` credit and need not reopen debt; an uncredited reversal or dispute does.

**Download entitlement.** Requires a live final, an available and unarchived project, an allowed download rule, every invoice on the project settled (zero-total projects count as settled), and no review item or slot deficit. Clients unlock automatically. For `password` sharing, a six-character download code is emailed on first eligibility; guests redeem it once per session, and the server re-checks entitlement on every download. Refund, expiry, archive, or revocation cannot be bypassed by an earlier code or signed URL. `downloads: none` always denies. The review request email queues once the project is both `delivered` and fully paid.

**Stripe objects:** Customer per client; Invoices for installments and adjustments; Checkout Sessions for extras and contract-free packages; refunds; Stripe Tax on the items each object owns. Card data never touches the app. Stripe's own emails are off except receipts.

## 11. Integrations and email

- **Transactional email (required):** direct SMTP with bundled templates, or listmonk's transactional API with mapped templates. Auth and every notification go through this adapter as jobs from the first milestone. Transport failure is visible and retryable. Switching transports requires a delivery test.
- **listmonk marketing (optional):** inquiry and favorites capture subscribe with source tags and the recorded consent. Absent, marketing features hide; transactional mail continues over SMTP. Marketing lists carry unsubscribe; transactional messages never subscribe anyone to marketing.
- **DocuSeal (optional):** templates built in DocuSeal. "Send contract" creates a submission pre-filled from the proposal; verified webhook records the signature and queues the signed PDF into `documents/`. Absent, the admin attaches a signed PDF and attests it, or the package policy is `not_required`. A missing integration never counts as a signature.
- **Stripe (optional):** section 10. Webhooks flow through the inbox and the transition service. Absent, proposals, installments, manual receipts, and grants work; paid extras, public package checkout, and Stripe-price offers hide. Removing credentials never settles an existing invoice.
- **Nightly reconcile** as in section 4.
- **Calendar out:** per-admin ICS feed of shoots, calls, holds, invoice due dates.

**Transactional emails:** inquiry received; call booked; proposal; contract; deposit invoice; booking confirmed; balance invoice and reminder; culling ready (magic link); culling idle nudge (3 days); finals ready / photos added; final invoice; download code; expiry reminder; review request; form to fill; referral credit applied; download digest and alerts (admin); review-item alerts (admin).

## 12. Growth features

- Studio branding and "Book your own session" on guest surfaces; inquiries tagged with source gallery.
- Referral codes per client; credit applied as an `adjustment` on the referrer's next invoice; insights show referrals.
- Review request email and end card with the studio's review link.
- Portfolio release: client-controlled toggle with a consent event; released photos feed a public portfolio page hosted by the app, with the inquiry form on it.
- Public package pages (section 8).
- Guest favorites capture (optional email to save favorites) → listmonk.

## 13. MCP

Streamable HTTP endpoint at `/mcp` in the same process, using the official TypeScript MCP SDK. Auth by MCP token. Tools call the same commands the admin UI does:
- Read: `list_projects`, `get_project`, `dashboard_summary`, `search_clients`, `project_insights`, `list_offers`, `list_review_items`
- Write (requires `write` scope): `create_project`, `grant_slots`, `send_proposal`, `send_invoice`, `send_contract`, `mark_paid`, `publish_to_client`, `add_note`, `send_form`
Works as a Claude custom connector and a ChatGPT connector.

## 14. Team and Kanban

`users` table with `owner`/`member`. Invite by email; magic-link sign-in. `assignedTo` per project. Events record the actor. Board columns derive from booking and production state with contract and payment badges; no custom columns. Dragging runs guarded commands.

## 15. Video

Files in `raw/` or `finals/` with supported video signatures. ffmpeg makes a poster; if not already H.264/AAC MP4, a 1080p web copy goes to `.cache/` keyed by checksum, as a low-priority job. Playback and download use the live file; drafts are never served. Manual video finals follow the same draft/live and source-linking rules as photos. Culling supports picking and timestamp comments. Slideshow skips videos. Lightroom never handles video.

## 16. Security

Baked from the "vibecoder review" checklist; the checklist lives at `docs/security-review.md` and is run before each release.

- Secrets in `.env` or encrypted settings; only the public Stripe key reaches the browser; gitleaks in CI.
- Server-side sessions only; roles checked on the server; CSRF; rate limits; hashed single-use magic links; hashed, scoped, revocable tokens; token-gated bootstrap; no email-less login.
- One access-scoping middleware for all project-bound data; signed, session-bound, re-checked download URLs.
- No seeded accounts, no debug mode, generic errors with request IDs.
- Uploads per the section 3 write policy: distinct surfaces for plugin, admin, and client form attachments; signatures verified; traversal and symlink escapes rejected; server-managed filenames; child processes with argument arrays; SMB-discovered files validated the same way.
- Dependabot; `npm audit` fails CI on high; lockfile committed.
- CORS restricted to own origin; helmet-style headers with CSP; HTTPS enforced by tunnel.
- Parameterized queries only; no `dangerouslySetInnerHTML`; comments are plain text.
- Webhooks signature-verified, deduplicated, applied through guarded commands.
- No telemetry.

## 17. Error handling

- Watcher: malformed JSON keeps last good state and banners the file. Missing referenced files (cover, music) fall back silently and log.
- Preview extraction failure (RAW without a usable embedded JPEG): placeholder tile, warning in Insights, `preview_failed` event; the photographer publishes an edited preview from Lightroom instead.
- Jobs retry with backoff (3 attempts) under the same idempotency key, recover after restart, and surface in Settings → Jobs. Uncertain provider outcomes become `needs_review`, never blind retries.
- Provider or SMTP down: the command shows pending or failed with a request ID; local state is committed, the provider call resumes from the job; no claim of rollback.
- Plugin: standard Lightroom error path; summary dialog for unresolved photos.

## 18. Testing

- Unit: access middleware, shared selection and entitlement math, installment rounding, guarded transitions and derived badges, ID/path reconciliation, write-policy validation, form schema.
- Integration: fixture project folder with real RAW, JPEG, MP4 files; webhook handlers with recorded payloads; provider clients against mocks.
- End-to-end: Playwright on an iPhone viewport through sign-in, culling, extras checkout (Stripe test mode), finish, comments, publish, unlock, download.
- Plugin: HTTP module against the running app; Lightroom glue via a manual checklist in `docs/plugin-testing.md`.
- CI: lint, typecheck, unit + integration on every push; e2e nightly and on release tags.

**Acceptance gates.** Each applies at the milestone that introduces the behaviour and again before release.

| Area | Evidence |
|---|---|
| Identity | Move and rename a populated project and client while the app is stopped; restart; IDs, picks, comments, events survive. Duplicate IDs quarantine; wrong depth is flagged; cross-client move needs approval; trash/restore keeps records; external RAW rename shows missing + new, no merge. |
| Workflow | Deliver, then replay a late balance payment and drop another RAW: production stays `delivered`. Every board transition either succeeds under its guard or fails visibly. Archived and cancelled projects stay closed despite late events. |
| Extras | Two client emails pick the same photo; picks change during checkout; two checkouts race; two different event IDs for one payment. Slots granted once; confirmed picks never exceed entitlement; cancelled and late checkouts, surplus slots, and used-slot refunds behave as specified. |
| Recovery | Kill the process before and after a provider call, before the inbox row is applied, and mid-JSON-write. Restart. No duplicate invoices or grants, no overwritten machine fields, unknown outcomes appear as review items. |
| Booking | Two payments race for the last slot; a hold expires; a late deposit arrives; its refund fails; a reschedule. Capacity never exceeded; the losing payment stays refund-due. DST and call/shoot overlap cases. |
| Publication | Renamed exports, identical basenames from different RAWs, several finals per RAW, unlinked SMB finals, replacement drafts, retirements. Progress maps by source; the client sees the previous live file until publish, including across a restart. |
| Invoices | Default and custom splits sum exactly; per-installment tax; contract-free package sale creates no installments; zero total; partial and manual payments; adjustments; refunds; unknown settlement; an earlier unpaid invoice at delivery blocks downloads. |
| Minimum install | Bootstrap and sign in with SMTP only; local contracts and billing, manual receipts, zero-total entitlement. Repeat with listmonk transport and a transport outage. Removing Stripe credentials settles nothing. |
| Write policy | Every allowed actor/path/type works; forbidden ones, bad signatures, oversize files, reserved paths, traversal, and symlink escapes fail visibly; SMB files cannot skip validation. |
| Rounds | Finish 25 of 40; finish with fewer usable photos than allowance; zero picks rejected with a clear message; post-delivery round leaves the first snapshot and `delivered` intact. |

## 19. Open-source readiness

AGPL-3.0. Single `compose.yml` with profiles for optional services + documented `.env.example`; multi-arch image on GHCR per tag; token-gated first-run setup. No studio specifics in code. One transactional email transport required; Stripe, DocuSeal, and marketing optional with explicit local-mode behaviour (section 11). README with screenshots, `docs/` (install, backup/restore, plugin, integrations, security review, plugin testing), CONTRIBUTING, CODE_OF_CONDUCT, SECURITY.md, issue/PR templates, CHANGELOG (Keep a Changelog), semver. GitHub Actions publishes the image and the `.lrplugin` zip on tags. `/healthz` plus readiness for email configuration. Strings centralized for later translation. Update checks off by default.

## 20. Deferred (own specs later)

- Print fulfillment (Printful first behind a `PrintVendor` interface; Prodigi second).
- Cal.com for two-way Google Calendar busy-sync.
- Face-based "find me" filter (design keeps `.cache/` and `photos` ready for it).
- AI culling assist (blur, closed eyes, duplicates).
- Capacitor/SwiftUI app: push notifications, Face ID, "Save all to Photos."
- SSO across listmonk and DocuSeal.
- Album proofing, gift cards, digital packages.
- Chunked/resumable uploads if tunnel limits are hit in practice.
- Translations.

## 21. Build order

Each milestone exits when its section 18 gates pass. Identity, access, and commit-then-call rules are foundation, not polish; screens come as early as those allow.

1. **Foundation:** compose profiles, schema and migrations with constraints, stable IDs and watcher reconciliation, RAW preview extraction, `jobs` and `webhook_inbox`, SMTP adapter with bundled templates, bootstrap, auth, access middleware, backup/restore doc. Gates: identity, minimum install, write policy.
2. **Client culling portal:** sign-in, culling grid, viewer, shared selection with slots, finish under allowance, comments, project home. Local mode only (no Stripe yet). Gates: rounds, extras math without payment.
3. **Admin core:** Files browser, project detail (photos, activity, details), dashboard, settings, team, Jobs view, identity conflict resolution.
4. **Lightroom plugin:** spike the publish-service hooks and ID mapping, then publish drafts, sync picks, comments, progress. Gate: publication.
5. **Finals gallery:** publish to client, sections, cover, order, share, music and slideshow, favorites, expiry, download rule (local mode: downloads on for settled zero-total projects).
6. **Booking and proposals (local mode):** two-state pipeline, transition service, board, proposals, installment split, manual receipts, reservations, availability, calendar, ICS, forms, packages. Gates: workflow, booking, invoices (manual paths).
7. **Stripe:** Customers, installment invoices on Hosted Invoice Page, extras and package Checkout, webhooks through the inbox, refunds, reconcile, download unlock and code. Gates: extras, invoices, recovery.
8. **DocuSeal and listmonk:** contracts with attestation fallback, marketing capture, template mapping.
9. **Offers, growth, insights, notifications, additional rounds.**
10. **MCP, video, YouTube music.**
11. **Release:** security review pass, full gate matrix, restore rehearsal, open-source packaging, docs.
