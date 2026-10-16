# AdForge — Local POC Design

**Date:** 2026-10-15 · **Status:** approved; **amended 2026-10-16 — see §11, which supersedes earlier sections where they differ**
**Parent:** [architecture.md](../../architecture.md). This spec narrows it for a local proof-of-concept; where they differ, the deviations are listed in §2 and each gets an ADR.

---

## 1. Goal

Prove the whole AdForge idea end to end on one Windows machine (RTX 5070 Ti, 16 GB):

> Upload 1–5 product photos → three rendered 20s vertical MP4s, structurally different by hook family and format family, each shown with the Strategist's rationale and its own strategic bet.

**Success criteria**

1. Two eval products — deliberately **not** the build spec's oil and mug, which are the prompts' few-shot anchors and would only test copying — each produce 3 MP4s with zero manual steps after upload.
2. `assertVariantDiversity()` passes at **family** level for both — not by slug.
3. Hero beats show the **real** product pixels (T0 cutout), never generated ones.
4. Each variant has one ambient video-model b-roll beat where a product-absent beat exists.
5. Media spend is zero; LLM spend per job is visible in `provider_calls`.
6. Every tunable listed in §5 can be changed without touching pipeline code.

**Non-goals:** auth UI, publishing, metrics, vocab proposal capture, continuity gate, M1 depth parallax, Hinglish, Langfuse, Sentry, Docker.

---

## 2. Stand-ins for the production stack

Code shape follows architecture.md exactly — monorepo, `packages/core` Zod types, provider interfaces, `VideoSpec` IR, Drizzle on the Postgres dialect. Only the infrastructure behind the seams changes.

| architecture.md | POC | Swap path |
|---|---|---|
| Supabase Postgres | **PGlite** (in-process Postgres) + same Drizzle schema | Change the Drizzle driver; migrations carry over |
| Supabase Auth | One seeded local user; `userId` still threads through every table | Add auth; schema unchanged |
| Cloudflare R2 | **`LocalDiskStorage`** — `.data/media/<key>`, served by Next route `/media/[...key]`. `MediaRef.url` is always that internal URL | New `StorageProvider` adapter |
| Inngest Cloud | **Inngest dev server** (`npx inngest-cli dev`) | Point at Inngest Cloud |
| fal.ai | **ComfyUI** adapter (local HTTP API) | New adapter + env change |
| ElevenLabs | **Kokoro-82M via `kokoro-js`**, Node, CPU, English only | New adapter + env change |
| `apps/renderer` service | HyperFrames called in-process from the worker | Move behind HTTP when scaling |
| Langfuse / Sentry | Skipped; `provider_calls` still written for every call | Add later |

**ComfyUI install:** fresh Windows portable build at `C:\ComfyUI` — **outside OneDrive**, which would otherwise try to sync ~40 GB of model weights. The existing `Desktop\ComfyUI-master` is an incomplete source drop (no requirements, no torch, no models) and is left alone. The portable build bundles a CUDA 12.8+ torch, required for Blackwell (sm_120).

**Models (all fit 16 GB with ComfyUI's offloading):**

| Role | Model | License |
|---|---|---|
| Cutout | BiRefNet (via a ComfyUI background-removal custom node, chosen at P1) | MIT |
| Plate | Flux.1-schnell fp8, 4 steps, 768×1344 | Apache-2.0 |
| B-roll | Wan 2.2 TI2V-5B, image→video, 720p, ~5s | Apache-2.0 |

Flux.1-dev is a one-line swap for quality, but its licence is non-commercial — kept out of the default deliberately.

---

## 3. Repo layout

```
adforge/
  packages/
    core/src/
      providers/types.ts      MediaRef, Money, JobHandle, ProviderResult, ProviderError,
                              Image/Video/TTS/Renderer/Storage/Distribution provider interfaces
      providers/registry.ts   register(kind, id, impl) / get(kind) — id chosen by config
      config/env.ts           Zod-parsed env, fails boot on invalid values
      config/pipeline.ts      creative tunables (§5.3)
      config/treatments.ts    per-visual_treatment render params (§5.2)
      vocab/                  Zod enums for render-coupled dims; registry row types
      shortlist.ts            deterministic rules-layer ranking
      diversity.ts            assertVariantDiversity (family level)
      llm/                    strategize(), direct(), Zod output schemas
      prompts/*.md            byte-frozen system prompts + few-shot anchors
      spec/                   VideoSpec schema, frames.ts, buildSpec()
    db/
      src/schema.ts           Drizzle schema (§4)
      src/client.ts           PGlite client
      src/seed/vocabulary.ts  families + 7/8/7 seed (§5.1)
      drizzle/                migrations
    providers/
      comfyui/                client, workflow patcher, image/video/cutout adapters,
                              workflows/*.json + *.params.ts
      kokoro/                 TTSProvider
      local-storage/          StorageProvider
      openrouter/             resolveModel()
    renderer-hyperframes/     VideoSpec → composition + variables → MP4
  apps/web/                   Next.js: UI, API routes, /media route, Inngest functions
  docs/providers/             fetched vendor docs: comfyui, openrouter, kokoro, hyperframes
  docs/decisions/             ADRs
```

---

## 4. Data model

architecture.md §5.4 tables, minus what the POC does not exercise (`vocab_proposals`, `gate_results`, `products.bible`):

```
users, projects, assets
vocab_families   id, kind(hook|format|archetype), slug UNIQUE, name
archetypes       id, slug UNIQUE, familyId, name, buyingDriver, definition, examples, status, ...
formats          id, slug UNIQUE, familyId, name, beats(jsonb), fitsArchetypes(text[]), definition, status, ...
hook_archetypes  id, slug UNIQUE, familyId, name, shape, skeleton, constraints, fitsArchetypes(text[]), status, ...
jobs             id, projectId, userId, status, inputSpec, brief, shortlist, configSnapshot,
                 costUsd, error, createdAt, completedAt
variants         id, jobId, variantNo, formatSlug, hookSlug, archetypeSlug, visualTreatment,
                 strategicBet, isExploratory, direction(jsonb), spec(jsonb), status,
                 renderAssetId, costUsd, error
provider_calls   id, jobId, variantId, kind, provider, model, requestHash,
                 idempotencyKey UNIQUE, latencyMs, costUsd, status, error
```

New vs architecture.md: **`jobs.configSnapshot`** — the resolved pipeline config, treatment config, workflow names, model ids and prompt hashes used for that job. Because §5 makes everything changeable, a job must record what it actually ran with, or old outputs become uninterpretable (same reasoning as `jobs.shortlist`).

`variants` stores slugs, not foreign keys. Retired registry rows are never deleted.

---

## 5. Configurability — every tunable has one home

The rule: **what kind of thing it is decides where it lives.** Nothing tunable is hardcoded inside a pipeline step.

### 5.1 Semantic vocabulary → database registry

Archetypes, formats (including beat structure), hook archetypes, and **families** are DB rows. Changing a family grouping, adding a format, or retiring a hook is a data change — edit `packages/db/src/seed/vocabulary.ts` and re-seed, or edit rows directly. Seed is idempotent upsert-by-slug; it never renames or deletes.

Seeded families (each regroupable later without code change):

| Kind | Family | Members |
|---|---|---|
| hook | `contrarian` | pattern_break, confession |
| hook | `targeting` | direct_call |
| hook | `evidence` | stat_shock, demonstration |
| hook | `tension` | curiosity_gap, objection_lead |
| format | `narrative_arc` | problem_solution, before_after |
| format | `social_proof` | ugc_testimonial |
| format | `rational` | spec_flex, listicle_3 |
| format | `sensory` | sensory_tease, styling_moment |
| format | `persuasion` | objection_kill |

### 5.2 Render-coupled vocabulary → typed config in code

`visual_treatment` and `motion` stay closed Zod enums (architecture §5.1). Their parameters live in **`config/treatments.ts`**, a single record typed `satisfies Record<VisualTreatment, TreatmentConfig>`:

```ts
{ captionPosition, captionStyle, scrim, defaultMotion, background,
  platePromptSuffix, plateNegativePrompt }
```

Adding an enum value fails to compile until its config entry exists — the "adding one is a PR" rule, enforced by the type checker.

### 5.3 Creative tunables → `config/pipeline.ts`

One typed, Zod-validated object with defaults:

```ts
video:   { width: 1080, height: 1920, fps: 30 }
timing:  { totalSec: 20, hookBeatSec: [3, 4], beatSec: [5, 6], voWordsPerSec: 2.5, voTailFrames: 6 }
hook:    { maxWords: 9, maxChars: 28, bannedOpeners: [...] }
plate:   { width: 768, height: 1344 }
broll:   { enabled: true, maxPerVariant: 1, durationSec: 5 }
shortlist: { formats: 8, hooks: 10, reserveExperimentalSlot: true }
diversity: { minHookFamilies: 3, minFormatFamilies: 2, repairPasses: 1 }
captions:  { mode: 'proportional' }      // 'whisper' later
retries:   { provider: 2 }
```

The Director prompt's numeric rules (timing, hook limits) are rendered **from this object** into the user message, so the frozen system prompt stays cacheable and the numbers can't drift from the validator.

### 5.4 Infrastructure and provider choice → env

Parsed by `config/env.ts` at boot; a bad value fails startup, never mid-job.

```bash
ADFORGE_DATA_DIR=.data
ADFORGE_PROVIDER_IMAGE=comfyui          # provider id from the registry
ADFORGE_PROVIDER_VIDEO=comfyui
ADFORGE_PROVIDER_CUTOUT=comfyui
ADFORGE_PROVIDER_TTS=kokoro
ADFORGE_PROVIDER_STORAGE=local
COMFYUI_URL=http://127.0.0.1:8188
ADFORGE_COMFY_WORKFLOW_PLATE=plate-flux-schnell
ADFORGE_COMFY_WORKFLOW_BROLL=broll-wan22-5b
ADFORGE_COMFY_WORKFLOW_CUTOUT=cutout-birefnet
ADFORGE_TTS_VOICE=af_heart
OPENROUTER_API_KEY=...
ADFORGE_LLM_STRATEGIST=anthropic/claude-sonnet-5   # verify slug against OpenRouter at build time
ADFORGE_LLM_DIRECTOR=anthropic/claude-opus-5
ADFORGE_LLM_EFFORT_STRATEGIST=medium
ADFORGE_LLM_EFFORT_DIRECTOR=high
```

### 5.5 ComfyUI workflows → files + param manifests

Each workflow is two files in `packages/providers/comfyui/workflows/`:

- `<name>.json` — API-format export from the ComfyUI GUI, committed as-is.
- `<name>.params.ts` — a Zod schema for the logical inputs plus a map from each logical param to `{ nodeTitle, input }`.

The patcher addresses nodes by **title**, not numeric id, so re-exporting a tuned workflow from the GUI doesn't break the adapter. Adding a workflow = export JSON + write manifest + set env. Swapping Flux-schnell → Flux-dev, or Wan → LTX, never touches TypeScript outside that folder.

### 5.6 Prompts → files

System prompts and few-shot anchors are `.md` files loaded byte-for-byte. Their SHA-256 goes into `jobs.configSnapshot`. Editing a prompt is a file edit; its hash change makes the before/after visible across jobs.

---

## 6. Pipeline

One Inngest function, `generate-ads`. Every line is a memoized step. ComfyUI steps run under an Inngest concurrency key of 1 (one GPU).

```
preflight     COMFYUI /system_stats reachable; required workflows registered; config snapshot → job
ingest        uploads → sha256 → storage → assets (dedupe on sha256)
cutout        ComfyUI BiRefNet per photo → RGBA asset (cached by source sha256)
strategize    OpenRouter, photos attached → brief: archetype_primary/secondary, rationale,
              core_objection, differentiators, image_inventory           → jobs.brief
shortlist     rules layer: fitsArchetypes affinity vs archetype pair; reserved experimental slot
                                                                         → jobs.shortlist
direct        OpenRouter → 3 variants chosen from the shortlist only
              → assertVariantDiversity (family level) → ≤1 repair pass naming the violation → else fail
── per variant, isolated ──
plates        per beat: ComfyUI plate, prompt = beat.scene + treatment suffix + "empty foreground"
fidelity      code, not model: prominence hero|supporting → T0 (cutout overlay); absent → T2
broll         first `absent` beat → ComfyUI image→video from that beat's plate
voice         Kokoro per beat → wav asset + measured duration
composeSpec   → VideoSpec: frames only, assetIds only; beat = max(planned, VO + tail)
render        HyperFrames → MP4 asset
── end per variant ──
finalize      cost roll-up from provider_calls; job status
```

**Director output per beat** (changed from build spec §7): `beat, vo, overlay, scene, product_prominence (hero|supporting|absent), duration, motion`. `image_index` is dropped — generated plates are the backgrounds; the real cutout is the product.

**T0 composite:** done in the renderer, not ComfyUI — plate layer + cutout overlay layer, both under the same motion, cutout with a CSS drop shadow. ComfyUI never touches product pixels.

**Captions:** word-by-word, timings distributed proportionally to word length across each beat's measured VO duration. Known ceiling: drifts on long pauses. Upgrade: Whisper alignment (`captions.mode: 'whisper'`).

**UI:** upload page → job page polling `GET /api/jobs/:id` (step + variant status) → review page with three `<video>` players side by side, rationale, each `strategic_bet`, and an Approve button.

---

## 7. Error handling

| Failure | Behaviour |
|---|---|
| Invalid env / config | Boot fails with the Zod path |
| ComfyUI unreachable | `preflight` fails the job immediately, message names `COMFYUI_URL` |
| ComfyUI `/prompt` returns `node_errors` (e.g. missing model file) | `ProviderError INVALID_INPUT`, logged as an adapter/setup bug; message includes node title and missing file |
| ComfyUI execution error in `/history` | `UPSTREAM`, retryable up to `retries.provider` |
| LLM schema-invalid output | AI SDK throws → step retried once |
| Diversity violation | One repair pass naming it → job fails with the violation |
| B-roll fails | **Non-fatal.** Beat degrades to plate + Ken Burns; variant warning recorded |
| One variant fails | Others continue. 2–3 delivered = `completed` (with warnings); 0 = `failed` |
| Double-fire | `provider_calls.idempotencyKey` unique index |

ComfyUI completion is detected by polling `/history/{promptId}` — never only by websocket — per the "webhooks get lost" rule.

---

## 8. Testing

`pnpm test` (Vitest), no network, no GPU:

- `assertVariantDiversity`: passes on 3 families; fails on 3 distinct slugs in 2 hook families; fails on 1 format family.
- `shortlist`: deterministic for a fixed brief + registry; reserved slot honoured when an experimental row exists.
- `frames.ts`: seconds→frames round-trip; spec durations sum exactly.
- `buildSpec`: golden file from a recorded Director output.
- ComfyUI patcher: golden file per workflow; fails loudly when a manifest title isn't in the JSON.
- ComfyUI adapter: one recorded live `/history` response per workflow as a fixture.
- `treatments.ts`: compile-time completeness (type test).
- Pipeline: `@inngest/test` with all providers stubbed — includes one-variant-fails and b-roll-fails cases.
- Render: 240×426, 5 frames from the golden `VideoSpec`.

Outside `pnpm test` (costs money / needs GPU): `pnpm eval` runs the two eval products (photos in `fixtures/eval-products/`) through strategize + direct live and asserts diversity; `pnpm smoke:comfy` runs each workflow once.

---

## 9. Milestones

Each: plan files → approve → implement → `pnpm test` → ADR for anything not dictated above.

| # | Milestone | Exit criteria |
|---|---|---|
| P0 | Foundation | `pnpm install` + `pnpm test` green; PGlite migration applies; vocab seeded; bad env fails boot |
| P1 | ComfyUI install | Portable build at `C:\ComfyUI`; 3 models + cutout node installed; each workflow runs in the GUI; `docs/providers/comfyui.md` fetched |
| P2 | ComfyUI adapter | `pnpm smoke:comfy` writes cutout, plate, b-roll into storage; goldens + fixtures committed |
| P3 | Render spike | Hand-written `VideoSpec` (plate + cutout + captions + wav) → 20s 4-beat MP4 via HyperFrames |
| P4 | Registry + shortlist | Families + 7/8/7 seeded; shortlist tests green |
| P5 | LLM layer | `pnpm eval` green on both eval products at family level |
| P6 | Voice + spec builder | Kokoro wavs; `buildSpec` golden; captions in sync by eye |
| P7 | Pipeline | Upload → 3 MP4s in `.data/media`, no manual steps |
| P8 | UI | Side-by-side review with rationale + bets; approve persists |

**ADRs planned:** 0001 local stack stand-ins · 0002 ComfyUI provider + model choices · 0003 Kokoro, English-only · 0004 proportional caption timing · 0005 seeded vocab families · 0006 `jobs.configSnapshot`.

---

## 10. Risks

| Risk | Mitigation |
|---|---|
| Flux-schnell plates look generic | Treatment suffixes are config; Flux-dev is a workflow swap |
| Real cutout looks pasted onto the plate | Drop shadow + matching motion first; relighting is a later workflow, not a code change |
| Wan 2.2 5B too slow (several minutes per clip) | `broll.enabled` toggle; per-variant isolation keeps the rest moving |
| HyperFrames API churn | Exact version pin; fetched docs; render test in CI |
| OpenRouter model slugs differ from Anthropic ids | Verified at P5 against OpenRouter's model list; env-driven |

---

## 11. Decisions amended 2026-10-16 (P3–P8 planning)

These supersede §1–§9 where they differ. Each one gets an ADR in the milestone that implements it.

| Area | Was | Now |
|---|---|---|
| TTS | Kokoro-82M via `kokoro-js`, English only | **Chatterbox Multilingual** (Resemble AI, MIT, ~0.5B), local on the GPU via a small Python service behind `TTSProvider`. Built-in default voice. Per-line emotion intensity (`exaggeration`) set by the Director per beat. Shares the GPU with ComfyUI, and the pipeline serializes GPU work |
| Captions | Proportional timing (`captions.mode: 'proportional'`) | **Whisper word-level alignment** of each generated voice clip (transformers.js in Node, CPU). Proportional stays as a fallback mode |
| Languages | English only, Hinglish deferred | **Per product: `en`, `hi` (Devanagari VO and captions), `hinglish` (Latin-script Hindi)**. All three are validated with a listening check in the P6 end-to-end. On-screen claim text stays Latin script for all languages (build spec §7) |
| Music | Undecided | **None in the POC.** `VideoSpec.audio.music` stays optional |
| LLM | OpenRouter via `@openrouter/ai-sdk-provider` | **Claude via the Claude Agent SDK (`@anthropic-ai/claude-agent-sdk`) under the user's Claude subscription**, for local POC use only, behind the LLM seam. Structured output via `outputFormat: { type: 'json_schema', schema: z.toJSONSchema(S, { target: 'draft-7' }) }`, re-validated with Zod. Switch to an API key before anyone other than the user runs AdForge |
| Eval products | Two products, photos in `fixtures/eval-products/` | **The user supplies 2 real products** (3–5 photos each, plus name, price and description). Never the oil or the mug |
| Input form | Photos | **3–5 photos, name, price, description, language (en/hi/hinglish), b-roll toggle.** No URL scraping (`enrich` stays out of the POC) |
| B-roll | Always, when a product-absent beat exists | **Toggle per job, default OFF** (`broll.enabled` becomes a per-job input, defaulting to false) |
| UI | Upload, progress, review, approve | Same; **minimal and functional**. Design polish is deferred (memory: POC quality stance) |
| Testing | §8 | **Every task carries functional tests (no GPU, no network, in `pnpm test`). Each milestone ends with exactly one end-to-end check** (a live script or browser run), like `pnpm smoke:comfy` |

