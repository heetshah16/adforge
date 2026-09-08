# AdForge — Build Spec & Make Runbook

**One-line pitch:** A small seller uploads product photos or a store URL. AdForge classifies the product by *buying psychology*, then generates three structurally different 20-second vertical ad variants — three hypotheses to A/B test, not three rewordings.

**Built entirely in Make. No servers, no deployment, two scenarios.**

---

# PART 1 — THE CONCEPT

## 1.1 Who it's for

Small D2C sellers who spend on Meta/TikTok/Instagram ads but have no creative budget and no audience data. They can't afford a videographer, can't afford a UGC creator, and can't afford to burn ad spend testing one creative at a time. AdForge gives them three testable angles per product in under three minutes.

## 1.2 What makes it not-a-wrapper

Three things, in order of how much they matter to a judge:

1. **It classifies by buying psychology, not product category.** "Cooking oil" is a food product; the *correct* read is that premium cooking oil is bought as a health remedy under a trust objection. That reclassification is what determines the ad format, and it's a decision a naive system gets wrong.
2. **Variant diversity is a schema constraint, not a hope.** The three outputs are forced to use different hook archetypes and different formats. Without this rule you get three paraphrases and the feature is fake.
3. **The reasoning is visible.** Every run writes a one-line rationale and a per-variant "strategic bet" into the UI. The user sees *why*, not just *what*.

## 1.3 What we deliberately cut

| Cut | Reason |
|---|---|
| Remotion / AWS / any container | Deployment is not the demo. JSON2Video's native Make module does the render. |
| Seedance / premium video models | 60–120s per clip, $0.45–$1+ per clip, and a live failure mode mid-demo. |
| Auto-posting to TikTok/YouTube | TikTok's app audit takes 2–6 weeks; unaudited clients can only post private. Impossible on a hackathon timeline. Say "publishing is one connector away." |
| QC gate, retries, multi-tenancy | Post-hackathon concerns. |
| Copyrighted music | Not available through the pipeline, *and* Meta/TikTok reject uncleared audio in paid ads. Royalty-free is the correct answer and it's a sellable feature: "ad-safe audio by default." |

---

# PART 2 — SYSTEM ARCHITECTURE

```
┌─ Airtable form ──────────────────────────────────┐
│  images[] · product_url · vo_language · notes    │
└───────────────────────┬──────────────────────────┘
                        │ status = queued
                        ▼
┌─ SCENARIO 1: Strategist & Director ──────────────┐
│  1  Airtable  Watch Records                      │
│  2  Airtable  Update → processing                │
│  3  Router    URL present? ──▶ HTTP GET + parse  │
│  4  Claude    CALL 1 — Strategist                │
│  5  JSON      Parse                              │
│  6  Airtable  Update (archetype + rationale)     │
│  7  Claude    CALL 2 — Director                  │
│  8  JSON      Parse                              │
│  9  Iterator  over variants[3]                   │
│ 10  JSON2Video Create Movie  (×3, async)         │
│ 11  Airtable  Write job_id per variant           │
└───────────────────────┬──────────────────────────┘
                        │  scenario ENDS. no polling.
                        ▼
┌─ SCENARIO 2: Delivery (webhook) ─────────────────┐
│  1  Webhook   JSON2Video callback                │
│  2  Airtable  Search by job_id                   │
│  3  Airtable  Update → video_url, done++         │
│  4  Router    done == 3 ? ──▶ status = ready     │
│  5  Slack     "3 variants ready" + links         │
└──────────────────────────────────────────────────┘
```

**The critical design rule:** Scenario 1 never waits for a render. It fires three async jobs and exits. This sidesteps Make's 40-minute execution ceiling and the 300-second Sleep cap entirely, and it cuts credit burn by roughly 5x versus a polling loop.

## 2.1 Why two Claude calls, not one

A single call doing classification + creative writing + strict JSON schema compliance drifts on all three. Splitting them:

- **Strategist** does analysis only. Small output, high accuracy, cheap to retry.
- **Director** receives the Strategist's verdict as *given fact* and only does creative + schema work.

Cost: one extra Make credit and ~3 seconds. Benefit: roughly halves schema-violation rate. Take the trade.

---

# PART 3 — THE VOCABULARY

The model reasons freely *within a closed vocabulary*. Free-form output is unrenderable; fixed decision trees aren't intelligent. This is the middle path.

## Axis 1 — Industry archetype (buying psychology)

| Archetype | Buying driver | Typical products |
|---|---|---|
| `remedy` | Solves a felt pain | skincare, cleaning, pain relief, health foods |
| `upgrade` | Better version of something owned | gadgets, cookware, tools, luggage |
| `indulgence` | Sensory or emotional want | snacks, beverages, fragrance, dessert |
| `identity` | Signals who the buyer is | apparel, jewellery, sneakers, decor |
| `utility` | Rational time/money saving | services, SaaS, storage, stationery |
| `gifting` | Bought for someone else | hampers, toys, occasion items |
| `trust` | High-consideration, risk-reducing | baby products, health devices, kids' food |

Products get a **primary** and **secondary** archetype. The blend is where the intelligence shows.

## Axis 2 — Format (the 4-beat structure)

| Format | Beats | Fits archetypes |
|---|---|---|
| `problem_solution` | pain → agitate → reveal → relief | remedy, utility, trust |
| `ugc_testimonial` | to-camera hook → skepticism → try → verdict | remedy, trust, indulgence |
| `before_after` | state A → trigger → state B → proof | remedy, upgrade |
| `spec_flex` | claim → demo → comparison → price anchor | upgrade, utility |
| `sensory_tease` | extreme close-up → texture → reaction → want | indulgence |
| `styling_moment` | context → product enters → transformation → look | identity, gifting |
| `objection_kill` | state doubt → escalate → counter-proof → CTA | trust, utility |
| `listicle_3` | "3 reasons" → beat → beat → winner | any (fallback) |

## Axis 3 — Visual treatment (drives render config)

`clean_studio` · `lifestyle_context` · `macro_texture` · `hand_held_ugc` · `flat_lay` · `split_compare`

This field is what turns creative intent into render parameters. Mapping is deterministic, handled Make-side:

| Visual treatment | Caption position | Motion default | Background |
|---|---|---|---|
| `clean_studio` | bottom-center | slow_zoom_in | brand light |
| `lifestyle_context` | bottom-center + scrim | slow_pan | image full-bleed |
| `macro_texture` | bottom-center bold + scrim | slow_zoom_in | image full-bleed |
| `hand_held_ugc` | mid-lower, chunky | subtle_shake | image full-bleed |
| `flat_lay` | top-third | slow_zoom_out | image full-bleed |
| `split_compare` | top-third | static | brand dark |

---

# PART 4 — THE HOOK SYSTEM

A hook is a **first-1.5-second promise**, not a vibe. Encode it as a typology plus hard constraints.

## 4.1 Hook archetypes

| Archetype | Shape | Skeleton |
|---|---|---|
| `pattern_break` | Contradicts expectation | "Stop buying [obvious thing]." |
| `direct_call` | Names the viewer | "If you [trait], watch this." |
| `stat_shock` | Number that doesn't fit intuition | "[N]% of [X] contains [Y]." |
| `confession` | Admits something | "I was wrong about [category]." |
| `curiosity_gap` | Withholds the payoff | "Nobody checks what's inside [X]." |
| `demonstration` | Opens mid-action, no preamble | product already doing the thing |
| `objection_lead` | Voices the doubt first | "Yes, it's 3x the price. Here's why." |

## 4.2 Hard constraints (put these verbatim in the prompt)

- ≤ 9 words spoken; ≤ 28 characters as on-screen text
- Must land entirely inside beat 1 (0–3s)
- **Must NOT name the brand.** Brand names in the first second kill retention.
- Must NOT begin with: "Introducing", "Meet", "Are you tired of", "In this video", "Discover"
- Must be falsifiably specific: "3-day results" beats "amazing results"
- On-screen text and VO line must **differ** — text carries the claim, VO carries the emotion. Duplicating them wastes attention.

## 4.3 The variant diversity rule

This is the single most important line in the entire prompt stack:

> The three variants MUST use three different `hook_archetype` values AND at least two different `format` values.
> - **Variant 1** = highest-confidence format for this archetype pair (the safe bet)
> - **Variant 2** = a different format testing an opposing angle
> - **Variant 3** = highest-risk / highest-ceiling option
>
> Each variant must state its `strategic_bet` in one sentence: what it assumes about the buyer that the others don't.

---

# PART 5 — DATA SCHEMA (Airtable)

## Table: `Requests`

| Field | Type | Notes |
|---|---|---|
| `request_id` | Autonumber | |
| `submitted_at` | Created time | |
| `product_images` | Attachment | multiple; optional if URL given |
| `product_url` | URL | optional if images given |
| `vo_language` | Single select | `en` · `hi` · `hinglish` |
| `notes` | Long text | optional user context |
| `status` | Single select | `queued` → `processing` → `rendering` → `ready` → `failed` |
| `archetype_primary` | Single line | written by Strategist |
| `archetype_secondary` | Single line | written by Strategist |
| `rationale` | Long text | **show this on stage** |
| `core_objection` | Long text | |
| `director_json` | Long text | raw Call 2 output, for debugging |
| `variants_done` | Number | 0→3 counter |
| `error_note` | Long text | |

## Table: `Variants`

| Field | Type | Notes |
|---|---|---|
| `variant_key` | Single line | `{request_id}-{1|2|3}` — used to match webhook |
| `request` | Link → Requests | |
| `variant_no` | Number | 1–3 |
| `format` | Single line | |
| `hook_archetype` | Single line | |
| `visual_treatment` | Single line | |
| `strategic_bet` | Long text | **show this on stage** |
| `hook_text` | Single line | |
| `j2v_job_id` | Single line | returned by JSON2Video |
| `video_url` | URL | written by Scenario 2 |
| `status` | Single select | `rendering` → `ready` → `failed` |

## Form view

Expose only: `product_images`, `product_url`, `vo_language`, `notes`. Four fields, one optional. Ten seconds of typing on stage.

**Note on the category dropdown:** there isn't one. Asking the seller to classify their own product is both a worse product and a worse demo. The archetype is inferred. If you want a manual override for safety, add a `archetype_override` single-select populated from the Axis 1 list — but never touch it during the demo.

---

# PART 6 — PROMPT 1: THE STRATEGIST

**Model:** Claude · **Temperature:** 0.2 · **Max tokens:** 800

```
You are a direct-response strategist analysing a product for a small D2C
seller who will run paid social ads. Your only job is analysis. You do not
write ad copy.

You will receive some combination of: product images, scraped text from a
product page, and seller notes. Some inputs may be missing. Work with what
you have and do not ask questions.

## Step 1 — Identify the product
Extract the product name, a plain one-line description with no marketing
language, and a price signal (premium / mid / value) based on price relative
to the obvious alternative in its category.

## Step 2 — Classify by BUYING PSYCHOLOGY, not product category
This is the part that matters. Choose a primary and secondary archetype:

- remedy      : bought to solve a felt pain
- upgrade     : bought as a better version of something already owned
- indulgence  : bought for sensory or emotional pleasure
- identity    : bought to signal who the buyer is
- utility     : bought for rational time or money saving
- gifting     : bought for someone else
- trust       : high-consideration, bought after risk-reduction

The naive classification is usually wrong. A premium food product is often
`remedy` + `trust`, not `indulgence`. A sneaker is `identity`, not `upgrade`.
Ask: what pain or desire opens the wallet, not what shelf it sits on.

## Step 3 — Audience and objection
Describe the buyer in one line: who they are and the trigger moment when
they buy. Then state the single biggest doubt that stops the purchase.
Be specific and uncomfortable. "It's expensive" is lazy;
"₹450 for oil feels irrational when ₹150 works fine" is useful.

## Step 4 — Differentiators
List 1–3 concrete, checkable claims from the input (process, ingredient,
spec, guarantee). Never invent one. If the input supports none, return an
empty array — the Director will work around it.

## HARD RULES
- Never invent health, medical, or regulatory claims.
- Never invent a certification, award, or statistic not present in input.
- If input is thin, say so in `confidence` and still commit to a
  classification.

## OUTPUT
Return ONLY valid JSON. No prose, no markdown fences, no preamble.

{
  "product": {
    "name": "string",
    "one_liner": "string",
    "price_signal": "premium|mid|value",
    "price_note": "string"
  },
  "archetype_primary": "one of the seven",
  "archetype_secondary": "one of the seven",
  "audience": "string",
  "core_objection": "string",
  "differentiators": ["string"],
  "rationale": "ONE sentence explaining the archetype choice, written for
                the seller to read",
  "confidence": "high|medium|low"
}
```

## 6.1 Few-shot anchor — Product A

**Input:** Sattvik Wood-Pressed Groundnut Oil, 1 litre, ₹450. Cold-pressed below 45°C in a wooden ghani. Single-origin Saurashtra groundnuts. No hexane, no refining, no bleaching. Images: bottle on white, pour into a kadhai, raw groundnuts macro, kitchen shelf.

```json
{
  "product": {
    "name": "Sattvik Wood-Pressed Groundnut Oil",
    "one_liner": "One litre of unrefined groundnut oil pressed cold in a wooden ghani",
    "price_signal": "premium",
    "price_note": "₹450 against ₹150 for refined supermarket oil — roughly 3x"
  },
  "archetype_primary": "remedy",
  "archetype_secondary": "trust",
  "audience": "30–45 home cooks, usually the person who buys groceries for a family, who started reading labels after a health scare in the household",
  "core_objection": "Paying 3x for cooking oil feels irrational when the cheap bottle has worked for twenty years — the buyer needs a reason that isn't vague wellness talk",
  "differentiators": [
    "pressed below 45°C so the oil is never heat-damaged",
    "no hexane solvent extraction",
    "single-origin Saurashtra groundnuts"
  ],
  "rationale": "Despite sitting in the food aisle this is not an indulgence purchase — it is bought as a health remedy under heavy skepticism, so the ads must lead with the problem in the cheap alternative and close the trust gap with process, not taste.",
  "confidence": "high"
}
```

## 6.2 Few-shot anchor — Product B

**Input:** Terra Handmade Ceramic Mug Set of 2, ₹1,299. Wheel-thrown by artisans in Jaipur. Food-safe reactive glaze, no two identical. Microwave and dishwasher safe. Images: pair on wooden table, single mug held in hands, glaze macro, gift box.

```json
{
  "product": {
    "name": "Terra Handmade Ceramic Mug Set of 2",
    "one_liner": "Two wheel-thrown ceramic mugs with a reactive glaze, no two alike",
    "price_signal": "premium",
    "price_note": "₹1,299 for two against ₹300 for a factory pair — roughly 4x"
  },
  "archetype_primary": "identity",
  "archetype_secondary": "gifting",
  "audience": "25–38 urban buyers furnishing a first home or hunting for a housewarming gift that doesn't look bought at the last minute",
  "core_objection": "Handmade reads as fragile and high-maintenance — the buyer assumes it will chip, can't go in the dishwasher, and isn't worth 4x a mug that does the same job",
  "differentiators": [
    "wheel-thrown by Jaipur artisans, no two pieces identical",
    "food-safe reactive glaze",
    "microwave and dishwasher safe"
  ],
  "rationale": "Nobody needs a fourth mug — this is bought to signal taste and to be given as a gift, so the ads should sell the look and the story while quietly killing the fragility objection with the dishwasher fact.",
  "confidence": "high"
}
```

---

# PART 7 — PROMPT 2: THE DIRECTOR

**Model:** Claude · **Temperature:** 0.7 · **Max tokens:** 4000

```
You are a short-form video director creating three DIFFERENT 20-second
vertical ad variants for one product. You will receive a strategist brief.
Treat every field in it as established fact — do not re-analyse the product.

## AVAILABLE FORMATS (4 beats each)
problem_solution : pain → agitate → reveal → relief
ugc_testimonial  : to-camera hook → skepticism → try → verdict
before_after     : state A → trigger → state B → proof
spec_flex        : claim → demo → comparison → price anchor
sensory_tease    : extreme close-up → texture → reaction → want
styling_moment   : context → product enters → transformation → look
objection_kill   : state doubt → escalate → counter-proof → CTA
listicle_3       : "3 reasons" → beat → beat → winner

## AVAILABLE HOOK ARCHETYPES
pattern_break · direct_call · stat_shock · confession
curiosity_gap · demonstration · objection_lead

## AVAILABLE VISUAL TREATMENTS
clean_studio · lifestyle_context · macro_texture
hand_held_ugc · flat_lay · split_compare

## DIVERSITY RULE — NON-NEGOTIABLE
The three variants MUST use three DIFFERENT hook_archetype values and at
least TWO different format values.
  Variant 1 = safest, highest-confidence format for this archetype pair
  Variant 2 = different format, opposing angle
  Variant 3 = highest-risk / highest-ceiling
Each variant states a `strategic_bet`: one sentence on what it assumes about
the buyer that the other two do not.

## HOOK RULES
- ≤ 9 spoken words, ≤ 28 characters of on-screen text
- Entirely inside beat 1
- NEVER name the brand in the hook
- NEVER start with: Introducing / Meet / Are you tired of / In this video /
  Discover
- Falsifiably specific, not vague
- The on-screen text and the VO line must DIFFER: text carries the claim,
  VO carries the emotion

## TIMING
Total 20s across 4 beats. Beat 1 is 3–4s. Remaining beats 5–6s each.
VO pacing is 2.5 words per second — a 5s beat takes ~12 spoken words, hard
ceiling. Overlay text ≤ 28 characters per beat.

## IMAGES
You receive an image inventory with an index and description for each.
Assign `image_index` per beat.
- Never use the same image twice CONSECUTIVELY with the same motion.
- If there are fewer images than beats, reuse with different motion values.
- If no lifestyle or context imagery exists, set visual_treatment to
  `clean_studio` for that variant and build all beats from the product image
  using varied motion and background colour.
Motion values: slow_zoom_in · slow_zoom_out · slow_pan · subtle_shake · static

## LANGUAGE
Write VO in the requested language.
- en       : neutral English
- hi       : Devanagari script
- hinglish : LATIN SCRIPT ONLY, Hindi words spelled phonetically
             ("bilkul", never "बिल्कुल"). Code-switch naturally the way
             urban Indian ads actually speak.
On-screen overlay text stays in Latin script for ALL languages —
it is read at a glance, not sounded out.

## HARD RULES
- Never invent a claim absent from the brief's differentiators.
- No health, medical, or regulatory claims.
- No comparative claims naming a competitor brand.
- Every CTA must be an action, not a slogan.

## OUTPUT
Return ONLY valid JSON. No prose, no markdown fences.

{
  "variants": [
    {
      "variant_no": 1,
      "format": "string",
      "hook_archetype": "string",
      "visual_treatment": "string",
      "strategic_bet": "string",
      "hook_text": "string",
      "scenes": [
        {
          "beat": "string",
          "vo": "string",
          "overlay": "string",
          "image_index": 0,
          "duration": 4,
          "motion": "string"
        }
      ],
      "cta": "string",
      "caption": "string",
      "hashtags": ["string"]
    }
  ]
}
```

## 7.1 Worked output — Product A (use as few-shot anchor)

```json
{
  "variants": [
    {
      "variant_no": 1,
      "format": "problem_solution",
      "hook_archetype": "curiosity_gap",
      "visual_treatment": "macro_texture",
      "strategic_bet": "The buyer already suspects something is wrong with cheap oil but has never been told what — name the process and the doubt converts.",
      "hook_text": "Nobody tells you how oil is made.",
      "scenes": [
        {
          "beat": "pain",
          "vo": "Nobody tells you how your cooking oil is made.",
          "overlay": "How is your oil made?",
          "image_index": 2,
          "duration": 4,
          "motion": "slow_zoom_in"
        },
        {
          "beat": "agitate",
          "vo": "Most of it is pushed through chemical solvent, then bleached clear.",
          "overlay": "Solvent. Then bleached.",
          "image_index": 2,
          "duration": 5,
          "motion": "slow_pan"
        },
        {
          "beat": "reveal",
          "vo": "This one is pressed cold in a wooden ghani. Nothing else.",
          "overlay": "Cold-pressed. Under 45°C.",
          "image_index": 1,
          "duration": 6,
          "motion": "slow_zoom_out"
        },
        {
          "beat": "relief",
          "vo": "Same kitchen. One honest bottle.",
          "overlay": "Switch one bottle.",
          "image_index": 0,
          "duration": 5,
          "motion": "slow_zoom_in"
        }
      ],
      "cta": "Order one litre and taste the difference",
      "caption": "Most cooking oil never tells you what happened to it before the bottle.",
      "hashtags": ["#coldpressed", "#woodpressed", "#kitchenessentials", "#cleaneating"]
    },
    {
      "variant_no": 2,
      "format": "objection_kill",
      "hook_archetype": "objection_lead",
      "visual_treatment": "split_compare",
      "strategic_bet": "The price objection is the only real barrier — meeting it head-on in second one earns permission for the next fifteen.",
      "hook_text": "Yes, it costs three times more.",
      "scenes": [
        {
          "beat": "state doubt",
          "vo": "Yes. This costs three times your usual bottle.",
          "overlay": "3x the price. Really?",
          "image_index": 0,
          "duration": 4,
          "motion": "static"
        },
        {
          "beat": "escalate",
          "vo": "And you have cooked with the cheap one for twenty years.",
          "overlay": "20 years, no problem.",
          "image_index": 3,
          "duration": 5,
          "motion": "slow_pan"
        },
        {
          "beat": "counter-proof",
          "vo": "The cheap one is heated, solvent-washed and bleached. This one is only pressed.",
          "overlay": "One is pressed. One is processed.",
          "image_index": 1,
          "duration": 6,
          "motion": "slow_zoom_in"
        },
        {
          "beat": "cta",
          "vo": "Twelve rupees a day. Decide for yourself.",
          "overlay": "₹12 a day.",
          "image_index": 0,
          "duration": 5,
          "motion": "slow_zoom_out"
        }
      ],
      "cta": "Try one litre this month",
      "caption": "We are not going to pretend it is cheap. Here is what you get instead.",
      "hashtags": ["#woodpressedoil", "#honestfood", "#groundnutoil"]
    },
    {
      "variant_no": 3,
      "format": "sensory_tease",
      "hook_archetype": "demonstration",
      "visual_treatment": "macro_texture",
      "strategic_bet": "Health framing is crowded and distrusted — winning on sheer appetite appeal reaches buyers who tune out wellness language entirely.",
      "hook_text": "That colour is not an accident.",
      "scenes": [
        {
          "beat": "extreme close-up",
          "vo": "Look at that colour.",
          "overlay": "That colour.",
          "image_index": 1,
          "duration": 3,
          "motion": "slow_zoom_in"
        },
        {
          "beat": "texture",
          "vo": "Thick, golden, and it actually smells like groundnut.",
          "overlay": "It smells like groundnut.",
          "image_index": 2,
          "duration": 6,
          "motion": "slow_pan"
        },
        {
          "beat": "reaction",
          "vo": "Because nothing was stripped out of it.",
          "overlay": "Nothing stripped out.",
          "image_index": 1,
          "duration": 6,
          "motion": "slow_zoom_out"
        },
        {
          "beat": "want",
          "vo": "Your kitchen will smell different tonight.",
          "overlay": "Cook one meal with it.",
          "image_index": 3,
          "duration": 5,
          "motion": "slow_zoom_in"
        }
      ],
      "cta": "Cook one meal with it and tell us",
      "caption": "Refined oil is clear because everything interesting was removed.",
      "hashtags": ["#ghani", "#slowfood", "#indiankitchen", "#coldpressed"]
    }
  ]
}
```

Note how the diversity rule bites: three hook archetypes (`curiosity_gap`, `objection_lead`, `demonstration`), three formats, and three genuinely different bets — process education, price confrontation, and pure appetite. **Show this side-by-side on stage.**

## 7.2 Expected shape — Product B

For the mug set, the correct output moves away from `problem_solution` entirely:

- **V1** `styling_moment` + `curiosity_gap` — bet: bought for how a shelf looks, not how coffee tastes
- **V2** `objection_kill` + `objection_lead` — bet: "handmade means fragile" is the only real blocker; the dishwasher fact kills it
- **V3** `sensory_tease` + `demonstration` on glaze macro — bet: the no-two-alike texture sells itself without argument

That the same system produces a completely different format mix for A and B **is the demo.**

---

# PART 8 — RENDER TEMPLATE (JSON2Video)

> **Verify field names against current JSON2Video docs before building.** The shape below is correct in structure; exact key spellings occasionally change between API versions, and the Make module surfaces most of these as form fields anyway.

## 8.1 Movie JSON skeleton

```json
{
  "resolution": "custom",
  "width": 1080,
  "height": 1920,
  "quality": "high",
  "scenes": [
    {
      "duration": 4,
      "elements": [
        {
          "type": "image",
          "src": "{{image_url}}",
          "duration": 4,
          "zoom": 2,
          "position": "center-center"
        },
        {
          "type": "text",
          "text": "{{overlay}}",
          "position": "{{caption_position}}",
          "settings": {
            "font-family": "Poppins",
            "font-size": "68px",
            "font-weight": "800",
            "color": "#FFFFFF",
            "text-shadow": "0 4px 24px rgba(0,0,0,0.85)",
            "text-align": "center"
          }
        },
        {
          "type": "voice",
          "text": "{{vo}}",
          "voice": "{{voice_id}}"
        }
      ]
    }
  ],
  "elements": [
    {
      "type": "audio",
      "src": "{{music_url}}",
      "volume": 0.12
    },
    {
      "type": "subtitles",
      "settings": {
        "style": "boxed-word",
        "font-family": "Poppins",
        "font-size": 64,
        "word-color": "#FFE600",
        "line-color": "#FFFFFF",
        "outline-width": 6,
        "position": "{{caption_position}}",
        "max-words-per-line": 3
      }
    }
  ]
}
```

## 8.2 Deterministic mappings (build these as Make `Set variable` lookups)

**`visual_treatment` → `caption_position`**

| Treatment | Position |
|---|---|
| `clean_studio` | `bottom-center` |
| `lifestyle_context` | `bottom-center` |
| `macro_texture` | `bottom-center` |
| `hand_held_ugc` | `center-bottom` |
| `flat_lay` | `top-center` |
| `split_compare` | `top-center` |

**`motion` → `zoom`**

| Motion | Zoom value |
|---|---|
| `slow_zoom_in` | `2` |
| `slow_zoom_out` | `-2` |
| `slow_pan` | `1` (with pan setting) |
| `subtle_shake` | `1` |
| `static` | `0` |

**`vo_language` → voice ID**

| Language | Voice choice |
|---|---|
| `en` | any neutral English voice |
| `hi` | **must be an Indian-accent Hindi voice** |
| `hinglish` | same Indian-accent voice as `hi` |

**Test the Hinglish voice before you commit.** It's five minutes of work and it's the single riskiest unknown in the build. If it sounds wrong, swap that one branch to an ElevenLabs module and leave the rest on native TTS.

## 8.3 On built-in TTS vs ElevenLabs

JSON2Video has TTS built in via the `voice` element. Using it **deletes an iterator, three TTS calls, three uploads and an aggregator** from Scenario 1 — a big module and credit saving.

Default to built-in. Only fall back to ElevenLabs for `hi`/`hinglish`, and only if the built-in Indian voices disappoint in your five-minute test.

## 8.4 Subtitles

Set `subtitles` at the movie level so JSON2Video auto-transcribes the generated VO. Burned-in word-by-word captions are the single biggest "this looks professional" signal in short-form. Don't skip this.

---

# PART 9 — THE MAKE BUILD

## 9.1 Prerequisites checklist

- [ ] Make account (Free plan is sufficient — but note it caps you at **2 active scenarios**, which is exactly our budget, so zero headroom)
- [ ] Airtable base with both tables + form view
- [ ] Anthropic API key (Make's Claude module uses your own key)
- [ ] JSON2Video account + API key
- [ ] Slack workspace or a Gmail address for delivery
- [ ] 4 product images per demo product, in a public-URL-accessible place

## 9.2 SCENARIO 1 — "Strategist & Director"

### Module 1 — Airtable › Watch Records
- Table: `Requests`
- Trigger field: `submitted_at`
- Formula filter: `status = "queued"`
- Limit: 1

### Module 2 — Airtable › Update a Record
- `status` → `processing`

Do this immediately. It prevents a double-fire creating duplicate renders — a real risk when you're re-running scenarios repeatedly during testing.

### Module 3 — Router: input path

**Route A** — filter: `product_url` is not empty
- **3a. HTTP › Make a request** — GET the URL
- **3b. Text parser › HTML to text** — strip markup, cap at ~4000 characters

**Route B** — filter: `product_url` is empty
- Pass through with images only

Both routes converge on Module 4.

> A Router here isn't padding — it handles a genuinely branching input contract, and if Make is a hackathon sponsor, visible use of Make-native constructs (Router, Iterator, Aggregator, error handlers) reads well to judges.

### Module 4 — Anthropic Claude › Create a Message *(CALL 1: STRATEGIST)*
- System prompt: **Part 6**, with both few-shot anchors appended
- Temperature: `0.2`, Max tokens: `800`
- User message: scraped text + seller notes + image URLs (Claude reads images directly — pass them as image content blocks where the module allows, otherwise pass the URLs and let it work from filenames plus scraped text)

### Module 5 — JSON › Parse JSON
Attach an **error handler** here: on failure → `Resume` with a hardcoded fallback brief. During a live demo you never want a parse error to kill the run.

### Module 6 — Airtable › Update a Record
Write `archetype_primary`, `archetype_secondary`, `rationale`, `core_objection`.

**This is your stage moment.** The rationale appears in Airtable within ~8 seconds of submission, well before any video exists. Read it aloud while the renders run.

### Module 7 — Anthropic Claude › Create a Message *(CALL 2: DIRECTOR)*
- System prompt: **Part 7**, with the Product A worked output as few-shot
- Temperature: `0.7`, Max tokens: `4000`
- User message: the Strategist JSON verbatim + image inventory (`index: description`) + `vo_language`

### Module 8 — JSON › Parse JSON
Same error handler pattern.

### Module 9 — Flow Control › Iterator
- Array: `variants`
- Produces 3 bundles

### Module 10 — Tools › Set multiple variables
Compute per variant:
- `caption_position` ← lookup from `visual_treatment` (§8.2)
- `voice_id` ← lookup from `vo_language`
- `variant_key` ← `{{request_id}}-{{variant_no}}`

### Module 11 — Airtable › Create a Record (`Variants`)
Write `variant_key`, link to request, `format`, `hook_archetype`, `visual_treatment`, `strategic_bet`, `hook_text`, `status = rendering`.

### Module 12 — JSON2Video › Create a Movie
- Build the movie JSON per §8.1, mapping each scene
- **Set the webhook callback URL** to Scenario 2's webhook
- Pass `variant_key` in the callback payload / metadata field so Scenario 2 can match it back
- The module returns a job ID — you can store it, but `variant_key` is the reliable join key

### Module 13 — Airtable › Update a Record
- `Requests.status` → `rendering`

**Scenario 1 ends here.** Total runtime ~15–20 seconds. No waiting, no Sleep, no polling.

## 9.3 SCENARIO 2 — "Delivery"

### Module 1 — Webhooks › Custom webhook
Copy this URL into Module 12 of Scenario 1. Run it once to capture the data structure before wiring the rest.

### Module 2 — Airtable › Search Records (`Variants`)
- Formula: `{variant_key} = "{{webhook.variant_key}}"`

### Module 3 — Airtable › Update a Record
- `video_url` ← rendered URL
- `status` → `ready`

### Module 4 — Airtable › Update a Record (`Requests`)
- `variants_done` ← `{{variants_done}} + 1`

### Module 5 — Router
- **Route A** filter: `variants_done = 3` → Module 6
- **Route B**: end quietly

### Module 6 — Slack › Create a Message
> 🎬 *{{product_name}}* — 3 variants ready
> Read: *{{rationale}}*
> 1. {{format}} · {{hook_archetype}} — {{url}}
> 2. …
> 3. …

## 9.4 Credit budget

| Stage | Credits |
|---|---|
| Scenario 1, pre-iterator | ~9 |
| Scenario 1, iterator × 3 | ~12 |
| Scenario 2 × 3 callbacks | ~12 |
| **Per submission** | **~33** |

Free plan (1,000 credits/month) ≈ **28 full runs**. Comfortable for a hackathon including testing.

---

# PART 10 — FAILURE MODES

| Failure | Mitigation |
|---|---|
| Claude returns non-JSON | Error handler on Parse JSON → `Resume` with hardcoded fallback brief |
| URL scrape returns nothing | Router falls to image-only path; Strategist works from images alone |
| Fewer images than beats | Director instructed to reuse with varied motion |
| No lifestyle imagery | Director forces `clean_studio`, builds from product shot only |
| Render fails on one variant | Other two still deliver; `variants_done` never hits 3 → add a `Requests` view filtered on `status = rendering` older than 5 min |
| Double-fire on trigger | `status → processing` as Module 2, before anything expensive |
| Hinglish voice sounds wrong | Test before the demo; swap that branch to ElevenLabs |
| **Live demo stalls** | **Pre-render one full run the night before. Keep it open in a tab.** |

---

# PART 11 — DEMO SCRIPT (3 minutes)

**0:00–0:25 — Problem.** A small seller spends ₹20k/month on Meta ads with one creative. No audience data, no idea which angle works. An agency charges ₹15k per video and takes a week.

**0:25–0:45 — Submit live.** Airtable form. Upload three photos of the oil, pick `hinglish`, submit. *Do not wait in silence.*

**0:45–1:30 — Talk over the render.** Switch to the Airtable record. The rationale is already there. Read it aloud:

> *"Despite sitting in the food aisle this is not an indulgence purchase — it is bought as a health remedy under heavy skepticism."*

Then: "It didn't classify this as food. It classified it by what opens the wallet." Show the seven archetypes.

**1:30–2:15 — Variants land.** Slack notification. Play variant 1 and variant 2 back to back — one leads with process education, one opens by admitting the price. Show the `strategic_bet` fields. "These aren't three takes. They're three hypotheses you can A/B for ₹500 each."

**2:15–2:45 — The mug.** Cut to your pre-baked Product B run. Completely different format mix — `styling_moment`, not `problem_solution`. "Same system, different psychology, different structure."

**2:45–3:00 — Close.** "Two Make scenarios, no servers, ~₹30 of API spend per product. Publishing connectors are one module away."

---

# PART 12 — BUILD ORDER (time-boxed)

| # | Task | Box | Blocks |
|---|---|---|---|
| 1 | Airtable base + both tables + form view | 45m | everything |
| 2 | JSON2Video: render ONE hardcoded movie by hand | 45m | proves the render path |
| 3 | Test Hinglish voice, pick voice IDs | 15m | — |
| 4 | Scenario 1 up to Module 6 (Strategist only) | 60m | — |
| 5 | Director prompt + parse, log to Airtable, no render | 60m | — |
| 6 | Iterator + JSON2Video wiring | 60m | — |
| 7 | Scenario 2 webhook + Slack | 45m | — |
| 8 | **Pre-bake demo runs for A and B** | 30m | insurance |
| 9 | Error handlers + fallbacks | 30m | — |
| 10 | Rehearse the 3 minutes twice | 30m | — |

**Total: ~7 hours.** Steps 1–2 are the true dependencies — if the render path doesn't work by hour 2, cut scope to two variants instead of three rather than dropping the classification layer. The classification layer *is* the project.

---

# APPENDIX — QUICK REFERENCE

**Archetypes:** remedy · upgrade · indulgence · identity · utility · gifting · trust

**Formats:** problem_solution · ugc_testimonial · before_after · spec_flex · sensory_tease · styling_moment · objection_kill · listicle_3

**Hooks:** pattern_break · direct_call · stat_shock · confession · curiosity_gap · demonstration · objection_lead

**Treatments:** clean_studio · lifestyle_context · macro_texture · hand_held_ugc · flat_lay · split_compare

**Motion:** slow_zoom_in · slow_zoom_out · slow_pan · subtle_shake · static

**Timing:** 20s total · beat 1 = 3–4s · beats 2–4 = 5–6s · VO 2.5 words/sec · overlay ≤ 28 chars · hook ≤ 9 words

**Statuses:** queued → processing → rendering → ready → failed
