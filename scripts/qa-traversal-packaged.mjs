#!/usr/bin/env node
// REAL check of the PACKAGED app (fuses on, so no test hooks and no Playwright): does a fresh
// cat leave the floor on its own and get onto an ordinary window? Launches
// release/win-unpacked/DesktopCat.exe (or the exe given) with a temporary userData directory
// (launch at sign-in off; settings: first run done, sleep after 120 idle minutes so an empty
// desk does not put it to sleep), opens a throwaway always-on-top window of typical size
// (about 70 % of the work area, its bottom ~180 px above the floor, not movable, says what it
// is), and reads the app's own rate-limited 'surfaces summary' log lines (counts, verdict code,
// what the cat stands on, trips up this session) until the cat has been up or time runs out. From
// there it keeps watching for up to --stay-minutes, until --stays finished stays are in the app's
// 'stay ended' log lines (kind, dwellS, reason, leave, arrivedBy), so a packaged run reports real
// dwell times. Then it closes the window, waits for the cat to be back on the floor and stops only
// the processes it started. Nothing of the user's is touched; no screenshots are taken.
//
//   node scripts/with-lock.mjs qa-traversal -- node scripts/qa-traversal-packaged.mjs [--minutes=12] [--stays=3] [--stay-minutes=25] [path-to-exe]
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { staysFromLog, summarizeStays } from './stay-lines.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);
const argv = process.argv.slice(2);
const numArg = (name, fallback) => Number((argv.find((a) => a.startsWith(`--${name}=`)) ?? `--${name}=${fallback}`).split('=')[1]);
const minutes = numArg('minutes', 12);
const wantStays = numArg('stays', 3);
const stayMinutes = numArg('stay-minutes', 25);
const exeArg = argv.find((a) => !a.startsWith('--'));
const exe = exeArg ? path.resolve(exeArg) : path.join(root, 'release', 'win-unpacked', 'DesktopCat.exe');
if (!fs.existsSync(exe)) {
  console.error(`qa-traversal: ${exe} not found (run npm run package first)`);
  process.exit(2);
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dcat-qa-traversal-'));
const userData = path.join(dir, 'userdata');
fs.mkdirSync(userData);
fs.writeFileSync(path.join(userData, 'settings.json'), JSON.stringify({ schemaVersion: 2, general: { firstRunCompleted: true }, behavior: { sleepAfterIdleMinutes: 120 } }));

// The same throwaway window as tests/e2e/surfaces.spec.ts ('typical' layout): a separate
// Electron process (an ordinary app window to the cat), shown without activation, fixed in
// place, reporting its HWND and DWM frame; 'quit' in the command file closes it.
const PROBE = String.raw`
const fs = require('node:fs');
const { app, BrowserWindow, screen } = require('electron');
const out = process.env.DCAT_PROBE_OUT, cmdFile = process.env.DCAT_PROBE_CMD;
const write = (o) => fs.appendFileSync(out, JSON.stringify(o) + '\n');
process.on('uncaughtException', (e) => { try { write({ error: String((e && e.stack) || e) }); } finally { app.exit(1); } });
const koffi = require(process.env.DCAT_KOFFI);
const RECT = koffi.struct('DCAT_QA_RECT', { left: 'int32_t', top: 'int32_t', right: 'int32_t', bottom: 'int32_t' });
const DwmGetWindowAttribute = koffi.load('dwmapi.dll').func('__stdcall', 'DwmGetWindowAttribute', 'int32_t', ['intptr_t', 'uint32_t', koffi.out(koffi.pointer(RECT)), 'uint32_t']);
// alwaysOnTop on a window shown inactive from a background process may not reach the topmost
// band (it then sits behind a maximized window and the cat rightly sees nothing): re-assert it on
// this window only (HWND_TOPMOST, no move/size/activation).
const SetWindowPos = koffi.load('user32.dll').func('__stdcall', 'SetWindowPos', 'int32_t', ['intptr_t', 'intptr_t', 'int32_t', 'int32_t', 'int32_t', 'int32_t', 'uint32_t']);
const topmost = (h) => SetWindowPos(h, -1, 0, 0, 0, 0, 0x0001 | 0x0002 | 0x0010);
app.whenReady().then(() => {
  const d = screen.getPrimaryDisplay(), wa = d.workArea;
  const width = Math.round(wa.width * 0.7);
  const bottom = wa.y + wa.height - Math.round(180 / d.scaleFactor);
  const height = Math.min(Math.round(wa.height * 0.7), bottom - wa.y - Math.round(120 / d.scaleFactor));
  const w = new BrowserWindow({ x: wa.x + Math.round((wa.width - width) / 2), y: bottom - height, width, height, movable: false, resizable: false, minimizable: false, maximizable: false, show: false, alwaysOnTop: true, backgroundColor: '#ffffff', title: 'dcat-qa' });
  w.showInactive();
  w.loadURL('data:text/html,' + encodeURIComponent('<!doctype html><meta charset="utf-8"><body style="font:20px sans-serif;margin:40px">Desktop Cat test window (packaged-build check). It closes by itself within a few minutes; please leave it where it is.</body>'));
  const hwnd = w.getNativeWindowHandle().readBigUInt64LE(0);
  topmost(hwnd);
  setTimeout(() => { const ok = topmost(hwnd); const r = {}; const hr = DwmGetWindowAttribute(hwnd, 9, r, koffi.sizeof(RECT)); write({ frame: hr === 0 ? { x: r.left, y: r.top, width: r.right - r.left, height: r.bottom - r.top } : null, scale: d.scaleFactor, topmostReasserted: ok !== 0 }); }, 800);
  setInterval(() => { let t = ''; try { t = fs.readFileSync(cmdFile, 'utf8'); } catch { return; } if (t.includes('quit')) app.exit(0); }, 100);
});
`;
const probeScript = path.join(dir, 'probe.cjs');
const probeOut = path.join(dir, 'probe-out.jsonl');
const probeCmd = path.join(dir, 'probe-cmd.txt');
fs.writeFileSync(probeScript, PROBE);
fs.writeFileSync(probeOut, '');
fs.writeFileSync(probeCmd, '');
const cleanEnv = Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^(ELECTRON_RUN_AS_NODE|NODE_OPTIONS)$/i.test(k) && !k.toUpperCase().startsWith('DESKTOP_CAT_')));

const result = { exe: path.relative(root, exe), minutes, userData, started: new Date().toISOString(), probe: null, summaries: [], stays: [], staySummary: null, checks: {}, pids: {} };
const logFile = path.join(userData, 'logs', 'main.log');
const logLines = () => {
  try {
    return fs.readFileSync(logFile, 'utf8').split('\n').flatMap((l) => {
      try {
        return l ? [JSON.parse(l)] : [];
      } catch {
        return [];
      }
    });
  } catch {
    return [];
  }
};
const summaries = () => logLines().filter((l) => l.m === 'surfaces summary');
// 'Up' means standing on a window top or tab strip (an excursion); a side is only on the way.
const TOPS = new Set(['windowTop', 'tabStrip']);

const probe = spawn(require('electron'), [probeScript, `--user-data-dir=${path.join(dir, 'probe-profile')}`], {
  env: { ...cleanEnv, DCAT_KOFFI: path.join(root, 'node_modules', 'koffi'), DCAT_PROBE_OUT: probeOut, DCAT_PROBE_CMD: probeCmd, ELECTRON_ENABLE_LOGGING: '0' },
  stdio: 'ignore',
});
result.pids.probe = probe.pid;
let probeExit = null;
probe.on('exit', (c) => (probeExit = c));
// DESKTOP_CAT_TEST=1 on purpose: a packaged build must ignore it (no test hooks; boot logs test:false).
const app = spawn(exe, [], { env: { ...cleanEnv, DESKTOP_CAT_USER_DATA: userData, DESKTOP_CAT_LOGIN_ITEM: 'off', DESKTOP_CAT_TEST: '1' }, stdio: 'ignore' });
result.pids.app = app.pid;
let appExit = null;
app.on('exit', (c) => (appExit = c));

const stopTree = (pid) => {
  if (pid) spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore' });
};
try {
  await sleep(3000);
  const rep = fs.readFileSync(probeOut, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
  result.probe = rep.find((r) => 'frame' in r) ?? rep.find((r) => 'error' in r) ?? null;
  const t0 = Date.now();
  let upAt = null;
  while (Date.now() - t0 < minutes * 60_000 && appExit === null) {
    await sleep(5000);
    const s = summaries();
    const up = s.find((l) => (l.d?.excursions ?? 0) > 0 || TOPS.has(l.d?.support));
    if (up) {
      upAt = up.t;
      break;
    }
  }
  result.checks.appRanThroughout = appExit === null;
  result.checks.wentUp = upAt !== null;
  result.checks.firstUpLoggedAt = upAt;
  result.checks.secondsToFirstUpLog = upAt ? Math.round((Date.parse(upAt) - t0) / 1000) : null;
  if (upAt !== null) {
    // Let it explore (real stays need real minutes), then take the window away and see it set down on the floor.
    const stayT0 = Date.now();
    await sleep(60_000);
    while (Date.now() - stayT0 < stayMinutes * 60_000 && appExit === null && staysFromLog(logLines()).length < wantStays) await sleep(10_000);
    const closeAt = Date.now();
    fs.writeFileSync(probeCmd, 'quit\n');
    let down = null;
    while (Date.now() - closeAt < 150_000 && appExit === null) {
      await sleep(5000);
      down = summaries().find((l) => Date.parse(l.t) > closeAt && (l.d?.support === 'floor' || l.d?.support === 'taskbar')) ?? null;
      if (down) break;
    }
    result.checks.backOnFloorAfterClose = down !== null;
    result.checks.secondsToFloorLogAfterClose = down ? Math.round((Date.parse(down.t) - closeAt) / 1000) : null;
  }
  const lines = logLines();
  result.summaries = summaries().map((l) => ({ t: l.t, ...l.d }));
  result.stays = staysFromLog(lines);
  result.staySummary = summarizeStays(result.stays);
  result.checks.seenOnASide = result.summaries.some((s) => s.support === 'windowSide');
  result.checks.maxExcursions = Math.max(0, ...result.summaries.map((s) => s.excursions ?? 0));
  result.checks.errorLines = lines.filter((l) => l.l === 'error').map((l) => `${l.s}: ${l.m}`);
  result.checks.warnLines = lines.filter((l) => l.l === 'warn').length;
  result.checks.boot = lines.find((l) => l.m === 'starting')?.d ?? null;
  result.checks.testHooksIgnoredWhenPackaged = result.checks.boot?.packaged === true && result.checks.boot?.test === false;
} finally {
  if (probeExit === null) fs.writeFileSync(probeCmd, 'quit\n');
  await sleep(1500);
  if (probeExit === null) stopTree(probe.pid);
  stopTree(app.pid);
  await sleep(1500);
  result.checks.cleanedUp = { probeExited: probeExit !== null || probe.exitCode !== null || probe.signalCode !== null, appExited: appExit !== null || app.exitCode !== null || app.signalCode !== null };
  result.finished = new Date().toISOString();
  fs.writeFileSync(path.join(dir, 'result.json'), JSON.stringify(result, null, 2));
  console.log(JSON.stringify(result, null, 2));
}
process.exit(result.checks.wentUp ? 0 : 1);
