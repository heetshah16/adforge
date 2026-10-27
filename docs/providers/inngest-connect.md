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
