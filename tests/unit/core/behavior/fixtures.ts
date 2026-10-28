// Deterministic test fixtures for the cat simulation.
import type { BehaviorState } from '../../../../src/shared/cat';
import type { PersistedCat } from '../../../../src/shared/catState';
import type { Rect } from '../../../../src/shared/geometry';
import type { Settings } from '../../../../src/shared/settings';
import { defaultSettings } from '../../../../src/shared/settings';
import type { SimEnv, SimEvent, SimOutput } from '../../../../src/shared/sim';
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
  windows?: Record<string, Rect | null>;
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
    return {
      now: this.now,
      dt,
      cursor: e.cursor ?? null,
      cursorOverCat: e.cursorOverCat ?? false,
      userIdleMs: e.userIdleMs ?? 0,
      typing: e.typing ?? false,
      typingIntensity: e.typingIntensity ?? 0,
      foreground: e.foreground ?? null,
      platforms: e.platforms ?? platformsFrom(windows),
      getWindowRect: e.getWindowRect ?? ((id: string) => windows[id] ?? null),
      fullscreenDisplayIds: e.fullscreenDisplayIds ?? [],
      paused: e.paused ?? false,
      hidden: e.hidden ?? false,
      dragCursor: e.dragCursor ?? null,
      localHour: e.localHour ?? 14,
    };
  }

  step(events: readonly SimEvent[] = [], dt = 33): SimOutput {
    this.now += dt;
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

/** Window rects -> walkable top edges (no occlusion). */
export function platformsFrom(windows: Record<string, Rect | null>): Platform[] {
  const out: Platform[] = [];
  for (const [id, r] of Object.entries(windows)) if (r) out.push({ windowId: id, y: r.y, x0: r.x, x1: r.x + r.width });
  return out;
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
