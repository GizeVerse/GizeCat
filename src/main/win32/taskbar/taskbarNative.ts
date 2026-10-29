// The Win32 surface the taskbar tracker needs, as an injectable facade (tests use a fake).
// Taskbar windows are found by class name only; no window title is ever read.
import { GWL_EXSTYLE } from '../constants';
import { loadShellNative, loadWin32Native } from '../native';
import type { Hwnd, RawRect, ShellNative, Win32Native } from '../native';

export const TRAY_CLASS = 'Shell_TrayWnd';
export const SECONDARY_TRAY_CLASS = 'Shell_SecondaryTrayWnd';

/** Every method may throw (the tracker guards each call). */
export interface TaskbarNative {
  /** FindWindowW(className): first top-level window of the class. */
  findWindow(className: string): Hwnd | null;
  /** Next top-level window of the class after `after` (null: the first). */
  findNextWindow(className: string, after: Hwnd | null): Hwnd | null;
  isWindow(h: Hwnd): boolean;
  isWindowVisible(h: Hwnd): boolean;
  /** GetWindowRect (live position: an auto-hidden taskbar is moved mostly off screen). */
  getWindowRect(h: Hwnd): RawRect | null;
  /** MonitorFromWindow(NEAREST) + GetMonitorInfoW. */
  getMonitorRects(h: Hwnd): { monitor: RawRect; work: RawRect } | null;
  /** ABM_GETSTATE bits (global auto-hide setting). Cross-process: only on discoveries that can change it, never per reconcile. */
  appBarState(): number;
  /** ABM_GETTASKBARPOS: the primary taskbar's docked rect and ABE_* edge. Cross-process: like appBarState. */
  appBarTaskbarPos(): { edge: number; rect: RawRect } | null;
  /** GWL_EXSTYLE (diagnostics: WS_EX_TOPMOST). */
  getExStyle(h: Hwnd): number;
}

export function createTaskbarNative(win32: Win32Native, shell: ShellNative): TaskbarNative {
  return {
    findWindow: (cls) => shell.findWindow(cls),
    findNextWindow: (cls, after) => shell.findNextWindow(cls, after),
    isWindow: (h) => win32.isWindow(h),
    isWindowVisible: (h) => win32.isWindowVisible(h),
    getWindowRect: (h) => win32.getWindowRect(h),
    getMonitorRects: (h) => win32.getMonitorRectsForWindow(h),
    appBarState: () => shell.appBarGetState(),
    appBarTaskbarPos: () => shell.appBarGetTaskbarPos(),
    getExStyle: (h) => win32.getWindowLong(h, GWL_EXSTYLE),
  };
}

/** The koffi-backed facade. Throws when koffi, a DLL or a binding is unavailable. */
export function loadTaskbarNative(): TaskbarNative {
  return createTaskbarNative(loadWin32Native(), loadShellNative());
}
