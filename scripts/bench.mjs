#!/usr/bin/env node
// Resource benchmark of the real app (dev build in out/, test hooks for control only).
// Phases: awake, asleep, hidden, paused. Samples app.getAppMetrics() (CPU % of one core
// summed over all processes, working set) plus main-process active timers/handles so
// leaks show up as growth. Results: out/bench/bench-<timestamp>.json.
//
//   node scripts/with-lock.mjs bench -- node scripts/bench.mjs [--phase-sec=120] [--sample-sec=10]
import { _electron as electron } from '@playwright/test';
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

const report = { at: new Date().toISOString(), phaseSec, sampleSec, os: `${os.type()} ${os.release()}`, cpus: os.cpus().length, phases: {} };
try {
  for (let i = 0; i < 60; i++) {
    const out = await hook('getSimOutput');
    if (out) break;
    await sleep(500);
  }
  await sleep(4000);
  await metrics(); // prime CPU counters
  const phases = [
    ['awake', async () => {}],
    ['asleep', async () => hook('injectEvent', { type: 'command.sleep' })],
    ['hidden', async () => hook('runAction', 'hide')],
    ['paused', async () => { await hook('runAction', 'show'); await hook('runAction', 'pause'); }],
  ];
  for (const [name, enter] of phases) {
    await enter();
    await sleep(3000);
    await metrics();
    const samples = [];
    const states = new Set();
    let asleepSamples = 0;
    for (let t = 0; t < phaseSec; t += sampleSec) {
      await sleep(sampleSec * 1000);
      samples.push(await metrics());
      const o = await hook('getSimOutput');
      if (o) states.add(o.state);
      if (o && o.state === 'sleeping') asleepSamples++;
      // Keep the asleep phase asleep: the cat may wake on its own (or because the user is active).
      if (name === 'asleep' && o && o.state !== 'sleeping' && o.state !== 'fallingAsleep') await hook('injectEvent', { type: 'command.sleep' });
    }
    const avg = (k) => Math.round((samples.reduce((s, x) => s + x[k], 0) / samples.length) * 100) / 100;
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
