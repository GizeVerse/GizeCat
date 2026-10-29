// TaskbarTracker (src/main/contracts.ts, ADR 0002 §2, docs/research/v1.1/taskbar.md).
//
// Discovers the taskbars (Shell_TrayWnd and every Shell_SecondaryTrayWnd, by class name only),
// follows their live window rects with cheap adaptive sampling (GetWindowRect ~0.6 µs) and turns
// a BOTTOM AUTO-HIDE taskbar into a ledge surface while at least half of it is on screen.
// SHAppBarMessage (cross-process, ~160 µs, INFERRED to stall while Explorer hangs) is only a
// cross-check, queried on the discoveries that can change its answer (start, TaskbarCreated, display
// changes, an edge move, a new primary window), never on the periodic reconcile.
// It also reports the screen areas the overlays must never take the mouse over (clickGuardRects).
//
// Roles by edge: bottom auto-hide = ledge (surfaces()); bottom always-shown = floor (the work-area
// floor already sits on its top, so it is not a ledge); top = ceiling, left/right = walls (out of
// scope for the ledge list; reported through taskbars() and debugInfo()).
//
// Physical px, on Electron's per-monitor-v2 main thread. Every public method is guarded and never
// throws; without Win32 the tracker is inert with available = false.
import type { Point, Rect } from '../../shared/geometry';
import type { SimEvent } from '../../shared/sim';
import type { LedgeSurface, SurfacePhase, TaskbarEdge } from '../../shared/surfaces';
import type { DisplayGeometry, WorldGeometry } from '../../shared/world';
import type { Logger, TaskbarState, TaskbarTracker } from '../contracts';
import type { Hwnd, RawRect } from './native';
import { BURST_SAMPLE_MS, IDLE_SAMPLE_MS, nextSampleDelay, type CadenceDecision, type CadenceTaskbar } from './taskbar/cadence';
import {
  ABS_AUTOHIDE,
  dockedRectFor,
  edgeBand,
  edgeFromAbe,
  edgeSign,
  fromRect,
  inferEdge,
  isHorizontalEdge,
  onScreenExtent,
  rawContains,
  rawEqual,
  rawHeight,
  rawIntersect,
  rawOverlapArea,
  rawWidth,
  spanOnMonitor,
  thicknessOf,
  toRect,
  visibleEdgeAt,
  workAreaReachesEdge,
} from './taskbar/geometry';
import { DEFAULT_MOTION_CONFIG, TaskbarMotion, type MotionSnapshot, type TaskbarPhase } from './taskbar/motion';
import { loadTaskbarNative, SECONDARY_TRAY_CLASS, TRAY_CLASS, type TaskbarNative } from './taskbar/taskbarNative';

export type { TaskbarNative } from './taskbar/taskbarNative';
export { BURST_SAMPLE_MS, IDLE_SAMPLE_MS } from './taskbar/cadence';

export type TaskbarRediscoverReason =
  | 'start'
  | 'taskbar-created'
  | 'display-change'
  | 'window-gone'
  | 'geometry-changed'
  | 'read-failure'
  | 'reconcile'
  | 'follow-up'
  | 'manual';

export interface TaskbarTrackerOptions {
  /** Clock for work done outside sample() (start, discovery requests); must match the host clock passed to sample(). Default performance.now(). */
  now?: () => number;
  /** Injected Win32 facade (tests). null forces the unavailable tracker. Default: koffi. */
  native?: TaskbarNative | null;
  /** Display topology, for display ids and per-monitor DPI scale (update with setWorld). */
  world?: WorldGeometry | null;
}

/** The TaskbarTracker contract plus the notifications the composition root forwards to it. */
export interface TaskbarTrackerHandle extends TaskbarTracker {
  /**
   * Requests a rediscovery on the next sample(): the shell's TaskbarCreated broadcast (Explorer
   * restarted: new window handles), display changes, or a manual refresh. Cheap and safe to call
   * from a window-message hook.
   */
  rediscover(reason: TaskbarRediscoverReason): void;
  /** New display topology: taskbars are re-attributed to displays and rediscovered on the next sample. */
  setWorld(world: WorldGeometry): void;
  /**
   * Screen areas (px) the overlays must never take the mouse over, whatever the cat does: the
   * live rect of every visible taskbar window (shown, sliding, or the strip of a hidden one) and,
   * for auto-hide taskbars, the TASKBAR_CLICK_GUARD_DIP band along their monitor edge (also while
   * hidden). From the last sample: no OS call, cheap enough for every cursor poll.
   */
  clickGuardRects(): Rect[];
}

export const TASKBAR_RECONCILE_MS = 10_000;
/**
 * Flapping guard: at most one taskbar.shown/hidden event per taskbar per this interval. A flip
 * that reverts within the interval after the previous event emits nothing; one that persists is
 * reported on the first sample after the interval. A vanished window is reported at once.
 */
export const TASKBAR_EVENT_DEBOUNCE_MS = 250;
/** A ledge exists while at least this share of the taskbar's thickness is on screen. */
export const TASKBAR_LEDGE_MIN_FRACTION = 0.5;
/**
 * Depth (DIP, DPI-scaled) of the band along an auto-hide taskbar's monitor edge where the overlays
 * stay click-through: the 1-2 px reveal strip plus a margin, so the overlay already ignores the
 * mouse when the cursor reaches the strip (the cursor poll runs every 16 ms near the cat).
 */
export const TASKBAR_CLICK_GUARD_DIP = 6;
/** After TaskbarCreated / a display change, discover once more after this delay (Explorer creates secondary taskbars late). */
const FOLLOW_UP_MS = 2000;
/** Rediscoveries forced by sampling (window gone, read failures, moved edge) are at most this frequent. */
const MIN_FORCED_REDISCOVERY_GAP_MS = 1000;
const MAX_SECONDARY_TASKBARS = 16;
const MAX_EVENTS = 32;
const READ_FAILURES_BEFORE_REDISCOVERY = 3;
const STALE_AFTER_MS = 500;
const MONITOR_MATCH_TOLERANCE_PX = 2;

type Role = 'ledge' | 'floor' | 'ceiling' | 'wall';

/**
 * Discoveries that query SHAppBarMessage: the ones whose cause can change its answer (auto-hide
 * toggles and taskbar moves change the work area, which is a display change). The 10 s reconcile,
 * read failures and a vanished secondary window reuse the cached answer.
 */
const APPBAR_QUERY_REASONS: ReadonlySet<TaskbarRediscoverReason> = new Set<TaskbarRediscoverReason>([
  'start',
  'taskbar-created',
  'display-change',
  'follow-up',
  'geometry-changed',
  'manual',
]);

interface AppBarInfo {
  /** Primary taskbar window the answer was read for: a new window (Explorer restarted) is queried again. */
  primary: Hwnd | null;
  state: number | null;
  pos: { edge: number; rect: RawRect } | null;
  at: number;
}

interface Entry {
  hwnd: Hwnd;
  id: string;
  primary: boolean;
  monitor: RawRect;
  work: RawRect;
  /**
   * 'window': MonitorFromWindow; 'appbar': the display holding the docked ABM rect; 'kept': previous
   * attribution; 'geometry': the display on which the rect reads as an auto-hidden taskbar.
   */
  monitorSource: 'window' | 'appbar' | 'kept' | 'geometry';
  displayId: string | null;
  scale: number;
  edge: TaskbarEdge;
  appBarEdge: TaskbarEdge | null;
  edgeMismatch: boolean;
  autoHide: boolean;
  autoHideBy: 'work-area' | 'appbar-state' | 'both' | 'none';
  thickness: number;
  thicknessSource: 'appbar' | 'window';
  docked: RawRect;
  rect: RawRect;
  visible: boolean;
  motion: TaskbarMotion;
  validatedAt: number;
  readFailures: number;
  /** The ledge is reported to the sim (last event was taskbar.shown). */
  reported: boolean;
  lastEventAt: number | null;
}

const SURFACE_PHASE: Readonly<Record<TaskbarPhase, SurfacePhase>> = { hidden: 'leaving', showing: 'entering', shown: 'stable', hiding: 'leaving' };

const roleOf = (e: Pick<Entry, 'edge' | 'autoHide'>): Role => (e.edge === 'bottom' ? (e.autoHide ? 'ledge' : 'floor') : e.edge === 'top' ? 'ceiling' : 'wall');
export const taskbarSurfaceId = (hwndId: string): string => `taskbar:${hwndId}`;

/** Creates the tracker. Never throws: without Win32 (or when loading fails) it is inert with available = false. */
export function createTaskbarTracker(logger: Logger, opts: TaskbarTrackerOptions = {}): TaskbarTrackerHandle {
  const log = logger.child('taskbar');
  try {
    let native: TaskbarNative | null;
    if (opts.native !== undefined) native = opts.native;
    else {
      try {
        native = loadTaskbarNative();
      } catch (e) {
        log.warn('taskbar tracking unavailable', { error: e instanceof Error ? e.message : String(e) });
        native = null;
      }
    }
    if (native === null) return createUnavailableTaskbarTracker('win32 unavailable');
    return createLiveTaskbarTracker(native, log, opts);
  } catch (e) {
    log.error('creating the taskbar tracker failed', { error: e instanceof Error ? e.message : String(e) });
    return createUnavailableTaskbarTracker('creation failed');
  }
}

export function createUnavailableTaskbarTracker(reason: string): TaskbarTrackerHandle {
  return {
    available: false,
    start: () => undefined,
    stop: () => undefined,
    sample: () => IDLE_SAMPLE_MS,
    taskbars: () => [],
    clickGuardRects: () => [],
    surfaces: () => [],
    drainEvents: () => [],
    debugInfo: () => ({ available: false, reason }),
    rediscover: () => undefined,
    setWorld: () => undefined,
  };
}

function createLiveTaskbarTracker(native: TaskbarNative, log: Logger, opts: TaskbarTrackerOptions): TaskbarTrackerHandle {
  const clock = opts.now ?? (() => performance.now());
  let world: WorldGeometry | null = opts.world ?? null;
  let entries = new Map<string, Entry>();
  let events: SimEvent[] = [];
  let droppedEvents = 0;
  let started = false;
  let pending: TaskbarRediscoverReason | null = null;
  let forcedPending: TaskbarRediscoverReason | null = null;
  let followUpAt: number | null = null;
  let lastDiscoveryAt: number | null = null;
  let lastForcedAt: number | null = null;
  let lastDiscovery: { at: number; reason: TaskbarRediscoverReason; found: number } | null = null;
  let discoveries = 0;
  let samples = 0;
  let lastSampleAt: number | null = null;
  let lastChangeAt: number | null = null;
  let lastDecision: CadenceDecision = { delayMs: IDLE_SAMPLE_MS, reason: null };
  let appBar: AppBarInfo | null = null;
  let signature: string | null = null;
  const errorCounts = new Map<string, number>();
  const mismatchLogged = new Set<string>();

  function noteFailure(op: string, e: unknown): void {
    const n = (errorCounts.get(op) ?? 0) + 1;
    errorCounts.set(op, n);
    if (n <= 3 || n % 1000 === 0) log.warn('taskbar native call failed', { op, count: n, error: e instanceof Error ? e.message : String(e) });
  }

  function guard<T>(op: string, fallback: T, fn: () => T): T {
    try {
      return fn();
    } catch (e) {
      noteFailure(op, e);
      return fallback;
    }
  }

  function push(ev: SimEvent): void {
    events.push(ev);
    if (events.length > MAX_EVENTS) {
      droppedEvents += events.length - MAX_EVENTS;
      events = events.slice(events.length - MAX_EVENTS);
    }
  }

  function eventFor(type: 'taskbar.shown' | 'taskbar.hidden', e: Entry): SimEvent {
    return { type, surfaceId: taskbarSurfaceId(e.id), displayId: e.displayId, edge: e.edge };
  }

  // --- display attribution -----------------------------------------------------------------

  function displayFor(monitor: RawRect): DisplayGeometry | null {
    if (!world) return null;
    let best: DisplayGeometry | null = null;
    let bestArea = 0;
    for (const d of world.displays) {
      const b = fromRect(d.boundsPx);
      if (rawEqual(b, monitor, MONITOR_MATCH_TOLERANCE_PX)) return d;
      const a = rawOverlapArea(b, monitor);
      if (a > bestArea) {
        bestArea = a;
        best = d;
      }
    }
    return best;
  }

  function displayContaining(x: number, y: number): DisplayGeometry | null {
    if (!world) return null;
    return world.displays.find((d) => x >= d.boundsPx.x && x < d.boundsPx.x + d.boundsPx.width && y >= d.boundsPx.y && y < d.boundsPx.y + d.boundsPx.height) ?? null;
  }

  function monitorExists(monitor: RawRect): boolean {
    return !world || world.displays.some((d) => rawEqual(fromRect(d.boundsPx), monitor, MONITOR_MATCH_TOLERANCE_PX));
  }

  /** `rect` lies fully on a display other than `monitor`. */
  function onAnotherDisplay(rect: RawRect, monitor: RawRect): boolean {
    if (!world) return false;
    return world.displays.some((d) => {
      const b = fromRect(d.boundsPx);
      return !rawEqual(b, monitor, MONITOR_MATCH_TOLERANCE_PX) && rawContains(b, rect);
    });
  }

  /** `rect` overlaps `monitor` or lies within the match tolerance of it. */
  function touches(rect: RawRect, monitor: RawRect): boolean {
    const t = MONITOR_MATCH_TOLERANCE_PX;
    return rawOverlapArea(rect, { left: monitor.left - t, top: monitor.top - t, right: monitor.right + t, bottom: monitor.bottom + t }) > 0;
  }

  /**
   * The one display on which `rect` reads as an auto-hidden taskbar: only a thin strip of it lies
   * on the display, along one side, and the rest sticks out past that side. A taskbar revealed on
   * a neighbouring display would lie fully on it instead, so for a rect straddling two displays
   * this is the steady-state reading. Null when no display (or more than one) fits.
   */
  function hiddenOwner(rect: RawRect): DisplayGeometry | null {
    if (!world) return null;
    let found: DisplayGeometry | null = null;
    for (const d of world.displays) {
      const b = fromRect(d.boundsPx);
      if (rawOverlapArea(b, rect) === 0) continue;
      const edge = inferEdge(rect, b);
      const thickness = thicknessOf(rect, edge);
      const extent = onScreenExtent(rect, b, edge, thickness);
      const [s0, s1] = spanOnMonitor(rect, b, edge);
      const along = isHorizontalEdge(edge) ? rawWidth(rect) : rawHeight(rect);
      const thin = extent > 0 && extent <= Math.max(DEFAULT_MOTION_CONFIG.hiddenPx, DEFAULT_MOTION_CONFIG.hiddenFraction * thickness);
      if (!thin || s1 - s0 < along - MONITOR_MATCH_TOLERANCE_PX) continue;
      if (found) return null;
      found = d;
    }
    return found;
  }

  /**
   * The monitor a taskbar belongs to. An auto-hidden taskbar is mostly outside its monitor, so
   * where another monitor adjoins that side MonitorFromWindow picks the neighbour: the primary's
   * docked ABM rect (valid while hidden) decides for it; a secondary keeps the monitor it was
   * attributed to earlier while its rect is not fully on the one MonitorFromWindow reports, and is
   * otherwise attributed by the hidden-taskbar reading of its rect (hiddenOwner).
   */
  function attribute(
    rect: RawRect,
    mfw: { monitor: RawRect; work: RawRect } | null,
    abmPos: AppBarInfo['pos'],
    existing: Entry | null,
  ): { monitor: RawRect; work: RawRect; source: Entry['monitorSource'] } | null {
    if (abmPos) {
      const d = displayContaining((abmPos.rect.left + abmPos.rect.right) / 2, (abmPos.rect.top + abmPos.rect.bottom) / 2);
      if (d) {
        const bounds = fromRect(d.boundsPx);
        if (mfw && rawEqual(mfw.monitor, bounds, MONITOR_MATCH_TOLERANCE_PX)) return { monitor: mfw.monitor, work: mfw.work, source: 'window' };
        return { monitor: bounds, work: fromRect(d.workAreaPx), source: 'appbar' };
      }
    }
    if (mfw && rawContains(mfw.monitor, rect)) return { monitor: mfw.monitor, work: mfw.work, source: 'window' };
    if (existing && (!mfw || !rawEqual(existing.monitor, mfw.monitor)) && monitorExists(existing.monitor) && touches(rect, existing.monitor)) {
      return { monitor: existing.monitor, work: existing.work, source: 'kept' };
    }
    const owner = hiddenOwner(rect);
    if (owner) {
      const bounds = fromRect(owner.boundsPx);
      if (mfw && rawEqual(mfw.monitor, bounds, MONITOR_MATCH_TOLERANCE_PX)) return { monitor: mfw.monitor, work: mfw.work, source: 'window' };
      return { monitor: bounds, work: fromRect(owner.workAreaPx), source: 'geometry' };
    }
    if (mfw) return { monitor: mfw.monitor, work: mfw.work, source: 'window' };
    return existing ? { monitor: existing.monitor, work: existing.work, source: 'kept' } : null;
  }

  // --- discovery ---------------------------------------------------------------------------

  function describe(hwnd: Hwnd, primary: boolean, existing: Entry | null, info: AppBarInfo, now: number): Entry | null {
    if (!native.isWindow(hwnd)) return null;
    const rect = native.getWindowRect(hwnd);
    if (rect === null || rawWidth(rect) <= 0 || rawHeight(rect) <= 0) {
      // Unreadable right now: keep what is known (stale, lower confidence) rather than dropping it.
      if (existing) existing.readFailures++;
      return existing;
    }
    const mfw = guard('MonitorFromWindow', null, () => native.getMonitorRects(hwnd));
    const abmPos = primary ? info.pos : null;
    const at = attribute(rect, mfw, abmPos, existing);
    if (at === null) return null;
    const edge = inferEdge(rect, at.monitor);
    const appBarEdge = abmPos ? edgeFromAbe(abmPos.edge) : null;
    const edgeMismatch = appBarEdge !== null && appBarEdge !== edge;
    let thickness = thicknessOf(rect, edge);
    let thicknessSource: Entry['thicknessSource'] = 'window';
    let docked = dockedRectFor(rect, at.monitor, edge, thickness);
    if (abmPos && appBarEdge === edge) {
      const t = thicknessOf(abmPos.rect, edge);
      if (t > 0) {
        thickness = t;
        thicknessSource = 'appbar';
        docked = abmPos.rect;
      }
    }
    const byWork = workAreaReachesEdge(at.monitor, at.work, edge);
    const byState = info.state !== null && (info.state & ABS_AUTOHIDE) !== 0;
    const visible = guard('IsWindowVisible', true, () => native.isWindowVisible(hwnd));
    const display = displayFor(at.monitor);
    const id = hwnd.toString();
    if (edgeMismatch && !mismatchLogged.has(`${id}:${edge}:${appBarEdge}`)) {
      mismatchLogged.add(`${id}:${edge}:${appBarEdge}`);
      log.warn('taskbar edge from geometry disagrees with SHAppBarMessage; using geometry', { id, edge, appBarEdge });
    }
    const motion = existing && existing.edge === edge ? existing.motion : new TaskbarMotion();
    motion.update(now, visible ? onScreenExtent(rect, at.monitor, edge, thickness) : 0, thickness);
    return {
      hwnd,
      id,
      primary,
      monitor: at.monitor,
      work: at.work,
      monitorSource: at.source,
      displayId: display?.id ?? null,
      scale: display && display.scaleFactor > 0 ? display.scaleFactor : 1,
      edge,
      appBarEdge,
      edgeMismatch,
      autoHide: byWork || byState,
      autoHideBy: byWork && byState ? 'both' : byWork ? 'work-area' : byState ? 'appbar-state' : 'none',
      thickness,
      thicknessSource,
      docked,
      rect,
      visible,
      motion,
      validatedAt: now,
      readFailures: 0,
      reported: existing?.reported ?? false,
      lastEventAt: existing?.lastEventAt ?? null,
    };
  }

  function gone(e: Entry): void {
    if (e.reported) push(eventFor('taskbar.hidden', e));
    e.reported = false;
  }

  function discover(now: number, reason: TaskbarRediscoverReason): void {
    discoveries++;
    lastDiscoveryAt = now;
    const found: Array<{ hwnd: Hwnd; primary: boolean }> = [];
    const seen = new Set<Hwnd>();
    const primary = guard('FindWindowW', null, () => native.findWindow(TRAY_CLASS));
    if (primary !== null) {
      found.push({ hwnd: primary, primary: true });
      seen.add(primary);
    }
    let prev: Hwnd | null = null;
    for (let i = 0; i < MAX_SECONDARY_TASKBARS; i++) {
      const after: Hwnd | null = prev;
      const h: Hwnd | null = guard<Hwnd | null>('FindWindowExW', null, (): Hwnd | null => native.findNextWindow(SECONDARY_TRAY_CLASS, after));
      if (h === null || seen.has(h)) break;
      seen.add(h);
      found.push({ hwnd: h, primary: false });
      prev = h;
    }
    const info: AppBarInfo =
      appBar !== null && appBar.primary === primary && !APPBAR_QUERY_REASONS.has(reason)
        ? appBar
        : {
            primary,
            state: found.length > 0 ? guard('SHAppBarMessage(ABM_GETSTATE)', null, () => native.appBarState()) : null,
            pos: primary !== null ? guard('SHAppBarMessage(ABM_GETTASKBARPOS)', null, () => native.appBarTaskbarPos()) : null,
            at: now,
          };
    appBar = info;
    const next = new Map<string, Entry>();
    for (const f of found) {
      const id = f.hwnd.toString();
      const old = entries.get(id) ?? null;
      const e = guard('describe taskbar', null, () => describe(f.hwnd, f.primary, old, info, now));
      if (!e) continue;
      if (old && old.reported && old.edge !== e.edge) {
        // Moved to another side: its ledge (named with the old edge) is gone.
        gone(old);
        e.reported = false;
        e.lastEventAt = now;
      }
      next.set(id, e);
    }
    for (const [id, old] of entries) if (!next.has(id)) gone(old);
    entries = next;
    for (const e of entries.values()) evaluate(e, now);
    lastDiscovery = { at: now, reason, found: entries.size };
    const sig = [...entries.values()].map((e) => `${e.id}:${e.edge}:${e.autoHide}:${e.displayId}:${e.thickness}`).join('|');
    if (sig !== signature) {
      signature = sig;
      if (entries.size === 0) log.warn('no taskbar window found', { reason });
      else
        log.info('taskbars discovered', {
          reason,
          taskbars: [...entries.values()].map((e) => ({
            id: e.id,
            primary: e.primary,
            edge: e.edge,
            role: roleOf(e),
            autoHide: e.autoHide,
            autoHideBy: e.autoHideBy,
            displayId: e.displayId,
            thickness: e.thickness,
            thicknessSource: e.thicknessSource,
            monitorSource: e.monitorSource,
          })),
        });
    } else {
      log.debug('taskbars rediscovered', { reason, count: entries.size });
    }
  }

  // --- sampling ----------------------------------------------------------------------------

  /** Updates every taskbar from one live read; returns a reason when a rediscovery is needed. */
  function sampleEntries(now: number): TaskbarRediscoverReason | null {
    let forced: TaskbarRediscoverReason | null = null;
    for (const e of [...entries.values()]) {
      const alive = guard('IsWindow', null, () => native.isWindow(e.hwnd));
      if (alive === false) {
        entries.delete(e.id);
        gone(e);
        lastChangeAt = now;
        forced = 'window-gone';
        continue;
      }
      const rect = alive === null ? null : guard('GetWindowRect', null, () => native.getWindowRect(e.hwnd));
      if (rect === null) {
        e.readFailures++;
        if (e.readFailures >= READ_FAILURES_BEFORE_REDISCOVERY) forced ??= 'read-failure';
        continue;
      }
      e.readFailures = 0;
      const visible = guard('IsWindowVisible', true, () => native.isWindowVisible(e.hwnd));
      if (!rawEqual(rect, e.rect) || visible !== e.visible) lastChangeAt = now;
      e.rect = rect;
      e.visible = visible;
      e.validatedAt = now;
      if (inferEdge(rect, e.monitor) !== e.edge || (rawOverlapArea(rect, e.monitor) === 0 && onAnotherDisplay(rect, e.monitor))) {
        // Moved to another side, or fully onto another monitor (moved there, or a misattributed
        // hidden taskbar now revealed on its own monitor): rediscover; keep the old state meanwhile.
        forced ??= 'geometry-changed';
        continue;
      }
      // Explorer moves the window instead of shrinking it; the largest thickness seen wins until the next discovery.
      e.thickness = Math.max(e.thickness, thicknessOf(rect, e.edge));
      e.motion.update(now, visible ? onScreenExtent(rect, e.monitor, e.edge, e.thickness) : 0, e.thickness);
      evaluate(e, now);
    }
    return forced;
  }

  /** Debounced taskbar.shown / taskbar.hidden for ledge taskbars (crossing 50 % of the thickness). */
  function evaluate(e: Entry, now: number): void {
    const desired = roleOf(e) === 'ledge' && e.motion.snapshot().fraction >= TASKBAR_LEDGE_MIN_FRACTION;
    if (desired === e.reported) return;
    if (e.lastEventAt !== null && now - e.lastEventAt < TASKBAR_EVENT_DEBOUNCE_MS) return;
    push(eventFor(desired ? 'taskbar.shown' : 'taskbar.hidden', e));
    e.reported = desired;
    e.lastEventAt = now;
  }

  /** A vanished window is replaced at once; other forced rediscoveries (which may repeat) are rate-limited. */
  function forcedAllowed(reason: TaskbarRediscoverReason, now: number): boolean {
    return reason === 'window-gone' || lastForcedAt === null || now - lastForcedAt >= MIN_FORCED_REDISCOVERY_GAP_MS;
  }

  function sampleImpl(now: number, cursor: Point | null): number {
    if (!started || !Number.isFinite(now)) return IDLE_SAMPLE_MS;
    samples++;
    lastSampleAt = now;
    let reason: TaskbarRediscoverReason | null = pending;
    pending = null;
    if (reason === null && followUpAt !== null && now >= followUpAt) reason = 'follow-up';
    if (reason === null && forcedPending !== null && forcedAllowed(forcedPending, now)) {
      reason = forcedPending;
      lastForcedAt = now;
    }
    if (reason === null && (lastDiscoveryAt === null || now - lastDiscoveryAt >= TASKBAR_RECONCILE_MS)) reason = 'reconcile';
    if (reason !== null) {
      if (reason === 'follow-up') followUpAt = null;
      forcedPending = null;
      discover(now, reason);
    } else {
      const forced = sampleEntries(now);
      if (forced !== null) {
        if (forcedAllowed(forced, now)) {
          lastForcedAt = now;
          discover(now, forced);
        } else forcedPending = forced;
      }
    }
    const cadence: CadenceTaskbar[] = [];
    for (const e of entries.values()) {
      const m = e.motion.snapshot();
      cadence.push({ autoHide: e.autoHide, edge: e.edge, monitor: e.monitor, scale: e.scale, hidden: m.phase === 'hidden', easing: m.inferred });
    }
    const c = cursor !== null && Number.isFinite(cursor.x) && Number.isFinite(cursor.y) ? cursor : null;
    lastDecision = nextSampleDelay({ now, cursor: c, lastChangeAt, taskbars: cadence });
    return lastDecision.delayMs;
  }

  // --- views -------------------------------------------------------------------------------

  const speedOf = (e: Entry, m: MotionSnapshot): number => (m.extentSpeed === 0 ? 0 : edgeSign(e.edge) * m.extentSpeed);

  function confidenceOf(e: Entry, m: MotionSnapshot): number {
    let c = 1;
    if (m.inferred) c = Math.min(c, 0.6);
    if (e.edgeMismatch) c = Math.min(c, 0.5);
    if (e.readFailures > 0) c = Math.min(c, 0.4);
    if (e.displayId === null) c *= 0.8;
    if (lastSampleAt !== null && lastSampleAt - e.validatedAt > STALE_AFTER_MS) c *= 0.7;
    return Math.round(c * 1000) / 1000;
  }

  function stateOf(e: Entry): TaskbarState {
    const m = e.motion.snapshot();
    return {
      id: e.id,
      displayId: e.displayId,
      edge: e.edge,
      autoHide: e.autoHide,
      rect: toRect(e.rect),
      dockedRect: toRect(e.docked),
      shownFraction: m.fraction,
      phase: m.phase,
      speed: speedOf(e, m),
      validatedAt: e.validatedAt,
    };
  }

  function ledgeOf(e: Entry): LedgeSurface | null {
    if (roleOf(e) !== 'ledge') return null;
    const m = e.motion.snapshot();
    if (m.phase === 'hidden' || m.fraction < TASKBAR_LEDGE_MIN_FRACTION) return null;
    const [x0, x1] = spanOnMonitor(e.rect, e.monitor, e.edge);
    if (x1 <= x0) return null;
    return {
      id: taskbarSurfaceId(e.id),
      kind: 'taskbar',
      orientation: 'ledge',
      ownerId: e.id,
      displayId: e.displayId,
      phase: SURFACE_PHASE[m.phase],
      vx: 0,
      vy: speedOf(e, m),
      confidence: confidenceOf(e, m),
      validatedAt: e.validatedAt,
      excluded: false,
      // Feet one px above the visible top edge. The cat's paws and shadow are still drawn up to
      // ~4-10 DIP below its feet, over the taskbar's top rows when the overlay is above it in
      // z-order (auto-hide: the overlay covers the taskbar); clicks there reach the taskbar
      // through clickGuardRects, which the overlays cut out of the cat's hit region.
      y: visibleEdgeAt(e.monitor, e.edge, m.extent) - 1,
      x0,
      x1,
      rest: null,
      focusX: null,
      edge: e.edge,
    };
  }

  /** See TaskbarTrackerHandle.clickGuardRects. */
  function guardRectsOf(e: Entry): Rect[] {
    const out: Rect[] = [];
    if (e.visible) out.push(toRect(e.rect));
    if (e.autoHide) {
      const span = spanOnMonitor(e.rect, e.monitor, e.edge);
      const band = rawIntersect(edgeBand(e.monitor, e.edge, span, Math.ceil(TASKBAR_CLICK_GUARD_DIP * e.scale)), e.monitor);
      if (band) out.push(toRect(band));
    }
    return out;
  }

  function debugOf(e: Entry): Record<string, unknown> {
    const m = e.motion.snapshot();
    const exStyle = guard('GetWindowLongPtrW', null, () => native.getExStyle(e.hwnd));
    return {
      id: e.id,
      primary: e.primary,
      role: roleOf(e),
      displayId: e.displayId,
      scale: e.scale,
      edge: e.edge,
      appBarEdge: e.appBarEdge,
      edgeMismatch: e.edgeMismatch,
      autoHide: e.autoHide,
      autoHideBy: e.autoHideBy,
      monitor: toRect(e.monitor),
      work: toRect(e.work),
      monitorSource: e.monitorSource,
      rect: toRect(e.rect),
      dockedRect: toRect(e.docked),
      thickness: e.thickness,
      thicknessSource: e.thicknessSource,
      visible: e.visible,
      extent: m.extent,
      measuredExtent: m.measured,
      shownFraction: m.fraction,
      phase: m.phase,
      speed: speedOf(e, m),
      inferred: m.inferred,
      readFailures: e.readFailures,
      reported: e.reported,
      /** WS_EX_TOPMOST (0x8) of the taskbar window; null when unreadable. */
      topmost: exStyle === null ? null : (exStyle & 0x8) !== 0,
      validatedAt: e.validatedAt,
    };
  }

  return {
    available: true,
    start() {
      if (started) return;
      started = true;
      guard('start', undefined, () => discover(clock(), 'start'));
    },
    stop() {
      started = false;
      entries = new Map();
      events = [];
      pending = null;
      forcedPending = null;
      followUpAt = null;
      lastChangeAt = null;
      signature = null;
    },
    // The host's catNear hint does not change the cadence: a still taskbar is sampled at the idle
    // rate wherever the cat is, and any slide is followed by the recent-change burst.
    sample(now, cursor) {
      return guard('sample', IDLE_SAMPLE_MS, () => sampleImpl(now, cursor));
    },
    taskbars() {
      return guard('taskbars', [], () => [...entries.values()].map(stateOf));
    },
    clickGuardRects() {
      return guard('clickGuardRects', [], () => [...entries.values()].flatMap(guardRectsOf));
    },
    surfaces() {
      return guard('surfaces', [], () => {
        const out: LedgeSurface[] = [];
        for (const e of entries.values()) {
          const s = ledgeOf(e);
          if (s) out.push(s);
        }
        return out;
      });
    },
    drainEvents() {
      const out = events;
      events = [];
      return out;
    },
    debugInfo() {
      return guard<Record<string, unknown>>('debugInfo', { available: true, error: 'debugInfo failed' }, () => ({
        available: true,
        started,
        taskbars: [...entries.values()].map(debugOf),
        appBar: appBar ? { state: appBar.state, edge: appBar.pos ? edgeFromAbe(appBar.pos.edge) : null, rect: appBar.pos ? toRect(appBar.pos.rect) : null, at: appBar.at } : null,
        discoveries,
        lastDiscovery,
        pendingRediscovery: pending ?? forcedPending,
        followUpAt,
        samples,
        lastSampleAt,
        lastChangeAt,
        cadence: { delayMs: lastDecision.delayMs, burst: lastDecision.delayMs === BURST_SAMPLE_MS, reason: lastDecision.reason },
        eventsQueued: events.length,
        droppedEvents,
        failures: Object.fromEntries(errorCounts),
        roles: 'bottom auto-hide = ledge (surfaces); bottom always-shown = floor (work-area floor); top = ceiling, left/right = walls (not in the ledge list)',
      }));
    },
    rediscover(reason) {
      if (!started) return;
      pending = reason;
      if (reason === 'taskbar-created' || reason === 'display-change') followUpAt = guard('clock', null, () => clock() + FOLLOW_UP_MS);
    },
    setWorld(next) {
      world = next;
      if (started) {
        pending = 'display-change';
        followUpAt = guard('clock', null, () => clock() + FOLLOW_UP_MS);
      }
    },
  };
}
