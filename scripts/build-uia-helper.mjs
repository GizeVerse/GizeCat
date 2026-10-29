#!/usr/bin/env node
// Compiles the UI Automation helper (native/uia-helper/*.cs) into out/native/DesktopCatUia.exe
// with the .NET Framework 4.x C# compiler that ships with Windows (C# 5, no SDK needed).
//
// Usage: node scripts/build-uia-helper.mjs [--out <dir>] [--strict]
//   --strict  exit 1 when csc.exe is missing (default: report and exit 0; tab strips are then
//             unavailable at run time and the rest of the app works).
//
// Idempotent: the output is rebuilt only when the sources, flags or compiler changed (a stamp
// file next to the exe records their hash). Fixed flag set; the legacy compiler has no
// /deterministic switch, so the PE timestamp differs between rebuilds.
import { execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const HELPER_EXE = 'DesktopCatUia.exe';
const SOURCE_DIR = path.join(root, 'native', 'uia-helper');

/** Framework directory holding csc.exe and the WPF UI Automation assemblies, or null. */
export function findFramework(env = process.env) {
  if (process.platform !== 'win32') return null;
  const windir = env.WINDIR || env.SystemRoot || 'C:\\Windows';
  for (const fw of ['Framework64', 'Framework']) {
    const dir = path.join(windir, 'Microsoft.NET', fw, 'v4.0.30319');
    const csc = path.join(dir, 'csc.exe');
    const wpf = path.join(dir, 'WPF');
    const refs = ['UIAutomationClient.dll', 'UIAutomationTypes.dll', 'WindowsBase.dll'].map((f) => path.join(wpf, f));
    if (fs.existsSync(csc) && refs.every((r) => fs.existsSync(r))) return { dir, csc, refs };
  }
  return null;
}

function sources() {
  return fs
    .readdirSync(SOURCE_DIR)
    .filter((f) => f.endsWith('.cs'))
    .sort()
    .map((f) => path.join(SOURCE_DIR, f));
}

function compilerArgs(fw, outFile, files) {
  return [
    '/nologo',
    '/noconfig',
    '/target:exe',
    '/platform:anycpu',
    '/optimize+',
    '/debug-',
    '/langversion:5',
    '/warn:4',
    '/highentropyva+',
    '/utf8output',
    '/codepage:65001',
    '/errorreport:none',
    '/preferreduilang:en-US',
    `/out:${outFile}`,
    `/r:${path.join(fw.dir, 'System.dll')}`,
    `/r:${path.join(fw.dir, 'System.Core.dll')}`,
    ...fw.refs.map((r) => `/r:${r}`),
    ...files,
  ];
}

/**
 * Builds the helper into `outDir`. Never throws for a missing compiler (returns skipped);
 * throws when compilation itself fails.
 * @returns {{ ok: boolean, skipped: boolean, rebuilt: boolean, path: string | null, reason: string | null, ms: number }}
 */
export function buildUiaHelper({ outDir = path.join(root, 'out', 'native'), log = console.log } = {}) {
  const t0 = Date.now();
  const fw = findFramework();
  if (!fw) {
    const reason = process.platform === 'win32' ? 'csc.exe (.NET Framework 4.x) not found' : 'not Windows';
    log(`build-uia-helper: skipped (${reason}); browser tab strips will be unavailable`);
    return { ok: false, skipped: true, rebuilt: false, path: null, reason, ms: Date.now() - t0 };
  }
  const files = sources();
  if (files.length === 0) throw new Error(`build-uia-helper: no C# sources in ${SOURCE_DIR}`);
  fs.mkdirSync(outDir, { recursive: true });
  const outFile = path.join(outDir, HELPER_EXE);
  const stampFile = `${outFile}.stamp`;
  const hash = crypto.createHash('sha256');
  hash.update(JSON.stringify(compilerArgs(fw, '<out>', files.map((f) => path.relative(root, f)))));
  hash.update(String(fs.statSync(fw.csc).size));
  for (const f of files) hash.update(fs.readFileSync(f));
  const digest = hash.digest('hex');
  try {
    if (fs.existsSync(outFile) && fs.readFileSync(stampFile, 'utf8').trim() === digest) {
      log(`build-uia-helper: up to date (${path.relative(root, outFile)})`);
      return { ok: true, skipped: false, rebuilt: false, path: outFile, reason: null, ms: Date.now() - t0 };
    }
  } catch {
    /* no stamp yet */
  }
  const tmpFile = path.join(outDir, `.${HELPER_EXE}.${process.pid}.tmp.exe`);
  try {
    execFileSync(fw.csc, compilerArgs(fw, tmpFile, files), { cwd: root, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
  } catch (e) {
    fs.rmSync(tmpFile, { force: true });
    const out = `${e.stdout ?? ''}${e.stderr ?? ''}`.trim();
    throw new Error(`build-uia-helper: csc failed\n${out}`);
  }
  fs.rmSync(outFile, { force: true });
  fs.renameSync(tmpFile, outFile);
  fs.writeFileSync(stampFile, `${digest}\n`);
  // Smoke check: the exe starts and speaks the protocol version (no UI Automation is loaded).
  const version = execFileSync(outFile, ['--version'], { encoding: 'utf8', windowsHide: true, timeout: 10_000 }).trim();
  const parsed = JSON.parse(version);
  if (parsed.version !== 1) throw new Error(`build-uia-helper: unexpected protocol version ${version}`);
  const size = fs.statSync(outFile).size;
  log(`build-uia-helper: ${path.relative(root, outFile)} (${(size / 1024).toFixed(1)} KB) in ${Date.now() - t0} ms`);
  return { ok: true, skipped: false, rebuilt: true, path: outFile, reason: null, ms: Date.now() - t0 };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const argv = process.argv.slice(2);
  const outIdx = argv.indexOf('--out');
  const outDir = outIdx >= 0 && argv[outIdx + 1] ? path.resolve(argv[outIdx + 1]) : undefined;
  try {
    const r = buildUiaHelper({ outDir });
    if (r.skipped && argv.includes('--strict')) process.exit(1);
  } catch (e) {
    console.error(e instanceof Error ? e.message : String(e));
    process.exit(1);
  }
}
