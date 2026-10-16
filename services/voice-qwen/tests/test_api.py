import io
import time
import wave

import numpy as np
from fastapi.testclient import TestClient

import app as a
from qwen_core import Watchdog

c = TestClient(a.app)


class FakeModel:
    def __init__(self):
        self.calls = []

    def generate_custom_voice(self, **kw):
        self.calls.append(kw)
        return [np.zeros(2400, dtype=np.float32)], 24000


def _install(monkeypatch):
    m = FakeModel()
    monkeypatch.setattr(a.tts, "_loader", lambda: m)
    a.tts.unload()
    return m


def test_validation_is_422():
    assert c.post("/synthesize", json={"text": "", "speaker": "Ryan"}).status_code == 422
    assert c.post("/synthesize", json={"text": "x" * 501, "speaker": "Ryan"}).status_code == 422
    assert c.post("/synthesize", json={"text": "hi", "speaker": "../x"}).status_code == 422
    assert c.post("/synthesize", json={"text": "hi"}).status_code == 422


def test_synthesize_returns_wav_and_forces_english(monkeypatch):
    m = _install(monkeypatch)
    r = c.post("/synthesize", json={"text": "Hello there.", "speaker": "Ryan", "instruct": "calm"})
    assert r.status_code == 200 and r.headers["content-type"] == "audio/wav"
    assert r.content[:4] == b"RIFF" and float(r.headers["x-duration-sec"]) == 0.1
    with wave.open(io.BytesIO(r.content)) as w:
        assert w.getframerate() == 24000 and w.getnchannels() == 1
    assert m.calls == [{"text": "Hello there.", "language": "English", "speaker": "Ryan", "instruct": "calm"}]
    a.tts.unload()


def test_free_always_collects_and_empties_cache_even_when_nothing_loaded(monkeypatch):
    calls = []
    monkeypatch.setattr(a.gc, "collect", lambda *x: calls.append("gc"))
    monkeypatch.setattr(a.torch.cuda, "is_available", lambda: True)
    monkeypatch.setattr(a.torch.cuda, "empty_cache", lambda: calls.append("cache"))
    a.tts.unload()
    assert a._free([a.tts]) == []
    assert calls == ["gc", "cache"]


def test_unload_endpoint_frees_loaded_model(monkeypatch):
    _install(monkeypatch)
    c.post("/synthesize", json={"text": "Hi.", "speaker": "Ryan"})
    assert a.tts.loaded
    assert c.post("/unload").json() == {"unloaded": ["tts"]} and not a.tts.loaded


def test_janitor_evicts_idle_but_rechecks_under_lock(monkeypatch):
    _install(monkeypatch)
    a.tts.get()
    monkeypatch.setattr(a, "IDLE_TTL_S", 50.0)
    # Idle at the unlocked check, but a call touches the slot before the janitor gets the lock -> must survive.
    a.tts._last_used -= 100
    a.gpu.acquire()
    t = __import__("threading").Thread(target=a._janitor_tick)
    t.start()
    time.sleep(0.1)
    a.tts.touch()
    a.gpu.release()
    t.join(5)
    assert a.tts.loaded
    # Genuinely idle -> evicted.
    a.tts._last_used -= 100
    a._janitor_tick()
    assert not a.tts.loaded


def test_model_load_uses_load_budget_not_call_budget(monkeypatch):
    seen = []

    class W:
        def __init__(self, s):
            seen.append(s)

        def __enter__(self):
            return self

        def __exit__(self, *e):
            pass

    class Slot:
        def get(self):
            return "m"

    monkeypatch.setattr(a, "Watchdog", W)
    assert a._get(Slot()) == "m"
    assert seen == [a.LOAD_TIMEOUT_S] and a.LOAD_TIMEOUT_S != a.CALL_TIMEOUT_S


def test_watchdog_fires_on_overrun_and_not_otherwise():
    fired = []
    with Watchdog(0.05, lambda: fired.append(1)):
        time.sleep(0.3)
    assert fired == [1]
    with Watchdog(5, lambda: fired.append(2)):
        pass
    time.sleep(0.05)
    assert fired == [1]
