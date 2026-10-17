# 0014 — Env profiles and Postgres

**Status:** accepted · 2026-10-17

## Decision
- **Profiles via `ADFORGE_ENV`** (`dev` default, or `prod`). `dev` uses PGlite under `ADFORGE_DATA_DIR`. `prod` requires `DATABASE_URL` (Postgres); `Env` refuses to parse without it.
- **Driver-neutral `Db` type.** Callers see one `Db` type from `packages/db/src/client.ts`. `openDbForEnv` picks PGlite or Postgres from the profile. Nothing outside `packages/db` imports a driver.
- **`prepare: false`** on the postgres-js client, so the connection works behind Supabase's transaction pooler. `connect_timeout` defaults to 10 s.
- **Provider policy enforced in `parseEnv`.** `assertProviderPolicy` runs after the Zod parse. In `prod`, any `ADFORGE_PROVIDER_*` value in `POC_ONLY_PROVIDERS` fails startup. The set is empty today.
- **CI runs on Linux only.** GitHub Actions service containers (the Postgres 17 service) are supported only on Linux runners.
- **Python voice services are not in CI.** `services/voice` and `services/voice-qwen` need torch/CUDA and a GPU machine.
- **`postgres` is pinned to 3.4.9** (catalog entry in `pnpm-workspace.yaml`, published 2026-04-05). Upgrades are deliberate.
- **Live Postgres tests run only when `ADFORGE_TEST_DATABASE_URL` is set.** Without it they skip. CI sets it to its service container.

## Test portability fixes
- `packages/core/test/env.test.ts` uses `resolve('/adforge-data')` so the absolute-path assertion holds on both Windows and POSIX.
- `packages/renderer-hyperframes/test/render.test.ts` counts Chrome processes with `tasklist` on Windows and `ps` elsewhere.

## Consequences
- Chrome for the renderer tests in CI comes from puppeteer's allowed postinstall script. Verify on the first CI run; if it does not download, the renderer tests will fail there.
- The Supabase dev-project parity check is pending the user's Supabase CLI and token setup. Until then, the CI Postgres container is the parity proof.
- Moving a provider id into `POC_ONLY_PROVIDERS` blocks it in prod with no other code change.
