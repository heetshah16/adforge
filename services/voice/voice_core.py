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
