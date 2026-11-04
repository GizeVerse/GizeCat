// v1.2 T8 click guard in the cat host (ADR 0003 §3, §6.1 (a)). REAL host and decideInteractive; the
// sim is scripted, or the real Mover replayed (as sim.ts copies support and jumpKind); the obstacle
// source and the provider are in-memory fakes (MOCKED native). The guard holds while the cat clings to
// a screen edge, flies to or from one or bails out, fails closed there, and only there: next to a
// screen side on the floor the cat stays clickable, pettable and grabbable.
import { describe, expect, it } from 'vitest';
import { decideInteractive } from '../../../src/core/interaction/clickThrough';
import { createCatHost, type HostOverlays, type HostSurfaceProvider } from '../../../src/main/catHost';
import type { ActivityMonitor, DisplayService, PerceptionService, Win32Api, WindowTracker } from '../../../src/main/contracts';
import { CatScene } from '../../../src/renderer/overlay/scene';
import { emptyBehaviorProfile } from '../../../src/shared/behaviorProfile';
import type { CatRenderState } from '../../../src/shared/cat';
import type { PersistedCat } from '../../../src/shared/catState';
import type { Point, Rect } from '../../../src/shared/geometry';
import { defaultSettings } from '../../../src/shared/settings';
import type { CatSim, SimOutput } from '../../../src/shared/sim';
import type { ScreenEdgeBand, Surface } from '../../../src/shared/surfaces';
import type { WorldGeometry } from '../../../src/shared/world';
import { DEFAULT_LIMITS, env, FLOOR_Y, SINGLE, topId, wall, type Env } from '../core/movement/v12Fixtures';
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
const CLING: SimOutput['support'] = { kind: 'surface', surfaceId: 'screenEdge:1:left', surfaceKind: 'screenEdge', orientation: 'wall' };

/** The cat's upright bounds at size 1 and this scale, its anchor at (x, y). */
const boundsAt = (x: number, y: number, scale = SCALE): Rect => ({ x: x - 42 * scale, y: y - 64 * scale, width: 84 * scale, height: 64 * scale });
const centre = (r: Rect): Point => ({ x: r.x + r.width / 2, y: r.y + r.height / 2 });

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
    nextTickMs: 16,
    requests: [],
    ...over,
  };
}

interface RigOptions {
  world?: WorldGeometry;
  bands?: readonly ScreenEdgeBand[] | null;
  obstacles?: readonly Rect[];
  /** Each sim tick's output; a fixed floor cat by default. */
  next?: () => SimOutput;
  listed?: () => readonly Surface[];
  /** Whether the overlay manager stand-in asks for the guard rects on a poll; never by default. */
  asks?: (cursor: Point | null, blocked: boolean) => boolean;
}

function rig(o: RigOptions = {}) {
  const timers = manualTimers();
  let out = output();
  let next = o.next ?? ((): SimOutput => out);
  const sim: CatSim = {
    tick: () => next(),
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
  let cursor: Point = { x: 500, y: 500 };
  const source = {
    rects: o.obstacles ?? [MAXIMIZED],
    fresh: true,
    throws: false,
    calls: 0,
    watch: [] as boolean[],
  };
  const win32 = {
    available: true,
    getCursorPos: () => cursor,
    isLeftButtonDown: () => false,
    windowProcessId: () => null,
    mouseButtons: () => ({ down: false, presses: 0 }),
    clickObstaclesPx: () => {
      source.calls++;
      if (source.throws) throw new Error('enumeration failed');
      return { rects: source.rects, fresh: source.fresh };
    },
    setObstacleWatch: (armed: boolean) => source.watch.push(armed),
    obstacleStats: () => null,
  } as unknown as Win32Api;
  const tracker = { mode: 'event-hooks', drainEvents: () => [], getForeground: () => null, getPlatforms: () => [], getWindowRect: () => null, getFullscreenDisplayIds: () => [] } as unknown as WindowTracker;
  const activity = { sample: () => undefined, drainEvents: () => [], idleMs: 0, typing: false, typingIntensity: 0, cursorSpeed: 0 } as unknown as ActivityMonitor;
  const perception = { drainEvents: () => [], request: () => undefined } as unknown as PerceptionService;
  const world = o.world ?? WORLD;
  const display = { world, displayAt: () => world.displays[0]!.id } as unknown as DisplayService;
  const blocked: boolean[] = [];
  const overlays: HostOverlays = {
    render: () => undefined,
    updateInteractivity: (c, b) => {
      blocked.push(b);
      if (o.asks?.(c, b)) host.clickGuardRectsPx();
    },
    isCursorOverCat: () => false,
    dragging: false,
    pressed: false,
    interactive: false,
  };
  const settings = defaultSettings();
  const listed = o.listed ?? ((): readonly Surface[] => []);
  const surfaces = {
    getSurfaces: () => listed(),
    getSurface: () => null,
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
    logger: memoryLogger(),
    getSettings: () => settings,
    cursorFallback: () => null,
    clock: () => timers.now,
    wallClock: () => new Date(2026, 9, 28, 14, 30),
    timers,
    surfaces,
  });
  /** What the overlay manager decides with the cursor on the cat's hit region. */
  const interactiveOver = (hit: Rect, at: Point = centre(hit)): boolean =>
    decideInteractive({
      cursor: at,
      hitRects: [hit],
      excludeRects: host.clickGuardRectsPx(),
      interactive: false,
      interactionsEnabled: true,
      visible: true,
      rendererHealthy: true,
      dragging: false,
      hitRegionAgeMs: 10,
    });
  return {
    host,
    timers,
    source,
    settings,
    blocked,
    interactiveOver,
    guard: () => host.debug().clickGuard,
    setCursor: (p: Point) => (cursor = p),
    /** One host tick with this output. */
    tick(over: Partial<SimOutput> = {}): SimOutput {
      out = output(over);
      timers.advance(16);
      return out;
    },
    setNext: (fn: () => SimOutput) => (next = fn),
  };
}

function started(o: RigOptions = {}): ReturnType<typeof rig> {
  const r = rig(o);
  r.host.start();
  r.timers.advance(0);
  return r;
}

describe('T8 guard: a cat on the floor next to a screen side stays usable (RES-1)', () => {
  // 311 and 360 are within one body width of the left band, 1548 of the right one.
  it.each([130, 311, 360, 1548, 1810])('anchor %d over a maximized window: the overlay takes the mouse, no obstacle is read, no hook installed', (x) => {
    const r = started();
    const out = r.tick({ x, boundsPx: boundsAt(x, 1200) });
    expect(r.interactiveOver(out.boundsPx)).toBe(true);
    expect(r.guard()).toMatchObject({ state: 'idle', reason: null, rects: 0, armed: false });
    expect(r.source.calls).toBe(0);
    expect(r.source.watch).toEqual([]);
    r.host.stop();
  });

  it('also while it sits, sleeps or crouches there: only the support decides', () => {
    const r = started();
    for (const over of [{ state: 'sleeping', clip: 'sleep' }, { state: 'sitting', clip: 'sit' }, { clip: 'crouch' }] as Array<Partial<SimOutput>>) {
      const out = r.tick({ x: 200, boundsPx: boundsAt(200, 1200), ...over });
      expect(r.interactiveOver(out.boundsPx)).toBe(true);
    }
    r.host.stop();
  });
});

describe('T8 guard: where it still holds, and fails closed', () => {
  const clinging = { x: 44, y: 700, support: CLING, boundsPx: boundsAt(44, 700) };

  it('clinging: the window under the cat is cut out, so the click reaches the window', () => {
    const r = started();
    const out = r.tick(clinging);
    expect(r.interactiveOver(out.boundsPx)).toBe(false);
    expect(r.guard()).toMatchObject({ state: 'active', reason: 'band', armed: true, rects: 1 });
    r.host.stop();
  });

  it('clinging over the bare desktop: nothing to cut out, the deliberate grab still works', () => {
    const r = started({ obstacles: [] });
    const out = r.tick(clinging);
    expect(r.interactiveOver(out.boundsPx)).toBe(true);
    expect(r.guard()).toMatchObject({ state: 'active', reason: 'band', rects: 0 });
    r.host.stop();
  });

  it('clinging with a stale or failing obstacle source: click-through', () => {
    const r = started();
    const out = r.tick(clinging);
    r.source.fresh = false;
    expect(r.interactiveOver(out.boundsPx)).toBe(false);
    expect(r.guard()).toMatchObject({ state: 'failClosed', reason: 'band' });
    r.source.fresh = true;
    r.source.throws = true;
    expect(r.interactiveOver(out.boundsPx)).toBe(false);
    expect(r.guard()).toMatchObject({ state: 'failClosed', reason: 'band' });
    r.host.stop();
  });

  it('a flight from a screen edge is guarded until the landing, then the floor is free again', () => {
    const r = started();
    r.tick(clinging);
    const air = r.tick({ x: 120, y: 800, support: { kind: 'air' }, jumpKind: 'wallJump', boundsPx: boundsAt(120, 800) });
    expect(r.interactiveOver(air.boundsPx)).toBe(false);
    expect(r.guard()).toMatchObject({ state: 'active', reason: 'edgeFlight' });
    const landed = r.tick({ x: 200, boundsPx: boundsAt(200, 1200) });
    expect(r.interactiveOver(landed.boundsPx)).toBe(true);
    expect(r.guard()).toMatchObject({ state: 'idle', reason: null });
    r.host.stop();
  });

  it('a leap near a band counts as an edge flight (the band only matters for that test)', () => {
    const r = started();
    const air = r.tick({ x: 260, y: 900, support: { kind: 'air' }, jumpKind: 'leap', boundsPx: boundsAt(260, 900) });
    expect(r.guard().reason).toBe(null);
    expect(r.interactiveOver(air.boundsPx)).toBe(false);
    expect(r.guard()).toMatchObject({ state: 'active', reason: 'edgeFlight' });
    r.host.stop();
  });

  it('opted out of screen edges (no bands): a floor cat and a leap are not guarded, a cat clinging at the toggle still is (RES-2)', () => {
    const r = started({ bands: null });
    const floor = r.tick({ x: 200, boundsPx: boundsAt(200, 1200) });
    expect(r.interactiveOver(floor.boundsPx)).toBe(true);
    const leap = r.tick({ x: 200, y: 900, support: { kind: 'air' }, jumpKind: 'leap', boundsPx: boundsAt(200, 900) });
    expect(r.interactiveOver(leap.boundsPx)).toBe(true);
    expect(r.guard()).toMatchObject({ state: 'idle', reason: null, armed: false });
    expect(r.source.calls).toBe(0);
    const out = r.tick(clinging);
    expect(r.interactiveOver(out.boundsPx)).toBe(false);
    expect(r.guard()).toMatchObject({ state: 'active', reason: 'band' });
    r.host.stop();
  });

  it('a hidden cat has no guard', () => {
    const r = started();
    r.tick({ ...clinging, visible: false });
    expect(r.host.clickGuardRectsPx()).toEqual([]);
    expect(r.guard()).toMatchObject({ state: 'idle', reason: null });
    r.host.stop();
  });
});

describe('T8 guard: read only while an overlay asks (RES-5)', () => {
  const clinging = { x: 44, y: 700, support: CLING, boundsPx: boundsAt(44, 700) };

  it('with the cursor off the cat, or interactions blocked, the windows are not read and the hooks come off', () => {
    let onCat = true;
    // As the real overlay manager does (overlayManager.test.ts): asked only over the cat, when not blocked.
    const r = started({ asks: (_c, blocked) => onCat && !blocked });
    for (let i = 0; i < 10; i++) r.tick(clinging);
    expect(r.source.calls).toBeGreaterThan(0);
    expect(r.source.watch).toEqual([true]);
    expect(r.guard()).toMatchObject({ state: 'active', reason: 'band', armed: true });

    // Cursor away, a minute on the wall: nothing read, the hooks gone after the quiet spell, no churn.
    onCat = false;
    const calls = r.source.calls;
    r.tick(clinging);
    expect(r.guard()).toMatchObject({ state: 'idle', reason: null });
    for (let i = 0; i < 3750; i++) r.tick(clinging);
    expect(r.source.calls).toBe(calls);
    expect(r.source.watch).toEqual([true, false]);
    expect(r.guard()).toMatchObject({ state: 'idle', armed: false });

    // Back on the cat: read and hooked at once.
    onCat = true;
    for (let i = 0; i < 10; i++) r.tick(clinging);
    expect(r.source.calls).toBeGreaterThan(calls);
    expect(r.source.watch).toEqual([true, false, true]);

    // Paused with the cursor still on it: no read, hooks off again.
    r.host.setPaused(true);
    const paused = r.source.calls;
    for (let i = 0; i < 300; i++) r.tick(clinging);
    expect(r.source.calls).toBe(paused);
    expect(r.source.watch).toEqual([true, false, true, false]);
    expect(r.blocked.at(-1)).toBe(true);
    r.host.stop();
  });

  it('interactions turned off: the same', () => {
    const r = started({ asks: (_c, blocked) => !blocked });
    for (let i = 0; i < 10; i++) r.tick(clinging);
    expect(r.source.watch).toEqual([true]);
    r.settings.interaction.enabled = false;
    const calls = r.source.calls;
    for (let i = 0; i < 300; i++) r.tick(clinging);
    expect(r.source.calls).toBe(calls);
    expect(r.source.watch).toEqual([true, false]);
    r.host.stop();
  });
});

describe('T8 guard: the renderer hit rects reach past the sim bounds at large scales and sizes (real CatScene; SEC-3)', () => {
  const worldAt = (scale: number): WorldGeometry => ({
    version: 1,
    displays: [{ id: '1', primary: true, scaleFactor: scale, boundsDip: { x: 0, y: 0, width: 1920 / scale, height: 1200 / scale }, workAreaDip: { x: 0, y: 0, width: 1920 / scale, height: 1200 / scale }, boundsPx: SCREEN, workAreaPx: SCREEN }],
  });
  const ANCHOR_DIP = { x: 40, y: 300 };

  /** What the renderer reports for a cat climbing a left screen edge (hind paws and tail base below the grip), px. */
  function climbingHitRectsPx(size: number, sf: number): Rect[] {
    const scene = new CatScene(() => 0.99);
    const state = (t: number): CatRenderState => ({
      seq: Math.round(t),
      t,
      x: ANCHOR_DIP.x,
      y: ANCHOR_DIP.y,
      snap: false,
      scale: size,
      facing: -1,
      state: 'idle',
      clip: 'climb',
      clipStartedAt: 0,
      speed: 0.5,
      vy: 0,
      look: null,
      arousal: 0.3,
      contentment: 0.5,
      emote: null,
      emoteStartedAt: 0,
      opacity: 1,
      visible: true,
      skin: 'ginger',
      style: 'smooth',
      shadow: true,
      animSpeed: 1,
    });
    for (let t = 0; t <= 1800; t += 16) scene.update({ x: ANCHOR_DIP.x, y: ANCHOR_DIP.y, state: state(t), simTime: t, dtMs: t === 0 ? 0 : 16, snapped: t === 0 });
    return scene.hitRects.filter((r) => r.width > 0 && r.height > 0).map((r) => ({ x: r.x * sf, y: r.y * sf, width: r.width * sf, height: r.height * sf }));
  }

  /** The sim's clinging bounds (simCore bodyBounds): from a body width above the anchor down to it. */
  function climbingBounds(size: number, sf: number): Rect {
    const bw = 84 * size * sf;
    const bh = 64 * size * sf;
    return { x: ANCHOR_DIP.x * sf - bw / 2, y: ANCHOR_DIP.y * sf - bw, width: bw + 0.15 * bh, height: bw };
  }

  function clinging(size: number, sf: number, obstacles: readonly Rect[]): { r: ReturnType<typeof rig>; hits: Rect[]; lowest: Rect } {
    const r = rig({ world: worldAt(sf), bands: BANDS, obstacles });
    r.settings.appearance.size = size;
    r.host.start();
    r.timers.advance(0);
    r.tick({ x: ANCHOR_DIP.x * sf, y: ANCHOR_DIP.y * sf, support: CLING, boundsPx: climbingBounds(size, sf) });
    const hits = climbingHitRectsPx(size, sf);
    const lowest = hits.reduce((a, b) => (b.y + b.height > a.y + a.height ? b : a));
    return { r, hits, lowest };
  }

  const CASES: ReadonlyArray<[number, number]> = [
    [1, 1],
    [1, 1.5],
    [1, 2],
    [1.5, 1],
    [2, 1],
    [2.5, 1],
    [1.5, 2],
    [2.5, 2],
  ];

  it.each(CASES)('failing closed at size %d, scale %d: nothing of the cat takes the mouse, down to its lowest hit rect', (size, sf) => {
    const { r, hits, lowest } = clinging(size, sf, []);
    const bounds = climbingBounds(size, sf);
    r.source.fresh = false;
    expect(r.interactiveOver(lowest, { x: lowest.x + lowest.width / 2, y: lowest.y + lowest.height - 0.5 }), `lowest hit rect ends ${lowest.y + lowest.height - (bounds.y + bounds.height)} px below the bounds`).toBe(false);
    for (const h of hits) expect(r.interactiveOver(h)).toBe(false);
    expect(r.guard().state).toBe('failClosed');
    r.host.stop();
  });

  it.each([
    [2.5, 1],
    [2.5, 2],
    [1.5, 2],
  ] as ReadonlyArray<[number, number]>)('active at size %d, scale %d: a window just past the old fixed reach is cut out of the hit rects over it', (size, sf) => {
    const bounds = climbingBounds(size, sf);
    const bottom = bounds.y + bounds.height;
    // The obstacle's grown top lands 1 px below bounds + 16 px: it used to be filtered out.
    const top = bottom + 16 + Math.ceil(8 * sf) + 1;
    const { r, lowest } = clinging(size, sf, [{ x: 0, y: top, width: 1920, height: 1200 - top }]);
    const cursorY = lowest.y + lowest.height - 0.5;
    expect(cursorY, 'the hit rect reaches into that window').toBeGreaterThan(top);
    expect(r.interactiveOver(lowest, { x: lowest.x + lowest.width / 2, y: cursorY })).toBe(false);
    expect(r.guard()).toMatchObject({ state: 'active', reason: 'band', rects: 1 });
    r.host.stop();
  });

  it('an obstacle out of the reach of any hit rect is not reported', () => {
    const { r } = clinging(1, 1, [{ x: 1500, y: 800, width: 300, height: 300 }]);
    expect(r.host.clickGuardRectsPx()).toEqual([]);
    r.host.stop();
  });
});

describe('T8 guard: a bail-out holds it until the landing or the catch (real Mover replayed; SEC-1, SEC-2)', () => {
  const FULL: Rect = { x: -8, y: -8, width: 1936, height: 1096 };
  const BAIL = { bailOut: true, ...DEFAULT_LIMITS } as const;

  /** Cat standing on window w's top (x 600..1400, y) at x = 900, as bailOut.test.ts sets it up. */
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

  /** The host over this Mover: one sim tick per host tick, the list as the provider would serve it. */
  function replay(e: Env): ReturnType<typeof rig> & { step(): SimOutput } {
    let last = output();
    const r = rig({
      world: SINGLE,
      bands: null,
      obstacles: [FULL],
      next: () => {
        e.step();
        last = output({ x: e.m.x, y: e.m.y, support: e.m.support, jumpKind: e.m.jumpKind, boundsPx: boundsAt(e.m.x, e.m.y, 1) });
        return last;
      },
      listed: () => e.surfaces().filter((s) => !e.hidden.has(s.id) && !e.gone.has(s.id)),
    });
    r.host.start();
    r.timers.advance(0);
    return Object.assign(r, {
      step(): SimOutput {
        r.timers.advance(16);
        return last;
      },
    });
  }

  /** Every step until `done`: the cursor on the cat reaches the window, never the cat. */
  function guardedUntil(r: ReturnType<typeof replay>, done: () => boolean, maxSteps = 800): number {
    let steps = 0;
    while (!done()) {
      expect(++steps, 'it got there').toBeLessThan(maxSteps);
      const out = r.step();
      if (done()) break;
      expect(r.interactiveOver(out.boundsPx), `step ${steps}, support ${out.support.kind}, jump ${out.jumpKind ?? null}`).toBe(false);
      expect(r.guard(), `step ${steps}`).toMatchObject({ state: 'active', reason: 'bailOut', rects: 1 });
    }
    return steps;
  }

  const vanish = (e: Env): void => {
    e.windows = {};
    e.gone.add(topId('w'));
  };

  it('maximized, minimized or closed support: from the very first tick, also over the bail-out crouch, until the landing', () => {
    const e = onWindow();
    const r = replay(e);
    const before = r.step();
    expect(before.support).toMatchObject({ kind: 'surface', surfaceId: topId('w') });
    expect(r.interactiveOver(before.boundsPx), 'on a visible window top the cat takes the mouse').toBe(true);
    vanish(e);
    const steps = guardedUntil(r, () => e.m.support.kind === 'floor');
    expect(steps).toBeGreaterThan(8);
    const landed = r.step();
    expect(landed.support.kind).toBe('floor');
    expect(r.interactiveOver(landed.boundsPx), 'on the floor afterwards it takes the mouse again').toBe(true);
    expect(r.guard()).toMatchObject({ state: 'idle', reason: null });
    r.host.stop();
  });

  it('the guard is armed on the vanish although the support already reads as air', () => {
    const e = onWindow();
    const r = replay(e);
    r.step();
    vanish(e);
    const first = r.step();
    expect(first.support.kind).toBe('air');
    expect(e.m.bailingOut).toBe(true);
    expect(r.interactiveOver(first.boundsPx)).toBe(false);
    expect(r.guard().reason).toBe('bailOut');
    r.host.stop();
  });

  it('no headroom any more (the window moved up under the top of the screen, still listed): the same', () => {
    const e = onWindow();
    const r = replay(e);
    r.step();
    e.windows = { w: { x: 600, y: 20, width: 800, height: FLOOR_Y - 20 } };
    const first = r.step();
    expect(e.m.bailingOut).toBe(true);
    expect(r.interactiveOver(first.boundsPx)).toBe(false);
    expect(r.guard().reason).toBe('bailOut');
    guardedUntil(r, () => e.m.support.kind === 'floor');
    r.host.stop();
  });

  /** bailOut.test.ts case 3: nothing to jump to within H_max, a window side in reach. */
  function wallBailOut(): { e: Env; r: ReturnType<typeof replay> } {
    const e = onWindow(200);
    e.windows = { w: { x: 500, y: 200, width: 480, height: 840 } };
    e.extra = [wall('u', 'left', 1000, 150, FLOOR_Y, { topLedgeId: null })];
    e.step();
    return { e, r: replay(e) };
  }

  it.each([
    ['covered', (e: Env): void => void e.hidden.add(topId('w'))],
    ['vanished', vanish],
  ])('%s, the way off a leap onto a window side: through the whole leap (the wall reads as support from the take-off on), gone after the catch', (_name, lose) => {
    const { e, r } = wallBailOut();
    r.step();
    lose(e);
    let leapSteps = 0;
    const caught = (): boolean => e.m.bailOutKind === 'wall' && e.m.onWall && e.m.climbPhase !== 'leap';
    let steps = 0;
    while (!caught()) {
      expect(++steps, 'it got there').toBeLessThan(800);
      const out = r.step();
      if (caught()) break;
      if (out.jumpKind === 'leap') {
        leapSteps++;
        expect(out.support).toMatchObject({ kind: 'surface', surfaceKind: 'windowSide', orientation: 'wall' });
      }
      expect(r.interactiveOver(out.boundsPx), `step ${steps}`).toBe(false);
      expect(r.guard().reason, `step ${steps}`).toBe('bailOut');
    }
    expect(leapSteps, 'the leap was seen').toBeGreaterThan(5);
    expect(e.m.bailingOut).toBe(false);
    const held = r.step();
    expect(held.support).toMatchObject({ surfaceKind: 'windowSide' });
    expect(r.host.clickGuardRectsPx()).toEqual([]);
    expect(r.guard()).toMatchObject({ state: 'idle', reason: null });
    r.host.stop();
  });

  describe('and only then', () => {
    const top: Surface = { id: topId('w'), kind: 'windowTop', ownerId: 'w', displayId: '1', orientation: 'ledge', y: 600, x0: 600, x1: 1400, rest: null, focusX: null, phase: 'stable', vx: 0, vy: 0, confidence: 1, validatedAt: 0, excluded: false };
    const onTop: SimOutput['support'] = { kind: 'surface', surfaceId: top.id, surfaceKind: 'windowTop', orientation: 'ledge' };

    it.each(['hop', 'up', 'across', 'down', 'pounce'] as const)('a voluntary %s off a visible window top is not guarded', (jumpKind) => {
      const r = started({ listed: () => [top] });
      r.tick({ x: 900, y: 600, support: onTop, boundsPx: boundsAt(900, 600) });
      const air = r.tick({ x: 920, y: 590, support: { kind: 'air' }, jumpKind, boundsPx: boundsAt(920, 590) });
      expect(r.interactiveOver(air.boundsPx)).toBe(true);
      expect(r.guard()).toMatchObject({ state: 'idle', reason: null });
      r.host.stop();
    });

    it('a voluntary hang-and-drop off a window side is not guarded either', () => {
      const side = wall('w', 'left', 600, 600, 1000);
      const r = started({ listed: () => [side] });
      r.tick({ x: 590, y: 800, support: { kind: 'surface', surfaceId: side.id, surfaceKind: 'windowSide', orientation: 'wall' }, boundsPx: boundsAt(590, 800) });
      const air = r.tick({ x: 580, y: 810, support: { kind: 'air' }, jumpKind: null, boundsPx: boundsAt(580, 810) });
      expect(r.interactiveOver(air.boundsPx)).toBe(true);
      r.host.stop();
    });

    it("a cat on a tab strip's walkable window top (land) has not lost its support", () => {
      const strip: Surface = { ...top, id: 'tabStrip:w', kind: 'tabStrip', x0: 700, x1: 1000, land: { x0: 600, x1: 1400 } };
      const r = started({ listed: () => [strip] });
      const out = r.tick({ x: 1200, y: 600, support: { kind: 'surface', surfaceId: strip.id, surfaceKind: 'tabStrip', orientation: 'ledge' }, boundsPx: boundsAt(1200, 600) });
      expect(r.interactiveOver(out.boundsPx)).toBe(true);
      r.host.stop();
    });

    it('a user drag ends the guard: the grab is the landing', () => {
      const r = started({ listed: () => [] });
      r.tick({ x: 900, y: 600, support: onTop, boundsPx: boundsAt(900, 600) });
      const lost = r.tick({ x: 900, y: 600, support: { kind: 'air' }, boundsPx: boundsAt(900, 600) });
      expect(r.interactiveOver(lost.boundsPx)).toBe(false);
      const held = r.tick({ x: 900, y: 600, support: { kind: 'held' }, boundsPx: boundsAt(900, 600) });
      expect(r.interactiveOver(held.boundsPx)).toBe(true);
      r.host.stop();
    });
  });
});
