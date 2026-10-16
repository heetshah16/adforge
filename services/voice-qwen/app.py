"""AdForge Qwen3-TTS service (English spike) on the local GPU.

Liveness: one GPU job at a time (lock); the model lazy-loads and is unloaded after QWEN_IDLE_TTL_S idle;
POST /unload frees it on demand. The watchdog exits with code 3 on a hung call so the supervisor restarts us.
"""
import gc
import os
import threading
import time
from typing import Literal

import numpy as np
import torch
from fastapi import FastAPI, HTTPException
from fastapi.responses import Response
from pydantic import BaseModel, Field

from qwen_core import ModelSlot, Watchdog, encode_wav

MODEL = os.environ.get("QWEN_MODEL", "Qwen/Qwen3-TTS-12Hz-1.7B-CustomVoice")
DEVICE = os.environ.get("QWEN_DEVICE", "cuda:0")
IDLE_TTL_S = float(os.environ.get("QWEN_IDLE_TTL_S", "120"))
CALL_TIMEOUT_S = float(os.environ.get("QWEN_CALL_TIMEOUT_S", "300"))
LOAD_TIMEOUT_S = float(os.environ.get("QWEN_LOAD_TIMEOUT_S", "1800"))  # first-ever weight download is several GB

gpu = threading.Lock()


def _load_tts():
    from qwen_tts import Qwen3TTSModel

    return Qwen3TTSModel.from_pretrained(MODEL, device_map=DEVICE, dtype=torch.bfloat16, attn_implementation="sdpa")


tts = ModelSlot("tts", _load_tts)


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


def _janitor_tick() -> None:
    if tts.idle_for() > IDLE_TTL_S:
        with gpu:  # re-check under the lock: a call may have started/finished since
            _free([s for s in (tts,) if s.idle_for() > IDLE_TTL_S])


def _janitor() -> None:
    while True:
        time.sleep(5)
        _janitor_tick()


threading.Thread(target=_janitor, name="idle-janitor", daemon=True).start()
app = FastAPI(title="adforge-voice-qwen")


class SynthReq(BaseModel):
    text: str = Field(min_length=1, max_length=500)
    speaker: Literal["Vivian", "Serena", "Uncle_Fu", "Dylan", "Eric", "Ryan", "Aiden", "Ono_Anna", "Sohee"]
    instruct: str | None = Field(default=None, max_length=300)


@app.get("/health")
def health():
    cuda = torch.cuda.is_available()
    return {
        "ok": True,
        "device": DEVICE,
        "cuda": cuda,
        "sm120": cuda and "sm_120" in torch.cuda.get_arch_list(),
        "loaded": {"tts": tts.loaded},
        "allocated_mb": torch.cuda.memory_allocated() / 2**20 if cuda else 0,
    }


@app.post("/synthesize")
def synthesize(req: SynthReq):
    with gpu:
        model = _get(tts)
        with Watchdog(CALL_TIMEOUT_S):
            kw = {"instruct": req.instruct} if req.instruct else {}  # no sampling params: model defaults
            try:
                wavs, sr = model.generate_custom_voice(text=req.text, language="English", speaker=req.speaker, **kw)
            except ValueError as e:
                raise HTTPException(422, str(e))
            samples = np.asarray(wavs[0], dtype=np.float32).reshape(-1)
            sr = int(sr)
            tts.touch()
    return Response(
        encode_wav(samples, sr),
        media_type="audio/wav",
        headers={"X-Duration-Sec": f"{len(samples) / sr:.6f}", "X-Sample-Rate": str(sr)},
    )


@app.post("/unload")
def unload():
    with gpu:
        return {"unloaded": _free((tts,))}
