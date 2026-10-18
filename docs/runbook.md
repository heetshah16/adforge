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
`DATABASE_URL` must be set in the shell running it, otherwise it uses local PGlite.
