#!/usr/bin/env node
// PreToolUse guard for Edit/Write/MultiEdit: simulates the edit and denies it when a marker that
// .claude/standard.json declares as an invariant would disappear from a protected file.
//
// "invariants": [{ "id": "research-only", "files": ["src/**/*.py"], "mustContain": ["RESEARCH_ONLY"],
//                  "reason": "...", "requireOnCreate": false }]
import fs from 'node:fs';
import path from 'node:path';
import { readStdinJson, projectDir, loadConfig, relPath, matchesAny, logHookError, emit, ensureBaseline, errorText } from './lib.mjs';

function replaceOnce(s, a, b, all) {
  if (!a) return s;
  if (all) return s.split(a).join(b);
  const i = s.indexOf(a);
  return i < 0 ? s : s.slice(0, i) + b + s.slice(i + a.length);
}

function simulate(toolName, ti, before) {
  if (toolName === 'Write') return ti.content ?? '';
  if (toolName === 'Edit') return replaceOnce(before, ti.old_string, ti.new_string ?? '', ti.replace_all);
  if (toolName === 'MultiEdit') return (ti.edits || []).reduce((s, e) => replaceOnce(s, e.old_string, e.new_string ?? '', e.replace_all), before);
  return null;
}

let dir = process.cwd();
try {
  const input = await readStdinJson();
  dir = projectDir(input);
  const cfg = loadConfig(dir);
  try { ensureBaseline(dir, input.session_id, cfg.stopGate.ignore); } catch (e) { logHookError(dir, 'invariant-guard:baseline', e); }
  const ti = input.tool_input || {};
  const file = ti.file_path || ti.notebook_path;
  if (file && cfg.invariants.length) {
    const rel = relPath(dir, file);
    const applicable = cfg.invariants.filter((inv) => matchesAny(rel, inv.files || []));
    if (applicable.length) {
      const abs = path.isAbsolute(file) ? file : path.join(dir, file);
      const exists = fs.existsSync(abs);
      const before = exists ? fs.readFileSync(abs, 'utf8') : '';
      const after = simulate(input.tool_name, ti, before);
      if (after !== null) {
        const broken = [];
        for (const inv of applicable) {
          for (const marker of inv.mustContain || []) {
            const required = exists ? before.includes(marker) : !!inv.requireOnCreate;
            if (required && !after.includes(marker)) broken.push({ inv, marker });
          }
        }
        if (broken.length) {
          const lines = broken.map(({ inv, marker }) => `"${marker}" (${inv.id}${inv.reason ? ': ' + inv.reason : ''})`);
          emit({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny',
            permissionDecisionReason: `[standard:invariant] ${rel} must keep ${lines.join('; ')}. Keep the marker in this edit. If the invariant itself must change, stop and ask the user.` } });
        }
      }
    }
  }
} catch (e) {
  // Never fail open silently: if the invariants cannot be checked, the user decides.
  logHookError(dir, 'invariant-guard', e);
  emit({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'ask',
    permissionDecisionReason: `[standard:invariant-guard-error] The invariant check failed (${errorText(e)}), so this edit was not checked. Approve only if it keeps the pinned markers; see .claude/state/hook-errors.log.` } });
}
process.exit(0);
