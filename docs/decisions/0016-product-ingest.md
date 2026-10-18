# 0016 — `adforge/product.ingest`: photos to versioned library rows

**Status:** accepted · 2026-10-18

## Decision
- **Payload:** `{ productId, photoAssetIds }` (1–5 upload asset ids, in display order). Ingest refuses, with no rows and no provider calls, when any asset is not an `upload` of the product's org. Rows record `meta.sourceAssetId`; `assets` is unchanged.
- **Steps** (`packages/pipeline/src/ingest.ts`): `load` → `cutouts` (then `comfy.free`, in a `finally`) → `ocr` (then `vision.unload`, in a `finally`) → `analyze` → `write`. Only `write` touches `library_assets`, in one transaction, so a failure anywhere leaves no partial rows. Every provider call is recorded in `provider_calls` with `orgId` and no job.
- **Keys:** everything is namespaced `ingest:<orgId>:<productId>`. The cutout and OCR keys add the photo sha; the ingest key adds a hash of the sorted photo shas, so photo order doesn't matter. The analysis keys hang off the ingest key. Re-running an ingest whose key already has active rows is a no-op (checked in `load` and again inside the write transaction).
- **Analysis, N calls for N photos:** one joint `analyzeProduct` over every photo picks `bestPhotoIndex` (the anchor) and describes it. Each other photo gets its own single-photo analysis, because the joint call's viewpoint and faces describe the best photo only, and each row needs its own view.
- **Tags:** `makeTag('product_view', [slug, face, bucket])`. `face` is `visibleFaces[0]`. `bucket` is `top`/`bottom` when the elevation is 60° or more either way; otherwise it comes from the azimuth: `front` up to 22.5°, `three-quarter-<side>` up to 67.5°, `<side>` up to 135°, `back` beyond. The bucket is dropped when it equals the face (`@prod_x_front`, `@prod_x_front_threequarterright`). A second photo with the same view gets `_2`.
- **Slug:** the name reduced to `[a-z0-9]`, or `p<first 8 hex of the id>` when nothing survives (for example a Devanagari-only name). The first product in an org to hold a slug keeps it. A later product whose name reduces to the same slug gets its id prefix appended.
- **An ingest defines the product's current view set.** Earlier active `product_view` rows of the product, and any active holders of the new tags, become `superseded`. Each tag's version is `nextVersion` of its existing versions.
- **`updateDescriptor`** runs the same guard as `analyzeProduct` (40–120 words, no label text). It copies the latest row to version n+1, `active`, and supersedes the rest, in one transaction.
- **Lane:** the whole function sits on the shared heavy lane at `priority.run: '600'`, so the LLM analysis holds the lane too (unlike `generate-ads`, ADR 0011). B4 sets the real priorities.
- **Attribution:** the job config snapshot and each ingest result record the vision model, its effort and both vision prompt hashes. Every row carries `meta.analysisModel` and `meta.analysisPrompt`.
