# Lightroom Classic plugin

Kreate ships as a Publish Service for Lightroom Classic (SDK 6+, tested against 15.x).

## Install

1. In Kreate, open **Settings → Access** and create a token (read+write). Copy it; it is shown once.
2. Get the plugin: `plugin/OpenGallery.lrplugin` from the repository, or the zip from a release. Put it anywhere stable (or in `~/Library/Application Support/Adobe/Lightroom/Modules/` to load automatically).
3. Lightroom Classic → File → Plug-in Manager → Add → choose `OpenGallery.lrplugin`.
4. Library → Publish Services panel → **Kreate → Set Up…**: server URL (`https://gallery.your-domain`), the token, and the **NAS mount path**, which is where the shared Photos folder is mounted on this machine (for example `/Volumes/Photos`). Press **Verify connection**.

Turn on Catalog Settings → Metadata → *Automatically write changes into XMP*, so other photographers see your edits.

## Workflow

- **A collection is a project.** Right-click the Kreate service → Create Published Collection, pick the project (or create one for a client). The collection stores the project id.
- **Publish** renders JPEGs and uploads them into the project's `finals/.draft/`. Nothing reaches the client until you publish to client (a later milestone adds that button to the collection and the admin). The first upload of a RAW resolves its source by path under the mount; the id is then remembered on the catalog photo, so renames on the server do not matter.
- **Sync picks** (Library → Plug-in Extras → Kreate: Sync picks) flags the client's submitted picks as Picked and adds them to a regular collection `<Project> – Picks` inside a "Kreate" set. Only flags the plugin set are ever cleared.
- **Comments** show in the Library Comments panel for published finals, including the client's comments on the RAW ("[on the RAW] top-left: soften the shadow"). Replies go back to the client.
- **Report editing progress** (Plug-in Extras) tells the client portal which picks have been edited since submission.

## Troubleshooting

`~/Documents/LrClassicLogs/Kreate.log` records loading, uploads, and errors. "token rejected" means the token was revoked or mistyped; "No response" means the server URL is unreachable from this machine.
