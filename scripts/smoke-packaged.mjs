#!/usr/bin/env node
// Smoke test for the packaged app (fuses on, so Playwright cannot drive it).
// Launches release/win-unpacked/DesktopCat.exe with a temporary userData directory,
// waits, reads its log, checks single-instance behaviour, then stops the process
// it started (only that PID tree).
//
//   node scripts/with-lock.mjs smoke -- node scripts/smoke-packaged.mjs [path-to-exe]
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const exe = process.argv[2] ? path.resolve(process.argv[2]) : path.join(root, 'release', 'win-unpacked', 'DesktopCat.exe');
if (!fs.existsSync(exe)) {
  console.error(`smoke: ${exe} not found (run npm run package first)`);
  process.exit(2);
}
const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'dcat-smoke-'));
const env = { ...process.env, DESKTOP_CAT_USER_DATA: userData };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const result = { exe: path.relative(root, exe), checks: {} };

const first = spawn(exe, [], { env, stdio: 'ignore', detached: false });
let firstExit = null;
first.on('exit', (code) => (firstExit = code));
try {
  await sleep(9000);
  result.checks.firstStillRunning = firstExit === null;

  const second = spawnSync(exe, [], { env, timeout: 20000, stdio: 'ignore' });
  result.checks.secondInstanceExitCode = second.status;
  result.checks.secondInstanceExitedQuickly = second.error === undefined;
  await sleep(1500);
  result.checks.firstSurvivedSecondLaunch = firstExit === null;

  const logFile = path.join(userData, 'logs', 'main.log');
  const lines = fs.existsSync(logFile)
    ? fs.readFileSync(logFile, 'utf8').split('\n').filter(Boolean).map((l) => {
        try {
          return JSON.parse(l);
        } catch {
          return { l: 'unparsable', m: l.slice(0, 120) };
        }
      })
    : [];
  result.checks.logLines = lines.length;
  result.checks.errors = lines.filter((l) => l.l === 'error').map((l) => `${l.s}: ${l.m}`);
  result.checks.warnings = lines.filter((l) => l.l === 'warn').map((l) => `${l.s}: ${l.m}`);
  result.checks.windowAwareness = lines.filter((l) => /hook|polling|win32/i.test(`${l.s} ${l.m}`)).map((l) => l.m).slice(0, 5);
  result.checks.settingsWritten = fs.existsSync(path.join(userData, 'settings.json'));
} finally {
  if (firstExit === null) spawnSync('taskkill', ['/PID', String(first.pid), '/T', '/F'], { stdio: 'ignore' });
  await sleep(1000);
  fs.rmSync(userData, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 });
}
console.log(JSON.stringify(result, null, 1));
const ok =
  result.checks.firstStillRunning &&
  result.checks.secondInstanceExitCode === 0 &&
  result.checks.firstSurvivedSecondLaunch &&
  result.checks.errors.length === 0 &&
  result.checks.logLines > 0;
process.exit(ok ? 0 : 1);
