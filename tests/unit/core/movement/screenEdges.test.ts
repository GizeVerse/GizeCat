// v1.2 screen-edge walls (ADR 0003 §6.1, §6.8, §6.9): only at outer display edges, never between
// monitors (also with roaming off), never beside a side taskbar or on a short display; climbed only
// by a goal naming the edge; the top hold with its 20 s cap; topology changes while clinging.
import { describe, expect, it } from 'vitest';
import { MOVEMENT, WorldModel } from '../../../../src/core/movement';
import { GAIT_LIMIT_DIP } from '../../../../src/shared/cat';
import { BH, BW, display, edgeId, env, FLOOR_Y, ledge, SINGLE, taskbar, world } from './v12Fixtures';

const EDGES = { screenEdges: true } as const;

describe('WorldModel.screenEdgeWalls: outer edges only', () => {
  it('a single display gets a wall at both outer work-area edges, the cat clinging inside the screen', () => {
    const walls = new WorldModel(SINGLE, 1, true).screenEdgeWalls();
    expect(walls.map((w) => [w.key, w.x, w.side, w.facing, w.screenSide])).toEqual([
      [edgeId('1', 'left'), 0, 'right', -1, 'left'],
      [edgeId('1', 'right'), 1920, 'left', 1, 'right'],
    ]);
    for (const w of walls) {
      expect(w.kind).toBe('screenEdge');
      expect(w.topLedgeId).toBeNull();
      expect(w.yBottom).toBe(FLOOR_Y);
      expect(w.yTop).toBe(MOVEMENT.screenEdgeTopClearanceDip);
      // The stand point is inside the screen, on the floor's walk range.
      expect(Math.abs(w.standX - w.x)).toBeCloseTo(0.55 * BW, 6);
      expect(w.standX).toBeGreaterThan(0);
      expect(w.standX).toBeLessThan(1920);
    }
  });

  it('two side-by-side displays: no wall where they meet', () => {
    const dual = world(display('1', 0, 0, 1920, 1080, { primary: true, taskbar: 40 }), display('2', 1920, 0, 1920, 1080, { taskbar: 40 }));
    expect(new WorldModel(dual, 1, true).screenEdgeWalls().map((w) => [w.key, w.x])).toEqual([
      [edgeId('1', 'left'), 0],
      [edgeId('2', 'right'), 3840],
    ]);
  });

  it('negative origins and 100/150 % mixed DPI: the touching sides get none, the outer ones get one each', () => {
    const mixed = world(display('1', 0, 0, 1920, 1080, { primary: true, taskbar: 40 }), display('2', -2560, -180, 2560, 1440, { scale: 1.5 }));
    const walls = new WorldModel(mixed, 1, true).screenEdgeWalls();
    expect(walls.map((w) => [w.key, w.x])).toEqual([
      [edgeId('1', 'right'), 1920],
      [edgeId('2', 'left'), -2560],
    ]);
    // Scaled: the 150 % display's hold point is 120 DIP below its top.
    expect(walls[1]?.yTop).toBeCloseTo(-180 + 120 * 1.5, 6);
  });

  it('a diagonal corner-only touch is no neighbour; a gap within the join tolerance is one', () => {
    const corner = world(display('1', 0, 0, 1920, 1080, { primary: true }), display('2', 1920, 1080, 1920, 1080));
    expect(new WorldModel(corner, 1, true).screenEdgeWalls().map((w) => w.key)).toEqual([edgeId('1', 'left'), edgeId('1', 'right'), edgeId('2', 'left'), edgeId('2', 'right')]);
    const gap = world(display('1', 0, 0, 1920, 1080, { primary: true }), display('2', 1924, 0, 1920, 1080));
    expect(new WorldModel(gap, 1, true).screenEdgeWalls().map((w) => w.key)).toEqual([edgeId('1', 'left'), edgeId('2', 'right')]);
    // Overlapping by only 2 px vertically: still corner-like, no neighbour.
    const sliver = world(display('1', 0, 0, 1920, 1080, { primary: true }), display('2', 1920, 1078, 1920, 1080));
    expect(new WorldModel(sliver, 1, true).screenEdgeWalls().some((w) => w.key === edgeId('1', 'right'))).toBe(true);
  });

  it('a world restricted to one display (roaming off) still sees its neighbour: no wall between monitors', () => {
    const dual = world(display('1', 0, 0, 1920, 1080, { primary: true }), display('2', 1920, 0, 1920, 1080));
    const restricted = new WorldModel(dual, 1, false).restrictTo('1');
    expect(restricted.screenEdgeWalls().map((w) => w.key)).toEqual([edgeId('1', 'left')]);
  });

  it('never beside a docked side taskbar, nor beside one seen as a side taskbar (auto-hide), nor on a short display', () => {
    const left = world(display('1', 0, 0, 1920, 1080, { primary: true, leftTaskbar: 48 }));
    expect(new WorldModel(left, 1, true).screenEdgeWalls().map((w) => w.key)).toEqual([edgeId('1', 'right')]);
    expect(new WorldModel(SINGLE, 1, true).screenEdgeWalls(new Set(['1:right'])).map((w) => w.key)).toEqual([edgeId('1', 'left')]);
    // 2 body heights (128 px) needed between the hold point (120 px below the top) and the floor.
    const short = world(display('1', 0, 0, 1920, 120 + 2 * BH - 1, { primary: true }));
    expect(new WorldModel(short, 1, true).screenEdgeWalls()).toEqual([]);
    const tallEnough = world(display('1', 0, 0, 1920, 120 + 2 * BH, { primary: true }));
    expect(new WorldModel(tallEnough, 1, true).screenEdgeWalls()).toHaveLength(2);
  });
});

describe('Mover: screen edges', () => {
  it('without the flag there are no screen-edge walls at all (v1.1.1)', () => {
    const e = env(SINGLE);
    expect(e.m.wallTracks.filter((w) => w.kind === 'screenEdge')).toEqual([]);
    expect(e.m.climbOptions()).toEqual([]);
  });

  it('with roaming off the mover offers only the outer edge of its display', () => {
    const dual = world(display('1', 0, 0, 1920, 1080, { primary: true, taskbar: 40 }), display('2', 1920, 0, 1920, 1080, { taskbar: 40 }));
    const e = env(dual, { ...EDGES, allowMultiMonitor: false }, 0.5, '1');
    expect(e.m.wallTracks.map((w) => w.key)).toEqual([edgeId('1', 'left')]);
  });

  it('a side taskbar the provider lists (auto-hide too) removes that edge for the session', () => {
    const e = env(SINGLE, EDGES);
    expect(e.m.wallTracks.map((w) => w.key)).toEqual([edgeId('1', 'left'), edgeId('1', 'right')]);
    e.extra = [{ ...taskbar('tb', SINGLE.displays[0] as never, 600, 'left'), x0: 0, x1: 48, displayId: '1' }];
    e.step();
    e.extra = [];
    e.step();
    expect(e.m.wallTracks.map((w) => w.key)).toEqual([edgeId('1', 'right')]);
  });

  it('climbOptions offers each screen edge from the floor with wallKind screenEdge, ending at its top hold point', () => {
    const e = env(SINGLE, EDGES);
    const opts = e.m.climbOptions();
    expect(opts.map((o) => [o.wallId, o.dir, o.wallKind, o.target.y, o.ownerId])).toEqual([
      [edgeId('1', 'left'), 'up', 'screenEdge', MOVEMENT.screenEdgeTopClearanceDip, ''],
      [edgeId('1', 'right'), 'up', 'screenEdge', MOVEMENT.screenEdgeTopClearanceDip, ''],
    ]);
  });

  it('a goal naming the edge climbs it to the grip height and holds there (arrived, balance, support kind)', () => {
    const e = env(SINGLE, EDGES, 0.3);
    e.goal({ x: 0, y: 600, surfaceId: edgeId('1', 'left') });
    let maxClimb = 0;
    expect(
      e.until((r) => {
        maxClimb = Math.max(maxClimb, e.m.climbSpeed);
        return r.goal === 'arrived';
      }, 40_000),
    ).toBe(true);
    expect(e.m.onScreenEdge).toBe(true);
    expect(e.m.holdingOnWall).toBe(true);
    expect(e.m.x).toBe(0);
    expect(e.m.y).toBeCloseTo(600, 6);
    expect(e.m.support).toEqual({ kind: 'surface', surfaceId: edgeId('1', 'left'), surfaceKind: 'screenEdge', orientation: 'wall' });
    expect(e.m.attachedSurface).toBeNull();
    expect(e.m.perchWindowId).toBeNull();
    expect(e.m.balance).toBe(MOVEMENT.wallHoldBalance);
    expect(maxClimb).toBeLessThanOrEqual(MOVEMENT.gaitLimitFactor * GAIT_LIMIT_DIP.climb + 1e-6);
    // It stays: a later step still reports arrived.
    expect(e.step().goal).toBe('arrived');
  });

  it('holdOnWall never holds longer than MOVEMENT.maxWallHoldMs, then the cat climbs down to the floor', () => {
    const e = env(SINGLE, EDGES, 0.1);
    e.goal({ x: 0, y: 300, surfaceId: edgeId('1', 'left') });
    expect(e.until((r) => r.goal === 'arrived', 40_000)).toBe(true);
    const since = e.now;
    expect(e.m.holdOnWall(e.now + 120_000)).toBe(true);
    expect(e.until(() => !e.m.holdingOnWall, 30_000, 50)).toBe(true);
    expect(e.now - since).toBeLessThanOrEqual(MOVEMENT.maxWallHoldMs + 50);
    expect(e.now - since).toBeGreaterThanOrEqual(MOVEMENT.maxWallHoldMs - 50);
    // The hold point was the goal: it is done, and the cat climbs down instead of up again.
    expect(e.until(() => e.m.grounded, 30_000)).toBe(true);
    expect(e.m.y).toBe(FLOOR_Y);
    expect(e.m.hasGoal).toBe(false);
  });

  it('without any holdOnWall the hold still ends at the cap; holdOnWall(null) releases it at once', () => {
    const e = env(SINGLE, EDGES, 0.9);
    e.goal({ x: 1920, y: 400, surfaceId: edgeId('1', 'right') });
    expect(e.until((r) => r.goal === 'arrived', 40_000)).toBe(true);
    const since = e.now;
    expect(e.until(() => !e.m.holdingOnWall, 30_000, 50)).toBe(true);
    expect(e.now - since).toBeLessThanOrEqual(MOVEMENT.maxWallHoldMs + 50);

    const f = env(SINGLE, EDGES, 0.9);
    f.goal({ x: 1920, y: 400, surfaceId: edgeId('1', 'right') });
    expect(f.until((r) => r.goal === 'arrived', 40_000)).toBe(true);
    expect(f.m.holdOnWall(f.now + 5000)).toBe(true);
    f.step();
    expect(f.m.holdOnWall(null)).toBe(true);
    const y0 = f.m.y;
    f.step();
    f.step();
    expect(f.m.holdingOnWall).toBe(false);
    expect(f.m.y).toBeGreaterThan(y0);
    expect(f.until(() => f.m.grounded, 30_000)).toBe(true);
  });

  it('holdOnWall is refused when the cat is not clinging', () => {
    const e = env(SINGLE, EDGES);
    expect(e.m.holdOnWall(e.now + 1000)).toBe(false);
    expect(e.m.holdOnWall(null)).toBe(false);
  });

  it('no route uses a screen edge on its own: a ledge only a wall jump off the edge could reach stays unreachable', () => {
    // A window top high above the floor, near the left screen edge, with no climbable sides.
    const e = env(SINGLE, { ...EDGES, wallJumps: true }, 0.3);
    e.walls = false;
    e.extra = [ledge('windowTop:hi', 'windowTop', 'hi', 220, 150, 420)];
    e.step();
    e.goal({ x: 300, y: 219 });
    expect(e.until((r) => r.goal === 'unreachable', 30_000)).toBe(true);
    expect(e.log.some(() => e.m.onScreenEdge)).toBe(false);
    for (let i = 0; i < 200; i++) expect(e.step().climbStarted).toBe(false);
  });

  it('a display removed while the cat clings to its edge lets it go with cause gone (screenEdge), no physics loss', () => {
    const dual = world(display('1', 0, 0, 1920, 1080, { primary: true, taskbar: 40 }), display('2', 1920, 0, 1920, 1080, { taskbar: 40 }));
    const e = env(dual, EDGES, 0.9, '2');
    e.goal({ x: 3840, y: 500, surfaceId: edgeId('2', 'right') });
    expect(e.until((r) => r.goal === 'arrived', 40_000)).toBe(true);
    const single = world(display('1', 0, 0, 1920, 1080, { primary: true, taskbar: 40 }));
    e.w = single;
    e.m.setWorld(single);
    const r = e.step();
    expect(r.supportLost).toEqual({ reason: 'gone', surfaceId: edgeId('2', 'right'), surfaceKind: 'screenEdge', fell: true });
    expect(e.m.onScreenEdge).toBe(false);
    expect(e.nextLanding(5000)).not.toBeNull();
    expect(e.m.y).toBe(FLOOR_Y);
  });

  it('a topology change that keeps the edge keeps the cat clinging without a snap', () => {
    const e = env(SINGLE, EDGES, 0.1);
    e.goal({ x: 0, y: 500, surfaceId: edgeId('1', 'left') });
    expect(e.until((r) => r.goal === 'arrived', 40_000)).toBe(true);
    const before = { x: e.m.x, y: e.m.y };
    expect(e.m.setWorld({ ...SINGLE, version: 7 })).toBe(false);
    const r = e.step();
    expect(r.supportLost).toBeNull();
    expect(e.m.onScreenEdge).toBe(true);
    expect(Math.hypot(e.m.x - before.x, e.m.y - before.y)).toBeLessThanOrEqual(0.5 * BW);
  });

  it('a monitor plugged in beside the edge removes it: the cat lets go from where it is (no snap)', () => {
    const e = env(SINGLE, EDGES, 0.9);
    e.goal({ x: 1920, y: 500, surfaceId: edgeId('1', 'right') });
    expect(e.until((r) => r.goal === 'arrived', 40_000)).toBe(true);
    const before = { x: e.m.x, y: e.m.y };
    const dual = world(display('1', 0, 0, 1920, 1080, { primary: true, taskbar: 40 }), display('2', 1920, 0, 1920, 1080, { taskbar: 40 }));
    e.w = dual;
    e.m.setWorld(dual);
    expect(Math.hypot(e.m.x - before.x, e.m.y - before.y)).toBeLessThanOrEqual(0.5 * BW);
    expect(e.step().supportLost?.reason).toBe('gone');
    expect(e.nextLanding(5000)).not.toBeNull();
  });

  it('switching screen edges off while clinging lets the cat go calmly (disabled)', () => {
    const e = env(SINGLE, EDGES, 0.1);
    e.goal({ x: 0, y: 500, surfaceId: edgeId('1', 'left') });
    expect(e.until((r) => r.goal === 'arrived', 40_000)).toBe(true);
    e.m.setConfig({ size: 1, movementSpeed: 1, allowMultiMonitor: true, perchOnWindows: true, screenEdges: false });
    const r = e.step();
    expect(r.supportLost).toMatchObject({ reason: 'disabled', surfaceKind: 'screenEdge' });
  });

  it('a goal naming an edge that does not exist is unreachable', () => {
    const e = env(SINGLE, EDGES);
    e.goal({ x: 0, y: 500, surfaceId: edgeId('9', 'left') });
    expect(e.until((r) => r.goal === 'unreachable', 5000)).toBe(true);
    expect(e.m.grounded).toBe(true);
  });
});

describe('Mover: screen-edge leave options while holding', () => {
  it('climbDown always, climbLeap only with wall jumps; leaveBy climbDown takes it to the floor', () => {
    const e = env(SINGLE, EDGES, 0.1);
    e.goal({ x: 0, y: 500, surfaceId: edgeId('1', 'left') });
    expect(e.until((r) => r.goal === 'arrived', 40_000)).toBe(true);
    const opts = e.m.leaveOptions();
    expect(opts.map((o) => o.kind)).toEqual(['climbDown']);
    expect(opts[0]).toMatchObject({ toKind: 'floor', toSurfaceId: null, emergency: false, impact: null });
    expect(e.m.leaveBy(opts[0] as never, 'walk')).toBe(true);
    expect(e.until(() => e.m.grounded, 20_000)).toBe(true);
    expect(e.m.y).toBe(FLOOR_Y);
    expect(e.until((r) => r.goal === 'arrived', 5000)).toBe(true);
  });

  it('with wall jumps it can push off onto the floor from a grip within the limits (jumpKind wallJump)', () => {
    const e = env(SINGLE, { ...EDGES, wallJumps: true, jumpDownSafeDip: 477, jumpDownMaxDip: 644 }, 0.1);
    e.goal({ x: 0, y: 400, surfaceId: edgeId('1', 'left') });
    expect(e.until((r) => r.goal === 'arrived', 40_000)).toBe(true);
    const leap = e.m.leaveOptions().find((o) => o.kind === 'climbLeap' && o.toKind === 'floor');
    expect(leap).toBeDefined();
    expect(e.m.leaveBy(leap as never, 'walk')).toBe(true);
    let kind: string | null = null;
    let crouched = false;
    const landed = (() => {
      let l = null as ReturnType<typeof e.step>['landed'];
      e.until((r) => {
        crouched ||= r.crouchStarted;
        if (e.m.airborne) kind = e.m.jumpKind;
        l = r.landed;
        return l !== null;
      }, 20_000);
      return l;
    })();
    expect(crouched).toBe(true);
    expect(kind).toBe('wallJump');
    expect(landed).toMatchObject({ jumpKind: 'wallJump', intentional: true, plannedOutcome: 'landed' });
    expect(landed?.impact).not.toBe('hard');
    expect(e.m.y).toBe(FLOOR_Y);
  });
});
