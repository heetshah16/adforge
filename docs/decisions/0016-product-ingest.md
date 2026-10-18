# 0016 — `adforge/product.ingest`: photos to versioned library rows

**Status:** accepted · 2026-10-18

## Decision
- **Payload:** `{ productId, photoAssetIds }` (1–5 upload asset ids, in display order). Ingest refuses the run, with no rows and no provider calls, when any asset:
  - is not an `upload` of the product's org; or
  - has a mime outside `IMAGE_MIMES` (png, jpeg, webp, the set `analyzeProduct` accepts).

  Rows record `meta.sourceAssetId`; `assets` is unchanged.
- **Steps** (`packages/pipeline/src/ingest.ts`):
  1. `load`;
  2. `cutouts` (then `comfy.free`, in a `finally`);
  3. `ocr` (then `vision.unload`, in a `finally`);
  4. `analyze:joint`, then one `analyze:<photo sha>` per other photo;
  5. `write`.
- **One Inngest step per analysis.** Each paid call (with its single repair, inside `analyzeProduct`) is memoized on success. A retry re-runs only the failed call, and the joint result (`bestPhotoIndex`) is a stable input to the rest.
- **No partial rows:** only `write` touches `library_assets`, in one transaction, so a failure anywhere leaves no partial rows.
- **Every provider call is recorded** in `provider_calls`, with `orgId` and no job. A provider or analysis that throws is recorded as a retryable `UNKNOWN` failure.
- **Keys:**
  - Everything is namespaced `ingest:<orgId>:<productId>`.
  - The cutout and OCR keys add the photo sha. They are local and free, and ComfyUI dedupes by key.
  - The ingest key adds a hash of the sorted photo shas, so photo order doesn't matter.
  - The LLM keys are `<ingestKey>:<runId>:analysis[:<sha>]`. The Inngest run id keeps a later run's paid calls in their own `provider_calls` rows; without it, re-ingesting an older photo set after a newer one would re-bill under keys that are already `done`, and `recordCall` never overwrites those. Retries within one run reuse the key, so a failed row is replaced by the retry's success.
  - Re-running an ingest whose key already has active rows is a no-op. This is checked in `load` and again inside the write transaction.
- **Analysis, N calls for N photos:**
  - One joint `analyzeProduct` over every photo picks `bestPhotoIndex` (the anchor). It also gives the product-level fields: `shapeClass`, `material`, `finish`, `palette`.
  - Each other photo gets its own single-photo analysis, which contributes only its view: `viewpoint`, `visibleFaces`, `lightDirection`, `descriptor`. The joint call's view describes the best photo only.
  - The product-level fields on every row come from the joint result, so one product never carries two palettes.
- **Tags:** `makeTag('product_view', [slug, face, bucket])`.
  - `face` is `visibleFaces[0]`.
  - `bucket` is `top` or `bottom` when the elevation is 60° or more either way. Otherwise it comes from the azimuth: `front` up to 22.5°, `three-quarter-<side>` up to 67.5°, `<side>` up to 135°, `back` beyond.
  - The bucket is dropped when it equals the face (`@prod_x_front`, `@prod_x_front_threequarterright`).
  - A second photo with the same view gets `_2`.
- **Slug:** a product keeps the slug of its first ingest, read back from any of its `product_view` rows, so a rename never moves its tags. On the first ingest:
  - the slug is the name reduced to `[a-z0-9]`, or `p<first 8 hex of the id>` when nothing survives (for example a Devanagari-only name);
  - the first product in an org to hold a slug keeps it;
  - a later product whose name reduces to the same slug gets its id prefix appended.
- **An ingest defines the product's current view set.** Earlier active `product_view` rows of the product, and any active holders of the new tags, become `superseded`. Each tag's version is `nextVersion` of its existing versions.
- **`updateDescriptor`** edits only the tag's active row and never revives a superseded view.
  - It runs the same guard as `analyzeProduct` (40–120 words, no label text).
  - It copies the active row to version max+1, `active`, and supersedes the old one, in one transaction.
- **Lane and concurrency:**
  - The function shares the heavy lane's concurrency key at `priority.run: '600'`. B4 sets the real priorities.
  - Inngest concurrency limits **executing steps, not whole runs**. The LLM steps take the lane only while they execute (as do the GPU steps), and two runs for the same product can interleave between steps.
  - The backstop for a duplicate run is the ingest-key re-check inside the write transaction plus `unique(org_id, tag, version)`. The loser either skips or errors, and its retry skips.
- **Attribution:** the job config snapshot and each ingest result record the vision model, its effort and both vision prompt hashes. Every row carries `meta.analysisModel` and `meta.analysisPrompt`.
