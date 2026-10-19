import { defineConfig } from 'vitest/config';

// Real renders spawn Chrome, and render.test.ts counts Chrome processes machine-wide: render files must not overlap.
export default defineConfig({
  test: { fileParallelism: false },
});
