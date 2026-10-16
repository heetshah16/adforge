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
