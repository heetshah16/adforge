# vision (local GPU service, C1)

`services/vision`, FastAPI on `127.0.0.1:8192`. Depth + OCR + luma for the library analyzer. Start: `scripts/vision.ps1` (restart loop on watchdog exit 3; also started by `scripts/stack.ps1`).

## Models and licenses
| Use | Model | License |
|---|---|---|
| Depth | `depth-anything/Depth-Anything-V2-Small-hf` (**Small only**) | Apache-2.0. Base and Large are CC-BY-NC: must not be used. |
| OCR | EasyOCR 1.7.2, detector CRAFT + recognizers `en` and `hi` (`~/.EasyOCR`) | Apache-2.0 |
| Luma | none (numpy, Rec.709) | n/a |

## Resolved versions (`uv.lock`)
Python 3.13; torch 2.12.1+cu130 and torchvision 0.27.1+cu130 (both pinned through `override-dependencies` so easyocr/transformers cannot pull another torch); transformers 5.18.0 (2026-09-30, 18 days old on 2026-10-18); easyocr 1.7.2; opencv-python-headless 5.0.0.93; numpy 2.5.4; pillow 13.0.0; fastapi 0.142.2; uvicorn 0.54.0; python-multipart 0.0.32; pytest 9.1.1; httpx 0.28.1.

## HTTP
- `GET /health` -> `{ok, device, cuda, loaded:{depth,ocr}, allocated_mb}`
- `POST /depth` multipart `image` -> `image/png`, 16-bit grayscale, long side <= 1024, source aspect. Headers `X-Depth-Near: high`, `X-Width`, `X-Height`. Min-max normalised per image (relative depth only).
- `POST /ocr` multipart `image`, `langs` (`en,hi` subset, default `en,hi`) -> `{items:[{text, box:[x,y,w,h] fractions, conf}]}` sorted top-to-bottom, left-to-right. `[]` for a text-free image. The single en+hi reader serves every valid `langs`; `langs` is validated, not used to filter.
- `POST /luma` multipart `image`, `grid` 2..32 (default 8) -> `{grid:[[mean Rec.709 luma 0-255]]}`. CPU, deterministic.
- `POST /unload` -> `{unloaded:[...]}` (always runs gc + `torch.cuda.empty_cache`).
- Inputs: > 20 MB -> 413; undecodable or bad params -> 422; alpha flattened onto white; downsized to long side <= 2048 before inference.

## Liveness
GPU lock; lazy `ModelSlot` per model; idle janitor (`VISION_IDLE_TTL_S=120`) re-checks under the lock; watchdogs `VISION_LOAD_TIMEOUT_S=900` and `VISION_CALL_TIMEOUT_S=120` exit with code 3. `scripts/vision.ps1` sets `PYTHONUTF8=1`: EasyOCR's first-run download progress bar prints block characters and crashes on a cp1252 console.

## Feasibility measurements (RTX 5070 Ti, 2026-10-18)
- Depth-Anything-V2-Small: load 2.8 s (cached weights), 95 MB resident, **386 MB peak** while running a 1024-px image; run 0.02-0.26 s (first call includes CUDA warmup).
- EasyOCR en+hi: first load 28 s including model download; about 320 MB resident; **1750 MB peak** on a 2048-px image; run 0.4-0.65 s.
- Combined (both resident): about 416 MB allocated, 2.0 GB reserved by the caching allocator (peak across both about 1.75 GB). Plan for <= 2.1 GB.
- Baseline before/after: about 1.4-1.5 GB (desktop apps); the service returns VRAM to baseline after stop.

## Depth direction (pinned: `X-Depth-Near: high`, larger = nearer)
DA-V2 outputs relative inverse depth (disparity): larger is nearer. Confirmed on Krishna photos: in the counter shots the bottom quarter (table close to the camera) averages 3.94 / 4.12 against 1.90 / 1.88 for the top quarter (background); in the in-hand shot the hand and pouch at the centre average 4.47 against 1.99 at the corners. A synthetic flat-colour disc is not a valid test (no depth cues, model read it as farther), so the evidence rests on real photos.

## OCR sample (Krishna packshot, text only)
KRISHNA, SPECIAL HING, COMPOUNDED ASAFOETIDA, SINCE 1925 (read "925", Devanagari digits misread as "११२5" at conf 0.51). Confidence ranges 0.22-1.0; stylised/curved text comes out with OCR typos (for example "ASAFCETIOA"), so downstream treats OCR as a hint, not ground truth.

## Debt
ponytail: `ModelSlot` and `Watchdog` are copied from `services/voice-qwen/qwen_core.py` (and originally `services/voice/voice_core.py`), not shared. Extract a shared package once a fourth service needs them.
