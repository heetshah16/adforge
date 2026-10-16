# P6b: Voice quality fixes after the first listening check — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development. Steps use checkbox (`- [ ]`) syntax.

**Why this exists.** The first P6 listening check (2026-10-17) failed all three languages:
1. **English:** "doesn't sound natural; a bit of emotional rise, but not good."
2. **Hindi:** pronunciation correct, but "a few issues with translating the meaning". The Hindi lines were hand-written test fixtures in the P6 plan, not Director output.
3. **Hinglish:** "downright racist and humorous pronunciation". Latin-script Hindi was fed to Chatterbox's Hindi model, which was trained on Devanagari.

**The user chose:**
- **Hinglish:** the Director also writes a Devanagari voice line, and TTS speaks it. Captions keep the Latin script.
- **English:** tune first. If still flat, the user provides a 10–20 s reference clip for voice cloning, which is a separate later task.

**Goal:** re-render EN, HI and Hinglish from real Director output with natural-sounding voices, then run a second listening check.

## Global Constraints

- Everything in the P5 and P6 plans' Global Constraints still applies: frames-only timing, Zod-validated requests, byte-frozen prompts (an edit is a new version with a new SHA), no temperature/top_p/top_k, the provider seams, and the liveness rules.
- **Live LLM calls use the user's subscription.** Each e2e runs once.
- `pnpm test` (typecheck first) passes before every commit. The FFmpeg dir is prefixed on PATH.

## Task 1: Tune Chatterbox emotion mapping (Haiku)
- **Change:** in `packages/core/src/config/pipeline.ts` `DEFAULT_PIPELINE.voice`:
  - `exaggeration: [0.4, 0.7]`;
  - `cfgWeight: 0.5`;
  - `expressiveCfgWeight: 0.45`;
  - `expressiveAbove: 0.8`.

  These sit near Chatterbox's natural defaults (0.5/0.5). The old range of 0.3–0.9 with cfg 0.3 is the README's "dramatic" setting.
- **Tests:** update the voice-service `voiceParams` test expectations and the golden request body (`exaggeration` at emotion 0.6 = 0.58; `cfg_weight` 0.5). Add one test at emotion 1.0: exaggeration 0.7, cfg 0.45.
- **Commit:** `tune(voice): natural Chatterbox emotion range after listening check`.

## Task 2: The Director writes a Devanagari voice line for Hinglish (Sonnet)
- **Schema** (`packages/core/src/llm/schemas.ts`): the Director scene gains an optional `vo_tts: z.string().min(1).max(400)`.
- **Prompt** (`packages/core/src/prompts/director.md`, a new frozen version): in `## LANGUAGE`, add under `hinglish`:

  > Also write `vo_tts` for every scene: the SAME spoken line written entirely in Devanagari for the voice engine. Transliterate every word, English words included (cooking oil → कुकिंग ऑयल), keeping the word order and word count of `vo` where possible. Omit `vo_tts` for `en` and `hi`.

  Update the worked anchor ONLY if the rules below would make it invalid. It is `en`, so it should stay valid.
- **Rules** (`packages/core/src/llm/rules.ts` `checkVariant`, rule `'language'`):
  - when `language === 'hinglish'`, every scene must have `vo_tts`, with at least 80% of its letters (`\p{L}`) in the Devanagari block U+0900–U+097F;
  - when the language is not `hinglish`, `vo_tts` must be absent;
  - the message names the scene number.
- **Helper** (`packages/core/src/llm/tts-text.ts`): `ttsText(scene, language): string` returns `scene.vo_tts` for `hinglish`, and throws if it is missing, since the rules guarantee it. Otherwise it returns `scene.vo`.
- **Tests:**
  - Hinglish without `vo_tts` → violation; Hinglish with Latin `vo_tts` → violation; `en` with `vo_tts` → violation;
  - `ttsText` returns the right line for each language.
  - The prompt SHA changes. If any test pins the old SHA, update it and say so.
- **Commit:** `feat(llm): Director writes a Devanagari vo_tts line for Hinglish voice`.

## Task 3: Voice the Devanagari line; align captions through it (Sonnet)
- **Helper** (`packages/core/src/spec/align-captions.ts`): `alignCaptions(scene, language, asrWords, durationSec): AlignedWord[]`.
  - For `hinglish`: run `alignScript(scene.vo_tts, asrWords, dur)`. If the Devanagari token count equals the Latin `scene.vo` token count, return those timings with the Latin token texts, one to one.
  - Otherwise, return `alignScript(scene.vo, asrWords, dur)`, which hits the slot fallback.
  - For other languages: `alignScript(scene.vo, asrWords, dur)`.
  - **Tests:** an equal-count mapping keeps the Latin texts with the Devanagari timings; an unequal count falls back.
- **The P5 e2e saves its Director output:** `packages/providers/claude-agent-sdk/src/e2e.ts` writes each product's OK `DirectorOutput` plus its language to `<ADFORGE_DATA_DIR>/e2e/directions/<slug>.json`. That directory is outside the repo and not committed.
- **The P6 e2e voices real Director output** (`packages/providers/voice-service/src/e2e.ts`):
  - If `<ADFORGE_DATA_DIR>/e2e/directions/*.json` exist, voice variant 1 of each saved direction. Use `ttsText` for the TTS text, `alignCaptions` for the captions, and the language's ASR id. Otherwise, fall back to the current anchor and fixture lines.
  - Plates: generate them from each voiced variant's own `scene` prompts, with idempotency keys namespaced by slug.
  - Keep the GPU hand-off:
    - after the ComfyUI batch, call `comfy.free()`, then poll `comfy` `systemStats` (or `/system_stats`) until VRAM in use drops, or 20 s pass. Log the before and after numbers. This closes the P6 Task 5 deferred minor.
    - Wrap the batches in `try/finally`, so a failure still calls `comfy.free()` and `voice.unload()` best-effort.
- **P7 plan amendment** (`docs/superpowers/plans/2026-10-16-p7-pipeline.md`): the heavy voice step uses `ttsText(scene, language)` for TTS and `alignCaptions(...)` for captions, and verifies ComfyUI `free()` via `systemStats` before TTS.
- **Commit:** `feat(voice): Hinglish voiced from Devanagari vo_tts, captions aligned through it; e2e voices real Director output`.

## Task 4: Live re-run and the second listening check (Sonnet, then the user)
- **Third eval product:** `fixtures/eval-products/krishna-special-hing-hinglish/` already exists (gitignored). It is a copy of krishna-special-hing with `"language": "hinglish"`.
- **Run `pnpm e2e:llm` once.** That makes 3 products of Strategist plus Director calls on the subscription, about $0.8 estimated. Confirm three direction JSONs were saved and that the Hinglish one has Devanagari `vo_tts` on every scene.
- **Start ComfyUI and the voice service, then run `pnpm e2e:voice` once.**
  - Expected: three RENDER lines (en, hi, hinglish) from real Director copy.
  - Afterwards stop both services, and report the MP4 paths, the ffprobe checks and the VRAM before and after `free()`.
- **The user listens.** Record both listening checks in ADR 0010, under "Listening check 1 (2026-10-17)" and "Listening check 2".
- **If English is still not natural:** open a follow-up task for reference-voice cloning (the service accepts an optional reference WAV; `audio_prompt_path` in Chatterbox). Do not start it without the user.
