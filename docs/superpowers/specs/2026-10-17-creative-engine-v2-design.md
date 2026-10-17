# AdForge Creative Engine v2: design (local-first)

**Status:** design, awaiting approval · 2026-10-17
**Builds on:**
- `docs/architecture.md`, which wins on conflict;
- §7 tiers and §13 Phase 3 (Product Bible, T0 composite, WorldBible/ShotList, continuity gate);
- Addendum A (shot synthesis) and Addendum B (2.5D motion);
- the research list `docs/research/2026-10-17-creative-upgrade.md`.

**Evidence base:**
- HyperFrames skills: product-launch-video, embedded-captions, audio, media-use.
- Higgsfield skills: Marketing Studio, product-photoshoot, video-explainer.
- Higgsfield's open ONEIRIC production brief. Notes: `scratchpad/oneiric-brief.txt`; source: higgsfield.ai/original-series/oneiric/full-film.

---

## 1. Intent and why

The POC proves the pipeline end to end, but the ads read as basic. Each beat is one AI plate, a Ken Burns move, one static line of text and boxed captions, joined by hard cuts, with no music or SFX. The product cutout looks **pasted on**: it was photographed at one angle and in one light, and the plate was "shot" at another. Moving the pair together can't fix that.

The user wants three things:

1. **Industry craft.** The ads use the practices real ad shops and AI film studios use: arcs, cue-paced reveals, shot templates, transitions, readable captions, music and SFX, one coherent grade.
2. **An understanding of images, and asset population.** The system understands the photos it's given and the plates it makes, and can **generate the product at a different angle** to sit naturally in a scene, instead of sliding or rotating one flat photo. **One photo is the minimum.** More photos enrich a per-product asset library that grows with every job.
3. **Malleability, with minimal regeneration.** After AdForge makes the ads, the user can change shot composition and do post-production work: move and resize things, retime, swap a background, ask for a new angle. Only what actually changed is regenerated, because **generation is the expensive part.**

**Resource stance:** everything runs on the local GPU first, scaled as far as the RTX 5070 Ti (16 GB) and 31.8 GB of RAM allow. Cloud providers come later, behind the existing provider interfaces, with no redesign.

## 2. Goals, non-goals, anti-goals

**Goals:**
- A product's look is consistent across every shot, and the product sits *in* the scene: matched angle, light, shadow and grade.
- A new product view from one photo, without AI redrawing the label.
- Every on-screen element is a named, positioned, timed layer that can be edited without regenerating anything else.
- Editing a layout, text, timing or style regenerates **zero** assets. Changing a shot's content regenerates **only that shot's assets**. Changing a voice line regenerates **only that line**, and the timeline re-flows.
- The user previews edits instantly in the browser, and an MP4 is produced only on export.
- The Director's output carries story structure (arc, roles, cues, persuasion, delivery), and the craft lives in **registry data** wherever possible, so it grows without code.
- A quality gate catches broken shots before the user sees them.

**Non-goals for this design:**
- Cloud providers.
- Distribution.
- Attribution / Phase 5.
- Talking presenters or avatars.
- Multi-user collaboration.
- Full 3D scene authoring.

**Anti-goals** (failure even if it technically works):
- A product drawn by a model *inside a shot* (architecture §7, CLAUDE.md). Hero shots composite either real photos or pre-generated, gated, approved library views, always by mask.
- An editor where every small change triggers a full regeneration or a multi-minute wait.
- A "malleable" system that's really free-text prompts. Edits must be structured, so they're reproducible and cacheable.
- Gaining craft by making the ads look templated: three variants looking alike defeats the product's core claim (`assertVariantDiversity`).
- GPU work that hangs, leaks VRAM or leaves processes behind. The user's standing rule is to free resources and never hang.

## 3. Constraints

- **CLAUDE.md, in full.** Provider SDK types stay in `packages/providers/*`, plus:
  - Zod validation before dispatch;
  - `MediaRef` / storage keys only;
  - all timing in frames;
  - layers reference asset keys;
  - no synchronous render path;
  - `fidelityTier` is computed in code;
  - no temperature/top_p/top_k;
  - exact pins at least 14 days old;
  - docs first, then a golden file and a recorded live response for every provider;
  - the registry rules (slugs never renamed, and `variants` stores slugs).
- **Hardware:**
  - one 16 GB GPU, shared serially by all GPU services through the heavy lane (concurrency 1);
  - every model must load, run and **unload**, with VRAM back to baseline (P6 liveness pattern: GPU lock, idle janitor, watchdog);
  - RAM peaks must leave headroom, because ComfyUI pins about 13 GB.
- **Licenses:**
  - Anything that ships in generated ads must permit commercial use.
  - Non-commercial models (for example CC-BY-NC) may be used only in spikes, and are marked **POC-only** like the subscription LLM.
  - Verify every license from the official repo before adoption, and record it in `docs/providers/<name>.md`.
- **Determinism (HyperFrames contract):**
  - no wall clock, no unseeded randomness, no network at render time;
  - entrances use `fromTo`;
  - no CSS animation, no infinite loops.
- **Partial success stays first-class:** 2 of 3 variants is a success with a warning.

## 4. The design

### 4.1 The asset library: assets first

**Principle (ONEIRIC):**
- Not one shot is generated until every element is named, versioned and locked.
- **An asset is a pair: a text descriptor plus an image.** The descriptor goes into every prompt word for word, and the image is the anchor.

**Scope:** per product, with **brand-level** shared assets (brand kit, voice bible, settings) and **job-level** assets.

**Tag convention** (one element, one name, never overwritten):

| kind | tag | example |
|---|---|---|
| product view | `@prod_<product>_<view>_v<n>` | `@prod_krishnahing_ras_front_v1` |
| location | `@loc_<brand>_<name>` | `@loc_krishna_kitchen_tawa_morning` |
| prop | `@prop_<name>` | `@prop_steel_kadai` |
| brand kit | `@brand_<brand>` | `@brand_krishna` |
| voice | `@voice_<brand>_<lang>` | `@voice_krishna_en` |

A changed state is a new version, a new tag and a new row. Old versions stay resolvable forever, like registry slugs, so old jobs remain interpretable.

**Product entry.** It extends the architecture's Product Bible (Phase 3, #13):
- **anchor:** the user's best photo plus its cutout. The anchor's pixels never pass through a generative model again (ONEIRIC: "the original close-up portrait is preserved untouched").
- **descriptor:** a locked text block: shape, material, colours, cap, label layout, size cues. It's written once by the analysis step (§4.2), editable by the user, and versioned.
- **views:** zero or more `ProductView` entries. Each has a viewpoint (azimuth, elevation, roughly), an origin (`user_photo` or `generated`), a cutout, and a **label-gate** result (§4.3). User photos are trusted views.
- **label:** the label text (OCR) and label regions on the anchor.

**Brand kit:**
- logo, palette, fonts and tone;
- extracted once from the brand site or uploaded, and editable;
- feeds `VideoSpec.theme`, the end card and the prompt compiler.

**Voice bible.** One locked voice block per brand and language, pasted verbatim into every TTS request (ONEIRIC "AUDIO LOCK"):
- for Qwen: speaker, base instruct and register;
- for Chatterbox: params.

**Settings library [R].** Reusable environments per category, for example "Indian kitchen, tadka in a steel kadai, morning light", with descriptor, lens/grade suffix, and an example plate when one exists.

**Storage:**
- binary assets stay content-addressed (`LocalDiskStorage`);
- the library is new DB tables keyed by tag and version (exact schema left to the builder);
- the tag convention and never-overwrite rule are fixed.

### 4.2 Understanding images

Two analyses, both cached and stored as structured, Zod-validated data:

**Product analysis** (once per uploaded photo):
- shape class (bottle, jar, pouch, box, tube…), viewpoint estimate, light direction, dominant colours;
- label regions and OCR text, material/finish, and whether the back or sides are visible;
- output feeds the descriptor, the brand palette fallback, and view selection.

**Plate analysis** (once per generated plate):
- camera height and tilt, plus horizon line;
- **the support surface** where the product can stand (region and plane);
- light direction and colour temperature, plus the **luma map** (drives caption choice, §4.7);
- free zones for text, and a depth map.

**Engines:**
- **vision LLM:** semantic fields. The Claude Agent SDK, the existing LLM provider (subscription, POC-only), returns structured output via Zod.
- **local models:** geometry fields:
  - depth: Depth-Anything-V2 **Small** (Apache-2.0; the Large weights are non-commercial);
  - segmentation: the existing BiRefNet;
  - OCR: a local engine chosen in a spike.
- All of these are providers behind the existing interfaces, so a cloud swap later changes nothing above them.

### 4.3 Asset population: new views that sit in the scene

**Goal:** the product appears at the angle and in the light the shot needs. Two strategies, chosen per shot by code:

**A. Match the plate to the product (the default, cheapest, safest).**
- Pick the closest existing view (anchor or a passed view) to the shot's intended camera.
- Generate the plate **to that view's camera**: the compiler writes the view's camera height, tilt and light direction into the plate prompt, and conditions on a layout guide (§4.5).
- The real cutout sits on the analysed support surface.
- This is the T0 path with the angle fixed at the source.

**B. Match the product to the shot (new view).** Used when the shot needs an angle no view covers (top-down hero, low angle, three-quarter turn).
- Generate the view from the anchor with a **local image-edit model with camera-angle control**. Primary candidate: Qwen-Image-Edit-2511 plus the fal Multiple-Angles LoRA, both reportedly Apache-2.0 with a ComfyUI workflow. VRAM fit on 16 GB (fp8/GGUF) and quality are decided by the spike.
- Fallback candidates: image-to-3D (TRELLIS-family, Hunyuan3D-family), only after license verification.
- **The label gate.** A generated view is accepted only if it passes:
  1. OCR text on the view matches the anchor's label text, above a threshold;
  2. an identity-embedding similarity to the anchor clears its threshold;
  3. colour histogram distance is within bounds.
- **On failure**, retry with a new seed (the failed check is named in the prompt) up to 2×. Then **downgrade**: use strategy A with the nearest real view (Addendum A failure policy). A real product on a matched plate always beats no shot.
- **When the new viewpoint is close enough to an existing one** (threshold left to the builder), the label region is **re-composited from real anchor pixels** with a perspective warp, so generated label text never reaches the screen on a hero shot.
- A passed view enters the library as `@prod_<product>_<view>_v1` and is reused by every later job. That's how one photo grows into a library.

**Blending, for both strategies:**
- a **contact shadow** from the cutout mask and the plate's light direction;
- **colour and white-balance match** of the cutout to the plate;
- a light wrap at the edges;
- the **same LUT** over plate and product (§4.7).
- **Relighting** the product to the plate's light is a later spike, and only if a local model with a commercial license fits.

**Hero shots may use generated angles, made beforehand as assets** (user decision, 2026-10-17):
- **New views are generated in pre-production, as library assets**, never inside a shot. The shot then **composites** the view's cutout over the plate with masks: matte, contact shadow, colour match.
- No plate, b-roll or video model ever renders the product in-shot. That keeps the architecture's core rule ("never let a video model render the hero product") while widening what counts as a real asset.
- A generated view is **hero-eligible** only once it has passed the label gate *and* been approved once in the library (my call; see §6).
- Where the viewpoint allows, the label region is still re-composited from real anchor pixels.

**Fidelity tiers stay computed in code:**
- `hero` → T0: a real-photo view, or a **hero-eligible library view**, composited by mask;
- `supporting` → T1: any gated library view;
- `absent` → T2.

This amends architecture §7's T0 definition ("real cutout") and needs an ADR in C5.

### 4.4 The Director v2: story structure

The Director's per-scene output gains structured fields. These are **semantic (registry-backed or free text)** unless marked [E], which means a closed enum in `packages/core`, because every value needs renderer code.

| field | kind | purpose |
|---|---|---|
| `role` | enum (stable, small) | hook, pain_point, product_intro, feature_showcase, benefit_highlight, social_proof, cta |
| `vo_cues[]` | text | the line split at phrase boundaries; each cue triggers one reveal |
| `persuasion` | text, from a suggested list | a concrete move ("risk reversal", never "show benefit") |
| `emotion_label` | text | a named feeling, alongside the numeric `emotion` |
| `acting_task` | text | delivery as a task ("convince a skeptical aunt it's worth the price"), not an adjective; feeds Qwen's instruct |
| `blueprint` | **[E]** | shot template (§4.7) |
| `transition_in` | **[E]** | cut, crossfade, blur_crossfade, push_slide, zoom_through |
| `sfx[]` | names from the SFX pack | cues |
| `shots[]` | structured | 1–3 shots per beat (§4.5) |

**Per variant:** an `arc` (PAS, BAB, Future-Pacing, Demo-Loop, Feature-Benefit-Cascade), stored on **format registry entries [R]**, and a `music_mood`.

**Script bank [R].** Every `hook_archetype` and `format` registry entry gains a `script_pattern` plus 2–3 example lines. They are rendered into the Director's system prompt in slug order, byte-frozen and cacheable. Verify `cache_read_input_tokens` and the Sonnet/Opus minimums.

**Script stress test.** Before any GPU work, an LLM critic pass checks each variant against an ad engine:
- the hook creates tension in the first 3 s;
- the promise lands by beat 2;
- each beat has one job;
- proof follows the claim;
- the CTA is concrete;
- copy says what it wants, not what it avoids.

It returns per-element verdicts and the weakest point, and the Director gets **one** repair pass naming the weakness (same pattern as the diversity repair). It's cheap: LLM only.

**Positive phrasing everywhere.** The prompt compiler and the Director prompt never name what to avoid ("no flares" summons flares).

### 4.5 Shots, layouts and the prompt compiler

**`Shot`** follows Addendum A §A4.2 (`shotSize`, camera, `matchesShot`):
- product placement: view tag, anchor point and scale on the support surface;
- `layout` (below);
- `plate_recipe`: setting tag, lens and grade suffix;
- an optional b-roll intent (M2).

**The layout map** is the "staging diagram" adapted for ads. It holds normalized boxes per shot for:
- the product zone;
- text zones: headline, stat, chips, badge, CTA;
- the caption band (bottom about 17%).

The layout map serves three purposes:
1. It is what the user drags in the editor.
2. It conditions plate generation: a rough layout and depth guide built from the product view's silhouette and support plane goes to the image model, so the surface lands where the product will sit. The method (img2img guide, ControlNet or depth conditioning) is decided by spike.
3. It feeds the safe-zone validator (§4.7).

**The prompt compiler** is deterministic code with no LLM, the CINEDANCE equivalent:
- Every generation prompt (plate, view, b-roll) is assembled from structured fields in **fixed blocks, in fixed order**: context, active references (descriptors verbatim), location map/support surface, camera, lighting, style/lens/grade, positive locks.
- **Every prompt is an island**: it never says "same as before".
- **Malleability comes from here:** an edit changes a field, the compiler re-emits the prompt, and only the assets whose compiled inputs changed are regenerated (§4.6).
- The Director never writes raw image prompts.
- Camera, lens and light vocabulary comes from a registry-backed "look" table: plate recipes from the product-photoshoot modes (product_shot, lifestyle_scene, conceptual splash, ingredient story, flat lay).

### 4.6 The editable project and minimal regeneration

**The composition is the editable document. The MP4 is an export.**

**`VideoSpec` v2** stays the IR, frames only, and gains:
- **element layers:** headline, stat, chip, badge, cta_button, logo, product (by view tag), plate, b-roll, captions. Each has a stable layer id, a box and a z-order.
- **per-element `revealFrame`**, cue-bound by default;
- **`transition_in` per scene**;
- **audio tracks:** voice per beat, music bed, SFX cues, with carve/duck settings.

**Recipes and the dependency graph:**
- Every generated asset has a **recipe**: the compiled provider request plus model id and version plus seed.
- Its cache key is a hash of the recipe. The same recipe means a cache hit, which means no GPU work. It extends the existing idempotency-key pattern.
- The project keeps a graph: plate ← plate recipe ← (setting, view camera, layout guide, look); view ← (anchor, viewpoint); voice line ← (text, voice bible, acting task); captions ← (voice audio, alignment)…

**Edit classes:**

| class | examples | regenerates |
|---|---|---|
| layout / style | move, resize, z-order, font weight, caption style, LUT, transition, blueprint params | **nothing**, preview only |
| text | headline, overlay, CTA copy | nothing (captions follow the VO, not the overlay) |
| timing | retime a reveal, trim a beat | nothing |
| voice line | edit a VO line, change acting task | that line's TTS plus alignment, then the timeline re-flows deterministically |
| shot content | new setting, new camera, new product angle | only that shot's plate and/or view, through the recipe |
| structural | add or remove a beat, change format | the Director for that variant, then the graph decides what's reusable |

**The edit log:**
- edits are recorded as structured operations (`move(layerId, box)`, `setField(shotId, path, value)`, `regenerate(assetTag)`…);
- they're replayable and undoable;
- they're stored per variant, which also gives a later attribution phase "what humans changed".

**Live preview:**
- the review UI plays the HyperFrames composition **in the browser** from cached assets, so edits show instantly;
- export renders the MP4 through Inngest, as today, because there's no synchronous render path;
- assets on the preview path are resolved through the worker's storage URL;
- the preview must match the MP4 frame-for-frame, under the same seek-safe determinism.

**Production stages:**
- **assembly** → **rough** (retime, reorder) → **supervision** (regenerate only flagged shots, QA §4.9) → **fine** → **lock**.
- After lock, generation is disabled for that variant. Only an explicit "unlock" re-enables it.
- At export, one **colour-unification** pass brings shots to one look.

**Two ways to edit, one operation set:**
1. **Direct:** drag and resize on a canvas, a timeline for timing, a layer panel, and a per-shot "regenerate with…" form on the shot's fields.
2. **In words:** "make the bottle bigger, move the price to the top". An LLM translates the words into the **same structured operations**, shows them, and applies them. It never writes prompts or HTML directly.

### 4.7 Renderer craft (closed enums, each value is a PR)

**Blueprints**, the starting six:

| blueprint | signature move |
|---|---|
| `kinetic_hook` | word-swap / beat-slam |
| `product_hero_reveal` | long-tail settle plus glow bloom, then hold |
| `stat_countup` | value-scaled counter |
| `benefit_stack` | one chip per cue |
| `split_compare` | opposed tilted cards |
| `endcard_lockup` | logo + price badge + CTA press |

Each is a time-coded template with slots, instantiated from the Director's fields and the layout map.

**Motion doctrine:**
- `power3` long-tail easing, with no bounce or elastic by default;
- reveals in the back half, on cues;
- holds instead of breathing, and no slow back-half pan;
- subtle jitter is the only allowed aliveness;
- velocity-matched cuts inside a beat;
- 2.5D parallax (Addendum B / architecture M1, with inpaint once per keyframe) behind its existing spike gate.

**Transitions:** the five in §4.4.

**Captions:**
- the style is **computed in code from plate luma under the caption band** (`ink` for bright, `cream`/`documentary` for dark/warm, `loud` for UGC, `anchor` as default), not chosen by the model;
- keyword emphasis on the hook or price word as it's spoken;
- Devanagari and Gujarati display fonts, resolved before render.

**Safe zones:**
- `VideoSpec` validation rejects product/text/caption-band overlaps, so a bad layout fails in tests, not on screen;
- a user's drag beyond a zone gets a warning, not a block (user intent wins, recorded in the edit log).

**Grade:** one LUT per treatment over plate and product, from the HyperFrames LUT catalog plus our own "warm kitchen".

### 4.8 Audio

- **Voice:**
  - English uses Qwen (decided, ADR 0013), with per-beat `instruct` from `acting_task` plus the voice bible;
  - hi/hinglish stay on Chatterbox;
  - an **Indic emotion spike**: svara-TTS, which covers Hindi and Gujarati, gated on license verification. Rumik-OSS-1 is POC-only because it's CC-BY-NC.
- **SFX:** the 21-file Pixabay pack bundled with HyperFrames (commercial use, no attribution), cued by the Director's `sfx[]`, at volume about 0.35.
- **Music:**
  - ACE-Step 1.5, local; verify the MIT license and the VRAM with a spike. One bed per variant from `music_mood`, cached by recipe.
  - Skip a quiet opening build: trim to the strongest section.
  - Fallback: the same SFX-style curated library approach for beds.
- **Mix:** carve the music under the voice group (never against SFX), and do a final loudness pass to about −14 LUFS.

### 4.9 QA: generation supervision

- **Contact sheet:** frames at each beat midpoint and ±0.1 s around each cut.
- **Vision critic.** Checks, with each failure tied to the asset or layer responsible:
  - product visible and un-occluded;
  - label readable;
  - text legible against its background;
  - no overlaps;
  - CTA present;
  - nothing visibly pasted (scale or contact).
- **One automatic repair pass,** then ship with warnings (partial success).
- **ASR word-count guard:** retry TTS when Whisper's word count diverges from the script.
- The **label gate** (§4.3) and continuity checks (architecture #18) run here too.

### 4.10 GPU scheduling (local scale)

- **All GPU work stays serialized on the heavy lane:** ComfyUI (Flux, view model, b-roll), voice, voice-qwen, music, depth.
- **Model swaps are planned per job phase**, so each model loads once per job: all plates, then all views, then all voice, then music.
- A VRAM budget table per model goes in `docs/providers/*`, measured by its spike. Anything that can't fit with the others unloads before the next phase. That is the existing bounded VRAM-wait pattern.
- **Caching is the scaling lever.** A second job for the same brand reuses its views, settings, voice bible and music beds. Measure and report cache hit rates.

## 5. Milestones

Each milestone gets its own implementation plan, review and ADR, per CLAUDE.md working style. Spikes come first where a model choice is open.

| # | Milestone | Exit criteria |
|---|---|---|
| **C1** | **The asset library and understanding** | Upload 1 photo, and you get: the anchor, a cutout, a descriptor, OCR label text, a viewpoint and a palette, all stored under tags. Plate analysis returns the support surface, light direction, luma and depth for a generated plate. Brand kit and voice bible exist for Krishna. |
| **C2** | **The editable composition and recipe cache** | `VideoSpec` v2 has element layers. Every generated asset has a recipe hash. The edit-operation set and log exist. Golden test: a layout-only edit regenerates 0 assets; a VO edit regenerates 1 line and re-flows. The browser preview plays a composition from cached assets. |
| **C3** | **Director v2** | New fields, arc on formats, script bank seeded for the existing hooks and formats, the stress test with one repair, the prompt compiler (golden files per block order), and shot lists of 1–3 shots per beat. The diversity assertion still passes. |
| **C4** | **Renderer craft** | 6 blueprints, the motion doctrine, 5 transitions, luma-picked captions, the safe-zone validator, a LUT grade and Indic fonts. Render tests at 240×426, 5 frames, per blueprint. |
| **C5** | **Asset population**, spike first | Spike: the view model fits 16 GB and passes the label gate on Krishna products, with measured VRAM, time and pass rate. Then strategy A (plate matched to view) by default, strategy B with the gate and downgrade, plus contact shadow, colour match and the layout-guided plate. Exit: a side-by-side where the product reads as photographed in the scene. |
| **C6** | **Audio** | SFX cues, an ACE-Step bed (after the spike), carve and loudness. One e2e with audible music under the voice. |
| **C7** | **The editor UI** | Canvas drag and resize, timeline, layer panel, regenerate-with-fields per shot, natural-language edits into operations, and the production stages with lock. Playwright e2e: drag the product, retime a reveal, regenerate one plate, export. |
| **C8** | **QA supervision** | Contact sheet plus vision critic plus one repair, the ASR guard, and the label/continuity gate. A deliberately corrupted shot gets flagged and regenerated. |

**Order:** C1 → C2 → C3 → C4 → C5 → C6 → C7 → C8.
- C1 and C2 come first because everything else hangs off the library and the recipe graph, and malleability is impossible without them.
- The **C5 spike may run early**, in parallel on a free GPU evening, because it's the highest technical risk.
- The **Indic TTS spike** can run any time.

## 6. Decided vs left to the builder

**Decided in this conversation:**
- local GPU first, cloud later;
- one photo minimum, with more enriching the library;
- assets-first with the tag convention and never-overwrite;
- the anchor is never regenerated;
- new views carry the label gate, downgrading to the real view;
- **hero shots may use AI-generated angles**, made beforehand as library assets and composited into the shot with masks, never generated in-shot;
- the composition is the editable document and the MP4 is an export;
- minimal regeneration through recipes;
- both drag and words, producing the same structured operations;
- the ONEIRIC principles (verbatim descriptors, every prompt an island, positive phrasing, tasks not emotions, stress test before generation, post stages with lock);
- English voice is Qwen.

**My calls (not discussed; say if wrong):**
- strategy A (match the plate to the view) is the default over generating new views;
- a generated view needs the automated label gate **plus one approval in the library** before hero use; supporting use needs the gate only;
- a vision LLM for semantic analysis plus local models for geometry;
- 6 starting blueprints and the 5 transitions;
- caption style computed from luma;
- a user drag outside a safe zone warns rather than blocks;
- C1/C2 before the craft work;
- ACE-Step for music;
- a ~−14 LUFS target.

**My calls from the builder check:**
- **The project document is separate from `VideoSpec`.** The editable document is a per-variant **project** (base generation plus edit log), compiled into `VideoSpec` for preview and export. `VideoSpec` stays a pure render IR.
- **Edits survive upstream regeneration where their layer ids survive.** Reveal timing is stored **relative to its cue** (cue index plus offset), so a VO re-flow keeps it right. When the Director re-runs on a structural change, edits whose layer ids no longer exist are listed to the user as dropped, never silently lost.
- **Code writes the initial layout map, not the Director.** It starts from the blueprint's default zones and the chosen product view's footprint, then the plate is generated to that layout. Plate analysis runs **after** generation, to verify the support surface and luma and to nudge text zones. The Director emits no boxes.
- **Product and brand identity.** A new `products` entity belongs to a project, and project = brand. At upload the user picks an existing product or creates one, and sha256/embedding matches *suggest* the existing product. Library reuse and the cross-job cache key off the product and project ids.
- **Edits create revisions.** The original generation is kept. "Approve" requires the revision to be **locked** first, and lock is per revision.
- **Hinglish edits.** The user edits the Latin `vo`. A transliteration step (LLM, shown for confirmation) regenerates `vo_tts`, then the TTS for that one line runs. The step is a node in the recipe graph.
- **Diversity.** The three variants' hook beats must use different blueprints, and their treatments' LUTs must differ, added to `assertVariantDiversity` with the same one-repair-then-fail rule. Transitions are not counted.
- **A failed stress test after the repair ships the variant with a warning**, partial-success style. Only diversity fails hard, because it's the core claim.

**Left to the builder** (decide in plans and spikes, then record ADRs):
- the exact DB schema for library tables, recipes and edit logs;
- the specific OCR, depth and view models (spikes, measured, licenses verified);
- the gate thresholds;
- the method for layout-guided plate conditioning;
- the editor UI component choices;
- the browser preview mechanics;
- the LUT set beyond the first;
- blueprint timing specifics.
