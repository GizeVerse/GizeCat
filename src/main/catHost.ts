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
//   the floor next to a screen side included, it takes the mouse as usual. Fail closed: a stale (past
//   a 250 ms grace, see below), incomplete or failing obstacle source makes the whole cat
//   click-through in those states. The
//   overlay manager asks only with the cursor on the cat: otherwise no window is read or hooked.
//
// Long-run hardening (diagnosis H2, H5, H8; 2026-11):
// - A bail-out guard episode starts when the window support is reported covered or gone, or when the
//   cat leaves a lost window support (the bail-out crouch, take-off or drop the Mover reports through
//   support and jumpKind); it ends on the landing (floor, a listed surface, a wall caught after the
//   leap, or a grab) and never spends longer than BAIL_GUARD_MAX_MS grounded (time in the air does
//   not count; BAIL_GUARD_CEILING_MS in all). A support that stays unlisted while the cat keeps
//   standing on it starts no second episode.
// - A momentarily stale obstacle list reuses the last fresh one for at most OBSTACLE_STALE_GRACE_MS
//   (the ADR's 250 ms cache age); after that, and on any failing read, the guard still fails closed.
// - The lock flag is re-derived on resume and every LOCK_RECHECK_MS while set, and cleared on native
//   input after the lock, so a lost unlock event cannot block interaction for good. A lock cleared on
//   the OS's word alone (the probe) restores interaction only: perceptionPausedFor() keeps perception
//   paused until an unlock event or native input confirms the user is back (docs/PRIVACY.md).
// - Every resume and unlock, seen or recovered by the host, resets the overlays' input state
//   (HostOverlays.noteResume).
// - The event caps never drop pointer, lifecycle, system or command events.
import { distanceToRect } from '../core/display/displayMath';
import { DEFAULT_POLL_INTERVALS, EVERYWHERE, suggestPollIntervalMs, wallGuardRects } from '../core/interaction/clickThrough';
import { CAT_BASE_WIDTH_DIP, type BehaviorState } from '../shared/cat';
import type { Point, Rect } from '../shared/geometry';
import type { Settings } from '../shared/settings';
import type { CatSim, SimEnv, SimEvent, SimOutput, SimRequest } from '../shared/sim';
import { SCREEN_EDGE_KIND, type ScreenEdgeBand, type Surface } from '../shared/surfaces';
import type { WorldGeometry } from '../shared/world';
import { simWorld } from '../core/display/simWorld';
import type { ActivityMonitor, DisplayService, Logger, PerceptionService, SurfaceProvider, TaskbarTracker, Win32Api, WindowTracker } from './contracts';
import type { OverlayInteractionStats, OverlayRenderExtras } from './overlay/overlayManager';
import { BODY_MARGIN_SIDE_DIP, presenceRectPx } from './overlay/renderMapping';
import type { CatPosition, ScreenEdgeGuard } from './surfaces/hostTypes';
import { bandXRange } from './surfaces/edgeBands';
import { hasWin32InputExtensions, type Win32InputExtensions } from './win32/win32Api';

export const MIN_TICK_MS = 16;
export const MAX_TICK_MS = 1000;
export const MAX_DT_MS = 250;
/** Real gaps up to this long are caught up in <= MAX_DT_MS sub-steps (timer lateness, slow hidden ticks, error back-off); longer stalls are clamped. */
export const MAX_CATCHUP_MS = 1000;
const HIDDEN_MIN_TICK_MS = 250;
const HIDDEN_POLL_MS = 500;
export const MAX_EVENTS_PER_TICK = 64;
/** Queued events beyond this are trimmed, the oldest non-priority ones first. */
export const MAX_PENDING_EVENTS = MAX_EVENTS_PER_TICK * 4;
/**
 * Memory bound for a host that is not ticking (stopped): only then can priority events pile up this
 * far (a ticking host drains the queue at least once a second, the IPC layer rate-limits pointers).
 */
export const PENDING_HARD_CAP = 4096;
export const PLATFORM_MAX_AGE_MS = 1000;
/** While hidden the surface set is fully re-read at most this often (event-driven updates still apply). */
export const HIDDEN_SURFACE_MAX_AGE_MS = 5000;
const FULLSCREEN_REFRESH_MS = 1000;
/** The OS reduced-motion preference changes rarely; it is re-read this often (Living Companion). */
const REDUCED_MOTION_REFRESH_MS = 5000;
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
/** Obstacle hooks stay installed this long after the guard was last needed (no hook churn). */
const GUARD_DISARM_AFTER_MS = 2000;
/** Window surfaces whose loss (covered, gone) starts a bail-out guard. */
const WINDOW_SURFACE_KINDS: ReadonlySet<string> = new Set(['windowTop', 'tabStrip', 'windowSide']);
const BAIL_SPAN_TOLERANCE_PX = 2;
/**
 * Longest time a bail-out guard episode may spend grounded (ms). The Mover takes off within
 * bailOutMaxDelayMs (600 ms) of a cover; longer on the ground means the cat is still standing on a
 * support the list no longer holds, which is no bail-out (diagnosis H2). Time in the air does not
 * count: a drop from a high ledge on a tall screen takes well over a second, and ending the guard
 * mid-fall would hand the covering window's clicks to the falling cat.
 */
export const BAIL_GUARD_MAX_MS = 1500;
/** No bail-out guard episode outlasts this, whatever the support says (a fall from the top of the tallest screen takes under 2 s). */
export const BAIL_GUARD_CEILING_MS = 10_000;
/** A stale obstacle list reuses the last fresh one this long (ms; ADR 0003 §6.1(a) cache age) before failing closed. */
export const OBSTACLE_STALE_GRACE_MS = 250;
/** Click-guard info lines at most this often (ms); the suppressed ones are counted into the next. */
export const GUARD_LOG_GAP_MS = 15_000;
/** While the host holds the session locked, the OS lock state is re-checked this often (ms). */
export const LOCK_RECHECK_MS = 10_000;
/** Native input seen at least this long after a lock event is evidence the session is unlocked (ms). */
export const LOCK_INPUT_SETTLE_MS = 2000;
/** Input-driven lock re-checks at most this often (ms). */
const LOCK_INPUT_PROBE_GAP_MS = 1000;

/** Why the T8 click guard holds. */
export type GuardReason = 'band' | 'edgeFlight' | 'bailOut';

/** v1.2 long-run counters of the click guard (diagnostics export; counts and ms only). */
export interface ClickGuardStats {
  /** Episodes per reason (a reason taking over counts as a new episode). */
  episodes: Record<GuardReason, number>;
  /** Time the cat spent in each guard phase, whether or not the cursor was on it (ms). */
  timeInGuardMs: Record<GuardReason, number>;
  /** The longest single episode (ms). */
  longestEpisodeMs: number;
  /** Bail-out episodes ended by BAIL_GUARD_MAX_MS rather than by a landing. */
  bailOutsCapped: number;
  /** Polls the guard answered with EVERYWHERE (stale past the grace, failing or throwing source). */
  failClosedPolls: number;
  /** Polls answered from the last fresh obstacle list within OBSTACLE_STALE_GRACE_MS. */
  staleGracePolls: number;
  /** Polls answered from a fresh obstacle list. */
  activePolls: number;
}

/** Events the caps never drop (diagnosis H8): the user's pointer, lifecycle, system and command events. */
export function isPriorityEvent(ev: SimEvent): boolean {
  const t = ev.type;
  return t.startsWith('pointer.') || t.startsWith('lifecycle.') || t.startsWith('system.') || t.startsWith('command.') || t === 'display.changed';
}

/** The surface provider as the host uses it (noteCat is the provider's host-feedback extra; v1.2 edge bands and guard state). */
export type HostSurfaceProvider = SurfaceProvider & {
  noteCat?(cat: CatPosition | null): void;
  edgeBands?(): readonly ScreenEdgeBand[] | null;
  /**
   * Android floating cat (1.4.2): this host has no Win32 click guard, but its screen edges are safe
   * to climb (its window only takes the cat's own touches). With it the host hands edgeBands to the sim
   * without the guard, and tells it to climb the left edge in full too (`fullBothSides`) and how much
   * shorter the pause between edge visits is (`cooldownScale`, 0.05..1). Absent on Windows.
   */
  readonly guardlessScreenEdges?: { readonly fullBothSides: boolean; readonly cooldownScale: number };
  noteClickGuard?(state: ScreenEdgeGuard): void;
};

export interface HostOverlays {
  /** `extras` (Living Companion): the laser dot and reduced-motion flag for this frame; absent = neither. */
  render(out: SimOutput, simNow: number, hidden: boolean, extras?: OverlayRenderExtras): void;
  updateInteractivity(cursorPx: Point | null, blocked: boolean): void;
  isCursorOverCat(cursorPx: Point | null): boolean;
  readonly dragging: boolean;
  readonly pressed: boolean;
  readonly interactive: boolean;
  /** Press-path counters (diagnosis F8), shown in the host debug state when the overlays keep them. */
  interactionStats?(): OverlayInteractionStats;
  /**
   * After a resume or unlock, whether an OS event reported it or the host recovered it: forget press,
   * hover and clock state from before (OverlayManager.noteResume).
   */
  noteResume?(): void;
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
  /**
   * The OS's own lock state where it can tell (powerMonitor.getSystemIdleState(1) === 'locked'), else
   * null. Read on resume, every LOCK_RECHECK_MS while the host holds the session locked, and on input
   * after a lock; never polled while unlocked.
   */
  isSystemLocked?: () => boolean | null;
  /**
   * Living Companion: the OS reduced-motion preference (app.ts reads Electron's animation settings).
   * Re-read every few seconds; a missing or throwing source means false. The sim ORs it with the setting.
   */
  getReducedMotion?: () => boolean;
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
  clickGuard: { state: ScreenEdgeGuard['state']; reason: GuardReason | null; failClosed: number; rects: number; armed: boolean };
  /** Long-run counters of the click guard (time per reason, episodes, fail-closed polls). */
  clickGuardStats: ClickGuardStats;
  /** v1.2: edge bands handed to the sim on the last tick (null: none, the host has no guard). */
  edgeBands: number | null;
  /** Session lock and suspend bookkeeping: how often a lost unlock or resume was recovered. */
  lifecycle: { suspended: boolean; locks: number; lockRecoveries: number; resumeRecoveries: number };
  /** The overlays' press-path counters (null: the overlays keep none). */
  interaction: OverlayInteractionStats | null;
}

export interface CatHost {
  start(): void;
  stop(): void;
  readonly running: boolean;
  readonly paused: boolean;
  readonly hidden: boolean;
  readonly locked: boolean;
  /**
   * The host let go of a lock on the OS's word alone (the lock probe), with no unlock event or native
   * input since: interaction is back, perception stays paused (perceptionPausedFor).
   */
  readonly unlockUnconfirmed: boolean;
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
  /** Living Companion Laser Mode: session-only, off at every start, never persisted. */
  readonly laserActive: boolean;
  setLaserMode(on: boolean): void;
  /** Living Companion: the user paused world events for this session (session-only, never persisted). */
  readonly eventsPaused: boolean;
  setEventsPaused(paused: boolean): void;
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

/**
 * Whether perception must be paused for this host state (app.ts applies it on every status change and
 * on the unlock event): hidden, locked, or a lock the host let go of on the OS's word alone, not yet
 * confirmed by an unlock event or native input (docs/PRIVACY.md: never analyse an away session).
 */
export function perceptionPausedFor(h: Pick<CatHost, 'hidden' | 'locked' | 'unlockUnconfirmed'>): boolean {
  return h.hidden || h.locked || h.unlockUnconfirmed;
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
  let laserActive = false;
  let eventsPaused = false;
  let reducedMotion = false;
  let reducedMotionAt = -Infinity;
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
  /**
   * A bail-out guard episode: since when, what started it (see the header), and its grounded time
   * (ms grounded up to `at`, and whether the cat was grounded from `at` on).
   */
  let bail: { since: number; why: 'covered' | 'tookOff'; groundedMs: number; at: number; grounded: boolean } | null = null;
  /** A support whose unlisted spell already had its (capped) episode: no second one until it changes or is listed again. */
  let bailSpent: string | null = null;
  let guard: ScreenEdgeGuard = { state: input === null ? 'off' : 'idle', failClosed: 0 };
  let guardReason: GuardReason | null = null;
  let guardRects = 0;
  let armed = false;
  let guardNeededAt = Number.NEGATIVE_INFINITY;
  /** An overlay asked for the guard rects since the last poll started. */
  let guardAsked = false;
  /** The last obstacle list the source called fresh, and when: reused within OBSTACLE_STALE_GRACE_MS. */
  let lastFreshObstacles: { rects: readonly Rect[]; at: number } | null = null;
  /** The guard phase of the last tick and since when (time-in-guard accounting). */
  let phase: GuardReason | null = null;
  let phaseSince = 0;
  const guardStats: ClickGuardStats = {
    episodes: { band: 0, edgeFlight: 0, bailOut: 0 },
    timeInGuardMs: { band: 0, edgeFlight: 0, bailOut: 0 },
    longestEpisodeMs: 0,
    bailOutsCapped: 0,
    failClosedPolls: 0,
    staleGracePolls: 0,
    activePolls: 0,
  };
  const guardLogs = { episode: { at: Number.NEGATIVE_INFINITY, suppressed: 0 }, alert: { at: Number.NEGATIVE_INFINITY, suppressed: 0 } };

  // ---- session lock and suspend (diagnosis H5)
  let lockedAt = Number.NEGATIVE_INFINITY;
  let lockCheckAt = Number.POSITIVE_INFINITY;
  let lockInputProbeAt = Number.NEGATIVE_INFINITY;
  /** Native cursor and press count when the session locked or suspended: input past them means it is back. */
  let awayMark: { at: number; cursor: Point | null; presses: number | null } | null = null;
  let suspended = false;
  /** A lock cleared on the OS's word alone, not yet confirmed by an unlock event or native input. */
  let unlockUnconfirmed = false;
  let hardCapDrops = 0;
  /** The last cursor read from Win32 itself (null: none, or it failed: GetCursorPos fails while locked). */
  let nativeCursor: Point | null = null;
  const lifecycleStats = { locks: 0, lockRecoveries: 0, resumeRecoveries: 0 };

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
    if (l.orientation === 'ledge') {
      // A tab strip's window top (`land`) holds the cat too.
      const x0 = Math.min(l.x0, l.land?.x0 ?? l.x0);
      const x1 = Math.max(l.x1, l.land?.x1 ?? l.x1);
      return out.x < x0 - BAIL_SPAN_TOLERANCE_PX || out.x > x1 + BAIL_SPAN_TOLERANCE_PX;
    }
    return out.y < l.y0 - BAIL_SPAN_TOLERANCE_PX || out.y > l.y1 + BAIL_SPAN_TOLERANCE_PX;
  }

  /**
   * The Mover lets go of a ledge that vanished or lost its headroom at once, so its support reads as
   * air from that step on, and without a flight until the take-off (the bail-out crouch). A jump off
   * a surface that just went from the list is the same bail-out, the crouch fell between two ticks.
   */
  function leftLostSupport(prev: SimOutput | null, out: SimOutput): boolean {
    if (out.support.kind !== 'air' || !prev) return false;
    const s = prev.support;
    if (s.kind !== 'surface' || !WINDOW_SURFACE_KINDS.has(s.surfaceKind)) return false;
    return (s.orientation === 'ledge' && (out.jumpKind ?? null) === null) || supportLost(prev, lastSurfaces);
  }

  /**
   * Info line about the click guard, per channel at most one per GUARD_LOG_GAP_MS (the suppressed ones
   * are counted into the next): `episode` for every ended episode, `alert` for capped bail-outs and
   * fail-closed spells, so routine episodes never hide those.
   */
  function guardLog(channel: 'episode' | 'alert', msg: string, data: Record<string, unknown>, t: number): void {
    const c = guardLogs[channel];
    if (t - c.at < GUARD_LOG_GAP_MS) {
      c.suppressed++;
      return;
    }
    c.at = t;
    log.info(msg, c.suppressed > 0 ? { ...data, suppressed: c.suppressed } : data);
    c.suppressed = 0;
  }

  function startBail(t: number, why: 'covered' | 'tookOff', out: SimOutput): void {
    bail = { since: t, why, groundedMs: 0, at: t, grounded: out.support.kind !== 'air' };
  }

  /** Time the episode spent grounded up to `t` (the support of the last output holds between ticks). */
  function bailGroundedMs(t: number): number {
    if (bail === null) return 0;
    return bail.groundedMs + (bail.grounded ? Math.max(0, t - bail.at) : 0);
  }

  /** On each tick: books the time since the last one, then whether the cat is grounded from now on. */
  function noteBailSupport(t: number, out: SimOutput): void {
    if (bail === null) return;
    bail.groundedMs = bailGroundedMs(t);
    bail.at = t;
    bail.grounded = out.support.kind !== 'air';
  }

  function endBail(t: number, why: 'landed' | 'held' | 'capped'): void {
    if (bail === null) return;
    const data = { reason: 'bailOut', ms: Math.round(t - bail.since), groundedMs: Math.round(bailGroundedMs(t)), start: bail.why, end: why };
    bail = null;
    if (why === 'capped') guardStats.bailOutsCapped++;
    guardLog(why === 'capped' ? 'alert' : 'episode', 'click guard episode', data, t);
  }

  /**
   * The cap: BAIL_GUARD_MAX_MS grounded (time in the air never counts, so a long drop stays guarded
   * to its landing), BAIL_GUARD_CEILING_MS in all. It holds also between ticks (a stalled or slow tick
   * loop cannot stretch an episode).
   */
  function expireBail(t: number, out: SimOutput | null): void {
    if (bail === null || (bailGroundedMs(t) < BAIL_GUARD_MAX_MS && t - bail.since < BAIL_GUARD_CEILING_MS)) return;
    if (out && supportLost(out, lastSurfaces) && out.support.kind === 'surface') bailSpent = out.support.surfaceId;
    endBail(t, 'capped');
  }

  /** Why the guard holds for this output (null: it does not). */
  function phaseOf(out: SimOutput | null): GuardReason | null {
    if (!out || !out.visible || hidden) return null;
    if (bail !== null) return 'bailOut';
    if (edgeFlight) return 'edgeFlight';
    return out.support.kind === 'surface' && out.support.surfaceKind === SCREEN_EDGE_KIND ? 'band' : null;
  }

  /** Time-in-guard and episode accounting, and an info line per change (rate-limited). */
  function notePhase(next: GuardReason | null, t: number): void {
    if (next === phase) return;
    if (phase !== null) {
      const ms = Math.max(0, t - phaseSince);
      guardStats.timeInGuardMs[phase] += ms;
      guardStats.longestEpisodeMs = Math.max(guardStats.longestEpisodeMs, ms);
    }
    if (next !== null) guardStats.episodes[next]++;
    // Bail-out episodes are logged where they end (endBail, with the cause).
    if (phase !== null && phase !== 'bailOut') guardLog('episode', 'click guard episode', { reason: phase, ms: Math.round(t - phaseSince) }, t);
    phase = next;
    phaseSince = t;
  }

  /** A copy of the guard counters, the phase still running included. */
  function clickGuardStats(): ClickGuardStats {
    const time = { ...guardStats.timeInGuardMs };
    let longest = guardStats.longestEpisodeMs;
    if (phase !== null) {
      const open = Math.max(0, clock() - phaseSince);
      time[phase] += open;
      longest = Math.max(longest, open);
    }
    for (const k of Object.keys(time) as GuardReason[]) time[k] = Math.round(time[k]);
    return { ...guardStats, episodes: { ...guardStats.episodes }, timeInGuardMs: time, longestEpisodeMs: Math.round(longest) };
  }

  /** After each tick: edge flights and bail-outs start and end with the support (see the header). */
  function trackGuardPhases(prev: SimOutput | null, out: SimOutput, t: number): void {
    const airborne = out.support.kind === 'air';
    const k = out.jumpKind ?? null;
    const wasEdge = prev?.support.kind === 'surface' && prev.support.surfaceKind === SCREEN_EDGE_KIND;
    if (airborne) {
      if (wasEdge || ((k === 'leap' || k === 'wallJump') && out.visible && nearBand(out.boundsPx))) edgeFlight = true;
    } else edgeFlight = false;

    const lost = supportLost(out, lastSurfaces);
    const sid = out.support.kind === 'surface' ? out.support.surfaceId : null;
    if (bailSpent !== null && (!lost || sid !== bailSpent)) bailSpent = null;
    if (bail === null) {
      // The bail-out itself (the crouch on a vanished ledge, the take-off or drop off a lost support), or
      // the cover that the Mover answers with one within its grace.
      if (leftLostSupport(prev, out)) startBail(t, 'tookOff', out);
      else if (lost && sid !== bailSpent) startBail(t, 'covered', out);
    } else noteBailSupport(t, out);
    if (bail !== null) {
      // The landing: grounded on a support the list holds (the floor, a listed ledge, a wall caught
      // after the leap, which reports the wall as support from the take-off on), or a grab.
      if (!airborne && k === null && !lost) endBail(t, out.support.kind === 'held' ? 'held' : 'landed');
      else expireBail(t, out);
    }
    notePhase(phaseOf(out), t);
  }

  function setGuard(state: ScreenEdgeGuard['state'], reason: GuardReason | null): void {
    guardReason = reason;
    if (state === guard.state) return;
    guard = { state, failClosed: guard.failClosed + (state === 'failClosed' ? 1 : 0) };
    if (state === 'failClosed') guardLog('alert', 'click guard failed closed (obstacle source stale or failing)', { reason, failClosed: guard.failClosed }, clock());
    attempt(() => surfaces?.noteClickGuard?.(guard), 'click guard state');
  }

  function setArmed(next: boolean, t: number): void {
    if (input === null) return;
    if (next) guardNeededAt = t;
    // Disarm only after a quiet spell, so a cat moving along the band does not churn the hooks.
    const want = next || t - guardNeededAt < GUARD_DISARM_AFTER_MS;
    if (want === armed) return;
    armed = want;
    // Unhooked, the source watched no events: a list read before is no basis for the stale grace.
    if (!want) lastFreshObstacles = null;
    attempt(() => input.setObstacleWatch(want), 'obstacle watch');
  }

  /** No overlay asked on this poll (the cursor is off the cat, or it may not take the mouse): nothing to read or hook. */
  function restGuard(t: number): void {
    if (input === null) return;
    setArmed(false, t);
    setGuard('idle', null);
    guardRects = 0;
  }

  /** The T8 guard (see the header). Never throws: every failure fails closed. */
  function clickGuardRects(): readonly Rect[] {
    const t = clock();
    guardAsked = true;
    if (input === null) {
      guardRects = 0;
      return NO_GUARD_RECTS;
    }
    const out = lastOutput;
    expireBail(t, out);
    const reason = phaseOf(out);
    if (!out || reason === null) {
      restGuard(t);
      return NO_GUARD_RECTS;
    }
    setArmed(true, t);
    let obstacles: { rects: readonly Rect[]; fresh: boolean } | null = null;
    try {
      obstacles = input.clickObstaclesPx();
    } catch (err) {
      log.warn('click-guard obstacles failed', { error: err });
    }
    let list: readonly Rect[];
    if (obstacles !== null && obstacles.fresh) {
      lastFreshObstacles = { rects: obstacles.rects, at: t };
      list = obstacles.rects;
      guardStats.activePolls++;
    } else if (obstacles !== null && lastFreshObstacles !== null && t - lastFreshObstacles.at <= OBSTACLE_STALE_GRACE_MS) {
      // Momentarily stale (WinEvent chatter between two enumerations): the last fresh cut-outs, at most
      // OBSTACLE_STALE_GRACE_MS old, the age the ADR allows a cache.
      list = lastFreshObstacles.rects;
      guardStats.staleGracePolls++;
    } else {
      // Fail closed: the whole cat is click-through until the obstacle list is current again. Not just
      // its bounds: the renderer's hit rects reach past them at large scales and sizes.
      guardStats.failClosedPolls++;
      setGuard('failClosed', reason);
      guardRects = 1;
      return EVERYWHERE;
    }
    // 8 DIP at the largest scale of the displays the window touches.
    const displays = opts.display.world.displays;
    const grown = list.map((r) => {
      let scale = 1;
      for (const d of displays) if (rectGap(d.boundsPx, r) === 0 && d.scaleFactor > scale) scale = d.scaleFactor;
      return growRect(r, Math.ceil(GUARD_OBSTACLE_MARGIN_DIP * scale));
    });
    // The presence rect holds all the renderer can draw, so every hit rect: an obstacle that misses
    // the hit rects after all is a plain cut-out and takes nothing away.
    const largestScale = displays.reduce((m, d) => Math.max(m, d.scaleFactor), 1);
    const rects = wallGuardRects(presenceRectPx(out, opts.getSettings().appearance, largestScale), grown);
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
    nativeCursor = p;
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
    if (evs.length <= MAX_EVENTS_PER_TICK) return evs;
    // Over the cap: the newest window, surface, activity and perception events go first. A pointer,
    // lifecycle, system or command event is never dropped (a lost dragEnd leaves the cat held, a lost
    // quit request hangs the quit), even if that leaves more than MAX_EVENTS_PER_TICK for this tick.
    let excess = evs.length - MAX_EVENTS_PER_TICK;
    const kept: SimEvent[] = [];
    for (let i = evs.length - 1; i >= 0; i--) {
      const ev = evs[i] as SimEvent;
      if (excess > 0 && !isPriorityEvent(ev)) {
        excess--;
        continue;
      }
      kept.push(ev);
    }
    kept.reverse();
    const count = evs.length - kept.length;
    droppedEvents += count;
    if (count > 0) log.debug('dropping excess events', { count });
    return kept;
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
          if (perception && !hidden && !locked && !unlockUnconfirmed) attempt(() => perception.request(r.reason, r.focus), 'perception request');
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

  /** The OS reduced-motion preference, cached; a source that is absent or throws means false. */
  function osReducedMotion(nowReal: number): boolean {
    if (!opts.getReducedMotion) return false;
    if (nowReal - reducedMotionAt >= REDUCED_MOTION_REFRESH_MS) {
      reducedMotionAt = nowReal;
      reducedMotion = safe(() => opts.getReducedMotion?.() === true, false, 'reduced motion check');
    }
    return reducedMotion;
  }

  /** Displays the laser dot never draws over: a fullscreen app in front, unless the cat ignores those. */
  function laserQuietIds(): readonly string[] {
    return opts.getSettings().behavior.fullscreenBehavior === 'ignore' ? [] : fullscreenIds;
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
    // Android floating cat (1.4.2): a host with no Win32 click guard may declare guardless screen edges
    // (nothing underneath can be covered by a click: its window only takes the cat's own touches).
    // Windows never sets it, so its rule above is unchanged.
    const guardless = surfaces?.guardlessScreenEdges ?? null;
    edgeBands = (guardless !== null || (input !== null && input.available)) && surfaces?.edgeBands ? safe(() => surfaces.edgeBands?.() ?? null, null, 'edge bands') : null;
    const foreground = safe(() => tracker.getForeground(), null, 'foreground');
    const wall = wallClock();
    const v12: Partial<SimEnv> = {
      ...(buttons !== null ? { pointerButtonDown: buttons.down, pointerButtonPresses: buttons.presses } : {}),
      ...(cursor !== null && Number.isFinite(cursorMovedAt) ? { cursorIdleMs: Math.max(0, nowReal - cursorMovedAt) } : {}),
      ...(edgeBands !== null ? { edgeBands } : {}),
      ...(edgeBands !== null && guardless !== null ? { edgeFullBothSides: guardless.fullBothSides, edgeCooldownScale: guardless.cooldownScale } : {}),
      // Living Companion: only when set, so an ordinary tick's environment is unchanged.
      ...(laserActive ? { laserMode: true } : {}),
      ...(osReducedMotion(nowReal) ? { reducedMotion: true } : {}),
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
    attempt(() => trackGuardPhases(lastOutput, out, nowReal), 'click guard phases');
    lastOutput = out;
    // The cursor is handed on for the laser dot only while Laser Mode is on (never stored or logged).
    const extras: OverlayRenderExtras | undefined =
      (laserActive && !paused) || reducedMotion
        ? {
            ...(laserActive && !paused ? { laser: cursor ? { x: cursor.x, y: cursor.y } : null, laserQuietDisplayIds: laserQuietIds() } : {}),
            ...(reducedMotion ? { reducedMotion: true } : {}),
          }
        : undefined;
    if (extras) overlays.render(out, simNow, hidden, extras);
    else overlays.render(out, simNow, hidden);
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

  // ---- session lock and suspend (diagnosis H5): a lost unlock or resume event must not latch

  /** The OS's own lock state (null: it cannot tell, or asking failed). */
  function systemLocked(): boolean | null {
    if (!opts.isSystemLocked) return null;
    try {
      const v = opts.isSystemLocked();
      return typeof v === 'boolean' ? v : null;
    } catch (err) {
      log.warn('lock state failed', { error: err });
      return null;
    }
  }

  function markAway(t: number): void {
    awayMark = { at: t, cursor: nativeCursor, presses: buttons?.presses ?? null };
  }

  /**
   * Native input since the mark: the Win32 cursor moved or a button went down. Neither is seen from
   * a locked or sleeping session: GetCursorPos fails off the input desktop (the fallback cursor does
   * not count) and GetAsyncKeyState reports no presses there.
   */
  function inputSinceMark(): boolean {
    const m = awayMark;
    if (m === null) return false;
    const c = nativeCursor;
    const scale = c ? displayScale(safe(() => opts.display.displayAt(c), null, 'display at cursor')) : 1;
    const moved = c !== null && (m.cursor === null || Math.hypot(c.x - m.cursor.x, c.y - m.cursor.y) > CURSOR_IDLE_MOVE_DIP * scale);
    const pressed = buttons !== null && m.presses !== null && buttons.presses > m.presses;
    return moved || pressed;
  }

  function setLocked(t: number, why: string): void {
    if (!locked) lifecycleStats.locks++;
    locked = true;
    unlockUnconfirmed = false;
    lockedAt = t;
    lockCheckAt = t + LOCK_RECHECK_MS;
    markAway(t);
    log.info('session locked', { why });
  }

  /**
   * A resume or unlock, seen or recovered: the overlays forget press, hover and clock state from before.
   * A press in progress is the user's first input after the resume (a recovered resume is detected
   * from that very input): it is never cancelled; the reset runs on the first poll after it ends.
   */
  let overlayResumePending = false;
  function overlaysResumed(): void {
    if (!overlays.noteResume) return;
    if (overlays.pressed) {
      overlayResumePending = true;
      return;
    }
    overlayResumePending = false;
    attempt(() => overlays.noteResume?.(), 'overlay resume');
  }

  /** The machine evidently runs: tell the sim the resume it missed. True when one was recovered (the caller resets the overlays). */
  function recoverResume(why: string): boolean {
    if (!suspended) return false;
    suspended = false;
    lifecycleStats.resumeRecoveries++;
    log.info('resume recovered without a resume event', { why });
    enqueue({ type: 'system.resume' });
    return true;
  }

  /**
   * The session is unlocked although no unlock event came: the host and the sim let go of the lock.
   * `confirmed`: native input showed the user is back. Without it (the OS's word alone: the periodic
   * probe, or the state read on resume) interaction comes back but perception stays paused until an
   * unlock event or native input (perceptionPausedFor; the probe may misread a disconnected session).
   */
  function clearLock(t: number, why: string, confirmed: boolean): void {
    if (!locked) return;
    locked = false;
    unlockUnconfirmed = !confirmed;
    lockCheckAt = Number.POSITIVE_INFINITY;
    lifecycleStats.lockRecoveries++;
    log.info('session lock cleared without an unlock event', { why, confirmed, lockedForS: Math.round((t - lockedAt) / 1000) });
    recoverResume(why);
    // Unconfirmed, the mark stays: native input past it confirms the unlock.
    if (confirmed) awayMark = null;
    enqueue({ type: 'system.unlock' });
    fullscreenAt = Number.NEGATIVE_INFINITY;
    overlaysResumed();
    statusChanged();
    nudge();
  }

  /** An unlock the host cleared on the OS's word is confirmed (unlock event or native input): perception may run again. */
  function confirmUnlock(why: string): void {
    if (!unlockUnconfirmed) return;
    unlockUnconfirmed = false;
    log.info('unlock confirmed', { why });
    statusChanged();
  }

  /**
   * On the cursor poll while locked, suspended or after an unconfirmed unlock: re-check the lock now
   * and then, and on native input.
   */
  function checkAway(t: number): void {
    const m = awayMark;
    if (m === null) return;
    // The lock screen or sleep takes a moment to come up: input until then proves nothing.
    if (t - m.at < LOCK_INPUT_SETTLE_MS) {
      markAway(m.at);
      return;
    }
    const seen = inputSinceMark();
    if (!locked) {
      if (seen) {
        if (recoverResume('input after suspend')) overlaysResumed();
        confirmUnlock('input after unlock');
      }
      if (!suspended && !unlockUnconfirmed) awayMark = null;
      return;
    }
    if (seen && t - lockInputProbeAt >= LOCK_INPUT_PROBE_GAP_MS) {
      lockInputProbeAt = t;
      const os = systemLocked();
      if (os !== true) {
        clearLock(t, os === false ? 'input after lock, system reports unlocked' : 'input after lock', true);
        return;
      }
      // Still locked by the OS's own account (it decides when it can tell): new input is needed next time.
      markAway(m.at);
    }
    if (t >= lockCheckAt) {
      lockCheckAt = t + LOCK_RECHECK_MS;
      if (systemLocked() === false) clearLock(t, 'system reports unlocked', false);
    }
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
      if (locked || suspended || unlockUnconfirmed) attempt(() => checkAway(t), 'lock check');
      if (overlayResumePending && !overlays.pressed) overlaysResumed();
      if (t >= cursorDueAt) {
        const blocked = hidden || paused || locked || !opts.getSettings().interaction.enabled;
        guardAsked = false;
        overlays.updateInteractivity(cursor, blocked);
        if (!guardAsked) restGuard(t);
        const adaptive = hidden
          ? HIDDEN_POLL_MS
          : suggestPollIntervalMs({
              cursor,
              catBounds: lastOutput?.boundsPx ?? null,
              interactive: overlays.interactive,
              dragging: overlays.dragging || overlays.pressed,
              catAsleep: lastOutput ? ASLEEP.has(lastOutput.state) : false,
              visible: lastOutput?.visible ?? false,
            });
        // Laser Mode follows the cursor closely; the adaptive rate returns when it ends.
        const delay = laserActive && !hidden ? Math.min(adaptive, DEFAULT_POLL_INTERVALS.fastMs) : adaptive;
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
    if (pending.length <= MAX_PENDING_EVENTS) return;
    // The oldest non-priority events go first; pointer, lifecycle, system and command events stay.
    const before = pending.length;
    let excess = before - MAX_PENDING_EVENTS;
    pending = pending.filter((e) => {
      if (excess > 0 && !isPriorityEvent(e)) {
        excess--;
        return false;
      }
      return true;
    });
    if (pending.length > PENDING_HARD_CAP) {
      // Only a host that does not tick gets here: a memory bound, not a policy.
      pending.splice(0, pending.length - PENDING_HARD_CAP);
      if (hardCapDrops++ % 1000 === 0) log.warn('event queue at its hard cap (the host is not ticking)', { cap: PENDING_HARD_CAP });
    }
    droppedEvents += before - pending.length;
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
    get unlockUnconfirmed() {
      return unlockUnconfirmed;
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
      const t = clock();
      enqueue({ type });
      switch (kind) {
        case 'lock':
          setLocked(t, 'lock event');
          break;
        case 'unlock':
          if (locked) log.info('session unlocked', { lockedForS: Math.round((t - lockedAt) / 1000) });
          locked = false;
          // The real unlock event: perception may run again (app.ts re-evaluates it after this).
          unlockUnconfirmed = false;
          lockCheckAt = Number.POSITIVE_INFINITY;
          // An unlocked session runs: a resume event that never came is made up for.
          recoverResume('unlock event');
          awayMark = null;
          overlaysResumed();
          break;
        case 'suspend':
          suspended = true;
          log.info('system suspending');
          markAway(t);
          break;
        case 'resume': {
          suspended = false;
          const recoveriesBefore = lifecycleStats.lockRecoveries;
          // Re-derived (diagnosis H5): a lock that happened unseen holds, one that ended unseen goes.
          const os = systemLocked();
          log.info('system resumed', { locked, systemLocked: os });
          if (os === true && !locked) {
            setLocked(t, 'system reports locked on resume');
            enqueue({ type: 'system.lock' });
            statusChanged();
          } else if (os === false && locked) {
            // Resets the overlays too.
            clearLock(t, 'system reports unlocked on resume', false);
          } else if (locked) {
            lockCheckAt = Math.min(lockCheckAt, t + LOCK_RECHECK_MS);
          }
          if (!locked && !unlockUnconfirmed) awayMark = null;
          // Clock offsets and any press or hover from before the sleep are stale now (diagnosis F3/F5).
          if (lifecycleStats.lockRecoveries === recoveriesBefore) overlaysResumed();
          break;
        }
      }
      if (kind === 'resume' || kind === 'unlock') fullscreenAt = -Infinity;
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
    get laserActive() {
      return laserActive;
    },
    setLaserMode(on) {
      if (laserActive === on) return;
      laserActive = on;
      log.info(on ? 'laser mode on (session only)' : 'laser mode off');
      // The poll timer was set at the slower rate: re-arm it now so the fast rate starts at once.
      if (running && pollTimer !== null) {
        timers.clearTimeout(pollTimer);
        pollTimer = null;
        cursorDueAt = -Infinity;
        poll();
      }
      statusChanged();
      // The next tick draws the dot, or sends the frame without it.
      nudge();
    },
    get eventsPaused() {
      return eventsPaused;
    },
    setEventsPaused(p) {
      if (eventsPaused === p) return;
      eventsPaused = p;
      log.info(p ? 'world events paused (session only)' : 'world events resumed');
      enqueue({ type: p ? 'command.eventsPause' : 'command.eventsResume' });
      statusChanged();
      nudge();
    },
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
      clickGuardStats: clickGuardStats(),
      edgeBands: edgeBands === null ? null : edgeBands.length,
      lifecycle: { suspended, ...lifecycleStats },
      interaction: overlays.interactionStats ? safe(() => overlays.interactionStats?.() ?? null, null, 'interaction stats') : null,
    }),
  };
}
