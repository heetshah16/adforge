# AdForge — Spec Addendum A: Generative Shot Synthesis

Extends `adforge-app-spec.md`. Replaces the naïve assumption in §6.1 that source images are static assets to be panned across.

**The gap this closes:** the base spec can only re-frame photos the seller already has. A real ad needs the product seen from angles that were never shot, in environments that don't exist, with props and talent the director specified — and all of it has to hold together across four beats.

---

# A1. THE CENTRAL PROBLEM

Two things are in tension:

- **Creative freedom** wants generated pixels: new angles, invented sets, motion, atmosphere.
- **Brand fidelity** wants the product's real pixels: the label must be *this* label, the logo *this* logo, the colour *this* colour.

Generative models still drift on small text, logos, and packaging detail. Reference conditioning narrows it — Seedance 2.5 accepts up to 30 reference images, Wan 2.7 offers reference-to-video and start/end-frame control — but neither guarantees a legible label at 1080×1920.

**The resolution is not one policy but a per-shot decision.** How much of the product's identity is load-bearing in *this* frame determines how much of it may be generated.

---

# A2. FIDELITY TIERS

Assigned per shot, not per video.

| Tier | Product pixels | Use when | Cost | Risk |
|---|---|---|---|---|
| **T0 — Composite** | Real, segmented, alpha-matted, composited over generated background | Product is hero in frame; label or logo readable | ~$0.03 (bg only) | None. Product is untouched. |
| **T1 — Conditioned** | Generated from multi-reference, gated by similarity + OCR | New angle needed; product mid-frame | ~$0.04/keyframe + retries | Moderate. Gate catches drift. |
| **T2 — Free** | Fully generated; product absent, distant, or occluded | Ambient b-roll, hands, texture, environment, reaction shots | ~$0.09–0.68/sec | Low, because identity isn't at stake |

**Default policy:** any shot where the director marked `product_prominence: hero` is **T0, non-negotiable**. `supporting` → T1. `absent` → T2.

This is the single most important rule in the addendum. It's also why the compositor (Remotion) is load-bearing rather than decorative: T0 exists only because a real cutout can be laid over a generated plate.

---

# A3. PRODUCT BIBLE

Built once per product, before any creative runs. Cached and reused across jobs.

```ts
export const ProductBible = z.object({
  productId: z.string(),

  // Source truth
  sourceAssets: z.array(z.string()),           // assetIds as uploaded

  // Derived, deterministic
  cutouts: z.array(z.object({                  // SAM / rembg
    assetId: z.string(),                       // RGBA, alpha-matted
    view: z.enum(['front','three_quarter','side','back','top','detail','unknown']),
    maskQuality: z.number(),                   // 0-1, edge confidence
  })),
  palette: z.array(z.object({ hex: z.string(), weight: z.number() })),
  labelText: z.array(z.string()),              // OCR — the QC ground truth
  logoCrop: z.string().optional(),             // assetId
  dimensionsHint: z.string().optional(),       // "tall cylinder", "flat pouch"
  material: z.string().optional(),             // "matte glass", "kraft paper"

  // Derived, generative (T1 enabler)
  synthesizedViews: z.array(z.object({
    assetId: z.string(),
    view: z.string(),
    similarity: z.number(),                    // vs sourceAssets
    approved: z.boolean(),
  })),

  // Embeddings for the continuity gate
  identityEmbedding: z.array(z.number()),      // DINOv2 / CLIP, mean of sources
});
```

**`labelText` is the highest-value field.** It converts "does this look right?" — unanswerable — into "does OCR of the generated frame contain these strings?" — a unit test.

`synthesizedViews` is generated lazily: the first job needing a three-quarter view creates and gates it, and every later job reuses it. Angle synthesis is amortised per product, not paid per ad.

---

# A4. THE EXPANDED PIPELINE

Replaces §6 steps 4–5.

```
strategize  →  direct  →  artDirect  →  cinematograph
                              ↓              ↓
                        WorldBible      ShotList
                              └──────┬───────┘
                                     ▼
                        synthesizeKeyframes  (images — cheap)
                                     ▼
                          ◆ CONTINUITY GATE ◆   ← reject/retry here
                                     ▼
                          synthesizeMotion  (video — expensive)
                                     ▼
                            composeSpec → render
```

The gate sits **between images and video**. That placement is the whole design: a rejected keyframe costs ~$0.04 to redo, a rejected clip costs $0.50–3.00.

## A4.1 Art Direction — the world bible

One call. Output constrains everything downstream.

```ts
export const WorldBible = z.object({
  environment: z.object({
    setting: z.string(),                   // "sunlit Indian home kitchen, morning"
    surfaces: z.array(z.string()),         // "worn teak counter", "brass vessels"
    timeOfDay: z.enum(['dawn','morning','midday','golden_hour','dusk','night']),
    season: z.string().optional(),
  }),
  lighting: z.object({
    key: z.string(),                       // "hard window light, camera left"
    fill: z.string(),
    mood: z.enum(['warm','neutral','cool','high_contrast','soft']),
    practicalSources: z.array(z.string()),
  }),
  palette: z.object({
    dominant: z.array(z.string()),         // hex, MUST harmonise with ProductBible
    accent: z.string(),
    avoid: z.array(z.string()),            // colours that would clash with packaging
  }),
  props: z.array(z.object({
    name: z.string(),
    description: z.string(),
    appearsInBeats: z.array(z.number()),   // continuity: props persist
  })),
  talent: z.array(z.object({
    id: z.string(),
    description: z.string(),               // "woman, 35, cotton kurta, no jewellery"
    referenceAssetId: z.string().optional(),
    seed: z.number(),                      // identity lock across shots
    appearsInBeats: z.array(z.number()),
  })).max(2),
  styleAnchor: z.string(),                 // one sentence appended to every prompt
  negativePrompt: z.string(),              // global: "text, watermark, extra fingers"
});
```

**`seed` per talent is what makes the same person appear in beats 2 and 4.** Not a prompt request — a locked parameter.

**`styleAnchor` is appended to every downstream generation prompt.** It's the cheapest continuity mechanism that exists, and it works.

## A4.2 Cinematography — the shot list

```ts
export const Shot = z.object({
  beat: z.number(),
  shotSize: z.enum(['extreme_close','close','medium_close','medium','wide','extreme_wide']),
  angle: z.enum(['eye_level','high','low','overhead','dutch','over_shoulder']),
  lens: z.enum(['macro','35mm','50mm','85mm','wide_24mm']),
  depthOfField: z.enum(['deep','medium','shallow','extreme_shallow']),

  cameraMove: z.object({
    type: z.enum(['static','push_in','pull_out','pan_left','pan_right',
                  'tilt_up','tilt_down','orbit','handheld_drift','rack_focus']),
    intensity: z.enum(['subtle','moderate','pronounced']),
  }),

  subject: z.object({
    productProminence: z.enum(['hero','supporting','absent']),
    productView: z.enum(['front','three_quarter','side','detail','in_hand','unknown']),
    talentIds: z.array(z.string()),
    propIds: z.array(z.string()),
  }),

  // Continuity constraints — the cinematographer's real job
  continuity: z.object({
    matchesShot: z.number().optional(),     // reuse environment/lighting from shot N
    screenDirection: z.enum(['left','right','neutral']),
    lightingContinuous: z.boolean(),
  }),

  fidelityTier: z.enum(['T0','T1','T2']),   // DERIVED, not chosen by the model
  keyframePrompt: z.string(),
  motionPrompt: z.string(),
});
```

`fidelityTier` is computed from `productProminence` in code. The model doesn't get to decide how much brand risk to take.

**Screen-direction continuity matters more than people expect.** If beat 2 pans right and beat 3 pans left with no motivation, the cut feels wrong even to viewers who can't say why. It's a cheap constraint to encode and a costly one to fix later.

## A4.3 Keyframe synthesis

For each shot, generate the **first frame** — and for moving shots, the **last frame** too.

```ts
interface KeyframeRequest {
  prompt: string;              // keyframePrompt + styleAnchor
  negativePrompt: string;      // WorldBible.negativePrompt
  references: MediaRef[];      // T0/T1: ProductBible cutouts + talent refs
  seed: number;                // from WorldBible for talent continuity
  aspectRatio: '9:16';
  tier: 'T0' | 'T1' | 'T2';
}
```

- **T0:** generate background plate only, product excluded via negative prompt. The real cutout composites in Remotion.
- **T1:** reference-conditioned generation with all product cutouts attached.
- **T2:** free generation with `styleAnchor` + `negativePrompt`.

## A4.4 The continuity gate — deterministic, not an agent

```ts
export async function gateKeyframe(
  frame: MediaRef, shot: Shot, world: WorldBible, product: ProductBible,
): Promise<GateResult> {
  const checks: Check[] = [];

  if (shot.fidelityTier !== 'T2') {
    // 1. Identity — embedding distance against the product bible
    const sim = cosine(await embed(frame), product.identityEmbedding);
    checks.push({ name: 'product_identity', pass: sim > 0.82, value: sim });

    // 2. Label legibility — OCR must contain the known strings
    const ocr = await readText(frame);
    const hit = product.labelText.filter(t => fuzzyContains(ocr, t)).length
              / Math.max(product.labelText.length, 1);
    checks.push({ name: 'label_legible', pass: hit >= 0.6, value: hit });

    // 3. Colour fidelity — ΔE against the product palette
    const de = deltaE(dominantColors(frame), product.palette);
    checks.push({ name: 'color_fidelity', pass: de < 12, value: de });
  }

  // 4. World continuity — palette drift vs the bible
  checks.push(paletteDrift(frame, world.palette));

  // 5. Artifacts — the one VLM call, with a fixed rubric
  checks.push(await vlmRubric(frame, ARTIFACT_RUBRIC));

  return { pass: checks.every(c => c.pass), checks };
}
```

Four of five checks are arithmetic. Only the artifact check needs a model, and it answers a closed rubric rather than "is this good?"

**Failure policy:** retry with a new seed and the failed check named in the prompt, up to 2×. Then downgrade the tier (T1→T0) rather than fail — a composited real product over a plain plate always beats no shot.

## A4.5 Motion synthesis

Only now does video money get spent. Route by what the shot needs:

| Shot condition | Mode | Why |
|---|---|---|
| Has first + last keyframe | `first_last_frame` | Maximum control; both ends are pre-approved |
| Single keyframe, simple move | `image_to_video` | Cheapest controllable option |
| Talent must persist from an earlier beat | `reference_to_video` | Identity conditioning |
| T0 hero shot | **no video model at all** | Remotion animates the cutout over a still plate |

`cameraMove.type` + `intensity` map to provider-specific motion prompt vocabulary **inside the adapter**. Camera grammar is domain language; each vendor's phrasing is an adapter detail.

---

# A5. WHY NOT CONVERSATIONAL AGENTS

The roles are real. The implementation shouldn't be a conversation.

| Persona framing | What to build instead |
|---|---|
| "Set designer agent" | One `artDirect()` call producing a typed `WorldBible` |
| "Cinematographer agent" | One `cinematograph()` call producing a typed `ShotList`, constrained by that bible |
| "Continuity supervisor agent" | A deterministic validator (A4.4). Four of five checks are maths. |
| "Agents negotiating" | A **narrowing chain**: each stage receives frozen upstream output as fact and may only add detail |

Three reasons:

1. **Drift.** Every LLM call is a chance to reinterpret. A schema that can't express a contradiction prevents more errors than an instruction not to contradict.
2. **Debuggability.** When beat 3 looks wrong you need to know which stage produced the bad field. A typed artifact per stage gives you that; a conversation transcript doesn't.
3. **Cost and latency.** Each round trip is money and seconds. Four narrowing calls beat twelve negotiating ones.

**Don't over-decompose in v1.** Merge art direction into the Director call first. Split it out only when you can point at outputs where a single call visibly failed to hold the world together — which will show up as props appearing and vanishing, or lighting flipping between beats.

---

# A6. WHAT THIS COSTS

Per 4-beat variant, rough:

| Stage | Calls | Unit | Subtotal |
|---|---|---|---|
| Art direction + cinematography | 2 | LLM | ~$0.05 |
| Keyframes (4–6, incl. last frames) | 6 | ~$0.04 | $0.24 |
| Gate retries @ ~40% | 2.4 | ~$0.04 | $0.10 |
| Gate checks (embed, OCR, ΔE, VLM) | 8 | ~$0.01 | $0.08 |
| Motion, 2–3 shots × 4s | 10s | ~$0.15/s | $1.50 |
| TTS + render | — | — | ~$0.15 |
| **Per variant** | | | **~$2.10** |
| **Per job (3 variants)** | | | **~$6.30** |

Two things fall out of this table:

**Motion is 70% of the cost.** Every T0 shot that Remotion animates instead of a video model is ~$0.60 saved. A 4-beat variant with two T0 shots costs half as much as one with none — which means the fidelity tier is a cost lever as much as a quality one.

**The gate pays for itself immediately.** $0.18 of checking prevents a $0.60 clip built on a bad keyframe. Gate before motion, always.

---

# A7. BUILD ORDER

Slot between Milestones 9 and 10 of the base spec.

| # | Milestone | Exit criteria |
|---|---|---|
| 9a | Product Bible: segmentation, palette, OCR, embeddings | Upload 3 photos → cutouts with alpha, `labelText` populated |
| 9b | T0 composite path | Generated background plate + real cutout composited in Remotion, indistinguishable from a shot photo |
| 9c | `WorldBible` + `ShotList` schemas and calls | Two products yield visibly different worlds; props persist across beats |
| 9d | Keyframe synthesis, T1/T2 | 4 keyframes per variant, one style |
| 9e | Continuity gate | Deliberately corrupt a keyframe; gate rejects it |
| 9f | Motion synthesis with routing | first_last_frame used where both keyframes exist |
| 9g | Tier router + cost telemetry | Cost per variant visible in `provider_calls`, split by tier |

**9b before everything else.** If a real cutout over a generated plate doesn't look right, the entire T0 tier collapses — and T0 is what protects brand fidelity on every hero shot. Prove it with one hand-assembled frame before building any of the machinery above it.
