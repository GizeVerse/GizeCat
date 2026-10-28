#!/usr/bin/env node
// Stop: if this session changed code and no passing verification covers the exact current tree,
// block once and ask for verification or an explicit UNVERIFIED label. Never blocks twice in a row
// (stop_hook_active), never blocks sessions that changed nothing, never blocks without a verify config.
import fs from 'node:fs';
import path from 'node:path';
import { readStdinJson, projectDir, loadConfig, stateDir, contentIdentity, logHookError, emit, ago, sessionFile, errorText } from './lib.mjs';

function lastAssistantText(input) {
  if (typeof input.last_assistant_message === 'string') return input.last_assistant_message;
  try {
    const fd = fs.openSync(input.transcript_path, 'r');
    const size = fs.fstatSync(fd).size;
    const len = Math.min(size, 512 * 1024);
    const buf = Buffer.alloc(len);
    fs.readSync(fd, buf, 0, len, size - len);
    fs.closeSync(fd);
    const rows = buf.toString('utf8').split('\n').reverse();
    for (const row of rows) {
      let e; try { e = JSON.parse(row); } catch { continue; }
      if (e.type !== 'assistant' || !e.message) continue;
      const text = (e.message.content || []).filter((c) => c.type === 'text').map((c) => c.text).join('\n');
      if (text.trim()) return text;
    }
  } catch { /* no transcript available */ }
  return '';
}

let dir = process.cwd();
let input = {};
try {
  input = await readStdinJson();
  dir = projectDir(input);
  const cfg = loadConfig(dir);
  const tiers = Object.keys(cfg.verify || {});
  // No baseline means no mutating tool ran in this repo this session: SessionStart or the first
  // guarded Bash/Edit/Write call records one before anything can change.
  let baseline;
  try { baseline = JSON.parse(fs.readFileSync(sessionFile(dir, input.session_id), 'utf8')).baseline; } catch { baseline = undefined; }
  if (cfg.stopGate.enabled && !input.stop_hook_active && tiers.length && baseline !== undefined) {
    const identity = contentIdentity(dir, cfg.stopGate.ignore);
    if (!identity) throw new Error('could not compute the working-tree identity (git failed)');
    let record = null;
    try { record = JSON.parse(fs.readFileSync(path.join(stateDir(dir), 'last-verify.json'), 'utf8')); } catch { /* never verified */ }
    const changedThisSession = identity !== baseline;
    const covered = record && record.identity === identity && record.status !== 'FAIL' && !record.stale;
    const labelled = /\bUNVERIFIED\b/.test(lastAssistantText(input));
    if (changedThisSession && !covered && !labelled) {
      const first = cfg.stopGate.tier || (tiers.includes('fast') ? 'fast' : tiers[0]);
      const last = record ? `last run: ${record.tier} ${record.status} ${ago(Date.now() - Date.parse(record.finishedAt))}${record.identity !== identity ? ', on different code' : ''}${record.stale ? ', stale' : ''}` : 'no run recorded';
      emit({ decision: 'block', reason:
        `[standard:definition-of-done] Code changed in this session is not covered by a passing verification of the current tree (${last}). ` +
        `Run \`node .claude/scripts/verify.mjs ${first}\` and report the result. If it cannot run here, say so and label the affected claims UNVERIFIED. ` +
        `If a check failed because of a pre-existing problem, report that with evidence. This gate fires once per stop.` });
    }
  }
} catch (e) {
  // A gate that cannot run must not look like a gate that passed.
  logHookError(dir, 'stop-gate', e);
  if (!input.stop_hook_active) {
    emit({ decision: 'block', reason:
      `[standard:stop-gate-error] The definition-of-done gate could not run (${errorText(e)}). ` +
      'Do not call the work verified unless `node .claude/scripts/verify.mjs` passed in this session. Label everything else UNVERIFIED, and report this error to the user.' });
  }
}
process.exit(0);
