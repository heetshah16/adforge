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
