#!/usr/bin/env node
// Resource benchmark of the real app (dev build in out/, test hooks for control only).
// Phases: awake, asleep, hidden, paused. Samples app.getAppMetrics() (CPU % of one core
// summed over all processes, working set) plus main-process active timers/handles so
// leaks show up as growth. getAppMetrics() covers only Chromium's own processes, so the
// tab-strip helper the app may spawn (DesktopCatUia.exe, a child of the app's main process)
// is sampled separately through Win32_Process (CPU from its kernel+user time, private bytes,
// working set) and reported per phase as `uiaHelper` (and added in `withHelper`). Only the
// app's own child processes are read. Results: out/bench/bench-<timestamp>.json.
//
//   node scripts/with-lock.mjs bench -- node scripts/bench.mjs [--phase-sec=120] [--sample-sec=10]
import { _electron as electron } from '@playwright/test';
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const num = (n, d) => {
  const a = process.argv.find((x) => x.startsWith(`--${n}=`));
  return a ? Number(a.split('=')[1]) : d;
};
const phaseSec = num('phase-sec', 120);
const sampleSec = num('sample-sec', 10);
const exe = path.join(root, 'node_modules', 'electron', 'dist', fs.readFileSync(path.join(root, 'node_modules', 'electron', 'path.txt'), 'utf8').trim());
const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'dcat-bench-'));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

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
  const phases = [
    ['awake', async () => hook('injectEvent', { type: 'command.wake' })],
    ['asleep', async () => hook('injectEvent', { type: 'command.sleep' })],
    ['hidden', async () => hook('runAction', 'hide')],
    ['paused', async () => { await hook('runAction', 'show'); await hook('runAction', 'pause'); }],
  ];
  for (const [name, enter] of phases) {
    await enter();
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
    console.log(`bench: ${name} done`, JSON.stringify(report.phases[name]));
  }
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
const outDir = path.join(root, 'out', 'bench');
fs.mkdirSync(outDir, { recursive: true });
const file = path.join(outDir, `bench-${report.at.replace(/[:.]/g, '-')}.json`);
fs.writeFileSync(file, JSON.stringify(report, null, 2));
console.log(`bench: wrote ${path.relative(root, file)}`);
console.log(JSON.stringify(report, null, 1));
