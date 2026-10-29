// v1.1 surface physics in the Mover: taskbars that lift, lower and retract, riding window
// tops, climbing window sides with corner pull-ups, tab strips, dead references, toggles.
import { describe, expect, it } from 'vitest';
import type { SimSupport } from '../../../../src/shared/sim';
import type { Surface } from '../../../../src/shared/surfaces';
import type { DisplayGeometry, WorldGeometry } from '../../../../src/shared/world';
import type { MoverConfig, MoverStep } from '../../../../src/core/movement';
import { MOVEMENT, Mover } from '../../../../src/core/movement';
import { display, DUAL_FLAT, DUAL_MIXED, insideAnyWorkArea, sideId, SINGLE, tabStrip, taskbar, taskbarId, topId, world } from '../behavior/fixtures';
import { SurfaceDriver } from './surfaceDriver';

const CFG: MoverConfig = { size: 1, movementSpeed: 1, allowMultiMonitor: true, perchOnWindows: true };

class Driver extends SurfaceDriver {
  override step(dt = 16): MoverStep {
    const r = super.step(dt);
    expect(Number.isFinite(this.m.x) && Number.isFinite(this.m.y)).toBe(true);
    expect(insideAnyWorkArea(this.w, this.m.x, this.m.y, 2.5)).toBe(true);
    return r;
  }
}

function make(w: WorldGeometry, cfg: Partial<MoverConfig> = {}, start: { displayId: string | null; xFrac: number } = { displayId: '1', xFrac: 0.5 }): Driver {
  return new Driver(new Mover(w, { ...CFG, ...cfg }, start), w);
}

const surf = (s: Surface): SimSupport => ({ kind: 'surface', surfaceId: s.id, surfaceKind: s.kind, orientation: s.orientation });
const WALL = (id: string, side: 'left' | 'right'): SimSupport => ({ kind: 'surface', surfaceId: sideId(id, side), surfaceKind: 'windowSide', orientation: 'wall' });
const TOP = (id: string): SimSupport => ({ kind: 'surface', surfaceId: topId(id), surfaceKind: 'windowTop', orientation: 'ledge' });

/** An auto-hide setup: the work area is the whole 1920x1200 screen, the floor is its bottom row. */
const AH_DISPLAY: DisplayGeometry = display('1', 0, 0, 1920, 1200, { primary: true });
const AUTOHIDE = world(AH_DISPLAY);
/** A 48 px taskbar fully shown: top 1152, feet at 1151 (49 px above the floor: within one 64 px body height). */
const SHOWN_TOP = 1152;
const tb = (top: number, extra: Parameters<typeof taskbar>[3] = {}) => taskbar('tb', AH_DISPLAY, top, extra);

/** Brings the cat onto a fully shown taskbar by sliding it in under the cat. */
function liftedOntoTaskbar(d: Driver, top = SHOWN_TOP): void {
  d.step();
  for (const t of [1190, 1175, 1160, top]) {
    d.extra = [tb(t, { phase: 'entering', vy: -900 })];
    d.step();
  }
  d.extra = [tb(top)];
  expect(d.until(() => Math.abs(d.m.y - (top - 1)) < 1e-6, 1000)).toBe(true);
  expect(d.m.support).toEqual(surf(tb(top)));
}

describe('Mover: taskbars', () => {
  it('a taskbar rising under a standing cat lifts it smoothly onto the taskbar (no snap, no fall)', () => {
    const d = make(AUTOHIDE);
    d.step();
    expect(d.m.y).toBe(1200);
    let lifted: MoverStep['lifted'] = null;
    let prevY = d.m.y;
    for (const t of [1196, 1185, 1172, 1160, SHOWN_TOP, SHOWN_TOP, SHOWN_TOP]) {
      d.extra = [tb(t, { phase: t === SHOWN_TOP ? 'stable' : 'entering', vy: -700 })];
      const r = d.step();
      lifted ??= r.lifted;
      expect(r.snapped).toBe(false);
      expect(r.perchLost).toBe(false);
      expect(d.m.airborne).toBe(false);
      // Rises monotonically, at most liftDip-ish per frame.
      expect(d.m.y).toBeLessThanOrEqual(prevY + 1e-9);
      expect(prevY - d.m.y).toBeLessThanOrEqual(Math.max(MOVEMENT.liftDip, 1.5 * 700) * 0.016 + 1e-6);
      prevY = d.m.y;
    }
    expect(lifted).toEqual({ surfaceId: taskbarId('tb'), surfaceKind: 'taskbar' });
    expect(d.until(() => d.m.y === SHOWN_TOP - 1, 500)).toBe(true);
    expect(d.m.support).toEqual(surf(tb(SHOWN_TOP)));
    expect(d.m.x).toBe(960);
  });

  it('a cat that ends up on the floor inside a shown taskbar steps up onto it', () => {
    const d = make(AUTOHIDE);
    d.extra = [tb(SHOWN_TOP)];
    d.step();
    // Shown before the cat arrived (first listing already above its feet): it is lifted all the same.
    expect(d.until(() => d.m.support.kind === 'surface', 200)).toBe(true);
    d.m.setGoal(null);
    // Thrown down from above, it lands on the taskbar, never inside it.
    d.m.startDrag({ x: d.m.x, y: d.m.y });
    d.dragCursor = { x: 500, y: 600 };
    d.step();
    d.dragCursor = null;
    d.m.endDrag(null, { x: 0, y: 0 }, d.now, true);
    expect(d.until((r) => r.landed !== null, 3000)).toBe(true);
    expect(d.m.y).toBe(SHOWN_TOP - 1);
    expect(d.m.support).toEqual(surf(tb(SHOWN_TOP)));
  });

  it('a sinking taskbar lowers the cat and sets it down on the floor without a fall', () => {
    const d = make(AUTOHIDE);
    liftedOntoTaskbar(d);
    let loss: MoverStep['supportLost'] = null;
    let prevY = d.m.y;
    for (const t of [1160, 1170, 1180, 1190, 1197, 1199, 1202]) {
      d.extra = t > 1199 ? [] : [tb(t, { phase: 'leaving', vy: 600 })];
      const r = d.step();
      loss ??= r.supportLost;
      expect(r.perchLost).toBe(false);
      expect(r.snapped).toBe(false);
      expect(d.m.airborne).toBe(false);
      expect(d.m.y).toBeGreaterThanOrEqual(prevY - 1e-9);
      prevY = d.m.y;
    }
    expect(loss).toEqual({ reason: 'retracted', surfaceId: taskbarId('tb'), surfaceKind: 'taskbar', fell: false });
    expect(d.until(() => d.m.y === 1200, 500)).toBe(true);
    expect(d.m.support).toEqual({ kind: 'floor', displayId: '1' });
  });

  it('a taskbar that vanishes at once: a usual one sets the cat down gently, a very tall one lets it drop calmly', () => {
    const low = make(AUTOHIDE);
    liftedOntoTaskbar(low); // 49 px: a step down (at most one body height)
    low.extra = [];
    const r = low.step();
    expect(r.supportLost).toEqual({ reason: 'retracted', surfaceId: taskbarId('tb'), surfaceKind: 'taskbar', fell: false });
    expect(r.lowered).toBe(true);
    expect(r.perchLost).toBe(false);
    expect(low.m.airborne).toBe(false);
    expect(low.until(() => low.m.y === 1200, 500)).toBe(true);

    const tall = make(AUTOHIDE);
    liftedOntoTaskbar(tall, 1120); // 81 px: more than a body height
    tall.extra = [];
    const s = tall.step();
    expect(s.supportLost).toEqual({ reason: 'retracted', surfaceId: taskbarId('tb'), surfaceKind: 'taskbar', fell: true });
    expect(tall.m.airborne).toBe(true);
    expect(tall.until((x) => x.landed !== null, 2000)).toBe(true);
    expect(tall.m.y).toBe(1200);
  });

  it('a floor goal under the taskbar it was lifted onto stays on the taskbar; a literal one goes down', () => {
    const d = make(AUTOHIDE);
    liftedOntoTaskbar(d);
    d.goal({ x: 600, y: 1200 });
    expect(d.until((r) => r.goal === 'arrived', 20_000)).toBe(true);
    expect(d.m.support).toEqual(surf(tb(SHOWN_TOP)));
    expect(d.log.some((r) => r.tookOff || r.steppedOff)).toBe(false);
    // While it is shown the floor under it is covered: even a literal floor goal means the taskbar
    // (no jumping down only to be lifted back up).
    d.log = [];
    d.goal({ x: 400, y: 1200, literal: true });
    expect(d.until((r) => r.goal === 'arrived', 20_000)).toBe(true);
    expect(d.m.support).toEqual(surf(tb(SHOWN_TOP)));
    expect(d.log.some((r) => r.tookOff)).toBe(false);
    // Once it starts sliding away, a literal goal takes the cat down to the floor itself.
    d.extra = [tb(SHOWN_TOP, { phase: 'leaving' })];
    d.goal({ x: 300, y: 1200, literal: true });
    expect(d.until((r) => r.goal === 'arrived', 20_000)).toBe(true);
    expect(d.m.support).toEqual({ kind: 'floor', displayId: '1' });
    expect(d.log.some((r) => r.tookOff)).toBe(true);
  });

  it('switching taskbars off while on one makes the cat leave it calmly', () => {
    const d = make(AUTOHIDE);
    liftedOntoTaskbar(d);
    d.m.setConfig({ ...CFG, taskbars: false });
    const r = d.step();
    expect(r.supportLost).toEqual({ reason: 'disabled', surfaceId: taskbarId('tb'), surfaceKind: 'taskbar', fell: false });
    expect(d.until(() => d.m.y === 1200, 1000)).toBe(true);
    expect(d.m.support.kind).toBe('floor');
    // Never lifted again while off.
    d.extra = [tb(1170, { phase: 'entering' })];
    d.step();
    expect(d.m.ledgeSurfaces).toEqual([]);
    expect(d.m.support.kind).toBe('floor');
  });
});

describe('Mover: dead and stale references', () => {
  function onTop(): Driver {
    const d = make(SINGLE);
    d.walls = false;
    d.windows = { w: { x: 800, y: 800, width: 600, height: 240 } };
    d.goal({ x: 1100, y: 799 });
    expect(d.until((r) => r.goal === 'arrived', 20_000)).toBe(true);
    d.m.setGoal(null);
    expect(d.m.support).toEqual(TOP('w'));
    return d;
  }

  it('releases the support in the same step getSurface returns null, even while the list still has it', () => {
    const d = onTop();
    d.gone.add(topId('w'));
    const r = d.step();
    expect(r.supportLost).toEqual({ reason: 'gone', surfaceId: topId('w'), surfaceKind: 'windowTop', fell: true });
    expect(d.m.airborne).toBe(true);
  });

  it('treats malformed and throwing providers as gone', () => {
    for (const bad of [(): Surface | null => ({ id: topId('w'), orientation: 'wall' }) as unknown as Surface, (): Surface | null => ({ id: topId('w'), orientation: 'ledge', y: Number.NaN, x0: 0, x1: 10 }) as unknown as Surface, (): Surface | null => {
      throw new Error('provider broke');
    }]) {
      const d = onTop();
      d.liveOverride = bad;
      const r = d.step();
      expect(r.supportLost?.reason).toBe('gone');
      expect(d.until((x) => x.landed !== null, 2000)).toBe(true);
      expect(d.m.support.kind).toBe('floor');
    }
  });

  it('keeps a live support missing from the list only for the grace, then falls (occluded)', () => {
    const d = onTop();
    d.hidden.add(topId('w'));
    const t0 = d.now;
    expect(d.until((r) => r.supportLost !== null, 3000)).toBe(true);
    expect(d.now - t0).toBeGreaterThanOrEqual(MOVEMENT.perchGraceMs);
    expect(d.now - t0).toBeLessThan(MOVEMENT.perchGraceMs + 40);
    expect(d.log[d.log.length - 1]?.supportLost?.reason).toBe('occluded');
  });

  it('rides a window being dragged (generalised ride), including its height', () => {
    const d = onTop();
    const x0 = d.m.x;
    for (let i = 1; i <= 20; i++) {
      d.windows.w = { x: 800 - 15 * i, y: 800 - 8 * i, width: 600, height: 240 };
      d.moving.add('w');
      d.step();
      expect(d.m.x).toBeCloseTo(x0 - 15 * i, 6);
      expect(d.m.y).toBe(800 - 8 * i);
      expect(d.m.support).toEqual(TOP('w'));
    }
  });

  it('a jump whose target closes mid-flight ends on the first valid surface below: here the ledge it left', () => {
    const d = make(SINGLE);
    d.walls = false;
    d.windows = { low: { x: 900, y: 900, width: 700, height: 140 } };
    d.goal({ x: 1200, y: 899 });
    expect(d.until((r) => r.goal === 'arrived', 20_000)).toBe(true);
    d.windows.high = { x: 1000, y: 650, width: 450, height: 250 };
    d.goal({ x: 1250, y: 649 });
    expect(d.until((r) => r.tookOff, 20_000)).toBe(true);
    d.step();
    d.windows.high = null;
    expect(d.until((r) => r.landed !== null, 3000)).toBe(true);
    expect(d.m.support).toEqual(TOP('low'));
    expect(d.m.y).toBe(900);
  });
});

describe('Mover: climbing window sides', () => {
  // Window w: x 800..1300, top 400, bottom on the floor (1040): 640 px up, too high to jump.
  const W = { x: 800, y: 400, width: 500, height: 640 };

  function climber(start = 0.25, w: WorldGeometry = SINGLE): Driver {
    const d = make(w, {}, { displayId: '1', xFrac: start });
    d.windows = { w: { ...W } };
    d.step();
    return d;
  }

  it('climbs up the outside of a left side facing the wall, then pulls up at the corner onto the top', () => {
    const d = climber();
    d.goal({ x: 1000, y: 400, route: 'climb' });
    expect(d.until((r) => r.climbStarted, 20_000)).toBe(true);
    expect(d.m.onWall).toBe(true);
    expect(d.m.support).toEqual(WALL('w', 'left'));
    expect(d.m.facing).toBe(1);
    // Past the mount: the anchor grips the wall line and climbs at climbUpDip.
    d.until(() => false, MOVEMENT.mountMs + 50);
    const y0 = d.m.y;
    const t0 = d.now;
    d.until(() => false, 1000);
    expect(d.m.x).toBe(800);
    expect((y0 - d.m.y) / ((d.now - t0) / 1000)).toBeCloseTo(MOVEMENT.climbUpDip, 6);
    expect(d.m.climbSpeed).toBeCloseTo(MOVEMENT.climbUpDip, 6);
    expect(d.m.grounded).toBe(false);
    expect(d.m.airborne).toBe(false);
    let ended = false;
    expect(
      d.until((r) => {
        ended ||= r.climbEnded;
        // Never in the air on the way up.
        expect(r.perchLost).toBe(false);
        return r.goal === 'arrived';
      }, 30_000),
    ).toBe(true);
    expect(ended).toBe(true);
    expect(d.m.support).toEqual(TOP('w'));
    expect(d.m.y).toBe(400);
    expect(d.m.x).toBeCloseTo(1000, 0);
  });

  it('on a right side it faces left', () => {
    const d = climber(0.85);
    d.goal({ x: 1100, y: 400, route: 'climb' });
    expect(d.until((r) => r.climbStarted, 20_000)).toBe(true);
    expect(d.m.support).toEqual(WALL('w', 'right'));
    expect(d.m.facing).toBe(-1);
    expect(d.until((r) => r.goal === 'arrived', 40_000)).toBe(true);
    expect(d.m.support).toEqual(TOP('w'));
  });

  it('climbs down: swings over the corner, climbs down at climbDownDip and steps off at the bottom', () => {
    const d = climber();
    d.goal({ x: 1000, y: 400 });
    expect(d.until((r) => r.goal === 'arrived', 40_000)).toBe(true);
    d.goal({ x: 500, y: 1040, route: 'climb' });
    expect(d.until((r) => r.climbStarted, 20_000)).toBe(true);
    expect(d.m.support).toEqual(WALL('w', 'left'));
    d.until(() => false, MOVEMENT.swingMs + 50);
    const y0 = d.m.y;
    const t0 = d.now;
    d.until(() => false, 1000);
    expect((d.m.y - y0) / ((d.now - t0) / 1000)).toBeCloseTo(MOVEMENT.climbDownDip, 6);
    expect(d.until((r) => r.goal === 'arrived', 30_000)).toBe(true);
    expect(d.log.some((r) => r.tookOff)).toBe(false);
    expect(d.m.support).toEqual({ kind: 'floor', displayId: '1' });
    expect(d.m.x).toBeCloseTo(500, 0);
  });

  it('climbs at a DIP speed scaled by the display (1.5x)', () => {
    // DUAL_MIXED display 2: x -2560..0, floor 1260, scale 1.5.
    const d = make(DUAL_MIXED, {}, { displayId: '2', xFrac: 0.2 });
    d.windows = { w: { x: -1800, y: 300, width: 700, height: 960 } };
    d.step();
    d.goal({ x: -1400, y: 300, route: 'climb' });
    expect(d.until((r) => r.climbStarted, 30_000)).toBe(true);
    d.until(() => false, MOVEMENT.mountMs + 50);
    const y0 = d.m.y;
    const t0 = d.now;
    d.until(() => false, 1000);
    expect((y0 - d.m.y) / ((d.now - t0) / 1000)).toBeCloseTo(MOVEMENT.climbUpDip * 1.5, 6);
  });

  it('rides the window while clinging to it, and lets go with a fall when it closes', () => {
    const d = climber();
    d.goal({ x: 1000, y: 400, route: 'climb' });
    expect(d.until((r) => r.climbStarted, 20_000)).toBe(true);
    d.until(() => false, MOVEMENT.mountMs + 500);
    for (let i = 1; i <= 10; i++) {
      d.windows.w = { ...W, x: W.x + 20 * i };
      d.moving.add('w');
      d.step();
      expect(d.m.x).toBe(W.x + 20 * i);
      expect(d.m.onWall).toBe(true);
    }
    d.windows.w = null;
    const r = d.step();
    expect(r.climbEnded).toBe(true);
    expect(r.supportLost).toEqual({ reason: 'gone', surfaceId: sideId('w', 'left'), surfaceKind: 'windowSide', fell: true });
    expect(d.m.airborne).toBe(true);
    expect(d.until((s) => s.landed !== null, 3000)).toBe(true);
    expect(d.m.support.kind).toBe('floor');
  });

  it('with the top covered it climbs back down instead of pulling up into nothing', () => {
    const d = climber();
    d.goal({ x: 1000, y: 400, route: 'climb' });
    expect(d.until((r) => r.climbStarted, 20_000)).toBe(true);
    d.hidden.add(topId('w'));
    let lowest = Infinity;
    expect(
      d.until(() => {
        lowest = Math.min(lowest, d.m.y);
        return d.m.grounded;
      }, 60_000),
    ).toBe(true);
    expect(d.m.support.kind).toBe('floor');
    expect(lowest).toBeLessThan(500);
    expect(d.log.some((r) => r.perchLost)).toBe(false);
  });

  it('dragging always overrides: a climbing cat is picked off the wall', () => {
    const d = climber();
    d.goal({ x: 1000, y: 400, route: 'climb' });
    expect(d.until((r) => r.climbStarted, 20_000)).toBe(true);
    d.until(() => false, 2000);
    d.m.startDrag({ x: d.m.x, y: d.m.y });
    expect(d.m.held).toBe(true);
    expect(d.m.onWall).toBe(false);
    expect(d.m.support).toEqual({ kind: 'held' });
    d.m.endDrag(null, { x: 0, y: 0 }, d.now, true);
    expect(d.until((r) => r.landed !== null, 3000)).toBe(true);
    expect(d.m.support.kind).toBe('floor');
  });

  it('offers climbs from where it stands, and none with climbing off', () => {
    const d = climber();
    const opts = d.m.climbOptions();
    expect(opts.map((o) => [o.dir, o.wallId])).toEqual([
      ['up', sideId('w', 'left')],
      ['up', sideId('w', 'right')],
    ]);
    expect(opts[0]?.target).toEqual({ x: 842, y: 400 });
    expect(opts[0]?.startX).toBeLessThan(800);
    d.m.setConfig({ ...CFG, walls: false });
    d.step();
    expect(d.m.climbOptions()).toEqual([]);
    expect(d.m.wallTracks).toEqual([]);
    d.goal({ x: 1000, y: 400 });
    expect(d.until((r) => r.goal === 'unreachable', 30_000)).toBe(true);
    expect(d.log.some((r) => r.climbStarted)).toBe(false);
  });

  it('switching climbing off while on a wall makes it let go calmly', () => {
    const d = climber();
    d.goal({ x: 1000, y: 400, route: 'climb' });
    expect(d.until((r) => r.climbStarted, 20_000)).toBe(true);
    d.until(() => false, 1500);
    d.m.setConfig({ ...CFG, walls: false });
    const r = d.step();
    expect(r.supportLost?.reason).toBe('disabled');
    expect(d.until((s) => s.landed !== null, 3000)).toBe(true);
  });
});

describe('Mover: tab strips and walking across ledges', () => {
  it('lands on a tab strip at the chosen resting point and keeps its rest span and focus', () => {
    const d = make(SINGLE);
    d.extra = [tabStrip('b', 760, 600, 1400, { x0: 800, x1: 1100 }, 950)];
    d.step();
    const strip = d.m.ledgeById('tabStrip:b');
    expect(strip?.rest).toEqual({ x0: 800, x1: 1100 });
    expect(strip?.focusX).toBe(950);
    d.goal({ x: 900, y: 760 });
    expect(d.until((r) => r.goal === 'arrived', 20_000)).toBe(true);
    expect(d.m.support).toEqual({ kind: 'surface', surfaceId: 'tabStrip:b', surfaceKind: 'tabStrip', orientation: 'ledge' });
    expect(d.m.x).toBeGreaterThanOrEqual(800);
    expect(d.m.x).toBeLessThanOrEqual(1100);
  });

  it('walks across two touching window tops at the same height without a jump or a jolt', () => {
    const d = make(SINGLE, {}, { displayId: '1', xFrac: 0.3 });
    d.walls = false;
    d.windows = { a: { x: 400, y: 800, width: 500, height: 240 }, b: { x: 902, y: 800, width: 400, height: 240 } };
    d.goal({ x: 800, y: 799 });
    expect(d.until((r) => r.goal === 'arrived', 20_000)).toBe(true);
    d.log = [];
    d.goal({ x: 1200, y: 799 });
    let prevX = d.m.x;
    let maxStep = 0;
    expect(
      d.until((r) => {
        maxStep = Math.max(maxStep, Math.abs(d.m.x - prevX));
        prevX = d.m.x;
        return r.goal === 'arrived';
      }, 20_000),
    ).toBe(true);
    expect(d.log.some((r) => r.tookOff || r.steppedOff || r.crouchStarted)).toBe(false);
    expect(d.m.support).toEqual(TOP('b'));
    // Walking speed per 16 ms frame, plus the 2 px gap between the edges and the 1 px crossing tolerance.
    expect(maxStep).toBeLessThanOrEqual(MOVEMENT.walkDip * 0.016 + 2 + 1 + 1e-6);
  });

  it('moves between displays with ledges on both (multi-monitor transitions)', () => {
    const d = make(DUAL_FLAT, {}, { displayId: '1', xFrac: 0.7 });
    d.walls = false;
    d.windows = { w: { x: 2100, y: 800, width: 500, height: 240 } };
    d.goal({ x: 2300, y: 799 });
    expect(d.until((r) => r.goal === 'arrived', 40_000)).toBe(true);
    expect(d.m.support).toEqual(TOP('w'));
    expect(d.m.displayId).toBe('2');
    d.goal({ x: 600, y: 1040 });
    expect(d.until((r) => r.goal === 'arrived', 60_000)).toBe(true);
    expect(d.m.support).toEqual({ kind: 'floor', displayId: '1' });
  });
});
