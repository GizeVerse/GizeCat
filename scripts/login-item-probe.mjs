#!/usr/bin/env node
// REAL probe of Electron's launch-at-sign-in API against the app's own model of it
// (docs/research/v1.1/startup.md §2, ADR 0002 §1). Opt-in; run under the machine lock:
//
//   node scripts/with-lock.mjs login-probe -- node scripts/login-item-probe.mjs
//
// Stage 1 (plain Node) records a throwaway value name, DesktopCatTest-<hex>, to a file in the
// temp folder BEFORE anything touches the registry, bundles the app's registry reader and
// command-line rules with esbuild, and starts this file in Electron. Stage 2 (Electron main,
// no windows) calls app.setLoginItemSettings with that name only, reads the result back with
// the app's koffi reader, and compares it with the app's port (formatCommandLine, the
// StartupApproved rule). Both values are deleted in finally; stage 1 then confirms through
// .NET (Microsoft.Win32.Registry, never reg.exe output) that they are gone, removes them if
// not, and deletes the record only after a confirmed cleanup. The production value name and
// the AppUserModelID of the real app are never used. Exit code 0 = every check passed.
import { spawn, spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = fileURLToPath(import.meta.url);
const ROOT = path.resolve(path.dirname(HERE), '..');
const CHILD_FLAG = '--login-probe-child';
const RESULT_TAG = 'LOGIN-PROBE-RESULT ';
const NAME_RE = /^DesktopCatTest-[0-9a-f]{8}$/;
const RUN_KEY = 'Software\\Microsoft\\Windows\\CurrentVersion\\Run';
const APPROVED_KEY = 'Software\\Microsoft\\Windows\\CurrentVersion\\Explorer\\StartupApproved\\Run';
const TIMEOUT_MS = 60_000;

if (process.versions.electron) {
  // Not awaited: Electron holds 'ready' until an ESM main module (top-level await included) has loaded.
  stageTwo().catch((e) => {
    process.stdout.write(`${RESULT_TAG}${JSON.stringify({ ok: false, error: String(e && e.stack ? e.stack : e) })}\n`);
    process.exit(1);
  });
} else {
  try {
    process.exit(await stageOne());
  } catch (e) {
    console.error(`login-item-probe: ${e && e.stack ? e.stack : e}`);
    process.exit(1);
  }
}

// ---------------------------------------------------------------------------
// Stage 1: plain Node

/** Reads (and with -Delete removes) the two values of one throwaway name through .NET. */
function dotnetValues(name, remove) {
  if (!NAME_RE.test(name)) throw new Error('refusing a value name that is not a throwaway test name');
  const script = [
    "$ErrorActionPreference = 'Stop'",
    `$name = '${name}'`,
    `$keys = @('${RUN_KEY}', '${APPROVED_KEY}')`,
    '$out = [ordered]@{}',
    'foreach ($p in $keys) {',
    `  $k = [Microsoft.Win32.Registry]::CurrentUser.OpenSubKey($p, ${remove ? '$true' : '$false'})`,
    '  if ($k) {',
    remove ? '    $k.DeleteValue($name, $false)' : '',
    "    $out[$p] = ($null -ne $k.GetValue($name, $null, 'DoNotExpandEnvironmentNames'))",
    '    $k.Close()',
    '  } else { $out[$p] = $false }',
    '}',
    '[Console]::Out.Write([Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes(($out | ConvertTo-Json -Compress))))',
  ].join('\n');
  const r = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { encoding: 'utf8', timeout: 30_000, windowsHide: true });
  if (r.status !== 0) throw new Error(`.NET registry read failed: ${r.stderr}`);
  const present = JSON.parse(Buffer.from(r.stdout.trim(), 'base64').toString('utf8'));
  return { run: present[RUN_KEY] === true, approved: present[APPROVED_KEY] === true };
}

async function stageOne() {
  if (process.platform !== 'win32') throw new Error('Windows only');
  const require = createRequire(import.meta.url);
  const esbuild = require(require.resolve('esbuild', { paths: [ROOT] }));
  const electronPath = require(require.resolve('electron', { paths: [ROOT] }));
  const koffiPath = require.resolve('koffi', { paths: [ROOT] });

  const hex = crypto.randomBytes(4).toString('hex');
  const name = `DesktopCatTest-${hex}`;
  const recordFile = path.join(os.tmpdir(), `desktop-cat-login-probe-${hex}.json`);
  // Recorded BEFORE anything can write, so a run that dies can still be cleaned up by hand.
  fs.writeFileSync(
    recordFile,
    JSON.stringify({ purpose: 'Desktop Cat login-item probe; delete these HKCU values if this file is still here', name, keys: [RUN_KEY, APPROVED_KEY], pid: process.pid, at: new Date().toISOString() }, null, 1),
  );

  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'desktop-cat-login-probe-'));
  const bundle = path.join(work, 'login.cjs');
  const userData = path.join(work, 'user-data');
  fs.mkdirSync(userData);
  let result = { ok: false, error: 'the probe did not report' };
  try {
    await esbuild.build({
      stdin: {
        contents: [
          "export { createLoginItemRegistry } from './src/main/win32/registry.ts';",
          "export { addQuoteForArg, formatCommandLine, parseCommandLine, startupApprovedEnabled } from './src/main/lifecycle/loginItemCommandLine.ts';",
          "export { interpretSnapshot, isOurEntry } from './src/main/lifecycle/loginItemReconcile.ts';",
        ].join('\n'),
        resolveDir: ROOT,
        loader: 'ts',
        sourcefile: 'login-probe-entry.ts',
      },
      bundle: true,
      platform: 'node',
      format: 'cjs',
      target: 'node24',
      outfile: bundle,
      external: ['electron'],
      logLevel: 'warning',
      plugins: [
        {
          // The bundle lives in a temp dir: point koffi at the repo's copy by absolute path.
          name: 'koffi-absolute',
          setup(b) {
            b.onResolve({ filter: /^koffi$/ }, () => ({ path: koffiPath, external: true }));
          },
        },
      ],
    });

    const child = spawn(electronPath, [HERE, CHILD_FLAG, bundle, name, userData, koffiPath], { stdio: ['ignore', 'pipe', 'inherit'], windowsHide: true });
    let stdout = '';
    child.stdout.on('data', (d) => (stdout += d));
    const killer = setTimeout(() => child.kill(), TIMEOUT_MS + 15_000);
    const code = await new Promise((resolve) => {
      child.on('exit', (c, signal) => resolve(c ?? (signal ? 1 : 0)));
      child.on('error', (e) => {
        console.error(`login-item-probe: failed to start Electron: ${e.message}`);
        resolve(1);
      });
    });
    clearTimeout(killer);
    const line = stdout.split(/\r?\n/).find((l) => l.startsWith(RESULT_TAG));
    if (line) result = JSON.parse(line.slice(RESULT_TAG.length));
    result.electronExitCode = code;
  } finally {
    // Confirm through .NET, independently of koffi and Electron.
    let left = dotnetValues(name, false);
    if (left.run || left.approved) left = dotnetValues(name, true);
    result.cleanup = { name, runGone: !left.run, approvedGone: !left.approved };
    if (!left.run && !left.approved) fs.rmSync(recordFile, { force: true });
    fs.rmSync(work, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  }
  const ok = result.ok === true && result.cleanup.runGone && result.cleanup.approvedGone;
  console.log(JSON.stringify({ ...result, ok }, null, 2));
  return ok ? 0 : 1;
}

// ---------------------------------------------------------------------------
// Stage 2: Electron main process

async function stageTwo() {
  const electron = await import('electron');
  const app = electron.app ?? electron.default.app;
  const i = process.argv.indexOf(CHILD_FLAG);
  const [bundle, name, userData, koffiPath] = process.argv.slice(i + 1);
  app.setPath('userData', userData);
  const report = (result, code) => {
    process.stdout.write(`${RESULT_TAG}${JSON.stringify(result)}\n`);
    app.exit(code);
  };
  const hardTimeout = setTimeout(() => report({ ok: false, error: 'probe timed out' }, 2), TIMEOUT_MS);
  await app.whenReady();
  const require = createRequire(import.meta.url);
  let result;
  try {
    result = runProbe(app, require(bundle), require(koffiPath), name);
  } catch (e) {
    result = { ok: false, error: String(e && e.stack ? e.stack : e) };
  }
  clearTimeout(hardTimeout);
  report(result, result.ok ? 0 : 1);
}

function runProbe(app, login, koffi, name) {
  if (!NAME_RE.test(name)) throw new Error('refusing a value name that is not a throwaway test name');
  const HKCU = -2147483647;
  const REG_BINARY = 3;
  const advapi32 = koffi.load('advapi32.dll');
  const RegSetKeyValueW = advapi32.func('__stdcall', 'RegSetKeyValueW', 'long', ['intptr_t', 'str16', 'str16', 'uint32_t', 'void *', 'uint32_t']);
  const RegDeleteKeyValueW = advapi32.func('__stdcall', 'RegDeleteKeyValueW', 'long', ['intptr_t', 'str16', 'str16']);
  const setApproved = (bytes) => RegSetKeyValueW(HKCU, APPROVED_KEY, name, REG_BINARY, Buffer.from(bytes), bytes.length);

  const reader = login.createLoginItemRegistry(name);
  const checks = {};
  const check = (id, ok, detail) => (checks[id] = detail === undefined ? { ok: Boolean(ok) } : { ok: Boolean(ok), detail });
  const state = () => login.interpretSnapshot(reader.read());
  const exe = 'C:\\Users\\Probe User\\AppData\\Local\\Programs\\Desktop Çat ğ 猫\\DesktopCat.exe';
  const args = ['--launched-at-login'];
  const set = (s) => app.setLoginItemSettings({ path: exe, args, name, ...s });
  // The getter keys openAtLogin on the AppUserModelID: give this process the probe's own.
  app.setAppUserModelId(name);

  try {
    check('readerAvailable', reader.available);
    check('startsAbsent', state().run === null && state().approved === 'absent');

    // The production call shape: unquoted path, one switch, enabled:true.
    set({ openAtLogin: true, enabled: true });
    let s = state();
    const expected = login.formatCommandLine(exe, args);
    check('registeredExactly', s.run?.raw === expected && s.approved === 'absent', { electron: s.run?.raw, port: expected });
    check('parsedBackAsOurs', s.run !== null && login.isOurEntry(s.run, { execPath: exe, args }));

    // Byte-for-byte golden from the research probe (quoting of tricky arguments).
    const goldenArgs = ['--launched-at-login', 'C:\\dir with space\\x', '"pre quoted"', 'tail\\', 'plain'];
    app.setLoginItemSettings({ openAtLogin: true, path: exe, args: goldenArgs, name, enabled: true });
    s = state();
    const golden = login.formatCommandLine(exe, goldenArgs);
    check('quotingMatchesPort', s.run?.raw === golden && s.run.raw.length === 149, { electron: s.run?.raw, port: golden });
    check('argvRoundTrip', JSON.stringify(login.parseCommandLine(s.run?.raw ?? '')) === JSON.stringify([exe, ...goldenArgs]));
    app.setLoginItemSettings({ openAtLogin: true, path: `"${exe}"`, args, name, enabled: true });
    check('preQuotedPathSameString', state().run?.raw === expected);

    // StartupApproved: the app's rule against Electron's own getter, byte pattern by byte pattern.
    const filetime = Buffer.alloc(8);
    filetime.writeBigUInt64LE(BigInt(Date.now() + 11_644_473_600_000) * 10_000n);
    const patterns = {
      '03+FILETIME': [0x03, 0, 0, 0, ...filetime],
      '03': [0x03, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
      '06': [0x06, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
      '02': [0x02, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
      '00': [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
      '02 05': [0x02, 0x05],
    };
    const agreement = {};
    for (const [label, bytes] of Object.entries(patterns)) {
      setApproved(bytes);
      const ours = state().approved;
      const theirs = app.getLoginItemSettings({ path: `"${exe}"`, args }).launchItems.find((it) => it.name === name);
      agreement[label] = { ours, electronEnabled: theirs?.enabled ?? null };
      check(`approved ${label}`, theirs !== undefined && (ours === 'enabled') === theirs.enabled && login.startupApprovedEnabled(Uint8Array.from(bytes)) === theirs.enabled, agreement[label]);
    }
    check('getterIgnoresApprovedForOpenAtLogin', app.getLoginItemSettings({ path: exe, args }).openAtLogin === true);
    check('getterMissesUnquotedSpacePath', app.getLoginItemSettings({ path: exe, args }).executableWillLaunchAtLogin === false);

    // Why the app never re-writes at boot: enabled:true erases a Task Manager disable.
    setApproved(patterns['03+FILETIME']);
    set({ openAtLogin: true, enabled: true });
    check('rewriteErasesDisable', state().approved === 'absent');
    // enabled:false writes 03 + eleven zero bytes (used to re-list an orphaned disable).
    set({ openAtLogin: true, enabled: false });
    const raw = reader.read().approved;
    check('enabledFalseWrites03', raw.kind === 'value' && raw.data.toString('hex') === '030000000000000000000000', { hex: raw.kind === 'value' ? raw.data.toString('hex') : raw.kind });
    // openAtLogin:false removes both values.
    set({ openAtLogin: false });
    s = state();
    check('openAtLoginFalseRemovesBoth', s.run === null && s.approved === 'absent');

    // Read cost in this process (both values, one snapshot).
    const n = 500;
    const t0 = performance.now();
    for (let k = 0; k < n; k++) reader.read();
    const usPerSnapshot = ((performance.now() - t0) / n) * 1000;
    check('readCostUnder1ms', usPerSnapshot < 1000, { usPerSnapshot: Math.round(usPerSnapshot * 10) / 10 });
  } finally {
    try {
      app.setLoginItemSettings({ openAtLogin: false, name });
    } finally {
      RegDeleteKeyValueW(HKCU, RUN_KEY, name);
      RegDeleteKeyValueW(HKCU, APPROVED_KEY, name);
    }
  }
  const after = state();
  check('cleanedUp', after.readable && after.run === null && after.approved === 'absent');
  return { ok: Object.values(checks).every((c) => c.ok), electron: process.versions.electron, name, checks };
}
