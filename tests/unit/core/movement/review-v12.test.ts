// Regression tests for the v1.2 review findings in the Mover (SIMULATED: the real Mover, synthetic surfaces).
import { describe, expect, it } from 'vitest';
import { ProgressMonitor, LOOP_LANDINGS } from '../../../../src/core/behavior/watchdog';
import { MOVEMENT } from '../../../../src/core/movement';
import { BW, display, edgeId, env, FLOOR_Y, SINGLE, taskbar, world, type Env } from './v12Fixtures';

const on = (e: Env): string => {
  const s = e.m.support;
  return s.kind === 'surface' ? s.surfaceId : s.kind;
};

describe('review PHYS-1: stepping off an auto-hide taskbar toward another monitor', () => {
  const two = world(display('1', 0, 0, 1920, 1076, { primary: true }), display('2', 1920, 0, 1920, 1076));
  const bar = taskbar('t', two.displays[0]!, 1031);

  function run(startX: number, goalX: number): { e: Env; landings: number; lifts: number; reachedAt: number } {
    const e = env(two, {}, 0.5);
    e.extra = [bar];
    e.step();
    e.placeOn('taskbar:t', startX, bar.y);
    e.step();
    expect(Math.abs(e.m.x - startX)).toBeLessThan(15);
    e.m.setGoal({ x: goalX, y: 1076, pace: 'walk', allowJump: true });
    let landings = 0;
    let lifts = 0;
    let reachedAt = -1;
    const t0 = e.now;
    e.until((r) => {
      if (r.landed) landings++;
      if (r.lifted) lifts++;
      if (reachedAt < 0 && e.m.x > 1920) reachedAt = e.now - t0;
      return false;
    }, 20_000);
    return { e, landings, lifts, reachedAt };
  }

  for (const startX of [1828, 1868]) {
    it(`from x=${startX} at walk pace it reaches the other display, with no fall-and-land loop`, () => {
      const r = run(startX, 2800);
      expect(r.lifts, 'lifted back onto the taskbar').toBe(0);
      expect(r.landings, 'landings').toBeLessThanOrEqual(2);
      expect(r.reachedAt, 'reached display 2').toBeGreaterThan(0);
      expect(r.e.m.x).toBeGreaterThan(1920);
    });
  }

  it('a cat that ends up on the floor inside a shown taskbar is still lifted onto it', () => {
    const e = env(two, {}, 0.5);
    e.step();
    expect(e.dropAt(800, 900)).not.toBeNull();
    e.extra = [bar];
    let lifted = false;
    e.until((r) => {
      lifted ||= r.lifted !== null;
      return lifted;
    }, 2000);
    expect(lifted).toBe(true);
    expect(on(e)).toBe('taskbar:t');
  });

  it('with its goal back inside the column (it changed its mind) the lift applies again', () => {
    const e = env(two, {}, 0.5);
    e.extra = [bar];
    e.step();
    e.placeOn('taskbar:t', 1868, bar.y);
    e.step();
    e.m.setGoal({ x: 2800, y: 1076, pace: 'walk', allowJump: true });
    e.until((r) => r.landed !== null, 5000);
    expect(on(e)).toBe('floor');
    e.m.setGoal({ x: 1800, y: 1076, pace: 'walk', allowJump: true });
    let lifted = false;
    e.until((r) => {
      lifted ||= r.lifted !== null;
      return lifted;
    }, 3000);
    expect(lifted).toBe(true);
  });

  it('the monitor sees a loop of landings on one spot, and not landings spread out or spaced out', () => {
    const p = new ProgressMonitor();
    let fired = 0;
    for (let i = 0; i < LOOP_LANDINGS - 1; i++) expect(p.noteLanding(i * 1000, 500, BW)).toBe(false);
    expect(p.noteLanding(LOOP_LANDINGS * 1000, 500, BW)).toBe(true);
    for (let i = 0; i < 40; i++) if (p.noteLanding(100_000 + i * 1000, 500 + i * 2 * BW, BW)) fired++;
    for (let i = 0; i < 40; i++) if (p.noteLanding(500_000 + i * 21_000, 500, BW)) fired++;
    expect(fired).toBe(0);
  });
});

describe('review PHYS-2: climbing down never jumps the cat up', () => {
  it('a screen edge peek with a window flush against the edge, its top above the hold: down to the floor, no warp up to the top', () => {
    const e = env(SINGLE, { screenEdges: true, jumpDownSafeDip: 477, jumpDownMaxDip: 644, bailOut: true }, 0.05);
    e.windows = { w: { x: 0, y: 540, width: 960, height: 500 } };
    e.step();
    const id = edgeId('1', 'left');
    e.m.setGoal({ x: 0, y: 912, pace: 'walk', allowJump: true, surfaceId: id });
    expect(e.until(() => e.m.holdingOnWall, 20_000), 'holds on the edge').toBe(true);
    expect(e.m.y).toBeCloseTo(912, 0);
    const down = e.m.leaveOptions().find((o) => o.kind === 'climbDown');
    expect(down, 'the way down').toMatchObject({ toKind: 'floor', toSurfaceId: null });
    expect(down?.dropDip).toBeGreaterThan(0);
    e.m.setGoal(null);
    e.m.holdOnWall(null);
    let y = e.m.y;
    let maxUp = 0;
    e.until(() => {
      maxUp = Math.max(maxUp, y - e.m.y);
      y = e.m.y;
      return e.m.grounded;
    }, 20_000);
    expect(maxUp, 'upward in one tick').toBe(0);
    expect(e.m.support.kind).toBe('floor');
    expect(e.m.y).toBe(FLOOR_Y);
  });

  it('a window side, turned back below a neighbouring top: it climbs on down and does not warp up onto it', () => {
    const e = env(SINGLE, { jumpDownSafeDip: 477, jumpDownMaxDip: 644, bailOut: true }, 0.6);
    e.walls = true;
    // w in front, its right side free; b just beside it, its top beside the side, above where the cat turns back.
    e.windows = { w: { x: 600, y: 300, width: 400, height: 740 }, b: { x: 1010, y: 600, width: 400, height: 440 } };
    e.step();
    e.m.setGoal({ x: 900, y: 300, pace: 'walk', allowJump: true, route: 'climb' });
    expect(e.until(() => e.m.onWall && e.m.climbPhase === 'climb' && e.m.y < 950, 30_000), 'on the side').toBe(true);
    const wall = e.m.wall;
    expect(wall?.side).toBe('right');
    e.m.setGoal({ x: 1040, y: FLOOR_Y, pace: 'walk', allowJump: true, literal: true });
    let y = e.m.y;
    let maxUp = 0;
    e.until(() => {
      if (e.m.onWall && e.m.climbPhase === 'climb') {
        maxUp = Math.max(maxUp, y - e.m.y);
        y = e.m.y;
      }
      return e.m.grounded;
    }, 20_000);
    expect(maxUp, 'upward in one tick while climbing down').toBeLessThan(5);
    expect(on(e)).not.toBe('windowTop:b');
  });
});

describe('review PHYS-3: a display change during a dismount', () => {
  const grown = world(display('1', 0, 0, 2560, 1440, { primary: true }));
  const barAdded = world(display('1', 0, 0, 1920, 1080, { primary: true, taskbar: 80 }));
  const barRemoved = world(display('1', 0, 0, 1920, 1080, { primary: true }));

  const dismounting = (kind: 'edge' | 'side'): Env => {
    const e = env(SINGLE, { screenEdges: true, jumpDownSafeDip: 477, jumpDownMaxDip: 644, bailOut: true }, kind === 'edge' ? 0.05 : 0.42);
    if (kind === 'side') {
      e.windows = { w: { x: 700, y: 400, width: 400, height: 640 } };
      e.step();
      e.m.setGoal({ x: 800, y: 400, pace: 'walk', allowJump: true, route: 'climb' });
      expect(e.until(() => e.m.onWall && e.m.climbPhase === 'climb' && e.m.y < FLOOR_Y - 60, 30_000), 'on the side').toBe(true);
      e.m.setGoal({ x: e.m.x - 60, y: FLOOR_Y, pace: 'walk', allowJump: true, literal: true });
    } else {
      e.step();
      e.m.setGoal({ x: 0, y: FLOOR_Y - 150, pace: 'walk', allowJump: true, surfaceId: edgeId('1', 'left') });
      expect(e.until(() => e.m.holdingOnWall, 20_000), 'holds on the edge').toBe(true);
      e.m.setGoal(null);
      e.m.holdOnWall(null);
    }
    expect(e.until(() => e.m.climbPhase === 'dismount', 20_000), 'dismounting').toBe(true);
    return e;
  };

  for (const kind of ['edge', 'side'] as const) {
    for (const [label, w, floor] of [['grows', grown, 1440], ['gets a taskbar', barAdded, 1000], ['loses its taskbar', barRemoved, 1080]] as const) {
      it(`${kind}: the display ${label}: it ends on the floor that is there now and can walk its whole range`, () => {
        const e = dismounting(kind);
        e.w = w;
        e.m.setWorld(w);
        expect(e.until(() => e.m.grounded, 20_000), 'stands').toBe(true);
        expect(e.m.support.kind).toBe('floor');
        expect(e.m.y).toBeCloseTo(floor, 0);
        const display0 = w.displays[0]!;
        const r = e.m.walkRange;
        expect(r?.x1).toBeGreaterThan(display0.workAreaPx.width - 2 * BW);
        // It walks on that floor; the walk does not hide a wrong height.
        e.m.setGoal({ x: display0.workAreaPx.width - 3 * BW, y: floor, pace: 'run', allowJump: true });
        expect(e.until((s) => s.goal === 'arrived' || s.goal === 'unreachable', 30_000)).toBe(true);
        expect(e.m.y).toBeCloseTo(floor, 0);
        expect(e.m.x).toBeCloseTo(display0.workAreaPx.width - 3 * BW, -1);
      });
    }
  }
});

describe('review PHYS-4: a display event during a leap', () => {
  const leaping = (): Env => {
    const e = env(SINGLE, { jumpDownSafeDip: 477, jumpDownMaxDip: 644, bailOut: true }, 0.4);
    e.walls = true;
    e.windows = { w: { x: 600, y: 300, width: 400, height: 500 } };
    e.step();
    e.m.setGoal({ x: 800, y: 300, pace: 'walk', allowJump: true, route: 'climb' });
    expect(e.until(() => e.m.climbPhase === 'leap', 20_000), 'leaps').toBe(true);
    e.step();
    return e;
  };

  it('the cat flies on from where it is, and catches the side', () => {
    const e = leaping();
    const at = { x: e.m.x, y: e.m.y };
    expect(e.m.setWorld({ ...SINGLE, version: 2 })).toBe(false);
    expect(e.m.climbPhase).toBe('leap');
    expect({ x: e.m.x, y: e.m.y }).toEqual(at);
    expect(e.until(() => e.m.climbPhase === 'climb', 3000), 'caught the side').toBe(true);
  });

  it('a display gone under the arc still puts it inside the world', () => {
    const e = leaping();
    const elsewhere = world(display('2', 2000, 0, 1920, 1080, { primary: true, taskbar: 40 }));
    e.w = elsewhere;
    expect(e.m.setWorld(elsewhere)).toBe(true);
    expect(e.m.x).toBeGreaterThanOrEqual(2000);
    expect(MOVEMENT.maxWallHoldMs).toBeGreaterThan(0);
  });
});
