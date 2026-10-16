# Chatterbox Multilingual — provider reference

**Fetched:** 2026-10-16 from github.com/resemble-ai/chatterbox (README), huggingface.co/ResembleAI/chatterbox (model card) and PyPI `chatterbox-tts` 0.1.7.

- **License:** MIT. About 0.5B parameters. Outputs carry Resemble's **PerTh** watermark.
- **Load:** `from chatterbox.mtl_tts import ChatterboxMultilingualTTS`; `ChatterboxMultilingualTTS.from_pretrained(device="cuda")` (0.1.7 has no `t3_model` argument; it downloads `t3_mtl23ls_v2.safetensors`, `s3gen.pt`, `ve.pt`, `conds.pt`).
- **Generate:** `model.generate(text, language_id="hi")`. It returns a waveform tensor at `model.sr`. Emotion is controlled with `exaggeration` (default 0.5) and `cfg_weight` (default 0.5); for expressive speech the README suggests `exaggeration` ≈ 0.7+ with `cfg_weight` ≈ 0.3.
- **Language ids:** ar da de el **en** es fi fr he **hi** it ja ko ms nl no pl pt ru sv sw tr zh. There is no Hinglish id; for Latin-script Hindi we send `hi` (or `en`), configurable in `PIPELINE.voice.hinglishTtsLanguage`.
- **Python:** developed on 3.11. 0.1.7 pins `torch==2.6.0` below Python 3.14; torch 2.6 lacks Blackwell (sm_120) kernels, so AdForge overrides torch via uv (ADR 0010).
- **Not documented:** VRAM use, and Windows support.
