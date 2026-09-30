# Deploying OpenGallery (hosted)

The App runs on Fly.io, Postgres is Neon, photos live in Cloudflare R2, and email goes out over one platform SMTP sender.

## One-time owner setup

These need your accounts. Nothing here is automated.

1. **Fly.io**: install `flyctl`, then run `fly auth login`.
2. **Neon**: create a project in `aws-us-east-2` (Ohio). Copy the **pooled** connection string (the host contains `-pooler`).
   The first migration runs `CREATE ROLE og_app`, so connect as the role Neon created with the project. Console-created roles belong to `neon_superuser` and have CREATEROLE. If the release step fails on `CREATE ROLE`, this is why.
3. **Cloudflare R2**: create a bucket `opengallery-media`. Then create an R2 API token with *Object Read & Write*, scoped to that bucket, and note the account id, access key id, and secret.
4. **Email**: a transactional provider's SMTP URL (for example Postmark or Resend), plus a verified sender address for `EMAIL_FROM`.

## First deploy

```bash
fly launch --no-deploy --copy-config --name opengallery
fly secrets set DATABASE_URL='postgres://…-pooler…/neondb?sslmode=require' SMTP_URL='smtp://…' EMAIL_FROM='no-reply@…' R2_ACCOUNT_ID=… R2_ACCESS_KEY_ID=… R2_SECRET_ACCESS_KEY=… R2_BUCKET=opengallery-media BASE_URL=https://opengallery.fly.dev
fly deploy
DATABASE_URL='postgres://…' npm run check:tenancy
curl -fsS https://opengallery.fly.dev/healthz
```

- `fly deploy` runs `npm run migrate` as the release step before any new machine takes traffic.
- `check:tenancy` must print `ok: …`. On any `FAIL` line, stop and fix it before inviting anyone.
- `/healthz` returns `{"ok":true}`. Then sign up at `/signup` with a real inbox, open the link, and confirm you land on the Dashboard.

## Everyday deploys

Run `fly deploy`. Migrations run first; a failed migration aborts the release, and the old machines keep serving.

## Rolling back

- **Code**: run `fly releases` and find the last good version, then `fly deploy --image <that release's image>`.
- **Migrations**: they only move forward. Undo a bad one with a new migration, or restore the database (below).

## Restoring the database

Neon keeps point-in-time history (7 days on the free plan, longer on paid plans). In the Neon console, go to *Branches → Restore* and pick a timestamp before the incident. Alternatively, create a branch at that time and point `DATABASE_URL` at it with `fly secrets set`. Then run `npm run check:tenancy` against it.

## Local development

`npm run dev` uses an on-disk PGlite database at `.data/dev` and in-memory photo storage, so no accounts are needed. Emails stay queued unless `SMTP_URL` is set.
