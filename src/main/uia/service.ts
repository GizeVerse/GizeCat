// TabStripService (src/main/contracts.ts): browser tab strips as walkable ledges, read through the
// DesktopCatUia helper (geometry only; ADR 0002 §3).
//
// - Lazy: the helper starts only while the tabStrips toggle is on and an interesting Edge/Chrome
//   window exists (setInterest), and stops after `idleShutdownMs` without one.
// - Windows passed to setInterest are polled at 1 Hz (the cat is on or heading to them; tab rects
//   raise no change events). Windows that were of interest recently stay listed and are refreshed
//   only on helper events (tab selected, content structure changed) or when they are resized, then
//   dropped after `idleShutdownMs`.
// - Excluded (private) windows are never queried: the exclusion verdict is re-read right before
//   every request and an excluded window is dropped on sight.
// - A crashed, blocked or hung helper is restarted with exponential backoff; after too many
//   failures the service reports 'unavailable' with a reason (window tops keep working).
// All decisions use the injected clock; the optional internal timer only calls pump(now()).
import type { Point } from '../../shared/geometry';
import type { Settings } from '../../shared/settings';
import type { SimEvent } from '../../shared/sim';
import type { LedgeSurface, SurfaceStatus } from '../../shared/surfaces';
import type { WindowInfo } from '../../shared/world';
import type { Logger, TabStripService } from '../contracts';
import { HelperTransportError, spawnUiaHelper, UiaHelperClient, type ChildProcessLike, type HelperExit } from './client';
import { fromWireRect, HWND_PATTERN, UIA_PROTOCOL_VERSION, type HelperEvent, type HelperResponse, type WireStrip } from './protocol';
import { DEFAULT_RESTART_BUDGET, RestartBudget, type RestartBudgetOptions } from './restartBudget';
import { catExtentPx, computeTabStripSegment, placeStrip, toRelativeStrip, type RelativeStrip, type StripGeometry, type TabStripSegment } from './segment';

/** Browsers whose tab strips are read (both expose native UIA by default since Chrome 138). */
export const TAB_STRIP_BROWSERS: readonly string[] = ['msedge.exe', 'chrome.exe'];

export const tabStripSurfaceId = (hwnd: string): string => `tabStrip:${hwnd}`;

export interface TabStripServiceOptions {
  requestTimeoutMs: number;
  /** Refresh period for windows of interest. */
  pollIntervalMs: number;
  /** Helper stops (and retained windows are dropped) after this long without interest. */
  idleShutdownMs: number;
  /** Window descriptions (rect, maximized, exclusion) are re-read at most this often. */
  describeIntervalMs: number;
  /** Max age of the frame used by surfaces() for windows of interest. */
  liveDescribeMs: number;
  /** At most one tabs.changed per window per this period (later changes are merged). */
  eventDebounceMs: number;
  /** Minimum gap between two reads of the same window after an event. */
  refreshGapMs: number;
  maxWindows: number;
  maxInterest: number;
  maxInFlight: number;
  /** Retry delay after a failed read of one window (doubles up to windowRetryMaxMs). */
  windowRetryMs: number;
  windowRetryMaxMs: number;
  /** Windows the helper rejected (not a browser frame) are skipped this long. */
  rejectedWindowMs: number;
  quitGraceMs: number;
  /** Internal pump timer period (ms); 0 disables it (tests drive pump through setInterest). */
  autoPumpMs: number;
  restart: RestartBudgetOptions;
  eventQueueCapacity: number;
  maxLineBytes: number;
}

export const DEFAULT_TAB_STRIP_OPTIONS: TabStripServiceOptions = {
  requestTimeoutMs: 1500,
  pollIntervalMs: 1000,
  idleShutdownMs: 60_000,
  describeIntervalMs: 250,
  liveDescribeMs: 16,
  eventDebounceMs: 300,
  refreshGapMs: 100,
  maxWindows: 8,
  maxInterest: 4,
  maxInFlight: 2,
  windowRetryMs: 2000,
  windowRetryMaxMs: 60_000,
  rejectedWindowMs: 10 * 60_000,
  quitGraceMs: 2000,
  autoPumpMs: 500,
  restart: DEFAULT_RESTART_BUDGET,
  eventQueueCapacity: 32,
  maxLineBytes: 64 * 1024,
};

export interface TabStripServiceDeps {
  logger: Logger;
  settings: Settings;
  /** Path of DesktopCatUia.exe (resolveUiaHelperPath); null = not installed. */
  helperPath: string | null;
  /** Win32Api.describeWindow: rect, maximized, exclusion verdict. Titles never leave win32. */
  describeWindow: (id: string) => WindowInfo | null;
  /** Monotonic host clock (ms); defaults to performance.now. */
  now?: () => number;
  spawnHelper?: (path: string) => ChildProcessLike;
  /** Display attribution for surfaces; without it displayId is null (the surface provider may fill it). */
  displayAt?: (p: Point) => string | null;
  options?: Partial<TabStripServiceOptions>;
}

type Change = Extract<SimEvent, { type: 'tabs.changed' }>['change'];
const CHANGE_PRIORITY: Record<Change, number> = { added: 3, removed: 3, selected: 2, geometry: 1 };

interface Snapshot {
  count: number;
  selectedIndex: number | null;
  focusRel: number | null;
  ok: boolean;
  x0Rel: number;
  x1Rel: number;
}

interface Tracked {
  id: string;
  info: WindowInfo;
  infoAt: number;
  vx: number;
  vy: number;
  interested: boolean;
  lastInterestAt: number;
  strip: RelativeStrip | null;
  stripAt: number;
  lastRequestAt: number;
  lastReadMs: number | null;
  inFlight: boolean;
  /** An event or a resize asked for a fresh read. */
  dirty: boolean;
  selectedHint: boolean;
  retryAt: number;
  errorStreak: number;
  lastError: string | null;
  snapshot: Snapshot | null;
  pendingChange: { change: Change; dueAt: number } | null;
  lastEmitAt: number;
  segCache: { key: string; seg: TabStripSegment } | null;
}

export interface TabStripDebug {
  status: SurfaceStatus['tabStrips'];
  reason: string | null;
  enabled: boolean;
  started: boolean;
  helper: {
    running: boolean;
    ready: boolean;
    pid: number | null;
    dpiMode: string | null;
    spawns: number;
    recentFailures: number;
    lastFailure: string | null;
    nextStartInMs: number | null;
    lines: number;
    malformed: number;
    oversized: number;
    timeouts: number;
    orphanResponses: number;
    stderrBytes: number;
  };
  windows: number;
  interested: number;
  withStrip: number;
  watched: number;
  reads: number;
  readErrors: number;
  lastReadMs: number | null;
  eventsIn: { selected: number; structure: number };
  eventsOut: number;
  eventsDropped: number;
}

const isBrowserCandidate = (info: WindowInfo): boolean =>
  TAB_STRIP_BROWSERS.includes(info.processName) && !info.excluded && !info.minimized && !info.fullscreen;

function toGeometry(s: WireStrip): StripGeometry {
  return {
    frame: fromWireRect(s.frame),
    work: s.work ? fromWireRect(s.work) : null,
    dpi: s.dpi,
    container: s.container ? fromWireRect(s.container) : null,
    tabs: s.tabs.map((t) => ({ x: t.x, y: t.y, width: t.w, height: t.h, selected: t.selected })),
    count: s.count,
    leftButton: s.leftButton ? fromWireRect(s.leftButton) : null,
    newTab: s.newTab ? fromWireRect(s.newTab) : null,
    grab: s.grab ? fromWireRect(s.grab) : null,
    captions: s.captions ? fromWireRect(s.captions) : null,
    maximized: s.maximized,
    vertical: s.vertical,
  };
}

const tabStripEnabled = (s: Settings): boolean => !s.behavior.disabledBehaviors.includes('tabStrips');

export type TabStripServiceImpl = TabStripService & { debugInfo(): TabStripDebug & Record<string, unknown> };

export function createTabStripService(deps: TabStripServiceDeps): TabStripServiceImpl {
  const o: TabStripServiceOptions = { ...DEFAULT_TAB_STRIP_OPTIONS, ...deps.options };
  const log = deps.logger.child('tabStrips');
  const now = deps.now ?? (() => performance.now());
  const budget = new RestartBudget(o.restart);

  let started = false;
  let enabled = tabStripEnabled(deps.settings);
  let catSize = deps.settings.appearance.size;
  /** Not installed / not Windows: cannot be fixed at run time. */
  const permanentReason: string | null =
    process.platform !== 'win32' ? 'tab strips need Windows' : deps.helperPath === null ? 'UI Automation helper not installed' : null;
  let unavailableReason: string | null = permanentReason;
  let helperReady = false;
  let helperDpiMode: string | null = null;
  let nextStartAt = 0;
  let lastFailure: string | null = null;
  let lastWantedAt = 0;
  let watchedKey = '';
  let watchInFlight = false;
  let timer: ReturnType<typeof setInterval> | null = null;

  const windows = new Map<string, Tracked>();
  const rejected = new Map<string, number>();
  const queue: SimEvent[] = [];
  const stats = { reads: 0, readErrors: 0, lastReadMs: null as number | null, eventsIn: { selected: 0, structure: 0 }, eventsOut: 0, eventsDropped: 0 };

  const client: UiaHelperClient | null =
    deps.helperPath === null
      ? null
      : new UiaHelperClient({
          helperPath: deps.helperPath,
          spawn: deps.spawnHelper ?? spawnUiaHelper,
          logger: log,
          now,
          requestTimeoutMs: o.requestTimeoutMs,
          quitGraceMs: o.quitGraceMs,
          maxLineBytes: o.maxLineBytes,
          onEvent: (ev) => onHelperEvent(ev),
          onExit: (exit) => onHelperExit(exit),
        });

  const active = (): boolean => started && enabled && unavailableReason === null && client !== null;
  const queryable = (t: Tracked): boolean => isBrowserCandidate(t.info) && !t.info.maximized;

  // ------------------------------------------------------------------ windows

  function drop(t: Tracked, reason: string): void {
    if (windows.get(t.id) !== t) return;
    windows.delete(t.id);
    log.debug('tab strip window dropped', { reason });
  }

  /** Re-reads the window description; drops it (false) when it is gone, excluded or no longer a candidate. */
  function refreshInfo(t: Tracked, at: number): boolean {
    const info = deps.describeWindow(t.id);
    if (info === null || !isBrowserCandidate(info)) {
      drop(t, info === null ? 'gone' : info.excluded ? 'excluded' : 'not a candidate');
      return false;
    }
    const dt = at - t.infoAt;
    if (dt > 0 && dt <= 1000) {
      t.vx = ((info.rect.x - t.info.rect.x) * 1000) / dt;
      t.vy = ((info.rect.y - t.info.rect.y) * 1000) / dt;
    } else if (dt > 1000) {
      t.vx = 0;
      t.vy = 0;
    }
    if (t.strip !== null) {
      const resized = info.rect.width !== t.strip.frameWidth || info.rect.height !== t.strip.frameHeight;
      const restored = t.info.maximized && !info.maximized;
      if (resized || restored) t.dirty = true;
    }
    t.info = info;
    t.infoAt = at;
    return true;
  }

  function admit(id: string, at: number): Tracked | null {
    const existing = windows.get(id);
    if (existing) {
      if (at - existing.infoAt >= o.describeIntervalMs && !refreshInfo(existing, at)) return null;
      return existing;
    }
    const until = rejected.get(id);
    if (until !== undefined) {
      if (at < until) return null;
      rejected.delete(id);
    }
    const info = deps.describeWindow(id);
    if (info === null || !isBrowserCandidate(info)) return null;
    if (windows.size >= o.maxWindows) {
      let victim: Tracked | null = null;
      for (const t of windows.values()) if (!t.interested && (victim === null || t.lastInterestAt < victim.lastInterestAt)) victim = t;
      if (victim === null) return null;
      drop(victim, 'evicted');
    }
    const t: Tracked = {
      id,
      info,
      infoAt: at,
      vx: 0,
      vy: 0,
      interested: false,
      lastInterestAt: at,
      strip: null,
      stripAt: 0,
      lastRequestAt: Number.NEGATIVE_INFINITY,
      lastReadMs: null,
      inFlight: false,
      dirty: false,
      selectedHint: false,
      retryAt: 0,
      errorStreak: 0,
      lastError: null,
      snapshot: null,
      pendingChange: null,
      lastEmitAt: Number.NEGATIVE_INFINITY,
      segCache: null,
    };
    windows.set(id, t);
    return t;
  }

  function segmentFor(t: Tracked): TabStripSegment | null {
    if (t.strip === null) return null;
    const r = t.info.rect;
    const key = `${t.stripAt}|${r.x},${r.y},${r.width},${r.height}|${t.info.maximized}|${catSize}`;
    if (t.segCache?.key === key) return t.segCache.seg;
    const seg = computeTabStripSegment(placeStrip(t.strip, r, t.info.maximized), catExtentPx(catSize, t.strip.dpi));
    t.segCache = { key, seg };
    return seg;
  }

  function snapshotOf(t: Tracked): Snapshot | null {
    const strip = t.strip;
    if (strip === null) return null;
    const tabs = [...strip.tabs].sort((a, b) => a.x - b.x);
    const sel = tabs.findIndex((x) => x.selected);
    const selTab = sel >= 0 ? tabs[sel] : undefined;
    const seg = segmentFor(t);
    const fx = t.info.rect.x;
    return {
      count: strip.count,
      selectedIndex: sel >= 0 ? sel : null,
      focusRel: selTab ? selTab.x + selTab.width / 2 : null,
      ok: seg?.ok === true,
      x0Rel: seg?.ok === true ? seg.x0 - fx : 0,
      x1Rel: seg?.ok === true ? seg.x1 - fx : 0,
    };
  }

  function detectChange(t: Tracked, at: number, selectedHint: boolean): void {
    const next = snapshotOf(t);
    const prev = t.snapshot;
    t.snapshot = next;
    if (prev === null || next === null) return;
    let change: Change | null = null;
    if (next.count > prev.count) change = 'added';
    else if (next.count < prev.count) change = 'removed';
    else if (next.selectedIndex !== prev.selectedIndex) change = 'selected';
    else if (selectedHint && prev.focusRel !== null && next.focusRel !== null && Math.abs(next.focusRel - prev.focusRel) > 2) change = 'selected';
    else if (next.ok !== prev.ok || Math.abs(next.x0Rel - prev.x0Rel) > 2 || Math.abs(next.x1Rel - prev.x1Rel) > 2) change = 'geometry';
    if (change !== null) queueChange(t, change, at);
  }

  function queueChange(t: Tracked, change: Change, at: number): void {
    const p = t.pendingChange;
    if (p !== null) {
      if (CHANGE_PRIORITY[change] >= CHANGE_PRIORITY[p.change]) p.change = change;
      return;
    }
    t.pendingChange = { change, dueAt: Math.max(at, t.lastEmitAt + o.eventDebounceMs) };
  }

  function flushChanges(at: number): void {
    for (const t of windows.values()) {
      const p = t.pendingChange;
      if (p === null || at < p.dueAt) continue;
      t.pendingChange = null;
      t.lastEmitAt = at;
      const seg = segmentFor(t);
      if (queue.length >= o.eventQueueCapacity) {
        queue.shift();
        stats.eventsDropped++;
      }
      queue.push({ type: 'tabs.changed', surfaceId: tabStripSurfaceId(t.id), ownerId: t.id, change: p.change, focusX: seg?.ok === true ? seg.focusX : null });
      stats.eventsOut++;
    }
  }

  // ------------------------------------------------------------------ helper lifecycle

  function markUnavailable(reason: string): void {
    unavailableReason = reason;
    log.warn('tab strips unavailable', { reason });
    windows.clear();
    watchedKey = '';
    helperReady = false;
    client?.kill();
  }

  function fail(reason: string, at: number): void {
    lastFailure = reason;
    const next = budget.recordFailure(at);
    if (client?.running) client.kill();
    helperReady = false;
    watchedKey = '';
    if (next === null) {
      markUnavailable(`helper failed ${budget.recentFailures} times in ${Math.round(o.restart.windowMs / 60_000)} min (last: ${reason})`);
      return;
    }
    nextStartAt = next;
    log.warn('uia helper failed; restarting with backoff', { reason, delayMs: Math.round(next - at) });
  }

  function onHelperExit(exit: HelperExit): void {
    helperReady = false;
    watchedKey = '';
    watchInFlight = false;
    for (const t of windows.values()) t.inFlight = false;
    if (exit.expected) {
      log.info('uia helper stopped', { uptimeMs: Math.round(exit.uptimeMs) });
      return;
    }
    if (!active()) return;
    const reason = exit.error !== null ? `could not run (${exit.error})` : `exited (code ${exit.code ?? 'none'}${exit.signal ? `, ${exit.signal}` : ''})`;
    fail(reason, now());
  }

  function startHelper(at: number): void {
    if (client === null) return;
    helperReady = false;
    helperDpiMode = null;
    watchedKey = '';
    watchInFlight = false;
    lastWantedAt = at;
    if (!client.start()) return;
    log.info('uia helper started', { pid: client.pid });
    client.request({ op: 'ping' }, at).then(
      (r) => {
        if (!r.ok || r.pong !== true) {
          fail(`bad ping response (${r.ok ? 'no pong' : r.error})`, now());
          return;
        }
        if (r.version !== UIA_PROTOCOL_VERSION) {
          markUnavailable(`helper protocol ${r.version ?? 'unknown'} != ${UIA_PROTOCOL_VERSION}`);
          return;
        }
        helperReady = true;
        helperDpiMode = r.dpi ?? null;
        if (r.dpi !== undefined && r.dpi !== 'permonitorv2' && r.dpi !== 'preset') log.warn('uia helper is not per-monitor DPI aware', { dpi: r.dpi });
        pump(now());
      },
      (e: unknown) => onTransportError(e),
    );
  }

  function onTransportError(e: unknown): void {
    // Timeouts are handled in pump (checkTimeouts) and exits in onHelperExit.
    if (!(e instanceof HelperTransportError)) log.error('uia helper request failed', { error: String(e) });
  }

  function onHelperEvent(ev: HelperEvent): void {
    stats.eventsIn[ev.event]++;
    const t = windows.get(ev.hwnd);
    if (!t) return;
    t.dirty = true;
    if (ev.event === 'selected') t.selectedHint = true;
    pump(now());
  }

  // ------------------------------------------------------------------ reads

  function read(t: Tracked, at: number): void {
    if (client === null) return;
    // The exclusion verdict is re-checked right before every query.
    if (!refreshInfo(t, at) || !queryable(t)) return;
    t.inFlight = true;
    t.lastRequestAt = at;
    t.dirty = false;
    const hint = t.selectedHint;
    t.selectedHint = false;
    stats.reads++;
    client.request({ op: 'strip', hwnd: t.id }, at).then(
      (r) => onStrip(t, r, hint),
      (e: unknown) => {
        t.inFlight = false;
        stats.readErrors++;
        onTransportError(e);
      },
    );
  }

  function onStrip(t: Tracked, r: HelperResponse, hint: boolean): void {
    t.inFlight = false;
    if (windows.get(t.id) !== t || !active()) return;
    const at = now();
    if (!r.ok || r.strip === undefined) {
      stats.readErrors++;
      const code = r.ok ? 'no-strip' : r.error;
      t.lastError = code;
      if (code === 'gone') {
        drop(t, 'gone');
        return;
      }
      if (code === 'rejected') {
        rejected.set(t.id, at + o.rejectedWindowMs);
        drop(t, 'rejected by helper');
        return;
      }
      const hadStrip = t.strip !== null;
      t.strip = null;
      t.segCache = null;
      t.snapshot = null;
      t.errorStreak++;
      t.retryAt = at + Math.min(o.windowRetryMaxMs, o.windowRetryMs * 2 ** (t.errorStreak - 1));
      if (hadStrip) log.debug('tab strip lost', { error: code });
      return;
    }
    const geo = toGeometry(r.strip);
    t.strip = toRelativeStrip(geo);
    t.stripAt = at;
    t.segCache = null;
    t.errorStreak = 0;
    t.lastError = null;
    t.lastReadMs = r.strip.ms;
    stats.lastReadMs = r.strip.ms;
    // The helper's frame was read after our description: adopt it.
    t.info = { ...t.info, rect: geo.frame, maximized: geo.maximized };
    t.infoAt = at;
    detectChange(t, at, hint);
    pump(at);
  }

  function syncWatch(at: number): void {
    if (client === null || watchInFlight) return;
    const ids = [...windows.values()]
      .filter((t) => t.strip !== null && queryable(t))
      .map((t) => t.id)
      .sort()
      .slice(0, 16);
    const key = ids.join(',');
    if (key === watchedKey) return;
    watchInFlight = true;
    client.request({ op: 'watch', hwnds: ids }, at).then(
      (r) => {
        watchInFlight = false;
        // Remember the set even on failure so a broken subscription does not retry in a loop.
        watchedKey = key;
        if (!r.ok) log.debug('uia watch failed', { error: r.error });
        else if ((r.failed?.length ?? 0) > 0) log.debug('uia watch incomplete', { failed: r.failed?.length ?? 0 });
      },
      (e: unknown) => {
        watchInFlight = false;
        onTransportError(e);
      },
    );
  }

  function scheduleReads(at: number): void {
    let inFlight = 0;
    for (const t of windows.values()) if (t.inFlight) inFlight++;
    const order = [...windows.values()].sort((a, b) => Number(b.interested) - Number(a.interested) || b.lastInterestAt - a.lastInterestAt);
    for (const t of order) {
      if (inFlight >= o.maxInFlight) return;
      if (t.inFlight || !queryable(t) || at < t.retryAt) continue;
      const due = t.strip === null || (t.dirty ? at - t.lastRequestAt >= o.refreshGapMs : t.interested && at - t.stripAt >= o.pollIntervalMs);
      if (!due) continue;
      read(t, at);
      if (t.inFlight) inFlight++;
    }
  }

  function pump(at: number): void {
    if (!active() || client === null) return;
    if (client.running && client.checkTimeouts(at) > 0) fail('request timed out (helper hung)', at);
    if (!active()) return;
    for (const t of [...windows.values()]) {
      if (!t.interested && at - t.lastInterestAt >= o.idleShutdownMs) drop(t, 'idle');
      else if (at - t.infoAt >= o.describeIntervalMs) refreshInfo(t, at);
    }
    let wanted = false;
    for (const t of windows.values()) {
      if (t.interested && queryable(t)) {
        wanted = true;
        break;
      }
    }
    if (wanted) lastWantedAt = at;
    if (!client.running) {
      if (wanted && at >= nextStartAt) startHelper(at);
    } else if (!client.stopping && at - lastWantedAt >= o.idleShutdownMs) {
      log.info('tab strips idle; stopping the helper');
      helperReady = false;
      client.quit();
    }
    if (client.running && !client.stopping && helperReady) {
      syncWatch(at);
      scheduleReads(at);
    }
    flushChanges(at);
  }

  function shutdown(): void {
    windows.clear();
    rejected.clear();
    queue.length = 0;
    watchedKey = '';
    helperReady = false;
    client?.quit();
  }

  function armTimer(): void {
    if (timer !== null || o.autoPumpMs <= 0) return;
    timer = setInterval(() => pump(now()), o.autoPumpMs);
    timer.unref?.();
  }

  function disarmTimer(): void {
    if (timer === null) return;
    clearInterval(timer);
    timer = null;
  }

  // ------------------------------------------------------------------ public API

  const service: TabStripServiceImpl = {
    get status(): SurfaceStatus['tabStrips'] {
      if (!started || !enabled) return 'off';
      if (unavailableReason !== null) return 'unavailable';
      return client !== null && client.running && !client.stopping ? 'active' : 'idle';
    },

    get statusReason(): string | null {
      return started && enabled ? unavailableReason : null;
    },

    start(): void {
      if (started) return;
      started = true;
      if (enabled) armTimer();
      if (permanentReason !== null && enabled) log.info('tab strips unavailable', { reason: permanentReason });
    },

    stop(): void {
      if (!started) return;
      started = false;
      disarmTimer();
      shutdown();
    },

    updateSettings(settings: Settings): void {
      catSize = settings.appearance.size;
      const next = tabStripEnabled(settings);
      if (next === enabled) return;
      enabled = next;
      if (!enabled) {
        disarmTimer();
        shutdown();
        return;
      }
      // Turning the feature back on is an explicit retry after repeated helper failures.
      if (unavailableReason !== null && permanentReason === null) {
        budget.reset();
        unavailableReason = null;
        nextStartAt = 0;
      }
      if (started) armTimer();
    },

    setInterest(windowIds: readonly string[], at: number): void {
      if (!active()) return;
      const admitted = new Set<string>();
      const scanLimit = o.maxInterest * 4;
      for (let i = 0; i < windowIds.length && i < scanLimit && admitted.size < o.maxInterest; i++) {
        const id = windowIds[i];
        if (id === undefined || admitted.has(id) || !HWND_PATTERN.test(id)) continue;
        const t = admit(id, at);
        if (t === null) continue;
        admitted.add(id);
        t.interested = true;
        t.lastInterestAt = at;
      }
      for (const t of windows.values()) if (!admitted.has(t.id)) t.interested = false;
      pump(at);
    },

    surfaces(): readonly LedgeSurface[] {
      if (!active()) return [];
      const at = now();
      const out: LedgeSurface[] = [];
      for (const t of [...windows.values()]) {
        if (t.strip === null) continue;
        const maxAge = t.interested ? o.liveDescribeMs : o.describeIntervalMs;
        if (at - t.infoAt >= maxAge && !refreshInfo(t, at)) continue;
        if (!queryable(t)) continue;
        const seg = segmentFor(t);
        if (seg === null || !seg.ok) continue;
        const sizeMatches = t.strip.frameWidth === t.info.rect.width && t.strip.frameHeight === t.info.rect.height;
        const age = at - t.stripAt;
        const confidence = !sizeMatches ? 0.5 : age <= 2 * o.pollIntervalMs ? 1 : age <= 30_000 ? 0.85 : 0.7;
        out.push({
          id: tabStripSurfaceId(t.id),
          kind: 'tabStrip',
          ownerId: t.id,
          displayId: deps.displayAt?.({ x: (seg.x0 + seg.x1) / 2, y: seg.y - 1 }) ?? null,
          phase: 'stable',
          vx: t.vx,
          vy: t.vy,
          confidence,
          validatedAt: t.infoAt,
          excluded: false,
          orientation: 'ledge',
          y: seg.y,
          x0: seg.x0,
          x1: seg.x1,
          rest: seg.rest,
          focusX: seg.focusX,
        });
      }
      return out;
    },

    drainEvents(): SimEvent[] {
      if (active()) flushChanges(now());
      return queue.splice(0, queue.length);
    },

    debugInfo() {
      const at = now();
      let interested = 0;
      let withStrip = 0;
      for (const t of windows.values()) {
        if (t.interested) interested++;
        if (t.strip !== null) withStrip++;
      }
      const cs = client?.stats;
      return {
        status: service.status,
        reason: service.statusReason,
        enabled,
        started,
        helper: {
          running: client?.running ?? false,
          ready: helperReady,
          pid: client?.pid ?? null,
          dpiMode: helperDpiMode,
          spawns: cs?.spawns ?? 0,
          recentFailures: budget.recentFailures,
          lastFailure,
          nextStartInMs: client !== null && !client.running && nextStartAt > at ? Math.round(nextStartAt - at) : null,
          lines: cs?.lines ?? 0,
          malformed: cs?.malformed ?? 0,
          oversized: cs?.oversized ?? 0,
          timeouts: cs?.timeouts ?? 0,
          orphanResponses: cs?.orphanResponses ?? 0,
          stderrBytes: cs?.stderrBytes ?? 0,
        },
        windows: windows.size,
        interested,
        withStrip,
        watched: watchedKey === '' ? 0 : watchedKey.split(',').length,
        reads: stats.reads,
        readErrors: stats.readErrors,
        lastReadMs: stats.lastReadMs,
        eventsIn: { ...stats.eventsIn },
        eventsOut: stats.eventsOut,
        eventsDropped: stats.eventsDropped,
      };
    },

    async dispose(): Promise<void> {
      service.stop();
      if (client === null) return;
      if (!(await client.waitForExit(o.quitGraceMs + 500))) {
        client.kill();
        await client.waitForExit(1000);
      }
    },
  };
  return service;
}
