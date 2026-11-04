// Hosts the cat simulation: a setTimeout-driven loop whose rate follows the sim's
// own nextTickMs, gathering sensor snapshots and events every tick and
// dispatching the output to the overlays. Cursor sampling for click-through runs
// on a separate adaptive timer so interaction stays responsive while the sim ticks
// slowly (asleep, hidden). The same timer drives the taskbar tracker's adaptive
// sampling (it returns its own next delay), so no extra timer or busy loop exists.
// Environment surfaces (v1.1) are read once per host tick for env.surfaces; the surface
// the cat rides is re-read live through env.getSurface.
//
// v1.2 (ADR 0003 §3, §4.3, §6.1):
// - env.pointerButtonDown / pointerButtonPresses: the left, right and middle mouse buttons (held,
//   and a content-free press count), sampled on the cursor poll and every tick; env.cursorIdleMs.
// - env.edgeBands only from a host that has the click guard (the Win32 obstacle source): without
//   it the sim never climbs a screen edge.
// - clickGuardRectsPx(): the T8 guard. While the cat clings to a screen edge, while it flies to or
//   from one, and while it bails out of a covered or vanished window ledge, every obstacle window
//   meeting its bounds (GetWindowRect grown by 8 DIP) is cut out of its hit region. Anywhere else,
//   the floor next to a screen side included, it takes the mouse as usual. Fail closed: a stale,
//   incomplete or failing obstacle source makes the whole cat click-through in those states.
import { distanceToRect } from '../core/display/displayMath';
import { suggestPollIntervalMs, wallGuardRects } from '../core/interaction/clickThrough';
import { CAT_BASE_WIDTH_DIP, type BehaviorState } from '../shared/cat';
import type { Point, Rect } from '../shared/geometry';
import type { Settings } from '../shared/settings';
import type { CatSim, SimEnv, SimEvent, SimOutput, SimRequest } from '../shared/sim';
import { SCREEN_EDGE_KIND, type ScreenEdgeBand, type Surface } from '../shared/surfaces';
import type { WorldGeometry } from '../shared/world';
import { simWorld } from '../core/display/simWorld';
import type { ActivityMonitor, DisplayService, Logger, PerceptionService, SurfaceProvider, TaskbarTracker, Win32Api, WindowTracker } from './contracts';
import { BODY_MARGIN_SIDE_DIP } from './overlay/renderMapping';
import type { CatPosition, ScreenEdgeGuard } from './surfaces';
import { bandXRange } from './surfaces/edgeBands';
import { hasWin32InputExtensions, type Win32InputExtensions } from './win32/win32Api';

export const MIN_TICK_MS = 16;
export const MAX_TICK_MS = 1000;
export const MAX_DT_MS = 250;
/** Real gaps up to this long are caught up in <= MAX_DT_MS sub-steps (timer lateness, slow hidden ticks, error back-off); longer stalls are clamped. */
export const MAX_CATCHUP_MS = 1000;
const HIDDEN_MIN_TICK_MS = 250;
const HIDDEN_POLL_MS = 500;
const MAX_EVENTS_PER_TICK = 64;
export const PLATFORM_MAX_AGE_MS = 1000;
/** While hidden the surface set is fully re-read at most this often (event-driven updates still apply). */
export const HIDDEN_SURFACE_MAX_AGE_MS = 5000;
const FULLSCREEN_REFRESH_MS = 1000;
/** Bounds on the taskbar tracker's requested sample delay; hidden or locked it idles at 1 Hz. */
export const MIN_TASKBAR_SAMPLE_MS = 16;
export const MAX_TASKBAR_SAMPLE_MS = 1000;
export const IDLE_TASKBAR_SAMPLE_MS = 1000;
/** Without a usable taskbar tracker, availability is re-checked this often. */
const TASKBAR_RECHECK_MS = 5000;
/** The cat counts as near a (moving or auto-hide) taskbar within this distance (DIP, scaled). */
export const CAT_NEAR_TASKBAR_DIP = 150;
/** Longest gap between sim ticks while a taskbar near the cat is sliding (ms). */
export const MOVING_SURFACE_TICK_MS = 33;
/** Cursor distance from a hidden auto-hide taskbar's screen edge that triggers an immediate sample (DIP, scaled). */
export const TASKBAR_REVEAL_BAND_DIP = 6;
const ASLEEP: ReadonlySet<BehaviorState> = new Set<BehaviorState>(['sleeping', 'fallingAsleep']);
const NO_SURFACES: readonly Surface[] = Object.freeze([]);
/** The cursor counts as moved beyond this (DIP, scaled) for env.cursorIdleMs. */
export const CURSOR_IDLE_MOVE_DIP = 2;
/** v1.2 T8 guard: obstacles are grown by this much (DIP, scaled): resize borders and shadows. */
export const GUARD_OBSTACLE_MARGIN_DIP = 8;
/** A leap or wall jump counts as an edge flight while the cat's bounds are within this many body widths of a cling band. */
export const GUARD_BAND_REACH_BW = 1;
/** Failing closed, the whole cat plus this margin (px) is cut out (the hit zone grows by a hysteresis margin). */
const FAIL_CLOSED_MARGIN_PX = 16;
/** Obstacle hooks stay installed this long after the guard was last needed (no hook churn). */
const GUARD_DISARM_AFTER_MS = 2000;
/** Window surfaces whose loss (covered, gone) starts a bail-out guard. */
const WINDOW_SURFACE_KINDS: ReadonlySet<string> = new Set(['windowTop', 'tabStrip', 'windowSide']);
const BAIL_SPAN_TOLERANCE_PX = 2;

/** The surface provider as the host uses it (noteCat is the provider's host-feedback extra; v1.2 edge bands and guard state). */
export type HostSurfaceProvider = SurfaceProvider & {
  noteCat?(cat: CatPosition | null): void;
  edgeBands?(): readonly ScreenEdgeBand[] | null;
  noteClickGuard?(state: ScreenEdgeGuard): void;
};

export interface HostOverlays {
  render(out: SimOutput, simNow: number, hidden: boolean): void;
  updateInteractivity(cursorPx: Point | null, blocked: boolean): void;
  isCursorOverCat(cursorPx: Point | null): boolean;
  readonly dragging: boolean;
  readonly pressed: boolean;
  readonly interactive: boolean;
}

export interface HostTimers {
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}

export interface CatHostOptions {
  sim: CatSim;
  win32: Win32Api;
  tracker: WindowTracker;
  activity: ActivityMonitor & { setSleepThresholdMs?: (ms: number) => void };
  perception: PerceptionService | null;
  display: DisplayService;
  overlays: HostOverlays;
  catStore: { markDirty(): void; save(): Promise<boolean> };
  logger: Logger;
  getSettings: () => Settings;
  /** Cursor in px without Win32 (Electron screen API). */
  cursorFallback: () => Point | null;
  /** Monotonic ms (performance.now in production). */
  clock?: () => number;
  wallClock?: () => Date;
  timers?: HostTimers;
  timeScale?: number;
  /** Behaviour state, pause or visibility changed. */
  onStatusChange?: () => void;
  /** v1.1 environment surfaces (taskbars, window tops/sides, tab strips). Without it env.surfaces stays empty. */
  surfaces?: HostSurfaceProvider | null;
  /** Taskbar observer, sampled from the cursor-poll timer at the rate it asks for. */
  taskbars?: TaskbarTracker | null;
}

export interface CatHostDebug {
  ticks: number;
  tickErrors: number;
  simNow: number;
  timeScale: number;
  paused: boolean;
  hidden: boolean;
  locked: boolean;
  pendingEvents: number;
  droppedEvents: number;
  /** Surfaces handed to the sim on the last tick. */
  surfaces: number;
  taskbarSamples: number;
  /** Delay before the next taskbar sample (ms), null without a taskbar tracker. */
  taskbarDelayMs: number | null;
  /** v1.2 T8 screen-edge click guard: state, why it is on, and how often it failed closed. */
  clickGuard: { state: ScreenEdgeGuard['state']; reason: 'band' | 'edgeFlight' | 'bailOut' | null; failClosed: number; rects: number; armed: boolean };
  /** v1.2: edge bands handed to the sim on the last tick (null: none, the host has no guard). */
  edgeBands: number | null;
}

export interface CatHost {
  start(): void;
  stop(): void;
  readonly running: boolean;
  readonly paused: boolean;
  readonly hidden: boolean;
  readonly locked: boolean;
  setPaused(paused: boolean): void;
  setHidden(hidden: boolean): void;
  /** Calls the cat to `at` (default: the cursor); shows it first if hidden. */
  callCat(at?: Point): void;
  enqueue(ev: SimEvent): void;
  enqueueAll(evs: readonly SimEvent[]): void;
  /** Sends lifecycle.quitRequested; resolves when the sim reports quitReady. */
  requestQuit(): Promise<void>;
  onSystem(kind: 'lock' | 'unlock' | 'suspend' | 'resume'): void;
  onDisplayChanged(world: WorldGeometry): void;
  updateSettings(settings: Settings): void;
  readonly lastOutput: SimOutput | null;
  /** env.surfaces of the last tick (what the sim saw). */
  readonly lastSurfaces: readonly Surface[];
  readonly state: BehaviorState;
  readonly timeScale: number;
  setTimeScale(scale: number): void;
  cursorPx(): Point | null;
  catBoundsPx(): Rect | null;
  catDisplayId(): string | null;
  catAnchor(): Point | null;
  /** Displays with a fullscreen app in front, as last handed to the sim (re-checked about once a second). */
  fullscreenDisplayIds(): readonly string[];
  /**
   * v1.2 (ADR 0003 §6.1, §3; review C2) seam: screen rects (px) no overlay takes the mouse over
   * right now because of what the cat is doing: obstacle windows next to a cat clinging to, leaping
   * at or jumping off a screen edge, and the covering window while it bails out of a covered ledge.
   * app.ts unions them with the taskbar guard; a throw makes the overlay manager fail closed
   * (click-through everywhere). The provider package implements it; the contract stub returns [].
   */
  clickGuardRectsPx(): readonly Rect[];
  /** Test mode only (E2E, via test hooks): use `p` as the cursor for the sim and the click-through decision; null restores the real one. */
  setInjectedCursor(p: Point | null): void;
  /** Test mode only (E2E, via test hooks): the sim sees `ms` as the user's idle time; null restores the real one. */
  setInjectedUserIdle(ms: number | null): void;
  debug(): CatHostDebug;
}

/** No extra click-guard rects (the guard is not needed right now). */
const NO_GUARD_RECTS: readonly Rect[] = Object.freeze([]);

const growRect = (r: Rect, m: number): Rect => ({ x: r.x - m, y: r.y - m, width: r.width + 2 * m, height: r.height + 2 * m });

/** Distance between two rects (0 when they touch or overlap). */
function rectGap(a: Rect, b: Rect): number {
  const dx = Math.max(0, a.x - (b.x + b.width), b.x - (a.x + a.width));
  const dy = Math.max(0, a.y - (b.y + b.height), b.y - (a.y + a.height));
  return Math.hypot(dx, dy);
}

const clampNum = (v: number, lo: number, hi: number): number => (Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : hi);

export function createCatHost(opts: CatHostOptions): CatHost {
  const log = opts.logger;
  const clock = opts.clock ?? (() => performance.now());
  const wallClock = opts.wallClock ?? (() => new Date());
  const timers: HostTimers = opts.timers ?? {
    setTimeout: (fn, ms) => setTimeout(fn, ms),
    clearTimeout: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
  };
  const { sim, win32, tracker, activity, perception, overlays } = opts;

  let running = false;
  let paused = false;
  let hidden = false;
  let locked = false;
  let timeScale = clampNum(opts.timeScale ?? 1, 0.1, 100);
  let simNow = 0;
  let lastReal: number | null = null;
  let lastTickAt = -Infinity;
  let pending: SimEvent[] = [];
  let tickTimer: unknown = null;
  let tickDueAt = Infinity;
  let pollTimer: unknown = null;
  let lastOutput: SimOutput | null = null;
  let lastState: BehaviorState | null = null;
  let lastCursor: Point | null = null;
  /** Test mode only (setInjectedCursor). */
  let injectedCursor: Point | null = null;
  /** Test mode only (setInjectedUserIdle). */
  let injectedUserIdleMs: number | null = null;
  let fullscreenIds: string[] = [];
  let fullscreenAt = -Infinity;
  let quitWaiters: Array<() => void> = [];
  let ticks = 0;
  let tickErrors = 0;
  let consecutiveErrors = 0;
  let droppedEvents = 0;
  let pollErrors = 0;
  let cursorDueAt = -Infinity;
  let taskbarDueAt = -Infinity;
  let taskbarSamples = 0;
  let taskbarErrors = 0;
  let taskbarDelayMs: number | null = null;
  let lastSurfaces: readonly Surface[] = NO_SURFACES;
  const surfaces = opts.surfaces ?? null;
  const taskbars = opts.taskbars ?? null;

  // ---- v1.2 input and the T8 click guard
  /** Mouse buttons, the obstacle source and window pids (null: an older or test Win32 facade). */
  const input: (Win32Api & Win32InputExtensions) | null = hasWin32InputExtensions(win32) ? win32 : null;
  let buttons: { down: boolean; presses: number } | null = null;
  let cursorMovedAt = Number.NEGATIVE_INFINITY;
  let cursorMovePoint: Point | null = null;
  /** Edge bands handed to the sim on the last tick (null: none). */
  let edgeBands: readonly ScreenEdgeBand[] | null = null;
  /** The cat flies to or from a screen edge (left one, or a leap / wall jump near a band) until it lands. */
  let edgeFlight = false;
  /** The window ledge or side under the cat is covered or gone: guarded from then until it lands. */
  let bailGuard = false;
  let guard: ScreenEdgeGuard = { state: input === null ? 'off' : 'idle', failClosed: 0 };
  let guardReason: CatHostDebug['clickGuard']['reason'] = null;
  let guardRects = 0;
  let armed = false;
  let guardNeededAt = Number.NEGATIVE_INFINITY;

  function sampleButtons(): void {
    if (input === null || !input.available) return;
    try {
      buttons = input.mouseButtons();
    } catch (err) {
      log.warn('mouse buttons failed', { error: err });
      buttons = null;
    }
  }

  /** env.cursorIdleMs bookkeeping: the last time the cursor moved more than CURSOR_IDLE_MOVE_DIP. */
  function noteCursorMove(p: Point | null, t: number): void {
    if (!p) return;
    const scale = displayScale(safe(() => opts.display.displayAt(p), null, 'display at cursor'));
    if (cursorMovePoint === null || Math.hypot(p.x - cursorMovePoint.x, p.y - cursorMovePoint.y) > CURSOR_IDLE_MOVE_DIP * scale) {
      cursorMovePoint = { x: p.x, y: p.y };
      cursorMovedAt = t;
    }
  }

  /** The cat's real width on a display (body width x size plus both side margins), px. */
  function footprintPx(displayId: string): number {
    return (CAT_BASE_WIDTH_DIP * opts.getSettings().appearance.size + 2 * BODY_MARGIN_SIDE_DIP) * displayScale(displayId);
  }

  /** The cat's bounds come within GUARD_BAND_REACH_BW body widths of a cling band. */
  function nearBand(bounds: Rect): boolean {
    const bands = edgeBands;
    if (!bands || bands.length === 0) return false;
    for (const b of bands) {
      const d = opts.display.world.displays.find((x) => x.id === b.displayId);
      if (!d) continue;
      const work = d.workAreaPx;
      const reach = GUARD_BAND_REACH_BW * CAT_BASE_WIDTH_DIP * opts.getSettings().appearance.size * d.scaleFactor;
      const x = bandXRange(work, b.side, footprintPx(b.displayId));
      const band: Rect = { x: x.x0, y: work.y, width: x.x1 - x.x0, height: work.height };
      if (rectGap(band, bounds) <= reach) return true;
    }
    return false;
  }

  /** The surface the cat stands on is a window surface no longer listed with the cat's spot on it. */
  function supportLost(out: SimOutput, listed: readonly Surface[]): boolean {
    const s = out.support;
    if (s.kind !== 'surface' || !WINDOW_SURFACE_KINDS.has(s.surfaceKind)) return false;
    const l = listed.find((x) => x.id === s.surfaceId);
    if (!l) return true;
    if (l.orientation === 'ledge') return out.x < l.x0 - BAIL_SPAN_TOLERANCE_PX || out.x > l.x1 + BAIL_SPAN_TOLERANCE_PX;
    return out.y < l.y0 - BAIL_SPAN_TOLERANCE_PX || out.y > l.y1 + BAIL_SPAN_TOLERANCE_PX;
  }

  /** After each tick: edge flights and bail-outs start and end with the support. */
  function trackGuardPhases(prev: SimOutput | null, out: SimOutput): void {
    const airborne = out.support.kind === 'air';
    const wasEdge = prev?.support.kind === 'surface' && prev.support.surfaceKind === SCREEN_EDGE_KIND;
    if (airborne) {
      const k = out.jumpKind ?? null;
      if (wasEdge || ((k === 'leap' || k === 'wallJump') && out.visible && nearBand(out.boundsPx))) edgeFlight = true;
    } else edgeFlight = false;
    if (supportLost(out, lastSurfaces)) bailGuard = true;
    else if (!airborne) bailGuard = false;
  }

  function setGuard(state: ScreenEdgeGuard['state'], reason: CatHostDebug['clickGuard']['reason']): void {
    guardReason = reason;
    if (state === guard.state) return;
    guard = { state, failClosed: guard.failClosed + (state === 'failClosed' ? 1 : 0) };
    if (state === 'failClosed') log.debug('click guard failed closed (obstacle source stale)');
    attempt(() => surfaces?.noteClickGuard?.(guard), 'click guard state');
  }

  function setArmed(next: boolean, t: number): void {
    if (input === null) return;
    if (next) guardNeededAt = t;
    // Disarm only after a quiet spell, so a cat moving along the band does not churn the hooks.
    const want = next || t - guardNeededAt < GUARD_DISARM_AFTER_MS;
    if (want === armed) return;
    armed = want;
    attempt(() => input.setObstacleWatch(want), 'obstacle watch');
  }

  /** The T8 guard (see the header). Never throws: every failure fails closed. */
  function clickGuardRects(): readonly Rect[] {
    const t = clock();
    if (input === null) {
      guardRects = 0;
      return NO_GUARD_RECTS;
    }
    const out = lastOutput;
    const bounds = out && out.visible && !hidden ? out.boundsPx : null;
    const clinging = out?.support.kind === 'surface' && out.support.surfaceKind === SCREEN_EDGE_KIND;
    const reason: CatHostDebug['clickGuard']['reason'] = !bounds ? null : bailGuard ? 'bailOut' : edgeFlight ? 'edgeFlight' : clinging ? 'band' : null;
    if (!bounds || reason === null) {
      setArmed(false, t);
      setGuard('idle', null);
      guardRects = 0;
      return NO_GUARD_RECTS;
    }
    setArmed(true, t);
    let obstacles: { rects: readonly Rect[]; fresh: boolean } | null = null;
    try {
      obstacles = input.clickObstaclesPx();
    } catch (err) {
      log.warn('click-guard obstacles failed', { error: err });
    }
    if (obstacles === null || !obstacles.fresh) {
      // Fail closed: the whole cat is click-through until the obstacle list is current again.
      setGuard('failClosed', reason);
      guardRects = 1;
      return [growRect(bounds, FAIL_CLOSED_MARGIN_PX)];
    }
    // 8 DIP at the largest scale of the displays the window touches.
    const displays = opts.display.world.displays;
    const grown = obstacles.rects.map((r) => {
      let scale = 1;
      for (const d of displays) if (rectGap(d.boundsPx, r) === 0 && d.scaleFactor > scale) scale = d.scaleFactor;
      return growRect(r, Math.ceil(GUARD_OBSTACLE_MARGIN_DIP * scale));
    });
    const rects = wallGuardRects(growRect(bounds, FAIL_CLOSED_MARGIN_PX), grown);
    setGuard('active', reason);
    guardRects = rects.length;
    return rects;
  }

  /** Live geometry of one surface (the sim calls it for the surface it rides). */
  const getSurface = (id: string): Surface | null => {
    if (!surfaces) return null;
    try {
      return surfaces.getSurface(id, clock());
    } catch {
      return null;
    }
  };

  /**
   * Where the cat is and what it stands on; also while hidden (the sim keeps it on its surface).
   * Asleep, paused or away (out of sight for a fullscreen app) it makes no trips: the provider
   * then stops measuring far browsers.
   */
  function catPosition(): CatPosition | null {
    const out = lastOutput;
    if (!out) return null;
    return {
      x: out.x,
      y: out.y,
      surfaceId: out.support.kind === 'surface' ? out.support.surfaceId : null,
      hidden,
      asleep: ASLEEP.has(out.state),
      paused,
      away: out.state === 'away' || !out.visible,
    };
  }

  function readSurfaces(nowReal: number): readonly Surface[] {
    if (!surfaces) return NO_SURFACES;
    attempt(() => surfaces.noteCat?.(catPosition()), 'surface feedback');
    lastSurfaces = safe(() => surfaces.getSurfaces(nowReal, hidden ? HIDDEN_SURFACE_MAX_AGE_MS : PLATFORM_MAX_AGE_MS), NO_SURFACES, 'surfaces');
    return lastSurfaces;
  }

  function displayScale(id: string | null): number {
    if (id === null) return 1;
    return opts.display.world.displays.find((d) => d.id === id)?.scaleFactor ?? 1;
  }

  /**
   * The cat rides a taskbar, or is within CAT_NEAR_TASKBAR_DIP of one that is on screen and can
   * move (auto-hide, or sliding). A static docked taskbar is always next to a floor-standing
   * cat, and a hidden one does not move until the cursor reaches its edge (see
   * cursorAtHiddenTaskbarEdge): fast sampling either would only burn timer wake-ups.
   */
  function catNearTaskbar(tb: TaskbarTracker): boolean {
    const out = lastOutput;
    if (!out || !out.visible || hidden) return false;
    if (out.support.kind === 'surface' && out.support.surfaceKind === 'taskbar') return true;
    const limit = CAT_NEAR_TASKBAR_DIP * displayScale(out.displayId);
    const p = { x: out.x, y: out.y };
    for (const s of tb.taskbars()) {
      const moving = s.phase === 'showing' || s.phase === 'hiding';
      if (!moving && !(s.autoHide && s.phase === 'shown')) continue;
      if (distanceToRect(s.dockedRect, p) <= limit) return true;
    }
    return false;
  }

  /**
   * The cursor is in the reveal band of a hidden auto-hide taskbar: sample now instead of at the
   * idle cadence, so a reveal under the cat is followed from its first frame (the cursor poll
   * already runs every 16-125 ms; this adds no timer).
   */
  function cursorAtHiddenTaskbarEdge(tb: TaskbarTracker, c: Point): boolean {
    for (const s of tb.taskbars()) {
      if (!s.autoHide || s.phase !== 'hidden') continue;
      const d = s.dockedRect;
      const band = Math.ceil(TASKBAR_REVEAL_BAND_DIP * displayScale(s.displayId));
      const inX = c.x >= d.x && c.x < d.x + d.width;
      const inY = c.y >= d.y && c.y < d.y + d.height;
      if (s.edge === 'bottom' && inX && c.y >= d.y + d.height - band && c.y < d.y + d.height) return true;
      if (s.edge === 'top' && inX && c.y >= d.y && c.y < d.y + band) return true;
      if (s.edge === 'left' && inY && c.x >= d.x && c.x < d.x + band) return true;
      if (s.edge === 'right' && inY && c.x >= d.x + d.width - band && c.x < d.x + d.width) return true;
    }
    return false;
  }

  /** A sample is not already imminent and the cursor just reached a hidden taskbar's edge. */
  function revealPending(tb: TaskbarTracker, cursor: Point, t: number): boolean {
    if (!tb.available || taskbarDueAt - t <= MIN_TASKBAR_SAMPLE_MS) return false;
    try {
      return cursorAtHiddenTaskbarEdge(tb, cursor);
    } catch (err) {
      taskbarErrors++;
      if (taskbarErrors <= 5 || taskbarErrors % 1000 === 0) log.warn('taskbar state failed', { error: err, count: taskbarErrors });
      return false;
    }
  }

  function sampleTaskbars(t: number, cursor: Point | null): void {
    if (!taskbars || !taskbars.available) {
      taskbarDelayMs = null;
      taskbarDueAt = t + TASKBAR_RECHECK_MS;
      return;
    }
    let delay: number;
    try {
      const near = catNearTaskbar(taskbars);
      delay = taskbars.sample(t, cursor, near);
      taskbarSamples++;
      // A taskbar sliding under or next to the cat is followed at a smooth tick rate even
      // while the sim itself would tick slowly (asleep).
      if (near && !hidden && !paused && taskbars.taskbars().some((s) => s.phase === 'showing' || s.phase === 'hiding')) {
        scheduleTick(Math.max(0, MOVING_SURFACE_TICK_MS - (t - lastTickAt)));
      }
    } catch (err) {
      taskbarErrors++;
      if (taskbarErrors <= 5 || taskbarErrors % 1000 === 0) log.warn('taskbar sample failed', { error: err, count: taskbarErrors });
      delay = IDLE_TASKBAR_SAMPLE_MS;
    }
    delay = clampNum(delay, MIN_TASKBAR_SAMPLE_MS, MAX_TASKBAR_SAMPLE_MS);
    if (hidden || locked) delay = Math.max(delay, IDLE_TASKBAR_SAMPLE_MS);
    taskbarDelayMs = delay;
    taskbarDueAt = t + delay;
  }

  function safe<T>(fn: () => T, fallback: T, what: string): T {
    try {
      return fn();
    } catch (err) {
      log.warn(`${what} failed`, { error: err });
      return fallback;
    }
  }

  function attempt(fn: () => void, what: string): void {
    try {
      fn();
    } catch (err) {
      log.warn(`${what} failed`, { error: err });
    }
  }

  function statusChanged(): void {
    try {
      opts.onStatusChange?.();
    } catch (err) {
      log.error('status listener failed', { error: err });
    }
  }

  function sampleCursor(): Point | null {
    if (injectedCursor) {
      lastCursor = injectedCursor;
      noteCursorMove(injectedCursor, clock());
      return injectedCursor;
    }
    let p: Point | null = null;
    if (win32.available) p = win32.getCursorPos();
    if (!p) {
      try {
        p = opts.cursorFallback();
      } catch {
        p = null;
      }
    }
    lastCursor = p;
    noteCursorMove(p, clock());
    return p;
  }

  function scheduleTick(delayMs: number): void {
    if (!running) return;
    const due = clock() + delayMs;
    if (tickTimer !== null) {
      if (due >= tickDueAt) return;
      timers.clearTimeout(tickTimer);
    }
    tickDueAt = due;
    tickTimer = timers.setTimeout(tick, delayMs);
  }

  /** Ticks as soon as allowed so interaction and commands are not delayed by a slow (sleeping) cadence. */
  function nudge(): void {
    scheduleTick(Math.max(0, MIN_TICK_MS - (clock() - lastTickAt)));
  }

  function collectEvents(): SimEvent[] {
    const evs = pending;
    pending = [];
    // The tracker first: draining it delivers the change notices the surface provider uses.
    evs.push(...safe(() => tracker.drainEvents(), [], 'window events'));
    if (surfaces) evs.push(...safe(() => surfaces.drainEvents(), [], 'surface events'));
    evs.push(...safe(() => activity.drainEvents(), [], 'activity events'));
    if (perception) evs.push(...safe(() => perception.drainEvents(), [], 'perception events'));
    if (evs.length > MAX_EVENTS_PER_TICK) {
      droppedEvents += evs.length - MAX_EVENTS_PER_TICK;
      log.debug('dropping excess events', { count: evs.length - MAX_EVENTS_PER_TICK });
      evs.length = MAX_EVENTS_PER_TICK;
    }
    return evs;
  }

  function resolveQuit(): void {
    const waiters = quitWaiters;
    quitWaiters = [];
    for (const w of waiters) w();
  }

  function handleRequests(requests: readonly SimRequest[]): void {
    for (const r of requests) {
      switch (r.type) {
        case 'perception':
          if (perception && !hidden && !locked) attempt(() => perception.request(r.reason, r.focus), 'perception request');
          break;
        case 'save':
          void opts.catStore.save();
          break;
        case 'quitReady':
          resolveQuit();
          break;
      }
    }
  }

  function step(nowReal: number): number {
    const realDelta = lastReal === null ? 0 : Math.max(0, nowReal - lastReal);
    lastReal = nowReal;
    lastTickAt = nowReal;
    // Sim time tracks real time through ordinary gaps by sub-stepping (each step <= MAX_DT_MS);
    // only stalls longer than MAX_CATCHUP_MS are clamped, so there is no catch-up storm after a stall.
    const simDelta = Math.min(realDelta * timeScale, MAX_CATCHUP_MS * Math.max(1, Math.ceil(timeScale)));
    const steps = Math.max(1, Math.ceil(simDelta / MAX_DT_MS));
    const dt = simDelta / steps;

    const cursor = sampleCursor();
    sampleButtons();
    attempt(() => activity.sample(nowReal, cursor), 'activity sample');
    const events = collectEvents();
    const world = opts.display.world;
    if (nowReal - fullscreenAt >= FULLSCREEN_REFRESH_MS) {
      fullscreenIds = safe(() => tracker.getFullscreenDisplayIds(world), [], 'fullscreen check');
      fullscreenAt = nowReal;
    }
    const envSurfaces = readSurfaces(nowReal);
    // Edge bands only with the click guard behind them (absent: the sim never climbs a screen edge).
    edgeBands = input !== null && input.available && surfaces?.edgeBands ? safe(() => surfaces.edgeBands?.() ?? null, null, 'edge bands') : null;
    const foreground = safe(() => tracker.getForeground(), null, 'foreground');
    const wall = wallClock();
    const v12: Partial<SimEnv> = {
      ...(buttons !== null ? { pointerButtonDown: buttons.down, pointerButtonPresses: buttons.presses } : {}),
      ...(cursor !== null && Number.isFinite(cursorMovedAt) ? { cursorIdleMs: Math.max(0, nowReal - cursorMovedAt) } : {}),
      ...(edgeBands !== null ? { edgeBands } : {}),
    };
    const base: Omit<SimEnv, 'now' | 'dt'> = {
      ...v12,
      cursor: cursor ? { x: cursor.x, y: cursor.y, speed: activity.cursorSpeed } : null,
      cursorOverCat: overlays.isCursorOverCat(cursor),
      userIdleMs: injectedUserIdleMs ?? activity.idleMs,
      typing: activity.typing,
      typingIntensity: activity.typingIntensity,
      foreground,
      surfaces: envSurfaces,
      getSurface,
      fullscreenDisplayIds: fullscreenIds,
      paused,
      hidden,
      dragCursor: overlays.dragging ? cursor : null,
      localHour: wall.getHours() + wall.getMinutes() / 60,
    };

    let out: SimOutput | null = null;
    for (let i = 0; i < steps; i++) {
      simNow += dt;
      out = sim.tick({ ...base, now: simNow, dt }, i === 0 ? events : []);
      handleRequests(out.requests);
    }
    if (!out) return MAX_TICK_MS;
    ticks++;
    attempt(() => trackGuardPhases(lastOutput, out), 'click guard phases');
    lastOutput = out;
    overlays.render(out, simNow, hidden);
    opts.catStore.markDirty();
    if (out.state !== lastState) {
      lastState = out.state;
      statusChanged();
    }
    const delay = clampNum(out.nextTickMs, MIN_TICK_MS, MAX_TICK_MS);
    return hidden ? Math.max(delay, HIDDEN_MIN_TICK_MS) : delay;
  }

  function tick(): void {
    tickTimer = null;
    tickDueAt = Infinity;
    if (!running) return;
    let next: number;
    try {
      next = step(clock());
      consecutiveErrors = 0;
    } catch (err) {
      tickErrors++;
      consecutiveErrors++;
      if (consecutiveErrors <= 5 || consecutiveErrors % 100 === 0) log.error('simulation tick failed', { error: err, consecutive: consecutiveErrors });
      next = MAX_TICK_MS;
    }
    scheduleTick(next);
  }

  /** One timer, two cadences: cursor/click-through polling and taskbar sampling, each when due. */
  function poll(): void {
    pollTimer = null;
    if (!running) return;
    const t = clock();
    let cursor: Point | null = null;
    try {
      cursor = sampleCursor();
      // Presses between ticks are counted here too (the poll runs at 8-60 Hz).
      sampleButtons();
      if (t >= cursorDueAt) {
        const blocked = hidden || paused || locked || !opts.getSettings().interaction.enabled;
        overlays.updateInteractivity(cursor, blocked);
        const delay = hidden
          ? HIDDEN_POLL_MS
          : suggestPollIntervalMs({
              cursor,
              catBounds: lastOutput?.boundsPx ?? null,
              interactive: overlays.interactive,
              dragging: overlays.dragging || overlays.pressed,
              catAsleep: lastOutput ? ASLEEP.has(lastOutput.state) : false,
              visible: lastOutput?.visible ?? false,
            });
        cursorDueAt = t + delay;
        pollErrors = 0;
      }
    } catch (err) {
      pollErrors++;
      if (pollErrors <= 5) log.error('cursor poll failed', { error: err });
      cursorDueAt = t + 250;
    }
    if (t >= taskbarDueAt || (!hidden && !locked && cursor !== null && taskbars !== null && revealPending(taskbars, cursor, t))) {
      sampleTaskbars(t, cursor);
    }
    pollTimer = timers.setTimeout(poll, Math.max(1, Math.min(cursorDueAt, taskbarDueAt) - t));
  }

  function enqueue(ev: SimEvent): void {
    pending.push(ev);
    if (pending.length > MAX_EVENTS_PER_TICK * 4) {
      droppedEvents += pending.length - MAX_EVENTS_PER_TICK * 4;
      pending.splice(0, pending.length - MAX_EVENTS_PER_TICK * 4);
    }
  }

  return {
    start() {
      if (running) return;
      running = true;
      lastReal = null;
      cursorDueAt = -Infinity;
      taskbarDueAt = -Infinity;
      scheduleTick(0);
      poll();
      log.info('simulation started', { timeScale });
    },
    stop() {
      running = false;
      if (tickTimer !== null) timers.clearTimeout(tickTimer);
      if (pollTimer !== null) timers.clearTimeout(pollTimer);
      tickTimer = null;
      pollTimer = null;
      tickDueAt = Infinity;
      resolveQuit();
    },
    get running() {
      return running;
    },
    get paused() {
      return paused;
    },
    get hidden() {
      return hidden;
    },
    get locked() {
      return locked;
    },
    setPaused(p) {
      if (paused === p) return;
      paused = p;
      log.info(p ? 'cat paused' : 'cat resumed');
      statusChanged();
      nudge();
    },
    setHidden(h) {
      if (hidden === h) return;
      hidden = h;
      log.info(h ? 'cat hidden' : 'cat shown');
      statusChanged();
      nudge();
    },
    callCat(at) {
      const p = at ?? sampleCursor();
      if (!p) return;
      if (hidden) {
        hidden = false;
        statusChanged();
      }
      enqueue({ type: 'command.callCat', at: { x: p.x, y: p.y } });
      nudge();
    },
    enqueue(ev) {
      enqueue(ev);
      nudge();
    },
    enqueueAll(evs) {
      if (evs.length === 0) return;
      for (const ev of evs) enqueue(ev);
      nudge();
    },
    requestQuit() {
      if (!running) return Promise.resolve();
      return new Promise<void>((resolve) => {
        quitWaiters.push(resolve);
        enqueue({ type: 'lifecycle.quitRequested' });
        nudge();
      });
    },
    onSystem(kind) {
      const type = kind === 'lock' ? 'system.lock' : kind === 'unlock' ? 'system.unlock' : kind === 'suspend' ? 'system.suspend' : 'system.resume';
      if (kind === 'lock') locked = true;
      if (kind === 'unlock') locked = false;
      if (kind === 'resume' || kind === 'unlock') fullscreenAt = -Infinity;
      enqueue({ type });
      nudge();
    },
    onDisplayChanged(world) {
      attempt(() => sim.setWorld(simWorld(world)), 'sim.setWorld');
      fullscreenAt = -Infinity;
      enqueue({ type: 'display.changed' });
      nudge();
    },
    updateSettings(s) {
      attempt(() => sim.updateSettings(s), 'sim.updateSettings');
      if (activity.setSleepThresholdMs) attempt(() => activity.setSleepThresholdMs?.(s.behavior.sleepAfterIdleMinutes * 60_000), 'sleep threshold');
      nudge();
    },
    get lastOutput() {
      return lastOutput;
    },
    get lastSurfaces() {
      return lastSurfaces;
    },
    get state() {
      return lastOutput?.state ?? sim.state;
    },
    get timeScale() {
      return timeScale;
    },
    setTimeScale(s) {
      timeScale = clampNum(s, 0.1, 100);
      log.info('time scale set', { timeScale });
    },
    cursorPx: () => lastCursor ?? sampleCursor(),
    catBoundsPx: () => (lastOutput && lastOutput.visible && !hidden ? lastOutput.boundsPx : null),
    catDisplayId: () => lastOutput?.displayId ?? null,
    catAnchor: () => (lastOutput ? { x: lastOutput.x, y: lastOutput.y } : null),
    fullscreenDisplayIds: () => [...fullscreenIds],
    clickGuardRectsPx: () => clickGuardRects(),
    setInjectedCursor(p) {
      injectedCursor = p && Number.isFinite(p.x) && Number.isFinite(p.y) ? { x: p.x, y: p.y } : null;
      log.info(injectedCursor ? 'cursor injected (test mode)' : 'cursor injection ended');
    },
    setInjectedUserIdle(ms) {
      injectedUserIdleMs = typeof ms === 'number' && Number.isFinite(ms) && ms >= 0 ? ms : null;
      log.info(injectedUserIdleMs !== null ? 'user idle time injected (test mode)' : 'user idle injection ended');
    },
    debug: () => ({
      ticks,
      tickErrors,
      simNow,
      timeScale,
      paused,
      hidden,
      locked,
      pendingEvents: pending.length,
      droppedEvents,
      surfaces: lastSurfaces.length,
      taskbarSamples,
      taskbarDelayMs,
      clickGuard: { state: guard.state, reason: guardReason, failClosed: guard.failClosed, rects: guardRects, armed },
      edgeBands: edgeBands === null ? null : edgeBands.length,
    }),
  };
}
