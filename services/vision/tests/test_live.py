import io
import os

import pytest
from fastapi.testclient import TestClient
from PIL import Image

FIX = os.path.join(os.path.dirname(__file__), "..", "..", "..", "fixtures", "eval-products", "krishna-special-hing", "1-packshot.jpg")


@pytest.mark.live
def test_depth_ocr_then_unload_frees_vram():
    from app import app

    c = TestClient(app)
    img = open(FIX, "rb").read()
    r = c.post("/depth", files={"image": ("p.jpg", img)})
    assert r.status_code == 200 and r.headers["x-depth-near"] == "high"
    assert Image.open(io.BytesIO(r.content)).size == (int(r.headers["x-width"]), int(r.headers["x-height"]))
    items = c.post("/ocr", files={"image": ("p.jpg", img)}).json()["items"]
    assert any("KRISHNA" in i["text"].upper() for i in items)
    before = c.get("/health").json()["allocated_mb"]
    assert before > 300
    assert set(c.post("/unload").json()["unloaded"]) == {"depth", "ocr"}
    assert c.get("/health").json()["allocated_mb"] < before * 0.25
