// 1.4.0 Windows on Arm packaging: the static payload check (scripts/check-win-payload.mjs), the
// koffi staging script (scripts/stage-koffi-arch.mjs), the ARM64-only installer guard
// (build/installer.nsh customInit) and the per-architecture installer choice of install-test.ps1
// and upgrade-test.ps1.
// SIMULATED: PE images, asar archives and unpacked folders are synthetic buffers written to a temp
// folder; nothing is downloaded and no app binary is executed. On Windows, the PowerShell parser
// reads the test scripts and only their Resolve-Installer function runs, against a temp folder.
// When electron-builder's NSIS is cached, the guard is compiled into a small silent harness and
// run (it writes one marker file in a temp folder). REAL only for the runIf blocks that read a
// packaged folder in release/1.4.0 or the staged node_modules package, when they exist.
import { execFileSync, spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
// @ts-expect-error a plain .mjs script without declarations
import * as payloadModule from '../../../scripts/check-win-payload.mjs';
// @ts-expect-error a plain .mjs script without declarations
import * as stageModule from '../../../scripts/stage-koffi-arch.mjs';

const ROOT = path.resolve(__dirname, '..', '..', '..');
const read = (...parts: string[]): string => fs.readFileSync(path.join(ROOT, ...parts), 'utf8').replace(/\r\n/g, '\n');
const onWindows = process.platform === 'win32';

// ---------------------------------------------------------------------------------------------
// Types of the two scripts' exports.

type Arch = 'x64' | 'arm64';
interface Reader {
  size: number;
  read(offset: number, length: number): Buffer;
  close(): void;
}
interface Pe {
  machine: number;
  format: string | null;
  dataDirs: { rva: number; size: number }[];
  sections: unknown[];
}
interface Clr {
  flags: number;
  ilOnly: boolean;
  requires32Bit: boolean;
  prefers32Bit: boolean;
}
interface Leaf {
  type: number | string;
  name: number | string | null;
  offset: number;
  size: number;
}
interface AsarNode {
  files?: Record<string, AsarNode>;
  size?: number;
  offset?: string;
  unpacked?: boolean;
}
interface Asar {
  raw: Buffer;
  header: AsarNode;
  dataOffset: number;
}
interface PayloadOptions {
  arch: Arch;
  dir: string;
  exe: string;
  strict: boolean;
  out: string | null;
  config: string | null;
}
interface PayloadResult {
  ok: boolean;
  failures: string[];
  warnings: string[];
  appVersion?: string | null;
  koffi: { unpackedPlatforms: string[]; otherArchInAsar: string[]; binary?: { machine: string } };
  asar?: { integrity: { resource: boolean; matches: boolean } };
  fuses?: { sentinels: number; mismatches: unknown[] };
  uiaHelper?: { present: boolean; platform?: string };
  otherPe: { mismatches: unknown[]; expectedOther: { file: string }[] };
}
interface PayloadApi {
  MACHINES: Record<'i386' | 'x64' | 'arm64', number>;
  FUSE_SENTINEL: Buffer;
  FUSE_ORDER: string[];
  RT_MANIFEST: number;
  bufferReader(buf: Buffer): Reader;
  readPe(r: Reader): Pe;
  readClr(r: Reader, pe: Pe): Clr | null;
  clrPlatform(machine: number, clr: Clr | null): string;
  readResources(r: Reader, pe: Pe): Leaf[];
  findResource(leaves: Leaf[], type: number | string, name?: number | string): Leaf | null;
  readResourceBytes(r: Reader, leaf: Leaf): Buffer;
  readAsarHeader(r: Reader): Asar;
  asarHeaderHash(raw: Buffer): string;
  readAsarFile(r: Reader, asar: Asar, p: string): Buffer | null;
  koffiPackagesInAsar(header: AsarNode): { name: string; binaries: { path: string; unpacked: boolean }[] }[];
  scanFor(r: Reader, needle: Buffer, chunk?: number): number[];
  parseFuseWire(bytes: Buffer): { version: number; length: number; states: Record<string, string> };
  fusesFromYml(text: string): Record<string, boolean>;
  compareFuses(expected: Record<string, boolean>, states: Record<string, string>): { fuse: string; expected: string; actual: string }[];
  parseArgs(argv: string[]): PayloadOptions;
  checkPayload(opts: PayloadOptions, repoRoot: string): PayloadResult;
}
interface LockedPackage {
  name: string;
  version: string;
  integrity: string;
}
interface StageApi {
  parseArgs(argv: string[]): { arch: Arch };
  lockedPlatformPackage(lock: unknown, arch: string): LockedPackage;
  sriOf(bytes: Buffer, alg?: string): string;
  inspectPackageDir(dir: string, pkg: LockedPackage, arch: Arch, machineOf?: (file: string) => number): string;
  npmCliCandidates(env: Record<string, string | undefined>, execPath: string): string[];
}

const payload = payloadModule as unknown as PayloadApi;
const stage = stageModule as unknown as StageApi;
const { MACHINES } = payload;

// ---------------------------------------------------------------------------------------------
// Synthetic files.

const must = <T>(v: T | undefined, what: string): T => {
  if (v === undefined) throw new Error(`fixture: no ${what}`);
  return v;
};
const align = (n: number, a: number): number => Math.ceil(n / a) * a;
const SECTION_VA = 0x1000;
const SECTION_RAW = 0x400;

interface ResourceSpec {
  type: number | string;
  name: number | string;
  data: Buffer;
}

/** A resource tree (type -> name -> one language), laid out for the RVA `baseRva`. */
function resourceTree(items: ResourceSpec[], baseRva: number): Buffer {
  const byType = new Map<number | string, ResourceSpec[]>();
  for (const it of items) byType.set(it.type, [...(byType.get(it.type) ?? []), it]);
  const types = [...byType.keys()];
  let off = 16 + 8 * types.length;
  const typeDirAt = new Map<number | string, number>();
  for (const t of types) {
    typeDirAt.set(t, off);
    off += 16 + 8 * must(byType.get(t), 'type').length;
  }
  const langDirAt = new Map<ResourceSpec, number>();
  for (const it of items) {
    langDirAt.set(it, off);
    off += 16 + 8;
  }
  const dataEntryAt = new Map<ResourceSpec, number>();
  for (const it of items) {
    dataEntryAt.set(it, off);
    off += 16;
  }
  const stringAt = new Map<string, number>();
  for (const key of [...types, ...items.map((i) => i.name)]) {
    if (typeof key === 'string' && !stringAt.has(key)) {
      stringAt.set(key, off);
      off += 2 + key.length * 2;
    }
  }
  off = align(off, 4);
  const blobAt = new Map<ResourceSpec, number>();
  for (const it of items) {
    blobAt.set(it, off);
    off = align(off + it.data.length, 4);
  }
  const buf = Buffer.alloc(off);
  const writeDir = (at: number, keys: (number | string)[], targets: number[], subdirs: boolean): void => {
    const named = keys.filter((k) => typeof k === 'string').length;
    buf.writeUInt16LE(named, at + 12);
    buf.writeUInt16LE(keys.length - named, at + 14);
    keys.forEach((k, i) => {
      const nameField = typeof k === 'string' ? (0x80000000 | must(stringAt.get(k), 'string')) >>> 0 : k;
      const target = must(targets[i], 'target');
      buf.writeUInt32LE(nameField, at + 16 + i * 8);
      buf.writeUInt32LE(subdirs ? (0x80000000 | target) >>> 0 : target, at + 20 + i * 8);
    });
  };
  writeDir(0, types, types.map((t) => must(typeDirAt.get(t), 'type dir')), true);
  for (const t of types) {
    const list = must(byType.get(t), 'type');
    writeDir(must(typeDirAt.get(t), 'type dir'), list.map((i) => i.name), list.map((i) => must(langDirAt.get(i), 'lang dir')), true);
  }
  for (const it of items) writeDir(must(langDirAt.get(it), 'lang dir'), [0x409], [must(dataEntryAt.get(it), 'data entry')], false);
  for (const it of items) {
    const at = must(dataEntryAt.get(it), 'data entry');
    const blob = must(blobAt.get(it), 'blob');
    buf.writeUInt32LE(baseRva + blob, at);
    buf.writeUInt32LE(it.data.length, at + 4);
    it.data.copy(buf, blob);
  }
  for (const [s, at] of stringAt) {
    buf.writeUInt16LE(s.length, at);
    buf.write(s, at + 2, 'utf16le');
  }
  return buf;
}

/** A minimal PE image with one section holding an optional CLR header, resources and extra bytes. */
function buildPe(o: { machine: number; plus: boolean; clrFlags?: number; resources?: ResourceSpec[]; extra?: Buffer }): Buffer {
  const optSize = o.plus ? 240 : 224;
  const rsrcOff = o.clrFlags === undefined ? 0 : 80;
  const rsrc = o.resources ? resourceTree(o.resources, SECTION_VA + rsrcOff) : Buffer.alloc(0);
  const extraOff = align(rsrcOff + rsrc.length, 16);
  const content = Buffer.alloc(extraOff + (o.extra?.length ?? 0));
  if (o.clrFlags !== undefined) {
    content.writeUInt32LE(72, 0);
    content.writeUInt16LE(2, 4);
    content.writeUInt16LE(5, 6);
    content.writeUInt32LE(o.clrFlags, 16);
  }
  rsrc.copy(content, rsrcOff);
  o.extra?.copy(content, extraOff);
  const file = Buffer.alloc(SECTION_RAW + content.length);
  file.write('MZ', 0, 'latin1');
  file.writeUInt32LE(0x40, 0x3c);
  file.write('PE\0\0', 0x40, 'latin1');
  file.writeUInt16LE(o.machine, 0x44);
  file.writeUInt16LE(1, 0x46);
  file.writeUInt16LE(optSize, 0x54);
  file.writeUInt16LE(0x0022, 0x56);
  const opt = 0x58;
  file.writeUInt16LE(o.plus ? 0x20b : 0x10b, opt);
  file.writeUInt32LE(16, opt + (o.plus ? 108 : 92));
  const dirs = opt + (o.plus ? 112 : 96);
  if (o.resources) {
    file.writeUInt32LE(SECTION_VA + rsrcOff, dirs + 2 * 8);
    file.writeUInt32LE(rsrc.length, dirs + 2 * 8 + 4);
  }
  if (o.clrFlags !== undefined) {
    file.writeUInt32LE(SECTION_VA, dirs + 14 * 8);
    file.writeUInt32LE(72, dirs + 14 * 8 + 4);
  }
  const sec = opt + optSize;
  file.write('.data', sec, 'latin1');
  file.writeUInt32LE(content.length, sec + 8);
  file.writeUInt32LE(SECTION_VA, sec + 12);
  file.writeUInt32LE(content.length, sec + 16);
  file.writeUInt32LE(SECTION_RAW, sec + 20);
  content.copy(file, SECTION_RAW);
  return file;
}

/** An asar archive; unpacked entries carry no data in the archive. */
function buildAsar(files: Record<string, { data?: Buffer; unpacked?: boolean }>): Buffer {
  const header: AsarNode = { files: {} };
  const chunks: Buffer[] = [];
  let offset = 0;
  for (const [p, f] of Object.entries(files)) {
    const parts = p.split('/');
    let node = header;
    for (const dir of parts.slice(0, -1)) {
      const children: Record<string, AsarNode> = (node.files ??= {});
      node = children[dir] ??= { files: {} };
    }
    const data = f.data ?? Buffer.alloc(0);
    (node.files ??= {})[must(parts.at(-1), 'name')] = f.unpacked ? { size: data.length, unpacked: true } : { size: data.length, offset: String(offset) };
    if (!f.unpacked) {
      chunks.push(data);
      offset += data.length;
    }
  }
  const json = Buffer.from(JSON.stringify(header), 'utf8');
  const padded = align(json.length, 4);
  const pickle = Buffer.alloc(8 + padded);
  pickle.writeUInt32LE(4 + padded, 0);
  pickle.writeInt32LE(json.length, 4);
  json.copy(pickle, 8);
  const prefix = Buffer.alloc(8);
  prefix.writeUInt32LE(4, 0);
  prefix.writeUInt32LE(pickle.length, 4);
  return Buffer.concat([prefix, pickle, ...chunks]);
}

const ymlFuses = payload.fusesFromYml(read('electron-builder.yml'));
/** The fuse wire electron-builder.yml asks for ('1' for fuses it does not name). */
function fuseWire(overrides: Record<string, '0' | '1'> = {}): Buffer {
  const states = payload.FUSE_ORDER.map((name) => overrides[name] ?? (ymlFuses[name] === false ? '0' : '1')).join('');
  return Buffer.concat([payload.FUSE_SENTINEL, Buffer.from([1, payload.FUSE_ORDER.length]), Buffer.from(states, 'latin1')]);
}

const repoVersion = (JSON.parse(read('package.json')) as { version: string }).version;
const KOFFI_VERSION = '3.3.4';

interface PayloadFixture {
  exeMachine?: number;
  koffiMachine?: number;
  otherArchPacked?: boolean;
  breakIntegrity?: boolean;
  helperFlags?: number;
  fuses?: Record<string, '0' | '1'>;
}

function writeFile(file: string, data: Buffer | string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, data);
}

/** A synthetic win-unpacked / win-arm64-unpacked folder. */
function writePayload(dir: string, arch: Arch, f: PayloadFixture = {}): void {
  const other: Arch = arch === 'x64' ? 'arm64' : 'x64';
  const pkgDir = `node_modules/@koromix/koffi-win32-${arch}`;
  const asarFiles: Record<string, { data?: Buffer; unpacked?: boolean }> = {
    'package.json': { data: Buffer.from(JSON.stringify({ name: 'desktop-cat', version: repoVersion })) },
    'out/main/index.js': { data: Buffer.from('// main') },
    'node_modules/koffi/package.json': { unpacked: true },
    [`${pkgDir}/package.json`]: { unpacked: true },
    [`${pkgDir}/win32_${arch}/koffi.node`]: { unpacked: true },
  };
  if (f.otherArchPacked) asarFiles[`node_modules/@koromix/koffi-win32-${other}/win32_${other}/koffi.node`] = { data: Buffer.from('other') };
  const asar = buildAsar(asarFiles);
  const raw = payload.readAsarHeader(payload.bufferReader(asar)).raw;
  const hash = f.breakIntegrity ? '0'.repeat(64) : payload.asarHeaderHash(raw);
  const integrity = Buffer.from(JSON.stringify([{ file: 'resources\\app.asar', alg: 'SHA256', value: hash }]));
  writeFile(
    path.join(dir, 'DesktopCat.exe'),
    buildPe({ machine: f.exeMachine ?? MACHINES[arch], plus: true, resources: [{ type: 'INTEGRITY', name: 'ELECTRONASAR', data: integrity }], extra: fuseWire(f.fuses) }),
  );
  writeFile(path.join(dir, 'resources', 'app.asar'), asar);
  const unpacked = path.join(dir, 'resources', 'app.asar.unpacked', 'node_modules');
  writeFile(path.join(unpacked, 'koffi', 'package.json'), JSON.stringify({ name: 'koffi', version: KOFFI_VERSION }));
  writeFile(path.join(unpacked, '@koromix', `koffi-win32-${arch}`, 'package.json'), JSON.stringify({ name: `@koromix/koffi-win32-${arch}`, version: KOFFI_VERSION }));
  writeFile(path.join(unpacked, '@koromix', `koffi-win32-${arch}`, `win32_${arch}`, 'koffi.node'), buildPe({ machine: f.koffiMachine ?? MACHINES[arch], plus: true }));
  const manifest = Buffer.from('<?xml version="1.0"?><assembly xmlns="urn:schemas-microsoft-com:asm.v1" manifestVersion="1.0"></assembly>');
  writeFile(
    path.join(dir, 'resources', 'native', 'DesktopCatUia.exe'),
    buildPe({ machine: MACHINES.i386, plus: false, clrFlags: f.helperFlags ?? 0x1, resources: [{ type: payload.RT_MANIFEST, name: 1, data: manifest }] }),
  );
  writeFile(path.join(dir, 'ffmpeg.dll'), buildPe({ machine: MACHINES[arch], plus: true }));
  writeFile(path.join(dir, 'resources', 'elevate.exe'), buildPe({ machine: MACHINES.i386, plus: false }));
}

const options = (arch: Arch, dir: string, strict = false): PayloadOptions => ({ arch, dir, exe: 'DesktopCat.exe', strict, out: null, config: null });

let work = '';
beforeAll(() => {
  work = fs.mkdtempSync(path.join(os.tmpdir(), 'dcat-arm64-pkg-'));
});
afterAll(() => {
  if (work) fs.rmSync(work, { recursive: true, force: true });
});
let caseNo = 0;
const freshDir = (): string => path.join(work, `case-${++caseNo}`);

// ---------------------------------------------------------------------------------------------

describe('check-win-payload: PE, asar and fuse readers', () => {
  it('reads the machine of PE32+ (x64, ARM64) and PE32 images', () => {
    for (const [machine, plus] of [
      [MACHINES.arm64, true],
      [MACHINES.x64, true],
      [MACHINES.i386, false],
    ] as const) {
      const pe = payload.readPe(payload.bufferReader(buildPe({ machine, plus })));
      expect(pe.machine).toBe(machine);
      expect(pe.format).toBe(plus ? 'PE32+' : 'PE32');
    }
    expect(() => payload.readPe(payload.bufferReader(Buffer.alloc(512)))).toThrow(/not a PE file/);
  });

  it('tells IL-only AnyCPU from 32-bit-required, 32-bit-preferred and native images', () => {
    const platform = (flags?: number): string => {
      const r = payload.bufferReader(buildPe({ machine: MACHINES.i386, plus: false, clrFlags: flags }));
      const pe = payload.readPe(r);
      return payload.clrPlatform(pe.machine, payload.readClr(r, pe));
    };
    expect(platform(0x1)).toBe('AnyCPU');
    expect(platform(0x1 | 0x2)).toBe('x86');
    expect(platform(0x1 | 0x20000)).toBe('AnyCPU-32bit-preferred');
    expect(platform(undefined)).toBe('native');
  });

  it('finds named (INTEGRITY/ELECTRONASAR) and numbered (RT_MANIFEST) resources', () => {
    const r = payload.bufferReader(
      buildPe({
        machine: MACHINES.x64,
        plus: true,
        resources: [
          { type: 'INTEGRITY', name: 'ELECTRONASAR', data: Buffer.from('[{"x":1}]') },
          { type: payload.RT_MANIFEST, name: 1, data: Buffer.from('<assembly/>') },
        ],
      }),
    );
    const leaves = payload.readResources(r, payload.readPe(r));
    const integrity = payload.findResource(leaves, 'INTEGRITY', 'ELECTRONASAR');
    const manifest = payload.findResource(leaves, payload.RT_MANIFEST);
    expect(integrity && payload.readResourceBytes(r, integrity).toString()).toBe('[{"x":1}]');
    expect(manifest && payload.readResourceBytes(r, manifest).toString()).toBe('<assembly/>');
    expect(payload.findResource(leaves, 'INTEGRITY', 'OTHER')).toBeNull();
  });

  it('reads the asar header, hashes it as electron-builder does and lists koffi packages', () => {
    const asar = buildAsar({
      'package.json': { data: Buffer.from('{"version":"9.9.9"}') },
      'node_modules/@koromix/koffi-win32-arm64/win32_arm64/koffi.node': { unpacked: true },
      'node_modules/@koromix/koffi-win32-x64/win32_x64/koffi.node': { data: Buffer.from('x') },
    });
    const r = payload.bufferReader(asar);
    const parsed = payload.readAsarHeader(r);
    expect(payload.asarHeaderHash(parsed.raw)).toBe(crypto.createHash('sha256').update(parsed.raw).digest('hex'));
    expect(payload.readAsarFile(r, parsed, 'package.json')?.toString()).toBe('{"version":"9.9.9"}');
    expect(payload.readAsarFile(r, parsed, 'node_modules/@koromix/koffi-win32-arm64/win32_arm64/koffi.node')).toBeNull();
    expect(payload.koffiPackagesInAsar(parsed.header)).toEqual([
      { name: 'koffi-win32-arm64', files: 1, unpackedFiles: 1, binaries: [{ path: 'win32_arm64/koffi.node', unpacked: true }] },
      { name: 'koffi-win32-x64', files: 1, unpackedFiles: 0, binaries: [{ path: 'win32_x64/koffi.node', unpacked: false }] },
    ]);
  });

  it('finds the fuse sentinel once, also across a chunk boundary', () => {
    const s = payload.FUSE_SENTINEL;
    const buf = Buffer.concat([Buffer.alloc(10), s, Buffer.alloc(7)]);
    for (const chunk of [8, 16, 20, 4096]) expect(payload.scanFor(payload.bufferReader(buf), s, chunk)).toEqual([10]);
    expect(payload.scanFor(payload.bufferReader(Buffer.concat([s, s])), s, 8)).toEqual([0, s.length]);
  });

  it('reads the fuse wire and compares it with electronFuses in electron-builder.yml', () => {
    expect(ymlFuses).toMatchObject({ runAsNode: false, enableEmbeddedAsarIntegrityValidation: true, onlyLoadAppFromAsar: true });
    const wire = payload.parseFuseWire(fuseWire().subarray(payload.FUSE_SENTINEL.length));
    expect(wire.length).toBe(payload.FUSE_ORDER.length);
    expect(payload.compareFuses(ymlFuses, wire.states)).toEqual([]);
    const bad = payload.parseFuseWire(fuseWire({ runAsNode: '1' }).subarray(payload.FUSE_SENTINEL.length));
    expect(payload.compareFuses(ymlFuses, bad.states)).toEqual([{ fuse: 'runAsNode', expected: 'disabled', actual: 'enabled' }]);
  });

  it('requires --arch x64|arm64 and --dir', () => {
    expect(payload.parseArgs(['--arch', 'arm64', '--dir', 'x'])).toMatchObject({ arch: 'arm64', dir: 'x', strict: false });
    expect(() => payload.parseArgs(['--arch', 'ia32', '--dir', 'x'])).toThrow(/--arch/);
    expect(() => payload.parseArgs(['--arch', 'x64'])).toThrow(/--dir/);
    expect(() => payload.parseArgs(['--arch', 'x64', '--dir', 'x', '--run'])).toThrow(/unknown argument/);
  });
});

describe('check-win-payload: an unpacked folder', () => {
  for (const arch of ['x64', 'arm64'] as const) {
    it(`passes a well-formed ${arch} folder without warnings`, () => {
      const dir = freshDir();
      writePayload(dir, arch);
      const r = payload.checkPayload(options(arch, dir), ROOT);
      expect(r.failures).toEqual([]);
      expect(r.warnings).toEqual([]);
      expect(r.ok).toBe(true);
      expect(r.appVersion).toBe(repoVersion);
      expect(r.koffi.unpackedPlatforms).toEqual([`koffi-win32-${arch}`]);
      expect(r.koffi.binary?.machine).toBe(arch);
      expect(r.asar?.integrity).toEqual(expect.objectContaining({ resource: true, matches: true }));
      expect(r.fuses?.sentinels).toBe(1);
      expect(r.uiaHelper?.platform).toBe('AnyCPU');
      expect(r.otherPe.expectedOther.map((e) => path.basename(e.file))).toEqual(['elevate.exe']);
    });
  }

  it('fails an ARM64 folder whose exe or koffi binary is x64', () => {
    const dir = freshDir();
    writePayload(dir, 'arm64', { exeMachine: MACHINES.x64, koffiMachine: MACHINES.x64 });
    const r = payload.checkPayload(options('arm64', dir), ROOT);
    expect(r.ok).toBe(false);
    expect(r.failures).toContain('DesktopCat.exe is x64, expected arm64');
    expect(r.failures).toContain('node_modules/@koromix/koffi-win32-arm64/win32_arm64/koffi.node is x64, expected arm64');
  });

  it('fails an x64 folder checked as ARM64 (no ARM64 koffi package at all)', () => {
    const dir = freshDir();
    writePayload(dir, 'x64');
    const r = payload.checkPayload(options('arm64', dir), ROOT);
    expect(r.ok).toBe(false);
    expect(r.failures).toContain('app.asar.unpacked has no @koromix/koffi-win32-arm64');
    expect(r.failures).toContain('app.asar header does not list node_modules/@koromix/koffi-win32-arm64/win32_arm64/koffi.node');
  });

  it('warns (fails only with --strict) when the other architecture is still in app.asar', () => {
    const dir = freshDir();
    writePayload(dir, 'arm64', { otherArchPacked: true });
    const r = payload.checkPayload(options('arm64', dir), ROOT);
    expect(r.failures).toEqual([]);
    expect(r.ok).toBe(true);
    expect(r.koffi.otherArchInAsar).toEqual(['koffi-win32-x64']);
    expect(r.warnings.join('\n')).toMatch(/app\.asar also lists koffi-win32-x64/);
    expect(payload.checkPayload(options('arm64', dir, true), ROOT).ok).toBe(false);
  });

  it('fails when the asar integrity record does not match the header (integrity fuse on)', () => {
    const dir = freshDir();
    writePayload(dir, 'arm64', { breakIntegrity: true });
    const r = payload.checkPayload(options('arm64', dir), ROOT);
    expect(r.ok).toBe(false);
    expect(r.failures).toContain('the exe asar integrity record does not match the app.asar header');
  });

  it('fails on a fuse that differs from electron-builder.yml', () => {
    const dir = freshDir();
    writePayload(dir, 'x64', { fuses: { runAsNode: '1' } });
    const r = payload.checkPayload(options('x64', dir), ROOT);
    expect(r.ok).toBe(false);
    expect(r.failures).toContain('fuse runAsNode is enabled, electron-builder.yml says disabled');
  });

  it('fails a UI Automation helper that requires 32-bit, warns on one that prefers it', () => {
    const required = freshDir();
    writePayload(required, 'arm64', { helperFlags: 0x1 | 0x2 });
    expect(payload.checkPayload(options('arm64', required), ROOT).failures).toContain('DesktopCatUia.exe is x86, expected IL-only AnyCPU');
    const preferred = freshDir();
    writePayload(preferred, 'arm64', { helperFlags: 0x1 | 0x20000 });
    const r = payload.checkPayload(options('arm64', preferred), ROOT);
    expect(r.ok).toBe(true);
    expect(r.warnings).toContain('DesktopCatUia.exe prefers 32-bit (it would run as x86 on ARM64)');
  });
});

describe('packaged 1.4.0 folders (REAL when they exist)', () => {
  const folders: [Arch, string][] = [
    ['x64', path.join(ROOT, 'release', repoVersion, 'win-unpacked')],
    ['arm64', path.join(ROOT, 'release', repoVersion, 'win-arm64-unpacked')],
  ];
  for (const [arch, dir] of folders) {
    it.runIf(fs.existsSync(path.join(dir, 'DesktopCat.exe')))(`${path.relative(ROOT, dir)} passes the static payload check`, () => {
      const r = payload.checkPayload(options(arch, dir), ROOT);
      expect(r.failures).toEqual([]);
      expect(r.ok).toBe(true);
    });
  }
});

// ---------------------------------------------------------------------------------------------

describe('stage-koffi-arch', () => {
  const lock = JSON.parse(read('package-lock.json')) as { packages: Record<string, { version?: string; integrity?: string }> };

  it('takes the ARM64 package at the locked koffi version and its sha512 from package-lock.json', () => {
    const pkg = stage.lockedPlatformPackage(lock, 'arm64');
    expect(pkg.name).toBe('@koromix/koffi-win32-arm64');
    expect(pkg.version).toBe(lock.packages['node_modules/koffi']?.version);
    expect(pkg.integrity).toBe(lock.packages['node_modules/@koromix/koffi-win32-arm64']?.integrity);
    expect(pkg.integrity).toMatch(/^sha512-/);
  });

  it('refuses a lockfile whose platform package differs from koffi, or lacks it', () => {
    const koffi = { version: '3.3.4' };
    const entry = { version: '3.3.3', integrity: 'sha512-AAAA' };
    expect(() => stage.lockedPlatformPackage({ packages: { 'node_modules/koffi': koffi, 'node_modules/@koromix/koffi-win32-arm64': entry } }, 'arm64')).toThrow(/koffi is 3\.3\.4/);
    expect(() => stage.lockedPlatformPackage({ packages: { 'node_modules/koffi': koffi } }, 'arm64')).toThrow(/has no node_modules\/@koromix\/koffi-win32-arm64/);
    expect(() => stage.lockedPlatformPackage({ packages: { 'node_modules/koffi': koffi, 'node_modules/@koromix/koffi-win32-arm64': { version: '3.3.4', integrity: 'sha1-AAAA' } } }, 'arm64')).toThrow(/sha512/);
  });

  it('computes npm-style integrity (FIPS 180-2 SHA-512 test vector)', () => {
    const abc = 'ddaf35a193617abacc417349ae20413112e6fa4e89a97ea20a9eeee64b55d39a2192992a274fc1a836ba3c23a3feebbd454d4423643ce80e2a9ac94fa54ca49f';
    expect(stage.sriOf(Buffer.from('abc'))).toBe(`sha512-${Buffer.from(abc, 'hex').toString('base64')}`);
  });

  it('accepts a staged folder only with the right name, version and PE machine', () => {
    const dir = freshDir();
    const pkg: LockedPackage = { name: '@koromix/koffi-win32-arm64', version: '3.3.4', integrity: 'sha512-x' };
    expect(stage.inspectPackageDir(dir, pkg, 'arm64')).toBe('missing');
    writeFile(path.join(dir, 'package.json'), JSON.stringify({ name: '@koromix/koffi-win32-x64', version: '3.3.4' }));
    expect(stage.inspectPackageDir(dir, pkg, 'arm64')).toMatch(/names @koromix\/koffi-win32-x64/);
    writeFile(path.join(dir, 'package.json'), JSON.stringify({ name: pkg.name, version: '3.3.3' }));
    expect(stage.inspectPackageDir(dir, pkg, 'arm64')).toMatch(/version 3\.3\.3, locked 3\.3\.4/);
    writeFile(path.join(dir, 'package.json'), JSON.stringify({ name: pkg.name, version: '3.3.4' }));
    expect(stage.inspectPackageDir(dir, pkg, 'arm64')).toBe('win32_arm64/koffi.node missing');
    writeFile(path.join(dir, 'win32_arm64', 'koffi.node'), buildPe({ machine: MACHINES.x64, plus: true }));
    expect(stage.inspectPackageDir(dir, pkg, 'arm64')).toBe('koffi.node is x64, expected arm64');
    writeFile(path.join(dir, 'win32_arm64', 'koffi.node'), buildPe({ machine: MACHINES.arm64, plus: true }));
    expect(stage.inspectPackageDir(dir, pkg, 'arm64')).toBe('ok');
    expect(stage.inspectPackageDir(dir, pkg, 'arm64', () => MACHINES.x64)).toBe('koffi.node is x64, expected arm64');
  });

  it('runs npm through its own CLI script (npm_execpath first when it is npm), never a .cmd shim', () => {
    const node = path.join('C:', 'node', 'node.exe');
    const fromNpm = stage.npmCliCandidates({ npm_execpath: path.join('C:', 'npm', 'bin', 'npm-cli.js') }, node);
    expect(fromNpm[0]).toBe(path.join('C:', 'npm', 'bin', 'npm-cli.js'));
    const other = stage.npmCliCandidates({ npm_execpath: path.join('C:', 'pnpm', 'pnpm.cjs') }, node);
    expect(other[0]).toBe(path.join('C:', 'node', 'node_modules', 'npm', 'bin', 'npm-cli.js'));
    expect(other.every((p) => p.endsWith('npm-cli.js'))).toBe(true);
  });

  it('takes only --arch x64|arm64', () => {
    expect(stage.parseArgs(['--arch', 'arm64'])).toEqual({ arch: 'arm64' });
    expect(() => stage.parseArgs(['--arch', 'arm'])).toThrow(/--arch/);
    expect(() => stage.parseArgs(['--arch', 'arm64', '--save'])).toThrow(/unknown argument/);
  });

  const staged = path.join(ROOT, 'node_modules', '@koromix', 'koffi-win32-arm64');
  it.runIf(fs.existsSync(path.join(staged, 'package.json')))('the staged node_modules package is the locked ARM64 one (REAL)', () => {
    expect(stage.inspectPackageDir(staged, stage.lockedPlatformPackage(lock, 'arm64'), 'arm64')).toBe('ok');
  });
});

// ---------------------------------------------------------------------------------------------

describe('electron-builder.yml: one installer per architecture', () => {
  const yml = read('electron-builder.yml');
  const win = yml.slice(yml.indexOf('\nwin:'), yml.indexOf('\nlinux:'));
  const nsis = yml.slice(yml.indexOf('\nnsis:'), yml.indexOf('\nelectronFuses:'));

  it('builds x64 and ARM64, each with only its own koffi binary unpacked', () => {
    expect(win).toMatch(/arch: \[x64, arm64\]/);
    expect(win).toContain('- node_modules/@koromix/koffi-win32-${arch}/**');
    expect(win).toContain('- "!node_modules/@koromix/koffi-win32-!(${arch})/**"');
  });

  it('names each installer by architecture and builds no combined installer', () => {
    expect(nsis).toContain('artifactName: Desktop-Cat-Setup-${version}-${arch}.${ext}');
    expect(nsis).toMatch(/buildUniversalInstaller: false/);
  });
});

// ---------------------------------------------------------------------------------------------

/** makensis.exe from electron-builder's cache (the one packaging uses), or null. */
function findMakensis(): string | null {
  const cache = path.join(process.env.LOCALAPPDATA ?? '', 'electron-builder', 'Cache');
  try {
    for (const version of fs.readdirSync(cache).filter((d) => /^nsis-\d/.test(d))) {
      for (const dir of fs.readdirSync(path.join(cache, version))) {
        const exe = path.join(cache, version, dir, 'makensis.exe');
        if (fs.existsSync(exe)) return exe;
      }
    }
  } catch {
    /* no cache */
  }
  return null;
}

/** PROCESSOR_ARCHITECTURE of Windows itself (AMD64, ARM64), also from an emulated process. */
function nativeArchitecture(): string | null {
  const r = spawnSync('reg.exe', ['query', 'HKLM\\SYSTEM\\CurrentControlSet\\Control\\Session Manager\\Environment', '/v', 'PROCESSOR_ARCHITECTURE'], {
    encoding: 'utf8',
    windowsHide: true,
    timeout: 30_000,
  });
  return /REG_SZ\s+(\S+)/.exec(r.stdout ?? '')?.[1] ?? null;
}

describe('build/installer.nsh: the ARM64-only guard', () => {
  const nsh = read('build', 'installer.nsh');

  it('defines customInit once, only when APP_ARM64 is defined and APP_64 is not', () => {
    expect(nsh.match(/!macro customInit\b/g) ?? []).toHaveLength(1);
    expect(nsh).toMatch(/!ifdef APP_ARM64\s+!ifndef APP_64\s+!macro customInit\s+\$\{IfNot\} \$\{IsNativeARM64\}/);
    const guard = nsh.slice(nsh.indexOf('!macro customInit'), nsh.indexOf('!macroend', nsh.indexOf('!macro customInit')));
    // Silent installs answer the message box themselves and exit non-zero; nothing is written first.
    expect(guard).toMatch(/MessageBox MB_OK\|MB_ICONSTOP "[^"]+" \/SD IDOK/);
    expect(guard).toMatch(/SetErrorLevel 1\s+Quit/);
    expect(guard).not.toMatch(/\b(File|WriteReg\w*|CreateDirectory|SetOutPath)\b/);
  });

  const makensis = onWindows ? findMakensis() : null;
  const native = onWindows ? nativeArchitecture() : null;
  describe.runIf(makensis !== null && (native === 'AMD64' || native === 'ARM64'))('compiled into a silent harness and run', () => {
    function runHarness(label: string, defines: string[]): { status: number | null; installed: boolean } {
      const dir = path.join(work, `nsis-${label}`);
      fs.mkdirSync(dir, { recursive: true });
      const exe = path.join(dir, 'harness.exe');
      const nsi = path.join(dir, 'harness.nsi');
      const marker = path.join(dir, 'installed.txt');
      fs.writeFileSync(
        nsi,
        [
          'Unicode true',
          'Name "Desktop Cat architecture guard harness"',
          `OutFile "${exe}"`,
          'RequestExecutionLevel user',
          'SilentInstall silent',
          '!include "LogicLib.nsh"',
          // electron-builder includes the custom file before common.nsh brings in x64.nsh.
          `!include "${path.join(ROOT, 'build', 'installer.nsh')}"`,
          '!include "x64.nsh"',
          'Function .onInit',
          '  !ifmacrodef customInit',
          '    !insertmacro customInit',
          '  !endif',
          'FunctionEnd',
          'Section "harness"',
          `  FileOpen $0 "${marker}" w`,
          '  FileWrite $0 "installed"',
          '  FileClose $0',
          'SectionEnd',
          '',
        ].join('\r\n'),
        'utf8',
      );
      const built = spawnSync(makensis as string, ['/V2', '/INPUTCHARSET', 'UTF8', '/DVERSION=9.9.9', ...defines, nsi], { encoding: 'utf8', timeout: 60_000, windowsHide: true });
      if (built.status !== 0) throw new Error(`makensis failed (${String(built.status)}): ${built.stdout}\n${built.stderr}`);
      const run = spawnSync(exe, [], { timeout: 60_000, windowsHide: true });
      return { status: run.status, installed: fs.existsSync(marker) };
    }

    it('the ARM64-only installer stops on a PC that is not Windows on Arm, and runs on one that is', () => {
      const r = runHarness('arm64', ['/DAPP_ARM64=app-arm64.7z']);
      if (native === 'ARM64') expect(r).toEqual({ status: 0, installed: true });
      else expect(r).toEqual({ status: 1, installed: false });
    }, 120_000);

    it('the x64 installer (and a combined one) never get the guard', () => {
      expect(runHarness('x64', ['/DAPP_64=app-64.7z'])).toEqual({ status: 0, installed: true });
      expect(runHarness('both', ['/DAPP_64=app-64.7z', '/DAPP_ARM64=app-arm64.7z'])).toEqual({ status: 0, installed: true });
    }, 120_000);
  });
});

// ---------------------------------------------------------------------------------------------

describe('install-test.ps1 and upgrade-test.ps1: which installer is tested', () => {
  const install = read('scripts', 'install-test.ps1');
  const upgrade = read('scripts', 'upgrade-test.ps1');
  const fn = (text: string, name: string): string => {
    const start = text.indexOf(`function ${name}`);
    const next = text.indexOf('\n}', start);
    return start === -1 || next === -1 ? '' : text.slice(start, next + 2);
  };

  it('both scripts share one Resolve-Installer and one Get-NativeArch, and never pick by name order or date', () => {
    for (const name of ['Resolve-Installer', 'Get-NativeArch']) {
      expect(fn(install, name).length, name).toBeGreaterThan(0);
      expect(fn(upgrade, name), name).toBe(fn(install, name));
    }
    expect(install).not.toMatch(/Filter 'Desktop-Cat-Setup-\*\.exe' \| Select-Object -First 1/);
    expect(upgrade).not.toMatch(/Sort-Object LastWriteTime/);
    expect(install).toMatch(/\$setup = Resolve-Installer \$root \$version \$Arch \$Installer/);
    expect(upgrade).toMatch(/\$new = Resolve-Installer \$root \$version \$Arch \$Installer/);
    // An arm64 installer is never started on a PC that cannot run it.
    for (const text of [install, upgrade]) expect(text).toMatch(/if \(\(\$Arch -eq 'arm64'\) -and \(\$nativeArch -ne 'arm64'\)\) \{ throw/);
  });

  interface ResolveCase {
    root: string;
    version: string;
    arch: Arch;
    explicit?: string;
  }
  interface ResolveOutcome {
    path?: string;
    error?: string;
  }
  /** Runs only the script's Resolve-Installer function (taken out by the PowerShell parser). */
  function resolve(script: string, cases: ResolveCase[]): ResolveOutcome[] {
    const ps = [
      '$tokens = $null; $errs = $null',
      '$ast = [System.Management.Automation.Language.Parser]::ParseFile($env:DCAT_PS_SCRIPT, [ref]$tokens, [ref]$errs)',
      "$fn = $ast.Find({ param($n) ($n -is [System.Management.Automation.Language.FunctionDefinitionAst]) -and ($n.Name -eq 'Resolve-Installer') }, $true)",
      '. ([scriptblock]::Create($fn.Extent.Text))',
      '$cases = $env:DCAT_PS_CASES | ConvertFrom-Json',
      '$out = @(foreach ($c in $cases) { try { $r = Resolve-Installer $c.root $c.version $c.arch $c.explicit; @{ path = $r.FullName } } catch { @{ error = $_.Exception.Message } } })',
      'ConvertTo-Json -InputObject $out -Compress -Depth 3',
    ].join('\n');
    const out = execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', ps], {
      env: { ...process.env, DCAT_PS_SCRIPT: script, DCAT_PS_CASES: JSON.stringify(cases) },
      encoding: 'utf8',
      windowsHide: true,
      timeout: 60_000,
    });
    return JSON.parse(out) as ResolveOutcome[];
  }

  it.runIf(onWindows)(
    'picks exactly Desktop-Cat-Setup-<version>-<arch>.exe, refuses none or several, and checks an explicit path',
    () => {
      const root = freshDir();
      const v = '1.4.0';
      const rel = (...p: string[]): string => path.join(root, 'release', ...p);
      for (const f of [rel('Desktop-Cat-Setup-1.1.0.exe'), rel('Desktop-Cat-Setup-1.2.0.exe'), rel(v, 'Desktop-Cat-Setup-1.4.0-x64.exe'), rel(v, 'Desktop-Cat-Setup-1.4.0-arm64.exe')]) writeFile(f, 'MZ');
      const dup = freshDir();
      writeFile(path.join(dup, 'release', 'Desktop-Cat-Setup-1.4.0-x64.exe'), 'MZ');
      writeFile(path.join(dup, 'release', v, 'Desktop-Cat-Setup-1.4.0-x64.exe'), 'MZ');
      for (const script of ['install-test.ps1', 'upgrade-test.ps1']) {
        const [x64, arm64, missing, several, explicitOk, explicitWrongArch, explicitAbsent] = resolve(path.join(ROOT, 'scripts', script), [
          { root, version: v, arch: 'x64' },
          { root, version: v, arch: 'arm64' },
          { root, version: '9.9.9', arch: 'x64' },
          { root: dup, version: v, arch: 'x64' },
          { root, version: v, arch: 'arm64', explicit: rel(v, 'Desktop-Cat-Setup-1.4.0-arm64.exe') },
          { root, version: v, arch: 'x64', explicit: rel(v, 'Desktop-Cat-Setup-1.4.0-arm64.exe') },
          { root, version: v, arch: 'x64', explicit: rel('nothing.exe') },
        ]);
        expect(x64?.path?.toLowerCase(), script).toMatch(/\\release\\1\.4\.0\\desktop-cat-setup-1\.4\.0-x64\.exe$/);
        expect(arm64?.path?.toLowerCase(), script).toMatch(/\\release\\1\.4\.0\\desktop-cat-setup-1\.4\.0-arm64\.exe$/);
        expect(missing?.error, script).toMatch(/Desktop-Cat-Setup-9\.9\.9-x64\.exe not found/);
        expect(several?.error, script).toMatch(/several copies of Desktop-Cat-Setup-1\.4\.0-x64\.exe/);
        expect(explicitOk?.path?.toLowerCase(), script).toMatch(/desktop-cat-setup-1\.4\.0-arm64\.exe$/);
        expect(explicitWrongArch?.error, script).toMatch(/is not the x64 installer/);
        expect(explicitAbsent?.error, script).toMatch(/installer not found/);
      }
    },
    120_000,
  );
});

describe('workflows (edited only, never started)', () => {
  it('release.yml packages both architectures and checks both payloads, one step each', () => {
    const yml = read('.github', 'workflows', 'release.yml');
    const job = yml.slice(yml.indexOf('\n  windows:'), yml.indexOf('\n  linux:'));
    expect(job).toContain('node scripts/stage-koffi-arch.mjs --arch arm64');
    expect(job).toContain('npx electron-builder --win nsis --x64 --arm64 --publish never');
    expect(job).toMatch(/run: node scripts\/check-win-payload\.mjs --arch x64 --dir release\/win-unpacked\n/);
    expect(job).toMatch(/run: node scripts\/check-win-payload\.mjs --arch arm64 --dir release\/win-arm64-unpacked\n/);
  });

  it('installer-check.yml tests the x64 installer on the x64 runner and stays manual', () => {
    const yml = read('.github', 'workflows', 'installer-check.yml');
    expect(yml).toContain('scripts/install-test.ps1 -Arch x64');
    expect(yml).toContain('-OldInstaller $old.FullName -Arch x64');
    expect(yml).toMatch(/^on:\n {2}workflow_dispatch:/m);
    // The Windows on Arm job stays commented out until its runner is confirmed for this repository.
    expect(yml).not.toMatch(/^\s+runs-on: windows-11-arm/m);
  });
});
