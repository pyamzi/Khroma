# Milestone 4 gate record: Lightroom Classic plugin

**Date:** 2026-09-12
**Branch:** agents/implement-opengallery-milestone-4 at `22d36cb` (this record is committed on top), stacked on milestone 3
**Spec:** docs/superpowers/specs/2026-09-10-opengallery-design.md §5 (plugin tokens), §9 (plugin), §3 (drafts), §18 gate *Publication* (M4 part)
**Plan:** docs/superpowers/plans/2026-09-12-m4-lightroom-plugin.md

## Automated evidence

`npm run typecheck && npm test` on Node 24.18.0 with Lua 5.5.1 (Homebrew) and its `luac`:

```
Test Files  36 passed (36)
     Tests  136 passed | 1 skipped (137)
```

| Area | Evidence |
|---|---|
| Plugin tokens (§5) | `tests/domain/tokens.test.ts`: raw token shown once and never stored; listing hides it; revoke → session gone; a project-scoped token sees one project; archived projects never. `tests/http/plugin.test.ts`: bearer auth, admin cookies rejected on plugin routes, read-only token gets 403 on writes, revoked token gets 401. |
| Publication gate, M4 part (§18) | `tests/domain/finals.test.ts` and `tests/http/plugin.test.ts`: identical basenames from two RAWs become `DSC_0001.jpg` and `DSC_0001 (2).jpg`; a re-export from the same RAW replaces its own draft (same row); same upload id and bytes are idempotent; drafts are invisible to clients and their previews 404 for clients while admins can fetch `?draft=1`; deleting a live final is refused with `live_until_published`. |
| Picks, comments, progress (§9) | Only submitted-round confirmed picks are returned, with current paths; comments carry position hints (`top-left` … `centre`) or timestamps and the source RAW for finals; a reply from the plugin lands as an admin comment; progress writes `editing` only for submitted RAWs and never overwrites `done`. |
| Lua client (§9 "tested against the running app") | `tests/plugin/api.test.ts` runs `tests/plugin/api_test.lua` with a plain interpreter and a curl adapter against the in-process server: JSON round trips, me/projects/resolve/upload×3/picks/comments/reply/progress/delete, plus the "token rejected" and "No response" error paths. |
| Syntax | `tests/plugin/luac.test.ts`: every `plugin/**/*.lua` compiles with `luac -p` (Homebrew 5.5 here; the SDK 5.1 compiler when present). |

## In-app spike: not completed

- The plugin was installed to `~/Library/Application Support/Adobe/Lightroom/Modules/OpenGallery.lrplugin` (Lightroom loads that folder automatically) and Lightroom Classic 15.5.1 was launched. Within two minutes no window appeared and `OGInit.lua` had not written its load line to `~/Documents/LrClassicLogs/OpenGallery.log`; plugins load only after a catalog opens, so a startup dialog is the likely reason. A crash-processor process from the first launch attempt was also observed; no crash dump was found in `~/Library/Logs/Adobe/CrashPadDumps` for the last ten minutes.
- The machine was in active use by the owner at the time, so the GUI spike was stopped rather than continued. **The plugin remains installed in the Modules folder; delete that folder to remove it.**
- Remaining manual steps are the checklist in `docs/plugin-testing.md`; the first item (Plug-in Manager shows *Installed and running*, log has a "plugin loaded" line) is the spike the plan asked for.

## Environment notes

- The SDK's `Lua Compiler/mac/luac` binary vanished from the References folder after being made executable and run once (a "permission denied" then "no such file" sequence, consistent with macOS removing an unsigned binary). It was not deleted by a command in this session. Re-extract it from the SDK zip; the syntax test picks it up automatically when present.

## Deferred, recorded

- Culling-rendition uploads (edited previews for the culling grid), retirement of live finals, the automatic five-minute progress timer (menu item for now), `imposeSortOrderOnPublishedCollection` and Publish-to-client (M5), release asset on tags (M11).
