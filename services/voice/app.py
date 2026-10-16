"""AdForge voice service — Chatterbox Multilingual TTS + Whisper word alignment on the local GPU.

Liveness: one GPU job at a time (lock); each model lazy-loads and is unloaded after VOICE_IDLE_TTL_S idle;
POST /unload frees both on demand so the pipeline can hand VRAM back to ComfyUI.
"""
import gc
import os
import threading
import wave
import time
from typing import Literal

import numpy as np
import torch
import torchaudio.functional as AF
from fastapi import FastAPI, File, Form, HTTPException, UploadFile
from fastapi.responses import Response
from pydantic import BaseModel, Field

from voice_core import ModelSlot, Watchdog, decode_wav, encode_wav

DEVICE = os.environ.get("VOICE_DEVICE", "cuda")
IDLE_TTL_S = float(os.environ.get("VOICE_IDLE_TTL_S", "120"))
CALL_TIMEOUT_S = float(os.environ.get("VOICE_CALL_TIMEOUT_S", "300"))
LOAD_TIMEOUT_S = float(os.environ.get("VOICE_LOAD_TIMEOUT_S", "1800"))  # first-ever weight download took 4m44s
MAX_UPLOAD_BYTES = 8 * 1024 * 1024
WHISPER_MODEL = os.environ.get("VOICE_WHISPER_MODEL", "small")

gpu = threading.Lock()


def _load_tts():
    from chatterbox.mtl_tts import ChatterboxMultilingualTTS

    return ChatterboxMultilingualTTS.from_pretrained(device=DEVICE)  # 0.1.7 has no t3_model arg; it loads t3_mtl23ls_v2


def _load_whisper():
    import whisper

    return whisper.load_model(WHISPER_MODEL, device=DEVICE)


tts = ModelSlot("tts", _load_tts)
asr = ModelSlot("whisper", _load_whisper)


def _free(slots) -> list[str]:
    freed = [s.name for s in slots if s.unload()]
    gc.collect()  # always: a failed load (CUDA OOM) leaves partial weights cached though nothing was "loaded"
    if torch.cuda.is_available():
        torch.cuda.empty_cache()
    return freed


def _get(slot: ModelSlot):
    """Model load under its own, larger watchdog budget (first run downloads weights)."""
    with Watchdog(LOAD_TIMEOUT_S):
        return slot.get()


def _janitor() -> None:
    while True:
        time.sleep(5)
        if any(s.idle_for() > IDLE_TTL_S for s in (tts, asr)):
            with gpu:  # re-check under the lock: a call may have started/finished since
                _free([s for s in (tts, asr) if s.idle_for() > IDLE_TTL_S])


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
        "allocated_mb": torch.cuda.memory_allocated() / 2**20 if cuda else 0,
    }


@app.post("/synthesize")
def synthesize(req: SynthReq):
    with gpu:
        model = _get(tts)
        with Watchdog(CALL_TIMEOUT_S):
            wav = model.generate(req.text, language_id=req.language_id, exaggeration=req.exaggeration, cfg_weight=req.cfg_weight)
            samples = wav.detach().float().cpu().numpy().reshape(-1)
            sr = int(model.sr)
            tts.touch()
    return Response(
        encode_wav(samples, sr),
        media_type="audio/wav",
        headers={"X-Duration-Sec": f"{len(samples) / sr:.6f}", "X-Sample-Rate": str(sr)},
    )


@app.post("/align")
def align(audio: UploadFile = File(...), language: Literal["en", "hi"] = Form(...)):
    if audio.size is not None and audio.size > MAX_UPLOAD_BYTES:
        raise HTTPException(413, "audio upload exceeds 8 MB")
    data = audio.file.read(MAX_UPLOAD_BYTES + 1)
    if len(data) > MAX_UPLOAD_BYTES:
        raise HTTPException(413, "audio upload exceeds 8 MB")
    try:
        samples, sr = decode_wav(data)
    except (wave.Error, ValueError, EOFError) as e:
        raise HTTPException(422, f"invalid audio: expected a 16-bit PCM WAV file ({e})")
    if sr != 16000:
        samples = AF.resample(torch.from_numpy(samples), sr, 16000).numpy()
    with gpu:
        model = _get(asr)
        with Watchdog(CALL_TIMEOUT_S):
            result = model.transcribe(
                samples.astype(np.float32),
                language=language,
                word_timestamps=True,
                fp16=DEVICE == "cuda",
                condition_on_previous_text=False,
            )
        asr.touch()
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
