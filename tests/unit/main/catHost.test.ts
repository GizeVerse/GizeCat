import { describe, expect, it } from 'vitest';
import { createCatHost, type HostOverlays } from '../../../src/main/catHost';
import type { ActivityMonitor, DisplayService, PerceptionService, Win32Api, WindowTracker } from '../../../src/main/contracts';
import type { PersistedCat } from '../../../src/shared/catState';
import { defaultSettings } from '../../../src/shared/settings';
import type { CatSim, SimEnv, SimEvent, SimOutput, SimRequest } from '../../../src/shared/sim';
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

function harness(opts: { win32Available?: boolean; timeScale?: number } = {}) {
  const timers = manualTimers();
  const ticks: Array<{ env: SimEnv; events: readonly SimEvent[] }> = [];
  let nextTickMs = 33;
  let requests: SimRequest[] = [];
  let throwNext = false;
  const sim: CatSim = {
    tick(env, events) {
      if (throwNext) {
        throwNext = false;
        throw new Error('sim bug');
      }
      ticks.push({ env, events: [...events] });
      const out = makeOutput({ nextTickMs, requests });
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
  };
  const win32 = {
    available: opts.win32Available ?? true,
    getCursorPos: () => ({ x: 500, y: 500 }),
    isLeftButtonDown: () => false,
  } as unknown as Win32Api;
  const trackerEvents: SimEvent[] = [];
  const tracker = {
    mode: 'event-hooks',
    drainEvents: () => trackerEvents.splice(0),
    getForeground: () => null,
    getPlatforms: () => [],
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
    setNextTick: (ms: number) => (nextTickMs = ms),
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
