# AdForge runbook

Operational procedures. Sections marked TBD are filled in by the milestone named.

## Start and stop

The GPU machine runs one supervisor (`scripts/supervisor.ps1`). It starts ComfyUI, voice, voice-qwen, vision and the worker hidden, and restarts each per `scripts/supervisor.config.json`: `restartOn` (`any`, or a list of exit codes; the three Python services restart only on watchdog exit 3), at most `maxRestarts` restarts in `windowMin` minutes, `backoffSec` apart. Past the limit it logs `gave-up` and leaves that service down. The Inngest dev server is not part of it (dev only; prod uses Inngest Cloud).

**Start by hand:** `powershell -ExecutionPolicy Bypass -File scripts\supervisor.ps1` (or `scripts\stack.ps1` for visible windows in dev).
**Stop:** Ctrl-C in the supervisor window, or create `<ADFORGE_DATA_DIR>\supervisor.stop`. Either kills every child tree (`taskkill /T /F`).
**Stopping cleanly:** only the stop file or Ctrl-C is clean. Killing the supervisor process itself (`Stop-ScheduledTask`, logoff, `taskkill`) orphans its children (there is no Job Object); stop the leftovers by hand before starting again.
**Do not start a service by hand** (`scripts\voice.ps1` etc.) while the supervisor or its task is running: port clash.

## Supervisor install and uninstall

Run these yourself. Nothing else registers the task.
- Install: `powershell -ExecutionPolicy Bypass -File scripts\install-supervisor.ps1`. It registers the logon task "AdForge supervisor" for your user (restarted up to 3 times, 1 minute apart, if it fails; no time limit). Add `-WhatIf` to see the command line without registering.
- Start it now: `Start-ScheduledTask -TaskName 'AdForge supervisor'`.
- Uninstall: `powershell -ExecutionPolicy Bypass -File scripts\install-supervisor.ps1 -Uninstall`.
- The task runs only while you are logged on. Keep the machine from sleeping while the queue should drain.

## Logs

All under `<ADFORGE_DATA_DIR>\logs` (keep this outside OneDrive).
- `supervisor-YYYYMMDD.log`: JSON lines (date is local time), events `started`, `exited`, `exited-final`, `gave-up`, `stopped`, `start-failed`.
- `worker-YYYYMMDD.log`: JSON lines (`ts`, `level`, `msg`, fields), also on the worker's stdout. A new file each day (the date is UTC); the newest 14 are kept. Keys containing `key`, `secret`, `token`, `password` or `database_url` are logged as `[redacted]`.
- `<service>.out.log` and `<service>.err.log`: raw stdout and stderr of each child, overwritten each time that service restarts.

## GPU offline

The web UI shows "GPU offline, queue paused" when the worker's heartbeat is stale (over 2 minutes). Queued jobs wait; running jobs are not failed while offline; a job queued longer than 24 h is failed.
1. Is the supervisor running? `Get-ScheduledTask 'AdForge supervisor'`, and a `powershell` process running `supervisor.ps1`.
2. Last lines of `supervisor-YYYYMMDD.log`: a `gave-up` for the worker means it crashed 5 times in 10 minutes. Read `worker.err.log` and `worker-YYYYMMDD.log` (heartbeat, shutdown and request errors are logged there as `level: error`), fix the cause, then restart the supervisor.
3. Worker up but still offline: check `worker-YYYYMMDD.log` for a `heartbeat write failed` entry (database URL, network) and that `ADFORGE_ENV=prod` and the Inngest keys are set in `.env`.
4. The machine slept or rebooted: log on again (the task starts at logon) and wait one heartbeat interval.

## Alerts
TBD in B5

## Kill switch
TBD in B5 (placeholder: the supervisor stop file above stops the whole local stack, not just new submissions).

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

## Deploy (Vercel)

Project settings: link the GitHub repo, **Root Directory** `apps/web`. **Do not override the Build Command**: the default runs the package `build` script, which copies the HyperFrames assets before `next build` (pnpm skips `pre*` scripts). Sources and DB notes: `docs/providers/vercel.md`.

**Env vars (names only; set with `vercel env add`, Production + Preview as noted)**
- `ADFORGE_ENV=prod` (production), `ADFORGE_SITE_URL` (must be `https://`; prod fails to boot otherwise).
- `DATABASE_URL`: the Supabase **transaction pooler** string (`...pooler.supabase.com:6543`, user `postgres.<ref>`). Prepared statements are off; the 15 s statement timeout is applied per transaction in `withUser` (the pooler ignores session and startup settings).
- `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY`, `SUPABASE_SECRET_KEY`, `ADFORGE_PUBLIC_URL`, `ADFORGE_ADMIN_EMAILS`.
- `ADFORGE_PROVIDER_STORAGE=r2`, `R2_ACCOUNT_ID`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`, `R2_BUCKET`, `ADFORGE_MEDIA_TTL_SEC` (optional `R2_TIMEOUT_MS`).
- `INNGEST_SIGNING_KEY`, `INNGEST_EVENT_KEY`. Preview/branch deployments also need `INNGEST_ENV` and that environment's own signing key.

**Inngest**
- The web serves app `adforge-web` at `/api/inngest` (signed; anonymous PUT sync is disabled). Sync with the Inngest Vercel integration (every deploy) or from the Inngest UI.
- Vercel Deployment Protection must let Inngest reach `/api/inngest`: disable it for that project, or enable "Protection Bypass for Automation" and put the secret in the integration's "Deployment protection key"; redeploy previews to resync.

**R2 bucket CORS for the site origins**
Same rule as the dev bucket (see Media (R2)), with `origins` = the prod site URL and each preview origin:
`npx wrangler@4 r2 bucket cors set adforge-prod --file cors-prod.json --force`
