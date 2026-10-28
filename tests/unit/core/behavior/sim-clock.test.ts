// The tick cadence the sim asks for must never be clamped by the host's stall guard:
// otherwise sim time (stats, cooldowns, the away threshold) falls behind real time.
import { describe, expect, it } from 'vitest';
import { MAX_DT_MS } from '../../../../src/main/catHost';
import { MAX_SIM_DT_MS, SLOWEST_TICK_MS } from '../../../../src/core/behavior/sim';
import { Harness, settingsWith } from './fixtures';

const MIN = 60_000;
/** Windows' default timer granularity: a setTimeout may fire this much late. */
const TIMER_LATE_MS = 16;

type Setup = (h: Harness) => void;

const modes: Array<[string, Setup]> = [
  ['hidden', (h) => (h.env.hidden = true)],
  ['fullscreen (hide)', (h) => (h.env.fullscreenDisplayIds = ['1'])],
  ['fullscreen (quiet)', (h) => (h.env.fullscreenDisplayIds = ['1'])],
  ['locked', (h) => h.step([{ type: 'system.lock' }])],
  ['paused', (h) => (h.env.paused = true)],
  ['idle asleep', (h) => (h.env.userIdleMs = 60 * MIN)],
];

describe('sim tick cadence vs the host dt clamp', () => {
  it('the slowest requested tick plus timer lateness stays within the dt clamp', () => {
    expect(MAX_SIM_DT_MS).toBe(MAX_DT_MS);
    expect(SLOWEST_TICK_MS + TIMER_LATE_MS).toBeLessThanOrEqual(MAX_DT_MS);
  });

  it.each(modes)('%s: a host following nextTickMs keeps sim time equal to real time', (name, setup) => {
    const h = new Harness({ seed: 7, settings: settingsWith({ behavior: { fullscreenBehavior: name === 'fullscreen (quiet)' ? 'quiet' : 'hide' } }) });
    h.run(2000);
    setup(h);
    h.run(2 * MIN, 100, () => {
      if (name === 'idle asleep') h.env.userIdleMs = (h.env.userIdleMs as number) + 100;
    });
    // Host model: the timer fires late, and the host clamps dt to MAX_DT_MS (its stall guard).
    let real = 0;
    let sim = 0;
    let slowest = 0;
    let out = h.last!;
    while (real < 30 * MIN) {
      const delay = out.nextTickMs;
      slowest = Math.max(slowest, delay);
      const realDelta = delay + TIMER_LATE_MS;
      const dt = Math.min(realDelta, MAX_DT_MS);
      real += realDelta;
      sim += dt;
      if (name === 'idle asleep') h.env.userIdleMs = (h.env.userIdleMs as number) + realDelta;
      out = h.step([], dt);
    }
    expect(slowest).toBeGreaterThan(100);
    expect(slowest).toBeLessThanOrEqual(SLOWEST_TICK_MS);
    expect(sim).toBe(real);
  });
});
