// Laser Mode, the pure rules (src/core/behavior/laser.ts) and the reduced-motion policy
// (src/core/behavior/reducedMotion.ts). These tests were written without being run; they pin the
// behaviour the code is meant to have.
import { describe, expect, it } from 'vitest';
import { HIT_CLEARANCE_DIP, HIT_FRONT_EXTENT_DIP } from '../../../../src/shared/cat';
import { LASER_STANDOFF_BODY_LENGTHS } from '../../../../src/shared/companion';
import type { LaserSituation } from '../../../../src/core/behavior/laser';
import { LASER_HOP_MARGIN_BW, laserBreakMs, laserChaseBudgetMs, laserDecision, laserStandoffPx } from '../../../../src/core/behavior/laser';
import { mulberry32 } from '../../../../src/core/behavior';
import { calmDwell, calmPace, motionPolicy, REDUCED_MOTION_OPT_OUTS, withMotionOptOuts } from '../../../../src/core/behavior/reducedMotion';
import type { BehaviorId } from '../../../../src/shared/settings';

const BW = 84;
const BH = 64;

function sit(over: Partial<LaserSituation> = {}): LaserSituation {
  return {
    catX: 600,
    dotX: 1400,
    dyBh: 0.2,
    bodyWidth: BW,
    bodyHeight: BH,
    scale: 1,
    size: 1,
    walkMin: 0,
    walkMax: 1920,
    dotSpeedDip: 0,
    dotIdleMs: 0,
    energy: 0.8,
    staminaLeft: 1,
    restBias: 0.5,
    playAppetite: 0.6,
    engaged: false,
    reduced: false,
    reachAllowed: true,
    hopAllowed: true,
    hopReady: true,
    ...over,
  };
}

describe('laserStandoffPx', () => {
  it('is at least LASER_STANDOFF_BODY_LENGTHS body widths and clears the paw reach plus the clearance at every size and scale', () => {
    for (const size of [0.5, 1, 1.5, 2.5]) {
      for (const scale of [1, 1.25, 2]) {
        const bw = BW * size * scale;
        const standoff = laserStandoffPx(bw, scale, size);
        expect(standoff).toBeGreaterThanOrEqual(LASER_STANDOFF_BODY_LENGTHS * bw - 1e-9);
        // The hit region (the paw-at reach) plus the 8 DIP clearance and the 3 px hysteresis stays short of the hotspot.
        expect(standoff).toBeGreaterThan(HIT_FRONT_EXTENT_DIP.pawAt * size * scale + HIT_CLEARANCE_DIP * scale + 3);
      }
    }
  });

  it('is total on odd input', () => {
    expect(Number.isFinite(laserStandoffPx(Number.NaN, 1, 1))).toBe(true);
    expect(laserStandoffPx(0, 1, 1)).toBeGreaterThan(0);
    expect(Number.isFinite(laserStandoffPx(84, Number.NaN, Number.NaN))).toBe(true);
  });
});

describe('laserDecision', () => {
  const standoff = laserStandoffPx(BW, 1, 1);

  it('goes toward a far dot and stops short of it, on its own side', () => {
    const d = laserDecision(sit());
    expect(d.mode === 'run' || d.mode === 'walk').toBe(true);
    expect(d.goalX).not.toBeNull();
    expect(d.goalX as number).toBeLessThan(1400 - standoff + 1e-6);
    expect(d.goalX as number).toBeGreaterThan(600);
    const left = laserDecision(sit({ catX: 1400, dotX: 600 }));
    expect(left.goalX as number).toBeGreaterThan(600 + standoff - 1e-6);
    expect(left.goalX as number).toBeLessThan(1400);
  });

  it('never picks a goal closer to the dot than the stand-off, however the situation looks', () => {
    const rnd = mulberry32(7);
    for (let i = 0; i < 4000; i++) {
      const s = sit({
        catX: rnd() * 1920,
        dotX: rnd() * 1920,
        dyBh: rnd() * 8 - 2,
        walkMin: rnd() < 0.5 ? 0 : rnd() * 900,
        walkMax: rnd() < 0.5 ? 1920 : 900 + rnd() * 1000,
        energy: rnd(),
        staminaLeft: rnd(),
        restBias: rnd(),
        playAppetite: rnd(),
        engaged: rnd() < 0.5,
        reduced: rnd() < 0.3,
        dotSpeedDip: rnd() * 800,
        size: 0.5 + rnd() * 2,
        scale: rnd() < 0.5 ? 1 : 1.5,
      });
      const bw = BW * s.size * s.scale;
      const d = laserDecision({ ...s, bodyWidth: bw });
      const so = laserStandoffPx(bw, s.scale, s.size);
      if (d.goalX !== null) expect(Math.abs(d.goalX - s.dotX)).toBeGreaterThanOrEqual(so - 1e-6);
      // Never moves toward a dot it is already inside the stand-off of.
      if (Math.abs(s.dotX - s.catX) < so - 0.05 * bw) {
        expect(d.mode).toBe('hold');
        expect(d.goalX).toBeNull();
        expect(d.reach).toBe(false);
        expect(d.hop).toBe(false);
      }
    }
  });

  it('holds still, reaching for nothing, with the dot inside the stand-off (a click on the cat is never dodged)', () => {
    const d = laserDecision(sit({ catX: 1000, dotX: 1000 + standoff * 0.5 }));
    expect(d).toMatchObject({ mode: 'hold', goalX: null, reach: false, hop: false, inside: true });
  });

  it('drops the goal when the surface ends short of the stand-off', () => {
    const d = laserDecision(sit({ catX: 600, dotX: 1400, walkMax: 1400 - standoff / 2 }));
    expect(d.goalX === null || Math.abs((d.goalX) - 1400) >= standoff).toBe(true);
    const d2 = laserDecision(sit({ catX: 600, dotX: 100, walkMin: 80 }));
    expect(d2.goalX === null || Math.abs((d2.goalX) - 100) >= standoff).toBe(true);
  });

  it('runs when far and keen, walks when near, tired or calm-minded about it, never runs under reduced motion', () => {
    expect(laserDecision(sit()).mode).toBe('run');
    expect(laserDecision(sit({ energy: 0.1 })).mode).toBe('walk');
    expect(laserDecision(sit({ staminaLeft: 0.1 })).mode).toBe('walk');
    expect(laserDecision(sit({ dotX: 600 + standoff + 2.5 * BW })).mode).toBe('walk');
    expect(laserDecision(sit({ reduced: true })).mode).toBe('walk');
  });

  it('a calm, restful cat lets the light come closer before it follows than a keen one', () => {
    const dotX = 600 + standoff + 0.15 * BW + 1.2 * BW;
    expect(laserDecision(sit({ dotX, restBias: 0.1 })).mode).not.toBe('hold');
    expect(laserDecision(sit({ dotX, restBias: 0.95 })).mode).toBe('hold');
  });

  it('reaches only for a resting dot in reach, and only when strikes are allowed', () => {
    const near = sit({ dotX: 600 + standoff + 0.3 * BW });
    expect(laserDecision(near).reach).toBe(true);
    expect(laserDecision({ ...near, reachAllowed: false }).reach).toBe(false);
    expect(laserDecision({ ...near, dotSpeedDip: 900 }).reach).toBe(false);
    expect(laserDecision({ ...near, dyBh: 3 }).reach).toBe(false);
  });

  it('hops only at a dot overhead, when jumps are allowed, and keeps room so the hop itself holds the stand-off', () => {
    const overhead = sit({ dyBh: 2.4, dotX: 600 + standoff + LASER_HOP_MARGIN_BW * BW + 4 });
    expect(laserDecision(overhead).hop).toBe(true);
    expect(laserDecision({ ...overhead, hopAllowed: false }).hop).toBe(false);
    expect(laserDecision({ ...overhead, hopReady: false }).hop).toBe(false);
    expect(laserDecision({ ...overhead, dyBh: 0.2 }).hop).toBe(false);
    // A cat that may hop stops farther out; a hop (0.35 body widths toward the dot) lands no closer than the stand-off.
    const goal = laserDecision(sit({ dyBh: 2.4, dotX: 1400 })).goalX as number;
    expect(1400 - goal - 0.35 * BW).toBeGreaterThanOrEqual(standoff - 1e-6);
  });

  it('is total on non-finite input', () => {
    const d = laserDecision(sit({ catX: Number.NaN, dotX: Number.NaN, dyBh: Number.NaN, energy: Number.NaN, restBias: Number.NaN }));
    expect(d.mode).toBe('hold');
    expect(d.goalX).toBeNull();
  });
});

describe('laser stamina', () => {
  it('a keen, rested cat chases longer than a calm or tired one, and always for a bounded time', () => {
    expect(laserChaseBudgetMs(1.6, 0.9)).toBeGreaterThan(laserChaseBudgetMs(1, 0.9));
    expect(laserChaseBudgetMs(0.55, 0.9)).toBeLessThan(laserChaseBudgetMs(1, 0.9));
    expect(laserChaseBudgetMs(1, 0.1)).toBeLessThan(laserChaseBudgetMs(1, 0.9));
    for (const k of [0, 1, 5, Number.NaN]) expect(laserChaseBudgetMs(k, 0.5)).toBeLessThan(180_000);
    expect(laserChaseBudgetMs(Number.NaN, Number.NaN)).toBeGreaterThan(0);
  });

  it('breaks are a few seconds and longer for a cat that likes its rest', () => {
    expect(laserBreakMs(0.9, 0.5)).toBeGreaterThan(laserBreakMs(0.1, 0.5));
    expect(laserBreakMs(0.5, 0)).toBeGreaterThanOrEqual(5000);
    expect(laserBreakMs(1, 1)).toBeLessThan(40_000);
  });
});

describe('the reduced-motion policy', () => {
  it('is the normal policy unless exactly true', () => {
    for (const v of [false, null, undefined]) expect(motionPolicy(v)).toMatchObject({ reduced: false, runByChoice: true, bigJumps: true, reactionScale: 1, cadenceScale: 1 });
    expect(motionPolicy(true)).toMatchObject({ reduced: true, runByChoice: false, bigJumps: false, reactionScale: 0 });
    expect(motionPolicy(true).cadenceScale).toBeGreaterThan(1);
  });

  it('turns running and sprinting into a walk, and leaves the slow gaits alone', () => {
    const r = motionPolicy(true);
    for (const p of ['run', 'chase', 'sprint'] as const) expect(calmPace(p, r)).toBe('walk');
    for (const p of ['stalk', 'slow', 'walk'] as const) expect(calmPace(p, r)).toBe(p);
    for (const p of ['run', 'chase', 'sprint', 'stalk', 'slow', 'walk'] as const) expect(calmPace(p, motionPolicy(false))).toBe(p);
  });

  it('adds the big-jump and running opt-outs on top of the user\'s own, and returns the very same set when off', () => {
    const base = new Set<BehaviorId>(['grooming']);
    expect(withMotionOptOuts(base, motionPolicy(false))).toBe(base);
    const on = withMotionOptOuts(base, motionPolicy(true));
    expect(on.has('grooming')).toBe(true);
    for (const id of REDUCED_MOTION_OPT_OUTS) expect(on.has(id)).toBe(true);
    // Pouncing and hopping between surfaces are the big voluntary jumps; the small hop is not an opt-out id at all.
    expect(on.has('pounce')).toBe(true);
    expect(on.has('surfaceHops')).toBe(true);
    expect(base.has('pounce')).toBe(false);
  });

  it('stretches dwells only when reduced, and passes odd numbers through', () => {
    expect(calmDwell(1000, motionPolicy(false))).toBe(1000);
    expect(calmDwell(1000, motionPolicy(true))).toBeGreaterThan(1000);
    expect(calmDwell(0, motionPolicy(true))).toBe(0);
    expect(Number.isNaN(calmDwell(Number.NaN, motionPolicy(true)))).toBe(true);
  });
});
