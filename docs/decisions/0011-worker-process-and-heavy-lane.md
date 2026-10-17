# 0011 — Worker process owns the pipeline; one shared heavy lane

**Status:** accepted · 2026-10-16

## Decision
- **The worker owns the pipeline.** `apps/worker` is a plain Node `node:http` server, run by `tsx`, and is the **only** process that opens PGlite and storage and runs Inngest functions. P8's Next.js UI proxies `/api/*` and `/media/*` to it and never imports server packages.
  - **Why:** Next would bundle our workspace packages, which read prompts, workflows, GSAP and fonts relative to `import.meta.url`. PGlite is single-process.
- **The heavy lane:** `heavy-plates`, `heavy-broll`, `heavy-voice` and `heavy-render` are separate Inngest functions, all with `concurrency: [{ scope: 'env', key: '"heavy"', limit: 1 }]`, called with `step.invoke`, which holds no slot while waiting. The LLM stages run outside the lane.
- **Batches by model, with hand-off:**
  1. plates and cutout, then ComfyUI `/free`;
  2. b-roll, then `/free`;
  3. voice and align, then voice `/unload`;
  4. one render per variant.
- **Partial success:** the job is `completed` when ≥1 variant finishes; failed variants carry their reason.
- **Liveness:** function timeouts, the request timeout on the worker, a 5-minute janitor (fails jobs silent for 60 min, frees GPU holders when idle), and graceful shutdown that releases the PGlite lock.

## Measured (`pnpm e2e:pipeline krishna-special-hing`, b-roll off, English, 4 photos)
- **Total:** 5.3 min wall, `COMPLETED`, 3/3 variants, no warnings, no partial success. Cost ~$0.22 (Strategist + Director on the subscription; `repairs=0`).
- **Per stage** (from the job progress log): preflight <1 s · strategize 7.5 s · direct 51 s · plates 94 s · broll skipped · voice 72 s · render 29 s / 34 s / 26 s for variants 1-3 (sequential, one per heavy-lane slot) · finalize ~0.
- **Peak VRAM:** 15,729 MiB of 16,303 MiB (sampled every 4 s; baseline ~0.7 GB). Tight but under the limit; never concurrent in the lane.
- **Peak RAM:** not sampled in this run.
- **Outputs:** three 1080×1920 30 fps H.264 MP4s with AAC audio, 604 / 728 / 600 frames (20.1 s / 24.3 s / 20.0 s).
- **Pinned-memory (`--disable-pinned-memory`) experiment:** not run. It needs a second plates run on a fresh upload and a RAM sampler; deferred. `scripts/comfyui.ps1` is unchanged.
- **Noise:** with voice-qwen not running, every voice hand-off and janitor tick logs a best-effort "voice-qwen unload failed (ECONNREFUSED :8191)" stack trace. Harmless, but worth downgrading to one line.
- **Shutdown on Windows:** a console Ctrl-C could not be delivered to the detached background worker, so it was force-killed and the stale PGlite lock removed by hand. The SIGINT path itself is covered by the shutdown tests.
