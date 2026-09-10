# OpenGallery — Design Spec

**Date:** 2026-09-10
**Status:** Draft for review
**Scope:** Core product (v1). Deferred items are listed at the end and get their own specs.

## 1. What this is

A self-hosted replacement for Pixieset that runs on a UGREEN NAS. One photographer studio, many team members, many clients. It covers the full client lifecycle: inquiry, discovery call, quote, contract, deposit, shoot, client culling of RAW previews, editing progress, final gallery, payment-gated downloads, prints and offers, and email marketing.

The organizing idea: **the NAS folder tree is the app.** Photos, legal documents, forms, packages, and music are plain files in a structure the app understands. The database only holds what a folder cannot express (picks, sessions, events). Photographers work in Lightroom Classic against RAWs on the NAS share; clients use an iOS-first web app. The admin side feels like Google Drive with a project overlay.

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
| `listmonk` + `postgres` | Email lists, campaigns, transactional templates | stock |
| `docuseal` | Contracts and signatures | stock |
| `cloudflared` | Tunnel; only service that touches the internet | stock |

**App stack:** Node 22 + TypeScript. Hono for HTTP. React + Tailwind front end served by the same process (Vite build). SQLite via Drizzle, WAL mode, one file on the data volume. `sharp` for image work, `exiftool` for embedded RAW previews, `ffmpeg` for video and audio, `yt-dlp` for YouTube extraction. Background jobs run in-process on a SQLite-backed queue; no Redis.

**Routes via tunnel:** `gallery.<domain>` → app, `mail.<domain>` → listmonk, `sign.<domain>` → DocuSeal. listmonk and DocuSeal keep their own admin UIs; the app links to them. No SSO in v1.

**Volumes:** `/data` (SQLite, job queue, settings) and `/photos` (the folder tree, also exported over SMB to photographers). Backups are the NAS's job: both are plain folders under one UGOS snapshot schedule.

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
  <anything else>/                  freeform, never indexed
```

**Rules**
- A folder is a client because it contains `client.json`; a project because it contains `project.json`. Both must sit at their depth under `Clients/`. The UI creates them; dropping the JSON file by hand also works.
- Media and legal documents are written only under `Clients/<client>/<project>/`. Nothing else in the tree is touched by the app except `.trash/`.
- `project.json` names the culling and finals subfolders (defaults `raw`, `finals`). Everything else in a project folder is a plain file.
- Photos are keyed by **path relative to the project folder** (e.g. `raw/DSC_0412.NEF`). Moving a project or client folder anywhere under `Clients/` keeps all data. Renaming files inside `raw/` after Lightroom import breaks Lightroom's own link; the UI warns.
- The watcher (chokidar) syncs disk → database for `Clients/`, `Templates/`, `Music/`. Database → disk happens only for JSON edits from the UI, webhook-delivered PDFs into `documents/`, and `.cache/`.
- Malformed JSON: the app keeps the last good version and shows a banner naming the file.
- Concurrent edits (Finder vs browser) are last-write-wins, deliberately.

### `client.json`
```json
{ "name": "Smith Family", "emails": ["sarah@…", "tom@…"], "phone": "", "stripeCustomerId": "cus_…", "listmonkSubscriberId": 12, "referralCode": "SARAH100", "notes": "" }
```

### `project.json`
```json
{
  "title": "Wedding 2026",
  "status": "culling",
  "date": "2026-06-14",
  "package": "wedding-full-day",
  "assignedTo": "sam@studio",
  "folders": { "culling": "raw", "finals": "finals" },
  "allowance": { "included": 40, "purchased": 0, "extraPrice": 1500 },
  "downloads": "client",                 // client | password | none
  "comments": { "culling": true, "finals": true },
  "notifyOnPublish": false,
  "sharePassword": "…",
  "music": "Library/first-dance.mp3",
  "cover": "finals/DSC_0999.jpg",
  "expiresAt": "2027-06-14",
  "offers": { "anniversary-15": true, "prints-16x20": true },
  "portfolioRelease": false,
  "showOffers": true,
  "stripe": { "quoteId": "", "depositInvoiceId": "", "balanceInvoiceId": "", "finalInvoiceId": "" },
  "docuseal": { "contractSubmissionId": "" },
  "calendar": { "callAt": "", "holdUntil": "" }
}
```
Prices are integer cents. Status values are in section 10.

## 4. Data model (SQLite)

Nine tables. Foreign IDs into Stripe, DocuSeal, and listmonk are stored, never their data.

| Table | Purpose | Key columns |
|---|---|---|
| `users` | Admin team | email, name, role (`owner`/`member`), notify_downloads (`off`/`digest`/`each`) |
| `clients` | Mirror of `client.json` | folder_path, name, emails (JSON), stripe_customer_id, listmonk_subscriber_id, referral_code |
| `projects` | Mirror of `project.json` | client_id, folder_path, status, date, json (the full file) |
| `photos` | Media in `raw/` and `finals/` | project_id, rel_path, stage (`culling`/`final`), kind (`photo`/`video`), width, height, captured_at, sort_order, section, draft (bool), edit_state (`none`/`editing`/`done`) |
| `picks` | Client selections | photo_id, by_email, picked_at, state (`confirmed`/`pending`) |
| `favorites` | Guest hearts on finals | photo_id, session_id |
| `comments` | Region/timestamp comments | photo_id, author, stage, x, y, w, h (nullable, 0–1), t (video seconds, nullable), text, created_at, resolved_at |
| `sessions` | Magic links, guest sessions, plugin/MCP tokens | kind (`client`/`admin`/`guest`/`plugin`/`mcp`), token_hash, subject, project_id (guests), scope, expires_at, nickname |
| `events` | Append-only activity log | project_id, actor, type, payload (JSON), at |

`events` feeds the dashboard, activity timelines, insights, analytics, download notifications, and "client last seen." Types include `viewed`, `picked`, `unpicked`, `commented`, `finished_culling`, `extras_purchased`, `published`, `downloaded`, `favorited`, `quote_sent`, `contract_signed`, `invoice_paid`, `form_submitted`, `offer_tapped`, `offer_converted`, `referral_used`, `edit_progress`.

Migrations are versioned and run at startup.

## 5. Auth and access

- **Clients** sign in by magic link (single-use, 30-day validity, hashed). A client sees only projects whose `client.json` lists their email.
- **Admins** sign in by magic link (15-minute validity). Roles: `owner` (everything) and `member` (everything except billing settings, integration keys, team management).
- **Guests** open a share link and enter the gallery password. They get a project-scoped guest session and may enter a nickname. Guests can view and favorite; they cannot comment. They can download only if the project's download rule is `password` and downloads are unlocked (section 10).
- **Session cookies:** `httpOnly`, `secure`, `sameSite=lax`. CSRF token on all state-changing routes. Rate limits per IP and per email on sign-in, per session on downloads.
- **Access middleware:** every photo, pick, comment, favorite, and file route resolves the project from the session, never from a client-supplied client ID. There is one scoping function; routes cannot bypass it.
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

**Extras.** Picks above `included + purchased` are `pending` with a badge. Checkout opens Stripe Checkout (quantity = pending count, price = `extraPrice`). Webhook confirms: `purchased += qty`, picks become `confirmed`. **Finish** is disabled while extras are pending. Admin can convert pending to included ("gift").

**Finish culling.** When picks reach the allowance, Finish shows a confirmation sheet; locks selection; emits `finished_culling`; notifies assigned admin.

**Viewer.** Photo on black. Heart bottom-right; pin count bottom-left when comments are on for that stage. Drag on the image (long-press to start on touch) draws a region; a text field anchors to it. Pins are numbered dots. Videos show a poster and play inline; comments on videos carry a timestamp instead of a region. Swipe down closes.

**Editing progress.** Progress bar from `photos.edit_state` over confirmed picks. Optional per-photo badge (project setting).

**Final gallery.** Same grid, sections from `finals/` subfolders as anchors, cover photo at top, order from `sort_order`. Top bar: Download (single / all, per rule) or **Unlock downloads** if the final invoice is unpaid; Order print (deferred); Share (native share sheet with link + password). Slideshow: Play button on the cover starts the project's music track and a crossfade slideshow of stills only; videos are skipped.

**Guests.** Password screen over a blurred cover with studio name and "Book your own session." Favorites filter shows hearts from all guests. Guest download unlock uses the six-character download code (section 10).

**Offers.** Cards in the gallery's visual language, never during culling, never on the password screen, never over a photo, no motion or timers. Placements: unlock card (un-picked photos, opens culling scoped to un-picked, checkout via extras flow), inline card at most one per 30 photos (dismissable per session), end card (one, not dismissable). Per-project on/off per offer and a global `showOffers` switch.

**Forms.** A form assigned to the project appears under Documents with a "Fill in" badge; fields render as native controls; submission writes PDF + JSON to `documents/`.

**Expiry.** `expiresAt` archives the gallery (viewable by admin only). Reminder email 7 days before.

**Known iOS limit:** zip downloads land in Files; single photo saves to Photos. The sheet says so.

## 7. Admin

Three-pane layout (sidebar, list, detail) on desktop; tab bar + push navigation on phone.

**Sidebar:** Dashboard, Files, Clients, Calendar, Settings.

**Dashboard.** Four blocks, nothing else: Money (outstanding, overdue in red, resend), Waiting on client (unsigned, culling idle, unpaid, with age), Waiting on you (culling finished, unresolved comments, finals not published, inquiries not quoted), Upcoming (shoots and calls by date).

**Files.** Drive-style browser of `/photos`. Create folder, upload any file, drag to move, rename, delete to `.trash/`. Client and project folders carry badges and status pills. **List / Board** toggle: Board is the Kanban of projects by status; dragging a card changes status. Filters: mine / everyone / archived. Search covers client names, project names, photo filenames.

**Project detail.** Header: title, client, date, status pill, context-aware action bar (only the actions valid for the status; the rest under "…"). Segments:
- **Photos:** current stage grid with pick/comment badges; pending extras dashed; drag to reorder finals; set cover; open viewer with reply/resolve controls. **Publish to client** flips drafts live and sends the ready/added email.
- **Activity:** events timeline; unresolved comments pinned to top.
- **Insights:** views, unique visitors, favorites, downloads, activity by day, per-visitor list, per-offer taps and conversions, inquiries sourced from this gallery.
- **Details:** `project.json` as a form (allowance, extra price, download rule, comment toggles, music, cover, expiry, notify-on-publish, assignee, offers, portfolio release status, notes). Files in the project folder with the **Share with client** toggle.

**Clients.** List; detail shows projects, contact info, Stripe balance, listmonk lists, referral credits.

**Calendar.** Month view of shoots, discovery calls, and tentative holds (hollow dots). Edit availability inline. ICS feed URL per admin.

**Settings (one page, grouped):** Studio (name, logo, sender, defaults for allowance, prices, deposit %, balance-due days, hold hours); Team (members, invites, per-member download notifications); Integrations (Stripe, DocuSeal, listmonk, later Printful; each with a connection dot; features hide when unset); Templates (which listmonk template per transactional email); Forms builder; Packages; Offers; Music (library + YouTube field); Access (MCP tokens, plugin tokens, calendar feed).

**Download notifications.** Per admin: Off / Daily digest (9am, grouped by project) / Every download. First download of a project always notifies.

## 8. Templates, forms, packages, offers, calendar, music

**Forms** (`Templates/Forms/*.json`): builder with fields short text, long text, single choice, multiple choice, date, yes/no, file. Reorder, required flag. Attached to packages (sent after booking) or sent ad hoc from a project. Responses → `documents/<Form>.pdf` + `.json`.

**Packages** (`Templates/Packages/*.json`): name, price, included picks, extra price, deposit override, duration, attached forms, contract template (DocuSeal template ID), public page on/off. Public package pages have a date picker and Stripe Checkout; a booking creates client + project in `booked`.

**Offers** (`Templates/Offers/*.json`): title, one line, image, button label, action (`unlock` / `prints` / `link` / `stripe_price`), placement (`unlock` / `inline` / `end`), default on/off.

**Availability** (`Templates/availability.json`): working days, blackout dates, shoots per day, call hours and slot length. Booked projects and holds block dates automatically.

**Music** (`Music/`): picker in project details lists tracks with their source folder. YouTube: paste URL → background job runs `yt-dlp` + ffmpeg → 192 kbps MP3 with title and source URL in tags → `Music/YouTube/`. Licensing of tracks used in client galleries is the studio's responsibility; the picker labels the source folder.

## 9. Lightroom Classic plugin

A **Publish Service** (same mechanism as Lightroom's Flickr plugin), configured once with server URL and a plugin token. Photos are resolved by path: plugin setting "NAS mount path" maps `/photos/Clients/...` to the local mount.

- **Publish collections mirror projects.** Creating a collection in Lightroom creates a project folder; projects created elsewhere appear on refresh. Each collection has a Culling / Finals switch; Finals collections render full-res JPEGs (quality configurable). Culling collections are rarely needed since the NAS previews RAWs itself, but exist for edited-preview culling.
- **Publish** uploads by multipart POST in batches of 20 to `finals/` as **drafts**. Lightroom tracks new/modified/removed. Custom sort order in the collection becomes gallery order.
- **Publish to client** is a menu item on the collection (and a button in the admin) that flips drafts live and sends the email, unless `notifyOnPublish` already did.
- **Sync picks** (service menu, also automatic on plugin load): pulls confirmed picks, resolves paths, and in one write transaction sets flag = Pick and adds to a regular collection `<Project> – Picks`. Idempotent. Un-picks only revert flags the plugin set. Pending extras are not pulled. Unresolvable paths are listed in a summary dialog.
- **Comments** appear in Lightroom's Comments panel via the publish-service comment hooks. Region comments carry a position hint ("top-left: …"); video comments carry the timestamp. Replies from the panel post back.
- **Editing progress**: a background task every 5 minutes checks the Picks collection: sidecar changed since pick → `editing`; present in a live Finals publish → `done`. Reports merge server-side per photo across photographers.
- **Failures:** unreachable server fails the publish with Lightroom's standard error and leaves photos "to be published." Videos are never handled by the plugin.
- The plugin turns on "automatically write changes into XMP" and warns if it's off.

Plugin code: one Lua module for the HTTP API with no Lightroom dependencies, one for Lightroom glue. Shipped as a zipped `.lrplugin` on each release.

## 10. Booking pipeline and payments

**Statuses** (`project.json.status`), in order:

```
inquiry → call → quoted → signed → booked → balance_due → ready → shot
        → culling → editing → delivered → paid → archived
```

**Flow**
1. **Inquiry** (public form, package page, or admin) creates client + project. Reply email offers "Book a discovery call" (in-app slots from availability). Source (gallery, referral code, package page) is recorded.
2. **Call** booked → `call`. After it, admin sends quote → `quoted`.
3. Quote accepted (Stripe Quote) → admin or automation sends contract (DocuSeal) → signed webhook → `signed`, which **automatically issues the deposit invoice** and holds the date for `holdHours` (default 72).
4. Deposit paid → `booked`; date confirmed on calendar; package forms sent.
5. **Balance invoice auto-issued** `balanceDueDays` (default 14) before the shoot; paid → `ready`. Unpaid on the day is a red dashboard item.
6. After the shoot the admin marks `shot` (optional). Files landing in `raw/` move the project to `culling` automatically once previews exist → `editing` on Finish → `delivered` on Publish to client.
7. **Final invoice** gates downloads. Gallery is viewable; Download reads "Unlock downloads" and opens Stripe Checkout for the final invoice. Paid → `paid`; client portal unlocks; a **six-character download code** is emailed. Guests enter it once on the gallery to unlock downloads for the password link (only if download rule is `password`).
8. `archived` at `expiresAt` or by hand.

Deposit is a percentage or fixed amount (studio default, per-package and per-quote override). Splits can be customized per project; the three above are the default. **Mark paid manually (Venmo/Zelle)** exists on every invoice and drives the same transitions.

**Stripe objects:** Customer per client; Quote, Invoices (deposit, balance, final), Checkout Sessions (extras, packages, later prints). Stripe Tax enabled on Checkout. Card data never touches the app. Stripe's own emails are off except receipts.

## 11. Integrations and email

- **listmonk:** inquiry form and favorites-email capture subscribe with source tags. All transactional email goes through listmonk's transactional API using templates chosen in Settings. Stripe and DocuSeal outbound emails are disabled. Marketing lists carry unsubscribe; transactional ignores it.
- **DocuSeal:** templates built in DocuSeal. "Send contract" creates a submission pre-filled from client/project/package. Webhook → `signed`, signed PDF → `documents/`.
- **Stripe:** section 10. Webhooks verified, idempotent on event ID, status-only updates.
- **Nightly reconcile** asks Stripe, DocuSeal, and listmonk for current state to recover missed webhooks.
- **Calendar out:** per-admin ICS feed of shoots, calls, holds, invoice due dates.

**Transactional emails:** inquiry received; call booked; quote; contract; deposit invoice; booking confirmed; balance invoice and reminder; culling ready (magic link); culling idle nudge (3 days); finals ready / photos added; final invoice; download code; expiry reminder; review request (after `paid`); form to fill; referral credit applied; download digest and download alerts (admin).

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

`users` table with `owner`/`member`. Invite by email; magic-link sign-in. `assignedTo` per project. Events record the actor. Board view is the status pipeline; no custom columns.

## 15. Video

Files in `raw/` or `finals/` with video extensions. ffmpeg makes a poster; if not already H.264/AAC MP4, a 1080p web copy goes to `.cache/` as a low-priority job. Inline playback with native controls; download serves the original. Culling supports picking and timestamp comments. Slideshow skips videos. Lightroom never handles video.

## 16. Security

Baked from the "vibecoder review" checklist; the checklist itself lives at `docs/security-review.md` and must be run before each release.

- Secrets in `.env` or encrypted settings; only the public Stripe key reaches the browser; gitleaks in CI.
- Server-side sessions only; roles checked on the server; CSRF; rate limits; hashed single-use magic links; hashed, scoped, revocable tokens.
- Single access-scoping middleware for all project-bound data; signed, session-bound download URLs.
- No seeded accounts, no debug mode, generic errors with request IDs.
- Uploads only from the plugin with a token; extension allowlist verified by magic bytes; size limits; paths validated against traversal; no client-supplied filenames; child processes called with argument arrays.
- Dependabot; `npm audit` fails CI on high; lockfile committed.
- CORS restricted to own origin; helmet-style headers with CSP; HTTPS enforced by tunnel.
- Parameterized queries only; no `dangerouslySetInnerHTML`; comments are plain text.
- Webhooks signature-verified and idempotent.
- No telemetry.

## 17. Error handling

- Watcher: unreadable or malformed JSON keeps last good state and banners the file. Missing referenced files (cover, music) fall back silently and log.
- Preview extraction failure (RAW without a usable embedded JPEG): a placeholder tile, a warning in the project's Insights, and a `preview_failed` event so the photographer can publish an edited preview from Lightroom instead.
- Jobs retry with backoff (3 attempts) and surface in a Settings → Jobs list with a retry button.
- Stripe/DocuSeal/listmonk down: actions fail with a readable message; nothing is half-applied; reconcile repairs later.
- Plugin: standard Lightroom error path; summary dialog for unresolved photos.

## 18. Testing

- Unit: access middleware, allowance/extras math, status transitions, watcher sync, path keying, form schema validation.
- Integration: fixture project folder with real RAW, JPEG, MP4 files; webhook handlers with recorded payloads; listmonk/DocuSeal/Stripe clients against mocks.
- End-to-end: Playwright on an iPhone viewport through sign-in, culling, extras checkout (Stripe test mode), finish, comments, final gallery, unlock, download.
- Plugin: HTTP module tested against the running app; Lightroom glue via a manual checklist in `docs/plugin-testing.md`.
- CI: lint, typecheck, unit + integration on every push; e2e nightly and on release tags.

## 19. Open-source readiness

AGPL-3.0. Single `compose.yml` + documented `.env.example`; multi-arch image on GHCR per tag; first-run setup page. No studio specifics in code. Integrations optional and hidden until configured. README with screenshots, `docs/` (install, plugin, integrations, security review, plugin testing), CONTRIBUTING, CODE_OF_CONDUCT, SECURITY.md, issue/PR templates, CHANGELOG (Keep a Changelog), semver. GitHub Actions publishes the image and the `.lrplugin` zip on tags. `/healthz`. Strings centralized for later translation. Update checks off by default.

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

1. Foundation: compose stack, folder watcher, previews, data model, auth, access middleware.
2. Client portal: sign-in, culling, picks, finish, viewer, comments.
3. Admin: Files browser, project detail, dashboard, settings, team.
4. Lightroom plugin: publish finals, sync picks, comments, progress.
5. Finals gallery: publish-to-client, downloads, share, music, slideshow, sections, expiry, favorites.
6. Stripe: invoices, extras, unlock/download code, manual paid.
7. Booking pipeline, forms, packages, availability, calendar, ICS.
8. listmonk + DocuSeal + transactional email.
9. Offers, growth features, insights, notifications.
10. MCP, video, YouTube music.
11. Security review pass, open-source packaging, docs, release.
