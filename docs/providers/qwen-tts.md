# Qwen3-TTS (local, English spike)

Source: github.com/QwenLM/Qwen3-TTS and PyPI `qwen-tts`, fetched 2026-10-17; verified against the installed package.

- **License / package:** Apache-2.0. `qwen-tts==0.1.1` (released 2026-02-06). It pins `transformers==4.57.3` and `accelerate==1.12.0`, which conflicts with `services/voice` (transformers 5.2.0), hence the separate uv project `services/voice-qwen`.
- **Resolved here (Python 3.13.15):** torch 2.12.1+cu130, torchaudio 2.11.0+cu130 (override, same as voice), transformers 4.57.3, accelerate 1.12.0, qwen-tts 0.1.1, sox 1.5.0, numpy 2.5.4.
- **Models:** `Qwen/Qwen3-TTS-12Hz-{1.7B,0.6B}-CustomVoice` (9 preset timbres; English natives "Ryan", "Aiden") and `-Base` (3 s voice clone). Hindi is unsupported; English only here.
- **API (matches the installed package):**
  - `Qwen3TTSModel.from_pretrained(id, device_map="cuda:0", dtype=torch.bfloat16, attn_implementation="sdpa")`
  - `model.generate_custom_voice(text=, language="English", speaker="Ryan", instruct=None) -> (list[np.ndarray float32], sample_rate)`
- **Attention:** flash-attn is not installed (prints a warning); `sdpa` was accepted by `from_pretrained`.
- **Measured (RTX 5070 Ti, Windows 11):** 1.7B-CustomVoice, bf16, sdpa: sample rate 24000 Hz; "Nobody tells you how your cooking oil is made." -> 2.96 s audio in 5.19 s (first generate, includes warmup); load 257.9 s on first run (includes the multi-GB download); peak `torch.cuda.max_memory_allocated()` 4104 MB.
- **Install warnings (harmless):** `sox` pip package prints "SoX could not be found!" (import still works); HF cache has no symlink support on Windows; `hf_xet` not installed (plain HTTP download, one read timeout resumed automatically).
- **OneDrive:** the repo lives under OneDrive, so uv's default hardlink install fails (os error 396). Use `UV_LINK_MODE=copy` (set in `scripts/voice-qwen.ps1`).
- **Sampling:** no `temperature`/`top_p`/`top_k` are passed; model defaults apply.
- **Service:** `services/voice-qwen`, 127.0.0.1:8191. `POST /synthesize {text 1..500, speaker, instruct?}` -> WAV (`X-Duration-Sec`, `X-Sample-Rate`); `GET /health`; `POST /unload`.

Note: the 0.6B models drop `instruct`, so the emotion->instruct mapping is a no-op for them.
