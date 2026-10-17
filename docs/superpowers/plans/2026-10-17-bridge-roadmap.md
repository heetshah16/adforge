# POC → Production Bridge Roadmap (B1–B6 interleaved with C1–C8)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement each milestone's code-level plan task by task. Steps use checkbox (`- [ ]`) syntax. This file is the **roadmap**: scope, fixed interfaces, graded tasks, tests, and one e2e per milestone. **The code-level plan for each milestone** (writing-plans format, exact signatures, TDD steps) is written right before that milestone, because CLAUDE.md requires reading the real vendor docs first, and each milestone's real interfaces feed the next. Every code-level plan must honour the interfaces fixed here, or amend this file first.

**Goal:** take the merged local POC to an invite-only hosted product. Brands join a waitlist, sign in and get ads, while generation runs on the local GPU machine. The Creative Engine v2 lands on production-shaped foundations, and launch comes after C4.

**Architecture:**
- **Control plane:** Next.js on Vercel, Supabase (Postgres + Auth, RLS), Cloudflare R2, Inngest Cloud.
- **Data plane:** the existing worker becomes an outbound-only `inngest/connect` GPU worker on the local Windows machine.
- **Environment profiles** (`ADFORGE_ENV=dev|prod`) keep one codebase.

**Tech stack:**
- TypeScript, pnpm 12 + Turborepo, Drizzle (PGlite in tests and dev pipeline, Postgres in prod), Supabase JS, Next.js 16.3.8, Inngest 4.21.1 (`inngest/connect`);
- an R2 S3-compatible client (pinned in B3), HyperFrames 0.8.106, ComfyUI, Chatterbox / Qwen3-TTS services, the Claude Agent SDK, then the Anthropic API at B6.

**Specs:**
- [2026-10-17-poc-to-prod-bridge-design.md](../specs/2026-10-17-poc-to-prod-bridge-design.md) (B milestones, launch gate);
- [2026-10-17-creative-engine-v2-design.md](../specs/2026-10-17-creative-engine-v2-design.md) (C milestones);
- `docs/architecture.md` wins wherever neither spec records an amendment.

## Global Constraints

Every task's requirements include these:
- **Provider boundaries:**
  - provider SDK types never leave `packages/providers/<name>/`;
  - everything crossing a boundary is a `MediaRef` or a type from `packages/core/src/providers/types.ts`;
  - every provider request is Zod-validated before dispatch;
  - `MediaRef.url` is always an internal URL from `StorageProvider.urlFor` (in prod, an app-minted signed URL on our domain).
- **Frames and keys:** all timing is in frames, and layers reference storage keys, never URLs.
- **LLM rules:**
  - never set `temperature`, `top_p` or `top_k`; use `output_config.effort`;
  - structured output via Zod only;
  - model ids come from env, Zod-parsed at boot, and a bad id fails boot.
- **Boot gate:** prod boot fails if any configured provider is marked `pocOnly` (bridge §4). The Claude subscription becomes `pocOnly` at B6.
- **Pins and providers:**
  - pin exact versions at least **14 days old**, never ranges, and never add `minimumReleaseAgeExclude`;
  - a dependency build script needs an explicit `allowBuilds` entry;
  - new providers follow CLAUDE.md: docs into `docs/providers/<name>.md` first, one recorded live response, a golden request body, and an honest registry entry.
- **Tests:**
  - `pnpm test` passes before every commit, with no GPU, no network and no subscription in it;
  - exactly one e2e check per milestone, run once at the milestone's end;
  - render tests are 240×426, 5 frames.
- **Liveness:**
  - every outbound call has a timeout, every long operation a deadline;
  - every model holder an idle unload;
  - after any live run, stop the services you started and confirm VRAM is back to baseline. Never leave a process hanging.
- **Tenancy:**
  - every tenant table carries `org_id` with RLS;
  - recipe and cache keys include `orgId`;
  - prod storage keys are `org/<orgId>/<2-hex>/<sha>.<ext>`;
  - the registry and shipped static packs (SFX, LUTs, fonts) are global.
- **Registry rules (CLAUDE.md):**
  - slugs are never renamed or reused;
  - `variants` stores slugs, retired entries stay forever, nothing auto-promotes to `active`;
  - `jobs.shortlist` is snapshotted.
- **Git:**
  - commit with `git -c user.name=heetshah16 -c user.email=shahheet85@gmail.com` and the `Co-Authored-By` trailer;
  - **never push without the user's approval**;
  - never commit `fixtures/eval-products/`, `.env`, `.superpowers/` or media;
  - stage specific paths, never `git add -A`.
- **Workflow:** an ADR in `docs/decisions/` for every decision a spec didn't dictate.

## Model grading (who implements and reviews what)

Same scheme as the P3–P8 run: the least capable model that can do the job well. Turn count matters more than token price.

| Grade | Use for | Implementer | Task review |
|---|---|---|---|
| **Haiku** | transcription from a complete code-level plan; 1–2 files; mechanical edits, migrations written out in full, config, fixtures, docs | Haiku 5.5 | Sonnet |
| **Sonnet** | multi-file integration, provider adapters, pipeline wiring, UI pages, spikes with measurements | Sonnet 5.5 | Sonnet (Opus when the diff touches security or money) |
| **Opus** | architecture and judgment: tenancy and RLS design, the recipe/edit model, the ledger, the prompt compiler, security-sensitive code, anything with a subtle concurrency or idempotency argument | Opus 5.5 | Opus |

- **Every milestone ends with an Opus whole-branch review**, then one fix wave plus a scoped re-review.
- **Fix rounds 4–5** escalate one tier.
- **Rule:** a task graded Haiku whose code-level plan turns out to need judgment is re-graded in the ledger, and never forced.

## Review Focus

Failure modes the specs imply that no single task's happy-path tests exercise. Each line names the owning task's test.

1. **Cross-tenant leakage through a side door:** a cache hit, a storage key or a signed URL from org A served to org B. Expected: impossible.
   - B2.T2: an RLS test suite for every tenant table;
   - B3.T3: a signed URL for a key outside the caller's org prefix → 403;
   - C2.T2: recipe keys for identical inputs in two orgs differ.
2. **The GPU machine dies or sleeps mid-job.** Expected: the job resumes on reconnect, or after 24 h it's failed and refunded exactly once, and the site says "GPU offline".
   - B4.T2: a dispatcher test with a stale heartbeat;
   - B4.T4: the kill-mid-step soak;
   - B5.T2: a refund idempotent under a duplicate `onFailure` + janitor.
3. **Inngest retries a settle or refund step.** Expected: the ledger is unchanged on the second run.
   - B5.T2: the `(reason, ref_type, ref_id)` uniqueness test, plus a retry test.
4. **A hostile or odd upload:** HEIC, CMYK JPEG, a 40 MB PNG, a polyglot file, EXIF GPS. Expected: rejected with a clear message, or normalized to sRGB PNG/JPEG with metadata stripped.
   - B3.T2: a validation test per case.
5. **A signed media URL expiring during a long review or edit session.** Expected: the player refreshes the URL transparently, with no broken video.
   - B3.T3: an expiry-refresh test in the web media hook.

## What the user must provide, and when

| Needed | By | Notes |
|---|---|---|
| **Approval to push** `main` (100+ local commits) to GitHub | Start of B1 (CI) | Nothing is pushed until you say so. |
| A Supabase account: two projects, **dev** and **prod** (staging = dev until B6) | Start of B2 | The free tier is fine. Keys go into the local `.env` and Vercel env, never committed. |
| A Vercel account linked to the GitHub repo | Start of B2 | Preview deploys from branches. |
| A Cloudflare account with two R2 buckets (dev and prod) and an API token | Start of B3 | Private buckets. |
| An Inngest Cloud account (dev and prod envs) and signing/event keys | Start of B4 | — |
| A Discord webhook URL for alerts | B5 | A private channel. |
| An Anthropic API key (prod) | B6 | It replaces the subscription for customer jobs. |
| Approval of each spike's model license and measurements | C5 / C6 spikes | Like the Qwen A/B. |

## Milestone order

```
B1 profiles+CI ─► B2 tenancy/auth/waitlist ─► C1 library ─► B3 media on R2 ─► C2 editable+recipes
   ─► B4 hosted queue (connect) ─► C3 Director v2 ─► B5 cost+quota+limits ─► C4 craft ─► B6 LAUNCH GATE
   ─► (launch, invite-only) ─► C5 views ─► C6 audio ─► C7 editor UI ─► C8 QA
```

**Why this order:**
- C1 needs B2's `products` and `org_id`.
- C2's recipe cache needs B3's tenant keys.
- C3's stress test and Director calls must run on the B4 worker, because the subscription lives on the GPU machine.
- C4 is the launch quality bar.
- B5 must exist before any outside job.

**Spikes that may run early on a free GPU evening:** C5.S (view model) and the Indic TTS spike. They never block B work.

---

## B1: Environment profiles, the Postgres driver, CI

**Goal:** one codebase, two profiles. Drizzle runs on PGlite (tests, dev pipeline) or Postgres (prod), migrations are proven on both, and CI runs `pnpm test` on every push.

**Docs first:** `drizzle-orm` postgres-js driver docs for the pinned version; the GitHub Actions Node + pnpm setup docs.

**Interfaces fixed here:**
- `packages/core/src/config/env.ts` gains:
  - `ADFORGE_ENV: z.enum(['dev','prod'])`, default `dev`;
  - `DATABASE_URL` (required when `prod`);
  - a `providerPolicy(env)` that throws at boot when any configured provider id is in `POC_ONLY_PROVIDERS` and `ADFORGE_ENV==='prod'`.
- `packages/db/src/client.ts`: `openDb(env) → Db`, returning a PGlite-backed or postgres-js-backed Drizzle instance with an identical schema type. `closeDb(db)`.
- `POC_ONLY_PROVIDERS` lives in `packages/core/src/providers/registry.ts` (initially empty; B6 adds `claude-agent-sdk`).

**Tasks:**
1. **(Sonnet)** The profile switch plus `openDb(env)` with both drivers. The PGlite dead-pid lock reclaim stays PGlite-only. **Tests:**
   - the env parse matrix;
   - `prod` without `DATABASE_URL` fails boot;
   - `providerPolicy` rejects a pocOnly id in prod and allows it in dev.
2. **(Haiku)** **Migration parity:** a script `pnpm db:check` that applies all migrations to a fresh PGlite and to a Postgres URL given in env, and diffs `information_schema` column lists. **Tests:** PGlite apply in `pnpm test`; the Postgres leg runs in CI only.
3. **(Haiku)** **CI workflow** `.github/workflows/ci.yml`:
   - pnpm install with a frozen lockfile;
   - `pnpm test` (FFmpeg and chrome-headless-shell installed in the job, render tests at 240×426×5);
   - typecheck;
   - `pnpm db:check` against a Postgres service container.
   - **Needs the user's push approval first.**

**E2e:** push to a branch, and CI goes green on GitHub (all jobs). Locally, `ADFORGE_ENV=prod DATABASE_URL=<dev Supabase> pnpm db:check` passes.

---

## B2: Tenancy, identity, waitlist and invites

**Goal:** orgs, memberships, projects (= brands) and products, with RLS. Supabase Auth sign-in (invite-only in prod), a public waitlist form, an admin page to invite. The web data layer moves from the worker's HTTP API to Supabase under RLS (bridge §6, dev data access).

**Docs first:** Supabase Auth with Next.js App Router (SSR cookies, `@supabase/ssr`); Postgres RLS with `auth.uid()`; Supabase invite (`auth.admin.inviteUserByEmail`). Pin exact versions.

**Interfaces fixed here:**
- **Tables:**
  - `orgs(id, name, created_at)`;
  - `memberships(org_id, user_id, role: 'owner'|'member')`;
  - `projects(id, org_id, name, brand_kit jsonb)`, which repurposes the existing `projects` and adds `org_id`;
  - `products(id, org_id, project_id, name, created_at)`;
  - `waitlist(id, name, email unique, brand, website, category, country, note, status: 'new'|'invited'|'joined', created_at)`;
  - `users.is_admin boolean`.
- **Existing tenant tables gain `org_id`:** `assets`, `jobs`, `variants`, `provider_calls`. Registry tables don't.
- **RLS:** a helper SQL function `is_member(org uuid) returns boolean`. Every tenant table gets a policy `using (is_member(org_id))`. `waitlist` is admin-only. The worker connects with the service role.
- **Web data layer:** `apps/web/lib/data/*` holds typed functions (`listJobs`, `getJob`, `createJob`…) using the Supabase server client. `apps/web/lib/api.ts` (worker HTTP) remains only behind `ADFORGE_ENV==='dev' && ADFORGE_LOCAL_WORKER_API==='1'` for the local e2e scripts.
- **Job submission:** the route `POST /api/jobs` validates, inserts `jobs` (status `queued`), and returns `{ jobId }`. The event send is added in B4. In B2 it calls the existing dev path.

**Tasks:**
1. **(Opus)** **The tenancy migration:**
   - adds the new tables;
   - adds `org_id` to the existing tenant tables, with a backfill: one "Operator" org owning all POC data;
   - replaces `deps.projectId`, which the worker bound at boot, with job-scoped `orgId`/`projectId`;
   - widens asset dedupe to `(org_id, sha256)`.
   - **Tests:** migration on a seeded POC DB keeps every row; dedupe is per org; the worker reads org/project from the job row.
2. **(Opus)** **RLS policies plus the cross-tenant test suite** (Postgres only, CI):
   - for every tenant table, a member of org A gets 0 rows of org B for select, update and delete, and an insert with a foreign `org_id` fails;
   - `waitlist` is unreadable by non-admins.
   - The suite enumerates tenant tables from the schema, so a new table without a policy fails the test.
3. **(Sonnet)** **Supabase Auth in `apps/web`:**
   - magic link and Google, SSR session, a sign-in page, sign-out;
   - middleware protects app routes;
   - the first sign-in for an invited email creates the org and owner membership and marks the waitlist row `joined`;
   - prod sign-up is closed (invite-only).
   - **Tests:** route protection; first-login org creation is idempotent across two concurrent first requests.
4. **(Sonnet)** **The web data layer:** existing pages (upload, progress, review) move to `lib/data/*` under RLS, with uploads still to the dev storage path until B3. **Tests:** the existing page tests re-pointed at the new layer with a Supabase fake; Zod-parsed responses as before.
5. **(Haiku)** **The waitlist page and route:**
   - Zod schema, honeypot field, minimum 3 s time-to-submit, a per-IP rate limit behind a `rateLimit(key, limit, windowSec)` interface: in-memory now, swapped for the DB-backed implementation in B5.T3;
   - a duplicate email is a friendly "you're already on the list".
   - **Tests:** a validation case per field; honeypot or too-fast → 200 with no insert (silent); duplicate → no second row.
6. **(Sonnet)** **The admin page:** the waitlist table, **Invite** (Supabase invite plus `status='invited'`), the org list. Gated on `is_admin`. **Tests:** non-admin → 404; invite marks the row; a second invite click is idempotent.

**E2e:** `pnpm e2e:tenancy` (Playwright against the dev Supabase project):
1. Submit the waitlist form.
2. As admin, invite that email.
3. Sign in via the magic link (test inbox via the Supabase admin generate-link API).
4. See an empty org.
5. A second org's user can't see the first org's job.

---

## C1: The asset library and image understanding

As specified in creative design §4.1–4.2 and C1's exit criteria, on B2's tables.

**Docs first:**
- Depth-Anything-V2 Small (license Apache-2.0, verified);
- the chosen local OCR engine;
- the Agent SDK image input (already in ADR 0009).

**Interfaces fixed here:**
- **Tables:**
  - `library_assets(id, org_id, project_id, product_id null, tag, version, kind: 'product_view'|'location'|'prop'|'brand_kit'|'voice', descriptor text, storage_key, meta jsonb, status: 'active'|'superseded', hero_eligible bool, gate jsonb, created_at)` with unique `(org_id, tag, version)`;
  - a tag regex per kind from creative §4.1.
- **`packages/core/src/library/tags.ts`:** `makeTag(kind, parts) → string`, `parseTag(tag)`, and `nextVersion(tag, existing)`. It's pure.
- **`packages/core/src/understand/schemas.ts`:**
  - `ProductAnalysis`: shape class, viewpoint `{ azimuthDeg, elevationDeg }`, light direction, palette, label regions plus OCR text, material, visible faces;
  - `PlateAnalysis`: camera height and tilt, horizon, support surface region and plane, light direction and colour temperature, a luma grid, free zones, a depth storage key.
- **Providers (new):**
  - `DepthProvider.estimate(MediaRef) → MediaRef` (16-bit depth PNG);
  - `OcrProvider.read(MediaRef) → { text, boxes }`;
  - `VisionAnalyzer.analyzeProduct(MediaRef[]) / analyzePlate(MediaRef)` (LLM, structured).

**Tasks:**
1. **(Haiku)** Tag utilities plus the `library_assets` migration with RLS (B2 pattern). **Tests:** tag round-trip and version bump; the RLS suite picks up the new table automatically.
2. **(Sonnet)** **Spike plus the provider:** depth (Depth-Anything-V2 Small via ComfyUI or a small Python service, builder's choice recorded in an ADR), with docs, a golden file, a recorded response, VRAM measured and unloaded after.
3. **(Sonnet)** **Spike plus the provider:** local OCR on the Krishna labels (Devanagari plus Latin). Record accuracy on the two eval products.
4. **(Sonnet)** `VisionAnalyzer` on the Agent SDK with byte-frozen prompts. **Tests:** schema validation; golden prompts; recorded responses for both eval products.
5. **(Opus)** **The ingest pipeline:** upload → anchor plus cutout (existing BiRefNet) → analysis → descriptor draft → library rows. A new version is created on re-analysis, never an overwrite. This is an Inngest function at interactive priority (the B4 seam; the dev path for now). **Tests:** 1-photo and 3-photo products; re-upload of an identical photo dedupes to the same anchor; a descriptor edit makes `v2` and keeps `v1` resolvable.
6. **(Sonnet)** Plate analysis wired after plate generation in `generateAds`, stored in the variant meta. Brand kit and voice bible rows for Krishna (seeded from the scrape and current voice config). **Tests:** plate analysis fake → stored; the voice bible is used verbatim by the Qwen request (golden body).

**E2e:** `pnpm e2e:library`: upload one Krishna photo. **Pass:** anchor, cutout, descriptor, OCR label text, viewpoint and palette are printed and stored; plate analysis is printed for one generated plate; services are stopped and VRAM is at baseline.

---

## B3: Media on R2

**Goal:** prod media lives in private R2. The GPU machine keeps a local read-through cache, uploads go browser → R2 via presigned PUT, and media is served via app-minted signed GETs.

**Docs first:** the Cloudflare R2 S3 API (presigned URLs, CORS on the bucket), and the chosen S3 client (pinned, at least 14 days old).

**Interfaces fixed here:**
- `packages/providers/r2/`: `R2Storage implements StorageProvider`. The `put` key layout is `org/<orgId>/<2-hex>/<sha>.<ext>`. `urlFor(key)` returns `${ADFORGE_PUBLIC_URL}/media/<key>`, our route, never an R2 URL.
- **`StorageKey` regex** in `video-spec.ts` is widened to accept the optional `org/<uuid>/` prefix. Dev keys stay valid.
- `CachedStorage(inner: StorageProvider, dir) implements StorageProvider`: read-through, write-through.
- **Web routes:**
  - `POST /api/uploads` → `{ url, key, fields }` (a presigned PUT, mime/size bound, org-prefixed key);
  - `GET /media/[...key]` → a 302 to a signed R2 GET (TTL from config) after an RLS check that the key's org is a membership of the caller.

**Tasks:**
1. **(Sonnet)** `R2Storage` provider with docs, a golden request, one recorded live put/get against the dev bucket, and timeouts. Enable **bucket object versioning** (bridge §5.5 backups) and document it in the runbook. **Tests:** Zod config; key layout; golden signing input; a timeout becomes `ProviderError('TIMEOUT')`.
2. **(Sonnet)** **Upload path plus worker re-validation:** presigned PUT; the worker sniffs magic bytes, decodes, enforces a dimension cap, converts CMYK/HEIC to sRGB and strips EXIF/GPS, then re-encodes. **Tests (Review Focus 4):** HEIC, CMYK JPEG, 40 MB PNG, a polyglot, EXIF GPS; each rejected or normalized as specified.
3. **(Sonnet)** **The media route plus a client refresh hook.** **Tests (Review Focus 1 and 5):** a foreign-org key → 403; an expired signed URL is re-fetched by `useMediaUrl` without breaking playback (fake timers).
4. **(Haiku)** `CachedStorage` plus wiring by profile: dev = `LocalDiskStorage`, prod = `CachedStorage(R2Storage)`. **Tests:** a cache hit doesn't call the inner store; a write is persisted to both.

**E2e:** `pnpm e2e:r2`. Against dev R2: upload via the browser flow, run a short job with the prod profile on dev Supabase, and the review page plays media through `/media/*`. **Pass:** no R2 hostnames appear in the page; the cache directory fills; a second render is a cache hit.

---

## C2: The editable composition and recipe cache

As specified in creative design §4.6 plus the builder-check calls: a separate project document compiled into `VideoSpec`, cue-relative reveal timing, and edit revisions.

**Interfaces fixed here:**
- **`packages/core/src/project/`:**
  - `Project` (per variant revision: base generation ref plus `ops: EditOp[]`);
  - `EditOp`, a discriminated union: `move`, `resize`, `setText`, `setStyle`, `retime`, `setField`, `regenerate`, `lock`, `unlock`;
  - `compileProject(project, assets) → VideoSpec` (pure);
  - `classifyEdit(op) → 'free'|'voice'|'shot'|'structural'`.
- **`packages/core/src/recipe/`:** `Recipe` (compiled provider request, model id and version, seed, `orgId`), `recipeKey(recipe) → string` (stable hash), and `RecipeGraph` with `dependents(assetTag)` and `invalidated(ops) → RecipeKey[]`.
- **Tables:**
  - `recipes(key pk, org_id, kind, recipe jsonb, output_key, created_at)`;
  - `variant_revisions(id, org_id, variant_id, parent_id, ops jsonb, locked bool, created_at)`, where the original generation is revision 0;
  - approve requires `locked`.
- **`VideoSpec` v2:** element layers (`headline`, `stat`, `chip`, `badge`, `cta_button`, `logo`, `product`, `plate`, `broll`) with `layerId`, `box`, `z`, a cue-bound `reveal { cue, offsetFrames }`, plus `transition_in`, music and SFX tracks. A v1 spec is migrated by a pure `upgradeSpec`.
- **Browser preview:** the review page mounts the HyperFrames composition in the browser from `compileProject` output, with assets via `/media/*`.

**Tasks:**
1. **(Opus)** `Project`/`EditOp`/`compileProject`/`classifyEdit` plus `VideoSpec` v2 and `upgradeSpec`. **Tests:**
   - a golden compile per op;
   - a v1 spec upgrades and still renders identically (frame hash at 240×426×5);
   - cue-relative reveals survive a VO duration change.
2. **(Opus)** `Recipe`, `recipeKey` and `RecipeGraph`, plus recording a recipe for every generated asset in `generateAds`. **Tests:**
   - an identical recipe gives the identical key;
   - a different `orgId` gives a different key (Review Focus 1);
   - a layout-only op invalidates 0 recipes;
   - a VO edit invalidates exactly that line's TTS and alignment.
3. **(Sonnet)** **The regeneration executor:** apply ops, invalidate, regenerate only the invalidated recipes (cache hits skipped), re-flow, recompile. As an Inngest function `adforge/variant.edit`. **Tests:** an op sequence against fake providers asserts the exact provider call counts (0 for free edits, 1 for a VO edit).
4. **(Sonnet)** Revisions, lock and approve-requires-lock migration and routes, plus a dropped-edits report on structural regeneration. **Tests:** revision chain; approve-unlocked → 409; a dropped edit is listed.
5. **(Sonnet)** **In-browser preview** on the review page, with no editing UI yet: play the compiled project. **Tests:** the preview mounts the compiled composition; it's frame-identical to the MP4 at sampled frames (snapshot compare in the e2e).

**E2e:** `pnpm e2e:edit`. Generate one variant, then apply three ops via the API: move the product, edit a VO line, change the caption style. **Pass:**
- the provider-call delta is exactly one TTS plus one align;
- the preview shows all three edits;
- the export MP4 matches the preview at sampled frames.

---

## B4: The hosted queue: the connect worker, dispatcher, heartbeat, supervisor, ETA

**Goal:**
- the GPU machine serves Inngest Cloud through an **outbound** `inngest/connect` worker;
- jobs are dispatched only while a worker is live;
- the site shows queue position and ETA, or "GPU offline, queue paused";
- the machine restarts everything on crash or reboot.

**Docs first:** the Inngest `connect` docs for 4.21.1 (`connect()` options: `instanceId`, `maxWorkerConcurrency`, shutdown signals; the dev server's support for connect); Inngest priority and concurrency keys; Windows service options (NSSM vs the Task Scheduler). The ADR records the choice.

**Interfaces fixed here:**
- `apps/worker/src/main.ts`: in prod it runs `connect({ apps:[{ client, functions }], instanceId: ADFORGE_WORKER_ID, maxWorkerConcurrency: 1 })`. In dev it keeps `serve()` and the dev HTTP API.
- **Table:** `workers(instance_id pk, last_seen, status, gpu, vram_free_mb, services jsonb)`; the heartbeat is every 30 s.
- **Dispatcher:** an Inngest cron function (every 1 min). If any worker's `last_seen < 2 min` ago, it sends `adforge/job.requested` for `queued` jobs not yet dispatched (`jobs.dispatched_at`), oldest first. Otherwise it does nothing. A job queued for more than `PIPELINE.jobs.offlineMaxHours` (24) is failed with "GPU offline" (refund in B5).
- **Priority:** event data carries `priority: 'interactive'|'job'`, and the heavy lane uses Inngest priority so interactive work runs between job steps.
- **The `generateAds` timeouts** (`finish`, `start`) are raised to cover a dispatch-to-finish window. The offline wait happens in Postgres, not Inngest.
- **`queueStatus(orgId, jobId) → { position, etaRange: [minSec, maxSec] | 'paused' }`:** a pure query over `jobs` plus p50 durations by configuration.

**Tasks:**
1. **(Sonnet)** The connect worker plus the heartbeat (prod profile), and graceful shutdown that closes the connect worker within the existing 10 s bound. **Tests:** heartbeat writes; shutdown order (the connect worker closes, then the DB).
2. **(Opus)** **The dispatcher plus the offline bound plus priority wiring.** **Tests (Review Focus 2):**
   - a stale heartbeat → no dispatch;
   - a fresh one → dispatch, oldest first, exactly once under duplicate cron runs;
   - more than 24 h queued → failed with the reason;
   - interactive priority is set on regenerate and ingest events.
3. **(Sonnet)** `queueStatus` plus the UI badge (position, ETA range, "GPU offline, queue paused"). **Tests:** the ETA from seeded durations; paused when the heartbeat is stale.
4. **(Sonnet)** **The supervisor** (Windows service or scheduled task, per the ADR). It starts ComfyUI, voice, voice-qwen and the worker, restarts on exit (generalizing `voice.ps1`), and survives reboot. Plus **structured JSON logs** on the worker, rotated to disk (bridge §5.5), and `docs/runbook.md` first sections. **Test:** a script-level check that a killed service restarts within 30 s. **Soak:** kill the worker mid-step and the step retries on reconnect (Review Focus 2).

**E2e:** `pnpm e2e:hosted-queue`. With prod-profile staging (dev Supabase, dev R2, the Inngest Cloud dev env), submit 2 jobs from the hosted Vercel preview.
- **Pass:**
  - the queue shows position 2 and an ETA;
  - stop the worker → "GPU offline, queue paused";
  - restart → both jobs complete;
  - no inbound port is open on the machine (checked with `Get-NetTCPConnection -State Listen`, filtered to non-loopback).

---

## C3: Director v2

As specified in creative design §4.4–4.5 (roles, cues, persuasion, `acting_task`, arc on formats, the script bank, the stress test with one repair (ship with a warning after), the prompt compiler, shot lists, and the blueprint diversity rule).

**Interfaces fixed here:**
- `directorOutput` v2 schema fields exactly as in creative §4.4.
- Registry columns `formats.arc`, `formats.script_pattern`, `formats.examples jsonb`, `hook_archetypes.script_pattern`, `hook_archetypes.examples jsonb`.
- `packages/core/src/compiler/`: `compilePlatePrompt(shot, library, look) → string` and `compileViewPrompt(...)`, with fixed block order, positive phrasing only, descriptors verbatim.
- `stressTest(variant) → { verdicts, weakest, passed }`.
- `assertVariantDiversity` gains a distinct hook-beat blueprint rule (the LUT rule lands in C4.T6, once LUTs exist).

**Tasks:**
1. **(Haiku)** The registry migration plus the script bank seed: patterns and examples for every existing hook and format slug, from the research doc and the HyperFrames script bank shapes, adapted to FMCG/food. **Tests:** every active slug has a pattern; slugs unchanged.
2. **(Sonnet)** The Director v2 schema plus the byte-frozen prompt with the script bank in slug order. **Tests:** schema golden; prompt bytes stable across jobs; `cache_read_input_tokens > 0` on the recorded second call.
3. **(Opus)** **The prompt compiler** (CINEDANCE-style block order, positive-phrasing lint rejecting "no …" / "without …" / "avoid …"). **Tests:** a golden per block order; the lint fails on a negative phrase; descriptors appear verbatim.
4. **(Sonnet)** `stressTest` plus one repair plus a warning on residual failure; diversity rule additions plus repair. **Tests:**
   - a weak fixture variant gets a repair attempt, then a warning;
   - three identical hook blueprints → violation → repair → fail;
   - the existing diversity tests stay green.
5. **(Sonnet)** **Shot lists:** 1–3 shots per beat, with `buildSpec` laying out shots inside beats on cue boundaries; code writes the layout map from blueprint defaults (builder-check call). **Tests:** frame sums exact; shot cuts on cue frames; layout boxes inside safe zones.

**E2e:** `pnpm e2e:director-v2`. Both Krishna products in English and Hindi. **Pass:**
- schema-valid output with all new fields;
- the stress test runs;
- diversity passes;
- compiled plate prompts are printed, with no negative phrasing.

---

## B5: Costs, quota and limits

**Goal:** every job has a cost, a budget and quota accounting, with per-org caps, a kill switch, rate limits and alerts. No payments (bridge §5.6).

**Interfaces fixed here:**
- `provider_calls` gains `gpu_seconds numeric`, `tokens_in`, `tokens_out` and `cost_estimated bool`. `PRICING.gpuHourUsd` is in config.
- **`credit_ledger`:**
  - `(id, org_id, delta int, reason: 'grant'|'reserve'|'settle'|'refund'|'purchase', ref_type, ref_id, created_at)`;
  - unique `(reason, ref_type, ref_id)`;
  - a materialized balance view.
- **`quota.ts`:** `reserve(orgId, jobId, n)`, `settle(jobId, deliveredCount)`, `refund(jobId, reason)` and `grant(orgId, n, ref)`. All are idempotent.
- `org_limits(org_id, jobs_per_day, max_queued)` with defaults in config; `system_flags(kill_switch bool)`.
- `alert(kind, payload)`: an Inngest function posting to the Discord webhook, retried.

**Tasks:**
1. **(Sonnet)** GPU-seconds and token metering in the heavy lane and LLM layer; cost per job on the admin page. **Tests:** recorded calls produce costs; subscription calls are marked estimated.
2. **(Opus)** **Ledger plus quota lifecycle:** reserve at `POST /api/jobs` (same transaction as the insert), settle in `finalize`, refund in `onFailure`, the janitor and the offline bound. **Tests (Review Focus 2 and 3):**
   - each operation run twice changes nothing the second time;
   - a 2-of-3 delivery → settle 2, refund 1;
   - a failed job → full refund exactly once, even with `onFailure` and the janitor both firing;
   - insufficient balance → 402 with no job row.
3. **(Sonnet)** Per-job budget (degrade b-roll, then music, with a warning), per-org caps, the kill switch (submit → 503 with a message; the worker pauses after the current step), and DB-backed rate limits on waitlist, upload, submit and regenerate. **Tests:** each limit trips with the right status; the kill switch stops dispatch.
4. **(Haiku)** **Alerts:** worker offline > 10 min, job failed, daily cost over threshold, kill switch flipped, new waitlist entry. **Tests:** each trigger sends one message (a fake webhook); retried on 5xx.

**E2e:** `pnpm e2e:quota`. On staging, grant 3 credits to a test org and run one job with b-roll forced to fail. **Pass:**
- the ledger shows reserve 3, settle 2, refund 1;
- a Discord alert arrives;
- the kill switch on → submit refused;
- off → it works.

---

## C4: Renderer craft (the launch quality bar)

As specified in creative design §4.7: 6 blueprints, the motion doctrine, 5 transitions, luma-picked captions with keyword emphasis, the safe-zone validator (warn on a user drag), a LUT grade, and Devanagari/Gujarati fonts.

**Interfaces fixed here:**
- `Blueprint` enum (closed, in `packages/core/src/vocab/enums.ts`);
- `Transition` enum;
- `CaptionStyle` enum (`ink`, `cream`, `documentary`, `loud`, `anchor`) with `pickCaptionStyle(lumaGrid, treatment) → CaptionStyle` (pure);
- `LUT` per treatment in `TREATMENTS`;
- `validateZones(spec) → Violation[]`.

**Tasks:**
1. **(Sonnet)** **The motion doctrine core:** `power3` default, `fromTo` entrances, cue-bound reveals, held frames, plus a seek-safety lint (no `repeat`, `yoyo`, CSS animation or `Math.random`). **Tests:** the lint fails on each forbidden construct; golden GSAP output.
2. **(Sonnet)** **Blueprints 1–3:** `kinetic_hook`, `product_hero_reveal`, `stat_countup`. **Tests:** render tests at 240×426×5 per blueprint; golden HTML.
3. **(Sonnet)** **Blueprints 4–6:** `benefit_stack`, `split_compare`, `endcard_lockup`. Same tests.
4. **(Sonnet)** Five transitions plus velocity-matched seams. **Tests:** golden per transition; scene frame sums unchanged.
5. **(Sonnet)** **Captions:** `pickCaptionStyle` from plate luma, keyword emphasis, Indic fonts resolved before render (the tofu trap). **Tests:**
   - a bright plate → `ink`, dark → `cream`;
   - Devanagari glyph coverage check;
   - a missing font fails staging.
6. **(Haiku)** `validateZones` plus a LUT per treatment plus the distinct-LUT diversity rule (creative design builder-check call). **Tests:** an overlap case → violation; LUT applied uniformly to plate and product layers (golden); three variants sharing a LUT → violation → repair.

**E2e:** `pnpm e2e:craft`. Full jobs for both Krishna products (EN with Qwen, HI with Chatterbox). **Pass, the user's watch check:**
- the ads no longer read as a slideshow;
- captions are readable on bright plates;
- nothing overlaps the product;
- transitions and blueprints vary across the three variants.

---

## B6: The launch gate

As specified in bridge §5.10. Nothing outside-facing launches until every item passes.

**Tasks:**
1. **(Sonnet)** **The Anthropic API provider** (`anthropic-api`) behind the existing LLM interface:
   - docs first;
   - model ids from env, effort via `output_config.effort`, no sampling params;
   - prompt caching verified (`cache_read_input_tokens`);
   - golden request plus one recorded live response.
   - Then `claude-agent-sdk` joins `POC_ONLY_PROVIDERS`.
   - **Tests:** prod boot with the subscription configured fails; Director and VisionAnalyzer goldens pass on the new provider.
2. **(Haiku)** **License audit:** a table in `docs/providers/LICENSES.md` covering every model and asset pack touching customer output, each with a verified license link; non-commercial ones are listed as pocOnly in the registry. **Test:** a boot-time check that every configured provider has a license entry.
3. **(Opus)** **Security review:** the `security-review` skill plus an Opus reviewer over auth, RLS, uploads, the media route, signed URLs, rate limits and secrets handling on the GPU machine. Fix wave plus re-review.
4. **(Sonnet)** **Restore drill:** restore the Supabase backup to a scratch project and an R2 object version, and verify a past job renders from restored data. Documented in the runbook.
5. **(Sonnet)** **Staging soak:** 20 jobs, including a worker kill mid-job, a machine reboot, a partial-success refund and an offline-bound expiry. All have the expected outcomes and ledger entries.
6. **(Haiku)** Finish the runbook (start/stop, alerts, kill switch, refunds/grants, key rotation, restore) and set up the prod environment (prod Supabase, R2, Inngest and Vercel env vars), with **user approval before the first prod deploy.**

**Gate check:** the user signs off the soak report and the security review. Launch is invite-only from the waitlist.

---

## After launch: C5–C8 (shipped as updates)

Each is as specified in creative design §4.3, §4.8, §4.6/§5 C7 and §4.9, with these production additions:

- **C5: Asset population.**
  - **S (spike), Sonnet:** Qwen-Image-Edit-2511 plus the Multiple-Angles LoRA on 16 GB (fp8/GGUF). Measure VRAM, time and label-gate pass rate on the Krishna products, and verify the licenses. The user approves.
  - **Tasks:** label gate (Opus); strategy A plate-matching to view (Sonnet); strategy B view generation as an interactive-priority library job, charged per B5 (Sonnet); compositing (contact shadow, colour match, light wrap; Sonnet); hero-eligibility approval UI for the brand user plus admin revoke (Sonnet); the ADR amending architecture §7 T0 (Haiku).
  - **E2e:** the side-by-side "photographed in the scene" check.
- **C6: Audio.**
  - **Spikes (Sonnet):** ACE-Step 1.5 license and VRAM; svara-TTS license and A/B.
  - **Tasks:** SFX pack wiring (Haiku); music bed with recipe caching per org (Sonnet); carve plus loudness (Sonnet).
  - **E2e:** music audibly under the voice; −14 LUFS measured.
- **C7: The editor UI.**
  - Canvas drag and resize (Sonnet);
  - timeline and retime (Sonnet);
  - layer panel (Haiku);
  - regenerate-with-fields per shot, charged per B5 edit class at interactive priority (Sonnet);
  - natural-language edits into `EditOp`s with confirmation (Opus);
  - production stages and lock (Sonnet).
  - **E2e:** a Playwright drag, retime, regenerate one plate and export on staging.
- **C8: QA supervision.**
  - Contact sheet (Haiku);
  - vision critic tied to layers and assets (Sonnet);
  - one automatic repair (Sonnet);
  - ASR word-count guard (Sonnet);
  - "delivered" now includes the hard checks in B5 settle (Opus review).
  - **E2e:** a corrupted shot gets flagged, regenerated and delivered.

---

## Carry-forward ledger (closed by milestone)

| Item | Closed in |
|---|---|
| Worker binds `projectId` at boot; dedupe per project | B2.T1 (job-scoped org/project; dedupe per org) |
| ADR 0012's direct worker API, CORS, Host/Origin guard | B4 (prod uses connect + Supabase; the dev API stays dev-only) |
| `generate-ads` `finish: '4h'` / `start: '2h'` vs offline waits | B4.T2 (dispatcher holds work in Postgres) |
| Silent b-roll drop (150 vs 156 frames) | C3.T5 (voice-first shot layout) |
| Overlay can sit on the product; white text on bright plates | C4.T5–T6 |
| Same category → same trio | C3.T1 (script bank) plus seeding `experimental` entries during C3 |
| ASR word-count guard | C8 |
| Thin VRAM headroom (15.7/16.3 GB) | B4 supervisor VRAM telemetry plus per-phase model swaps (creative §4.10) |
| Push of 100+ local commits | B1 (user approval) |
| Experimental-slot starvation | Later (architecture Phase 5); not in this bridge |
