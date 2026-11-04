// Click-guard obstacle source for the screen-edge walls (ADR 0003 §6.1 (a), T8). Main only: the rects
// are never passed to the sim, logged or exported (§13).
//
// Every visible, uncloaked top-level window except this app's overlays: app windows, this app's own
// Settings window and dialogs, topmost, tool and popup windows (browser picture-in-picture, Task
// Manager), click-through windows and privacy-excluded windows, as GetWindowRect (resize borders
// included; the caller grows them by its margin). Only the desktop itself (wallpaper, icons) is left
// out. Nothing but class names, styles, process ids and rects is read; never a title.
//
// The list is cached. It is invalidated by WinEvents (create, show, hide, location change,
// foreground, minimize, move/size, cloak, uncloak, destroy) hooked only while the source is armed
// (the guard is in use: the cursor on a clinging, edge-flying or bailing-out cat), and re-enumerated
// only when asked and invalid or older than maxAgeMs, at most every minEnumerateGapMs. Fail closed:
// an invalid cache that cannot be refreshed yet, a failed or incomplete enumeration, or a missing
// hook answers fresh = false, and the caller then makes the whole cat click-through.
import type { Rect } from '../../shared/geometry';
import type { Logger } from '../contracts';
import { CHILDID_SELF, DESKTOP_WINDOW_CLASSES, EVENT_OBJECT_DESTROY, GA_ROOT, GWL_EXSTYLE, OBJID_WINDOW, OBSTACLE_EVENT_RANGES, WINEVENT_OUTOFCONTEXT } from './constants';
import type { Hwnd, Win32Native } from './native';
import { isOverlayStyle, toRect } from './windowRules';

export interface ClickObstacles {
  /** GetWindowRect of every obstacle window (px), top of the z-order first. */
  rects: readonly Rect[];
  /** The list is current; false = stale or unknown: the caller must fail closed. */
  fresh: boolean;
}

export interface ClickObstacleOptions {
  /** Monotonic clock (ms). */
  now: () => number;
  /** A cache older than this is re-enumerated (ms; ADR: 250). */
  maxAgeMs?: number;
  /** Enumerations at most this often (ms); in between an invalid cache is reported stale. */
  minEnumerateGapMs?: number;
  /** Bound on the listed rects (a longer list is incomplete: stale). */
  maxRects?: number;
}

export interface ClickObstacleStats {
  armed: boolean;
  hooks: number;
  enumerations: number;
  invalidations: number;
  stale: number;
  failures: number;
  lastEnumerateMs: number | null;
  rects: number;
}

export interface ClickObstacleSource {
  get(): ClickObstacles;
  /** Installs (true) or removes (false) the invalidation hooks; the click guard is in use. */
  setArmed(armed: boolean): void;
  invalidate(): void;
  stats(): ClickObstacleStats;
  dispose(): void;
}

const EMPTY: readonly Rect[] = Object.freeze([]);

export function createClickObstacleSource(native: Win32Native, logger: Logger, opts: ClickObstacleOptions): ClickObstacleSource {
  const log = logger.child('clickObstacles');
  const maxAgeMs = opts.maxAgeMs ?? 250;
  const minGapMs = opts.minEnumerateGapMs ?? 50;
  const maxRects = opts.maxRects ?? 512;
  const ownPid = native.ownPid;

  let rects: readonly Rect[] = EMPTY;
  let complete = false;
  let valid = false;
  let enumeratedAt = Number.NEGATIVE_INFINITY;
  let armed = false;
  let proc: bigint | null = null;
  let hooks: bigint[] = [];
  let disposed = false;
  const stats = { enumerations: 0, invalidations: 0, stale: 0, failures: 0, lastEnumerateMs: null as number | null };

  function invalidate(): void {
    if (!valid) return;
    valid = false;
    stats.invalidations++;
  }

  /** O(1) WinEvent filter: top-level window events only (cursor and caret moves are dropped at once). */
  function onEvent(event: number, hwnd: Hwnd | null, idObject: number, idChild: number): void {
    if (!valid || hwnd === null || idObject !== OBJID_WINDOW || idChild !== CHILDID_SELF) return;
    // A destroyed window can no longer be asked for its root: invalidate anyway.
    if (event !== EVENT_OBJECT_DESTROY && native.getAncestor(hwnd, GA_ROOT) !== hwnd) return;
    invalidate();
  }

  function install(): void {
    if (proc !== null || disposed) return;
    try {
      proc = native.registerWinEventProc(onEvent);
      const installed: bigint[] = [];
      // Not WINEVENT_SKIPOWNPROCESS: our own Settings window and dialogs are obstacles too.
      for (const [min, max] of OBSTACLE_EVENT_RANGES) {
        const h = native.setWinEventHook(min, max, proc, WINEVENT_OUTOFCONTEXT);
        if (h !== null) installed.push(h);
      }
      hooks = installed;
      if (installed.length < OBSTACLE_EVENT_RANGES.length) log.warn('click-guard hooks incomplete; the guard re-reads windows every time', { installed: installed.length });
    } catch (e) {
      stats.failures++;
      log.warn('click-guard hooks failed', { error: e instanceof Error ? e.message : String(e) });
    }
  }

  function uninstall(): void {
    for (const h of hooks) {
      try {
        native.unhookWinEvent(h);
      } catch {
        /* already gone */
      }
    }
    hooks = [];
    if (proc !== null) {
      try {
        native.unregisterCallback(proc);
      } catch {
        /* already gone */
      }
      proc = null;
    }
  }

  const hooked = (): boolean => hooks.length === OBSTACLE_EVENT_RANGES.length;

  function enumerate(now: number): void {
    const t0 = now;
    stats.enumerations++;
    const out: Rect[] = [];
    let ok = true;
    try {
      for (const h of native.enumTopLevelWindows()) {
        if (!native.isWindowVisible(h) || native.isIconic(h)) continue;
        const cloaked = native.getCloaked(h);
        if (cloaked !== null && cloaked !== 0) continue;
        if (native.getWindowProcessId(h) === ownPid && isOverlayStyle(native.getWindowLong(h, GWL_EXSTYLE))) continue;
        if (DESKTOP_WINDOW_CLASSES.has(native.getClassName(h))) continue;
        const r = native.getWindowRect(h) ?? native.getExtendedFrameBounds(h);
        if (r === null) {
          // Still there but cannot be located: it cannot be guarded.
          if (native.isWindow(h)) ok = false;
          continue;
        }
        const rect = toRect(r);
        if (!(rect.width > 0 && rect.height > 0)) continue;
        if (out.length >= maxRects) {
          ok = false;
          break;
        }
        out.push(rect);
      }
    } catch (e) {
      ok = false;
      stats.failures++;
      if (stats.failures <= 3) log.warn('click-guard window enumeration failed', { error: e instanceof Error ? e.message : String(e) });
    }
    rects = Object.freeze(out);
    complete = ok;
    valid = true;
    enumeratedAt = now;
    stats.lastEnumerateMs = Math.max(0, opts.now() - t0);
  }

  return {
    get(): ClickObstacles {
      if (disposed) return { rects: EMPTY, fresh: false };
      const now = opts.now();
      // Without every hook installed, only a list read this instant is trusted.
      const current = valid && now - enumeratedAt <= maxAgeMs && (hooked() || now - enumeratedAt <= 0);
      if (!current) {
        if (now - enumeratedAt < minGapMs && enumeratedAt !== Number.NEGATIVE_INFINITY) {
          stats.stale++;
          return { rects, fresh: false };
        }
        enumerate(now);
      }
      const fresh = complete && (hooked() || now - enumeratedAt <= 0);
      if (!fresh) stats.stale++;
      return { rects, fresh };
    },
    setArmed(next: boolean): void {
      if (disposed || next === armed) return;
      armed = next;
      if (armed) install();
      else uninstall();
      // Events were not watched before arming: whatever was cached is unknown now.
      valid = false;
    },
    invalidate,
    stats: () => ({ armed, hooks: hooks.length, ...stats, rects: rects.length }),
    dispose(): void {
      disposed = true;
      uninstall();
      rects = EMPTY;
      valid = false;
    },
  };
}
