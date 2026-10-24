# @hyperframes/player (0.8.106)

Source: the package README and `dist/hyperframes-player.d.ts` shipped in `node_modules/@hyperframes/player` (read at install, not from memory). Pinned exactly, equal to the other `@hyperframes/*` (catalog in `pnpm-workspace.yaml`). Depends only on `@hyperframes/core` 0.8.106. Display only in C2; the editing UI is C7.

## Mount API

A web component, `<hyperframes-player>`, registered by `import '@hyperframes/player'` (browser only; the preview imports it dynamically inside `useEffect`, never at module load, so SSR and the Next build are untouched).

The composition runs in a sandboxed iframe inside the component's shadow DOM. Attributes we use:

| Attribute | Use |
|---|---|
| `srcdoc` | The composition HTML string. Wins over `src`. This is how the preview provides `previewHtml(spec, mediaUrl)`: no URL to host. |
| `runtime-src` | Same-origin (or localhost) URL of the HyperFrames runtime script, injected into the composition's `<head>`. Any other value falls back to jsDelivr. |
| `width` / `height` | Composition pixel size, for aspect ratio (1080x1920 for us). Not the display size. |
| `controls` | Built-in play/pause, scrubber, time display. This is the preview's whole UI. |

The element is created imperatively (`document.createElement('hyperframes-player')`), attributes set, then appended; React never renders the custom tag, so no JSX typing is needed.

## Seek and playback

`player.play()`, `player.pause()`, `player.seek(seconds)`, `player.currentTime`, `player.duration`, events `ready`, `timeupdate`, `ended`. Seek is in seconds. `lib/preview.ts#previewFrame(frame, fps)` converts with the compositor's own `secs()` (floor to microseconds), so frame n lands inside frame n's window. `player.iframeElement` reaches the composition's document and `__timelines` (same-origin sandbox).

**Deterministic seek for the e2e (ruling 6):** the preview host `<div data-preview>` carries `seekToFrame(n)`, which pauses and seeks to frame n. From Playwright: `await page.locator('[data-preview]').first().evaluate((el, n) => el.seekToFrame(n), 12)`. The host gets a `data-ready` attribute when the player fires `ready`; the e2e waits with `page.locator('[data-preview][data-ready]')` (open the collapsed `<details>` first). A `seekToFrame` call before ready is queued and applied at `ready`. The player is keyed on the revision id only, so poll refreshes do not remount it (`data-ready` is cleared and re-set only when the revision changes). For image/font paint, the player also fires `assetsready` and `painted`.

## How assets load

- Composition media (`<img>`, `<video>`, `<audio>`): absolute URLs from `storage.urlFor(key)`, passed through `composeHtml`'s `assetUrl`. The job view returns them per variant in `revision.assetUrls` (key to URL), so the signing and tenancy rules are unchanged. They are fetched with the storage URL, not through the player.
- GSAP and fonts: `composeHtml(spec, { staticBase: '/hf' })` points them at `apps/web/public/hf/`. That folder is **gitignored** and filled by `apps/web/scripts/copy-hf-assets.ts` (`pnpm --filter @adforge/web hf-assets`, run automatically: the web `dev` and `build` scripts run the copy) from `gsap`, the `@fontsource/*` packages (`FONT_FILES`) and `@hyperframes/core/runtime`. No binaries are committed. The player has no asset-base option, hence the script.
- Runtime: left alone, the player injects `https://cdn.jsdelivr.net/npm/@hyperframes/core@0.8.106/dist/hyperframe.runtime.iife.js`. The preview overrides it with `runtime-src=/hf/hyperframe.runtime.iife.js` (the same file from node_modules), so the preview needs no third-party network.

## Determinism notes

- The preview and the renderer share one compositor (`composeHtml`); they differ only in `assetUrl` and `staticBase`. A composition built here is the one the producer renders from staged files.
- The page uses no wall clock or randomness: the timeline is a paused GSAP timeline driven by the player/runtime. Live playback in the browser is real-time and is for review, not a render; exports always go through Inngest (`variant.export`).
- Mobile audio: the player copies timed `<audio>`/`<video>` into the parent frame, so the same media URLs must be CORS/fetch-reachable from the page origin (they are `/media/*` or the worker URL).
