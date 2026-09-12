# Plugin manual checklist (Lightroom Classic)

Automated coverage: `tests/plugin/luac.test.ts` compiles every file; `tests/plugin/api.test.ts` drives `OGApi.lua` through the real HTTP API with a plain Lua interpreter. Lightroom itself cannot be scripted, so these steps are run by hand before a release.

Setup: `npm run demo` (prints an owner link and a client link), create a token in Settings → Access, a small catalog whose RAWs live under the demo photos dir (`Clients/<client>/<project>/raw`), and the mount path set to that dir.

- [ ] Plug-in Manager shows OpenGallery as **Installed and running**; `~/Documents/LrClassicLogs/OpenGallery.log` has a "plugin loaded" line.
- [ ] Publish service setup: Verify connection reports the studio and token name; a wrong token reports "token rejected".
- [ ] Create Published Collection: project popup lists projects "Title · Client"; choosing one stores it; creating a new project makes it appear in the admin Files browser.
- [ ] Add two RAWs, Publish: both appear as **Draft** in the admin project Photos tab; the client gallery does not show them; the log shows "source <id>" for each.
- [ ] Publish again after a develop change: the same draft is replaced (no duplicate row).
- [ ] Rename the exported file (export preset) and publish: a new draft name, still linked to the same RAW.
- [ ] Remove a photo from the collection, Publish: the draft is withdrawn from the admin view.
- [ ] Client finishes a round in the demo portal → **Sync picks**: picks flagged, `<Project> – Picks` collection created, dialog lists counts; a RAW moved outside the mount is listed as not found.
- [ ] Client comments on a RAW and on nothing else → Comments panel on the published final shows "[on the RAW] top-left: …"; reply from the panel appears in the client portal.
- [ ] Edit a picked RAW → **Report editing progress**: portal shows "We're editing · 1 of N done" only after publication (M5); until then the pick shows as editing in the admin.
