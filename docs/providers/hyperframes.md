# HyperFrames — provider reference

**Fetched:** 2026-10-16 from the HyperFrames source (v0.8.91 checkout in the Claude plugin cache: `packages/producer`, `packages/engine`, `skills/hyperframes-core`). **Pinned version:** `@hyperframes/producer` / `@hyperframes/engine` **0.8.106**.

## Programmatic render
- `createRenderJob(config)` → `RenderJob`. Required: `fps` (`{ num: 30, den: 1 }` or a number) and `quality` (`'draft' | 'standard' | 'high'`). Optional: `format` (default `'mp4'`), `workers`, `crf`, `strictness`, `entryFile` (default `index.html`), `logger`.
- `executeRenderJob(job, projectDir, outputPath, onProgress?, abortSignal?)` → `Promise<void>`. On return, `job.status` / `job.error` / `job.failedStage` describe the outcome.
- `drainBrowserPool()` / `closeBrowserPool()` from `@hyperframes/engine` close pooled Chrome.
- **Frame count:** `totalFrames = ceil(rootDurationSeconds × fps)`.

## Environment
- **FFmpeg / FFprobe:** found on `PATH`, or via `HYPERFRAMES_FFMPEG_PATH`.
- **Chrome:** `chrome-headless-shell`. The engine looks in this order:
  1. `PRODUCER_HEADLESS_SHELL_PATH`;
  2. `HYPERFRAMES_BROWSER_PATH`;
  3. `~/.cache/hyperframes/chrome/chrome-headless-shell`;
  4. `~/.cache/puppeteer/chrome-headless-shell` (installed by puppeteer's postinstall).
- **On Windows** capture uses screenshot mode. BeginFrame is Linux-only.

## Composition contract (what AdForge's `compose.ts` relies on)
- **Standalone `index.html` root:** `<div id="root" data-composition-id="…" data-width data-height data-duration>`, with no `<template>`. The root uses `width/height: 100%`; the canvas size comes from `data-width` and `data-height`.
- **Root `data-duration`** (seconds) is the render length. It is read once at compile time.
- **Clips:** any element with `data-start` (seconds), plus `data-duration`. Visibility is half-open: `[start, start+duration)`. Direct children of the root get `position:absolute; top:0; left:0`. `class="clip"` is a convention.
- **One paused GSAP timeline**, registered as `window.__timelines["<composition-id>"]`.
- **Media:**
  - `<video id muted playsinline data-start data-duration data-media-start>` must not be inside another `data-start` element.
  - `<audio id src data-start data-duration data-volume>`. **`id` is required, or the audio is silent.**
  - No `crossorigin`.
- **Determinism:** no wall clock, no network, no unseeded random, no `repeat:-1`. Fonts need an in-file `@font-face` pointing to a local file.
- **Lint traps:**
  - a CSS `transform` plus a GSAP tween on the same node (`gsap_css_transform_conflict`);
  - tweening `visibility`/`autoAlpha` on a `.clip`;
  - an `<audio>` without an `id`;
  - a `<video data-start>` inside a timed wrapper.
