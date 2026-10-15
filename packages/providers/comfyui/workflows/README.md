# ComfyUI workflows

API-format workflows, built from the official templates that ship with ComfyUI v0.35.1 (`flux_schnell`, `utility_birefnet_remove_background`, `video_wan2_2_5B_ti2v`). They use only native nodes, with no custom nodes. API reference: [docs/providers/comfyui.md](../../../../docs/providers/comfyui.md).

The adapter patches nodes **by title** (`_meta.title`), never by numeric id. A workflow re-exported from the GUI (Workflow → Export (API)) stays compatible as long as these titles are kept:

| Title | Meaning | Inputs set by the adapter |
|---|---|---|
| `in:prompt` | positive prompt | `text` |
| `in:seed` | sampler | `seed` (or `noise_seed`) |
| `in:size` | latent size | `width`, `height` (+ `length` for video) |
| `in:image` | LoadImage | `image` (the name returned by `/upload/image`) |
| `out:image` / `out:video` | output node | read from `/history` |

| Workflow | What it does |
|---|---|
| `plate-flux-schnell` | Flux.1-schnell fp8, 4 steps, cfg 1, euler/simple, 768×1344. The negative prompt is unused at cfg 1. |
| `cutout-birefnet` | BiRefNet → `InvertMask` → `JoinImageWithAlpha` → RGBA PNG. Keep the invert: `JoinImageWithAlpha` treats its mask as transparency. |
| `broll-wan22-5b` | Wan 2.2 TI2V-5B image→video, 704×1280, 121 frames @ 24 fps (~5s), 20 steps uni_pc, shift 8, the template's default negative. MP4 via `SaveVideo` (nested inputs use dotted keys: `format.codec`). |

**To add a workflow:**
1. Build it in the GUI.
2. Apply the titles.
3. Export (API) to `<name>.json`.
4. Add its `.params.ts` manifest (P2).
5. Point `ADFORGE_COMFY_WORKFLOW_*` at it.

`../fixtures/` holds recorded live responses: one `/history` entry per workflow, plus a `/prompt` 400 for a missing model.
