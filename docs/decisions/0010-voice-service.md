# 0010 — Local Python voice service (Chatterbox + Whisper)

**Status:** accepted · 2026-10-16 · amends spec §11 (Whisper placement) and the P6 roadmap

## Decision
- **Exception to "TypeScript end-to-end":** Chatterbox and openai-whisper are Python/torch only. They run in **one** local FastAPI service (`services/voice`, uv-managed, Python 3.13) behind the TypeScript `TTSProvider` and `CaptionAligner` interfaces. No provider shape crosses into Node.
- **Blackwell:** `chatterbox-tts` 0.1.7 pins torch 2.6.0, which has no sm_120 kernels. uv `override-dependencies` installs torch 2.12.1 / torchaudio 2.11.0 from the cu130 index, the same build ComfyUI runs on this GPU.
- **Whisper is in the same service,** not transformers.js in Node. It uses the same torch, needs no audio resampling in Node, and has proven multilingual DTW word timestamps. Captions show the **script's** words, re-timed onto Whisper's word timings by `alignScript` in core.
- **WAV I/O uses the stdlib `wave` module.** torchaudio's file I/O moved to torchcodec in recent releases.
- **Liveness:** a GPU lock, lazy model slots, an idle TTL unload (`VOICE_IDLE_TTL_S`, default 120 s), `POST /unload` and `GET /health`.
- **Watchdog:** every model call made under the GPU lock (load, generate, transcribe) runs inside `Watchdog(VOICE_CALL_TIMEOUT_S, default 300)`. Torch calls cannot be interrupted, so on expiry the process logs and `os._exit(3)` rather than hold the lock forever; the supervisor restarts it. `/align` rejects uploads over 8 MB (413) and non-WAV input (422).
- **Checkpoint:** chatterbox-tts 0.1.7 has no `t3_model` argument; `from_pretrained(device)` loads the `t3_mtl23ls_v2` multilingual checkpoint. The "v3" option in the reference notes does not exist in this release.

## Measured
RTX 5070 Ti, torch 2.12.1+cu130, warm HF cache: cold synth incl. model load 16.0 s; warm synth of "Nobody tells you how oil is made." 2.12 s for 2.20 s of audio (24 kHz); align cold (Whisper small load) 3.4 s, warm 0.27 s (7 words, 0.00–1.38 s); peak VRAM 6.5 GB total with both models resident (about 5.2 GB above the 1.35 GB desktop baseline); `/health` after `/unload`: `loaded: {tts: false, whisper: false}`. First-ever run (weight download) took 4 min 44 s.

## Consequences
- The pipeline must serialize voice work with ComfyUI on the GPU (P7 heavy lane) and free ComfyUI before a voice batch.
- Swapping to a hosted TTS later is a new `TTSProvider` adapter. The service stays for alignment, or Whisper moves too.

## Measured (e2e, 2026-10-16)
Anchor variant 1 voiced in three languages (`pnpm e2e:voice`; ComfyUI plates, then `comfy.free()`, then voice, then `voice.unload()`, then render). Per-beat voice durations (s):
- en: 2.56, 3.72, 8.88, 3.72
- hi: 4.60, 5.64, 6.32, 4.88
- hinglish (TTS language `hi`): 4.20, 5.40, 3.64, 3.28

Peak VRAM sampled every 2 s over the run: 15.6 GB of 16 GB (the peak fell about 70 s in, during the ComfyUI plate batch). The GPU returned to 1.3 GB once both services were stopped. Rendered frame counts (1080x1920, 30 fps, video + audio): en 692, hi 667, hinglish 630, each equal to the spec's `durationInFrames`. The first English beat took 37.9 s because it included the cold TTS and Whisper loads; warm beats took 3 to 7 s.

## Listening check 1 (user, 2026-10-17): failed all three
- **en:** not natural; only a slight emotional rise. The exaggeration range was 0.3–0.9, with cfg 0.3 above emotion 0.7, which is the README's "dramatic" setting.
- **hi:** pronunciation was correct, but the meaning was off. The Hindi lines were hand-written plan fixtures, not Director output.
- **hinglish:** unacceptable. The user described the pronunciation as "downright racist and humorous". Latin-script Hindi was sent to Chatterbox's Hindi model, which is trained on Devanagari.

**Decision (P6b):**
- **Hinglish:** the Director also writes `vo_tts`, the same line fully in Devanagari (English words and brand names transliterated). TTS speaks `vo_tts` with the `hi` model. Captions keep the Latin `vo`, timed through `alignCaptions`. **Never send Latin-script Hindi to the TTS.**
- **English:** the exaggeration range was narrowed to 0.4–0.7, with cfg 0.5 (0.45 only above emotion 0.8).

## Listening check 2 (user, 2026-10-17): Hindi and Hinglish accepted; English still a known gap
The run voiced real Director copy for the Krishna Hing eval products (`pnpm e2e:llm`, then `pnpm e2e:voice`).
- **hi:** fine.
- **hinglish:** fine, voiced from the Devanagari `vo_tts`.
- **en:** at emotional or dramatic moments the voice produces gibberish instead of a dramatic read. The user deferred this ("maybe we will need something else; we can work on that later").

Candidate fixes, not yet started:
- Chatterbox's English-only model (`ChatterboxTTS`) for `en`, instead of the multilingual one.
- Capping exaggeration for `en`.
- A reference voice clip (`audio_prompt_path`).
- A hosted `TTSProvider`.
