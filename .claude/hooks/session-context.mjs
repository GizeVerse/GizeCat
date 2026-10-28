#!/usr/bin/env node
// SessionStart: inject a compact recovery summary (branch, dirty files, verification freshness,
// handoff note) and record the session's baseline tree for the stop gate. In cloud sessions
// (CLAUDE_CODE_REMOTE=true) it can run the repo's opt-in "cloudSetup" command on startup.
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { readStdinJson, projectDir, loadConfig, stateDir, contentIdentity, git, logHookError, emit, ago, ensureBaseline, errorText } from './lib.mjs';

let dir = process.cwd();
try {
  const input = await readStdinJson();
  dir = projectDir(input);
  const cfg = loadConfig(dir);
  const lines = [];
  const remote = process.env.CLAUDE_CODE_REMOTE === 'true';

  if (remote && cfg.cloudSetup && cfg.cloudSetup.cmd && (input.source || 'startup') === 'startup') {
    const t0 = Date.now();
    const p = spawnSync(cfg.cloudSetup.cmd, { cwd: dir, shell: true, encoding: 'utf8', timeout: (cfg.cloudSetup.timeoutSec || 600) * 1000, maxBuffer: 32 * 1024 * 1024 });
    const secs = ((Date.now() - t0) / 1000).toFixed(0);
    fs.writeFileSync(path.join(stateDir(dir), 'cloud-setup.log'), `${p.stdout || ''}\n${p.stderr || ''}`);
    lines.push(p.status === 0 ? `cloud setup: PASS in ${secs}s (${cfg.cloudSetup.cmd})` : `cloud setup: FAIL exit ${p.status} in ${secs}s — see .claude/state/cloud-setup.log; dependent checks are UNVERIFIED until fixed`);
  }

  const branch = git(dir, ['branch', '--show-current']) || '(detached)';
  const head = git(dir, ['log', '-1', '--format=%h %s']) || '';
  const counts = git(dir, ['rev-list', '--left-right', '--count', '@{upstream}...HEAD']);
  const track = counts ? (() => { const [behind, ahead] = counts.split(/\s+/); return ` (ahead ${ahead}, behind ${behind} of upstream)`; })() : ' (no upstream)';
  const dirty = (git(dir, ['status', '--porcelain']) || '').split('\n').filter(Boolean);
  lines.push(`branch ${branch}${track} | HEAD ${head.slice(0, 90)}`);
  if (dirty.length) lines.push(`uncommitted: ${dirty.length} file(s) — ${dirty.slice(0, 8).map((l) => l.slice(3)).join(', ')}${dirty.length > 8 ? ', …' : ''}`);
  if (/^(main|master)$/.test(branch)) lines.push('on a protected branch: create a feature branch (or worktree) before changing code');

  const identity = contentIdentity(dir, cfg.stopGate.ignore);
  ensureBaseline(dir, input.session_id, cfg.stopGate.ignore, identity);
  const sessions = path.join(stateDir(dir), 'sessions');
  fs.mkdirSync(sessions, { recursive: true });
  for (const f of fs.readdirSync(sessions)) {
    const p = path.join(sessions, f);
    if (Date.now() - fs.statSync(p).mtimeMs > 7 * 864e5) fs.rmSync(p, { force: true });
  }

  try {
    const v = JSON.parse(fs.readFileSync(path.join(stateDir(dir), 'last-verify.json'), 'utf8'));
    const fresh = v.identity && v.identity === identity && !v.stale;
    lines.push(`last verify: ${v.tier} ${v.status} ${ago(Date.now() - Date.parse(v.finishedAt))} — ${fresh ? 'matches the current tree' : 'STALE (code changed since)'}`);
  } catch { lines.push('last verify: none recorded (run node .claude/scripts/verify.mjs fast)'); }

  const errLog = path.join(stateDir(dir), 'hook-errors.log');
  if (fs.existsSync(errLog) && Date.now() - fs.statSync(errLog).mtimeMs < 7 * 864e5) {
    const n = fs.readFileSync(errLog, 'utf8').split('\n').filter((l) => /^\d{4}-\d\d-\d\dT/.test(l)).length;
    lines.push(`WARNING: ${n} hook error(s) logged, last ${ago(Date.now() - fs.statSync(errLog).mtimeMs)}. See .claude/state/hook-errors.log; guard decisions in that window may not have been made.`);
  }

  const handoff = path.join(dir, '.claude', 'handoff.md');
  if (fs.existsSync(handoff)) {
    const text = fs.readFileSync(handoff, 'utf8').split(/\r?\n/).filter((l) => l.trim()).slice(0, 12).join('\n');
    lines.push(`handoff note (.claude/handoff.md, ${ago(Date.now() - fs.statSync(handoff).mtimeMs)}):\n${text}`);
  }

  emit({ hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: `[standard] session state\n${lines.join('\n')}` } });
} catch (e) {
  logHookError(dir, 'session-context', e);
  emit({ hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext:
    `[standard] WARNING: the session-context hook failed (${errorText(e)}). The standard's hooks may not be working in this session; treat verification claims as UNVERIFIED until \`node .claude/scripts/selftest.mjs\` passes.` } });
}
process.exit(0);
