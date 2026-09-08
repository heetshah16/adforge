# AdForge

Generates three structurally different short-form vertical ad variants per product, each classified by buying psychology and carrying a stated strategic bet.

**Read [docs/architecture.md](docs/architecture.md) before any non-trivial work.** It reconciles the four spec documents in `docs/` and wins wherever they disagree with it.

TypeScript end-to-end · pnpm + Turborepo · Next.js · Supabase (Postgres + Auth) · Drizzle · Inngest · Cloudflare R2 · OpenRouter via Vercel AI SDK · fal.ai · ElevenLabs · HyperFrames

## Architecture rules

- **Provider SDK types never leave `packages/providers/<name>/`.** Everything crossing a boundary is a `MediaRef` or another type from `packages/core/src/providers/types.ts`.
- **Every provider request is Zod-validated before dispatch.** A remote 400 means our validation is wrong — fix the schema, not the payload.
- **`MediaRef.url` is always an internal R2 URL.** Third-party signed URLs expire. Ingest to R2 first, always.
- **All timing in frames.** Convert seconds→frames once, in the spec builder. Rounding drift is the top cause of audio desync.
- **Layers reference `assetId`, never URLs.** The renderer resolves through storage at render time.
- **No synchronous render path exists.** Everything goes through Inngest, including in tests.
- **The renderer receives our `VideoSpec` IR, never provider-shaped JSON.** Each adapter translates.
- **`fidelityTier` is computed in code** from `productProminence`. The model does not get to decide how much brand risk to take.
- Partial success is a first-class outcome. 2 of 3 variants delivered is a success with a warning.

## The vocabulary is the moat — and it's a registry, not enums

Two kinds of dimension. Do not confuse them (architecture.md §5.1):

- **Semantic — `archetype`, `format`, `hook_archetype`.** DB-backed registries. Wide, growing, extensible. Adding a value costs ~nothing.
- **Render-coupled — `visual_treatment`, `motion`.** Closed Zod enums in `packages/core`. Every value needs renderer code behind it, so **adding one is a PR, not a data change.**

Registry rules:

- **`slug` is the attribution key. Never rename it. Never reuse it.** It's what makes performance data survive registry growth.
- `variants` stores **slugs, not foreign keys**, so a retired entry can't orphan a historical variant.
- Retired entries stay in the table forever — old jobs must stay interpretable.
- **Nothing auto-promotes to `active`.** New entries enter as `proposed`, get reviewed, land as `experimental`, and only reach `active` on performance evidence.
- `experimental` entries are always assigned to the exploratory variant slot.
- Always snapshot the offered candidates into `jobs.shortlist` — otherwise you can't later distinguish "never wins" from "never shown."

`assertVariantDiversity()` checks **distance, not distinctness**: 3 distinct hook *families*, ≥2 distinct format *families*, plus pairwise embedding distance once Phase 3 lands. Distinct slugs alone would pass three near-synonyms. One repair pass naming the violation, then fail. If this assertion is weak, the product's core claim is fake.

Seed data source: `docs/adforge-build-spec.md` §3–4.

## LLM rules

- **Never set `temperature`, `top_p`, or `top_k`.** Current Anthropic models reject them with a 400. Use `output_config.effort` (`low`→`max`) and prompting instead.
- Structured output via `generateObject` + Zod only. **Never string-concatenate model output into a payload** — serialize objects.
- Model IDs come from env (`ADFORGE_LLM_*`), parsed with Zod at boot. **Fail to start on a bad id** — never discover it mid-job.
- Keep system prompts byte-frozen for prompt caching. Never interpolate product name, date, or job ID above cached content. Verify with `usage.cache_read_input_tokens`.

## HyperFrames rules

- **Pin exact versions. Never use ranges.** It's 0.x shipping ~2 releases/day; upgrades are deliberate, tested work.
- Composition variables are stringly-typed. **Validate the variable payload against the generated JSON Schema before it reaches the renderer.** A malformed payload is a test failure, not a runtime surprise.
- Determinism contract: no wall clock, no live network at render time, no unseeded randomness.

## When adding a provider

1. **Fetch the real API docs into `docs/providers/<name>.md` FIRST.** Do not write the adapter from memory — guessing input schemas cost hours in the Make build and will cost more here, because the feedback loop is slower.
2. Record one live response as a fixture.
3. Add a golden file for the request body.
4. Register in the registry; declare capabilities honestly.

**No adapter merges without a golden file and one recorded live response.**

## Testing

- `pnpm test` before any commit.
- Render tests: 240×426, 5 frames.
- Golden files for every provider request body — this is the test that catches 400s in CI instead of at the vendor.

## Known traps

- Fonts must resolve before render or text silently renders as tofu.
- Provider "per second" pricing is not comparable across vendors. Trust `provider_calls`, not vendor docs.
- Displacing depth layers exposes background that was never photographed. Inpaint once per keyframe and cache it, or M1 looks broken.
- Never let a video model render the hero product shot — label and logo drift is unsolved. Real cutout composited on top, always.
- Webhooks get lost. Every async provider needs polling reconciliation too.
- Prompt-cache minimums are model-dependent (Opus 5: 512 tokens, Sonnet 5: 1024, Haiku 4.5: 4096). Below threshold it silently doesn't cache — no error.

## Working style

Work milestone by milestone against `docs/architecture.md` §13. For each: plan and list files first, get approval, implement, run `pnpm test`, then write an ADR in `docs/decisions/` for anything decided that the architecture doc didn't dictate.
