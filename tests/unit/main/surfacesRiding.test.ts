// The real surface provider and window tracker (scripted Win32 fake: MOCKED OS) feeding the
// real cat simulation the way the host does each tick: noteCat with the previous output, then
// getSurfaces, then the sim's live getSurface reads. Deterministic clock and RNG.
import { describe, expect, it } from 'vitest';
import type { DisplayService, TabStripService, TaskbarTracker } from '../../../src/main/contracts';
import { createSurfaceProvider } from '../../../src/main/surfaces';
import type { Occluder } from '../../../src/main/win32/platforms';
import { createWindowTracker } from '../../../src/main/win32/windowTracker';
import { mulberry32, newPersistedCat } from '../../../src/core/behavior';
import { Mover, type MoverStep } from '../../../src/core/movement';
import type { BehaviorState } from '../../../src/shared/cat';
import type { PersistedCat, Traits } from '../../../src/shared/catState';
import type { Rect } from '../../../src/shared/geometry';
import { defaultSettings } from '../../../src/shared/settings';
import type { SimEvent, SimOutput } from '../../../src/shared/sim';
import type { LedgeSurface, SurfaceStatus } from '../../../src/shared/surfaces';
import { callCat, Harness, onWindowTop, SINGLE, WAKE_MS } from '../core/behavior/fixtures';
import { createTestLogger, FakeExtendedWin32Api, win } from '../win32/fakes';

class SurfaceApi extends FakeExtendedWin32Api {
  extras: Occluder[] = [];
  override listOccluders(): Occluder[] {
    return [...this.extras, ...this.windows.filter((w) => !w.minimized).map((w) => ({ id: w.id, rect: { ...w.rect } }))];
  }
}

const NO_TASKBARS: TaskbarTracker = {
  available: false,
  start: () => undefined,
  stop: () => undefined,
  sample: () => 1000,
  taskbars: () => [],
  surfaces: () => [],
  drainEvents: () => [],
  debugInfo: () => ({}),
};

class FakeTabs implements TabStripService {
  status: SurfaceStatus['tabStrips'] = 'idle';
  statusReason: string | null = null;
  ledges: readonly LedgeSurface[] = [];
  start(): void {}
  stop(): void {}
  updateSettings(): void {}
  setInterest(): void {}
  surfaces(): readonly LedgeSurface[] {
    return this.ledges;
  }
  drainEvents(): SimEvent[] {
    return [];
  }
  debugInfo(): Record<string, unknown> {
    return {};
  }
  dispose(): Promise<void> {
    return Promise.resolve();
  }
}

const PLACID: Partial<Traits> = { curiosity: 0.2, playfulness: 0.2, confidence: 0.4, energyLevel: 0.3, laziness: 0.8 };
const WALL_CLOCK = 1_800_000_000_000;
const RECT: Rect = { x: 600, y: 760, width: 700, height: 280 };
const TOP = 'windowTop:101';

function placidCat(seed: number): PersistedCat {
  const cat = newPersistedCat(mulberry32(seed), WALL_CLOCK - 3600_000);
  Object.assign(cat.traits, PLACID);
  return cat;
}

/** A host loop over the real provider: one window (101) on the floor of SINGLE (1920x1080, floor 1040). */
function world(o: { seed?: number; category?: 'browser' | 'other' } = {}) {
  const seed = o.seed ?? 11;
  const api = new SurfaceApi().add(win('101', { ...RECT }, { category: o.category ?? 'other', processName: o.category === 'browser' ? 'msedge.exe' : 'app.exe' }));
  let clock = 1000;
  const logger = createTestLogger();
  const tracker = createWindowTracker(api, logger, { now: () => clock });
  const display = { world: SINGLE, onChange: () => () => undefined } as unknown as DisplayService;
  const tabs = new FakeTabs();
  const provider = createSurfaceProvider({ logger, tracker, win32: api, taskbars: NO_TASKBARS, tabStrips: tabs, display, settings: defaultSettings(), now: () => clock, options: { cornerRadiusDip: 8 } });
  tracker.start();
  const h = new Harness({ seed, persisted: placidCat(seed), now: clock });
  let hidden = false;
  const position = (out: SimOutput | null) => (out ? { x: out.x, y: out.y, surfaceId: out.support.kind === 'surface' ? out.support.surfaceId : null, hidden } : null);
  h.env = {
    // Read once per tick, as catHost.readSurfaces does: feedback first, then the list.
    get surfaces() {
      provider.noteCat(position(h.last));
      return provider.getSurfaces(clock, 1000);
    },
    getSurface: (id: string) => provider.getSurface(id, clock),
    get hidden() {
      return hidden;
    },
  };
  const step = (dt = 33, events: SimEvent[] = []): SimOutput => {
    clock = h.now + dt;
    return h.step([...tracker.drainEvents(), ...provider.drainEvents(), ...events], dt);
  };
  const run = (ms: number, dt = 33, each?: (o: SimOutput) => void): SimOutput => {
    const end = h.now + ms;
    let out = h.last ?? step(0);
    while (h.now < end) {
      out = step(dt);
      each?.(out);
    }
    return out;
  };
  /** Wakes the cat and calls it onto the window top near x; returns once it stands there idle. */
  const perch = (x: number): SimOutput => {
    run(WAKE_MS);
    callCat(h, { x, y: RECT.y - 60 });
    const end = h.now + 30_000;
    while (h.now < end) {
      const out = step();
      if (onWindowTop(out.support, '101') && out.state === 'idle') return out;
    }
    throw new Error('the cat never perched on the window');
  };
  const sleep = (): SimOutput => {
    step(33, [{ type: 'command.sleep' }]);
    const end = h.now + 10_000;
    while (h.now < end) if (step().state === 'sleeping') return h.last!;
    throw new Error('the cat never fell asleep');
  };
  const transitionsSince = (from: number): BehaviorState[] => h.transitions.slice(from).map((t) => t.to);
  const fear = (): number => h.sim.serialize().stats.fear;
  return {
    api,
    tracker,
    provider,
    tabs,
    h,
    step,
    run,
    perch,
    sleep,
    transitionsSince,
    fear,
    setHidden: (v: boolean) => (hidden = v),
  };
}

describe('riding a window through the real provider', () => {
  it('a fast drag with the cat near the trailing end of the top: it rides on, never falls', () => {
    const w = world();
    const at = w.perch(640);
    const x0 = 608;
    // Per tick, the window moves further than the cat's distance to the trailing end plus the
    // attachment tolerance (12 px): the old frame's spot is off the new span.
    const d = Math.ceil(at.x - x0) + 30;
    expect(d * 6 + RECT.x + RECT.width).toBeLessThan(1920);
    w.step(33, [{ type: 'window.moveStart', id: '101' }]);
    const from = w.h.transitions.length;
    for (let i = 1; i <= 6; i++) {
      w.api.update('101', { rect: { ...RECT, x: RECT.x + d * i } });
      w.api.fire('moveStart', '101');
      const o = w.step();
      expect(onWindowTop(o.support, '101'), `tick ${i}`).toBe(true);
      expect(o.x).toBeCloseTo(at.x + d * i, 6);
      expect(o.y).toBe(RECT.y);
    }
    w.api.fire('moveEnd', '101');
    w.run(2000);
    expect(onWindowTop(w.h.last!.support, '101')).toBe(true);
    expect(w.transitionsSince(from)).not.toContain('falling');
  });

  it('a same-size jump of the window (snap, Win+Arrow) carries the cat along', () => {
    const w = world();
    const at = w.perch(950);
    const from = w.h.transitions.length;
    w.api.update('101', { rect: { ...RECT, x: RECT.x - 400 } });
    const o = w.step();
    expect(onWindowTop(o.support, '101')).toBe(true);
    expect(o.x).toBeCloseTo(at.x - 400, 6);
    w.run(2000);
    expect(onWindowTop(w.h.last!.support, '101')).toBe(true);
    expect(w.transitionsSince(from)).not.toContain('falling');
  });

  it('a window brought in front over the cat’s spot drops it calmly: no start, no fright', () => {
    const w = world();
    const at = w.perch(950);
    const fear0 = w.fear();
    const from = w.h.transitions.length;
    w.api.extras = [{ id: 'dlg', rect: { x: Math.round(at.x) - 100, y: 600, width: 200, height: 300 } }];
    w.api.foregroundId = 'dlg';
    w.api.fire('foreground', 'dlg');
    w.run(4000);
    const to = w.transitionsSince(from);
    expect(to).toContain('falling');
    expect(to).not.toContain('startled');
    expect(w.fear()).toBeLessThanOrEqual(fear0 + 1e-9);
    expect(onWindowTop(w.h.last!.support, '101') && Math.abs(w.h.last!.x - at.x) < 100).toBe(false);
  });

  it('a window in front over the whole window (its top and both sides) is a calm drop too, not a vanished window', () => {
    const w = world();
    w.perch(950);
    const fear0 = w.fear();
    const from = w.h.transitions.length;
    w.api.extras = [{ id: 'dlg', rect: { x: RECT.x - 100, y: RECT.y - 60, width: RECT.width + 200, height: 400 } }];
    w.api.foregroundId = 'dlg';
    w.api.fire('foreground', 'dlg');
    w.run(4000);
    // Nothing of 101 is listed any more, but it is still there.
    expect(w.provider.getSurfaces(w.h.now, 1000).filter((s) => s.ownerId === '101')).toEqual([]);
    const to = w.transitionsSince(from);
    expect(to).toContain('falling');
    expect(to).not.toContain('startled');
    expect(w.fear()).toBeLessThanOrEqual(fear0 + 1e-9);
  });

  it('a window turning private under a sleeping cat: it leaves calmly within seconds and never returns', () => {
    const w = world();
    w.perch(950);
    w.sleep();
    const fear0 = w.fear();
    const from = w.h.transitions.length;
    w.api.update('101', { excluded: true });
    w.tracker.setExclusions(['app.exe'], []);
    let leftAt: number | null = null;
    const t0 = w.h.now;
    w.run(3000, 33, (o) => {
      if (leftAt === null && !(o.support.kind === 'surface' && o.support.surfaceId.includes(':101'))) leftAt = w.h.now - t0;
    });
    expect(leftAt).not.toBeNull();
    expect(w.transitionsSince(from)).not.toContain('startled');
    expect(w.fear()).toBeLessThanOrEqual(fear0 + 1e-9);
    w.run(60_000, 100, (o) => {
      expect(o.support.kind === 'surface' && o.support.surfaceId.includes(':101')).toBe(false);
    });
  });

  it('a tab strip found under a cat on the browser’s top (outside the strip’s span) does not drop it', () => {
    const w = world({ category: 'browser' });
    const at = w.perch(1150);
    w.sleep();
    const from = w.h.transitions.length;
    // The strip ends well left of the cat (caption buttons on the right).
    w.tabs.ledges = [
      {
        id: 'tabStrip:101', kind: 'tabStrip', orientation: 'ledge', ownerId: '101', displayId: '1', phase: 'stable', vx: 0, vy: 0, confidence: 1, validatedAt: 1000, excluded: false,
        y: RECT.y, x0: 650, x1: Math.round(at.x) - 150, rest: null, focusX: null,
      },
    ];
    w.run(5000, 33, (o) => {
      expect(o.support).toMatchObject({ kind: 'surface', surfaceId: TOP });
    });
    expect(w.transitionsSince(from)).not.toContain('falling');
  });

  it('hidden and shown again, the cat is still on the part of a split top it was on', () => {
    const w = world();
    const at = w.perch(1230);
    // A dialog splits the top: the cat is on the shorter right part.
    w.api.extras = [{ id: 'dlg', rect: { x: Math.round(at.x) - 200, y: 600, width: 100, height: 300 } }];
    w.api.foregroundId = 'dlg';
    w.api.fire('foreground', 'dlg');
    w.run(1000);
    expect(onWindowTop(w.h.last!.support, '101')).toBe(true);
    const x = w.h.last!.x;
    w.setHidden(true);
    w.run(3000, 100);
    w.setHidden(false);
    w.run(2000);
    expect(onWindowTop(w.h.last!.support, '101')).toBe(true);
    expect(w.h.last!.y).toBe(RECT.y);
    expect(Math.abs(w.h.last!.x - x)).toBeLessThan(200);
  });
});

describe('climbing a browser through the real provider', () => {
  it('climbs the left side of a browser whose tab strip is known and pulls up onto the strip', () => {
    // 640 px tall, standing on the floor of SINGLE (1040): too high to jump onto.
    const frame: Rect = { x: 800, y: 400, width: 700, height: 640 };
    const api = new SurfaceApi().add(win('101', { ...frame }, { category: 'browser', processName: 'msedge.exe' }));
    let clock = 1000;
    const logger = createTestLogger();
    const tracker = createWindowTracker(api, logger, { now: () => clock });
    const display = { world: SINGLE, onChange: () => () => undefined } as unknown as DisplayService;
    const tabs = new FakeTabs();
    // As the helper places it: from just past the first tab's margin to left of the caption
    // buttons, so it stops short of both top corners (808 and 1492).
    tabs.ledges = [
      {
        id: 'tabStrip:101', kind: 'tabStrip', orientation: 'ledge', ownerId: '101', displayId: '1', phase: 'stable', vx: 0, vy: 0, confidence: 1, validatedAt: 1000, excluded: false,
        y: 400, x0: 850, x1: 1300, rest: null, focusX: null,
      },
    ];
    const provider = createSurfaceProvider({ logger, tracker, win32: api, taskbars: NO_TASKBARS, tabStrips: tabs, display, settings: defaultSettings(), now: () => clock, options: { cornerRadiusDip: 8 } });
    tracker.start();
    const m = new Mover(SINGLE, { size: 1, movementSpeed: 1, allowMultiMonitor: true, perchOnWindows: true }, { displayId: '1', xFrac: 0.25 });
    // The host's order each tick: feedback, the list, then the sim's live reads.
    const step = (dt = 16): MoverStep => {
      clock += dt;
      tracker.drainEvents();
      const support = m.support;
      provider.noteCat({ x: m.x, y: m.y, surfaceId: support.kind === 'surface' ? support.surfaceId : null });
      m.sense(provider.getSurfaces(clock, 1000));
      return m.step({ now: clock, dtMs: dt, dragCursor: null, getSurface: (id) => provider.getSurface(id, clock) });
    };
    step();
    expect(m.climbOptions().map((o) => [o.dir, o.wallId, o.target.y])).toEqual([['up', 'windowSide:101:left', 400]]);
    m.setGoal({ x: 1000, y: 400, pace: 'walk', allowJump: true, route: 'climb' });
    let wall: string | null = null;
    let arrived = false;
    for (let t = 0; t < 60_000 && !arrived; t += 16) {
      const r = step();
      expect(r.perchLost).toBe(false);
      if (r.climbStarted) wall = m.support.kind === 'surface' ? m.support.surfaceId : null;
      arrived = r.goal === 'arrived';
    }
    expect(wall).toBe('windowSide:101:left');
    expect(arrived).toBe(true);
    expect(m.support).toMatchObject({ kind: 'surface', surfaceId: 'tabStrip:101' });
    expect(m.y).toBe(400);
  });
});
