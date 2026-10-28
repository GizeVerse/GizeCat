#!/usr/bin/env node
// Settings-window QA against the REAL main process (test mode, temp userData):
// opens every page in light and dark mode, saves page screenshots (the settings
// window's own content only) to out/qa/, and reports console errors / CSP violations.
//
//   node scripts/with-lock.mjs qa-settings -- node scripts/qa-settings.mjs
import { _electron as electron } from '@playwright/test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const outDir = path.join(root, 'out', 'qa');
fs.mkdirSync(outDir, { recursive: true });
const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'dcat-qa-settings-'));
const exe = path.join(root, 'node_modules', 'electron', 'dist', fs.readFileSync(path.join(root, 'node_modules', 'electron', 'path.txt'), 'utf8').trim());
const PAGES = ['welcome', 'general', 'appearance', 'behavior', 'interaction', 'privacy', 'ai', 'personality', 'diagnostics', 'about'];

const app = await electron.launch({
  executablePath: exe,
  args: [path.join(root, 'out', 'main', 'index.js')],
  cwd: root,
  env: { ...process.env, DESKTOP_CAT_TEST: '1', DESKTOP_CAT_USER_DATA: userData },
  timeout: 45000,
});
const hook = (name, ...args) => app.evaluate(async (_e, c) => globalThis.__desktopCatTest[c.name](...c.args), { name, args });
const report = { pages: [], consoleErrors: [], horizontalOverflow: [] };
try {
  const existing = app.windows().find((p) => p.url().includes('/renderer/settings/'));
  const page = existing ?? (await Promise.all([app.waitForEvent('window', { predicate: (p) => p.url().includes('/renderer/settings/'), timeout: 20000 }), hook('openSettings')]))[0];
  page.on('console', (m) => {
    if (m.type() === 'error') report.consoleErrors.push(m.text().slice(0, 200));
  });
  page.on('pageerror', (e) => report.consoleErrors.push(String(e).slice(0, 200)));
  await page.waitForLoadState('domcontentloaded');
  await page.setViewportSize({ width: 900, height: 640 });
  for (const scheme of ['light', 'dark']) {
    await page.emulateMedia({ colorScheme: scheme });
    for (const p of PAGES) {
      await page.evaluate((h) => {
        window.location.hash = `#${h}`;
      }, p);
      await page.waitForTimeout(450);
      const overflow = await page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth + 1);
      if (overflow) report.horizontalOverflow.push(`${p}/${scheme}`);
      const file = path.join(outDir, `settings-${p}-${scheme}.png`);
      await page.screenshot({ path: file });
      report.pages.push(path.relative(root, file));
    }
  }
  report.logProblems = await hook('getLogProblems');
} finally {
  const proc = app.process();
  const exited = new Promise((r) => proc.once('exit', (c) => r(c)));
  void hook('quit').catch(() => undefined);
  const code = await Promise.race([exited, new Promise((r) => setTimeout(() => r('timeout'), 15000))]);
  if (code === 'timeout') proc.kill();
  report.exitCode = code;
  fs.rmSync(userData, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
}
console.log(JSON.stringify({ ...report, pages: report.pages.length }, null, 1));
