# OpenGallery — Design Spec

**Date:** 2026-09-10
**Status:** Draft for review
**Scope:** Core product (v1). Deferred items are listed at the end and get their own specs.
**Revision:** Audit fixes applied 2026-09-10. Identity, state transitions, payments, recovery, publication, and minimum-install contracts below supersede the original path-only / single-status design.

## 1. What this is

A self-hosted replacement for Pixieset that runs on a UGREEN NAS. One photographer studio, many team members, many clients. It covers the full client lifecycle: inquiry, discovery call, quote, contract, deposit, shoot, client culling of RAW previews, editing progress, final gallery, payment-gated downloads, prints and offers, and email marketing.

The organizing idea: **the NAS folder tree is the app's content interface.** Photos, legal documents, forms, packages, and music are plain files in a structure the app understands. SQLite owns transactional facts that files cannot safely coordinate: selections, payments, reservations, publication revisions, sessions, and durable work. JSON files contain human-editable metadata and read-only projections of those facts; they are not a replacement for the database backup. Photographers work in Lightroom Classic against RAWs on the NAS share; clients use an iOS-first web app. The admin side feels like Google Drive with a project overlay.

Design language everywhere: Apple Human Interface Guidelines. One clear thing per screen, direct manipulation, system fades behind the photos.

### Non-goals (v1)
- Multi-tenant SaaS. One install, one studio.
- Watermarking, likes counters, social buttons, per-gallery themes, custom domains per gallery.
- In-app photo or video editing, presets.
- Task-level Kanban (sub-tasks, checklists, due dates per task).
- Native App Store app (designed for, not built).

## 2. Architecture and deployment

One Docker Compose stack on the NAS, exposed through a Cloudflare Tunnel on the studio's domain.

| Service | Role | Image |
|---|---|---|
| `opengallery` | The app: API, web UI, folder watcher, background jobs, MCP endpoint | built here |
| `listmonk` + `postgres` | Optional email lists, campaigns, transactional templates | stock |
| `docuseal` | Optional contracts and signatures | stock |
| `cloudflared` | Sole public ingress; services still require outbound access to configured providers | stock |

**App stack:** Node 22 + TypeScript. Hono for HTTP. React + Tailwind front end served by the same process (Vite build). SQLite via Drizzle, WAL mode, one file on the data volume. `sharp` for image work, `exiftool` for embedded RAW previews, `ffmpeg` for video and audio, `yt-dlp` for YouTube extraction. Background jobs run in-process on a SQLite-backed queue; no Redis.

**Routes via tunnel:** `gallery.<domain>` → app, `mail.<domain>` → listmonk, `sign.<domain>` → DocuSeal. listmonk and DocuSeal keep their own admin UIs; the app links to them. No SSO in v1.

**Volumes:** `/data` (SQLite, durable jobs, settings) and `/photos` (the folder tree, also exported over SMB to photographers). SQLite resides on local NAS storage, not an SMB mount. Backups must consistently capture the database including WAL, settings, content, and retained publication revisions; also persist and back up enabled listmonk/Postgres and DocuSeal state. Use a coordinated quiesced snapshot or database-native backup, and test restoring it. Reindexing `/photos` alone does not restore payments, selections, or publication history.

**Minimum install:** app + tunnel + a working transactional email transport (direct SMTP or configured listmonk). Direct SMTP uses bundled transactional templates; listmonk, DocuSeal, and Stripe remain optional. The app needs outbound SMTP/API access even though public ingress is tunnel-only. Setup and unavailable-integration behavior are defined in sections 5 and 11.

**Photographer machines:** mount the `/photos` share over SMB. Lightroom Classic catalogs live locally on each machine and reference RAWs on the share. XMP sidecars carry edits between catalogs. The plugin (section 9) is installed in each catalog.

## 3. Storage layout

```
/photos/
  Clients/                          structured; the app owns this shape
    <Client Name>/                  client.json
      <Project Name>/               project.json
        raw/                        RAWs (+ .xmp), videos for culling
        finals/                     JPEGs + videos rendered/dropped for delivery
          <Section>/                optional: subfolders become gallery sections
        documents/                  contracts, invoices, questionnaires, releases
        .revisions/                 immutable media revisions; retained, backed up
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
  .trash/                           deleted items, emptied after 30 days
  <anything else>/                  freeform, browser-visible but never indexed
```

**Rules**
- A folder is a client because it contains `client.json`; a project because it contains `project.json`. Clients must be direct children of `Clients/`, and projects direct children of clients. Both files require `schemaVersion: 1` and an immutable UUID `id`. UI creation allocates IDs; a hand-created file without an ID needs explicit admin adoption before indexing. Unsupported schema versions and malformed JSON keep the last good state and show a file-specific banner; schema migrations are versioned.
- Folder paths are mutable locations, not identities. A startup/full rescan matches IDs before classifying removals, including moves made while the app was stopped. Rename or same-client project moves at the valid depth retain IDs, selections, comments, and events. Missing folders are marked unavailable, not cascaded away. Trash/restore retains IDs and records for 30 days; content purge leaves financial/audit records and tombstones.
- A cross-client move requires an admin transfer confirming the new client's access. An external cross-client move is marked unavailable to clients/guests until approved; do not silently transfer access. Invalid-depth folders are flagged and not served. Duplicate IDs quarantine all conflicting locations until an admin identifies the original and explicitly adopts the copy with new IDs and no inherited transactional state. Never merge by matching titles, paths, or JSON contents.
- `project.json` names the culling and finals subfolders (defaults `raw`, `finals`). Media locations are project-relative paths, while photo IDs are stable database identities. A controlled admin rename preserves identity; an external file rename is reported as missing/new until the admin explicitly remaps it. Never guess identity from basename. The UI warns that renaming RAWs or moving their folders also breaks Lightroom's path references until relinked.
- The watcher (chokidar) reconciles allowed disk metadata and content into SQLite for `Clients/`, `Templates/`, and `Music/`. It waits for stable writes, validates content, and queues idempotent ingestion. A changed final creates a new immutable revision in `.revisions/`; a publication pointer, not the latest file bytes, determines what clients see. `.cache/` remains disposable.
- App writes follow the policy below. JSON projections use same-directory temporary files and atomic replacement; revision files use write-then-rename before a database pointer is committed. Recovery cleans unreferenced temporary files, never live revisions.
- Human metadata (title, notes, display preferences) uses field-level last-write-wins. Identity, workflow state, financial settings/entitlements, provider IDs, reservations, and publication state change only through validated commands in SQLite. Exported machine-owned fields are read-only projections with `stateVersion`; external edits produce a banner and are restored from SQLite, never replayed as commands. Projection jobs merge the latest valid human fields and retry if a file changed; stale whole-file writes must not overwrite paid entitlements.

### File-write policy

All paths are resolved server-side beneath their allowed root; reject traversal and symlink escapes. Reserved metadata/revision/cache directories cannot be overwritten through general upload. Metadata editors validate schemas. Limits are studio-configurable with the defaults below; originals are never executable or served as HTML. These are logical file limits, not HTTP request sizes: uploads use resumable chunks of at most 8 MB (or the configured ingress limit, if lower), with server-enforced aggregate quotas and complete-file validation before ingestion.

| Actor / operation | Destination | Allowed content and default limits |
|---|---|---|
| Admin Files browser | Non-reserved paths under `/photos`; client/project moves obey identity rules | Create/move/rename/trash; opaque attachments up to 2 GB, media up to 20 GB/file. Unrecognized types remain attachments, never previewed. Reserved JSON changes use editors. |
| Client submitting an assigned form | That project's `documents/<submission-id>/` | JPEG, PNG, PDF; 20 MB/file, 10 files/submission. Server-generated storage names; original names are display metadata. No arbitrary-path upload. |
| Plugin with project-authorized write token | Culling renditions or finals of the resolved project | JPEG renditions up to 100 MB/file, 20 logical files/batch with aggregate limits. Server assigns revision paths; token cannot write templates or unrelated files. |
| Admin settings / template builders | `Templates/Forms`, `Packages`, `Offers`, `availability.json`; `Music/Library` | Schema-valid JSON up to 1 MB; MP3, AAC/M4A, WAV up to 200 MB/track. |
| Background jobs / verified integrations | Project `documents/`, `.revisions/`, `.cache/`; `Music/YouTube` | Validated PDFs/JSON, media revisions/previews, extracted MP3 up to 200 MB. Job inputs identify the target entity, not an arbitrary destination. |

Media/PDF uploads and SMB-discovered media must match supported signatures and size limits before parsing. SMB files cannot bypass validation; unsupported or partial content gets a visible issue and is not rendered. Arbitrary admin attachments are downloaded as attachments after authorization, not interpreted. Freeform folders are browsable but are not project-shareable until moved into a project.

### `client.json`
```json
{ "schemaVersion": 1, "id": "01993840-0000-7000-8000-000000000001", "stateVersion": 1, "name": "Smith Family", "emails": ["sarah@example.com", "tom@example.com"], "phone": "", "stripeCustomerId": null, "listmonkSubscriberId": null, "referralCode": "SARAH100", "notes": "" }
```

### `project.json`
```json
{
  "schemaVersion": 1,
  "id": "01993840-0000-7000-8000-000000000002",
  "stateVersion": 1,
  "title": "Wedding 2026",
  "state": { "booking": "booked", "contract": "signed", "production": "culling", "archivedAt": null },
  "date": "2026-06-14",
  "package": "wedding-full-day",
  "assignedTo": "sam@studio",
  "folders": { "culling": "raw", "finals": "finals" },
  "currency": "usd",
  "allowance": { "included": 40, "purchased": 0, "gifted": 0, "extraPrice": 1500 },
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
  "billing": { "mode": "stripe", "planId": null },
  "docuseal": { "contractSubmissionId": "" },
  "calendar": { "callAt": "", "holdUntil": "" }
}
```
Prices are integer minor units in the project's explicit currency (cents for USD). `downloads` is `client`, `password`, or `none`. State, allowance, currency, billing, integration IDs, referral code, and calendar reservations are read-only projections; changes go through their commands. Invoice IDs are held per obligation in SQLite, not limited to three scalar fields. Initial project import creates no financial entitlement from hand-authored machine fields; adoption initializes those facts through admin commands. State dimensions are in section 10.

## 4. Data model (SQLite)

Core tables plus durable transactional records; there is no nine-table limit. Store provider IDs and the minimal local snapshots required for pricing, settlement, audit, and recovery, but never card data or unnecessary copies of provider/customer data. Every entity has an immutable primary key; mutable paths have project-scoped uniqueness.

| Table | Purpose | Key columns |
|---|---|---|
| `users` | Admin team | email, name, role (`owner`/`member`), notify_downloads (`off`/`digest`/`each`) |
| `clients` | Stable identity plus file metadata/projections | id (JSON UUID), folder_path, availability, state_version, name, emails (JSON), stripe_customer_id, listmonk_subscriber_id, referral_code |
| `projects` | Stable identity, metadata, independent state | id (JSON UUID), client_id, folder_path, availability, state_version, booking_state, contract_state, production_state, archived_at, date, metadata_json |
| `photos` | Logical media and source identity | id, project_id, rel_path, stage (`culling`/`final`), source_photo_id (nullable FK), kind (`photo`/`video`), sort_order, section, preview_revision_id, live_revision_id, edit_state (`none`/`editing`/`done`) |
| `media_revisions` | Immutable content, separate from live pointer | photo_id, revision, purpose (`culling_preview`/`final`), storage_path, checksum, width, height, captured_at, state (`draft`/`live`/`retired`), created_at |
| `selection_rounds` | Initial or additional culling, immutable submitted snapshot | project_id, kind (`initial`/`additional`), state (`open`/`submitted`/`cancelled`), revision, submitted_photo_ids, submitted_at |
| `picks` | One shared project selection across client emails | project_id, round_id, photo_id, by_email, picked_at, state (`confirmed`/`pending`); unique (project_id, photo_id) |
| `favorites` | Guest hearts on finals | photo_id, session_id |
| `comments` | Region/timestamp comments | photo_id, author, stage, x, y, w, h (nullable, 0–1), t (video seconds, nullable), text, created_at, resolved_at |
| `sessions` | Magic links, guest sessions, plugin/MCP tokens | kind (`client`/`admin`/`guest`/`plugin`/`mcp`), token_hash, subject, project_id (guests), scope, expires_at, nickname |
| `events` | Append-only activity log | project_id, actor, type, payload (JSON), at |
| `orders` | Immutable extras/package checkout snapshot | project_id, reservation_id, selection_revision, kind, quantity, unit_amount, total_amount, currency, provider_session_id, operation_id, state |
| `billing_plans` / `obligations` | Agreed total and non-overlapping installments | project_id, version, currency, item/tax snapshot, total_amount; plan_id, kind, amount_due, due_at, provider_invoice_id |
| `ledger_entries` | Payments, refunds, credits, slot grants/reversals | project_id, obligation_id/order_id, type, amount, currency, slot_delta, provider_reference, operation_id, actor |
| `reservations` | Atomic call/shoot capacity and expiry | project_id, kind, resource_id, starts_at, ends_at, studio_local_date, state (`held`/`confirmed`/`expired`/`cancelled`), expires_at, operation_id |
| `webhook_inbox` | Verified deliveries, durable deduplication | provider, event_id (unique per provider), object_id, payload, state, received_at |
| `operations` / `jobs` | Durable commands, outbox, retries and projections | operation_id (unique), entity_id, kind, immutable_request, provider_reference, state; operation_id, step, attempts, lease_until, next_attempt_at, last_error |

`events` feeds the dashboard, activity timelines, insights, analytics, download notifications, and "client last seen." Types include `viewed`, `picked`, `unpicked`, `commented`, `finished_culling`, `extras_purchased`, `published`, `downloaded`, `favorited`, `quote_sent`, `contract_signed`, `invoice_paid`, `form_submitted`, `offer_tapped`, `offer_converted`, `referral_used`, `edit_progress`.

Migrations are versioned and run at startup. Enforce foreign keys and database uniqueness, including one open selection round and one nonterminal extras checkout per project, unique provider transaction references, and unique operation/step keys. Historical selection snapshots and ledger entries are append-only; current entitlement is derived from ledger entries rather than editing a `purchased` counter.

### Durable commands and recovery

1. In one SQLite transaction, validate current state/version, record the operation and any reservation/order, and enqueue its next step. Commit before calling an external API.
2. Workers lease jobs durably and call providers with a stable idempotency key derived from the operation and step, plus correlation metadata where supported. Persist returned IDs before advancing. On uncertain success, look up the original request; do not create a new operation merely to retry. If a provider cannot deduplicate or resolve uncertainty, mark `needs_review` rather than blindly repeating the side effect. Respect provider idempotency retention windows.
3. Verify webhooks, insert the unique inbox event durably, then acknowledge. Processing commits ledger effects, guarded transitions, events, and follow-up jobs together with marking the inbox entry applied. A second event ID for the same payment must still deduplicate by provider transaction/object and effect. Fetch current provider state for stale/out-of-order events; provider settlement facts cannot directly assign production state.
4. Project JSON exports, PDFs, and emails are separate retryable outbox steps after that commit. A crash during projection regenerates the current version from SQLite while preserving human metadata. A valid PDF/revision file is finalized before recording its reference; an orphaned file is recoverable, not evidence of payment or publication.
5. Nightly reconciliation and startup lease recovery resume incomplete operations and compare linked provider objects to the ledger. Differences surface in Jobs/Insights with request IDs. Financial/admin commands show `pending`, `succeeded`, `failed`, or `needs_review`; no promise of distributed atomicity or silent success.
6. Email has a unique logical notification key and stable Message-ID. SMTP/provider acceptance followed by a crash can still produce a duplicate on retry; delivery is at-least-once, not exactly-once. Email retries never re-run payment or booking actions.

## 5. Auth and access

- **First owner / email prerequisite:** an operator runs the local setup command to generate a short-lived, single-use bootstrap token and opens the setup page with it. Setup creates the first owner, configures SMTP or listmonk, and verifies delivery and redemption of an owner magic link before normal onboarding is enabled. Bootstrap cannot authorize normal project access or be reused after setup. Email recovery requires a local operator command to reconfigure transport; never expose magic links in logs or add a public no-email login bypass.
- **Clients** sign in by magic link (single-use, 30-day validity, hashed). A client sees only projects whose `client.json` lists their email.
- **Admins** sign in by magic link (15-minute validity). Roles: `owner` (everything) and `member` (everything except billing settings, integration keys, team management).
- **Guests** open a share link and enter the gallery password. They get a project-scoped guest session and may enter a nickname. Guests can view and favorite; they cannot comment. They can download only if the project's download rule is `password` and downloads are unlocked (section 10).
- **Session cookies:** `httpOnly`, `secure`, `sameSite=lax`. CSRF token on all state-changing routes. Rate limits per IP and per email on sign-in, per session on downloads.
- **Access middleware:** every photo, pick, comment, favorite, and file route resolves the resource's project server-side and checks that the session is entitled to it. Clients/admins can select a project ID, but ownership is never trusted from request fields; guests are restricted to their session's project. Unavailable, transfer-pending, cancelled, or archived projects cannot be served to clients/guests. There is one scoping function; routes cannot bypass it.
- **Downloads:** per-request signed URLs, 10-minute expiry, bound to the requesting session. Zips stream, never touch disk. Every download is an event.
- **Plugin tokens** and **MCP tokens** are created in Settings → Access, hashed, scoped (`read` or `read+write`), revocable.

## 6. Client portal (iOS-first PWA)

Mobile-first, installable as a standalone PWA with the studio icon. Built to HIG: system font, Dynamic Type, 44pt targets, large titles, bottom sheets, safe-area insets, swipe-back, pull to refresh, light/dark from system. All screens talk to the same REST API the MCP uses, so a Capacitor or SwiftUI app later needs no backend changes.

**Sign in.** Email → magic link → in. One project lands directly; several show a list.

**Project home.** Title, date, one status line that says what to do now:
- `Pick your favorites · 23 of 40` + Continue
- `We're editing · 23 of 40 done` + progress bar
- `Your gallery is ready` + grid
Secondary row: Documents (shared files, contracts, invoices, forms to fill), Share, Referral code, Help.

**Culling grid.** Edge-to-edge thumbnails (embedded RAW previews), three across, pinch to change density. Tap opens the viewer; swipe for next; heart to pick. Filter: All / Picked. Sort: capture time. Bottom bar: `23 of 40`; above allowance it becomes the extras bar: `1 extra photo · $15 · Checkout`.

**Shared selection and extras.** All client emails share one project selection: the same photo counts once. Extras buy **fungible project slots**, not a frozen list of photos. Entitlement is `included + gifted + net purchased slots`. After every pick/unpick, grant, or reversal, recompute confirmed/pending picks in one SQLite transaction: submitted-round picks first, then current picks by `picked_at` and photo ID. A selection revision detects stale browser writes, which return a conflict for refresh rather than silently replacing another client's changes.

Checkout creates an immutable order for the current pending count at the current unit price, currency, tax, and selection revision. Only one nonterminal extras checkout is allowed per project; concurrent requests reuse it. Selection can change during payment, but the order does not: show the purchased quantity clearly, grant exactly that many slots on verified settlement, and recompute picks rather than blanket-confirming all pending rows. Surplus slots remain available to the project and can be used in a later round. To change quantity, cancel/expire and reconcile the old checkout before opening another; a timeout is not proof it was unpaid. A unique settlement reference grants slots once even when several provider events describe the same purchase.

Admin "gift" records an audited slot grant rather than editing a counter. App-initiated extras refunds are for whole unused slots, with corresponding tax reversal; used slots must first be explicitly released. An external refund/dispute that removes used entitlement records a reversal, deterministically makes excess current picks pending, pauses Finish/new publication/downloads, and raises a billing-review item. Original submitted snapshots, existing delivered revisions, and work history remain intact; settling or granting the deficit restores entitlement without silently reopening a submitted round. Partial external refunds with ambiguous quantity require review and block new checkout/Finish/publication/downloads until resolved.

**Finish culling.** The allowance is a maximum included entitlement, not a required quota. Finish requires an open round with at least one selected photo, no pending picks or unresolved billing review, and no nonterminal extras checkout. A confirmation sheet displays the actual count even below allowance. Submission uses a revision check and transaction to freeze the round's selected IDs, lock its picks, emit `finished_culling`, and notify the assigned admin. With zero usable photos, show an explicit action-required message; an admin can cancel the round, not fabricate a completed selection.

**Viewer.** Photo on black. Heart bottom-right; pin count bottom-left when comments are on for that stage. Drag on the image (long-press to start on touch) draws a region; a text field anchors to it. Pins are numbered dots. Videos show a poster and play inline; comments on videos carry a timestamp instead of a region. Swipe down closes.

**Editing progress.** Progress bar from source `photos.edit_state` over the submitted round's selected IDs, with any entitlement deficit shown separately. `done` requires a live final explicitly linked to that source. Unlinked manual finals never mark a RAW done by filename inference. Optional per-photo badge (project setting).

**Final gallery.** Same grid, sections from `finals/` subfolders as anchors, cover photo at top, order from `sort_order`. Only live revisions are served, including cover, thumbnails, slideshow, and downloads. A replacement draft does not change the previous live version. Top bar: Download (single / all, per rule), **Unlock downloads** with outstanding obligations when settlement is required, or a visible billing-review notice when payment state needs review. Invoice payments use the Stripe Hosted Invoice Page, not a separate Checkout charge. With local billing, show manual-payment instructions instead. `downloads: none` never shows an unlock purchase. Order print is deferred. Share uses the native share sheet with link + password. Slideshow plays the project's music with crossfades of stills only.

**Guests.** Password screen over a blurred cover with studio name and "Book your own session." Favorites filter shows hearts from all guests. Guest download unlock uses the six-character download code (section 10).

**Offers.** Cards in the gallery's visual language, never during culling, never on the password screen, never over a photo, no motion or timers. Placements: unlock card (un-picked photos, opens an **additional selection round** using remaining project slots and the extras flow), inline card at most one per 30 photos (dismissable per session), end card (one, not dismissable). Additional rounds exclude all previously submitted photos; they do not mutate initial selections or regress `delivered`. Their editing/publication work is shown separately, and prior live finals remain available subject to normal settlement rules. Only authenticated clients can open these rounds. Per-project on/off per offer and a global `showOffers` switch.

**Forms.** A form assigned to the project appears under Documents with a "Fill in" badge; fields render as native controls; submission writes PDF + JSON to `documents/`.

**Expiry.** `expiresAt` archives the gallery (viewable by admin only). Reminder email 7 days before.

**Known iOS limit:** zip downloads land in Files; single photo saves to Photos. The sheet says so.

## 7. Admin

Three-pane layout (sidebar, list, detail) on desktop; tab bar + push navigation on phone.

**Sidebar:** Dashboard, Files, Clients, Calendar, Settings.

**Dashboard.** Four blocks, nothing else: Money (outstanding, overdue in red, resend), Waiting on client (unsigned, culling idle, unpaid, with age), Waiting on you (culling finished, unresolved comments, finals not published, inquiries not quoted), Upcoming (shoots and calls by date).

**Files.** Drive-style browser of `/photos`. Create folder, upload allowed files, drag to move, rename, delete to `.trash/`, subject to section 3's write and identity policy. Client and project folders carry badges and derived status pills. **List / Board** toggle: Board uses the derived pipeline in section 10; dragging invokes the corresponding guarded command, never assigns status or marks an invoice paid. Unsupported moves explain the required action. Filters: mine / everyone / archived. Search covers client names, project names, photo filenames.

**Project detail.** Header: title, client, date, status pill, context-aware action bar (only the actions valid for the status; the rest under "…"). Segments:
- **Photos:** current stage grid with pick/comment badges; pending extras dashed; drag to reorder finals; set cover; open viewer with reply/resolve controls. **Publish to client** atomically swaps selected live revision pointers and queues one ready/added email. Manual and plugin finals follow the same publication rules.
- **Activity:** events timeline; unresolved comments pinned to top.
- **Insights:** views, unique visitors, favorites, downloads, activity by day, per-visitor list, per-offer taps and conversions, inquiries sourced from this gallery.
- **Details:** `project.json` as a form (allowance, extra price, download rule, comment toggles, music, cover, expiry, notify-on-publish, assignee, offers, portfolio release status, notes). Machine-owned values are read-only with explicit actions for grants, price changes, transitions, and reservations. Reducing allowance cannot invalidate submitted selections without an explicit deficit-resolution workflow. Files in the project folder have a **Share with client** toggle.

**Clients.** List; detail shows projects, contact info, Stripe balance, listmonk lists, referral credits.

**Calendar.** Month view of shoots, discovery calls, and tentative holds (hollow dots). Edit availability inline. ICS feed URL per admin.

**Settings (one page, grouped):** Studio (name, logo, sender, timezone, currency, defaults for allowance, prices, installment split, balance-due days, hold hours); Team (members, invites, per-member download notifications); Email (required SMTP or listmonk transport, delivery test, transport health); Integrations (Stripe, DocuSeal, listmonk marketing, later Printful; unsupported actions hide when unset, but existing obligations remain visible); Templates (bundled email templates or selected listmonk equivalents); Forms builder; Packages; Offers; Music (library + YouTube field); Access (MCP tokens, plugin tokens, calendar feed).

**Download notifications.** Per admin: Off / Daily digest (9am, grouped by project) / Every download. First download of a project always notifies.

## 8. Templates, forms, packages, offers, calendar, music

**Forms** (`Templates/Forms/*.json`): builder with fields short text, long text, single choice, multiple choice, date, yes/no, file. Reorder, required flag. Attached to packages (sent after booking) or sent ad hoc from a project. Responses and validated attachments → `documents/<submission-id>/`, with form name as display metadata. Each submission gets its own PDF + JSON, so repeated submissions cannot overwrite prior responses.

**Packages** (`Templates/Packages/*.json`): name, price, currency, included picks, extra price, installment override, duration, attached forms, contract policy/template, public page on/off. Public date selection creates a provisional client/project and reserves shoot capacity before payment. Direct package Checkout charges the full package amount and tax, not a deposit, and settles the plan once; only verified payment with a valid reservation confirms booking. A package requiring a signed contract uses the quote/contract/installment flow instead of bypassing it with direct Checkout. Without Stripe, public package pages create inquiries, not checkout sessions or automatic bookings.

**Offers** (`Templates/Offers/*.json`): title, one line, image, button label, action (`unlock` / `prints` / `link` / `stripe_price`), placement (`unlock` / `inline` / `end`), default on/off.

**Availability** (`Templates/availability.json`): studio IANA timezone, working days, blackout dates, shoot capacity per local date, call resources/hours and slot length. SQLite reservations, not this file, own held/confirmed capacity.

**Reservation contract.** In a serialized SQLite write transaction, expire elapsed holds, validate availability and capacity, and create a reservation before initiating Checkout or issuing a deposit invoice. Shoot holds/confirmations consume one unit of that studio-local date's shoot capacity. Calls reserve non-overlapping intervals per assigned admin; that admin's assigned shoots also block overlapping call times. Store UTC instants plus the chosen studio-local date/timezone; reject nonexistent DST times and require an explicit offset for ambiguous ones.

Public Checkout holds last 30 minutes; signed-contract deposit holds use `holdHours` (default 72). Checkout/deposit operations carry the reservation ID. Verified settlement converts an unexpired hold to confirmed within a transaction, never by an unguarded status write. On expiry/cancellation release capacity and queue checkout expiration or unpaid-invoice voiding; these jobs recheck current settlement/reservation state before acting. A late payment after expiry may atomically reacquire capacity only for an active, non-cancelled project. If unavailable (or the project was cancelled/archived), retain the payment fact, do not book, show a conflict, and queue a full refund (or an explicit refund-due task for manual payments). Failed refunds remain visible until resolved. Provider timeouts leave the original operation unresolved, not a new booking attempt. Availability edits cannot silently evict existing reservations; rescheduling reserves the new slot and releases the old one atomically.

**Music** (`Music/`): picker in project details lists tracks with their source folder. YouTube: paste URL → background job runs `yt-dlp` + ffmpeg → 192 kbps MP3 with title and source URL in tags → `Music/YouTube/`. Licensing of tracks used in client galleries is the studio's responsibility; the picker labels the source folder.

## 9. Lightroom Classic plugin

A **Publish Service** (same mechanism as Lightroom's Flickr plugin), configured once with server URL and a plugin token. The initial source lookup uses paths: plugin setting "NAS mount path" maps `/photos/Clients/...` to the local mount. Subsequent operations use stable project/source IDs and resolve their current paths.

- **Publish collections mirror projects.** Collections store the stable project ID. Creating one creates a project through the API; external projects appear on refresh. The initial path lookup resolves a RAW to a stable source photo ID, then the plugin persists that ID per catalog photo; an ambiguous or missing mapping requires relinking. Each collection has a Culling / Finals switch; Finals collections render full-res JPEGs. Culling collections upload edited-preview renditions associated with the existing RAW, never replacement source files.
- **Publish** submits batches of 20 logical JPEG revisions using resumable multipart chunks, stable source/photo IDs, desired display names, and idempotent upload IDs. The server assigns storage paths under `.revisions/`; the latest complete final export is also available at its working `finals/` path. It allocates a distinct working path on name collision rather than overwriting another source's final. Upload IDs and checksums make watcher observation of server-written files a no-op, not a second import. Custom sort order becomes gallery order. New/modified files from either Lightroom or SMB are drafts by default; a changed working file never overwrites an immutable live revision. Manual SMB finals remain unlinked until the admin associates them with a source. Duplicate basenames and multiple final renditions per source are supported.
- **Publish to client** is a collection menu item and admin button. A publication operation atomically switches selected final pointers to complete drafts and queues one email. `notifyOnPublish: true` opts into that same operation after a complete upload batch (or stable SMB ingestion); it never exposes partially uploaded bytes or sends a second email on manual retry. Removing a final in Lightroom/SMB proposes retirement; the prior live revision remains until explicit publication of the removal. Culling-preview publication cannot mark production delivered or emit a finals-ready notification.
- **Sync picks** (service menu, also automatic on plugin load): pulls entitled submitted-round picks, resolves current source paths by ID, and in one Lightroom write transaction sets flag = Pick and adds to a regular collection `<Project> – Picks`. Idempotent. Un-picks only revert flags the plugin set. Open-round/pending extras are not editing commitments. Unresolvable paths are listed in a summary dialog.
- **Comments** appear in Lightroom's Comments panel via the publish-service comment hooks. Region comments carry a position hint ("top-left: …"); video comments carry the timestamp. Replies from the panel post back.
- **Editing progress**: a background task every 5 minutes reports sidecar changes since round submission as `editing`, keyed by source ID. The server derives `done` when at least one final linked to that source is live; a new draft leaves prior live progress intact. Retiring the last linked live final recomputes the source's progress without regressing the project's delivered state. Reports merge per source across photographers and cannot overwrite server-derived `done`.
- **Failures:** unreachable server fails the publish with Lightroom's standard error and leaves photos "to be published." Videos are never handled by the plugin.
- The plugin turns on "automatically write changes into XMP" and warns if it's off.

Plugin code: one Lua module for the HTTP API with no Lightroom dependencies, one for Lightroom glue. Shipped as a zipped `.lrplugin` on each release.

## 10. Booking pipeline and payments

### Independent state and derived pipeline

There is no writable `project.json.status`. Persist these independent dimensions:

| Dimension | Values / source of truth |
|---|---|
| Booking | `inquiry`, `call`, `quoted`, `awaiting_deposit`, `booked`, `cancelled`; guarded commands plus reservation confirmation |
| Contract | `not_required`, `pending`, `signed`; explicit policy and verified submission/manual evidence |
| Production | `not_started`, `shot`, `culling`, `editing`, `delivered`; production commands only |
| Financial | Per-obligation balances and refunds/credits in the ledger; `unpaid`/`partial`/`paid`/`needs_review` are derived |
| Archive | `archivedAt` independently restricts access; restoration requires an explicit admin command and valid expiry |

The board shows booking columns until production starts, then the production column; archived and cancelled projects are separately filtered. Signed, balance-due, ready-for-shoot, and paid are badges, not writable stages. Ready-for-shoot requires a confirmed reservation, a satisfied contract policy, and all pre-shoot obligations settled. A paid badge does not mean photos are delivered.

| Trigger / command | Guard | Effect |
|---|---|---|
| Book call / send quote | Valid call reservation / priced proposal | Advance booking to `call` / `quoted`; never change money or production |
| Contract policy satisfied | Verified signature evidence or explicit `not_required` policy for the accepted proposal; initial booking not already completed | Record the appropriate contract state; attempt date hold and queue deposit issue; set booking `awaiting_deposit` only if capacity reserved |
| Deposit settlement | Active or atomically reacquired reservation; contract policy satisfied | Confirm reservation and set booking `booked`; duplicate/late events cannot regress it |
| Full-package settlement | Unique verified full payment, valid reservation, `not_required` contract policy | Settle the single obligation, confirm the reservation, set booking `booked`, and send forms once |
| Balance/final settlement | Unique provider transaction or authorized manual ledger entry | Update settlement and derived badges/download entitlement only |
| Mark shot | Admin action on an active project in `not_started` | Set production `shot` |
| First usable RAW/preview ingestion | Active, non-cancelled project in `not_started` or `shot` | Open initial round and set production `culling`; new files in later stages never regress it |
| Finish initial round | Section 6 completion invariant, production `culling` | Freeze round and set production `editing` |
| Publish final revisions | Active project, complete revisions, no entitlement deficit/review; production `editing` or `delivered`, or explicit admin direct-delivery command for a project without initial culling | Set/remain `delivered`; direct delivery is audited, not inferred from dropped files |
| Additional round submission/publication | Section 6 round guards | Update that round and notify editing work; keep production `delivered` |
| Cancel / archive / restore | Explicit admin command (archive also on expiry) | Cancel releases reservations with visible refund tasks where needed; archive controls access independently; no provider event can undo either |

Every entry point (UI, board, plugin, MCP, webhook, scheduler) calls the same transition service with state/version checks. Unsupported/backward drags fail visibly; an audited correction command must check the original invariants and may not invent payment or contract facts. Provider events still record financial truth for cancelled/archived projects but do not reactivate access or enqueue new booking/delivery workflows.

### Quote, installments, and ledger

1. Inquiry creates client + project and records source. The reply offers discovery-call slots from the reservation service.
2. The app sends a versioned proposal containing item prices, currency, taxes, credits, installment amounts, and terms. Client acceptance locks that version. In v1, acceptance is recorded locally rather than accepting a Stripe Quote that could create an additional full-value invoice; only the obligations below are billable.
3. Send the required contract through DocuSeal, or record verified manual evidence when using local contracts. Once signed (or explicitly not required), atomically reserve the shoot before issuing the deposit obligation's invoice. No capacity means a visible conflict, not a deposit request. Zero deposit confirms the hold immediately once the contract policy is satisfied.
4. Deposit settlement confirms the reservation and sends package forms. The balance invoice is auto-issued `balanceDueDays` (default 14) before the shoot, or immediately if already within that window. Due/unpaid obligations remain visible independently of production.
5. The final installment, if nonzero, is issued on first final-gallery publication and gates download settlement along with any earlier unpaid obligation. Gallery viewing does not require payment; publication never implicitly marks an invoice paid.

**Money contract.** One explicit currency per project, using integer minor units and that currency's exponent. The accepted plan freezes item quantities/prices, tax basis/amount, discounts, credits, and the collectible total. Default allocation is 30% deposit, 50% balance, and the remaining 20% final. Round deposit and balance down in minor units and assign the residual to final so amounts sum exactly to the total. Overrides may be percentages or fixed amounts but must resolve to nonnegative installments whose sum equals that total; changing the deposit requires confirming the revised full split. Each installment owns a disjoint allocation of item and tax amounts; never tax the full package again on each invoice. Tax calculation/collection uses the configured provider where available and explicit reviewed tax amounts in local mode; missing required tax configuration blocks acceptance/checkout rather than silently assuming zero.

**Payment representation.** There is one obligation per installment, with at most one active provider invoice. Send its [Stripe Hosted Invoice Page](https://docs.stripe.com/invoicing/hosted-invoice-page) link for payment; never create a separate Checkout Session to pay an existing invoice. Replacements retain the original obligation and explicitly void/credit superseded invoices. Zero-amount installments create no provider invoice. Later agreed scope changes create a versioned adjustment obligation; they do not edit already settled history.

**Full-payment packages.** Direct package Checkout has one full-value obligation, including tax, instead of the three-installment schedule. Its verified payment settles that obligation; no later deposit/balance/final invoices are generated for the same items. Checkout and invoices cannot both own the same receivable. Extras orders are separate slot purchases, not another charge for package-included photos.

**Settlement and corrections.** Append uniquely referenced receipts, manual payments, credits, refunds, and reversals, allocated to obligations/orders. Credits reduce what is owed; payments reduce outstanding amounts; neither is double-counted. Refunds record both the payment reversal and any explicit price reduction/credit: a price correction need not reopen debt, while an uncredited reversal/dispute does. Overpayment becomes a visible refund-due item, not extra photo entitlement. Before collection, final provider amounts and currency must match the accepted obligation/order; a tax/address/amount change requires a reviewed adjustment, never silent overcharging. Unknown or mismatched settlements remain recorded in `needs_review` until reconciled.

**Mark paid manually (Venmo/Zelle)** records amount, currency, reference, actor, and timestamp on the obligation, not a status toggle. It drives the same entitlement/reservation checks as remote payment. For a linked Stripe invoice, confirm supported out-of-band settlement remotely through the durable operation before showing the obligation as fully synchronized; unresolved synchronization blocks duplicate collection and is visible in Jobs. Local billing records the receipt directly. Do not mark a whole invoice paid to represent a partial receipt.

**Download entitlement.** Require a live final, active/available project, allowed download rule, satisfied accepted billing plan (including adjustments), and no pending payment review or selection entitlement deficit. A zero-total plan is explicitly settled without payment; absence of an invoice is not proof of settlement. Clients unlock automatically when eligible; for `password` sharing, email a six-character project download code on first eligibility. Guest sessions must redeem it and the server rechecks eligibility on each download. Refund/expiry/archive/revocation cannot be bypassed by a previously redeemed code or signed URL. `downloads: none` always denies. Review requests are queued once the gallery is both delivered and settled, not merely on receipt of any invoice payment.

**Stripe objects:** Customer per client; installment/adjustment Invoices; Checkout Sessions for extras and full-payment packages; associated payments/refunds and tax calculations. Local proposal IDs map to the resulting obligations. Stripe Tax applies only to the items owned by that checkout/invoice allocation, with final totals reconciled before entitlement. Card data never touches the app. Stripe's own emails are off except receipts; application email is queued separately.

## 11. Integrations and email

- **Transactional email:** required direct SMTP transport with bundled templates or listmonk's transactional API with mapped templates. Auth and all notifications use this adapter/outbox from the foundation milestone. A transport failure is visible and retryable; provider receipt emails are not the sign-in mechanism.
- **listmonk (optional):** inquiry/favorites email capture subscribes with source tags and the applicable marketing consent. If absent, marketing capture/campaign features hide; transactional mail continues over configured SMTP. Marketing lists carry unsubscribe; strictly transactional messages do not subscribe recipients to marketing. Switching transports requires a delivery test and preserves queued notification IDs.
- **DocuSeal (optional):** templates built in DocuSeal. "Send contract" creates a correlated submission pre-filled from the proposal; verified webhook updates contract state and queues signed PDF storage. With no DocuSeal, admin can attach a signed contract and explicitly attest its date/evidence, or set a disclosed `not_required` policy; missing integration never automatically counts as a signature.
- **Stripe (optional):** section 10. Webhooks update the local ledger and guarded workflows via the inbox, not a raw status assignment. Without Stripe, local plans/obligations, manual receipts, and grants work; paid extras checkout, online package checkout, and Stripe-price offers hide. Client extra requests are routed to admin for a grant or manually settled slot order. Existing Stripe obligations remain visible and unresolved if credentials are removed; disabling an integration never unlocks them.
- **Nightly reconcile** queries configured providers for linked objects and uncertain operations using section 4's recovery rules. Disconnected-provider work stays visibly blocked, not treated as settled.
- **Calendar out:** per-admin ICS feed of shoots, calls, holds, invoice due dates.

**Transactional emails:** inquiry received; call booked; quote; contract; deposit invoice; booking confirmed; balance invoice and reminder; culling ready (magic link); culling idle nudge (3 days); finals ready / photos added; final invoice; download code; expiry reminder; review request (after delivery and settlement); form to fill; referral credit applied; download digest and download alerts (admin). Disable Stripe/DocuSeal application-notification emails where the app owns that notification; retain provider receipts as documented.

## 12. Growth features

- Studio branding and "Book your own session" on guest surfaces; inquiries tagged with source gallery.
- Referral codes per client; credit applied to the referrer's next invoice; insights show referrals.
- Review request email and end card with the studio's review link.
- Portfolio release: client-controlled toggle with consent record; released photos feed a public portfolio page hosted by the app, with the inquiry form on it.
- Public package pages with date picker and checkout.
- Guest favorites capture (optional email to save favorites) → listmonk.

## 13. MCP

Streamable HTTP endpoint at `/mcp` in the same process, using the official TypeScript MCP SDK. Auth by MCP token. Tools mirror the admin API:
- Read: `list_projects`, `get_project`, `dashboard_summary`, `search_clients`, `project_insights`, `list_offers`
- Write (requires `write` scope): `create_project`, `set_allowance`, `send_quote`, `send_invoice`, `send_contract`, `mark_paid`, `publish_to_client`, `add_note`, `send_form`
Works as a Claude custom connector and a ChatGPT connector.

## 14. Team and Kanban

`users` table with `owner`/`member`. Invite by email; magic-link sign-in. `assignedTo` per project. Events record the actor. Board columns derive from booking/production, with independent contract/payment badges and archive filtering; no custom columns. Dragging uses section 10's guarded commands, not direct state assignment.

## 15. Video

Files in `raw/` or `finals/` with supported video signatures. ffmpeg makes a poster; if not already H.264/AAC MP4, a 1080p web copy goes to `.cache/` as a low-priority job, keyed by revision checksum. Inline playback uses the selected revision; download serves its retained original, never an unpublished replacement at the working path. Manual video finals follow the same draft/live and explicit source-linking rules as photos. Culling supports picking and timestamp comments. Slideshow skips videos. Lightroom never handles video.

## 16. Security

Baked from the "vibecoder review" checklist; the checklist itself lives at `docs/security-review.md` and must be run before each release.

- Secrets in `.env` or encrypted settings; only the public Stripe key reaches the browser; gitleaks in CI.
- Server-side sessions only; roles checked on the server; CSRF; rate limits; hashed single-use magic links; hashed, scoped, revocable tokens.
- Single access-scoping middleware for all project-bound data; signed, session-bound download URLs.
- No seeded accounts, no debug mode, generic errors with request IDs.
- Uploads follow the actor/destination/type/limit matrix in section 3: scoped plugin tokens, authorized admin uploads, and project-assigned client form attachments are distinct surfaces. Verify supported media signatures, validate paths against traversal/symlink escape, generate managed storage filenames, and treat original filenames as display metadata. Child processes use argument arrays; SMB ingestion receives the same parser validation.
- Dependabot; `npm audit` fails CI on high; lockfile committed.
- CORS restricted to own origin; helmet-style headers with CSP; HTTPS enforced by tunnel.
- Parameterized queries only; no `dangerouslySetInnerHTML`; comments are plain text.
- Webhooks signature-verified and idempotent.
- No telemetry.

## 17. Error handling

- Watcher: unreadable or malformed JSON keeps last good state and banners the file. Missing referenced files (cover, music) fall back silently and log.
- Preview extraction failure (RAW without a usable embedded JPEG): a placeholder tile, a warning in the project's Insights, and a `preview_failed` event so the photographer can publish an edited preview from Lightroom instead.
- Jobs retry safe/idempotent steps with backoff (3 attempts), recover expired worker leases after restart, and surface in Settings → Jobs. Retry keeps the original operation ID; uncertain non-idempotent outcomes require reconciliation or operator review first.
- Stripe/DocuSeal/listmonk/SMTP down: show the durable operation's pending/failed/review state and request ID. External success and local follow-up can be temporarily incomplete; preserve the ledger, block duplicate collection, and resume the outbox/reconciliation steps in section 4 rather than claiming distributed rollback.
- Plugin: standard Lightroom error path; summary dialog for unresolved photos.

## 18. Testing

- Unit: access middleware, project-wide selection/entitlement math, installment/currency rounding, guarded transitions and derived labels, ID/path reconciliation, form schema and write-policy validation.
- Integration: fixture project folder with real RAW, JPEG, MP4 files; webhook handlers with recorded payloads; listmonk/DocuSeal/Stripe clients against mocks.
- End-to-end: Playwright on an iPhone viewport through sign-in, culling, extras checkout (Stripe test mode), finish, comments, final gallery, unlock, download.
- Plugin: HTTP module tested against the running app; Lightroom glue via a manual checklist in `docs/plugin-testing.md`.
- CI: lint, typecheck, unit + integration on every push; e2e nightly and on release tags.

**Required acceptance cases before release (audit regression gates):**

| Finding | Acceptance evidence |
|---|---|
| Stable folder identity | Move/rename a populated project and a client while stopped, restart, and retain IDs/picks/comments/events. Test duplicate IDs, invalid depth, cross-client transfer approval, trash/restore, and external media rename without heuristic merging. |
| Independent workflow | Deliver, then replay a late balance payment and ingest another RAW: production stays delivered. Exercise every guarded board/API transition; archived/cancelled projects stay inaccessible despite delayed events. |
| Extras concurrency | Two client emails pick the same photo, change picks during checkout, race checkout creation, and replay different events for one payment. Slots are granted once; confirmed current picks never exceed entitlement. Cover cancelled/late checkout, surplus slots, and used-slot refund/review. |
| Durable recovery | Crash before/after remote success, inbox/ledger commit, and JSON/PDF/revision writes; restart and reconcile without duplicated invoices/grants or overwritten machine fields. Verify unknown provider outcomes become review tasks and SMTP duplicate-delivery limits are explicit. |
| Booking capacity | Race two payments for the last slot, expire a hold, accept a late deposit, fail its refund, and reschedule. Confirmed/held capacity is never exceeded; losing payments remain refund-due until resolved. Include DST and call/shoot overlap. |
| Media identity/publication | Publish renamed exports, identical basenames from different sources, multiple renditions per RAW, unlinked SMB finals, replacement drafts, and retirements. Source progress maps correctly; every client surface keeps the prior revision until publish, including after restart/restore. |
| Invoice accounting | Test default/custom splits and currency exponents; installment item/tax totals equal the accepted plan. Full-payment packages never generate duplicate installments. Cover zero total, partial/manual payment, price corrections, refunds, unknown settlement, and outstanding earlier invoices at delivery. |
| Minimum install | Bootstrap and later sign in with direct SMTP and no optional integrations; verify local contracts/billing, manual settlement, and zero-total download entitlement. Repeat with listmonk transport and a transport outage. Removing Stripe credentials never settles an existing obligation. |
| Write-policy consistency | Every allowed actor/path/type operation works; forbidden combinations, malformed signatures, oversize files, reserved paths, traversal, and symlink escapes fail visibly. SMB-discovered files cannot bypass parser validation. |
| Round completion | Finish 25 of 40, finish when fewer usable photos than allowance exist, reject zero selections with a clear message, and submit post-delivery extras without modifying the initial snapshot or regressing delivery. |

## 19. Open-source readiness

AGPL-3.0. Single `compose.yml` with optional-service profiles + documented `.env.example`; multi-arch image on GHCR per tag; token-gated first-run setup page. No studio specifics in code. One transactional email transport is required; Stripe, DocuSeal, and marketing remain optional with explicit local-mode behavior in section 11. README with screenshots, `docs/` (install, plugin, integrations, security review, plugin testing, backup/restore), CONTRIBUTING, CODE_OF_CONDUCT, SECURITY.md, issue/PR templates, CHANGELOG (Keep a Changelog), semver. GitHub Actions publishes the image and the `.lrplugin` zip on tags. `/healthz` plus readiness reporting for required email/configuration. Strings centralized for later translation. Update checks off by default.

## 20. Deferred (own specs later)

- Print fulfillment (Printful first behind a `PrintVendor` interface; Prodigi second).
- Cal.com for two-way Google Calendar busy-sync.
- Face-based "find me" filter (design keeps `.cache/` and `photos` ready for it).
- AI culling assist (blur, closed eyes, duplicates).
- Capacitor/SwiftUI app: push notifications, Face ID, "Save all to Photos."
- SSO across listmonk and DocuSeal.
- Album proofing, gift cards, digital packages.
- Translations.

## 21. Build order

Each milestone exits only when its applicable section 18 acceptance gates pass. These are implementation stages, not permission to defer identity, settlement, or access invariants until the end.

1. Foundation: compose profiles, stable IDs/schema migrations, watcher reconciliation, media revisions/previews, database constraints, durable operations/inbox/outbox, backup/restore. Implement SMTP + bundled email, owner bootstrap, auth, and access middleware together.
2. Domain core: guarded independent state, local proposals/installment ledger, manual receipts/grants, selection rounds/entitlement math, and atomic reservations/timezone rules. Pass concurrency and crash-recovery gates before UI workflows depend on them.
3. Admin: policy-aware Files browser, project detail, derived board/dashboard, settings, email delivery test, team; include identity conflict resolution and pending/review job visibility.
4. Stripe adapter: invoice Hosted Invoice Page flow, extras/full-package checkout, idempotency/reconciliation/refunds, reservation confirmation, and download settlement policy. Pass accounting/reservation/duplicate-event gates.
5. Client portal: sign-in, shared culling, extras checkout/manual requests, under-allowance Finish, viewer/comments, submitted snapshots, and additional-round behavior.
6. Lightroom plugin: prove SDK hooks/path-ID mapping in a small integration spike, then publish revisions, sync submitted picks, comments, and source-linked progress; pass revision-replacement tests.
7. Finals gallery: explicit publication, entitlement-checked downloads/code, share, music/slideshow, sections, expiry, favorites. Test local and Stripe modes, refunds, and archived access.
8. Booking UI, forms/attachments, packages, availability/calendar/ICS; DocuSeal and optional listmonk adapters on the existing durable/email contracts.
9. Offers, growth features, insights, notifications; retain separate post-delivery rounds and ledger-backed credits.
10. MCP, video, YouTube music; enforce the same commands, write policy, and publication rules.
11. Security review pass, full acceptance matrix, restore rehearsal, open-source packaging/docs, release. Security/access checks and targeted tests run throughout, not only here.
