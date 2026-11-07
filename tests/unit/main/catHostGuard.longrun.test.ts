// Long-run regression suite for the cat host's T8 click guard and lifecycle latches (diagnosis H2, H5,
// H8; synthesis §3.B). REAL createCatHost and decideInteractive, the REAL obstacle source over
// FakeNative in the chatter case and the REAL Mover replayed for the bail-out timings; the sim is
// otherwise scripted, Win32 and the provider are in-memory fakes (MOCKED native). The overlay
// stand-in asks for the guard rects only with the cursor on the cat, as the overlay manager does.
// Seeded randomness and injected clocks: every result here is SIMULATED.
import { describe, expect, it } from 'vitest';
import { decideInteractive } from '../../../src/core/interaction/clickThrough';
import {
  BAIL_GUARD_MAX_MS,
  createCatHost,
  GUARD_LOG_GAP_MS,
  LOCK_INPUT_SETTLE_MS,
  LOCK_RECHECK_MS,
  MAX_EVENTS_PER_TICK,
  OBSTACLE_STALE_GRACE_MS,
  perceptionPausedFor,
  type GuardReason,
  type HostOverlays,
  type HostSurfaceProvider,
} from '../../../src/main/catHost';
import type { ActivityMonitor, DisplayService, PerceptionService, TaskbarState, TaskbarTracker, Win32Api, WindowTracker } from '../../../src/main/contracts';
import { createClickObstacleSource, type ClickObstacleSource } from '../../../src/main/win32/clickObstacles';
import { EVENT_OBJECT_LOCATIONCHANGE } from '../../../src/main/win32/constants';
import { emptyBehaviorProfile } from '../../../src/shared/behaviorProfile';
import type { PersistedCat } from '../../../src/shared/catState';
import type { Point, Rect } from '../../../src/shared/geometry';
import { defaultSettings } from '../../../src/shared/settings';
import type { CatSim, SimEvent, SimOutput } from '../../../src/shared/sim';
import type { ScreenEdgeBand, Surface } from '../../../src/shared/surfaces';
import type { WorldGeometry } from '../../../src/shared/world';
import { DEFAULT_LIMITS, env, FLOOR_Y, SINGLE, topId, wall, type Env } from '../core/movement/v12Fixtures';
import { createTestLogger, FakeNative, raw } from '../win32/fakes';
import { manualTimers, memoryLogger } from './helpers';

/** The reporting user's display: 1920x1200 at 125 %, the taskbar auto-hides. */
const SCALE = 1.25;
const SCREEN: Rect = { x: 0, y: 0, width: 1920, height: 1200 };
const WORLD: WorldGeometry = {
  version: 1,
  displays: [{ id: '1', primary: true, scaleFactor: SCALE, boundsDip: { x: 0, y: 0, width: 1536, height: 960 }, workAreaDip: { x: 0, y: 0, width: 1536, height: 960 }, boundsPx: SCREEN, workAreaPx: SCREEN }],
};
const BANDS: readonly ScreenEdgeBand[] = [
  { displayId: '1', side: 'left', clearSpans: [] },
  { displayId: '1', side: 'right', clearSpans: [] },
];
const MAXIMIZED: Rect = { x: -8, y: -8, width: 1936, height: 1216 };
/** A window on the right half: never under a cat at the left edge. */
const RIGHT_HALF: Rect = { x: 1000, y: 100, width: 900, height: 900 };
const WINDOW_W: Rect = { x: 600, y: 600, width: 800, height: 600 };
const CLING_LEFT: SimOutput['support'] = { kind: 'surface', surfaceId: 'screenEdge:1:left', surfaceKind: 'screenEdge', orientation: 'wall' };
const TOP_W: Surface = { id: topId('w'), kind: 'windowTop', ownerId: 'w', displayId: '1', orientation: 'ledge', y: 600, x0: 600, x1: 1400, rest: null, focusX: null, phase: 'stable', vx: 0, vy: 0, confidence: 1, validatedAt: 0, excluded: false };
const ON_TOP_W: SimOutput['support'] = { kind: 'surface', surfaceId: TOP_W.id, surfaceKind: 'windowTop', orientation: 'ledge' };
const SIDE_W = wall('w', 'right', 1400, 600, 1200);
const ON_SIDE_W: SimOutput['support'] = { kind: 'surface', surfaceId: SIDE_W.id, surfaceKind: 'windowSide', orientation: 'wall' };
const TASKBAR_LEDGE: SimOutput['support'] = { kind: 'surface', surfaceId: 'taskbar:7', surfaceKind: 'taskbar', orientation: 'ledge' };

/** The cat's upright bounds at size 1 and this scale, its anchor at (x, y). */
const boundsAt = (x: number, y: number, scale = SCALE): Rect => ({ x: x - 42 * scale, y: y - 64 * scale, width: 84 * scale, height: 64 * scale });
const centre = (r: Rect): Point => ({ x: r.x + r.width / 2, y: r.y + r.height / 2 });
const inside = (r: Rect, p: Point): boolean => p.x >= r.x && p.x < r.x + r.width && p.y >= r.y && p.y < r.y + r.height;

function output(over: Partial<SimOutput> = {}): SimOutput {
  const x = over.x ?? 960;
  const y = over.y ?? 1200;
  return {
    x,
    y,
    facing: 1,
    state: 'idle',
    clip: 'stand',
    clipStartedAt: 0,
    speed: 0,
    vy: 0,
    look: null,
    arousal: 0,
    contentment: 0.5,
    emote: null,
    emoteStartedAt: 0,
    opacity: 1,
    visible: true,
    snap: false,
    displayId: '1',
    support: { kind: 'floor', displayId: '1' },
    boundsPx: boundsAt(x, y),
    nextTickMs: 33,
    requests: [],
    ...over,
  };
}

/** Seeded uniform [0, 1) (mulberry32). */
function seeded(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

interface Poll {
  t: number;
  blocked: boolean;
  onCat: boolean;
  interactive: boolean;
  reason: GuardReason | null;
  state: string;
}

interface RigOptions {
  world?: WorldGeometry;
  bands?: readonly ScreenEdgeBand[] | null;
  obstacles?: readonly Rect[];
  /** Install the OS lock probe (reads rig.os.locked). */
  probe?: boolean;
  /** The real obstacle source (built over the rig clock) instead of the scripted one. */
  realSource?: (now: () => number) => ClickObstacleSource;
  taskbars?: TaskbarTracker | null;
  /** Each sim tick's output; the scripted `out` by default. */
  next?: () => SimOutput;
  listed?: () => readonly Surface[];
}

function rig(o: RigOptions = {}) {
  const timers = manualTimers();
  const logger = memoryLogger();
  let out = output();
  let listed: readonly Surface[] = [];
  const delivered: SimEvent[] = [];
  let quitAsked = false;
  const sim: CatSim = {
    tick: (_env, evs) => {
      for (const e of evs) {
        delivered.push(e);
        if (e.type === 'lifecycle.quitRequested') quitAsked = true;
      }
      const base = o.next ? o.next() : out;
      if (!quitAsked) return base;
      quitAsked = false;
      return { ...base, requests: [{ type: 'quitReady' }] };
    },
    updateSettings: () => undefined,
    setWorld: () => undefined,
    serialize: () => ({}) as PersistedCat,
    resetPersonality: () => undefined,
    clearHistory: () => undefined,
    state: 'idle',
    debugInfo: () => ({}),
    surfaceDiagnostics: () => {
      throw new Error('not used by these tests');
    },
    surfaceDebugLines: () => [],
    behaviorProfile: () => emptyBehaviorProfile(0),
  };
  /** Win32 input: the cursor (null read = GetCursorPos failing, as on a locked desktop) and the press count. */
  const input: { cursor: Point; cursorWorks: boolean; down: boolean; presses: number } = { cursor: { x: 300, y: 300 }, cursorWorks: true, down: false, presses: 0 };
  const source = {
    rects: o.obstacles ?? [MAXIMIZED],
    fresh: true as boolean | (() => boolean),
    throws: false,
    calls: 0,
    watch: [] as boolean[],
  };
  const real = o.realSource ? o.realSource(() => timers.now) : null;
  const os = { locked: false as boolean | null, probes: 0 };
  const win32 = {
    available: true,
    getCursorPos: () => (input.cursorWorks ? { x: input.cursor.x, y: input.cursor.y } : null),
    isLeftButtonDown: () => input.down,
    windowProcessId: () => null,
    mouseButtons: () => ({ down: input.down, presses: input.presses }),
    clickObstaclesPx: () => {
      source.calls++;
      if (real) return real.get();
      if (source.throws) throw new Error('enumeration failed');
      return { rects: source.rects, fresh: typeof source.fresh === 'function' ? source.fresh() : source.fresh };
    },
    setObstacleWatch: (armed: boolean) => {
      source.watch.push(armed);
      real?.setArmed(armed);
    },
    obstacleStats: () => null,
  } as unknown as Win32Api;
  const tracker = { mode: 'event-hooks', drainEvents: () => [], getForeground: () => null, getPlatforms: () => [], getWindowRect: () => null, getFullscreenDisplayIds: () => [] } as unknown as WindowTracker;
  const activity = { sample: () => undefined, drainEvents: () => [], idleMs: 0, typing: false, typingIntensity: 0, cursorSpeed: 0 } as unknown as ActivityMonitor;
  const perception = { drainEvents: () => [], request: () => undefined } as unknown as PerceptionService;
  const world = o.world ?? WORLD;
  const display = { world, displayAt: () => world.displays[0]!.id } as unknown as DisplayService;
  const polls: Poll[] = [];
  let recording = true;
  let interactive = false;
  let statusChanges = 0;
  let noteResumes = 0;
  const overlays: HostOverlays = {
    noteResume: () => void noteResumes++,
    render: () => undefined,
    // As the overlay manager: the guard rects are asked for only with the cursor on the cat's hit region.
    updateInteractivity: (c, blocked) => {
      const cur = host.lastOutput;
      const hit = cur && cur.visible ? cur.boundsPx : null;
      const onCat = !blocked && c !== null && hit !== null && inside(hit, c);
      let now = false;
      if (onCat && hit) {
        const excludeRects = host.clickGuardRectsPx();
        now = decideInteractive({ cursor: c, hitRects: [hit], excludeRects, interactive, interactionsEnabled: true, visible: true, rendererHealthy: true, dragging: false, hitRegionAgeMs: 10 });
      }
      interactive = now;
      if (recording) {
        const g = host.debug().clickGuard;
        polls.push({ t: timers.now, blocked, onCat, interactive: now, reason: g.reason, state: g.state });
      }
    },
    isCursorOverCat: () => false,
    dragging: false,
    pressed: false,
    get interactive() {
      return interactive;
    },
  };
  const settings = defaultSettings();
  const surfaces = {
    getSurfaces: () => (o.listed ? o.listed() : listed),
    getSurface: () => null,
    drainEvents: () => [],
    edgeBands: () => (o.bands === undefined ? BANDS : o.bands),
  } as unknown as HostSurfaceProvider;
  const host = createCatHost({
    sim,
    win32,
    tracker,
    activity,
    perception,
    display,
    overlays,
    catStore: { markDirty: () => undefined, save: () => Promise.resolve(true) },
    logger,
    getSettings: () => settings,
    cursorFallback: () => null,
    clock: () => timers.now,
    wallClock: () => new Date(2026, 10, 6, 14, 30),
    timers,
    surfaces,
    taskbars: o.taskbars ?? null,
    onStatusChange: () => statusChanges++,
    ...(o.probe
      ? {
          isSystemLocked: () => {
            os.probes++;
            return os.locked;
          },
        }
      : {}),
  });
  /** The sim returns this from its next tick on. */
  const set = (over: Partial<SimOutput>): SimOutput => {
    out = output(over);
    return out;
  };
  return {
    host,
    timers,
    logger,
    source,
    input,
    os,
    polls,
    delivered,
    settings,
    get statusChanges(): number {
      return statusChanges;
    },
    /** HostOverlays.noteResume calls (the overlays' input-state reset after a resume or unlock). */
    get noteResumes(): number {
      return noteResumes;
    },
    /** The overlay manager's press state as the host reads it. */
    setPressed(v: boolean): void {
      (overlays as { pressed: boolean }).pressed = v;
    },
    get out(): SimOutput {
      return out;
    },
    set recording(v: boolean) {
      recording = v;
    },
    set listed(l: readonly Surface[]) {
      listed = l;
    },
    set,
    /** set(), then on until the host has ticked with it (the next tick may be a sleeping cadence away). */
    show(over: Partial<SimOutput>): SimOutput {
      const o = set(over);
      for (let i = 0; i < 100 && host.lastOutput !== o; i++) timers.advance(16);
      return o;
    },
    cursorOnCat(): void {
      input.cursor = centre(out.boundsPx);
    },
    cursorAway(): void {
      input.cursor = { x: out.x > 960 ? 100 : 1800, y: 100 };
    },
    run: (ms: number): void => timers.advance(ms),
    guard: () => host.debug().clickGuard,
    stats: () => host.debug().clickGuardStats,
    start(): void {
      host.start();
      timers.advance(0);
    },
    /** The polls since `t` with the cursor on the cat. */
    onCatSince: (t: number): Poll[] => polls.filter((p) => p.t > t && p.onCat),
    clearPolls: (): void => void polls.splice(0),
  };
}

type Rig = ReturnType<typeof rig>;

function startedRig(o: RigOptions = {}): Rig {
  const r = rig(o);
  r.start();
  return r;
}

describe('bail-out guard: a support the list no longer holds, with the cat still on it (H2)', () => {
  it.each([
    ['a window top', ON_TOP_W, 900, 600],
    ['a window side', ON_SIDE_W, 1400, 800],
  ] as const)('on %s behind a maximized window for 60 s: interactive again within BAIL_GUARD_MAX_MS, and it stays so', (_name, support, x, y) => {
    const r = rig({ obstacles: [MAXIMIZED] });
    r.listed = [TOP_W, SIDE_W];
    r.set({ x, y, support, boundsPx: boundsAt(x, y) });
    r.start();
    r.cursorOnCat();
    r.run(1000);
    expect(r.onCatSince(500).every((p) => p.interactive), 'listed: the cat takes the mouse').toBe(true);

    // The maximize covers the window; the provider stops listing it, the scripted sim keeps the cat there.
    r.listed = [];
    const coveredAt = r.timers.now;
    r.run(60_000);
    const polls = r.onCatSince(coveredAt);
    const lastDenied = polls.filter((p) => !p.interactive).at(-1);
    expect(lastDenied, 'the cover is guarded first (ADR 0003 §3)').toBeDefined();
    // One tick to see the cover, the cap, one tick and one poll to act on it.
    expect(lastDenied!.t - coveredAt).toBeLessThanOrEqual(BAIL_GUARD_MAX_MS + 33 + 33 + 16);
    expect(polls.filter((p) => p.t > lastDenied!.t).length).toBeGreaterThan(3000);
    expect(r.guard()).toMatchObject({ state: 'idle', reason: null });
    const s = r.stats();
    expect(s.episodes.bailOut).toBe(1);
    expect(s.bailOutsCapped).toBe(1);
    expect(s.timeInGuardMs.bailOut).toBeGreaterThanOrEqual(BAIL_GUARD_MAX_MS);
    expect(s.timeInGuardMs.bailOut).toBeLessThan(BAIL_GUARD_MAX_MS + 100);
    expect(r.logger.entries.filter((e) => e.level === 'info' && e.msg === 'click guard episode')).toEqual([
      expect.objectContaining({ data: expect.objectContaining({ reason: 'bailOut', start: 'covered', end: 'capped' }) }),
    ]);
    r.host.stop();
  });

  it('listed again under the cat: the episode ends at once (the list caught up)', () => {
    const r = rig({ obstacles: [MAXIMIZED] });
    r.listed = [TOP_W];
    r.set({ x: 900, y: 600, support: ON_TOP_W, boundsPx: boundsAt(900, 600) });
    r.start();
    r.cursorOnCat();
    r.run(200);
    r.listed = [];
    r.run(200);
    expect(r.guard().reason).toBe('bailOut');
    r.listed = [TOP_W];
    r.run(50);
    expect(r.guard()).toMatchObject({ state: 'idle', reason: null });
    expect(r.stats().bailOutsCapped).toBe(0);
    r.host.stop();
  });

  it('a jump off the support that stayed unlisted is the bail-out it was: guarded again until the landing', () => {
    const r = rig({ obstacles: [MAXIMIZED] });
    r.listed = [TOP_W];
    r.set({ x: 900, y: 600, support: ON_TOP_W, boundsPx: boundsAt(900, 600) });
    r.start();
    r.cursorOnCat();
    r.run(200);
    r.listed = [];
    r.run(5000);
    expect(r.guard().reason).toBe(null);
    const air = r.set({ x: 920, y: 800, support: { kind: 'air' }, jumpKind: 'down', boundsPx: boundsAt(920, 800) });
    r.input.cursor = centre(air.boundsPx);
    r.run(300);
    expect(r.guard()).toMatchObject({ state: 'active', reason: 'bailOut' });
    r.set({ x: 940, y: 1200 });
    r.cursorOnCat();
    r.run(100);
    expect(r.guard()).toMatchObject({ state: 'idle', reason: null });
    expect(r.onCatSince(r.timers.now - 40).every((p) => p.interactive)).toBe(true);
    expect(r.stats().episodes.bailOut).toBe(2);
    r.host.stop();
  });

  it('a bail-out drop with more than 1.5 s in the air stays guarded until the landing (review finding 6: the cap counts grounded time only)', () => {
    const r = rig({ obstacles: [MAXIMIZED] });
    r.listed = [TOP_W];
    r.set({ x: 900, y: 600, support: ON_TOP_W, boundsPx: boundsAt(900, 600) });
    r.start();
    r.cursorOnCat();
    r.run(200);
    // Covered: the provider stops listing the window top; the cat crouches for 450 ms ...
    r.listed = [];
    r.run(450);
    expect(r.guard().reason).toBe('bailOut');
    // ... then drops for 2.2 s (a high ledge on a tall screen), past the covering window, the cursor on it.
    const AIR_MS = 2200;
    const t0 = r.timers.now;
    for (let ms = 0; ms < AIR_MS; ms += 33) {
      const y = 600 + (580 * ms) / AIR_MS;
      const o = r.set({ x: 900, y, support: { kind: 'air' }, jumpKind: 'down', boundsPx: boundsAt(900, y) });
      r.input.cursor = centre(o.boundsPx);
      r.run(33);
    }
    const fall = r.onCatSince(t0);
    expect(fall.length).toBeGreaterThan(60);
    expect(
      fall.filter((p) => p.reason !== 'bailOut' || p.interactive).map((p) => p.t - t0),
      'guarded (the covering window keeps its clicks) for the whole fall',
    ).toEqual([]);
    // The landing ends it.
    r.set({ x: 900, y: 1200 });
    r.cursorOnCat();
    r.run(100);
    expect(r.guard()).toMatchObject({ state: 'idle', reason: null });
    expect(r.onCatSince(r.timers.now - 40).every((p) => p.interactive)).toBe(true);
    const s = r.stats();
    expect(s.episodes.bailOut).toBe(1);
    expect(s.bailOutsCapped).toBe(0);
    expect(s.timeInGuardMs.bailOut).toBeGreaterThan(450 + AIR_MS - 50);
    expect(r.logger.entries.filter((e) => e.msg === 'click guard episode').map((e) => e.data?.end)).toEqual(['landed']);
    r.host.stop();
  });
});

describe('bail-out guard: the cap sits above every real bail-out (REAL Mover replayed)', () => {
  const FULL: Rect = { x: -8, y: -8, width: 1936, height: 1096 };
  const BAIL = { bailOut: true, ...DEFAULT_LIMITS } as const;

  function onWindow(y = 600): Env {
    const e = env(SINGLE, BAIL, 0.45);
    e.walls = false;
    e.windows = { w: { x: 600, y, width: 800, height: FLOOR_Y - y } };
    e.step();
    e.placeOn(topId('w'), 900, y);
    e.m.setGoal(null);
    for (let i = 0; i < 5; i++) e.step();
    return e;
  }

  function replay(e: Env): Rig {
    const r = rig({
      world: SINGLE,
      bands: null,
      obstacles: [FULL],
      next: () => {
        e.step();
        return output({ x: e.m.x, y: e.m.y, support: e.m.support, jumpKind: e.m.jumpKind, boundsPx: boundsAt(e.m.x, e.m.y, 1), nextTickMs: 16 });
      },
      listed: () => e.surfaces().filter((s) => !e.hidden.has(s.id) && !e.gone.has(s.id)),
    });
    r.recording = false;
    r.start();
    return r;
  }

  function untilDone(r: Rig, done: () => boolean): void {
    for (let i = 0; i < 800 && !done(); i++) r.run(16);
    expect(done(), 'it got there').toBe(true);
    r.run(32);
  }

  const vanish = (e: Env): void => {
    e.windows = {};
    e.gone.add(topId('w'));
  };

  it.each([
    ['vanished (maximized, minimized or closed)', vanish],
    ['covered', (e: Env): void => void e.hidden.add(topId('w'))],
    ['out of headroom', (e: Env): void => void (e.windows = { w: { x: 600, y: 20, width: 800, height: FLOOR_Y - 20 } })],
  ])('a window top %s: one episode, ended by the landing, well inside the cap', (_name, lose) => {
    const e = onWindow();
    const r = replay(e);
    r.run(32);
    lose(e);
    untilDone(r, () => e.m.support.kind === 'floor');
    const s = r.stats();
    expect(s.episodes.bailOut).toBe(1);
    expect(s.bailOutsCapped).toBe(0);
    expect(s.timeInGuardMs.bailOut).toBeGreaterThan(100);
    expect(s.timeInGuardMs.bailOut).toBeLessThan(BAIL_GUARD_MAX_MS);
    expect(r.guard()).toMatchObject({ state: 'idle', reason: null });
    r.host.stop();
  });

  it('covered, the way off a leap onto a window side: ended by the catch, inside the cap', () => {
    const e = onWindow(200);
    e.windows = { w: { x: 500, y: 200, width: 480, height: 840 } };
    e.extra = [wall('u', 'left', 1000, 150, FLOOR_Y, { topLedgeId: null })];
    e.step();
    const r = replay(e);
    r.run(32);
    e.hidden.add(topId('w'));
    untilDone(r, () => e.m.bailOutKind === 'wall' && e.m.onWall && e.m.climbPhase !== 'leap');
    const s = r.stats();
    expect(s.episodes.bailOut).toBe(1);
    expect(s.bailOutsCapped).toBe(0);
    expect(s.timeInGuardMs.bailOut).toBeLessThan(BAIL_GUARD_MAX_MS);
    r.host.stop();
  });
});

describe('screen-edge band: the designed protection stays (ADR 0003 §6.1(a))', () => {
  const at = { x: 44, y: 700, support: CLING_LEFT, boundsPx: boundsAt(44, 700) };

  it('clinging over a maximized window with the cursor resting on the cat: click-through on every poll, by design', () => {
    const r = rig({ obstacles: [MAXIMIZED] });
    r.set(at);
    r.start();
    r.cursorOnCat();
    r.run(10_000);
    const polls = r.onCatSince(0);
    expect(polls.length).toBeGreaterThan(500);
    expect(polls.every((p) => !p.interactive && p.reason === 'band' && p.state === 'active')).toBe(true);
    expect(r.stats()).toMatchObject({ failClosedPolls: 0, episodes: { band: 1 } });
    r.host.stop();
  });

  it('clinging over the bare desktop, or next to a window that misses it: the deliberate grab works', () => {
    for (const obstacles of [[], [RIGHT_HALF]]) {
      const r = rig({ obstacles });
      r.set(at);
      r.start();
      r.cursorOnCat();
      r.run(2000);
      expect(r.onCatSince(0).every((p) => p.interactive && p.reason === 'band')).toBe(true);
      r.host.stop();
    }
  });
});

describe('stale obstacle lists (H2): the last fresh one for at most OBSTACLE_STALE_GRACE_MS, then fail closed', () => {
  const at = { x: 44, y: 700, support: CLING_LEFT, boundsPx: boundsAt(44, 700) };

  it('stale for k polls: reused while the fresh list is at most 250 ms old, then the whole cat is click-through; fresh again: grabbable', () => {
    const r = rig({ obstacles: [] });
    r.set(at);
    r.start();
    r.cursorOnCat();
    r.run(500);
    const lastFresh = r.onCatSince(0).at(-1)!.t;
    r.source.fresh = false;
    r.run(600);
    const stale = r.onCatSince(lastFresh);
    const graced = stale.filter((p) => p.t - lastFresh <= OBSTACLE_STALE_GRACE_MS);
    const after = stale.filter((p) => p.t - lastFresh > OBSTACLE_STALE_GRACE_MS);
    expect(graced.length).toBeGreaterThanOrEqual(10);
    expect(graced.every((p) => p.interactive && p.state === 'active')).toBe(true);
    expect(after.length).toBeGreaterThan(10);
    expect(after.every((p) => !p.interactive && p.state === 'failClosed')).toBe(true);
    const s = r.stats();
    expect(s.staleGracePolls).toBe(graced.length);
    expect(s.failClosedPolls).toBe(after.length);
    r.source.fresh = true;
    const back = r.timers.now;
    r.run(100);
    expect(r.onCatSince(back).every((p) => p.interactive && p.state === 'active')).toBe(true);
    r.host.stop();
  });

  it('the grace reuses the cut-outs too: a cat over a maximized window stays click-through while the list is stale', () => {
    const r = rig({ obstacles: [MAXIMIZED] });
    r.set(at);
    r.start();
    r.cursorOnCat();
    r.run(200);
    r.source.fresh = false;
    const t0 = r.timers.now;
    r.run(1000);
    expect(r.onCatSince(t0).every((p) => !p.interactive)).toBe(true);
    r.host.stop();
  });

  it('a throwing source fails closed at once (no grace), and so does a stale list after the hooks came off', () => {
    const r = rig({ obstacles: [] });
    r.set(at);
    r.start();
    r.cursorOnCat();
    r.run(200);
    r.source.throws = true;
    const t0 = r.timers.now;
    r.run(100);
    expect(r.onCatSince(t0).every((p) => !p.interactive && p.state === 'failClosed')).toBe(true);
    r.source.throws = false;
    r.run(100);
    // Cursor away long enough for the hooks to come off (2 s quiet), then back with a stale list.
    r.cursorAway();
    r.run(3000);
    expect(r.source.watch.at(-1)).toBe(false);
    r.source.fresh = false;
    r.cursorOnCat();
    const t1 = r.timers.now;
    r.run(100);
    expect(r.onCatSince(t1).every((p) => !p.interactive && p.state === 'failClosed')).toBe(true);
    r.host.stop();
  });

  it('WinEvent chatter between enumerations (REAL obstacle source): never fails closed, the clinging cat stays grabbable for 10 s', () => {
    const native = new FakeNative(4242);
    native.add(1n, { pid: 50, frame: raw(1000, 200, 800, 600) });
    const r = rig({ realSource: (now) => createClickObstacleSource(native, createTestLogger(), { now }) });
    r.set(at);
    r.start();
    // A window animating somewhere else: a location change every 10 ms.
    const chatter = (): void => {
      native.fire(EVENT_OBJECT_LOCATIONCHANGE, 1n);
      r.timers.setTimeout(chatter, 10);
    };
    chatter();
    r.cursorOnCat();
    r.run(10_000);
    const polls = r.onCatSince(100);
    expect(polls.length).toBeGreaterThan(500);
    expect(polls.every((p) => p.interactive)).toBe(true);
    const s = r.stats();
    expect(s.failClosedPolls).toBe(0);
    expect(s.staleGracePolls, 'the chatter really made the list stale').toBeGreaterThan(100);
    r.host.stop();
  });
});

describe('session lock and suspend latches recover (H5)', () => {
  function floorRig(probe: boolean): Rig {
    const r = rig({ obstacles: [MAXIMIZED], probe });
    r.set({ x: 700, y: 1200 });
    r.start();
    r.cursorOnCat();
    r.run(500);
    expect(r.onCatSince(0).at(-1)?.interactive).toBe(true);
    return r;
  }
  const lastBlocked = (r: Rig): boolean => r.polls.at(-1)!.blocked;
  const after = (r: Rig, i: number): SimEvent['type'][] => r.delivered.slice(i).map((e) => e.type);

  it('lock, suspend, resume, the unlock event lost: the OS lock state is re-read and the host lets go within LOCK_RECHECK_MS', () => {
    const r = floorRig(true);
    r.os.locked = true;
    r.host.onSystem('lock');
    r.run(1000);
    expect(lastBlocked(r)).toBe(true);
    r.host.onSystem('suspend');
    r.timers.stall(3_600_000);
    r.host.onSystem('resume');
    r.run(5000);
    expect(r.host.locked, 'the lock screen is still up').toBe(true);
    expect(lastBlocked(r)).toBe(true);
    // The user signs in; Windows never sends the unlock.
    const mark = r.delivered.length;
    const changes = r.statusChanges;
    r.os.locked = false;
    r.run(LOCK_RECHECK_MS + 200);
    expect(r.host.locked).toBe(false);
    expect(lastBlocked(r)).toBe(false);
    expect(r.polls.at(-1)!.interactive).toBe(true);
    expect(after(r, mark)).toContain('system.unlock');
    expect(r.statusChanges, 'the app re-evaluates perception and the tray').toBeGreaterThan(changes);
    expect(r.host.debug().lifecycle).toMatchObject({ lockRecoveries: 1, suspended: false });
    r.host.stop();
  });

  it('without an OS probe: locked while nothing happens, unlocked by the first native input (the cursor read works again, a press)', () => {
    for (const evidence of ['cursor', 'press'] as const) {
      const r = floorRig(false);
      r.host.onSystem('lock');
      r.host.onSystem('suspend');
      // Locked desktop: GetCursorPos fails.
      r.input.cursorWorks = false;
      r.timers.stall(600_000);
      r.host.onSystem('resume');
      r.run(60_000);
      expect(r.host.locked, 'no evidence of a user: still locked').toBe(true);
      const mark = r.delivered.length;
      if (evidence === 'cursor') {
        r.input.cursorWorks = true;
        r.input.cursor = { x: r.input.cursor.x + 40, y: r.input.cursor.y };
      } else {
        r.input.cursorWorks = true;
        r.run(200);
        expect(r.host.locked, 'the cursor read alone, unmoved since the lock').toBe(true);
        r.input.presses++;
      }
      r.run(200);
      expect(r.host.locked).toBe(false);
      expect(after(r, mark)).toContain('system.unlock');
      r.cursorOnCat();
      r.run(100);
      expect(r.polls.at(-1)).toMatchObject({ blocked: false, interactive: true });
      r.host.stop();
    }
  });

  it('input while the lock screen comes up does not count, nor input the OS says happened on a locked session', () => {
    const r = floorRig(true);
    r.os.locked = true;
    r.host.onSystem('lock');
    r.run(LOCK_INPUT_SETTLE_MS / 2);
    r.input.cursor = { x: 100, y: 100 };
    r.run(LOCK_INPUT_SETTLE_MS);
    expect(r.host.locked).toBe(true);
    const probes = r.os.probes;
    // Input the OS still calls locked (the probe is authoritative): no unlock, at most one probe a second.
    for (let i = 0; i < 50; i++) {
      r.input.cursor = { x: 100 + 10 * i, y: 100 };
      r.run(100);
    }
    expect(r.host.locked).toBe(true);
    expect(r.os.probes - probes).toBeLessThanOrEqual(6);
    r.host.stop();
  });

  it('a resume with no lock event while the OS reports the session locked: blocked until it is not', () => {
    const r = floorRig(true);
    r.host.onSystem('suspend');
    r.timers.stall(60_000);
    r.os.locked = true;
    const mark = r.delivered.length;
    r.host.onSystem('resume');
    r.run(500);
    expect(r.host.locked).toBe(true);
    expect(lastBlocked(r)).toBe(true);
    expect(after(r, mark)).toEqual(expect.arrayContaining(['system.resume', 'system.lock']));
    r.os.locked = false;
    r.run(LOCK_RECHECK_MS + 200);
    expect(r.host.locked).toBe(false);
    expect(lastBlocked(r)).toBe(false);
    r.host.stop();
  });

  it('a suspend whose resume never came: an unlock event, or native input, tells the sim it runs again', () => {
    const viaUnlock = floorRig(true);
    viaUnlock.host.onSystem('lock');
    viaUnlock.host.onSystem('suspend');
    const m1 = viaUnlock.delivered.length;
    viaUnlock.host.onSystem('unlock');
    viaUnlock.run(100);
    expect(after(viaUnlock, m1)).toEqual(expect.arrayContaining(['system.unlock', 'system.resume']));
    expect(viaUnlock.host.debug().lifecycle).toMatchObject({ suspended: false, resumeRecoveries: 1 });
    viaUnlock.host.stop();

    const viaInput = floorRig(false);
    viaInput.host.onSystem('suspend');
    viaInput.run(LOCK_INPUT_SETTLE_MS + 500);
    const m2 = viaInput.delivered.length;
    viaInput.input.cursor = { x: viaInput.input.cursor.x + 50, y: viaInput.input.cursor.y };
    viaInput.run(200);
    expect(after(viaInput, m2)).toContain('system.resume');
    expect(viaInput.host.debug().lifecycle.suspended).toBe(false);
    viaInput.host.stop();
  });

  it('a normal lock and unlock: unchanged (no probe while unlocked, no made-up events)', () => {
    const r = floorRig(true);
    r.run(30_000);
    expect(r.os.probes).toBe(0);
    r.os.locked = true;
    r.host.onSystem('lock');
    r.run(1000);
    r.os.locked = false;
    const mark = r.delivered.length;
    r.host.onSystem('unlock');
    r.run(100);
    expect(after(r, mark)).toEqual(['system.unlock']);
    expect(r.host.debug().lifecycle).toMatchObject({ locks: 1, lockRecoveries: 0, resumeRecoveries: 0 });
    r.host.stop();
  });

  it('a lock the OS probe clears restores interaction but keeps perception paused until an unlock event or native input (review finding 8)', () => {
    for (const confirm of ['unlock event', 'native input'] as const) {
      const r = floorRig(true);
      r.os.locked = true;
      r.host.onSystem('lock');
      // Locked desktop: GetCursorPos fails, no presses.
      r.input.cursorWorks = false;
      r.run(LOCK_INPUT_SETTLE_MS + 500);
      expect(perceptionPausedFor(r.host)).toBe(true);
      // The probe reads active/idle (it may misread a disconnected or switched-away session); no input, no unlock event.
      r.os.locked = false;
      const changes = r.statusChanges;
      r.run(LOCK_RECHECK_MS + 200);
      expect(r.host.locked, `${confirm}: the lock is let go`).toBe(false);
      expect(lastBlocked(r), `${confirm}: interaction is back`).toBe(false);
      expect(r.statusChanges).toBeGreaterThan(changes);
      expect(r.host.unlockUnconfirmed).toBe(true);
      expect(perceptionPausedFor(r.host), `${confirm}: perception stays paused on the OS's word alone`).toBe(true);
      r.run(60_000);
      expect(perceptionPausedFor(r.host), `${confirm}: still paused a minute on`).toBe(true);
      const before = r.statusChanges;
      if (confirm === 'unlock event') r.host.onSystem('unlock');
      else {
        r.input.cursorWorks = true;
        r.input.cursor = { x: r.input.cursor.x + 40, y: r.input.cursor.y };
        r.run(200);
        expect(r.statusChanges, 'the app re-evaluates perception').toBeGreaterThan(before);
      }
      expect(r.host.unlockUnconfirmed).toBe(false);
      expect(perceptionPausedFor(r.host), `${confirm}: confirmed, perception may run`).toBe(false);
      // A new lock starts over.
      r.host.onSystem('lock');
      expect(perceptionPausedFor(r.host)).toBe(true);
      r.host.stop();
    }
  });

  it('the overlays reset their input state on every resume and unlock, also the ones the host recovers itself (review finding 9)', () => {
    // The OS events.
    const ev = floorRig(true);
    ev.host.onSystem('suspend');
    ev.host.onSystem('resume');
    expect(ev.noteResumes).toBe(1);
    ev.host.onSystem('lock');
    ev.host.onSystem('unlock');
    expect(ev.noteResumes).toBe(2);
    ev.host.stop();

    // A lost unlock (and resume) the OS probe recovers.
    const probe = floorRig(true);
    probe.os.locked = true;
    probe.host.onSystem('lock');
    probe.host.onSystem('suspend');
    probe.timers.stall(600_000);
    probe.os.locked = false;
    probe.run(LOCK_RECHECK_MS + 200);
    expect(probe.host.locked).toBe(false);
    expect(probe.noteResumes, 'recovered unlock + resume: one reset').toBe(1);
    probe.host.stop();

    // A lost unlock native input recovers.
    const input = floorRig(false);
    input.host.onSystem('lock');
    input.input.cursorWorks = false;
    input.run(LOCK_INPUT_SETTLE_MS + 500);
    input.input.cursorWorks = true;
    input.input.cursor = { x: input.input.cursor.x + 40, y: input.input.cursor.y };
    input.run(200);
    expect(input.host.locked).toBe(false);
    expect(input.noteResumes).toBe(1);
    input.host.stop();

    // A lost resume native input recovers.
    const resume = floorRig(false);
    resume.host.onSystem('suspend');
    resume.run(LOCK_INPUT_SETTLE_MS + 500);
    resume.input.cursor = { x: resume.input.cursor.x + 50, y: resume.input.cursor.y };
    resume.run(200);
    expect(resume.host.debug().lifecycle).toMatchObject({ suspended: false, resumeRecoveries: 1 });
    expect(resume.noteResumes).toBe(1);
    resume.host.stop();
  });

  it('a resume recovered from a press never cancels that press: the overlays reset after the release (verify finding on item 9)', () => {
    const r = floorRig(false);
    r.host.onSystem('suspend');
    r.run(LOCK_INPUT_SETTLE_MS + 500);
    // The user's first input after the missed resume is a press on the cat (no cursor move first).
    r.setPressed(true);
    r.input.cursor = { x: r.input.cursor.x + 50, y: r.input.cursor.y };
    r.run(300);
    expect(r.host.debug().lifecycle).toMatchObject({ suspended: false, resumeRecoveries: 1 });
    expect(r.noteResumes, 'no reset while the press is live').toBe(0);
    r.setPressed(false);
    r.run(100);
    expect(r.noteResumes, 'reset once the press has ended').toBe(1);
    r.run(1000);
    expect(r.noteResumes, 'exactly once').toBe(1);
    r.host.stop();
  });
});

describe('event caps never drop pointer or lifecycle events (H8)', () => {
  const minimized = (i: number): SimEvent => ({ type: 'window.minimized', id: `w${i}` });

  it('70 queued events, then pointer.dragEnd: the dragEnd reaches the sim, in order', () => {
    const r = startedRig();
    r.run(100);
    const mark = r.delivered.length;
    for (let i = 0; i < 70; i++) r.host.enqueue(minimized(i));
    const end: SimEvent = { type: 'pointer.dragEnd', at: { x: 10, y: 20 }, velocity: { x: 300, y: 0 } };
    r.host.enqueue(end);
    r.run(20);
    const got = r.delivered.slice(mark);
    expect(got.at(-1)).toEqual(end);
    expect(got.length).toBe(MAX_EVENTS_PER_TICK);
    expect(r.host.debug().droppedEvents).toBe(71 - MAX_EVENTS_PER_TICK);
    r.host.stop();
  });

  it('more than the cap of pointer events in one tick: all of them arrive (only the others are trimmed)', () => {
    const r = startedRig();
    r.run(100);
    const mark = r.delivered.length;
    for (let i = 0; i < 40; i++) r.host.enqueue(minimized(i));
    for (let i = 0; i < 70; i++) r.host.enqueue({ type: 'pointer.pet', at: { x: i, y: 0 }, strength: 0.5 });
    r.host.enqueue({ type: 'pointer.dragStart', at: { x: 1, y: 1 } });
    r.run(20);
    const got = r.delivered.slice(mark);
    expect(got.filter((e) => e.type === 'pointer.pet')).toHaveLength(70);
    expect(got.at(-1)?.type).toBe('pointer.dragStart');
    expect(got.filter((e) => e.type === 'window.minimized')).toHaveLength(0);
    r.host.stop();
  });

  it('a quit requested behind 70 events still resolves', async () => {
    const r = startedRig();
    r.run(100);
    for (let i = 0; i < 70; i++) r.host.enqueue(minimized(i));
    let done = false;
    void r.host.requestQuit().then(() => (done = true));
    r.run(20);
    await Promise.resolve();
    expect(done).toBe(true);
    r.host.stop();
  });

  it('the queue cap trims the oldest non-priority events, never an older dragStart', () => {
    const r = startedRig();
    r.run(100);
    const mark = r.delivered.length;
    r.host.enqueue({ type: 'pointer.dragStart', at: { x: 1, y: 1 } });
    for (let i = 0; i < 300; i++) r.host.enqueue(minimized(i));
    r.run(20);
    expect(r.delivered.slice(mark)[0]).toEqual({ type: 'pointer.dragStart', at: { x: 1, y: 1 } });
    r.host.stop();
  });
});

describe('24 h scripted soak (H2, H5; SIMULATED)', () => {
  /** An auto-hide bottom taskbar the scenarios reveal and hide (cadence only: the host never guards a taskbar). */
  function autoHideTaskbar() {
    const docked: Rect = { x: 0, y: 1152, width: 1920, height: 48 };
    let phase: TaskbarState['phase'] = 'hidden';
    const state = (): TaskbarState => ({ id: '7', displayId: '1', edge: 'bottom', autoHide: true, rect: phase === 'shown' ? docked : { ...docked, y: 1198 }, dockedRect: docked, shownFraction: phase === 'shown' ? 1 : 0, phase, speed: 0, validatedAt: 0 });
    const tracker: TaskbarTracker = {
      available: true,
      start: () => undefined,
      stop: () => undefined,
      sample: () => (phase === 'hidden' ? 1000 : 50),
      taskbars: () => [state()],
      surfaces: () => [],
      drainEvents: () => [],
      debugInfo: () => ({}),
    };
    return {
      tracker,
      set: (p: TaskbarState['phase']) => (phase = p),
    };
  }

  it('cycling front-maximized windows, bail-outs, stuck supports, edge visits, taskbar reveals, stale lists and resumes: the guard always returns to idle in bound, a floor cat under the cursor is always clickable, time in guard is recorded', () => {
    const rand = seeded(0x5eed2611);
    const between = (a: number, b: number): number => a + rand() * (b - a);
    const bar = autoHideTaskbar();
    const r = rig({ obstacles: [], probe: true, taskbars: bar.tracker });
    r.recording = false;
    r.start();
    /** Scripted time in each guard phase (ms), to compare with the host's account. */
    const expected: Record<GuardReason, number> = { band: 0, edgeFlight: 0, bailOut: 0 };
    let episodes = 0;
    const violations: string[] = [];
    const counts: Record<string, number> = {};
    const fail = (slot: number, what: string): void => {
      if (violations.length < 20) violations.push(`slot ${slot} (${(r.timers.now / 3_600_000).toFixed(2)} h): ${what}`);
    };

    /** Runs `ms` with the cursor on the cat; returns the on-cat polls. */
    const hover = (ms: number): Poll[] => {
      r.clearPolls();
      r.recording = true;
      r.cursorOnCat();
      r.run(ms);
      r.recording = false;
      return r.polls.filter((p) => p.onCat);
    };
    /** A floor cat (any front window) under the cursor takes the mouse at once, and the guard is idle. */
    const floorClickable = (slot: number, what: string): void => {
      const x = between(130, 1810);
      r.show({ x, y: 1200 });
      const polls = hover(150);
      if (polls.length === 0 || !polls.every((p) => p.interactive && p.reason === null)) fail(slot, `${what}: floor cat at ${x.toFixed(0)} not clickable (${polls.length} polls, ${JSON.stringify(polls.find((p) => !p.interactive || p.reason !== null) ?? r.polls.at(-1))})`);
      const g = r.guard();
      if (g.state !== 'idle' || g.reason !== null) fail(slot, `${what}: guard not idle after the episode: ${JSON.stringify(g)}`);
    };
    const front = (): void => {
      const u = rand();
      r.source.rects = u < 0.65 ? [MAXIMIZED] : u < 0.85 ? [] : [RIGHT_HALF];
      r.source.fresh = true;
    };

    const scenarios = {
      edgeVisit(slot: number): void {
        const y = between(300, 1000);
        r.show({ x: 44, y, support: CLING_LEFT, boundsPx: boundsAt(44, y) });
        const t0 = r.timers.now;
        const polls = hover(between(2000, 8000));
        const covered = r.source.rects.some((o) => o === MAXIMIZED);
        // By design over a window: click-through; over the bare desktop: the deliberate grab works.
        if (!polls.every((p) => p.interactive === !covered && p.reason === 'band')) fail(slot, `edge visit (covered ${covered}) answered ${JSON.stringify(polls.find((p) => p.interactive === covered || p.reason !== 'band'))}`);
        const fy = Math.min(1100, y + 150);
        r.show({ x: 160, y: fy, support: { kind: 'air' }, jumpKind: 'wallJump', boundsPx: boundsAt(160, fy) });
        const t1 = r.timers.now;
        r.run(between(300, 700));
        r.show({ x: 220, y: 1200 });
        expected.band += t1 - t0;
        expected.edgeFlight += r.timers.now - t1;
        episodes += 2;
        floorClickable(slot, 'after the edge visit');
      },
      bailOut(slot: number): void {
        r.source.rects = [WINDOW_W];
        r.listed = [TOP_W];
        r.show({ x: 900, y: 600, support: ON_TOP_W, boundsPx: boundsAt(900, 600) });
        const before = hover(500);
        if (!before.every((p) => p.interactive)) fail(slot, 'cat on a visible window top not clickable');
        // A maximize covers it (or minimizes or closes it): guarded from the cover, through the crouch
        // and the take-off, until the landing.
        r.source.rects = [MAXIMIZED];
        r.listed = [];
        const vanished = rand() < 0.5;
        const t0 = r.timers.now;
        r.recording = true;
        r.clearPolls();
        if (!vanished) r.run(450);
        r.show({ x: 900, y: 600, support: { kind: 'air' }, jumpKind: vanished ? null : 'down', boundsPx: boundsAt(900, 600) });
        r.cursorOnCat();
        r.run(between(250, 700));
        r.recording = false;
        const during = r.polls.filter((p) => p.onCat && p.t > t0 + 40);
        if (!during.every((p) => !p.interactive && p.reason === 'bailOut')) fail(slot, `bail-out not guarded: ${JSON.stringify(during.find((p) => p.interactive || p.reason !== 'bailOut'))}`);
        r.show({ x: 900, y: 1200 });
        expected.bailOut += r.timers.now - t0;
        episodes++;
        floorClickable(slot, 'after the bail-out');
      },
      stuckUnlisted(slot: number): void {
        r.source.rects = [MAXIMIZED];
        r.listed = [TOP_W];
        r.show({ x: 900, y: 600, support: ON_TOP_W, boundsPx: boundsAt(900, 600) });
        r.listed = [];
        const t0 = r.timers.now;
        const stay = between(5000, 20_000);
        const polls = hover(stay);
        // One tick to see the cover, the cap, one poll to act on it.
        const late = polls.filter((p) => p.t - t0 > BAIL_GUARD_MAX_MS + 33 + 16);
        if (late.length === 0 || !late.every((p) => p.interactive)) fail(slot, `still guarded ${stay.toFixed(0)} ms on an unlisted support: ${JSON.stringify(late.filter((p) => !p.interactive).map((p) => Math.round(p.t - t0)))}`);
        expected.bailOut += BAIL_GUARD_MAX_MS;
        r.show({ x: 930, y: 900, support: { kind: 'air' }, jumpKind: 'down', boundsPx: boundsAt(930, 900) });
        const t1 = r.timers.now;
        r.run(between(200, 500));
        r.show({ x: 930, y: 1200 });
        expected.bailOut += r.timers.now - t1;
        episodes += 2;
        floorClickable(slot, 'after the stuck support');
      },
      floorNearSide(slot: number): void {
        const x = rand() < 0.5 ? between(130, 400) : between(1500, 1810);
        r.show({ x, y: 1200, state: 'walking', speed: 1 });
        const polls = hover(between(1000, 3000));
        if (polls.length === 0 || !polls.every((p) => p.interactive && p.reason === null)) fail(slot, `floor cat near a side at ${x.toFixed(0)} not clickable (RES-1)`);
        floorClickable(slot, 'after the walk');
      },
      taskbar(slot: number): void {
        bar.set('shown');
        r.show({ x: between(300, 1600), y: 1151, support: TASKBAR_LEDGE });
        const polls = hover(between(1000, 3000));
        if (!polls.every((p) => p.interactive && p.reason === null)) fail(slot, 'cat on the revealed taskbar not clickable (host guard)');
        bar.set('hidden');
        floorClickable(slot, 'after the taskbar hid');
      },
      staleChatter(slot: number): void {
        r.source.rects = [];
        let n = 0;
        r.source.fresh = () => n++ % 3 === 0;
        const y = between(300, 1000);
        r.show({ x: 44, y, support: CLING_LEFT, boundsPx: boundsAt(44, y) });
        const t0 = r.timers.now;
        const polls = hover(between(2000, 5000));
        if (polls.length === 0 || !polls.every((p) => p.interactive)) fail(slot, `stale chatter failed closed: ${JSON.stringify(polls.find((p) => !p.interactive))}`);
        r.source.fresh = true;
        r.show({ x: 44, y: 1200 });
        expected.band += r.timers.now - t0;
        episodes++;
        floorClickable(slot, 'after the chatter');
      },
      resume(slot: number): void {
        const withLock = rand() < 0.5;
        if (withLock) {
          r.os.locked = true;
          r.host.onSystem('lock');
          r.run(500);
        }
        r.host.onSystem('suspend');
        r.timers.stall(between(30_000, 600_000));
        r.host.onSystem('resume');
        r.run(1000);
        // Signed in; the unlock event is lost half the time.
        r.os.locked = false;
        if (withLock && rand() < 0.5) r.host.onSystem('unlock');
        r.run(LOCK_RECHECK_MS + 200);
        if (r.host.locked) fail(slot, 'still locked after the resume');
        floorClickable(slot, 'after the resume');
      },
    } satisfies Record<string, (slot: number) => void>;
    const names = Object.keys(scenarios) as Array<keyof typeof scenarios>;

    const SLOTS = 24 * 60;
    for (let slot = 0; slot < SLOTS; slot++) {
      const slotStart = r.timers.now;
      front();
      // Quiet: asleep on the floor, the cursor far away.
      r.set({ x: between(200, 1700), y: 1200, state: 'sleeping', clip: 'sleep', nextTickMs: 1000 });
      r.cursorAway();
      r.run(between(10_000, 30_000));
      const name = names[Math.floor(rand() * names.length)]!;
      counts[name] = (counts[name] ?? 0) + 1;
      scenarios[name](slot);
      r.listed = [];
      r.set({ x: between(200, 1700), y: 1200, state: 'sleeping', clip: 'sleep', nextTickMs: 1000 });
      r.cursorAway();
      const rest = 60_000 - (r.timers.now - slotStart);
      if (rest > 0) r.run(rest);
    }

    expect(violations).toEqual([]);
    expect(r.timers.now).toBeGreaterThanOrEqual(24 * 3_600_000);
    for (const n of names) expect(counts[n], n).toBeGreaterThan(100);
    const s = r.stats();
    // Each phase is seen from the first tick after it is scripted to the first tick after it ends: 33 ms either way.
    const tolerance = episodes * 40;
    for (const k of ['band', 'edgeFlight', 'bailOut'] as const) {
      expect(s.timeInGuardMs[k], k).toBeGreaterThan(expected[k] - tolerance);
      expect(s.timeInGuardMs[k], k).toBeLessThan(expected[k] + tolerance);
    }
    expect(s.episodes.bailOut).toBe((counts.bailOut ?? 0) + 2 * (counts.stuckUnlisted ?? 0));
    expect(s.bailOutsCapped).toBe(counts.stuckUnlisted ?? 0);
    expect(s.failClosedPolls).toBe(0);
    expect(s.staleGracePolls).toBeGreaterThan(0);
    expect(r.host.debug().lifecycle.lockRecoveries).toBeGreaterThan(0);
    // The info log is rate-limited: per channel (episodes, alerts) at most one guard line per GUARD_LOG_GAP_MS.
    const guardLines = r.logger.entries.filter((e) => e.level === 'info' && /guard/.test(e.msg));
    expect(guardLines.length).toBeGreaterThan(100);
    expect(guardLines.length).toBeLessThanOrEqual(2 * (Math.ceil(r.timers.now / GUARD_LOG_GAP_MS) + 1));
    expect(guardLines.some((e) => e.data?.end === 'capped')).toBe(true);
    r.host.stop();
  });
});
