# 0013 — Qwen3-TTS English spike (separate service)

**Status:** spike, accepted for A/B listening · 2026-10-17

## Decision
- Chatterbox Multilingual produced gibberish at dramatic English moments (ADR 0010, listening check 2). We try Qwen3-TTS for English.
- **Separate service `services/voice-qwen`** (own uv project, FastAPI on 127.0.0.1:8191). `qwen-tts` 0.1.1 pins `transformers==4.57.3`; `services/voice` resolved transformers 5.2.0 for Chatterbox. One venv cannot satisfy both.
- Same torch override as voice (2.12.1 / torchaudio 2.11.0, cu130), Python 3.13 (no fallback to 3.12 was needed).
- Same liveness design as voice: GPU lock, lazy `ModelSlot`, idle-TTL janitor that re-checks under the lock (`QWEN_IDLE_TTL_S` 120), `/unload` always runs gc + `empty_cache`, watchdog with separate load (1800 s) and call (300 s) budgets that exits 3, restart loop in `scripts/voice-qwen.ps1`.
- The small helpers (`ModelSlot`, `Watchdog`, `encode_wav`) are copied into `qwen_core.py`, not shared. ponytail: extract a shared package if a third engine appears.
- `attn_implementation="sdpa"` (flash-attn is not installed on Windows).

## Measured
1.7B-CustomVoice, bf16, sdpa, speaker Ryan: 24 kHz, 2.96 s of audio in 5.19 s, peak VRAM 4104 MB, first load 257.9 s including download. Live test: VRAM drops below 25% after `/unload`.

## Consequences
- **Default unchanged pending the user's A/B listening check.** Every language keeps `engineByLanguage = 'chatterbox'`.
- Roughly 4 GB more VRAM when resident; it must be unloaded before ComfyUI work, like voice.

## A/B pair ready for listening check
Same Director English copy (`krishna-special-hing`, variant 1, 4 beats), same plates and cutout; Whisper on the voice service aligns both. No winner is picked here.
- A (Chatterbox): `C:\adforge-data\media\94\94aa11766a4d7602ba710ed0abc301d465b9febada43b12c0bef6201066666ec.mp4` (756 frames, 25.2 s)
- B (Qwen, Ryan): `C:\adforge-data\media\02\022a3a468179c20262918adcf8748a3e79106294c9caac6c8734368f91a585a1.mp4` (663 frames, 22.1 s)
- Voice duration per beat (s): Chatterbox 9.00 / 2.92 / 5.24 / 4.64; Qwen 4.16 / 4.96 / 6.00 / 6.16.
- Generation time (TTS+align, 4 beats): Chatterbox 48.9 s (40.4 s of it was beat 1, cold load); Qwen 55.4 s (29.6 s beat 1, cold load).
- Peak VRAM: Chatterbox + Whisper about 6.0 GB; Qwen + Whisper about 7.35 GB (the voice service was unloaded between engines). The 15.7 GB peak in the same run was the ComfyUI plate phase, before the hand-off.
- Run with `pnpm e2e:voice-ab` (needs ComfyUI, voice and voice-qwen up). Chatterbox beat 1 at 9.0 s for a short line is worth listening for.

## Decision after listening check 3 (2026-10-17)
The user picked Qwen ("leagues better"). **English now defaults to `qwen`** (`PIPELINE.voice.engineByLanguage.en`); hi and hinglish stay Chatterbox (Qwen has no Hindi). `voice-qwen` is now a required service for English jobs. Tests that exercise the Chatterbox client pin an all-chatterbox table instead of relying on the default.
