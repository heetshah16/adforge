# Inngest connect — provider reference

**Fetched:** 2026-10-27 (inngest.com/docs/setup/connect). **Verified against installed types:** `inngest` 4.21.1, `components/connect/types.d.ts`. Import: `import { connect } from 'inngest/connect'`.

- **Usage:** `const conn = await connect({ apps: [{ client, functions }], ... })`; resolves once the connection is ACTIVE. Outbound WebSocket only, so no inbound port. Needs Node 22.4+, a long-running host (not serverless). Free plan: 3 concurrent worker connections.
- **Options:**
  - `instanceId`: stable worker id (default `HOSTNAME`). Connections sharing one share a concurrency limit.
  - `maxWorkerConcurrency`: caps simultaneous steps; unset/0 is unlimited (env `INNGEST_CONNECT_MAX_WORKER_CONCURRENCY`, option wins).
  - `handleShutdownSignals`: signals that start graceful shutdown (default SIGINT/SIGTERM); `[]` disables. We pass `[]` because our shutdown owns signals.
  - `gatewayUrl`: override WS gateway (self-hosted only, port 8289; env `INNGEST_CONNECT_GATEWAY_URL`).
  - `isolateExecution` (types only; default true): runs the WebSocket, heartbeater and lease extender in a worker thread so blocking user code does not hurt connection health. `INNGEST_CONNECT_ISOLATE_EXECUTION=false` disables it.
- **Lifecycle:** `state` is CONNECTING, ACTIVE, PAUSED, RECONNECTING, CLOSING, CLOSED. `close(): Promise<void>` starts graceful shutdown (new steps rejected, in-flight steps finish, results flushed over HTTP). `closed: Promise<void>` resolves when fully closed. Reconnects automatically, unlimited by default.
- **Dev server:** supported with `INNGEST_DEV=1`; no keys needed. (We do not exercise it in tests.)
- **Prod env:** `INNGEST_SIGNING_KEY` and `INNGEST_EVENT_KEY`.
- **Bundling:** keep `inngest` and `inngest/*` external.
- **One app id, one registering endpoint.** An app id is synced as a whole by whichever endpoint registers it (serve or connect), so serve and connect under one id would overwrite each other's function list. Hence two apps: `adforge-web` (Vercel `serve()`) and `adforge-gpu` (this worker, connect). Event names are shared across apps.
- **Dev vs cloud mode:** a boolean `isDev` on the client overrides `INNGEST_DEV`, so the client sets `isDev` from `ADFORGE_ENV`.
- **Preview/branch environments:** need `INNGEST_ENV` set to the branch environment name plus that environment's own signing key (and event key).
- **The two apps in practice (B4 Task 2):** `adforge-web` = `apps/web/app/api/inngest/route.ts`, `serve()` from `inngest/next`, functions from `@adforge/pipeline/light` (dispatcher: cron `* * * * *` + `adforge/dispatch.nudge`; janitor: cron `*/5`). `adforge-gpu` = the worker (generate-ads, heavy-*, product-ingest, variant-edit/export, gpu-idle). Dev: `pnpm --filter @adforge/worker inngest:dev` points the dev server at both endpoints (`-u http://127.0.0.1:3001/api/inngest -u http://127.0.0.1:3000/api/inngest`), so run the web dev server too or jobs submitted from the web never dispatch. The worker's dev `POST /api/jobs` claims its own job at insert (`dispatched_at`) and sends `job.requested` itself, so `pnpm e2e` still runs without the web.
- **Web endpoint security:** no session (the proxy lets `/api/*` through); `serve({ enableUnauthedSync: false })`, so in cloud mode every request, sync `PUT`s included, must be signed with `INNGEST_SIGNING_KEY` (prod web env requires it). Syncs then come from the Inngest UI/API or the Vercel integration, never an anonymous `PUT`.
