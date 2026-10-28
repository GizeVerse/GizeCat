// Shared helpers for the engineering-standard hooks and scripts.
// Zero dependencies: runs on the Node that ships with local dev machines and cloud sessions.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const STANDARD_VERSION = '1.1.0';
const here = path.dirname(fileURLToPath(import.meta.url));

export async function readStdinJson() {
  const chunks = [];
  for await (const c of process.stdin) chunks.push(c);
  const raw = Buffer.concat(chunks).toString('utf8').trim();
  return raw ? JSON.parse(raw) : {};
}

// The repo a hook acts on. A vendored hook (<root>/.claude/hooks) belongs to the repo it lives in;
// CLAUDE_PROJECT_DIR alone is not trusted, because it keeps the launch directory when a session
// moves into a worktree mid-session. The user-level copy follows the session's working tree.
export function projectDir(input = {}) {
  const vendored = path.resolve(here, '..', '..');
  if (fs.existsSync(path.join(vendored, '.claude', 'standard.json'))) return vendored;
  const cwd = input.cwd || process.cwd();
  const top = git(cwd, ['rev-parse', '--show-toplevel']);
  return top ? path.resolve(top) : path.resolve(process.env.CLAUDE_PROJECT_DIR || cwd);
}

export function stateDir(dir) {
  const d = path.join(dir, '.claude', 'state');
  fs.mkdirSync(d, { recursive: true });
  return d;
}

// A missing file is "no config"; a malformed one is an error, never silently an empty config.
function readJson(file) {
  let text;
  try { text = fs.readFileSync(file, 'utf8'); } catch { return null; }
  try { return JSON.parse(text); } catch (e) { throw new Error(`${file} is not valid JSON (${e.message})`); }
}

// Repo config (.claude/standard.json) plus optional machine-local config
// (~/.claude/standard.user.json, absent in cloud sessions). Only guard rules merge from the user layer.
export function loadConfig(dir) {
  const repo = readJson(path.join(dir, '.claude', 'standard.json')) || {};
  const userFile = process.env.CLAUDE_STANDARD_USER_CONFIG || path.join(os.homedir(), '.claude', 'standard.user.json');
  const user = readJson(userFile) || {};
  const guard = repo.guard || {};
  return {
    ...repo,
    machine: user.machine || {},
    guard: {
      ...guard,
      rules: [...(guard.rules || []), ...((user.guard && user.guard.rules) || [])],
      protectedPaths: [...(guard.protectedPaths || []), ...((user.guard && user.guard.protectedPaths) || [])],
    },
    invariants: repo.invariants || [],
    verify: repo.verify || {},
    stopGate: { enabled: true, ignore: [], ...(repo.stopGate || {}) },
  };
}

export function git(dir, args, opts = {}) {
  try {
    return execFileSync('git', args, {
      cwd: dir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'],
      env: { ...process.env, ...(opts.env || {}) }, timeout: opts.timeout || 20000, maxBuffer: 64 * 1024 * 1024,
    }).trim();
  } catch {
    return null;
  }
}

export function toPosix(p) { return p.replace(/\\/g, '/'); }

export function relPath(dir, file) {
  if (!file) return '';
  const abs = path.isAbsolute(file) ? file : path.join(dir, file);
  return toPosix(path.relative(dir, abs));
}

// gitignore-flavoured glob: a pattern without '/' matches the basename anywhere.
export function globToRegExp(glob) {
  let re = '';
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === '*') {
      if (glob[i + 1] === '*') {
        i++;
        if (glob[i + 1] === '/') { i++; re += '(?:.*/)?'; } else re += '.*';
      } else re += '[^/]*';
    } else if (c === '?') re += '[^/]';
    else if ('\\^$+.()|{}[]'.includes(c)) re += '\\' + c;
    else re += c;
  }
  return new RegExp('^' + re + '$', process.platform === 'win32' ? 'i' : '');
}

export function matchesAny(rel, globs = []) {
  const base = rel.split('/').pop();
  return globs.some((g) => globToRegExp(g).test(g.includes('/') ? rel : base));
}

// Hash of the working-tree content (tracked + untracked, honouring .gitignore), independent of
// commits: the same files give the same id before and after `git commit`. Uses a throwaway index
// so the real index is never touched.
export function contentIdentity(dir, ignore = []) {
  const realIndex = git(dir, ['rev-parse', '--git-path', 'index']);
  if (realIndex === null) return null;
  const tmpIndex = path.join(os.tmpdir(), `cstd-index-${process.pid}-${Math.floor(Math.random() * 1e9)}`);
  try {
    const src = path.resolve(dir, realIndex);
    if (fs.existsSync(src)) fs.copyFileSync(src, tmpIndex);
    const env = { GIT_INDEX_FILE: tmpIndex };
    if (git(dir, ['add', '-A', '--', '.'], { env, timeout: 60000 }) === null) return null;
    // Drop ignored globs afterwards: `add` with an exclude pathspec naming a gitignored path fails.
    const drop = ['.claude/state/**', '.claude/handoff.md', ...ignore].map((g) => `:(glob)${g.includes('/') ? g : '**/' + g}`);
    if (git(dir, ['rm', '--cached', '-r', '-q', '--ignore-unmatch', '--', ...drop], { env, timeout: 60000 }) === null) return null;
    return git(dir, ['write-tree'], { env });
  } finally {
    fs.rmSync(tmpIndex, { force: true });
  }
}

// Per-session baseline of the tree, for the stop gate's "changed in this session" test. SessionStart
// records it; the PreToolUse hooks record it lazily before the first mutating tool call, which covers
// sessions that entered this repo (e.g. a worktree) after they started.
export function sessionFile(dir, sessionId) {
  return path.join(stateDir(dir), 'sessions', `${String(sessionId).replace(/[^\w.-]/g, '_')}.json`);
}

export function ensureBaseline(dir, sessionId, ignore = [], identity) {
  if (!sessionId) return;
  const f = sessionFile(dir, sessionId);
  if (fs.existsSync(f)) return;
  fs.mkdirSync(path.dirname(f), { recursive: true });
  const baseline = identity === undefined ? contentIdentity(dir, ignore) : identity;
  fs.writeFileSync(f, JSON.stringify({ baseline, at: new Date().toISOString() }));
}

export function errorText(e) { return String((e && e.message) || e).split('\n')[0].slice(0, 300); }

export function logHookError(dir, hook, err) {
  try {
    fs.appendFileSync(path.join(stateDir(dir), 'hook-errors.log'), `${new Date().toISOString()} ${hook}: ${err && err.stack || err}\n`);
  } catch { /* never let logging break a hook */ }
}

export function emit(obj) { process.stdout.write(JSON.stringify(obj)); }

export function ago(ms) {
  const s = Math.round(ms / 1000);
  if (s < 90) return `${s}s ago`;
  if (s < 5400) return `${Math.round(s / 60)}m ago`;
  if (s < 172800) return `${Math.round(s / 3600)}h ago`;
  return `${Math.round(s / 86400)}d ago`;
}
