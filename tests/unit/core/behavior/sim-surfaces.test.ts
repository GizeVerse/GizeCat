// v1.1 behaviour on environment surfaces: taskbars (lift, ride down, retraction, flapping,
// reactions by state and personality), window tops and sides (ride, detach, climb), tab
// strips (rest span, focus), toggles, output (climb clip, bounds, support) and persistence.
import { describe, expect, it } from 'vitest';
import type { BehaviorState } from '../../../../src/shared/cat';
import type { PersistedCat, Stats, Traits } from '../../../../src/shared/catState';
import type { Rect } from '../../../../src/shared/geometry';
import type { SimEvent, SimOutput, SimSupport } from '../../../../src/shared/sim';
import type { DisplayGeometry, WindowInfo } from '../../../../src/shared/world';
import { mulberry32, newPersistedCat } from '../../../../src/core/behavior';
import { PHYSICAL_STATES } from '../../../../src/core/behavior/states';
import { callCat, display, Harness, onWindowTop, settingsWith, SINGLE, stripId, tabStrip, taskbar, taskbarId, WAKE_MS, world } from './fixtures';

const MIN = 60_000;
const WALL = 1_800_000_000_000;
const BW = 84;
const BH = 64;

/** Auto-hide taskbar setup: the work area is the whole 1920x1200 screen. */
const AH: DisplayGeometry = display('1', 0, 0, 1920, 1200, { primary: true });
const AUTOHIDE = world(AH);
const TB_TOP = 1152;
const TB_ID = taskbarId('tb');
const tbAt = (top: number, extra: Parameters<typeof taskbar>[3] = {}) => taskbar('tb', AH, top, extra);
const SHOWN: SimEvent = { type: 'taskbar.shown', surfaceId: TB_ID, displayId: '1', edge: 'bottom' };
const HIDDEN: SimEvent = { type: 'taskbar.hidden', surfaceId: TB_ID, displayId: '1', edge: 'bottom' };
const onTaskbar = (s: SimSupport): boolean => s.kind === 'surface' && s.surfaceId === TB_ID;

function catWith(seed: number, traits: Partial<Traits> = {}, stats: Partial<Stats> = {}): PersistedCat {
  const cat = newPersistedCat(mulberry32(seed), WALL - 3600_000);
  Object.assign(cat.traits, traits);
  Object.assign(cat.stats, stats);
  return cat;
}

const CURIOUS: Partial<Traits> = { curiosity: 1, playfulness: 1, confidence: 1, energyLevel: 1, laziness: 0 };
const PLACID: Partial<Traits> = { curiosity: 0.2, playfulness: 0.2, confidence: 0.4, energyLevel: 0.3, laziness: 0.8 };

/** Slides the taskbar in over a few frames (the provider's 60 Hz burst), then holds it shown. */
function slideIn(h: Harness): void {
  h.env.extraSurfaces = [tbAt(1190, { phase: 'entering', vy: -900 })];
  h.step([SHOWN]);
  for (const t of [1175, 1160, TB_TOP]) {
    h.env.extraSurfaces = [tbAt(t, { phase: 'entering', vy: -900 })];
    h.step();
  }
  h.env.extraSurfaces = [tbAt(TB_TOP)];
}

/** Slides it out and removes it once less than half of it is on screen. */
function slideOut(h: Harness): void {
  h.env.extraSurfaces = [tbAt(1165, { phase: 'leaving', vy: 900 })];
  h.step([HIDDEN]);
  h.env.extraSurfaces = [tbAt(1178, { phase: 'leaving', vy: 900 })];
  h.step();
  h.env.extraSurfaces = [];
}

function windowInfo(id: string, rect: Rect, o: Partial<WindowInfo> = {}): WindowInfo {
  return { id, rect, processName: 'app.exe', category: 'browser', minimized: false, maximized: false, fullscreen: false, excluded: false, ...o };
}

const stimulusTo = (h: Harness, from: number): BehaviorState[] => h.transitions.slice(from).filter((t) => t.cause === 'stimulus').map((t) => t.to);

describe('taskbar: physics as seen by the cat', () => {
  it('a sleeping cat is lifted by a sliding taskbar and lowered again without waking, startling or falling', () => {
    const h = new Harness({ seed: 3, world: AUTOHIDE, persisted: catWith(3, PLACID) });
    h.run(WAKE_MS);
    h.step([{ type: 'command.sleep' }]);
    expect(h.runUntil((o) => o.state === 'sleeping', 10_000)).toBe(true);
    const from = h.transitions.length;
    slideIn(h);
    h.run(3000);
    expect(h.last!.state).toBe('sleeping');
    expect(onTaskbar(h.last!.support)).toBe(true);
    expect(h.last!.y).toBe(TB_TOP - 1);
    slideOut(h);
    h.run(3000);
    expect(h.last!.state).toBe('sleeping');
    expect(h.last!.support).toEqual({ kind: 'floor', displayId: '1' });
    expect(h.last!.y).toBe(1200);
    expect(h.transitions.slice(from).map((t) => t.to)).toEqual([]);
  });

  it('a taskbar vanishing at once under an awake cat never startles it or makes it afraid', () => {
    for (const seed of [1, 2, 3, 4]) {
      const h = new Harness({ seed, world: AUTOHIDE });
      h.run(WAKE_MS);
      slideIn(h);
      h.run(1500);
      expect(onTaskbar(h.last!.support)).toBe(true);
      const fear0 = h.sim.serialize().stats.fear;
      const from = h.transitions.length;
      // Gone at once, without a slide (no in-between samples).
      h.env.extraSurfaces = [];
      h.step([HIDDEN]);
      h.run(3000);
      const to = h.transitions.slice(from).map((t) => t.to);
      expect(to).not.toContain('startled');
      expect(to).not.toContain('hiding');
      expect(h.sim.serialize().stats.fear).toBeLessThanOrEqual(fear0 + 1e-9);
      expect(h.last!.support.kind).toBe('floor');
      expect(PHYSICAL_STATES.has(h.last!.state)).toBe(false);
    }
  });

  it('flapping 50 times in 10 s: bounded reactions, at most one hop, no startle and no stuck state', () => {
    for (const seed of [1, 2, 3, 4, 5]) {
      const h = new Harness({ seed, world: AUTOHIDE, persisted: catWith(seed, CURIOUS, { energy: 1 }), settings: settingsWith({ behavior: { activitySensitivity: 1, autonomy: 1 } }) });
      h.run(WAKE_MS + 3000);
      const from = h.transitions.length;
      let shown = false;
      let flips = 0;
      h.run(10_000, 33, (hh, i) => {
        if (i % 6 !== 0) return [];
        shown = !shown;
        flips++;
        hh.env.extraSurfaces = shown ? [tbAt(TB_TOP)] : [];
        return [shown ? SHOWN : HIDDEN];
      });
      expect(flips).toBeGreaterThanOrEqual(50);
      const all = h.transitions.slice(from);
      // One decision per 4 s at most, however often it flaps.
      expect(stimulusTo(h, from).length).toBeLessThanOrEqual(3);
      expect(all.filter((t) => t.to === 'jumping').length).toBeLessThanOrEqual(2);
      expect(all.some((t) => t.to === 'startled')).toBe(false);
      expect(h.sim.serialize().stats.fear).toBeLessThan(0.05);
      // It settles once the flapping stops.
      h.env.extraSurfaces = [];
      h.run(8000);
      expect(PHYSICAL_STATES.has(h.last!.state)).toBe(false);
      expect(h.last!.support.kind).toBe('floor');
      expect(h.last!.y).toBe(1200);
      expect(h.sim.debugInfo().invalidSamples).toEqual([]);
    }
  });

  it('held or thrown, the cat ignores a taskbar that appears', () => {
    const h = new Harness({ seed: 7, world: AUTOHIDE, persisted: catWith(7, CURIOUS) });
    h.run(WAKE_MS);
    const o = h.last!;
    h.step([{ type: 'pointer.dragStart', at: { x: o.x, y: o.y - 30 } }]);
    h.env.dragCursor = { x: 600, y: 500 };
    h.run(300);
    expect(h.last!.state).toBe('held');
    const from = h.transitions.length;
    slideIn(h);
    h.run(500);
    expect(stimulusTo(h, from)).toEqual([]);
    h.env.dragCursor = null;
    h.step([{ type: 'pointer.dragEnd', at: { x: 600, y: 500 }, velocity: { x: 2500, y: -800 } }]);
    h.step([SHOWN]);
    expect(stimulusTo(h, from)).toEqual([]);
    expect(h.runUntil((x) => x.state === 'landing', 5000)).toBe(true);
    // A taskbar is solid: the thrown cat lands on it, not inside it.
    expect(h.last!.y === TB_TOP - 1 || h.last!.y === 1200).toBe(true);
    if (h.last!.y === 1200) expect(h.last!.support.kind).toBe('floor');
  });

  it('awake on a window top, a curious cat may hop down onto a taskbar that appears; a placid one only looks', () => {
    const rect = { x: 700, y: 760, width: 600, height: 440 };
    const run = (traits: Partial<Traits>, seed: number): { reacted: BehaviorState[]; onIt: boolean; looked: boolean } => {
      const h = new Harness({ seed, world: AUTOHIDE, persisted: catWith(seed, traits, { energy: 1, fear: 0 }), settings: settingsWith({ behavior: { activitySensitivity: 1 } }) });
      h.env.windows = { w: rect };
      h.run(WAKE_MS);
      callCat(h, { x: 1000, y: 700 });
      expect(h.runUntil((x) => onWindowTop(x.support, 'w') && x.state === 'idle', 30_000)).toBe(true);
      const from = h.transitions.length;
      slideIn(h);
      let looked = false;
      let onIt = false;
      h.run(15_000, 33, (hh) => {
        const look = hh.last!.look;
        if (look && Math.abs(look.y - (TB_TOP - 1)) < 2) looked = true;
        if (onTaskbar(hh.last!.support)) onIt = true;
      });
      return { reacted: stimulusTo(h, from), onIt, looked };
    };
    // The reaction is a walk over (then a hop down onto it); later, ordinary wandering may also lead there.
    let hops = 0;
    for (const seed of [1, 2, 3, 4]) {
      const r = run(CURIOUS, seed);
      if (r.reacted.includes('walking') && r.onIt) hops++;
    }
    expect(hops).toBeGreaterThanOrEqual(2);
    for (const seed of [1, 2, 3, 4]) {
      const r = run({ ...PLACID, curiosity: 0.05, playfulness: 0 }, seed);
      expect(r.reacted.filter((s) => s === 'walking')).toEqual([]);
    }
  });

  it('a walking cat lifted by the taskbar keeps walking on it to where it was going', () => {
    for (const seed of [1, 2, 3]) {
      const h = new Harness({ seed, world: AUTOHIDE, persisted: catWith(seed, PLACID) });
      h.run(WAKE_MS);
      const goalX = h.last!.x < 960 ? 1700 : 200;
      callCat(h, { x: goalX, y: 1190 });
      h.run(600);
      expect(['walking', 'running']).toContain(h.last!.state);
      const from = h.transitions.length;
      slideIn(h);
      expect(h.runUntil((o) => Math.abs(o.x - goalX) < 6 && o.speed === 0, 40_000)).toBe(true);
      expect(onTaskbar(h.last!.support)).toBe(true);
      expect(h.last!.y).toBe(TB_TOP - 1);
      const to = h.transitions.slice(from).map((t) => t.to);
      expect(to).not.toContain('falling');
      expect(to).not.toContain('jumping');
    }
  });

  it('a resting cat gets at most a look at a taskbar that appears, and settles back', () => {
    const rect = { x: 700, y: 760, width: 600, height: 440 };
    let rested = 0;
    for (const seed of [1, 2, 3, 4, 5, 6]) {
      const h = new Harness({ seed, world: AUTOHIDE, persisted: catWith(seed, { ...PLACID, laziness: 1 }, { energy: 0.3 }), settings: settingsWith({ behavior: { autonomy: 0.2 } }) });
      h.env.windows = { w: rect };
      h.run(WAKE_MS);
      callCat(h, { x: 1000, y: 700 });
      if (!h.runUntil((o) => o.state === 'resting' && onWindowTop(o.support, 'w'), 10 * MIN, 100)) continue;
      rested++;
      const from = h.transitions.length;
      slideIn(h);
      h.run(10_000);
      const reacted = stimulusTo(h, from);
      expect(reacted.filter((s) => s !== 'curious')).toEqual([]);
      expect(onWindowTop(h.last!.support, 'w')).toBe(true);
    }
    expect(rested).toBeGreaterThanOrEqual(2);
  });

  it('a curious cat asleep right above it may wake once; a far or placid one never does', () => {
    const wakes = (traits: Partial<Traits>, seeds: number[]): number => {
      let n = 0;
      for (const seed of seeds) {
        const h = new Harness({ seed, world: AUTOHIDE, persisted: catWith(seed, traits, { energy: 1 }), settings: settingsWith({ behavior: { activitySensitivity: 1 } }) });
        h.run(WAKE_MS);
        h.step([{ type: 'command.sleep' }]);
        expect(h.runUntil((o) => o.state === 'sleeping', 10_000)).toBe(true);
        const from = h.transitions.length;
        for (let k = 0; k < 6; k++) {
          slideIn(h);
          h.run(2000);
          slideOut(h);
          h.run(6000);
        }
        const w = stimulusTo(h, from).filter((s) => s === 'wakingUp').length;
        expect(w).toBeLessThanOrEqual(1);
        n += w;
      }
      return n;
    };
    expect(wakes(CURIOUS, [1, 2, 3, 4, 5, 6])).toBeGreaterThanOrEqual(1);
    expect(wakes(PLACID, [1, 2, 3])).toBe(0);
  });

  it('with "taskbarPlay" off a taskbar neither lifts the cat nor gets any reaction', () => {
    const h = new Harness({ seed: 2, world: AUTOHIDE, persisted: catWith(2, CURIOUS), settings: settingsWith({ behavior: { disabledBehaviors: ['taskbarPlay'], activitySensitivity: 1 } }) });
    h.run(WAKE_MS);
    const from = h.transitions.length;
    h.keepOutputs = true;
    for (let k = 0; k < 5; k++) {
      slideIn(h);
      h.run(3000);
      slideOut(h);
      h.run(3000);
    }
    expect(h.outputs.some((o) => o.support.kind === 'surface')).toBe(false);
    expect(stimulusTo(h, from)).toEqual([]);
  });

  it('roams between two auto-hide displays: steps up onto the shown taskbar, and down off its end', () => {
    const d1 = display('1', 0, 0, 1920, 1200, { primary: true });
    const d2 = display('2', 1920, 0, 1920, 1200);
    const h = new Harness({ seed: 5, world: world(d1, d2), persisted: catWith(5, PLACID) });
    h.run(WAKE_MS);
    h.env.extraSurfaces = [taskbar('tb2', d2, TB_TOP)];
    callCat(h, { x: 2900, y: 1190 });
    expect(h.runUntil((o) => o.support.kind === 'surface' && o.support.surfaceId === taskbarId('tb2') && !PHYSICAL_STATES.has(o.state) && o.speed === 0, 40_000)).toBe(true);
    expect(h.last!.displayId).toBe('2');
    expect(h.last!.y).toBe(TB_TOP - 1);
    callCat(h, { x: 600, y: 1190 });
    expect(h.runUntil((o) => o.support.kind === 'floor' && o.displayId === '1' && o.speed === 0 && !PHYSICAL_STATES.has(o.state), 60_000)).toBe(true);
    expect(h.transitions.some((t) => t.to === 'startled')).toBe(false);
  });
});

describe('window tops and sides', () => {
  const RECT = { x: 600, y: 760, width: 700, height: 280 };

  function perched(seed = 11): Harness {
    const h = new Harness({ seed, persisted: catWith(seed, PLACID) });
    h.env.windows = { w: { ...RECT } };
    h.run(WAKE_MS);
    callCat(h, { x: 950, y: 700 });
    expect(h.runUntil((o) => onWindowTop(o.support, 'w') && o.state === 'idle', 30_000)).toBe(true);
    return h;
  }

  it('rides a window being dragged, and keeps riding until it is let go', () => {
    const h = perched();
    const x0 = h.last!.x;
    h.step([{ type: 'window.moveStart', id: 'w' }]);
    for (let i = 1; i <= 40; i++) {
      h.env.windows = { w: { ...RECT, x: RECT.x - 8 * i, y: RECT.y - 4 * i } };
      const o = h.step();
      expect(onWindowTop(o.support, 'w')).toBe(true);
      expect(o.y).toBe(RECT.y - 4 * i);
      expect(o.x).toBeCloseTo(x0 - 8 * i, 6);
      expect(PHYSICAL_STATES.has(o.state)).toBe(false);
    }
    h.step([{ type: 'window.moveEnd', id: 'w', rect: h.env.windows?.w ?? null }]);
    h.run(2000);
    expect(onWindowTop(h.last!.support, 'w')).toBe(true);
  });

  it.each([
    ['closed', (h: Harness): SimEvent[] => ((h.env.windows = {}), [{ type: 'window.closed', id: 'w', rect: RECT, category: 'browser' }])],
    ['minimized', (h: Harness): SimEvent[] => ((h.env.windows = {}), [{ type: 'window.minimized', id: 'w' }])],
    ['maximized', (h: Harness): SimEvent[] => ((h.env.windows = { w: { x: 0, y: 0, width: 1920, height: 1040 } }), [])],
  ])('a window %s under the cat: it drops with a short start (lost footing), not a fright', (_label, change) => {
    const h = perched();
    const fear0 = h.sim.serialize().stats.fear;
    const from = h.transitions.length;
    h.step(change(h));
    const variants: unknown[] = [];
    h.run(4000, 33, (hh) => {
      if (hh.last!.state === 'startled') variants.push(hh.sim.debugInfo().variant);
    });
    const to = h.transitions.slice(from).map((t) => t.to);
    expect(to.slice(0, 3)).toEqual(['falling', 'landing', 'startled']);
    expect(new Set(variants)).toEqual(new Set(['lostFooting']));
    expect(h.sim.serialize().stats.fear - fear0).toBeLessThanOrEqual(0.16);
    expect(h.last!.support.kind).toBe('floor');
  });

  it('a window closed mid-jump: it falls to the floor and carries on, without a start', () => {
    for (const seed of [1, 2, 3]) {
      const h = new Harness({ seed, persisted: catWith(seed, PLACID) });
      h.env.windows = { w: { ...RECT } };
      h.run(WAKE_MS);
      callCat(h, { x: 950, y: 700 });
      expect(h.runUntil((o) => o.state === 'jumping' && o.support.kind === 'air', 30_000)).toBe(true);
      const from = h.transitions.length;
      h.env.windows = {};
      h.step([{ type: 'window.closed', id: 'w', rect: RECT, category: 'browser' }]);
      expect(h.runUntil((o) => o.state === 'landing', 3000)).toBe(true);
      h.run(1500);
      expect(h.transitions.slice(from).some((t) => t.to === 'startled')).toBe(false);
      expect(h.last!.support.kind).toBe('floor');
    }
  });

  it('a curious cat sometimes climbs a window side and pulls up onto the top; the climb shows as such', () => {
    // A tall window standing on the floor (640 px: too high to jump onto).
    const tall = { x: 900, y: 400, width: 600, height: 640 };
    let climbed = 0;
    for (const seed of [1, 2, 3, 4, 5, 6]) {
      const h = new Harness({ seed, persisted: catWith(seed, CURIOUS, { energy: 1, boredom: 0.8 }), settings: settingsWith({ behavior: { autonomy: 1 } }) });
      h.env.windows = { t: tall };
      let onWall = false;
      let toppedOut = false;
      h.run(40 * MIN, 66, (hh) => {
        const o = hh.last!;
        const wallSupport = o.support.kind === 'surface' && o.support.orientation === 'wall';
        if (o.clip === 'climb') expect(wallSupport).toBe(true);
        if (wallSupport) expect(['climb', 'walk']).toContain(o.clip);
        if (wallSupport) {
          onWall = true;
          // Vertical pose: about a body length tall, hanging outside the window.
          expect(o.boundsPx.height).toBeGreaterThanOrEqual(BW - 1e-6);
          expect(o.boundsPx.y).toBeCloseTo(o.y - BW, 6);
          if (o.support.kind === 'surface' && o.support.surfaceId.endsWith(':left')) expect(o.boundsPx.x).toBeLessThan(o.x - BH * 0.9);
          else expect(o.boundsPx.x + o.boundsPx.width).toBeGreaterThan(o.x + BH * 0.9);
        }
        if (onWall && onWindowTop(o.support, 't')) toppedOut = true;
      });
      if (onWall && toppedOut) climbed++;
    }
    expect(climbed).toBeGreaterThanOrEqual(1);
  }, 120_000);

  it('with "Climb windows" off it never climbs (and with "Sit on windows" off neither)', () => {
    const tall = { x: 900, y: 400, width: 600, height: 640 };
    for (const disabled of [['climbWindows'], ['perchOnWindows']] as const) {
      for (const seed of [1, 2]) {
        const h = new Harness({ seed, persisted: catWith(seed, CURIOUS, { energy: 1, boredom: 0.8 }), settings: settingsWith({ behavior: { autonomy: 1, disabledBehaviors: [...disabled] } }) });
        h.env.windows = { t: tall };
        h.keepOutputs = true;
        h.run(20 * MIN, 100);
        expect(h.outputs.some((o) => o.clip === 'climb' || (o.support.kind === 'surface' && o.support.orientation === 'wall'))).toBe(false);
      }
    }
  });

  it('never climbs or stands on a private window', () => {
    const tall = { x: 900, y: 400, width: 600, height: 640 };
    const h = new Harness({ seed: 4, persisted: catWith(4, CURIOUS, { energy: 1, boredom: 0.8 }), settings: settingsWith({ behavior: { autonomy: 1 } }) });
    h.env.windows = { t: tall };
    h.env.foreground = windowInfo('t', tall, { excluded: true });
    h.keepOutputs = true;
    h.run(20 * MIN, 100);
    expect(h.outputs.some((o) => o.support.kind === 'surface')).toBe(false);
  });

  it('sitting on a window top it may look down into the window (look target below its feet)', () => {
    let lookedDown = false;
    for (const seed of [1, 2, 3, 4, 5, 6, 7, 8]) {
      const h = new Harness({ seed, persisted: catWith(seed, { curiosity: 0.9, laziness: 0.3 }), settings: settingsWith({ behavior: { autonomy: 0.6 } }) });
      h.env.windows = { w: { x: 400, y: 600, width: 1100, height: 440 } };
      h.run(WAKE_MS);
      callCat(h, { x: 950, y: 560 });
      h.run(10 * MIN, 66, (hh) => {
        const o = hh.last!;
        if (o.state === 'inspectingWindow' && hh.sim.debugInfo().variant === 'edge' && o.look && onWindowTop(o.support, 'w') && o.look.y > o.y + BH * 0.9) lookedDown = true;
      });
      if (lookedDown) break;
    }
    expect(lookedDown).toBe(true);
  });
});

describe('tab strips', () => {
  // A browser window whose top is a tab strip (the provider lists the strip instead of the window top).
  const STRIP = tabStrip('b', 700, 500, 1500, { x0: 700, x1: 1200 }, 900);

  function onStrip(seed: number, traits: Partial<Traits> = PLACID): Harness {
    const h = new Harness({ seed, persisted: catWith(seed, traits) });
    h.env.extraSurfaces = [STRIP];
    h.run(WAKE_MS);
    callCat(h, { x: 900, y: 650 });
    expect(h.runUntil((o) => o.support.kind === 'surface' && o.support.surfaceId === stripId('b') && o.state === 'idle', 30_000)).toBe(true);
    return h;
  }

  it('looks toward the active tab when the selection changes', () => {
    const h = onStrip(2);
    h.run(3000);
    const tabs: SimEvent = { type: 'tabs.changed', surfaceId: stripId('b'), ownerId: 'b', change: 'selected', focusX: 1350 };
    const o = h.step([tabs]);
    expect(o.look).not.toBeNull();
    expect(o.look!.x).toBeCloseTo(1350, 6);
    expect(o.look!.y).toBeGreaterThan(700);
    // Geometry-only changes and removals get nothing.
    h.run(3000);
    const g = h.step([{ type: 'tabs.changed', surfaceId: stripId('b'), ownerId: 'b', change: 'geometry', focusX: 600 }]);
    expect(g.look?.x).not.toBeCloseTo(600, 0);
  });

  it('walks the strip only within its span and comes to rest within the resting span', () => {
    for (const seed of [1, 2, 3]) {
      const h = onStrip(seed, { curiosity: 0.9, energyLevel: 0.8 });
      let inStripWalk = false;
      const ends: number[] = [];
      h.run(15 * MIN, 66, (hh, i) => {
        const o = hh.last!;
        const onIt = o.support.kind === 'surface' && o.support.surfaceId === stripId('b');
        if (onIt) {
          expect(o.x).toBeGreaterThanOrEqual(STRIP.x0 - 1e-6);
          expect(o.x).toBeLessThanOrEqual(STRIP.x1 + 1e-6);
        }
        const walking = o.state === 'walking' && hh.sim.debugInfo().variant === 'tabStrip';
        if (inStripWalk && !walking && onIt) ends.push(o.x);
        inStripWalk = walking;
        return i % 900 === 450 ? [{ type: 'tabs.changed', surfaceId: stripId('b'), ownerId: 'b', change: 'selected', focusX: 1000 + (i % 3) * 100 }] : [];
      });
      for (const x of ends) {
        expect(x).toBeGreaterThanOrEqual(700 - BW * 0.05);
        expect(x).toBeLessThanOrEqual(1200 + BW * 0.05);
      }
    }
  });

  it('ignores tab changes of a private window, and events naming another kind of surface', () => {
    const priv = new Harness({ seed: 4, persisted: catWith(4, CURIOUS) });
    priv.env.extraSurfaces = [{ ...STRIP, excluded: true }];
    priv.run(WAKE_MS);
    callCat(priv, { x: 900, y: 1040 });
    priv.run(8000);
    const o = priv.step([{ type: 'tabs.changed', surfaceId: stripId('b'), ownerId: 'b', change: 'selected', focusX: 1350 }]);
    expect(o.look === null || Math.abs(o.look.x - 1350) > 1).toBe(true);
    // A "taskbar" event naming the tab strip, and a tab event naming a taskbar, do nothing.
    const h = onStrip(5);
    h.env.extraSurfaces = [STRIP, taskbar('tb', display('1', 0, 0, 1920, 1080, { primary: true, taskbar: 40 }), 1040)];
    h.run(3000);
    const from = h.transitions.length;
    h.step([{ type: 'taskbar.shown', surfaceId: stripId('b'), displayId: '1', edge: 'bottom' }]);
    const b = h.step([{ type: 'tabs.changed', surfaceId: TB_ID, ownerId: 'tb', change: 'selected', focusX: 1700 }]);
    expect(stimulusTo(h, from)).toEqual([]);
    expect(b.look === null || Math.abs(b.look.x - 1700) > 1).toBe(true);
  });

  it('with "tabStrips" off it ignores tab changes and never stands on a strip', () => {
    const h = new Harness({ seed: 3, persisted: catWith(3, CURIOUS), settings: settingsWith({ behavior: { disabledBehaviors: ['tabStrips'], autonomy: 1 } }) });
    h.env.extraSurfaces = [STRIP];
    h.keepOutputs = true;
    h.run(10 * MIN, 100, (_hh, i) => (i % 50 === 0 ? [{ type: 'tabs.changed', surfaceId: stripId('b'), ownerId: 'b', change: 'selected', focusX: 900 }] : []));
    expect(h.outputs.some((o) => o.support.kind === 'surface')).toBe(false);
    expect(h.outputs.some((o) => o.look !== null && Math.abs(o.look.x - 900) < 1e-6 && o.look.y > 700)).toBe(false);
  });
});

describe('robustness of surface references', () => {
  it('a provider whose live lookups always fail never leaves the cat attached or stuck', () => {
    const h = new Harness({ seed: 6, persisted: catWith(6, CURIOUS), settings: settingsWith({ behavior: { autonomy: 1 } }) });
    h.env.windows = { w: { x: 600, y: 760, width: 700, height: 280 } };
    h.env.extraSurfaces = [STRIP_FOR_ROBUSTNESS];
    h.env.getSurface = () => null;
    h.keepOutputs = true;
    h.run(WAKE_MS);
    callCat(h, { x: 950, y: 700 });
    h.run(10 * MIN, 66);
    expect(h.outputs.some((o) => o.support.kind === 'surface')).toBe(false);
    let airborne = 0;
    let worst = 0;
    for (const o of h.outputs) {
      airborne = o.support.kind === 'air' ? airborne + 66 : 0;
      worst = Math.max(worst, airborne);
    }
    expect(worst).toBeLessThan(6500);
    expect(h.sim.debugInfo().eventErrors).toBe(0);
  });

  it('stale ids in events (unknown surfaces, other kinds) are harmless', () => {
    const h = new Harness({ seed: 8 });
    h.run(WAKE_MS);
    const evs: SimEvent[] = [
      { type: 'taskbar.shown', surfaceId: 'taskbar:nope', displayId: '9', edge: 'bottom' },
      { type: 'taskbar.hidden', surfaceId: 'taskbar:nope', displayId: null, edge: 'left' },
      { type: 'tabs.changed', surfaceId: 'tabStrip:nope', ownerId: 'x', change: 'selected', focusX: 400 },
      { type: 'tabs.changed', surfaceId: 'tabStrip:nope', ownerId: 'x', change: 'added', focusX: Number.NaN },
    ];
    for (let i = 0; i < 50; i++) h.step(evs);
    expect(h.sim.debugInfo().eventErrors).toBe(0);
    expect(h.sim.debugInfo().invalidSamples).toEqual([]);
  });
});

const STRIP_FOR_ROBUSTNESS = tabStrip('r', 500, 200, 900, null, null);

describe('output and persistence', () => {
  it('a cat on a surface is saved as on the floor at the same spot, and restored there safely', () => {
    const h = new Harness({ seed: 12, persisted: catWith(12, PLACID) });
    h.env.windows = { w: { x: 600, y: 760, width: 700, height: 280 } };
    h.run(WAKE_MS);
    callCat(h, { x: 950, y: 700 });
    expect(h.runUntil((o) => onWindowTop(o.support, 'w') && o.state === 'idle', 30_000)).toBe(true);
    const saved = h.sim.serialize();
    expect(saved.lastPosition?.support).toBe('floor');
    expect(saved.lastPosition?.displayKey).toBe('1');
    expect(saved.lastPosition!.xFrac * 1920).toBeCloseTo(h.last!.x, 0);
    const again = new Harness({ seed: 13, persisted: saved });
    const o = again.step();
    expect(o.support).toEqual({ kind: 'floor', displayId: '1' });
    expect(o.y).toBe(1040);
    expect(o.x).toBeCloseTo(h.last!.x, 0);
  });

  it('reports the surface it stands on (kind and orientation) and keeps the upright bounds on ledges', () => {
    const h = new Harness({ seed: 12, world: SINGLE, persisted: catWith(12, PLACID) });
    h.env.windows = { w: { x: 600, y: 760, width: 700, height: 280 } };
    h.run(WAKE_MS);
    callCat(h, { x: 950, y: 700 });
    expect(h.runUntil((o) => onWindowTop(o.support, 'w') && o.state === 'idle', 30_000)).toBe(true);
    const o: SimOutput = h.last!;
    expect(o.support).toEqual({ kind: 'surface', surfaceId: 'windowTop:w', surfaceKind: 'windowTop', orientation: 'ledge' });
    expect(o.boundsPx).toEqual({ x: o.x - BW / 2, y: o.y - BH, width: BW, height: BH });
    expect(h.sim.debugInfo().surface).toBe('windowTop');
  });
});

describe('typing keeps the cat off surfaces', () => {
  it('intensive typing means fewer surface excursions', () => {
    const share = (typingIntensity: number): number => {
      let on = 0;
      let total = 0;
      for (const seed of [1, 2, 3]) {
        const h = new Harness({ seed, persisted: catWith(seed, CURIOUS, { energy: 1 }), settings: settingsWith({ behavior: { autonomy: 1 } }) });
        h.env.windows = { a: { x: 300, y: 760, width: 500, height: 280 }, t: { x: 1100, y: 400, width: 600, height: 640 } };
        h.env.typingIntensity = typingIntensity;
        h.run(30 * MIN, 100, (hh) => {
          total++;
          if (hh.last!.support.kind === 'surface') on++;
        });
      }
      return on / total;
    };
    const calm = share(0.95);
    const free = share(0);
    expect(free).toBeGreaterThan(0);
    expect(calm).toBeLessThan(free * 0.7);
  }, 120_000);
});
