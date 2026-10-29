// Read-only access to the two HKCU values behind "Start with Windows": our value under
// ...\CurrentVersion\Run and its twin under ...\Explorer\StartupApproved\Run (where Task
// Manager › Startup apps records a disable). Only the one value name passed in is ever
// read; the keys are never enumerated. Writes go through Electron's setLoginItemSettings.
//
// advapi32 is bound here with its own koffi library handle (native.ts stays untouched).
// Same koffi rules as native.ts: no global type names, primitive signatures only, output
// buffers are Node Buffers. koffi 3.3.4 round-trip VERIFIED (docs/research/v1.1/startup.md).
import type koffiModule from 'koffi';

type Koffi = typeof koffiModule;

export const RUN_KEY = 'Software\\Microsoft\\Windows\\CurrentVersion\\Run';
export const STARTUP_APPROVED_RUN_KEY = 'Software\\Microsoft\\Windows\\CurrentVersion\\Explorer\\StartupApproved\\Run';

/** HKEY_CURRENT_USER = (HKEY)(ULONG_PTR)(LONG)0x80000001, sign-extended on x64. */
const HKEY_CURRENT_USER = -2147483647;
const RRF_RT_ANY = 0x0000ffff;
/** Return REG_EXPAND_SZ data as stored (no %VAR% expansion). */
const RRF_NOEXPAND = 0x10000000;
const ERROR_SUCCESS = 0;
const ERROR_FILE_NOT_FOUND = 2;
const ERROR_MORE_DATA = 234;
/** Values larger than this are not ours (a Run command line is at most 260 chars). */
const MAX_VALUE_BYTES = 64 * 1024;
const READ_ATTEMPTS = 3;

export type RegistryRead =
  | { kind: 'absent' }
  | { kind: 'value'; type: number; data: Buffer }
  /** Win32 error code, or a short description when the API itself failed. */
  | { kind: 'error'; code: number | string };

export interface LoginRegistrySnapshot {
  run: RegistryRead;
  approved: RegistryRead;
}

export interface LoginItemRegistry {
  readonly available: boolean;
  /** Reads both values now. Never throws. */
  read(): LoginRegistrySnapshot;
}

type RegGetValueFn = (hkey: number, subKey: string, value: string, flags: number, type: [number], data: Buffer | null, size: [number]) => number;

let memo: { fn: RegGetValueFn } | { error: string } | null = null;

function bindRegGetValue(): RegGetValueFn {
  if (memo === null) {
    try {
      if (process.platform !== 'win32') throw new Error(`the registry is not available on ${process.platform}`);
      // Lazy require: a missing koffi binary degrades to "unavailable" instead of crashing main.
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const koffi = require('koffi') as Koffi;
      const advapi32 = koffi.load('advapi32.dll');
      const fn = advapi32.func(
        'RegGetValueW',
        'long',
        ['intptr_t', 'str16', 'str16', 'uint32_t', koffi.out(koffi.pointer('uint32_t')), 'void *', koffi.inout(koffi.pointer('uint32_t'))],
      ) as RegGetValueFn;
      memo = { fn };
    } catch (err) {
      memo = { error: err instanceof Error ? err.message : String(err) };
    }
  }
  if ('error' in memo) throw new Error(memo.error);
  return memo.fn;
}

/** Two-call RegGetValueW (size, then data), retried if the value grows in between. */
function readValue(fn: RegGetValueFn, subKey: string, valueName: string): RegistryRead {
  const flags = RRF_RT_ANY | RRF_NOEXPAND;
  for (let attempt = 0; attempt < READ_ATTEMPTS; attempt++) {
    const type: [number] = [0];
    const size: [number] = [0];
    const probe = fn(HKEY_CURRENT_USER, subKey, valueName, flags, type, null, size);
    if (probe === ERROR_FILE_NOT_FOUND) return { kind: 'absent' };
    if (probe !== ERROR_SUCCESS) return { kind: 'error', code: probe };
    if (size[0] > MAX_VALUE_BYTES) return { kind: 'error', code: 'value too large' };
    const data = Buffer.alloc(Math.max(size[0], 2));
    const got: [number] = [data.length];
    const r = fn(HKEY_CURRENT_USER, subKey, valueName, flags, type, data, got);
    if (r === ERROR_MORE_DATA) continue;
    if (r === ERROR_FILE_NOT_FOUND) return { kind: 'absent' };
    if (r !== ERROR_SUCCESS) return { kind: 'error', code: r };
    return { kind: 'value', type: type[0], data: data.subarray(0, Math.min(got[0], data.length)) };
  }
  return { kind: 'error', code: ERROR_MORE_DATA };
}

/**
 * Reader for `valueName` (production: LOGIN_ITEM_NAME; tests pass a unique throwaway name).
 * When koffi or advapi32 cannot be loaded, `available` is false and every read reports an error.
 */
export function createLoginItemRegistry(valueName: string): LoginItemRegistry {
  if (valueName.length === 0 || valueName.length > 255 || /[\\\0]/.test(valueName)) throw new Error('invalid registry value name');
  let fn: RegGetValueFn | null = null;
  let loadError: string | null = null;
  try {
    fn = bindRegGetValue();
  } catch (err) {
    loadError = err instanceof Error ? err.message : String(err);
  }
  const read = (subKey: string): RegistryRead => {
    if (!fn) return { kind: 'error', code: loadError ?? 'unavailable' };
    try {
      return readValue(fn, subKey, valueName);
    } catch (err) {
      return { kind: 'error', code: err instanceof Error ? err.message : String(err) };
    }
  };
  return {
    available: fn !== null,
    read: () => ({ run: read(RUN_KEY), approved: read(STARTUP_APPROVED_RUN_KEY) }),
  };
}
