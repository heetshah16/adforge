# 0017 — C1: vision service, analysis policy, voice bible, asset insert grants

**Status:** accepted · 2026-10-18

## Decision
- Depth and OCR run in a separate local service `services/vision` (FastAPI on 127.0.0.1:8192): Depth-Anything-V2 Small (Apache-2.0; Base/Large are non-commercial and not used) and EasyOCR 1.7.2 (Apache-2.0), plus a deterministic Rec.709 luma grid. Same liveness pattern as voice-qwen (GPU lock, idle unload, watchdog exit 3, restart loop).
- The ModelSlot/Watchdog helpers are copied from voice-qwen, not extracted into a shared package; that is a recorded debt to pay when a fourth Python service appears.
- Product descriptors contain no label text. They describe label layout, colours and script in words; real label text lives only in OCR metadata. A code-level guard rejects quoted strings, ALL-CAPS tokens of 3+ letters and digit runs of 3+, and enforces 40–120 words, with one repair pass naming the problems, then a non-retryable failure.
- Plate analysis (luma, depth, PlateAnalysis LLM) runs after plates are generated and before b-roll, is best-effort (failures become one aggregated job warning), stores its result on the plate asset (`assets.analysis`), and runs one LLM step per plate in parallel.
- Voice bible: a `@voice_<brand>_en` library row locks the Qwen speaker and a base instruct prefix. The voice used (`<tag>_v<n>` or `config-defaults`) is recorded in the job config snapshot and on TTS provider_calls. A missing bible is silent but recorded; a warning is raised only when a bible was expected (explicit brand, or the org has a voice row) or a row exists but is unusable, the slug can't be made, or the lookup fails. A bad or failing bible never fails the voice step.
- The brand kit row is created only when palette or font data exists; a hollow existing kit is superseded.
- Migration 0015 replaces the table-wide `assets` INSERT grant for `authenticated` with an explicit column list that excludes `analysis`. Because drizzle names every column in an INSERT, user-path inserts go through `assetsForInsert`, a second table definition without `analysis`; a test keeps its columns, SQL names and the 0015 GRANT list in lockstep with `assets`. This amends ADR 0015's note about table-wide INSERT on assets.
- Ingest LLM idempotency keys are scoped to the Inngest run (and attempt), so retries within a run reuse keys and a later run records its own spend.

## Consequences
- About 2.1 GB extra VRAM while vision models are loaded; total peak about 15.8 of 16.3 GB during a job, so headroom is thin.
- Plate analysis adds paid LLM calls per job (one per plate); nothing consumes `assets.analysis` until C3/C4.
- Real label text for prompts must come from OCR metadata or the brand kit, never from descriptors.
