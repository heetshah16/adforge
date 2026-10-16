import pytest
from fastapi.testclient import TestClient


@pytest.mark.live
def test_synthesize_then_align_round_trip():
    from app import app
    c = TestClient(app)
    r = c.post("/synthesize", json={"text": "Nobody tells you how oil is made.", "language_id": "en", "exaggeration": 0.5, "cfg_weight": 0.5})
    assert r.status_code == 200 and r.headers["content-type"] == "audio/wav"
    assert float(r.headers["x-duration-sec"]) > 0.5
    a = c.post("/align", files={"audio": ("v.wav", r.content, "audio/wav")}, data={"language": "en"})
    assert a.status_code == 200
    words = a.json()["words"]
    assert len(words) >= 5 and all(w["end"] >= w["start"] for w in words)
    before = c.get("/health").json()["allocated_mb"]
    assert before > 500
    assert c.post("/unload").json()["unloaded"]
    assert c.get("/health").json()["allocated_mb"] < before * 0.25
