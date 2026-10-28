# B4: Hosted Queue Implementation Plan

> **Amendment (2026-10-28, ADR 0020):** single environment (no preview/staging; Vercel Production + Inngest production env, `INNGEST_ENV` unset, dev Supabase + `adforge-dev` until B6), and the dispatcher is capacity-gated (at most `GENERATE_ADS_CONCURRENCY` = 2 jobs in flight, advisory-locked) with a janitor lost-dispatch bound. Tasks below are unchanged.

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** the GPU machine serves Inngest Cloud through an outbound-only `inngest/connect` worker; jobs are dispatched only while a worker is live; the site shows queue position and ETA or "GPU offline, queue paused"; a supervisor restarts the services on crash and reboot; the web app deploys to Vercel.

**Architecture:**
- **Prod worker:** `apps/worker` runs `connect()` (no HTTP server, so no inbound port) and writes a heartbeat row every 30 s.
- **Dispatcher:** a light Inngest function (cron each minute, plus an on-submit nudge) sends `adforge/job.requested` exactly once per queued job, oldest first, only while a heartbeat is fresh.
- **Queue status:** `queueStatus` is a query.
- **Supervisor:** a PowerShell supervisor launched by a logon scheduled task generalizes the existing restart loops.
- **Dev:** keeps `serve()` and the dev HTTP API.

**Tech Stack:** Inngest 4.21.1 (`inngest/connect`), Drizzle (PGlite tests, Postgres prod), Next.js 16.3.8 on Vercel, PowerShell 5.1 + Windows Task Scheduler, Vitest.

**Spec:** `docs/superpowers/specs/2026-10-17-poc-to-prod-bridge-design.md` §4, §5.4, §5.5, §5.9; roadmap `docs/superpowers/plans/2026-10-17-bridge-roadmap.md` §B4 (fixed interfaces honoured; amendments below).

## Amendments to the roadmap (ADR 0020 records them)

1. **The e2e is GPU-free** (user rule 2026-10-24: no GPU work without an explicit yes; the full pipeline waits for the end of development). `e2e:hosted-queue` runs with ComfyUI and the voice services **off**. Each job is dispatched, shows position and ETA, pauses when the worker stops, resumes on restart, and then fails fast at `preflight` (no ComfyUI). **Pass** = dispatch, position, ETA, paused, resumed and a terminal state for both jobs; completion is not required.
2. **Submission no longer sends `adforge/job.requested`.** The web inserts the queued job and sends `adforge/dispatch.nudge`, so the dispatcher runs immediately instead of waiting for its cron. **The dispatcher is the only sender of `job.requested`.**
3. **`workers` is not a tenant table** (no `org_id`). Users get no grants on it. The web reads only `max(last_seen)` through an owner module, and the queue position counts every org's queued jobs but returns only numbers.
4. **Supervisor choice:** a logon scheduled task running `scripts/supervisor.ps1` (no admin install, no third-party binary) over NSSM. The ADR records why.
5. **Vercel deploy is its own task (Task 5).** The roadmap's e2e needs a hosted preview. The task closes the B1/B2/B3 carry-forwards for deploy:
   - transaction pooler `:6543` for the web pool;
   - prod and preview R2 bucket CORS;
   - `ADFORGE_SITE_URL`;
   - Vercel env vars;
   - the build command stays the package `build` script.

## Global Constraints

- **The GPU machine opens no inbound port in prod.** Prod `main.ts` must not `listen()`, and the dev HTTP API stays dev-only on 127.0.0.1.
- **Inngest:** every new function is idempotent. Event ids are used for exactly-once dispatch (`id: job:<jobId>`). The heavy lane (env-scoped key, limit 1) stays. `maxWorkerConcurrency: 1`.
- **Liveness:** every outbound call has a timeout, and the heartbeat's local probes have ≤2 s timeouts each. Stopping the worker closes the connect worker first and then the DB, inside the existing 10 s shutdown bound.
- **Tenancy:**
  - queue numbers never reveal another org's job details;
  - `workers` has no user grants;
  - RLS is unchanged elsewhere.
- **Migrations:** 0016–0018 are applied on the shared dev DB and are never edited. B4's migration is **0019** and is purely additive.
- **Pins:** exact versions, at least 14 days old; no new runtime dependency unless the task says so. JSON logs use a ~30-line in-repo logger, not a logging library.
- **Tests:** `pnpm test` offline, with no GPU, network or subscription. **GPU rule: no task, test or subagent starts ComfyUI, voice, voice-qwen or vision.** Supervisor tests use a dummy child process.
- **Git:**
  - commit with `git -c user.name=heetshah16 -c user.email=shahheet85@gmail.com` and a `Co-Authored-By` trailer naming the implementing model;
  - stage specific paths only;
  - never commit `.env*`, `apps/web/.env.local`, `fixtures/eval-products/`, `.superpowers/` or media;
  - push after the milestone's final review.
- **Secrets:** Inngest signing and event keys, R2 keys and the Supabase keys live only in `.env` (worker) and the Vercel env. They are never printed, committed or put in prompts.

## Review Focus

1. **A stale heartbeat:** a worker is killed, or the machine sleeps. Expected: no dispatch, the UI shows "GPU offline, queue paused", and running jobs are **not** failed by the janitor while offline. Tests in Task 2 and Task 3.
2. **Duplicate dispatcher runs:** cron and nudge together, or two overlapping crons. Expected: each queued job gets exactly one `job.requested` (event id plus `dispatched_at` claimed under `FOR UPDATE SKIP LOCKED`). Test in Task 2.
3. **A worker killed mid-step:** expected, the step retries on reconnect and nothing is double-recorded (existing idempotency keys). Soak in Task 4; the unit test of the shutdown order is in Task 1.
4. **A job queued longer than `offlineMaxHours` (24):** expected, it is failed with "GPU offline for 24 h", exactly once. Test in Task 2.
5. **A queue position for org A's job while org B has jobs ahead:** expected, it counts B's jobs, but the response holds only `{ position, etaRange | 'paused' }`. Test in Task 3.

## Accounts the user provides (before the e2e; tasks 1–4 do not need them)

- **Inngest Cloud:** an app with a **dev/staging** environment. Its `INNGEST_SIGNING_KEY` and `INNGEST_EVENT_KEY` go in `.env` (worker) and the Vercel env (web).
- **Vercel:** a project linked to the GitHub repo, with root directory `apps/web` and the default build command.

The controller creates the rest: env vars through `vercel env`, bucket CORS through wrangler.

## File map

| File | Responsibility | Task |
|---|---|---|
| `apps/worker/src/main.ts`, `apps/worker/src/connect.ts`, `apps/worker/src/heartbeat.ts`, `apps/worker/src/shutdown.ts` | prod connect worker, heartbeat, shutdown order | 1 |
| `packages/db/src/schema.ts`, `packages/db/drizzle/0019_*.sql` | `workers` table; `jobs.dispatched_at`; grants | 1 |
| `docs/providers/inngest-connect.md` | connect docs (docs-first) | 1 |
| `packages/pipeline/src/dispatch.ts`, `inngest.ts`, `janitor.ts`, `orchestrate.ts` | dispatcher, offline bound, janitor offline pause, priority, timeouts | 2 |
| `apps/web/lib/server/jobs-api.ts`, `apps/web/lib/server/events.ts` | submit → nudge (no direct `job.requested`) | 2 |
| `packages/pipeline/src/queue.ts`, `apps/web/lib/server/queue-owner.ts`, `apps/web/app/jobs/[id]/…` | `queueStatus` and the badge | 3 |
| `scripts/supervisor.ps1`, `scripts/install-supervisor.ps1`, `apps/worker/src/log.ts`, `docs/runbook.md` | supervisor, JSON logs, runbook | 4 |
| `apps/web/lib/server/db.ts`, `vercel.json` (only if required), docs | Vercel deploy config | 5 |
| `docs/decisions/0020-b4-hosted-queue.md` | ADR | 6 |
| `apps/worker/src/e2e-hosted-queue.ts` | the e2e | E2e |

---

### Task 1: Connect worker, heartbeat, `workers` table (Sonnet implements, Opus reviews: grants + no inbound port)

**Files:**
- Create: `apps/worker/src/connect.ts`, `apps/worker/src/heartbeat.ts`, `docs/providers/inngest-connect.md`, `packages/db/drizzle/0019_workers_dispatch.sql`
- Modify: `apps/worker/src/main.ts`, `apps/worker/src/shutdown.ts`, `packages/db/src/schema.ts`, `packages/core/src/config/env.ts` (`ADFORGE_WORKER_ID`, required in prod, `^[a-z0-9-]{3,40}$`)
- Test: `apps/worker/test/heartbeat.test.ts`, `apps/worker/test/shutdown.test.ts` (extend), `packages/db/test/rls.test.ts` (privileges for `workers`)

**Docs first:** read the installed `inngest@4.21.1` `components/connect` types and README. Fetch Inngest's connect docs page into `docs/providers/inngest-connect.md`, covering:
- `connect()` options: `instanceId`, `maxWorkerConcurrency`, `handleShutdownSignals`, `isolateExecution`, `gatewayUrl`;
- the `close()` / `closed` lifecycle;
- whether the dev server supports connect;
- the env keys connect needs (`INNGEST_SIGNING_KEY`, `INNGEST_EVENT_KEY`).

**Interfaces:**
- **Produces:**
  - `startConnect({ functions, instanceId }): Promise<{ close(): Promise<void> }>` — `connect({ apps: [{ client: inngest, functions }], instanceId, maxWorkerConcurrency: 1, handleShutdownSignals: [] })`, because our shutdown owns the signals.
  - `startHeartbeat({ db, instanceId, probes, intervalMs = 30_000 }): { stop(): void }`. It upserts `workers(instance_id, last_seen = now(), status 'online', gpu, vram_free_mb, services jsonb)`. `probes` reads `nvidia-smi` (timeout 2 s; a null value on failure is fine) and each local service's `/health` (2 s timeout) → `{ comfyui: bool, voice: bool, qwen: bool, vision: bool }`. On stop it writes `status 'offline'` once (best effort).
  - Migration 0019:
    - `workers(instance_id text pk, last_seen timestamptz not null, status text not null check (status in ('online','offline')), gpu text, vram_free_mb integer, services jsonb not null default '{}')`;
    - `ALTER TABLE jobs ADD COLUMN dispatched_at timestamptz`;
    - an index on `jobs(status, created_at) WHERE dispatched_at IS NULL`;
    - `REVOKE ALL ON workers FROM anon, authenticated`, with no policies (owner-only).
  - `main.ts`:
    - `ADFORGE_ENV=prod` → `startConnect` + heartbeat, **no `createServer`/`listen`**;
    - dev → unchanged `serve()` + dev HTTP API, plus the heartbeat (so the dev UI badge works).
  - Shutdown order: heartbeat.stop → connect.close (or server.close in dev) → DB close, all within the 10 s bound.

- [ ] **Step 1: Write the failing tests.**
  - heartbeat: an upsert every interval with fake timers; `last_seen` advances; a failing probe gives `services.<x> = false`, not a throw; stop writes offline once.
  - shutdown: the order is heartbeat → connect → db, with a fake connect whose close takes 3 s; the 10 s bound still holds.
  - `main` prod-mode factory: no listen is called (inject a server factory spy).
  - privileges: `authenticated` has no privilege on `workers`; `jobs.dispatched_at` is not user-writable (check the existing jobs grants).
- [ ] **Step 2: Run them and confirm they fail. Step 3: implement. Step 4: run them and confirm they pass, then `pnpm test`, `pnpm typecheck` and `pnpm db:check`.**
- [ ] **Step 5: Commit:** `feat(worker,db): inngest connect worker (prod), heartbeat, workers table`

---

### Task 2: Dispatcher, offline bound, janitor offline pause, priority, timeouts (Opus implements, Opus reviews)

**Files:**
- Create: `packages/pipeline/src/dispatch.ts`
- Modify: `packages/pipeline/src/inngest.ts`, `packages/pipeline/src/janitor.ts`, `packages/pipeline/src/orchestrate.ts`, `packages/core/src/config/pipeline.ts` (`jobs.offlineMaxHours: 24`, `jobs.heartbeatFreshSec: 120`), `apps/web/lib/server/jobs-api.ts`, `apps/web/lib/server/events.ts`
- Test: `packages/pipeline/test/dispatch.test.ts`, `packages/pipeline/test/janitor.test.ts` (extend), `apps/web/test/jobs-routes.test.ts` (extend)

**Interfaces:**
- **Produces:**
  - `workerOnline(db, now?): Promise<boolean>` — any `workers.last_seen` within `heartbeatFreshSec`.
  - Inngest function `dispatcher`, triggers `[{ cron: '* * * * *' }, { event: 'adforge/dispatch.nudge' }]`, `concurrency: [{ limit: 1 }]`, retries 2. In one step:
    - **Offline:** fail every queued, undispatched job older than `offlineMaxHours` (`status 'failed'`, error `{ message: 'GPU offline for 24 h' }`), guarded by `status = 'queued'`. Then return.
    - **Online:** claim up to 10 oldest queued, undispatched jobs (`UPDATE … SET dispatched_at = now() WHERE id IN (SELECT id … ORDER BY created_at FOR UPDATE SKIP LOCKED LIMIT 10) RETURNING id`), then send `adforge/job.requested { jobId, priority: 'job' }` with event `id: job:<jobId>` for each.
    - If a send fails after the claim, reset `dispatched_at` to null for the unsent ids.
  - **Submit:** `createJobHandler` stops sending `job.requested`. After the commit it sends `adforge/dispatch.nudge` (fire-and-forget with a timeout; a failure is fine, the cron covers it).
  - **Janitor:** a running job past `staleAfterMin` is failed **only when `workerOnline`**. Offline, it is left alone (paused).
  - **Priority:**
    - `variant.edit`, `variant.export` and `product.ingest` events carry `priority: 'interactive'`;
    - the heavy functions get `priority: { run: "event.data.priority == 'interactive' ? 600 : 0" }`;
    - `step.invoke` payloads pass `priority` through from the parent event;
    - generateAds' invokes pass `'job'`.
  - **`generate-ads` timeouts:** `start` stays; `finish` goes from 4h to 6h (dispatch happens only while online, so the run window starts at dispatch). Record this in the ADR.
- [ ] **Step 1: Write the failing tests:**
  - **Review Focus 1:** a stale heartbeat (last_seen 3 min ago) → 0 sends, 0 claims.
  - **Fresh heartbeat:** 3 queued jobs → 3 sends in created_at order, each with id `job:<id>`, and `dispatched_at` set.
  - **Review Focus 2:** run the dispatcher twice concurrently (two promises over PGlite, plus a Postgres-gated variant using `ADFORGE_TEST_DATABASE_URL`) → each job is sent exactly once.
  - **Send failure:** the second send throws → that job's `dispatched_at` is reset, and the next run sends it.
  - **Review Focus 4:** a job queued 25 h ago while offline → failed with the message, exactly once over two runs. While online it is dispatched instead.
  - **Janitor:** a stale running job while offline → untouched; while online → failed (existing behaviour).
  - **Priority:** the edit, export and ingest send sites include `priority: 'interactive'`; the heavy function config has the priority expression; invoke payloads carry it.
  - **Submit route:** no `job.requested` is sent; a nudge is sent; the job is queued with `dispatched_at` null.
- [ ] **Step 2: Run them and confirm they fail. Step 3: implement. Step 4: run them and confirm they pass, then `pnpm test` and `pnpm typecheck`.**
- [ ] **Step 5: Commit:** `feat(pipeline,web): heartbeat-gated dispatcher, offline bound, interactive priority`

---

### Task 3: `queueStatus` and the queue badge (Sonnet implements, Sonnet reviews)

**Files:**
- Create: `packages/pipeline/src/queue.ts`, `apps/web/lib/server/queue-owner.ts`
- Modify: `apps/web/lib/server/jobs-api.ts` (the job view includes `queue`), `apps/web/lib/view.ts`, `apps/web/app/jobs/[id]/page.tsx`
- Test: `packages/pipeline/test/queue.test.ts`, `apps/web/test/jobs-routes.test.ts` (extend)

**Interfaces:**
- **Produces:**
  - `queueStatus(db, jobId, now?): Promise<{ position: number; etaRange: [number, number] } | { position: number; etaRange: 'paused' } | null>`. It returns null when the job isn't queued or running.
  - `position` = 1 + the number of queued or running jobs (all orgs) created before this one.
  - `etaRange` = `[ahead × p50 + remaining, ahead × p90 + remaining]` in seconds, where:
    - p50/p90 are over completed jobs from the last 30 days with the same `(language, broll)`, falling back to all completed jobs, then to `PIPELINE.jobs.defaultDurationSec` (900);
    - `remaining` for the running job is max(0, p50 − elapsed since dispatched_at).
  - `etaRange` is `'paused'` when `!workerOnline`.
  - Called from the web only through `queue-owner.ts` (owner connection, `*-owner.ts` rule). The job view returns just `{ position, etaRange }`.
  - **UI:** a badge on the job page. "In queue: #2 · about 12–20 min", "Running · about 6–9 min left", or "GPU offline, queue paused". It refreshes with the existing poll.
- [ ] **Step 1: Write the failing tests:**
  - ETA from seeded completed durations, including the language and b-roll split and the fallbacks;
  - position counts other orgs' jobs;
  - **Review Focus 5:** the job view JSON for org A contains no other job id or org id;
  - paused when the heartbeat is stale;
  - null for a completed job;
  - the badge text formatting as a pure function.
- [ ] **Step 2: Run them and confirm they fail. Step 3: implement. Step 4: run them and confirm they pass, then `pnpm test` and `pnpm typecheck`.**
- [ ] **Step 5: Commit:** `feat(pipeline,web): queue position and ETA, GPU-offline badge`

---

### Task 4: Supervisor, JSON logs, runbook (Sonnet implements, Sonnet reviews)

**Files:**
- Create: `scripts/supervisor.ps1`, `scripts/install-supervisor.ps1`, `scripts/supervisor.config.json`, `apps/worker/src/log.ts`
- Modify: `apps/worker/src/main.ts` (use the logger), `docs/runbook.md`, `scripts/voice.ps1`, `scripts/voice-qwen.ps1`, `scripts/vision.ps1`, `scripts/comfyui.ps1` (only if the supervisor replaces their loops — keep them runnable by hand)
- Test: `scripts/test/supervisor.test.ps1` (run by a vitest wrapper in `apps/worker/test/supervisor.test.ts` that spawns PowerShell with a **dummy child**: a node script that exits on a signal file)

**Interfaces:**
- **Produces:**
  - `supervisor.ps1 -Config scripts/supervisor.config.json`. The config lists services `{ name, cwd, command, args, restartOn: 'any' | [codes], maxRestarts: 5, windowMin: 10, backoffSec: 2 }`, covering ComfyUI, voice, voice-qwen, vision and the worker.
  - The supervisor starts each service hidden, restarts it on exit per its policy, logs JSON lines to `<ADFORGE_DATA_DIR>/logs/supervisor-YYYYMMDD.log`, and on Ctrl-C / stop kills each child tree.
  - `install-supervisor.ps1` registers a **logon scheduled task** ("AdForge supervisor", run whether or not the user is logged on is NOT required; restart the task on failure), with `-Uninstall` to remove it. The user runs it; the task never runs it.
  - `log.ts`: `logger.info/warn/error(msg, fields)` writes one JSON line to stdout **and** to `<ADFORGE_DATA_DIR>/logs/worker-YYYYMMDD.log`, rotated daily, keeping 14 files. Secrets are redacted by key name (`*key*`, `*secret*`, `*token*`, `*password*`, `DATABASE_URL`).
  - Runbook: first sections for start/stop, the supervisor install/uninstall, where the logs are, "GPU offline" troubleshooting, and the kill switch placeholder (B5).
- [ ] **Step 1: Write the failing tests:**
  - a killed dummy child restarts within 30 s;
  - five exits in 10 min stops restarting and logs it;
  - stopping the supervisor leaves no child alive;
  - the logger writes JSON lines, rotates by date and redacts the secret-named keys.
- [ ] **Step 2: Run them and confirm they fail. Step 3: implement. Step 4: run them and confirm they pass, then `pnpm test`.** The real services are **never** started by the tests.
- [ ] **Step 5: Commit:** `feat(ops): supervisor with restart policy, JSON logs, runbook`

---

### Task 5: Vercel deploy configuration (Sonnet implements, Opus reviews: secrets + tenancy config)

**Files:**
- Modify: `apps/web/lib/server/db.ts` (prod pool via the transaction pooler `:6543` with `prepare: false`, as postgres-js requires for pgbouncer-style pooling; keep the dev path), `apps/web/lib/server/env.ts` (validate `ADFORGE_SITE_URL` as `https` in prod), `docs/runbook.md` (§ "Deploy (Vercel)")
- Create only if required by the docs: `apps/web/vercel.json`

**Docs first:** read the Vercel monorepo, Next.js and env-var docs, and Supabase's pooler guidance (transaction mode `:6543` with postgres-js) into `docs/providers/vercel.md`.

**Interfaces:**
- **Produces:**
  - The web DB URL in prod is the transaction pooler.
  - A statement timeout is set per connection (B1 carry-forward), e.g. `connection: { statement_timeout: 15000 }` if the pooler honours it. If it doesn't, apply it per transaction. Document which.
  - The runbook lists every Vercel env var by name: `ADFORGE_ENV`, `ADFORGE_SITE_URL`, `DATABASE_URL` (pooler), the Supabase URL and keys, the `R2_*` vars, `ADFORGE_PROVIDER_STORAGE=r2`, `ADFORGE_MEDIA_TTL_SEC`, `INNGEST_SIGNING_KEY`, `INNGEST_EVENT_KEY`.
  - The controller sets them with `vercel env add` once the project exists, and adds the preview and prod origins to the R2 bucket CORS with wrangler (as in the B3 runbook).
- [ ] **Step 1: Write the failing tests:** prod env without https `ADFORGE_SITE_URL` fails to parse; the prod pool options carry `prepare: false` and the statement timeout (unit-test the options builder).
- [ ] **Step 2: Run them and confirm they fail. Step 3: implement. Step 4: run them and confirm they pass, then `pnpm test`, `pnpm typecheck` and `pnpm --filter @adforge/web build`.**
- [ ] **Step 5: Commit:** `feat(web): Vercel prod config (transaction pooler, statement timeout, site URL)`

---

### Task 6: ADR 0020 (Worker via the room, Sonnet reviews)

The controller writes the fact brief (the amendments, the supervisor choice, timeouts, the dispatch design, the connect findings) and dispatches a free OpenCode worker in a clean worktree. File: `docs/decisions/0020-b4-hosted-queue.md` in the format of 0019.

---

### E2e: `pnpm e2e:hosted-queue` (Sonnet writes it; the controller runs it once — GPU-free)

- **Preconditions:**
  - the Inngest Cloud dev env keys are in `.env`;
  - the Vercel preview is deployed with the env vars set;
  - prod-profile worker settings: dev Supabase, dev R2, `ADFORGE_WORKER_ID=gpu-dev-1`;
  - **ComfyUI, voice, voice-qwen and vision OFF.**
- **Steps:**
  1. Start the worker (connect).
  2. Submit 2 jobs through the preview's API with a signed-in test user (Playwright, or the API with a session cookie the controller provides).
  3. Assert the job view shows positions 1/2 and an ETA.
  4. Stop the worker and wait 2.5 min; assert `etaRange: 'paused'` and the jobs still queued or running.
  5. Restart the worker; assert both jobs dispatch and reach a terminal state (they fail at preflight: no ComfyUI).
  6. Assert `Get-NetTCPConnection -State Listen` shows no non-loopback listener owned by the worker process.
- **Pass** = all of the above. Stop everything started; confirm no process is left.
