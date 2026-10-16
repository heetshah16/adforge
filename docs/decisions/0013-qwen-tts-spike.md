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
