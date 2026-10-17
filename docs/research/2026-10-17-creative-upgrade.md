# Creative upgrade: what the Director, shot creator, and renderer should gain

**Status:** research list, 2026-10-17. Nothing here is decided. Each item names where it lives.
**Why:** the POC ads read as basic. The user watched both runs, and English voice is now solved (Qwen, ADR 0013).
**Sources:**
- the HyperFrames skills (HeyGen), v0.8.91: `product-launch-video` (story-design, visual-design, motion-language), `embedded-captions`, `hyperframes-audio`, `media-use`, `hyperframes-creative`;
- the Higgsfield skills, v0.13.0: `generate` / Marketing Studio, `product-photoshoot`, `video-explainer`, `brandkit`;
- our spec addenda A (shot synthesis) and B (motion).

## Why today's ads look basic (diagnosis)
Each beat is **one AI plate, one Ken Burns move, one static text line, and boxed captions, with a hard cut to the next beat**. There is no music and no SFX.

The HyperFrames doctrine names exactly this failure: *"slideshow — everything dumped on screen in the first ~25%, then frozen."* Our Director output can't express anything richer:
- `Scene` has `beat: string`, a single `overlay`, one `scene` prompt, and one `motion` out of 5;
- `VideoSpec` has no transitions, no audio beyond voice, and one caption style.

Legend:
- **[R]** registry/data change, which is cheap.
- **[E]** a closed render-coupled enum, which needs a PR plus renderer code.
- **[S]** a schema or code change.

Spec refs point at existing plans we haven't built.

---

## Tier 1: biggest visible lift per unit of work

### 1. Director: write beats as cue sequences, not one line [S]
- **`role` enum per beat** replaces the free `beat` string: `hook | pain_point | product_intro | feature_showcase | benefit_highlight | social_proof | cta` (HyperFrames role set).
- **`vo_cues: string[]`.** The VO is split at phrase boundaries, and each cue triggers one on-screen reveal. This is the core anti-slideshow mechanism: *"nothing appears before the voiceover names it."* Word timings from Whisper already exist, so cue → frame mapping is deterministic in `buildSpec`.
- **`persuasion` (named move) and `emotion_label`** alongside the existing numeric `emotion`. Example moves: pain agitation, risk reversal, value stacking, social proof, sensory tease. Example emotions: curiosity, urgency, relief, craving, trust.
- **`delivery`**, a short spoken-direction string ("warm, confiding, slower"). It feeds **Qwen's `instruct` per beat**, replacing today's two fixed instructs. This is cheap, because Qwen already takes instruct.
- **`arc` per variant**: PAS / BAB / Future-Pacing / Demo-Loop / Feature-Benefit-Cascade. Make it **[R]**: a field on `format` registry entries, so the format fixes beat order.

### 2. Director prompt: a script bank per hook archetype [R]
HyperFrames' biggest quality lever is a few-shot **script bank**. Proven ad lines are reversed into patterns per role. An example pattern: *"a 'could be X, or Y, or Z?' cycle on one swapping word, then a hero claim crashes in."*

Add `script_pattern` and 2–3 `examples` to each `hook_archetype` and `format` registry entry. Render them into the Director prompt in slug order: deterministic, byte-frozen, so they stay cacheable. Our registry already has the slugs (`stat_shock`, `curiosity_gap`, `objection_kill`, `sensory_tease`…); it's missing the patterns.

### 3. Shot blueprints: beats with a signature move [E]
Replace "plate + Ken Burns" with a small closed set of **beat templates**. Each is a time-coded shot shape with slots and one signature move. Start with six that fit FMCG/food:

| blueprint | signature move | fits role |
|---|---|---|
| `kinetic_hook` | word-swap / beat-slam type over a dimmed plate | hook |
| `product_hero_reveal` | cutout enters on a long-tail settle, glow blooms behind, then holds | product_intro |
| `stat_countup` | a number counts up, with a value-scaled font | hook, social_proof |
| `benefit_stack` | 3–4 chips/lines assemble one per VO cue | feature/benefit |
| `split_compare` | two tilted cards, before vs after or us vs them | pain→solution |
| `endcard_lockup` | logo + price badge + CTA button press | cta |

The Director picks a `blueprint` per beat from an enum, and `buildSpec` lays it out. `VideoSpec` gains element layers (`headline`, `stat`, `chip`, `badge`, `cta_button`, `logo`) with `revealFrame`. HyperFrames has rule recipes for all of these (`discrete-text-sequence`, `counting-dynamic-scale`, `spring-pop-entrance`, `press-release-spring`, `ambient-glow-bloom`).

### 4. Motion doctrine in the renderer [E]
- **Easing:** `power3` long-tail eases only, with no bounce or elastic. *"Bouncy is the #1 instant turn-off."*
- **Reveal timing:** reveals sit in the back ~50% of a beat, timed to cues.
- **Stillness:** no "lazy breathing" and no slow back-half pan. A held frame is fine; subtle jitter is the only sanctioned aliveness.
- **Seek-safety:** HyperFrames' seek-safe rules (`fromTo`, no `repeat` or `yoyo`, no CSS animation) match our determinism contract.

### 5. Transitions between beats [E]
Add `transition_in: cut | crossfade | blur_crossfade | push_slide | zoom_through` per scene, which is the HyperFrames five. Use crossfade as the default, `blur_crossfade` when the plates clash, and `zoom_through` at the hook→body boundary. Today every seam is a hard cut.

### 6. More shots per beat [S] (spec: Addendum A §A4.2 ShotList)
Short-form ads cut every ~1.5–2.5 s, while ours hold one plate for ~5 s. Allow 1–3 shots per beat: wide → macro detail → hero, each with a shot size and camera from the A4.2 `Shot` schema. Plates are cheap locally (Flux), so this is VRAM/time rather than money. It needs the WorldBible seed so the shots look like one place.

### 7. Captions that read on any plate [E] + layout safe zones [S]
- **Pick the caption style by measured plate luma.** This is computed in code, like `fidelityTier`, not chosen by the model. HyperFrames' catalog does exactly this:
  - `ink` for bright plates (luma > 150): it directly fixes our unreadable white-on-bright;
  - `cream` / `documentary` for dark or warm plates;
  - `loud` for UGC/hype;
  - `anchor` as the safe default.
- **Keyword emphasis** (`asr-keyword-glow`): highlight the hook word or price word as it's spoken.
- **Zones:** a caption keep-out band (bottom ~17%), a product zone and a text zone. `buildSpec` rejects overlaps deterministically, which fixes "overlay sits on the product". Make it a `VideoSpec.superRefine` check, so it fails in tests rather than on screen.

### 8. Music bed and SFX [S]
- **SFX:** HyperFrames ships **21 Pixabay-licensed SFX** (commercial OK, no attribution): whoosh ×3, impact-bass ×2, riser, pop, click, chime, sparkle, typing, glitch… The Director names `sfx` per beat (impact on the hook slam, whoosh on transitions, riser into the reveal), mixed at volume ~0.35.
- **Music:** generate locally with **ACE-Step 1.5**. It is reported MIT and <4 GB VRAM; verify the LICENSE before use. One `music_mood` per variant drives it. Under the VO, **carve or duck** the bed (HyperFrames' "voiceover carve") rather than pushing it flat.
- **Final mix:** normalize to about −14 LUFS for Reels/Shorts.

### 9. Voice first, then size visuals to the voice [S]
Higgsfield's explainer pipeline generates *every voice take first, then every clip*. Doing the same means choosing b-roll beats and clip lengths **after** TTS durations are known. That fixes the silent b-roll drop (V2: a 150-frame clip against a 156-frame beat).

---

## Tier 2: polish and brand

10. **Color grade per treatment [E].**
    - Apply one LUT to plate + cutout together: `teal-orange-blockbuster`, `film-fade`, `bleach-bypass` (HyperFrames LUT catalog), or a warm "Indian kitchen" look.
    - This unifies AI plates and real product pixels, the biggest "composited" tell.
11. **Cutout integration [S]:**
    - a contact shadow (we have a bool), a color match of the cutout to the plate, and a light wrap;
    - a hero → detail `zoom-to-target` on the label.
    - The rule stays: never let a model render the product.
12. **2.5D parallax [E]** (spec: Addendum B §B2). Use depth-split plates for push and parallax. Inpaint the exposed background once per keyframe (CLAUDE.md trap).
13. **Brand kit per brand [R/S]:**
    - extract logo, palette, fonts and tone once from the site (Higgsfield `brand-kits fetch` idea; we already scrape krishnahing.com);
    - store it and feed `VideoSpec.theme` plus the end card.
    - Today `theme` is two hexes and mostly unused.
14. **Devanagari / Gujarati display fonts [S].** Hindi captions and overlays need a real Indic display face, or they fall back to the OS font (P3 noted the Inter latin-ext gap).
15. **Plate recipes from photoshoot modes [R].** Higgsfield's product-photoshoot modes map onto our `visual_treatment` + plate prompts:
    - `product_shot`, `lifestyle_scene`, `conceptual_product` (splash/levitate, with the real cutout composited over a generated splash plate);
    - `ingredient_story` and `flat_lay`.
    - Add a camera/lens/light vocabulary to plate prompts ("85mm, low angle, rim light"). Phrase prompts positively ("tack sharp", not "no blur").
16. **Settings library [R].** Reusable environments per category, for example "Indian kitchen, tadka in a steel kadai, morning light", as registry entries the Director picks from. This is Higgsfield's "settings" concept.
17. **Ad-mode coverage check [R].** Compare our `format` registry with Marketing Studio's modes: ugc, how_to, unboxing, product_showcase, product_review, tv_spot. `how_to` (recipe use: "add a pinch to dal") and `unboxing` are missing for food. Adding them as `experimental` also helps the same-category/same-trio problem.

## Tier 3: QA and later

18. **Critic pass before delivery [S].**
    - Render a contact sheet (beat midpoints, plus ±0.1 s around each cut; HyperFrames `snapshot`).
    - A vision check scores: product visible, text legible, nothing overlapping, CTA present.
    - One repair pass, then ship with a warning.
19. **ASR word-count guard [S]** (already proposed): retry TTS when Whisper's count diverges from the script.
20. **Attention scoring:** Higgsfield Virality Predictor (`brain_activity`): hook-second, sustain, distraction. It's cloud and paid; use it for eval runs, not per job.
21. **Presenter/UGC talent:** Marketing Studio avatars. There's no good local option yet, so skip for now and revisit with Addendum A's talent shots.

---

## Voice: local models for Indic language plus emotion

**English is settled: Qwen3-TTS** (ADR 0013). Qwen has no Hindi, so hi/hinglish stay on Chatterbox, which you rated fine. Candidates to spike for **emotion in Hindi, and for Gujarati** (Krishna Hing is from Nadiad):

| model | langs | emotion control | license | note |
|---|---|---|---|---|
| **svara-TTS v1** (kenpath) | 19 (18 Indic incl. Hindi, **Gujarati** + Indian English) | inline tags `<happy> <sad> <anger> <fear>`, zero-shot clone | **unverified**: the card's license section was empty | Orpheus-based; GGUF/LoRA; the top pick to spike |
| **Indic Parler-TTS** (AI4Bharat) | 21 | text description prompts; *documented* emotion covers 10 langs, **not Hindi/Gujarati** | Apache-2.0 | a fallback for coverage |
| **Rumik-OSS-1** (Sept 2026) | 22 Indic + English, native + romanized | emotion and vocalization control | **CC-BY-NC 4.0** | POC-only, like the subscription LLM; it can't ship |

Suggested spike (same shape as P6c): put svara-TTS in its own `services/voice-*` and do an A/B on the Krishna Hing Hindi copy against Chatterbox, plus one Gujarati line. Verify its license first.

---

## Suggested order
1. Items **1 + 2**: Director schema and script bank. They're cheap and unlock everything else.
2. Items **7 + 8**: captions, zones, music, SFX. They're the most visible and mostly independent.
3. Items **3 + 4 + 5**: blueprints, motion and transitions, one renderer milestone.
4. Items **6 + 9**: shot lists and voice-first timing.
5. Then Tier 2. Run the Indic TTS spike in parallel whenever a GPU evening is free.

## Sources
- [svara-TTS blog](https://huggingface.co/blog/kenpath/svara-tts-open-multilingual-speech-for-india) · [svara-tts-v1 card](https://huggingface.co/kenpath/svara-tts-v1)
- [Indic Parler-TTS card](https://huggingface.co/ai4bharat/indic-parler-tts)
- [Rumik-OSS-1 write-up](https://explainx.ai/blog/rumik-oss-1-indic-tts-open-source-emotion-2026)
- [ACE-Step 1.5 (AMD blog)](https://www.amd.com/en/blogs/2026/commercial-grade-ai-music-generation-on-amd-ryzen-ai-and-radeon-ace-step-1-5.html) · [ACE-Step 1.5 overview](https://rits.shanghai.nyu.edu/ai/ace-step-1-5-open-source-music-generation-that-rivals-commercial-ai/)
- [MMAudio licensing note (vendor blog; says weights are CC-BY-NC)](https://runware.ai/blog/your-ai-video-pipeline-is-silent-heres-the-fix)
