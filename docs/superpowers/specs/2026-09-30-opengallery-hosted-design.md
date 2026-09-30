# OpenGallery Hosted — Design Spec

Date: 2026-09-30. Status: draft for owner review.

Vocabulary follows [`CONTEXT.md`](../../../CONTEXT.md). Decisions behind this spec: [ADR 0001](../../adr/0001-hosted-multi-tenant-service.md) (hosted multi-tenant service) and [ADR 0002](../../adr/0002-no-face-recognition.md) (no face recognition).

This spec **supersedes** the following parts of [`2026-09-10-opengallery-design.md`](2026-09-10-opengallery-design.md): §1 non-goals, §2 architecture and deployment, §3 storage layout (folder tree, JSON sidecars, watcher, write policy, folder identity), §4 SQLite specifics, the bootstrap part of §5, §9 (plugin publishing to a network share), §11 email transport, §13 MCP, §19 open-source readiness, and §21 build order. Every other rule in that spec (culling, allowance and extras, finals gallery, booking pipeline, proposals, offers, comments, team roles, security posture) still holds, now scoped to one Studio.

## 1. What this is

OpenGallery is a hosted service. Any Studio, from a solo photographer or designer to an agency, signs up, keeps its Library in the cloud, delivers photos to Clients, and pulls its own photos and Free media into websites and designs through Claude with one connector.

Success looks like:

- A new Studio goes from "Add custom connector" to a search that returns its own photos in under five minutes, with one email sign-in and no key to copy.
- A Studio's team never sees another Studio's data, and a Client sees only what is published to them.
- Every search result carries a license block and a credit line, and nothing unsafe for commercial design reaches Claude by default.
- Fixed running cost stays under $40 a month until paid Studios exist.

### Non-goals (this spec)

- Self-hosted installs (ADR 0001).
- Face recognition, face clustering, or person tagging (ADR 0002).
- Video in the Library, RAW originals in the Library, imports from Google Drive, Dropbox, or Pixieset.
- Clients connecting their own Claude to the connector.
- Paid scanning services for abuse material.
- Payments from Clients to Studios (the old spec's Stripe installments and extras); these need Stripe Connect and get their own spec.

## 2. Architecture

Two deployables, one database, one bucket.

| Part | Runs on | Does |
| --- | --- | --- |
| **App** | Fly.io, the existing Node 22 + Hono + Drizzle codebase in Docker | Studio web app, Client galleries, uploads, sign-in pages, Stripe webhooks, email jobs |
| **Processing machines** | Fly.io machines started per job from the same image | Resize uploads, pull embedded previews from RAW files for culling, describe images, embed descriptions |
| **Connector** | Cloudflare Workers, grown from today's `free-media-mcp` | The OpenGallery MCP endpoint, OAuth for Claude, Free media search, Library search, image links |
| **Database** | Neon Postgres with `pgvector` | All tables; reached from the App directly and from the Connector through Cloudflare Hyperdrive |
| **Storage** | Cloudflare R2, one private bucket | Library files, web sizes, culling previews |

Why this shape: the App keeps about half of the milestone 1–5 code (auth, jobs, email, comments, access rules, picking and delivery rules, the React front end), and photo processing needs native tools (exiftool, libvips, zip) that Workers cannot run. The Connector is already live and proven on Workers, where the MCP SDK's stateless handler and Hyperdrive fit.

Estimated fixed cost: Fly machine about $11, Neon about $7–10, Workers plan $5, so $23–26 a month before Studios. Per-Studio cost is in §9.

### Porting the milestone code

- Every table gains `studio_id`, every query filters by it, and one access function per request resolves the Studio (the old spec's single scoping rule, extended).
- SQLite synchronous calls become async Postgres calls. The job queue's claim uses `FOR UPDATE SKIP LOCKED`.
- Deleted, not ported: folder scanning, the watcher, JSON sidecars, duplicate adoption, identity conflict resolution, path containment.
- The single-owner bootstrap becomes public Studio signup (§3).
- Existing tests are ported; the 21 that build photo trees on disk are rewritten against an in-memory storage fake.

## 3. Accounts and sign-in

- **Signup:** email address and Studio name. A magic link confirms the email and creates the Studio, its first Team member with role `owner`, and a Trial (§8). Minimum age is 18, stated in the terms and confirmed by a checkbox.
- **Sign-in:** magic links as today (15 minutes for Team members, 30 days for Clients).
- **Team members:** invited by email; the role rules from the old spec's §5 and §14 are unchanged. The Plan caps how many a Studio can have.
- **Clients:** unchanged from the old spec; they belong to one Studio and sign in to their gallery only.
- **Email sending:** the platform sends every email from its own domain through a transactional email provider, with the Studio's name as the display name and the Studio owner's address as reply-to. Per-Studio SMTP and listmonk are dropped.
- **Account deletion:** an owner can delete the Studio; all rows and files are gone within 30 days, and the privacy policy says so.

## 4. Library

The Library is every photo a Studio has uploaded, in or out of a Project, visible only to its team (CONTEXT.md).

- **Uploads:** drag-and-drop in the web app (JPEG, PNG, WebP, HEIC converted to JPEG; 50 MB per file), and the Lightroom plugin publishing exported JPEGs. Files go straight to R2 through presigned upload URLs, then a job is queued.
- **Processing job** (on a processing machine): verify the file signature, store the original, write web sizes (400, 1280, and 2048 px long edge), read EXIF date and Lightroom keywords and caption, then describe and embed (§6).
- **Culling previews:** the plugin uploads the preview embedded in each RAW, not the RAW. Culling previews follow the old spec's culling rules, do not count toward the Plan, are not searchable, and are deleted 30 days after the Client finishes picking.
- **Finals and galleries:** publishing to a Client works as in the old spec's §5–§6, reading from R2 instead of the share. The gallery ZIP download is built on a processing machine and served from R2 through a signed link.
- **Limits:** the Plan's photo count covers Library photos only. An upload that would exceed it is refused with the count and the next Plan.

## 5. The OpenGallery connector

One connector named **OpenGallery**. It replaces the Free Media MCP for signed-in Studios.

- **Sign-in at connect:** OAuth 2.1 through `@cloudflare/workers-oauth-provider` on the Connector, supporting Claude's published client identity (CIMD) and dynamic registration. The authorize step redirects to the App's magic-link page; after sign-in the token carries the Team member and Studio. Access tokens last 1 hour with rotating refresh tokens. Only Team members can connect (no Client access).
- **Tools:** the same three names, extended.
  - `search_media` searches the Studio's Library and Free media in one call. The Library is queried first and its matches fill the result up to `limit`; Free media, interleaved as today, fills any remaining slots. If the Library fills every slot, no Provider is called and no Search is counted. Inputs add `library_only` and `free_media_only` booleans alongside the existing `sources`, `providers`, and license filters.
  - `get_media` accepts Library ids (`library:<uuid>`) and Free media ids.
  - `get_attribution` returns "Photo by <Studio name>" for Library items only if the Studio turns credits on; otherwise it returns no credit line with a note that none is required.
- **Library items in results:** provider `library`, Source the Studio's name, and a fixed "Studio's own" license: code `studio`, commercial use and modification allowed, attribution not required. The Studio accepts responsibility for rights and model releases at upload (terms §10).
- **Links to Library photos:** results carry a short-lived signed URL (1 hour) served by the Connector from R2, enough for Canva's upload-from-URL. `get_media` accepts `permanent: true`, which creates a permanent web link for that one photo: a stable URL on the public image domain, listed in the web app under "Public on the web" and revocable there. Revoking returns 404 from that URL.
- **Free media:** Openverse, Pexels, and Pixabay as today, with Sources and credit rules unchanged. The Connector uses registered Openverse credentials.
- **Old endpoint:** the authless Free Media URL keeps working, Free media only, for 60 days after launch, then returns a plain message pointing to the new connector.

## 6. Search

- **Descriptions:** on upload, a vision model writes a 40–80 word scene description: setting, light, time of day, activity, clothing, composition. The prompt forbids names, identities, and guesses about age or ethnicity (ADR 0002). The model is chosen by a bake-off before H3 starts: 30 photos from the owner's own shoots, captioned by Cloudflare's cheapest vision model and by Claude Haiku, judged on 20 real queries. The losing option stays as a fallback.
- **Embeddings:** Workers AI `bge-base-en-v1.5` (768 dimensions), called over REST from processing machines and through the AI binding from the Connector, stored in a `pgvector` column. One model on both sides keeps vectors comparable.
- **Ranking:** a Library query runs Postgres full-text search over Lightroom keywords, caption, Project name, and Client name, plus vector similarity over descriptions. Keyword hits rank above description-only hits, so Studios who keyword their work get what they tagged.
- **Web app search** uses the same engine for the Library.
- **Usage:** a **Search** is one `search_media` call that queries at least one Free media Provider. Library-only searches do not count, because they spend no provider quota. `get_media`, `get_attribution`, and permanent links never count.

## 7. Data model changes

New tables: `studios` (name, plan, trial_ends_at, grace_ends_at, stripe_customer_id, stripe_subscription_id, credits_on), `public_links` (photo_id, token, created_by, revoked_at), and `usage_months` (studio_id, month, searches). OAuth grants and tokens live in the Connector's KV namespace, as `workers-oauth-provider` requires.

Changed tables: every existing table gains `studio_id` with a foreign key and an index. `photos` gains `r2_key`, `sizes` (JSON), `keywords`, `caption`, `description`, `embedding vector(768)`, `in_library` (false for culling previews), and allows `project_id` to be null for Library items outside a Project. `clients.folder_path` and `projects.folder_path` are dropped.

Invariant tested at the database layer: no query in the App or Connector reads a row without a `studio_id` predicate, enforced by one scoped query helper and a test that fails if a table is read without it.

## 8. Plans, Trial, and Grace period

| Plan | Monthly / yearly | Library photos | Searches a month | Team members |
| --- | --- | --- | --- | --- |
| Free | $0 | 500 | 100 | 1 |
| Solo | $9 / $90 | 10,000 | 1,000 | 1 |
| Pro | $19 / $190 | 50,000 | 5,000 | 3 |
| Agency | $49 / $490 | 150,000 | 20,000 | 10 |

- **Trial:** every new Studio gets 14 days of Pro with no card. On day 15 it moves to Free unless the owner has picked a Plan. Emails go out at day 11 and day 14.
- **Billing:** Stripe Checkout for subscriptions, Stripe Billing for renewals, webhooks through the existing webhook inbox. The Stripe SDK runs in the App on Node, so no Workers workarounds are needed.
- **Limits:** photos and Team members are checked on write; Searches are counted per calendar month in `usage_months` and checked by the Connector before calling Providers. Hitting a limit returns a plain message with the count and the reset date. No sales copy in tool results (directory policy).
- **Grace period:** when a Trial ends or a paid Plan lapses and the Studio is over its new Plan, the Grace period starts: 90 days with no deletion, viewing, downloading, and Client delivery still working, uploads blocked. Emails at day 0, 60, and 83. On day 90 the Studio's chosen photos are kept (default: newest first) up to the Plan's count and the rest are deleted, including from Client galleries, which the emails state.
- **Paid Plans launch last:** Plans ship first with Free and Trial only. Paid checkout is switched on after Pexels and Openverse have answered the owner's emails about a paid tier (§11).

## 9. Costs

| | Monthly | One-time |
| --- | --- | --- |
| Fixed platform | $23–26 | |
| Free Studio, 500 photos | about $0.07 | descriptions about $0.10–1.00 |
| Pro Studio, 50,000 photos | about $6.75 | descriptions about $7–50 |
| Stripe per charge | 2.9% + $0.30, plus 0.7% Billing | |

At full Library, margin after hosting and Stripe is about $7 (Solo), $11 (Pro), and $27 (Agency) a month. About four paid Studios cover the fixed cost.

## 10. Safety, privacy, and legal floor

Required before public signup opens:

- Terms of service: minimum age 18; the Studio warrants it holds rights and model releases for what it uploads; acceptable use; the "Studio's own" license meaning.
- Privacy policy (CalOPPA-compliant): data collected, AI descriptions of photos and that they never identify people, processors (Cloudflare, Fly, Neon, Stripe, the email provider, and the description model's provider), retention and deletion.
- One abuse address and a report form. Reports of non-consensual intimate images are removed within 48 hours along with known copies (TAKE IT DOWN Act practice).
- A DMCA page with the registered agent, notice and counter-notice steps, and a repeat-infringer policy.
- A written NCMEC reporting procedure and a one-year evidence preservation step.
- Cloudflare's CSAM scanning on the public image domain that serves permanent links.
- A lawyer reviews the terms and privacy policy.

## 11. Owner actions (outside the code)

- Choose and buy the product domain, and a separate image domain for permanent links.
- Form a Wisconsin LLC ($130, then $25 a year) and open a Stripe account under it.
- Register the DMCA agent with the U.S. Copyright Office ($6, renews every three years).
- Register an Openverse app and verify its email; request enhanced limits before paid Plans launch.
- Email Pexels (api@pexels.com) for unlimited requests, describing the paid tiers; ask Pixabay the same.
- Pick the transactional email provider and verify the sending domain.
- Confirm Wisconsin sales-tax treatment with a CPA.

## 12. Build order

Each milestone gets its own implementation plan and exits when its gates pass.

1. **H1 Hosted foundation.** Port milestone 1–5 code to Postgres and `studio_id`, R2 storage adapter, Studio signup, delete the folder layer, deploy App to Fly with Neon. Gates: tenant isolation (a second Studio's rows and objects are unreachable through every route), ported test suite green, deploy from a clean checkout.
2. **H2 Library and uploads.** Web upload, processing machines, web sizes, culling previews from the plugin, finals delivery from R2, 30-day culling cleanup, Library view. Gates: upload-to-visible under 60 seconds for a 20 MB JPEG, culling previews excluded from counts.
3. **H3 Search.** Bake-off, descriptions, embeddings, keyword and vector ranking, web app search. Gates: the bake-off's 20 queries find an expected photo in the top 5 at least 16 times.
4. **H4 Connector.** OAuth sign-in at connect, Library in `search_media`, links, usage counting, old endpoint notice. Gates: claude.ai connects with "Sign in now", a signed-in Studio's search returns its own photos first, a Canva import from a short-lived link works, a revoked permanent link returns 404.
5. **H5 Plans.** Free, Trial, limits, Grace period and trim, emails; then Stripe checkout behind a switch. Gates: trial expiry and grace trimming run correctly on a simulated clock.
6. **H6 Launch.** §10 pages and processes, CSAM scanning, security review, restore rehearsal from Neon's point-in-time restore.

After H6, the old spec's remaining milestones (booking and proposals, Client payments through Stripe Connect, contracts, email marketing, offers and growth, Studio MCP tools, video) are re-planned against this architecture with their own specs.

## 13. Assumptions made while writing (for review)

- The repository stays open source under its current AGPL-3.0 license; only the self-hosting packaging work (old §19) is dropped.
- Emails come from the platform's domain with the Studio as display name (§3), rather than each Studio's own domain.
- Library-only searches are free and unlimited (§6).
- Library credits are off by default (§5).
- Supported upload formats and the 50 MB file cap (§4).
