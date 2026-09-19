# Milestone 2 gate record: Client culling portal

**Date:** 2026-09-11
**Branch:** agents/implement-opengallery-milestone-2 at `1387560` (this record is committed on top), stacked on milestone 1
**Spec:** docs/superpowers/specs/2026-09-10-opengallery-design.md §4, §6, §10, §18 gates *Rounds*, *Extras* (without payment), *Workflow* (culling cases)
**Plan:** docs/superpowers/plans/2026-09-11-m2-culling-portal.md

## Automated evidence

`npm run typecheck && npm test && npm run test:e2e` on Node 24.18.0, Playwright 1.63 (Chromium, iPhone 13 viewport):

```
Test Files  25 passed (25)
     Tests  94 passed | 1 skipped (95)
Playwright  1 passed
```

| Gate | Evidence |
|---|---|
| Rounds | `tests/domain/transitions.test.ts`: finish 2 of 40 (under allowance) freezes the round into `finished_culling`, locks picks, opens round 2, moves to `editing`, projects to disk, emails the assignee; zero picks rejected with `no_picks`. `tests/http/portal.test.ts`: locked picks answer 422 after finish; `progress` reports `0 of N done`. Post-delivery additional rounds are M9. |
| Extras (no payment) | `tests/domain/selection.test.ts`: two client emails pick the same photo once; confirmed in `picked_at` order; overflow pending; unpick promotes the oldest pending; grant promotes; negative grant demotes; the same reference cannot grant twice; deficit counts only against submitted picks; `setIncluded` refuses to go below submitted. `tests/http/portal.test.ts`: stale `selectionVersion` → 409 carrying the current version; extras request emails the studio once per count; clients cannot grant; admin gift promotes pending picks. |
| Workflow (culling) | `tests/domain/transitions.test.ts`: first usable RAW moves `not_started → culling` with `stateVersion` 2 and the file updated; a later RAW never regresses `editing`; finish guards for pending picks, unpaid extras invoice, needs-review invoice, deficit, not-culling; conflict on stale version; `stateVersion` 3 after finish. |
| Comments | `tests/domain/comments.test.ts` (region bounds, timestamp-vs-region by kind, per-stage toggle bypassed by admins, resolve/unresolve, counts), `tests/http/portal.test.ts` (client add, admin resolve, 404 for strangers). |
| Identity / write policy (regression) | M1 suites unchanged and green. `tests/fs/projection.test.ts`: `allowance.slots` projects `included + Σ grants` and rescan does not flag it as drift. |
| End to end | `tests/e2e/culling.spec.ts`: sign-in from the emailed link, single project lands on its home, pick to the allowance, third pick shows the extras bar, request emails the studio, unpick, open viewer, draw a region with the mouse, post a note, pin appears, finish sheet shows the real count, project home reads "We're editing · 0 of 2 done", studio emailed. |

## Manual checks (in-app browser, 375×812 mobile emulation with touch)

Run with `npm run demo`, which boots the e2e harness and prints a signed-in link.

1. Project home, culling grid (edge-to-edge, three across, 44pt hearts, sticky count bar with Finish disabled at zero) render as designed in light mode.
2. **Rapid taps:** three quick heart taps initially registered only the first; taps two and three raced the first response and were dropped with 409. Fixed in `1387560` (client-side request queue that always sends the latest version, one retry after a conflict). Re-checked: all three register, two confirmed (white) and one pending (amber), bar reads "1 extra photo · $15 · Request".
3. **Touch drawing:** in the viewer, a synthetic hold (650 ms) then drag drew the yellow region and opened the note field; posting produced pin "1" at the region centre and "1 comment · hold to draw" in the footer.
4. Not checked here: pinch density, swipe-to-close on a real device, and Safari specifically (the e2e runs Chromium). These need a real iPhone; see "Open items".

## Deviations from the spec text, with reasons

- **`selectionVersion` instead of `stateVersion` for pick concurrency.** `stateVersion` is a machine field projected into `project.json`; bumping it on every heart tap would rewrite the file constantly. Picks use a database-only `selection_version`; `stateVersion` still covers workflow transitions and is projected.
- **Video** tiles show a placeholder and take timestamp comments; posters and playback arrive in M10.
- **Pull to refresh** is refresh-on-visibility for now.
- **Admin UI** for grants, allowance, and cancel-round is M3; the routes exist and are tested so the MCP and tests can use them.

## Bugs found and fixed while gating

- Preview extraction failed on JPEG-compressed TIFFs: exiftool returns an abbreviated JPEG strip that will not decode, and the whole preview errored instead of falling back to the source (`7992b4f`).
- Rapid taps dropped picks (`1387560`, above).

## Open items

- Real-device pass on an iPhone (Safari, Add to Home Screen, pinch density, swipe gestures) before v1.
- `ponytail:` ceilings added: in-process view throttle for `viewed` events; single client-side pick queue per page.
