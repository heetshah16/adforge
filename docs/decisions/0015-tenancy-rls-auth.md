# 0015 — Tenancy, RLS and auth

**Status:** accepted · 2026-10-18. Supersedes the "UI-only" part of ADR 0012 for prod.

## Plan amendments (B2)
1. **Drizzle + `withUser`, not PostgREST.** All data access goes through Drizzle over a direct Postgres connection. The Supabase client is used for Auth only.
2. **`DATABASE_URL` selects Postgres in any profile.** Set = Postgres; empty = local PGlite. `ADFORGE_ENV=prod` still requires it.
3. **The Inngest event is sent from the web route in B2**, not from the worker.
4. **Approve is atomic and lives in the web app.** This fixes the B1 race. The worker's duplicate approve route and any unused worker `getJob` route are deleted. A dev script that polled the worker GET route must use the web route.
5. **Magic link only.** Google sign-in is deferred.

## RLS model
- Two roles: the **owner** (migrations, provisioning, admin work; bypasses RLS) and **`authenticated`** (every request made for a signed-in user).
- Request code runs inside `withUser(claims, fn)`: one transaction that sets the role to `authenticated` and the JWT claims, so `auth.uid()` returns the caller. A nesting guard throws if `withUser` is called inside `withUser`.
- On plain Postgres (CI, PGlite) a stub `auth.uid()` is created **only if it is missing**. Supabase's real one is never replaced.
- Grants are narrowed per table: `authenticated` gets only the verbs and columns each table needs. `TRUNCATE` is revoked.
- Tenant tables carry `org_id` with composite `(org_id, id)` FKs, so a row can never point at another org's parent.
- Policies check org membership. Admin-only tables (waitlist) check the admin flag.
- `users.id` = `auth.users.id`. Foreign keys reference `users.id`.
- `projects.user_id` (creator) stays next to the new `org_id`. The plan did not name it for removal.

## Auth and invites
- **Admin bootstrap:** emails in `ADFORGE_ADMIN_EMAILS` (compared lower-cased) are admins. `provision` derives admin status from `serverEnv` itself; callers cannot pass a list.
- **Server-enforced invite gate.** In prod, `provision` refuses to create an org unless the email is an admin, has a waitlist row `invited` or `joined`, or the user already has a membership. A directly created auth user owns nothing: data routes 404 and the user is sent to `/waitlist`. Emails are lower-cased on both sides.
- **The gate trusts `claims.email`, so Supabase "Confirm email" must stay ON** (`mailer_autoconfirm=false`). The config script sets and asserts it.
- **Redirects use `ADFORGE_SITE_URL` only** (`z.url`; default `http://localhost:3000` in dev, required in prod), never request headers. This covers `emailRedirectTo`, invite `redirectTo`, `/auth/confirm`, the proxy and sign-out. Sign-out is POST-only and checks `Origin`.
- **Neutral sign-in message.** Every outcome shows "If this address can sign in, a link is on its way..."; no 429 branch, so no account-enumeration oracle.
- **Email conflict.** If an auth user is deleted and re-created with the same email, the new `auth.users.id` differs from the old `users.id`. Provision fails closed with an "account conflict, ask the admin" page. No auto re-keying (FKs reference `users.id`). Fix: see the runbook.
- **`ADFORGE_ENV` fails closed:** default is `prod` when `NODE_ENV=production`, else `dev`. dev lets anyone sign in; prod is invite-only.
- Proxy is deny-by-default. Public: `/signin`, `/auth/*`, `/waitlist`, `/_next/*`, favicon.

## Supabase project config (`scripts/supabase-auth-config.mjs <ref>`)
Docs: Management API reference https://api.supabase.com/api/v1 (OpenAPI at https://api.supabase.com/api/v1-json: `/v1/projects/{ref}/config/auth`, `/v1/projects/{ref}/postgrest`); https://supabase.com/docs/guides/api/securing-your-api.
- **Data API off.** `db_schema` is set to the empty string. The API accepts it (200); the default was `public,graphql_public`. Verified on dev: `/rest/v1/*` and `/graphql/v1` return 503 `PGRST002`, Auth stays healthy. Reason: members hold a JWT plus the public publishable key and could otherwise write their org's rows (job cost/status, later the credit ledger) directly. If PostgREST, GraphQL or Realtime-over-API is wanted later, re-expose a schema and add column-level grants first. The dashboard "Enable Data API" toggle is the documented alternative; the Management API has no separate flag, so the empty `db_schema` is the scripted equivalent.
- **Confirm email ON:** `mailer_autoconfirm=false`.
- **`site_url`** `http://localhost:3000` (dev); **`uri_allow_list`** exact entries only, no wildcards: `http://localhost:3000/auth/confirm`. Prod: pass `--site-url https://<prod host>`; the allow list becomes the single entry `<site>/auth/confirm` (the script replaces the list, so run it per project).
- **`disable_signup`: keep `false` in prod.** Admin bootstrap creates users with `shouldCreateUser`, and the real enforcement is the server-side gate in `provision`, which refuses uninvited users. Setting `true` would block an admin's first sign-in unless admins were pre-created. The script's `--prod` flag sets it `true` for anyone who does pre-create admins.
- **Email templates** (`mailer_templates_magic_link_content`, `mailer_templates_invite_content`) link to `{{ .RedirectTo }}?token_hash={{ .TokenHash }}&type=email` / `&type=invite`, since the app sends `redirectTo = <ADFORGE_SITE_URL>/auth/confirm`. `/auth/confirm` accepts `email`, `magiclink`, `invite`, `signup`. **Supabase refuses template edits on the default email provider** (400: "not available for free tier projects using the default email provider"). The script skips templates with a warning until custom SMTP is configured. The default templates use `{{ .ConfirmationURL }}`, which does not reach `/auth/confirm` with a `token_hash`, so real emailed links will not sign in until then. E2E uses `auth.admin.generateLink`, which returns `hashed_token`, so it is unaffected.
- **Free-tier Supabase SMTP is rate-limited.** Real email volume, and the templates above, need custom SMTP before launch. That is a **B6** item.

## Deferred, with reasons
- **Migration 0005:** the `assets (org_id, sha256)` unique constraint would fail on a hand-made multi-project POC database that shares a sha256 across projects. Impossible through POC code paths. Dedupe by hand if it ever occurs.
- **Table-wide INSERT** on jobs/assets/projects/products lets a member preset status/cost/`user_id`; waitlist UPDATE is table-wide for admins. Closed in practice by turning the Data API off (all writes go through our routes). Revisit before opening the Data API.
- **Per-row `is_member` cost** in policies: fine now, revisit when tables grow.
- Privilege-matrix test reads column-level grants only for UPDATE.
- Provision runs on every poll (one owner txn per poll); acceptable at current scale.
- Minors left open: `startedAt` on the waitlist form is forgeable (rate limit is the backstop); unknown-IP requests share one rate bucket; `ctx.insert` DB errors surface as unstructured 500; PGlite race test cannot reach the 23505 catch; proxy parses full server env on the redirect path (fails closed); `/email/` regex could match `waitlist_email_unique` (unreachable); possible `signInWithOtp` timing side channel; layout `getClaims` under `/auth/*` not-found can drop a rotated refresh token; `getClaims` cost on HS256 projects; `createSupabaseServer` throw in layout is uncaught; seed `Local` project name vs `(org_id,name)` unique (unreachable); `getDb` caches a rejected promise (latent); `orchestrate.test.ts` boolean-combined assertion; operator type spelled twice; drizzle NOTICE noise in `db:check`; concurrent double-send of an invite; no pagination on `/admin`; unauthenticated `/admin` redirect reveals the route.
- Not adopted: an `email_verified` claim check (magic-link and invite sessions are verified by construction). Revisit if password or OAuth sign-in is added.
- Applied migrations are frozen: schema fixes go in a new migration, never an edit of an applied one.

## Consequences
- Postgres-gated tests run against Supabase dev locally (`ADFORGE_TEST_DATABASE_URL`) and against CI's postgres:17 container; both must pass.
- Turning the Data API off removes the dashboard table API and any client-side `supabase.from()` use. None exists in the app.
