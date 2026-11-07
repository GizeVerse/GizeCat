#!/usr/bin/env node
// Static, read-only checks of an unpacked Windows build (electron-builder's win-unpacked or
// win-arm64-unpacked folder). It never executes a binary: everything comes from file headers.
//
//   node scripts/check-win-payload.mjs --arch <x64|arm64> --dir <unpacked dir> [--strict] [--out <file.json>]
//
// Checks (failures make the exit code 1; warnings only with --strict):
// - DesktopCat.exe has the PE machine of --arch (0x8664 x64, 0xAA64 ARM64).
// - resources/app.asar.unpacked/node_modules/@koromix holds koffi-win32-<arch>, and its
//   win32_<arch>/koffi.node has the right machine. koffi loads exactly
//   @koromix/koffi-<process.platform>-<process.arch>, so a missing or wrong binary would leave the
//   app running on the Win32 fallback without window surfaces, taskbar or perception.
// - The app.asar header lists that koffi.node as unpacked (Electron reads unpacked files only
//   through the header). Another architecture's koffi package in the header or the unpacked
//   folder is a warning: the files exclusion in electron-builder.yml did not apply (harmless,
//   koffi never loads it, about +1 MB).
// - The asar integrity resource of the exe (type INTEGRITY, name ELECTRONASAR) matches the SHA-256
//   of the app.asar header, when the enableEmbeddedAsarIntegrityValidation fuse is on.
// - The fuse wire in the exe matches electronFuses in electron-builder.yml.
// - resources/native/DesktopCatUia.exe (UI Automation helper, optional) is IL-only AnyCPU (COR20
//   ILONLY set, 32BITREQUIRED clear); 32BITPREFERRED is a warning (it would run as x86 on ARM64).
//   Whether its manifest declares supportedArchitectures is reported, not judged.
// - Every other .exe/.dll/.node file has the machine of --arch (a mismatch is a warning).
//
// Prints one JSON object (paths relative to the current directory) for the evidence record.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const MACHINES = { i386: 0x014c, x64: 0x8664, arm64: 0xaa64, arm64ec: 0xa641, arm: 0x01c4 };
export const ARCHES = {
  x64: { machine: MACHINES.x64, koffiPackage: 'koffi-win32-x64', koffiDir: 'win32_x64' },
  arm64: { machine: MACHINES.arm64, koffiPackage: 'koffi-win32-arm64', koffiDir: 'win32_arm64' },
};

export function machineName(machine) {
  const hit = Object.entries(MACHINES).find(([, v]) => v === machine);
  return hit ? hit[0] : `0x${Number(machine).toString(16).padStart(4, '0')}`;
}

// ---------------------------------------------------------------------------------------------
// Readers: { size, read(offset, length) -> Buffer (shorter at the end of the file), close() }.

export function bufferReader(buf) {
  return {
    size: buf.length,
    read: (offset, length) => buf.subarray(Math.max(0, offset), Math.max(0, Math.min(buf.length, offset + length))),
    close() {},
  };
}

export function fileReader(file) {
  const fd = fs.openSync(file, 'r');
  const size = fs.fstatSync(fd).size;
  return {
    size,
    read(offset, length) {
      const n = Math.max(0, Math.min(length, size - offset));
      const out = Buffer.alloc(n);
      let got = 0;
      while (got < n) {
        const k = fs.readSync(fd, out, got, n - got, offset + got);
        if (k === 0) break;
        got += k;
      }
      return out.subarray(0, got);
    },
    close() {
      fs.closeSync(fd);
    },
  };
}

function exact(r, offset, length, what) {
  const b = r.read(offset, length);
  if (b.length !== length) throw new Error(`truncated file: ${what} at ${offset}`);
  return b;
}

// ---------------------------------------------------------------------------------------------
// PE / COFF headers (Microsoft PE format spec).

export const DIR_RESOURCE = 2;
export const DIR_CLR = 14;
export const RT_MANIFEST = 24;
export const COMIMAGE_FLAGS = { ILONLY: 0x1, REQUIRES_32BIT: 0x2, NATIVE_ENTRYPOINT: 0x10, PREFERS_32BIT: 0x20000 };

/** Machine, optional-header kind, data directories and sections of a PE image. */
export function readPe(r) {
  const dos = exact(r, 0, 64, 'DOS header');
  if (dos.readUInt16LE(0) !== 0x5a4d) throw new Error('not a PE file (no MZ)');
  const peOff = dos.readUInt32LE(0x3c);
  const coff = exact(r, peOff, 24, 'PE header');
  if (coff.readUInt32LE(0) !== 0x00004550) throw new Error('not a PE file (no PE signature)');
  const machine = coff.readUInt16LE(4);
  const sectionCount = coff.readUInt16LE(6);
  const optSize = coff.readUInt16LE(20);
  const characteristics = coff.readUInt16LE(22);
  const result = { machine, characteristics, format: null, dataDirs: [], sections: [] };
  if (optSize < 2) return result;
  const opt = exact(r, peOff + 24, optSize, 'optional header');
  const magic = opt.readUInt16LE(0);
  const plus = magic === 0x20b;
  if (!plus && magic !== 0x10b) throw new Error(`unknown optional header magic 0x${magic.toString(16)}`);
  result.format = plus ? 'PE32+' : 'PE32';
  const countAt = plus ? 108 : 92;
  const dirsAt = plus ? 112 : 96;
  const dirCount = optSize >= countAt + 4 ? Math.min(16, opt.readUInt32LE(countAt)) : 0;
  for (let i = 0; i < dirCount && dirsAt + i * 8 + 8 <= optSize; i++) {
    result.dataDirs.push({ rva: opt.readUInt32LE(dirsAt + i * 8), size: opt.readUInt32LE(dirsAt + i * 8 + 4) });
  }
  const table = exact(r, peOff + 24 + optSize, sectionCount * 40, 'section table');
  for (let i = 0; i < sectionCount; i++) {
    const s = table.subarray(i * 40, i * 40 + 40);
    result.sections.push({
      name: s.subarray(0, 8).toString('latin1').replace(/\0+$/, ''),
      virtualSize: s.readUInt32LE(8),
      va: s.readUInt32LE(12),
      rawSize: s.readUInt32LE(16),
      rawPtr: s.readUInt32LE(20),
    });
  }
  return result;
}

/** The PE machine of a file, reading only its headers. */
export function peMachineOfFile(file) {
  const r = fileReader(file);
  try {
    return readPe(r).machine;
  } finally {
    r.close();
  }
}

export function rvaToOffset(pe, rva) {
  for (const s of pe.sections) {
    const span = Math.max(s.virtualSize, s.rawSize);
    if (rva >= s.va && rva < s.va + span) {
      const delta = rva - s.va;
      return delta < s.rawSize ? s.rawPtr + delta : null;
    }
  }
  return null;
}

/** COR20 (CLR) header flags of a .NET image, or null for a native one. */
export function readClr(r, pe) {
  const dir = pe.dataDirs[DIR_CLR];
  if (!dir || dir.rva === 0 || dir.size === 0) return null;
  const off = rvaToOffset(pe, dir.rva);
  if (off === null) throw new Error('CLR header outside every section');
  const h = exact(r, off, 24, 'CLR header');
  const flags = h.readUInt32LE(16);
  return {
    runtime: `${h.readUInt16LE(4)}.${h.readUInt16LE(6)}`,
    flags,
    ilOnly: (flags & COMIMAGE_FLAGS.ILONLY) !== 0,
    requires32Bit: (flags & COMIMAGE_FLAGS.REQUIRES_32BIT) !== 0,
    prefers32Bit: (flags & COMIMAGE_FLAGS.PREFERS_32BIT) !== 0,
    nativeEntryPoint: (flags & COMIMAGE_FLAGS.NATIVE_ENTRYPOINT) !== 0,
  };
}

/**
 * How Windows runs a .NET Framework exe, from its machine and COR20 flags: 'AnyCPU' (64-bit where
 * available), 'AnyCPU-32bit-preferred', 'x86', 'x64', 'arm64' or 'native'.
 */
export function clrPlatform(machine, clr) {
  if (!clr) return 'native';
  if (machine === MACHINES.i386) {
    if (!clr.ilOnly || clr.requires32Bit) return 'x86';
    return clr.prefers32Bit ? 'AnyCPU-32bit-preferred' : 'AnyCPU';
  }
  return machineName(machine);
}

/** Every leaf of the resource tree: { type, name, lang, offset, size } (numbers or strings). */
export function readResources(r, pe) {
  const dir = pe.dataDirs[DIR_RESOURCE];
  if (!dir || dir.rva === 0 || dir.size === 0) return [];
  const base = rvaToOffset(pe, dir.rva);
  if (base === null) throw new Error('resource directory outside every section');
  const nameAt = (field) => {
    if ((field & 0x80000000) === 0) return field & 0xffff;
    const at = base + (field & 0x7fffffff);
    const len = exact(r, at, 2, 'resource name').readUInt16LE(0);
    return exact(r, at + 2, len * 2, 'resource name').toString('utf16le');
  };
  const leaves = [];
  const walk = (rel, depth, keys) => {
    const head = exact(r, base + rel, 16, 'resource directory');
    const count = head.readUInt16LE(12) + head.readUInt16LE(14);
    if (count > 4096) throw new Error('implausible resource directory');
    const entries = exact(r, base + rel + 16, count * 8, 'resource entries');
    for (let i = 0; i < count; i++) {
      const key = nameAt(entries.readUInt32LE(i * 8));
      const target = entries.readUInt32LE(i * 8 + 4);
      const path3 = [...keys, key];
      if ((target & 0x80000000) !== 0) {
        if (depth < 2) walk(target & 0x7fffffff, depth + 1, path3);
        continue;
      }
      const data = exact(r, base + target, 16, 'resource data entry');
      const offset = rvaToOffset(pe, data.readUInt32LE(0));
      if (offset === null) continue;
      leaves.push({ type: path3[0], name: path3[1] ?? null, lang: path3[2] ?? null, offset, size: data.readUInt32LE(4) });
    }
  };
  walk(0, 0, []);
  return leaves;
}

const sameKey = (a, b) => (typeof a === 'string' && typeof b === 'string' ? a.toUpperCase() === b.toUpperCase() : a === b);

export function findResource(leaves, type, name) {
  return leaves.find((l) => sameKey(l.type, type) && (name === undefined || sameKey(l.name, name))) ?? null;
}

export function readResourceBytes(r, leaf) {
  return exact(r, leaf.offset, leaf.size, 'resource data');
}

// ---------------------------------------------------------------------------------------------
// asar archive: [u32 4][u32 headerPickleSize][header pickle: u32 payload, i32 length, JSON]; file
// offsets in the JSON are relative to 8 + headerPickleSize.

export function readAsarHeader(r) {
  const prefix = exact(r, 0, 8, 'asar size pickle');
  if (prefix.readUInt32LE(0) !== 4) throw new Error('not an asar archive');
  const pickleSize = prefix.readUInt32LE(4);
  const pickle = exact(r, 8, pickleSize, 'asar header pickle');
  const length = pickle.readInt32LE(4);
  if (length < 0 || 8 + length > pickle.length) throw new Error('corrupt asar header');
  const raw = pickle.subarray(8, 8 + length);
  return { raw, header: JSON.parse(raw.toString('utf8')), dataOffset: 8 + pickleSize };
}

/** The SHA-256 electron-builder records for asar integrity: over the header JSON string. */
export function asarHeaderHash(raw) {
  return crypto.createHash('sha256').update(raw).digest('hex');
}

export function asarLookup(header, p) {
  let node = header;
  for (const part of p.split('/').filter(Boolean)) {
    if (!node || !node.files || !Object.hasOwn(node.files, part)) return null;
    node = node.files[part];
  }
  return node;
}

export function* walkAsar(node, prefix = '') {
  for (const [name, child] of Object.entries(node?.files ?? {})) {
    const p = prefix ? `${prefix}/${name}` : name;
    if (child && child.files) {
      yield { path: p, dir: true, node: child };
      yield* walkAsar(child, p);
    } else {
      yield { path: p, dir: false, node: child };
    }
  }
}

export function readAsarFile(r, asar, p) {
  const node = asarLookup(asar.header, p);
  if (!node || node.files || node.unpacked || node.offset === undefined) return null;
  return exact(r, asar.dataOffset + Number(node.offset), Number(node.size), `asar file ${p}`);
}

/** koffi platform packages listed in the asar header, with their files and .node binaries. */
export function koffiPackagesInAsar(header) {
  const scope = asarLookup(header, 'node_modules/@koromix');
  if (!scope || !scope.files) return [];
  return Object.entries(scope.files)
    .filter(([name]) => name.startsWith('koffi-'))
    .map(([name, node]) => {
      const files = [...walkAsar(node)].filter((e) => !e.dir);
      return {
        name,
        files: files.length,
        unpackedFiles: files.filter((e) => e.node && e.node.unpacked).length,
        binaries: files.filter((e) => e.path.endsWith('.node')).map((e) => ({ path: e.path, unpacked: Boolean(e.node && e.node.unpacked) })),
      };
    })
    .sort((a, b) => a.name.localeCompare(b.name));
}

// ---------------------------------------------------------------------------------------------
// Electron fuses (@electron/fuses 2.1.3 constants): the wire follows a fixed sentinel as
// [version][length][state per fuse], '0' disabled, '1' enabled, 'r' removed.

export const FUSE_SENTINEL = Buffer.from('dL7pKGdnNz796PbbjQWNKmHXBZaB9tsX', 'latin1');
export const FUSE_ORDER = [
  'runAsNode',
  'enableCookieEncryption',
  'enableNodeOptionsEnvironmentVariable',
  'enableNodeCliInspectArguments',
  'enableEmbeddedAsarIntegrityValidation',
  'onlyLoadAppFromAsar',
  'loadBrowserProcessSpecificV8Snapshot',
  'grantFileProtocolExtraPrivileges',
  'wasmTrapHandlers',
];

/** Offsets of every copy of `needle`, scanning in chunks that overlap by needle.length - 1. */
export function scanFor(r, needle, chunk = 4 * 1024 * 1024) {
  const found = [];
  for (let start = 0; start < r.size; start += chunk) {
    const buf = r.read(start, chunk + needle.length - 1);
    let i = buf.indexOf(needle);
    while (i !== -1) {
      if (i < chunk) found.push(start + i);
      i = buf.indexOf(needle, i + 1);
    }
  }
  return found;
}

export function parseFuseWire(bytes) {
  if (bytes.length < 2) throw new Error('truncated fuse wire');
  const version = bytes[0];
  const length = bytes[1];
  const wire = bytes.subarray(2, 2 + length);
  const states = {};
  wire.forEach((b, i) => {
    const name = FUSE_ORDER[i] ?? `fuse${i}`;
    states[name] = b === 0x31 ? 'enabled' : b === 0x30 ? 'disabled' : b === 0x72 ? 'removed' : `0x${b.toString(16)}`;
  });
  return { version, length, states };
}

/** electronFuses from electron-builder.yml: { name: boolean } for each `  name: true|false` line. */
export function fusesFromYml(text) {
  const lines = text.split(/\r?\n/);
  const start = lines.findIndex((l) => /^electronFuses:\s*$/.test(l));
  const out = {};
  if (start === -1) return out;
  for (const line of lines.slice(start + 1)) {
    if (/^\S/.test(line)) break;
    const m = /^\s+(\w+):\s*(true|false)\s*(#.*)?$/.exec(line);
    if (m) out[m[1]] = m[2] === 'true';
  }
  return out;
}

export function compareFuses(expected, states) {
  return Object.entries(expected)
    .map(([fuse, want]) => ({ fuse, expected: want ? 'enabled' : 'disabled', actual: states[fuse] ?? 'absent' }))
    .filter((d) => d.expected !== d.actual);
}

// ---------------------------------------------------------------------------------------------
// The check itself.

/** Files (relative to the unpacked folder, lower case) whose machine differs from the target by design. */
export const KNOWN_OTHER_MACHINE = {
  // electron-builder copies its x86 elevation helper into every Windows package (x86 runs emulated on ARM64).
  'resources/elevate.exe': { machine: MACHINES.i386, why: "electron-builder's x86 elevation helper, the same for every architecture" },
};

export function parseArgs(argv) {
  const opts = { arch: null, dir: null, exe: 'DesktopCat.exe', strict: false, out: null, config: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => {
      const v = argv[++i];
      if (v === undefined) throw new Error(`${a} needs a value`);
      return v;
    };
    if (a === '--arch') opts.arch = next();
    else if (a === '--dir') opts.dir = next();
    else if (a === '--exe') opts.exe = next();
    else if (a === '--out') opts.out = next();
    else if (a === '--config') opts.config = next();
    else if (a === '--strict') opts.strict = true;
    else throw new Error(`unknown argument ${a}`);
  }
  if (!opts.arch || !Object.hasOwn(ARCHES, opts.arch)) throw new Error(`--arch must be one of ${Object.keys(ARCHES).join(', ')}`);
  if (!opts.dir) throw new Error('--dir is required');
  return opts;
}

function sha256File(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

function listPeFiles(dir) {
  const out = [];
  const walk = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.isFile() && /\.(exe|dll|node)$/i.test(e.name)) out.push(p);
    }
  };
  walk(dir);
  return out;
}

export function checkPayload(opts, repoRoot) {
  const spec = ARCHES[opts.arch];
  const dir = path.resolve(opts.dir);
  const rel = (p) => path.relative(process.cwd(), p).split(path.sep).join('/') || '.';
  const failures = [];
  const warnings = [];
  const fail = (m) => failures.push(m);
  const warn = (m) => warnings.push(m);
  const result = { tool: 'check-win-payload', staticOnly: true, dir: rel(dir), arch: opts.arch };
  if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) throw new Error(`not a directory: ${dir}`);

  // 1. The Electron executable.
  const exePath = path.join(dir, opts.exe);
  let exe = null;
  let exeResources = [];
  let fuseStates = null;
  if (!fs.existsSync(exePath)) {
    fail(`${opts.exe} missing`);
  } else {
    exe = fileReader(exePath);
    try {
      const pe = readPe(exe);
      result.exe = { file: opts.exe, machine: machineName(pe.machine), format: pe.format, bytes: exe.size };
      if (pe.machine !== spec.machine) fail(`${opts.exe} is ${machineName(pe.machine)}, expected ${opts.arch}`);
      exeResources = readResources(exe, pe);
      // Fuses.
      const sentinels = scanFor(exe, FUSE_SENTINEL);
      result.fuses = { sentinels: sentinels.length };
      if (sentinels.length !== 1) {
        fail(`${sentinels.length} fuse sentinels in ${opts.exe} (expected 1)`);
      } else {
        const wire = parseFuseWire(exe.read(sentinels[0] + FUSE_SENTINEL.length, 2 + 255));
        fuseStates = wire.states;
        const configFile = opts.config ? path.resolve(opts.config) : path.join(repoRoot, 'electron-builder.yml');
        const expected = fs.existsSync(configFile) ? fusesFromYml(fs.readFileSync(configFile, 'utf8')) : {};
        const mismatches = compareFuses(expected, wire.states);
        Object.assign(result.fuses, { version: wire.version, length: wire.length, states: wire.states, expectedFrom: rel(configFile), mismatches });
        if (Object.keys(expected).length === 0) warn(`no electronFuses found in ${rel(configFile)}; fuses not compared`);
        for (const m of mismatches) fail(`fuse ${m.fuse} is ${m.actual}, electron-builder.yml says ${m.expected}`);
      }
    } finally {
      exe.close();
    }
  }

  // 2. app.asar: header, integrity, the app's package.json, koffi entries.
  const asarPath = path.join(dir, 'resources', 'app.asar');
  let asarPackages = [];
  if (!fs.existsSync(asarPath)) {
    fail('resources/app.asar missing');
  } else {
    const ar = fileReader(asarPath);
    try {
      const asar = readAsarHeader(ar);
      const entries = [...walkAsar(asar.header)];
      const hash = asarHeaderHash(asar.raw);
      result.asar = { bytes: ar.size, headerBytes: asar.raw.length, files: entries.filter((e) => !e.dir).length, unpackedFiles: entries.filter((e) => !e.dir && e.node && e.node.unpacked).length, headerSha256: hash };
      const pkgBytes = readAsarFile(ar, asar, 'package.json');
      if (pkgBytes) {
        const pkg = JSON.parse(pkgBytes.toString('utf8'));
        result.appVersion = pkg.version ?? null;
        const repoPkg = path.join(repoRoot, 'package.json');
        const repoVersion = fs.existsSync(repoPkg) ? JSON.parse(fs.readFileSync(repoPkg, 'utf8')).version : null;
        if (repoVersion && pkg.version !== repoVersion) warn(`app.asar package.json is ${pkg.version}, the repository is ${repoVersion}`);
      } else {
        warn('app.asar has no readable package.json');
      }
      // Asar integrity (Windows: an INTEGRITY/ELECTRONASAR resource of the exe, JSON).
      const leaf = findResource(exeResources, 'INTEGRITY', 'ELECTRONASAR');
      const integrity = { resource: Boolean(leaf), matches: false };
      if (leaf && fs.existsSync(exePath)) {
        const er = fileReader(exePath);
        try {
          const list = JSON.parse(readResourceBytes(er, leaf).toString('utf8'));
          const entry = Array.isArray(list) ? list.find((x) => String(x.file).replace(/\//g, '\\').toLowerCase() === 'resources\\app.asar') : null;
          integrity.alg = entry ? entry.alg : null;
          integrity.matches = Boolean(entry && String(entry.alg).toUpperCase() === 'SHA256' && String(entry.value).toLowerCase() === hash);
        } finally {
          er.close();
        }
      }
      result.asar.integrity = integrity;
      if (fuseStates && fuseStates.enableEmbeddedAsarIntegrityValidation === 'enabled') {
        if (!integrity.resource) fail('asar integrity fuse is on but the exe has no INTEGRITY/ELECTRONASAR resource');
        else if (!integrity.matches) fail('the exe asar integrity record does not match the app.asar header');
      }
      // Native modules packed inside the archive cannot be loaded.
      const packedNative = entries.filter((e) => !e.dir && e.path.endsWith('.node') && !(e.node && e.node.unpacked)).map((e) => e.path);
      if (packedNative.length > 0) warn(`native modules packed inside app.asar (not loadable): ${packedNative.join(', ')}`);
      asarPackages = koffiPackagesInAsar(asar.header);
    } finally {
      ar.close();
    }
  }

  // 3. koffi: the unpacked platform packages and the binary this architecture loads.
  const unpackedRoot = path.join(dir, 'resources', 'app.asar.unpacked', 'node_modules');
  const scopeDir = path.join(unpackedRoot, '@koromix');
  const unpackedPlatforms = fs.existsSync(scopeDir)
    ? fs.readdirSync(scopeDir, { withFileTypes: true }).filter((e) => e.isDirectory() && e.name.startsWith('koffi-')).map((e) => e.name).sort()
    : [];
  const readVersion = (p) => (fs.existsSync(p) ? (JSON.parse(fs.readFileSync(p, 'utf8')).version ?? null) : null);
  const koffi = {
    unpackedPlatforms,
    koffiVersion: readVersion(path.join(unpackedRoot, 'koffi', 'package.json')),
    platformVersion: readVersion(path.join(scopeDir, spec.koffiPackage, 'package.json')),
    asarPackages,
  };
  result.koffi = koffi;
  if (!unpackedPlatforms.includes(spec.koffiPackage)) fail(`app.asar.unpacked has no @koromix/${spec.koffiPackage}`);
  const extraUnpacked = unpackedPlatforms.filter((n) => n !== spec.koffiPackage);
  if (extraUnpacked.length > 0) warn(`other koffi platform packages unpacked: ${extraUnpacked.join(', ')}`);
  if (koffi.koffiVersion === null) fail('app.asar.unpacked has no node_modules/koffi/package.json');
  if (koffi.koffiVersion && koffi.platformVersion && koffi.koffiVersion !== koffi.platformVersion) warn(`koffi ${koffi.koffiVersion} with ${spec.koffiPackage} ${koffi.platformVersion}`);
  const binaryRel = `node_modules/@koromix/${spec.koffiPackage}/${spec.koffiDir}/koffi.node`;
  const binaryPath = path.join(dir, 'resources', 'app.asar.unpacked', ...binaryRel.split('/'));
  if (!fs.existsSync(binaryPath)) {
    fail(`${binaryRel} missing from app.asar.unpacked`);
  } else {
    const machine = peMachineOfFile(binaryPath);
    koffi.binary = { path: rel(binaryPath), machine: machineName(machine), bytes: fs.statSync(binaryPath).size, sha256: sha256File(binaryPath) };
    if (machine !== spec.machine) fail(`${binaryRel} is ${machineName(machine)}, expected ${opts.arch}`);
  }
  const own = asarPackages.find((p) => p.name === spec.koffiPackage);
  const ownBinary = own ? own.binaries.find((b) => b.path === `${spec.koffiDir}/koffi.node`) : null;
  if (result.asar && !ownBinary) fail(`app.asar header does not list ${binaryRel}`);
  else if (ownBinary && !ownBinary.unpacked) fail(`app.asar header lists ${binaryRel} as packed, not unpacked`);
  const otherInAsar = asarPackages.map((p) => p.name).filter((n) => n !== spec.koffiPackage);
  koffi.otherArchInAsar = otherInAsar;
  if (otherInAsar.length > 0) warn(`app.asar also lists ${otherInAsar.join(', ')} (the files exclusion did not apply; koffi never loads it)`);

  // 4. The UI Automation helper (optional: absent when the build machine had no csc.exe).
  const helperPath = path.join(dir, 'resources', 'native', 'DesktopCatUia.exe');
  if (!fs.existsSync(helperPath)) {
    result.uiaHelper = { present: false };
    warn('resources/native/DesktopCatUia.exe missing (browser tab strips report themselves unavailable)');
  } else {
    const hr = fileReader(helperPath);
    try {
      const pe = readPe(hr);
      const clr = readClr(hr, pe);
      const manifestLeaf = findResource(readResources(hr, pe), RT_MANIFEST);
      const manifest = manifestLeaf ? readResourceBytes(hr, manifestLeaf).toString('utf8').replace(/^﻿/, '') : null;
      const platform = clrPlatform(pe.machine, clr);
      result.uiaHelper = {
        present: true,
        bytes: hr.size,
        sha256: sha256File(helperPath),
        machine: machineName(pe.machine),
        format: pe.format,
        clr,
        platform,
        manifest: { present: manifest !== null, supportedArchitectures: manifest ? /supportedArchitectures/i.test(manifest) : false },
      };
      if (!clr) fail('DesktopCatUia.exe is not a .NET image');
      else if (!clr.ilOnly || clr.requires32Bit || pe.machine !== MACHINES.i386) fail(`DesktopCatUia.exe is ${platform}, expected IL-only AnyCPU`);
      else if (clr.prefers32Bit) warn('DesktopCatUia.exe prefers 32-bit (it would run as x86 on ARM64)');
    } finally {
      hr.close();
    }
  }

  // 5. Every other PE file.
  const skip = new Set([path.resolve(exePath), path.resolve(helperPath), path.resolve(binaryPath)].map((p) => p.toLowerCase()));
  const byMachine = {};
  const mismatches = [];
  const expectedOther = [];
  const unreadable = [];
  let checked = 0;
  for (const file of listPeFiles(dir)) {
    if (skip.has(path.resolve(file).toLowerCase())) continue;
    let machine;
    try {
      machine = peMachineOfFile(file);
    } catch (e) {
      unreadable.push(`${rel(file)}: ${e instanceof Error ? e.message : String(e)}`);
      continue;
    }
    checked++;
    const name = machineName(machine);
    byMachine[name] = (byMachine[name] ?? 0) + 1;
    const inDir = path.relative(dir, file).split(path.sep).join('/').toLowerCase();
    const known = KNOWN_OTHER_MACHINE[inDir];
    if (machine === spec.machine) continue;
    if (known && known.machine === machine) expectedOther.push({ file: rel(file), machine: name, why: known.why });
    else mismatches.push({ file: rel(file), machine: name });
  }
  result.otherPe = { checked, byMachine, mismatches, expectedOther, unreadable };
  if (mismatches.length > 0) warn(`${mismatches.length} other PE file(s) are not ${opts.arch}: ${mismatches.map((m) => `${m.file} (${m.machine})`).join(', ')}`);
  if (unreadable.length > 0) warn(`${unreadable.length} .exe/.dll/.node file(s) are not readable PE images`);

  result.failures = failures;
  result.warnings = warnings;
  result.ok = failures.length === 0 && (!opts.strict || warnings.length === 0);
  return result;
}

function main(argv) {
  let opts;
  try {
    opts = parseArgs(argv);
  } catch (e) {
    console.error(`check-win-payload: ${e instanceof Error ? e.message : String(e)}`);
    console.error('usage: node scripts/check-win-payload.mjs --arch <x64|arm64> --dir <unpacked dir> [--strict] [--out <file.json>] [--exe DesktopCat.exe] [--config electron-builder.yml]');
    return 2;
  }
  const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  let result;
  try {
    result = checkPayload(opts, repoRoot);
  } catch (e) {
    console.error(`check-win-payload: ${e instanceof Error ? e.message : String(e)}`);
    return 2;
  }
  const text = `${JSON.stringify(result, null, 2)}\n`;
  if (opts.out) fs.writeFileSync(opts.out, text);
  process.stdout.write(text);
  return result.ok ? 0 : 1;
}

const invoked = process.argv[1] ? pathToFileURL(path.resolve(process.argv[1])).href : '';
if (invoked.toLowerCase() === import.meta.url.toLowerCase()) process.exitCode = main(process.argv.slice(2));
