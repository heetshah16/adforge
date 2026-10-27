# Inngest — provider reference

**Fetched:** 2026-10-16 (inngest.com/docs: reference/typescript/functions/create, guides/concurrency). **Verified against installed types 2026-10-17.** **Pinned:** `inngest` 4.21.1, `inngest-cli` 1.45.1 (dev server).

- **Client:** `new Inngest({ id: 'adforge-gpu', isDev: ADFORGE_ENV === 'dev' })` (packages/pipeline `makeInngest`; a boolean `isDev` overrides `INNGEST_DEV`, so it must follow the env). In v4, `baseUrl` / `fetch` / signing keys live on the client, not on `serve`.
- **Function:** `inngest.createFunction({ id, triggers: [{ event: 'x' } | { cron: '*/5 * * * *' }], concurrency, retries, timeouts }, async ({ event, step, runId, attempt, logger }) => …)`. Triggers live in the options object in v4. A function with no triggers (invoke-only) omits `triggers`. The docs do not describe invoke-only functions explicitly; treat that as unverified until Task 2 exercises it.
- **Concurrency** counts **executing steps**, not runs. `key` is a CEL expression, so `'"heavy"'` is a constant. With `scope: 'env'`, **different functions sharing the same key share one limit**. Configure every sharing function with the same scope, key and limit. `step.sleep` / `step.sleepUntil` / `step.invoke` / `step.waitForEvent` hold no slot while waiting. A function may have at most 2 concurrency constraints.
- **Steps:**
  - `step.run(id, fn)` is a memoized, retriable unit; its result is serialized to JSON.
  - `step.invoke(id, { function, data })` calls another function by instance (v4 rejects a raw string).
  - `step.sleep(id, duration)` pauses.
- **Retries:** `retries` is 0–20 (default 4). Throwing inside `step.run` retries that step.
- **Timeouts:** `timeouts: { start, finish }`. Verified in installed types (`inngest` 4.21.1, `Inngest.d.ts`): `start` (scheduled → started) and `finish` (execution timeout).
- **Serving over node:http:** `import { serve } from 'inngest/node'`; `serve(options)` returns a `RequestListener`, used as `http.createServer(serve({ client, functions }))`. Verified in `node.d.ts`.
- **Dev server:** `inngest-cli dev -u http://127.0.0.1:3001/api/inngest`; its UI runs at http://127.0.0.1:8288.
