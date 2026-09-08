# AdForge — Architecture

**Status:** foundational. Written 2026-08-15 from the four spec documents in [docs/](.) plus a decision session. This is the reference for all future development sessions.

**One-line:** a seller uploads product photos (or a URL); AdForge classifies the product by *buying psychology*, then generates three structurally different short-form vertical ad variants — three testable hypotheses, each with a stated strategic bet.

---

## 0. Document map

| Document | Role |
|---|---|
| [adforge-build-spec.md](adforge-build-spec.md) | **Domain source of truth.** The creative vocabulary (archetypes, formats, hooks, treatments, motion), the prompt stack, the diversity rule, the few-shot anchors. The Make.com implementation it describes is **not built** — only the domain content carries forward. |
| [adforge-app-spec.md](adforge-app-spec.md) | Engineering spec: provider abstraction, `VideoSpec` IR, DB schema, pipeline, testing discipline. §2 (Make-build learnings) is load-bearing. |
| [adforge-spec-addendum-shot-synthesis.md](adforge-spec-addendum-shot-synthesis.md) | Addendum A: fidelity tiers T0–T2, Product Bible, World Bible, Shot List, the continuity gate. |
| [adforge-spec-addendum-motion-distribution.md](adforge-spec-addendum-motion-distribution.md) | Addendum B: motion tiers M0–M3, depth parallax, distribution providers, metrics, attribution. |
| **architecture.md** (this file) | Reconciles all four against the decisions below. **Where this file and a spec disagree, this file wins.** |
| [CLAUDE.md](../CLAUDE.md) | Operating rules for coding sessions. Short by design. |

---

## 1. Decisions

Resolved 2026-08-15. Several **supersede** `adforge-app-spec.md §3.1`.

| Area | Decision | Note |
|---|---|---|
| Language | **TypeScript, strict, end-to-end** | Confirms app-spec §3.1 |
| Monorepo | pnpm workspaces + Turborepo | Confirms app-spec |
| Web | Next.js App Router | Confirms app-spec |
| Auth | **Supabase Auth, from day one** | `userId` threads through the schema even though v1 is effectively single-tenant |
| DB | **Supabase Postgres** + Drizzle | Confirms app-spec |
| Storage | **Cloudflare R2** | Confirms app-spec. Zero egress matters — platforms fetch our video URLs |
| Orchestration | **Inngest** | Confirms app-spec §3.1. Durable memoized steps; a render failure must not re-bill keyframes |
| LLM routing | **OpenRouter** via `@openrouter/ai-sdk-provider` + Vercel AI SDK | *Supersedes* app-spec §4.3's direct-provider assumption. Same `generateObject` + Zod discipline |
| Media models | **fal.ai** primary — image, video, depth, segmentation, inpainting | Behind provider interfaces; Replicate is the escape hatch |
| TTS | ElevenLabs | Hinglish is a real capability difference between vendors |
| Renderer | **HyperFrames** primary, behind `RendererProvider` | *Supersedes* app-spec §7.2's "Remotion is the product renderer" verdict — see §9 |
| Deployment | **Docker Compose, host later** | Reverses an earlier "deployed day one" call. Harmless for v1 since v1 has no publishing; R2 gives public URLs regardless of where the app runs |
| Observability | Langfuse + Sentry + `provider_calls` table + eval harness — **all four** | |
| Cost ceiling | Not a constraint yet, **but tracked per job from commit one** | App-spec §2's last row |
| v1 scope | **Generate + review in-app.** No publishing, no metrics | |

**Unconfirmed assumption:** India-first D2C (the ₹ pricing and Hinglish in the build spec imply it). Affects TTS voice defaults and example content only. Flag if wrong.

---

## 2. System shape

```
┌──────────────────────────────────────────────────────────┐
│ apps/web — Next.js                                       │
│ upload · watch pipeline · review 3 variants · approve     │
└────────────────────────┬─────────────────────────────────┘
                         │ tRPC
┌────────────────────────▼─────────────────────────────────┐
│ API routes                                                │
│ POST /jobs · GET /jobs/:id · POST /webhooks/:provider      │
└────────────────────────┬─────────────────────────────────┘
                         │ inngest.send
┌────────────────────────▼─────────────────────────────────┐
│ Inngest — durable, memoized, individually retryable steps │
│                                                            │
│ ingest → enrich → strategize → direct → artDirect*         │
│   → per variant: cinematograph → keyframes → ◆GATE◆        │
│                  → motion → voice → composeSpec → render   │
│   → finalize                                               │
│                                                            │
│ * artDirect is merged into direct for v1 — see §6          │
└────────────────────────┬─────────────────────────────────┘
                         │ via registry
┌────────────────────────▼─────────────────────────────────┐
│ Provider layer — all swappable by env var                 │
│ LLM · Image · Video · Depth/Seg · TTS · Renderer · Storage │
│ (later: Distribution)                                      │
└──────────────────────────────────────────────────────────┘
```

**The critical rule, inherited from the Make build:** nothing blocks on a render. There is no synchronous render path, not even in tests.

### Services in Compose

| Service | What |
|---|---|
| `web` | Next.js — UI + API routes + Inngest function definitions |
| `worker` | Inngest dev server (prod: Inngest Cloud) |
| `renderer` | Node 22 + headless Chrome + FFmpeg, wrapping `@hyperframes/producer` |
| `db` | Postgres (dev only — prod is Supabase) |

The renderer is a separate service because it needs a browser and FFmpeg in the image, and because render is the one step we want to scale independently.

---

## 3. Repo layout

```
adforge/
  CLAUDE.md
  .claude/
    settings.json
    commands/{new-provider,render-check,cost-report}.md
    agents/{provider-adapter,composition}.md
  docs/
    architecture.md              # this file
    adforge-*.md                 # the four source specs
    providers/*.md               # FETCHED vendor API docs, committed
    decisions/*.md               # ADRs
  packages/
    core/          # domain types, Zod schemas, VideoSpec, closed enums,
                   # registry accessors, shortlist, diversity rule
    providers/     # one dir per adapter; provider SDK types never escape
    renderer-hyperframes/
    renderer-remotion/           # phase 2 — hedge, same interface
    db/            # Drizzle schema + migrations
  apps/
    web/
    renderer/      # Node service wrapping @hyperframes/producer
```

`packages/core` is importable by every app. That's the whole reason the language decision matters.

---

## 4. The provider abstraction

Carried from `adforge-app-spec.md §4` **unchanged** — it's the best-designed part of the spec set. Key types in `packages/core/src/providers/types.ts`: `MediaRef`, `Money`, `JobHandle`, `ProviderResult<T>`, `ProviderError`, `Capability`, `ProviderRegistry`, `SelectionPolicy`.

Three rules are non-negotiable:

1. **`MediaRef.url` is always an internal R2 URL.** Never a vendor URL. Third-party signed URLs expire; the Make build lost a render to exactly this.
2. **`ProviderError` code `INVALID_INPUT` is a bug in our adapter, not a runtime condition.** It should have failed Zod validation locally. Log at error, alert.
3. **Selection is policy-driven, not hardcoded.** "Cheapest provider supporting `first_last_frame` at 720p under $0.50/clip." A provider failing health checks is excluded automatically.

Interfaces: `LLMProvider`, `ImageProvider`, `VideoProvider`, `TTSProvider`, `RendererProvider`, `StorageProvider`. Phase 3 adds `DistributionProvider` (Addendum B §B7) — **define its signature now, implement later**, so v1 code is written against a seam that already exists.

---

## 5. Domain model

### 5.1 The vocabulary — an adaptive registry, not frozen enums

Addendum B §B9 is right that typed creative dimensions are the compounding advantage: because variants differ along *known* dimensions, performance can later be attributed to them — "for `remedy` products on TikTok, `objection_lead` hooks retain 18% better than `curiosity_gap`." A competitor wrapping a video model has no typed dimensions and cannot learn.

But **typed does not have to mean frozen.** The build spec's 7 archetypes × 8 formats × 7 hooks were designed for a seven-hour hackathon; they are one person's taxonomy, not an empirical one. A vocabulary hardcoded in August 2026 will be stale by 2027, and `sensory_tease` is meaningless for B2B SaaS.

**The resolution rests on a distinction the source specs don't draw.** Not all five dimensions cost the same to extend:

| Dimension | What it touches | Cost of a new value | Storage |
|---|---|---|---|
| `archetype` | Only what the LLM reasons about | ~zero | **Registry** |
| `format` | Beat structure — labels + timing | ~zero, if beats validate | **Registry** |
| `hook_archetype` | Only what the LLM writes | ~zero | **Registry** |
| `visual_treatment` | **Render parameters** | An engineering task | **Closed enum** |
| `motion` | **Renderer implementation** | An engineering task | **Closed enum** |

The first three are purely semantic and live in DB-backed registries — wide, growing, extensible. The last two are render-coupled: every value needs code behind it, so they stay closed Zod enums in `packages/core` and grow by PR. **The wide net goes only where it's free.**

#### Registry entry contract

Every registry row carries:

| Field | Purpose |
|---|---|
| `slug` | **The attribution key. Never renamed, never reused.** This is what makes performance data survive registry growth. |
| `family` | Hierarchy parent. Attribution rolls up to family while per-slug data is thin — see §5.2. |
| `status` | `proposed` → `experimental` → `active`, plus `retired` |
| `fitsArchetypes[]` | Coarse affinity filter (the build spec §3–4 already has this data) |
| `beats` *(formats only)* | Structure definition; must validate against the target duration |
| `embedding` | Retrieval ranking — Phase 3 |
| `definition`, `skeleton`, `constraints` | The prompt-facing content |

Retired entries stay in the table forever so historical jobs remain interpretable.

#### How the registry grows

Seeded with the build spec's 7/8/7 as `active`. Three growth paths, all landing in `proposed` for review — **nothing auto-promotes to `active` without performance data**:

1. **LLM-proposed.** When the Strategist finds a product that fits nothing well, it emits a proposed entry with a definition rather than forcing a bad classification. The gap itself is the signal.
2. **Hand-curated.** You add entries directly as you learn what's missing.
3. **Mined from real ads** *(Phase 5)*. Ingest real short-form ads, classify their structure, cluster into candidate formats and hooks. Empirically grounded rather than invented — the strongest source, and a substantial separate build.

Promoted entries enter as `experimental`: selectable, but **always assigned to the exploratory variant slot.** That's a clean fit with Addendum B §B9's rule that one of three variants must always sample outside the current best-known combination. Variant 3 is where new registry entries earn their place.

**The moat survives because the slug does.** The vocabulary stays typed and stable; it just stops being frozen.

### 5.2 Diversity is distance, not distinctness

The build spec's rule — three distinct hooks, ≥2 distinct formats — is trivially satisfiable against a registry of eighty, and would pass three near-synonyms with different slugs. That is exactly the failure it was written to prevent.

```ts
assertVariantDiversity(variants)
//   3 distinct hook FAMILIES
//   ≥2 distinct format FAMILIES
//   pairwise embedding distance above threshold   (Phase 3, once embeddings exist)
```

Violation → **one** repair pass naming the violation in the prompt → then fail the variant. This is load-bearing, not a backstop — §8 explains why it now carries the entire diversity guarantee.

**The cost of a wider net, stated plainly:** attribution dilutes. With 8 formats you need hundreds of posts to say anything; with 80 you need thousands. The `family` field is the mitigation — attribute at family level while data is thin, drill into individual slugs once a family has volume. The §B9 feedback loop gets slower before it gets richer. That is a real price and it is worth paying, because the alternative is a taxonomy that cannot represent products it was never designed for.

### 5.3 `VideoSpec` — the IR

The contract between creative and rendering, from app-spec §5.3, renderer-agnostic by construction. Two invariants:

- **Everything is frames, not seconds.** Convert once, at spec-build time. Seconds→frames rounding drift is the top cause of audio desync in programmatic video.
- **Layers reference `assetId`, never URLs.** The renderer resolves IDs through storage at render time, so a spec stored today still renders next month.

### 5.4 Database (Drizzle)

```
users           id, email, createdAt                        -- Supabase auth mirror
projects        id, userId, name, brandKit(jsonb), createdAt
products        id, projectId, name, bible(jsonb)            -- Addendum A ProductBible, cached
assets          id, projectId, kind, r2Key, mime, w, h, bytes, sha256, sourceUrl

-- the adaptive vocabulary (§5.1) --------------------------------------------
archetypes      id, slug UNIQUE, familyId, name, buyingDriver, definition,
                examples(jsonb), status, embedding, createdAt, retiredAt
formats         id, slug UNIQUE, familyId, name, beats(jsonb),
                fitsArchetypes(text[]), definition, status, embedding, ...
hook_archetypes id, slug UNIQUE, familyId, name, shape, skeleton,
                constraints(jsonb), fitsArchetypes(text[]), status, embedding, ...
vocab_families  id, kind, slug UNIQUE, name              -- attribution roll-up
vocab_proposals id, kind, proposedSlug, definition(jsonb), sourceJobId,
                origin, status, reviewedBy, reviewedAt   -- origin: llm|human|mined

-- jobs ----------------------------------------------------------------------
jobs            id, projectId, userId, status, inputSpec(jsonb), brief(jsonb),
                shortlist(jsonb), world(jsonb), costUsd, error(jsonb),
                createdAt, completedAt
variants        id, jobId, variantNo, formatSlug, hookSlug, archetypeSlug,
                visualTreatment, strategicBet, isExploratory,
                shotList(jsonb), spec(jsonb), status, renderAssetId, costUsd
provider_calls  id, jobId, variantId, kind, provider, model, requestHash,
                idempotencyKey, latencyMs, costUsd, status, error(jsonb)
gate_results    id, variantId, shotIndex, attempt, checks(jsonb), passed
```

`variants` stores **slugs, not foreign keys**, so a retired or renamed registry row can never orphan a historical variant. `visualTreatment` stays a plain enum column — it's closed by design.

`jobs.shortlist` snapshots what the Director was actually offered for that job. Without it you cannot later distinguish "this format never wins" from "this format was never shown."

- **Unique index on `provider_calls.idempotencyKey`** — this is the double-fire guard the Make build approximated with a status field.
- `assets.sha256` gives free dedupe.
- `provider_calls` is your cost model, latency baseline, and A/B substrate. Not optional.
- Phase 3 adds `social_accounts`, `posts`, `metric_snapshots`, `performance_attribution`.

---

## 6. The pipeline

Each step is a durable, memoized Inngest step. A failure at `render` must not re-run `strategize` and re-bill the LLM.

| # | Step | Notes |
|---|---|---|
| 1 | `ingest` | Copy every input into R2, normalize to `MediaRef`. Kills the expiring-signed-URL failure class. |
| 2 | `enrich` | Optional URL scrape. Failure is non-fatal. |
| 3 | `productBible` | Cutouts (SAM), palette, OCR `labelText`, identity embedding. **Cached per product**, not per job. |
| 4 | `strategize` | Images attached. Small JSON out. → `archetype_primary/secondary`, `rationale`, `core_objection`. May emit a `vocab_proposal` if nothing fits. |
| 4b | **`shortlist`** | Narrows the registry to *this* product. See below. Deterministic — no LLM call. |
| 5 | `direct` | Three variants chosen **from the shortlist**, diversity asserted in code, one repair pass. |
| 6 | `artDirect` | `WorldBible`. **v1: merge into `direct`.** Split it out only when you can point at outputs where one call visibly failed to hold the world together — props appearing and vanishing, lighting flipping between beats. |
| — | *fan out per variant, isolated. Partial success is a first-class outcome.* | |
| 7 | `cinematograph` | `ShotList`. `fidelityTier` is **computed in code** from `productProminence`, never chosen by the model. |
| 8 | `keyframes` | First frame per shot; last frame too for moving shots. |
| 9 | **`gate`** | ◆ The whole design. See below. |
| 10 | `motion` | Only now does video money get spent. Routed by tier. |
| 11 | `voice` | TTS per beat, frame-aligned. |
| 12 | `composeSpec` | Build `VideoSpec`. Golden-file tested. |
| 13 | `render` | Via `RendererProvider`. |
| 14 | `finalize` | Aggregate, cost-roll-up, notify. |

### The shortlist — casting wide, then filtering

`shortlist` is what makes the registry usable. It takes the Strategist brief and returns a ranked candidate set — roughly 10–15 hooks and 8–12 formats, each with a fit score and a one-line reason. The Director picks three from *that*, not from the whole registry. Cooking oil and enterprise SaaS get genuinely different menus.

Three ranking layers, landing in three different phases:

| Layer | Mechanism | Phase |
|---|---|---|
| **Rules** | `fitsArchetypes` affinity against the Strategist's archetype pair | v1 |
| **Embeddings** | Cosine similarity between the brief and each entry's definition | 3 |
| **Priors** | Historical performance for this archetype × platform, reweighting the ranking | 5 |

Each layer refines the one before it; none replaces it. **v1 ships rules only** — with a registry of 7/8/7 that's barely a filter, and that is fine. The step exists so the seam is real from day one.

**One shortlist slot is always reserved for an `experimental` entry**, feeding the exploratory variant. Otherwise the priors converge on a local maximum and the system stops learning.

Two constraints on the implementation:

- **Deterministic, no LLM call.** The shortlist must be reproducible and explainable — you need to be able to answer "why was this format offered?" months later. It is also snapshotted into `jobs.shortlist`.
- **Compatible with prompt caching.** The frozen Director system prompt (rules, diversity, timing, hook constraints) stays cached; the shortlist goes into the user message, after the cache breakpoint. Never interpolate it into the system prompt.

### The gate is the load-bearing idea

It sits **between images and video**. A rejected keyframe costs ~$0.04 to redo; a rejected clip costs $0.50–3.00. Four of its five checks are arithmetic — embedding cosine distance, OCR `labelText` hit rate, ΔE colour fidelity, palette drift. Only the artifact check needs a model, and it answers a **closed rubric**, not "is this good?"

`labelText` is the highest-value field in the whole system: it converts "does this look right?" — unanswerable — into "does OCR of the generated frame contain these strings?" — a unit test.

**Failure policy:** retry with a new seed and the failed check named, up to 2×. Then **downgrade the tier (T1→T0) rather than fail.** A composited real product over a plain plate always beats no shot.

---

## 7. Fidelity and motion tiers

Two orthogonal per-shot axes. Together they set cost and risk.

**Fidelity — how much of the product's identity may be generated** (Addendum A §A2):

| Tier | Product pixels | Policy |
|---|---|---|
| **T0** | Real cutout composited over a generated plate | `product_prominence: hero` → **T0, non-negotiable** |
| **T1** | Generated from multi-reference, gated | `supporting` |
| **T2** | Fully generated; product absent or occluded | `absent` |

**Motion — does the camera move, or the world?** (Addendum B §B1–B3):

| Tier | Method | ~Cost/shot | When |
|---|---|---|---|
| **M0** | 2D transform (pan, zoom, crop) | ~$0 | Flat subject, graphic beats, text moments |
| **M1** | Depth parallax (Depth-Anything-V2 → SAM 2 → inpaint → Three.js) | ~$0.03, cached | Camera move through a scene, no content motion |
| **M2** | Video model, `image_to_video`, short | ~$0.35 | Ambient content motion — steam, drift |
| **M3** | Video model, `first_last_frame` / `reference_to_video` | ~$0.60+ | Real physical events, talent performance |

**T0/M1 is the workhorse** — real product cutout over a depth-parallax plate, camera dollying past. Brand-safe, cinematic, essentially free after the first render.

**The inpainting step is the one people skip.** Displacing layers exposes background that was never photographed — a hole behind the product. Inpaint once per keyframe, cache it, and every later camera move on that frame is free.

**Where M1 breaks:** orbits past ~15–20°, genuinely unseen geometry (the back of the product), fine occlusion detail like hair or foliage. Those go to M2/M3.

**Do not let a video model render the hero product shot.** Label and logo drift is unsolved. AI video does ambient b-roll, hands, texture, environment; the compositor puts the real product on top. That hybrid is the entire reason the renderer exists.

**v1 ships M0 only — Ken Burns on stills.** M1 lands behind a flag once the core loop is green, gated on the depth-parallax spike (§13).

---

## 8. LLM layer

### Routing

OpenRouter via `@openrouter/ai-sdk-provider` (v3.0.0, Apache-2.0), behind our own `resolveModel()`. Env-driven:

```bash
ADFORGE_LLM_STRATEGIST=...
ADFORGE_LLM_DIRECTOR=...
ADFORGE_LLM_CINEMATOGRAPHER=...
ADFORGE_LLM_GATE_VLM=...
```

Structured output via `generateObject` + Zod, which compiles to `output_config.format` with a JSON schema. **Never string-concatenate model output into a payload** — serialize objects. This deletes the entire markdown-fence bug class that bit the Make build.

**Recommended starting assignments** (all configurable; Anthropic canonical IDs — verify the exact OpenRouter slug against their model list at build time, don't guess it):

| Stage | Model | Why |
|---|---|---|
| Strategist | `claude-sonnet-5` | Vision + judgment, small output, high volume |
| Director | `claude-opus-5` | The hardest creative task in the system |
| Cinematographer | `claude-sonnet-5` | Heavily typed and constrained by the World Bible |
| Gate VLM | `claude-haiku-4-5` | Closed rubric, one call per keyframe, cost-sensitive |

Current pricing per 1M tokens: Opus 5 $5/$25 · Sonnet 5 $3/$15 (intro $2/$10 through 2026-08-31) · Haiku 4.5 $1/$5.

### ⚠ `temperature` is gone — and it changes the design

Both source specs specify **Strategist at temperature 0.2, Director at 0.7**. On Anthropic's current models (Opus 5, Sonnet 5, Opus 4.7/4.8, Fable 5) **`temperature`, `top_p`, and `top_k` are rejected with a 400.** Through OpenRouter the parameter may be silently dropped or forwarded depending on routing — either way, do not rely on it, and do not set it in AI SDK calls for Anthropic-routed models.

The replacement is `output_config.effort` (`low` | `medium` | `high` | `xhigh` | `max`) plus prompting. Suggested: Strategist `medium`, Director `high`, Cinematographer `medium`, Gate `low`.

**The consequence is bigger than a parameter swap.** Variant diversity can no longer lean on sampling variance at all. It rests entirely on:

1. the **shortlist** offering genuinely different candidates (§6),
2. the diversity rule stated in the Director prompt, and
3. `assertVariantDiversity()` enforcing family-level distance in code, with a repair pass (§5.2).

Which is exactly what `adforge-app-spec.md §5.1` argued for on other grounds. Good instinct, now mandatory. **If the code-level assertion is weak, the product's core claim is fake.**

### Prompt caching

The Strategist prompt carries two long few-shot anchors; the Director carries a full worked output. These are stable prefixes and should be cached — reads cost ~0.1× base input, writes 1.25× (5-min TTL).

Minimum cacheable prefix is **model-dependent**: Opus 5 = 512 tokens, Sonnet 5 = 1024, Haiku 4.5 = 4096. Below the threshold it silently doesn't cache — `cache_creation_input_tokens: 0`, no error. Our prompts clear 1024 comfortably; the Haiku-based gate prompt likely does not, so don't bother caching it.

Caching is a **prefix match** — any byte change invalidates everything after it. Keep the system prompt frozen; never interpolate the product name, date, or job ID above the cached content. Verify with `usage.cache_read_input_tokens`; a persistent zero means a silent invalidator.

**Caching behaviour varies by provider through OpenRouter.** This is the concrete reason the `LLMProvider` seam exists: once model selection settles, dropping the hot path to the Anthropic SDK direct is one adapter and buys back deterministic caching.

---

## 9. Renderer

### HyperFrames is primary

Verified 2026-08-15: **Apache-2.0** (LICENSE file + GitHub SPDX), ~41k stars, repo created 2026-03-10, actively pushed. `@hyperframes/producer` at **0.7.109** — 352 releases in five months.

Compositions are HTML/CSS/JS. The engine loads them in headless Chrome, seeks deterministically (`frame = floor(time * fps)`), captures via `beginFrame`, pipes to FFmpeg. Determinism contract: no wall clock, no live network at render time, no unseeded randomness.

| Package | Role |
|---|---|
| `@hyperframes/producer` | Programmatic render — `createRenderJob` / `executeRenderJob`, progress + cancellation |
| `@hyperframes/core` | Composition types, compilation, browser runtime |
| `@hyperframes/sdk` | Headless composition editing — query by property, typed mutations, serialize |
| `@hyperframes/player` | Web component for in-app preview |
| `@hyperframes/aws-lambda` / `gcp-cloud-run` | Distributed render adapters |

**Why it beats Remotion here:**

1. **Agent-authoring.** Models write correct HTML/CSS/GSAP/Three.js far more reliably than correct `useCurrentFrame`/`interpolate`/`Sequence`/Lambda-config Remotion. Since most of the motion library is agent-written, this is the largest practical difference.
2. **Variables + batch map onto our data model.** Variables declared via `data-composition-variables`, bound with `data-var-text` / `data-var-src` / CSS custom properties, supplied as `--variables` JSON or `--batch rows.json`. Our unit of work is *three variants of one product* — that's literally one composition and a rows file.
3. **Three.js is first-class**, via a frame adapter publishing `window.__hfThreeTime` and dispatching `hf-seek`. M1 depth parallax — Addendum B's one non-trivial renderer component — is buildable here by design.
4. **Native captions** with per-word emphasis. Build spec §8.4 calls burned-in word-by-word captions "the single biggest 'this looks professional' signal in short-form."
5. Apache-2.0 with no ceiling, vs Remotion's company-size-based commercial licence.

### Corrections to `adforge-app-spec.md §7.2`

That section's comparison table has three errors, and the verdict rested on them:

| §7.2 claims | Actually |
|---|---|
| HyperFrames client preview: "None equivalent" — listed as Remotion's "big UX and cost win" | **`@hyperframes/player` exists.** Preview-before-you-pay works on both. |
| Managed scale: "Roll your own" | `@hyperframes/aws-lambda`, `@hyperframes/gcp-cloud-run`, and HeyGen managed cloud |
| Adapter "shells out to `npx hyperframes render`" | `@hyperframes/producer` gives programmatic control with progress and cancellation — no process spawning |

§7.2's verdict was right given those inputs. Corrected, HyperFrames wins.

### The two real risks, and their mitigations

| Risk | Mitigation |
|---|---|
| **0.x at ~2 releases/day.** API churn is a live cost. | **Pin exact versions. Never use ranges.** Upgrades are deliberate, tested work. |
| **Weaker typing.** Variables are a JSON blob in an HTML attribute bound by string keys — versus Remotion's real typed `inputProps`. | **JSON Schema is the source of truth.** A generated validator runs over the variable payload *before* anything reaches the renderer. Same discipline as Addendum B's `validate()`: a malformed payload is a test failure, not a runtime surprise. |

The thing to watch in the first spike: HyperFrames composes by convention where React composes structurally. Addendum B wants `kenBurns`, `depthParallax`, `rackFocus`, `DepthLayerStack` as reusable units. If that library gets unwieldy, that's the signal to reconsider.

`packages/renderer-remotion` stays defined against the same `RendererProvider` interface as a hedge. `renderer-hyperframes` translates `VideoSpec` → composition + variables and calls the render service. **The renderer receives our `VideoSpec` IR, never provider-shaped JSON.**

---

## 10. Webhooks and reconciliation

Every async provider needs both webhooks and polling, because callbacks get lost.

- `POST /api/webhooks/[provider]` → verify signature → parse → `inngest.send` → return 2xx fast, do work in the queue.
- **Reconciliation cron every 2 minutes:** any `provider_call` in `pending` older than 2× its typical latency gets polled directly.

The Make build had no equivalent, and a dropped callback stranded the job forever.

---

## 11. Observability and cost

| Layer | Tool | What it buys |
|---|---|---|
| LLM tracing | **Langfuse** | Every stage traced with prompt, response, cost, latency, schema-validation result. Prompt versioning and A/B. Diversity-rule violations become data, not vibes. This is the layer you'll live in. |
| Errors | Sentry | Across web, worker, renderer |
| Cost + latency | `provider_calls` table | Per-step, per-provider, per-tier. Feeds `/cost-report`. |
| Regression | **Eval harness** | Golden products (the oil, the mug) through the full chain; asserts diversity holds and JSON validates. Catches prompt regressions before they hit a render bill. |

Per-second pricing means at least four different things across video vendors, and the headline rate often buys a lower tier. **Cost comparison must be empirical, from `provider_calls` — never from a marketing page.**

---

## 12. Testing

| Layer | Approach |
|---|---|
| Provider adapters | Recorded fixtures from real responses, committed. One test per error code. |
| Request builders | **Golden files.** Snapshot the exact JSON sent to each provider. Any change is a visible diff. This is the test that would have caught every 400 the Make build hit. |
| Schemas | Property tests — an arbitrary valid `VideoSpec` must always produce a valid provider request |
| Diversity rule | Unit test on `assertVariantDiversity` |
| Gate | Deliberately corrupt a keyframe; assert rejection |
| Pipeline | Inngest test harness, all providers stubbed |
| Render | 240×426, 5 frames, in CI — catches font/asset failures cheaply |
| Visual | Frame hash comparison on a fixed seed |

**No adapter merges without a golden file and one recorded live response.**

---

## 13. Build order

### Phase 0 — foundation
| # | Milestone | Exit criteria |
|---|---|---|
| 0 | Monorepo, Drizzle schema, R2, env validation | `pnpm dev` boots; migration applies; bad provider id fails at boot |
| 1 | Storage + ingest | Upload 3 images → rows in `assets`, internal URLs resolve, sha256 dedupe works |

### Phase 1 — prove the render path *before* any AI touches it
| # | Milestone | Exit criteria |
|---|---|---|
| 2 | **Spike: HyperFrames** | Hand-written `VideoSpec` → 20s 4-beat MP4 via `@hyperframes/producer`. Captions burned in. |
| 3 | **Spike: depth parallax** | One M1 shot that reads as a real camera move. **Gates the entire motion library.** If it doesn't look right, M1 is cut and we ship M0-only for longer. |
| 4 | `VideoSpec` → composition adapter | Golden file; renderer service behind `RendererProvider` |

**Milestone 2 before the LLM work** — same reason the Make build proved JSON2Video before wiring Claude.

### Phase 2 — the creative engine
| # | Milestone | Exit criteria |
|---|---|---|
| 5 | **Vocabulary registry** | Tables + families + seed migration loading the build spec's 7/8/7 as `active`. Slugs stable. Retired entries still resolvable. |
| 6 | `shortlist` step | Rules-layer only: archetype affinity + one reserved `experimental` slot. Snapshotted to `jobs.shortlist`. |
| 7 | LLM layer | `strategize()` + `direct()` return schema-valid output; Director selects from the shortlist; **family-level diversity test passes**; Langfuse traces visible |
| 8 | Proposal capture | Strategist emits a `vocab_proposal` on poor fit; review queue in the UI; promotion to `experimental` works |
| 9 | Spec builder | Director output → valid `VideoSpec` (golden file) |
| 10 | TTS + audio timing | Voice tracks frame-aligned; captions sync; **Hinglish voice validated** |
| 11 | Inngest pipeline | End-to-end: upload → 3 MP4s in R2 |
| 12 | Next.js UI + player | Three variants side by side with `rationale` and `strategic_bet` visible; approve one |

**v1 is done at Milestone 12.**

Milestone 5 before 7 is the point: the registry has to exist before any job writes a variant, or those variants need slug backfill later.

### Phase 3 — shot synthesis (Addendum A)
| # | Milestone | Exit criteria |
|---|---|---|
| 13 | Product Bible | Upload 3 photos → cutouts with alpha, `labelText` populated, identity embedding stored |
| 14 | **T0 composite path** | Generated plate + real cutout, indistinguishable from a shot photo. **Do this before any of the machinery above it** — if T0 doesn't look right the whole tier system collapses. |
| 15 | Registry embeddings | Every entry embedded; `shortlist` gains the similarity layer; diversity gains the pairwise-distance check |
| 16 | `WorldBible` + `ShotList` | Two products yield visibly different worlds; props persist across beats |
| 17 | Keyframes T1/T2 | 4 keyframes per variant, one coherent style |
| 18 | Continuity gate | Deliberately corrupt a keyframe; gate rejects it |
| 19 | Motion synthesis + routing | `first_last_frame` used where both keyframes exist |
| 20 | Tier router + cost telemetry | Cost per variant visible in `provider_calls`, split by tier |

### Phase 4 — distribution (Addendum B)
Aggregator (Blotato / Ayrshare) behind `DistributionProvider` → OAuth linking → transcode-per-target + local `validate()` → scheduling and draft mode. **Validation before scheduling**, or the first scheduled batch fails silently at 3am with no one watching.

Direct platform APIs are 6–18 weeks of app review across three independent regimes. Wrong order for a product still finding its shape.

### Phase 5 — attribution and vocabulary discovery, the actual product

Metrics ingestion on a decay schedule (hourly for 24h, 6-hourly to day 7, daily to day 30, then stop) → attribution dashboard sliced by format × hook × archetype, **rolling up to family when a slug is thin** → historical priors feeding the `shortlist` priors layer.

Two things unlock here that the registry made possible:

- **Promotion on evidence.** `experimental` entries that beat their family baseline get promoted to `active`. Ones that lose get retired. The vocabulary starts curating itself.
- **Ad mining.** Ingest real short-form ads, classify their structure against the registry, and cluster the residue — the ads that fit nothing — into proposed new formats and hooks. This is the strongest growth path because it's empirical rather than invented, and it's a substantial build in its own right.

**The exploratory slot is what makes any of this work.** One of three variants always samples outside the current best-known combination — in practice, the reserved `experimental` shortlist slot. Without it the priors converge on a local maximum and the registry stops growing.

Never claim cross-platform view parity — a TikTok view, an Instagram play and a YouTube view have different thresholds. Compare within a platform, or compare engagement *rates*. Store `raw` metrics always: metric fields get deprecated on short notice, and a raw archive is the difference between a schema migration and permanent data loss.

---

## 14. Open decisions → ADRs

Resolve before Phase 2 ships; each becomes a file in `docs/decisions/`.

1. **Music.** Royalty-free library vs licensed catalogue. Note Meta and TikTok both reject uncleared audio in paid ad creative — "ad-safe by default" is a feature, not a compromise.
2. **Caption source.** Whisper on the rendered voice track (accurate, one more step) vs cues from the script (free, drifts).
3. **b-roll cost ceiling.** At $0.09–0.68/sec and a realistic 2–3× retry ratio, a 4-clip variant is $2–15. Cap per job, or make it a paid tier.
4. **Video provider shortlist.** Addendum B §B4 names `supportsFirstLastFrame` as the top capability filter, since we buy fewer, harder seconds. Depth conditioning is nearly free for us — we already compute depth maps for M1.
5. **Direct Anthropic SDK for the hot path.** Once model selection settles, does deterministic prompt caching justify leaving OpenRouter for the Strategist/Director calls?
6. **Multi-tenancy depth.** Row-level `projectId` scoping now is much cheaper than retrofitting.
7. **Registry scope — global or per-project?** A shared registry pools attribution data across all users, which is what makes the §B9 moat compound. A per-project registry lets a brand build a private house vocabulary. Probably: global registry + per-project overrides on ranking, never on slugs. Decide before Phase 5, because it determines whether attribution data is poolable.
8. **Promotion threshold.** What evidence promotes `experimental` → `active`, and what retires an entry? Needs a real number (posts, or a lift threshold against family baseline) before Phase 5, or the vocabulary grows without ever pruning.

---

## 15. Deliberate non-goals for v1

Publishing · billing · timeline editor · real-time collaboration · QC gate (Phase 3) · direct platform APIs · self-hosted video models.
