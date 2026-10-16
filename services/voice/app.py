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

    return ChatterboxMultilingualTTS.from_pretrained(device=DEVICE)  # 0.1.7 has no t3_model arg; it loads t3_mtl23ls_v2


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
