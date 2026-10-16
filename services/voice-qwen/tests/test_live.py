import pytest
from fastapi.testclient import TestClient


@pytest.mark.live
def test_synthesize_then_unload_frees_vram():
    from app import app

    c = TestClient(app)
    r = c.post("/synthesize", json={"text": "Nobody tells you how oil is made.", "speaker": "Ryan"})
    assert r.status_code == 200 and r.headers["content-type"] == "audio/wav"
    assert float(r.headers["x-duration-sec"]) > 0.5
    before = c.get("/health").json()["allocated_mb"]
    assert before > 1000
    assert c.post("/unload").json()["unloaded"] == ["tts"]
    assert c.get("/health").json()["allocated_mb"] < before * 0.25
