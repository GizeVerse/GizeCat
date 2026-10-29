// FakeWindowsLogin: an in-memory HKCU Run + StartupApproved\Run pair behind a port of
// Electron 44.9.3's setLoginItemSettings / getLoginItemSettings (shell/browser/browser_win.cc),
// so tests exercise the same quoting, StartupApproved deletion and 03-write as the real API.
// The getter is ported only to pin why the app does not use it (v1's isActive bug).
import { applySettingsPatch, migrateSettings, type PatchResult, type Settings, type SettingsPatch } from '../../../src/shared/settings';
import { LOGIN_ITEM_NAME, type LoginItemFs, type LoginItemWriter } from '../../../src/main/lifecycle/loginItem';
import { formatCommandLine, parseCommandLine, REG_BINARY, REG_SZ, samePath } from '../../../src/main/lifecycle/loginItemCommandLine';
import type { LoginItemRegistry, LoginRegistrySnapshot, RegistryRead } from '../../../src/main/win32/registry';

export const DISABLE_BYTES = [0x03, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0];
/** What Task Manager writes when the user disables an entry: 03 00 00 00 + FILETIME. */
export const TASK_MANAGER_DISABLED = [0x03, 0, 0, 0, 0x10, 0x32, 0x54, 0x76, 0x98, 0xba, 0xdc, 0x01];
/** What Task Manager writes when the user enables it again. */
export const TASK_MANAGER_ENABLED = [0x02, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0];

interface StoredValue {
  type: number;
  data: Buffer;
}

export type SetSettings = Parameters<LoginItemWriter['setLoginItemSettings']>[0];
type ElectronSetSettings = { openAtLogin?: boolean; path?: string; args?: string[]; name?: string; enabled?: boolean };

const utf16z = (text: string): Buffer => Buffer.from(`${text}\0`, 'utf16le');

export class FakeWindowsLogin implements LoginItemWriter {
  readonly run = new Map<string, StoredValue>();
  readonly approved = new Map<string, StoredValue>();
  readonly writes: SetSettings[] = [];
  /** 'throw': setLoginItemSettings throws; 'ignore': it returns without changing anything. */
  failWrites: 'throw' | 'ignore' | null = null;
  /** Win32 error code returned for every read (e.g. 5 = access denied), or null. */
  readError: number | null = null;

  constructor(
    /** Electron's default value name (the AppUserModelID set by index.ts). */
    readonly aumid = LOGIN_ITEM_NAME,
    readonly processExecPath = 'C:\\fake\\DesktopCat.exe',
  ) {}

  // -- Electron's app.setLoginItemSettings ------------------------------------------------

  setLoginItemSettings(s: ElectronSetSettings): void {
    this.writes.push(s as SetSettings);
    if (this.failWrites === 'throw') throw new Error('simulated registry failure');
    if (this.failWrites === 'ignore') return;
    const name = s.name && s.name.length > 0 ? s.name : this.aumid;
    if (s.openAtLogin) {
      this.run.set(name, { type: REG_SZ, data: utf16z(formatCommandLine(s.path ?? this.processExecPath, s.args ?? [])) });
      if (s.enabled ?? true) this.approved.delete(name);
      else this.approved.set(name, { type: REG_BINARY, data: Buffer.from(DISABLE_BYTES) });
    } else {
      this.approved.delete(name);
      this.run.delete(name);
    }
  }

  // -- Electron's app.getLoginItemSettings (HKCU only; HKLM is not modelled) ---------------

  getLoginItemSettings(options: { path?: string; args?: string[] } = {}): {
    openAtLogin: boolean;
    executableWillLaunchAtLogin: boolean;
    launchItems: Array<{ name: string; path: string; args: string[]; scope: 'user'; enabled: boolean }>;
  } {
    let openAtLogin = false;
    const own = this.runText(this.aumid);
    if (own !== null) openAtLogin = own === formatCommandLine(options.path ?? this.processExecPath, options.args ?? []);
    const lookup = parseCommandLine(options.path ?? this.processExecPath)[0] ?? '';
    const launchItems: Array<{ name: string; path: string; args: string[]; scope: 'user'; enabled: boolean }> = [];
    let executableWillLaunchAtLogin = false;
    if (lookup !== '') {
      for (const name of this.run.keys()) {
        const [program = '', ...rest] = parseCommandLine(this.runText(name) ?? '');
        if (!samePath(program, lookup)) continue;
        const enabled = this.electronApprovedEnabled(name);
        // Chromium's CommandLine::GetArgs leaves out switches.
        launchItems.push({ name, path: program, args: rest.filter((a) => !a.startsWith('-') && !a.startsWith('/')), scope: 'user', enabled });
        executableWillLaunchAtLogin ||= enabled;
      }
    }
    return { openAtLogin, executableWillLaunchAtLogin, launchItems };
  }

  /** Electron reads at most 24 bytes; REG_BINARY data is compared as a C string to "" or "\x02". */
  private electronApprovedEnabled(name: string): boolean {
    const v = this.approved.get(name);
    if (!v || v.type !== REG_BINARY || v.data.length > 24) return true;
    const end = v.data.indexOf(0);
    const cstr = v.data.subarray(0, end === -1 ? v.data.length : end);
    return cstr.length === 0 || (cstr.length === 1 && cstr[0] === 0x02);
  }

  // -- Registry reader (what win32/registry.ts returns) -----------------------------------

  readerFor(valueName = LOGIN_ITEM_NAME): LoginItemRegistry {
    const read = (map: Map<string, StoredValue>): RegistryRead => {
      if (this.readError !== null) return { kind: 'error', code: this.readError };
      const v = map.get(valueName);
      return v ? { kind: 'value', type: v.type, data: Buffer.from(v.data) } : { kind: 'absent' };
    };
    return { available: true, read: (): LoginRegistrySnapshot => ({ run: read(this.run), approved: read(this.approved) }) };
  }

  // -- Outside actors --------------------------------------------------------------------

  runText(name = LOGIN_ITEM_NAME): string | null {
    const v = this.run.get(name);
    return v ? v.data.toString('utf16le').replace(/\0+$/, '') : null;
  }

  approvedHex(name = LOGIN_ITEM_NAME): string | null {
    return this.approved.get(name)?.data.toString('hex') ?? null;
  }

  setRunText(text: string, name = LOGIN_ITEM_NAME): void {
    this.run.set(name, { type: REG_SZ, data: utf16z(text) });
  }

  setApproved(bytes: readonly number[], name = LOGIN_ITEM_NAME, type = REG_BINARY): void {
    this.approved.set(name, { type, data: Buffer.from(bytes) });
  }

  taskManagerDisable(name = LOGIN_ITEM_NAME): void {
    this.setApproved(TASK_MANAGER_DISABLED, name);
  }

  taskManagerEnable(name = LOGIN_ITEM_NAME): void {
    this.setApproved(TASK_MANAGER_ENABLED, name);
  }

  /** Autoruns / CCleaner style removal of the Run value only. */
  deleteRun(name = LOGIN_ITEM_NAME): void {
    this.run.delete(name);
  }

  /**
   * build/installer.nsh customUnInstall on a real uninstall: the marker is written only for an
   * entry that existed and that Startup apps never toggled; then both values are deleted.
   */
  uninstall(name = LOGIN_ITEM_NAME): boolean {
    const marker = this.run.has(name) && !this.approved.has(name);
    this.run.delete(name);
    this.approved.delete(name);
    return marker;
  }
}

/** Settings store stand-in with the real patch validation. */
export function memorySettings(initial: Settings = migrateSettings({})) {
  let current = initial;
  const patches: SettingsPatch[] = [];
  return {
    patches,
    get: (): Settings => current,
    patch(p: SettingsPatch): PatchResult {
      patches.push(p);
      const r = applySettingsPatch(current, p);
      if (r.ok) current = r.settings;
      return r;
    },
    set(s: Settings): void {
      current = s;
    },
  };
}

/** In-memory file system for the uninstall marker and log files. */
export function memoryFs(files: Record<string, string> = {}): LoginItemFs & { files: Map<string, string> } {
  const map = new Map(Object.entries(files).map(([k, v]) => [k.toLowerCase(), v]));
  const key = (p: string): string => p.toLowerCase();
  return {
    files: map,
    existsSync: (p) => map.has(key(p)),
    rmSync: (p) => {
      map.delete(key(p));
    },
    readdirSync: (dir) => {
      const prefix = `${key(dir)}\\`;
      return [...map.keys()].filter((k) => k.startsWith(prefix) && !k.slice(prefix.length).includes('\\')).map((k) => k.slice(prefix.length));
    },
    readFileSync: (p) => {
      const v = map.get(key(p));
      if (v === undefined) throw Object.assign(new Error(`ENOENT: ${p}`), { code: 'ENOENT' });
      return v;
    },
    statSync: (p) => {
      const v = map.get(key(p));
      if (v === undefined) throw Object.assign(new Error(`ENOENT: ${p}`), { code: 'ENOENT' });
      return { size: Buffer.byteLength(v), isFile: () => true };
    },
  };
}

/** Deterministic PRNG (mulberry32) for property tests. */
export function seededRandom(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
