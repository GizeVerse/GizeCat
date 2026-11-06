// Pure window classification rules (no FFI), shared by the koffi API and tests.
import type { Rect } from '../../shared/geometry';
import type { Win32Api } from '../contracts';
import {
  MIN_APP_WINDOW_HEIGHT,
  MIN_APP_WINDOW_WIDTH,
  QUNS_ACCEPTS_NOTIFICATIONS,
  QUNS_APP,
  QUNS_BUSY,
  QUNS_PRESENTATION_MODE,
  QUNS_QUIET_TIME,
  QUNS_RUNNING_D3D_FULL_SCREEN,
  WS_CAPTION,
  WS_DLGFRAME,
  WS_EX_APPWINDOW,
  WS_EX_NOACTIVATE,
  WS_EX_TOOLWINDOW,
  WS_EX_TRANSPARENT,
  WS_EX_WINDOWEDGE,
  WS_THICKFRAME,
} from './constants';
import type { RawRect } from './nativeTypes';

export type NotificationState = ReturnType<Win32Api['getNotificationState']>;

export const toRect = (r: RawRect): Rect => ({ x: r.left, y: r.top, width: r.right - r.left, height: r.bottom - r.top });

/**
 * Extended-style part of the Alt-Tab rule: tool windows and no-activate popups are
 * hidden from Alt-Tab unless they opt in with WS_EX_APPWINDOW.
 */
export function isExcludedByExStyle(exStyle: number): boolean {
  if (exStyle & WS_EX_APPWINDOW) return false;
  return (exStyle & WS_EX_TOOLWINDOW) !== 0 || (exStyle & WS_EX_NOACTIVATE) !== 0;
}

/** WS_EX_APPWINDOW windows ignore their owner chain (Alt-Tab rule). */
export const ignoresOwner = (exStyle: number): boolean => (exStyle & WS_EX_APPWINDOW) !== 0;

export const meetsMinimumSize = (r: Rect): boolean => r.width >= MIN_APP_WINDOW_WIDTH && r.height >= MIN_APP_WINDOW_HEIGHT;

/** Click-through windows (WS_EX_TRANSPARENT): OS hit-testing passes through them. */
export const isClickThrough = (exStyle: number): boolean => (exStyle & WS_EX_TRANSPARENT) !== 0;

/** Styles of this app's overlays (tool, no-activate or click-through windows), as opposed to its Settings window. */
export const isOverlayStyle = (exStyle: number): boolean => (exStyle & (WS_EX_TOOLWINDOW | WS_EX_NOACTIVATE | WS_EX_TRANSPARENT)) !== 0;

function covers(outer: RawRect, inner: RawRect): boolean {
  return outer.left <= inner.left && outer.top <= inner.top && outer.right >= inner.right && outer.bottom >= inner.bottom;
}

const sameRect = (a: RawRect, b: RawRect): boolean => a.left === b.left && a.top === b.top && a.right === b.right && a.bottom === b.bottom;

export interface FullscreenProbe {
  /** GetWindowRect (may include invisible resize borders). */
  windowRect: RawRect;
  /** DWM extended frame bounds (visible frame), if known. */
  frameRect: RawRect | null;
  monitorRect: RawRect;
  /** Monitor work area (rcWork), if known. Equals monitorRect when the taskbar auto-hides. */
  workRect: RawRect | null;
  style: number;
  exStyle: number;
  maximized: boolean;
}

/**
 * Chromium's heuristic (ui/base/fullscreen_win.cc), generalised to the window's own
 * monitor: the window covers the monitor and has no resize/dialog frame and no
 * window-edge/tool-window style. That style test is what rules out maximized windows,
 * whose rect spills past the monitor. A non-maximized window whose visible frame is
 * exactly the monitor also counts (fullscreen apps that keep a thick frame).
 *
 * On a monitor whose work area is the whole monitor (auto-hide taskbar) a maximized
 * window covers the monitor as well, so there a maximized window is never fullscreen,
 * and a framed one only counts without a caption. Exclusive and presentation-mode
 * fullscreen are still reported through the user notification state.
 */
export function isFullscreenGeometry(p: FullscreenProbe): boolean {
  if (!covers(p.windowRect, p.monitorRect)) return false;
  const workIsMonitor = p.workRect !== null && sameRect(p.workRect, p.monitorRect);
  const framed = (p.style & (WS_DLGFRAME | WS_THICKFRAME)) !== 0 || (p.exStyle & (WS_EX_WINDOWEDGE | WS_EX_TOOLWINDOW)) !== 0;
  if (!framed) return !(p.maximized && workIsMonitor);
  if (p.maximized || p.frameRect === null || !sameRect(p.frameRect, p.monitorRect)) return false;
  return !workIsMonitor || (p.style & WS_CAPTION) !== WS_CAPTION;
}

/**
 * Maps SHQueryUserNotificationState. QUNS_BUSY is only a soft signal: a topmost
 * full-work-area overlay (ours) may trip it, so callers must not treat it as fullscreen.
 */
export function mapNotificationState(value: number | null): NotificationState {
  switch (value) {
    case QUNS_BUSY:
      return 'busy';
    case QUNS_RUNNING_D3D_FULL_SCREEN:
      return 'd3d-fullscreen';
    case QUNS_PRESENTATION_MODE:
      return 'presentation';
    case QUNS_APP:
      return 'fullscreen';
    case QUNS_ACCEPTS_NOTIFICATIONS:
    case QUNS_QUIET_TIME:
      return 'normal';
    default:
      // QUNS_NOT_PRESENT (screen saver, locked, inactive session) or a failed query.
      return 'unknown';
  }
}
