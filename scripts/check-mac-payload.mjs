#!/usr/bin/env node
// Static checks of a thin macOS zip: the ad-hoc GizeCat-<version>-mac-<arch>-adhoc.zip, or a
// Developer ID build's GizeCat-<version>-mac-<arch>.zip. It reads the zip's bytes only and never runs
// anything: this is inspection, not a test.
//
//   node scripts/check-mac-payload.mjs --arch <x64|arm64> --zip <file> [--expect-signature adhoc|cms] [--out <report.json>]
//
// --expect-signature: every checked Mach-O and the Electron framework must carry that kind of code
// signature. "adhoc": the signature's CMS slot is empty or absent (no signer identity). "cms": a real
// CMS signature from a certificate (it does not judge which certificate; codesign and spctl do).
//
// Failures (exit code 1):
// - Missing bundle parts: Contents/MacOS/Desktop Cat, Info.plist, Resources/app.asar, the Electron
//   framework; no symbolic links in the zip (Electron Framework's Versions/Current would be broken).
// - The main, helper and framework Mach-O files are not thin binaries of --arch, or the main
//   executable or a helper has no code signature (Apple Silicon refuses unsigned code).
// - Info.plist: identifier or version wrong; LSUIElement present; no ElectronAsarIntegrity.
// - app.asar: anything outside the app's own files (the allow-list and the size bound shared with
//   check-win-payload.mjs), any koffi package (macOS is floor-only, no FFI), a header hash that
//   differs from the ElectronAsarIntegrity value in Info.plist.
// - The fuse wire in the Electron framework differs from electronFuses in electron-builder.yml.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import zlib from 'node:zlib';
import {
  asarHeaderHash,
  asarStrayEntries,
  bufferReader,
  compareFuses,
  FUSE_SENTINEL,
  fusesFromYml,
  MAX_ASAR_BYTES,
  parseFuseWire,
  readAsarHeader,
  scanFor,
  walkAsar,
} from './check-win-payload.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const APP = 'Desktop Cat.app/Contents';
const CPU = { x64: 0x01000007, arm64: 0x0100000c };
const CPU_NAME = new Map([[0x01000007, 'x64'], [0x0100000c, 'arm64']]);

/** Central-directory entries of a zip: name, method, sizes, offset, unix mode. */
export function readZipEntries(fd, size) {
  const tail = Buffer.alloc(Math.min(size, 66 * 1024));
  fs.readSync(fd, tail, 0, tail.length, size - tail.length);
  let eocd = -1;
  for (let i = tail.length - 22; i >= 0; i--) {
    if (tail.readUInt32LE(i) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new Error('no end-of-central-directory record');
  const count = tail.readUInt16LE(eocd + 10);
  const cdSize = tail.readUInt32LE(eocd + 12);
  const cdOffset = tail.readUInt32LE(eocd + 16);
  const cd = Buffer.alloc(cdSize);
  fs.readSync(fd, cd, 0, cdSize, cdOffset);
  const entries = [];
  let p = 0;
  for (let n = 0; n < count; n++) {
    if (cd.readUInt32LE(p) !== 0x02014b50) throw new Error('corrupt central directory');
    const method = cd.readUInt16LE(p + 10);
    const compressed = cd.readUInt32LE(p + 20);
    const uncompressed = cd.readUInt32LE(p + 24);
    const nameLen = cd.readUInt16LE(p + 28);
    const extraLen = cd.readUInt16LE(p + 30);
    const commentLen = cd.readUInt16LE(p + 32);
    const external = cd.readUInt32LE(p + 38);
    const offset = cd.readUInt32LE(p + 42);
    const name = cd.toString('utf8', p + 46, p + 46 + nameLen);
    entries.push({ name, method, compressed, uncompressed, offset, mode: external >>> 16 });
    p += 46 + nameLen + extraLen + commentLen;
  }
  return entries;
}

/** An entry's bytes (the whole file, or only its first `limit` bytes). */
export function readZipEntry(fd, e, limit) {
  const head = Buffer.alloc(30);
  fs.readSync(fd, head, 0, 30, e.offset);
  if (head.readUInt32LE(0) !== 0x04034b50) throw new Error(`bad local header: ${e.name}`);
  const start = e.offset + 30 + head.readUInt16LE(26) + head.readUInt16LE(28);
  const want = limit && e.method === 8 ? Math.min(e.compressed, limit + 64 * 1024) : e.compressed;
  const raw = Buffer.alloc(want);
  fs.readSync(fd, raw, 0, want, start);
  if (e.method === 0) return limit ? raw.subarray(0, limit) : raw;
  if (e.method !== 8) throw new Error(`unsupported compression ${e.method}: ${e.name}`);
  const out = zlib.inflateRawSync(raw, limit ? { finishFlush: zlib.constants.Z_SYNC_FLUSH } : {});
  return limit ? out.subarray(0, limit) : out;
}

/** CPU type and whether a thin 64-bit Mach-O has a code signature load command. */
export function readMachO(buf) {
  if (buf.length < 32) throw new Error('truncated Mach-O');
  const magic = buf.readUInt32BE(0);
  if (magic === 0xcafebabe || magic === 0xcafebabf) return { fat: true };
  if (buf.readUInt32LE(0) !== 0xfeedfacf) throw new Error('not a 64-bit Mach-O');
  const cputype = buf.readUInt32LE(4);
  const ncmds = buf.readUInt32LE(16);
  let p = 32;
  let signed = false;
  let sigOff = -1;
  let sigSize = 0;
  for (let i = 0; i < ncmds && p + 8 <= buf.length; i++) {
    const cmd = buf.readUInt32LE(p);
    const size = buf.readUInt32LE(p + 4);
    if (cmd === 0x1d) {
      // LC_CODE_SIGNATURE: linkedit_data_command { cmd, cmdsize, dataoff, datasize }
      signed = true;
      sigOff = buf.readUInt32LE(p + 8);
      sigSize = buf.readUInt32LE(p + 12);
    }
    if (size < 8) throw new Error('bad load command');
    p += size;
  }
  return { fat: false, cputype, arch: CPU_NAME.get(cputype) ?? `0x${cputype.toString(16)}`, signed, signature: signatureKind(buf, sigOff, sigSize) };
}

/**
 * The kind of a Mach-O code signature, read from its SuperBlob (big-endian): 'ad-hoc' when the CMS
 * slot (0x10000) is absent or empty (rcodesign and `codesign -s -` write an 8-byte empty CMS blob),
 * 'cms' when a CMS signature with certificates is present (Developer ID and other identities),
 * null when there is no signature or it lies outside the bytes read. Reading this is inspection, not
 * a trust decision: a 'cms' signature still has to be checked with codesign/spctl on a Mac.
 */
export function signatureKind(buf, off, size) {
  if (off < 0 || off + 12 > buf.length || size < 12) return null;
  if (buf.readUInt32BE(off) !== 0xfade0cc0) return null; // CSMAGIC_EMBEDDED_SIGNATURE
  const count = buf.readUInt32BE(off + 8);
  for (let i = 0; i < count; i++) {
    const at = off + 12 + i * 8;
    if (at + 8 > buf.length) return null;
    const type = buf.readUInt32BE(at);
    const blobOff = off + buf.readUInt32BE(at + 4);
    if (type !== 0x10000) continue; // CSSLOT_SIGNATURESLOT
    if (blobOff + 8 > buf.length) return null;
    return buf.readUInt32BE(blobOff + 4) > 8 ? 'cms' : 'ad-hoc';
  }
  return 'ad-hoc';
}

/** The values of a flat, XML Info.plist as strings or nested raw text. */
export function plistValue(xml, key) {
  const m = new RegExp(`<key>${key}</key>\\s*<(string|true|false)\\s*/?>([^<]*)`).exec(xml);
  if (!m) return null;
  return m[1] === 'string' ? m[2] : m[1];
}

export function checkMacZip(opts) {
  const failures = [];
  const warnings = [];
  const fail = (m) => failures.push(m);
  const size = fs.statSync(opts.zip).size;
  const fd = fs.openSync(opts.zip, 'r');
  const result = { zip: path.basename(opts.zip), arch: opts.arch, bytes: size };
  try {
    const entries = readZipEntries(fd, size);
    const byName = new Map(entries.map((e) => [e.name, e]));
    const links = entries.filter((e) => (e.mode & 0o170000) === 0o120000);
    result.entries = entries.length;
    result.symlinks = links.length;
    if (links.length === 0) fail('no symbolic links in the zip (Electron Framework would be broken)');

    const need = (n) => {
      const e = byName.get(n);
      if (!e) fail(`missing ${n}`);
      return e;
    };
    // Mach-O architecture and signatures: the app, every helper, the framework.
    const machos = [`${APP}/MacOS/Desktop Cat`, ...entries.filter((e) => e.name.startsWith(`${APP}/Frameworks/`) && /\/[^/]+ Helper[^/]*\.app\/Contents\/MacOS\/[^/]+$/.test(e.name) && (e.mode & 0o170000) !== 0o120000).map((e) => e.name)];
    result.macho = [];
    for (const n of machos) {
      const e = need(n);
      if (!e) continue;
      const info = readMachO(readZipEntry(fd, e));
      result.macho.push({ file: n.replace(`${APP}/`, ''), ...info });
      if (info.fat) fail(`${n} is a fat binary, expected thin ${opts.arch}`);
      else {
        if (info.cputype !== CPU[opts.arch]) fail(`${n} is ${info.arch}, expected ${opts.arch}`);
        if (!info.signed) fail(`${n} has no code signature`);
        else if (opts.expectSignature && info.signature !== opts.expectSignature) fail(`${n} has a ${String(info.signature)} signature, expected ${opts.expectSignature}`);
      }
    }
    const fw = byName.get(`${APP}/Frameworks/Electron Framework.framework/Versions/A/Electron Framework`);
    if (!fw) fail('missing the Electron framework binary');

    // Info.plist.
    let plist = '';
    const pe = need(`${APP}/Info.plist`);
    if (pe) {
      plist = readZipEntry(fd, pe).toString('utf8');
      const version = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')).version;
      result.plist = {
        id: plistValue(plist, 'CFBundleIdentifier'),
        version: plistValue(plist, 'CFBundleShortVersionString'),
        name: plistValue(plist, 'CFBundleName'),
        executable: plistValue(plist, 'CFBundleExecutable'),
        minimumSystem: plistValue(plist, 'LSMinimumSystemVersion'),
        lsuiElement: plistValue(plist, 'LSUIElement'),
        camera: plistValue(plist, 'NSCameraUsageDescription'),
        microphone: plistValue(plist, 'NSMicrophoneUsageDescription'),
      };
      if (result.plist.id !== 'io.github.enesiltas.desktopcat') fail(`CFBundleIdentifier is ${String(result.plist.id)}`);
      if (result.plist.version !== version) fail(`version is ${String(result.plist.version)}, the repository is ${version}`);
      if (result.plist.lsuiElement !== null) fail('LSUIElement is set (the Dock switch must stay a runtime choice)');
      if (!plist.includes('<key>ElectronAsarIntegrity</key>')) fail('no ElectronAsarIntegrity in Info.plist');
      if (/com\.apple\.security|NSAccessibility|NSScreenCapture/.test(plist)) warnings.push('Info.plist names a permission or entitlement key');
    }

    // app.asar: only the app.
    const ae = need(`${APP}/Resources/app.asar`);
    if (ae) {
      const bytes = readZipEntry(fd, ae);
      const r = bufferReader(bytes);
      const asar = readAsarHeader(r);
      const list = [...walkAsar(asar.header)];
      const stray = asarStrayEntries(list);
      const koffi = list.filter((x) => !x.dir && /node_modules\/(koffi|@koromix)\//.test(`${x.path}`)).map((x) => x.path);
      const hash = asarHeaderHash(asar.raw);
      result.asar = { bytes: bytes.length, files: list.filter((x) => !x.dir).length, strayEntries: stray.length, koffiFiles: koffi.length, headerSha256: hash };
      if (stray.length > 0) fail(`app.asar holds ${stray.length} file(s) outside the app's own files (e.g. ${stray.slice(0, 5).join(', ')})`);
      if (bytes.length > MAX_ASAR_BYTES) fail(`app.asar is ${bytes.length} bytes, over the bound`);
      if (koffi.length > 0) fail(`app.asar holds koffi files: ${koffi.slice(0, 3).join(', ')}`);
      if (plist && !plist.toLowerCase().includes(hash)) fail('the ElectronAsarIntegrity hash in Info.plist does not match the app.asar header');
    }
    const unpacked = entries.filter((e) => e.name.startsWith(`${APP}/Resources/app.asar.unpacked/`) && !e.name.endsWith('/'));
    result.unpackedFiles = unpacked.length;
    if (unpacked.some((e) => /\.node$/.test(e.name))) fail('native modules in app.asar.unpacked (macOS ships none)');

    // Fuses in the framework (the whole binary, about 200 MB, read once).
    if (fw) {
      const bin = readZipEntry(fd, fw);
      // The whole binary: its code signature sits at the end of the file.
      const info = readMachO(bin);
      result.framework = { arch: info.arch, fat: info.fat, signed: info.signed, signature: info.signature, bytes: bin.length };
      if (info.fat) fail('the Electron framework is a fat binary');
      else {
        if (info.cputype !== CPU[opts.arch]) fail(`the Electron framework is ${info.arch}, expected ${opts.arch}`);
        if (!info.signed) fail('the Electron framework has no code signature');
        else if (opts.expectSignature && info.signature !== opts.expectSignature) fail(`the Electron framework has a ${String(info.signature)} signature, expected ${opts.expectSignature}`);
      }
      const r = bufferReader(bin);
      const at = scanFor(r, FUSE_SENTINEL);
      if (at.length !== 1) fail(`${at.length} fuse sentinels in the framework (expected 1)`);
      else {
        const wire = parseFuseWire(r.read(at[0] + FUSE_SENTINEL.length, 2 + 255));
        const expected = fusesFromYml(fs.readFileSync(path.join(root, 'electron-builder.yml'), 'utf8'));
        const diff = compareFuses(expected, wire.states);
        result.fuses = { states: wire.states, mismatches: diff };
        if (diff.length > 0) fail(`fuses differ from electron-builder.yml: ${JSON.stringify(diff)}`);
      }
    }
  } finally {
    fs.closeSync(fd);
  }
  return { ...result, failures, warnings, ok: failures.length === 0 };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const a = process.argv.slice(2);
  const get = (k) => (a.includes(k) ? a[a.indexOf(k) + 1] : undefined);
  const arch = get('--arch');
  const zip = get('--zip');
  const expect = get('--expect-signature');
  const expectSignature = expect === undefined ? undefined : expect === 'adhoc' ? 'ad-hoc' : expect;
  if (!CPU[arch] || !zip || (expectSignature !== undefined && !['ad-hoc', 'cms'].includes(expectSignature))) {
    console.error('usage: node scripts/check-mac-payload.mjs --arch <x64|arm64> --zip <file> [--expect-signature adhoc|cms] [--out <report.json>]');
    process.exit(2);
  }
  const res = checkMacZip({ arch, zip: path.resolve(zip), expectSignature });
  const text = JSON.stringify(res, null, 2);
  if (get('--out')) fs.writeFileSync(get('--out'), text);
  console.log(text);
  process.exit(res.ok ? 0 : 1);
}
