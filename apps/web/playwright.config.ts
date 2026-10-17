import { defineConfig } from '@playwright/test';

/** The stack (scripts/stack.ps1: ComfyUI, voice, Inngest dev, worker) must already be running. */
export default defineConfig({
  testDir: './e2e',
  timeout: 60 * 60_000, // one full job (b-roll off) plus margin
  expect: { timeout: 15_000 },
  use: { baseURL: 'http://localhost:3000', trace: 'retain-on-failure' },
  webServer: { command: 'pnpm dev', url: 'http://localhost:3000', reuseExistingServer: true, timeout: 120_000 },
});
