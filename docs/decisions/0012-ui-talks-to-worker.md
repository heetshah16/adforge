# 0012 — The UI talks to the worker directly

**Status:** accepted · 2026-10-16

## Decision
- **The UI is client-only.** `apps/web` (Next 16.3.8) holds client components and has **no server code**. It reads and writes only through the worker's HTTP API (`NEXT_PUBLIC_WORKER_URL`), and parses every response with Zod.
- **No proxy through Next.** The worker sends `Access-Control-Allow-Origin: ADFORGE_UI_ORIGIN`. A multipart POST and a body-less POST are CORS simple requests, so there are no preflights. This avoids Next's proxied-body size limit, since uploads can reach 25 MB.
- **Origin/Host guard on every route** (including `/api/inngest`). CORS only stops the browser *reading* a response; it does not stop a cross-site form from *sending* a simple POST. The guard rejects any request whose `Origin` is not `ADFORGE_UI_ORIGIN` (CSRF) and any whose `Host` is not the worker's own (DNS rebinding).
- **`ADFORGE_UI_ORIGIN` is an exact match.** It defaults to `http://localhost:3000`. Browsing at `http://127.0.0.1:3000` is a different origin and is rejected; to use it, change the env value (and restart the worker).
- **Media from the worker.** `ADFORGE_PUBLIC_URL` is the worker, so `<video>` plays from `/media/<key>` directly. Appending `?download=1` makes the worker send `content-disposition: attachment`, which the Download link uses.
- **TypeScript 5.9.3 in `apps/web` only,** because Next's build uses the TypeScript JS API. The repo stays on TS 7. Typecheck there runs `next typegen && tsc`, so route types exist on a fresh clone.
- **Approval:** a single approval per job. Approving another variant moves it, atomically.
- **`variants.visualTreatment` stays `text`.** It's render-coupled, so the closed Zod enum in `packages/core` is the gate. A pgEnum would add a migration for every new treatment and catch nothing the Zod parse doesn't already catch.

## Consequences
- Moving to a hosted deployment means putting the worker behind the same origin, or tightening CORS. The UI code is unchanged.
- There is no server-side rendering of job data. That's acceptable for a local review tool.
- The end-to-end check is `pnpm e2e:ui` with `ADFORGE_E2E_PRODUCT=<eval-products folder>`; it needs the full stack running and makes live LLM calls.
