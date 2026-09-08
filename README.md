# AdForge

**A seller uploads product photos or a store URL. AdForge classifies the product by *buying psychology*, then generates three structurally different vertical ad variants — three hypotheses to A/B test, not three rewordings.**

Small D2C sellers spend on Meta, TikTok and Instagram but have no creative budget and no audience data. They can't afford a videographer, can't afford a UGC creator, and can't afford to burn ad spend testing one creative at a time. AdForge gives them three testable angles per product, each with a stated strategic bet.

> **Status: pre-implementation.** This repository currently tracks specification and architecture only. No code has been written yet. See [Build order](#build-order).

---

## Why this isn't a video-model wrapper

**1. It classifies by buying psychology, not product category.**
"Cooking oil" is a food product; the *correct* read is that premium cooking oil is bought as a health remedy under a trust objection. That reclassification determines the ad format, and it's the decision a naive system gets wrong.

**2. Variant diversity is a schema constraint, not a hope.**
The three outputs are forced to differ on hook family and format family, asserted in code with a repair pass — not merely requested in a prompt. Without that rule you get three paraphrases and the feature is fake.

**3. The reasoning is visible.**
Every run surfaces a one-line rationale for the classification and a per-variant "strategic bet" — what this variant assumes about the buyer that the other two don't. The user sees *why*, not just *what*.

**4. The creative vocabulary compounds.**
Variants differ along *typed, tracked* dimensions — archetype, format, hook. When performance data comes back, it can be attributed to those dimensions: *"for `remedy` products on TikTok, `objection_lead` hooks retain 18% better than `curiosity_gap`."* A competitor wrapping a video model has no typed dimensions and therefore cannot learn. That vocabulary is an adaptive registry, not a frozen enum — it grows from observed gaps and mined real ads, and prunes on evidence.

---

## Documentation

| Document | Role |
|---|---|
| **[docs/architecture.md](docs/architecture.md)** | **The reference.** Reconciles all four specs below and wins wherever they disagree. Start here. |
| [CLAUDE.md](CLAUDE.md) | Operating rules for coding sessions. Short by design. |
| [docs/adforge-build-spec.md](docs/adforge-build-spec.md) | Domain source of truth — creative vocabulary, prompt stack, diversity rule, few-shot anchors. Describes an earlier no-code build that is **not** being built; only the domain content carries forward. |
| [docs/adforge-app-spec.md](docs/adforge-app-spec.md) | Engineering spec — provider abstraction, `VideoSpec` IR, DB schema, pipeline, testing discipline. |
| [docs/adforge-spec-addendum-shot-synthesis.md](docs/adforge-spec-addendum-shot-synthesis.md) | Addendum A — fidelity tiers, Product Bible, World Bible, Shot List, the continuity gate. |
| [docs/adforge-spec-addendum-motion-distribution.md](docs/adforge-spec-addendum-motion-distribution.md) | Addendum B — motion tiers, depth parallax, distribution, metrics, attribution. |
| `docs/decisions/` | ADRs. Anything decided that the architecture doc didn't dictate. |
| `docs/providers/` | Fetched vendor API docs, committed. Adapters are written against these, never from memory. |

---

## How it works

```
ingest → enrich → strategize → shortlist → direct
   → per variant: cinematograph → keyframes → ◆GATE◆
                  → motion → voice → composeSpec → render
   → finalize
```

**Strategize** classifies the product by buying psychology and names the core objection.
**Shortlist** narrows the creative registry to candidates that fit *this* product.
**Direct** picks three variants from that shortlist, forced apart by the diversity rule.
**The gate** sits between image generation and video generation — a rejected keyframe costs cents, a rejected clip costs dollars. Four of its five checks are arithmetic.

Two orthogonal per-shot axes set cost and risk: **fidelity tiers** (how much of the product's identity may be generated — a hero shot is always a real cutout composited over a generated plate) and **motion tiers** (does the camera move, or the world — 2D transform, depth parallax, or a video model).

Nothing blocks on a render. There is no synchronous render path, not even in tests.

---

## Stack

TypeScript end-to-end · pnpm + Turborepo · Next.js · Supabase (Postgres + Auth) · Drizzle · Inngest · Cloudflare R2 · OpenRouter via Vercel AI SDK · fal.ai · ElevenLabs · HyperFrames

Every external capability — LLM, image gen, video gen, TTS, render, storage — sits behind an interface. Swapping a provider is a config change and one adapter file. No provider type crosses into domain code.

---

## Build order

| Phase | What | Status |
|---|---|---|
| **0** | Monorepo, schema, storage, ingest | Not started |
| **1** | Prove the render path before any AI touches it | Not started |
| **2** | The creative engine — registry, shortlist, LLM chain, pipeline, review UI | Not started |
| **3** | Shot synthesis — Product Bible, T0 composites, continuity gate, motion tiers | Not started |
| **4** | Distribution — publish to TikTok / Reels / Shorts via an aggregator | Not started |
| **5** | Attribution and vocabulary discovery — the actual product | Not started |

**v1 is done at the end of Phase 2:** submit a product, get three rendered variants, review them side by side with their rationale and strategic bets. No publishing, no metrics.

Full milestone detail in [architecture.md §13](docs/architecture.md#13-build-order).
