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
- **Liveness:** function timeouts, a 5-minute janitor (`finish: 4m`, concurrency 1; fails only `running` jobs silent for `staleAfterMin`, frees GPU holders when idle), `generate-ads` `onFailure`, and graceful shutdown that releases the PGlite lock.
  - **`server.requestTimeout` bounds request receipt (slow uploads), not handler run time.** It does not guarantee that no request can hang the worker; handlers are short and bounded by their own awaits.
  - **`onFailure`:** when a `generate-ads` run dies (retries exhausted, a heavy `step.invoke` timing out, `load` failing), `failJob` marks the job `failed` with `error: { stage: 'inngest', reason }` and one progress entry, only if it is still `queued` or `running`. A completed job is never overwritten; `finalize` likewise writes only while the job is `running`, so a janitor-failed job is not resurrected.
  - **Enqueue failure:** if `inngest.send` throws, the job is failed with `stage: 'enqueue'` and the API returns 503; the event is sent with `id: jobId` for dedupe.
  - **b-roll is never fatal:** a throwing `heavy-broll` invoke yields no b-roll and a warning `b-roll unavailable: <reason>`.
  - **Values:** `broll.pollDeadlineMs = 480_000` (8 min) so 3 variants x 2 attempts x 8 min = 48 min fits under the `heavy-broll` 60 min `finish`; `jobs.staleAfterMin = 120` so a long, legitimately silent heavy step (queued behind the lane) is not janitor-failed (was 900_000 / 60).
  - **Memoization is per batch, not per call:** each heavy invoke is one `step.run`, so a throw mid-batch re-runs the whole batch and regenerates earlier items; ComfyUI `promptIdFor` dedupe softens the cost.

## Measured (`pnpm e2e:pipeline krishna-special-hing`, b-roll off, English, 4 photos)
- **Total:** 5.3 min wall, `COMPLETED`, 3/3 variants, no warnings, no partial success. Cost ~$0.22 (Strategist + Director on the subscription; `repairs=0`).
- **Per stage** (from the job progress log): preflight <1 s · strategize 7.5 s · direct 51 s · plates 94 s · broll skipped · voice 72 s · render 29 s / 34 s / 26 s for variants 1-3 (sequential, one per heavy-lane slot) · finalize ~0.
- **Peak VRAM:** 15,729 MiB of 16,303 MiB (sampled every 4 s; baseline ~0.7 GB). Tight but under the limit; never concurrent in the lane.
- **Peak RAM:** not sampled in this run.
- **Outputs:** three 1080×1920 30 fps H.264 MP4s with AAC audio, 604 / 728 / 600 frames (20.1 s / 24.3 s / 20.0 s).
- **Pinned-memory (`--disable-pinned-memory`) experiment:** not run. It needs a second plates run on a fresh upload and a RAM sampler; deferred. `scripts/comfyui.ps1` is unchanged.
- **Noise:** with voice-qwen not running, every voice hand-off and janitor tick logs a best-effort "voice-qwen unload failed (ECONNREFUSED :8191)" stack trace. Harmless, but worth downgrading to one line.
- **Shutdown on Windows:** a console Ctrl-C could not be delivered to the detached background worker, so it was force-killed and the stale PGlite lock removed by hand. The SIGINT path itself is covered by the shutdown tests.

### Measured, b-roll on (`pnpm e2e:pipeline krishna-hing-ras --broll`, Hindi, final P8 run)
- **Total:** 19.9 min wall, `COMPLETED`, 3/3 variants, no warnings (no "b-roll unavailable"). Cost ~$0.31 (Strategist + Director, `repairs=1`); all media providers $0.
- **Per stage:** strategize 13 s · direct 89 s · plates 74 s · broll 14.3 min (3 Wan clips, about 4.8 min each, sequential) · voice 79 s · render ~27 s per variant · finalize ~0.
- **Peak VRAM:** 15,729 MiB of 16,303 MiB (sampled every 10 s; baseline 743 MiB; 496 MiB after shutdown).
- **B-roll clips:** 3 generated (one per variant, `provider_calls` kind `video`, all `done`). Only 2 reached the final videos (V1 beat 2, V3 beat 1): `buildSpec` drops a clip shorter than its beat, and V2's first absent beat (156 frames) outran the 5 s (150 frame) clip. The drop is silent. Follow-up: choose the beat after voice durations are known, or emit a warning.
- **Shutdown:** services were force-killed by port owner (no console to deliver Ctrl-Break to); no stale PGlite lock remained.
