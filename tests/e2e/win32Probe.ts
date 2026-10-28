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
  };
  return probe;
}
