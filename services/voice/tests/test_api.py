from fastapi.testclient import TestClient

from app import app

c = TestClient(app)


def test_align_rejects_non_wav_with_422():
    r = c.post("/align", files={"audio": ("v.wav", b"not a wav", "audio/wav")}, data={"language": "en"})
    assert r.status_code == 422 and "invalid audio" in r.json()["detail"]


def test_align_rejects_oversize_with_413():
    r = c.post("/align", files={"audio": ("v.wav", b"\0" * (8 * 1024 * 1024 + 1), "audio/wav")}, data={"language": "en"})
    assert r.status_code == 413


def test_synthesize_validation_is_422():
    assert c.post("/synthesize", json={"text": "", "language_id": "en", "exaggeration": 0.5, "cfg_weight": 0.5}).status_code == 422


def test_free_always_collects_and_empties_cache_even_when_nothing_loaded(monkeypatch):
    import app as a

    calls = []
    monkeypatch.setattr(a.gc, "collect", lambda *x: calls.append("gc"))
    monkeypatch.setattr(a.torch.cuda, "is_available", lambda: True)
    monkeypatch.setattr(a.torch.cuda, "empty_cache", lambda: calls.append("cache"))
    assert a._free([a.tts, a.asr]) == []
    assert calls == ["gc", "cache"]


def test_model_load_uses_load_budget_not_call_budget(monkeypatch):
    import app as a

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
