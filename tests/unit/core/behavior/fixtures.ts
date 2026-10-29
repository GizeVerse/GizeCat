// Deterministic test fixtures for the cat simulation.
import type { BehaviorState } from '../../../../src/shared/cat';
import type { PersistedCat } from '../../../../src/shared/catState';
import type { Rect } from '../../../../src/shared/geometry';
import type { Settings } from '../../../../src/shared/settings';
import { defaultSettings } from '../../../../src/shared/settings';
import type { SimEnv, SimEvent, SimOutput, SimSupport } from '../../../../src/shared/sim';
import type { LedgeSurface, Surface, SurfaceKind, TaskbarEdge, WallSurface } from '../../../../src/shared/surfaces';
import type { DisplayGeometry, Platform, WorldGeometry } from '../../../../src/shared/world';
import { createInstrumentedCatSim, mulberry32 } from '../../../../src/core/behavior';
import type { DecisionView } from '../../../../src/core/behavior/decide';
import { scoreCandidates } from '../../../../src/core/behavior/decide';
import type { TransitionRecord } from '../../../../src/core/behavior';
import type { CatSimImpl } from '../../../../src/core/behavior/sim';

export function display(id: string, x: number, y: number, w: number, h: number, opts: { scale?: number; primary?: boolean; taskbar?: number } = {}): DisplayGeometry {
  const scale = opts.scale ?? 1;
  const taskbar = opts.taskbar ?? 0;
  const boundsPx = { x, y, width: w, height: h };
  const workAreaPx = { x, y, width: w, height: h - taskbar };
  const dip = (r: Rect): Rect => ({ x: r.x / scale, y: r.y / scale, width: r.width / scale, height: r.height / scale });
  return { id, primary: opts.primary ?? false, scaleFactor: scale, boundsPx, workAreaPx, boundsDip: dip(boundsPx), workAreaDip: dip(workAreaPx) };
}

export function world(...displays: DisplayGeometry[]): WorldGeometry {
  return { version: 1, displays };
}

/** One 1920x1080 primary display with a 40 px taskbar (floor at y = 1040). */
export const SINGLE = world(display('1', 0, 0, 1920, 1080, { primary: true, taskbar: 40 }));

/**
 * Primary 1920x1080 @1x (taskbar, floor 1040) and a secondary on the LEFT at
 * negative coordinates, 2560x1440 @1.5x whose floor is lower (y = 1260).
 */
export const DUAL_MIXED = world(
  display('1', 0, 0, 1920, 1080, { primary: true, taskbar: 40 }),
  display('2', -2560, -180, 2560, 1440, { scale: 1.5 }),
);

/** Two identical side-by-side displays whose floors meet (walkable across). */
export const DUAL_FLAT = world(display('1', 0, 0, 1920, 1080, { primary: true, taskbar: 40 }), display('2', 1920, 0, 1920, 1080, { taskbar: 40 }));

export interface EnvOverrides extends Partial<Omit<SimEnv, 'now' | 'dt'>> {
  /** Plain app windows: the fixture's provider turns them into window-top ledges and side walls. */
  windows?: Record<string, Rect | null>;
  /** More surfaces (taskbars, tab strips) listed after the windows' and returned by getSurface. */
  extraSurfaces?: Surface[];
  /** Window sides are offered (the host only lists them while climbing is allowed). Default true. */
  walls?: boolean;
}

export class Harness {
  readonly sim: CatSimImpl;
  readonly transitions: TransitionRecord[] = [];
  readonly outputs: SimOutput[] = [];
  now: number;
  env: EnvOverrides = {};
  keepOutputs = false;
  private worldGeometry: WorldGeometry;

  constructor(opts: { seed?: number; settings?: Settings; world?: WorldGeometry; persisted?: PersistedCat | null; now?: number; wall?: number } = {}) {
    this.now = opts.now ?? 1000;
    this.worldGeometry = opts.world ?? SINGLE;
    let wall = opts.wall ?? 1_800_000_000_000;
    this.sim = createInstrumentedCatSim(
      {
        persisted: opts.persisted ?? null,
        settings: opts.settings ?? defaultSettings(),
        world: this.worldGeometry,
        now: this.now,
        random: mulberry32(opts.seed ?? 1),
        wallClock: () => (wall += 1),
      },
      { onTransition: (r) => this.transitions.push(r) },
    );
  }

  get world(): WorldGeometry {
    return this.worldGeometry;
  }

  setWorld(w: WorldGeometry): void {
    this.worldGeometry = w;
    this.sim.setWorld(w);
  }

  buildEnv(dt: number): SimEnv {
    const e = this.env;
    const windows = e.windows ?? {};
    const surfaces = e.surfaces ?? [...surfacesFromWindows(windows, this.worldGeometry, { walls: e.walls ?? true, now: this.now }), ...(e.extraSurfaces ?? [])];
    const byId = new Map(surfaces.map((s) => [s.id, s] as const));
    return {
      now: this.now,
      dt,
      cursor: e.cursor ?? null,
      cursorOverCat: e.cursorOverCat ?? false,
      userIdleMs: e.userIdleMs ?? 0,
      typing: e.typing ?? false,
      typingIntensity: e.typingIntensity ?? 0,
      foreground: e.foreground ?? null,
      surfaces,
      getSurface: e.getSurface ?? ((id: string) => byId.get(id) ?? null),
      fullscreenDisplayIds: e.fullscreenDisplayIds ?? [],
      paused: e.paused ?? false,
      hidden: e.hidden ?? false,
      dragCursor: e.dragCursor ?? null,
      localHour: e.localHour ?? 14,
    };
  }

  /** Ticks that delivered events (sim time and the events), for tests that attribute reactions to events. */
  readonly delivered: { at: number; events: readonly SimEvent[] }[] = [];

  step(events: readonly SimEvent[] = [], dt = 33): SimOutput {
    this.now += dt;
    if (events.length > 0) this.delivered.push({ at: this.now, events });
    const out = this.sim.tick(this.buildEnv(dt), events);
    if (this.keepOutputs) this.outputs.push(out);
    this.last = out;
    return out;
  }

  last: SimOutput | null = null;

  /** Runs for `ms` of sim time; `each` may return events and is called before every tick. */
  run(ms: number, dt = 33, each?: (h: Harness, i: number) => readonly SimEvent[] | void): SimOutput {
    const end = this.now + ms;
    let i = 0;
    let out = this.last ?? this.step([], 0);
    while (this.now < end) {
      const ev = each?.(this, i++) ?? [];
      out = this.step(ev, dt);
    }
    return out;
  }

  /** Runs until `pred` holds or `ms` elapses; returns whether it held. */
  runUntil(pred: (o: SimOutput) => boolean, ms: number, dt = 33): boolean {
    const end = this.now + ms;
    while (this.now < end) {
      if (pred(this.step([], dt))) return true;
    }
    return false;
  }

  statesSeen(): Set<BehaviorState> {
    return new Set(this.transitions.map((t) => t.to));
  }
}

/** Every launch starts with a short nap and a wake-up stretch (at most ~4.1 s); after this the cat is up. */
export const WAKE_MS = 5000;

/** Calls the cat. A call it ignores is repeated: it never ignores two in a row. */
export function callCat(h: Harness, at: { x: number; y: number }, dt = 33): SimOutput {
  const before = commandsIgnored(h);
  h.step([{ type: 'command.callCat', at }], dt);
  if (commandsIgnored(h) > before) h.step([{ type: 'command.callCat', at }], dt);
  return h.last as SimOutput;
}

/** Calls and play commands the cat has ignored so far (diagnostics counter). */
export function commandsIgnored(h: Harness): number {
  return h.sim.debugInfo().commandsIgnored as number;
}

/** Window rects -> walkable top edges (no occlusion). Deprecated v1 env field. */
export function platformsFrom(windows: Record<string, Rect | null>): Platform[] {
  const out: Platform[] = [];
  for (const [id, r] of Object.entries(windows)) if (r) out.push({ windowId: id, y: r.y, x0: r.x, x1: r.x + r.width });
  return out;
}

export const topId = (windowId: string): string => `windowTop:${windowId}`;
export const sideId = (windowId: string, side: 'left' | 'right'): string => `windowSide:${windowId}:${side}`;
export const stripId = (windowId: string): string => `tabStrip:${windowId}`;
export const taskbarId = (hwnd: string): string => `taskbar:${hwnd}`;

const BASE = { phase: 'stable' as const, vx: 0, vy: 0, confidence: 1, validatedAt: 0, excluded: false };

export function ledge(id: string, kind: Exclude<SurfaceKind, 'windowSide'>, ownerId: string, y: number, x0: number, x1: number, extra: Partial<LedgeSurface> = {}): LedgeSurface {
  return { ...BASE, id, kind, ownerId, displayId: null, orientation: 'ledge', y, x0, x1, rest: null, focusX: null, ...extra };
}

export function wall(windowId: string, side: 'left' | 'right', x: number, y0: number, y1: number, extra: Partial<WallSurface> = {}): WallSurface {
  return { ...BASE, id: sideId(windowId, side), kind: 'windowSide', ownerId: windowId, displayId: null, orientation: 'wall', x, y0, y1, side, topLedgeId: topId(windowId), ...extra };
}

/** A docked taskbar ledge spanning one display: feet one pixel above its top edge. */
export function taskbar(hwnd: string, d: DisplayGeometry, top: number, extra: Partial<LedgeSurface> & { edge?: TaskbarEdge } = {}): LedgeSurface {
  return ledge(taskbarId(hwnd), 'taskbar', hwnd, top - 1, d.boundsPx.x, d.boundsPx.x + d.boundsPx.width, { displayId: d.id, edge: 'bottom', ...extra });
}

/** A browser tab strip on top of a window, with a resting span and the active tab's centre. */
export function tabStrip(windowId: string, y: number, x0: number, x1: number, rest: { x0: number; x1: number } | null, focusX: number | null, extra: Partial<LedgeSurface> = {}): LedgeSurface {
  return ledge(stripId(windowId), 'tabStrip', windowId, y, x0, x1, { rest, focusX, ...extra });
}

/**
 * What the host's surface provider reports for plain app windows (no occlusion): each
 * window's top edge and, while climbing is allowed, its two sides (pulling up onto the top).
 * A window covering a whole work area (maximized) offers nothing.
 */
export function surfacesFromWindows(windows: Record<string, Rect | null>, geometry: WorldGeometry, opts: { walls?: boolean; now?: number } = {}): Surface[] {
  const out: Surface[] = [];
  for (const [id, r] of Object.entries(windows)) {
    if (!r) continue;
    const maximized = geometry.displays.some((d) => r.x <= d.workAreaPx.x && r.y <= d.workAreaPx.y && r.x + r.width >= d.workAreaPx.x + d.workAreaPx.width && r.y + r.height >= d.workAreaPx.y + d.workAreaPx.height);
    if (maximized) continue;
    const validatedAt = opts.now ?? 0;
    out.push(ledge(topId(id), 'windowTop', id, r.y, r.x, r.x + r.width, { validatedAt }));
    if (opts.walls ?? true) {
      out.push(wall(id, 'left', r.x, r.y, r.y + r.height, { validatedAt }));
      out.push(wall(id, 'right', r.x + r.width, r.y, r.y + r.height, { validatedAt }));
    }
  }
  return out;
}

/** On some window surface (a window top, a tab strip or a window side). */
export function onWindowSurface(s: SimSupport): boolean {
  return s.kind === 'surface' && s.surfaceKind !== 'taskbar';
}

/** Standing on a window's top edge. */
export function onWindowTop(s: SimSupport, windowId?: string): boolean {
  return s.kind === 'surface' && s.surfaceKind === 'windowTop' && (windowId === undefined || s.surfaceId === topId(windowId));
}

export function settingsWith(patch: { [K in keyof Settings]?: Partial<Settings[K]> }): Settings {
  const s = defaultSettings();
  for (const [k, v] of Object.entries(patch)) Object.assign((s as unknown as Record<string, object>)[k] as object, v);
  return s;
}

export function insideAnyWorkArea(w: WorldGeometry, x: number, y: number, tol = 1): boolean {
  return w.displays.some((d) => x >= d.workAreaPx.x - tol && x <= d.workAreaPx.x + d.workAreaPx.width + tol && y >= d.workAreaPx.y - tol && y <= d.workAreaPx.y + d.workAreaPx.height + tol);
}

/** A decision context for scoring tests: an awake, energetic cat with a pointer and a foreground window around. */
export function decisionView(o: Partial<DecisionView> = {}): DecisionView {
  return {
    traits: { playfulness: 0.6, curiosity: 0.6, affection: 0.6, laziness: 0.3, confidence: 0.5, energyLevel: 0.6 },
    stats: { energy: 0.9, boredom: 0.5, bond: 0.5, annoyance: 0, fear: 0 },
    prefs: { cursorPlayAcceptance: 0.5, attentionAcceptance: 0.5, petRatePerHour: 0 },
    behavior: { ...defaultSettings().behavior, autonomy: 1, attentionSeeking: 1 },
    disabled: new Set(),
    localHour: 14,
    typing: false,
    userIdleMs: 0,
    busySwitching: false,
    mediaForeground: false,
    screen: null,
    recentRough: 0,
    darkBias: 0,
    quietMs: 2 * 3600_000,
    awakeMs: 0,
    cursor: { point: { x: 1000, y: 1000 }, speedDip: 400, distBodyLengths: 3, reachable: true },
    foreground: { center: { x: 900, y: 500 }, distBodyLengths: 2 },
    favoriteSpot: null,
    perchTarget: null,
    wanderTarget: { x: 1200, y: 1040 },
    cornerTarget: null,
    typingIntensity: 0,
    standingOn: 'floor',
    climbTarget: null,
    tabStripTarget: null,
    edgeLook: null,
    surpriseReady: false,
    recentStates: [],
    current: 'idle',
    isCoolingDown: () => false,
    ...o,
  };
}

/** Summed utility of the candidates for `state` (and `variant`, when given). */
export function scoreOf(v: DecisionView, state: BehaviorState, variant: string | null = null): number {
  return scoreCandidates(v)
    .filter((c) => c.item.state === state && (variant === null || c.item.variant === variant))
    .reduce((a, c) => a + c.score, 0);
}
