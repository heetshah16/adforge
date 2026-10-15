# 0001 — Local POC infrastructure stand-ins

**Status:** accepted · 2026-10-15 · Spec: docs/superpowers/specs/2026-10-15-adforge-local-poc-design.md §2

## Context
The POC must run end to end on one Windows machine with no Docker and zero media spend, without forking the code shape architecture.md prescribes.

## Decision
Keep every seam; swap what is behind it:
- Supabase Postgres → **PGlite** with the same Drizzle schema and migrations. Single-process, guarded by a pid lockfile.
- Supabase Auth → one seeded local user; `userId` still threads through the schema.
- R2 → **LocalDiskStorage**, content-addressed under `ADFORGE_DATA_DIR`, served at `/media/<key>`.
- Inngest Cloud → Inngest dev server. fal.ai → ComfyUI (ADR 0002). ElevenLabs → Kokoro (ADR 0003).
- Langfuse/Sentry deferred; `provider_calls` is still written.
- `ADFORGE_DATA_DIR` must live outside OneDrive; boot-check warns otherwise.
- pnpm 12 policies: `allowBuilds: { esbuild: true }` (tsx and drizzle-kit need esbuild's binary); `@electric-sql/pglite` pinned to 0.5.8 rather than bypassing pnpm's minimum-release-age gate for a day-old release.

## Consequences
Going to production is new adapters + env, not a rewrite. PGlite cannot be shared by two processes, so seed scripts and the dev server cannot run against the same data dir at once.
