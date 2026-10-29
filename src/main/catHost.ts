// Hosts the cat simulation: a setTimeout-driven loop whose rate follows the sim's
// own nextTickMs, gathering sensor snapshots and events every tick and
// dispatching the output to the overlays. Cursor sampling for click-through runs
// on a separate adaptive timer so interaction stays responsive while the sim ticks
// slowly (asleep, hidden). The same timer drives the taskbar tracker's adaptive
// sampling (it returns its own next delay), so no extra timer or busy loop exists.
// Environment surfaces (v1.1) are read once per host tick for env.surfaces; the surface
// the cat rides is re-read live through env.getSurface.
import { distanceToRect } from '../core/display/displayMath';
import { suggestPollIntervalMs } from '../core/interaction/clickThrough';
import type { BehaviorState } from '../shared/cat';
import type { Point, Rect } from '../shared/geometry';
import type { Settings } from '../shared/settings';
import type { CatSim, SimEnv, SimEvent, SimOutput, SimRequest } from '../shared/sim';
import type { Surface } from '../shared/surfaces';
import type { WorldGeometry } from '../shared/world';
import { simWorld } from '../core/display/simWorld';
import type { ActivityMonitor, DisplayService, Logger, PerceptionService, SurfaceProvider, TaskbarTracker, Win32Api, WindowTracker } from './contracts';
import type { CatPosition } from './surfaces';

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
const ASLEEP: ReadonlySet<BehaviorState> = new Set<BehaviorState>(['sleeping', 'fallingAsleep']);
const NO_SURFACES: readonly Surface[] = Object.freeze([]);

/** The surface provider as the host uses it (noteCat is the provider's host-feedback extra). */
export type HostSurfaceProvider = SurfaceProvider & { noteCat?(cat: CatPosition | null): void };

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
  debug(): CatHostDebug;
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

  const getWindowRect = (id: string): Rect | null => {
    try {
      return tracker.getWindowRect(id);
    } catch {
      return null;
    }
  };

  /** Live geometry of one surface (the sim calls it for the surface it rides). */
  const getSurface = (id: string): Surface | null => {
    if (!surfaces) return null;
    try {
      return surfaces.getSurface(id, clock());
    } catch {
      return null;
    }
  };

  function catPosition(): CatPosition | null {
    const out = lastOutput;
    if (!out || hidden) return null;
    return { x: out.x, y: out.y, surfaceId: out.support.kind === 'surface' ? out.support.surfaceId : null };
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
   * The cat rides a taskbar, or is within CAT_NEAR_TASKBAR_DIP of one that can move (auto-hide
   * or sliding). A static docked taskbar is always next to a floor-standing cat, and fast
   * sampling it would only burn timer wake-ups.
   */
  function catNearTaskbar(tb: TaskbarTracker): boolean {
    const out = lastOutput;
    if (!out || !out.visible || hidden) return false;
    if (out.support.kind === 'surface' && out.support.surfaceKind === 'taskbar') return true;
    const limit = CAT_NEAR_TASKBAR_DIP * displayScale(out.displayId);
    const p = { x: out.x, y: out.y };
    for (const s of tb.taskbars()) {
      if (!s.autoHide && s.phase !== 'showing' && s.phase !== 'hiding') continue;
      if (distanceToRect(s.dockedRect, p) <= limit) return true;
    }
    return false;
  }

  function sampleTaskbars(t: number, cursor: Point | null): void {
    if (!taskbars || !taskbars.available) {
      taskbarDelayMs = null;
      taskbarDueAt = t + TASKBAR_RECHECK_MS;
      return;
    }
    let delay: number;
    try {
      delay = taskbars.sample(t, cursor, catNearTaskbar(taskbars));
      taskbarSamples++;
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
    attempt(() => activity.sample(nowReal, cursor), 'activity sample');
    const events = collectEvents();
    const world = opts.display.world;
    if (nowReal - fullscreenAt >= FULLSCREEN_REFRESH_MS) {
      fullscreenIds = safe(() => tracker.getFullscreenDisplayIds(world), [], 'fullscreen check');
      fullscreenAt = nowReal;
    }
    const platforms = safe(() => tracker.getPlatforms(PLATFORM_MAX_AGE_MS), [], 'platforms');
    const envSurfaces = readSurfaces(nowReal);
    const foreground = safe(() => tracker.getForeground(), null, 'foreground');
    const wall = wallClock();
    const base: Omit<SimEnv, 'now' | 'dt'> = {
      cursor: cursor ? { x: cursor.x, y: cursor.y, speed: activity.cursorSpeed } : null,
      cursorOverCat: overlays.isCursorOverCat(cursor),
      userIdleMs: activity.idleMs,
      typing: activity.typing,
      typingIntensity: activity.typingIntensity,
      foreground,
      // Deprecated v1 fields, kept populated until the sim reads surfaces only.
      platforms,
      getWindowRect,
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
    if (t >= taskbarDueAt) sampleTaskbars(t, cursor);
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
    }),
  };
}
