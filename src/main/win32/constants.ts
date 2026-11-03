// Win32 constants (MS docs / Windows SDK headers). Only what this module uses.

export const WINEVENT_OUTOFCONTEXT = 0x0000;
export const WINEVENT_SKIPOWNPROCESS = 0x0002;

export const EVENT_SYSTEM_FOREGROUND = 0x0003;
export const EVENT_SYSTEM_MOVESIZESTART = 0x000a;
export const EVENT_SYSTEM_MOVESIZEEND = 0x000b;
export const EVENT_SYSTEM_MINIMIZESTART = 0x0016;
export const EVENT_SYSTEM_MINIMIZEEND = 0x0017;
export const EVENT_OBJECT_DESTROY = 0x8001;
export const EVENT_OBJECT_SHOW = 0x8002;
export const EVENT_OBJECT_HIDE = 0x8003;
export const EVENT_OBJECT_CLOAKED = 0x8017;
export const EVENT_OBJECT_UNCLOAKED = 0x8018;

/** One hook per narrow range: the span 0x3..0x17 would also deliver capture/menu/scroll events. */
export const WIN_EVENT_RANGES: ReadonlyArray<readonly [number, number]> = [
  [EVENT_SYSTEM_FOREGROUND, EVENT_SYSTEM_FOREGROUND],
  [EVENT_SYSTEM_MOVESIZESTART, EVENT_SYSTEM_MOVESIZEEND],
  [EVENT_SYSTEM_MINIMIZESTART, EVENT_SYSTEM_MINIMIZEEND],
  [EVENT_OBJECT_DESTROY, EVENT_OBJECT_HIDE],
  [EVENT_OBJECT_CLOAKED, EVENT_OBJECT_UNCLOAKED],
];

/** v1.2 click-guard obstacle cache (ADR 0003 §6.1): window creation and moves also invalidate it. */
export const EVENT_OBJECT_CREATE = 0x8000;
export const EVENT_OBJECT_LOCATIONCHANGE = 0x800b;
/**
 * Hooked only while the cat is near a screen-edge band. LOCATIONCHANGE is a separate, narrow hook
 * (it also fires for every cursor and caret move; those are filtered out at once by idObject).
 */
export const OBSTACLE_EVENT_RANGES: ReadonlyArray<readonly [number, number]> = [
  [EVENT_SYSTEM_FOREGROUND, EVENT_SYSTEM_FOREGROUND],
  [EVENT_SYSTEM_MOVESIZESTART, EVENT_SYSTEM_MOVESIZEEND],
  [EVENT_SYSTEM_MINIMIZESTART, EVENT_SYSTEM_MINIMIZEEND],
  [EVENT_OBJECT_CREATE, EVENT_OBJECT_HIDE],
  [EVENT_OBJECT_LOCATIONCHANGE, EVENT_OBJECT_LOCATIONCHANGE],
  [EVENT_OBJECT_CLOAKED, EVENT_OBJECT_UNCLOAKED],
];

export const OBJID_WINDOW = 0;
export const CHILDID_SELF = 0;

export const GWL_STYLE = -16;
export const GWL_EXSTYLE = -20;
export const GA_ROOT = 2;
export const GW_OWNER = 4;

export const WS_THICKFRAME = 0x0004_0000;
export const WS_DLGFRAME = 0x0040_0000;
/** WS_BORDER | WS_DLGFRAME: a title bar. */
export const WS_CAPTION = 0x00c0_0000;
export const WS_EX_TRANSPARENT = 0x0000_0020;
export const WS_EX_TOOLWINDOW = 0x0000_0080;
export const WS_EX_WINDOWEDGE = 0x0000_0100;
export const WS_EX_APPWINDOW = 0x0004_0000;
export const WS_EX_NOACTIVATE = 0x0800_0000;

export const DWMWA_EXTENDED_FRAME_BOUNDS = 9;
export const DWMWA_CLOAKED = 14;

export const MONITOR_DEFAULTTONEAREST = 2;
export const PROCESS_QUERY_LIMITED_INFORMATION = 0x1000;

export const VK_LBUTTON = 0x01;
export const VK_RBUTTON = 0x02;
/** v1.2: the middle button (press counter and typing detector; mouse buttons only, never keys). */
export const VK_MBUTTON = 0x04;
export const SM_SWAPBUTTON = 23;

/** QUERY_USER_NOTIFICATION_STATE */
export const QUNS_NOT_PRESENT = 1;
export const QUNS_BUSY = 2;
export const QUNS_RUNNING_D3D_FULL_SCREEN = 3;
export const QUNS_PRESENTATION_MODE = 4;
export const QUNS_ACCEPTS_NOTIFICATIONS = 5;
export const QUNS_QUIET_TIME = 6;
export const QUNS_APP = 7;

/** DPI_AWARENESS */
export const DPI_AWARENESS_PER_MONITOR_AWARE = 2;

/** Desktop/taskbar surfaces that are never app windows (and never count as fullscreen). */
export const SHELL_WINDOW_CLASSES: ReadonlySet<string> = new Set([
  'Progman',
  'WorkerW',
  'Shell_TrayWnd',
  'Shell_SecondaryTrayWnd',
]);

/** The desktop itself (wallpaper and icons): below every window, it hides nothing. */
export const DESKTOP_WINDOW_CLASSES: ReadonlySet<string> = new Set(['Progman', 'WorkerW']);

/** Bound on owner-chain walks (real chains are a few windows long). */
export const MAX_OWNER_DEPTH = 16;

/** Shell processes whose CoreWindows (Start, search, flyouts, IME) are not app windows. */
export const SHELL_SURFACE_PROCESSES: ReadonlySet<string> = new Set([
  'startmenuexperiencehost.exe',
  'searchhost.exe',
  'searchapp.exe',
  'shellexperiencehost.exe',
  'textinputhost.exe',
  'lockapp.exe',
  'shellhost.exe',
]);

export const UWP_FRAME_HOST = 'applicationframehost.exe';
export const UWP_CORE_WINDOW_CLASS = 'Windows.UI.Core.CoreWindow';

/** Alt-Tab-like minimum size for an app window (physical px). */
export const MIN_APP_WINDOW_WIDTH = 120;
export const MIN_APP_WINDOW_HEIGHT = 60;
