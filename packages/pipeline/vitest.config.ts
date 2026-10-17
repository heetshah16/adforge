import { defineConfig } from 'vitest/config';

// Cold PGlite (WASM) open+migrate takes 6-12 s on a 4-vCPU CI runner under turbo's parallel test tasks.
export default defineConfig({
  test: { testTimeout: 30_000, hookTimeout: 30_000 },
});
