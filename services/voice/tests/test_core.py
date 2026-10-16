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
