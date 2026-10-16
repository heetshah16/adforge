# 0007 — ComfyUI adapter job model

**Status:** accepted · 2026-10-15

## Context
ComfyUI has no notion of our idempotency keys, keeps history only in memory, and plates and cutouts take seconds while b-roll takes minutes (ADR 0002). Inngest will retry failed steps (P7), so a retry must never render twice.

## Decision
- **Idempotency:**
  - The `prompt_id` is a canonical UUID derived from the idempotency key. `submitOnce` reuses an existing job for that id only when its `/history` entry succeeded or it is still queued/running.
  - On a history miss and a queue miss, it checks `/history` a second time (the job may have just finished) before queueing.
  - If the key's previous run failed (a non-success history entry), the adapter deletes that entry (`POST /history {"delete":[id]}`) and requeues under the same `prompt_id`. A retry therefore re-runs instead of returning the old error.
  - A missing seed is derived from the key the same way, so retries reproduce identical pixels.
- **Request timeout:** every HTTP request (headers and body) made by `ComfyClient` is bounded by `timeoutMs` (default 30s, constructor param). A breach is an `UPSTREAM` error, "timed out after <n>ms". This is distinct from `syncTimeoutMs` (default 120s), which bounds the image and cutout providers' overall wait for a job to finish.
- **Sync vs async:**
  - `ImageProvider.generate` and `CutoutProvider.cutout` wait for the result, bounded by `syncTimeoutMs` (default 120s).
  - `VideoProvider` is submit/poll with a 15s poll hint.
- **Retry policy lives in core:** `isRetryable(code)` covers `UPSTREAM`, `TIMEOUT` and `RATE_LIMIT`, and every adapter result derives `retryable` from it. The one exception is an interrupted job, which a user cancelled.
- **Lost jobs:** a job is "lost" only after two history misses around a queue miss. It is a retryable failure, and the retry resubmits under the same id.
- **Latency:** this is execution time taken from ComfyUI's own `execution_start` and `execution_success` timestamps, excluding queue wait. Cost is $0 and not estimated, since this is local GPU.
- **Video duration:** read back from the `length` input in the history's own copy of the workflow, so the reported duration is what actually ran.

## Consequences
- A timed-out image call can be retried safely: it re-finds the same job. A retry after a failed run clears the old history entry and requeues under the same id, so it genuinely re-runs.
- Workflow JSON hashes are exposed for `jobs.configSnapshot`. The hash covers bytes on disk, so the CRLF/LF checkout style changes it across OSes.
- Swapping to a hosted provider later means implementing the same three core interfaces. Callers stay unchanged.
