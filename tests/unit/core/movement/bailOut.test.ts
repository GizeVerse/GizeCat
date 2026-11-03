// v1.2 controlled bail-out (ADR 0003 §3, B13): with MoverConfig.bailOut a covered, vanished
// (closed, minimized, maximized) or headroom-less support is left within the 450 ms grace by one
// take-off after a 120 ms crouch, at most 0.6 s after the cover, in this order: a single hop onto the
// still-visible stretch of the same edge, one jump onto a visible support within H_max (softest
// first), a leap onto a visible wall (then climbing down), the emergency drop. Never a walk across
// the covered part; never a free fall (perchLost).
import { describe, expect, it } from 'vitest';
import type { MoverStep } from '../../../../src/core/movement';
import { MOVEMENT } from '../../../../src/core/movement';
import { BW, DEFAULT_LIMITS, env, FLOOR_Y, ledge, SINGLE, sideId, stripId, topId, wall } from './v12Fixtures';

const BAIL = { bailOut: true, ...DEFAULT_LIMITS } as const;

/** Cat standing on window w's top (x 600..1400, y) at x = 900. */
function onW(y = 600, cfg: object = BAIL, walls = false): ReturnType<typeof env> {
  const e = env(SINGLE, cfg, 0.45);
  e.walls = walls;
  e.windows = { w: { x: 600, y, width: 800, height: FLOOR_Y - y } };
  e.step();
  e.placeOn(topId('w'), 900, y);
  e.m.setGoal(null);
  for (let i = 0; i < 5; i++) e.step();
  return e;
}

/** Steps from the cover until the cat stands again; what happened on the way. */
function afterCover(e: ReturnType<typeof env>, maxMs = 8000): { steps: Array<MoverStep & { t: number; x: number; grounded: boolean }>; coverAt: number } {
  const coverAt = e.now;
  const steps: Array<MoverStep & { t: number; x: number; grounded: boolean }> = [];
  e.until((r) => {
    steps.push({ ...r, t: e.now - coverAt, x: e.m.x, grounded: e.m.grounded });
    return r.landed !== null || (r.clung && e.m.onWall);
  }, maxMs);
  return { steps, coverAt };
}

const firstIdx = (steps: MoverStep[], p: (s: MoverStep) => boolean): number => steps.findIndex(p);

describe('bail-out order (MoverConfig.bailOut)', () => {
  it('1. covered where it stands: a single hop onto the visible stretch of the same edge, within 0.6 s, no walk across', () => {
    for (const cover of [
      { x0: 1000, x1: 1400 },
      { x0: 600, x1: 820 },
    ]) {
      const e = onW();
      const x0 = e.m.x;
      e.patch.set(topId('w'), cover);
      const { steps } = afterCover(e);
      const off = firstIdx(steps, (s) => s.tookOff);
      expect(off, JSON.stringify(cover)).toBeGreaterThan(0);
      const take = steps[off] as (typeof steps)[number];
      expect(take.bailedOut).toBe(true);
      expect(take.supportLost).toEqual({ reason: 'occluded', surfaceId: topId('w'), surfaceKind: 'windowTop', fell: false });
      expect(take.t).toBeLessThanOrEqual(MOVEMENT.bailOutMaxDelayMs);
      expect(e.m.bailOutKind).toBe('hop');
      // Until the take-off it crouched where it stood: it never walked across the covered part.
      for (const s of steps.slice(0, off)) expect(s.x).toBe(x0);
      expect(steps.some((s) => s.perchLost)).toBe(false);
      expect(steps.filter((s) => s.tookOff)).toHaveLength(1);
      expect(steps.at(-1)?.landed).toMatchObject({ plannedSupportId: topId('w'), plannedOutcome: 'landed', intentional: true });
      expect(e.m.x).toBeGreaterThanOrEqual(cover.x0 - 1);
      expect(e.m.x).toBeLessThanOrEqual(cover.x1 + 1);
    }
  });

  it('2. vanished (maximized, closed): one jump onto a visible support within H_max, the softest landing first', () => {
    const e = onW();
    e.extra = [ledge('windowTop:v', 'windowTop', 'v', 700, 1050, 1500)];
    e.step();
    e.windows = {};
    e.gone.add(topId('w'));
    const { steps } = afterCover(e);
    const off = firstIdx(steps, (s) => s.tookOff);
    const take = steps[off] as (typeof steps)[number];
    expect(take.bailedOut).toBe(true);
    expect(take.supportLost).toMatchObject({ reason: 'gone', surfaceId: topId('w'), fell: false });
    expect(take.t).toBeGreaterThanOrEqual(MOVEMENT.bailOutCrouchMs - 16);
    expect(take.t).toBeLessThanOrEqual(MOVEMENT.bailOutMaxDelayMs);
    expect(e.m.bailOutKind).toBe('jump');
    expect(steps.at(-1)?.landed).toMatchObject({ plannedSupportId: 'windowTop:v', plannedOutcome: 'landed', impact: 'soft' });
    expect(steps.some((s) => s.perchLost)).toBe(false);
  });

  it('2b. with only the floor in reach it jumps there (medium), never a free fall', () => {
    const e = onW();
    e.windows = {};
    e.gone.add(topId('w'));
    const { steps } = afterCover(e);
    expect(steps.find((s) => s.tookOff)?.bailedOut).toBe(true);
    expect(e.m.bailOutKind).toBe('jump');
    expect(steps.at(-1)?.landed?.impact).not.toBe('hard');
    expect(steps.at(-1)?.landed?.plannedOutcome).toBe('landed');
    expect(e.m.y).toBe(FLOOR_Y);
  });

  it('3. nothing to jump to within H_max: a leap onto a visible wall, then it climbs down', () => {
    const e = onW(200, BAIL);
    e.windows = { w: { x: 500, y: 200, width: 480, height: 840 } };
    e.extra = [wall('u', 'left', 1000, 150, FLOOR_Y, { topLedgeId: null })];
    e.step();
    e.windows = {};
    e.gone.add(topId('w'));
    const { steps } = afterCover(e);
    const take = steps.find((s) => s.tookOff);
    expect(take?.bailedOut).toBe(true);
    expect(e.m.bailOutKind).toBe('wall');
    expect(steps.at(-1)?.clung).toBe(true);
    expect(e.m.wall?.key).toBe(sideId('u', 'left'));
    expect(e.m.bailingOut).toBe(false);
    expect(e.until(() => e.m.grounded, 30_000)).toBe(true);
    expect(e.m.y).toBe(FLOOR_Y);
  });

  it('4. nothing at all: the emergency controlled drop (bailOutKind emergency), reported as such', () => {
    const e = onW(200, BAIL);
    e.windows = {};
    e.gone.add(topId('w'));
    const { steps } = afterCover(e);
    const drop = steps.find((s) => s.bailedOut);
    expect(drop?.supportLost).toMatchObject({ reason: 'gone', fell: true });
    expect(drop?.perchLost).toBe(false);
    expect(e.m.bailOutKind).toBe('emergency');
    expect(steps.at(-1)?.landed).toMatchObject({ intentional: true });
    expect(e.m.y).toBe(FLOOR_Y);
  });

  it('a covered tab strip is bailed out of the same way (single hop or jump), never a free fall', () => {
    for (const cover of [
      { x0: 1000, x1: 1300 },
      { x0: 700, x1: 850 },
    ]) {
      const e = env(SINGLE, BAIL, 0.45);
      e.walls = false;
      e.extra = [ledge(stripId('b'), 'tabStrip', 'b', 600, 700, 1300)];
      e.step();
      e.placeOn(stripId('b'), 900, 600);
      e.m.setGoal(null);
      e.patch.set(stripId('b'), cover);
      const { steps } = afterCover(e);
      expect(steps.filter((s) => s.tookOff)).toHaveLength(1);
      expect(steps.find((s) => s.tookOff)?.bailedOut).toBe(true);
      expect(['hop', 'jump']).toContain(e.m.bailOutKind);
      expect(steps.some((s) => s.perchLost)).toBe(false);
    }
  });

  it('the click-guard signal: bailingOut from the bail-out crouch until the landing', () => {
    const e = onW();
    e.windows = {};
    e.gone.add(topId('w'));
    const seen: boolean[] = [];
    e.until((r) => {
      seen.push(e.m.bailingOut);
      return r.landed !== null;
    }, 5000);
    expect(seen[0]).toBe(true);
    expect(seen.at(-2)).toBe(true);
    expect(e.m.bailingOut).toBe(false);
  });

  it('a list that catches up before the take-off cancels the bail-out: the cat stays, nothing is reported', () => {
    const e = onW();
    e.hidden.add(topId('w'));
    const steps: MoverStep[] = [];
    e.until(() => {
      steps.push(e.log.at(-1) as MoverStep);
      return e.m.mode === 'crouch';
    }, MOVEMENT.perchGraceMs);
    expect(e.m.bailingOut).toBe(true);
    e.hidden.clear();
    for (let i = 0; i < 60; i++) steps.push(e.step());
    expect(steps.some((s) => s.bailedOut || s.supportLost !== null || s.tookOff)).toBe(false);
    expect(e.m.support).toMatchObject({ surfaceId: topId('w') });
    expect(e.m.bailingOut).toBe(false);
  });

  it('the clinging cat bails off a vanished side with a jump onto a support in reach', () => {
    const e = env(SINGLE, BAIL, 0.3);
    e.windows = { w: { x: 700, y: 300, width: 600, height: 740 } };
    e.step();
    e.goal({ x: 1000, y: 299, route: 'climb' });
    expect(e.until(() => e.m.climbPhase === 'climb' && e.m.y < 760, 30_000)).toBe(true);
    e.windows = {};
    e.gone.add(sideId('w', 'left'));
    e.gone.add(topId('w'));
    const r = e.step();
    expect(r.bailedOut).toBe(true);
    expect(r.supportLost).toMatchObject({ reason: 'gone', surfaceKind: 'windowSide', fell: false });
    expect(e.m.bailOutKind).toBe('jump');
    expect(e.m.jumpKind).toBe('wallJump');
    expect(e.nextLanding(5000)).toMatchObject({ plannedOutcome: 'landed' });
  });

  it('without the flag the v1.1.1 handling stays: a free fall after the grace (perchLost, no bail-out)', () => {
    const e = onW(600, {});
    e.patch.set(topId('w'), { x0: 1000, x1: 1400 });
    const { steps } = afterCover(e);
    expect(steps.some((s) => s.bailedOut)).toBe(false);
    const lost = steps.find((s) => s.perchLost);
    expect(lost?.supportLost).toMatchObject({ reason: 'occluded', fell: true });
    expect(lost?.t).toBeGreaterThan(MOVEMENT.perchGraceMs);
  });

  it('a hidden (away) cat keeps the v1.1.1 set-down on the floor below, never a bail-out crouch', () => {
    const e = onW();
    e.windows = {};
    e.gone.add(topId('w'));
    e.now += 16;
    expect(e.m.stepAway({ now: e.now, dtMs: 16, dragCursor: null, getSurface: () => null })).toBe(true);
    expect(e.m.grounded).toBe(true);
    expect(e.m.y).toBe(FLOOR_Y);
    expect(e.m.bailingOut).toBe(false);
  });
});

describe('stale plans (ADR 0003 §6.8)', () => {
  /** On the floor, crouching to jump onto window t's top 200 px up. */
  function crouching(cfg: object): ReturnType<typeof env> {
    const e = env(SINGLE, cfg, 0.4);
    e.walls = false;
    e.windows = { t: { x: 900, y: FLOOR_Y - 200, width: 500, height: 200 } };
    e.step();
    e.goal({ x: 1200, y: FLOOR_Y - 201 });
    expect(e.until((r) => r.crouchStarted, 20_000)).toBe(true);
    return e;
  }

  it('a target that vanished during the crouch reports planCancelled (also without flags)', () => {
    const e = crouching({});
    e.windows = {};
    const r = [] as MoverStep[];
    e.until((s) => {
      r.push(s);
      return s.planCancelled || s.tookOff;
    }, 1000);
    expect(r.at(-1)?.planCancelled).toBe(true);
    expect(r.some((s) => s.tookOff)).toBe(false);
  });

  it('with bailOut a target moved more than half a body length (or served covered) cancels the take-off', () => {
    const moved = crouching({ bailOut: true });
    moved.windows = { t: { x: 900 + 0.6 * BW, y: FLOOR_Y - 200 - 0.6 * BW, width: 500, height: 200 } };
    expect(moved.until((s) => s.planCancelled || s.tookOff, 1000)).toBe(true);
    expect(moved.log.at(-1)?.planCancelled).toBe(true);

    const covered = crouching({ bailOut: true });
    covered.patch.set(topId('t'), { confidence: 0.1 });
    expect(covered.until((s) => s.planCancelled || s.tookOff, 1000)).toBe(true);
    expect(covered.log.at(-1)?.planCancelled).toBe(true);

    // v1.1.1 (flag off): the moved window is still jumped onto.
    const old = crouching({});
    old.windows = { t: { x: 900 + 0.6 * BW, y: FLOOR_Y - 200 - 0.6 * BW, width: 500, height: 200 } };
    expect(old.until((s) => s.planCancelled || s.tookOff, 1000)).toBe(true);
    expect(old.log.at(-1)?.tookOff).toBe(true);
  });

  it('two cancels within 10 s: the goal is reported unreachable for 3-5 s (no crouch), then it tries again', () => {
    const e = crouching({ bailOut: true });
    let y = FLOOR_Y - 200;
    const jiggle = (): void => {
      y -= 0.6 * BW;
      e.windows = { t: { x: 900, y, width: 500, height: FLOOR_Y - y } };
    };
    jiggle();
    expect(e.until((s) => s.planCancelled, 1000)).toBe(true);
    // The cat replans (the user's target follows the window) and crouches again; the window moves again.
    e.goal({ x: 1200, y: y - 1 });
    expect(e.until((s) => s.crouchStarted, 5000)).toBe(true);
    jiggle();
    e.goal({ x: 1200, y: y - 1 });
    expect(e.until((s) => s.planCancelled, 1000)).toBe(true);
    const t0 = e.now;
    const during: MoverStep[] = [];
    e.until((s) => {
      during.push(s);
      return e.now - t0 >= MOVEMENT.planCancelBackoffMinMs - 50;
    }, 6000);
    expect(during.every((s) => s.goal === 'unreachable' && !s.crouchStarted)).toBe(true);
    expect(e.until((s) => s.crouchStarted, MOVEMENT.planCancelBackoffMaxMs + 5000)).toBe(true);
    expect(e.now - t0).toBeGreaterThanOrEqual(MOVEMENT.planCancelBackoffMinMs - 50);
    expect(e.now - t0).toBeLessThanOrEqual(MOVEMENT.planCancelBackoffMaxMs + 3000);
  });

  it('without bailOut there is no backoff (v1.1.1): after two cancels it crouches again at once', () => {
    const e = crouching({});
    const win = { t: { x: 900, y: FLOOR_Y - 200, width: 500, height: 200 } };
    for (let i = 0; i < 2; i++) {
      e.windows = {};
      expect(e.until((s) => s.planCancelled, 1000)).toBe(true);
      e.windows = win;
      e.m.setGoal(null);
      e.goal({ x: 1200, y: FLOOR_Y - 201 });
      expect(e.until((s) => s.crouchStarted, 1500)).toBe(true);
    }
    expect(e.log.slice(-60).some((s) => s.goal === 'unreachable')).toBe(false);
  });
});
