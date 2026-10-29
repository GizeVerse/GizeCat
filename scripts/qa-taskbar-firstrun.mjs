#!/usr/bin/env node
// REAL check: on a first run started by a background process, the Welcome window must not keep an
// auto-hide taskbar revealed. Launches the app (test mode, fresh userData), samples the real taskbar
// tracker for ~10 s through test hooks, and reports whether the taskbar ledge is still present at the end.
//   node scripts/with-lock.mjs qa-taskbar -- node scripts/qa-taskbar-firstrun.mjs
import { _electron as electron } from '@playwright/test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'dcat-qa-taskbar-'));
const exe = path.join(root, 'node_modules', 'electron', 'dist', fs.readFileSync(path.join(root, 'node_modules', 'electron', 'path.txt'), 'utf8').trim());
const app = await electron.launch({
  executablePath: exe,
  args: [path.join(root, 'out', 'main', 'index.js')],
  cwd: root,
  env: { ...process.env, DESKTOP_CAT_TEST: '1', DESKTOP_CAT_USER_DATA: userData },
  timeout: 45000,
});
const hook = (name, ...args) => app.evaluate(async (_e, c) => globalThis.__desktopCatTest[c.name](...c.args), { name, args });
const samples = [];
let windowsSeen = 0;
try {
  const t0 = Date.now();
  while (Date.now() - t0 < 10000) {
    const list = await hook('getSurfaces');
    const taskbar = list.find((s) => s.kind === 'taskbar') ?? null;
    samples.push({ t: Date.now() - t0, taskbarLedge: taskbar ? Math.round(taskbar.y) : null });
    windowsSeen = Math.max(windowsSeen, app.windows().length);
    await new Promise((r) => setTimeout(r, 250));
  }
  const status = await hook('getSurfaceStatus');
  const revealed = samples.filter((s) => s.taskbarLedge !== null);
  const result = {
    surfaceStatus: status,
    windowsSeen,
    samples: samples.length,
    revealedSamples: revealed.length,
    firstRevealAt: revealed[0]?.t ?? null,
    lastRevealAt: revealed.at(-1)?.t ?? null,
    revealedAtEnd: samples.at(-1)?.taskbarLedge !== null,
    logProblems: await hook('getLogProblems'),
  };
  console.log(JSON.stringify(result, null, 1));
} finally {
  const proc = app.process();
  const exited = new Promise((r) => proc.once('exit', (c) => r(c)));
  void hook('quit').catch(() => undefined);
  const code = await Promise.race([exited, new Promise((r) => setTimeout(() => r('timeout'), 15000))]);
  if (code === 'timeout') proc.kill();
  fs.rmSync(userData, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
}
