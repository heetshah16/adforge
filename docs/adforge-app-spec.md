# AdForge — Application Spec

Engineering spec for the code implementation. Assumes `adforge-build-spec.md` for domain content (archetypes, formats, hooks, prompts) — that document is the source of truth for *what* the system says; this one is *how* it's built.

Written to be handed to Claude Code.

---

# 1. SCOPE

**Build:** a service that takes product images (+ optional URL) and returns N structurally-different short-form video ads, each with a stated strategic rationale.

**Core constraint:** every external capability — LLM, image gen, video gen, TTS, render, storage — sits behind an interface. Swapping Seedance for Wan, or Remotion for HyperFrames, is a config change and one adapter file. No provider type crosses into domain code.

**Non-goals for v1:** publishing/distribution, multi-tenant billing, a timeline editor, real-time collaboration.

---

# 2. WHAT THE MAKE BUILD TAUGHT US

These are the load-bearing learnings. Each maps to a concrete design decision — don't relearn them.

| Learning | Design response |
|---|---|
| **Renders take 1–5 min; nothing may block on them.** | Durable job orchestration from day one. No synchronous render path exists, even for tests. |
| **Provider-native objects leaked into payloads.** An attachment object was interpolated where a URL string was expected; its embedded quotes destroyed the JSON. | **Normalize at the boundary.** Every asset becomes `MediaRef { id, url, mime, width, height, bytes }` the instant it enters the system. Provider shapes never travel. |
| **Every payload bug surfaced as a remote 400.** Round-trip per attempt: ~45s. | **Validate locally before sending.** Zod schema for every provider request; a golden-file test per adapter. A malformed payload must fail in CI, not at the vendor. |
| **LLM returned JSON wrapped in markdown fences; string interpolation of model text broke the envelope.** | Structured output with schema-constrained decoding (`generateObject` + Zod). Never string-concatenate model output into a payload — serialize objects with `JSON.stringify`. This entire bug class disappears. |
| **I guessed a tool's input schema three times and was wrong three times.** Reading the actual spec found it in one call. | Adapters are written against fetched OpenAPI/type definitions, committed to `docs/providers/`. No adapter ships without a recorded live response fixture. |
| **Two-call LLM split (Strategist → Director) roughly halved schema violations vs one call.** | Keep the split. Separate models per stage — cheap/fast for classification, stronger for creative. |
| **A status field on the record prevented duplicate processing.** | Explicit state machine + DB-level idempotency keys. |
| **Airtable signed URLs expire in hours.** A render tomorrow against today's URL 404s. | **Ingest before use.** Copy every input asset into own object storage; the pipeline only ever sees internal URLs. |
| **One failed variant killed the batch until errors were isolated.** | Per-variant fault isolation. Partial success is a first-class outcome: 2 of 3 delivered is a success with a warning. |
| **Free-tier ceilings (ops, concurrency, execution time) dictated architecture more than the design did.** | Track cost per job in the DB from commit one. Budget guard before dispatch, not after. |

---

# 3. ARCHITECTURE

```
┌──────────────┐
│  Next.js UI  │  upload · review 3 variants · approve · download
└──────┬───────┘
       │ tRPC / REST
┌──────▼─────────────────────────────────────────────────┐
│  API layer                                              │
│  POST /jobs  ·  GET /jobs/:id  ·  POST /webhooks/:prov  │
└──────┬─────────────────────────────────────────────────┘
       │ enqueue
┌──────▼─────────────────────────────────────────────────┐
│  Orchestrator (durable steps, retries, idempotency)     │
│                                                          │
│  ingest → strategize → direct → resolveAssets →         │
│  synthesizeVoice → composeSpec → render → finalize      │
└──────┬─────────────────────────────────────────────────┘
       │ via registry
┌──────▼─────────────────────────────────────────────────┐
│  Provider layer  (all swappable)                        │
│  LLM · ImageGen · VideoGen · TTS · Renderer · Storage   │
└─────────────────────────────────────────────────────────┘
```

## 3.1 Stack

| Layer | Choice | Why |
|---|---|---|
| Language | TypeScript, strict | Remotion is React; one language end-to-end |
| Monorepo | pnpm workspaces + Turborepo | `packages/core` importable by web and worker |
| Web | Next.js App Router | Hosts `@remotion/player` for client-side preview |
| DB | Postgres (Neon/Supabase) + Drizzle | Typed schema, cheap migrations |
| Orchestration | **Inngest** (or BullMQ + Redis if self-hosting) | Durable steps, automatic retries, native long-running fan-out. Solves the exact problem Make couldn't. |
| Storage | Cloudflare R2 | S3-compatible, **zero egress** — decisive when moving video |
| LLM routing | Vercel AI SDK | `generateObject` + Zod gives provider-agnostic structured output for free |
| Render | Remotion Lambda (prod) / local (dev) | Horizontal scale without owning servers |
| Observability | OpenTelemetry + Langfuse | Per-step spans, per-job cost, prompt versioning |

**On Inngest vs BullMQ:** Inngest's `step.run` gives durable memoized steps, so a failure at `render` doesn't re-run `strategize` and re-bill the LLM. That's worth the dependency. Use BullMQ only if data residency forces self-hosting.

---

# 4. THE PROVIDER ABSTRACTION

This is the core of the spec. Get it right and everything else is mechanical.

## 4.1 Shared primitives

```ts
// packages/core/src/providers/types.ts

export interface MediaRef {
  id: string;
  url: string;              // ALWAYS an internal R2 URL, never a vendor URL
  mime: string;
  width?: number;
  height?: number;
  bytes?: number;
  durationSec?: number;
}

export interface Money { amountUsd: number; estimated: boolean; }

export interface JobHandle {
  provider: string;
  externalId: string;
  pollAfterMs: number;
  raw?: unknown;            // vendor payload, for debugging only
}

export type ProviderResult<T> =
  | { status: 'pending'; handle: JobHandle }
  | { status: 'done'; value: T; cost: Money; latencyMs: number }
  | { status: 'failed'; error: ProviderError; retryable: boolean };

export class ProviderError extends Error {
  constructor(
    readonly provider: string,
    readonly code: 'AUTH' | 'RATE_LIMIT' | 'INVALID_INPUT'
                 | 'CONTENT_POLICY' | 'TIMEOUT' | 'UPSTREAM' | 'UNKNOWN',
    message: string,
    readonly raw?: unknown,
  ) { super(message); }
}

export interface Capability {
  readonly id: string;
  readonly displayName: string;
  supports(req: unknown): boolean;
  estimateCost(req: unknown): Money;
}
```

**Rule:** `INVALID_INPUT` from a provider is a **bug in our adapter**, not a runtime condition. It should have failed Zod validation locally. Log it at error level and alert.

## 4.2 VideoProvider

```ts
export interface VideoGenRequest {
  mode: 'text_to_video' | 'image_to_video' | 'reference_to_video'
      | 'first_last_frame';
  prompt: string;
  negativePrompt?: string;
  images?: MediaRef[];            // >1 = reference conditioning
  firstFrame?: MediaRef;
  lastFrame?: MediaRef;
  durationSec: number;
  aspectRatio: '9:16' | '16:9' | '1:1';
  resolution: '480p' | '720p' | '1080p';
  nativeAudio?: boolean;
  seed?: number;
  idempotencyKey: string;
}

export interface VideoCapabilities {
  modes: VideoGenRequest['mode'][];
  maxDurationSec: number;
  resolutions: VideoGenRequest['resolution'][];
  maxReferenceImages: number;
  nativeAudio: boolean;
  typicalLatencyMs: number;
  costPerSecondUsd: Partial<Record<VideoGenRequest['resolution'], number>>;
}

export interface VideoProvider extends Capability {
  readonly capabilities: VideoCapabilities;
  submit(req: VideoGenRequest): Promise<JobHandle>;
  poll(handle: JobHandle): Promise<ProviderResult<MediaRef>>;
  parseWebhook?(headers: Headers, body: unknown):
    { externalId: string; result: ProviderResult<MediaRef> } | null;
}
```

**Adapters for v1:** `seedance-modelark`, `seedance-fal`, `wan-fal`, `wan-replicate`, `kling-fal`.

Two providers for the same model on purpose. <cite index="15-1">Per-second pricing means at least four different things across platforms, and the headline rate often buys a lower tier</cite> — so cost comparison must be empirical, from your own `job_costs` table, not from marketing pages.

## 4.3 LLMProvider

Don't hand-roll this. The AI SDK already is the abstraction.

```ts
// packages/core/src/llm/index.ts
import { generateObject } from 'ai';

export async function strategize(input: StrategistInput) {
  return generateObject({
    model: resolveModel('strategist'),   // env-driven
    schema: StrategistOutputSchema,      // Zod — see §5
    system: PROMPTS.strategist,
    messages: [{ role: 'user', content: [
      { type: 'text', text: renderStrategistPrompt(input) },
      ...input.images.map(i => ({ type: 'image' as const, image: i.url })),
    ]}],
    temperature: 0.2,
  });
}
```

`resolveModel()` reads `ADFORGE_LLM_STRATEGIST=anthropic:claude-...` / `openai:...` / `google:...` and returns the SDK model. **Schema-constrained decoding is why the fence-stripping bug cannot recur.**

## 4.4 TTSProvider

```ts
export interface TTSRequest {
  text: string;
  language: 'en' | 'hi' | 'hinglish' | string;
  voiceId?: string;              // provider-specific, resolved by voice map
  speed?: number;
  idempotencyKey: string;
}
export interface TTSProvider extends Capability {
  listVoices(language: string): Promise<VoiceDescriptor[]>;
  synthesize(req: TTSRequest): Promise<ProviderResult<MediaRef>>;
}
```

Keep a `config/voices.ts` map from `(language, persona) → providerVoiceId`. **Hinglish is a real capability difference between vendors** — write the language→voice map as data, and make an untested language fail loudly rather than silently render in the wrong accent.

## 4.5 Renderer

```ts
export interface RenderRequest {
  spec: VideoSpec;              // our IR — see §5.3
  outputKey: string;
  webhookUrl?: string;
  idempotencyKey: string;
}
export interface RendererProvider extends Capability {
  render(req: RenderRequest): Promise<ProviderResult<MediaRef>>;
  poll?(handle: JobHandle): Promise<ProviderResult<MediaRef>>;
}
```

Implementations: `remotion-lambda`, `remotion-local`, `hyperframes-cli`.

**The renderer receives our `VideoSpec` IR, never provider-shaped JSON.** Each adapter translates. This is what makes swapping Remotion→HyperFrames a single file.

## 4.6 Registry and routing

```ts
export class ProviderRegistry {
  register(kind: ProviderKind, p: Capability): void;
  get<T>(kind: ProviderKind, id: string): T;
  select<T>(kind: ProviderKind, policy: SelectionPolicy): T;
}

export interface SelectionPolicy {
  require: Partial<VideoCapabilities>;
  optimize: 'cost' | 'latency' | 'quality';
  maxCostUsd?: number;
  exclude?: string[];           // circuit-broken providers
}
```

Selection is **policy-driven, not hardcoded**: "cheapest provider supporting image_to_video at 720p with ≥3 reference images, under $0.50/clip." A provider failing health checks is excluded automatically.

---

# 5. DOMAIN MODEL

## 5.1 Schemas (Zod, single source of truth)

Port the vocabulary from `adforge-build-spec.md` §3–4 verbatim into enums:

```ts
export const Archetype = z.enum(['remedy','upgrade','indulgence','identity',
                                 'utility','gifting','trust']);
export const Format = z.enum(['problem_solution','ugc_testimonial','before_after',
                              'spec_flex','sensory_tease','styling_moment',
                              'objection_kill','listicle_3']);
export const HookArchetype = z.enum(['pattern_break','direct_call','stat_shock',
                                     'confession','curiosity_gap','demonstration',
                                     'objection_lead']);
export const VisualTreatment = z.enum(['clean_studio','lifestyle_context',
                                       'macro_texture','hand_held_ugc',
                                       'flat_lay','split_compare']);
```

Enforce the diversity rule **in code, after generation** — not only in the prompt:

```ts
export function assertVariantDiversity(variants: Variant[]) {
  const hooks = new Set(variants.map(v => v.hookArchetype));
  const formats = new Set(variants.map(v => v.format));
  if (hooks.size < variants.length)
    throw new DiversityViolation('hook_archetype', [...hooks]);
  if (formats.size < 2)
    throw new DiversityViolation('format', [...formats]);
}
```

On violation → one repair pass with the violation named in the prompt → then fail. The Make version could only ask nicely.

## 5.2 Database (Drizzle)

```
projects        id, name, brandKit(jsonb), createdAt
assets          id, projectId, kind, r2Key, mime, w, h, bytes, sha256, sourceUrl
jobs            id, projectId, status, inputSpec(jsonb), brief(jsonb),
                costUsd, error(jsonb), createdAt, completedAt
variants        id, jobId, variantNo, format, hookArchetype, visualTreatment,
                strategicBet, spec(jsonb), status, renderAssetId, costUsd
provider_calls  id, jobId, variantId, kind, provider, model, requestHash,
                idempotencyKey, latencyMs, costUsd, status, error(jsonb)
```

`provider_calls` is not optional. It's your cost model, your latency baseline, and your A/B substrate. **Unique index on `idempotencyKey`** — that's the double-fire guard the Make `status → processing` hack was approximating.

`assets.sha256` gives free dedupe: the same product photo uploaded twice is stored once.

## 5.3 VideoSpec — the intermediate representation

The contract between creative and rendering. Renderer-agnostic by construction.

```ts
export const VideoSpec = z.object({
  id: z.string(),
  dimensions: z.object({ width: z.number(), height: z.number() }),
  fps: z.literal(30),
  durationInFrames: z.number(),
  theme: z.object({
    fontFamily: z.string(), primary: z.string(),
    accent: z.string(), captionStyle: z.enum(['boxed_word','karaoke','plain']),
  }),
  scenes: z.array(z.object({
    startFrame: z.number(), durationInFrames: z.number(),
    layers: z.array(z.discriminatedUnion('type', [
      z.object({ type: z.literal('image'), assetId: z.string(),
                 motion: Motion, fit: z.enum(['cover','contain']) }),
      z.object({ type: z.literal('video'), assetId: z.string(),
                 trimStart: z.number().optional(), muted: z.boolean() }),
      z.object({ type: z.literal('text'), content: z.string(),
                 position: Position, style: TextStyle,
                 enter: Transition, exit: Transition }),
      z.object({ type: z.literal('overlay'), assetId: z.string(),
                 position: Position, opacity: z.number() }),
    ])),
  })),
  audio: z.object({
    voiceTracks: z.array(z.object({ assetId: z.string(), startFrame: z.number() })),
    music: z.object({ assetId: z.string(), gainDb: z.number() }).optional(),
  }),
  captions: z.object({
    source: z.enum(['whisper','provided']),
    cues: z.array(Cue).optional(),
  }),
});
```

**Everything is frames, not seconds.** Seconds-to-frames rounding drift is the single most common source of audio desync in programmatic video. Convert once, at spec-build time.

**Layers reference `assetId`, never URLs.** The renderer resolves IDs through storage at render time — so a spec stored today still renders next month.

---

# 6. PIPELINE

Each step is a durable, memoized, individually-retryable unit.

```ts
export const generateAds = inngest.createFunction(
  { id: 'generate-ads', concurrency: { limit: 5 }, retries: 2 },
  { event: 'adforge/job.created' },
  async ({ event, step }) => {
    const { jobId } = event.data;

    // 1. INGEST — copy every input into R2, normalize to MediaRef.
    //    Kills the expiring-signed-URL class of failure.
    const assets = await step.run('ingest', () => ingestAssets(jobId));

    // 2. ENRICH — optional URL scrape. Failure is non-fatal.
    const pageText = await step.run('enrich', () => scrapeProductPage(jobId));

    // 3. STRATEGIZE — cheap model, temp 0.2, images attached.
    const brief = await step.run('strategize', () =>
      strategize({ assets, pageText, notes: job.notes }));

    // 4. DIRECT — stronger model, temp 0.7. Diversity asserted in code,
    //    one repair pass on violation.
    const variants = await step.run('direct', () =>
      directWithRepair(brief, assets, job.language));

    // 5. FAN OUT — per-variant, isolated. Partial success allowed.
    const results = await Promise.allSettled(
      variants.map(v => step.invoke(`variant-${v.variantNo}`, {
        function: renderVariant, data: { jobId, variant: v, assets },
      })),
    );

    await step.run('finalize', () => finalize(jobId, results));
  },
);
```

`renderVariant` internally: `synthesizeVoice` → `generateBroll?` → `composeSpec` → `render` → `persist`.

## 6.1 Where AI video actually belongs

Do **not** let a video model render the hero product shot — label and logo drift is still unsolved. The correct division:

- **AI video (Seedance/Wan):** ambient b-roll, hands, texture, environment, motion backgrounds
- **Remotion:** the real product still, composited on top, with text, brand frame, captions

That hybrid is the entire reason the renderer exists. It's also why `VideoSpec` supports both `image` and `video` layers in the same scene.

For v1, ship **Ken Burns on stills only**. Add the b-roll layer behind a feature flag once the core loop is green — it's the most expensive and least reliable component.

## 6.2 QC gate (v1.1)

After render: extract 4 frames → vision model against a rubric (product legible? text matches script? anatomy sane?) → pass, or regenerate that variant once. Budget it; it's the difference between an automation and a slop machine.

---

# 7. RENDERER

## 7.1 Remotion — the layout

```
packages/renderer-remotion/
  src/
    Root.tsx                 # registerRoot, one composition: <AdComposition/>
    AdComposition.tsx        # props: VideoSpec (Zod-validated)
    scenes/SceneRenderer.tsx
    layers/{Image,Video,Text,Overlay}Layer.tsx
    motion/kenBurns.ts       # motion enum → interpolate()
    captions/Captions.tsx
  remotion.config.ts
```

One parameterised composition, not one composition per template. Templates are **data** (`VideoSpec`), not code. This is why the LLM can invent a new beat structure without a deploy.

Key rules:
- `calculateMetadata` derives `durationInFrames` from the spec — never hardcode
- All timing via `useCurrentFrame()` + `interpolate()`; never `Date.now()` or CSS animation
- `<Audio>` with frame-accurate `startFrom`
- Fonts via `@remotion/google-fonts` with `waitForFonts()` — missing fonts render as tofu and it's silent
- `@remotion/player` in the Next app for **free client-side preview**: users pick a variant before you pay to render

## 7.2 HyperFrames adapter

<cite index="4-1">HyperFrames turns HTML, CSS, media and seekable animations into deterministic MP4, usable via CLI or from AI coding agents with skills</cite>, and <cite index="7-1">compositions are HTML elements with data-* attributes, animated with CSS, GSAP, Lottie or Three.js, rendered to MP4 from the command line</cite>.

`packages/renderer-hyperframes` translates `VideoSpec` → HTML + `data-*` attributes, shells out to `npx hyperframes render`, uploads the MP4. Requires Node 22+ and FFmpeg.

**Where each wins:**

| | Remotion | HyperFrames |
|---|---|---|
| Model | Templates + props | Agent-generated composition |
| Language | React/TSX | HTML + GSAP |
| Client preview | `@remotion/player` — big UX and cost win | None equivalent |
| Managed scale | Lambda | Roll your own |
| Licence | Free ≤3 employees; then $25/dev/mo, $100/mo min | Apache 2.0, no ceiling |
| Agent ergonomics | Good | Purpose-built skills |

**Verdict:** Remotion is the product renderer. HyperFrames earns its place for bespoke one-offs and as a licence hedge — which is exactly why it goes behind the same interface rather than being ignored.

---

# 8. WEBHOOKS AND POLLING

Every async provider needs both, because callbacks get lost.

```ts
// POST /api/webhooks/[provider]
const provider = registry.get<VideoProvider>('video', params.provider);
const parsed = provider.parseWebhook?.(req.headers, await req.json());
if (!parsed) return new Response('ignored', { status: 202 });
await inngest.send({ name: 'adforge/provider.completed', data: parsed });
```

Plus a **reconciliation cron** every 2 minutes: any `provider_call` in `pending` older than 2× its typical latency gets polled directly. The Make build had no equivalent, and a dropped callback stranded the job forever.

Verify signatures per provider. Return 2xx fast; do work in the queue.

---

# 9. CONFIGURATION

```bash
ADFORGE_LLM_STRATEGIST=anthropic:claude-...
ADFORGE_LLM_DIRECTOR=anthropic:claude-...
ADFORGE_VIDEO_PRIMARY=seedance-modelark
ADFORGE_VIDEO_FALLBACK=wan-fal
ADFORGE_TTS_PRIMARY=elevenlabs
ADFORGE_RENDERER=remotion-lambda
ADFORGE_STORAGE=r2
ADFORGE_MAX_COST_PER_JOB_USD=3.00
```

Parse with Zod at boot. **Fail to start on a bad provider id** — never discover it mid-job.

---

# 10. TESTING

| Layer | Approach |
|---|---|
| Provider adapters | Recorded fixtures (nock/msw) from real responses, committed. One test per error code. |
| Request builders | **Golden files.** Snapshot the exact JSON sent to each provider. Any change is a visible diff. This is the test that would have caught every 400. |
| Schemas | Property tests — arbitrary valid `VideoSpec` must always produce a valid provider request |
| Diversity rule | Unit test on `assertVariantDiversity` |
| Pipeline | Inngest test harness with all providers stubbed |
| Render | `@remotion/renderer` in CI at 240×426, 5 frames — catches font/asset failures cheaply |
| Visual | Frame hash comparison on a fixed seed |

**Rule: no adapter merges without a golden file and one recorded live response.**

---

# 11. BUILD ORDER

Each milestone is independently demoable.

| # | Milestone | Exit criteria |
|---|---|---|
| 0 | Monorepo, Drizzle schema, R2, env validation | `pnpm dev` boots; migration applies |
| 1 | Storage + ingest | Upload 3 images → rows in `assets`, internal URLs resolve |
| 2 | LLM layer | `strategize()` + `direct()` return schema-valid output; diversity test passes |
| 3 | `VideoSpec` + Remotion composition | Hand-written spec renders locally to MP4 |
| 4 | Spec builder | Director output → valid `VideoSpec` (golden file) |
| 5 | TTS + audio timing | Voice tracks frame-aligned; captions sync |
| 6 | Inngest pipeline | End-to-end: upload → 3 MP4s in R2 |
| 7 | Next.js UI + Player | Preview all 3 variants client-side, approve one |
| 8 | Remotion Lambda | Same output, rendered in cloud |
| 9 | Second video provider | Swap Seedance↔Wan by env var, no code change |
| 10 | b-roll layer | AI video behind product stills, flag-gated |
| 11 | QC gate | Auto-regenerate on rubric failure |

**Milestone 3 before Milestone 2.** Prove the render path with a hand-written spec before any AI touches it — same reason Phase 2 came before Make modules.

---

# 12. CLAUDE CODE SETUP

## 12.1 Repo layout

```
adforge/
  CLAUDE.md
  .claude/
    settings.json
    commands/{new-provider,render-check,cost-report}.md
    agents/{provider-adapter,remotion-composition}.md
  docs/
    spec.md                    # this file
    domain.md                  # archetypes/formats/hooks
    providers/*.md             # FETCHED vendor API docs, committed
    decisions/*.md             # ADRs
  packages/
    core/ providers/ renderer-remotion/ renderer-hyperframes/ db/
  apps/
    web/ worker/
```

## 12.2 CLAUDE.md — the rules that matter

Keep it short. Long CLAUDE.md files get ignored. These are the non-obvious ones:

```md
# AdForge

## Architecture rules
- Provider SDK types NEVER cross out of `packages/providers/<name>/`.
  Everything crossing a boundary is a `MediaRef` or another type from
  `packages/core/src/providers/types.ts`.
- Every provider request is Zod-validated before dispatch. A remote 400
  means our validation is wrong — fix the schema, not the payload.
- All timing in frames. Convert seconds→frames once, in the spec builder.
- Layers reference assetId, never URLs.
- No synchronous render path exists. Everything goes through Inngest.

## When adding a provider
1. Fetch the real API docs into docs/providers/<name>.md FIRST.
   Do not write the adapter from memory.
2. Record one live response as a fixture.
3. Add a golden file for the request body.
4. Register in the registry; declare capabilities honestly.

## Testing
- `pnpm test` before any commit.
- Render tests: 240x426, 5 frames.

## Known traps
- Signed URLs from third parties expire. Always ingest to R2 first.
- Fonts must resolve before render or text silently renders as boxes.
- Provider "per second" pricing is not comparable across vendors;
  trust the job_costs table, not vendor docs.
```

## 12.3 Subagents

**`provider-adapter`** — given a vendor's docs, produce adapter + fixtures + golden file + registry entry. Tools: Read, Write, Bash, WebFetch. Instruct it to fetch docs before writing code; this is the single highest-value guardrail given how the Make build went.

**`remotion-composition`** — build/modify Remotion components. Restrict to `packages/renderer-remotion/**`. Must run a 5-frame render before reporting done.

## 12.4 Slash commands

- `/new-provider <kind> <name> <docsUrl>` — scaffold from the checklist above
- `/render-check <specFile>` — validate spec, render 5 frames, report timing
- `/cost-report [days]` — aggregate `provider_calls` by provider and job

## 12.5 Plugins and skills worth wiring

- **HyperFrames skills** — `npx skills add heygen-com/hyperframes --full-depth`. <cite index="7-1">These teach agents valid compositions, GSAP timelines and Tailwind v4 browser-runtime styles, with plugin entry points for Claude Code, Cursor, Codex and Gemini CLI</cite>. Install even if Remotion is primary; the composition-authoring skills transfer.
- **Remotion docs as an MCP/fetch source** — pin the version you're on.
- **Postgres MCP** for schema introspection during development.

## 12.6 How to drive it

Work milestone by milestone. For each:

1. `Read docs/spec.md §<n>. Plan the milestone. List files you'll create. Wait for approval.`
2. Approve or correct the plan.
3. `Implement. Run pnpm test. Report the diff.`
4. `Write an ADR in docs/decisions/ for anything you decided that the spec didn't dictate.`

**Never let it invent a provider API from memory.** The instruction "fetch the docs first" is the difference between one clean adapter and four rounds of remote 400s — that pattern cost hours in the Make build and it will cost more here, because the feedback loop is slower.

---

# 13. OPEN DECISIONS

Resolve these before Milestone 6; each becomes an ADR.

1. **Music.** Royalty-free library vs licensed catalogue. Note that Meta and TikTok both reject uncleared audio in paid ad creative, so "ad-safe by default" is a feature, not a compromise.
2. **b-roll cost ceiling.** At $0.09–0.68/sec across providers and a realistic 2–3× retry ratio, a 4-clip variant is $2–15. Cap per job, or make it a paid tier.
3. **Caption source.** Whisper on the rendered voice track (accurate, one more step) vs cues from the script (free, drifts).
4. **Multi-tenancy.** Row-level `projectId` scoping now is much cheaper than retrofitting.
5. **Self-hosting Wan.** Open weights make this viable; only worth it above a volume you should measure first.
