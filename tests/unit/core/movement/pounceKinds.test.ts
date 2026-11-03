// v1.2 ballistic pounce (ADR 0003 §6.5), jump kinds (§6.2), clean-gait pace clamps and narrow
// ledges with balance (§6.7).
import { describe, expect, it } from 'vitest';
import type { JumpKind } from '../../../../src/shared/cat';
import { GAIT_LIMIT_DIP, HIT_FRONT_EXTENT_DIP } from '../../../../src/shared/cat';
import type { LandingInfo, Pace, PounceOptions } from '../../../../src/core/movement';
import { classifyJump, MOVEMENT } from '../../../../src/core/movement';
import { BH, BW, display, env, FLOOR_Y, ledge, SINGLE, topId, world } from './v12Fixtures';

const POUNCE: PounceOptions = { crouchMs: 600, shortPx: 30, maxDistPx: 3.2 * BW, frontExtentPx: HIT_FRONT_EXTENT_DIP.pounce };

/** Runs until the next landing, recording the jump kind seen while airborne and the highest point. */
function flight(e: ReturnType<typeof env>, maxMs = 5000): { landing: LandingInfo | null; kinds: Set<JumpKind | null>; minY: number; tookOffAt: number | null; cancelled: boolean } {
  const kinds = new Set<JumpKind | null>();
  let minY = e.m.y;
  let tookOffAt: number | null = null;
  let cancelled = false;
  let landing: LandingInfo | null = null;
  e.until((r) => {
    if (r.tookOff && tookOffAt === null) tookOffAt = e.now;
    if (r.planCancelled) cancelled = true;
    if (e.m.airborne || e.m.climbPhase === 'leap') kinds.add(e.m.jumpKind);
    minY = Math.min(minY, e.m.y);
    landing = r.landed;
    return landing !== null || cancelled;
  }, maxMs);
  return { landing, kinds, minY, tookOffAt, cancelled };
}

describe('Mover.pounceAt (ballistic hunting pounce)', () => {
  it.each([1, -1])('lands the anchor frontExtentPx + shortPx short of the target, facing it (direction %i)', (dir) => {
    const e = env(SINGLE, {}, 0.5);
    const x0 = e.m.x;
    const target = { x: x0 + dir * 2.5 * BW, y: e.m.y };
    expect(e.m.pounceAt(e.now, target, POUNCE)).toBe(true);
    expect(e.m.mode).toBe('crouch');
    const f = flight(e);
    expect(f.landing).toMatchObject({ jumpKind: 'pounce', intentional: true, plannedOutcome: 'landed' });
    expect(e.m.x).toBeCloseTo(target.x - dir * (POUNCE.frontExtentPx! + POUNCE.shortPx), 6);
    expect(e.m.facing).toBe(dir);
    expect([...f.kinds]).toEqual(['pounce']);
    // The crouch (the wiggle) lasted crouchMs before the take-off.
    expect(f.tookOffAt).not.toBeNull();
  });

  it('never further than min(maxDistPx, 3.2 body lengths); the apex rises 30..70 DIP with the distance', () => {
    const far = env(SINGLE, {}, 0.3);
    const x0 = far.m.x;
    expect(far.m.pounceAt(far.now, { x: x0 + 10 * BW, y: far.m.y }, { ...POUNCE, maxDistPx: 99 * BW })).toBe(true);
    const ff = flight(far);
    expect(far.m.x - x0).toBeCloseTo(MOVEMENT.pounceReachBodyLengths * BW, 6);
    expect(FLOOR_Y - ff.minY).toBeGreaterThan(MOVEMENT.pounceApexMaxDip - 3);
    expect(FLOOR_Y - ff.minY).toBeLessThanOrEqual(MOVEMENT.pounceApexMaxDip + 1);

    const capped = env(SINGLE, {}, 0.3);
    const c0 = capped.m.x;
    expect(capped.m.pounceAt(capped.now, { x: c0 + 10 * BW, y: capped.m.y }, { ...POUNCE, maxDistPx: 1.5 * BW })).toBe(true);
    flight(capped);
    expect(capped.m.x - c0).toBeCloseTo(1.5 * BW, 6);

    const near = env(SINGLE, {}, 0.3);
    const n0 = near.m.x;
    expect(near.m.pounceAt(near.now, { x: n0 + 1.4 * BW, y: near.m.y }, { ...POUNCE, shortPx: 10, frontExtentPx: 40 })).toBe(true);
    const nf = flight(near);
    const apex = FLOOR_Y - nf.minY;
    expect(apex).toBeGreaterThanOrEqual(MOVEMENT.pounceApexMinDip - 1);
    expect(apex).toBeLessThan(MOVEMENT.pounceApexMinDip + 0.5 * (MOVEMENT.pounceApexMaxDip - MOVEMENT.pounceApexMinDip));
  });

  it('a target past a ledge end lands 0.2 body lengths inside that end: never off the ledge', () => {
    const e = env(SINGLE, {}, 0.5);
    e.windows = { w: { x: 700, y: 700, width: 420, height: 340 } };
    e.step();
    e.placeOn(topId('w'), 820, 700);
    const top = e.m.walkRange as { x0: number; x1: number };
    expect(e.m.pounceAt(e.now, { x: 1500, y: 699 }, POUNCE)).toBe(true);
    const f = flight(e);
    expect(f.landing?.plannedOutcome).toBe('landed');
    expect(e.m.support).toMatchObject({ surfaceId: topId('w') });
    expect(e.m.x).toBeCloseTo(top.x1 - MOVEMENT.pounceEndMarginBodyLengths * BW, 6);
  });

  it('lands on a ledge walk-joined at the same height when the target is over it', () => {
    const e = env(SINGLE, {}, 0.5);
    e.walls = false;
    e.extra = [ledge('windowTop:a', 'windowTop', 'a', 700, 600, 900), ledge('windowTop:b', 'windowTop', 'b', 700, 900, 1300)];
    e.step();
    e.placeOn('windowTop:a', 760, 700);
    expect(e.m.pounceAt(e.now, { x: 1080, y: 699 }, POUNCE)).toBe(true);
    const f = flight(e);
    expect(f.landing?.plannedSupportId).toBe('windowTop:b');
    expect(e.m.support).toMatchObject({ surfaceId: 'windowTop:b' });
    expect(e.m.x).toBeCloseTo(1080 - (POUNCE.frontExtentPx! + POUNCE.shortPx), 6);
  });

  it('a surface moving more than half a body length during the crouch cancels the pounce (planCancelled)', () => {
    const e = env(SINGLE, {}, 0.5);
    e.windows = { w: { x: 600, y: 700, width: 700, height: 340 } };
    e.step();
    e.placeOn(topId('w'), 800, 700);
    expect(e.m.pounceAt(e.now, { x: 1100, y: 699 }, POUNCE)).toBe(true);
    e.step();
    e.windows = { w: { x: 600, y: 700 - 0.6 * BW, width: 700, height: 340 } };
    const f = flight(e, 3000);
    expect(f.cancelled).toBe(true);
    expect(f.tookOffAt).toBeNull();
    expect(e.m.grounded).toBe(true);
  });

  it('refuses when it cannot pounce: too close, not standing, or on a narrow ledge; it never slips', () => {
    const e = env(SINGLE, {}, 0.5);
    expect(e.m.pounceAt(e.now, { x: e.m.x + 0.5 * BW, y: e.m.y }, POUNCE)).toBe(false);
    expect(e.m.pounceAt(e.now, { x: Number.NaN, y: e.m.y }, POUNCE)).toBe(false);
    expect(e.m.pounceAt(e.now, { x: e.m.x + 3 * BW, y: e.m.y }, POUNCE)).toBe(true);
    expect(e.m.armSlip('scramble')).toBe(false);
    expect(e.m.nextLegRisk).toBe(0);
    expect(e.m.pounceAt(e.now, { x: e.m.x - 3 * BW, y: e.m.y }, POUNCE)).toBe(false);

    const n = env(SINGLE, { narrowLedges: true }, 0.5);
    n.walls = false;
    n.extra = [ledge('windowTop:n', 'windowTop', 'n', 700, 900, 960)];
    n.step();
    n.placeOn('windowTop:n', 930, 700);
    expect(n.m.balance).toBeGreaterThan(0);
    expect(n.m.pounceAt(n.now, { x: n.m.x + 2 * BW, y: n.m.y }, POUNCE)).toBe(false);
    expect(n.m.pounce(n.now, n.m.x + 2 * BW)).toBe(false);
  });
});

describe('jump kinds (render hint and LandingInfo.jumpKind)', () => {
  it('classifies by displacement: hop on the same surface, up, down, across', () => {
    expect(classifyJump(0.5 * BW, 0, BW, BH, true)).toBe('hop');
    expect(classifyJump(1.5 * BW, 0, BW, BH, true)).toBe('across');
    expect(classifyJump(0.5 * BW, 0, BW, BH, false)).toBe('across');
    expect(classifyJump(0, -0.6 * BH, BW, BH, false)).toBe('up');
    expect(classifyJump(0, 0.6 * BH, BW, BH, false)).toBe('down');
  });

  it('hop(), the playful pounce(), a jump up onto a top, a step down, a leap onto a side', () => {
    const h = env(SINGLE, {}, 0.5);
    expect(h.m.hop(h.now)).toBe(true);
    expect(flight(h).landing?.jumpKind).toBe('hop');

    const p = env(SINGLE, {}, 0.5);
    expect(p.m.pounce(p.now, p.m.x + 2 * BW)).toBe(true);
    expect(flight(p).landing?.jumpKind).toBe('pounce');

    const up = env(SINGLE, {}, 0.5);
    up.walls = false;
    up.windows = { w: { x: 800, y: 840, width: 500, height: 200 } };
    up.step();
    up.goal({ x: 1000, y: 839 });
    const fu = flight(up, 20_000);
    expect(fu.landing?.jumpKind).toBe('up');
    expect([...fu.kinds]).toEqual(['up']);

    // Down again: a step off the end (or a planned jump) is reported as 'down'.
    up.goal({ x: 300, y: FLOOR_Y });
    const fd = flight(up, 20_000);
    expect(fd.landing?.jumpKind).toBe('down');

    const leap = env(SINGLE, {}, 0.3);
    leap.windows = { w: { x: 700, y: 300, width: 600, height: 500 } };
    leap.step();
    leap.goal({ x: 1000, y: 299, route: 'climb' });
    const kinds = new Set<JumpKind | null>();
    expect(
      leap.until((r) => {
        if (leap.m.climbPhase === 'leap') kinds.add(leap.m.jumpKind);
        return r.clung;
      }, 30_000),
    ).toBe(true);
    expect([...kinds]).toEqual(['leap']);
  });

  it('a throw or a release by the user has no jump kind', () => {
    const e = env(SINGLE, {}, 0.5);
    expect(e.dropAt(900, 600)?.jumpKind).toBeNull();
  });
});

describe('paces: clamped to 1.1 x their clip clean-gait limit (GAIT_LIMIT_DIP)', () => {
  const paces: Pace[] = ['stalk', 'slow', 'walk', 'chase', 'run', 'sprint'];

  it('at movementSpeed 1 the table speeds hold (all within their limits)', () => {
    const e = env(SINGLE, {}, 0.5);
    expect(paces.map((p) => e.m.paceSpeedPx(p))).toEqual([24, 42, 70, 210, 260, 360]);
  });

  it('at movementSpeed 2 every pace stays within 1.1 x its limit, also at 150 %', () => {
    const e = env(SINGLE, { movementSpeed: 2 }, 0.5);
    const lim = { stalk: GAIT_LIMIT_DIP.stalk, slow: GAIT_LIMIT_DIP.walk, walk: GAIT_LIMIT_DIP.walk, chase: GAIT_LIMIT_DIP.run, run: GAIT_LIMIT_DIP.run, sprint: GAIT_LIMIT_DIP.sprint };
    for (const p of paces) expect(e.m.paceSpeedPx(p), p).toBeLessThanOrEqual(MOVEMENT.gaitLimitFactor * lim[p] + 1e-9);
    expect(e.m.paceSpeedPx('walk')).toBeCloseTo(1.1 * GAIT_LIMIT_DIP.walk, 9);
    expect(e.m.paceSpeedPx('sprint')).toBeCloseTo(1.1 * GAIT_LIMIT_DIP.sprint, 9);
    expect(e.m.paceSpeedPx('chase')).toBe(420);
    const hi = env(world(display('1', 0, 0, 2880, 1620, { primary: true, scale: 1.5 })), { movementSpeed: 2 }, 0.5);
    expect(hi.m.paceSpeedPx('walk')).toBeCloseTo(1.1 * GAIT_LIMIT_DIP.walk * 1.5, 9);
  });

  it('climbing at movementSpeed 2 never exceeds 1.1 x the climb limit', () => {
    const e = env(SINGLE, { movementSpeed: 2 }, 0.3);
    e.windows = { w: { x: 700, y: 300, width: 600, height: 740 } };
    e.step();
    e.goal({ x: 1000, y: 299, route: 'climb' });
    let max = 0;
    expect(
      e.until(() => {
        max = Math.max(max, e.m.climbSpeed);
        return e.m.support.kind === 'surface' && e.m.grounded;
      }, 40_000),
    ).toBe(true);
    expect(max).toBeGreaterThan(0);
    expect(max).toBeLessThanOrEqual(MOVEMENT.gaitLimitFactor * GAIT_LIMIT_DIP.climb + 1e-6);
  });
});

describe('narrow ledges (MoverConfig.narrowLedges)', () => {
  const narrow = (cfg: { narrowLedges?: boolean }) => {
    const e = env(SINGLE, cfg, 0.5);
    e.walls = false;
    e.extra = [ledge('windowTop:n', 'windowTop', 'n', 700, 900, 970)];
    e.step();
    return e;
  };

  it('a window top 0.25..0.9 body lengths wide is a support only with the flag', () => {
    expect(narrow({}).m.ledgeById('windowTop:n')).toBeNull();
    const e = narrow({ narrowLedges: true });
    expect(e.m.ledgeById('windowTop:n')?.narrowWidthPx).toBe(70);
    // Below a quarter body: still too narrow.
    const tiny = env(SINGLE, { narrowLedges: true }, 0.5);
    tiny.extra = [ledge('windowTop:t', 'windowTop', 't', 700, 900, 900 + 0.2 * BW)];
    tiny.step();
    expect(tiny.m.ledgeById('windowTop:t')).toBeNull();
  });

  it('on it the cat balances (clamp((0.9 bw - width) / 0.65 bw)), walks at most 0.6 x its walking pace and never runs', () => {
    const e = narrow({ narrowLedges: true });
    e.placeOn('windowTop:n', 935, 700);
    expect(e.m.balance).toBeCloseTo((0.9 * BW - 70) / (0.65 * BW), 9);
    const r = e.m.walkRange as { x0: number; x1: number };
    e.m.setGoal({ x: r.x0, y: 699, pace: 'run', allowJump: false });
    let max = 0;
    e.until((s) => {
      max = Math.max(max, e.m.groundSpeed);
      return s.goal === 'arrived';
    }, 3000);
    e.m.setGoal({ x: r.x1, y: 699, pace: 'sprint', allowJump: false });
    e.until((s) => {
      max = Math.max(max, e.m.groundSpeed);
      return s.goal === 'arrived';
    }, 3000);
    expect(max).toBeGreaterThan(0);
    expect(max).toBeLessThanOrEqual(MOVEMENT.narrowWalkFactor * MOVEMENT.walkDip + 1e-6);
    // Off the narrow ledge, on the floor, balance is 0 again.
    expect(env(SINGLE, { narrowLedges: true }).m.balance).toBe(0);
  });
});
