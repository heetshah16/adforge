"""Pure helpers for the vision service: lazy model slot, watchdog, image prep, luma grid.
ponytail: ModelSlot/Watchdog copied from services/voice-qwen/qwen_core.py, not shared; extract a shared package if a fourth service appears."""
import io
import logging
import os
import threading
import time
from typing import Any, Callable

import numpy as np
from PIL import Image

MAX_BYTES = 20 * 1024 * 1024
MAX_SIDE = 2048


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

    def touch(self) -> None:
        """Stamp last-used again when a call finishes, so a long generate is not seen as idle."""
        with self._lock:
            self._last_used = time.monotonic()

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


class Watchdog:
    """Context manager: if the block runs longer than `seconds`, call on_expire (default: hard-exit the process).
    Torch calls cannot be interrupted, so a hung one would hold the GPU lock forever; exiting lets the supervisor restart us."""

    def __init__(self, seconds: float, on_expire: Callable[[], None] | None = None):
        self.seconds = seconds
        self._on_expire = on_expire or (lambda: os._exit(3))
        self._timer: threading.Timer | None = None

    def _fire(self) -> None:
        logging.getLogger("vision").error("vision: GPU call exceeded %ss — exiting so the lock is not held forever", self.seconds)
        self._on_expire()

    def __enter__(self) -> "Watchdog":
        self._timer = threading.Timer(self.seconds, self._fire)
        self._timer.daemon = True
        self._timer.start()
        return self

    def __exit__(self, *exc) -> None:
        self._timer.cancel()



def prep_image(data: bytes, max_side: int = MAX_SIDE) -> Image.Image:
    """Decode (alpha flattened onto white), downsize to long side <= max_side keeping aspect. ValueError on garbage."""
    try:
        im = Image.open(io.BytesIO(data))
        im.load()
    except Exception as e:
        raise ValueError(f"not a decodable image: {e}")
    if im.mode in ("RGBA", "LA", "P"):
        im = im.convert("RGBA")
        im = Image.alpha_composite(Image.new("RGBA", im.size, (255, 255, 255, 255)), im)
    im = im.convert("RGB")
    w, h = im.size
    s = max_side / max(w, h)
    if s < 1:
        im = im.resize((max(1, round(w * s)), max(1, round(h * s))), Image.LANCZOS)
    return im


def luma_grid(im: Image.Image, n: int) -> list[list[float]]:
    """Mean Rec.709 luma (0-255) per cell of an n x n grid."""
    a = np.asarray(im.convert("RGB"), dtype=np.float64)
    y = 0.2126 * a[..., 0] + 0.7152 * a[..., 1] + 0.0722 * a[..., 2]
    h, w = y.shape
    ys, xs = np.linspace(0, h, n + 1).astype(int), np.linspace(0, w, n + 1).astype(int)
    return [
        [round(float(y[ys[i]:max(ys[i + 1], ys[i] + 1), xs[j]:max(xs[j + 1], xs[j] + 1)].mean()), 3) for j in range(n)]
        for i in range(n)
    ]
