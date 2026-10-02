# Install

Khroma runs as one Docker Compose stack on a NAS. Everything the app writes lives in two folders you choose.

## Prerequisites

- A NAS or server with Docker and Docker Compose (UGOS ships both).
- A domain on Cloudflare and a [Cloudflare Tunnel](https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/) token for it.
- An SMTP account (any provider). Sign-in is by emailed link, so email must work before anyone can sign in.

## First run

```bash
git clone https://github.com/pyamzi/OpenGallery.git && cd OpenGallery
cp .env.example .env
```

Edit `.env`:

- `SESSION_SECRET`: generate one with `openssl rand -base64 48`.
- `BASE_URL`: the public URL, for example `https://gallery.example.com`.
- `SMTP_URL`: your SMTP account, for example `smtp://user:pass@smtp.example.com:587`.
- `CLOUDFLARE_TUNNEL_TOKEN`: from the Cloudflare dashboard.

Choose where data lives (defaults are `./data` and `./photos` next to the compose file). `DATA_ROOT` must be on local NAS disk, never an SMB mount, because it holds the SQLite database.

```bash
DATA_ROOT=/volume1/opengallery PHOTOS_ROOT=/volume1/Photos docker compose up -d
```

Then create the one-time setup link:

```bash
docker compose exec opengallery node dist/server/cli.js setup-token
```

Open the printed URL within 15 minutes, enter the studio name, your email, and the SMTP details, and submit. A sign-in link is emailed to you. Opening it completes setup; until then the app serves nothing else.

## Share the photo tree

Share `PHOTOS_ROOT` over SMB from the NAS so photographers can mount it. The app creates `Clients/` inside it; see the design spec for the folder layout.

## Optional services

```bash
docker compose --profile listmonk up -d     # email marketing and listmonk transactional transport
docker compose --profile docuseal up -d     # contracts and signatures
```

Each has its own admin UI on localhost (listmonk on 9000, DocuSeal on 3001); route them through the tunnel as you like.

## Upgrade

```bash
docker compose pull && docker compose up -d
```

Database migrations run on startup.

## Health

`GET /healthz` returns `{ ok, setup, email }`. `setup` is `unconfigured`, `awaiting_verification`, or `complete`; `email` is whether a transport is configured.
