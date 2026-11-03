// v1.2 wall-jump edges in the surface graph (ADR 0003 §6.2), routes over a side's top with a
// wall jump, the T6 goal pin (MoveGoal.surfaceId, §7.3 layer 2), and a window side kept through
// a topology change (§6.8, with MoverConfig.bailOut).
import { describe, expect, it } from 'vitest';
import type { JumpKind } from '../../../../src/shared/cat';
import { SurfaceGraph, WorldModel } from '../../../../src/core/movement';
import { BW, env, FLOOR_Y, ledge, SINGLE, sideId, stripId, topId, wall } from './v12Fixtures';

describe('SurfaceGraph: wall-jump edges', () => {
  function graph(wallJumps: boolean): SurfaceGraph {
    const world = new WorldModel(SINGLE, 1, true);
    const ledges = world.ledgeSurfaces([ledge('windowTop:x', 'windowTop', 'x', 250, 500, 760)]);
    const walls = world.wallTracks([wall('w', 'left', 800, 300, FLOOR_Y, { topLedgeId: null })]);
    const g = new SurfaceGraph();
    g.setOptions({ wallJumps });
    g.update(world, ledges, walls);
    return g;
  }

  it('exist only with the option, from the top of a wall onto supports within a push-off', () => {
    expect(graph(false).edgesFrom(`up:${sideId('w', 'left')}`).filter((e) => e.kind === 'wallJump')).toEqual([]);
    const jumps = graph(true)
      .edgesFrom(`up:${sideId('w', 'left')}`)
      .filter((e) => e.kind === 'wallJump');
    expect(jumps.map((e) => e.to).sort()).toEqual(['floor:1', 'windowTop:x']);
    const onX = jumps.find((e) => e.to === 'windowTop:x');
    // Lands on the cat's side of the line, at least wallJumpMinBodyLengths away, the nearest point.
    expect(onX?.toX).toBeCloseTo(800 - 0.8 * BW, 6);
    expect(onX?.dropDip).toBe(0);
    expect(jumps.find((e) => e.to === 'floor:1')?.dropDip).toBeGreaterThan(600);
  });

  it('a jump or drop edge carries how far it ends below its take-off', () => {
    const world = new WorldModel(SINGLE, 1, true);
    const ledges = world.ledgeSurfaces([ledge('windowTop:a', 'windowTop', 'a', 640, 600, 1200)]);
    const g = new SurfaceGraph();
    g.update(world, ledges, []);
    const down = g.outgoing(g.node('windowTop:a') as never).filter((e) => e.to === 'floor:1');
    expect(down.length).toBeGreaterThan(0);
    for (const e of down) expect(e.dropDip).toBeCloseTo(400, 6);
    expect(g.edgesFrom('floor:1').find((e) => e.to === 'windowTop:a')?.dropDip).toBeUndefined();
  });
});

describe('Mover: a route over a side with a wall jump', () => {
  function layout(cfg: object): ReturnType<typeof env> {
    const e = env(SINGLE, cfg, 0.6);
    e.walls = false;
    // A side with no ledge at its top, and a top beside it only a push-off from the side reaches.
    e.extra = [wall('w', 'left', 800, 300, FLOOR_Y, { topLedgeId: null }), ledge('windowTop:x', 'windowTop', 'x', 250, 500, 760)];
    e.step();
    e.goal({ x: 600, y: 249 });
    return e;
  }

  it('without wall jumps the top is unreachable', () => {
    const e = layout({});
    expect(e.until((r) => r.goal === 'unreachable', 30_000)).toBe(true);
  });

  it('with wall jumps the cat climbs the side and pushes off onto the top (jumpKind wallJump)', () => {
    const e = layout({ wallJumps: true });
    const kinds = new Set<JumpKind | null>();
    expect(
      e.until((r) => {
        if (e.m.airborne) kinds.add(e.m.jumpKind);
        return r.goal === 'arrived' || r.goal === 'unreachable';
      }, 60_000),
    ).toBe(true);
    expect(e.log.at(-1)?.goal).toBe('arrived');
    expect(kinds.has('wallJump')).toBe(true);
    expect(e.m.support).toMatchObject({ surfaceId: 'windowTop:x' });
  });
});

describe('MoveGoal.surfaceId: the goal pinned to its surface (T6)', () => {
  it('x is clamped into the strip and follows it when it shrinks; arrival on the strip', () => {
    const e = env(SINGLE, {}, 0.45);
    e.walls = false;
    e.extra = [ledge(stripId('b'), 'tabStrip', 'b', 600, 700, 1300)];
    e.step();
    e.placeOn(stripId('b'), 900, 600);
    e.goal({ x: 1700, y: 599, surfaceId: stripId('b') });
    e.step();
    e.extra = [ledge(stripId('b'), 'tabStrip', 'b', 600, 700, 1100)];
    expect(e.until((r) => r.goal === 'arrived', 20_000)).toBe(true);
    expect(e.m.support).toMatchObject({ surfaceId: stripId('b') });
    expect(e.m.x).toBeLessThanOrEqual(1100 + 1e-6);
    expect(e.m.x).toBeGreaterThan(1050);
  });

  it('never re-mapped to the floor: once the pinned surface is gone the goal is unreachable', () => {
    const e = env(SINGLE, {}, 0.3);
    e.walls = false;
    e.extra = [ledge(stripId('b'), 'tabStrip', 'b', 900, 700, 1300)];
    e.step();
    e.extra = [];
    e.step();
    e.goal({ x: 1000, y: 899, surfaceId: stripId('b') });
    const x0 = e.m.x;
    expect(e.until((r) => r.goal === 'unreachable', 5000)).toBe(true);
    expect(Math.abs(e.m.x - x0)).toBeLessThan(BW);
    expect(e.m.y).toBe(FLOOR_Y);
  });

  it('a floor key pins to the floor; allowJump false never leaves for another pinned surface', () => {
    const e = env(SINGLE, {}, 0.3);
    e.goal({ x: 1200, y: 100, surfaceId: 'floor:1' });
    expect(e.until((r) => r.goal === 'arrived', 30_000)).toBe(true);
    expect(e.m.x).toBeCloseTo(1200, 0);
    const f = env(SINGLE, {}, 0.3);
    f.walls = false;
    f.windows = { t: { x: 600, y: 900, width: 600, height: 140 } };
    f.step();
    f.m.setGoal({ x: 900, y: 899, pace: 'walk', allowJump: false, surfaceId: topId('t') });
    expect(f.until((r) => r.goal === 'unreachable', 3000)).toBe(true);
    expect(f.m.y).toBe(FLOOR_Y);
  });
});

describe('topology change mid-climb on a window side', () => {
  function climbing(cfg: object): ReturnType<typeof env> {
    const e = env(SINGLE, cfg, 0.3);
    e.windows = { w: { x: 700, y: 300, width: 600, height: 740 } };
    e.step();
    e.goal({ x: 1000, y: 299, route: 'climb' });
    expect(e.until(() => e.m.climbPhase === 'climb' && e.m.y < 800, 30_000)).toBe(true);
    return e;
  }

  it('with bailOut the cat stays on the side (no snap) and goes on climbing', () => {
    const e = climbing({ bailOut: true });
    const before = { x: e.m.x, y: e.m.y };
    expect(e.m.setWorld({ ...SINGLE, version: 9 })).toBe(false);
    expect(e.m.onWall).toBe(true);
    e.step();
    expect(e.m.onWall).toBe(true);
    expect(Math.hypot(e.m.x - before.x, e.m.y - before.y)).toBeLessThan(0.5 * BW);
    expect(e.until(() => e.m.grounded, 30_000)).toBe(true);
    expect(e.m.support).toMatchObject({ surfaceId: topId('w') });
  });

  it('v1.1.1 (flag off): re-placed on the floor', () => {
    const e = climbing({});
    expect(e.m.setWorld({ ...SINGLE, version: 9 })).toBe(true);
    expect(e.m.grounded).toBe(true);
    expect(e.m.y).toBe(FLOOR_Y);
  });
});
