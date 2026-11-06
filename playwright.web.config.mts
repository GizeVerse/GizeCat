import { defineConfig, devices } from '@playwright/test';

// GizeCat web host E2E (ADR 0004 §8): the real page in the installed Chrome and Edge (channel; the
// bundled Chromium is not installed here), served by scripts/serve-web.mjs on 127.0.0.1 from
// out/web-test. Mobile is Chrome's device emulation (SIMULATED). Headless: no window on the desktop.
// Build first: node scripts/build.mjs --web-only --web-test (npm run test:web does both).
// The Electron E2E suite has its own config (playwright.config.mts).
const PORT = Number(process.env.GIZECAT_WEB_PORT ?? 41731);

export default defineConfig({
  testDir: 'tests/web',
  testMatch: '**/*.spec.ts',
  // Inside the git-ignored build output, so runs leave the working tree clean.
  outputDir: 'out/web-e2e-results',
  workers: 1,
  fullyParallel: false,
  timeout: 90_000,
  expect: { timeout: 15_000 },
  retries: 0,
  reporter: [['list']],
  use: {
    baseURL: `http://127.0.0.1:${PORT}`,
    headless: true,
    trace: 'retain-on-failure',
  },
  webServer: {
    command: `node scripts/serve-web.mjs --dir out/web-test --port ${PORT}`,
    url: `http://127.0.0.1:${PORT}/index.html`,
    reuseExistingServer: false,
    timeout: 20_000,
    stdout: 'pipe',
  },
  projects: [
    { name: 'chrome', use: { ...devices['Desktop Chrome'], channel: 'chrome' } },
    { name: 'msedge', use: { ...devices['Desktop Edge'], channel: 'msedge' } },
    { name: 'mobile-emulated', use: { ...devices['Pixel 7'], channel: 'chrome' } },
  ],
});
