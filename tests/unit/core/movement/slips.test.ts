// v1.2 deliberate slips (ADR 0003 §6.6): armed by the sim during the crouch of a take-off onto
// another support (jumps, leaps onto sides, wall jumps, pull-ups onto tab strips; never hops on the
// same surface, pounces or bail-outs); 'scramble' holds the cat on the edge for 0.9 s, 'miss' slides
// it off to the support below (LandingInfo.slipped), and a miss over a drop beyond the safe height
// is turned into a scramble. nextLegRisk is the geometric risk of the take-off being prepared.
import { describe, expect, it } from 'vitest';
import type { LandingInfo, MoverStep } from '../../../../src/core/movement';
import { MOVEMENT, takeoffRisk } from '../../../../src/core/movement';
import { BW, env, FLOOR_Y, ledge, SINGLE, sideId, stripId, topId, wall } from './v12Fixtures';

/** The cat on the floor heading for a window top 200 px up (no sides): steps until the jump crouch starts. */
function crouchingForTop(cfg = {}): ReturnType<typeof env> {
  const e = env(SINGLE, cfg, 0.4);
  e.walls = false;
  e.windows = { w: { x: 900, y: FLOOR_Y - 200, width: 500, height: 200 } };
  e.step();
  e.goal({ x: 1300, y: FLOOR_Y - 201 });
  expect(e.until((r) => r.crouchStarted, 20_000)).toBe(true);
  return e;
}

function collect(e: ReturnType<typeof env>, pred: (r: MoverStep) => boolean, maxMs: number): { steps: MoverStep[]; landing: LandingInfo | null } {
  const steps: MoverStep[] = [];
  let landing: LandingInfo | null = null;
  e.until((r) => {
    steps.push(r);
    landing ??= r.landed;
    return pred(r);
  }, maxMs);
  return { steps, landing };
}

describe('armSlip eligibility and nextLegRisk', () => {
  it('only while a take-off onto another support is being prepared', () => {
    const idle = env(SINGLE, {}, 0.5);
    expect(idle.m.armSlip('scramble')).toBe(false);
    expect(idle.m.nextLegRisk).toBe(0);
    expect(idle.m.hop(idle.now)).toBe(true);
    // A hop on the same surface never slips.
    expect(idle.m.armSlip('miss')).toBe(false);
    expect(idle.m.nextLegRisk).toBe(0);

    const e = crouchingForTop();
    expect(e.m.nextLegRisk).toBeGreaterThanOrEqual(0);
    expect(e.m.nextLegRisk).toBeLessThanOrEqual(1);
    expect(e.m.armSlip('scramble')).toBe(true);
    expect(e.m.armSlip('bogus' as never)).toBe(false);
  });

  it('the geometric risk grows with a narrow landing span, a long gap, a high rise and a moving target', () => {
    const base = { spanPx: 5 * BW, gapPx: 50, upPx: 50, targetSpeedDip: 0 };
    expect(takeoffRisk(base, 1, BW)).toBe(0);
    expect(takeoffRisk({ ...base, spanPx: 0.5 * BW }, 1, BW)).toBeGreaterThan(0.4);
    expect(takeoffRisk({ ...base, gapPx: 0.95 * MOVEMENT.maxJumpAcrossDip }, 1, BW)).toBeGreaterThan(0.5);
    expect(takeoffRisk({ ...base, upPx: 0.95 * MOVEMENT.maxJumpUpDip }, 1, BW)).toBeGreaterThan(0.5);
    expect(takeoffRisk({ ...base, targetSpeedDip: 200 }, 1, BW)).toBeGreaterThan(0.9);
    const all = takeoffRisk({ spanPx: 0.5 * BW, gapPx: 0.95 * MOVEMENT.maxJumpAcrossDip, upPx: 0.95 * MOVEMENT.maxJumpUpDip, targetSpeedDip: 200 }, 1, BW);
    expect(all).toBeLessThanOrEqual(1);
    expect(all).toBeGreaterThan(0.95);
  });

  it('nextLegRisk reflects the target: a narrow tab-strip span is riskier than a wide window top', () => {
    const wide = crouchingForTop();
    const narrow = env(SINGLE, {}, 0.4);
    narrow.walls = false;
    narrow.extra = [ledge(stripId('s'), 'tabStrip', 's', FLOOR_Y - 200, 1100, 1100 + 0.5 * BW)];
    narrow.step();
    narrow.goal({ x: 1120, y: FLOOR_Y - 201 });
    expect(narrow.until((r) => r.crouchStarted, 20_000)).toBe(true);
    expect(narrow.m.nextLegRisk).toBeGreaterThan(wide.m.nextLegRisk + 0.3);
  });
});

describe('slips on a jump onto a ledge', () => {
  it("'scramble': lands on the target, reports the slip, and holds still on the edge for 0.9 s", () => {
    const e = crouchingForTop();
    expect(e.m.armSlip('scramble')).toBe(true);
    const r = collect(e, (s) => s.landed !== null, 5000);
    expect(r.landing).toMatchObject({ plannedOutcome: 'landed', slipped: false, plannedSupportId: topId('w') });
    expect(r.steps.at(-1)?.slipped).toBe('scramble');
    const x0 = e.m.x;
    const t0 = e.now;
    // A goal further along the top waits until the scramble is over.
    e.goal({ x: x0 - 200, y: FLOOR_Y - 201 });
    e.until(() => e.now - t0 >= MOVEMENT.slipScrambleMs - 40, 2000);
    expect(e.m.x).toBe(x0);
    expect(e.until(() => Math.abs(e.m.x - x0) > 1, 3000)).toBe(true);
    expect(e.now - t0).toBeGreaterThanOrEqual(MOVEMENT.slipScrambleMs - 20);
  });

  it("'miss': the paws do not hold; it slides off to the support below (slipped landing, the planned target missed)", () => {
    const e = crouchingForTop();
    expect(e.m.armSlip('miss')).toBe(true);
    const r = collect(e, (s) => s.landed !== null, 6000);
    expect(r.steps.some((s) => s.slipped === 'miss')).toBe(true);
    expect(r.landing).toMatchObject({ slipped: true, plannedSupportId: topId('w'), plannedOutcome: 'missed' });
    expect(e.m.y).toBe(FLOOR_Y);
    expect(e.m.support).toEqual({ kind: 'floor', displayId: '1' });
  });

  it('a miss over a drop beyond the safe jump-down height becomes a scramble', () => {
    const e = crouchingForTop({ jumpDownSafeDip: 150, jumpDownMaxDip: 400 });
    expect(e.m.armSlip('miss')).toBe(true);
    const r = collect(e, (s) => s.landed !== null, 6000);
    expect(r.steps.some((s) => s.slipped === 'miss')).toBe(false);
    expect(r.steps.at(-1)?.slipped).toBe('scramble');
    expect(r.landing).toMatchObject({ slipped: false, plannedOutcome: 'landed' });
  });
});

describe('slips on a leap onto a side and on a pull-up onto a tab strip', () => {
  /** A window whose side ends 240 px above the floor: the cat leaps onto it (ADR 0002 v1.1.1 leap). */
  function crouchingForLeap(): ReturnType<typeof env> {
    const e = env(SINGLE, {}, 0.3);
    e.windows = { w: { x: 800, y: 300, width: 600, height: 500 } };
    e.step();
    e.goal({ x: 1100, y: 299, route: 'climb' });
    expect(e.until((r) => r.crouchStarted, 30_000)).toBe(true);
    return e;
  }

  it("'scramble' at the catch: it clings, holds still 0.9 s, then climbs", () => {
    const e = crouchingForLeap();
    expect(e.m.armSlip('scramble')).toBe(true);
    const r = collect(e, (s) => s.clung, 5000);
    expect(r.steps.at(-1)?.slipped).toBe('scramble');
    const y0 = e.m.y;
    const t0 = e.now;
    e.until(() => e.now - t0 >= MOVEMENT.slipScrambleMs - 40, 2000);
    expect(e.m.y).toBe(y0);
    expect(e.until(() => e.m.y < y0 - 1, 3000)).toBe(true);
  });

  it("'miss' at the catch: it drops back to the floor with a slipped landing", () => {
    const e = crouchingForLeap();
    expect(e.m.armSlip('miss')).toBe(true);
    const r = collect(e, (s) => s.landed !== null, 6000);
    expect(r.steps.some((s) => s.slipped === 'miss')).toBe(true);
    expect(r.steps.some((s) => s.clung)).toBe(false);
    expect(r.landing?.slipped).toBe(true);
    expect(e.m.y).toBe(FLOOR_Y);
  });

  /** A tab strip on a window whose sides lead up to it: the cat climbs a side and pulls up onto the strip. */
  function climbingToStrip(): ReturnType<typeof env> {
    const e = env(SINGLE, {}, 0.3);
    e.walls = false;
    const y = 400;
    e.extra = [
      ledge(stripId('b'), 'tabStrip', 'b', y, 820, 1380),
      wall('b', 'left', 800, y, FLOOR_Y, { topLedgeId: stripId('b') }),
      wall('b', 'right', 1400, y, FLOOR_Y, { topLedgeId: stripId('b') }),
    ];
    e.step();
    e.goal({ x: 1100, y: y - 1, route: 'climb' });
    expect(e.until((r) => r.climbStarted, 30_000)).toBe(true);
    expect(e.m.wall?.key === sideId('b', 'left') || e.m.wall?.key === sideId('b', 'right')).toBe(true);
    expect(e.until(() => e.m.climbPhase === 'climb', 2000)).toBe(true);
    return e;
  }

  it("a pull-up onto a strip may be armed while climbing: 'scramble' lengthens it by 0.9 s", () => {
    const e = climbingToStrip();
    expect(e.m.nextLegRisk).toBeGreaterThanOrEqual(0);
    expect(e.m.armSlip('scramble')).toBe(true);
    const start = { t: Number.NaN };
    const r = collect(
      e,
      (s) => {
        if (s.slipped === 'scramble') start.t = e.now;
        return e.m.grounded;
      },
      30_000,
    );
    expect(Number.isFinite(start.t)).toBe(true);
    expect(e.now - start.t).toBeGreaterThanOrEqual(MOVEMENT.pullUpMs + MOVEMENT.slipScrambleMs - 40);
    expect(r.steps.some((s) => s.slipped === 'miss')).toBe(false);
    expect(e.m.support).toMatchObject({ surfaceId: stripId('b') });
  });

  it('a wall jump may slip too: armed during its push-off crouch, a scramble on landing on a ledge, never on the floor', () => {
    const atEdge = (): ReturnType<typeof env> => {
      const e = env(SINGLE, { screenEdges: true, wallJumps: true, jumpDownSafeDip: 477, jumpDownMaxDip: 644 }, 0.1);
      e.extra = [ledge('windowTop:t', 'windowTop', 't', 700, 100, 500)];
      e.goal({ x: 0, y: 500, surfaceId: 'screenEdge:1:left' });
      expect(e.until((r) => r.goal === 'arrived', 40_000)).toBe(true);
      return e;
    };
    const off = (e: ReturnType<typeof env>, toKind: string): void => {
      const leap = e.m.leaveOptions().find((o) => o.kind === 'climbLeap' && o.toKind === toKind);
      expect(leap).toBeDefined();
      expect(e.m.leaveBy(leap as never, 'walk')).toBe(true);
      expect(e.until((r) => r.crouchStarted, 20_000)).toBe(true);
    };
    const toFloor = atEdge();
    off(toFloor, 'floor');
    expect(toFloor.m.armSlip('scramble')).toBe(false);
    const e = atEdge();
    off(e, 'windowTop');
    expect(e.m.nextLegRisk).toBeGreaterThanOrEqual(0);
    expect(e.m.armSlip('scramble')).toBe(true);
    const r = collect(e, (s) => s.landed !== null, 5000);
    expect(r.landing).toMatchObject({ jumpKind: 'wallJump', plannedOutcome: 'landed', slipped: false });
    expect(r.steps.at(-1)?.slipped).toBe('scramble');
  });

  it("'miss' on the pull-up drops it off the corner with a slipped landing", () => {
    const e = climbingToStrip();
    expect(e.m.armSlip('miss')).toBe(true);
    const r = collect(e, (s) => s.landed !== null, 30_000);
    expect(r.steps.some((s) => s.slipped === 'miss')).toBe(true);
    expect(r.landing?.slipped).toBe(true);
    expect(e.m.y).toBe(FLOOR_Y);
  });
});
