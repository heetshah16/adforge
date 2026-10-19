# AdForge runbook

Operational procedures. Sections marked TBD are filled in by the milestone named.

## Start and stop
TBD in B4

## Alerts
TBD in B5

## Kill switch
TBD in B5

## Quota
TBD in B5

## Key rotation
TBD in B6

## Restore
TBD in B6

## Database: running `pnpm db:check`

`pnpm db:check` compares the column schema of a PGlite database (in memory) with a Postgres database and reports any difference. It is the parity check between dev and prod.

**It applies migrations to the target database.** It is not read-only. Pending Drizzle migrations run against the Postgres database before the comparison.

**Env vars**
- `ADFORGE_TEST_DATABASE_URL`: Postgres URL to check. Takes precedence.
- `DATABASE_URL`: used if `ADFORGE_TEST_DATABASE_URL` is unset.

**Exit codes**
- `0`: schema parity ok.
- `1`: column differences were printed, or the Postgres database could not be opened or migrated.
- `2`: neither env var is set.

**Local example**
```
ADFORGE_TEST_DATABASE_URL=postgresql://user:pass@host:5432/db pnpm db:check
```
Use a database you are willing to migrate.

## Auth & tenancy

See ADR 0015. Web env lives in `apps/web/.env.local`; the Supabase admin token is `SUPABASE_TOKEN` in `.env.supabase`.

**Invite a brand**
1. The brand submits the public form at `/waitlist`.
2. An admin opens `/admin` and invites the row. Supabase emails the invite (default mailer, `{{ .ConfirmationURL }}`); the link lands on `/signin?invited=1`, which says "You're invited". The user then enters their email and requests a sign-in link (the invited auth user already exists, so this works even though prod forbids new accounts). The row becomes `invited`, then `joined` after first sign-in.
3. Prod lets in only invited users and admins. Emails are compared lower-cased.

**Make someone an admin**
Add their email to `ADFORGE_ADMIN_EMAILS` (comma list) and restart the web app. They sign in with a magic link as usual.

**Rotate the secret key**
1. Supabase dashboard > Project Settings > API Keys: create a new secret key.
2. Set `SUPABASE_SECRET_KEY` in the web app env and redeploy.
3. Confirm sign-in and an `/admin` invite work, then delete the old key.

**Re-apply the auth config**
`node scripts/supabase-auth-config.mjs <project-ref>` (dev ref `pdxtuejlluzylgyvonii`; add `--site-url https://<host>` for prod). Idempotent; prints only the field names it changed and verifies with a GET. It sets the site URL, the exact redirect allow list, Confirm email ON, and turns the Data API off. Email templates apply only once custom SMTP is configured (B6). Until then, sign-in emails use the default `{{ .ConfirmationURL }}` PKCE link, which `/auth/confirm` handles via `?code=` (open it in the same browser that requested it, since the verifier cookie lives there). The free-tier mailer is heavily rate-limited, so expect `over_email_send_rate_limit` under load.

**Resolve an "account conflict" sign-in**
An auth user was deleted and re-invited, so the new `auth.users.id` differs from the stale `users` row with the same email. An admin deletes that stale `users` row (confirm it owns nothing worth keeping; FKs reference `users.id`). The user then signs in again and provision creates a fresh account.

**Run `db:migrate`**
`DATABASE_URL` must be set in the shell running it, otherwise it exits with code 2 (there is no PGlite fallback).

## Media (R2)

**Buckets**
- `adforge-dev` (dev, local testing, e2e) and `adforge-prod` (prod). Both private.
- Created with `npx wrangler@4 r2 bucket create <name>`.

**Dev bucket CORS**
Create `cors-dev.json` from the JSON block below (it is not in the repo), then set it with `npx wrangler@4 r2 bucket cors set adforge-dev --file cors-dev.json --force`.
```json
{"rules":[{"allowed":{"origins":["http://localhost:3000"],"methods":["PUT","GET","HEAD"],"headers":["content-type","x-amz-checksum-sha256","if-none-match"]},"exposeHeaders":["ETag","Content-Length","Content-Type"],"maxAgeSeconds":3600}]}
```

**Prod bucket CORS**
Not set yet. Set it in B4 when the site domain exists, with the same rule and origins = the site URL.

**Prod bucket lock**
- Rule `retain-30d`, all prefixes. Objects cannot be deleted or overwritten for 30 days.
- Add with `npx wrangler@4 r2 bucket lock add adforge-prod retain-30d "" --retention-days 30 --force`.
- Check with `npx wrangler@4 r2 bucket lock list adforge-prod`.

**Env vars**
In `.env` for the worker; in `apps/web/.env.local` / Vercel env for the web app.
- `ADFORGE_PROVIDER_STORAGE=r2`, `R2_ACCOUNT_ID`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`, `R2_BUCKET`.
- Optional `R2_TIMEOUT_MS` (default 30000) and `ADFORGE_MEDIA_TTL_SEC` (default 900, range 60–3600).
- Prod requires `r2`. Web and worker must use the same `ADFORGE_PROVIDER_STORAGE` profile.
- Under r2 the web's media URLs (`/media/<key>`) are built from `ADFORGE_SITE_URL`, not `ADFORGE_PUBLIC_URL` (that one is the worker's).
- Never commit or paste these values anywhere.

**Rotate the R2 token**
1. Cloudflare dashboard > R2 > Manage R2 API Tokens: create a new token (Object Read & Write, both buckets).
2. Update `.env` and Vercel env.
3. Restart the worker and redeploy web.
4. Revoke the old token.

**Worker cache**
`<ADFORGE_DATA_DIR>/media-cache` is a read-through copy of R2. Safe to delete at any time; it refills on demand.

**Record the live provider fixture again**
`pnpm --filter @adforge/provider-r2 record:live` (writes only to `adforge-dev`).

**Run the media e2e**
`pnpm e2e:r2` (no GPU). Required env:
- `ADFORGE_ENV=prod` and `ADFORGE_PROVIDER_STORAGE=r2`.
- `DATABASE_URL` = the dev Supabase database.
- The `R2_*` vars. The bucket is hardcoded to `adforge-dev`.
- FFmpeg on PATH.

A re-PUT of an existing key into the locked prod bucket is refused (412/403), which is why `R2Storage.put` HEADs first and skips the PUT when the object exists.
