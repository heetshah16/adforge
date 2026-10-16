# P6: Voice (Chatterbox) + Caption Alignment (Whisper) + Spec Builder — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** turn a Director variant plus generated assets into a frame-exact `VideoSpec`, with a per-beat voice-over (English, Hindi or Hinglish) whose emotion is set per line, and word-by-word captions timed by Whisper. Render it through P3.

**Architecture:**
- **One local Python service, `services/voice`** (FastAPI, its own uv venv, GPU), holds two lazily loaded models:
  - **Chatterbox Multilingual v3** (TTS);
  - **openai-whisper `small`** (word-timestamp ASR).

  It serializes GPU work with a lock and unloads each model after an idle TTL.
- **Node talks to it only through `packages/providers/voice-service`.** That package implements the core `TTSProvider` and `CaptionAligner` interfaces.
- **Pure core functions** do the rest:
  - `alignScript` maps the *script's* words onto Whisper's timings, since captions show what was written even when ASR mishears;
  - `buildSpec` produces the `VideoSpec`. It computes fidelity tiers in code, decides b-roll eligibility, and converts every second to frames through `frames.ts`.

**Tech Stack:**
- Python 3.13 (matching ComfyUI's known-good stack on this RTX 5070 Ti) and uv 0.12.13.
- `chatterbox-tts` 0.1.7, with **torch overridden to 2.12.1 / torchaudio 2.11.0 (cu130 index)**. Its own pin, torch 2.6, has no Blackwell sm_120 kernels.
- `openai-whisper` 20250625, fastapi 0.142.2, uvicorn 0.54.0.
- Node side: Zod 4 and Vitest 5. No new npm dependencies.

**Spec:** [spec](../specs/2026-10-15-adforge-local-poc-design.md) §6, §11 (Chatterbox, Whisper, three languages). **Roadmap:** P6 section plus the liveness rule. This plan **amends** the roadmap:
- **Whisper runs inside the voice service** (openai-whisper on torch), not transformers.js in Node. That means no resampling in Node, proven multilingual word timestamps, and no second runtime. Recorded in ADR 0010.
- **Python 3.13 with a uv torch override** is primary; the roadmap's Python 3.14 route becomes the fallback.

## Global Constraints

- **Provider shapes stay inside `packages/providers/voice-service` and `services/voice`.** Core sees only `TTSProvider`, `CaptionAligner`, `MediaRef` and `AlignedWord`.
- **Every request is Zod-validated before dispatch,** and Pydantic-validated again in the service. A service 422 means our Zod schema is wrong.
- **All timing in frames.** Seconds become frames **only** through `secondsToFrames` / `layoutFrames` (`@adforge/core/spec/frames`).
- **`fidelityTier` is computed in code** from `product_prominence`: `hero`/`supporting` → T0 real cutout overlay; `absent` → no product. **A video model never renders a `hero` or `supporting` beat**: b-roll is allowed only on `absent` beats, and only when the clip is at least as long as the beat.
- **Tunables live in `PIPELINE.voice` and `PIPELINE.composite`:** the emotion→exaggeration mapping, cfg weights, the Hinglish TTS/ASR language ids, request timeout and composite geometry. Service settings use env (`VOICE_IDLE_TTL_S`, `VOICE_DEVICE`, `VOICE_WHISPER_MODEL`, `VOICE_PORT`).
- **Liveness:**
  - every Node→service request has a deadline (`PIPELINE.voice.requestTimeoutMs`, default 120 s), and a timeout is a retryable `TIMEOUT`;
  - the service unloads each model after `VOICE_IDLE_TTL_S` (default 120) seconds idle and frees CUDA memory;
  - `POST /unload` frees both models on demand, and `GET /health` reports loaded state and sm_120 support;
  - the e2e calls ComfyUI `free()` before the TTS batch and voice `unload()` after it.
- **Exact pins, nothing newer than 2 weeks** (npm catalog; Python versions in `pyproject.toml` plus a committed `uv.lock`).
- `pnpm test` (typecheck first) before every commit, with no GPU, no service and no network; the Python unit tests run with `uv run pytest` (no GPU unless `--live`). **One end-to-end check** at the end (`pnpm e2e:voice`), which includes the user's listening check on all three languages.
- Commits: `git -c user.name=heetshah16 -c user.email=shahheet85@gmail.com commit ...` with a `Co-Authored-By:` trailer naming the authoring model.

## Review Focus

1. **The voice service hangs mid-synthesis.** The Node call must time out as `TIMEOUT` at its deadline and never wait forever. → Task 2 test.
2. **Whisper mishears or transcribes Hinglish in Devanagari.** Captions must still show the script's words with monotonic, in-clip timings (slot fallback). → Task 3 tests.
3. **A voice clip longer than its planned beat.** The beat must stretch to VO plus tail, so frames still sum exactly and the voice never overlaps the next beat. → Task 4 test.
4. **A b-roll clip shorter than its beat, or b-roll on a hero beat.** Use the plate instead; never let video cover a product beat. → Task 4 tests.
5. **VRAM contention** (Flux resident while TTS loads). The e2e must free ComfyUI first, and the service must free CUDA memory on unload. → Task 5, plus a `/health` check in the report.

---

## File Structure

```
services/voice/
  pyproject.toml, uv.lock, .python-version
  app.py              FastAPI: /health /synthesize /align /unload, idle janitor
  voice_core.py       ModelSlot, encode_wav, decode_wav (pure, stdlib wave)
  tests/test_core.py  unit tests (no GPU); tests/test_live.py (--live only)
  conftest.py
scripts/voice.ps1                     start the service
docs/providers/chatterbox.md, docs/providers/whisper.md
docs/decisions/0010-voice-service.md
packages/core/src/providers/types.ts  + TTSRequest/TTSProvider, AlignedWord/AlignRequest/CaptionAligner
packages/core/src/providers/registry.ts + 'tts', 'aligner'
packages/core/src/config/env.ts       ADFORGE_PROVIDER_TTS=chatterbox, ADFORGE_PROVIDER_ALIGNER=whisper, ADFORGE_VOICE_URL
packages/core/src/config/pipeline.ts  + voice, composite
packages/core/src/spec/align-script.ts  alignScript()
packages/core/src/spec/build-spec.ts    buildSpec()
packages/core/test/align-script.test.ts, test/build-spec.test.ts (+ golden)
packages/providers/voice-service/
  package.json, tsconfig.json
  src/client.ts       VoiceClient (HTTP, schemas, deadline)
  src/params.ts       voiceParams(emotion, language) → service body (pure)
  src/providers.ts    ChatterboxTTS, WhisperAligner, createVoiceProviders
  src/index.ts, src/e2e.ts, src/record-fixtures.ts
  fixtures/synthesize.live.json, fixtures/align.live.json
  test/*.test.ts, test/golden/*.json
packages/providers/comfyui/src/{client,providers}.ts   + free()
```

---

### Task 1: Python voice service

**Files:**
- Create: `services/voice/pyproject.toml`, `services/voice/.python-version`, `services/voice/app.py`, `services/voice/voice_core.py`, `services/voice/conftest.py`, `services/voice/tests/test_core.py`, `services/voice/tests/test_live.py`, `services/voice/uv.lock` (generated)
- Create: `scripts/voice.ps1`, `docs/providers/chatterbox.md`, `docs/providers/whisper.md`, `docs/decisions/0010-voice-service.md`
- Modify: `.gitignore` (`services/voice/.venv/`)

**Interfaces (HTTP, consumed by Task 2):**
- `GET /health` → `{ ok: true, device: string, cuda: boolean, sm120: boolean, loaded: { tts: boolean, whisper: boolean } }`
- `POST /synthesize` with JSON `{ text: string (1..500), language_id: 'en' | 'hi', exaggeration: number (0.25..2.0), cfg_weight: number (0..1) }` → 200 `audio/wav` (16-bit PCM mono), with headers `X-Duration-Sec` (6 decimals) and `X-Sample-Rate`. 422 on a validation failure.
- `POST /align` with multipart `audio` (a WAV file) and `language` (`'en' | 'hi'`) → `{ text: string, words: { text: string, start: number, end: number }[] }`
- `POST /unload` → `{ unloaded: string[] }`

- [ ] **Step 1: Write the reference docs (fetched 2026-10-16)**

`docs/providers/chatterbox.md`:
```markdown
# Chatterbox Multilingual — provider reference

**Fetched:** 2026-10-16 from github.com/resemble-ai/chatterbox (README), huggingface.co/ResembleAI/chatterbox (model card) and PyPI `chatterbox-tts` 0.1.7.

- **License:** MIT. About 0.5B parameters. Outputs carry Resemble's **PerTh** watermark.
- **Load:** `from chatterbox.mtl_tts import ChatterboxMultilingualTTS`; `ChatterboxMultilingualTTS.from_pretrained(device="cuda", t3_model="v3")`. V3 is the recommended multilingual checkpoint.
- **Generate:** `model.generate(text, language_id="hi")`. It returns a waveform tensor at `model.sr`. Emotion is controlled with `exaggeration` (default 0.5) and `cfg_weight` (default 0.5); for expressive speech the README suggests `exaggeration` ≈ 0.7+ with `cfg_weight` ≈ 0.3.
- **Language ids:** ar da de el **en** es fi fr he **hi** it ja ko ms nl no pl pt ru sv sw tr zh. There is no Hinglish id; for Latin-script Hindi we send `hi` (or `en`), configurable in `PIPELINE.voice.hinglishTtsLanguage`.
- **Python:** developed on 3.11. 0.1.7 pins `torch==2.6.0` below Python 3.14; torch 2.6 lacks Blackwell (sm_120) kernels, so AdForge overrides torch via uv (ADR 0010).
- **Not documented:** VRAM use, and Windows support.
```

`docs/providers/whisper.md`:
```markdown
# openai-whisper — provider reference

**Pinned:** `openai-whisper` 20250625 (MIT). It runs on our torch, so there is no extra runtime.
- `whisper.load_model("small", device="cuda")`. `small` is multilingual (~460 MB) and covers en and hi.
- `model.transcribe(audio: np.ndarray float32 @ 16 kHz mono, language="hi", word_timestamps=True, fp16=True, condition_on_previous_text=False)` → `{ text, segments: [{ words: [{ word, start, end, probability }] }] }`.
- **Word timestamps come from cross-attention DTW.** They are good to ~±50–100 ms, which is enough for word-by-word captions at 30 fps.
- **Dependencies:** `numba` (Python 3.13 is supported), `tiktoken`, `torch`.
```

- [ ] **Step 2: Create the uv project**

`services/voice/.python-version`:
```
3.13
```

`services/voice/pyproject.toml`:
```toml
[project]
name = "adforge-voice"
version = "0.1.0"
description = "AdForge local voice service: Chatterbox Multilingual TTS + Whisper word alignment"
requires-python = "==3.13.*"
dependencies = [
  "chatterbox-tts==0.1.7",
  "openai-whisper==20250625",
  "fastapi==0.142.2",
  "uvicorn==0.54.0",
  "python-multipart==PIN",
  "torch==2.12.1",
  "torchaudio==2.11.0",
]

[dependency-groups]
dev = ["pytest==PIN", "httpx==PIN"]

[tool.uv]
# chatterbox-tts 0.1.7 pins torch==2.6.0 (no sm_120 kernels for the RTX 5070 Ti). Use the build ComfyUI already runs on this GPU.
override-dependencies = ["torch==2.12.1", "torchaudio==2.11.0"]

[[tool.uv.index]]
name = "pytorch-cu130"
url = "https://download.pytorch.org/whl/cu130"
explicit = true

[tool.uv.sources]
torch = { index = "pytorch-cu130" }
torchaudio = { index = "pytorch-cu130" }
```
Replace each `PIN` with the newest release published at least 14 days before today (check PyPI's release dates). List the chosen versions in the report; this is the same release-age rule as npm.

Run from `services/voice`: `uv sync`
Expected: creates `.venv` with Python 3.13 and resolves with torch `2.12.1+cu130`. If resolution fails on a Chatterbox transitive dependency under 3.13, follow the **fallback**: set `requires-python = "==3.11.*"` and `.python-version` to `3.11`, keep the overrides, run `uv sync` again, and record which dependency forced it.

Then the GPU smoke test (CLAUDE.md: fail fast on the toolchain):
```powershell
cd services/voice; uv run python -c "import torch; print(torch.__version__, torch.cuda.is_available(), 'sm_120' in torch.cuda.get_arch_list())"
```
Expected: `2.12.1+cu130 True True`. If `False`, stop and report; nothing else in P6 can work.

Append to `.gitignore`: `services/voice/.venv/`.

- [ ] **Step 3: Write the failing Python unit tests**

`services/voice/conftest.py`:
```python
import pytest

def pytest_addoption(parser):
    parser.addoption("--live", action="store_true", help="run tests that load models on the GPU")

def pytest_collection_modifyitems(config, items):
    if config.getoption("--live"):
        return
    skip = pytest.mark.skip(reason="needs --live (GPU + model download)")
    for item in items:
        if "live" in item.keywords:
            item.add_marker(skip)
```

`services/voice/tests/test_core.py`:
```python
import threading
import numpy as np
from voice_core import ModelSlot, decode_wav, encode_wav


def test_wav_round_trip_preserves_rate_and_duration():
    sr = 24000
    samples = np.sin(np.linspace(0, 2 * np.pi * 220, sr // 2)).astype(np.float32) * 0.5
    data = encode_wav(samples, sr)
    out, out_sr = decode_wav(data)
    assert out_sr == sr
    assert len(out) == len(samples)
    assert np.max(np.abs(out - samples)) < 1e-3
    assert data[:4] == b"RIFF"


def test_encode_clips_out_of_range_samples():
    data = encode_wav(np.array([2.0, -2.0], dtype=np.float32), 16000)
    out, _ = decode_wav(data)
    assert out.max() <= 1.0 and out.min() >= -1.0


def test_model_slot_loads_lazily_once_and_unloads():
    calls = []
    slot = ModelSlot("m", lambda: calls.append(1) or object())
    assert not slot.loaded
    a = slot.get()
    b = slot.get()
    assert a is b and calls == [1]
    assert slot.unload() is True
    assert not slot.loaded and slot.unload() is False


def test_model_slot_idle_time_resets_on_use():
    slot = ModelSlot("m", object)
    assert slot.idle_for() == 0.0  # never loaded → never idle-evicted
    slot.get()
    assert 0.0 <= slot.idle_for() < 1.0


def test_model_slot_is_thread_safe_under_concurrent_get():
    calls = []
    slot = ModelSlot("m", lambda: calls.append(1) or object())
    threads = [threading.Thread(target=slot.get) for _ in range(8)]
    for t in threads:
        t.start()
    for t in threads:
        t.join()
    assert calls == [1]
```

`services/voice/tests/test_live.py`:
```python
import pytest
from fastapi.testclient import TestClient


@pytest.mark.live
def test_synthesize_then_align_round_trip():
    from app import app
    c = TestClient(app)
    r = c.post("/synthesize", json={"text": "Nobody tells you how oil is made.", "language_id": "en", "exaggeration": 0.5, "cfg_weight": 0.5})
    assert r.status_code == 200 and r.headers["content-type"] == "audio/wav"
    assert float(r.headers["x-duration-sec"]) > 0.5
    a = c.post("/align", files={"audio": ("v.wav", r.content, "audio/wav")}, data={"language": "en"})
    assert a.status_code == 200
    words = a.json()["words"]
    assert len(words) >= 5 and all(w["end"] >= w["start"] for w in words)
    assert c.post("/unload").json()["unloaded"]
```

Run from `services/voice`: `uv run pytest -q`
Expected: FAIL (`voice_core` missing).

- [ ] **Step 4: Implement `voice_core.py`**

`services/voice/voice_core.py`:
```python
"""Pure helpers for the voice service: lazy model slots and stdlib WAV I/O (no torchaudio/torchcodec I/O)."""
import io
import threading
import time
import wave
from typing import Any, Callable

import numpy as np


class ModelSlot:
    """Lazily loads one model on first use; tracks idle time so a janitor can unload it."""

    def __init__(self, name: str, loader: Callable[[], Any]):
        self.name = name
        self._loader = loader
        self._model: Any = None
        self._last_used = 0.0
        self._lock = threading.Lock()

    @property
    def loaded(self) -> bool:
        return self._model is not None

    def get(self) -> Any:
        with self._lock:
            if self._model is None:
                self._model = self._loader()
            self._last_used = time.monotonic()
            return self._model

    def idle_for(self) -> float:
        """Seconds since last use; 0.0 when not loaded (nothing to evict)."""
        with self._lock:
            return 0.0 if self._model is None else time.monotonic() - self._last_used

    def unload(self) -> bool:
        with self._lock:
            if self._model is None:
                return False
            self._model = None
            return True


def encode_wav(samples: np.ndarray, sample_rate: int) -> bytes:
    """float32 mono [-1, 1] → 16-bit PCM WAV bytes."""
    pcm = (np.clip(samples.astype(np.float32).reshape(-1), -1.0, 1.0) * 32767.0).astype("<i2")
    buf = io.BytesIO()
    with wave.open(buf, "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(sample_rate)
        w.writeframes(pcm.tobytes())
    return buf.getvalue()


def decode_wav(data: bytes) -> tuple[np.ndarray, int]:
    """16-bit PCM WAV (mono or stereo, mixed down) → float32 mono [-1, 1], sample rate."""
    with wave.open(io.BytesIO(data), "rb") as w:
        if w.getsampwidth() != 2:
            raise ValueError("expected 16-bit PCM WAV")
        channels, rate, frames = w.getnchannels(), w.getframerate(), w.readframes(w.getnframes())
    pcm = np.frombuffer(frames, dtype="<i2").astype(np.float32) / 32767.0
    if channels > 1:
        pcm = pcm.reshape(-1, channels).mean(axis=1)
    return pcm, rate
```

Run: `uv run pytest -q` → the 5 unit tests PASS and the live test is skipped.

- [ ] **Step 5: Implement `app.py`**

`services/voice/app.py`:
```python
"""AdForge voice service — Chatterbox Multilingual TTS + Whisper word alignment on the local GPU.

Liveness: one GPU job at a time (lock); each model lazy-loads and is unloaded after VOICE_IDLE_TTL_S idle;
POST /unload frees both on demand so the pipeline can hand VRAM back to ComfyUI.
"""
import os
import threading
import time
from typing import Literal

import numpy as np
import torch
import torchaudio.functional as AF
from fastapi import FastAPI, File, Form, UploadFile
from fastapi.responses import Response
from pydantic import BaseModel, Field

from voice_core import ModelSlot, decode_wav, encode_wav

DEVICE = os.environ.get("VOICE_DEVICE", "cuda")
IDLE_TTL_S = float(os.environ.get("VOICE_IDLE_TTL_S", "120"))
WHISPER_MODEL = os.environ.get("VOICE_WHISPER_MODEL", "small")

gpu = threading.Lock()


def _load_tts():
    from chatterbox.mtl_tts import ChatterboxMultilingualTTS

    return ChatterboxMultilingualTTS.from_pretrained(device=DEVICE, t3_model="v3")


def _load_whisper():
    import whisper

    return whisper.load_model(WHISPER_MODEL, device=DEVICE)


tts = ModelSlot("tts", _load_tts)
asr = ModelSlot("whisper", _load_whisper)


def _free(slots) -> list[str]:
    freed = [s.name for s in slots if s.unload()]
    if freed and torch.cuda.is_available():
        torch.cuda.empty_cache()
    return freed


def _janitor() -> None:
    while True:
        time.sleep(5)
        idle = [s for s in (tts, asr) if s.idle_for() > IDLE_TTL_S]
        if idle:
            with gpu:
                _free(idle)


threading.Thread(target=_janitor, name="idle-janitor", daemon=True).start()
app = FastAPI(title="adforge-voice")


class SynthReq(BaseModel):
    text: str = Field(min_length=1, max_length=500)
    language_id: Literal["en", "hi"]
    exaggeration: float = Field(ge=0.25, le=2.0)
    cfg_weight: float = Field(ge=0.0, le=1.0)


@app.get("/health")
def health():
    cuda = torch.cuda.is_available()
    return {
        "ok": True,
        "device": DEVICE,
        "cuda": cuda,
        "sm120": cuda and "sm_120" in torch.cuda.get_arch_list(),
        "loaded": {"tts": tts.loaded, "whisper": asr.loaded},
    }


@app.post("/synthesize")
def synthesize(req: SynthReq):
    with gpu:
        model = tts.get()
        wav = model.generate(req.text, language_id=req.language_id, exaggeration=req.exaggeration, cfg_weight=req.cfg_weight)
        samples = wav.detach().float().cpu().numpy().reshape(-1)
        sr = int(model.sr)
    return Response(
        encode_wav(samples, sr),
        media_type="audio/wav",
        headers={"X-Duration-Sec": f"{len(samples) / sr:.6f}", "X-Sample-Rate": str(sr)},
    )


@app.post("/align")
async def align(audio: UploadFile = File(...), language: Literal["en", "hi"] = Form(...)):
    samples, sr = decode_wav(await audio.read())
    if sr != 16000:
        samples = AF.resample(torch.from_numpy(samples), sr, 16000).numpy()
    with gpu:
        model = asr.get()
        result = model.transcribe(
            samples.astype(np.float32),
            language=language,
            word_timestamps=True,
            fp16=DEVICE == "cuda",
            condition_on_previous_text=False,
        )
    words = [
        {"text": w["word"].strip(), "start": float(w["start"]), "end": float(w["end"])}
        for seg in result.get("segments", [])
        for w in seg.get("words", [])
        if w["word"].strip()
    ]
    return {"text": result.get("text", "").strip(), "words": words}


@app.post("/unload")
def unload():
    with gpu:
        return {"unloaded": _free((tts, asr))}
```

If the installed `ChatterboxMultilingualTTS.generate` signature (read `.venv/Lib/site-packages/chatterbox/mtl_tts.py`) names `exaggeration` / `cfg_weight` differently, use the real names and report them.

`scripts/voice.ps1`:
```powershell
# Starts the AdForge voice service (Chatterbox + Whisper) on 127.0.0.1:8190. Models load on first request
# and unload after VOICE_IDLE_TTL_S seconds idle (default 120).
param([int]$Port = 8190)
Push-Location "$PSScriptRoot\..\services\voice"
try { uv run uvicorn app:app --host 127.0.0.1 --port $Port --timeout-keep-alive 5 }
finally { Pop-Location }
```

- [ ] **Step 6: Run the unit tests, then the live test once**

Run: `uv run pytest -q` → unit tests PASS.
Run: `uv run pytest -q --live`
Expected: PASS. The first run downloads the Chatterbox v3 and Whisper small weights (several GB, under the user's HF cache). Report:
- the synth time for the sentence;
- the align time;
- peak VRAM (`nvidia-smi` during the run);
- `/health` after `/unload` (both `loaded` flags false).

- [ ] **Step 7: Write ADR 0010, then commit**

`docs/decisions/0010-voice-service.md`:
```markdown
# 0010 — Local Python voice service (Chatterbox + Whisper)

**Status:** accepted · 2026-10-16 · amends spec §11 (Whisper placement) and the P6 roadmap

## Decision
- **Exception to "TypeScript end-to-end":** Chatterbox and openai-whisper are Python/torch only. They run in **one** local FastAPI service (`services/voice`, uv-managed, Python 3.13) behind the TypeScript `TTSProvider` and `CaptionAligner` interfaces. No provider shape crosses into Node.
- **Blackwell:** `chatterbox-tts` 0.1.7 pins torch 2.6.0, which has no sm_120 kernels. uv `override-dependencies` installs torch 2.12.1 / torchaudio 2.11.0 from the cu130 index, the same build ComfyUI runs on this GPU.
- **Whisper is in the same service,** not transformers.js in Node. It uses the same torch, needs no audio resampling in Node, and has proven multilingual DTW word timestamps. Captions show the **script's** words, re-timed onto Whisper's word timings by `alignScript` in core.
- **WAV I/O uses the stdlib `wave` module.** torchaudio's file I/O moved to torchcodec in recent releases.
- **Liveness:** a GPU lock, lazy model slots, an idle TTL unload (`VOICE_IDLE_TTL_S`, default 120 s), `POST /unload` and `GET /health`.

## Measured
[FILL IN from Task 1 Step 6: synth s, align s, peak VRAM, health after unload]

## Consequences
- The pipeline must serialize voice work with ComfyUI on the GPU (P7 heavy lane) and free ComfyUI before a voice batch.
- Swapping to a hosted TTS later is a new `TTSProvider` adapter. The service stays for alignment, or Whisper moves too.
```
Fill in the measured line before committing.

```bash
git add services/voice scripts/voice.ps1 docs/providers/chatterbox.md docs/providers/whisper.md docs/decisions/0010-voice-service.md .gitignore
git commit -m "feat(voice): local Chatterbox + Whisper service with idle unload, GPU lock and health"
```

---

### Task 2: Node voice adapter + core types + config

**Files:**
- Modify: `packages/core/src/providers/types.ts`, `packages/core/src/providers/registry.ts`, `packages/core/src/config/env.ts`, `packages/core/test/env.test.ts`, `packages/core/src/config/pipeline.ts`, `.env.example`
- Create: `packages/providers/voice-service/{package.json,tsconfig.json}`, `src/client.ts`, `src/params.ts`, `src/providers.ts`, `src/index.ts`, `src/record-fixtures.ts`
- Create: `packages/providers/voice-service/fixtures/synthesize.live.json`, `fixtures/align.live.json` (recorded in Step 6)
- Test: `packages/providers/voice-service/test/voice.test.ts` (+ `test/golden/synthesize-body.json`)

**Interfaces:**
- Produces (core types):
  ```ts
  export interface TTSRequest { text: string; language: Language; emotion: number; idempotencyKey: string }
  export interface TTSProvider { readonly id: string; synthesize(req: TTSRequest): Promise<ProviderResult<MediaRef>> }
  export interface AlignedWord { text: string; startSec: number; endSec: number }
  export interface AlignRequest { audio: MediaRef; text: string; language: Language; idempotencyKey: string }
  export interface CaptionAligner { readonly id: string; align(req: AlignRequest): Promise<ProviderResult<{ words: AlignedWord[] }>> }
  ```
  (Use `import type { Language } from '../vocab/enums'`.) `ProviderKind` gains `tts: TTSProvider` and `aligner: CaptionAligner`.
- Produces (env):
  - `ADFORGE_PROVIDER_TTS: z.enum(['chatterbox']).default('chatterbox')`, which replaces `kokoro`;
  - `ADFORGE_PROVIDER_ALIGNER: z.enum(['whisper']).default('whisper')`;
  - `ADFORGE_VOICE_URL` (http(s) URL, default `http://127.0.0.1:8190`, trailing slash stripped).
  - `ADFORGE_TTS_VOICE` is **removed** (built-in default voice).
- Produces (`PIPELINE`):
  ```ts
  voice: { exaggeration: [0.3, 0.9], cfgWeight: 0.5, expressiveCfgWeight: 0.3, expressiveAbove: 0.7,
           hinglishTtsLanguage: 'hi', hinglishAsrLanguage: 'hi', requestTimeoutMs: 120_000 },
  composite: { hero: { anchorX: 0.5, anchorY: 0.84, heightFrac: 0.46 }, supporting: { anchorX: 0.72, anchorY: 0.9, heightFrac: 0.3 } },
  ```
  The schema uses `Range` for `exaggeration` and `z.enum(['en','hi'])` for the two Hinglish ids.
- Produces (`packages/providers/voice-service`):
  - `voiceParams(text, language, emotion, cfg?) → { text, language_id: 'en'|'hi', exaggeration, cfg_weight }`. Exaggeration is linear across the configured range; `cfg_weight = emotion > expressiveAbove ? expressiveCfgWeight : cfgWeight`.
  - `asrLanguage(language, cfg?) → 'en'|'hi'`
  - `class VoiceClient(baseUrl, fetchImpl?, timeoutMs?)` with `health()`, `synthesize(body)` → `{ bytes: Uint8Array; durationSec: number }`, `align(wav, language)` → `{ text, words: { text, start, end }[] }`, and `unload()`
  - `createVoiceProviders({ baseUrl, storage, fetchImpl?, timeoutMs? }) → { tts: TTSProvider; aligner: CaptionAligner; health(); unload() }`

- [ ] **Step 1: Core types, registry, env, config**

Apply the Interfaces block above.
- In `env.ts`, replace the `ADFORGE_PROVIDER_TTS` line, delete `ADFORGE_TTS_VOICE`, and add `ADFORGE_PROVIDER_ALIGNER` plus `ADFORGE_VOICE_URL: z.url({ protocol: /^https?$/ }).default('http://127.0.0.1:8190').transform((u) => u.replace(/\/+$/, '')),`.
- In `.env.example`, replace the `# TTS` block with:
  ```bash
  # Voice (Chatterbox + Whisper service, scripts/voice.ps1)
  ADFORGE_PROVIDER_TTS=chatterbox
  ADFORGE_PROVIDER_ALIGNER=whisper
  ADFORGE_VOICE_URL=http://127.0.0.1:8190
  ```
- Add to `packages/core/test/env.test.ts`, inside `describe('parseEnv')`:
  ```ts
  it('defaults the voice providers and URL', () => {
    const env = parseEnv({});
    expect(env.ADFORGE_PROVIDER_TTS).toBe('chatterbox');
    expect(env.ADFORGE_PROVIDER_ALIGNER).toBe('whisper');
    expect(env.ADFORGE_VOICE_URL).toBe('http://127.0.0.1:8190');
    expect(() => parseEnv({ ADFORGE_PROVIDER_TTS: 'kokoro' })).toThrow(/ADFORGE_PROVIDER_TTS/);
  });
  ```

Run: `pnpm --filter @adforge/core test` → PASS.

- [ ] **Step 2: Create the package**

`packages/providers/voice-service/package.json`:
```json
{
  "name": "@adforge/provider-voice-service",
  "private": true,
  "type": "module",
  "exports": { ".": "./src/index.ts" },
  "scripts": {
    "test": "vitest run",
    "typecheck": "tsc -p .",
    "record": "tsx src/record-fixtures.ts",
    "e2e": "tsx src/e2e.ts"
  },
  "dependencies": { "@adforge/core": "workspace:*", "zod": "catalog:" },
  "devDependencies": {
    "@adforge/provider-local-storage": "workspace:*",
    "@adforge/provider-comfyui": "workspace:*",
    "@adforge/renderer-hyperframes": "workspace:*",
    "vitest": "catalog:",
    "tsx": "catalog:",
    "typescript": "catalog:",
    "@types/node": "catalog:"
  }
}
```
`tsconfig.json`: `{ "extends": "../../../tsconfig.base.json", "include": ["src", "test"] }`. Run `pnpm install`.

- [ ] **Step 3: Write the failing test**

`packages/providers/voice-service/test/voice.test.ts`:
```ts
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { ProviderError } from '@adforge/core/providers/types';
import { VoiceClient } from '../src/client';
import { asrLanguage, voiceParams } from '../src/params';
import { createVoiceProviders } from '../src/providers';

const BASE = 'http://127.0.0.1:8190';
const fixture = (n: string) => JSON.parse(readFileSync(new URL(`../fixtures/${n}`, import.meta.url), 'utf8'));
const json = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status, headers: { 'content-type': 'application/json' } });

function fake(routes: Record<string, (req: Request) => Response | Promise<Response>>) {
  const bodies: Record<string, unknown> = {};
  const f = (async (input: string | Request | URL, init?: RequestInit) => {
    const req = new Request(input, init);
    const key = `${req.method} ${new URL(req.url).pathname}`;
    if (req.headers.get('content-type')?.includes('json')) bodies[key] = await req.clone().json();
    if (!routes[key]) throw new Error(`unrouted ${key}`);
    return routes[key]!(req);
  }) as typeof fetch;
  return Object.assign(f, { bodies });
}

function memStorage() {
  const files = new Map<string, Uint8Array>();
  return {
    id: 'mem',
    files,
    async put(bytes: Uint8Array, opts: { mime: string; durationSec?: number }) {
      const id = `ab/${'a'.repeat(63)}${files.size}.wav`;
      files.set(id, bytes);
      return { id, url: `http://localhost:3000/media/${id}`, mime: opts.mime, sha256: 'x', bytes: bytes.length, durationSec: opts.durationSec };
    },
    async read(key: string) {
      return files.get(key)!;
    },
  };
}

describe('voiceParams', () => {
  it('maps emotion linearly onto the exaggeration range and lowers cfg when expressive', () => {
    expect(voiceParams('hi there', 'en', 0)).toEqual({ text: 'hi there', language_id: 'en', exaggeration: 0.3, cfg_weight: 0.5 });
    expect(voiceParams('x', 'en', 1)).toMatchObject({ exaggeration: 0.9, cfg_weight: 0.3 });
    expect(voiceParams('x', 'en', 0.5).exaggeration).toBeCloseTo(0.6, 6);
  });
  it('routes Hinglish through the configured TTS and ASR language ids', () => {
    expect(voiceParams('Bilkul sahi', 'hinglish', 0.5).language_id).toBe('hi');
    expect(asrLanguage('hinglish')).toBe('hi');
    expect(asrLanguage('en')).toBe('en');
  });
  it('produces the golden request body', async () => {
    await expect(JSON.stringify(voiceParams('Nobody tells you how oil is made.', 'en', 0.6), null, 2) + '\n').toMatchFileSnapshot('./golden/synthesize-body.json');
  });
});

describe('VoiceClient', () => {
  it('returns WAV bytes and the duration header', async () => {
    const live = fixture('synthesize.live.json');
    const f = fake({ 'POST /synthesize': () => new Response(new Uint8Array([82, 73, 70, 70]), { headers: { 'content-type': 'audio/wav', 'x-duration-sec': live.durationSec } }) });
    const r = await new VoiceClient(BASE, f).synthesize(voiceParams('x', 'en', 0.5));
    expect(r.durationSec).toBeCloseTo(Number(live.durationSec), 6);
    expect(r.bytes.length).toBe(4);
  });

  it('parses the recorded live alignment', async () => {
    const f = fake({ 'POST /align': () => json(fixture('align.live.json')) });
    const r = await new VoiceClient(BASE, f).align(new Uint8Array([1]), 'en');
    expect(r.words.length).toBeGreaterThan(3);
    expect(r.words.every((w) => w.end >= w.start)).toBe(true);
  });

  it('maps a 422 to INVALID_INPUT (our schema was wrong)', async () => {
    const f = fake({ 'POST /synthesize': () => json({ detail: [{ msg: 'too long' }] }, 422) });
    const err = await new VoiceClient(BASE, f).synthesize(voiceParams('x', 'en', 0.5)).catch((e: unknown) => e);
    expect((err as ProviderError).code).toBe('INVALID_INPUT');
  });

  it('times out a hung service as a retryable TIMEOUT', async () => {
    const hung = ((_: unknown, init?: RequestInit) =>
      new Promise((_r, reject) => init?.signal?.addEventListener('abort', () => reject(init.signal!.reason)))) as typeof fetch;
    const err = await new VoiceClient(BASE, hung, 25).synthesize(voiceParams('x', 'en', 0.5)).catch((e: unknown) => e);
    expect((err as ProviderError).code).toBe('TIMEOUT');
  });
});

describe('createVoiceProviders', () => {
  it('stores synthesized audio with its measured duration', async () => {
    const storage = memStorage();
    const f = fake({ 'POST /synthesize': () => new Response(new Uint8Array([1, 2]), { headers: { 'x-duration-sec': '2.500000' } }) });
    const { tts } = createVoiceProviders({ baseUrl: BASE, storage, fetchImpl: f });
    const r = await tts.synthesize({ text: 'hello', language: 'en', emotion: 0.4, idempotencyKey: 'k' });
    expect(r.status === 'done' && r.value).toMatchObject({ mime: 'audio/wav', durationSec: 2.5 });
    expect(f.bodies['POST /synthesize']).toMatchObject({ language_id: 'en' });
  });

  it('rejects an invalid TTS request before dispatch', async () => {
    const f = fake({});
    const { tts } = createVoiceProviders({ baseUrl: BASE, storage: memStorage(), fetchImpl: f });
    const r = await tts.synthesize({ text: 'x'.repeat(501), language: 'en', emotion: 0.4, idempotencyKey: 'k' });
    expect(r.status === 'failed' && r.error.code).toBe('INVALID_INPUT');
  });

  it('aligns stored audio and converts to AlignedWord seconds', async () => {
    const storage = memStorage();
    const ref = await storage.put(new Uint8Array([9]), { mime: 'audio/wav' });
    const f = fake({ 'POST /align': () => json({ text: 'a b', words: [{ text: 'a', start: 0.1, end: 0.3 }, { text: 'b', start: 0.3, end: 0.6 }] }) });
    const { aligner } = createVoiceProviders({ baseUrl: BASE, storage, fetchImpl: f });
    const r = await aligner.align({ audio: ref, text: 'a b', language: 'en', idempotencyKey: 'k' });
    expect(r.status === 'done' && r.value.words).toEqual([{ text: 'a', startSec: 0.1, endSec: 0.3 }, { text: 'b', startSec: 0.3, endSec: 0.6 }]);
  });
});
```

Run: `pnpm --filter @adforge/provider-voice-service test` → FAIL (modules missing; the live fixtures are recorded in Step 6).

- [ ] **Step 4: Implement params and client**

`packages/providers/voice-service/src/params.ts`:
```ts
import { PIPELINE, type PipelineConfig } from '@adforge/core/config/pipeline';
import type { Language } from '@adforge/core/vocab/enums';

export type SynthBody = { text: string; language_id: 'en' | 'hi'; exaggeration: number; cfg_weight: number };

const ttsLanguage = (l: Language, cfg: PipelineConfig) => (l === 'hinglish' ? cfg.voice.hinglishTtsLanguage : l);
export const asrLanguage = (l: Language, cfg: PipelineConfig = PIPELINE): 'en' | 'hi' => (l === 'hinglish' ? cfg.voice.hinglishAsrLanguage : l);

/** Director emotion (0..1) → Chatterbox controls. Expressive lines get a lower cfg weight (Chatterbox README tip). */
export function voiceParams(text: string, language: Language, emotion: number, cfg: PipelineConfig = PIPELINE): SynthBody {
  const [lo, hi] = cfg.voice.exaggeration;
  const e = Math.min(1, Math.max(0, emotion));
  return {
    text,
    language_id: ttsLanguage(language, cfg),
    exaggeration: Number((lo + e * (hi - lo)).toFixed(6)),
    cfg_weight: e > cfg.voice.expressiveAbove ? cfg.voice.expressiveCfgWeight : cfg.voice.cfgWeight,
  };
}
```

`packages/providers/voice-service/src/client.ts`:
```ts
import { z } from 'zod';
import { ProviderError } from '@adforge/core/providers/types';
import type { SynthBody } from './params';

const P = 'voice-service';
const Health = z.object({ ok: z.boolean(), device: z.string(), cuda: z.boolean(), sm120: z.boolean(), loaded: z.object({ tts: z.boolean(), whisper: z.boolean() }) });
const Aligned = z.object({ text: z.string(), words: z.array(z.object({ text: z.string(), start: z.number(), end: z.number() })) });
const Unloaded = z.object({ unloaded: z.array(z.string()) });

export class VoiceClient {
  private readonly baseUrl: string;
  constructor(baseUrl: string, private readonly fetchImpl: typeof fetch = fetch, private readonly timeoutMs = 120_000) {
    this.baseUrl = baseUrl.replace(/\/+$/, '');
  }

  async #request(path: string, init?: RequestInit): Promise<Response> {
    try {
      const res = await this.fetchImpl(`${this.baseUrl}${path}`, { ...init, signal: AbortSignal.timeout(this.timeoutMs) });
      if (res.status === 422) throw new ProviderError(P, 'INVALID_INPUT', `voice service rejected ${path}: ${await res.text()}`);
      if (!res.ok) throw new ProviderError(P, 'UPSTREAM', `${init?.method ?? 'GET'} ${path} -> HTTP ${res.status}`);
      return res;
    } catch (e) {
      if (e instanceof ProviderError) throw e;
      if ((e as Error).name === 'TimeoutError') throw new ProviderError(P, 'TIMEOUT', `voice service ${path} timed out after ${this.timeoutMs}ms`, e);
      throw new ProviderError(P, 'UPSTREAM', `voice service unreachable at ${this.baseUrl}: ${(e as Error).message}`, e);
    }
  }

  async #json<T>(path: string, schema: z.ZodType<T>, init?: RequestInit): Promise<T> {
    const res = await this.#request(path, init);
    const parsed = schema.safeParse(await res.json().catch(() => null));
    if (!parsed.success) throw new ProviderError(P, 'UPSTREAM', `unexpected ${path} response: ${z.prettifyError(parsed.error)}`);
    return parsed.data;
  }

  health() {
    return this.#json('/health', Health);
  }

  async synthesize(body: SynthBody): Promise<{ bytes: Uint8Array; durationSec: number }> {
    const res = await this.#request('/synthesize', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    const durationSec = Number(res.headers.get('x-duration-sec'));
    if (!Number.isFinite(durationSec) || durationSec <= 0) throw new ProviderError(P, 'UPSTREAM', 'voice service returned no X-Duration-Sec');
    return { bytes: new Uint8Array(await res.arrayBuffer()), durationSec };
  }

  align(wav: Uint8Array, language: 'en' | 'hi') {
    const form = new FormData();
    form.append('audio', new Blob([new Uint8Array(wav)], { type: 'audio/wav' }), 'voice.wav');
    form.append('language', language);
    return this.#json('/align', Aligned, { method: 'POST', body: form });
  }

  unload() {
    return this.#json('/unload', Unloaded, { method: 'POST' });
  }
}
```

- [ ] **Step 5: Implement providers**

`packages/providers/voice-service/src/providers.ts`:
```ts
import { z } from 'zod';
import {
  ProviderError,
  isRetryable,
  type CaptionAligner,
  type ProviderResult,
  type StorageProvider,
  type TTSProvider,
} from '@adforge/core/providers/types';
import { PIPELINE } from '@adforge/core/config/pipeline';
import { Language } from '@adforge/core/vocab/enums';
import { VoiceClient } from './client';
import { asrLanguage, voiceParams } from './params';

const TtsReq = z.object({ text: z.string().min(1).max(500), language: Language, emotion: z.number().min(0).max(1), idempotencyKey: z.string().min(1) });

const asFailed = (e: unknown): ProviderResult<never> => {
  if (e instanceof ProviderError) return { status: 'failed', error: e, retryable: isRetryable(e.code) };
  throw e;
};

export function createVoiceProviders(o: { baseUrl: string; storage: StorageProvider; fetchImpl?: typeof fetch; timeoutMs?: number }) {
  const client = new VoiceClient(o.baseUrl, o.fetchImpl, o.timeoutMs ?? PIPELINE.voice.requestTimeoutMs);

  const tts: TTSProvider = {
    id: 'chatterbox',
    async synthesize(req) {
      const parsed = TtsReq.safeParse(req);
      if (!parsed.success) return { status: 'failed', error: new ProviderError('chatterbox', 'INVALID_INPUT', z.prettifyError(parsed.error)), retryable: false };
      const started = Date.now();
      try {
        const { bytes, durationSec } = await client.synthesize(voiceParams(req.text, req.language, req.emotion));
        const ref = await o.storage.put(bytes, { mime: 'audio/wav', durationSec });
        return { status: 'done', value: ref, cost: { amountUsd: 0, estimated: false }, latencyMs: Date.now() - started };
      } catch (e) {
        return asFailed(e);
      }
    },
  };

  const aligner: CaptionAligner = {
    id: 'whisper',
    async align(req) {
      const started = Date.now();
      try {
        const r = await client.align(await o.storage.read(req.audio.id), asrLanguage(req.language));
        return {
          status: 'done',
          value: { words: r.words.map((w) => ({ text: w.text, startSec: w.start, endSec: w.end })) },
          cost: { amountUsd: 0, estimated: false },
          latencyMs: Date.now() - started,
        };
      } catch (e) {
        return asFailed(e);
      }
    },
  };

  return { tts, aligner, health: () => client.health(), unload: () => client.unload() };
}
```

`packages/providers/voice-service/src/index.ts`:
```ts
export { createVoiceProviders } from './providers';
export { voiceParams, asrLanguage } from './params';
```

- [ ] **Step 6: Record live fixtures (CLAUDE.md provider rule)**

`packages/providers/voice-service/src/record-fixtures.ts`:
```ts
import { writeFileSync } from 'node:fs';
import { VoiceClient } from './client';
import { voiceParams } from './params';

const c = new VoiceClient(process.env.ADFORGE_VOICE_URL ?? 'http://127.0.0.1:8190', fetch, 300_000);
console.log(await c.health());
const s = await c.synthesize(voiceParams('Nobody tells you how your cooking oil is made.', 'en', 0.6));
writeFileSync(new URL('../fixtures/synthesize.live.json', import.meta.url), JSON.stringify({ durationSec: s.durationSec.toFixed(6), bytes: s.bytes.length }, null, 2) + '\n');
const a = await c.align(s.bytes, 'en');
writeFileSync(new URL('../fixtures/align.live.json', import.meta.url), JSON.stringify(a, null, 2) + '\n');
console.log('recorded', s.durationSec, a.words.length, await c.unload());
```
With the service running (`powershell -ExecutionPolicy Bypass -File scripts/voice.ps1`), run `pnpm --filter @adforge/provider-voice-service record`.
Expected: both fixtures are written, and `align.live.json` has about 9 words with increasing times.

- [ ] **Step 7: Run tests, then commit**

Run: `pnpm --filter @adforge/provider-voice-service test` (the golden is written on first run; inspect it: `language_id: "en"`, `exaggeration: 0.66`, `cfg_weight: 0.5`), then `pnpm test`.
Expected: all PASS.

```bash
git add packages/core packages/providers/voice-service .env.example pnpm-lock.yaml
git commit -m "feat(voice): TTS + aligner providers over the voice service with deadlines and recorded fixtures"
```

---

### Task 3: `alignScript` — script words onto ASR timings (pure)

**Files:**
- Create: `packages/core/src/spec/align-script.ts`
- Test: `packages/core/test/align-script.test.ts`

**Interfaces:**
- Consumes: `AlignedWord` (Task 2).
- Produces: `alignScript(script: string, asr: AlignedWord[], durationSec: number): AlignedWord[]`. It returns one entry per whitespace token of `script`, in order, with `0 ≤ startSec < endSec ≤ durationSec` and each start ≥ the previous end. The strategy:
  1. Normalize tokens (NFKC, lowercase, letters and digits only) and match script tokens to ASR words with a two-pointer, lookahead-3 scan.
  2. If at least 50% of script tokens matched, keep the matched timings and interpolate unmatched runs evenly between their matched neighbours.
  3. Otherwise (different script, heavy mishearing), use the **slot fallback**: distribute script tokens across the ASR speech span `[first.start, last.end]` in proportion to each token's character length.
  4. With no ASR words at all, distribute across `[0, durationSec]`.
  5. Finally clamp, and enforce monotonicity with a minimum word length of 0.05 s.

- [ ] **Step 1: Write the failing test**

`packages/core/test/align-script.test.ts`:
```ts
import { describe, expect, it } from 'vitest';
import { alignScript } from '../src/spec/align-script';

const w = (text: string, startSec: number, endSec: number) => ({ text, startSec, endSec });
const valid = (out: { startSec: number; endSec: number }[], dur: number) => {
  let prev = 0;
  for (const x of out) {
    expect(x.startSec).toBeGreaterThanOrEqual(prev - 1e-9);
    expect(x.endSec).toBeGreaterThan(x.startSec);
    expect(x.endSec).toBeLessThanOrEqual(dur + 1e-9);
    prev = x.endSec;
  }
};

describe('alignScript', () => {
  it('uses ASR timings for matched words, keeping the script text and punctuation', () => {
    const out = alignScript('Nobody tells you, okay?', [w('nobody', 0.1, 0.4), w('tells', 0.4, 0.7), w('you', 0.7, 0.9), w('okay', 1.0, 1.4)], 2);
    expect(out).toEqual([w('Nobody', 0.1, 0.4), w('tells', 0.4, 0.7), w('you,', 0.7, 0.9), w('okay?', 1.0, 1.4)]);
  });

  it('interpolates script words Whisper missed between matched neighbours', () => {
    const out = alignScript('one two three four', [w('one', 0, 0.5), w('four', 1.5, 2)], 2);
    expect(out.map((x) => x.text)).toEqual(['one', 'two', 'three', 'four']);
    expect(out[1]!.startSec).toBeCloseTo(0.5, 6);
    expect(out[2]!.endSec).toBeCloseTo(1.5, 6);
    valid(out, 2);
  });

  it('falls back to proportional slots across the speech span when scripts differ (Hinglish → Devanagari ASR)', () => {
    const out = alignScript('Bilkul sahi oil hai', [w('बिल्कुल', 0.2, 0.6), w('सही', 0.6, 0.9), w('ऑयल', 0.9, 1.3), w('है', 1.3, 1.5)], 2);
    expect(out.map((x) => x.text)).toEqual(['Bilkul', 'sahi', 'oil', 'hai']);
    expect(out[0]!.startSec).toBeCloseTo(0.2, 6);
    expect(out.at(-1)!.endSec).toBeCloseTo(1.5, 6);
    valid(out, 2);
  });

  it('matches Devanagari script against Devanagari ASR', () => {
    const out = alignScript('असली स्वाद', [w('असली', 0.1, 0.5), w('स्वाद', 0.5, 0.9)], 1);
    expect(out).toEqual([w('असली', 0.1, 0.5), w('स्वाद', 0.5, 0.9)]);
  });

  it('spreads words over the whole clip when ASR returned nothing', () => {
    const out = alignScript('a bb ccc', [], 1.2);
    expect(out[0]!.startSec).toBe(0);
    expect(out.at(-1)!.endSec).toBeCloseTo(1.2, 6);
    valid(out, 1.2);
  });

  it('clamps ASR timings that run past the clip and keeps words monotonic', () => {
    const out = alignScript('a b', [w('a', 0.5, 0.4), w('b', 0.3, 9)], 1);
    valid(out, 1);
  });

  it('returns nothing for an empty script', () => {
    expect(alignScript('   ', [w('x', 0, 1)], 1)).toEqual([]);
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `pnpm --filter @adforge/core test` → FAIL.

- [ ] **Step 3: Implement**

`packages/core/src/spec/align-script.ts`:
```ts
import type { AlignedWord } from '../providers/types';

const norm = (s: string) => s.normalize('NFKC').toLowerCase().replace(/[^\p{L}\p{N}]/gu, '');
const MIN_WORD = 0.05;

function proportional(tokens: string[], from: number, to: number): AlignedWord[] {
  const weights = tokens.map((t) => Math.max(1, [...t].length));
  const total = weights.reduce((a, b) => a + b, 0);
  let t = from;
  return tokens.map((text, i) => {
    const startSec = t;
    t += ((to - from) * weights[i]!) / total;
    return { text, startSec, endSec: t };
  });
}

/** Captions show the SCRIPT's words; Whisper only supplies the timing. Pure and deterministic. */
export function alignScript(script: string, asr: AlignedWord[], durationSec: number): AlignedWord[] {
  const tokens = script.trim().split(/\s+/).filter(Boolean);
  if (tokens.length === 0) return [];

  let out: AlignedWord[];
  if (asr.length === 0) {
    out = proportional(tokens, 0, durationSec);
  } else {
    const timing: ({ startSec: number; endSec: number } | null)[] = tokens.map(() => null);
    let j = 0;
    for (let i = 0; i < tokens.length && j < asr.length; i++) {
      const target = norm(tokens[i]!);
      for (let k = j; k < Math.min(asr.length, j + 4); k++) {
        if (target && norm(asr[k]!.text) === target) {
          timing[i] = { startSec: asr[k]!.startSec, endSec: asr[k]!.endSec };
          j = k + 1;
          break;
        }
      }
    }
    const matched = timing.filter(Boolean).length;
    if (matched / tokens.length >= 0.5) {
      out = [];
      for (let i = 0; i < tokens.length; ) {
        if (timing[i]) {
          out.push({ text: tokens[i]!, ...timing[i]! });
          i++;
          continue;
        }
        let end = i;
        while (end < tokens.length && !timing[end]) end++;
        const from = out.at(-1)?.endSec ?? 0;
        const to = end < tokens.length ? timing[end]!.startSec : durationSec;
        out.push(...proportional(tokens.slice(i, end), from, Math.max(from, to)));
        i = end;
      }
    } else {
      out = proportional(tokens, asr[0]!.startSec, asr.at(-1)!.endSec);
    }
  }

  // Clamp to the clip and enforce monotonic, non-empty words.
  let prev = 0;
  return out.map((x) => {
    const startSec = Math.min(Math.max(x.startSec, prev), Math.max(0, durationSec - MIN_WORD));
    const endSec = Math.min(durationSec, Math.max(x.endSec, startSec + MIN_WORD));
    prev = endSec;
    return { text: x.text, startSec, endSec };
  });
}
```

- [ ] **Step 4: Run tests, then commit**

Run: `pnpm --filter @adforge/core test`, then `pnpm test` → PASS.

```bash
git add packages/core
git commit -m "feat(spec): alignScript keeps script words, retimed onto Whisper with a slot fallback"
```

---

### Task 4: `buildSpec` — Director variant + assets → `VideoSpec` (pure)

**Files:**
- Create: `packages/core/src/spec/build-spec.ts`
- Test: `packages/core/test/build-spec.test.ts` (+ `test/golden/build-spec.json`)

**Interfaces:**
- Consumes: `VideoSpec` (P3), `secondsToFrames` (P0), `alignScript` (Task 3), `TREATMENTS`, `PIPELINE` (`video`, `timing.voTailFrames`, `composite`), `DirectorVariant` (P5), `AlignedWord`.
- Produces:
  ```ts
  export interface BeatAssets {
    plate: string;                                   // storage key, always present (b-roll is generated from it)
    cutout?: string;                                 // storage key of the real product cutout (required for hero/supporting)
    broll?: { key: string; durationSec: number };    // only honoured on 'absent' beats that it fully covers
    voice: { key: string; durationSec: number };
    words: AlignedWord[];                            // seconds relative to this beat's voice start
  }
  export interface BuildSpecInput { id: string; variant: DirectorVariant; beats: BeatAssets[]; theme?: { primary: string; accent: string }; cfg?: PipelineConfig }
  export function buildSpec(input: BuildSpecInput): VideoSpec   // VideoSpec.parse()d; throws on a programming error
  ```
- **Rules:**
  - **Beat frames:** `max(secondsToFrames(scene.duration), secondsToFrames(voice.durationSec) + voTailFrames)`, laid out cumulatively.
  - **Background:** a `video` layer only if the beat is `absent`, has `broll`, and `secondsToFrames(broll.durationSec) ≥ beatFrames`. Otherwise use the `plate`.
  - **Cutout:** `hero` and `supporting` get a `cutout` layer with `PIPELINE.composite[prominence]` geometry and `shadow: true`. A missing `cutout` key on such a beat is an error. `absent` beats get none.
  - **Overlay:** a `text` layer with the scene overlay. Position is `mid_lower` when the treatment's caption position is `top_third`, otherwise `top_third`; weight and scrim come from the treatment.
  - **Captions:** `position = TREATMENTS[treatment].captionPosition`. Each word is converted to absolute frames from the beat start, clipped to the beat, made non-overlapping and at least 1 frame long. Words that don't fit are dropped.
  - **Voice:** one track per beat at the beat start, lasting `max(1, secondsToFrames(voice.durationSec))`.

- [ ] **Step 1: Write the failing test**

`packages/core/test/build-spec.test.ts`:
```ts
import { describe, expect, it } from 'vitest';
import { loadPrompt } from '../src/llm/prompts';
import type { DirectorOutput } from '../src/llm/schemas';
import { buildSpec, type BeatAssets } from '../src/spec/build-spec';

const variant = () => {
  const t = loadPrompt('director').text;
  return (JSON.parse(t.slice(t.indexOf('```json') + 7, t.lastIndexOf('```'))) as DirectorOutput).variants[0]!; // problem_solution: absent, absent, hero, hero
};
const key = (c: string, ext = 'png') => `${c}${c}/${c.repeat(64)}.${ext}`;
const beat = (i: number, voiceSec: number, extra: Partial<BeatAssets> = {}): BeatAssets => ({
  plate: key(String(i)),
  cutout: key('c'),
  voice: { key: key(String(i), 'wav'), durationSec: voiceSec },
  words: [{ text: 'w1', startSec: 0.1, endSec: 0.5 }, { text: 'w2', startSec: 0.5, endSec: 1.0 }],
  ...extra,
});

describe('buildSpec', () => {
  it('produces a valid spec whose scene frames sum exactly', () => {
    const spec = buildSpec({ id: 'v1', variant: variant(), beats: [beat(1, 3), beat(2, 4), beat(3, 5), beat(4, 4)] });
    expect(spec.durationInFrames).toBe(spec.scenes.reduce((n, s) => n + s.durationInFrames, 0));
    expect(spec.scenes.map((s) => s.durationInFrames)).toEqual([120, 150, 180, 150]); // planned 4,5,6,5 s; VO fits
  });

  it('stretches a beat to fit a long voice clip plus the tail', () => {
    const spec = buildSpec({ id: 'v1', variant: variant(), beats: [beat(1, 4.5), beat(2, 4), beat(3, 5), beat(4, 4)] });
    expect(spec.scenes[0]!.durationInFrames).toBe(135 + 6);
    expect(spec.audio.voice[1]!.startFrame).toBe(141);
  });

  it('puts the real cutout on hero beats only, never on absent beats', () => {
    const spec = buildSpec({ id: 'v1', variant: variant(), beats: [beat(1, 3), beat(2, 4), beat(3, 5), beat(4, 4)] });
    const hasCutout = spec.scenes.map((s) => s.layers.some((l) => l.type === 'cutout'));
    expect(hasCutout).toEqual([false, false, true, true]);
  });

  it('uses b-roll only on an absent beat it fully covers, else the plate', () => {
    const short = buildSpec({ id: 'v1', variant: variant(), beats: [beat(1, 3, { broll: { key: key('b', 'mp4'), durationSec: 3 } }), beat(2, 4), beat(3, 5), beat(4, 4)] });
    expect(short.scenes[0]!.layers[0]!.type).toBe('plate'); // 3s clip < 4s beat
    const long = buildSpec({ id: 'v1', variant: variant(), beats: [beat(1, 3, { broll: { key: key('b', 'mp4'), durationSec: 5.04 } }), beat(2, 4), beat(3, 5), beat(4, 4)] });
    expect(long.scenes[0]!.layers[0]).toMatchObject({ type: 'video', trimStartFrame: 0 });
  });

  it('never puts b-roll on a hero beat', () => {
    const spec = buildSpec({ id: 'v1', variant: variant(), beats: [beat(1, 3), beat(2, 4), beat(3, 5, { broll: { key: key('b', 'mp4'), durationSec: 8 } }), beat(4, 4)] });
    expect(spec.scenes[2]!.layers[0]!.type).toBe('plate');
  });

  it('places captions inside their beats, ordered, at least one frame each', () => {
    const spec = buildSpec({ id: 'v1', variant: variant(), beats: [beat(1, 3), beat(2, 4), beat(3, 5), beat(4, 4)] });
    expect(spec.captions.words).toHaveLength(8);
    expect(spec.captions.words[2]).toEqual({ text: 'w1', startFrame: 120 + 3, endFrame: 120 + 15 });
    expect(spec.captions.position).toBe('bottom_center'); // macro_texture
  });

  it('rejects a hero beat without a cutout key', () => {
    expect(() => buildSpec({ id: 'v1', variant: variant(), beats: [beat(1, 3), beat(2, 4), beat(3, 5, { cutout: undefined }), beat(4, 4)] })).toThrow(/cutout/);
  });

  it('matches the golden spec', async () => {
    const spec = buildSpec({ id: 'v1', variant: variant(), beats: [beat(1, 3), beat(2, 4), beat(3, 5), beat(4, 4)] });
    await expect(JSON.stringify(spec, null, 2) + '\n').toMatchFileSnapshot('./golden/build-spec.json');
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `pnpm --filter @adforge/core test` → FAIL.

- [ ] **Step 3: Implement**

`packages/core/src/spec/build-spec.ts`:
```ts
import { PIPELINE, type PipelineConfig } from '../config/pipeline';
import { TREATMENTS } from '../config/treatments';
import type { DirectorVariant } from '../llm/schemas';
import type { AlignedWord } from '../providers/types';
import { secondsToFrames } from './frames';
import { VideoSpec, type Layer, type Scene } from './video-spec';

export interface BeatAssets {
  plate: string;
  cutout?: string;
  broll?: { key: string; durationSec: number };
  voice: { key: string; durationSec: number };
  words: AlignedWord[];
}
export interface BuildSpecInput {
  id: string;
  variant: DirectorVariant;
  beats: BeatAssets[];
  theme?: { primary: string; accent: string };
  cfg?: PipelineConfig;
}

/** Director variant + generated assets → our IR. Seconds become frames here and nowhere else in the pipeline. */
export function buildSpec(input: BuildSpecInput): VideoSpec {
  const cfg = input.cfg ?? PIPELINE;
  const { fps } = cfg.video;
  const v = input.variant;
  if (input.beats.length !== v.scenes.length) throw new Error(`buildSpec: ${v.scenes.length} scenes but ${input.beats.length} beat assets`);
  const t = TREATMENTS[v.visual_treatment];
  const overlayPosition = t.captionPosition === 'top_third' ? 'mid_lower' : 'top_third';

  const scenes: Scene[] = [];
  const voice: VideoSpec['audio']['voice'] = [];
  const words: VideoSpec['captions']['words'] = [];
  let cursor = 0;

  v.scenes.forEach((scene, i) => {
    const a = input.beats[i]!;
    const voiceFrames = Math.max(1, secondsToFrames(a.voice.durationSec, fps));
    const frames = Math.max(secondsToFrames(scene.duration, fps), voiceFrames + cfg.timing.voTailFrames);
    const layers: Layer[] = [];

    const brollFits = a.broll && secondsToFrames(a.broll.durationSec, fps) >= frames;
    if (scene.product_prominence === 'absent' && brollFits) {
      layers.push({ type: 'video', key: a.broll!.key, trimStartFrame: 0 });
    } else {
      layers.push({ type: 'plate', key: a.plate });
    }
    if (scene.product_prominence !== 'absent') {
      if (!a.cutout) throw new Error(`buildSpec: scene ${i + 1} is ${scene.product_prominence} but has no cutout key`);
      layers.push({ type: 'cutout', key: a.cutout, ...cfg.composite[scene.product_prominence], shadow: true });
    }
    layers.push({ type: 'text', content: scene.overlay, position: overlayPosition, weight: t.captionWeight, scrim: t.scrim });

    // VideoSpec requires video-background scenes to be static (P3 final review, ADR 0008).
    scenes.push({ startFrame: cursor, durationInFrames: frames, motion: layers[0]!.type === 'video' ? 'static' : scene.motion, layers });
    voice.push({ key: a.voice.key, startFrame: cursor, durationInFrames: voiceFrames });

    for (const w of a.words) {
      const prevEnd = words.at(-1)?.endFrame ?? 0;
      const start = Math.max(prevEnd, cursor + secondsToFrames(w.startSec, fps));
      const end = Math.min(cursor + frames, Math.max(start + 1, cursor + secondsToFrames(w.endSec, fps)));
      if (start >= cursor + frames || end <= start) continue;
      words.push({ text: w.text, startFrame: start, endFrame: end });
    }
    cursor += frames;
  });

  return VideoSpec.parse({
    id: input.id,
    width: cfg.video.width,
    height: cfg.video.height,
    fps,
    durationInFrames: cursor,
    theme: input.theme ?? { primary: '#141414', accent: '#f5b301' },
    scenes,
    audio: { voice },
    captions: { position: t.captionPosition, words },
  });
}
```

`PIPELINE.composite` must be keyed `hero` / `supporting` so `cfg.composite[scene.product_prominence]` typechecks after the `absent` branch. If TypeScript doesn't narrow, use `cfg.composite[scene.product_prominence as 'hero' | 'supporting']` with a comment.

- [ ] **Step 4: Run tests, inspect the golden, commit**

Run: `pnpm --filter @adforge/core test` (inspect `golden/build-spec.json`: 4 scenes, cutouts on scenes 3–4, text overlays at `top_third`), then `pnpm test` → PASS.

```bash
git add packages/core
git commit -m "feat(spec): buildSpec — frame-exact beats, code-computed fidelity, safe b-roll, aligned captions"
```

---

### Task 5: ComfyUI `free()` + end-to-end voice check (three languages) + listening check

**Files:**
- Modify: `packages/providers/comfyui/src/client.ts` (add `free()`), `packages/providers/comfyui/src/providers.ts` (expose `free`), `packages/providers/comfyui/test/client.test.ts`
- Create: `packages/providers/voice-service/src/e2e.ts`
- Modify: root `package.json` (`"e2e:voice": "pnpm --filter @adforge/provider-voice-service e2e"`), `docs/decisions/0010-voice-service.md` (append the listening result)

**Interfaces:**
- Produces (comfyui):
  - `ComfyClient.free(): Promise<void>` sends `POST /free` with `{ "unload_models": true, "free_memory": true }`; a non-2xx is `UPSTREAM`.
  - `createComfyProviders(...)` also returns `free(): Promise<void>`.

- [ ] **Step 1: ComfyUI `free()` (test first)**

Add to `packages/providers/comfyui/test/client.test.ts`:
```ts
  it('asks ComfyUI to unload models and free memory', async () => {
    const f = fakeFetch({ 'POST /free': () => new Response(null, { status: 200 }) });
    await new ComfyClient(BASE, f).free();
    expect(f.bodies['POST /free']?.[0]).toEqual({ unload_models: true, free_memory: true });
  });
```
In `client.ts`, add:
```ts
  /** Hand VRAM/RAM back (heavy-lane hand-off). ComfyUI applies it when idle. */
  async free(): Promise<void> {
    await this.#request('/free', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ unload_models: true, free_memory: true }),
    }).then((res) => {
      if (!res.ok) throw new ProviderError(P, 'UPSTREAM', `POST /free -> HTTP ${res.status}`);
    });
  }
```
In `providers.ts`, add `free: () => client.free(),` to the returned object, and `free(): Promise<void>` to its return type. Run `pnpm --filter @adforge/provider-comfyui test` → PASS.

- [ ] **Step 2: Write the e2e script**

`packages/providers/voice-service/src/e2e.ts`:
```ts
import { join } from 'node:path';
import { REPO_ROOT, parseEnv } from '@adforge/core/config/env';
import { TREATMENTS } from '@adforge/core/config/treatments';
import { loadPrompt } from '@adforge/core/llm/prompts';
import type { DirectorOutput, DirectorVariant } from '@adforge/core/llm/schemas';
import type { MediaRef, ProviderResult } from '@adforge/core/providers/types';
import { alignScript } from '@adforge/core/spec/align-script';
import { buildSpec, type BeatAssets } from '@adforge/core/spec/build-spec';
import { createComfyProviders } from '@adforge/provider-comfyui';
import { LocalDiskStorage } from '@adforge/provider-local-storage';
import { HyperframesRenderer } from '@adforge/renderer-hyperframes';
import { createVoiceProviders } from './providers';

/** P6 end-to-end: anchor variant 1 voiced in en / hi / hinglish → three rendered MP4s for the listening check. */
try {
  process.loadEnvFile(join(REPO_ROOT, '.env'));
} catch (e) {
  if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
}
const env = parseEnv(process.env);
const storage = new LocalDiskStorage(join(env.ADFORGE_DATA_DIR, 'media'), env.ADFORGE_PUBLIC_URL);
const comfy = createComfyProviders({
  baseUrl: env.COMFYUI_URL, storage,
  plateWorkflow: env.ADFORGE_COMFY_WORKFLOW_PLATE, cutoutWorkflow: env.ADFORGE_COMFY_WORKFLOW_CUTOUT, brollWorkflow: env.ADFORGE_COMFY_WORKFLOW_BROLL,
});
const voice = createVoiceProviders({ baseUrl: env.ADFORGE_VOICE_URL, storage });
const renderer = new HyperframesRenderer({ storage, workDir: join(env.ADFORGE_DATA_DIR, 'render-work') });
const done = <T>(step: string, r: ProviderResult<T>): T => {
  if (r.status !== 'done') { console.error(`FAIL ${step}:`, r.status === 'failed' ? `${r.error.code} ${r.error.message}` : 'pending'); process.exit(1); }
  return r.value;
};

const t = loadPrompt('director').text;
const base = (JSON.parse(t.slice(t.indexOf('```json') + 7, t.lastIndexOf('```'))) as DirectorOutput).variants[0]!;
const VO: Record<'hi' | 'hinglish', string[]> = {
  hi: [
    'कोई नहीं बताता कि आपका खाने का तेल कैसे बनता है।',
    'ज़्यादातर तेल केमिकल सॉल्वेंट से निकाला जाता है, फिर ब्लीच होता है।',
    'यह तेल लकड़ी की घानी में ठंडा पेरा गया है। बस इतना ही।',
    'वही रसोई। एक ईमानदार बोतल।',
  ],
  hinglish: [
    'Koi nahi batata ki aapka cooking oil kaise banta hai.',
    'Zyaadatar oil chemical solvent se nikaalte hain, phir bleach karte hain.',
    'Yeh oil lakdi ki ghani mein thanda pressa gaya hai. Bas.',
    'Wahi kitchen. Ek imaandaar bottle.',
  ],
};
const variants: DirectorVariant[] = [
  base,
  { ...base, language: 'hi', scenes: base.scenes.map((s, i) => ({ ...s, vo: VO.hi[i]! })) },
  { ...base, language: 'hinglish', scenes: base.scenes.map((s, i) => ({ ...s, vo: VO.hinglish[i]! })) },
];

await comfy.preflight();
console.log('voice health:', await voice.health());

// Batch 1 — ComfyUI: plates for each beat (shared across languages) + the product cutout.
const suffix = TREATMENTS[base.visual_treatment].platePromptSuffix;
const plates: MediaRef[] = [];
for (const [i, s] of base.scenes.entries()) {
  plates.push(done(`plate ${i + 1}`, await comfy.image.generate({ prompt: `${s.scene}, ${suffix}`, width: 768, height: 1344, idempotencyKey: `p6:plate:${i}` })));
}
const product = done('product', await comfy.image.generate({
  prompt: 'studio product photo of a single amber glass bottle with a plain paper label, isolated on a pure white background',
  width: 768, height: 1344, idempotencyKey: 'smoke:p2-check:product',
}));
const cutout = done('cutout', await comfy.cutout.cutout({ image: product, idempotencyKey: 'smoke:p2-check:cutout' }));
await comfy.free(); // hand the GPU to the voice service

// Batch 2 — voice + alignment for every language.
const assets: BeatAssets[][] = [];
for (const v of variants) {
  const beats: BeatAssets[] = [];
  for (const [i, s] of v.scenes.entries()) {
    const t0 = Date.now();
    const audio = done(`tts ${v.language} ${i + 1}`, await voice.tts.synthesize({ text: s.vo, language: v.language, emotion: s.emotion, idempotencyKey: `p6:${v.language}:${i}` }));
    const asr = done(`align ${v.language} ${i + 1}`, await voice.aligner.align({ audio, text: s.vo, language: v.language, idempotencyKey: `p6:${v.language}:${i}:align` }));
    beats.push({ plate: plates[i]!.id, cutout: cutout.id, voice: { key: audio.id, durationSec: audio.durationSec! }, words: alignScript(s.vo, asr.words, audio.durationSec!) });
    console.log(`  ${v.language} beat ${i + 1}: ${audio.durationSec!.toFixed(2)}s voice, ${asr.words.length} asr words, ${((Date.now() - t0) / 1000).toFixed(1)}s`);
  }
  assets.push(beats);
}
console.log('voice unload:', await voice.unload());

// Batch 3 — render.
for (const [n, v] of variants.entries()) {
  const spec = buildSpec({ id: `p6-${v.language}`, variant: v, beats: assets[n]! });
  const out = done(`render ${v.language}`, await renderer.render({ spec, idempotencyKey: `p6:${v.language}` }));
  console.log(`RENDER ${v.language}: ${storage.pathFor(out.id)} (${spec.durationInFrames} frames)`);
}
console.log('VOICE E2E OK — now listen to all three files.');
```

- [ ] **Step 3: Run the end-to-end check (the plan's only one)**

Prerequisites: ComfyUI is running (`scripts/comfyui.ps1`) and the voice service is running (`scripts/voice.ps1`).
Run: `pnpm e2e:voice`
Expected: three `RENDER` lines and `VOICE E2E OK`. During the run, `nvidia-smi` must not exceed 16 GB; `comfy.free()` precedes the voice batch.

**Listening check (the user):** play the three MP4s and confirm:
1. **English:** natural, with emotion rising on the agitate line.
2. **Hindi:** correct pronunciation, Devanagari captions in sync.
3. **Hinglish:** pronunciation acceptable with `hinglishTtsLanguage: 'hi'`.

If Hinglish sounds wrong, set `PIPELINE.voice.hinglishTtsLanguage` to `'en'` in `packages/core/src/config/pipeline.ts`, rerun, and keep whichever the user prefers. Record the user's verdict per language in ADR 0010 under "Listening check (2026-10-…)".

- [ ] **Step 4: Commit**

```bash
git add package.json packages/providers/comfyui packages/providers/voice-service packages/core docs/decisions/0010-voice-service.md
git commit -m "feat(voice): e2e EN/HI/Hinglish voiced renders with GPU hand-off and listening verdict"
```

**P6 exit check:**
- `pnpm test` is green.
- `uv run pytest -q` is green in `services/voice`.
- `pnpm e2e:voice` renders three MP4s.
- The user's listening verdict is recorded in ADR 0010.
