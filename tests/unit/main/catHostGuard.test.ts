// v1.2 T8 click guard in the cat host (ADR 0003 §3, §6.1 (a)). REAL host and decideInteractive; the
// sim is scripted, or the real Mover replayed (as sim.ts copies support and jumpKind); the obstacle
// source and the provider are in-memory fakes (MOCKED native). The guard holds while the cat clings to
// a screen edge, flies to or from one or bails out, fails closed there, and only there: next to a
// screen side on the floor the cat stays clickable, pettable and grabbable.
import { describe, expect, it } from 'vitest';
import { decideInteractive } from '../../../src/core/interaction/clickThrough';
import { createCatHost, type HostOverlays, type HostSurfaceProvider } from '../../../src/main/catHost';
import type { ActivityMonitor, DisplayService, PerceptionService, Win32Api, WindowTracker } from '../../../src/main/contracts';
import { emptyBehaviorProfile } from '../../../src/shared/behaviorProfile';
import type { PersistedCat } from '../../../src/shared/catState';
import type { Point, Rect } from '../../../src/shared/geometry';
import { defaultSettings } from '../../../src/shared/settings';
import type { CatSim, SimOutput } from '../../../src/shared/sim';
import type { ScreenEdgeBand, Surface } from '../../../src/shared/surfaces';
import type { WorldGeometry } from '../../../src/shared/world';
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
    updateInteractivity: (_c, b) => blocked.push(b),
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

  it('a hidden cat has no guard', () => {
    const r = started();
    r.tick({ ...clinging, visible: false });
    expect(r.host.clickGuardRectsPx()).toEqual([]);
    expect(r.guard()).toMatchObject({ state: 'idle', reason: null });
    r.host.stop();
  });
});
