// OS-level oracle for click-through: asks Windows (not Chromium) which window is
// at a physical point, and reads overlay window styles. Runs in the test process.
import koffi from 'koffi';

export const WS_EX_TOPMOST = 0x8;
export const WS_EX_TRANSPARENT = 0x20;
export const WS_EX_TOOLWINDOW = 0x80;
export const WS_EX_LAYERED = 0x80000;
export const WS_EX_NOACTIVATE = 0x08000000;

export interface Win32Probe {
  /** Root window (GA_ROOT) at a physical-pixel point, as a decimal HWND string. */
  rootWindowAt(x: number, y: number): string | null;
  exStyle(hwnd: string): number;
  /** IsZoomed (maximized). */
  isZoomed(hwnd: string): boolean;
  /** GetWindowThreadProcessId: the owning process id (0 when unknown). */
  ownerPid(hwnd: string): number;
  /** GetWindowRect (geometry only), or null. */
  windowRect(hwnd: string): { x: number; y: number; width: number; height: number } | null;
  /** SHQueryUserNotificationState (QUNS_*: 2 busy/fullscreen, 3 D3D fullscreen, 4 presentation, 5 normal, 6 quiet time, 7 an app in front), or null. */
  notificationState(): number | null;
  /** The window's z-order band (user32 GetWindowBand, undocumented: 1 = desktop windows; higher bands sit above every topmost desktop window), or null. */
  windowBand(hwnd: string): number | null;
  /** Position in the top-level z-order (0 = front; GetWindow GW_HWNDFIRST/GW_HWNDNEXT), or -1. */
  zIndex(hwnd: string): number;
  /** IsWindowEnabled && IsWindowVisible. */
  enabledAndVisible(hwnd: string): { enabled: boolean; visible: boolean };
  /**
   * Makes one of THIS SUITE'S OWN throwaway windows topmost (or not) without activating, moving
   * or resizing it (SetWindowPos with SWP_NOACTIVATE | SWP_NOMOVE | SWP_NOSIZE). Never call it
   * on another application's window.
   */
  setOwnWindowTopmost(hwnd: string, topmost: boolean): boolean;
}

let probe: Win32Probe | null = null;

function toHandleString(h: unknown): string | null {
  if (h === null || h === undefined) return null;
  if (typeof h === 'bigint') return h === 0n ? null : h.toString();
  if (typeof h === 'number') return h === 0 ? null : String(h);
  return null;
}

export function win32Probe(): Win32Probe {
  if (probe) return probe;
  const user32 = koffi.load('user32.dll');
  const POINT = koffi.struct('DCAT_E2E_POINT', { x: 'int32_t', y: 'int32_t' });
  const WindowFromPoint = user32.func('__stdcall', 'WindowFromPoint', 'void *', [POINT]);
  const GetAncestor = user32.func('__stdcall', 'GetAncestor', 'void *', ['void *', 'uint32_t']);
  const GetWindowLongPtrW = user32.func('__stdcall', 'GetWindowLongPtrW', 'intptr_t', ['void *', 'int']);
  const SetThreadDpiAwarenessContext = user32.func('__stdcall', 'SetThreadDpiAwarenessContext', 'intptr_t', ['intptr_t']);
  const IsZoomed = user32.func('__stdcall', 'IsZoomed', 'int', ['void *']);
  const GetWindowThreadProcessId = user32.func('__stdcall', 'GetWindowThreadProcessId', 'uint32_t', ['void *', koffi.out(koffi.pointer('uint32_t'))]);
  const RECT = koffi.struct('DCAT_E2E_RECT', { left: 'int32_t', top: 'int32_t', right: 'int32_t', bottom: 'int32_t' });
  const GetWindowRect = user32.func('__stdcall', 'GetWindowRect', 'int', ['void *', koffi.out(koffi.pointer(RECT))]);
  const shell32 = koffi.load('shell32.dll');
  const SHQueryUserNotificationState = shell32.func('__stdcall', 'SHQueryUserNotificationState', 'int32_t', [koffi.out(koffi.pointer('int32_t'))]);
  const GetTopWindow = user32.func('__stdcall', 'GetTopWindow', 'void *', ['void *']);
  const GetWindow = user32.func('__stdcall', 'GetWindow', 'void *', ['void *', 'uint32_t']);
  const IsWindowEnabled = user32.func('__stdcall', 'IsWindowEnabled', 'int', ['void *']);
  const IsWindowVisible = user32.func('__stdcall', 'IsWindowVisible', 'int', ['void *']);
  let GetWindowBand: ((h: bigint, band: number[]) => unknown) | null = null;
  try {
    GetWindowBand = user32.func('__stdcall', 'GetWindowBand', 'int', ['void *', koffi.out(koffi.pointer('uint32_t'))]) as (h: bigint, band: number[]) => unknown;
  } catch {
    GetWindowBand = null;
  }
  const SetWindowPos = user32.func('__stdcall', 'SetWindowPos', 'int', ['void *', 'intptr_t', 'int', 'int', 'int', 'int', 'uint32_t']);
  const HWND_TOPMOST = -1;
  const HWND_NOTOPMOST = -2;
  const SWP_NOSIZE_NOMOVE_NOACTIVATE = 0x0001 | 0x0002 | 0x0010;
  // Physical coordinates only make sense to a per-monitor-aware caller (DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2).
  SetThreadDpiAwarenessContext(-4);
  probe = {
    rootWindowAt(x, y) {
      const h: unknown = WindowFromPoint({ x: Math.round(x), y: Math.round(y) });
      if (toHandleString(h) === null) return null;
      return toHandleString(GetAncestor(h, 2));
    },
    exStyle(hwnd) {
      return Number(GetWindowLongPtrW(BigInt(hwnd), -20));
    },
    isZoomed(hwnd) {
      return Number(IsZoomed(BigInt(hwnd))) !== 0;
    },
    ownerPid(hwnd) {
      const pid = [0];
      GetWindowThreadProcessId(BigInt(hwnd), pid);
      return Number(pid[0] ?? 0);
    },
    windowRect(hwnd) {
      const r = { left: 0, top: 0, right: 0, bottom: 0 };
      if (Number(GetWindowRect(BigInt(hwnd), r)) === 0) return null;
      return { x: r.left, y: r.top, width: r.right - r.left, height: r.bottom - r.top };
    },
    notificationState() {
      const s = [0];
      return Number(SHQueryUserNotificationState(s)) === 0 ? Number(s[0]) : null;
    },
    windowBand(hwnd) {
      if (!GetWindowBand) return null;
      const b = [0];
      return Number(GetWindowBand(BigInt(hwnd), b)) !== 0 ? Number(b[0]) : null;
    },
    zIndex(hwnd) {
      let h: unknown = GetTopWindow(null);
      for (let i = 0; i < 4096 && toHandleString(h) !== null; i++) {
        if (toHandleString(h) === hwnd) return i;
        h = GetWindow(h, 2);
      }
      return -1;
    },
    enabledAndVisible(hwnd) {
      return { enabled: Number(IsWindowEnabled(BigInt(hwnd))) !== 0, visible: Number(IsWindowVisible(BigInt(hwnd))) !== 0 };
    },
    setOwnWindowTopmost(hwnd, topmost) {
      return Number(SetWindowPos(BigInt(hwnd), topmost ? HWND_TOPMOST : HWND_NOTOPMOST, 0, 0, 0, 0, SWP_NOSIZE_NOMOVE_NOACTIVATE)) !== 0;
    },
  };
  return probe;
}
