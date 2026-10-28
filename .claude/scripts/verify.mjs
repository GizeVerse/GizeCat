#!/usr/bin/env node
// Runs a verification tier from .claude/standard.json sequentially and records the outcome against
// the working-tree content identity, so "verified" always refers to the exact code on disk.
//
//   node .claude/scripts/verify.mjs [tier=fast] [--only name[,name]] [--list]
//
// "verify": { "fast": [{ "name": "unit", "cmd": "npm test", "cwd": ".", "timeoutSec": 600,
//                        "requires": { "env": ["DATABASE_URL"], "probe": "docker info" } }], "full": [...] }
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { projectDir, loadConfig, stateDir, contentIdentity, git, STANDARD_VERSION } from '../hooks/lib.mjs';

const args = process.argv.slice(2);
const tier = args.find((a) => !a.startsWith('--')) || 'fast';
const onlyArg = args.includes('--only') ? args[args.indexOf('--only') + 1] : null;
const only = onlyArg ? onlyArg.split(',') : null;

const dir = projectDir();
const cfg = loadConfig(dir);
const steps = (cfg.verify[tier] || []).filter((s) => !only || only.includes(s.name));

if (args.includes('--list') || !cfg.verify[tier]) {
  for (const [t, list] of Object.entries(cfg.verify)) console.log(`${t}: ${list.map((s) => s.name).join(', ')}`);
  if (!cfg.verify[tier]) { console.error(`No tier "${tier}" in .claude/standard.json`); process.exit(2); }
  process.exit(0);
}

const gitBash = ['C:\\Program Files\\Git\\bin\\bash.exe', 'C:\\Program Files (x86)\\Git\\bin\\bash.exe'].find((p) => fs.existsSync(p));
function shellFor(step) {
  const want = step.shell || (process.platform === 'win32' ? (gitBash ? 'bash' : 'cmd') : 'sh');
  if (want === 'bash') return [process.platform === 'win32' ? gitBash : 'bash', ['-c', step.cmd]];
  if (want === 'pwsh') return ['powershell.exe', ['-NoProfile', '-Command', step.cmd]];
  if (want === 'cmd') return ['cmd.exe', ['/d', '/s', '/c', step.cmd]];
  return ['/bin/sh', ['-c', step.cmd]];
}

function unmet(step) {
  const r = step.requires || {};
  const missing = (r.env || []).filter((v) => !process.env[v]);
  if (missing.length) return `needs env ${missing.join(', ')}`;
  if (r.probe) {
    const [cmd, a] = shellFor({ ...step, cmd: r.probe });
    const p = spawnSync(cmd, a, { cwd: path.join(dir, step.cwd || '.'), stdio: 'ignore', timeout: 30000 });
    if (p.status !== 0) return `probe failed: ${r.probe}`;
  }
  return null;
}

// One verification at a time per machine: concurrent heavy runs on a shared machine skew results.
const lockFile = process.env.CLAUDE_STANDARD_VERIFY_LOCKFILE || path.join(os.tmpdir(), 'claude-standard-verify.lock');
function alive(pid) { try { process.kill(pid, 0); return true; } catch { return false; } }
async function acquireLock() {
  // A verify started by a step of another verify (e.g. the selftest) runs under its parent's lock.
  if (process.env.CLAUDE_STANDARD_VERIFY_LOCK === '1') return false;
  const waitSec = Number(process.env.CLAUDE_STANDARD_VERIFY_LOCK_WAIT_SEC) || 30 * 60;
  const deadline = Date.now() + waitSec * 1000;
  let announced = false;
  for (;;) {
    try {
      fs.writeFileSync(lockFile, JSON.stringify({ pid: process.pid, dir, tier, at: new Date().toISOString() }), { flag: 'wx' });
      return true;
    } catch {
      let holder = null;
      try { holder = JSON.parse(fs.readFileSync(lockFile, 'utf8')); } catch { /* partially written */ }
      if (holder && !alive(holder.pid)) { fs.rmSync(lockFile, { force: true }); continue; }
      if (Date.now() > deadline) { console.error('verify: gave up waiting for the machine verify lock'); process.exit(3); }
      if (!announced) { console.log(`verify: waiting for another run (${holder ? holder.dir + ' ' + holder.tier : 'unknown'}) to finish…`); announced = true; }
      await new Promise((r) => setTimeout(r, Math.min(5000, waitSec * 250)));
    }
  }
}

function runStep(step, logPath) {
  return new Promise((resolve) => {
    const [cmd, a] = shellFor(step);
    const out = fs.openSync(logPath, 'w');
    const t0 = Date.now();
    const child = spawn(cmd, a, { cwd: path.join(dir, step.cwd || '.'), stdio: ['ignore', out, out], env: { ...process.env, CI: process.env.CI || '1', FORCE_COLOR: '0', CLAUDE_STANDARD_VERIFY_LOCK: '1' } });
    const limit = (step.timeoutSec || 900) * 1000;
    const timer = setTimeout(() => {
      if (process.platform === 'win32') spawnSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
      else child.kill('SIGKILL');
    }, limit);
    child.on('close', (code, signal) => {
      clearTimeout(timer); fs.closeSync(out);
      const seconds = (Date.now() - t0) / 1000;
      const timedOut = seconds * 1000 >= limit;
      resolve({ exitCode: code, signal, seconds, timedOut });
    });
    child.on('error', (e) => { clearTimeout(timer); fs.closeSync(out); resolve({ exitCode: -1, seconds: (Date.now() - t0) / 1000, error: String(e) }); });
  });
}

function tail(file, n) {
  const lines = fs.readFileSync(file, 'utf8').replace(/\x1b\[[0-9;]*m/g, '').trimEnd().split(/\r?\n/);
  return lines.slice(-n).map((l) => '        ' + l.slice(0, 300)).join('\n');
}

await acquireLock();
// Shared machines: run the whole test tree below normal priority (children inherit it on Windows and Linux).
if (process.env.CLAUDE_STANDARD_LOW_PRIORITY === '1' || cfg.machine.verifyLowPriority) {
  try { os.setPriority(os.constants.priority.PRIORITY_BELOW_NORMAL); console.log('verify: below-normal priority (shared machine)'); } catch { /* not permitted here */ }
}
process.on('exit', () => { try { const h = JSON.parse(fs.readFileSync(lockFile, 'utf8')); if (h.pid === process.pid) fs.rmSync(lockFile, { force: true }); } catch { /* already gone */ } });
process.on('SIGINT', () => process.exit(130));

const logs = path.join(stateDir(dir), 'logs');
fs.mkdirSync(logs, { recursive: true });
const ignore = cfg.stopGate.ignore || [];
const identity = contentIdentity(dir, ignore);
const startedAt = new Date().toISOString();
console.log(`verify ${tier} — ${steps.length} step(s), sequential`);
const results = [];
for (const step of steps) {
  const why = unmet(step);
  if (why) {
    results.push({ name: step.name, cmd: step.cmd, status: 'SKIPPED', reason: why });
    console.log(`  SKIP  ${step.name.padEnd(18)}        ${why} (UNVERIFIED)`);
    continue;
  }
  const logPath = path.join(logs, `${tier}-${step.name}.log`);
  const r = await runStep(step, logPath);
  const status = r.exitCode === 0 ? 'PASS' : 'FAIL';
  const relLog = path.relative(dir, logPath).replace(/\\/g, '/');
  results.push({ name: step.name, cmd: step.cmd, status, exitCode: r.exitCode, seconds: +r.seconds.toFixed(1), timedOut: r.timedOut || undefined, log: relLog });
  console.log(`  ${status}  ${step.name.padEnd(18)} ${r.seconds.toFixed(1).padStart(6)}s${status === 'FAIL' ? `  exit ${r.exitCode}${r.timedOut ? ' (timeout)' : ''}  log: ${relLog}` : ''}`);
  if (status === 'FAIL') console.log(tail(logPath, step.tailLines || 25));
  if (status === 'FAIL' && step.stopOnFail) break;
}

const identityAfter = contentIdentity(dir, ignore);
const failed = results.filter((r) => r.status === 'FAIL').length;
const skipped = results.filter((r) => r.status === 'SKIPPED').length;
const passed = results.filter((r) => r.status === 'PASS').length;
const status = failed ? 'FAIL' : skipped ? 'PARTIAL' : 'PASS';
const record = {
  standard: STANDARD_VERSION, tier, status, startedAt, finishedAt: new Date().toISOString(),
  identity, stale: identity !== identityAfter, head: git(dir, ['rev-parse', '--short', 'HEAD']), branch: git(dir, ['branch', '--show-current']),
  results,
};
fs.writeFileSync(path.join(stateDir(dir), 'last-verify.json'), JSON.stringify(record, null, 2));
fs.writeFileSync(path.join(stateDir(dir), `last-verify-${tier}.json`), JSON.stringify(record, null, 2));
console.log(`RESULT ${status} (${passed} passed, ${failed} failed, ${skipped} skipped)${record.stale ? ' — WARNING: files changed during the run; result is stale' : ''}`);
process.exit(failed ? 1 : 0);
