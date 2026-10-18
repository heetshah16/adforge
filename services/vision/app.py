"""AdForge vision service: Depth-Anything-V2 Small depth, EasyOCR, luma grid. 127.0.0.1:8192.

Liveness (same as voice-qwen): one GPU job at a time (lock); models lazy-load and unload after VISION_IDLE_TTL_S idle;
POST /unload frees them on demand; the watchdog exits with code 3 on a hung call so the supervisor restarts us.
"""
import gc
import io
import os
import threading
import time

import numpy as np
import torch
from fastapi import FastAPI, File, Form, HTTPException
from fastapi.responses import Response
from PIL import Image

from vision_core import MAX_BYTES, ModelSlot, Watchdog, luma_grid, prep_image

DEPTH_MODEL = "depth-anything/Depth-Anything-V2-Small-hf"  # Apache-2.0. Base/Large are non-commercial: never use.
DEVICE = os.environ.get("VISION_DEVICE", "cuda:0")
IDLE_TTL_S = float(os.environ.get("VISION_IDLE_TTL_S", "120"))
CALL_TIMEOUT_S = float(os.environ.get("VISION_CALL_TIMEOUT_S", "120"))
LOAD_TIMEOUT_S = float(os.environ.get("VISION_LOAD_TIMEOUT_S", "900"))
DEPTH_MAX_SIDE = 1024
OCR_LANGS = {"en", "hi"}

gpu = threading.Lock()


def _load_depth():
    from transformers import AutoImageProcessor, AutoModelForDepthEstimation

    proc = AutoImageProcessor.from_pretrained(DEPTH_MODEL)
    net = AutoModelForDepthEstimation.from_pretrained(DEPTH_MODEL).to(DEVICE).eval()
    return proc, net


def _load_ocr():
    import easyocr

    # ponytail: one en+hi reader serves every `langs` subset (filtering is not needed for the library use case).
    return easyocr.Reader(["en", "hi"], verbose=False, gpu=DEVICE.startswith("cuda") and torch.cuda.is_available())


depth = ModelSlot("depth", _load_depth)
ocr = ModelSlot("ocr", _load_ocr)


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
    if any(s.idle_for() > IDLE_TTL_S for s in (depth, ocr)):
        with gpu:  # re-check under the lock: a call may have started/finished since
            _free([s for s in (depth, ocr) if s.idle_for() > IDLE_TTL_S])


def _janitor() -> None:
    while True:
        time.sleep(5)
        _janitor_tick()


threading.Thread(target=_janitor, name="idle-janitor", daemon=True).start()
app = FastAPI(title="adforge-vision")


def _prep(data: bytes, max_side: int = 2048) -> Image.Image:
    if len(data) > MAX_BYTES:
        raise HTTPException(413, "image over 20 MB")
    try:
        return prep_image(data, max_side)
    except ValueError as e:
        raise HTTPException(422, str(e))


@app.get("/health")
def health():
    cuda = torch.cuda.is_available()
    return {
        "ok": True,
        "device": DEVICE,
        "cuda": cuda,
        "loaded": {"depth": depth.loaded, "ocr": ocr.loaded},
        "allocated_mb": torch.cuda.memory_allocated() / 2**20 if cuda else 0,
    }


def _run_depth(model, im: Image.Image) -> np.ndarray:
    proc, net = model
    inputs = proc(images=im, return_tensors="pt").to(DEVICE)
    with torch.inference_mode():
        out = net(**inputs).predicted_depth  # (1, h, w) relative inverse depth: larger = nearer
        out = torch.nn.functional.interpolate(out[None], size=(im.height, im.width), mode="bicubic", align_corners=False)[0, 0]
    return out.float().cpu().numpy()


@app.post("/depth")
def depth_ep(image: bytes = File(...)):
    im = _prep(image, DEPTH_MAX_SIDE)
    with gpu:
        model = _get(depth)
        with Watchdog(CALL_TIMEOUT_S):
            d = _run_depth(model, im)
            depth.touch()
    lo, hi = float(d.min()), float(d.max())
    u16 = ((d - lo) / (hi - lo) * 65535.0).round().astype("<u2") if hi > lo else np.zeros(d.shape, "<u2")
    buf = io.BytesIO()
    Image.fromarray(u16).save(buf, format="PNG")  # 16-bit grayscale
    return Response(
        buf.getvalue(),
        media_type="image/png",
        headers={"X-Depth-Near": "high", "X-Width": str(im.width), "X-Height": str(im.height)},
    )


@app.post("/ocr")
def ocr_ep(image: bytes = File(...), langs: str = Form("en,hi")):
    ls = [x.strip() for x in langs.split(",") if x.strip()]
    if not ls or any(x not in OCR_LANGS for x in ls):
        raise HTTPException(422, "langs must be a comma list from en,hi")
    im = _prep(image)
    arr = np.asarray(im)
    with gpu:
        reader = _get(ocr)
        with Watchdog(CALL_TIMEOUT_S):
            # EasyOCR expects BGR channel order for arrays. (contiguous: negative strides break the tensor conversion)
            res = reader.readtext(np.ascontiguousarray(arr[..., ::-1]))
            ocr.touch()
    w, h = im.size
    items = []
    for pts, text, conf in res:
        xs, ys = [p[0] for p in pts], [p[1] for p in pts]
        x0, y0 = max(0.0, min(xs)), max(0.0, min(ys))
        x1, y1 = min(float(w), max(xs)), min(float(h), max(ys))
        items.append({"text": text, "box": [x0 / w, y0 / h, (x1 - x0) / w, (y1 - y0) / h], "conf": float(conf)})
    items.sort(key=lambda i: (i["box"][1], i["box"][0]))
    return {"items": items}


@app.post("/luma")
def luma_ep(image: bytes = File(...), grid: int = Form(8)):
    if not 2 <= grid <= 32:
        raise HTTPException(422, "grid must be 2..32")
    return {"grid": luma_grid(_prep(image), grid)}


@app.post("/unload")
def unload():
    with gpu:
        return {"unloaded": _free((depth, ocr))}
