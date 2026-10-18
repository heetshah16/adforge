import { defineConfig } from 'vitest/config';

// Cold PGlite (WASM) open+migrate takes 6-12 s on a 4-vCPU CI runner under turbo's parallel test tasks.
// dir scopes discovery to test/, so Playwright specs in e2e/ are never picked up by vitest.
export default defineConfig({
  test: { dir: 'test', testTimeout: 30_000, hookTimeout: 30_000 },
});
