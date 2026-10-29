// WindowTracker (src/main/contracts.ts).
//
// Pipeline: WinEvent hook -> O(1) push into a bounded raw queue -> on drainEvents() the
// raw events mark windows "pending"; a window settles once its burst has been quiet for
// `coalesceMs` (or after `maxSettleMs`), is described once and diffed against the model,
// producing at most one state event per burst. A slow reconcile (listAppWindows diff)
// catches missed events, and a foreground poll is kept as a safety net even with hooks.
// Without hooks the same reconcile + poll run alone ('polling'). Nothing runs on timers:
// the host's tick drives all work, so the cost is bounded by the tick rate.
// Move and close events carry the window's tracked `excluded` flag so the cat leaves
// private windows alone; private windows never offer a perch platform.
// Incremental consumers (the surface provider) subscribe to change notices through
// onChange(): raw hook events as they are ingested, settled window changes, z-order
// (foreground) changes and "anything may have changed". Notices carry ids only.
import type { Point, Rect } from '../../shared/geometry';
import type { SimEvent } from '../../shared/sim';
import type { Platform, WindowInfo, WorldGeometry } from '../../shared/world';
import type { Logger, RawWinEvent, Unsubscribe, Win32Api, WindowTracker } from '../contracts';
import { BoundedQueue } from './collections';
import { computeFullscreenDisplayIds, computePlatforms, MIN_PLATFORM_WIDTH } from './platforms';
import { ExclusionRules } from './processNames';
import { hasWin32Extensions } from './win32Api';
import type { NotificationState } from './windowRules';

export interface WindowTrackerOptions {
  /** Monotonic clock (ms). */
  now?: () => number;
  coalesceMs?: number;
  maxSettleMs?: number;
  reconcileMs?: number;
  foregroundPollMs?: number;
  rawQueueCapacity?: number;
  eventQueueCapacity?: number;
}

export interface WindowTrackerDebug {
  mode: WindowTracker['mode'];
  running: boolean;
  knownWindows: number;
  pendingWindows: number;
  rawDropped: number;
  eventsDropped: number;
  pendingOverflows: number;
  switchesPerMinute: number;
}

/** A change notice of the tracker's window model (ids and kinds only, never titles). */
export type WindowChange =
  /** A window's burst settled (or the reconcile saw it change): `windowInfo(id)` is current. */
  | { kind: 'window'; id: string; change: 'shown' | 'closed' | 'updated' | 'minimized' | 'restored'; at: number }
  /** A raw hook event was ingested, before its burst settles (a drag or a minimize starting). */
  | { kind: 'raw'; id: string; raw: Exclude<RawWinEvent['kind'], 'foreground'>; at: number }
  /** The foreground window changed, so the z-order did too (`id` is the raw foreground HWND). */
  | { kind: 'zorder'; id: string | null; at: number }
  /** Anything may have changed (tracking started or stopped, exclusions changed, event overflow). */
  | { kind: 'all'; at: number };

export interface WindowTrackerExtras {
  debugInfo(): WindowTrackerDebug;
  readonly running: boolean;
  /** Subscribes to change notices; they are delivered synchronously from drainEvents(), start(), stop() and setExclusions(). */
  onChange(listener: (change: WindowChange) => void): Unsubscribe;
  /** Tracked info of an app window (no OS call), null when it is not tracked. */
  windowInfo(id: string): WindowInfo | null;
  /** App windows in z-order (top first) from an enumeration at most `maxAgeMs` old; [] when not running. */
  listWindows(maxAgeMs: number): readonly WindowInfo[];
  /** True while the window is being moved or sized (a move/size start without its end). */
  isMoving(id: string): boolean;
}

type RawKind = RawWinEvent['kind'];

interface Tracked {
  info: WindowInfo;
  lastRect: Rect | null;
  moving: boolean;
  movingSince: number;
}

interface Pending {
  firstAt: number;
  lastAt: number;
  lastMove: 'moveStart' | 'moveEnd' | null;
  sawMoveStart: boolean;
  sawMoveEnd: boolean;
}

const MAX_PENDING_WINDOWS = 256;
const MAX_SWITCH_SAMPLES = 512;
const SWITCH_WINDOW_MS = 60_000;
const STUCK_MOVE_MS = 60_000;
const NOTIFICATION_CACHE_MS = 1000;
const FOREGROUND_REFRESH_MS = 1000;
const POLLING_MODE_FOREGROUND_MS = 500;
const RECONCILE_LIST_REUSE_MS = 250;
const FULLSCREEN_LIST_MAX_AGE_MS = 1000;
/** getExcludedRects() answer when private windows cannot be located: mask everything. */
const MASK_EVERYTHING: Rect = Object.freeze({ x: -(2 ** 31), y: -(2 ** 31), width: 2 ** 32, height: 2 ** 32 });

const moved = (a: Rect, b: Rect): boolean =>
  Math.abs(a.x - b.x) > 2 || Math.abs(a.y - b.y) > 2 || Math.abs(a.width - b.width) > 2 || Math.abs(a.height - b.height) > 2;

/** Any change a geometry consumer cares about: the exact rect, the state flags or the privacy verdict. */
const infoChanged = (a: WindowInfo, b: WindowInfo): boolean =>
  a.rect.x !== b.rect.x ||
  a.rect.y !== b.rect.y ||
  a.rect.width !== b.rect.width ||
  a.rect.height !== b.rect.height ||
  a.minimized !== b.minimized ||
  a.maximized !== b.maximized ||
  a.fullscreen !== b.fullscreen ||
  a.excluded !== b.excluded;

export function createWindowTracker(api: Win32Api, logger: Logger, opts: WindowTrackerOptions = {}): WindowTracker & WindowTrackerExtras {
  const log = logger.child('windows');
  const now = opts.now ?? (() => performance.now());
  const coalesceMs = opts.coalesceMs ?? 150;
  const maxSettleMs = opts.maxSettleMs ?? 600;
  const reconcileMs = opts.reconcileMs ?? 2500;
  const hookPollMs = opts.foregroundPollMs ?? 750;

  const raw = new BoundedQueue<{ kind: RawKind; id: string; at: number }>(opts.rawQueueCapacity ?? 512);
  const out = new BoundedQueue<SimEvent>(opts.eventQueueCapacity ?? 256);
  const windows = new Map<string, Tracked>();
  const pending = new Map<string, Pending>();
  const switchTimes: number[] = [];
  const rules = new ExclusionRules();
  const extended = hasWin32Extensions(api) ? api : null;
  const listeners = new Set<(change: WindowChange) => void>();

  let mode: WindowTracker['mode'] = api.available ? 'polling' : 'unavailable';
  let running = false;
  let unsubscribe: Unsubscribe | null = null;
  let fgPending: { firstAt: number; lastAt: number } | null = null;
  let fgRawId: string | null = null;
  let fg: WindowInfo | null = null;
  let fgRefreshedAt = -Infinity;
  let lastFgPollAt = -Infinity;
  let lastReconcileAt = -Infinity;
  let forceReconcile = false;
  let pendingOverflows = 0;
  let listCache: { at: number; windows: WindowInfo[] } | null = null;
  let platformCache: { at: number; platforms: Platform[] } | null = null;
  let notificationCache: { at: number; state: NotificationState } | null = null;
  let errorCount = 0;

  const emit = (e: SimEvent): void => out.push(e);

  function notify(change: WindowChange): void {
    for (const listener of listeners) {
      try {
        listener(change);
      } catch (e) {
        reportError('changeListener', e);
      }
    }
  }

  /** Replaces a tracked window's info and notices consumers when anything relevant changed. */
  function updateInfo(entry: Tracked, info: WindowInfo, t: number): void {
    const before = entry.info;
    entry.info = info;
    if (!info.minimized) entry.lastRect = info.rect;
    if (infoChanged(before, info)) notify({ kind: 'window', id: info.id, change: 'updated', at: t });
  }

  /** Applies tracker-level process rules for APIs that cannot evaluate exclusions themselves. */
  const withRules = (info: WindowInfo | null): WindowInfo | null =>
    info && !info.excluded && !extended && rules.matchesProcess(info.processName) ? { ...info, excluded: true } : info;

  const describe = (id: string): WindowInfo | null => withRules(api.describeWindow(id));

  const invalidateGeometry = (): void => {
    listCache = null;
    platformCache = null;
  };

  function freshList(t: number, maxAgeMs: number): WindowInfo[] {
    if (listCache && t - listCache.at <= maxAgeMs) return listCache.windows;
    const list: WindowInfo[] = [];
    for (const w of api.listAppWindows()) {
      const info = withRules(w);
      if (info) list.push(info);
    }
    listCache = { at: t, windows: list };
    return list;
  }

  function switchesPerMinute(t: number): number {
    while (switchTimes.length > 0 && t - (switchTimes[0] ?? t) >= SWITCH_WINDOW_MS) switchTimes.shift();
    return switchTimes.length;
  }

  function track(info: WindowInfo): Tracked {
    const entry: Tracked = { info, lastRect: info.minimized ? null : info.rect, moving: false, movingSince: 0 };
    windows.set(info.id, entry);
    return entry;
  }

  function markForeground(t: number): void {
    if (fgPending) fgPending.lastAt = t;
    else fgPending = { firstAt: t, lastAt: t };
  }

  function ingest(): void {
    for (const ev of raw.drain()) {
      if (ev.kind === 'foreground') {
        markForeground(ev.at);
        continue;
      }
      let p = pending.get(ev.id);
      if (!p) {
        if (pending.size >= MAX_PENDING_WINDOWS) {
          // A storm of distinct windows: let a full reconcile sort it out.
          pendingOverflows++;
          forceReconcile = true;
          notify({ kind: 'all', at: ev.at });
          continue;
        }
        p = { firstAt: ev.at, lastAt: ev.at, lastMove: null, sawMoveStart: false, sawMoveEnd: false };
        pending.set(ev.id, p);
      }
      p.lastAt = Math.max(p.lastAt, ev.at);
      if (ev.kind === 'moveStart') {
        p.sawMoveStart = true;
        p.lastMove = 'moveStart';
      } else if (ev.kind === 'moveEnd') {
        p.sawMoveEnd = true;
        p.lastMove = 'moveEnd';
      }
      notify({ kind: 'raw', id: ev.id, raw: ev.kind, at: ev.at });
    }
  }

  function settleMoves(id: string, entry: Tracked, p: Pending, prevRect: Rect | null, t: number): void {
    if (!p.sawMoveStart && !p.sawMoveEnd) return;
    const rectNow = entry.info.minimized ? null : entry.info.rect;
    const excluded = entry.info.excluded;
    const finalMoving = p.lastMove === 'moveStart';
    if (!entry.moving && finalMoving) {
      emit({ type: 'window.moveStart', id, excluded });
      entry.moving = true;
      entry.movingSince = t;
    } else if (entry.moving && !finalMoving) {
      emit({ type: 'window.moveEnd', id, rect: rectNow, excluded });
      entry.moving = false;
    } else if (!entry.moving && p.sawMoveStart) {
      // Press-drag-release inside one burst: report it only if the window actually moved.
      if (prevRect && rectNow && moved(prevRect, rectNow)) {
        emit({ type: 'window.moveStart', id, excluded });
        emit({ type: 'window.moveEnd', id, rect: rectNow, excluded });
      }
    } else if (entry.moving && p.sawMoveEnd) {
      emit({ type: 'window.moveEnd', id, rect: rectNow, excluded });
      emit({ type: 'window.moveStart', id, excluded });
      entry.movingSince = t;
    }
  }

  function settleWindow(id: string, p: Pending, t: number): void {
    const prev = windows.get(id);
    const info = describe(id);
    if (!info) {
      if (prev) {
        windows.delete(id);
        emit({ type: 'window.closed', id, rect: prev.lastRect, category: prev.info.category, excluded: prev.info.excluded });
        invalidateGeometry();
        notify({ kind: 'window', id, change: 'closed', at: t });
      }
      return;
    }
    if (!prev) {
      const entry = track(info);
      emit({ type: 'window.shown', window: info });
      settleMoves(id, entry, p, null, t);
      invalidateGeometry();
      notify({ kind: 'window', id, change: 'shown', at: t });
      return;
    }
    const wasMinimized = prev.info.minimized;
    const prevRect = prev.lastRect;
    prev.info = info;
    if (!info.minimized) prev.lastRect = info.rect;
    let change: 'updated' | 'minimized' | 'restored' = 'updated';
    if (!wasMinimized && info.minimized) {
      prev.moving = false;
      emit({ type: 'window.minimized', id });
      change = 'minimized';
    } else if (wasMinimized && !info.minimized) {
      emit({ type: 'window.restored', window: info });
      change = 'restored';
    }
    settleMoves(id, prev, p, prevRect, t);
    if (fg && fg.id === id) {
      fg = info;
      fgRefreshedAt = t;
    }
    invalidateGeometry();
    // A settled burst always re-validates the window (a drag may have ended where it began).
    notify({ kind: 'window', id, change, at: t });
  }

  function settleForeground(t: number): void {
    fgPending = null;
    const id = api.getForegroundWindowId();
    const info = id ? describe(id) : null;
    const prevRawId = fgRawId;
    fgRawId = id;
    fgRefreshedAt = t;
    const prevAppId = fg?.id ?? null;
    fg = info;
    if (info) {
      const known = windows.get(info.id);
      if (!known) {
        track(info);
        emit({ type: 'window.shown', window: info });
        invalidateGeometry();
        notify({ kind: 'window', id: info.id, change: 'shown', at: t });
      } else if (!pending.has(info.id)) {
        updateInfo(known, info, t);
      }
    }
    // Any window coming to the front (owned dialogs and tool windows too) reorders the z-order.
    if (id !== prevRawId) notify({ kind: 'zorder', id, at: t });
    if ((info?.id ?? null) === prevAppId) return;
    switchTimes.push(t);
    if (switchTimes.length > MAX_SWITCH_SAMPLES) switchTimes.shift();
    emit({ type: 'window.foreground', window: info, switchesPerMinute: switchesPerMinute(t) });
  }

  function pollForeground(t: number): void {
    lastFgPollAt = t;
    const id = api.getForegroundWindowId();
    if (id !== fgRawId) {
      markForeground(t);
      return;
    }
    if (t - fgRefreshedAt >= FOREGROUND_REFRESH_MS) refreshForegroundInfo(t);
  }

  function refreshForegroundInfo(t: number): void {
    fgRefreshedAt = t;
    fg = fgRawId ? describe(fgRawId) : null;
    if (fg) {
      const known = windows.get(fg.id);
      if (known && !pending.has(fg.id)) updateInfo(known, fg, t);
    }
  }

  function reconcile(t: number, emitEvents: boolean): void {
    lastReconcileAt = t;
    forceReconcile = false;
    const list = freshList(t, RECONCILE_LIST_REUSE_MS);
    const seen = new Set<string>();
    for (const info of list) {
      seen.add(info.id);
      // Windows with a pending burst are diffed when that burst settles.
      if (pending.has(info.id)) continue;
      const prev = windows.get(info.id);
      if (!prev) {
        track(info);
        // The silent start-up reconcile announces nothing per window (start() notices 'all').
        if (emitEvents) {
          emit({ type: 'window.shown', window: info });
          notify({ kind: 'window', id: info.id, change: 'shown', at: t });
        }
        continue;
      }
      const wasMinimized = prev.info.minimized;
      const prevRect = prev.lastRect;
      updateInfo(prev, info, t);
      if (!emitEvents) continue;
      if (!wasMinimized && info.minimized) {
        prev.moving = false;
        emit({ type: 'window.minimized', id: info.id });
      } else if (wasMinimized && !info.minimized) {
        emit({ type: 'window.restored', window: info });
      } else if (mode === 'polling' && !info.minimized && prevRect && moved(prevRect, info.rect)) {
        // Without hooks there are no move/size notifications: report the observed move.
        emit({ type: 'window.moveStart', id: info.id, excluded: info.excluded });
        emit({ type: 'window.moveEnd', id: info.id, rect: info.rect, excluded: info.excluded });
      }
      if (prev.moving && t - prev.movingSince > STUCK_MOVE_MS) {
        prev.moving = false;
        emit({ type: 'window.moveEnd', id: info.id, rect: info.minimized ? null : info.rect, excluded: info.excluded });
      }
    }
    for (const [id, prev] of windows) {
      if (seen.has(id) || pending.has(id)) continue;
      windows.delete(id);
      if (emitEvents) emit({ type: 'window.closed', id, rect: prev.lastRect, category: prev.info.category, excluded: prev.info.excluded });
      notify({ kind: 'window', id, change: 'closed', at: t });
    }
    platformCache = null;
  }

  function step(t: number): void {
    ingest();
    const pollMs = mode === 'polling' ? Math.min(hookPollMs, POLLING_MODE_FOREGROUND_MS) : hookPollMs;
    if (t - lastFgPollAt >= pollMs) pollForeground(t);
    for (const [id, p] of pending) {
      if (t - p.lastAt >= coalesceMs || t - p.firstAt >= maxSettleMs) {
        pending.delete(id);
        settleWindow(id, p, t);
      }
    }
    if (fgPending && (t - fgPending.lastAt >= coalesceMs || t - fgPending.firstAt >= maxSettleMs)) settleForeground(t);
    if (forceReconcile || t - lastReconcileAt >= reconcileMs) reconcile(t, true);
  }

  function reportError(op: string, e: unknown): void {
    errorCount++;
    if (errorCount <= 5 || errorCount % 1000 === 0) log.warn('window tracker step failed', { op, count: errorCount, error: e instanceof Error ? e.message : String(e) });
  }

  function getForeground(): WindowInfo | null {
    if (!running) return fg;
    const t = now();
    if (t - fgRefreshedAt >= FOREGROUND_REFRESH_MS) {
      try {
        if (api.getForegroundWindowId() !== fgRawId) markForeground(t);
        else refreshForegroundInfo(t);
      } catch (e) {
        reportError('foreground', e);
      }
    }
    return fg;
  }

  function cachedNotification(t: number): NotificationState {
    if (notificationCache && t - notificationCache.at < NOTIFICATION_CACHE_MS) return notificationCache.state;
    const state = api.getNotificationState();
    if (notificationCache && notificationCache.state !== state) log.debug('notification state changed', { state });
    notificationCache = { at: t, state };
    return state;
  }

  return {
    get mode() {
      return mode;
    },

    get running() {
      return running;
    },

    start() {
      if (running) return;
      if (!api.available) {
        mode = 'unavailable';
        log.warn('window awareness unavailable (Win32 API not loaded)');
        return;
      }
      running = true;
      try {
        unsubscribe = api.subscribeWinEvents((ev) => raw.push({ kind: ev.kind, id: ev.id, at: now() }));
      } catch (e) {
        unsubscribe = null;
        reportError('subscribe', e);
      }
      mode = unsubscribe ? 'event-hooks' : 'polling';
      try {
        const t = now();
        invalidateGeometry();
        reconcile(t, false);
        fgRawId = api.getForegroundWindowId();
        refreshForegroundInfo(t);
        lastFgPollAt = t;
      } catch (e) {
        reportError('start', e);
      }
      log.info('window tracking started', { mode, windows: windows.size });
      notify({ kind: 'all', at: now() });
    },

    stop() {
      if (!running) return;
      running = false;
      try {
        unsubscribe?.();
      } catch (e) {
        reportError('unsubscribe', e);
      }
      unsubscribe = null;
      raw.clear();
      pending.clear();
      fgPending = null;
      invalidateGeometry();
      notify({ kind: 'all', at: now() });
    },

    drainEvents() {
      if (running) {
        try {
          step(now());
        } catch (e) {
          reportError('drain', e);
        }
      }
      return out.drain();
    },

    getForeground,

    getPlatforms(maxAgeMs: number): readonly Platform[] {
      if (!running) return [];
      const t = now();
      if (platformCache && t - platformCache.at <= maxAgeMs) return platformCache.platforms;
      try {
        // Owned dialogs, tool windows and our Settings window cut edges too; app windows
        // alone are the fallback when the full z-order is not available. Private windows
        // cut edges but offer none (see computePlatforms).
        const occluders = extended?.listOccluders() ?? null;
        platformCache = { at: t, platforms: computePlatforms(freshList(t, maxAgeMs), MIN_PLATFORM_WIDTH, occluders) };
      } catch (e) {
        reportError('platforms', e);
        platformCache = { at: t, platforms: [] };
      }
      return platformCache.platforms;
    },

    getWindowRect(id: string): Rect | null {
      try {
        return api.getWindowRect(id);
      } catch (e) {
        reportError('rect', e);
        return null;
      }
    },

    getFullscreenDisplayIds(world: WorldGeometry): string[] {
      if (!running || world.displays.length === 0) return [];
      try {
        const t = now();
        const notification = cachedNotification(t);
        const foreground = getForeground();
        const exclusive = notification === 'd3d-fullscreen' || notification === 'presentation' || notification === 'fullscreen';
        return computeFullscreenDisplayIds({
          displays: world.displays,
          windows: freshList(t, FULLSCREEN_LIST_MAX_AGE_MS),
          foreground,
          foregroundRect: exclusive && !foreground && fgRawId ? api.getWindowRect(fgRawId) : null,
          notification,
        });
      } catch (e) {
        reportError('fullscreen', e);
        return [];
      }
    },

    isExcludedAt(p: Point): boolean {
      // Privacy check: anything we cannot positively clear counts as excluded.
      if (!api.available) return true;
      try {
        if (extended) return extended.isPointExcluded(p) ?? true;
        const id = api.windowIdAtPoint(p);
        if (id === null) return true;
        const info = describe(id);
        return info ? info.excluded : true;
      } catch (e) {
        reportError('excluded', e);
        return true;
      }
    },

    isForegroundExcluded(): boolean {
      // Privacy check of the real foreground window, app window or not (owned dialogs, popups).
      if (!api.available) return true;
      try {
        if (extended) return extended.isForegroundExcluded() ?? true;
        const id = api.getForegroundWindowId();
        return id !== null && (describe(id)?.excluded ?? true);
      } catch (e) {
        reportError('foregroundExcluded', e);
        return true;
      }
    },

    getExcludedRects(): Rect[] {
      // Fresh enumeration (only called per capture) of every shown window, dialogs and
      // popups included. When they cannot be located, everything is masked.
      if (!api.available) return [{ ...MASK_EVERYTHING }];
      try {
        if (extended) {
          const rects = extended.listExcludedRects();
          return rects ? rects.map((r) => ({ ...r })) : [{ ...MASK_EVERYTHING }];
        }
        const rects: Rect[] = [];
        for (const w of api.listAppWindows()) {
          if (w.minimized || w.rect.width <= 0 || w.rect.height <= 0) continue;
          if (withRules(w)?.excluded) rects.push({ ...w.rect });
        }
        return rects;
      } catch (e) {
        reportError('excludedRects', e);
        return [{ ...MASK_EVERYTHING }];
      }
    },

    setExclusions(processes: readonly string[], titlePatterns: readonly string[]) {
      rules.set(processes, titlePatterns);
      try {
        extended?.setExclusions(processes, titlePatterns);
      } catch (e) {
        reportError('exclusions', e);
      }
      // Cached and tracked infos carry stale `excluded` flags: re-list on the next drain.
      invalidateGeometry();
      fgRefreshedAt = -Infinity;
      forceReconcile = true;
      notify({ kind: 'all', at: now() });
    },

    debugInfo(): WindowTrackerDebug {
      return {
        mode,
        running,
        knownWindows: windows.size,
        pendingWindows: pending.size,
        rawDropped: raw.dropped,
        eventsDropped: out.dropped,
        pendingOverflows,
        switchesPerMinute: switchesPerMinute(now()),
      };
    },

    onChange(listener: (change: WindowChange) => void): Unsubscribe {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },

    windowInfo(id: string): WindowInfo | null {
      return windows.get(id)?.info ?? null;
    },

    listWindows(maxAgeMs: number): readonly WindowInfo[] {
      if (!running) return [];
      try {
        return freshList(now(), maxAgeMs);
      } catch (e) {
        reportError('listWindows', e);
        return [];
      }
    },

    isMoving(id: string): boolean {
      if (windows.get(id)?.moving === true) return true;
      // A move/size start not settled yet (the burst is still pending).
      return pending.get(id)?.lastMove === 'moveStart';
    },
  };
}
