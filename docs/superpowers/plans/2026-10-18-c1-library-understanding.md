# C1: The asset library and image understanding — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task by task. Steps use checkbox (`- [ ]`) syntax.

**Goal:**
- One uploaded product photo becomes a tagged, versioned library entry: the anchor (never regenerated), a cutout, OCR label text, a viewpoint, a palette and a locked text descriptor.
- Generated plates get an analysis: support surface, light, luma grid and depth.
- Krishna gets a brand kit and a voice bible that the TTS request uses verbatim.

**Architecture:**
- **A new local GPU service, `services/vision`** (FastAPI on 127.0.0.1:8192, its own uv project, the same liveness pattern as `services/voice-qwen`). It serves depth (Depth-Anything-V2 **Small**), OCR (EasyOCR) and a deterministic luma grid.
- **Node providers** in `packages/providers/vision-service`.
- **Semantic analysis is a structured LLM call** (`VisionAnalyzer`) on the existing Agent SDK provider, with byte-frozen prompts.
- **An Inngest function `adforge/product.ingest`** chains them on the heavy lane at interactive priority and writes `library_assets` rows under the tag convention.

**Tech stack:** Python 3.13 with uv; torch 2.12.1 / cu130 (same override as `services/voice-qwen`); `transformers` (`depth-estimation` pipeline); `easyocr` **1.7.2** (Apache-2.0, 2024-09-24); FastAPI/uvicorn at the same pins as `services/voice`; Drizzle; Inngest 4.21.1; the Claude Agent SDK 0.3.287.

**Specs:**
- [creative design §4.1–4.2, C1 exit](../specs/2026-10-17-creative-engine-v2-design.md);
- [bridge roadmap §C1](2026-10-17-bridge-roadmap.md);
- [bridge design §5.1](../specs/2026-10-17-poc-to-prod-bridge-design.md): per-org tables, RLS, recipe keys include `orgId`.

## Global Constraints
- **The roadmap's Global Constraints apply,** in particular:
  - exact pins at least 14 days old (Python: `uv.lock` committed; ranges forbidden);
  - provider docs first into `docs/providers/<name>.md`, plus a golden request and one recorded live response;
  - `pnpm test` with no GPU, network or subscription;
  - the commit identity flags plus a trailer naming the implementing model;
  - stage specific paths; never push;
  - after any live run, stop the services you started and confirm VRAM is back at baseline.
- **Licenses** (record them in `docs/providers/vision.md`):
  - Depth-Anything-V2 **Small** only (`depth-anything/Depth-Anything-V2-Small-hf`, Apache-2.0). Base and Large are non-commercial and **must not** be used.
  - EasyOCR is Apache-2.0.
- **Tenancy:**
  - `library_assets` carries `org_id` with RLS. `authenticated` gets **SELECT only**; writes go through the owner connection in the pipeline.
  - B2's RLS suite must keep passing: add the table to its TENANT list and the privilege matrix.
  - Migrations 0000–0010 are applied to Supabase dev and frozen; add new migrations only.
- **The anchor's pixels are never sent to a generative model** (creative §4.1). Analysis models only read them.
- **Liveness, same as voice-qwen:**
  - a GPU lock and a lazy model slot per model;
  - an idle janitor (`VISION_IDLE_TTL_S=120`) that re-checks under the lock;
  - `/unload` always runs `gc` plus `empty_cache`;
  - watchdogs with `VISION_LOAD_TIMEOUT_S=900` and `VISION_CALL_TIMEOUT_S=120`, exiting 3;
  - a restart loop in `scripts/vision.ps1`.
  - The Node clients have per-request timeouts.
- **Tags** (creative §4.1):
  - `library_assets.tag` stores the **base** tag without a version (e.g. `@prod_krishnahingras_front`), and `version` is an int ≥ 1;
  - `formatTag(tag, version)` gives `@prod_krishnahingras_front_v1`;
  - a new state is a new row (version + 1), never an update of an existing version.
- **Positive phrasing in every prompt.** No temperature/top_p/top_k. Model ids come from env.

## Review Focus
1. **Text-free or unreadable labels** (a plain pouch, a heavily stylized script). Expected: OCR returns `[]` or low confidence, analysis still completes, and the descriptor doesn't invent label text. *Task 2* service test with a blank image; *Task 5* ingest test with OCR `[]`.
2. **The same photo uploaded twice, or re-analysis after a descriptor edit.** Expected: one anchor (sha dedupe), a descriptor edit creates `v2`, and `v1` stays resolvable. *Task 5* tests.
3. **The vision service is down or hangs mid-ingest.** Expected: a retryable TIMEOUT/UPSTREAM; ingest fails cleanly with a warning, no partial library rows, and the job pipeline is unaffected. *Task 3* client timeout test; *Task 5* failure test.
4. **A huge or odd-shaped image** (6000×4000, portrait/landscape, PNG with alpha). Expected: the service downsizes before inference, and depth/luma outputs keep the source aspect ratio. *Task 2* tests.
5. **Org isolation of library rows.** Expected: org B never sees org A's library entries, and tags are unique per org, not globally. *Task 1* RLS coverage, plus a test that the same tag in two orgs is allowed.

---

### Task 1: Tags plus the `library_assets` migration with RLS (Haiku)

**Files:**
- Create: `packages/core/src/library/tags.ts`, `packages/core/test/tags.test.ts`
- Modify: `packages/db/src/schema.ts`; new migrations (generated table plus a custom RLS migration); `packages/db/test/rls.test.ts` (TENANT list and privilege matrix)

**Interfaces:**
- `type LibraryKind = 'product_view'|'location'|'prop'|'brand_kit'|'voice'`.
- `makeTag(kind, parts: string[]) → string`:
  - prefixes: `@prod_`, `@loc_`, `@prop_`, `@brand_`, `@voice_`;
  - parts are lower-cased, stripped to `[a-z0-9]`, and joined by `_`.
- `parseTag(tag) → { kind, parts }`.
- `formatTag(tag, version) → string`.
- `nextVersion(existing: number[]) → number` (max + 1, or 1).
- **Table `library_assets`:**
  - columns: `id` uuid pk, `org_id` not null, `project_id` not null, `product_id` null, `tag` text, `version` int, `kind` (enum `library_kind`), `descriptor` text not null, `storage_key` text null, `meta` jsonb default `{}`, `status` (`active`|`superseded`), `hero_eligible` bool default false, `gate` jsonb null, `created_at`;
  - unique `(org_id, tag, version)`;
  - composite FKs `(project_id, org_id) → projects(id, org_id)` and `(product_id, org_id) → products(id, org_id)` (same pattern as B2's 0007);
  - an index on `org_id`.
- **RLS:** a select policy `is_member(org_id)`; grant SELECT to `authenticated`; nothing to `anon`.

- [ ] **Step 1:** Failing tests:
  - tags: round-trip, sanitising, `nextVersion`;
  - RLS suite: `library_assets` is in TENANT with matrix `['SELECT']`;
  - a test that the same tag and version in two orgs both insert.
- [ ] **Step 2:** FAIL. **Step 3:** Implement: schema → `pnpm db:generate` → `drizzle-kit generate --custom --name library_rls`, filled in.
- [ ] **Step 4:** `pnpm test`, then the Postgres-gated db suite and `pnpm db:check` against Supabase dev (`ADFORGE_TEST_DATABASE_URL` from `.env.supabase`; never print it) → PASS.
- [ ] **Step 5:** Commit `feat(db): library_assets (tag+version, per-org RLS) and tag utilities`.

### Task 2: The `services/vision` GPU service (Sonnet)

**Files:**
- Create:
  - `services/vision/` (`pyproject.toml`, `uv.lock`, `app.py`, `vision_core.py`, `tests/`);
  - `scripts/vision.ps1`;
  - `docs/providers/vision.md`.
- Modify: `scripts/stack.ps1` (start vision), `.gitignore` (`services/vision/.venv/`)

**Interfaces (HTTP, 127.0.0.1:8192):**
- `GET /health` → `{ ok, device, cuda, loaded: { depth, ocr }, allocated_mb }`.
- `POST /depth`: multipart `image` → `image/png`, 16-bit grayscale at source aspect (long side ≤ 1024). Headers:
  - `X-Depth-Near: high` (larger = nearer, for DA-V2 relative depth; **verify on a test image**);
  - `X-Width`, `X-Height`.
- `POST /ocr`: multipart `image` plus `langs` (comma list from `en,hi`; default `en,hi`) → `{ items: [{ text, box: [x, y, w, h] as fractions, conf }] }`, sorted top-to-bottom and left-to-right.
- `POST /luma`: multipart `image` plus `grid` (2..32, default 8) → `{ grid: number[][] }`, the mean Rec.709 luma 0–255 per cell. Deterministic, no model, CPU.
- `POST /unload`.
- Inputs are capped at 20 MB and downsized to a long side of ≤ 2048 before inference.

- [ ] **Step 1: Docs first.** Write `docs/providers/vision.md` covering: the model ids, licenses (Small only; EasyOCR Apache-2.0), versions resolved by `uv`, the measured VRAM per model and combined, the load and run times, and the depth direction found in Step 3.
- [ ] **Step 2:** uv project:
  - pins: `torch==2.12.1`, `torchaudio`/`torchvision` per the voice-qwen override, the cu130 index, Python 3.13;
  - `transformers` pinned exactly at a release at least 14 days old that supports Depth-Anything-V2;
  - `easyocr==1.7.2`, plus FastAPI/uvicorn/python-multipart/pytest/httpx at the same pins as `services/voice`;
  - then `uv sync`.
- [ ] **Step 3:** **Feasibility run** (one-off `uv run python -c`):
  - depth on a Krishna photo (from `fixtures/eval-products/`) and a synthetic near/far gradient, to pin the depth direction;
  - OCR `['en','hi']` on a Krishna label;
  - print the times and `torch.cuda.max_memory_allocated()`;
  - record everything in the docs.
- [ ] **Step 4:** Implement the app: ModelSlots, GPU lock, janitor, watchdogs, sync endpoints, and the restart loop in `vision.ps1`.
- [ ] **Step 5:** Non-live pytest with fake slots:
  - 422 on bad input; the size cap;
  - a 6000×4000 input keeps its aspect ratio;
  - the luma grid of a half-black, half-white image;
  - OCR `[]` on a blank image (fake);
  - unload calls `gc` and the cache clear;
  - the janitor re-checks; the watchdog exits.
  - Plus one `--live` test (depth + OCR + unload; VRAM drops). Run `--live` once, then **stop the service and confirm VRAM is at baseline**.
- [ ] **Step 6:** Commit `feat(vision): local depth (DA-V2 Small) + OCR (EasyOCR) + luma service with idle unload and watchdog`.

### Task 3: The Node vision providers (Sonnet)

**Files:**
- Create: `packages/providers/vision-service/` (`src/client.ts`, `src/providers.ts`, `src/record-fixtures.ts`, `fixtures/*.live.json`, `test/*.test.ts`, `package.json`)
- Modify: `packages/core/src/providers/types.ts`, `packages/core/src/config/env.ts` (`ADFORGE_VISION_URL`, default `http://127.0.0.1:8192`), `.env.example`

**Interfaces (core `types.ts`):**
- `DepthProvider { id; estimate(image: MediaRef, key: string): Promise<ProviderResult<MediaRef>> }` (a stored 16-bit PNG).
- `OcrProvider { id; read(image: MediaRef, langs?: ('en'|'hi')[]): Promise<ProviderResult<OcrItem[]>> }`, where `OcrItem = { text: string; box: [number, number, number, number]; conf: number }`.
- `LumaProvider { id; grid(image: MediaRef, n?: number): Promise<ProviderResult<number[][]>> }`.
- `createVisionProviders({ baseUrl, storage, fetchImpl? }) → { depth, ocr, luma, health, unload }`:
  - Zod-validates requests and responses;
  - timeouts: 120 s for calls, 900 s for the first load;
  - status mapping: 400/413/422 → INVALID_INPUT, 5xx → UPSTREAM, abort → TIMEOUT.

- [ ] **Steps:** failing tests first:
  - the golden multipart body per endpoint;
  - the status mapping;
  - a hung server becomes TIMEOUT (Review Focus 3);
  - the depth PNG is stored with its width and height.

  Then implement. Record one live response per endpoint (start and stop the vision service; keep sizes and shapes only, not image bytes). Then `pnpm test`, and commit `feat(providers): vision-service depth/ocr/luma providers`.

### Task 4: `VisionAnalyzer` (structured LLM) (Sonnet)

**Files:**
- Create: `packages/core/src/understand/schemas.ts`, `packages/core/src/understand/prompts.ts`, `packages/core/test/understand.test.ts`
- Modify: `packages/providers/claude-agent-sdk/src/*` (an `analyzeProduct` / `analyzePlate` entry point on the existing LLM adapter), plus the recorded fixtures

**Interfaces:**
- **`ProductAnalysis` (Zod):**
  - `shapeClass`: one of `bottle|jar|pouch|box|tube|can|sachet|other`;
  - `viewpoint`: `{ azimuthDeg -180..180, elevationDeg -90..90 }`;
  - `lightDirection`: `{ azimuthDeg, elevationDeg }`, or null;
  - `palette`: 1–6 hex values;
  - `material`: a string of at most 40 characters;
  - `finish`: one of `matte|gloss|metallic|translucent|mixed`;
  - `visibleFaces`: a non-empty array of `front|back|left|right|top|bottom`;
  - `descriptor`: 40–120 words describing shape, colours, cap and label layout, phrased positively, **never quoting label text that OCR didn't return**;
  - `bestPhotoIndex`: an int (when several photos are given).
- **`PlateAnalysis` (Zod):**
  - `cameraHeight`: one of `ground|table|eye|high|overhead`;
  - `tiltDeg`;
  - `horizonY`: 0–1, or null;
  - `supportSurface`: `{ box: [x, y, w, h] fractions }`, or null;
  - `light`: `{ azimuthDeg, colorTempK 1500..10000 }`;
  - `freeZones`: up to 4 `[x, y, w, h]` boxes.
  - Luma and depth come from Task 3 providers, **not** from the LLM.
- `analyzeProduct(llm, { images: MediaRef[]; ocr: OcrItem[][] }) → ProductAnalysis`. The OCR text is given to the model as ground truth.
- `analyzePlate(llm, { image }) → PlateAnalysis`.
- **Prompts are byte-frozen constants,** with no product name, date or ids above the cached content. Model id from env (`ADFORGE_LLM_VISION`, default `claude-sonnet-5-5`, Zod-parsed at boot). Effort via `output_config.effort`, no sampling params.

- [ ] **Steps:** failing tests:
  - schema validation, including the descriptor word-count bounds;
  - golden prompt bytes;
  - a test that the descriptor fails validation when it contains a quoted string not present in the OCR text (a cheap guard, implemented as a refine using the OCR text).

  Then implement. Record live responses for both eval products and one generated plate (subscription, local only; `fixtures/eval-products` stays uncommitted, and the recorded JSON contains analysis only, no image bytes). Then `pnpm test`, and commit `feat(llm): VisionAnalyzer — structured product and plate analysis`.

### Task 5: The ingest pipeline `adforge/product.ingest` (Opus)

**Files:**
- Create: `packages/pipeline/src/ingest.ts`, `packages/pipeline/test/ingest.test.ts`
- Modify: `packages/pipeline/src/inngest.ts` (register the function on the heavy lane, interactive priority), `apps/worker/src/deps.ts` (vision providers), `packages/pipeline/src/types.ts`

**Interfaces:**
- **Event `adforge/product.ingest`** with `{ productId }`. The product row gives `org_id` and `project_id`. Photos are the product's `assets` rows with kind `upload`, linked through `library_assets.meta.sourceAssetId` or a `product_id` on assets. Pick one, document it, and keep it per org.
- **Steps, each an Inngest `step.run` and each idempotent:**
  1. load the product and photos;
  2. cutout every photo (existing comfy `cutout`), then `comfy.free`;
  3. OCR every photo, then `vision.unload`;
  4. `analyzeProduct` (LLM);
  5. write the library rows in one transaction:
     - one `product_view` row per photo, tag `makeTag('product_view', [productSlug, viewName])`, where `viewName` comes from `visibleFaces[0]` plus the azimuth bucket (`front`, `left`, `right`, `back`, `top`, `three-quarter-left`…);
     - the row for `bestPhotoIndex` gets `meta.anchor = true`;
     - `meta` holds `{ cutoutKey, ocr, viewpoint, palette, lightDirection, sourceAssetId, analysisModel }`;
     - `descriptor` comes from the analysis.
- **Re-running ingest** for the same product and photos is a no-op (an idempotency key per product plus the photo sha set).
- `updateDescriptor(db, { orgId, tag, descriptor }) → newVersion`. It inserts version n+1 with `status='active'` and marks the previous row `superseded` in one transaction. The old version remains selectable by `(tag, version)`.
- **On failure** of any external step: the function fails with a recorded `provider_calls` row and writes **no** partial library rows (the write step is last and transactional) (Review Focus 3).

- [ ] **Steps:** failing tests with fakes:
  - 1 photo → 1 anchor row with every meta field;
  - 3 photos → 3 rows, with the anchor at `bestPhotoIndex`;
  - the same photos ingested twice → no new rows;
  - OCR `[]` → completes, and the descriptor has no quoted label text (Review Focus 1);
  - the vision service failing → no library rows;
  - `updateDescriptor` → v2 active, v1 superseded and resolvable;
  - an org-scoped idempotency key.

  Then implement. Then `pnpm test`, and commit `feat(pipeline): product.ingest — cutouts, OCR, analysis → versioned library rows`.

### Task 6: Plate analysis in `generateAds`, plus the Krishna brand kit and voice bible (Sonnet)

**Files:**
- Modify:
  - `packages/pipeline/src/*` (after each plate is generated: luma grid + depth + `analyzePlate`, stored on the plate asset);
  - `packages/db/src/schema.ts` (new nullable `assets.analysis jsonb`, new migration);
  - `packages/providers/voice-service/src/*` (the Qwen request uses the voice bible).
- Create: `packages/db/src/seed/brand-krishna.ts` plus a script `pnpm seed:brand -- krishna`
- Test: pipeline tests, voice golden

**Interfaces:**
- `assets.analysis` = `{ plate: PlateAnalysis, lumaGrid: number[][], depthKey: string }` for plate assets.
- Plate analysis is **best-effort**: on failure, record a warning, and the job continues (partial-success rule).
- **The brand kit row** (`kind='brand_kit'`, tag `@brand_krishna`):
  - `meta` = `{ palette, fonts, tone, logoKey? }`;
  - source: the scraped site data in `fixtures/eval-products/*/product.json`, read at seed time and never committed;
  - the seed is idempotent.
- **The voice bible row** (`kind='voice'`, tag `@voice_krishna_en`):
  - `meta` = `{ engine: 'qwen', speaker: 'Ryan', baseInstruct: <locked text> }`;
  - the Qwen request uses `speaker` verbatim and prefixes the beat instruct with `baseInstruct` verbatim;
  - golden body test.
  - When there's no voice bible, today's config defaults stand.

- [ ] **Steps:** failing tests:
  - plate analysis stored for a fake plate;
  - analysis failure → job still completes with a warning;
  - the seed is idempotent;
  - the Qwen golden body includes the bible text verbatim.

  Then implement. Then `pnpm test`, `pnpm db:check` (Supabase dev), and commit `feat: plate analysis on generated plates; Krishna brand kit + voice bible`.

---

## End-to-end check (once, at the end): `pnpm e2e:library`
A script (`apps/worker/src/e2e-library.ts`):
1. Creates a product for the Operator org from **one** photo of `fixtures/eval-products/krishna-hing-ras`.
2. Runs ingest through Inngest dev with ComfyUI and vision running, and the subscription LLM.
3. Prints the anchor tag, cutout key, OCR text, viewpoint, palette and descriptor.
4. Generates one plate and prints its PlateAnalysis, luma grid summary and depth key.

**Pass:**
- every field is present;
- the OCR text contains the brand's label words;
- the descriptor has no invented label text;
- services are stopped afterwards and VRAM is back at baseline (`nvidia-smi`);
- no process is left listening on 8188, 8190, 8191 or 8192.
