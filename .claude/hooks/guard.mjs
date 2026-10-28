#!/usr/bin/env node
// PreToolUse guard for Bash/PowerShell: denies irreversible shared-state actions, asks before
// destructive local or outward-facing ones. A safety net against accidents, not a sandbox.
import fs from 'node:fs';
import path from 'node:path';
import { readStdinJson, projectDir, loadConfig, git, matchesAny, logHookError, emit, ensureBaseline, errorText } from './lib.mjs';

const SEP = '[^;&|\\n]*';
const DEFAULT_RULES = [
  { id: 'force-push', decision: 'deny', pattern: `\\bgit\\b${SEP}\\bpush\\b${SEP}(\\s--force(-with-lease)?\\b|\\s-[a-zA-Z]*f\\b|\\s\\+[\\w/.-]+)`,
    reason: 'Force-push rewrites shared history; the standard forbids it. Push a new commit instead, or ask the user to force-push themselves.' },
  { id: 'push-protected', decision: 'ask', pattern: `\\bgit\\b${SEP}\\bpush\\b${SEP}\\s([\\w/.-]+:)?(refs/heads/)?(main|master)(\\s|$)`,
    reason: 'Pushing to main/master needs the user\'s approval (it may deploy). Prefer a feature branch and a PR.' },
  { id: 'no-verify', decision: 'deny', pattern: `\\bgit\\b${SEP}\\s--no-verify\\b`,
    reason: 'Skipping git hooks (--no-verify) is not allowed. Fix the failing hook instead.' },
  { id: 'gh-repo-delete', decision: 'deny', pattern: '\\bgh\\s+repo\\s+delete\\b', reason: 'Deleting a GitHub repository is irreversible.' },
  { id: 'reset-hard', decision: 'ask', pattern: '\\bgit\\b[^;&|\\n]*\\breset\\b[^;&|\\n]*\\s--hard\\b', reason: 'git reset --hard discards uncommitted work.' },
  { id: 'git-clean', decision: 'ask', pattern: '\\bgit\\s+clean\\b[^;&|\\n]*\\s-[a-zA-Z]*f', reason: 'git clean -f deletes untracked files.' },
  { id: 'discard-all', decision: 'ask', pattern: '\\bgit\\s+(checkout|restore)\\b(?![^;&|\\n]*--staged)[^;&|\\n]*\\s(--\\s+)?\\.(\\s|$)', reason: 'This discards all unstaged changes.' },
  { id: 'stash-drop', decision: 'ask', pattern: '\\bgit\\s+stash\\s+(drop|clear)\\b', reason: 'Dropping stashes loses work.' },
  { id: 'branch-force-delete', decision: 'ask', pattern: '\\bgit\\s+branch\\b[^;&|\\n]*\\s(-D|--delete\\s+--force|-d\\s+-f)\\b', reason: 'Force-deleting a branch can lose unmerged commits.' },
  { id: 'worktree-force-remove', decision: 'ask', pattern: '\\bgit\\s+worktree\\s+remove\\b[^;&|\\n]*\\s(--force|-f)\\b', reason: 'Force-removing a worktree discards its uncommitted changes.' },
  { id: 'history-rewrite', decision: 'ask', pattern: '\\bgit\\s+(filter-branch|filter-repo|rebase\\b[^;&|\\n]*\\s(-i|--interactive)\\b)', reason: 'History rewrites need the user.' },
  { id: 'remote-branch-delete', decision: 'ask', pattern: `\\bgit\\b${SEP}\\bpush\\b${SEP}(\\s--delete\\b|\\s-d\\b|\\s:[\\w/.-]+)`, reason: 'Deleting a remote branch is outward-facing.' },
  { id: 'pr-merge', decision: 'ask', pattern: '\\bgh\\s+pr\\s+merge\\b', reason: 'Merging is the user\'s decision.' },
  { id: 'publish', decision: 'ask', pattern: '\\b(npm|pnpm|yarn)\\s+publish\\b|\\bgh\\s+release\\s+create\\b|\\btwine\\s+upload\\b|\\bflutter\\s+pub\\s+publish\\b|\\bdart\\s+pub\\s+publish\\b', reason: 'Publishing is outward-facing and hard to undo.' },
  { id: 'pipe-to-shell', decision: 'ask', pattern: '\\b(curl|wget|iwr|Invoke-WebRequest|irm|Invoke-RestMethod)\\b[^\\n]*\\|\\s*(sudo\\s+)?((ba|z)?sh|iex|Invoke-Expression|python3?|node)\\b', reason: 'Piping a download into an interpreter runs unreviewed code.' },
  { id: 'secret-read', decision: 'ask',
    pattern: '\\b(cat|type|less|more|head|tail|Get-Content|gc|bat|xxd|od|base64|strings|grep|rg|findstr|Select-String|sed|awk|Copy-Item|cp|scp|curl)\\b[^|;&\\n]*(\\.env(?!\\.(example|sample|template|dist)\\b)(\\.[\\w-]+)?\\b|\\.pem\\b|\\.p12\\b|\\.pfx\\b|\\.jks\\b|\\.keystore\\b|\\bid_(rsa|ed25519|ecdsa)\\b|credentials\\.json|\\.credentials\\b|service[-_]account[\\w-]*\\.json|key\\.properties|\\.netrc\\b|\\.npmrc\\b|\\.pypirc\\b)',
    reason: 'This would print a secret file into the transcript. Read only the variable names you need, or ask the user.' },
  { id: 'env-dump', decision: 'ask', pattern: '(^|[;&|(]\\s*)(printenv|env|set)\\s*($|[|>;&)])|\\b(Get-ChildItem|gci|ls|dir)\\s+env:', reason: 'Dumping the environment can expose tokens. Print only the variables you need.' },
];

const SAFE_DELETE = /(^|[\\/])(node_modules|dist|build|out|coverage|\.cache|\.turbo|\.next|\.nuxt|\.parcel-cache|tmp|temp|__pycache__|\.pytest_cache|\.mypy_cache|\.ruff_cache|\.tox|target|\.dart_tool|\.gradle|\.claude[\\/]state)([\\/]\*?)?$/i;
const CATASTROPHIC = /^(\/|~\/?|\$HOME\/?|\$env:USERPROFILE\\?|%USERPROFILE%|\*|\.|\.\.|\.\/|\.\.\/|[a-zA-Z]:[\\/]?|\/[a-zA-Z]\/?)$/;

// Remove heredoc bodies and quoted strings so commit messages and docs don't trip the rules.
function stripLiterals(cmd) {
  let s = cmd.replace(/<<-?\s*(['"]?)(\w+)\1[\s\S]*?\n\s*\2\s*(\n|$)/g, ' ');
  s = s.replace(/@'[\s\S]*?'@|@"[\s\S]*?"@/g, ' ');
  s = s.replace(/"(?:\\.|[^"\\])*"|'[^']*'/g, '""');
  return s;
}

function deletionTargets(cmd) {
  const out = [];
  const segs = cmd.split(/[;&|\n]+/);
  for (const seg of segs) {
    const t = seg.trim().split(/\s+/);
    const i = t.findIndex((w) => /^(rm|rmdir|rd|Remove-Item|ri|del)$/i.test(w));
    if (i < 0) continue;
    const args = t.slice(i + 1);
    const flags = args.filter((a) => /^-/.test(a) || /^\/[sq]$/i.test(a)).join(' ');
    const recursive = /(^|\s)-[a-zA-Z]*r|--recursive|-Recurse|\/s\b/i.test(flags) || /^(rmdir|rd)$/i.test(t[i]);
    if (!recursive) continue;
    const targets = args.filter((a) => !/^-/.test(a) && !/^\/[sq]$/i.test(a) && !/^-(Force|Recurse|Path|LiteralPath)$/i.test(a)).map((a) => a.replace(/^["']|["']$/g, ''));
    out.push(...targets);
  }
  return out;
}

function decide(input, cfg, dir) {
  const raw = String((input.tool_input && input.tool_input.command) || '');
  if (!raw) return null;
  const stripped = stripLiterals(raw);
  // Nested shells hide the real command inside quotes: check the raw text for those too.
  const nested = /\b(bash|sh|zsh|pwsh|powershell)(\.exe)?\s+(-c|-Command)\b|\beval\b|Invoke-Expression|\biex\b/i.test(raw);
  const texts = nested ? [stripped, raw] : [stripped];

  const rules = [...DEFAULT_RULES, ...(cfg.guard.rules || [])].filter((r) => !(cfg.guard.disable || []).includes(r.id));
  const hits = [];
  for (const r of rules) {
    const re = new RegExp(r.pattern, r.flags || 'i');
    if (texts.some((t) => re.test(t))) hits.push(r);
  }

  // `git push` / `git push origin` / `git push origin HEAD` while on main/master pushes the protected branch.
  for (const m of stripped.matchAll(/\bgit\b[^;&|\n]*?\bpush\b([^;&|\n]*)/gi)) {
    const refspecs = m[1].trim().split(/\s+/).filter((a) => a && !a.startsWith('-')).slice(1);
    if (refspecs.length && !refspecs.some((r) => /^(HEAD|@)(:|$)/.test(r))) continue;
    const branch = git(dir, ['branch', '--show-current']);
    if (branch && /^(main|master)$/.test(branch)) hits.push({ id: 'push-protected', decision: 'ask', reason: `Current branch is ${branch}; pushing it needs the user's approval (it may deploy). Prefer a feature branch and a PR.` });
  }

  for (const target of deletionTargets(stripped)) {
    if (CATASTROPHIC.test(target)) hits.push({ id: 'rm-catastrophic', decision: 'deny', reason: `Refusing recursive delete of "${target}".` });
    else if (!SAFE_DELETE.test(target.replace(/[\\/]+$/, '')) && !(process.env.CLAUDE_JOB_DIR && target.startsWith(process.env.CLAUDE_JOB_DIR)))
      hits.push({ id: 'rm-recursive', decision: 'ask', reason: `Recursive delete of "${target}" (not a build/cache/temp directory).` });
  }

  const prot = cfg.guard.protectedPaths || [];
  if (prot.length && /\b(rm|del|Remove-Item|mv|move|Move-Item|git\s+rm|git\s+mv)\b/i.test(stripped)) {
    const words = stripped.split(/\s+/).map((w) => w.replace(/^["']|["']$/g, '').replace(/\\/g, '/').replace(/^\.\//, ''));
    const p = words.find((w) => w && matchesAny(w, prot));
    if (p) hits.push({ id: 'protected-path', decision: 'ask', reason: `"${p}" is a protected path in .claude/standard.json.` });
  }

  if (!hits.length) return null;
  const deny = hits.find((h) => h.decision === 'deny');
  const chosen = deny || hits[0];
  return { decision: chosen.decision, reason: `[standard:${chosen.id}] ${chosen.reason}` };
}

const fallback = process.argv.includes('--fallback');
let dir = process.cwd();
try {
  const input = await readStdinJson();
  dir = projectDir(input);
  // --fallback: the user-level copy steps aside in repos that ship their own guard.
  if (fallback && fs.existsSync(path.join(dir, '.claude', 'hooks', 'guard.mjs'))) process.exit(0);
  const cfg = loadConfig(dir);
  const d = decide(input, cfg, dir);
  if (!fallback) {
    try { ensureBaseline(dir, input.session_id, cfg.stopGate.ignore); } catch (e) { logHookError(dir, 'guard:baseline', e); }
  }
  if (d) emit({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: d.decision, permissionDecisionReason: d.reason } });
} catch (e) {
  // Never fail open silently: if the guard cannot judge a command, the user decides.
  logHookError(dir, 'guard', e);
  emit({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'ask',
    permissionDecisionReason: `[standard:guard-error] The command guard failed (${errorText(e)}), so this command was not checked. Approve only if it is safe; see .claude/state/hook-errors.log.` } });
}
process.exit(0);
