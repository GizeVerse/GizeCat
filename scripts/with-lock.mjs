#!/usr/bin/env node
// Runs a command under the machine-wide verification lock used by .claude/scripts/verify.mjs.
// On a shared PC, heavy work (test suites, builds, Electron runs, packaging, benchmarks)
// should run one at a time across all sessions.
//
// Usage: node scripts/with-lock.mjs <label> -- <command> [args...]
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const argv = process.argv.slice(2);
const sep = argv.indexOf('--');
if (sep < 1 || sep === argv.length - 1) {
  console.error('usage: node scripts/with-lock.mjs <label> -- <command> [args...]');
  process.exit(2);
}
const label = argv.slice(0, sep).join(' ');
const [cmd, ...args] = argv.slice(sep + 1);

const lockFile = process.env.CLAUDE_STANDARD_VERIFY_LOCKFILE || path.join(os.tmpdir(), 'claude-standard-verify.lock');
const nested = process.env.CLAUDE_STANDARD_VERIFY_LOCK === '1';

function alive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function acquire() {
  if (nested) return false;
  const waitSec = Number(process.env.CLAUDE_STANDARD_VERIFY_LOCK_WAIT_SEC) || 45 * 60;
  const deadline = Date.now() + waitSec * 1000;
  let announced = false;
  for (;;) {
    try {
      fs.writeFileSync(
        lockFile,
        JSON.stringify({ pid: process.pid, dir: process.cwd(), tier: `desktop-cat:${label}`, at: new Date().toISOString() }),
        { flag: 'wx' },
      );
      return true;
    } catch {
      let holder = null;
      try {
        holder = JSON.parse(fs.readFileSync(lockFile, 'utf8'));
      } catch {
        /* partially written */
      }
      if (holder && !alive(holder.pid)) {
        fs.rmSync(lockFile, { force: true });
        continue;
      }
      if (Date.now() > deadline) {
        console.error('with-lock: gave up waiting for the machine verify lock');
        process.exit(3);
      }
      if (!announced) {
        console.log(`with-lock: waiting for another run (${holder ? `${holder.dir} ${holder.tier}` : 'unknown'}) to finish...`);
        announced = true;
      }
      await new Promise((r) => setTimeout(r, 3000));
    }
  }
}

function release() {
  try {
    const h = JSON.parse(fs.readFileSync(lockFile, 'utf8'));
    if (h.pid === process.pid) fs.rmSync(lockFile, { force: true });
  } catch {
    /* already gone */
  }
}

const held = await acquire();
process.on('exit', () => {
  if (held) release();
});
process.on('SIGINT', () => process.exit(130));
process.on('SIGTERM', () => process.exit(143));

// On Windows npm/npx are .cmd shims and need a shell; pass one pre-quoted command line
// instead of an args array (args + shell:true is deprecated and unescaped).
const quote = (s) => (/^[\w@%+=:,./\\-]+$/.test(s) ? s : `"${s.replace(/"/g, '\\"')}"`);
const env = { ...process.env, CLAUDE_STANDARD_VERIFY_LOCK: '1' };
const child =
  process.platform === 'win32'
    ? spawn([cmd, ...args].map(quote).join(' '), { stdio: 'inherit', shell: true, env })
    : spawn(cmd, args, { stdio: 'inherit', env });
child.on('close', (code, signal) => process.exit(code ?? (signal ? 1 : 0)));
child.on('error', (e) => {
  console.error(`with-lock: failed to start ${cmd}: ${e.message}`);
  process.exit(1);
});
