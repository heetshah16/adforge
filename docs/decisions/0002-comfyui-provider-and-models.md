# 0002 — ComfyUI as the local media provider

**Status:** accepted · 2026-10-15
**Spec:** docs/superpowers/specs/2026-10-15-adforge-local-poc-design.md §2
**API reference:** [docs/providers/comfyui.md](../providers/comfyui.md)

## Context
The spec planned a fresh ComfyUI *portable* install at `C:\ComfyUI`, with BiRefNet supplied by a custom node, and workflows built and exported in the GUI. In practice the machine already had **Comfy Desktop**: ComfyUI v0.35.1, torch 2.12.1+cu130, and Blackwell (sm_120) support confirmed on the RTX 5070 Ti. That version ships native background-removal nodes and the official workflow templates locally.

## Decision
- **Use the existing Comfy Desktop install; don't add a second one.** `scripts/comfyui.ps1` starts it headless on a fixed `127.0.0.1:8188` (matching the `COMFYUI_URL` default). It uses Desktop's model-paths YAML and its shared `input` / `output` dirs. Models live in `%LOCALAPPDATA%\Comfy-Desktop\ComfyUI-Shared\models`, which is outside OneDrive.
- **No custom nodes.** The cutout uses native `LoadBackgroundRemovalModel` → `RemoveBackground` → `InvertMask` → `JoinImageWithAlpha`.
- **Workflows are written directly in API format.** Their node graphs and sampler settings come from the bundled official templates, and the server validated them against `/object_info` and `/prompt`. They were not exported from the GUI. The title contract (`in:*` / `out:*`) is unchanged, so a later GUI re-export stays compatible.
- **Completion is detected by polling `/history`,** never by websocket alone. The adapter sends a client-chosen `prompt_id` derived from `idempotencyKey`.

| Role | Model (file) | Source | License | Cold | Warm | Peak VRAM |
|---|---|---|---|---|---|---|
| Plate | Flux.1-schnell fp8, 4 steps, cfg 1, 768×1344 (`flux1-schnell-fp8.safetensors`, 17.2 GB) | Comfy-Org/flux1-schnell | Apache-2.0 | 13.3 s | 5.1 s | ~12.4 GB |
| Cutout | BiRefNet (`birefnet.safetensors`, 0.44 GB) | Comfy-Org/BiRefNet | MIT | 2.0 s | — (identical inputs hit ComfyUI's cache: 0.0 s) | small |
| B-roll | Wan 2.2 TI2V-5B fp16 (`wan2.2_ti2v_5B_fp16.safetensors`, 10.0 GB) + umt5-xxl fp8 + wan2.2 VAE; 704×1280, 121 frames @ 24 fps (5.04 s), 20 steps | Comfy-Org Wan 2.2 / 2.1 repackaged | Apache-2.0 | 274 s | 272 s (sampling-bound, not load-bound) | ~14.1 GB |

Every downloaded file was verified byte-exact against the server's `Content-Length`.

## Findings the P2 adapter must honour
- `SaveVideo` reports its MP4 under the **`images`** output key, with `"animated": [true]`. There is no `video` key.
- ComfyUI caches results for an identical prompt. A resubmit with the same inputs returns instantly with the same file, which makes retries cheap and safe.
- A missing model file is a `/prompt` 400 with `error.type = "prompt_outputs_failed_validation"` and a "Value not in list" error on the loader node. This is recorded in `fixtures/prompt-missing-model.400.json` and maps to `INVALID_INPUT`.
- History is in memory only. After a ComfyUI restart, an id that is in neither history nor the queue is lost, so resubmit it.

## Consequences
- **Running two ComfyUI processes:** the Desktop window app and the headless server can't usefully run at once, because both compete for 16 GB of VRAM. Use one at a time.
- **Swapping models:** a new model means a new workflow JSON plus an env change. Flux.1-dev stays excluded by default because of its non-commercial licence.
- **B-roll latency:** at the warm b-roll time, one clip per variant costs about 4.5 min of GPU time per variant (~14 min per 3-variant job). This keeps the `broll.enabled` toggle and per-variant isolation load-bearing.
