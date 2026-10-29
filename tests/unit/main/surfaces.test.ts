// SurfaceProvider with the real window tracker over a scripted Win32 fake (MOCKED OS,
// deterministic clock). Geometry in physical px.
import { describe, expect, it } from 'vitest';
import type { DisplayService, TabStripService, TaskbarState, TaskbarTracker } from '../../../src/main/contracts';
import { createSurfaceProvider, type SurfaceProviderOptions } from '../../../src/main/surfaces';
import type { Occluder } from '../../../src/main/win32/platforms';
import { createUnavailableWin32Api } from '../../../src/main/win32/win32Api';
import { createWindowTracker } from '../../../src/main/win32/windowTracker';
import type { Point } from '../../../src/shared/geometry';
import { defaultSettings, type Settings } from '../../../src/shared/settings';
import type { SimEvent } from '../../../src/shared/sim';
import type { LedgeSurface, Surface, SurfaceStatus, WallSurface } from '../../../src/shared/surfaces';
import type { DisplayGeometry, WorldGeometry } from '../../../src/shared/world';
import { createTestLogger, FakeExtendedWin32Api, FakeWin32Api, rect, win } from '../win32/fakes';

/** FakeExtendedWin32Api whose z-order (listOccluders) follows its app windows plus extra non-app windows on top. */
class SurfaceApi extends FakeExtendedWin32Api {
  extras: Occluder[] = [];
  occluderCalls = 0;
  override listOccluders(): Occluder[] {
    this.occluderCalls++;
    return [...this.extras, ...this.windows.filter((w) => !w.minimized).map((w) => ({ id: w.id, rect: { ...w.rect } }))];
  }
}

class FakeTaskbars implements TaskbarTracker {
  available = true;
  states: TaskbarState[] = [];
  ledges: LedgeSurface[] = [];
  events: SimEvent[] = [];
  samples: Array<{ now: number; cursor: Point | null; catNear: boolean }> = [];
  delay = 250;
  start(): void {}
  stop(): void {}
  sample(now: number, cursor: Point | null, catNear: boolean): number {
    this.samples.push({ now, cursor, catNear });
    return this.delay;
  }
  taskbars(): readonly TaskbarState[] {
    return this.states;
  }
  surfaces(): readonly LedgeSurface[] {
    return this.ledges;
  }
  drainEvents(): SimEvent[] {
    return this.events.splice(0);
  }
  debugInfo(): Record<string, unknown> {
    return { fake: true };
  }
}

class FakeTabs implements TabStripService {
  status: SurfaceStatus['tabStrips'] = 'idle';
  statusReason: string | null = null;
  ledges: readonly LedgeSurface[] = [];
  events: SimEvent[] = [];
  interest: Array<{ ids: string[]; now: number }> = [];
  settingsSeen: Settings[] = [];
  start(): void {}
  stop(): void {}
  updateSettings(s: Settings): void {
    this.settingsSeen.push(s);
  }
  setInterest(ids: readonly string[], now: number): void {
    this.interest.push({ ids: [...ids], now });
  }
  surfaces(): readonly LedgeSurface[] {
    return this.ledges;
  }
  drainEvents(): SimEvent[] {
    return this.events.splice(0);
  }
  debugInfo(): Record<string, unknown> {
    return {};
  }
  dispose(): Promise<void> {
    return Promise.resolve();
  }
}

function disp(id: string, x: number, y: number, w: number, h: number, scale = 1, workH = h - Math.round(48 * scale)): DisplayGeometry {
  const b = { x, y, width: w, height: h };
  const wa = { x, y, width: w, height: workH };
  return { id, primary: id === '1', scaleFactor: scale, boundsDip: b, workAreaDip: wa, boundsPx: b, workAreaPx: wa };
}

function fakeDisplay(displays: DisplayGeometry[]): DisplayService & { change(next: DisplayGeometry[]): void } {
  let world: WorldGeometry = { version: 1, displays };
  const listeners = new Set<(w: WorldGeometry) => void>();
  return {
    get world() {
      return world;
    },
    onChange(cb) {
      listeners.add(cb);
      return () => {
        listeners.delete(cb);
      };
    },
    toLocalDip: (_id, p) => p,
    fromLocalDip: (_id, p) => p,
    displayAt: () => world.displays[0]?.id ?? null,
    refresh: () => false,
    dispose: () => undefined,
    change(next) {
      world = { version: world.version + 1, displays: next };
      for (const cb of listeners) cb(world);
    },
  };
}

interface SetupOptions {
  api?: FakeWin32Api;
  displays?: DisplayGeometry[];
  settings?: Settings;
  tabs?: FakeTabs | null;
  options?: Partial<SurfaceProviderOptions>;
}

function setup(o: SetupOptions = {}) {
  let t = 1000;
  const api = o.api ?? new SurfaceApi();
  const logger = createTestLogger();
  const tracker = createWindowTracker(api, logger, { now: () => t });
  const display = fakeDisplay(o.displays ?? [disp('1', 0, 0, 1920, 1200)]);
  const taskbars = new FakeTaskbars();
  const tabs = o.tabs === undefined ? new FakeTabs() : o.tabs;
  const provider = createSurfaceProvider({
    logger,
    tracker,
    win32: api,
    taskbars,
    tabStrips: tabs,
    display,
    settings: o.settings ?? defaultSettings(),
    now: () => t,
    options: { cornerRadiusDip: 8, ...o.options },
  });
  tracker.start();
  /** One host tick: drain the tracker (delivers change notices), then read the surfaces. */
  const tick = (ms = 33): readonly Surface[] => {
    t += ms;
    tracker.drainEvents();
    return provider.getSurfaces(t, 1000);
  };
  const run = (ms: number, step = 33): readonly Surface[] => {
    let last = provider.getSurfaces(t, 1000);
    const end = t + ms;
    while (t < end) last = tick(Math.min(step, end - t));
    return last;
  };
  return { api, tracker, provider, taskbars, tabs, display, logger, tick, run, now: () => t };
}

const byId = (list: readonly Surface[], id: string): Surface | undefined => list.find((s) => s.id === id);
const ledge = (list: readonly Surface[], id: string): LedgeSurface => {
  const s = byId(list, id);
  if (!s || s.orientation !== 'ledge') throw new Error(`no ledge ${id} in [${list.map((x) => x.id).join(', ')}]`);
  return s;
};
const wall = (list: readonly Surface[], id: string): WallSurface => {
  const s = byId(list, id);
  if (!s || s.orientation !== 'wall') throw new Error(`no wall ${id} in [${list.map((x) => x.id).join(', ')}]`);
  return s;
};
const ids = (list: readonly Surface[]) => list.map((s) => s.id);

function stripLedge(owner: string, over: Partial<LedgeSurface> = {}): LedgeSurface {
  return {
    id: `tabStrip:${owner}`,
    kind: 'tabStrip',
    orientation: 'ledge',
    ownerId: owner,
    displayId: '1',
    phase: 'stable',
    vx: 0,
    vy: 0,
    confidence: 1,
    validatedAt: 1000,
    excluded: false,
    y: 200,
    x0: 341,
    x1: 1250,
    rest: { x0: 341, x1: 1250 },
    focusX: 500,
    ...over,
  };
}

describe('window top ledges', () => {
  it('stand on the DWM frame top, inset for rounded corners at 100/125/150 % and Windows 10 square corners', () => {
    for (const [scale, inset] of [
      [1, 8],
      [1.25, 10],
      [1.5, 12],
    ] as const) {
      const api = new SurfaceApi().add(win('101', rect(300, 400, 800, 500)));
      const s = setup({ api, displays: [disp('1', 0, 0, 1920, 1200, scale)] });
      const list = s.tick();
      const top = ledge(list, 'windowTop:101');
      expect([top.y, top.x0, top.x1], `scale ${scale}`).toEqual([400, 300 + inset, 1100 - inset]);
      expect(wall(list, 'windowSide:101:right'), `scale ${scale}`).toMatchObject({ x: 1100, y0: 400 + inset, y1: 900 - inset });
      expect(top).toMatchObject({ kind: 'windowTop', ownerId: '101', displayId: '1', phase: 'stable', excluded: false, rest: null, focusX: null, confidence: 1 });
    }
    const api = new SurfaceApi().add(win('101', rect(300, 400, 800, 500)));
    const square = setup({ api, options: { cornerRadiusDip: 0 } });
    expect(ledge(square.tick(), 'windowTop:101')).toMatchObject({ x0: 300, x1: 1100 });
  });

  it('are cut by windows above (owned dialogs too) and follow the cat across the gap', () => {
    const api = new SurfaceApi().add(win('101', rect(300, 400, 800, 500)));
    api.extras = [{ id: 'dlg', rect: rect(650, 350, 200, 150) }];
    const s = setup({ api });
    expect(ledge(s.tick(), 'windowTop:101')).toMatchObject({ x0: 308, x1: 650 });
    s.provider.noteCat({ x: 1000, y: 400, surfaceId: 'windowTop:101' });
    expect(ledge(s.tick(), 'windowTop:101')).toMatchObject({ x0: 850, x1: 1092 });
  });

  it('are dropped when narrower than the minimum, maximized, fullscreen or covering the work area', () => {
    const api = new SurfaceApi()
      .add(win('101', rect(300, 400, 90, 300)))
      .add(win('102', rect(0, 0, 1920, 1152), { maximized: true }))
      .add(win('103', rect(500, 500, 600, 400), { fullscreen: true }))
      .add(win('104', rect(0, 0, 1920, 1152)));
    const s = setup({ api });
    expect(ids(s.tick()).filter((id) => id.startsWith('windowTop'))).toEqual([]);
  });

  it('needs a work area above the edge: a window top at the screen top or under a docked taskbar offers nothing', () => {
    const api = new SurfaceApi().add(win('101', rect(300, 0, 800, 500))).add(win('102', rect(300, 1160, 800, 300)));
    const s = setup({ api });
    const list = s.tick();
    expect(ids(list).filter((id) => id.startsWith('windowTop'))).toEqual([]);
    // The sides of the window at the top are still climbable; the one below the work area has none.
    expect(ids(list)).toEqual(['windowSide:101:left', 'windowSide:101:right']);
  });

  it('are never offered for private windows, which still cut the windows below them', () => {
    const api = new SurfaceApi().add(win('101', rect(300, 400, 800, 500), { excluded: true, processName: 'keepass.exe' })).add(win('102', rect(200, 300, 300, 300)), false);
    const s = setup({ api });
    expect(ids(s.tick()).filter((id) => id.includes(':101'))).toEqual([]);
    expect(ledge(s.tick(), 'windowTop:102')).toMatchObject({ x0: 208, x1: 492 });
    for (const id of ['windowTop:101', 'windowSide:101:left', 'tabStrip:101']) expect(s.provider.getSurface(id, s.now()), id).toBeNull();
  });

  it('a window turning private under the cat is unlisted at once; the surface it is on is still served, flagged, until it leaves', () => {
    const api = new SurfaceApi().add(win('101', rect(300, 400, 800, 500), { processName: 'keepass.exe' }));
    const s = setup({ api });
    s.tick();
    s.provider.noteCat({ x: 700, y: 400, surfaceId: 'windowTop:101' });
    expect(ids(s.tick())).toContain('windowTop:101');
    // The user adds keepass.exe to the exclusions: the tracker re-lists every window.
    api.update('101', { excluded: true });
    s.tracker.setExclusions(['keepass.exe'], []);
    expect(ids(s.run(100)).filter((id) => id.includes(':101'))).toEqual([]);
    expect(s.provider.getSurface('windowTop:101', s.now())).toMatchObject({ id: 'windowTop:101', excluded: true, x0: 308, x1: 1092 });
    // Not offered for anything else: no climbing it, no other ledge of it.
    expect(s.provider.getSurface('windowSide:101:left', s.now())).toBeNull();
    // Off it, nothing of it is served any more.
    s.provider.noteCat({ x: 200, y: 1152, surfaceId: null });
    expect(s.provider.getSurface('windowTop:101', s.now() + 5)).toBeNull();
  });

  it('keep the same array and objects while nothing changes', () => {
    const api = new SurfaceApi().add(win('101', rect(300, 400, 800, 500)));
    const s = setup({ api });
    const a = s.tick();
    const b = s.tick();
    expect(b).toBe(a);
  });
});

describe('window side walls', () => {
  it('cling to the frame sides, inset for corners, linked to the top ledge at the corner', () => {
    const api = new SurfaceApi().add(win('101', rect(300, 400, 800, 500)));
    const s = setup({ api });
    const list = s.tick();
    expect(wall(list, 'windowSide:101:left')).toMatchObject({ kind: 'windowSide', side: 'left', x: 300, y0: 408, y1: 892, topLedgeId: 'windowTop:101', displayId: '1' });
    expect(wall(list, 'windowSide:101:right')).toMatchObject({ side: 'right', x: 1100, y0: 408, y1: 892, topLedgeId: 'windowTop:101' });
  });

  it('need open space beside them: none against the screen edge, cut where a window above covers the side', () => {
    const api = new SurfaceApi().add(win('101', rect(20, 400, 800, 500)));
    api.extras = [{ id: 'tool', rect: rect(790, 600, 300, 100) }];
    const s = setup({ api });
    const list = s.tick();
    expect(byId(list, 'windowSide:101:left')).toBeUndefined();
    // The right side is split by the tool window; the span at the top corner is kept.
    expect(wall(list, 'windowSide:101:right')).toMatchObject({ x: 820, y0: 408, y1: 600, topLedgeId: 'windowTop:101' });
    s.provider.noteCat({ x: 830, y: 800, surfaceId: 'windowSide:101:right' });
    expect(wall(s.tick(), 'windowSide:101:right')).toMatchObject({ y0: 700, y1: 892 });
  });

  it('have no pull-up ledge when the top ledge does not reach that corner', () => {
    const api = new SurfaceApi().add(win('101', rect(300, 400, 800, 500)));
    api.extras = [{ id: 'dlg', rect: rect(900, 350, 300, 100) }];
    const s = setup({ api });
    const list = s.tick();
    expect(ledge(list, 'windowTop:101')).toMatchObject({ x0: 308, x1: 900 });
    expect(wall(list, 'windowSide:101:left').topLedgeId).toBe('windowTop:101');
    // The dialog covers the right corner area and the right band's top part.
    expect(wall(list, 'windowSide:101:right')).toMatchObject({ y0: 450, topLedgeId: null });
  });

  it('are cut by the taskbar and clipped to the work area', () => {
    const api = new SurfaceApi().add(win('101', rect(300, 600, 600, 560)));
    const s = setup({ api, displays: [disp('1', 0, 0, 1920, 1200, 1, 1200)] });
    s.taskbars.states = [
      { id: '65552', displayId: '1', edge: 'bottom', autoHide: true, rect: rect(0, 1140, 1920, 60), dockedRect: rect(0, 1140, 1920, 60), shownFraction: 1, phase: 'shown', speed: 0, validatedAt: 1000 },
    ];
    expect(wall(s.tick(), 'windowSide:101:left')).toMatchObject({ y0: 608, y1: 1140 });
  });

  it('are cut at once by an auto-hide taskbar sliding in, without waiting for the next z-order read', () => {
    const api = new SurfaceApi().add(win('101', rect(300, 600, 600, 560)));
    const s = setup({ api, displays: [disp('1', 0, 0, 1920, 1200, 1, 1200)] });
    const tb = (y: number, shownFraction: number): TaskbarState => ({
      id: '65552', displayId: '1', edge: 'bottom', autoHide: true, rect: rect(0, y, 1920, 60), dockedRect: rect(0, 1140, 1920, 60), shownFraction, phase: shownFraction >= 1 ? 'shown' : 'showing', speed: 0, validatedAt: 1000,
    });
    s.taskbars.states = [tb(1198, 2 / 60)];
    expect(wall(s.tick(), 'windowSide:101:left')).toMatchObject({ y0: 608, y1: 1152 });
    const calls = api.occluderCalls;
    s.taskbars.states = [tb(1150, 50 / 60)];
    expect(wall(s.tick(16), 'windowSide:101:left')).toMatchObject({ y0: 608, y1: 1150 });
    s.taskbars.states = [tb(1140, 1)];
    expect(wall(s.tick(16), 'windowSide:101:left')).toMatchObject({ y0: 608, y1: 1140 });
    expect(api.occluderCalls).toBe(calls);
    s.taskbars.states = [tb(1198, 2 / 60)];
    expect(wall(s.tick(16), 'windowSide:101:left')).toMatchObject({ y1: 1152 });
  });

  it('exist only while climbing is allowed', () => {
    const api = new SurfaceApi().add(win('101', rect(300, 400, 800, 500)));
    const settings = defaultSettings();
    settings.behavior.disabledBehaviors = ['climbWindows'];
    const s = setup({ api, settings });
    expect(ids(s.tick())).toEqual(['windowTop:101']);
    expect(s.provider.getSurface('windowSide:101:left', s.now())).toBeNull();
    s.provider.updateSettings(defaultSettings());
    expect(ids(s.tick())).toEqual(['windowTop:101', 'windowSide:101:left', 'windowSide:101:right']);
  });
});

describe('incremental updates', () => {
  it('applies settled moves without re-enumerating the z-order and recomputes only the affected window', () => {
    const api = new SurfaceApi().add(win('101', rect(100, 300, 500, 400))).add(win('102', rect(1000, 500, 600, 400)));
    const s = setup({ api });
    const before = s.tick();
    const calls = api.occluderCalls;
    const recomputes = s.provider.debugInfo().recomputes;
    api.update('102', { rect: rect(1000, 450, 600, 400) });
    api.fire('moveStart', '102');
    api.fire('moveEnd', '102');
    const after = s.run(200);
    expect(api.occluderCalls).toBe(calls);
    expect(ledge(after, 'windowTop:102').y).toBe(450);
    expect(byId(after, 'windowTop:101')).toBe(byId(before, 'windowTop:101'));
    expect(s.provider.debugInfo().recomputes - recomputes).toBe(1);
  });

  it('re-reads the z-order when the foreground changes (occlusion invalidated) and at most every maxAgeMs', () => {
    // add() puts a window on top: 101 is above 102.
    const api = new SurfaceApi().add(win('102', rect(300, 350, 500, 400))).add(win('101', rect(500, 300, 500, 400)));
    const s = setup({ api });
    // 101 is on top: its body cuts 102's top edge at x >= 500.
    expect(ledge(s.tick(), 'windowTop:102')).toMatchObject({ x0: 308, x1: 500 });
    const calls = api.occluderCalls;
    api.windows = [api.find('102')!, api.find('101')!];
    api.foregroundId = '102';
    api.fire('foreground', '102');
    const list = s.run(200);
    expect(api.occluderCalls).toBe(calls + 1);
    expect(ledge(list, 'windowTop:102')).toMatchObject({ x0: 308, x1: 792 });
    // 102 is now above 101, but its body starts below 101's top row: 101's top stays whole,
    // while 102 now covers 101's left side from y=350 (the 42 px left above it are too short).
    expect(ledge(list, 'windowTop:101')).toMatchObject({ x0: 508, x1: 992 });
    expect(byId(list, 'windowSide:101:left')).toBeUndefined();
    s.run(1100);
    expect(api.occluderCalls).toBeGreaterThanOrEqual(calls + 2);
  });

  it('invalidates on maximize, minimize (leaving first) and close; restored windows are briefly entering', () => {
    const api = new SurfaceApi().add(win('101', rect(300, 400, 800, 500))).add(win('102', rect(1300, 400, 500, 500)));
    const s = setup({ api });
    s.tick();
    // Minimize: the start is announced before the burst settles.
    api.update('101', { minimized: true });
    api.fire('minimizeStart', '101');
    const leaving = s.tick(16);
    expect(ledge(leaving, 'windowTop:101').phase).toBe('leaving');
    expect(s.provider.getSurface('windowTop:101', s.now())).toBeNull();
    expect(byId(s.run(300), 'windowTop:101')).toBeUndefined();
    // Restore: entering for a moment, then stable.
    api.update('101', { minimized: false });
    api.fire('minimizeEnd', '101');
    const restored = s.run(200);
    expect(ledge(restored, 'windowTop:101').phase).toBe('entering');
    expect(ledge(s.run(400), 'windowTop:101').phase).toBe('stable');
    // Maximize (no move event fires for it: the tracker learns on the next burst or reconcile).
    api.update('102', { maximized: true, rect: rect(0, 0, 1920, 1152) });
    api.fire('show', '102');
    expect(byId(s.run(300), 'windowTop:102')).toBeUndefined();
    // Close.
    api.remove('101');
    api.fire('destroy', '101');
    expect(ids(s.run(300))).toEqual([]);
  });

  it('follows a window being dragged live (no events until the drag ends) with a velocity, then rests', () => {
    const api = new SurfaceApi().add(win('101', rect(300, 400, 800, 500)));
    const s = setup({ api });
    s.tick();
    api.fire('moveStart', '101');
    let top = ledge(s.tick(16), 'windowTop:101');
    for (let i = 1; i <= 12; i++) {
      api.update('101', { rect: rect(300 + i * 10, 400 - i * 4, 800, 500) });
      top = ledge(s.tick(16), 'windowTop:101');
    }
    expect([top.x0, top.y]).toEqual([300 + 120 + 8, 400 - 48]);
    expect(top.vx).toBeGreaterThan(400);
    expect(top.vy).toBeLessThan(-150);
    api.fire('moveEnd', '101');
    const rested = ledge(s.run(600), 'windowTop:101');
    expect([rested.vx, rested.vy]).toEqual([0, 0]);
  });

  it('survives a rapid burst of moves across many windows and ends consistent', () => {
    const api = new SurfaceApi();
    for (let i = 0; i < 12; i++) api.add(win(String(200 + i), rect(100 + i * 120, 200 + (i % 3) * 150, 300, 300)), false);
    const s = setup({ api });
    s.tick();
    for (let k = 0; k < 40; k++) {
      const id = String(200 + (k % 12));
      const w = api.find(id)!;
      api.update(id, { rect: rect(w.rect.x + 7, w.rect.y + (k % 2 ? 5 : -5), 300, 300) });
      api.fire('moveStart', id);
      api.fire('moveEnd', id);
      s.tick(5);
    }
    const settled = s.run(1500);
    // Same result as a provider built from scratch on the final layout.
    const fresh = setup({ api });
    expect(settled.map((x) => ({ ...x, validatedAt: 0, confidence: 0 }))).toEqual(fresh.tick().map((x) => ({ ...x, validatedAt: 0, confidence: 0 })));
  });
});

describe('getSurface (live re-read)', () => {
  it('re-reads the owner window: moved without events, gone, minimized, maximized', () => {
    const api = new SurfaceApi().add(win('101', rect(300, 400, 800, 500)));
    const s = setup({ api });
    s.tick();
    api.update('101', { rect: rect(350, 380, 800, 500) });
    expect(s.provider.getSurface('windowTop:101', s.now() + 1)).toMatchObject({ y: 380, x0: 358, x1: 1142, validatedAt: s.now() + 1, confidence: 1 });
    expect(s.provider.getSurface('windowSide:101:right', s.now() + 10)).toMatchObject({ x: 1150 });
    api.update('101', { rect: rect(0, 0, 1920, 1152) });
    expect(s.provider.getSurface('windowTop:101', s.now() + 20)).toBeNull();
    api.update('101', { rect: rect(300, 400, 800, 500), minimized: true });
    expect(s.provider.getSurface('windowTop:101', s.now() + 30)).toBeNull();
    api.remove('101');
    expect(s.provider.getSurface('windowTop:101', s.now() + 40)).toBeNull();
  });

  it('a covered attachment point is not a loss: an open part that does not hold the spot (calm drop), the bare edge when none is left', () => {
    const api = new SurfaceApi().add(win('101', rect(300, 400, 800, 500)));
    const s = setup({ api });
    s.tick();
    s.provider.noteCat({ x: 700, y: 400, surfaceId: 'windowTop:101' });
    api.extras = [{ id: 'dlg', rect: rect(650, 350, 200, 150) }];
    api.foregroundId = 'dlg';
    api.fire('foreground', 'dlg');
    s.run(200);
    const covered = s.provider.getSurface('windowTop:101', s.now());
    expect(covered).toMatchObject({ id: 'windowTop:101', y: 400, x0: 308, x1: 650 });
    s.provider.noteCat({ x: 655, y: 400, surfaceId: 'windowTop:101' });
    expect(s.provider.getSurface('windowTop:101', s.now() + 5)).toMatchObject({ x0: 308, x1: 650 });
    // A window in front over the whole top edge: still there, unlisted, low confidence.
    api.extras = [{ id: 'big', rect: rect(250, 300, 1000, 300) }];
    api.foregroundId = 'big';
    api.fire('foreground', 'big');
    const list = s.run(200);
    expect(byId(list, 'windowTop:101')).toBeUndefined();
    expect(s.provider.getSurface('windowTop:101', s.now())).toMatchObject({ id: 'windowTop:101', y: 400, x0: 308, x1: 1092, confidence: 0.3 });
    // ... but only for the cat standing on it.
    s.provider.noteCat({ x: 100, y: 1152, surfaceId: null });
    expect(s.provider.getSurface('windowTop:101', s.now() + 5)).toBeNull();
    for (const id of ['windowTop:999', 'windowTop', 'windowSide:101:up', 'windowTop:101:extra', 'nope:101', '']) expect(s.provider.getSurface(id, s.now())).toBeNull();
  });

  describe('follows the riding cat however far the window moved since the last tick', () => {
    // The host notes the cat from the previous tick's output (old frame), then reads the surfaces.
    const hostTick = (s: ReturnType<typeof setup>, cat: { x: number; y: number; surfaceId: string }, ms = 33): void => {
      s.provider.noteCat(cat);
      s.tick(ms);
    };

    it('a fast drag with the cat near the trailing end, and a same-size jump (snap, Win+Arrow)', () => {
      const api = new SurfaceApi().add(win('101', rect(300, 400, 800, 500)));
      const s = setup({ api });
      s.tick();
      const cat = { x: 338, y: 400, surfaceId: 'windowTop:101' };
      api.fire('moveStart', '101');
      hostTick(s, cat, 16);
      for (let i = 1; i <= 6; i++) {
        // 50 px per 33 ms tick (about 1500 px/s), 30 px from the trailing end of the span.
        api.update('101', { rect: rect(300 + 50 * i, 400, 800, 500) });
        hostTick(s, cat);
        expect(s.provider.getSurface('windowTop:101', s.now()), `tick ${i}`).toMatchObject({ id: 'windowTop:101', y: 400, x0: 308 + 50 * i, x1: 1092 + 50 * i });
        // The sim carries the cat with its ledge.
        cat.x += 50;
      }
      api.fire('moveEnd', '101');
      s.run(300);
      hostTick(s, cat);
      // A 400 px jump between two ticks (no move events).
      api.update('101', { rect: rect(1000, 400, 800, 500) });
      expect(s.provider.getSurface('windowTop:101', s.now() + 5)).toMatchObject({ x0: 1008, x1: 1792 });
      expect(ledge(s.tick(), 'windowTop:101')).toMatchObject({ x0: 1008, x1: 1792 });
    });

    it('picks the part the cat was carried onto when the edge moved as a whole', () => {
      const api = new SurfaceApi().add(win('101', rect(300, 400, 800, 500)));
      // A palette above 101 splits its top: [308, 650) and [700, 1092). It moves with 101.
      api.extras = [{ id: 'palette', rect: rect(650, 350, 50, 150) }];
      const s = setup({ api });
      s.tick();
      hostTick(s, { x: 720, y: 400, surfaceId: 'windowTop:101' });
      expect(ledge(s.tick(), 'windowTop:101')).toMatchObject({ x0: 700, x1: 1092 });
      // Both jump 300 px right before the next read: carried to x=1020, the cat is on the right
      // part ([1000, 1392)), although its old spot now lies on the left one ([608, 950)).
      api.update('101', { rect: rect(600, 400, 800, 500) });
      api.extras = [{ id: 'palette', rect: rect(950, 350, 50, 150) }];
      api.foregroundId = 'palette';
      api.fire('foreground', 'palette');
      expect(ledge(s.run(300), 'windowTop:101')).toMatchObject({ x0: 1000, x1: 1392 });
      expect(s.provider.getSurface('windowTop:101', s.now() + 5)).toMatchObject({ x0: 1000, x1: 1392 });
    });

    it('keeps the cat where it was on a part bounded by a window that stayed put', () => {
      const api = new SurfaceApi().add(win('101', rect(300, 400, 800, 500)));
      // A window above 101 (not moving) splits its top: [308, 650) and [850, 1092).
      api.extras = [{ id: 'dlg', rect: rect(650, 350, 200, 150) }];
      const s = setup({ api });
      s.tick();
      hostTick(s, { x: 640, y: 400, surfaceId: 'windowTop:101' });
      // 101 slides 60 px right under the cat: its left part shrinks to [368, 650) and the right
      // one, now longer, is [850, 1152). The carried spot (700) is covered; the cat stays at 640.
      api.update('101', { rect: rect(360, 400, 800, 500) });
      s.provider.noteCat({ x: 640, y: 400, surfaceId: 'windowTop:101' });
      expect(s.provider.getSurface('windowTop:101', s.now() + 5)).toMatchObject({ x0: 368, x1: 650 });
    });

    it('a window resized from the edge the cat stands near keeps serving its top', () => {
      const api = new SurfaceApi().add(win('101', rect(300, 400, 800, 500)));
      const s = setup({ api });
      s.tick();
      hostTick(s, { x: 320, y: 400, surfaceId: 'windowTop:101' });
      api.fire('moveStart', '101');
      // Resized from the left edge, past the cat: the cat stays where it was (now off the edge).
      api.update('101', { rect: rect(400, 400, 700, 500) });
      expect(s.provider.getSurface('windowTop:101', s.now() + 5)).toMatchObject({ x0: 408, x1: 1092 });
    });

    it('a wall dragged vertically under a climbing cat', () => {
      const api = new SurfaceApi().add(win('101', rect(300, 400, 800, 500)));
      // A tool window beside the right side splits it: [408, 600) and [700, 892).
      api.extras = [{ id: 'tool', rect: rect(1090, 600, 100, 100) }];
      const s = setup({ api });
      s.tick();
      hostTick(s, { x: 1100, y: 860, surfaceId: 'windowSide:101:right' });
      expect(wall(s.tick(), 'windowSide:101:right')).toMatchObject({ y0: 700, y1: 892 });
      api.fire('moveStart', '101');
      hostTick(s, { x: 1100, y: 860, surfaceId: 'windowSide:101:right' });
      api.update('101', { rect: rect(300, 340, 800, 500) });
      // Carried up 60 px with the window: still on the lower part, whose bottom moved up too.
      expect(s.provider.getSurface('windowSide:101:right', s.now() + 5)).toMatchObject({ x: 1100, y0: 700, y1: 832 });
      api.update('101', { rect: rect(300, 100, 800, 500) });
      s.provider.noteCat({ x: 1100, y: 800, surfaceId: 'windowSide:101:right' });
      // Dragged 240 px further up: the whole side is now above the tool window.
      expect(s.provider.getSurface('windowSide:101:right', s.now() + 10)).toMatchObject({ y0: 108, y1: 592 });
    });
  });

  it('shares one OS read between sim sub-steps of the same moment', () => {
    const api = new SurfaceApi().add(win('101', rect(300, 400, 800, 500)));
    const s = setup({ api });
    s.tick();
    const reads = s.provider.debugInfo().liveReads;
    for (let i = 0; i < 4; i++) s.provider.getSurface('windowTop:101', s.now());
    expect(s.provider.debugInfo().liveReads - reads).toBe(1);
  });
});

describe('tab strips', () => {
  const browser = (id: string, r = rect(300, 200, 1100, 700)) => win(id, r, { category: 'browser', processName: 'msedge.exe' });

  it('replace the window top (same y, safe span cut by occlusion) and shift with the window', () => {
    const api = new SurfaceApi().add(browser('102'));
    const s = setup({ api });
    s.tabs!.ledges = [stripLedge('102')];
    let list = s.tick();
    expect(byId(list, 'windowTop:102')).toBeUndefined();
    expect(ledge(list, 'tabStrip:102')).toMatchObject({ y: 200, x0: 341, x1: 1250, rest: { x0: 341, x1: 1250 }, focusX: 500 });
    // The walls pull up onto the strip that replaces the top (the open edge runs from each
    // corner to it); whether a corner is close enough is the sim's call.
    expect([wall(list, 'windowSide:102:left').topLedgeId, wall(list, 'windowSide:102:right').topLedgeId]).toEqual(['tabStrip:102', 'tabStrip:102']);
    // The window moves; the cached strip moves with it.
    api.update('102', { rect: rect(350, 230, 1100, 700) });
    api.fire('moveStart', '102');
    api.fire('moveEnd', '102');
    list = s.run(200);
    expect(ledge(list, 'tabStrip:102')).toMatchObject({ y: 230, x0: 391, x1: 1300, focusX: 550 });
    expect(ledge(list, 'tabStrip:102').confidence).toBeLessThan(1);
    // A tool window over part of the strip cuts it.
    api.extras = [{ id: 'tool', rect: rect(900, 100, 200, 200) }];
    api.foregroundId = 'tool';
    api.fire('foreground', 'tool');
    expect(ledge(s.run(200), 'tabStrip:102')).toMatchObject({ x0: 391, x1: 900, rest: { x0: 391, x1: 900 }, focusX: 550 });
  });

  it('never swap the ledge under the cat: a strip found while it is on the top waits until it leaves; a lost one goes on along the edge', () => {
    const api = new SurfaceApi().add(browser('102'));
    const s = setup({ api });
    s.tick();
    // On the plain top, right of where the strip will end (over the caption buttons).
    s.provider.noteCat({ x: 1350, y: 200, surfaceId: 'windowTop:102' });
    s.tick();
    s.tabs!.ledges = [stripLedge('102')];
    let list = s.tick();
    expect(ledge(list, 'windowTop:102')).toMatchObject({ y: 200, x0: 308, x1: 1392 });
    expect(byId(list, 'tabStrip:102')).toBeUndefined();
    expect([wall(list, 'windowSide:102:left').topLedgeId, wall(list, 'windowSide:102:right').topLedgeId]).toEqual(['windowTop:102', 'windowTop:102']);
    expect(s.provider.getSurface('windowTop:102', s.now())).toMatchObject({ kind: 'windowTop', x0: 308, x1: 1392, y: 200 });
    // It jumps off: the strip takes over.
    s.provider.noteCat({ x: 1500, y: 1152, surfaceId: null });
    list = s.tick();
    expect(byId(list, 'windowTop:102')).toBeUndefined();
    expect(ledge(list, 'tabStrip:102')).toMatchObject({ x0: 341, x1: 1250 });
    expect(wall(list, 'windowSide:102:left').topLedgeId).toBe('tabStrip:102');
    // On the strip, the strip is lost (helper restarted): the ledge goes on along the top edge.
    s.provider.noteCat({ x: 700, y: 200, surfaceId: 'tabStrip:102' });
    s.tick();
    s.tabs!.ledges = [];
    list = s.tick();
    expect(ledge(list, 'tabStrip:102')).toMatchObject({ kind: 'tabStrip', y: 200, x0: 308, x1: 1392, confidence: 0.5 });
    expect(byId(list, 'windowTop:102')).toBeUndefined();
    expect(s.provider.getSurface('tabStrip:102', s.now() + 5)).toMatchObject({ id: 'tabStrip:102', kind: 'tabStrip', y: 200, x0: 308, confidence: 0.5 });
    // Off it, the plain top is back.
    s.provider.noteCat({ x: 1500, y: 1152, surfaceId: null });
    list = s.tick();
    expect(ledge(list, 'windowTop:102')).toMatchObject({ x0: 308, x1: 1392 });
    expect(byId(list, 'tabStrip:102')).toBeUndefined();
  });

  it('keep their objects when the service returns a new list with the same content', () => {
    const api = new SurfaceApi().add(browser('102'));
    const s = setup({ api });
    s.tabs!.ledges = [stripLedge('102')];
    const a = s.tick();
    const recomputes = s.provider.debugInfo().recomputes;
    // The real service builds a fresh array (and a fresh validatedAt) on every call.
    s.tabs!.ledges = [stripLedge('102', { validatedAt: 1500 })];
    const b = s.tick();
    expect(b).toBe(a);
    expect(s.provider.debugInfo().recomputes).toBe(recomputes);
  });

  it('are not shifted twice when the service re-places them on the moved frame', () => {
    const api = new SurfaceApi().add(browser('102'));
    const s = setup({ api });
    s.tabs!.ledges = [stripLedge('102')];
    s.tick();
    // A snap (no move events): the service re-reads the frame first and moves its strip.
    api.update('102', { rect: rect(400, 260, 1100, 700) });
    s.tabs!.ledges = [stripLedge('102', { y: 260, x0: 441, x1: 1350, rest: { x0: 441, x1: 1350 }, focusX: 600 })];
    const list = s.tick();
    expect(ledge(list, 'tabStrip:102')).toMatchObject({ y: 260, x0: 441, x1: 1350, focusX: 600 });
    // The live read that anchored the strip also moved the window's own surfaces.
    expect(wall(list, 'windowSide:102:left')).toMatchObject({ x: 400 });
    // The settled tracker change that follows does not shift it again.
    api.fire('moveStart', '102');
    api.fire('moveEnd', '102');
    expect(ledge(s.run(300), 'tabStrip:102')).toMatchObject({ y: 260, x0: 441, x1: 1350 });
    // Riding: a live read while dragging shifts the strip from the frame it was placed on.
    api.fire('moveStart', '102');
    s.tick(16);
    api.update('102', { rect: rect(410, 250, 1100, 700) });
    s.provider.noteCat({ x: 700, y: 260, surfaceId: 'tabStrip:102' });
    expect(s.provider.getSurface('tabStrip:102', s.now() + 10)).toMatchObject({ y: 250, x0: 451, x1: 1360, focusX: 610 });
  });

  it('are ignored while the tabStrips toggle is off', () => {
    const api = new SurfaceApi().add(browser('102'));
    const settings = defaultSettings();
    settings.behavior.disabledBehaviors = ['tabStrips'];
    const s = setup({ api, settings });
    s.tabs!.ledges = [stripLedge('102')];
    expect(ids(s.tick())).toContain('windowTop:102');
    expect(s.tabs!.settingsSeen).toEqual([]);
    s.provider.updateSettings(defaultSettings());
    expect(s.tabs!.settingsSeen).toHaveLength(1);
    expect(ids(s.tick())).toContain('tabStrip:102');
  });

  it('get interest only for browser windows within reach of the cat (the foreground one is no exception), never private ones', () => {
    const api = new SurfaceApi()
      .add(browser('104', rect(300, 400, 800, 400)))
      .add(browser('105', rect(1300, 100, 500, 400)))
      .add(win('106', rect(200, 380, 400, 300), { category: 'browser', excluded: true }))
      .add(win('107', rect(250, 390, 300, 300), { category: 'code' }));
    api.foregroundId = '105';
    const s = setup({ api });
    s.provider.noteCat({ x: 420, y: 395, surfaceId: null });
    s.tick();
    const first = s.tabs!.interest.at(-1)!;
    // The foreground browser is far from the cat: it is not polled.
    expect(first.ids).toEqual(['104']);
    // Rate-limited.
    const n = s.tabs!.interest.length;
    s.tick(100);
    expect(s.tabs!.interest.length).toBe(n);
    s.run(600);
    expect(s.tabs!.interest.every((c) => !c.ids.includes('105') && !c.ids.includes('106') && !c.ids.includes('107'))).toBe(true);
    // The cat comes over to it.
    s.provider.noteCat({ x: 1500, y: 120, surfaceId: null });
    s.run(600);
    expect(s.tabs!.interest.at(-1)!.ids).toEqual(['105']);
    // Hidden cat (still on its surface): interest is withdrawn once, then nothing more is sent.
    s.provider.noteCat({ x: 1500, y: 100, surfaceId: 'windowTop:105', hidden: true });
    s.run(600);
    expect(s.tabs!.interest.at(-1)!.ids).toEqual([]);
    const sent = s.tabs!.interest.length;
    s.run(2000);
    expect(s.tabs!.interest.length).toBe(sent);
  });

  it('a hidden cat keeps its attachment: the part of a split top it is on is still served', () => {
    const api = new SurfaceApi().add(win('101', rect(300, 400, 800, 500)));
    api.extras = [{ id: 'dlg', rect: rect(650, 350, 200, 150) }];
    const s = setup({ api });
    s.tick();
    s.provider.noteCat({ x: 1000, y: 400, surfaceId: 'windowTop:101' });
    expect(ledge(s.tick(), 'windowTop:101')).toMatchObject({ x0: 850, x1: 1092 });
    for (let i = 0; i < 8; i++) {
      s.provider.noteCat({ x: 1000, y: 400, surfaceId: 'windowTop:101', hidden: true });
      s.tick(500);
    }
    expect(ledge(s.tick(), 'windowTop:101')).toMatchObject({ x0: 850, x1: 1092 });
    expect(s.provider.getSurface('windowTop:101', s.now())).toMatchObject({ x0: 850, x1: 1092 });
  });
});

describe('taskbars, events and status', () => {
  const bar = (over: Partial<LedgeSurface> = {}): LedgeSurface => ({
    id: 'taskbar:65552',
    kind: 'taskbar',
    orientation: 'ledge',
    ownerId: '65552',
    displayId: '1',
    phase: 'stable',
    vx: 0,
    vy: 0,
    confidence: 1,
    validatedAt: 1000,
    excluded: false,
    y: 1139,
    x0: 0,
    x1: 1920,
    rest: null,
    focusX: null,
    edge: 'bottom',
    ...over,
  });

  it('lists taskbar ledges first and always fresh, and reads them by id', () => {
    const api = new SurfaceApi().add(win('101', rect(300, 400, 800, 500)));
    const s = setup({ api });
    s.taskbars.ledges = [bar()];
    expect(ids(s.tick())[0]).toBe('taskbar:65552');
    s.taskbars.ledges = [bar({ y: 1150, vy: -300, phase: 'entering' })];
    expect(ledge(s.tick(), 'taskbar:65552')).toMatchObject({ y: 1150, vy: -300 });
    expect(s.provider.getSurface('taskbar:65552', s.now())).toMatchObject({ y: 1150 });
    s.taskbars.ledges = [];
    expect(s.provider.getSurface('taskbar:65552', s.now())).toBeNull();
  });

  it('drains only taskbar and tab events, dropping tab events of private windows and when toggled off', () => {
    const api = new SurfaceApi().add(win('101', rect(300, 400, 800, 500), { category: 'browser' })).add(win('102', rect(1300, 400, 500, 500), { category: 'browser', excluded: true }));
    const s = setup({ api });
    s.tick();
    const shown: SimEvent = { type: 'taskbar.shown', surfaceId: 'taskbar:65552', displayId: '1', edge: 'bottom' };
    s.taskbars.events.push(shown, { type: 'display.changed' });
    s.tabs!.events.push(
      { type: 'tabs.changed', surfaceId: 'tabStrip:101', ownerId: '101', change: 'added', focusX: 400 },
      { type: 'tabs.changed', surfaceId: 'tabStrip:102', ownerId: '102', change: 'selected', focusX: 1400 },
      { type: 'tabs.changed', surfaceId: 'tabStrip:999', ownerId: '999', change: 'removed', focusX: null },
    );
    expect(s.provider.drainEvents()).toEqual([shown, { type: 'tabs.changed', surfaceId: 'tabStrip:101', ownerId: '101', change: 'added', focusX: 400 }]);
    const settings = defaultSettings();
    settings.behavior.disabledBehaviors = ['taskbarPlay'];
    s.provider.updateSettings(settings);
    s.taskbars.events.push(shown);
    s.taskbars.ledges = [bar()];
    expect(s.provider.drainEvents()).toEqual([]);
    expect(ids(s.tick())).not.toContain('taskbar:65552');
    expect(s.provider.getSurface('taskbar:65552', s.now())).toBeNull();
  });

  it('reports status from its observers, and degrades without Win32 or a tab-strip service', () => {
    const s = setup({ api: new SurfaceApi(), tabs: null });
    s.taskbars.states = [
      { id: '65552', displayId: '1', edge: 'bottom', autoHide: true, rect: rect(0, 1198, 1920, 60), dockedRect: rect(0, 1140, 1920, 60), shownFraction: 0.03, phase: 'hidden', speed: 0, validatedAt: 1000 },
    ];
    expect(s.provider.status).toEqual({ taskbar: 'tracked', taskbars: 1, windowSurfaces: 'tracked', tabStrips: 'unavailable', tabStripReason: 'Tab-strip discovery is not available in this build.' });

    const logger = createTestLogger();
    const offline = createUnavailableWin32Api();
    const tracker = createWindowTracker(offline, logger);
    tracker.start();
    const taskbars = new FakeTaskbars();
    taskbars.ledges = [bar()];
    const p = createSurfaceProvider({ logger, tracker, win32: offline, taskbars, tabStrips: new FakeTabs(), display: fakeDisplay([disp('1', 0, 0, 1920, 1200)]), settings: defaultSettings() });
    expect(p.status.windowSurfaces).toBe('unavailable');
    expect(ids(p.getSurfaces(0, 1000))).toEqual(['taskbar:65552']);
    expect(p.getSurface('windowTop:1', 0)).toBeNull();
  });

  it('falls back to the app-window list when the full z-order is unavailable', () => {
    const api = new FakeWin32Api().add(win('101', rect(300, 400, 800, 500))).add(win('102', rect(600, 300, 200, 300)));
    const s = setup({ api });
    expect(ledge(s.tick(), 'windowTop:101')).toMatchObject({ x0: 308, x1: 600 });
  });

  it('caps the list (taskbars first, then windows top-down)', () => {
    const api = new SurfaceApi();
    for (let i = 0; i < 6; i++) api.add(win(String(300 + i), rect(100 + i * 300, 300, 250, 300)), false);
    const s = setup({ api, options: { maxSurfaces: 4 } });
    s.taskbars.ledges = [bar()];
    expect(ids(s.tick())).toEqual(['taskbar:65552', 'windowTop:300', 'windowSide:300:left', 'windowSide:300:right']);
  });

  it('rebuilds after a display change (new scale, new insets)', () => {
    const api = new SurfaceApi().add(win('101', rect(300, 400, 800, 500)));
    const s = setup({ api });
    expect(ledge(s.tick(), 'windowTop:101').x0).toBe(308);
    s.display.change([disp('1', 0, 0, 1920, 1200, 1.5)]);
    expect(ledge(s.tick(), 'windowTop:101').x0).toBe(312);
  });
});

describe('test-mode injection', () => {
  const fake = (y: number): LedgeSurface => ({
    id: 'taskbar:e2e',
    kind: 'taskbar',
    orientation: 'ledge',
    ownerId: '1',
    displayId: '1',
    phase: 'entering',
    vx: 0,
    vy: -200,
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

  it('replaces every surface, raises taskbar.shown/hidden for injected taskbars and restores the real ones', () => {
    const api = new SurfaceApi().add(win('101', rect(300, 400, 800, 500)));
    const s = setup({ api });
    s.tick();
    s.provider.injectSurfaces([fake(1180)], s.now());
    expect(s.provider.getSurfaces(s.now(), 1000)).toEqual([{ ...fake(1180), validatedAt: s.now() }]);
    expect(s.provider.getSurface('taskbar:e2e', s.now())).toMatchObject({ y: 1180 });
    expect(s.provider.getSurface('windowTop:101', s.now())).toBeNull();
    s.taskbars.events.push({ type: 'taskbar.hidden', surfaceId: 'taskbar:65552', displayId: '1', edge: 'bottom' });
    expect(s.provider.drainEvents()).toEqual([{ type: 'taskbar.shown', surfaceId: 'taskbar:e2e', displayId: '1', edge: 'bottom' }]);
    s.provider.injectSurfaces([fake(1100)], s.now());
    expect(s.provider.drainEvents()).toEqual([]);
    s.provider.injectSurfaces(null, s.now());
    expect(s.provider.drainEvents()).toEqual([{ type: 'taskbar.hidden', surfaceId: 'taskbar:e2e', displayId: '1', edge: 'bottom' }]);
    expect(ids(s.tick())).toContain('windowTop:101');
    expect(s.provider.debugInfo().injected).toBeNull();
  });

  it('stops everything on dispose', async () => {
    const api = new SurfaceApi().add(win('101', rect(300, 400, 800, 500)));
    const s = setup({ api });
    s.tick();
    await s.provider.dispose();
    expect(s.provider.getSurfaces(s.now(), 1000)).toEqual([]);
    expect(s.provider.getSurface('windowTop:101', s.now())).toBeNull();
  });
});
