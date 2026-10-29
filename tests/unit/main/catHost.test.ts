import { describe, expect, it } from 'vitest';
import { createCatHost, type HostOverlays, type HostSurfaceProvider } from '../../../src/main/catHost';
import type { ActivityMonitor, DisplayService, PerceptionService, TaskbarState, TaskbarTracker, Win32Api, WindowTracker } from '../../../src/main/contracts';
import type { CatPosition } from '../../../src/main/surfaces';
import type { Point } from '../../../src/shared/geometry';
import type { PersistedCat } from '../../../src/shared/catState';
import { defaultSettings } from '../../../src/shared/settings';
import type { CatSim, SimEnv, SimEvent, SimOutput, SimRequest } from '../../../src/shared/sim';
import type { ProviderDiagnostics } from '../../../src/shared/surfaceDiagnostics';
import type { LedgeSurface, Surface, SurfaceStatus } from '../../../src/shared/surfaces';
import type { WorldGeometry } from '../../../src/shared/world';
import { manualTimers, memoryLogger } from './helpers';

const world: WorldGeometry = {
  version: 1,
  displays: [
    {
      id: '1',
      primary: true,
      scaleFactor: 1,
      boundsDip: { x: 0, y: 0, width: 1920, height: 1080 },
      workAreaDip: { x: 0, y: 0, width: 1920, height: 1040 },
      boundsPx: { x: 0, y: 0, width: 1920, height: 1080 },
      workAreaPx: { x: 0, y: 0, width: 1920, height: 1040 },
    },
  ],
};

function makeOutput(over: Partial<SimOutput> = {}): SimOutput {
  return {
    x: 100,
    y: 1040,
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
    boundsPx: { x: 60, y: 980, width: 84, height: 64 },
    nextTickMs: 33,
    requests: [],
    ...over,
  };
}

interface HarnessOptions {
  win32Available?: boolean;
  timeScale?: number;
  surfaces?: HostSurfaceProvider | null;
  taskbars?: TaskbarTracker | null;
}

function harness(opts: HarnessOptions = {}) {
  const timers = manualTimers();
  const ticks: Array<{ env: SimEnv; events: readonly SimEvent[] }> = [];
  let nextTickMs = 33;
  let requests: SimRequest[] = [];
  let throwNext = false;
  let output: Partial<SimOutput> = {};
  const sim: CatSim = {
    tick(env, events) {
      if (throwNext) {
        throwNext = false;
        throw new Error('sim bug');
      }
      ticks.push({ env, events: [...events] });
      const out = makeOutput({ ...output, nextTickMs, requests });
      requests = [];
      return out;
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
  };
  let cursor: Point = { x: 500, y: 500 };
  const win32 = {
    available: opts.win32Available ?? true,
    getCursorPos: () => cursor,
    isLeftButtonDown: () => false,
  } as unknown as Win32Api;
  const trackerEvents: SimEvent[] = [];
  let platformCalls = 0;
  const tracker = {
    mode: 'event-hooks',
    drainEvents: () => trackerEvents.splice(0),
    getForeground: () => null,
    getPlatforms: () => {
      platformCalls++;
      return [];
    },
    getWindowRect: () => null,
    getFullscreenDisplayIds: () => [],
  } as unknown as WindowTracker;
  const activity = {
    sample: () => undefined,
    drainEvents: () => [],
    idleMs: 1234,
    typing: false,
    typingIntensity: 0,
    cursorSpeed: 42,
  } as unknown as ActivityMonitor;
  const perceptionCalls: unknown[] = [];
  const perception = {
    drainEvents: () => [],
    request: (reason: string, focus: unknown) => perceptionCalls.push([reason, focus]),
  } as unknown as PerceptionService;
  const display = { world } as unknown as DisplayService;
  const renders: Array<{ hidden: boolean; simNow: number }> = [];
  const interactivity: boolean[] = [];
  const overlays: HostOverlays = {
    render: (_out, simNow, hidden) => renders.push({ simNow, hidden }),
    updateInteractivity: (_c, blocked) => interactivity.push(blocked),
    isCursorOverCat: () => false,
    dragging: false,
    pressed: false,
    interactive: false,
  };
  let saves = 0;
  const settings = defaultSettings();
  const log = memoryLogger();
  const host = createCatHost({
    sim,
    win32,
    tracker,
    activity,
    perception,
    display,
    overlays,
    catStore: { markDirty: () => undefined, save: () => Promise.resolve(Boolean(++saves)) },
    logger: log,
    getSettings: () => settings,
    cursorFallback: () => ({ x: 7, y: 8 }),
    clock: () => timers.now,
    wallClock: () => new Date(2026, 9, 28, 14, 30),
    timers,
    timeScale: opts.timeScale ?? 1,
    surfaces: opts.surfaces,
    taskbars: opts.taskbars,
  });
  return {
    host,
    timers,
    ticks,
    renders,
    interactivity,
    perceptionCalls,
    trackerEvents,
    log,
    settings,
    get saves() {
      return saves;
    },
    get platformCalls() {
      return platformCalls;
    },
    setNextTick: (ms: number) => (nextTickMs = ms),
    setOutput: (o: Partial<SimOutput>) => (output = o),
    setCursor: (p: Point) => (cursor = p),
    setRequests: (r: SimRequest[]) => (requests = r),
    throwNext: () => (throwNext = true),
  };
}

describe('cat host loop', () => {
  it('ticks immediately on start and then follows nextTickMs within [16, 1000]', () => {
    const h = harness();
    h.host.start();
    h.timers.advance(0);
    expect(h.ticks).toHaveLength(1);
    expect(h.ticks[0]!.env).toMatchObject({ dt: 0, cursor: { x: 500, y: 500, speed: 42 }, userIdleMs: 1234, localHour: 14.5, paused: false, hidden: false });
    // One render per host tick (catch-up sub-steps call sim.tick more than once).
    h.setNextTick(5);
    h.timers.advance(33);
    expect(h.renders).toHaveLength(2);
    h.setNextTick(5000);
    h.timers.advance(16);
    expect(h.renders).toHaveLength(3);
    h.timers.advance(999);
    expect(h.renders).toHaveLength(3);
    h.timers.advance(1);
    expect(h.renders).toHaveLength(4);
    h.host.stop();
  });

  it('keeps each step <= 250 ms but catches up gaps up to 1 s, so sim time tracks real time', () => {
    const h = harness();
    h.setNextTick(1000);
    h.host.start();
    h.timers.advance(1000);
    expect(h.ticks.at(-1)!.env.dt).toBe(250);
    expect(h.renders.at(-1)!.simNow).toBe(1000);
    h.host.stop();
  });

  it('clamps stalls longer than 1 s (no catch-up storm)', () => {
    const h = harness();
    h.setNextTick(1000);
    h.host.start();
    h.timers.advance(0);
    const before = h.ticks.length;
    h.timers.stall(5000);
    h.timers.advance(0);
    expect(h.ticks.length - before).toBe(4);
    expect(h.renders.at(-1)!.simNow).toBe(1000);
    expect(h.ticks.every((t) => t.env.dt <= 250)).toBe(true);
    h.host.stop();
  });

  it('sub-steps with a time scale and delivers events only on the first step', () => {
    const h = harness({ timeScale: 4 });
    h.setNextTick(100);
    h.host.start();
    h.timers.advance(0);
    h.trackerEvents.push({ type: 'system.unlock' });
    h.timers.advance(100);
    const last = h.ticks.slice(-2);
    expect(last.map((t) => t.env.dt)).toEqual([200, 200]);
    expect(last[0]!.events).toEqual([{ type: 'system.unlock' }]);
    expect(last[1]!.events).toEqual([]);
    expect(h.renders.at(-1)!.simNow).toBe(400);
    h.host.stop();
  });

  it('enqueued events nudge a slow loop so interaction is not delayed', () => {
    const h = harness();
    h.setNextTick(1000);
    h.host.start();
    h.timers.advance(100);
    expect(h.ticks).toHaveLength(1);
    h.host.enqueue({ type: 'command.play' });
    h.timers.advance(0);
    expect(h.ticks).toHaveLength(2);
    expect(h.ticks[1]!.events).toEqual([{ type: 'command.play' }]);
    h.host.stop();
  });

  it('dispatches save, perception and quitReady requests', async () => {
    const h = harness();
    h.host.start();
    h.timers.advance(0);
    h.setRequests([{ type: 'save' }, { type: 'perception', reason: 'curious', focus: { x: 1, y: 2 } }]);
    h.timers.advance(33);
    expect(h.saves).toBe(1);
    expect(h.perceptionCalls).toEqual([['curious', { x: 1, y: 2 }]]);
    let quitDone = false;
    const quit = h.host.requestQuit().then(() => (quitDone = true));
    // Nudged ticks still respect the 16 ms minimum spacing.
    h.timers.advance(16);
    expect(h.ticks.at(-1)!.events).toContainEqual({ type: 'lifecycle.quitRequested' });
    expect(quitDone).toBe(false);
    h.setRequests([{ type: 'quitReady' }]);
    h.timers.advance(33);
    await quit;
    expect(quitDone).toBe(true);
    h.host.stop();
  });

  it('hidden: renders hidden, ticks slowly, polls minimally and skips perception', () => {
    const h = harness();
    h.host.start();
    h.timers.advance(0);
    h.host.setHidden(true);
    h.timers.advance(16);
    expect(h.renders.at(-1)!.hidden).toBe(true);
    expect(h.ticks.at(-1)!.env.hidden).toBe(true);
    const before = h.ticks.length;
    h.timers.advance(249);
    expect(h.ticks.length).toBe(before);
    h.timers.advance(1);
    expect(h.ticks.length).toBe(before + 1);
    h.setRequests([{ type: 'perception', reason: 'periodic', focus: { x: 0, y: 0 } }]);
    h.timers.advance(250);
    expect(h.perceptionCalls).toEqual([]);
    expect(h.interactivity.at(-1)).toBe(true);
    h.host.callCat({ x: 3, y: 4 });
    expect(h.host.hidden).toBe(false);
    h.timers.advance(16);
    expect(h.ticks.at(-1)!.events).toContainEqual({ type: 'command.callCat', at: { x: 3, y: 4 } });
    h.host.stop();
  });

  it('blocks interactivity while paused or when interactions are disabled', () => {
    const h = harness();
    h.host.start();
    h.timers.advance(0);
    expect(h.interactivity.at(-1)).toBe(false);
    h.host.setPaused(true);
    h.timers.advance(200);
    expect(h.interactivity.at(-1)).toBe(true);
    expect(h.ticks.at(-1)!.env.paused).toBe(true);
    h.host.setPaused(false);
    h.settings.interaction.enabled = false;
    h.timers.advance(200);
    expect(h.interactivity.at(-1)).toBe(true);
    h.host.stop();
  });

  it('survives a throwing simulation and keeps ticking', () => {
    const h = harness();
    h.host.start();
    h.timers.advance(0);
    h.throwNext();
    h.timers.advance(33);
    expect(h.log.entries.some((e) => e.level === 'error' && e.msg === 'simulation tick failed')).toBe(true);
    const n = h.renders.length;
    h.timers.advance(1000);
    expect(h.renders.length).toBe(n + 1);
    // The 1 s back-off is caught up, so sim time does not fall behind real time.
    expect(h.renders.at(-1)!.simNow).toBeGreaterThanOrEqual(1000);
    expect(h.host.debug().tickErrors).toBe(1);
    h.host.stop();
  });

  it('falls back to the Electron cursor without Win32 and stops cleanly', () => {
    const h = harness({ win32Available: false });
    h.host.start();
    h.timers.advance(0);
    expect(h.ticks[0]!.env.cursor).toMatchObject({ x: 7, y: 8 });
    h.host.stop();
    expect(h.timers.size).toBe(0);
    h.timers.advance(5000);
    expect(h.ticks).toHaveLength(1);
  });
});

// v1.1 surfaces: the host hands the provider's list to the sim and drives taskbar sampling
// from its cursor-poll timer (MOCKED provider and taskbar tracker).
const ledgeAt = (id: string, y: number): LedgeSurface => ({
  id,
  kind: 'taskbar',
  orientation: 'ledge',
  ownerId: id.split(':')[1] ?? id,
  displayId: '1',
  phase: 'stable',
  vx: 0,
  vy: 0,
  confidence: 1,
  validatedAt: 0,
  excluded: false,
  y,
  x0: 0,
  x1: 1920,
  rest: null,
  focusX: null,
  edge: 'bottom',
});

class FakeProvider implements HostSurfaceProvider {
  list: readonly Surface[] = [ledgeAt('taskbar:1', 1020)];
  calls: Array<{ now: number; maxAgeMs: number }> = [];
  live: Array<{ id: string; now: number }> = [];
  cats: Array<CatPosition | null> = [];
  events: SimEvent[] = [];
  throwOnRead = false;
  readonly status: SurfaceStatus = { taskbar: 'tracked', taskbars: 1, windowSurfaces: 'tracked', tabStrips: 'idle', tabStripReason: null };
  getSurfaces(now: number, maxAgeMs: number): readonly Surface[] {
    this.calls.push({ now, maxAgeMs });
    if (this.throwOnRead) throw new Error('provider bug');
    return this.list;
  }
  getSurface(id: string, now: number): Surface | null {
    this.live.push({ id, now });
    if (this.throwOnRead) throw new Error('provider bug');
    return this.list.find((s) => s.id === id) ?? null;
  }
  drainEvents(): SimEvent[] {
    return this.events.splice(0);
  }
  noteCat(cat: CatPosition | null): void {
    this.cats.push(cat);
  }
  updateSettings(): void {}
  debugInfo(): Record<string, unknown> {
    return {};
  }
  diagnostics(): ProviderDiagnostics {
    throw new Error('not used by these tests');
  }
  dispose(): Promise<void> {
    return Promise.resolve();
  }
}

class FakeTaskbarTracker implements TaskbarTracker {
  available = true;
  delay = 250;
  states: TaskbarState[] = [];
  samples: Array<{ now: number; cursor: Point | null; catNear: boolean }> = [];
  throwOnSample = false;
  start(): void {}
  stop(): void {}
  sample(now: number, cursor: Point | null, catNear: boolean): number {
    this.samples.push({ now, cursor, catNear });
    if (this.throwOnSample) throw new Error('taskbar bug');
    return this.delay;
  }
  taskbars(): readonly TaskbarState[] {
    return this.states;
  }
  surfaces(): readonly LedgeSurface[] {
    return [];
  }
  drainEvents(): SimEvent[] {
    return [];
  }
  debugInfo(): Record<string, unknown> {
    return {};
  }
}

const autoHideBar = (phase: TaskbarState['phase'], over: Partial<TaskbarState> = {}): TaskbarState => ({
  id: '1',
  displayId: '1',
  edge: 'bottom',
  autoHide: true,
  rect: phase === 'hidden' ? { x: 0, y: 1078, width: 1920, height: 48 } : { x: 0, y: 1032, width: 1920, height: 48 },
  dockedRect: { x: 0, y: 1032, width: 1920, height: 48 },
  shownFraction: phase === 'hidden' ? 0.04 : 1,
  phase,
  speed: 0,
  validatedAt: 0,
  ...over,
});

describe('cat host: environment surfaces', () => {
  it('hands the provider list to the sim each tick, keeps the v1 platform fields and re-reads ridden surfaces live', () => {
    const surfaces = new FakeProvider();
    const h = harness({ surfaces });
    h.host.start();
    h.timers.advance(0);
    const env = h.ticks[0]!.env;
    expect(env.surfaces).toBe(surfaces.list);
    expect(surfaces.calls[0]).toEqual({ now: 0, maxAgeMs: 1000 });
    h.timers.advance(20);
    expect(env.getSurface('taskbar:1')).toMatchObject({ y: 1020 });
    expect(surfaces.live.at(-1)).toEqual({ id: 'taskbar:1', now: 20 });
    expect(h.host.lastSurfaces).toBe(surfaces.list);
    expect(h.host.debug().surfaces).toBe(1);
    h.host.stop();
  });

  it('tells the provider where the cat is and what it stands on, also while hidden (it stays on its surface)', () => {
    const surfaces = new FakeProvider();
    const h = harness({ surfaces });
    h.setOutput({ x: 640, y: 1020, support: { kind: 'surface', surfaceId: 'taskbar:1', surfaceKind: 'taskbar', orientation: 'ledge' } });
    h.host.start();
    h.timers.advance(0);
    expect(surfaces.cats[0]).toBeNull();
    h.timers.advance(33);
    expect(surfaces.cats.at(-1)).toEqual({ x: 640, y: 1020, surfaceId: 'taskbar:1', hidden: false });
    h.setOutput({ x: 10, y: 1040 });
    h.timers.advance(33);
    h.timers.advance(33);
    expect(surfaces.cats.at(-1)).toEqual({ x: 10, y: 1040, surfaceId: null, hidden: false });
    h.setOutput({ x: 1000, y: 400, support: { kind: 'surface', surfaceId: 'windowTop:101', surfaceKind: 'windowTop', orientation: 'ledge' } });
    h.timers.advance(33);
    h.host.setHidden(true);
    h.timers.advance(300);
    // The attachment is kept (the provider serves the part of the edge the cat is on); only
    // tab-strip interest stops.
    expect(surfaces.cats.at(-1)).toEqual({ x: 1000, y: 400, surfaceId: 'windowTop:101', hidden: true });
    expect(surfaces.calls.at(-1)!.maxAgeMs).toBe(5000);
    h.host.stop();
  });

  it('drains surface events into the sim, after the window tracker', () => {
    const surfaces = new FakeProvider();
    const h = harness({ surfaces });
    h.host.start();
    h.timers.advance(0);
    h.trackerEvents.push({ type: 'window.minimized', id: '7' });
    surfaces.events.push({ type: 'taskbar.shown', surfaceId: 'taskbar:1', displayId: '1', edge: 'bottom' });
    h.timers.advance(33);
    expect(h.ticks.at(-1)!.events).toEqual([
      { type: 'window.minimized', id: '7' },
      { type: 'taskbar.shown', surfaceId: 'taskbar:1', displayId: '1', edge: 'bottom' },
    ]);
    h.host.stop();
  });

  it('survives a throwing provider (empty surfaces, null live reads)', () => {
    const surfaces = new FakeProvider();
    surfaces.throwOnRead = true;
    const h = harness({ surfaces });
    h.host.start();
    h.timers.advance(0);
    expect(h.ticks[0]!.env.surfaces).toEqual([]);
    expect(h.ticks[0]!.env.getSurface('taskbar:1')).toBeNull();
    h.timers.advance(100);
    expect(h.ticks.length).toBeGreaterThan(1);
    expect(h.host.debug().tickErrors).toBe(0);
    h.host.stop();
  });

  it('without a provider the sim sees no surfaces', () => {
    const h = harness();
    h.host.start();
    h.timers.advance(0);
    expect(h.ticks[0]!.env.surfaces).toEqual([]);
    expect(h.ticks[0]!.env.getSurface('taskbar:1')).toBeNull();
    h.host.stop();
  });
});

describe('cat host: taskbar sampling', () => {
  it('samples on the cursor-poll timer at the delay the tracker asks for, with no timer of its own', () => {
    const taskbars = new FakeTaskbarTracker();
    const h = harness({ taskbars });
    h.host.start();
    h.timers.advance(0);
    expect(taskbars.samples).toEqual([{ now: 0, cursor: { x: 500, y: 500 }, catNear: false }]);
    // One tick timer and one poll timer, however the two cadences interleave.
    expect(h.timers.size).toBe(2);
    h.timers.advance(249);
    expect(taskbars.samples).toHaveLength(1);
    h.timers.advance(1);
    expect(taskbars.samples).toHaveLength(2);
    taskbars.delay = 16;
    h.timers.advance(250);
    const n = taskbars.samples.length;
    h.timers.advance(160);
    expect(taskbars.samples.length - n).toBe(10);
    expect(h.timers.size).toBe(2);
    // Out-of-range requests are clamped.
    taskbars.delay = 0;
    h.timers.advance(32);
    const m = taskbars.samples.length;
    h.timers.advance(32);
    expect(taskbars.samples.length - m).toBe(2);
    expect(h.host.debug().taskbarDelayMs).toBe(16);
    h.host.stop();
    expect(h.timers.size).toBe(0);
  });

  it('reports the cat near a taskbar when riding it or close to one that can move, not a static docked one', () => {
    const taskbars = new FakeTaskbarTracker();
    const h = harness({ taskbars });
    taskbars.states = [autoHideBar('shown')];
    h.host.start();
    h.timers.advance(0);
    // The first sample runs before the first sim output: nothing is near yet.
    expect(taskbars.samples.at(-1)!.catNear).toBe(false);
    h.timers.advance(250);
    // makeOutput's cat stands at y=1040, right above the shown auto-hide taskbar.
    expect(taskbars.samples.at(-1)!.catNear).toBe(true);
    taskbars.states = [autoHideBar('shown', { autoHide: false })];
    h.timers.advance(250);
    expect(taskbars.samples.at(-1)!.catNear).toBe(false);
    taskbars.states = [autoHideBar('hidden')];
    h.timers.advance(250);
    expect(taskbars.samples.at(-1)!.catNear).toBe(false);
    h.setOutput({ x: 640, y: 300, support: { kind: 'surface', surfaceId: 'taskbar:1', surfaceKind: 'taskbar', orientation: 'ledge' } });
    h.timers.advance(250);
    h.timers.advance(250);
    expect(taskbars.samples.at(-1)!.catNear).toBe(true);
    h.host.stop();
  });

  it('samples at once when the cursor reaches a hidden auto-hide taskbar edge', () => {
    const taskbars = new FakeTaskbarTracker();
    taskbars.states = [autoHideBar('hidden')];
    const h = harness({ taskbars });
    h.host.start();
    h.timers.advance(0);
    const n = taskbars.samples.length;
    h.setCursor({ x: 900, y: 1079 });
    // The next cursor poll (<= 125 ms) samples the taskbar instead of waiting for 250 ms.
    h.timers.advance(130);
    expect(taskbars.samples.length).toBe(n + 1);
    expect(taskbars.samples.at(-1)!.cursor).toEqual({ x: 900, y: 1079 });
    h.host.stop();
  });

  it('nudges a slow sim while a taskbar slides next to the cat', () => {
    const taskbars = new FakeTaskbarTracker();
    taskbars.delay = 16;
    const h = harness({ taskbars });
    h.setNextTick(1000);
    h.host.start();
    h.timers.advance(0);
    taskbars.states = [autoHideBar('showing')];
    h.timers.advance(100);
    // Without the nudge the second tick would come at 1000 ms.
    expect(h.ticks.length).toBeGreaterThanOrEqual(3);
    h.host.stop();
  });

  it('idles at 1 Hz while hidden, and survives a throwing tracker', () => {
    const taskbars = new FakeTaskbarTracker();
    taskbars.delay = 16;
    const h = harness({ taskbars });
    h.host.start();
    h.timers.advance(0);
    h.host.setHidden(true);
    h.timers.advance(1000);
    const n = taskbars.samples.length;
    h.timers.advance(3000);
    expect(taskbars.samples.length - n).toBe(3);
    h.host.setHidden(false);
    taskbars.throwOnSample = true;
    h.timers.advance(3000);
    expect(h.log.entries.some((e) => e.msg === 'taskbar sample failed')).toBe(true);
    expect(h.host.debug().taskbarDelayMs).toBe(1000);
    h.host.stop();
  });

  it('re-checks an unavailable tracker rarely', () => {
    const taskbars = new FakeTaskbarTracker();
    taskbars.available = false;
    const h = harness({ taskbars });
    h.host.start();
    h.timers.advance(10_000);
    expect(taskbars.samples).toEqual([]);
    expect(h.host.debug().taskbarDelayMs).toBeNull();
    h.host.stop();
  });
});
