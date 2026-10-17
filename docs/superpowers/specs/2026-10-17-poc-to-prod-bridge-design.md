# AdForge POC → Production bridge: design

**Status:** design, awaiting approval · 2026-10-17

**Builds on:**
- `docs/architecture.md`, which wins on conflict except where this doc records an amendment;
- the Creative Engine v2 design (`2026-10-17-creative-engine-v2-design.md`, milestones C1–C8);
- the local POC (P0–P8, merged, `main`).

**Companion roadmap:** `docs/superpowers/plans/2026-10-17-bridge-roadmap.md`. It interleaves bridge milestones (B*) with C1–C8 and grades every task by model.

---

## 1. Intent and why

The POC proves a local machine can turn product photos into three ads. Production means **outside brands log into a hosted site, upload products, and get ads, while generation keeps running on the user's local GPU machine.** Brands arrive from a **waitlist** and are invited in; **payments are deferred.** Cloud GPUs come later, behind the existing provider interfaces.

This design is the bridge. It defines what changes from the POC stack to the production stack, in an order that lets the Creative Engine v2 work land on production-shaped foundations instead of being migrated afterwards.

## 2. User decisions (2026-10-17)

| Question | Decision |
|---|---|
| Who and where | **A hosted site for outside brands. Generation runs on the local GPU machine**, which pulls work from the queue. |
| Production bar | Login with per-brand data isolation; cost tracking and limits; survives restarts and failures. Billing was chosen first, then **deferred**. |
| Billing | **Not needed yet.** A public **waitlist joining form** instead. Brands are invited from it. Credits stay as an **internal quota** the admin grants (my call, §5.6), so payments can plug in later. |
| Launch point | **After C4** (library, editable cache, Director v2, renderer craft). C5–C8 ship as updates after launch. |
| Hosting | **The architecture stack:** Vercel (Next.js), Supabase (Postgres + Auth), Cloudflare R2 (media), Inngest Cloud (queue). The GPU machine connects outbound only. |
| Throughput at launch | **One GPU, a visible queue with an ETA.** That's fine for tens of jobs a day. |
| LLM | **Keep the Claude subscription until launch.** The subscription is licensed for the user's own use, so **switching to the Anthropic API is a hard launch gate**: no outside customer job may run on the subscription. |
| Ordering | **Interleave** bridge milestones with C1–C8. The foundations C1/C2 need come first. |

## 3. Goals, non-goals, anti-goals

**Goals:**
- Anyone can join the **waitlist**. The admin invites a brand, which then signs in, uploads products, watches its job in a queue with an ETA, reviews (and, after C7, edits) ads, and exports, all on the hosted site.
- Every brand sees only its own data, enforced in the database (row-level security), not only in app code.
- Every job has a **cost** (LLM tokens, GPU-seconds, render time) recorded per provider call, a **budget**, and per-brand **caps**. A global kill switch stops new work.
- **Nothing is lost or stuck when the GPU machine sleeps, reboots, crashes or loses network:**
  - jobs wait in the queue;
  - in-flight steps retry idempotently;
  - the site shows "GPU offline, queue paused";
  - the operator gets an alert.
- Quota (credits) is charged correctly under partial success and retries: never double-charged, refunded for undelivered variants.
- Production is an **environment profile**, not a fork. The pipeline and `pnpm test` stay offline-capable on PGlite and local disk (dev data access: §6).

**Non-goals for this bridge:**
- cloud GPU providers;
- distribution/publishing (architecture Phase 4);
- attribution (Phase 5);
- teams with roles beyond owner/member;
- **payments of any kind** (Stripe/Razorpay, tax, invoices). Deferred by the user; the credit ledger is the seam where they'll attach;
- multiple GPU machines. Design for them, don't build them, beyond what `connect` gives for free.

**Anti-goals:**
- A customer job running on the personal Claude subscription.
- Any inbound port opened on the GPU machine.
- A job that silently stalls with no refund of quota and no signal.
- POC-only models (non-commercial licenses) producing customer output.
- Customer media served from third-party signed URLs (CLAUDE.md: `MediaRef.url` is always internal).

## 4. Target architecture

```
 Browser ──HTTPS──► Vercel (Next.js app: UI + API routes, Supabase Auth session)
                         │  reads/writes (RLS as the user)        ▲ signed media URLs
                         ▼                                        │
                    Supabase Postgres ◄────────────┐         Cloudflare R2 (private bucket)
                         ▲                         │              ▲
     job.requested event │                         │ service role │ put/get
                         ▼                         │              │
                    Inngest Cloud ◄══ outbound WebSocket (inngest/connect) ══╗
                                                                             ║
                    ┌──────────────── GPU machine (Windows, local) ──────────╨──────┐
                    │ gpu-worker (Node): Inngest functions via connect, maxWorkerConcurrency 1 │
                    │   ComfyUI · voice · voice-qwen · music · renderer · Claude (subscription→API) │
                    │   local disk = cache only; every output → R2; rows → Postgres     │
                    └────────────────────────────────────────────────────────────────────┘
```

**Control plane (hosted, Vercel):**
- waitlist, auth, upload, product library, job submission, queue/ETA, review/editor UI, quota, admin;
- it **never** calls the GPU machine directly; it writes rows and sends Inngest events.

**Data plane (the GPU machine):**
- the existing worker becomes `gpu-worker`, an **Inngest `connect` worker** (outbound WebSocket, `maxWorkerConcurrency: 1`, `instanceId` per machine);
- it runs all heavy functions and the LLM calls. LLM calls must run there while the subscription is in use, and may move to Vercel after the API switch;
- it talks only outbound: Inngest Cloud, Supabase Postgres (TLS), R2, and later the Anthropic API.

**The POC worker's HTTP surface is retired in production:**
- the Host/Origin guard, CORS and `ADFORGE_UI_ORIGIN` from ADR 0012 stay for the dev profile only;
- media is served from R2 through short-lived signed URLs minted by the app, on our domain;
- this amends ADR 0012 for production.

**Environment profiles:**
- `ADFORGE_ENV=dev`: PGlite, `LocalDiskStorage`, Inngest dev server, `serve()`, subscription LLM, all providers allowed.
- `ADFORGE_ENV=prod`: Postgres, R2 storage, Inngest Cloud via `connect`.
- Boot **fails** in prod if any configured provider is marked `pocOnly`, which extends the existing "fail to start on a bad id" rule. After the launch gate, that includes the subscription LLM.

## 5. Design by concern

### 5.1 Data and tenancy
- **One Drizzle schema, two drivers.** PGlite in dev and `postgres` in prod, chosen by profile. Migrations are identical and run in CI against both.
- **Tenancy model:** `orgs` (a customer account) → `memberships` (user, org, role owner|member) → `projects` (= brand, per C1) → `products` → jobs, variants, assets, library rows, edit logs. Every tenant table carries `org_id`. This resolves architecture §14.6 "row-level projectId scoping now".
- **RLS** on every tenant table: a user reads and writes rows of orgs they're a member of. The gpu-worker uses the service role. Tests prove a member of org A can't read org B, via SQL-level tests against Postgres in CI.
- **The registry stays global** (architecture §14.7 "global registry + per-project overrides"). Registry tables have no `org_id` and are read-only to users.
- **Storage keys become tenant-prefixed in prod:** `org/<orgId>/<2-hex>/<sha>.<ext>`. Content dedupe works within an org. `VideoSpec`'s `StorageKey` regex is widened accordingly, and dev keys stay valid.

### 5.2 Identity
- **Supabase Auth:** email magic link plus Google.
- The Next app uses server-side session cookies, and API routes run as the user so RLS applies.
- The first sign-up creates an org.
- Admin is a flag on the user, the operator (you), and gates the admin pages: queue, kill switch, credit grants, library approvals oversight.

### 5.3 Media
- **The `R2Storage` provider** implements `StorageProvider` (`put` / `read` / `urlFor`), with Zod-validated config and docs-first per CLAUDE.md. A recorded live response and a golden request apply as for any provider.
- **On the GPU machine, local disk is a read-through cache** in front of R2, keyed by storage key. HyperFrames staging reads from the cache, so renders stay fast and offline-safe.
- **Uploads:**
  - the browser asks the app for a **presigned PUT** (mime and size limited), uploads straight to R2, then the app records the asset;
  - the gpu-worker re-validates (magic bytes, decode, dimension caps) before use, and re-encodes images to strip metadata.
- **Media URLs** are app-minted, short-lived signed GETs, the "internal URL" for prod. Preview (C2/C7) uses the same.

### 5.4 Jobs, queue and ETA
- Job submission is an API route. In one transaction it inserts the `jobs` row and **reserves credits** (§5.6), then sends `adforge/job.requested`.
- **The queue position is derived** from `jobs` rows in `queued`/`running` state, ordered by created time.
- **The ETA** = (jobs ahead × p50 job duration) + the current job's remaining estimate. p50 comes from recent `jobs` timings per configuration (language, b-roll on/off), shown as a range. There's no new service: it's a query.
- **The existing heavy lane** (one env-scoped concurrency key, limit 1) stays. `maxWorkerConcurrency: 1` on the connect worker doubles it. With more GPU machines later, the limit becomes per-instance.

### 5.5 Reliability: survives restarts and failures
- **Worker heartbeat:** a `workers` table (`instance_id`, `last_seen`, `status`, `gpu`, `vram_free_mb`, `services`) is updated every 30 s by gpu-worker. The site shows "GPU offline, queue paused" when `last_seen` is older than 2 minutes, and the ETA says "paused".
- **The supervisor** on the GPU machine runs as a Windows **service** or a logon scheduled task (builder's choice, recorded in an ADR). It:
  - starts ComfyUI, voice, voice-qwen and gpu-worker;
  - restarts them on crash (it generalizes the existing `voice.ps1` restart-on-exit-3 loops);
  - survives reboot.
- **In-flight safety:**
  - Inngest steps are already idempotent (P7: `provider_calls` upsert, namespaced idempotency keys);
  - a worker disconnect mid-step means Inngest retries the step on reconnect;
  - local service liveness (watchdogs, idle unload, VRAM wait) is unchanged.
- **Stale reconciliation:**
  - the existing janitor also refunds credits for jobs it fails;
  - a job exceeding `staleAfterMin` while the worker is **offline** is not failed, it's paused, because the queue waits for the GPU;
  - jobs are only failed when the worker is online and the job is stuck.
- **Alerts:** a Discord webhook (the user uses Discord), triggered by:
  - worker offline for more than 10 min;
  - a job failed;
  - daily cost over its threshold;
  - the kill switch flipped;
  - a new waitlist entry.
  Implemented as an Inngest function, so it's retried.
- **Observability:**
  - structured JSON logs on gpu-worker, rotated to disk;
  - Vercel logs for the control plane;
  - LLM traces via the existing call recording, with Langfuse (architecture) deferred to the API switch.
- **Backups:** Supabase daily backups (managed) plus R2 versioning on the media bucket. A restore drill is part of the launch gate.

### 5.6 Waitlist, invites and quota (payments deferred)

**Waitlist:**
- A public page with a form: name, email, brand, website, category, country, and an optional note.
- Validated with Zod, rate-limited, bot-protected (a honeypot field plus a time-to-submit check; no third-party captcha in this bridge).
- Stored in `waitlist` (not tenant-scoped, readable by the admin only), and a Discord alert fires on each new entry.

**Invites:**
- The admin page lists the waitlist, and **Invite** sends a Supabase Auth magic-link invite.
- On first sign-in the org is created and the waitlist row is marked `invited` → `joined`.
- Sign-up without an invite is closed in prod.

**Quota (credits):**
- **`credit_ledger` is append-only:** `(org_id, delta, reason, ref_type, ref_id, created_at)`.
- A unique constraint on `(reason, ref_type, ref_id)` makes every grant, reserve, settle and refund idempotent. The balance is a sum, materialized for reads.
- **Grants are admin-only** for now: an invite starting grant plus manual top-ups.
- **The job lifecycle:**
  - **reserve** 3 variants at submit;
  - **settle** on completion, charging **delivered** variants (§6) and **refunding undelivered ones**;
  - a failed or expired job is refunded in full.
- **Regenerations (C7)** are priced by edit class (creative design §4.6):
  - layout, style, text and timing edits are **free**;
  - voice-line and shot-content regenerations cost small fixed amounts;
  - structural re-direction costs a variant.
- **Prices are config** (`PRICING`). The admin page shows cost per job from §5.7, so when payments arrive, prices are set on evidence.
- **Payments later:** a payment provider will only ever *add* `grant` rows (`reason='purchase'`). Nothing else in the ledger changes.

### 5.7 Costs, budgets and limits
- **`provider_calls` already records cost per call.** It gains:
  - **GPU-seconds** for local providers, measured wall time on the heavy lane;
  - a configurable `$/GPU-hour` that covers electricity plus amortization, so local work has a non-zero cost;
  - LLM token usage. Subscription calls record *estimated* API-equivalent cost, so the launch-gate switch has no pricing surprise.
- **Per-job budget** in config. A job exceeding it fails the remaining optional work (b-roll first, then music), with a warning, never silently.
- **Per-org caps:** jobs per day and concurrent queued jobs, stored per org with defaults, editable by the admin.
- **A global kill switch** (DB flag): submissions are rejected with a clear message, and gpu-worker finishes the current step and pauses.
- **Rate limits** on API routes: waitlist, upload, submit, regenerate.

### 5.8 Security
- The GPU machine has **no inbound ports**. Secrets live in a local `.env` with OS-protected ACLs; the Supabase service role is never shipped to the browser.
- Upload validation (§5.3).
- Signed URLs expire, and the R2 bucket is private.
- RLS tests in CI.
- A **security review** (the `security-review` skill plus an Opus reviewer) before launch.
- **POC-only models are blocked in prod at boot** (§4), and licenses are recorded per provider in `docs/providers/*`.

### 5.9 CI and environments
- **GitHub Actions on every push:** `pnpm test` (all functional tests, golden files), migrations against PGlite and Postgres, RLS tests, typecheck, lint. GPU, live and e2e checks stay manual, as today.
- **Three environments:** dev (local), **staging** (its own Supabase project, R2 bucket, Inngest env and Vercel preview), and prod. The GPU machine runs one gpu-worker per environment it serves, staging only while testing.
- **Push policy:** the user approves the first push of the 100+ local commits. CI and deployments start after that.

### 5.10 The launch gate (before the first outside customer)
1. **The LLM provider is the Anthropic API.** The subscription is marked `pocOnly` in prod.
   - Model ids come from env, parsed by Zod at boot.
   - Prompt caching is verified by `cache_read_input_tokens` on real Director calls.
   - Effort is set via `output_config.effort`, never temperature.
2. **License audit:** every model that touches customer output has a verified commercial license in `docs/providers/*`.
3. **A security review passed,** and the RLS cross-tenant tests are green in CI.
4. **The restore drill passed** (Supabase plus R2).
5. **A staging soak:** 20 jobs end to end, including:
   - a worker kill mid-job (the job resumes);
   - a GPU-machine reboot (the queue pauses, then resumes);
   - a partial-success refund.
6. **The runbook** (`docs/runbook.md`): start/stop, alerts, the kill switch, refunds, rotating keys, restoring.

## 6. Decided vs left to the builder

**Decided by the user:** everything in §2.

**My calls (not discussed; say if wrong):**
- Inngest `connect` for the outbound GPU worker (verified present in the pinned `inngest@4.21.1`);
- a tenancy model of org → membership → project(brand) → product;
- a global registry;
- tenant-prefixed storage keys;
- a local disk read-through cache;
- an ETA from p50 job durations;
- a Discord webhook for alerts;
- GPU-seconds × a configurable $/GPU-hour as local cost;
- credits reserved at submit and settled per delivered variant;
- free layout/text/timing edits;
- credits as an admin-granted internal quota while payments are deferred;
- a honeypot plus timing bot check on the waitlist form;
- staging as a full separate environment;
- jobs pause rather than fail while the worker is offline.

**My calls from the builder check:**
- **Dev data access.** In dev the web app reaches data the same way as prod: Supabase client calls under RLS, against a **free hosted Supabase "dev" project**. Docker is avoided, because local Supabase costs about 2–4 GB of RAM and RAM is the tightest resource. **PGlite stays for `pnpm test`** and offline unit tests. The worker's dev HTTP API is kept only for local e2e scripts. Supabase CLI local is an option the plan documents, not the default. (This revises "dev fully offline": the browser flow needs network in dev; the pipeline and tests don't.)
- **Offline bound.** A queued or running job may wait **up to 24 h** (config) while the worker is offline, then it's failed and refunded with the reason "GPU offline".
  - Inngest timeouts (`finish`, `start`) are raised to match.
  - A **dispatcher** sends `job.requested` only while a worker heartbeat is live; otherwise the job stays `queued` in Postgres.
  - So nothing waits inside Inngest longer than Inngest retains it.
- **Priority.** Interactive GPU work (upload understanding, single regenerations, exports) gets **higher priority** than full jobs. It runs **between steps** of a running job (Inngest priority on the heavy lane), never preempting mid-step.
  - Upload understanding is free.
  - A library view generation costs a small fixed amount.
  - Exports are free up to a per-variant cap (config).
  - The ETA counts only work at or above the item's priority.
- **Tenancy of library and caches.**
  - Everything is **per org**, except the global registry and shipped static packs (SFX, LUTs, fonts).
  - Settings, music beds, product views and the recipe cache carry `org_id` and RLS, and **recipe keys include `orgId`**. No cross-tenant cache hits, so no leaks.
  - **Hero-eligibility approval is done by the brand's own user**, since it's their label; the admin can revoke.
- **"Delivered"** = rendered, exported to R2, and passing C8's hard checks once C8 exists (warnings still count as delivered). A user rejecting a delivered variant gets no refund, but free edits apply.
- **Launch after C4** means the launch gate runs right after C4. B milestones that C5–C8 don't need before launch (alerts polish, restore drill) are scheduled before the gate.

**Left to the builder** (plans, ADRs):
- the exact table schemas;
- the supervisor mechanism (Windows service vs scheduled task);
- the signed-URL TTL;
- the rate-limit implementation;
- the log format and rotation;
- Supabase Auth UI details;
- the R2 client library choice (docs first, pinned, at least 14 days old).
