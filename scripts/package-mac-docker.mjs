#!/usr/bin/env node
// GizeCat 1.4.0: ad-hoc macOS test builds (x64 and arm64 zips) from a Linux container, on a host
// that has Docker but no Mac (ADR 0004 §11, decision D11). Run it under the machine lock:
//   npm run package:mac:adhoc-docker
//   (= node scripts/with-lock.mjs mac-docker -- node scripts/package-mac-docker.mjs)
//
// What it does:
// 1. Refuses unless every tracked file is committed: the build is made from HEAD (git archive), so
//    uncommitted edits would silently be left out of it. Untracked files never reach the archive.
// 2. Writes `git archive HEAD` and scripts/docker/mac-adhoc-build.sh into a fresh temp folder
//    outside the repo.
// 3. Runs ONE uniquely named container (gizecat-mac-adhoc-<epoch>) from node:24-bookworm-slim with
//    that folder mounted at /stage, removed when it exits (--rm, and `docker rm -f <that name>` if
//    it is still there afterwards). It never lists, stops, removes or prunes any other container
//    or image.
// 4. Copies the results (two *-adhoc.zip, SHA256SUMS.txt, README-adhoc.txt) to
//    release/<version>/mac/ and checks every zip against SHA256SUMS.txt.
// The zips are unsigned ad-hoc test builds, never a release, and a build is not a test: nothing
// here runs the app. DMG, universal and Developer ID signed/notarized artifacts come from
// .github/workflows/macos-packages.yml on a macOS runner.
//
// Usage: node scripts/package-mac-docker.mjs [--keep-stage]
import { spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const keepStage = process.argv.includes('--keep-stage');
const IMAGE = 'node:24-bookworm-slim';
const CONTAINER = `gizecat-mac-adhoc-${Date.now()}`;
/** The container installs packages, runs npm ci and downloads two Electron builds: allow plenty. */
const RUN_TIMEOUT_MS = 100 * 60 * 1000;

function fail(message) {
  console.error(`package-mac-docker: ${message}`);
  process.exit(1);
}

/** Runs a command without a shell (no Git Bash path conversion, no quoting issues). */
function run(cmd, args, opts = {}) {
  const r = spawnSync(cmd, args, { cwd: root, encoding: 'utf8', windowsHide: true, ...opts });
  if (r.error) return { ok: false, status: null, stdout: '', stderr: String(r.error.message ?? r.error) };
  return { ok: r.status === 0, status: r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
}

function sha256(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

// 1. A committed tree.
const dirty = run('git', ['status', '--porcelain', '--untracked-files=no']);
if (!dirty.ok) fail(`git status failed: ${dirty.stderr.trim()}`);
if (dirty.stdout.trim() !== '') fail(`commit or set aside the tracked changes first (the build is made from HEAD):\n${dirty.stdout}`);
const head = run('git', ['rev-parse', 'HEAD']);
if (!head.ok) fail(`git rev-parse failed: ${head.stderr.trim()}`);
const commit = head.stdout.trim();
const pkgAtHead = run('git', ['show', 'HEAD:package.json']);
if (!pkgAtHead.ok) fail(`could not read package.json at HEAD: ${pkgAtHead.stderr.trim()}`);
const version = JSON.parse(pkgAtHead.stdout).version;
if (typeof version !== 'string' || !/^\d+\.\d+\.\d+/.test(version)) fail(`unexpected version in package.json: ${String(version)}`);

const docker = run('docker', ['version', '--format', '{{.Server.Version}}']);
if (!docker.ok) fail(`Docker is not available (is Docker Desktop running?): ${docker.stderr.trim()}`);
console.log(`package-mac-docker: GizeCat ${version} at ${commit.slice(0, 12)}, Docker ${docker.stdout.trim()}`);

// 2. The stage, outside the repo.
const stage = fs.mkdtempSync(path.join(os.tmpdir(), 'gizecat-mac-'));
console.log(`package-mac-docker: stage ${stage}`);
const archive = run('git', ['archive', '--format=tar', '-o', path.join(stage, 'src.tar'), 'HEAD']);
if (!archive.ok) fail(`git archive failed: ${archive.stderr.trim()}`);
// LF only: bash refuses a script with CRLF line ends (.gitattributes already keeps it LF).
const script = fs.readFileSync(path.join(root, 'scripts', 'docker', 'mac-adhoc-build.sh'), 'utf8').replace(/\r\n/g, '\n');
fs.writeFileSync(path.join(stage, 'mac-adhoc-build.sh'), script, { mode: 0o755 });

// 3. One container, ours only.
function removeOwnContainer() {
  const exists = run('docker', ['container', 'inspect', '--format', '{{.Id}}', CONTAINER]);
  if (!exists.ok) return;
  console.log(`package-mac-docker: removing leftover container ${CONTAINER}`);
  run('docker', ['rm', '-f', CONTAINER]);
}

let status = 1;
try {
  console.log(`package-mac-docker: docker run ${CONTAINER} (${IMAGE}); this takes a while`);
  const r = spawnSync(
    'docker',
    [
      'run',
      '--rm',
      '--name',
      CONTAINER,
      '--platform',
      'linux/amd64',
      '-e',
      `GIZECAT_COMMIT=${commit}`,
      '--mount',
      `type=bind,source=${stage},target=/stage`,
      IMAGE,
      'bash',
      '/stage/mac-adhoc-build.sh',
    ],
    { cwd: root, stdio: 'inherit', windowsHide: true, timeout: RUN_TIMEOUT_MS },
  );
  if (r.error) console.error(`package-mac-docker: docker run failed: ${r.error.message}`);
  status = r.status ?? 1;
} finally {
  removeOwnContainer();
}
if (status !== 0) {
  console.error(`package-mac-docker: the container exited with ${status}; the stage is kept for inspection: ${stage}`);
  process.exit(status);
}

// 4. Results to release/<version>/mac/, checked against the container's checksums.
const outDir = path.join(stage, 'out');
const dest = path.join(root, 'release', version, 'mac');
fs.mkdirSync(dest, { recursive: true });
const files = fs.readdirSync(outDir).filter((f) => fs.statSync(path.join(outDir, f)).isFile());
for (const f of files) fs.copyFileSync(path.join(outDir, f), path.join(dest, f));
const sums = fs
  .readFileSync(path.join(dest, 'SHA256SUMS.txt'), 'utf8')
  .split(/\r?\n/)
  .filter(Boolean)
  .map((line) => line.trim().split(/\s+\*?/));
let mismatch = false;
for (const [hash, name] of sums) {
  const file = path.join(dest, name);
  const actual = fs.existsSync(file) ? sha256(file) : 'missing';
  const ok = actual === hash;
  if (!ok) mismatch = true;
  const size = fs.existsSync(file) ? fs.statSync(file).size : 0;
  console.log(`${ok ? 'ok ' : 'BAD'} ${name}  ${size} bytes  sha256 ${actual}`);
}
if (sums.length === 0) mismatch = true;
if (!keepStage) fs.rmSync(stage, { recursive: true, force: true });
if (mismatch) fail(`checksum mismatch or no zips in ${dest}`);
console.log(`package-mac-docker: unsigned ad-hoc test builds (not notarized) in ${dest}`);
