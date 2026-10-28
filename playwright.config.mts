import { defineConfig } from '@playwright/test';

// Electron E2E: one app at a time (overlays are real topmost windows on this desktop).
// Build first (npm run build); tests launch out/main/index.js.
export default defineConfig({
  testDir: 'tests/e2e',
  testMatch: '**/*.spec.ts',
  // Inside the git-ignored build output, so runs leave the working tree clean.
  outputDir: 'out/e2e-results',
  workers: 1,
  fullyParallel: false,
  timeout: 60_000,
  expect: { timeout: 10_000 },
  retries: 0,
  reporter: [['list']],
  use: { trace: 'retain-on-failure' },
});
