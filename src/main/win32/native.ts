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

export type Hwnd = bigint;

export interface RawRect {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

/** WinEventProc as seen by JS (koffi also passes hook handle, thread id and time; unused). */
export type WinEventProc = (event: number, hwnd: Hwnd | null, idObject: number, idChild: number) => void;

export interface Win32Native {
  readonly ownPid: number;
  getCursorPos(): { x: number; y: number } | null;
  /** LASTINPUTINFO.dwTime (GetTickCount clock) or null on failure. */
  getLastInputTick(): number | null;
  getTickCount(): number;
  getAsyncKeyState(vk: number): number;
  getSystemMetrics(index: number): number;
  getForegroundWindow(): Hwnd | null;
  getAncestor(h: Hwnd, flags: number): Hwnd | null;
  getWindow(h: Hwnd, cmd: number): Hwnd | null;
  /** 0 when the window is gone. */
  getWindowProcessId(h: Hwnd): number;
  getProcessImagePath(pid: number): string | null;
  /** Caption of a window. Callers must only use it on windows of OTHER processes. */
  getWindowText(h: Hwnd): string;
  getClassName(h: Hwnd): string;
  isWindow(h: Hwnd): boolean;
  isWindowVisible(h: Hwnd): boolean;
  isIconic(h: Hwnd): boolean;
  isZoomed(h: Hwnd): boolean;
  /** GetWindowLongPtrW, normalised to an unsigned 32-bit value. */
  getWindowLong(h: Hwnd, index: number): number;
  getExtendedFrameBounds(h: Hwnd): RawRect | null;
  getWindowRect(h: Hwnd): RawRect | null;
  /** DWMWA_CLOAKED value (0 = not cloaked) or null when the query failed. */
  getCloaked(h: Hwnd): number | null;
  findChildWindow(parent: Hwnd, className: string): Hwnd | null;
  /** Top-level windows in z-order, top first. */
  enumTopLevelWindows(): Hwnd[];
  getMonitorRectsForWindow(h: Hwnd): { monitor: RawRect; work: RawRect } | null;
  windowFromPoint(x: number, y: number): Hwnd | null;
  /** QUERY_USER_NOTIFICATION_STATE value or null on failure. */
  queryUserNotificationState(): number | null;
  /** DPI_AWARENESS of the calling thread, or null when the API is missing. */
  getThreadDpiAwareness(): number | null;
  registerWinEventProc(proc: WinEventProc): bigint;
  unregisterCallback(ptr: bigint): void;
  setWinEventHook(eventMin: number, eventMax: number, proc: bigint, flags: number): bigint | null;
  unhookWinEvent(hook: bigint): boolean;
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
    setWinEventHook: (eventMin, eventMax, proc, flags) => SetWinEventHook(eventMin, eventMax, null, proc, 0, 0, flags),
    unhookWinEvent: (hook) => UnhookWinEvent(hook) !== 0,
  };
}
