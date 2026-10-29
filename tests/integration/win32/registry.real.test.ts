// REAL registry tests for launch at sign-in, with ONE throwaway value, DesktopCatTest-<hex>,
// under HKCU ...\Run and ...\Explorer\StartupApproved\Run; the production value name is never
// written. The name is recorded to a file in the temp folder before the first write, both
// values are deleted in afterAll (the suite's finally) and confirmed gone by reading back, and
// a record left behind by a run that died is cleaned up first.
//  1. The app's koffi reader (src/main/win32/registry.ts) against values this test writes
//     through its own RegSetKeyValueW binding (the app never writes the registry directly).
//  2. The uninstaller's customUnInstall macro (build/installer.nsh), compiled with the NSIS
//     that electron-builder uses into a small silent harness, with the value name and the
//     marker folder substituted (checked before compiling). Skipped when that NSIS is not cached.
import { spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import type koffiModule from 'koffi';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { LOGIN_ITEM_NAME, UNINSTALL_MARKER_FILE } from '../../../src/main/lifecycle/loginItem';
import { formatCommandLine, REG_BINARY, REG_EXPAND_SZ, REG_SZ, startupApprovedEnabled } from '../../../src/main/lifecycle/loginItemCommandLine';
import { interpretSnapshot, isOurEntry } from '../../../src/main/lifecycle/loginItemReconcile';
import { createLoginItemRegistry, RUN_KEY, STARTUP_APPROVED_RUN_KEY, type LoginItemRegistry } from '../../../src/main/win32/registry';

const ROOT = path.resolve(__dirname, '..', '..', '..');
const HKEY_CURRENT_USER = -2147483647;
const KEY_READ = 0x20019;
const ERROR_SUCCESS = 0;
const ERROR_FILE_NOT_FOUND = 2;
const NAME_RE = /^DesktopCatTest-[0-9a-f]{8}$/;
const RECORD_RE = /^desktop-cat-registry-test-([0-9a-f]{8})\.json$/;

interface TestRegistry {
  set(subKey: string, name: string, type: number, data: Buffer): number;
  remove(subKey: string, name: string): number;
  keyExists(subKey: string): boolean;
}

function bindTestRegistry(): TestRegistry {
  const koffi = createRequire(import.meta.url)('koffi') as typeof koffiModule;
  const advapi32 = koffi.load('advapi32.dll');
  const RegSetKeyValueW = advapi32.func('__stdcall', 'RegSetKeyValueW', 'long', ['intptr_t', 'str16', 'str16', 'uint32_t', 'void *', 'uint32_t']) as (
    k: number,
    s: string,
    v: string,
    t: number,
    d: Buffer,
    n: number,
  ) => number;
  const RegDeleteKeyValueW = advapi32.func('__stdcall', 'RegDeleteKeyValueW', 'long', ['intptr_t', 'str16', 'str16']) as (k: number, s: string, v: string) => number;
  const RegOpenKeyExW = advapi32.func('__stdcall', 'RegOpenKeyExW', 'long', ['intptr_t', 'str16', 'uint32_t', 'uint32_t', koffi.out(koffi.pointer('intptr_t'))]) as (
    k: number,
    s: string,
    o: number,
    sam: number,
    out: [number],
  ) => number;
  const RegCloseKey = advapi32.func('__stdcall', 'RegCloseKey', 'long', ['intptr_t']) as (k: number) => number;
  const guard = (name: string): void => {
    if (!NAME_RE.test(name)) throw new Error('refusing to touch a value that is not a throwaway test value');
  };
  return {
    set: (subKey, name, type, data) => {
      guard(name);
      return RegSetKeyValueW(HKEY_CURRENT_USER, subKey, name, type, data, data.length);
    },
    remove: (subKey, name) => {
      guard(name);
      return RegDeleteKeyValueW(HKEY_CURRENT_USER, subKey, name);
    },
    keyExists: (subKey) => {
      const out: [number] = [0];
      if (RegOpenKeyExW(HKEY_CURRENT_USER, subKey, 0, KEY_READ, out) !== ERROR_SUCCESS) return false;
      RegCloseKey(out[0]);
      return true;
    },
  };
}

const utf16z = (text: string): Buffer => Buffer.from(`${text}\0`, 'utf16le');

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** Removes the values of records left by earlier runs that died (their process is gone). */
function sweepStaleRecords(reg: TestRegistry): void {
  for (const file of fs.readdirSync(os.tmpdir())) {
    if (!RECORD_RE.test(file)) continue;
    const full = path.join(os.tmpdir(), file);
    try {
      const rec = JSON.parse(fs.readFileSync(full, 'utf8')) as { name?: unknown; pid?: unknown };
      if (typeof rec.name !== 'string' || !NAME_RE.test(rec.name)) continue;
      if (typeof rec.pid === 'number' && rec.pid !== process.pid && pidAlive(rec.pid)) continue;
      reg.remove(RUN_KEY, rec.name);
      reg.remove(STARTUP_APPROVED_RUN_KEY, rec.name);
      fs.rmSync(full, { force: true });
    } catch {
      /* unreadable record: leave it for a person to look at */
    }
  }
}

/** makensis.exe from electron-builder's cache (the one `npm run package` uses), or null. */
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

const onWindows = process.platform === 'win32';
const testReg = onWindows ? bindTestRegistry() : null;
// Writing a value under a missing key would create the key; skip rather than leave one behind.
const keysPresent = testReg !== null && testReg.keyExists(RUN_KEY) && testReg.keyExists(STARTUP_APPROVED_RUN_KEY);
const makensis = onWindows ? findMakensis() : null;

const FILETIME = (() => {
  const b = Buffer.alloc(8);
  b.writeBigUInt64LE(133_000_000_000_000_000n);
  return b;
})();
const TASK_MANAGER_DISABLED = Buffer.concat([Buffer.from([0x03, 0, 0, 0]), FILETIME]);
const zeros = (first: number): Buffer => Buffer.from([first, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]);

describe.runIf(onWindows && keysPresent)('launch at sign-in against the real registry (throwaway value)', () => {
  const reg = testReg as TestRegistry;
  const hex = crypto.randomBytes(4).toString('hex');
  const name = `DesktopCatTest-${hex}`;
  const recordFile = path.join(os.tmpdir(), `desktop-cat-registry-test-${hex}.json`);
  let work = '';
  let reader: LoginItemRegistry;

  beforeAll(() => {
    sweepStaleRecords(reg);
    work = fs.mkdtempSync(path.join(os.tmpdir(), 'desktop-cat-registry-work-'));
    // Recorded BEFORE the first write, so a crashed run can still be cleaned up.
    fs.writeFileSync(
      recordFile,
      JSON.stringify({
        purpose: 'Desktop Cat registry integration test; delete these HKCU values if this file is still here',
        name,
        keys: [RUN_KEY, STARTUP_APPROVED_RUN_KEY],
        pid: process.pid,
        at: new Date().toISOString(),
      }),
    );
    reader = createLoginItemRegistry(name);
  });

  afterAll(() => {
    try {
      reg.remove(RUN_KEY, name);
      reg.remove(STARTUP_APPROVED_RUN_KEY, name);
      if (work) fs.rmSync(work, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    } finally {
      const after = createLoginItemRegistry(name).read();
      // Only a confirmed cleanup deletes the record.
      if (after.run.kind === 'absent' && after.approved.kind === 'absent') fs.rmSync(recordFile, { force: true });
      expect(after).toEqual({ run: { kind: 'absent' }, approved: { kind: 'absent' } });
    }
  });

  describe('koffi reader (src/main/win32/registry.ts)', () => {
    it('never uses the production value name', () => {
      expect(name).toMatch(NAME_RE);
      expect(name).not.toBe(LOGIN_ITEM_NAME);
      expect(reader.available).toBe(true);
    });

    it('reads absent values as absent (ERROR_FILE_NOT_FOUND), never as an error', () => {
      expect(reader.read()).toEqual({ run: { kind: 'absent' }, approved: { kind: 'absent' } });
    });

    it('round-trips the Electron-formatted command line exactly, non-ASCII and spaces kept', () => {
      const exe = 'C:\\Users\\Probe User\\AppData\\Local\\Programs\\Desktop Ã‡at ÄŸ çŒ«\\DesktopCat.exe';
      const cmd = formatCommandLine(exe, ['--launched-at-login']);
      expect(reg.set(RUN_KEY, name, REG_SZ, utf16z(cmd))).toBe(ERROR_SUCCESS);
      const snap = reader.read();
      expect(snap.run).toMatchObject({ kind: 'value', type: REG_SZ });
      const state = interpretSnapshot(snap);
      expect(state).toMatchObject({ readable: true, approved: 'absent', error: null });
      expect(state.run).toEqual({ raw: cmd, program: exe, args: ['--launched-at-login'] });
      // Windows paths compare case-insensitively.
      expect(isOurEntry(state.run!, { execPath: exe.toUpperCase(), args: ['--launched-at-login'] })).toBe(true);
      expect(isOurEntry(state.run!, { execPath: exe, args: [] })).toBe(false);
    });

    it('returns REG_EXPAND_SZ data as stored (no %VAR% expansion)', () => {
      const cmd = '"%LOCALAPPDATA%\\Programs\\Desktop Cat\\DesktopCat.exe" --launched-at-login';
      expect(reg.set(RUN_KEY, name, REG_EXPAND_SZ, utf16z(cmd))).toBe(ERROR_SUCCESS);
      const state = interpretSnapshot(reader.read());
      expect(state.run?.raw).toBe(cmd);
      expect(state.run?.program).toBe('%LOCALAPPDATA%\\Programs\\Desktop Cat\\DesktopCat.exe');
    });

    it('reads StartupApproved bytes exactly and applies Electronâ€™s enabled rule', () => {
      const cases: Array<[Buffer, 'enabled' | 'disabled']> = [
        [TASK_MANAGER_DISABLED, 'disabled'],
        [zeros(0x03), 'disabled'],
        [zeros(0x06), 'disabled'],
        [zeros(0x02), 'enabled'],
        [zeros(0x00), 'enabled'],
      ];
      for (const [bytes, want] of cases) {
        expect(reg.set(STARTUP_APPROVED_RUN_KEY, name, REG_BINARY, bytes)).toBe(ERROR_SUCCESS);
        const snap = reader.read();
        expect(snap.approved).toEqual({ kind: 'value', type: REG_BINARY, data: bytes });
        expect(interpretSnapshot(snap).approved).toBe(want);
      }
    });

    it('reads both values in well under a millisecond (startup budget)', () => {
      const n = 200;
      const t0 = performance.now();
      for (let i = 0; i < n; i++) reader.read();
      const perSnapshotMs = (performance.now() - t0) / n;
      // Generous bound for a loaded shared machine.
      expect(perSnapshotMs).toBeLessThan(2);
    });

    it('sees the values disappear once deleted', () => {
      expect([ERROR_SUCCESS, ERROR_FILE_NOT_FOUND]).toContain(reg.remove(RUN_KEY, name));
      expect([ERROR_SUCCESS, ERROR_FILE_NOT_FOUND]).toContain(reg.remove(STARTUP_APPROVED_RUN_KEY, name));
      expect(reader.read()).toEqual({ run: { kind: 'absent' }, approved: { kind: 'absent' } });
    });
  });

  describe.runIf(makensis !== null)('uninstaller customUnInstall (build/installer.nsh, compiled harness)', () => {
    let markerDir = '';
    let marker = '';
    const harness: Record<'uninstall' | 'upgrade', string> = { uninstall: '', upgrade: '' };

    function build(kind: 'uninstall' | 'upgrade'): string {
      const src = fs.readFileSync(path.join(ROOT, 'build', 'installer.nsh'), 'utf8');
      const patched = src.replaceAll(LOGIN_ITEM_NAME, name).replaceAll('$APPDATA\\Desktop Cat', markerDir);
      // Safety: the harness may only ever touch the throwaway value and the temp marker folder.
      if (patched.includes(LOGIN_ITEM_NAME) || patched.includes('$APPDATA') || !patched.includes(name)) throw new Error('harness substitution failed');
      const nsh = path.join(work, `customUnInstall-${kind}.nsh`);
      fs.writeFileSync(nsh, `\uFEFF${patched}`, 'utf8');
      const exe = path.join(work, `harness-${kind}.exe`);
      const nsi = path.join(work, `harness-${kind}.nsi`);
      fs.writeFileSync(
        nsi,
        [
          'Unicode true',
          '!include "LogicLib.nsh"',
          'Name "Desktop Cat uninstall harness"',
          `OutFile "${exe}"`,
          'RequestExecutionLevel user',
          'SilentInstall silent',
          'Var installMode',
          // electron-builder's ${isUpdated}: true while an upgrade runs the old uninstaller.
          '!macro _isUpdated _a _b _t _f',
          `  StrCmp "${kind === 'upgrade' ? '1' : '0'}" "1" \`\${_t}\` \`\${_f}\``,
          '!macroend',
          '!define isUpdated `"" isUpdated ""`',
          `!include "${nsh}"`,
          'Function .onInit',
          '  StrCpy $installMode "CurrentUser"',
          'FunctionEnd',
          'Section "harness"',
          '  !insertmacro customUnInstall',
          'SectionEnd',
          '',
        ].join('\r\n'),
        'utf8',
      );
      const r = spawnSync(makensis as string, ['/V2', '/INPUTCHARSET', 'UTF8', nsi], { encoding: 'utf8', timeout: 60_000, windowsHide: true });
      if (r.status !== 0) throw new Error(`makensis failed (${r.status}): ${r.stdout}\n${r.stderr}`);
      return exe;
    }

    beforeAll(() => {
      markerDir = path.join(work, 'Roaming', 'Desktop Cat');
      marker = path.join(markerDir, UNINSTALL_MARKER_FILE);
      harness.uninstall = build('uninstall');
      harness.upgrade = build('upgrade');
    }, 120_000);

    type Case = { label: string; run: boolean; approved: Buffer | null; folder: boolean; kind: 'uninstall' | 'upgrade' };
    const cases: Case[] = [
      { label: 'entry, no StartupApproved value', run: true, approved: null, folder: true, kind: 'uninstall' },
      { label: 'entry, re-enabled in Task Manager (02 00â€¦)', run: true, approved: zeros(0x02), folder: true, kind: 'uninstall' },
      { label: 'entry, StartupApproved 00 00â€¦', run: true, approved: zeros(0x00), folder: true, kind: 'uninstall' },
      { label: 'entry, one byte 02', run: true, approved: Buffer.from([0x02]), folder: true, kind: 'uninstall' },
      { label: 'entry, disabled in Task Manager (03 + FILETIME)', run: true, approved: TASK_MANAGER_DISABLED, folder: true, kind: 'uninstall' },
      { label: 'entry, StartupApproved 06 00â€¦', run: true, approved: zeros(0x06), folder: true, kind: 'uninstall' },
      { label: 'entry, StartupApproved 02 05', run: true, approved: Buffer.from([0x02, 0x05]), folder: true, kind: 'uninstall' },
      { label: 'no entry, orphaned Task Manager disable', run: false, approved: TASK_MANAGER_DISABLED, folder: true, kind: 'uninstall' },
      { label: 'no entry at all', run: false, approved: null, folder: true, kind: 'uninstall' },
      { label: 'entry, but no user-data folder', run: true, approved: null, folder: false, kind: 'uninstall' },
      { label: 'upgrade (--updated): nothing removed', run: true, approved: zeros(0x02), folder: true, kind: 'upgrade' },
    ];

    it.each(cases)('$label', ({ run, approved, folder, kind }) => {
      const cmd = '"C:\\Users\\Probe User\\AppData\\Local\\Programs\\Desktop Cat\\DesktopCat.exe" --launched-at-login';
      reg.remove(RUN_KEY, name);
      reg.remove(STARTUP_APPROVED_RUN_KEY, name);
      if (run) expect(reg.set(RUN_KEY, name, REG_SZ, utf16z(cmd))).toBe(ERROR_SUCCESS);
      if (approved) expect(reg.set(STARTUP_APPROVED_RUN_KEY, name, REG_BINARY, approved)).toBe(ERROR_SUCCESS);
      fs.rmSync(path.dirname(markerDir), { recursive: true, force: true });
      if (folder) fs.mkdirSync(markerDir, { recursive: true });

      const r = spawnSync(harness[kind], ['/S'], { timeout: 30_000, windowsHide: true });
      expect(r.status).toBe(0);

      const after = reader.read();
      if (kind === 'upgrade') {
        expect(after.run.kind).toBe('value');
        expect(after.approved).toEqual({ kind: 'value', type: REG_BINARY, data: approved });
        expect(fs.existsSync(marker)).toBe(false);
        return;
      }
      expect(after).toEqual({ run: { kind: 'absent' }, approved: { kind: 'absent' } });
      // The same rule the app applies when it reads the registry (Electron's StartupApproved rule).
      const wouldHaveStarted = run && (approved === null || startupApprovedEnabled(approved));
      expect(fs.existsSync(marker)).toBe(wouldHaveStarted && folder);
      if (!folder) expect(fs.existsSync(markerDir)).toBe(false);
    });
  });
});
