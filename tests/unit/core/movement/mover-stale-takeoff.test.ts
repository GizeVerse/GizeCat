// A plan's take-off point cut off while the cat walks to it (ADR 0003 §6.8, B14): a window comes to cover the far
// part of the top or strip. The Mover says so instead of reporting 'moving' at the end of what is left, which the
// sim's progress monitor would have to reset as a stuck cat. SIMULATED: the real Mover.
import { describe, expect, it } from 'vitest';
import { BW, DEFAULT_LIMITS, env, FLOOR_Y, SINGLE, topId } from './v12Fixtures';

const BAIL = { bailOut: true, ...DEFAULT_LIMITS } as const;

function onLowTop(walls = false): ReturnType<typeof env> {
  const y = FLOOR_Y - 3 * BW;
  const e = env(SINGLE, BAIL, 0.45);
  e.walls = walls;
  e.windows = { w: { x: 600, y, width: 800, height: FLOOR_Y - y } };
  e.step();
  e.placeOn(topId('w'), 900, y);
  e.m.setGoal(null);
  for (let i = 0; i < 5; i++) e.step();
  return e;
}

describe('a take-off point cut off on the way to it', () => {
  it('the goal turns unreachable within moments, not moving for ever', () => {
    const e = onLowTop();
    // A way down from the far end of the top: its take-off lies past the part about to be covered.
    const option = e.m.leaveOptions().filter((o) => o.startX > 1200).sort((a, b) => b.startX - a.startX)[0];
    expect(option, JSON.stringify(e.m.leaveOptions().map((o) => [o.kind, o.startX]))).toBeDefined();
    expect(e.m.leaveBy(option!, 'walk')).toBe(true);
    e.step();
    e.patch.set(topId('w'), { x0: 600, x1: 1000 });
    let goal = 'moving';
    e.until((r) => {
      goal = r.goal ?? goal;
      return goal !== 'moving';
    }, 9000);
    expect(goal).toBe('unreachable');
    expect(e.m.x).toBeLessThanOrEqual(1000 + 1);
    expect(e.m.grounded).toBe(true);
  });

  it('the same for a climb down whose corner the top no longer reaches', () => {
    const e = onLowTop(true);
    const option = e.m.leaveOptions().find((o) => o.kind === 'climbDown' && o.startX > 1200);
    expect(option, JSON.stringify(e.m.leaveOptions().map((o) => [o.kind, o.startX]))).toBeDefined();
    expect(e.m.leaveBy(option!, 'walk')).toBe(true);
    e.step();
    e.patch.set(topId('w'), { x0: 600, x1: 1000 });
    let goal = 'moving';
    e.until((r) => {
      goal = r.goal ?? goal;
      return goal !== 'moving';
    }, 9000);
    expect(goal).toBe('unreachable');
    expect(e.m.x).toBeLessThanOrEqual(1000 + 1);
  });
});
