# Milestone 3 gate record: Admin core

**Date:** 2026-09-11
**Branch:** agents/implement-opengallery-milestone-3 at `3764f20` (this record is committed on top), stacked on milestone 2
**Spec:** docs/superpowers/specs/2026-09-10-opengallery-design.md §3 (identity, write policy, trash), §7 (admin), §14 (team), §18 gates *Identity*, *Write policy*, *Minimum install*
**Plan:** docs/superpowers/plans/2026-09-11-m3-admin-core.md

## Automated evidence

`npm run typecheck && npm test && npm run test:e2e` on Node 24.18.0, Playwright 1.63 (Chromium):

```
Test Files  31 passed (31)
     Tests  116 passed | 1 skipped (117)
Playwright  2 passed (culling on iPhone 13 viewport; admin at 1280×800)
npm audit --audit-level=high: exit 0
```

| Gate | Evidence |
|---|---|
| Identity | `tests/domain/files.test.ts`: rename within a client and a plain file move keep the project id and its photos; a cross-client project move refuses without `confirm`, moves nothing, then transfers with the same id and approves; trash keeps rows and ids (project `available=false`, photos intact), restore brings the same id back at the original path, purge removes only old entries. `tests/domain/identity.test.ts`: a copied project folder is adopted with a fresh id, default machine fields, kept human fields and no picks, and the original keeps its id and picks; a renamed RAW is remapped onto its missing row keeping picks and comments, and stays stable on re-index. `tests/http/admin.test.ts` exercises the same through the API (`needs_confirm` → 409, adopt, remap). |
| Write policy (admin surface) | `tests/domain/files.test.ts`: reserved directories and metadata files refused for mkdir, upload, move, trash; traversal refused; a folder cannot be moved into itself; uploaded names are sanitised to the basename; oversize refused by kind (attachment vs media limits); executables refused; no `.part` files left behind; upload into a missing folder refused. `tests/http/admin.test.ts`: download sends `nosniff`, `attachment` for unknown types and `inline` for images, refuses `client.json`; upload of `run.sh` → 415; reserved mkdir → 422; traversal → 400. |
| Minimum install | `tests/domain/settings.test.ts`: email status reports configured/unconfigured; a delivery test is a job whose state is the evidence (`pending` → `done`, or `pending` with the transport error visible). `tests/http/admin.test.ts`: `POST /api/settings/email/test` then `GET /api/settings` shows `lastTest.state = done`. |
| Team (§14) | Owner-only studio/email/invite/remove; a member may change only their own notifications; the last owner cannot be demoted or removed; nobody can remove themselves; invites send an admin magic link. |
| Dashboard (§7) | `tests/domain/dashboard.test.ts` and the API test: waiting-on-you (picks in, comments to answer, drafts, failed previews, jobs needing review, file issues), waiting-on-client (culling idle > 3 days), upcoming by date, money empty until M7. |
| End to end | `tests/e2e/admin.spec.ts`: owner signs in, dashboard empty states, creates a client and a project with defaults, renames via Details, creates a folder and uploads in Files, trashes and restores, resolves a client comment in the viewer, invites a member, sends a delivery test and sees `done`, finds the project on the Board. |

## Manual checks (in-app browser)

- Desktop 800px+: sidebar with Dashboard / Files / Clients / Settings and a disabled Calendar (M6); dashboard's four cards with honest empty states; Files breadcrumb, badges, status pill, List/Board toggle, Trash link.
- Phone 375px: **found and fixed** a horizontal overflow on Settings caused by number inputs' intrinsic width inside a two-column grid (`min-width: 0` on form controls and grid children). After the fix: `scrollWidth === clientWidth`, bottom tab bar with four items visible, cards fit.

## Deviations, recorded

- **Board** shows production columns only; booking columns and the transition service arrive with M6. Dragging supports `not_started → shot`; other drags explain why the step is automatic.
- **Publish to client** button is present but disabled until M5.
- **Integrations, Templates, Forms, Packages, Offers, Music, Access** are listed as disabled rows with their milestone.
- Uploads are whole-file (`ponytail:`); chunked uploads stay deferred per the spec.
- Rename in the project header uses a native prompt; a proper inline editor can come with the design pass.

## Open items

- Real-device pass on an iPhone for the admin tab bar and sheets.
- Board drag on touch devices is not implemented (HTML5 drag-and-drop only); use the project action bar on phones.
