import io
import threading
import time

import numpy as np
import pytest
from fastapi.testclient import TestClient
from PIL import Image

import app as a
from vision_core import Watchdog, prep_image

c = TestClient(a.app)


def png(w, h, fn=None, mode="RGB"):
    arr = np.zeros((h, w, 3), "uint8") if fn is None else fn(h, w)
    b = io.BytesIO()
    Image.fromarray(arr).convert(mode).save(b, format="PNG")
    return b.getvalue()


def half(h, w):
    arr = np.zeros((h, w, 3), "uint8")
    arr[:, w // 2:] = 255
    return arr


class FakeOcr:
    def __init__(self, res):
        self.res = res

    def readtext(self, arr):
        return self.res


def _fake_ocr(monkeypatch, res):
    monkeypatch.setattr(a.ocr, "_loader", lambda: FakeOcr(res))
    a.ocr.unload()


def test_bad_input_is_422():
    assert c.post("/luma", files={"image": ("x.png", b"not an image")}).status_code == 422
    assert c.post("/luma", files={"image": ("x.png", png(8, 8))}, data={"grid": 1}).status_code == 422
    assert c.post("/luma", files={"image": ("x.png", png(8, 8))}, data={"grid": 33}).status_code == 422
    assert c.post("/luma").status_code == 422
    assert c.post("/ocr", files={"image": ("x.png", png(8, 8))}, data={"langs": "fr"}).status_code == 422
    assert c.post("/depth", files={"image": ("x.png", b"junk")}).status_code == 422


def test_size_cap_is_413():
    assert c.post("/luma", files={"image": ("x.bin", b"0" * (20 * 1024 * 1024 + 1))}).status_code == 413


def test_luma_half_black_half_white():
    g = c.post("/luma", files={"image": ("x.png", png(64, 32, half))}, data={"grid": 4}).json()["grid"]
    assert len(g) == 4 and all(len(r) == 4 for r in g)
    for row in g:
        assert row == [0, 0, 255, 255]


def test_luma_default_grid_is_8_and_alpha_flattens_to_white():
    b = io.BytesIO()
    Image.new("RGBA", (16, 16), (0, 0, 0, 0)).save(b, format="PNG")
    g = c.post("/luma", files={"image": ("x.png", b.getvalue())}).json()["grid"]
    assert len(g) == 8 and g[0][0] == 255


def test_large_input_keeps_aspect_and_depth_downsizes(monkeypatch):
    seen = {}

    def fake_run(model, im):
        seen["size"] = im.size
        return np.random.default_rng(0).random((im.height, im.width)).astype("float32")

    monkeypatch.setattr(a, "_run_depth", fake_run)
    monkeypatch.setattr(a.depth, "_loader", lambda: object())
    a.depth.unload()
    r = c.post("/depth", files={"image": ("x.png", png(6000, 4000))})
    assert r.status_code == 200 and r.headers["x-depth-near"] == "high"
    assert seen["size"] == (1024, 683)  # 6000x4000, long side 1024, 3:2 kept
    assert (r.headers["x-width"], r.headers["x-height"]) == ("1024", "683")
    out = Image.open(io.BytesIO(r.content))
    assert out.size == (1024, 683) and out.mode.startswith("I")
    assert np.asarray(out).max() == 65535
    a.depth.unload()


def test_luma_downsizes_big_input_without_distortion():
    g = c.post("/luma", files={"image": ("x.png", png(6000, 4000, half))}, data={"grid": 2}).json()["grid"]
    assert g == [[pytest.approx(0, abs=1), pytest.approx(255, abs=1)]] * 2


def test_ocr_blank_image_returns_empty(monkeypatch):
    _fake_ocr(monkeypatch, [])
    assert c.post("/ocr", files={"image": ("x.png", png(32, 32))}).json() == {"items": []}
    a.ocr.unload()


def test_ocr_items_sorted_with_fraction_boxes(monkeypatch):
    box = lambda x0, y0, x1, y1: [[x0, y0], [x1, y0], [x1, y1], [x0, y1]]
    _fake_ocr(monkeypatch, [
        (box(50, 80, 100, 100), "low", 0.9),
        (box(60, 10, 100, 30), "right", 0.8),
        (box(0, 10, 20, 30), "left", 0.7),
    ])
    items = c.post("/ocr", files={"image": ("x.png", png(100, 100))}, data={"langs": "en"}).json()["items"]
    assert [i["text"] for i in items] == ["left", "right", "low"]
    assert items[0]["box"] == [0.0, 0.1, 0.2, 0.2]
    a.ocr.unload()


def test_free_always_collects_and_empties_cache_even_when_nothing_loaded(monkeypatch):
    calls = []
    monkeypatch.setattr(a.gc, "collect", lambda *x: calls.append("gc"))
    monkeypatch.setattr(a.torch.cuda, "is_available", lambda: True)
    monkeypatch.setattr(a.torch.cuda, "empty_cache", lambda: calls.append("cache"))
    a.depth.unload()
    a.ocr.unload()
    assert a._free([a.depth, a.ocr]) == []
    assert calls == ["gc", "cache"]


def test_unload_endpoint_frees_loaded_models(monkeypatch):
    _fake_ocr(monkeypatch, [])
    a.ocr.get()
    assert c.post("/unload").json() == {"unloaded": ["ocr"]} and not a.ocr.loaded
    assert c.get("/health").json()["loaded"] == {"depth": False, "ocr": False}


def test_janitor_evicts_idle_but_rechecks_under_lock(monkeypatch):
    _fake_ocr(monkeypatch, [])
    a.ocr.get()
    monkeypatch.setattr(a, "IDLE_TTL_S", 50.0)
    a.ocr._last_used -= 100
    a.gpu.acquire()
    t = threading.Thread(target=a._janitor_tick)
    t.start()
    time.sleep(0.1)
    a.ocr.touch()  # a call finished before the janitor got the lock -> must survive
    a.gpu.release()
    t.join(5)
    assert a.ocr.loaded
    a.ocr._last_used -= 100
    a._janitor_tick()
    assert not a.ocr.loaded


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


def test_exif_orientation_is_applied():
    arr = np.zeros((20, 40, 3), "uint8")
    arr[:, 20:] = 255
    img = Image.fromarray(arr)
    exif = img.getexif()
    exif[0x0112] = 6
    buf = io.BytesIO()
    img.save(buf, "JPEG", exif=exif.tobytes())
    out = prep_image(buf.getvalue())
    assert out.size == (20, 40)


def test_watchdog_fires_on_overrun_and_not_otherwise():
    fired = []
    with Watchdog(0.05, lambda: fired.append(1)):
        time.sleep(0.3)
    assert fired == [1]
    with Watchdog(5, lambda: fired.append(2)):
        pass
    time.sleep(0.05)
    assert fired == [1]
