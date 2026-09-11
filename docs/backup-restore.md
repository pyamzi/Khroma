# Backup and restore

## What to back up

| Path | Holds | Notes |
|---|---|---|
| `DATA_ROOT` | `opengallery.db`, `opengallery.db-wal`, `opengallery.db-shm` | Identity, sessions, jobs, and in later milestones picks, invoices, reservations. Never copy the `.db` alone while the app is running. |
| `PHOTOS_ROOT` | The folder tree: RAWs, finals, documents, `client.json`, `project.json` | Files are the content; the JSON files carry human metadata plus projections of database state. |
| `DATA_ROOT/listmonk-db` | Postgres data for listmonk | Only if the `listmonk` profile is enabled. |
| `DATA_ROOT/docuseal` | DocuSeal data | Only if the `docuseal` profile is enabled. |

## How

Use one of:

- A UGOS (or other NAS) snapshot that captures `DATA_ROOT` and `PHOTOS_ROOT` at the same instant.
- `docker compose stop`, copy both roots, `docker compose start`.

Reindexing `PHOTOS_ROOT` alone rebuilds clients, projects, and photos from the folder tree, but does not restore sessions, jobs, or (later) picks and invoices. Those live only in the database.

## Restore rehearsal

Do this once after installing and once a quarter:

1. Restore both roots to scratch paths, for example `/tmp/og-restore/data` and `/tmp/og-restore/photos`.
2. Start a second stack against them on another port:
   ```bash
   DATA_ROOT=/tmp/og-restore/data PHOTOS_ROOT=/tmp/og-restore/photos docker compose -p og-restore up -d opengallery
   ```
3. Check `GET /healthz` reports `setup: complete`.
4. Sign in and confirm a known project lists its photos.
5. `docker compose -p og-restore down` and remove the scratch paths.
