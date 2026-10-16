# 0008 — HyperFrames renderer: composition per spec, offline, deadline-bounded

**Status:** accepted · 2026-10-16

## Decision
- **Pinned versions:** `@hyperframes/producer` and `@hyperframes/engine` **0.8.106** (2026-10-01), with every transitive `@hyperframes/*` package held at 0.8.106 via pnpm `overrides`. Upgrades are deliberate PRs.
- **One HTML composition per render,** generated from the `VideoSpec` by a pure function (`composeHtml`). HyperFrames composition variables are **not** used: the spec already holds every value, so there is no stringly-typed payload to validate.
- **Asset references are storage keys.** "assetId" in CLAUDE.md means `MediaRef.id`. `stageProject` copies each key into the project's `assets/`.
- **Offline render:** GSAP and fonts (Inter for Latin, Noto Sans Devanagari for Hindi) are copied from pinned npm packages into each project.
- **Timing:** frames are the source of truth. `secs()` floors to whole microseconds, so frame *n* always falls inside its clip window. The producer's frame count is `durationToFrameCount`: round when within 1e-3 frames of an integer, else ceil. A test simulates every frame and checks that count for n = 1…899.
- **Composition rules:**
  - The plate and the cutout share one motion stage, so the real product never drifts against its scene.
  - B-roll `<video>` elements and `<audio>` sit at the root, as the HyperFrames lint rules require.
  - Each b-roll clip is trimmed to its scene by `data-duration` / `data-media-start`.
- **Liveness:**
  - each render has a deadline (`renderTimeoutMs`, default 15 min) through `executeRenderJob`'s abort signal; a timeout is a retryable `TIMEOUT`;
  - the browser pool is drained and the temp project removed after every render.
- **Idempotency** is the caller's job: P7's Inngest step memoization. The renderer itself does no caching.

## Measured
`pnpm e2e:render` (1080×1920, 600 frames, `standard` quality): 28.2 s on the i9-14900K, in Windows screenshot capture mode.

## Consequences
- Rendering is CPU- and RAM-heavy (Chrome plus FFmpeg). It belongs in P7's `heavy` lane alongside ComfyUI and TTS.
- Caption style and background are not in the POC IR. Captions are a fixed boxed-word style (Inter/Noto 800, 76 px). A treatment's `captionWeight`/`scrim` drive the *overlay* text layer (P6 `buildSpec`). A video-background scene is always `static`.
