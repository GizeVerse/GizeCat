// Win32Api (src/main/contracts.ts) on top of the typed native layer. Every public
// method is guarded: failures are logged (rate-limited) and mapped to null/[]/false.
import { rectContains, type Point, type Rect } from '../../shared/geometry';
import { DEFAULT_EXCLUDED_PROCESSES } from '../../shared/settings';
import type { WindowInfo } from '../../shared/world';
import type { Logger, RawWinEvent, Unsubscribe, Win32Api } from '../contracts';
import { createClickObstacleSource, type ClickObstacles, type ClickObstacleSource, type ClickObstacleStats } from './clickObstacles';
import { LruCache } from './collections';
import { createMouseButtonSampler, type MouseButtonState } from './mouseButtons';
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
 * Every privacy answer is fresh (no cached process names) and null means "cannot be
 * determined": callers must then fail closed.
 */
export interface Win32ApiExtensions {
  /**
   * Privacy exclusions used for WindowInfo.excluded and the checks below. Title patterns
   * make window titles be read (in memory only); with none, no title is ever read.
   * Process rules start as the defaults, title patterns start empty.
   */
  setExclusions(processes: readonly string[], titlePatterns: readonly string[]): void;
  /** Privacy check of any root window (and its owner chain), app window or not. */
  isWindowExcluded(id: string): boolean | null;
  /**
   * Privacy check of the real foreground window (GetForegroundWindow) and its owner chain,
   * whatever kind of window it is. false when this app is in front.
   */
  isForegroundExcluded(): boolean | null;
  /**
   * Privacy check of the window shown at a physical point. Where this app's overlay is
   * hit-tested (while it is interactive) the window under it is judged; where its Settings
   * window is on top the point is not private.
   */
  isPointExcluded(p: Point): boolean | null;
  /**
   * Rects (GetWindowRect, px) of every shown top-level window that is private or cannot be
   * cleared. null when the windows cannot be enumerated or a private one cannot be located.
   */
  listExcludedRects(): Rect[] | null;
  /**
   * Every shown top-level window that hides what is below it, in z-order (top first):
   * app windows, owned dialogs, tool windows, the taskbar and this app's Settings window,
   * but not click-through windows, the desktop or this app's overlays. null when
   * enumeration fails.
   */
  listOccluders(): Occluder[] | null;
}

export type ExtendedWin32Api = Win32Api & Win32ApiExtensions;

/**
 * v1.2 input and click-guard capabilities (ADR 0003 §4.3, §6.1, §13). A separate interface (with its
 * own guard) so existing Win32Api fakes and extensions stay valid.
 */
export interface Win32InputExtensions {
  /** Owning process id of a top-level window (E2E restriction to the test's own windows), null when gone. */
  windowProcessId(id: string): number | null;
  /**
   * Samples the left, right and middle mouse buttons (GetAsyncKeyState, mouse buttons only, never
   * keys): whether one is held and a monotonic, content-free press count. One sampler for the process.
   */
  mouseButtons(): MouseButtonState;
  /** The click-guard obstacle list (WinEvent-invalidated cache; fresh = false means fail closed). */
  clickObstaclesPx(): ClickObstacles;
  /** Hooks the obstacle invalidation events while the cat is near a screen-edge band. */
  setObstacleWatch(armed: boolean): void;
  obstacleStats(): ClickObstacleStats | null;
}

const EXTENSION_METHODS: ReadonlyArray<keyof Win32ApiExtensions> = [
  'setExclusions',
  'isWindowExcluded',
  'isForegroundExcluded',
  'isPointExcluded',
  'listExcludedRects',
  'listOccluders',
];

const INPUT_EXTENSION_METHODS: ReadonlyArray<keyof Win32InputExtensions> = ['windowProcessId', 'mouseButtons', 'clickObstaclesPx', 'setObstacleWatch', 'obstacleStats'];

export function hasWin32Extensions(api: Win32Api): api is ExtendedWin32Api {
  const a = api as Partial<ExtendedWin32Api>;
  return EXTENSION_METHODS.every((m) => typeof a[m] === 'function');
}

export function hasWin32InputExtensions(api: Win32Api): api is Win32Api & Win32InputExtensions {
  const a = api as Partial<Win32InputExtensions>;
  return INPUT_EXTENSION_METHODS.every((m) => typeof a[m] === 'function');
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

export function createKoffiWin32Api(native: Win32Native, logger: Logger, opts: Win32ApiOptions = {}): ExtendedWin32Api & Win32InputExtensions {
  const log = logger.child('win32');
  const includeOwn = opts.includeOwnProcess === true;
  const now = opts.now ?? (() => performance.now());
  const nameTtlMs = opts.processCacheTtlMs ?? 15_000;
  const ownPid = native.ownPid;

  // No title patterns until the host installs them (only while screen analysis is on), so
  // no window title is read before that.
  const exclusions = new ExclusionRules(DEFAULT_EXCLUDED_PROCESSES);
  const processNames = new LruCache<number, CachedName>(256);
  /** Ids recently described as app windows: lets the hook keep DESTROY events of interest only. */
  const appWindowIds = new LruCache<string, true>(1024);
  /** Last visible frame per window, reported for minimized windows. */
  const lastRects = new LruCache<string, Rect>(512);
  const subscriptions = new Set<() => void>();
  const errorCounts = new Map<string, number>();
  let disposed = false;
  // v1.2: one mouse-button sampler for the process (see mouseButtons.ts) and the lazily created
  // click-guard obstacle cache.
  const buttons = createMouseButtonSampler((vk) => native.getAsyncKeyState(vk));
  let obstacles: ClickObstacleSource | null = null;
  const obstacleSource = (): ClickObstacleSource => (obstacles ??= createClickObstacleSource(native, log, { now }));

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

  type NameLookup = (pid: number) => string;
  const cachedNames: NameLookup = (pid) => lookupProcessName(pid, false);
  /** Fresh lookups for one privacy check or enumeration, memoised only for its duration. */
  function freshNames(): NameLookup {
    const seen = new Map<number, string>();
    return (pid) => {
      let name = seen.get(pid);
      if (name === undefined) {
        name = lookupProcessName(pid, true);
        seen.set(pid, name);
      }
      return name;
    };
  }

  /** UWP apps live in a CoreWindow child of ApplicationFrameHost; attribute the window to the app. */
  function resolveProcessName(h: Hwnd, pid: number, names: NameLookup): string {
    const name = names(pid);
    if (name !== UWP_FRAME_HOST) return name;
    const core = native.findChildWindow(h, UWP_CORE_WINDOW_CLASS);
    if (core === null) return name;
    const corePid = native.getWindowProcessId(core);
    if (corePid === 0 || corePid === pid) return name;
    return names(corePid) || name;
  }

  function computeExcluded(h: Hwnd, pid: number, processName: string): boolean {
    if (exclusions.matchesProcess(processName)) return true;
    // GetWindowTextW on our own windows sends WM_GETTEXT and can hang: never read them.
    if (pid === ownPid || !exclusions.hasTitlePatterns) return false;
    return exclusions.matchesTitle(native.getWindowText(h));
  }

  /**
   * Privacy status of a root window: true when it or a window in its owner chain (a dialog's
   * app window) matches the exclusions, null when one of them cannot be identified. Windows
   * of this process are never private, and their titles are never read.
   */
  function privacyOf(h: Hwnd, names: NameLookup): boolean | null {
    let cur: Hwnd | null = h;
    for (let depth = 0; cur !== null; depth++) {
      if (depth > MAX_OWNER_DEPTH) return null;
      const pid = native.getWindowProcessId(cur);
      if (pid === 0) return null;
      if (pid !== ownPid) {
        const name = resolveProcessName(cur, pid, names);
        if (name === '') return null;
        if (computeExcluded(cur, pid, name)) return true;
      }
      cur = native.getWindow(cur, GW_OWNER);
    }
    return false;
  }

  /** Visible, not minimized and not cloaked (on this virtual desktop). A failed cloak query counts as shown. */
  function isShown(h: Hwnd): boolean {
    if (!native.isWindowVisible(h) || native.isIconic(h)) return false;
    const cloaked = native.getCloaked(h);
    return cloaked === null || cloaked === 0;
  }

  /** Visible frame (DWM bounds, else GetWindowRect); null when unknown or empty. */
  function frameRect(h: Hwnd): Rect | null {
    const r = native.getExtendedFrameBounds(h) ?? native.getWindowRect(h);
    if (r === null) return null;
    const rect = toRect(r);
    return rect.width > 0 && rect.height > 0 ? rect : null;
  }

  /**
   * The window shown at p, found by walking the z-order: the first shown window whose frame
   * contains p, skipping click-through windows (as hit-testing does) and this app's overlays.
   */
  function shownWindowAt(p: Point): Hwnd | null {
    for (const h of native.enumTopLevelWindows()) {
      if (!isShown(h)) continue;
      const exStyle = native.getWindowLong(h, GWL_EXSTYLE);
      if (isClickThrough(exStyle)) continue;
      if (native.getWindowProcessId(h) === ownPid && isOverlayStyle(exStyle)) continue;
      const r = frameRect(h);
      if (r && rectContains(r, p)) return h;
    }
    return null;
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

    const processName = resolveProcessName(h, pid, cachedNames);
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
          workRect: mon.work,
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
      guard<boolean | null>('isWindowExcluded', null, () => {
        const h = parseWindowId(id);
        if (h === null || !native.isWindow(h)) return null;
        return privacyOf(native.getAncestor(h, GA_ROOT) ?? h, freshNames());
      }),

    isForegroundExcluded: () =>
      guard<boolean | null>('isForegroundExcluded', null, () => {
        const h = native.getForegroundWindow();
        if (h === null) return null;
        return privacyOf(native.getAncestor(h, GA_ROOT) ?? h, freshNames());
      }),

    isPointExcluded: (p) =>
      guard<boolean | null>('isPointExcluded', null, () => {
        if (!Number.isFinite(p.x) || !Number.isFinite(p.y)) return null;
        const hit = native.windowFromPoint(p.x, p.y);
        if (hit === null) return null;
        const root = native.getAncestor(hit, GA_ROOT) ?? hit;
        // Hit-testing reaches our overlay only while it is interactive; it is transparent, so
        // what the frame shows there is the window below it.
        const shown = native.getWindowProcessId(root) === ownPid ? shownWindowAt(p) : root;
        return shown === null ? null : privacyOf(shown, freshNames());
      }),

    listExcludedRects: () =>
      guard<Rect[] | null>('listExcludedRects', null, () => {
        const names = freshNames();
        const out: Rect[] = [];
        for (const h of native.enumTopLevelWindows()) {
          if (!isShown(h) || privacyOf(h, names) === false) continue;
          // GetWindowRect contains the visible frame: the safer mask.
          const r = native.getWindowRect(h) ?? native.getExtendedFrameBounds(h);
          if (r === null) {
            // A private window that is still there but cannot be located cannot be masked.
            if (native.isWindow(h)) return null;
            continue;
          }
          const rect = toRect(r);
          if (rect.width > 0 && rect.height > 0) out.push(rect);
        }
        return out;
      }),

    listOccluders: () =>
      guard<Occluder[] | null>('listOccluders', null, () => {
        const out: Occluder[] = [];
        for (const h of native.enumTopLevelWindows()) {
          if (!isShown(h)) continue;
          const exStyle = native.getWindowLong(h, GWL_EXSTYLE);
          if (isClickThrough(exStyle)) continue;
          const pid = native.getWindowProcessId(h);
          if (pid === 0 || (pid === ownPid && isOverlayStyle(exStyle))) continue;
          if (DESKTOP_WINDOW_CLASSES.has(native.getClassName(h))) continue;
          const rect = frameRect(h);
          if (rect) out.push({ id: h.toString(), rect });
        }
        return out;
      }),

    windowProcessId: (id) =>
      guard<number | null>('windowProcessId', null, () => {
        const h = parseWindowId(id);
        if (h === null || !native.isWindow(h)) return null;
        const pid = native.getWindowProcessId(h);
        return pid === 0 ? null : pid;
      }),

    // Mouse buttons only (VK_LBUTTON, VK_RBUTTON, VK_MBUTTON); keyboard state is never read.
    mouseButtons: () => guard<MouseButtonState>('mouseButtons', buttons.last, () => buttons.sample()),

    clickObstaclesPx: () => guard<ClickObstacles>('clickObstacles', { rects: [], fresh: false }, () => obstacleSource().get()),

    setObstacleWatch: (armed) => guard('setObstacleWatch', undefined, () => (disposed ? undefined : obstacleSource().setArmed(armed))),

    obstacleStats: () => obstacles?.stats() ?? null,

    dispose() {
      disposed = true;
      for (const unsubscribe of [...subscriptions]) unsubscribe();
      obstacles?.dispose();
      processNames.clear();
      appWindowIds.clear();
      lastRects.clear();
    },
  };
}

/** Safe stand-in when koffi or a system DLL cannot be loaded (or off Windows). */
export function createUnavailableWin32Api(): ExtendedWin32Api & Win32InputExtensions {
  return {
    windowProcessId: () => null,
    mouseButtons: () => ({ down: false, presses: 0 }),
    // No obstacle knowledge: always stale (the guard fails closed).
    clickObstaclesPx: () => ({ rects: [], fresh: false }),
    setObstacleWatch: () => undefined,
    obstacleStats: () => null,
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
    isForegroundExcluded: () => null,
    isPointExcluded: () => null,
    listExcludedRects: () => null,
    listOccluders: () => null,
    dispose: () => undefined,
  };
}
