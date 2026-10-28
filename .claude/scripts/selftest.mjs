#!/usr/bin/env node
// Validates this repo's engineering-standard install and exercises every hook against fixtures in a
// throwaway git repo. Safe for CI: touches nothing outside os.tmpdir().
//
//   node .claude/scripts/selftest.mjs
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, '..', '..');
const claude = path.join(repo, '.claude');
let failures = 0;
const warnings = [];
const ok = (cond, msg) => { if (!cond) { failures++; console.log(`  FAIL ${msg}`); } return cond; };
const warn = (msg) => warnings.push(msg);
const readJson = (f) => JSON.parse(fs.readFileSync(f, 'utf8'));

function frontmatter(file) {
  const m = fs.readFileSync(file, 'utf8').match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!m) return null;
  const out = {};
  for (const line of m[1].split(/\r?\n/)) { const i = line.indexOf(':'); if (i > 0) out[line.slice(0, i).trim()] = line.slice(i + 1).trim(); }
  return out;
}

console.log('static checks');
let settings = {};
if (ok(fs.existsSync(path.join(claude, 'settings.json')), '.claude/settings.json exists')) {
  try { settings = readJson(path.join(claude, 'settings.json')); } catch (e) { ok(false, `.claude/settings.json parses: ${e.message}`); }
}
for (const [event, groups] of Object.entries(settings.hooks || {})) {
  for (const g of groups) for (const h of g.hooks || []) {
    const m = String(h.command || '').match(/\.claude\/hooks\/([\w.-]+)/);
    if (m) ok(fs.existsSync(path.join(claude, 'hooks', m[1])), `${event} hook file .claude/hooks/${m[1]} exists`);
  }
}
let std = {};
if (ok(fs.existsSync(path.join(claude, 'standard.json')), '.claude/standard.json exists')) {
  try { std = readJson(path.join(claude, 'standard.json')); } catch (e) { ok(false, `.claude/standard.json parses: ${e.message}`); }
}
for (const [tier, steps] of Object.entries(std.verify || {})) {
  ok(Array.isArray(steps) && steps.every((s) => s.name && s.cmd), `verify.${tier} is a list of {name, cmd}`);
}
if (!std.verify || !std.verify.fast) warn('no verify.fast tier: the stop gate has nothing to ask for');
for (const inv of std.invariants || []) ok(inv.id && Array.isArray(inv.files) && Array.isArray(inv.mustContain), `invariant ${inv.id || '?'} has id/files/mustContain`);
for (const r of ((std.guard || {}).rules || [])) { try { new RegExp(r.pattern, r.flags || 'i'); } catch (e) { ok(false, `guard rule ${r.id} regex compiles: ${e.message}`); } }
const skillsDir = path.join(claude, 'skills');
for (const d of fs.existsSync(skillsDir) ? fs.readdirSync(skillsDir) : []) {
  const f = path.join(skillsDir, d, 'SKILL.md');
  if (!fs.existsSync(f)) continue;
  const fm = frontmatter(f);
  ok(fm && fm.name === d, `skill ${d}: frontmatter name matches directory`);
  ok(fm && fm.description && fm.description.length <= 1024, `skill ${d}: description present and <= 1024 chars`);
}
const agentsDir = path.join(claude, 'agents');
for (const f of fs.existsSync(agentsDir) ? fs.readdirSync(agentsDir).filter((x) => x.endsWith('.md')) : []) {
  const fm = frontmatter(path.join(agentsDir, f));
  ok(fm && fm.name && fm.description, `agent ${f}: frontmatter name and description`);
}
const gi = fs.existsSync(path.join(repo, '.gitignore')) ? fs.readFileSync(path.join(repo, '.gitignore'), 'utf8') : '';
ok(/\.claude\/state/.test(gi), '.gitignore excludes .claude/state/');
ok(/\.claude\/handoff\.md/.test(gi), '.gitignore excludes .claude/handoff.md');
const cm = [path.join(repo, 'CLAUDE.md'), path.join(claude, 'CLAUDE.md')].find((f) => fs.existsSync(f));
if (ok(cm, 'CLAUDE.md or .claude/CLAUDE.md exists')) {
  const text = fs.readFileSync(cm, 'utf8');
  const lines = text.split('\n').length;
  console.log(`  info ${path.relative(repo, cm).replace(/\\/g, '/')} ${lines} lines, ~${Math.round(text.length / 4)} tokens always loaded`);
  if (lines > 200) warn(`CLAUDE.md is ${lines} lines; move procedures into skills or linked docs`);
}

console.log('behaviour checks (throwaway repo)');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cstd-selftest-'));
const g = (...a) => spawnSync('git', a, { cwd: tmp, encoding: 'utf8' });
try {
  g('init', '-q', '-b', 'feature/selftest');
  g('config', 'user.email', 'selftest@example.invalid'); g('config', 'user.name', 'selftest'); g('config', 'core.autocrlf', 'false');
  fs.cpSync(path.join(claude, 'hooks'), path.join(tmp, '.claude', 'hooks'), { recursive: true });
  fs.cpSync(path.join(claude, 'scripts'), path.join(tmp, '.claude', 'scripts'), { recursive: true });
  fs.writeFileSync(path.join(tmp, '.gitignore'), '.claude/state/\n.claude/handoff.md\n');
  fs.writeFileSync(path.join(tmp, '.claude', 'standard.json'), JSON.stringify({
    verify: { fast: [{ name: 'ok', cmd: 'node -e "process.exit(0)"' }, { name: 'needs-env', cmd: 'node -e "process.exit(0)"', requires: { env: ['CSTD_SELFTEST_UNSET_VAR'] } }],
      broken: [{ name: 'fails', cmd: 'node -e "console.log(\'boom\');process.exit(3)"' }] },
    invariants: [{ id: 'research-only', files: ['src/**/*.py'], mustContain: ['RESEARCH_ONLY'], reason: 'selftest' }],
    guard: { protectedPaths: ['src/core.py'] },
  }));
  fs.mkdirSync(path.join(tmp, 'src'));
  fs.writeFileSync(path.join(tmp, 'src', 'core.py'), 'STATUS = "RESEARCH_ONLY"\nvalue = 1\n');
  g('add', '-A'); g('commit', '-q', '-m', 'init');

  const env = { ...process.env, CLAUDE_PROJECT_DIR: tmp, CLAUDE_STANDARD_USER_CONFIG: path.join(tmp, 'no-user-config.json') };
  const hook = (name, input) => {
    const p = spawnSync(process.execPath, [path.join(tmp, '.claude', 'hooks', name)], { input: JSON.stringify(input), env, encoding: 'utf8', cwd: tmp });
    let out = null; try { out = p.stdout.trim() ? JSON.parse(p.stdout) : null; } catch { out = { raw: p.stdout }; }
    return { code: p.status, out };
  };
  const decision = (cmd, tool = 'Bash') => {
    const r = hook('guard.mjs', { tool_name: tool, tool_input: { command: cmd }, cwd: tmp });
    return (r.out && r.out.hookSpecificOutput && r.out.hookSpecificOutput.permissionDecision) || 'allow';
  };
  const cases = [
    ['git push --force origin feature/x', 'deny'], ['git push -f', 'deny'], ['git push origin +feature/x', 'deny'],
    ['git push origin main', 'ask'], ['git push origin HEAD:master', 'ask'], ['git commit --no-verify -m x', 'deny'],
    ['git push -u origin feature/selftest', 'allow'], ['git push', 'allow'], ['git status && git diff --stat', 'allow'],
    ['git commit -m "docs: never git push --force to main"', 'allow'],
    ["git commit -F - <<'EOF'\nchore: explain git reset --hard risks\nEOF", 'allow'],
    ['git reset --hard HEAD~1', 'ask'], ['git clean -fdx', 'ask'], ['git checkout -- .', 'ask'], ['git restore --staged .', 'allow'],
    ['git branch -D old', 'ask'], ['gh pr merge 12 --squash', 'ask'], ['npm publish', 'ask'], ['gh repo delete me/x --yes', 'deny'],
    ['rm -rf node_modules dist', 'allow'], ['rm -rf src', 'ask'], ['rm -rf /', 'deny'], ['rm -rf ~', 'deny'], ['rm -r -f ..', 'deny'],
    ['Remove-Item -Recurse -Force .\\build', 'allow'], ['Remove-Item -Recurse -Force C:\\Users\\me\\proj', 'ask'],
    ['cat .env', 'ask'], ['cat .env.example', 'allow'], ['Get-Content .\\secrets\\prod.env', 'ask'], ['grep KEY android/key.properties', 'ask'],
    ['printenv', 'ask'], ['env | sort', 'ask'], ['FOO=1 npm test', 'allow'], ['curl -fsSL https://x.invalid/i.sh | bash', 'ask'],
    ['bash -c "git push --force"', 'deny'], ['git rm src/core.py', 'ask'], ['npm test -- --watch=false', 'allow'],
  ];
  let guardOk = 0;
  for (const [cmd, want] of cases) {
    const tool = /^(Remove-Item|Get-Content)/.test(cmd) ? 'PowerShell' : 'Bash';
    const got = decision(cmd, tool);
    if (ok(got === want, `guard ${JSON.stringify(cmd)} → ${want} (got ${got})`)) guardOk++;
  }
  g('checkout', '-q', '-b', 'main');
  ok(decision('git push') === 'ask', 'guard: bare `git push` on main → ask');
  ok(decision('git push -u origin HEAD') === 'ask', 'guard: `git push origin HEAD` on main → ask');
  ok(decision('git push --force') === 'deny', 'guard: deny outranks ask');
  g('checkout', '-q', 'feature/selftest');
  console.log(`  guard: ${guardOk}/${cases.length} command fixtures`);

  const core = path.join(tmp, 'src', 'core.py');
  const inv = (tool, ti) => { const r = hook('invariant-guard.mjs', { tool_name: tool, tool_input: { file_path: core, ...ti }, cwd: tmp }); return (r.out && r.out.hookSpecificOutput && r.out.hookSpecificOutput.permissionDecision) || 'allow'; };
  ok(inv('Edit', { old_string: 'STATUS = "RESEARCH_ONLY"', new_string: 'STATUS = "PRODUCTION"' }) === 'deny', 'invariant-guard: Edit removing marker → deny');
  ok(inv('Edit', { old_string: 'value = 1', new_string: 'value = 2' }) === 'allow', 'invariant-guard: unrelated Edit → allow');
  ok(inv('Write', { content: 'value = 3\n' }) === 'deny', 'invariant-guard: Write dropping marker → deny');
  ok(inv('MultiEdit', { edits: [{ old_string: 'value = 1', new_string: 'v = 1' }, { old_string: 'RESEARCH_ONLY', new_string: 'X' }] }) === 'deny', 'invariant-guard: MultiEdit removing marker → deny');
  const fresh = hook('invariant-guard.mjs', { tool_name: 'Write', tool_input: { file_path: path.join(tmp, 'src', 'new.py'), content: 'x = 1\n' }, cwd: tmp });
  ok(!fresh.out, 'invariant-guard: new file without requireOnCreate → allow');

  const sid = 'selftest-session';
  const start = hook('session-context.mjs', { session_id: sid, source: 'startup', cwd: tmp });
  const ctx = start.out && start.out.hookSpecificOutput && start.out.hookSpecificOutput.additionalContext || '';
  ok(/branch feature\/selftest/.test(ctx) && /last verify: none/.test(ctx), 'session-context: reports branch and verify state');
  const stop = (extra = {}) => { const r = hook('stop-gate.mjs', { session_id: sid, stop_hook_active: false, cwd: tmp, transcript_path: path.join(tmp, 'none.jsonl'), ...extra }); return r.out && r.out.decision === 'block'; };
  ok(!stop(), 'stop-gate: no changes this session → allow');
  fs.appendFileSync(core, 'value2 = 2\n');
  ok(stop(), 'stop-gate: unverified change → block');
  ok(!stop({ stop_hook_active: true }), 'stop-gate: second stop (stop_hook_active) → allow');
  ok(!stop({ last_assistant_message: 'Tests not run here; parser change is UNVERIFIED.' }), 'stop-gate: explicit UNVERIFIED label → allow');
  const v = spawnSync(process.execPath, [path.join(tmp, '.claude', 'scripts', 'verify.mjs'), 'fast'], { cwd: tmp, env, encoding: 'utf8' });
  ok(v.status === 0 && /RESULT PARTIAL/.test(v.stdout) && /SKIP\s+needs-env/.test(v.stdout), 'verify: pass + skip → PARTIAL, exit 0');
  ok(!stop(), 'stop-gate: verified current tree → allow');
  g('add', '-A'); g('commit', '-q', '-m', 'change');
  ok(!stop(), 'stop-gate: same content after commit → still covered');
  fs.writeFileSync(path.join(tmp, 'README.md'), 'docs only\n');
  fs.appendFileSync(core, 'value3 = 3\n');
  ok(stop(), 'stop-gate: edit after verification → block');
  const b = spawnSync(process.execPath, [path.join(tmp, '.claude', 'scripts', 'verify.mjs'), 'broken'], { cwd: tmp, env, encoding: 'utf8' });
  ok(b.status === 1 && /FAIL\s+fails/.test(b.stdout) && /boom/.test(b.stdout), 'verify: failing step → exit 1 with log tail');
  ok(stop(), 'stop-gate: failed verification → block');
  // A verify started from another verify's step (this selftest inside `verify fast`) must not wait on the parent's lock.
  const held = path.join(tmp, 'held.lock');
  fs.writeFileSync(held, JSON.stringify({ pid: process.pid, dir: 'parent', tier: 'fast' }));
  const nested = spawnSync(process.execPath, [path.join(tmp, '.claude', 'scripts', 'verify.mjs'), 'fast'], { cwd: tmp, encoding: 'utf8', timeout: 60000,
    env: { ...env, CLAUDE_STANDARD_VERIFY_LOCKFILE: held, CLAUDE_STANDARD_VERIFY_LOCK: '1' } });
  ok(nested.status === 0 && !/waiting for another run/.test(nested.stdout), 'verify: nested run does not wait on its parent\'s lock');
  // These two runs must contend for the lock even when this selftest itself runs inside `verify`.
  const blocked = spawnSync(process.execPath, [path.join(tmp, '.claude', 'scripts', 'verify.mjs'), 'fast'], { cwd: tmp, encoding: 'utf8', timeout: 60000,
    env: { ...env, CLAUDE_STANDARD_VERIFY_LOCK: '', CLAUDE_STANDARD_VERIFY_LOCKFILE: held, CLAUDE_STANDARD_VERIFY_LOCK_WAIT_SEC: '2' } });
  ok(blocked.status === 3 && /waiting for another run/.test(blocked.stdout), 'verify: a held machine lock makes a second run wait, then give up');
  fs.writeFileSync(held, JSON.stringify({ pid: 2147483646, dir: 'gone', tier: 'fast' }));
  const reclaimed = spawnSync(process.execPath, [path.join(tmp, '.claude', 'scripts', 'verify.mjs'), 'fast'], { cwd: tmp, encoding: 'utf8', timeout: 60000,
    env: { ...env, CLAUDE_STANDARD_VERIFY_LOCK: '', CLAUDE_STANDARD_VERIFY_LOCKFILE: held, CLAUDE_STANDARD_VERIFY_LOCK_WAIT_SEC: '2' } });
  ok(reclaimed.status === 0, 'verify: a lock left by a dead process is reclaimed');

  // Sessions that never ran SessionStart here (they entered a worktree mid-session) still get a baseline.
  ok(!hook('stop-gate.mjs', { session_id: 'idle-session', stop_hook_active: false, cwd: tmp }).out, 'stop-gate: session with no mutating tool call → allow');
  hook('guard.mjs', { session_id: 'lazy-session', tool_name: 'Bash', tool_input: { command: 'echo hi' }, cwd: tmp });
  ok(fs.existsSync(path.join(tmp, '.claude', 'state', 'sessions', 'lazy-session.json')), 'guard: records a lazy baseline on the first call');
  fs.appendFileSync(core, 'value4 = 4\n');
  const lazyStop = hook('stop-gate.mjs', { session_id: 'lazy-session', stop_hook_active: false, cwd: tmp });
  ok(lazyStop.out && lazyStop.out.decision === 'block', 'stop-gate: change after a lazy baseline → block');

  // The real hook commands, run as Claude Code runs them: through bash, with ${CLAUDE_PROJECT_DIR}
  // pointing at a different directory (a session launched elsewhere that entered this repo).
  const tplFile = fs.existsSync(path.join(claude, 'settings.json')) ? path.join(claude, 'settings.json') : path.resolve(repo, '..', 'templates', 'settings.json');
  const hookCmds = {};
  for (const [event, groups] of Object.entries((readJson(tplFile).hooks) || {})) {
    for (const gr of groups) for (const h of gr.hooks || []) {
      const s = (String(h.command).match(/\.claude\/hooks\/([\w.-]+\.mjs)/) || [])[1];
      if (s) hookCmds[s] = { event, command: h.command };
    }
  }
  const bash = process.platform === 'win32'
    ? ['C:\\Program Files\\Git\\bin\\bash.exe', 'C:\\Program Files (x86)\\Git\\bin\\bash.exe'].find((p) => fs.existsSync(p))
    : 'bash';
  const viaShell = (script, input, cwd, projectDirValue, extraEnv = {}) => {
    const cmd = hookCmds[script].command.split('${CLAUDE_PROJECT_DIR}').join(projectDirValue);
    const p = spawnSync(bash, ['-c', cmd], { cwd, input: JSON.stringify(input), encoding: 'utf8', env: { ...env, ...extraEnv, CLAUDE_PROJECT_DIR: projectDirValue } });
    let out = null; try { out = p.stdout.trim() ? JSON.parse(p.stdout) : null; } catch { out = { raw: p.stdout }; }
    return { code: p.status, out, stdout: p.stdout, stderr: p.stderr };
  };
  const elsewhere = fs.mkdtempSync(path.join(os.tmpdir(), 'cstd-elsewhere-'));
  if (!bash || Object.keys(hookCmds).length < 4) {
    warn(`hook commands not exercised through a shell (${bash ? 'settings has no kit hooks' : 'no bash found'}): UNVERIFIED`);
  } else {
    const sub = path.join(tmp, 'src');
    const gv = viaShell('guard.mjs', { session_id: 'lazy-session', tool_name: 'Bash', tool_input: { command: 'git push --force origin x' }, cwd: sub }, sub, elsewhere);
    ok(gv.code === 0 && gv.out && gv.out.hookSpecificOutput && gv.out.hookSpecificOutput.permissionDecision === 'deny', `shell: guard command finds its script when CLAUDE_PROJECT_DIR is another dir (exit ${gv.code} ${gv.stderr.slice(0, 160)})`);
    const iv = viaShell('invariant-guard.mjs', { session_id: 'lazy-session', tool_name: 'Edit', tool_input: { file_path: core, old_string: 'RESEARCH_ONLY', new_string: 'X' }, cwd: sub }, sub, elsewhere);
    ok(iv.out && iv.out.hookSpecificOutput && iv.out.hookSpecificOutput.permissionDecision === 'deny', 'shell: invariant command finds its script when CLAUDE_PROJECT_DIR is another dir');
    const sv = viaShell('session-context.mjs', { session_id: 'shell-session', source: 'startup', cwd: sub }, sub, elsewhere);
    ok(sv.out && /\[standard\] session state/.test(sv.out.hookSpecificOutput.additionalContext), 'shell: session-context command finds its script when CLAUDE_PROJECT_DIR is another dir');
    const tv = viaShell('stop-gate.mjs', { session_id: 'lazy-session', stop_hook_active: false, cwd: sub }, sub, elsewhere);
    ok(tv.out && tv.out.decision === 'block', 'shell: stop-gate command finds its script and blocks the unverified change');
  }
  const errLog = path.join(tmp, '.claude', 'state', 'hook-errors.log');
  ok(!fs.existsSync(errLog), `no hook errors logged${fs.existsSync(errLog) ? ': ' + fs.readFileSync(errLog, 'utf8').slice(0, 400) : ''}`);

  if (bash && Object.keys(hookCmds).length >= 4) {
    // Missing scripts fail closed and loudly, never silently.
    const bare = fs.mkdtempSync(path.join(os.tmpdir(), 'cstd-bare-'));
    spawnSync('git', ['init', '-q'], { cwd: bare });
    const mg = viaShell('guard.mjs', { tool_name: 'Bash', tool_input: { command: 'ls' } }, bare, bare);
    ok(mg.code === 2 && /missing/.test(mg.stderr), 'missing guard script → exit 2 (blocks the call) with a reason');
    const mi = viaShell('invariant-guard.mjs', { tool_name: 'Edit', tool_input: { file_path: 'x' } }, bare, bare);
    ok(mi.code === 2 && /missing/.test(mi.stderr), 'missing invariant script → exit 2 (blocks the edit) with a reason');
    const ms = viaShell('stop-gate.mjs', { stop_hook_active: false }, bare, bare);
    ok(ms.code === 2 && /UNVERIFIED/.test(ms.stderr), 'missing stop-gate script → exit 2 once, telling Claude to label claims UNVERIFIED');
    const ms2 = viaShell('stop-gate.mjs', { stop_hook_active: true }, bare, bare);
    ok(ms2.code === 0, 'missing stop-gate script → lets the second stop through (no loop)');
    const mc = viaShell('session-context.mjs', { source: 'startup' }, bare, bare);
    ok(mc.code === 0 && /WARNING/.test(mc.stdout), 'missing session-context script → warning injected into context');
    fs.rmSync(bare, { recursive: true, force: true });
  }

  // A malformed config is an error the user sees, never a silently empty config.
  fs.writeFileSync(path.join(tmp, '.claude', 'standard.json'), '{ "verify": ');
  const bg = hook('guard.mjs', { session_id: 'lazy-session', tool_name: 'Bash', tool_input: { command: 'ls' }, cwd: tmp });
  ok(bg.out && bg.out.hookSpecificOutput.permissionDecision === 'ask' && /guard-error/.test(bg.out.hookSpecificOutput.permissionDecisionReason), 'broken config: guard asks instead of allowing silently');
  const bi = hook('invariant-guard.mjs', { session_id: 'lazy-session', tool_name: 'Edit', tool_input: { file_path: core, old_string: 'a', new_string: 'b' }, cwd: tmp });
  ok(bi.out && bi.out.hookSpecificOutput.permissionDecision === 'ask', 'broken config: invariant guard asks instead of allowing silently');
  const bs = hook('stop-gate.mjs', { session_id: 'lazy-session', stop_hook_active: false, cwd: tmp });
  ok(bs.out && bs.out.decision === 'block' && /stop-gate-error/.test(bs.out.reason) && /UNVERIFIED/.test(bs.out.reason), 'broken config: stop gate blocks once and asks for UNVERIFIED labels');
  ok(!hook('stop-gate.mjs', { session_id: 'lazy-session', stop_hook_active: true, cwd: tmp }).out, 'broken config: stop gate lets the second stop through');
  const bc = hook('session-context.mjs', { session_id: 'broken-session', source: 'startup', cwd: tmp });
  ok(bc.out && /WARNING/.test(bc.out.hookSpecificOutput.additionalContext), 'broken config: session-context warns Claude');
  ok(fs.existsSync(errLog), 'broken config: errors are written to hook-errors.log');
  fs.rmSync(elsewhere, { recursive: true, force: true });
} finally {
  fs.rmSync(tmp, { recursive: true, force: true });
}

for (const w of warnings) console.log(`  WARN ${w}`);
console.log(failures ? `SELFTEST FAIL (${failures} failure(s))` : 'SELFTEST PASS');
process.exit(failures ? 1 : 0);
