#!/usr/bin/env node
// Smoke test for the packaged app (fuses on, so Playwright cannot drive it).
// Launches the given exe (default release/win-unpacked/DesktopCat.exe, what `npm run package`
// writes; a versioned build is release/<version>/windows/win-unpacked) with a temporary userData directory,
// waits, reads its log, checks single-instance behaviour, then stops the process
// it started (only that PID tree). DESKTOP_CAT_LOGIN_ITEM=off keeps it from ever writing
// the HKCU Run entry, on top of the write gate's uninstaller check (install-test.ps1 runs
// this script against an installed copy, which has an uninstaller).
//
// It refuses (exit 2) before launching anything when the build's resources/app.asar package.json
// version differs from the repository's, so a stale build left in a folder can never be recorded
// as a smoke pass for this version (1.4.0 review WINREG-2).
//
//   node scripts/with-lock.mjs smoke -- node scripts/smoke-packaged.mjs [path-to-exe]
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { fileReader, readAsarFile, readAsarHeader } from './check-win-payload.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const exe = process.argv[2] ? path.resolve(process.argv[2]) : path.join(root, 'release', 'win-unpacked', 'DesktopCat.exe');
if (!fs.existsSync(exe)) {
  console.error(`smoke: ${exe} not found (run npm run package first, or pass the exe, e.g. release/<version>/windows/win-unpacked/DesktopCat.exe)`);
  process.exit(2);
}

/** The version in a build's app.asar package.json (read statically, nothing runs), or null. */
function packagedVersion(asarPath) {
  if (!fs.existsSync(asarPath)) return null;
  const r = fileReader(asarPath);
  try {
    const bytes = readAsarFile(r, readAsarHeader(r), 'package.json');
    if (!bytes) return null;
    const version = JSON.parse(bytes.toString('utf8')).version;
    return typeof version === 'string' ? version : null;
  } catch {
    return null;
  } finally {
    r.close();
  }
}
const repoVersion = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')).version;
const appVersion = packagedVersion(path.join(path.dirname(exe), 'resources', 'app.asar'));
if (appVersion !== repoVersion) {
  console.error(
    `smoke: ${exe} is ${appVersion === null ? 'a build without a readable resources/app.asar package.json' : `version ${appVersion}`}, the repository is ${repoVersion}; refusing to smoke the wrong build (pass the exe of this version's build)`,
  );
  process.exit(2);
}
const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'dcat-smoke-'));
const env = { ...process.env, DESKTOP_CAT_USER_DATA: userData, DESKTOP_CAT_LOGIN_ITEM: 'off' };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const result = { exe: path.relative(root, exe), appVersion, checks: {} };

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
  // The login item is reconciled with the gate closed and never written.
  const reconciled = lines.filter((l) => l.m === 'login item reconciled').map((l) => l.d ?? {});
  result.checks.loginItemRules = reconciled.map((d) => d.rule);
  result.checks.loginItemGateClosedByEnv = reconciled.length > 0 && reconciled.every((d) => Array.isArray(d.gate) && d.gate.includes('env-off'));
  result.checks.loginItemWrites = lines.filter((l) => l.m === 'login item written').length;
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
  result.checks.logLines > 0 &&
  result.checks.loginItemWrites === 0 &&
  result.checks.loginItemGateClosedByEnv &&
  result.checks.loginItemRules.every((r) => r === 'gate-closed');
process.exit(ok ? 0 : 1);
