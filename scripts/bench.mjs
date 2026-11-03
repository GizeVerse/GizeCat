#!/usr/bin/env node
// Resource benchmark of the real app (dev build in out/, test hooks for phase control only).
// Phases: awake, asleep, hidden, paused, and (--lively, ADR 0003 §15.4) lively. Samples
// app.getAppMetrics() (CPU % of one core summed over all processes, working set) plus main-process
// active timers/handles so leaks show up as growth. getAppMetrics() covers only Chromium's own
// processes, so the tab-strip helper the app may spawn (DesktopCatUia.exe, a child of the app's
// main process) is sampled separately through Win32_Process (CPU from its kernel+user time,
// private bytes, working set) and reported per phase as `uiaHelper` (and added in `withHelper`).
// Only the app's own child processes are read. Results: out/bench/bench-<timestamp>.json.
//
// The lively phase opens OWN windows only (an Edge with a temp profile, a named Windows Terminal
// window running ping -t, an Explorer window on a temp folder in its own process; each skipped
// when unavailable or when it would share a process with the user's windows), restricts the
// app's surfaces to their PIDs, moves an injected cursor (never the real one) around and near
// the cat so the scorer, the hunt gates and the click guard run, and never forces command.play.
// Closes only what it opened. Gate B12 (ADR 0003 §14): awake CPU <= 1.5 % of a core and at most
// 0.3 pp above the v1.1.1 baseline (--baseline-awake, default 1.05: TEST_REPORT v1.1.1, REAL).
//
//   node scripts/with-lock.mjs bench -- node scripts/bench.mjs [--phase-sec=120] [--sample-sec=10]
//        [--phases=awake,asleep,hidden,paused] [--lively] [--lively-windows=edge,terminal,explorer]
//        [--baseline-awake=1.05]
//   node scripts/with-lock.mjs bench -- node scripts/bench.mjs --passive-exe=<full exe path> [--phase-sec=600]
//        a passive Win32_Process CPU sample of processes with exactly that executable path (e.g. a
//        packaged build): read-only, no control, no phases; labelled as such in the report.
import { _electron as electron } from '@playwright/test';
import koffi from 'koffi';
import { execFile, spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const str = (n, d) => {
  const a = process.argv.find((x) => x.startsWith(`--${n}=`));
  return a ? a.slice(n.length + 3) : d;
};
const num = (n, d) => {
  const v = str(n, null);
  return v === null ? d : Number(v);
};
const has = (n) => process.argv.includes(`--${n}`);
const phaseSec = num('phase-sec', 120);
const sampleSec = num('sample-sec', 10);
const phaseNames = str('phases', 'awake,asleep,hidden,paused').split(',').map((x) => x.trim()).filter(Boolean);
if (has('lively') && !phaseNames.includes('lively')) phaseNames.push('lively');
const livelyWindows = new Set(str('lively-windows', 'edge,terminal,explorer').split(',').map((x) => x.trim()));
const baselineAwake = num('baseline-awake', 1.05);
const passiveExe = str('passive-exe', null);
const exe = path.join(root, 'node_modules', 'electron', 'dist', fs.readFileSync(path.join(root, 'node_modules', 'electron', 'path.txt'), 'utf8').trim());
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const pwsh = (script, timeout = 30000) =>
  new Promise((resolve) => {
    execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { encoding: 'utf8', timeout, windowsHide: true, maxBuffer: 4 * 1024 * 1024 }, (err, stdout) => resolve(err ? null : stdout));
  });
const outDir = path.join(root, 'out', 'bench');

// ---- passive mode: CPU of processes with one executable path (read-only, no control) ----
if (passiveExe) {
  const q = (x) => x.replace(/'/g, "''").replace(/\\/g, '\\\\');
  const sample = async () => {
    const out = await pwsh(`ConvertTo-Json -Compress -InputObject @(Get-CimInstance Win32_Process -Filter "ExecutablePath='${q(passiveExe)}'" | Select-Object ProcessId,KernelModeTime,UserModeTime,WorkingSetSize,PrivatePageCount)`);
    try {
      const rows = JSON.parse((out ?? '').trim() || '[]');
      return { at: performance.now(), rows: Array.isArray(rows) ? rows : [rows] };
    } catch {
      return { at: performance.now(), rows: [] };
    }
  };
  const cpu100ns = (smp) => smp.rows.reduce((a, r) => a + Number(r.KernelModeTime ?? 0) + Number(r.UserModeTime ?? 0), 0);
  const first = await sample();
  const series = [];
  let prev = first;
  for (let t = 0; t < phaseSec; t += sampleSec) {
    await sleep(sampleSec * 1000);
    const cur = await sample();
    series.push({
      cpuPercentOfOneCore: Math.round(((cpu100ns(cur) - cpu100ns(prev)) / 1e4 / (cur.at - prev.at)) * 10000) / 100,
      processes: cur.rows.length,
      privateMB: Math.round(cur.rows.reduce((a, r) => a + Number(r.PrivatePageCount ?? 0), 0) / 1048576),
    });
    prev = cur;
  }
  const passive = {
    at: new Date().toISOString(),
    label: 'PASSIVE Win32_Process sample: no control, no phases (the app does whatever it does meanwhile); REAL for that process set only',
    exe: passiveExe,
    phaseSec,
    sampleSec,
    processes: first.rows.length,
    cpuAvgPercentOfOneCore: series.length ? Math.round((series.reduce((a, x) => a + x.cpuPercentOfOneCore, 0) / series.length) * 100) / 100 : null,
    series,
  };
  fs.mkdirSync(outDir, { recursive: true });
  const pfile = path.join(outDir, `bench-passive-${passive.at.replace(/[:.]/g, '-')}.json`);
  fs.writeFileSync(pfile, JSON.stringify(passive, null, 2));
  console.log(`bench: wrote ${path.relative(root, pfile)}`);
  console.log(JSON.stringify(passive, null, 1));
  process.exit(0);
}

// ---- own windows for the lively phase (class names and PIDs only; never a title) ----
let w32 = null;
function win32() {
  if (w32) return w32;
  const user32 = koffi.load('user32.dll');
  const WNDENUMPROC = koffi.proto('__stdcall', null, 'int', ['void *', 'intptr_t']);
  const EnumWindows = user32.func('__stdcall', 'EnumWindows', 'int', [koffi.pointer(WNDENUMPROC), 'intptr_t']);
  const GetClassNameW = user32.func('int __stdcall GetClassNameW(void *h, void *buf, int max)');
  const GetWindowThreadProcessId = user32.func('uint32_t __stdcall GetWindowThreadProcessId(void *h, _Out_ uint32_t *pid)');
  const IsWindowVisible = user32.func('int __stdcall IsWindowVisible(void *h)');
  const PostMessageW = user32.func('int __stdcall PostMessageW(void *h, uint32_t msg, uintptr_t w, intptr_t l)');
  const buf = Buffer.alloc(512);
  w32 = {
    windows() {
      const hs = [];
      EnumWindows((h) => {
        if (h !== null) hs.push(h);
        return hs.length < 4096 ? 1 : 0;
      }, 0);
      return hs.map((h) => {
        const n = GetClassNameW(h, buf, 256);
        const pid = [0];
        GetWindowThreadProcessId(h, pid);
        return { h, key: String(h), cls: n > 0 ? buf.toString('utf16le', 0, n * 2) : '', pid: pid[0], visible: IsWindowVisible(h) !== 0 };
      });
    },
    /** WM_SYSCOMMAND SC_CLOSE to one of OUR windows. */
    scClose: (h) => PostMessageW(h, 0x0112, 0xf060, 0) !== 0,
  };
  return w32;
}
const ofClass = (cls) => win32().windows().filter((w) => w.visible && w.cls === cls);
async function freshWindow(cls, before, timeoutMs = 20000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    const w = ofClass(cls).find((x) => !before.has(x.key));
    if (w) return w;
    await sleep(250);
  }
  return null;
}

/** Opens the lively phase's own windows; returns their PIDs and how to close them (only them). */
async function openOwnWindows() {
  const own = { pids: [], closers: [], notes: [] };
  if (livelyWindows.has('edge')) {
    const pf86 = process.env['ProgramFiles(x86)'] ?? 'C:\\Program Files (x86)';
    const pf = process.env.ProgramFiles ?? 'C:\\Program Files';
    const edge = [path.join(pf86, 'Microsoft', 'Edge', 'Application', 'msedge.exe'), path.join(pf, 'Microsoft', 'Edge', 'Application', 'msedge.exe')].find((x) => fs.existsSync(x));
    if (!edge) own.notes.push('edge: not installed');
    else {
      const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'dcat-bench-edge-'));
      const marker = path.basename(profile);
      const args = [`--user-data-dir=${profile}`, '--no-first-run', '--no-default-browser-check', '--disable-background-networking', '--disable-component-update', '--disable-sync', '--window-position=300,160', '--window-size=1000,800', 'about:blank', 'about:blank'];
      const p = spawn(edge, args, { stdio: 'ignore' });
      p.on('error', () => undefined);
      const pidsOf = async () => {
        const out = await pwsh(`Get-CimInstance Win32_Process -Filter "Name='msedge.exe' AND CommandLine LIKE '%${marker}%'" | ForEach-Object { $_.ProcessId }`);
        return (out ?? '').split(/\r?\n/).map((x) => Number(x.trim())).filter((n) => Number.isInteger(n) && n > 0);
      };
      await sleep(4000);
      const pids = await pidsOf();
      own.pids.push(...pids);
      own.closers.push(async () => {
        const mine = new Set(await pidsOf());
        for (const w of win32().windows()) if (mine.has(w.pid) && w.cls === 'Chrome_WidgetWin_1') win32().scClose(w.h);
        await sleep(5000);
        // Only processes verified as ours (by the unique profile marker) are ended, one PID at a time.
        for (const pid of await pidsOf()) await new Promise((r) => execFile('taskkill.exe', ['/PID', String(pid), '/F'], { windowsHide: true }, () => r()));
        for (let i = 0; i < 10; i++) {
          try {
            fs.rmSync(profile, { recursive: true, force: true });
            break;
          } catch {
            await sleep(500);
          }
        }
      });
      own.notes.push(`edge: ${pids.length} own processes`);
    }
  }
  if (livelyWindows.has('terminal')) {
    const cls = 'CASCADIA_HOSTING_WINDOW_CLASS';
    const existing = ofClass(cls);
    const name = `dcat-bench-${crypto.randomBytes(4).toString('hex')}`;
    await new Promise((r) => execFile('wt.exe', ['-w', name, 'new-tab', '--', 'ping', '-t', '127.0.0.1'], { windowsHide: true, timeout: 30000 }, () => r()));
    const w = await freshWindow(cls, new Set(existing.map((x) => x.key)));
    if (!w) own.notes.push('terminal: no own window (wt.exe missing?)');
    else if (existing.some((x) => x.pid === w.pid)) {
      win32().scClose(w.h);
      own.notes.push("terminal: skipped, its process hosts the user's Terminal windows");
    } else {
      own.pids.push(w.pid);
      // Only our window is closed; Terminal hosts every window in one process, which is never ended.
      own.closers.push(async () => void win32().scClose(w.h));
      own.notes.push('terminal: own window');
    }
  }
  if (livelyWindows.has('explorer')) {
    const cls = 'CabinetWClass';
    const before = new Set(ofClass(cls).map((x) => x.key));
    const shell = win32().windows().find((x) => x.cls === 'Shell_TrayWnd')?.pid ?? null;
    const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'dcat-bench-explorer-'));
    await pwsh(`Start-Process -FilePath '${folder.replace(/'/g, "''")}' -Verb opennewprocess`);
    const w = await freshWindow(cls, before);
    if (!w) own.notes.push('explorer: no own window');
    else if (w.pid === shell) {
      win32().scClose(w.h);
      own.notes.push("explorer: skipped, it opened in the shell's process");
    } else {
      own.pids.push(w.pid);
      // SC_CLOSE only; explorer.exe is never killed.
      own.closers.push(async () => {
        win32().scClose(w.h);
        await sleep(2000);
        fs.rmSync(folder, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
      });
      own.notes.push('explorer: own window in its own process');
    }
  }
  return own;
}

/** The injected cursor (never the real one): a slow sweep, and every 20 s an erratic 4 s near the cat. */
function startCursorPath(display) {
  const t0 = Date.now();
  let busy = false;
  const timer = setInterval(async () => {
    if (busy) return;
    busy = true;
    try {
      const t = (Date.now() - t0) / 1000;
      let p;
      if (t % 20 < 4) {
        const o = await hook('getSimOutput');
        const bw = 84 * (display.scale ?? 1);
        const base = o ? { x: o.x, y: o.y } : { x: display.width / 2, y: display.height * 0.8 };
        p = { x: base.x + Math.sin(t * 7) * 3 * bw + Math.sin(t * 17) * bw, y: base.y - bw * (0.8 + 0.5 * Math.sin(t * 5)) };
      } else {
        p = { x: display.width * (0.5 + 0.4 * Math.sin(t * 0.37)), y: display.height * (0.5 + 0.35 * Math.sin(t * 0.23)) };
      }
      await hook('injectCursor', { x: Math.round(Math.max(0, Math.min(display.width - 1, p.x))), y: Math.round(Math.max(0, Math.min(display.height - 1, p.y))) });
    } catch {
      /* the next tick retries */
    } finally {
      busy = false;
    }
  }, 100);
  return () => clearInterval(timer);
}

const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'dcat-bench-'));

const app = await electron.launch({
  executablePath: exe,
  args: [path.join(root, 'out', 'main', 'index.js')],
  cwd: root,
  env: { ...process.env, DESKTOP_CAT_TEST: '1', DESKTOP_CAT_USER_DATA: userData },
  timeout: 45000,
});
const hook = (name, ...args) => app.evaluate(async (_e, c) => globalThis.__desktopCatTest[c.name](...c.args), { name, args });
const metrics = () =>
  app.evaluate(({ app: a }) => {
    const m = a.getAppMetrics();
    const res = process.getActiveResourcesInfo();
    const count = (k) => res.filter((r) => r === k).length;
    return {
      cpu: m.reduce((s, p) => s + p.cpu.percentCPUUsage, 0),
      byType: Object.fromEntries(m.map((p) => [`${p.type}:${p.pid}`, Math.round(p.cpu.percentCPUUsage * 100) / 100])),
      workingSetMB: Math.round(m.reduce((s, p) => s + p.memory.workingSetSize, 0) / 1024),
      // privateBytes (Windows): memory not shared with other processes, so it can be summed meaningfully.
      privateMB: Math.round(m.reduce((s, p) => s + (p.memory.privateBytes ?? 0), 0) / 1024),
      mainHeapMB: Math.round(process.memoryUsage().heapUsed / 1048576),
      timers: count('Timeout'),
      handles: res.length,
    };
  });

// ---- the UIA helper (not in getAppMetrics) ----
const HELPER_EXE = 'desktopcatuia.exe';
const appPid = app.process().pid;
/**
 * The helper processes the app's main process spawned (src/main/uia/client.ts spawns the exe
 * directly, so it is a child of `rootPid`; no other process is read), with CPU time (100 ns
 * units) and memory (bytes). [] off Windows or on any failure. One WQL query per sample: walking
 * the whole tree level by level took ~12 s per sample on the dev machine.
 */
function helperProcesses(rootPid) {
  if (process.platform !== 'win32' || !Number.isInteger(rootPid)) return Promise.resolve([]);
  const script = [
    `$f = "ParentProcessId=${rootPid} AND Name='DesktopCatUia.exe'"`,
    '$c = @(Get-CimInstance Win32_Process -Filter $f | Select-Object ProcessId,ParentProcessId,Name,KernelModeTime,UserModeTime,WorkingSetSize,PrivatePageCount)',
    'ConvertTo-Json -Compress -InputObject @($c)',
  ].join('\n');
  return new Promise((resolve) => {
    execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { encoding: 'utf8', timeout: 20000, windowsHide: true, maxBuffer: 4 * 1024 * 1024 }, (err, stdout) => {
      if (err) return resolve([]);
      try {
        const rows = JSON.parse(stdout.trim() || '[]');
        resolve(Array.isArray(rows) ? rows : [rows]);
      } catch {
        resolve([]);
      }
    });
  });
}
/** CPU time per helper pid at the previous sample: { pid: { cpu100ns, at } }. */
const helperPrev = new Map();
/** One sample of the helper(s): running, CPU % of one core since the previous sample (null on the first), private and working set (MB). */
async function helperMetrics() {
  const at = performance.now();
  const rows = (await helperProcesses(appPid)).filter((p) => String(p.Name).toLowerCase() === HELPER_EXE && Number(p.ParentProcessId) === appPid);
  let cpu = null;
  let privateBytes = 0;
  let workingSet = 0;
  const seen = new Set();
  for (const p of rows) {
    const pid = Number(p.ProcessId);
    const t = Number(p.KernelModeTime ?? 0) + Number(p.UserModeTime ?? 0);
    const prev = helperPrev.get(pid);
    if (prev && at > prev.at) cpu = (cpu ?? 0) + ((t - prev.cpu100ns) / 1e4 / (at - prev.at)) * 100;
    helperPrev.set(pid, { cpu100ns: t, at });
    seen.add(pid);
    privateBytes += Number(p.PrivatePageCount ?? 0);
    workingSet += Number(p.WorkingSetSize ?? 0);
  }
  for (const pid of [...helperPrev.keys()]) if (!seen.has(pid)) helperPrev.delete(pid);
  const mb = (b) => Math.round((b / 1048576) * 10) / 10;
  return {
    running: rows.length > 0,
    pids: rows.map((p) => Number(p.ProcessId)),
    cpu: cpu === null ? null : Math.round(cpu * 100) / 100,
    privateMB: rows.length > 0 ? mb(privateBytes) : null,
    workingSetMB: rows.length > 0 ? mb(workingSet) : null,
  };
}
/** Per-phase summary of the helper samples (nulls where it never ran). */
function helperSummary(samples) {
  const vals = (k) => samples.map((s) => s[k]).filter((v) => v !== null);
  const avg = (xs) => (xs.length === 0 ? null : Math.round((xs.reduce((a, b) => a + b, 0) / xs.length) * 100) / 100);
  const max = (xs) => (xs.length === 0 ? null : Math.max(...xs));
  const span = (k) => {
    const xs = vals(k);
    return xs.length === 0 ? null : { first: xs[0], last: xs.at(-1), max: max(xs) };
  };
  return {
    runningShare: samples.length === 0 ? 0 : Math.round((samples.filter((s) => s.running).length / samples.length) * 100) / 100,
    // Averaged over all samples (0 while not running; a helper's first sample has no CPU figure yet).
    cpuAvgPercentOfOneCore: avg(samples.filter((s) => !s.running || s.cpu !== null).map((s) => (s.running ? s.cpu : 0))),
    cpuMaxPercentOfOneCore: max(vals('cpu')),
    privateMB: span('privateMB'),
    workingSetMB: span('workingSetMB'),
    pids: [...new Set(samples.flatMap((s) => s.pids))],
  };
}

const report = { at: new Date().toISOString(), phaseSec, sampleSec, os: `${os.type()} ${os.release()}`, cpus: os.cpus().length, appPid, phases: {} };
try {
  for (let i = 0; i < 60; i++) {
    const out = await hook('getSimOutput');
    if (out) break;
    await sleep(500);
  }
  await sleep(4000);
  await metrics(); // prime CPU counters
  let lively = null;
  const allPhases = {
    awake: async () => hook('injectEvent', { type: 'command.wake' }),
    asleep: async () => hook('injectEvent', { type: 'command.sleep' }),
    hidden: async () => hook('runAction', 'hide'),
    paused: async () => {
      await hook('runAction', 'show');
      await hook('runAction', 'pause');
    },
    lively: async () => {
      await hook('runAction', 'resume');
      await hook('runAction', 'show');
      await hook('injectEvent', { type: 'command.wake' });
      const own = await openOwnWindows();
      lively = { own, stopCursor: null, restricted: false };
      try {
        await hook('restrictSurfacesToPids', own.pids.length ? own.pids : [appPid]);
        lively.restricted = true;
      } catch (e) {
        own.notes.push(`restrictSurfacesToPids failed (${e instanceof Error ? e.message.split('\n')[0] : String(e)}): phase skipped, own windows closed`);
        return false;
      }
      const d = await app.evaluate(({ screen }) => {
        const p = screen.getPrimaryDisplay();
        return { width: Math.round(p.size.width * p.scaleFactor), height: Math.round(p.size.height * p.scaleFactor), scale: p.scaleFactor };
      });
      lively.stopCursor = startCursorPath(d);
      return true;
    },
  };
  const leaveLively = async () => {
    if (!lively) return;
    lively.stopCursor?.();
    await hook('injectCursor', null).catch(() => undefined);
    if (lively.restricted) await hook('restrictSurfacesToPids', null).catch(() => undefined);
    for (const close of lively.own.closers) await close().catch(() => undefined);
  };
  const phases = phaseNames.filter((n) => n in allPhases).map((n) => [n, allPhases[n]]);
  for (const [name, enter] of phases) {
    const entered = await enter();
    if (entered === false) {
      report.phases[name] = { skipped: true, notes: lively?.own.notes ?? [] };
      await leaveLively();
      lively = null;
      continue;
    }
    await sleep(3000);
    await metrics();
    await helperMetrics(); // prime the helper's CPU baseline
    const samples = [];
    const helperSamples = [];
    const states = new Set();
    let asleepSamples = 0;
    for (let t = 0; t < phaseSec; t += sampleSec) {
      await sleep(sampleSec * 1000);
      samples.push(await metrics());
      helperSamples.push(await helperMetrics());
      const o = await hook('getSimOutput');
      if (o) states.add(o.state);
      if (o && o.state === 'sleeping') asleepSamples++;
      // Keep the asleep phase asleep: the cat may wake on its own (or because the user is active).
      if (name === 'asleep' && o && o.state !== 'sleeping' && o.state !== 'fallingAsleep') await hook('injectEvent', { type: 'command.sleep' });
      // Keep the awake phase awake and moving: on an idle machine the cat would otherwise nap.
      if (name === 'awake' && o) {
        if (o.state === 'sleeping' || o.state === 'fallingAsleep') await hook('injectEvent', { type: 'command.wake' });
        else await hook('injectEvent', { type: 'command.play' });
      }
    }
    const avg = (k) => Math.round((samples.reduce((s, x) => s + x[k], 0) / samples.length) * 100) / 100;
    const uiaHelper = helperSummary(helperSamples);
    report.phases[name] = {
      cpuAvgPercentOfOneCore: avg('cpu'),
      cpuMaxPercentOfOneCore: Math.round(Math.max(...samples.map((s) => s.cpu)) * 100) / 100,
      workingSetMB: { first: samples[0].workingSetMB, last: samples.at(-1).workingSetMB },
      privateMB: { first: samples[0].privateMB, last: samples.at(-1).privateMB },
      asleepShare: Math.round((asleepSamples / samples.length) * 100) / 100,
      mainHeapMB: { first: samples[0].mainHeapMB, last: samples.at(-1).mainHeapMB },
      timers: { first: samples[0].timers, last: samples.at(-1).timers, max: Math.max(...samples.map((s) => s.timers)) },
      handles: { first: samples[0].handles, last: samples.at(-1).handles },
      statesSeen: [...states],
      lastByProcess: samples.at(-1).byType,
      // DesktopCatUia.exe (outside getAppMetrics): add it to the figures above for the whole app.
      uiaHelper,
      withHelper: {
        cpuAvgPercentOfOneCore: Math.round((avg('cpu') + (uiaHelper.cpuAvgPercentOfOneCore ?? 0)) * 100) / 100,
        privateMBLast: Math.round((samples.at(-1).privateMB + (helperSamples.at(-1)?.privateMB ?? 0)) * 10) / 10,
      },
    };
    if (name === 'lively') {
      report.phases[name].label = 'own windows only, injected cursor, no forced command.play';
      report.phases[name].ownWindows = lively?.own.notes ?? [];
      report.phases[name].behaviorProfile = await hook('getBehaviorProfile').catch(() => null);
      await leaveLively();
      lively = null;
    }
    console.log(`bench: ${name} done`, JSON.stringify(report.phases[name]));
  }
  // B12 (ADR 0003 §14): awake CPU <= 1.5 % of a core and <= 0.3 pp above the v1.1.1 baseline.
  const awake = report.phases.awake?.withHelper?.cpuAvgPercentOfOneCore ?? null;
  report.gateB12 =
    awake === null
      ? { status: 'n/a', reason: 'no awake phase' }
      : { awake, baselineAwake, limit: 1.5, maxRegressionPp: 0.3, status: awake <= 1.5 && awake - baselineAwake <= 0.3 ? 'pass' : 'fail' };
  await hook('runAction', 'resume');
  report.logProblems = await hook('getLogProblems');
  report.hostDebug = await hook('getHostDebug');
} finally {
  const proc = app.process();
  const exited = new Promise((r) => proc.once('exit', (c) => r(c)));
  void hook('quit').catch(() => undefined);
  const code = await Promise.race([exited, sleep(15000).then(() => 'timeout')]);
  if (code === 'timeout') proc.kill();
  report.exitCode = code;
  fs.rmSync(userData, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
}
fs.mkdirSync(outDir, { recursive: true });
const file = path.join(outDir, `bench-${report.at.replace(/[:.]/g, '-')}.json`);
fs.writeFileSync(file, JSON.stringify(report, null, 2));
console.log(`bench: wrote ${path.relative(root, file)}`);
console.log(JSON.stringify(report, null, 1));
