# Vercel + Supabase pooler (web deploy)

Fetched 2026-10-27 from the sources named per section. Re-fetch before changing anything here.

## Monorepo (https://vercel.com/docs/monorepos)
- One Vercel project per app directory; set **Root Directory** (`apps/web`) in the import screen or Settings > Build and Deployment.
- Unaffected projects are skipped automatically (GitHub + pnpm workspaces; unique package names; inter-package deps must be declared).
- Optional filtered install: `installCommand` in `apps/web/vercel.json` (e.g. `pnpm install --filter web...`). Not needed; no `vercel.json` is created.
- Build command: leave at the framework default so Vercel runs the package `build` script. `apps/web` `build` = `tsx scripts/copy-hf-assets.ts && next build`; pnpm does not run `pre*` scripts, so overriding the command in the UI would skip the HyperFrames asset copy.

## Supabase pooler (https://supabase.com/docs/guides/database/connecting-to-postgres)
- Transaction mode: shared pooler `aws-<n>-<region>.pooler.supabase.com:6543`, user `postgres.<project-ref>`, IPv4. Copy the host from the Connect dialog.
- "Transaction mode does not support prepared statements": Postgres.js and Drizzle use `prepare: false`. Already set in `packages/db/src/client.ts` (`pgOptions`).
- Session state (`SET`/`RESET`, session advisory locks, LISTEN/NOTIFY, temp tables) does not persist between transactions; no query pipelining.

## Statement timeout (https://supabase.com/docs/guides/database/postgres/timeouts)
- Per-session `set statement_timeout` "cannot be used ... with Supavisor in Transaction mode (port 6543)"; it works only on session mode (5432) or a direct connection.
- Startup parameters (postgres-js `connection: { statement_timeout }`) are not documented as supported on :6543. Not used.
- **Mechanism chosen: per transaction.** `withUser` (tenant request path) runs `set_config('statement_timeout', '15000', true)` (transaction-local) right after `set local role`. Constant `STATEMENT_TIMEOUT_MS` in `packages/db/src/client.ts`.
- Known ceiling: owner-connection autocommit queries (`getDb()` callers other than `withUser`) have no per-statement cap beyond the role/database default (anon 3s / authenticated 8s per Supabase docs; the pooler's `postgres.<ref>` role uses the database default). Upgrade path: `alter role postgres set statement_timeout` (role-level settings are applied by the backend on connect and survive pooling), once the controller decides.

## Inngest on Vercel (https://www.inngest.com/docs/deploy/vercel)
- Integration sets `INNGEST_SIGNING_KEY` and `INNGEST_EVENT_KEY` and syncs on every Vercel deploy; without it, sync from the Inngest UI or the API.
- Custom/staging environment: add both keys in Vercel scoped to that environment only. (`INNGEST_ENV` is not covered by that page; it is the SDK's branch-environment selector.)
- Deployment Protection (Standard / All / Only preview) can block Inngest from reaching `/api/inngest`. Either disable it for the project or (Pro) enable "Protection Bypass for Automation" and paste the secret into the Inngest Vercel integration's "Deployment protection key", then redeploy previews so they resync.
