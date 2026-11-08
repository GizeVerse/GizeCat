#!/usr/bin/env node
// Builds the ad-hoc macOS zips (GizeCat-<version>-mac-<x64|arm64>-adhoc.zip) in a DISPOSABLE WSL 2
// distro on a Windows host, for when Docker is not available (scripts/package-mac-docker.mjs is the
// same build in a container). electron-builder refuses Mac targets on Windows but allows them on
// Linux; DMG and universal builds need a real Mac (.github/workflows/macos-packages.yml).
//
// It imports its own uniquely named distro from the official Ubuntu WSL root filesystem
// (sha256-checked against Ubuntu's SHA256SUMS), runs scripts/docker/mac-adhoc-build.sh there on a
// `git archive` of the committed HEAD, copies the results to release/<version>/mac/, and ALWAYS
// unregisters the distro afterwards. It never touches any other WSL distro or the Docker engine.
// Nothing built here is run: a build is not a test.
//
// Usage (under the machine lock on a shared PC):
//   node scripts/with-lock.mjs mac-wsl -- node scripts/package-mac-wsl.mjs [--allow-dirty] [--keep-stage]
// --allow-dirty builds HEAD even when the working tree has uncommitted changes (they are NOT included).
import { spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const allowDirty = process.argv.includes('--allow-dirty');
const keepStage = process.argv.includes('--keep-stage');

const ROOTFS_NAME = 'ubuntu-noble-wsl-amd64-wsl.rootfs.tar.gz';
const ROOTFS_BASE = 'https://cloud-images.ubuntu.com/wsl/releases/24.04/current';
const NODE_VERSION = 'v24.22.2';
const NODE_SHA256 = '48cc0e21e048790e54c0cf5749c2725005313d652651c40b7a21feb9697aaf75'; // nodejs.org SHASUMS256.txt, linux-x64.tar.xz
const BUILD_TIMEOUT_MS = 100 * 60 * 1000;

function fail(message) {
  console.error(`package-mac-wsl: ${message}`);
  process.exit(1);
}
function git(...args) {
  const r = spawnSync('git', args, { cwd: root, encoding: 'utf8', windowsHide: true });
  if (r.status !== 0) fail(`git ${args.join(' ')} failed: ${r.stderr}`);
  return r.stdout.trim();
}
function wsl(args, opts = {}) {
  return spawnSync('wsl.exe', args, { windowsHide: true, ...opts });
}
function toWslPath(p) {
  const m = /^([A-Za-z]):[\\/](.*)$/.exec(p);
  if (!m) fail(`not a drive path: ${p}`);
  return `/mnt/${m[1].toLowerCase()}/${m[2].replace(/\\/g, '/')}`;
}
function sha256File(file) {
  const h = crypto.createHash('sha256');
  const fd = fs.openSync(file, 'r');
  const buf = Buffer.alloc(4 * 1024 * 1024);
  for (;;) {
    const n = fs.readSync(fd, buf, 0, buf.length, null);
    if (n === 0) break;
    h.update(buf.subarray(0, n));
  }
  fs.closeSync(fd);
  return h.digest('hex');
}
async function download(url, dest) {
  const res = await fetch(url, { redirect: 'follow' });
  if (!res.ok || !res.body) fail(`download failed (${res.status}): ${url}`);
  await pipeline(Readable.fromWeb(res.body), fs.createWriteStream(dest));
}

if (process.platform !== 'win32') fail('this route is for a Windows host; on Linux run scripts/docker/mac-adhoc-build.sh in a container');
if (!allowDirty && git('status', '--porcelain') !== '') fail('the working tree has uncommitted changes (commit them, or pass --allow-dirty to build HEAD without them)');

const commit = git('rev-parse', '--short=12', 'HEAD');
const version = JSON.parse(git('show', 'HEAD:package.json')).version;
const name = `gizecat-mac-build-${Date.now()}`;
const stage = fs.mkdtempSync(path.join(os.tmpdir(), 'gizecat-mac-wsl-'));
const cacheDir = path.join(os.tmpdir(), 'gizecat-wsl-cache');
fs.mkdirSync(cacheDir, { recursive: true });
console.log(`package-mac-wsl: GizeCat ${version} at ${commit}; distro ${name}; stage ${stage}`);

// 1. The official root filesystem, checked against Ubuntu's published sums.
const sums = await (await fetch(`${ROOTFS_BASE}/SHA256SUMS`)).text();
const line = sums.split('\n').find((l) => l.endsWith(ROOTFS_NAME));
if (!line) fail(`${ROOTFS_NAME} is not listed in SHA256SUMS`);
const expected = line.split(/\s+/)[0];
const rootfs = path.join(cacheDir, ROOTFS_NAME);
if (!fs.existsSync(rootfs) || sha256File(rootfs) !== expected) {
  console.log('package-mac-wsl: downloading the Ubuntu WSL root filesystem');
  await download(`${ROOTFS_BASE}/${ROOTFS_NAME}`, rootfs);
  const got = sha256File(rootfs);
  if (got !== expected) fail(`root filesystem checksum mismatch: ${got}`);
}
console.log(`package-mac-wsl: root filesystem sha256 ${expected} (matches Ubuntu's SHA256SUMS)`);

// 2. Inputs: the committed source, the build script and a bootstrap for this distro.
const tar = spawnSync('git', ['archive', '--format=tar', '-o', path.join(stage, 'src.tar'), 'HEAD'], { cwd: root, windowsHide: true });
if (tar.status !== 0) fail('git archive failed');
fs.copyFileSync(path.join(root, 'scripts', 'docker', 'mac-adhoc-build.sh'), path.join(stage, 'mac-adhoc-build.sh'));
const winStage = toWslPath(stage);
const bootstrap = `#!/usr/bin/env bash
set -euo pipefail
export DEBIAN_FRONTEND=noninteractive
apt-get update -qq
apt-get install -y -qq --no-install-recommends ca-certificates curl xz-utils
cd /tmp
curl -fsSL --retry 3 -o node.tar.xz https://nodejs.org/dist/${NODE_VERSION}/node-${NODE_VERSION}-linux-x64.tar.xz
echo "${NODE_SHA256}  node.tar.xz" | sha256sum -c -
tar -xJf node.tar.xz -C /usr/local --strip-components=1
mkdir -p /stage
cp "${winStage}/src.tar" "${winStage}/mac-adhoc-build.sh" /stage/
chmod +x /stage/mac-adhoc-build.sh
GIZECAT_COMMIT="${commit}" GIZECAT_BUILD_ENV="a disposable WSL 2 distro (Ubuntu 24.04, Node ${NODE_VERSION})" bash /stage/mac-adhoc-build.sh
mkdir -p "${winStage}/out"
cp /stage/out/* "${winStage}/out/"
`;
fs.writeFileSync(path.join(stage, 'bootstrap.sh'), bootstrap, { mode: 0o755 });

// 3. One distro, ours only; always unregistered.
let status = 1;
const distroDir = path.join(stage, 'distro');
fs.mkdirSync(distroDir);
const imported = wsl(['--import', name, distroDir, rootfs, '--version', '2'], { stdio: 'inherit' });
if (imported.status !== 0) fail('wsl --import failed');
try {
  console.log(`package-mac-wsl: building in ${name}; this takes a while`);
  const r = wsl(['-d', name, '-u', 'root', '--cd', '/', '--', 'bash', `${winStage}/bootstrap.sh`], { stdio: 'inherit', timeout: BUILD_TIMEOUT_MS });
  if (r.error) console.error(`package-mac-wsl: wsl run failed: ${r.error.message}`);
  status = r.status ?? 1;
} finally {
  const un = wsl(['--unregister', name], { encoding: 'utf16le' });
  console.log(`package-mac-wsl: unregister ${name}: exit ${String(un.status)}`);
}
if (status !== 0) {
  console.error(`package-mac-wsl: the build exited with ${status}; the stage is kept for inspection: ${stage}`);
  process.exit(status);
}

// 4. Results to release/<version>/mac/, checked against the build's checksums.
const outDir = path.join(stage, 'out');
const dest = path.join(root, 'release', version, 'mac');
fs.mkdirSync(dest, { recursive: true });
const files = fs.readdirSync(outDir).filter((f) => fs.statSync(path.join(outDir, f)).isFile());
for (const f of files) fs.copyFileSync(path.join(outDir, f), path.join(dest, f));
for (const l of fs.readFileSync(path.join(dest, 'SHA256SUMS.txt'), 'utf8').split('\n').filter(Boolean)) {
  const [hash, file] = l.split(/\s+/);
  const got = sha256File(path.join(dest, file));
  if (got !== hash) fail(`${file}: checksum mismatch after the copy`);
  console.log(`package-mac-wsl: ${file} ${fs.statSync(path.join(dest, file)).size} bytes, sha256 ${hash}`);
}
if (!keepStage) fs.rmSync(stage, { recursive: true, force: true });
console.log(`package-mac-wsl: done -> release/${version}/mac/`);
