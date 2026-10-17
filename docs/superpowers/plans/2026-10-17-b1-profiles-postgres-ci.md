# B1: Environment profiles, the Postgres driver, CI — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task by task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:**
- one codebase with two profiles (`ADFORGE_ENV=dev|prod`);
- Drizzle runs on PGlite (tests, dev) or Postgres (prod) with identical schema types and identical migrations;
- prod boot refuses POC-only providers;
- CI runs `pnpm test`, typecheck and migration parity on every push.

**Architecture:**
- `openDb(dataDir?)` (PGlite) stays as is. A sibling `openPostgres(url)` returns the same `{ db, close }` shape, and `openDbForEnv(env)` picks one by profile.
- `Db` becomes the driver-neutral `PgDatabase<PgQueryResultHKT, typeof schema>`.
- The provider policy runs inside `parseEnv`, so every boot path enforces it.
- CI runs on `ubuntu-latest` with a Postgres service container. GitHub only supports service containers on Linux runners.

**Tech stack:** drizzle-orm 0.45.4 (`drizzle-orm/postgres-js`, `drizzle-orm/postgres-js/migrator`), **postgres 3.4.9** (published 2026-04-05, so at least 14 days old), PGlite 0.5.8, GitHub Actions.

**Specs:**
- [bridge roadmap §B1](2026-10-17-bridge-roadmap.md);
- [bridge design §4, §5.1, §5.9](../specs/2026-10-17-poc-to-prod-bridge-design.md).

## Global Constraints
- The roadmap's Global Constraints apply: pins exact and at least 14 days old, `pnpm test` before each commit, the commit identity flags plus the `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>` trailer, stage specific paths only.
- **Supabase compatibility:** postgres-js clients use `prepare: false`, because Supabase's transaction pooler doesn't support prepared statements (Drizzle "connect-supabase" docs).
- **Migrations:** the existing folder `packages/db/drizzle/` (0000–0002) is the single source; never hand-edit generated SQL.
- No GPU, network or subscription in `pnpm test`. The Postgres tests run only when `ADFORGE_TEST_DATABASE_URL` is set (CI sets it).
- **Docs first:** the implementer of Task 2 reads the installed `node_modules/drizzle-orm/postgres-js/migrator.d.ts` and `driver.d.ts` before writing code (the web docs don't show the postgres-js migrator).

## Review Focus
1. **The prod profile with a missing or malformed `DATABASE_URL`:** a clear boot error naming the variable, never a hang on connect. *Task 1:* `parseEnv({ADFORGE_ENV:'prod'})` throws mentioning `DATABASE_URL`. *Task 2:* `openPostgres` against an unroutable host rejects within a `connectTimeoutSec`.
2. **A POC-only provider configured in prod:** boot refuses and names the provider. *Task 1* test.
3. **Migrations applied twice to the same Postgres** (CI re-run, or a second deploy): a no-op, not an error. *Task 2:* the Postgres test opens twice.
4. **PGlite vs Postgres schema drift** (a type only one engine renders the same way): `db:check` reports the differing column. *Task 3:* the diff function test with a synthetic mismatch.
5. **CI on Linux with Windows-assuming tests** (`env.test.ts` OneDrive paths, path separators): tests pass on both OSes without being skipped. *Task 4:* the CI run itself, with any test made portable rather than skipped.

---

### Task 1: The profile switch and provider policy (Sonnet)

**Files:**
- Modify: `packages/core/src/config/env.ts`
- Create: `packages/core/src/providers/policy.ts`
- Test: `packages/core/test/env.test.ts`, `packages/core/test/policy.test.ts`

**Interfaces:**
- Produces:
  - `Env.ADFORGE_ENV: 'dev' | 'prod'` (default `'dev'`);
  - `Env.DATABASE_URL?: string` (a `postgres:` or `postgresql:` URL);
  - `POC_ONLY_PROVIDERS: ReadonlySet<string>` (initially empty; B6 adds `'claude-agent-sdk'`);
  - `assertProviderPolicy(env: Env, pocOnly?: ReadonlySet<string>): void`;
  - `parseEnv` calls it.

- [ ] **Step 1: Write failing tests.**
  `env.test.ts`:
  - `parseEnv({})` gives `ADFORGE_ENV === 'dev'` and `DATABASE_URL === undefined`;
  - `parseEnv({ ADFORGE_ENV: 'prod' })` throws `/DATABASE_URL/`;
  - `parseEnv({ ADFORGE_ENV: 'prod', DATABASE_URL: 'postgresql://u:p@h:5432/d' })` is ok;
  - `DATABASE_URL: 'http://x'` throws.

  `policy.test.ts`:
  - `assertProviderPolicy(parseEnv({}), new Set(['claude-agent-sdk']))` does not throw (dev);
  - `assertProviderPolicy(prodEnv, new Set(['claude-agent-sdk']))` throws `/claude-agent-sdk.*POC-only/` and names `ADFORGE_PROVIDER_LLM`;
  - with the real empty `POC_ONLY_PROVIDERS`, prod passes.
- [ ] **Step 2:** `pnpm --filter @adforge/core test` → FAIL.
- [ ] **Step 3: Implement.**
  - Add the two fields to `Env` with a `superRefine`: prod requires `DATABASE_URL`.
  - `assertProviderPolicy` iterates every `ADFORGE_PROVIDER_*` key of `env`; in prod it throws `Error('<KEY>=<id> is POC-only and refused in prod')` on the first hit.
  - `parseEnv` calls `assertProviderPolicy(result.data)` after a successful parse.
- [ ] **Step 4:** `pnpm --filter @adforge/core test` → PASS. Then `pnpm test` → all green.
- [ ] **Step 5: Commit:** `feat(core): ADFORGE_ENV profiles, DATABASE_URL, POC-only provider policy at boot`.

### Task 2: The Postgres driver and `openDbForEnv` (Sonnet)

**Files:**
- Modify: `pnpm-workspace.yaml` (catalog `postgres: 3.4.9`), `packages/db/package.json` (dependency `postgres: catalog:`), `packages/db/src/client.ts`
- Modify callers: `apps/worker/src/deps.ts:13`, `packages/db/src/seed/run.ts:14`, `packages/db/src/e2e-shortlist.ts:14`, `packages/providers/claude-agent-sdk/src/e2e.ts:26`
- Test: `packages/db/test/client.test.ts`, `packages/db/test/postgres.test.ts` (new)

**Interfaces:**
- Consumes: `Env.ADFORGE_ENV`, `Env.DATABASE_URL`, `Env.ADFORGE_DATA_DIR` (Task 1).
- Produces:
  - `export type Db = PgDatabase<PgQueryResultHKT, typeof schema>`;
  - `openDb(dataDir?: string)`, unchanged behaviour and lock;
  - `openPostgres(url: string, opts?: { connectTimeoutSec?: number }): Promise<{ db: Db; close(): Promise<void> }>`, which applies migrations before returning;
  - `openDbForEnv(env: Pick<Env, 'ADFORGE_ENV' | 'ADFORGE_DATA_DIR' | 'DATABASE_URL'>)`, the same return type.

- [ ] **Step 1: Write failing tests.**
  `client.test.ts`:
  - `openDbForEnv({ ADFORGE_ENV: 'dev', ADFORGE_DATA_DIR: tmpDir })` opens PGlite and takes the lock (a second open rejects `/already open by pid/`);
  - the `Db` type accepts both (a type-level test: `const f = (d: Db) => d.select().from(schema.jobs)` compiles for both openers).

  `postgres.test.ts` (`describe.skipIf(!process.env.ADFORGE_TEST_DATABASE_URL)`):
  - opens, migrates, `seed()` runs, `loadRegistry(db)` returns the seeded counts (same counts as `seed.test.ts`);
  - opening twice (migrate twice) succeeds;
  - `openPostgres('postgresql://u:p@10.255.255.1:5432/x', { connectTimeoutSec: 2 })` rejects within 5 s.
- [ ] **Step 2:** `pnpm --filter @adforge/db test` → FAIL.
- [ ] **Step 3: Implement.**
  - `openPostgres` builds `postgres(url, { prepare: false, max: 5, connect_timeout: opts.connectTimeoutSec ?? 10 })` and then `drizzle({ client, schema, casing: 'snake_case' })`.
  - It calls `migrate` from `drizzle-orm/postgres-js/migrator` with the same `MIGRATIONS` folder.
  - On migrate failure it does `client.end()` and rethrows.
  - `close()` does `client.end({ timeout: 5 })`.
  - Switch the four callers to `openDbForEnv(env)`.
- [ ] **Step 4:** `pnpm test` → PASS (the Postgres tests skip locally).
- [ ] **Step 5: Commit:** `feat(db): postgres-js driver behind openDbForEnv; driver-neutral Db type`.

### Task 3: The migration parity check, `pnpm db:check` (Haiku)

**Files:**
- Create: `packages/db/src/db-check.ts`, `packages/db/src/schema-diff.ts`
- Modify: `packages/db/package.json` (script `"db:check": "tsx src/db-check.ts"`), the root `package.json` (`"db:check": "pnpm --filter @adforge/db db:check"`)
- Test: `packages/db/test/schema-diff.test.ts`

**Interfaces:**
- Consumes: `openDb()`, `openPostgres(url)` (Task 2).
- Produces:
  - `type ColumnRow = { table: string; column: string; type: string; nullable: boolean }`;
  - `listColumns(db: Db): Promise<ColumnRow[]>`, from `information_schema.columns where table_schema = 'public'`, sorted by table then column;
  - `diffColumns(a: ColumnRow[], b: ColumnRow[]): string[]`, one human line per difference, e.g. `"jobs.status: pglite=text postgres=character varying"` or `"variants.error: missing in postgres"`.

- [ ] **Step 1: Write failing tests** in `schema-diff.test.ts`:
  - identical lists → `[]`;
  - a type mismatch → exactly one line naming `table.column` and both types;
  - a column only in one → a "missing in" line;
  - `listColumns` on in-memory PGlite returns the `jobs` table's columns, including `shortlist`.
- [ ] **Step 2:** `pnpm --filter @adforge/db test` → FAIL.
- [ ] **Step 3: Implement** `listColumns` and `diffColumns`. `db-check.ts`:
  - reads `ADFORGE_TEST_DATABASE_URL ?? DATABASE_URL` (exit 2 with a message when neither is set);
  - opens both engines and prints the diff lines;
  - exits 1 if any, else prints `schema parity ok (<n> columns)`;
  - closes both in `finally`.
- [ ] **Step 4:** `pnpm test` → PASS.
- [ ] **Step 5: Commit:** `feat(db): pnpm db:check — PGlite vs Postgres schema parity`.

### Task 4: The CI workflow (Sonnet; regraded from Haiku because of Linux portability)

**Files:**
- Create: `.github/workflows/ci.yml`
- Modify: any test that assumes Windows. Known: `packages/core/test/env.test.ts` OneDrive path cases. Make it portable, e.g. by asserting via `path.win32` where the case is Windows-specific; never skip.

**Interfaces:** consumes `pnpm db:check` (Task 3), `ADFORGE_TEST_DATABASE_URL` (Task 2).

- [ ] **Step 1: Write the workflow.**
  - Trigger: on `push` and `pull_request`. Runner: `ubuntu-latest`.
  - Service: `postgres:17` (user, password and db `adforge`, health-cmd `pg_isready`).
  - Steps:
    1. checkout;
    2. `actions/setup-node` with Node 24;
    3. `npm i -g pnpm@12.11.2`;
    4. `pnpm install --frozen-lockfile`;
    5. FFmpeg via `apt-get install -y ffmpeg`;
    6. chrome-headless-shell at the version the renderer tests use (read it from `@hyperframes/producer`/puppeteer config in the repo and pin it);
    7. `pnpm typecheck`;
    8. `pnpm test` with `ADFORGE_TEST_DATABASE_URL=postgresql://adforge:adforge@localhost:5432/adforge`;
    9. `pnpm db:check` with the same URL.
  - Python services are not in CI (their torch/CUDA stacks are GPU-machine only); note it in a workflow comment.
- [ ] **Step 2: Linux portability.** Run the test suite in WSL or reason it through. Fix every path- or OS-specific assumption found, as in Files above.
- [ ] **Step 3:** `pnpm test` locally (Windows) → PASS.
- [ ] **Step 4: Commit:** `ci: GitHub Actions — typecheck, tests (incl. Postgres), schema parity`.
- [ ] **Step 5:** The push happens at the milestone end, after the final review (standing user approval). CI must go green. Fix forward on the branch if not.

### Task 5: ADR 0014 plus the runbook seed (Haiku)

**Files:** Create `docs/decisions/0014-env-profiles-postgres.md`, `docs/runbook.md`

- [ ] **Step 1:** ADR 0014 records:
  - profiles via `ADFORGE_ENV`;
  - the driver-neutral `Db` type;
  - `prepare: false` for Supabase poolers;
  - the policy enforced in `parseEnv`;
  - CI on Linux only, why, and that Python services are excluded;
  - postgres 3.4.9 pinned.
- [ ] **Step 2:** The `docs/runbook.md` skeleton has headings for start/stop, alerts, kill switch, quota, key rotation and restore, each "TBD in B<n>" naming the milestone that fills it, plus a filled "Database: running `pnpm db:check`" section.
- [ ] **Step 3: Commit:** `docs: ADR 0014 env profiles + Postgres; runbook seed`.

---

## End-to-end check (once, at the end)
1. **Local:** `pnpm test` is green, and `pnpm db:check` against a Postgres. Use the Supabase dev project once the user reports the Supabase CLI and token are ready (per memory `push-and-accounts`); **until then this leg is held, and the CI Postgres container proves parity.**
2. **CI:** after the final review and merge, push `main` (standing approval). **Pass:** every CI job is green on GitHub.
