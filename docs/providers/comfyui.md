# ComfyUI server API — provider reference

**Fetched:** 2026-10-15
**Version this describes:** ComfyUI **v0.35.1** (commit `856a922`), from the Comfy Desktop standalone build `v0.34.0-env1` (Python 3.13.12, torch 2.12.1+cu130).

**Sources:**
1. The docs page "ComfyUI Server Routes (HTTP and WebSocket API)" on docs.comfy.org (`/development/comfyui-server/comms_routes`). It gives the route inventory but no request or response schemas, and it points to `server.py` and `execution.py` for those.
2. The installed source:
   - `server.py`: the `@routes` handlers
   - `execution.py`: `validate_prompt`, `PromptQueue`, `handle_execution_error`

Shapes below come from (2) and are pinned to this version. Re-check them on any ComfyUI upgrade.

---

## Routes the adapter uses

| Method | Path | Use |
|---|---|---|
| GET | `/system_stats` | Preflight: is the server up, and which devices and VRAM does it have |
| GET | `/object_info` · `/object_info/{node_class}` | Node input schemas; used to validate workflows |
| GET | `/models/{folder}` | Lists model files in a folder (e.g. `checkpoints`, `background_removal`) |
| POST | `/upload/image` | Puts an input image into ComfyUI's `input` dir |
| POST | `/prompt` | Queues a workflow |
| GET | `/history/{prompt_id}` | Polls for the result (the source of truth for completion) |
| GET | `/queue` | Distinguishes "still queued or running" from "lost" |
| GET | `/view` | Downloads an output file |
| POST | `/interrupt` · `/free` | Cancels the running job or unloads models |
| WS | `/ws?clientId=` | Optional progress events; never rely on it alone |

## POST /prompt

**Request body:**
```json
{ "prompt": { "<node_id>": { "class_type": "...", "inputs": { ... }, "_meta": { "title": "..." } } },
  "prompt_id": "<optional canonical lowercase UUID>",
  "client_id": "<optional, for ws routing>",
  "extra_data": { } }
```
- `prompt` is the **API-format** workflow: a map from node id to `{class_type, inputs}`.
  - An input is either a literal value, or a link `["<src_node_id>", <output_index>]`.
  - `_meta.title` is ignored by execution. The AdForge patcher addresses nodes by it.
- **`prompt_id` may be supplied by the client** if it is a canonical lowercase hyphenated UUID; otherwise the server mints one.
  - AdForge derives it deterministically from `idempotencyKey`. A retry after a crash can then poll `/history/{id}` for a job it already submitted instead of resubmitting blindly.
  - A malformed id is rejected with a 400, `error.type = "invalid_prompt_id"`.

**200:** `{ "prompt_id": "...", "number": <queue position>, "node_errors": {} }`

**400 (validation failed):** `{ "error": { "type", "message", "details", "extra_info" }, "node_errors": { "<node_id>": { "errors": [ { "type", "message", "details", "extra_info" } ], "dependent_outputs": [...], "class_type": "..." } } }`
- `error.type` values seen in source: `no_prompt`, `invalid_prompt_id`, `prompt_no_outputs`, `prompt_outputs_failed_validation`.
- A **missing model file** shows up here as a node error on its loader node, with a "value not in list" style error naming the file. Map this to `ProviderError('INVALID_INPUT')` (an adapter or setup bug), and include the node title and missing file in the message.

## GET /history/{prompt_id}

- Returns `{}` while the job is queued or running.
- Returns this when it is finished:
```json
{ "<prompt_id>": {
    "prompt": [number, prompt_id, prompt, extra_data, outputs_to_execute, ...],
    "outputs": { "<node_id>": { "images": [ { "filename", "subfolder", "type": "output" } ], ... } },
    "status": { "status_str": "success" | "error", "completed": true|false,
                "messages": [ ["execution_start", {...}], ["execution_success"|"execution_error"|"execution_interrupted", {...}] ] },
    "meta": { "<node_id>": { ... } } } }
```
- The output key differs by node type. Image save nodes use `images`; video save nodes write their own key. Check the recorded fixture rather than assuming.
- An `execution_error` message payload carries `prompt_id`, `node_id`, `node_type`, `executed`, `exception_message`, `exception_type`, `traceback`, `current_inputs`, and `current_outputs`. Map it to `ProviderError('UPSTREAM')`, retryable.
- `execution_interrupted` means someone hit cancel. Map it to `UPSTREAM` and make it non-retryable.

**History is in memory only and bounded at 10,000 entries.** A ComfyUI restart loses it. If `/history/{id}` is `{}` *and* the id is in neither `queue_running` nor `queue_pending` of `GET /queue`, the job is **lost**, so resubmit it with the same `prompt_id`.

## GET /queue

`{ "queue_running": [[number, prompt_id, ...]], "queue_pending": [[...]] }`. Sensitive extra_data is stripped.

## POST /upload/image (multipart)

**Fields:**
- `image`: the file
- `type`: `input` (default), `output` or `temp`
- `subfolder`
- `overwrite`: `"true"` or `"1"`. Without it, a name clash gets a ` (1)` suffix, unless the bytes hash the same as the existing file, which is then reused.

**200:** `{ "name": "<final filename>", "subfolder": "...", "type": "input" }`. Use the returned `name` in `LoadImage.inputs.image`, because it may differ from the name you sent.

## GET /view

**Query:** `filename`, `type` (`output` by default, or `input` / `temp`), `subfolder`, optional `preview`.
- The server rejects a filename that contains `..` or starts with `/`, and a subfolder that escapes its folder.
- The adapter downloads outputs through this route and immediately stores them in AdForge storage. A ComfyUI `/view` URL never leaves the adapter (CLAUDE.md: `MediaRef.url` is internal).

## Native nodes AdForge depends on (v0.35.1, no custom nodes)

| Purpose | Nodes |
|---|---|
| Cutout | `LoadBackgroundRemovalModel` (model folder `background_removal`, BiRefNet) → `RemoveBackground` (outputs a MASK) → `JoinImageWithAlpha` (IMAGE + MASK → RGBA) → `SaveImage` |
| Plate (Flux-schnell) | `CheckpointLoaderSimple` → `CLIPTextEncode` → `EmptySD3LatentImage` → `KSampler` → `VAEDecode` → `SaveImage` |
| B-roll (Wan 2.2 5B) | `UNETLoader`, `CLIPLoader`, `VAELoader`, `LoadImage`, `CLIPTextEncode`, `Wan22ImageToVideoLatent`, `ModelSamplingSD3`, `KSampler`, `VAEDecode`, `CreateVideo`, `SaveVideo` |

The model files and URLs come from the bundled official templates (`comfyui_workflow_templates_json`: `flux_schnell`, `utility_birefnet_remove_background`, `video_wan2_2_5B_ti2v`). They are all in Comfy Desktop's shared models dir.

## Running it for AdForge

`scripts/comfyui.ps1` starts the Comfy Desktop install **headless on a fixed port 8188**, using Desktop's model-paths YAML and its shared input and output dirs. The GUI is still available at http://127.0.0.1:8188. Don't run it alongside the Desktop window app on the same models at the same time, because both would try to fill the 16 GB of VRAM.
