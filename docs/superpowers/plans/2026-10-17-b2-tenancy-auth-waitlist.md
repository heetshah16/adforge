# B2: Tenancy, identity, waitlist and invites — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task by task. Steps use checkbox (`- [ ]`) syntax.

**Goal:**
- Brands' data is isolated in the database (orgs, memberships, RLS).
- People sign in with Supabase Auth magic links, invite-only in prod.
- Anyone can join a waitlist, and the admin invites from it.
- The Next app becomes the control plane: it reads data and creates jobs under RLS, and no longer goes through the worker's HTTP API.

**Architecture:**
- **Supabase is used for Auth and Postgres only.** The app talks to Postgres through **Drizzle**, not PostgREST, so it shares the repo's schema types and runs on PGlite in tests.
- **User-scoped queries run inside `withUser(db, userId, fn)`.** That's a transaction that does `set local role authenticated` and sets `request.jwt.claims`, so RLS applies. Only provisioning, admin and the worker use the owner connection.
- **In dev, the web app and the worker both use the Supabase dev project** (`DATABASE_URL`). PGlite stays for `pnpm test`.
- **Job submission moves to a Next route handler.** It validates, stores photos (dev: local disk; R2 in B3), inserts the job under RLS, and sends `adforge/job.requested` to Inngest.

**Tech stack:** Next 16.3.8 (App Router, `proxy.ts`), `@supabase/ssr` **0.12.7**, `@supabase/supabase-js` **2.117.2** (both at least 14 days old), Drizzle 0.45.4, postgres 3.4.9, Inngest 4.21.1, Playwright 1.63.0.

**Specs:**
- [bridge roadmap §B2](2026-10-17-bridge-roadmap.md);
- [bridge design §5.1, §5.2, §5.6, §6](../specs/2026-10-17-poc-to-prod-bridge-design.md).

**Amendments to roadmap §B2** (recorded in ADR 0015):
1. App data goes through Drizzle plus `withUser`, not the Supabase server client.
2. `openDbForEnv` uses Postgres whenever `DATABASE_URL` is set, in either profile.
3. The job route sends the Inngest event in B2 (dev server), because jobs must keep running. B4 adds the dispatcher.
4. Approve moves to the web on Postgres, so B1's deferred approve race is **fixed here** with an atomic statement.
5. Google sign-in is deferred until the user provides OAuth credentials; B2 is magic link only.

## Global Constraints
- The roadmap's Global Constraints apply, in particular:
  - exact pins at least 14 days old, never `minimumReleaseAgeExclude`;
  - `pnpm test` before every commit;
  - commits with `git -c user.name=heetshah16 -c user.email=shahheet85@gmail.com` and a `Co-Authored-By` trailer naming the implementing model;
  - stage specific paths only, never push;
  - match surrounding style with no formatter runs.
- **Secrets:** they live in gitignored files only:
  - repo root `.env.supabase`: `SUPABASE_DEV_URL`, `SUPABASE_DEV_PUBLISHABLE_KEY`, `SUPABASE_DEV_SECRET_KEY`, `SUPABASE_DEV_DATABASE_URL` (session pooler :5432), `SUPABASE_TOKEN`, `SUPABASE_DEV_REF=pdxtuejlluzylgyvonii`;
  - `apps/web/.env.local` (created in Task 3).
  - Never print or commit a secret value.
  - `.env.example` gets every new key name with an empty value.
- **Auth verification:** server code verifies identity with `supabase.auth.getClaims()`, **never `getSession()`** (Supabase SSR docs). The session-refresh file is `apps/web/proxy.ts` (Next 16 renamed `middleware.ts`).
- **Env names:** `NEXT_PUBLIC_SUPABASE_URL` and `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY` for the browser and server clients; `SUPABASE_SECRET_KEY` (server only) for admin invites. The magic-link confirm route is `/auth/confirm`, using `verifyOtp({ token_hash, type })`.
- **Migrations:**
  - schema changes come from `drizzle-kit generate`;
  - backfills and RLS go in **custom** migrations (`drizzle-kit generate --custom --name <name>`, then filled in);
  - generated SQL is never hand-edited;
  - every migration must apply on **both** PGlite and Postgres (`pnpm db:check` stays green).
- **RLS everywhere:**
  - every table carrying `org_id` has policies;
  - registry tables are select-only for `authenticated`;
  - `waitlist` is admin-only;
  - `anon` gets nothing;
  - the RLS suite enumerates tables, so a new table without coverage fails CI.
- **Data access:** web data functions only accept a `UserDb` (the branded handle `withUser` provides). The owner connection is used only in modules named `*-owner.ts` (provisioning, admin, waitlist insert).
- **Partial success and the job/variant lifecycle are unchanged.** Worker behaviour changes only in where org and project come from.

## Review Focus
1. **A member of org A guessing org B's job or variant id** in `GET /api/jobs/:id`, the approve route or media URLs. Expected: 404, with no existence leak. *Task 5* route tests for a foreign id; *Task 2* RLS suite.
2. **Two first requests from a newly invited user arriving at once:** exactly one org, one membership and one `users` row. *Task 4* concurrency test.
3. **Two concurrent approves on different variants of one job:** exactly one `approved` afterwards. *Task 5* Postgres-gated concurrency test.
4. **A forged or expired session cookie:** treated as signed out, never trusted. *Task 4* test with a tampered cookie, through `getClaims()`.
5. **Waitlist abuse:** bots (honeypot, under 3 s), a duplicate email, an oversize payload, and HTML in fields stored but always rendered escaped. *Task 6* tests.

---

### Task 1: The tenancy schema, backfill, and job-scoped org/project (Opus)

**Files:**
- Modify: `packages/db/src/schema.ts`, `packages/db/src/seed/seed.ts` (`seedLocalUser` → `seedOperator`), `packages/pipeline/src/types.ts`, `packages/pipeline/src/record.ts`, `packages/pipeline/src/heavy.ts`, `packages/pipeline/src/*` (wherever `deps.projectId`/`deps.userId` are read), `apps/worker/src/deps.ts`, `apps/worker/src/routes.ts`, test fakes
- Create: migrations via drizzle-kit (generated plus one custom backfill)
- Test: `packages/db/test/tenancy.test.ts`, updated pipeline/worker tests

**Interfaces:**
- Produces, in the schema:
  - `orgs(id, name, createdAt)`;
  - `memberships(orgId, userId, role: 'owner'|'member', createdAt)` with PK `(orgId, userId)`;
  - `products(id, orgId, projectId, name, createdAt)`;
  - `waitlist(id, name, email unique, brand, website, category, country, note, status: 'new'|'invited'|'joined', createdAt, invitedAt)`;
  - `users.isAdmin boolean default false`;
  - `orgId uuid not null references orgs` on `projects`, `assets`, `jobs`, `variants`, `providerCalls`;
  - `assets` unique becomes `(orgId, sha256)`.
- **`users.id` equals the Supabase `auth.users.id`** (no FK across schemas; documented).
- `seedOperator(db) → { orgId, userId, projectId }`: an idempotent "Operator" org, a local user and a project for dev scripts. It replaces `seedLocalUser`.
- **Pipeline:** `PipelineDeps` loses `userId`/`projectId`. `saveAsset(db, scope: { orgId: string; projectId: string }, kind, ref)`. Every pipeline function obtains `{ orgId, projectId }` from the job row.

- [ ] **Step 1: Failing tests** in `tenancy.test.ts` (PGlite):
  - migrating a DB that already holds POC rows (seed them via the pre-migration schema: open, insert, then apply the new migrations; or assert on a fresh DB that the backfill SQL is idempotent) leaves every pre-existing project, asset, job, variant and provider_call with the Operator org's id, and none NULL;
  - inserting the same sha256 asset in two different orgs succeeds, while the same org twice yields one row (`saveAsset` returns the same id);
  - `seedOperator` run twice gives the same ids.
  - Pipeline tests: a job in org X writes its assets with `orgId = X`.
- [ ] **Step 2:** Run → FAIL.
- [ ] **Step 3: Implement.**
  1. Schema with `orgId` **nullable**, then `pnpm db:generate`.
  2. A custom migration `tenancy_backfill`: insert the Operator org if missing, then update all five tables to it.
  3. Schema with `orgId.notNull()` plus the new unique, then `pnpm db:generate`.
  4. Then wire `seedOperator`, `PipelineDeps`, `saveAsset`, the worker deps and the dev `createJob` route (which uses `seedOperator`'s ids).
- [ ] **Step 4:** `pnpm test`, `pnpm typecheck` and `pnpm db:check` (with `ADFORGE_TEST_DATABASE_URL` set to `SUPABASE_DEV_DATABASE_URL` from `.env.supabase`) → PASS.
- [ ] **Step 5: Commit:** `feat(db): orgs, memberships, products, waitlist; org_id on tenant tables; job-scoped org/project`.

### Task 2: RLS policies, `withUser`, and the cross-tenant suite (Opus)

**Files:**
- Create: a custom migration `rls`, `packages/db/src/with-user.ts`, `packages/db/test/rls.test.ts` (Postgres-gated)
- Modify: `packages/db/package.json` exports if needed

**Interfaces:**
- **The migration** (idempotent, applies on PGlite and Postgres):
  - creates roles `anon` and `authenticated` if missing (`NOLOGIN`);
  - `create schema if not exists auth`;
  - **only if `auth.uid()` doesn't exist**, creates the Supabase-compatible stub: `coalesce(nullif(current_setting('request.jwt.claim.sub', true), ''), (nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'sub'))::uuid`. It never replaces Supabase's real one.
  - `public.is_member(org uuid) returns boolean` and `public.is_admin() returns boolean`, both `security definer`, `stable`, with `set search_path = public`;
  - `grant usage on schema public to authenticated`, plus the table grants the policies need;
  - `enable row level security` on every table.
- **Policies:**
  - tenant tables (`projects`, `products`, `assets`, `jobs`, `variants`): select, insert, update and delete for `authenticated` `using/with check (is_member(org_id))`;
  - `provider_calls`: select only;
  - `orgs`: select `is_member(id)`;
  - `memberships`: select `user_id = auth.uid()`;
  - `users`: select `id = auth.uid()`;
  - registry tables (`vocab_families`, `archetypes`, `formats`, `hook_archetypes`): select `true`;
  - `waitlist`: select and update `is_admin()`;
  - no `anon` policies anywhere.
- **`withUser<T>(db: Db, userId: string, fn: (udb: UserDb) => Promise<T>): Promise<T>`** runs `db.transaction`: `set local role authenticated`, then `select set_config('request.jwt.claims', <json {sub: userId, role:'authenticated'}>, true)`, then `fn`. `type UserDb = Db & { readonly __rls: unique symbol }` (a branded type).

- [ ] **Step 1: Failing tests** in `rls.test.ts`, `describe.skipIf(!process.env.ADFORGE_TEST_DATABASE_URL)`, each test using fresh orgs and users with random uuids so runs don't interfere:
  - **every table in the schema is covered:** iterate the Drizzle schema exports. A table with an `org_id` column must have RLS enabled (`pg_class.relrowsecurity`) and at least one policy. Every other table must be in the explicit allowlist `[users, orgs, memberships, waitlist, vocab_families, archetypes, formats, hook_archetypes]` and also have RLS enabled.
  - **for each tenant table**, a member of org A under `withUser`:
    - selects 0 of org B's rows;
    - updates and deletes 0 of them (row count 0);
    - fails to insert a row with `org_id = B`.
  - **`waitlist`:** a non-admin selects 0 rows, an admin selects all.
  - **`anon`:** `set role anon` selects 0 rows from every tenant table and from `waitlist` (permission error or 0 rows).
  - **`withUser` leaks nothing past its transaction:** after it returns, `current_user` is back to the owner.
- [ ] **Step 2:** Run with `ADFORGE_TEST_DATABASE_URL` set to `SUPABASE_DEV_DATABASE_URL` → FAIL.
- [ ] **Step 3: Implement** the migration and `withUser`.
- [ ] **Step 4:** Postgres-gated suite → PASS against Supabase dev. `pnpm test` (PGlite applies the migration) and `pnpm db:check` → PASS.
- [ ] **Step 5: Commit:** `feat(db): RLS on every table, withUser for user-scoped queries, cross-tenant suite`.

### Task 3: DB access by profile, plus the web server's DB and env (Sonnet)

**Files:**
- Modify: `packages/db/src/client.ts`, root `package.json`, `packages/db/package.json` (`db:migrate` script), `apps/web/next.config.ts`, `apps/web/package.json`, `.env.example`
- Create: `apps/web/lib/server/env.ts`, `apps/web/lib/server/db.ts`, `packages/db/src/migrate.ts`, `apps/web/.env.local` (gitignored, written from `.env.supabase`)
- Test: `packages/db/test/client.test.ts`, `apps/web/test/server-env.test.ts`

**Interfaces:**
- `openDbForEnv(env)`: Postgres whenever `DATABASE_URL` is set (dev or prod); otherwise PGlite (dev only; prod still requires the URL).
- `openPostgres(url, opts?: { connectTimeoutSec?: number; migrate?: boolean })`, where `migrate` defaults to `true`. The web passes `false`.
- `pnpm db:migrate` applies migrations to `DATABASE_URL` and exits.
- `apps/web/lib/server/env.ts`: a Zod schema for the web server only:
  - `DATABASE_URL`, `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY`, `SUPABASE_SECRET_KEY`;
  - `ADFORGE_ADMIN_EMAILS` (comma list, lower-cased);
  - `ADFORGE_DATA_DIR`, `ADFORGE_PUBLIC_URL` (dev media until B3);
  - `INNGEST_EVENT_KEY` (optional), `INNGEST_DEV` (optional).
  - It does **not** import `@adforge/core/config/env` (its `REPO_ROOT` depth check breaks under Next bundling).
- `apps/web/lib/server/db.ts`: `getDb(): Promise<Db>` (owner connection, `migrate: false`), cached on `globalThis` so hot reload doesn't open pools repeatedly.
- `next.config.ts`:
  - `transpilePackages` for the workspace packages the server imports;
  - `serverExternalPackages: ['@electric-sql/pglite', 'postgres']`;
  - `next build` must not open a DB.

- [ ] **Step 1: Failing tests:**
  - `openDbForEnv({ADFORGE_ENV:'dev', DATABASE_URL})` picks Postgres. Assert via an injected opener, or the Postgres-gated test.
  - The web env parse matrix: missing publishable key → error naming it; admin emails normalized.
- [ ] **Step 2:** FAIL.
- [ ] **Step 3: Implement.**
  - Write `apps/web/.env.local` from `.env.supabase` values with a small one-off script you don't commit. `DATABASE_URL` is the session pooler URL; `ADFORGE_ADMIN_EMAILS=shahheet85@gmail.com`; `ADFORGE_DATA_DIR`/`ADFORGE_PUBLIC_URL` copied from the root `.env`.
  - Add `DATABASE_URL` to the root `.env` (the worker in dev uses Supabase dev from now on).
  - Run `pnpm db:migrate` once against Supabase dev.
- [ ] **Step 4:** `pnpm test`, `pnpm typecheck` and `pnpm --filter @adforge/web build` (proves no DB at build) → PASS.
- [ ] **Step 5: Commit:** `feat: DATABASE_URL selects Postgres in any profile; web server env + cached DB; db:migrate`.

### Task 4: Supabase Auth in `apps/web` (Sonnet)

**Files:**
- Create:
  - `apps/web/lib/supabase/server.ts`, `apps/web/lib/supabase/client.ts`;
  - `apps/web/proxy.ts`;
  - `apps/web/app/signin/page.tsx`, `apps/web/app/auth/confirm/route.ts`, `apps/web/app/auth/signout/route.ts`;
  - `apps/web/lib/server/session.ts`, `apps/web/lib/server/provision-owner.ts`.
- Test: `apps/web/test/session.test.ts`, `apps/web/test/provision.test.ts`

**Interfaces:**
- `requireUser(): Promise<{ userId: string; email: string; isAdmin: boolean }>`. It reads `getClaims()`. With no valid claims it redirects to `/signin`. It calls `provision`.
- **`provision(db, { userId, email, adminEmails }) → { orgId }`**, idempotent and concurrency-safe:
  - upserts `users` (`isAdmin` = the email is in `adminEmails`);
  - when the user has no membership, creates an org (name = the email's local part) plus an owner membership in one transaction, guarded with a lock or `on conflict` so two parallel calls create exactly one;
  - marks the matching `waitlist` row `joined`.
- **Sign-in:**
  - `signInWithOtp({ email, options: { emailRedirectTo: <site>/auth/confirm, shouldCreateUser: <dev ? true : email ∈ admin emails> } })`;
  - in prod non-admins must be invited first, so the page shows "check your email" either way (no account enumeration).
- **`/auth/confirm`:** `verifyOtp({ token_hash, type })` → redirect `/`. Invalid → `/signin?error=link`.
- **`proxy.ts`:** refreshes the session per the `@supabase/ssr` README in `node_modules` (read it first). The matcher excludes static assets and `/auth/*`.
- Protected: `/` and `/jobs/*`. Public: `/signin`, `/auth/*`, `/waitlist`.

- [ ] **Step 1:** Add the deps (`@supabase/ssr: 0.12.7`, `@supabase/supabase-js: 2.117.2` to the catalog; `pnpm install`).
- [ ] **Step 2: Failing tests:**
  - `provision` run twice sequentially gives one org, one membership and one users row;
  - `provision` run twice **concurrently** (`Promise.all` on PGlite or Postgres) gives the same;
  - an admin email gives `isAdmin` true;
  - a waitlist row is marked joined;
  - `requireUser` with a fake supabase client returning no claims redirects; with claims it returns the user. Covers a tampered cookie, where the fake `getClaims` errors.
- [ ] **Step 3: Implement.**
- [ ] **Step 4:** `pnpm test`, `pnpm typecheck`, and a web build → PASS.
- [ ] **Step 5: Commit:** `feat(web): Supabase Auth — magic link, proxy session refresh, first-login provisioning`.

### Task 5: The web data layer, job routes and pages under RLS (Sonnet)

**Files:**
- Create:
  - `packages/pipeline/src/job-input.ts`: the upload validation moved out of `apps/worker/src/routes.ts`. The worker dev route and the web route both use it, so the logic isn't duplicated.
  - `apps/web/lib/data/jobs.ts`;
  - `apps/web/app/api/jobs/route.ts`, `apps/web/app/api/jobs/[id]/route.ts`, `apps/web/app/api/jobs/[id]/variants/[n]/approve/route.ts`;
  - `apps/web/lib/server/events.ts`.
- Modify: `apps/web/app/page.tsx`, `apps/web/app/jobs/[id]/page.tsx`, `apps/web/lib/api.ts` (now same-origin `/api/*`), `apps/worker/src/routes.ts` (uses `job-input.ts`)
- Test: `packages/pipeline/test/job-input.test.ts`, `apps/web/test/jobs-data.test.ts`, `apps/web/test/approve.test.ts`

**Interfaces:**
- `parseJobUpload(form: FormData) → { ok: true; fields; photos: {bytes, type}[] } | { ok: false; status: 400|413; error; issues? }`. It has the same limits as today: 3–5 photos, 5 MB each, a 30 MB body, png/jpeg/webp with magic-byte sniffing.
- `lib/data/jobs.ts`, all taking `udb: UserDb`:
  - `createJobRow(udb, { orgId, projectId, userId, inputSpec }) → jobId`;
  - `getJobView(udb, jobId) → JobView | null`. The JobView shape is unchanged from `lib/api.ts`'s Zod schema. `renderUrl` = `${ADFORGE_PUBLIC_URL}/media/<key>` in dev.
  - `approveVariant(udb, jobId, n) → 'ok'|'not_found'|'conflict'` is a **single atomic statement**: it sets the target to `approved` and any other `approved` in the job to `completed`, only when the target is `completed` or `approved`, inside one `UPDATE … WHERE job_id = $1 AND status IN ('completed','approved') AND EXISTS (target eligible)`. It returns `not_found` when no visible target exists, and `conflict` when the target exists but isn't eligible.
- `POST /api/jobs`:
  1. `requireUser`;
  2. `parseJobUpload`;
  3. the org's default project, created if missing (`project.name = 'Default'`);
  4. photos → `LocalDiskStorage` (dev) plus `saveAsset`;
  5. `createJobRow`;
  6. `sendJobRequested(jobId)` via an Inngest client with app id `'adforge'`, the same event name `adforge/job.requested` and payload `{ jobId }` as the worker;
  7. → `202 { jobId }`.
  - If the send fails, the job is failed (`failJob`) → 503.
- `GET /api/jobs/[id]` → the JobView, or 404 (foreign ids included).
- The approve route → `{ approved: n }`, 404 or 409.

- [ ] **Step 1: Failing tests:**
  - `job-input` (each limit, sniff mismatch, the fields);
  - `getJobView` for a foreign org's job → null;
  - `approveVariant` foreign → `not_found`, a pending target → `conflict`, a completed one → `ok`, with exactly one `approved` after;
  - **Postgres-gated:** 10 parallel approves on different variants → exactly one approved (Review Focus 3);
  - the route returns 404 for a foreign id (Review Focus 1).
- [ ] **Step 2:** FAIL.
- [ ] **Step 3: Implement.** The pages keep their current look and view model (`lib/view.ts`), now fetching same-origin routes.
- [ ] **Step 4:** `pnpm test`, `pnpm typecheck`, web build → PASS.
- [ ] **Step 5: Commit:** `feat(web): jobs created and read under RLS; atomic approve; shared upload validation`.

### Task 6: The waitlist page and route (Haiku)

**Files:**
- Create: `apps/web/app/waitlist/page.tsx`, `apps/web/app/api/waitlist/route.ts`, `apps/web/lib/server/waitlist-owner.ts`, `apps/web/lib/server/rate-limit.ts`
- Test: `apps/web/test/waitlist.test.ts`

**Interfaces:**
- `WaitlistInput` Zod:
  - `name` 1–120, `email` (an email, ≤254, lower-cased), `brand` 1–120, `website` (optional URL, ≤300), `category` 1–80, `country` 1–80, `note` (optional, ≤1000);
  - hidden `company_url` (the honeypot, must be empty);
  - `startedAt` (ms epoch; rejected silently if `now - startedAt < 3000`).
- `rateLimit(key: string, limit: number, windowSec: number): Promise<boolean>`: in-memory now, swapped in B5.
- The route caps the body at 8 KB → 413.
- Results:
  - valid → insert (`on conflict (email) do nothing`) → `200 { ok: true }`, plus a "you're on the list" message, also on a duplicate;
  - bot → `200 { ok: true }` without inserting;
  - rate-limited (5 per IP per 10 min) → 429.

- [ ] **Steps:** a failing test per case (Review Focus 5: honeypot, too fast, duplicate, oversize, rate limit, invalid field) → implement → `pnpm test` → commit `feat(web): public waitlist form with honeypot, timing check and rate limit`.

### Task 7: The admin page and invites (Sonnet)

**Files:**
- Create: `apps/web/app/admin/page.tsx`, `apps/web/app/api/admin/invite/route.ts`, `apps/web/lib/server/admin-owner.ts`
- Test: `apps/web/test/admin.test.ts`

**Interfaces:**
- `/admin`: non-admin → 404 (not 403, so nothing is revealed). It lists the waitlist (newest first) with status, and the orgs with member counts. All text is rendered escaped.
- `POST /api/admin/invite { waitlistId }`:
  - admin only;
  - `supabase.auth.admin.inviteUserByEmail(email, { redirectTo: <site>/auth/confirm })` using `SUPABASE_SECRET_KEY`;
  - sets `status='invited'` and `invitedAt`;
  - idempotent: an already-invited row returns 200 without a second send.

- [ ] **Steps:** failing tests (non-admin 404, invite marks the row, a second invite doesn't call the fake admin client again, an unknown id gives 404) → implement → `pnpm test` → commit `feat(web): admin waitlist + invite`.

### Task 8: Supabase project config, ADR 0015, runbook (Haiku)

**Files:**
- Create: `scripts/supabase-auth-config.mjs`, `docs/decisions/0015-tenancy-rls-auth.md`
- Modify: `docs/runbook.md` (an "Auth & tenancy" section), `.env.example`

**Interfaces:** `node scripts/supabase-auth-config.mjs <ref>` reads `SUPABASE_TOKEN` from `.env.supabase` and `PATCH`es `https://api.supabase.com/v1/projects/<ref>/config/auth` with:
- `site_url` = `http://localhost:3000` (dev);
- `uri_allow_list` including `http://localhost:3000/auth/confirm`;
- `disable_signup` = `false` for dev (the prod value is `true`, documented);
- `mailer_templates_magic_link_content` and the invite template using `{{ .SiteURL }}/auth/confirm?token_hash={{ .TokenHash }}&type=email` (and `type=invite` for invites).

It prints only the field names it changed.

- [ ] **Step 1:** Write the script. Run it once for the dev ref `pdxtuejlluzylgyvonii`. Verify via `GET` that the fields were changed.
- [ ] **Step 2:** ADR 0015 records the five roadmap amendments above, the RLS model (owner vs `authenticated`, `withUser`, the stub `auth.uid()`), "`users.id` = `auth.users.id`", admin bootstrap via `ADFORGE_ADMIN_EMAILS`, magic link only, and that the free-tier Supabase SMTP is rate-limited (real email volume needs custom SMTP before launch, which is a B6 item).
- [ ] **Step 3:** Runbook "Auth & tenancy": invite a brand, make someone admin, rotate the secret key, re-apply the auth config.
- [ ] **Step 4: Commit:** `docs+chore: Supabase auth config script, ADR 0015, runbook auth section`.

---

## End-to-end check (once, at the end): `pnpm --filter @adforge/web e2e:tenancy`
A Playwright spec `apps/web/e2e/tenancy.spec.ts` run against the dev Supabase project, with `pnpm dev` started by the Playwright config. Magic links come from `auth.admin.generateLink` (service key), so no inbox is needed. Steps:
1. Submit the waitlist form as `e2e+<rand>@adforge.test`, after waiting 3 s for the timing check.
2. As admin, open `/admin` and invite that row; the row shows `invited`.
3. Generate a magic link for the invited email, visit `/auth/confirm?...`, land on `/` signed in, and the org is created.
4. Org B (a second invited user): directly insert a job row for org A via the owner DB in the test fixture. B's `GET /api/jobs/<A's id>` → 404, and B's home shows no jobs.

**Pass:** all steps green, and cleanup deletes the test users (`auth.admin.deleteUser`), their orgs and rows. GPU services aren't needed.
