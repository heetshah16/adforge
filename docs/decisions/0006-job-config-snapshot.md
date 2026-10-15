# 0006 — Snapshot resolved config onto every job

**Status:** accepted · 2026-10-15

## Context
The POC makes every tunable changeable (env, `pipeline.ts`, `treatments.ts`, workflow files, prompt files). Without a record of what a job ran with, an old output can't be explained or compared — the same reason `jobs.shortlist` exists.

## Decision
`jobs.configSnapshot` (jsonb) stores, at preflight: the parsed `PIPELINE`, `TREATMENTS`, selected provider ids, ComfyUI workflow names + file SHA-256s, LLM model ids + effort, and prompt file SHA-256s. Secrets are never included.

## Consequences
Before/after comparisons across a config change are a query, not archaeology. Snapshots are a few KB per job.
