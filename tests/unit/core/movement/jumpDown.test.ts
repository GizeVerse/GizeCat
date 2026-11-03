// v1.2 jump-down limits and impact-scaled landings (ADR 0003 §6.3, §6.4): planned jumps and drops
// prefer the safe height, never exceed the maximum (beyond it the cat climbs down or does not go),
// and the default cat's planned descents land soft or medium wherever another way exists.
import { describe, expect, it } from 'vitest';
import type { LandingInfo, MoverConfig } from '../../../../src/core/movement';
import { descentClearancePx, dropImpact, dropRisk, HARD_DROP_DIP, jumpDownLimits, leaveLimits, MOVEMENT } from '../../../../src/core/movement';
import { DEFAULT_LIMITS, env, FLOOR_Y, SINGLE, topId } from './v12Fixtures';

/** A 500 px wide window whose top is `drop` px (= DIP at 100 %) above the floor, reaching down to it. */
function onTop(drop: number, cfg: Partial<MoverConfig>, walls: boolean): ReturnType<typeof env> {
  const e = env(SINGLE, cfg, 0.45);
  e.walls = walls;
  e.windows = { w: { x: 600, y: FLOOR_Y - drop, width: 500, height: drop } };
  e.step();
  e.placeOn(topId('w'), 850, FLOOR_Y - drop);
  return e;
}

/** Goes for a floor point and returns how it got down: the planned landing, or that it climbed. */
function descend(e: ReturnType<typeof env>): { landing: LandingInfo | null; climbed: boolean; arrived: boolean } {
  e.goal({ x: 250, y: FLOOR_Y });
  let landing: LandingInfo | null = null;
  let climbed = false;
  const arrived = e.until((r) => {
    if (r.climbStarted) climbed = true;
    if (r.landed) landing = r.landed;
    return r.goal === 'arrived' || r.goal === 'unreachable';
  }, 60_000);
  return { landing, climbed, arrived: arrived && e.m.y === FLOOR_Y };
}

describe('jump-down limit helpers', () => {
  it('no limits configured is the v1.1.1 unlimited planner; one limit implies the other; the absolute cap always holds', () => {
    expect(jumpDownLimits({})).toBeNull();
    expect(jumpDownLimits({ jumpDownMaxDip: 600 })).toEqual({ safeDip: 600, maxDip: 600 });
    expect(jumpDownLimits({ jumpDownSafeDip: 400 })).toEqual({ safeDip: 400, maxDip: MOVEMENT.jumpDownAbsoluteMaxDip });
    expect(jumpDownLimits({ jumpDownSafeDip: 2000, jumpDownMaxDip: 5000 })).toEqual({ safeDip: 900, maxDip: 900 });
    expect(jumpDownLimits({ jumpDownSafeDip: Number.NaN, jumpDownMaxDip: -1 })).toBeNull();
    expect(leaveLimits({})).toEqual({ safeDip: 900, maxDip: 900 });
  });

  it('risk is 0 up to the safe height and 1 at the maximum; drops land soft below ~190 DIP, hard above ~492 DIP', () => {
    const l = { safeDip: 477, maxDip: 644 };
    expect(dropRisk(400, l)).toBe(0);
    expect(dropRisk(477, l)).toBe(0);
    expect(dropRisk((477 + 644) / 2, l)).toBeCloseTo(0.5, 6);
    expect(dropRisk(644, l)).toBe(1);
    expect(dropRisk(900, null)).toBe(0);
    expect(HARD_DROP_DIP).toBeCloseTo(492.3, 1);
    expect(dropImpact(190)).toBe('soft');
    expect(dropImpact(200)).toBe('medium');
    expect(dropImpact(477)).toBe('medium');
    expect(dropImpact(495)).toBe('hard');
  });

  it('with limits a descent pushes off nearly flat: its fall stays within the medium class up to the safe height', () => {
    for (const drop of [100, 300, 450, 477]) {
      const c = descentClearancePx(60, drop, 1, true);
      expect(c).toBeLessThanOrEqual(60);
      expect(dropImpact(drop + c)).not.toBe('hard');
    }
    // Without limits (v1.1.1) and for level or upward jumps the clearance is untouched.
    expect(descentClearancePx(60, 450, 1, false)).toBe(60);
    expect(descentClearancePx(60, -100, 1, true)).toBe(60);
  });
});

describe('Mover: jump-down limits (default H_safe 477 / H_max 644 DIP)', () => {
  it.each([150, 300, 450, 477])('a %i DIP descent with a climbable side is jumped or dropped and lands soft or medium', (drop) => {
    const e = onTop(drop, DEFAULT_LIMITS, true);
    const r = descend(e);
    expect(r.arrived).toBe(true);
    expect(r.climbed).toBe(false);
    expect(r.landing).not.toBeNull();
    expect(['soft', 'medium']).toContain(r.landing?.impact);
    expect(r.landing?.intentional).toBe(true);
  });

  it.each([520, 600])('a %i DIP descent (would land hard) with a climbable side is climbed down instead', (drop) => {
    const e = onTop(drop, DEFAULT_LIMITS, true);
    const r = descend(e);
    expect(r.arrived).toBe(true);
    expect(r.climbed).toBe(true);
    // No planned landing on the way, or only the soft step at the side's foot.
    if (r.landing) expect(r.landing.impact).not.toBe('hard');
  });

  it('between H_safe and H_max with no other way it still jumps (risky), landing as planned', () => {
    const e = onTop(600, DEFAULT_LIMITS, false);
    const r = descend(e);
    expect(r.arrived).toBe(true);
    expect(r.landing).toMatchObject({ intentional: true });
    expect((r.landing?.fallHeightDip ?? 0) - 600).toBeLessThan(10);
  });

  it('beyond H_max it never jumps or drops: the floor goal is unreachable and the cat stays up', () => {
    const e = onTop(700, DEFAULT_LIMITS, false);
    const r = descend(e);
    expect(r.landing).toBeNull();
    expect(e.log.at(-1)?.goal).toBe('unreachable');
    expect(e.m.support).toMatchObject({ kind: 'surface', surfaceId: topId('w') });
    for (let i = 0; i < 300; i++) {
      const s = e.step();
      expect(s.tookOff || s.steppedOff).toBe(false);
    }
  });

  it('beyond H_max with a side it climbs down', () => {
    const e = onTop(700, DEFAULT_LIMITS, true);
    const r = descend(e);
    expect(r.arrived).toBe(true);
    expect(r.climbed).toBe(true);
  });

  it('without limits (v1.1.1) the same 700 DIP top is simply jumped or dropped from', () => {
    const e = onTop(700, {}, false);
    const r = descend(e);
    expect(r.arrived).toBe(true);
    expect(r.landing?.impact).toBe('hard');
  });

  it('property: no planned, non-emergency leg ever ends further below its take-off than jumpDownMaxDip', () => {
    let seed = 12345;
    const rand = (): number => {
      seed = (seed * 1103515245 + 12345) % 2147483648;
      return seed / 2147483648;
    };
    const maxDip = 520;
    let legs = 0;
    for (let run = 0; run < 12; run++) {
      const e = env(SINGLE, { jumpDownSafeDip: 400, jumpDownMaxDip: maxDip, wallJumps: true }, 0.2 + 0.6 * rand());
      e.walls = rand() < 0.6;
      const windows: Record<string, { x: number; y: number; width: number; height: number }> = {};
      for (let i = 0; i < 3; i++) {
        const y = 150 + Math.round(rand() * 800);
        const x = Math.round(rand() * 1400);
        windows[`w${i}`] = { x, y, width: 260 + Math.round(rand() * 400), height: Math.min(FLOOR_Y - y, 200 + Math.round(rand() * 700)) };
      }
      e.windows = windows;
      e.step();
      let start: number | null = null;
      for (let g = 0; g < 6; g++) {
        const ids = Object.keys(windows);
        const pick = ids[Math.floor(rand() * ids.length)] as string;
        const w = windows[pick] as { x: number; y: number; width: number };
        const toFloor = rand() < 0.5;
        e.goal(toFloor ? { x: 100 + rand() * 1700, y: FLOOR_Y } : { x: w.x + rand() * w.width, y: w.y - 1 });
        e.until((r) => {
          if (r.tookOff || r.steppedOff) start = e.m.airborne ? e.m.y : null;
          if (r.landed && start !== null) {
            if (r.landed.intentional) {
              legs++;
              expect((e.m.y - start) / e.m.scale, `run ${run} goal ${g}`).toBeLessThanOrEqual(maxDip + 2);
            }
            start = null;
          }
          return r.goal === 'arrived' || r.goal === 'unreachable';
        }, 45_000, 33);
      }
    }
    expect(legs).toBeGreaterThan(5);
  });
});
