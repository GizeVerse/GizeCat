// Regression tests for the v1.2 review findings on the behaviour side (SIMULATED: the real Sim and
// Mover through the Harness on the user's screen, synthetic input, OS mocked).
import { describe, expect, it } from 'vitest';
import { applyImpulse } from '../../../../src/core/behavior/drives';
import { STAY_LONELY_MIN_GAP_MS } from '../../../../src/core/behavior/stay';
import type { Drives } from '../../../../src/shared/catState';
import { defaultSettings, type Settings } from '../../../../src/shared/settings';
import type { CatSim } from '../../../../src/shared/sim';
import { MIN, runCell } from './bands';
import { settingsWith } from './fixtures';

const median = (xs: number[]): number => {
  const s = [...xs].sort((a, b) => a - b);
  return s.length ? (s[Math.floor(s.length / 2)] as number) : -1;
};
const behavior = (b: Partial<Settings['behavior']>): Settings => settingsWith({ behavior: { ...defaultSettings().behavior, ...b } });
/** Holds a drive where a scenario wants it (white box: the drives are the sim's own). */
const drivesOf = (sim: CatSim): Drives => (sim as unknown as { cat: { drives: Drives } }).cat.drives;

describe('review BEH-1: the lonely leave is one-shot, not a cap on every stay (ADR 0003 §2.4)', () => {
  it('a need nobody relieves leaves stays their planned length: at most one cut per 20 min', () => {
    for (const seed of [11, 12]) {
      const r = runCell({ seed, hours: 2, layout: 'L1', user: 'active', drives: { socialNeed: 1 } });
      const ends = r.excursions.filter((e) => e.phase === 'end');
      const cut = ends.filter((e) => e.endReason === 'stimulus');
      expect(ends.length, `seed ${seed}: stays ended`).toBeGreaterThanOrEqual(4);
      expect(cut.length, `seed ${seed}: stays cut short`).toBeLessThanOrEqual(1 + r.simMs / STAY_LONELY_MIN_GAP_MS);
      // Saturated, the old rule cut every one of them at about 60 s (median 63-71 s against a planned 163-381 s).
      expect(median(ends.map((e) => e.dwellMs)), `seed ${seed}: median stay`).toBeGreaterThanOrEqual(90_000);
    }
  });

  it('fires once until the need has fallen below 0.7, then again', () => {
    const cuts = (rearm: boolean): number[] => {
      let first = -1;
      const r = runCell({ seed: 5, hours: 1.6, layout: 'L1', user: 'active', drives: { socialNeed: 1 } }, (h) => {
        if (first < 0) first = h.sim.behaviorProfile().recentStays.find((s) => s.endReason === 'stimulus')?.at ?? -1;
        // Held at 1, but for a moment (a pet) 25 min after the first cut when `rearm`.
        drivesOf(h.sim).socialNeed = rearm && first >= 0 && h.now > first + 25 * MIN && h.now < first + 25 * MIN + 5000 ? 0.6 : 1;
      });
      expect(r.excursions.filter((e) => e.phase === 'arrive').length).toBeGreaterThanOrEqual(4);
      return r.excursions.filter((e) => e.phase === 'end' && e.endReason === 'stimulus').map((e) => e.at);
    };
    expect(cuts(false)).toHaveLength(1);
    const again = cuts(true);
    expect(again.length).toBeGreaterThanOrEqual(2);
    expect((again[1] as number) - (again[0] as number)).toBeGreaterThanOrEqual(STAY_LONELY_MIN_GAP_MS);
  });

  it('the cut-short stay ends in asking for attention, and an unanswered request relieves the need', () => {
    const r = runCell({ seed: 11, hours: 1, layout: 'L1', user: 'active', drives: { socialNeed: 1 } });
    const cut = r.excursions.find((e) => e.phase === 'end' && e.endReason === 'stimulus');
    expect(cut, 'one stay cut short').toBeDefined();
    const at = (cut as { at: number }).at;
    expect(r.harness.transitions.filter((t) => t.at >= at && t.at <= at + 30_000).map((t) => t.to)).toContain('seekingAttention');
    const d = { socialNeed: 1, mischief: 0.3 } as Drives;
    applyImpulse(d, 'attentionIgnored');
    expect(d.socialNeed).toBeCloseTo(0.8, 6);
    expect(d.mischief).toBeCloseTo(0.45, 6);
  });

  it("'Attention seeking' at 0 is an exit: no stay is cut short for company", () => {
    const r = runCell({ seed: 11, hours: 1.5, layout: 'L1', user: 'active', drives: { socialNeed: 1 }, settings: behavior({ attentionSeeking: 0 }) });
    const ends = r.excursions.filter((e) => e.phase === 'end');
    expect(ends.length).toBeGreaterThanOrEqual(3);
    expect(ends.filter((e) => e.endReason === 'stimulus')).toEqual([]);
  });
});
