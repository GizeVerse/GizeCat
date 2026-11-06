// The only file that touches koffi. Exposes typed, data-only wrappers over the
// Win32 calls this module needs. Loading is lazy and memoised per process.
//
// Research constraints honoured here (docs/research/win32-koffi.md):
// - Win32 BOOL is declared as 'int' (4 bytes), never koffi's 1-byte 'bool'.
// - Pointers are BigInt in koffi 3; NULL comes back as null.
// - Output buffers are Node Buffers decoded as UTF-16LE (koffi.view is disallowed in Electron).
// - No global koffi type names (koffi's registry is process-wide; other modules may load it too):
//   structs/prototypes are anonymous type objects, signatures use primitive types only.
import type koffiModule from 'koffi';
import type { LibraryHandle, TypeObject } from 'koffi';

type Koffi = typeof koffiModule;

// The data-only shapes live in nativeTypes.ts (no koffi, no Node typings); re-exported here.
import type { Hwnd, RawRect, Win32Native } from './nativeTypes';
export type { Hwnd, RawRect, Win32Native, WinEventProc } from './nativeTypes';

/**
 * Shell and taskbar bindings (v1.1), bound together with Win32Native. A separate interface so
 * existing Win32Native implementations stay valid. Class names only: never window titles.
 */
export interface ShellNative {
  /** FindWindowW(className, NULL): the first top-level window of the class. */
  findWindow(className: string): Hwnd | null;
  /** FindWindowExW(NULL, after, className, NULL): the next top-level window of the class after `after` (null: the first). */
  findNextWindow(className: string, after: Hwnd | null): Hwnd | null;
  /** SHAppBarMessage(ABM_GETSTATE): ABS_* bits. Cross-process call to Explorer: never per tick. */
  appBarGetState(): number;
  /** SHAppBarMessage(ABM_GETTASKBARPOS): the primary taskbar's docked rect (also while auto-hidden) and ABE_* edge; null on failure. */
  appBarGetTaskbarPos(): { edge: number; rect: RawRect } | null;
  /** SetPropW with an integer value; false on failure. */
  setProp(h: Hwnd, name: string, value: number): boolean;
  /** RemovePropW: the removed value (0 when the property was absent or the call failed). */
  removeProp(h: Hwnd, name: string): number;
  /** RegisterWindowMessageW: a message id (0xC000..0xFFFF), or 0 on failure. */
  registerWindowMessage(name: string): number;
}

/** A koffi pointer type as resolved at binding time (unit-tested: anonymous-name clashes turn struct pointers into callbacks). */
export interface NativeTypeInfo {
  name: string;
  /** koffi's (anonymous) name of the pointee type: must be unique per type. */
  typeName: string;
  kind: 'struct-pointer' | 'callback-pointer';
  primitive: string;
  /** sizeof the pointee (0 for callbacks). */
  size: number;
  offsets?: Record<string, number>;
}

let shellMemo: { shell: ShellNative } | { error: Error } | null = null;
let typeReport: NativeTypeInfo[] = [];

/** The shell/taskbar bindings. Loads Win32Native first; throws when either is unavailable. */
export function loadShellNative(): ShellNative {
  loadWin32Native();
  if (shellMemo === null) throw new Error('shell bindings were not bound');
  if ('error' in shellMemo) throw shellMemo.error;
  return shellMemo.shell;
}

/** How koffi resolved every pointer type bound in this process (empty before loading). */
export function nativeTypeReport(): readonly NativeTypeInfo[] {
  return typeReport;
}

const MAX_ENUM_WINDOWS = 4096;
const MAX_TITLE_CHARS = 1024;

let memo: { native: Win32Native } | { error: Error } | null = null;

/** Loads koffi and the Win32 DLLs once per process. Throws if anything is missing. */
export function loadWin32Native(): Win32Native {
  if (memo === null) {
    try {
      memo = { native: bind() };
    } catch (e) {
      memo = { error: e instanceof Error ? e : new Error(String(e)) };
    }
  }
  if ('error' in memo) throw memo.error;
  return memo.native;
}

type Fn<A extends unknown[], R> = (...args: A) => R;
type Cell = [number];
type MonitorInfo = { cbSize: number; rcMonitor: Partial<RawRect>; rcWork: Partial<RawRect>; dwFlags: number };

function bind(): Win32Native {
  if (process.platform !== 'win32') throw new Error(`Win32 is not available on ${process.platform}`);
  // Lazy require so a missing native binary degrades to the fallback API instead of crashing main.
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const koffi = require('koffi') as Koffi;

  const user32 = koffi.load('user32.dll');
  const kernel32 = koffi.load('kernel32.dll');
  const dwmapi = koffi.load('dwmapi.dll');
  const shell32 = koffi.load('shell32.dll');

  const RECT = koffi.struct({ left: 'int32_t', top: 'int32_t', right: 'int32_t', bottom: 'int32_t' });
  const POINT = koffi.struct({ x: 'int32_t', y: 'int32_t' });
  const MONITORINFO = koffi.struct({ cbSize: 'uint32_t', rcMonitor: RECT, rcWork: RECT, dwFlags: 'uint32_t' });
  const LASTINPUTINFO = koffi.struct({ cbSize: 'uint32_t', dwTime: 'uint32_t' });
  const WINEVENTPROC = koffi.proto('__stdcall', null, 'void', ['void *', 'uint32_t', 'void *', 'int32_t', 'int32_t', 'uint32_t', 'uint32_t']);
  const WNDENUMPROC = koffi.proto('__stdcall', null, 'int', ['void *', 'intptr_t']);

  // koffi functions are untyped ((...args: any[]) => any); these give each one a precise signature.
  const s = <A extends unknown[], R>(lib: LibraryHandle, def: string): Fn<A, R> => lib.func(def);
  const c = <A extends unknown[], R>(lib: LibraryHandle, name: string, ret: TypeObject | string, args: Parameters<typeof koffi.out>[0][]): Fn<A, R> =>
    lib.func('__stdcall', name, ret, args);
  const outPtr = (t: TypeObject) => koffi.out(koffi.pointer(t));
  const inoutPtr = (t: TypeObject) => koffi.inout(koffi.pointer(t));

  const GetCursorPos = c<[Partial<{ x: number; y: number }>], number>(user32, 'GetCursorPos', 'int', [outPtr(POINT)]);
  const GetLastInputInfo = c<[{ cbSize: number; dwTime: number }], number>(user32, 'GetLastInputInfo', 'int', [inoutPtr(LASTINPUTINFO)]);
  const GetTickCount = s<[], number>(kernel32, 'uint32_t __stdcall GetTickCount()');
  const GetAsyncKeyState = s<[number], number>(user32, 'int16_t __stdcall GetAsyncKeyState(int vk)');
  const GetSystemMetrics = s<[number], number>(user32, 'int __stdcall GetSystemMetrics(int index)');
  const GetForegroundWindow = s<[], Hwnd | null>(user32, 'void * __stdcall GetForegroundWindow()');
  const GetAncestor = s<[Hwnd, number], Hwnd | null>(user32, 'void * __stdcall GetAncestor(void *h, uint32_t flags)');
  const GetWindow = s<[Hwnd, number], Hwnd | null>(user32, 'void * __stdcall GetWindow(void *h, uint32_t cmd)');
  const GetWindowThreadProcessId = s<[Hwnd, Cell], number>(user32, 'uint32_t __stdcall GetWindowThreadProcessId(void *h, _Out_ uint32_t *pid)');
  const OpenProcess = s<[number, number, number], bigint | null>(kernel32, 'void * __stdcall OpenProcess(uint32_t access, int inherit, uint32_t pid)');
  const QueryFullProcessImageNameW = s<[bigint, number, Buffer, Cell], number>(
    kernel32,
    'int __stdcall QueryFullProcessImageNameW(void *h, uint32_t flags, void *buf, _Inout_ uint32_t *size)',
  );
  const CloseHandle = s<[bigint], number>(kernel32, 'int __stdcall CloseHandle(void *h)');
  const GetWindowTextLengthW = s<[Hwnd], number>(user32, 'int __stdcall GetWindowTextLengthW(void *h)');
  const GetWindowTextW = s<[Hwnd, Buffer, number], number>(user32, 'int __stdcall GetWindowTextW(void *h, void *buf, int max)');
  const GetClassNameW = s<[Hwnd, Buffer, number], number>(user32, 'int __stdcall GetClassNameW(void *h, void *buf, int max)');
  const IsWindow = s<[Hwnd], number>(user32, 'int __stdcall IsWindow(void *h)');
  const IsWindowVisible = s<[Hwnd], number>(user32, 'int __stdcall IsWindowVisible(void *h)');
  const IsIconic = s<[Hwnd], number>(user32, 'int __stdcall IsIconic(void *h)');
  const IsZoomed = s<[Hwnd], number>(user32, 'int __stdcall IsZoomed(void *h)');
  const GetWindowLongPtrW = s<[Hwnd, number], number>(user32, 'intptr_t __stdcall GetWindowLongPtrW(void *h, int idx)');
  const GetWindowRect = c<[Hwnd, Partial<RawRect>], number>(user32, 'GetWindowRect', 'int', ['void *', outPtr(RECT)]);
  const DwmGetRect = c<[Hwnd, number, Partial<RawRect>, number], number>(dwmapi, 'DwmGetWindowAttribute', 'int32_t', [
    'void *',
    'uint32_t',
    outPtr(RECT),
    'uint32_t',
  ]);
  const DwmGetU32 = s<[Hwnd, number, Cell, number], number>(
    dwmapi,
    'int32_t __stdcall DwmGetWindowAttribute(void *h, uint32_t attr, _Out_ uint32_t *value, uint32_t size)',
  );
  const FindWindowExW = s<[Hwnd, null, string, null], Hwnd | null>(
    user32,
    'void * __stdcall FindWindowExW(void *parent, void *after, const char16_t *cls, const char16_t *title)',
  );
  const EnumWindows = c<[(h: Hwnd | null, lp: number) => number, number], number>(user32, 'EnumWindows', 'int', [
    koffi.pointer(WNDENUMPROC),
    'intptr_t',
  ]);
  const MonitorFromWindow = s<[Hwnd, number], bigint | null>(user32, 'void * __stdcall MonitorFromWindow(void *h, uint32_t flags)');
  const GetMonitorInfoW = c<[bigint, MonitorInfo], number>(user32, 'GetMonitorInfoW', 'int', ['void *', inoutPtr(MONITORINFO)]);
  const WindowFromPoint = c<[{ x: number; y: number }], Hwnd | null>(user32, 'WindowFromPoint', 'void *', [POINT]);
  const SHQueryUserNotificationState = s<[Cell], number>(shell32, 'int32_t __stdcall SHQueryUserNotificationState(_Out_ int32_t *state)');
  const SetWinEventHook = c<[number, number, null, bigint, number, number, number], bigint | null>(user32, 'SetWinEventHook', 'void *', [
    'uint32_t',
    'uint32_t',
    'void *',
    koffi.pointer(WINEVENTPROC),
    'uint32_t',
    'uint32_t',
    'uint32_t',
  ]);
  const UnhookWinEvent = s<[bigint], number>(user32, 'int __stdcall UnhookWinEvent(void *h)');

  // Windows 10 1607+; absent on older builds, which only affects the startup diagnostic.
  let getThreadDpiAwareness: () => number | null = () => null;
  try {
    const GetThreadDpiAwarenessContext = s<[], bigint | null>(user32, 'void * __stdcall GetThreadDpiAwarenessContext()');
    const GetAwarenessFromDpiAwarenessContext = s<[bigint | null], number>(user32, 'int __stdcall GetAwarenessFromDpiAwarenessContext(void *ctx)');
    getThreadDpiAwareness = () => GetAwarenessFromDpiAwarenessContext(GetThreadDpiAwarenessContext());
  } catch {
    /* keep the null-returning default */
  }

  const classBuf = Buffer.alloc(256 * 2);
  const pathBuf = Buffer.alloc(1024 * 2);

  const readRect = (r: Partial<RawRect>): RawRect | null => {
    const { left, top, right, bottom } = r;
    if (typeof left !== 'number' || typeof top !== 'number' || typeof right !== 'number' || typeof bottom !== 'number') return null;
    return { left, top, right, bottom };
  };

  const queryImagePath = (handle: bigint, buf: Buffer): string | null => {
    const size: Cell = [buf.length / 2];
    if (!QueryFullProcessImageNameW(handle, 0, buf, size)) return null;
    return buf.toString('utf16le', 0, size[0] * 2);
  };

  // v1.1 shell bindings: after every koffi.proto above (APPBARDATA has a pointer member; declared
  // before the protos, koffi 3.3.4 gives MONITORINFO and WNDENUMPROC the same anonymous type
  // name, docs/research/v1.1/taskbar.md pitfall 2). A failure here disables only ShellNative.
  let appBarData: TypeObject | null = null;
  try {
    const bound = bindShell(koffi, user32, shell32, RECT, readRect);
    shellMemo = { shell: bound.shell };
    appBarData = bound.APPBARDATA;
  } catch (e) {
    shellMemo = { error: e instanceof Error ? e : new Error(String(e)) };
  }
  try {
    typeReport = describePointerTypes(koffi, { RECT, POINT, MONITORINFO, LASTINPUTINFO, ...(appBarData ? { APPBARDATA: appBarData } : {}) }, { WINEVENTPROC, WNDENUMPROC });
  } catch {
    typeReport = []; // diagnostics only; an empty report fails its unit test
  }

  return {
    ownPid: process.pid,
    getCursorPos() {
      const p: Partial<{ x: number; y: number }> = {};
      if (!GetCursorPos(p) || typeof p.x !== 'number' || typeof p.y !== 'number') return null;
      return { x: p.x, y: p.y };
    },
    getLastInputTick() {
      const info = { cbSize: 8, dwTime: 0 };
      return GetLastInputInfo(info) ? info.dwTime : null;
    },
    getTickCount: () => GetTickCount(),
    getAsyncKeyState: (vk) => GetAsyncKeyState(vk),
    getSystemMetrics: (index) => GetSystemMetrics(index),
    getForegroundWindow: () => GetForegroundWindow(),
    getAncestor: (h, flags) => GetAncestor(h, flags),
    getWindow: (h, cmd) => GetWindow(h, cmd),
    getWindowProcessId(h) {
      const pid: Cell = [0];
      return GetWindowThreadProcessId(h, pid) === 0 ? 0 : pid[0];
    },
    getProcessImagePath(pid) {
      const handle = OpenProcess(0x1000 /* PROCESS_QUERY_LIMITED_INFORMATION */, 0, pid);
      if (handle === null) return null;
      try {
        // Long (\\?\) paths can exceed the reusable buffer; retry once with the documented maximum.
        return queryImagePath(handle, pathBuf) ?? queryImagePath(handle, Buffer.alloc(32768 * 2));
      } finally {
        CloseHandle(handle);
      }
    },
    getWindowText(h) {
      const len = Math.min(GetWindowTextLengthW(h), MAX_TITLE_CHARS);
      if (len <= 0) return '';
      const buf = Buffer.alloc((len + 1) * 2);
      const n = GetWindowTextW(h, buf, len + 1);
      return n > 0 ? buf.toString('utf16le', 0, n * 2) : '';
    },
    getClassName(h) {
      const n = GetClassNameW(h, classBuf, 256);
      return n > 0 ? classBuf.toString('utf16le', 0, n * 2) : '';
    },
    isWindow: (h) => IsWindow(h) !== 0,
    isWindowVisible: (h) => IsWindowVisible(h) !== 0,
    isIconic: (h) => IsIconic(h) !== 0,
    isZoomed: (h) => IsZoomed(h) !== 0,
    getWindowLong: (h, index) => GetWindowLongPtrW(h, index) >>> 0,
    getExtendedFrameBounds(h) {
      const r: Partial<RawRect> = {};
      return DwmGetRect(h, 9 /* DWMWA_EXTENDED_FRAME_BOUNDS */, r, 16) === 0 ? readRect(r) : null;
    },
    getWindowRect(h) {
      const r: Partial<RawRect> = {};
      return GetWindowRect(h, r) ? readRect(r) : null;
    },
    getCloaked(h) {
      const v: Cell = [0];
      return DwmGetU32(h, 14 /* DWMWA_CLOAKED */, v, 4) === 0 ? v[0] : null;
    },
    findChildWindow: (parent, className) => FindWindowExW(parent, null, className, null),
    enumTopLevelWindows() {
      const out: Hwnd[] = [];
      // Transient callback: only collects handles; describing happens after EnumWindows returns.
      EnumWindows((h) => {
        if (h !== null) out.push(h);
        return out.length < MAX_ENUM_WINDOWS ? 1 : 0;
      }, 0);
      return out;
    },
    getMonitorRectsForWindow(h) {
      const mon = MonitorFromWindow(h, 2 /* MONITOR_DEFAULTTONEAREST */);
      if (mon === null) return null;
      const mi: MonitorInfo = { cbSize: koffi.sizeof(MONITORINFO), rcMonitor: {}, rcWork: {}, dwFlags: 0 };
      if (!GetMonitorInfoW(mon, mi)) return null;
      const monitor = readRect(mi.rcMonitor);
      const work = readRect(mi.rcWork);
      return monitor && work ? { monitor, work } : null;
    },
    windowFromPoint: (x, y) => WindowFromPoint({ x: Math.round(x), y: Math.round(y) }),
    queryUserNotificationState() {
      const state: Cell = [0];
      return SHQueryUserNotificationState(state) === 0 ? state[0] : null;
    },
    getThreadDpiAwareness: () => getThreadDpiAwareness(),
    registerWinEventProc(proc) {
      const relay = (_hook: unknown, event: number, hwnd: Hwnd | null, idObject: number, idChild: number): void => {
        try {
          proc(event, hwnd, idObject, idChild);
        } catch {
          /* never throw into native code */
        }
      };
      return koffi.register(relay, koffi.pointer(WINEVENTPROC));
    },
    unregisterCallback: (ptr) => koffi.unregister(ptr),
    setWinEventHook: (eventMin, eventMax, proc, flags, idProcess = 0) => SetWinEventHook(eventMin, eventMax, null, proc, idProcess, 0, flags),
    unhookWinEvent: (hook) => UnhookWinEvent(hook) !== 0,
  };
}

type AppBarData = { cbSize: number; hWnd: null; uCallbackMessage: number; uEdge: number; rc: Partial<RawRect>; lParam: number };
const ABM_GETSTATE = 4;
const ABM_GETTASKBARPOS = 5;

/** Nonzero for koffi integer results that may come back as number or BigInt. */
const nonZero = (v: number | bigint): boolean => (typeof v === 'bigint' ? v !== 0n : v !== 0);

function bindShell(
  koffi: Koffi,
  user32: LibraryHandle,
  shell32: LibraryHandle,
  RECT: TypeObject,
  readRect: (r: Partial<RawRect>) => RawRect | null,
): { shell: ShellNative; APPBARDATA: TypeObject } {
  const s = <A extends unknown[], R>(lib: LibraryHandle, def: string): Fn<A, R> => lib.func(def);
  // sizeof == 48 on x64: hWnd 8, uCallbackMessage 16, uEdge 20, rc 24, lParam 40 (unit-tested).
  const APPBARDATA = koffi.struct({ cbSize: 'uint32_t', hWnd: 'void *', uCallbackMessage: 'uint32_t', uEdge: 'uint32_t', rc: RECT, lParam: 'intptr_t' });
  const SHAppBarMessage: Fn<[number, AppBarData], number | bigint> = shell32.func('__stdcall', 'SHAppBarMessage', 'uintptr_t', [
    'uint32_t',
    koffi.inout(koffi.pointer(APPBARDATA)),
  ]);
  const FindWindowW = s<[string, null], Hwnd | null>(user32, 'void * __stdcall FindWindowW(const char16_t *cls, const char16_t *title)');
  const FindWindowExTop = s<[null, Hwnd | null, string, null], Hwnd | null>(
    user32,
    'void * __stdcall FindWindowExW(void *parent, void *after, const char16_t *cls, const char16_t *title)',
  );
  const SetPropW = s<[Hwnd, string, number], number>(user32, 'int __stdcall SetPropW(void *h, const char16_t *name, intptr_t data)');
  const RemovePropW = s<[Hwnd, string], number | bigint>(user32, 'intptr_t __stdcall RemovePropW(void *h, const char16_t *name)');
  const RegisterWindowMessageW = s<[string], number>(user32, 'uint32_t __stdcall RegisterWindowMessageW(const char16_t *name)');
  const abd = (): AppBarData => ({ cbSize: koffi.sizeof(APPBARDATA), hWnd: null, uCallbackMessage: 0, uEdge: 0, rc: { left: 0, top: 0, right: 0, bottom: 0 }, lParam: 0 });

  const shell: ShellNative = {
    findWindow: (className) => FindWindowW(className, null),
    findNextWindow: (className, after) => FindWindowExTop(null, after, className, null),
    appBarGetState: () => Number(SHAppBarMessage(ABM_GETSTATE, abd())),
    appBarGetTaskbarPos() {
      const data = abd();
      if (!nonZero(SHAppBarMessage(ABM_GETTASKBARPOS, data))) return null;
      const rect = readRect(data.rc);
      return rect ? { edge: data.uEdge, rect } : null;
    },
    setProp: (h, name, value) => SetPropW(h, name, value) !== 0,
    removeProp: (h, name) => Number(RemovePropW(h, name)),
    registerWindowMessage: (name) => RegisterWindowMessageW(name),
  };
  return { shell, APPBARDATA };
}

function describePointerTypes(koffi: Koffi, structs: Record<string, TypeObject>, callbacks: Record<string, TypeObject>): NativeTypeInfo[] {
  const out: NativeTypeInfo[] = [];
  for (const [name, t] of Object.entries(structs)) {
    const members = koffi.type(t).members;
    const offsets: Record<string, number> = {};
    for (const [m, info] of Object.entries(members ?? {})) offsets[m] = info.offset;
    out.push({ name, typeName: koffi.type(t).name, kind: 'struct-pointer', primitive: koffi.type(koffi.pointer(t)).primitive, size: koffi.sizeof(t), offsets });
  }
  for (const [name, t] of Object.entries(callbacks)) {
    out.push({ name, typeName: koffi.type(t).name, kind: 'callback-pointer', primitive: koffi.type(koffi.pointer(t)).primitive, size: 0 });
  }
  return out;
}
