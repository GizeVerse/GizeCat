#!/usr/bin/env node
// Puts @koromix/koffi-win32-<arch> (koffi's prebuilt binary for one Windows architecture) into
// node_modules, so electron-builder can package that architecture on a build host of another one.
// `npm ci` installs only the host's own platform package (os/cpu of the optional dependency), and
// `npm ci --cpu=arm64` would remove the host's x64 binaries (esbuild, rolldown, lightningcss, koffi).
//
//   node scripts/with-lock.mjs stage-koffi -- node scripts/stage-koffi-arch.mjs --arch arm64
//
// What it does, and never more:
// 1. reads the version and integrity of node_modules/@koromix/koffi-win32-<arch> from
//    package-lock.json (it must equal the locked koffi version);
// 2. exits when that version is already in node_modules with a koffi.node of the right PE machine;
// 3. otherwise downloads the tarball with `npm pack <name>@<version>` into a fresh temporary
//    folder, refuses it unless its sha512 equals the lockfile integrity, extracts it with tar into a
//    staging folder next to the target, checks name, version and PE machine, then swaps it in;
// 4. fails if package.json or package-lock.json changed (it never writes either).
// No install script runs. `npm ci` removes the staged package again; stage after every `npm ci`.
// Manual equivalent: npm install --no-save --force --ignore-scripts --no-audit --no-fund
// @koromix/koffi-win32-arm64@<locked version>, then git diff --exit-code -- package.json package-lock.json.
import { execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { ARCHES, machineName, peMachineOfFile } from './check-win-payload.mjs';

export function parseArgs(argv) {
  let arch = null;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--arch') arch = argv[++i] ?? null;
    else throw new Error(`unknown argument ${argv[i]}`);
  }
  if (!arch || !Object.hasOwn(ARCHES, arch)) throw new Error(`--arch must be one of ${Object.keys(ARCHES).join(', ')}`);
  return { arch };
}

/** The locked platform package: { name, version, integrity, resolved }. Throws when it does not fit. */
export function lockedPlatformPackage(lock, arch) {
  const spec = ARCHES[arch];
  if (!spec) throw new Error(`unknown arch ${arch}`);
  const name = `@koromix/${spec.koffiPackage}`;
  const entry = lock?.packages?.[`node_modules/${name}`];
  const koffi = lock?.packages?.['node_modules/koffi'];
  if (!entry) throw new Error(`package-lock.json has no node_modules/${name}`);
  if (!koffi) throw new Error('package-lock.json has no node_modules/koffi');
  if (entry.version !== koffi.version) throw new Error(`${name} ${entry.version} is locked, but koffi is ${koffi.version}`);
  if (!/^\d+\.\d+\.\d+$/.test(String(entry.version))) throw new Error(`unexpected locked version ${entry.version}`);
  if (!/^sha512-[A-Za-z0-9+/]+={0,2}$/.test(String(entry.integrity))) throw new Error(`${name} has no sha512 integrity in package-lock.json`);
  return { name, version: entry.version, integrity: entry.integrity, resolved: entry.resolved ?? null };
}

/** Subresource-integrity string (as npm writes it) of some bytes. */
export function sriOf(bytes, alg = 'sha512') {
  return `${alg}-${crypto.createHash(alg).update(bytes).digest('base64')}`;
}

/** 'ok' when `dir` holds `pkg` with a koffi.node of the right machine, otherwise the reason. */
export function inspectPackageDir(dir, pkg, arch, machineOf = peMachineOfFile) {
  const spec = ARCHES[arch];
  const manifest = path.join(dir, 'package.json');
  if (!fs.existsSync(manifest)) return 'missing';
  let meta;
  try {
    meta = JSON.parse(fs.readFileSync(manifest, 'utf8'));
  } catch {
    return 'unreadable package.json';
  }
  if (meta.name !== pkg.name) return `package.json names ${meta.name}`;
  if (meta.version !== pkg.version) return `version ${meta.version}, locked ${pkg.version}`;
  const binary = path.join(dir, spec.koffiDir, 'koffi.node');
  if (!fs.existsSync(binary)) return `${spec.koffiDir}/koffi.node missing`;
  let machine;
  try {
    machine = machineOf(binary);
  } catch (e) {
    return `koffi.node unreadable: ${e instanceof Error ? e.message : String(e)}`;
  }
  return machine === spec.machine ? 'ok' : `koffi.node is ${machineName(machine)}, expected ${arch}`;
}

/** Where npm's own CLI script is, so it runs under this node without a shell (.cmd shims need one). */
export function npmCliCandidates(env, execPath) {
  const list = [];
  if (env.npm_execpath && /npm-cli\.c?js$/i.test(env.npm_execpath)) list.push(env.npm_execpath);
  const dir = path.dirname(execPath);
  list.push(path.join(dir, 'node_modules', 'npm', 'bin', 'npm-cli.js'));
  list.push(path.join(dir, '..', 'lib', 'node_modules', 'npm', 'bin', 'npm-cli.js'));
  return list;
}

function runNpm(args, cwd) {
  const cli = npmCliCandidates(process.env, process.execPath).find((p) => fs.existsSync(p));
  const opts = { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'], maxBuffer: 16 * 1024 * 1024, windowsHide: true };
  if (cli) return execFileSync(process.execPath, [cli, ...args], opts);
  if (process.platform === 'win32') throw new Error('npm-cli.js not found next to node; stage by hand (see the header of this script)');
  return execFileSync('npm', args, opts);
}

function tarCommand() {
  // Git for Windows' GNU tar reads "C:\..." as a remote host; Windows' own bsdtar does not.
  if (process.platform === 'win32') return path.join(process.env.SystemRoot || process.env.windir || 'C:\\Windows', 'System32', 'tar.exe');
  return 'tar';
}

function fileSha256(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

function main(argv) {
  const { arch } = parseArgs(argv);
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const guarded = ['package.json', 'package-lock.json'].map((f) => path.join(root, f));
  const before = guarded.map(fileSha256);
  const lock = JSON.parse(fs.readFileSync(path.join(root, 'package-lock.json'), 'utf8'));
  const pkg = lockedPlatformPackage(lock, arch);
  const scope = path.join(root, 'node_modules', '@koromix');
  const target = path.join(scope, ARCHES[arch].koffiPackage);
  const binary = path.join(target, ARCHES[arch].koffiDir, 'koffi.node');
  const report = { package: pkg.name, version: pkg.version, integrity: pkg.integrity, target: path.relative(root, target).split(path.sep).join('/') };

  const state = inspectPackageDir(target, pkg, arch);
  if (state === 'ok') {
    report.status = 'already-staged';
  } else {
    report.previous = state;
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dcat-koffi-'));
    const suffix = crypto.randomBytes(4).toString('hex');
    const staging = path.join(scope, `.${ARCHES[arch].koffiPackage}.staging-${suffix}`);
    const old = path.join(scope, `.${ARCHES[arch].koffiPackage}.old-${suffix}`);
    try {
      const out = runNpm(['pack', `${pkg.name}@${pkg.version}`, '--pack-destination', tmp, '--json', '--ignore-scripts', '--no-audit', '--no-fund'], root);
      let packed = null;
      try {
        packed = JSON.parse(out);
      } catch {
        /* npm printed something else; fall back to the folder listing */
      }
      const reported = Array.isArray(packed) ? packed[0] : null;
      const tgzName = reported && reported.filename ? path.basename(reported.filename) : fs.readdirSync(tmp).find((f) => f.endsWith('.tgz'));
      if (!tgzName) throw new Error('npm pack produced no tarball');
      const tgz = path.join(tmp, tgzName);
      const integrity = sriOf(fs.readFileSync(tgz));
      if (integrity !== pkg.integrity) throw new Error(`tarball integrity ${integrity} does not match package-lock.json ${pkg.integrity}`);
      if (reported && reported.integrity && reported.integrity !== pkg.integrity) throw new Error(`npm reported integrity ${reported.integrity}, package-lock.json has ${pkg.integrity}`);
      fs.mkdirSync(staging, { recursive: true });
      execFileSync(tarCommand(), ['-xzf', tgz, '-C', staging, '--strip-components=1'], { stdio: ['ignore', 'inherit', 'inherit'], windowsHide: true });
      const staged = inspectPackageDir(staging, pkg, arch);
      if (staged !== 'ok') throw new Error(`extracted package rejected: ${staged}`);
      // Swap: a package that was there (wrong version or machine) comes back if the swap fails.
      const hadTarget = fs.existsSync(target);
      if (hadTarget) fs.renameSync(target, old);
      try {
        fs.renameSync(staging, target);
      } catch (e) {
        if (hadTarget) fs.renameSync(old, target);
        throw e;
      }
      report.status = 'staged';
      report.tarballIntegrity = integrity;
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
      fs.rmSync(staging, { recursive: true, force: true });
      fs.rmSync(old, { recursive: true, force: true });
    }
  }

  const machine = peMachineOfFile(binary);
  report.koffiNode = { path: path.relative(root, binary).split(path.sep).join('/'), machine: machineName(machine), bytes: fs.statSync(binary).size, sha256: fileSha256(binary) };
  const after = guarded.map(fileSha256);
  report.lockfilesUnchanged = after.every((h, i) => h === before[i]);
  console.log(JSON.stringify(report, null, 2));
  if (!report.lockfilesUnchanged) throw new Error('package.json or package-lock.json changed while staging');
  if (machine !== ARCHES[arch].machine) throw new Error(`staged koffi.node is ${machineName(machine)}`);
  return 0;
}

const invoked = process.argv[1] ? pathToFileURL(path.resolve(process.argv[1])).href : '';
if (invoked.toLowerCase() === import.meta.url.toLowerCase()) {
  try {
    process.exitCode = main(process.argv.slice(2));
  } catch (e) {
    console.error(`stage-koffi-arch: ${e instanceof Error ? e.message : String(e)}`);
    process.exitCode = 1;
  }
}
