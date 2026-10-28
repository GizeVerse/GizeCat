// Win32Api (src/main/contracts.ts) on top of the typed native layer. Every public
// method is guarded: failures are logged (rate-limited) and mapped to null/[]/false.
import { rectContains, type Point, type Rect } from '../../shared/geometry';
import { DEFAULT_EXCLUDED_PROCESSES } from '../../shared/settings';
import type { WindowInfo } from '../../shared/world';
import type { Logger, RawWinEvent, Unsubscribe, Win32Api } from '../contracts';
import { LruCache } from './collections';
import {
  CHILDID_SELF,
  DESKTOP_WINDOW_CLASSES,
  DPI_AWARENESS_PER_MONITOR_AWARE,
  EVENT_OBJECT_CLOAKED,
  EVENT_OBJECT_DESTROY,
  EVENT_OBJECT_HIDE,
  EVENT_OBJECT_SHOW,
  EVENT_OBJECT_UNCLOAKED,
  EVENT_SYSTEM_FOREGROUND,
  EVENT_SYSTEM_MINIMIZEEND,
  EVENT_SYSTEM_MINIMIZESTART,
  EVENT_SYSTEM_MOVESIZEEND,
  EVENT_SYSTEM_MOVESIZESTART,
  GA_ROOT,
  GW_OWNER,
  GWL_EXSTYLE,
  GWL_STYLE,
  MAX_OWNER_DEPTH,
  OBJID_WINDOW,
  SHELL_SURFACE_PROCESSES,
  SHELL_WINDOW_CLASSES,
  SM_SWAPBUTTON,
  UWP_CORE_WINDOW_CLASS,
  UWP_FRAME_HOST,
  VK_LBUTTON,
  VK_RBUTTON,
  WIN_EVENT_RANGES,
  WINEVENT_OUTOFCONTEXT,
  WINEVENT_SKIPOWNPROCESS,
} from './constants';
import type { Hwnd, RawRect, Win32Native } from './native';
import type { Occluder } from './platforms';
import { categorizeProcess, ExclusionRules, exeBasename } from './processNames';
import {
  ignoresOwner,
  isClickThrough,
  isExcludedByExStyle,
  isFullscreenGeometry,
  isOverlayStyle,
  mapNotificationState,
  meetsMinimumSize,
  toRect,
} from './windowRules';

export interface Win32ApiOptions {
  /** Include this process's own windows and hook events. Diagnostic probes only. */
  includeOwnProcess?: boolean;
  /** Clock for RawWinEvent.at (ms). Defaults to performance.now(). */
  now?: () => number;
  /** How long a cached pid -> process name entry is trusted (ms). */
  processCacheTtlMs?: number;
}

/**
 * Capabilities beyond the Win32Api contract that keep window titles inside this module.
 * Privacy checks here see every shown top-level window (owned dialogs, tool windows,
 * popups, small windows), not only Alt-Tab app windows. A window is private when it or
 * a window in its owner chain matches the exclusions; this app's own windows never are.
 */
export interface Win32ApiExtensions {
  /**
   * Privacy exclusions used for WindowInfo.excluded and the checks below. Title patterns
   * make window titles be read (in memory only); with none, no title is ever read.
   */
  setExclusions(processes: readonly string[], titlePatterns: readonly string[]): void;
  /**
   * Fresh (uncached) privacy check of any root window, app window or not.
   * null when it cannot be determined; callers must then fail closed.
   */
  isWindowExcluded(id: string): boolean | null;
  /**
   * Fresh privacy check of the real foreground window (GetForegroundWindow), whatever kind
   * of window it is. false when this app is in front; null when it cannot be determined.
   */
  isForegroundExcluded(): boolean | null;
  /**
   * On-screen rects of every shown top-level window that is private or cannot be cleared.
   * null when the windows cannot be enumerated; callers must then fail closed.
   */
  listExcludedRects(): Rect[] | null;
  /**
   * Every shown top-level window that hides what is below it, in z-order (top first):
   * app windows, owned dialogs, tool windows and this app's Settings window, but not
   * click-through windows, the desktop or this app's overlays. null when enumeration fails.
   */
  listOccluders(): Occluder[] | null;
}

export type ExtendedWin32Api = Win32Api & Win32ApiExtensions;

const EXTENSION_METHODS: ReadonlyArray<keyof Win32ApiExtensions> = ['setExclusions', 'isWindowExcluded', 'isForegroundExcluded', 'listExcludedRects', 'listOccluders'];

export function hasWin32Extensions(api: Win32Api): api is ExtendedWin32Api {
  const a = api as Partial<ExtendedWin32Api>;
  return EXTENSION_METHODS.every((m) => typeof a[m] === 'function');
}

const EVENT_KINDS: ReadonlyMap<number, RawWinEvent['kind']> = new Map<number, RawWinEvent['kind']>([
  [EVENT_SYSTEM_FOREGROUND, 'foreground'],
  [EVENT_SYSTEM_MOVESIZESTART, 'moveStart'],
  [EVENT_SYSTEM_MOVESIZEEND, 'moveEnd'],
  [EVENT_SYSTEM_MINIMIZESTART, 'minimizeStart'],
  [EVENT_SYSTEM_MINIMIZEEND, 'minimizeEnd'],
  [EVENT_OBJECT_SHOW, 'show'],
  [EVENT_OBJECT_HIDE, 'hide'],
  [EVENT_OBJECT_DESTROY, 'destroy'],
  [EVENT_OBJECT_CLOAKED, 'cloaked'],
  [EVENT_OBJECT_UNCLOAKED, 'uncloaked'],
]);

const MAX_HWND = (1n << 64n) - 1n;
const EMPTY_RECT: Rect = { x: 0, y: 0, width: 0, height: 0 };

/** Parses a decimal HWND id; null for anything that is not a non-zero 64-bit value. */
export function parseWindowId(id: string): Hwnd | null {
  if (!/^[0-9]{1,20}$/.test(id)) return null;
  const v = BigInt(id);
  return v === 0n || v > MAX_HWND ? null : v;
}

/** GetTickCount() - LASTINPUTINFO.dwTime, safe across the 49.7-day DWORD wrap. */
export function idleFromTicks(tickNow: number, lastInputTick: number): number {
  const diff = (tickNow - lastInputTick) >>> 0;
  // Input that landed between the two reads makes dwTime "newer" than the tick count.
  return diff > 0x7fffffff ? 0 : diff;
}

interface CachedName {
  name: string;
  at: number;
}

export function createKoffiWin32Api(native: Win32Native, logger: Logger, opts: Win32ApiOptions = {}): ExtendedWin32Api {
  const log = logger.child('win32');
  const includeOwn = opts.includeOwnProcess === true;
  const now = opts.now ?? (() => performance.now());
  const nameTtlMs = opts.processCacheTtlMs ?? 15_000;
  const ownPid = native.ownPid;

  const exclusions = new ExclusionRules(DEFAULT_EXCLUDED_PROCESSES, DEFAULT_EXCLUDED_TITLE_PATTERNS);
  const processNames = new LruCache<number, CachedName>(256);
  /** Ids recently described as app windows: lets the hook keep DESTROY events of interest only. */
  const appWindowIds = new LruCache<string, true>(1024);
  /** Last visible frame per window, reported for minimized windows. */
  const lastRects = new LruCache<string, Rect>(512);
  const subscriptions = new Set<() => void>();
  const errorCounts = new Map<string, number>();
  let disposed = false;

  function noteFailure(op: string, e: unknown): void {
    const n = (errorCounts.get(op) ?? 0) + 1;
    errorCounts.set(op, n);
    if (n <= 3 || n % 1000 === 0) log.warn('native call failed', { op, count: n, error: e instanceof Error ? e.message : String(e) });
  }

  function guard<T>(op: string, fallback: T, fn: () => T): T {
    try {
      return fn();
    } catch (e) {
      noteFailure(op, e);
      return fallback;
    }
  }

  const isOwn = (pid: number): boolean => pid === ownPid && !includeOwn;

  function lookupProcessName(pid: number, fresh: boolean): string {
    const t = now();
    if (!fresh) {
      const hit = processNames.get(pid);
      if (hit && t - hit.at < nameTtlMs) return hit.name;
    }
    const path = native.getProcessImagePath(pid);
    const name = path ? exeBasename(path) : '';
    processNames.set(pid, { name, at: t });
    return name;
  }

  /** UWP apps live in a CoreWindow child of ApplicationFrameHost; attribute the window to the app. */
  function resolveProcessName(h: Hwnd, pid: number, fresh: boolean): string {
    const name = lookupProcessName(pid, fresh);
    if (name !== UWP_FRAME_HOST) return name;
    const core = native.findChildWindow(h, UWP_CORE_WINDOW_CLASS);
    if (core === null) return name;
    const corePid = native.getWindowProcessId(core);
    if (corePid === 0 || corePid === pid) return name;
    return lookupProcessName(corePid, fresh) || name;
  }

  function computeExcluded(h: Hwnd, pid: number, processName: string): boolean {
    if (exclusions.matchesProcess(processName)) return true;
    // GetWindowTextW on our own windows sends WM_GETTEXT and can hang: never read them.
    if (pid === ownPid || !exclusions.hasTitlePatterns) return false;
    return exclusions.matchesTitle(native.getWindowText(h));
  }

  function describeHwnd(h: Hwnd): WindowInfo | null {
    if (!native.isWindowVisible(h)) return null;
    const pid = native.getWindowProcessId(h);
    if (pid === 0 || isOwn(pid)) return null;
    if (native.getAncestor(h, GA_ROOT) !== h) return null;
    const exStyle = native.getWindowLong(h, GWL_EXSTYLE);
    if (isExcludedByExStyle(exStyle)) return null;
    if (!ignoresOwner(exStyle)) {
      const owner = native.getWindow(h, GW_OWNER);
      if (owner !== null && native.isWindowVisible(owner)) return null;
    }
    const cloaked = native.getCloaked(h);
    if (cloaked !== null && cloaked !== 0) return null;
    if (SHELL_WINDOW_CLASSES.has(native.getClassName(h))) return null;

    const id = h.toString();
    const minimized = native.isIconic(h);
    let rect: Rect;
    let frame: RawRect | null = null;
    if (minimized) {
      rect = lastRects.get(id) ?? EMPTY_RECT;
    } else {
      frame = native.getExtendedFrameBounds(h);
      const visible = frame ?? native.getWindowRect(h);
      if (visible === null) return null;
      rect = toRect(visible);
      if (!meetsMinimumSize(rect)) return null;
      lastRects.set(id, rect);
    }

    const processName = resolveProcessName(h, pid, false);
    if (SHELL_SURFACE_PROCESSES.has(processName)) return null;

    const maximized = !minimized && native.isZoomed(h);
    let fullscreen = false;
    if (!minimized) {
      const mon = native.getMonitorRectsForWindow(h);
      const windowRect = native.getWindowRect(h);
      if (mon && windowRect) {
        fullscreen = isFullscreenGeometry({
          windowRect,
          frameRect: frame,
          monitorRect: mon.monitor,
          style: native.getWindowLong(h, GWL_STYLE),
          exStyle,
          maximized,
        });
      }
    }

    appWindowIds.set(id, true);
    return {
      id,
      rect,
      processName,
      category: categorizeProcess(processName),
      minimized,
      maximized,
      fullscreen,
      excluded: computeExcluded(h, pid, processName),
    };
  }

  const dpiAwareness = guard('GetThreadDpiAwareness', null, () => native.getThreadDpiAwareness());
  if (dpiAwareness === DPI_AWARENESS_PER_MONITOR_AWARE) log.info('thread DPI awareness', { awareness: dpiAwareness, perMonitor: true });
  else log.warn('thread is not per-monitor DPI aware; Win32 coordinates may be virtualised', { awareness: dpiAwareness });

  return {
    available: true,

    getCursorPos: () => guard('GetCursorPos', null, () => native.getCursorPos()),

    getIdleMs: () =>
      guard('GetLastInputInfo', null, () => {
        const last = native.getLastInputTick();
        return last === null ? null : idleFromTicks(native.getTickCount(), last);
      }),

    isLeftButtonDown: () =>
      guard('GetAsyncKeyState', false, () => {
        // Mouse buttons only; keyboard state is never read. GetAsyncKeyState reports physical
        // buttons, so follow the user's primary-button swap.
        const vk = native.getSystemMetrics(SM_SWAPBUTTON) !== 0 ? VK_RBUTTON : VK_LBUTTON;
        return (native.getAsyncKeyState(vk) & 0x8000) !== 0;
      }),

    getForegroundWindowId: () =>
      guard('GetForegroundWindow', null, () => {
        const h = native.getForegroundWindow();
        if (h === null) return null;
        return isOwn(native.getWindowProcessId(h)) ? null : h.toString();
      }),

    describeWindow: (id) =>
      guard('describeWindow', null, () => {
        const h = parseWindowId(id);
        return h === null ? null : describeHwnd(h);
      }),

    getWindowRect: (id) =>
      guard('getWindowRect', null, () => {
        const h = parseWindowId(id);
        if (h === null || !native.isWindow(h) || !native.isWindowVisible(h) || native.isIconic(h)) return null;
        const cloaked = native.getCloaked(h);
        if (cloaked !== null && cloaked !== 0) return null;
        const frame = native.getExtendedFrameBounds(h) ?? native.getWindowRect(h);
        if (frame === null) return null;
        const r = toRect(frame);
        return r.width > 0 && r.height > 0 ? r : null;
      }),

    listAppWindows: () =>
      guard('listAppWindows', [], () => {
        const out: WindowInfo[] = [];
        for (const h of native.enumTopLevelWindows()) {
          // A window can vanish mid-enumeration; one failure must not drop the whole list.
          const info = guard('describeWindow', null, () => describeHwnd(h));
          if (info) out.push(info);
        }
        return out;
      }),

    windowIdAtPoint: (p: Point) =>
      guard('WindowFromPoint', null, () => {
        if (!Number.isFinite(p.x) || !Number.isFinite(p.y)) return null;
        const hit = native.windowFromPoint(p.x, p.y);
        if (hit === null) return null;
        const root = native.getAncestor(hit, GA_ROOT) ?? hit;
        return isOwn(native.getWindowProcessId(root)) ? null : root.toString();
      }),

    getNotificationState: () => guard('SHQueryUserNotificationState', 'unknown', () => mapNotificationState(native.queryUserNotificationState())),

    subscribeWinEvents: (handler: (ev: RawWinEvent) => void): Unsubscribe | null =>
      guard('SetWinEventHook', null, () => {
        if (disposed) return null;
        // Keep this O(1): filter, describe nothing, hand over. Consumers enqueue and drain later.
        const proc = native.registerWinEventProc((event, hwnd, idObject, idChild) => {
          if (hwnd === null || idObject !== OBJID_WINDOW || idChild !== CHILDID_SELF) return;
          const kind = EVENT_KINDS.get(event);
          if (kind === undefined) return;
          const id = hwnd.toString();
          if (kind === 'destroy') {
            if (!appWindowIds.has(id)) return;
          } else if (native.getAncestor(hwnd, GA_ROOT) !== hwnd) {
            return;
          }
          try {
            handler({ kind, id, at: now() });
          } catch (e) {
            noteFailure('winEventHandler', e);
          }
        });
        const flags = WINEVENT_OUTOFCONTEXT | (includeOwn ? 0 : WINEVENT_SKIPOWNPROCESS);
        const hooks: bigint[] = [];
        for (const [min, max] of WIN_EVENT_RANGES) {
          const hook = guard('SetWinEventHook', null, () => native.setWinEventHook(min, max, proc, flags));
          if (hook !== null) hooks.push(hook);
        }
        if (hooks.length === 0) {
          guard('unregister', undefined, () => native.unregisterCallback(proc));
          log.warn('no WinEvent hook could be installed');
          return null;
        }
        if (hooks.length < WIN_EVENT_RANGES.length) log.warn('some WinEvent hooks failed', { installed: hooks.length, wanted: WIN_EVENT_RANGES.length });
        let active = true;
        const unsubscribe = (): void => {
          if (!active) return;
          active = false;
          subscriptions.delete(unsubscribe);
          for (const hook of hooks) guard('UnhookWinEvent', false, () => native.unhookWinEvent(hook));
          guard('unregister', undefined, () => native.unregisterCallback(proc));
        };
        subscriptions.add(unsubscribe);
        return unsubscribe;
      }),

    setExclusions(processes, titlePatterns) {
      exclusions.set(processes, titlePatterns);
    },

    isWindowExcluded: (id) =>
      guard('isWindowExcluded', null, () => {
        const h = parseWindowId(id);
        if (h === null || !native.isWindow(h)) return null;
        const pid = native.getWindowProcessId(h);
        if (pid === 0) return null;
        const name = resolveProcessName(h, pid, true);
        if (name === '' && pid !== ownPid) return null;
        return computeExcluded(h, pid, name);
      }),

    dispose() {
      disposed = true;
      for (const unsubscribe of [...subscriptions]) unsubscribe();
      processNames.clear();
      appWindowIds.clear();
      lastRects.clear();
    },
  };
}

/** Safe stand-in when koffi or a system DLL cannot be loaded (or off Windows). */
export function createUnavailableWin32Api(): ExtendedWin32Api {
  return {
    available: false,
    getCursorPos: () => null,
    getIdleMs: () => null,
    isLeftButtonDown: () => false,
    getForegroundWindowId: () => null,
    describeWindow: () => null,
    getWindowRect: () => null,
    listAppWindows: () => [],
    windowIdAtPoint: () => null,
    getNotificationState: () => 'unknown',
    subscribeWinEvents: () => null,
    setExclusions: () => undefined,
    isWindowExcluded: () => null,
    dispose: () => undefined,
  };
}
