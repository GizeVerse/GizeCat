// v1.1.1 liveness: the installed cat never left the floor (docs/research/v1.1.1-floor-only-diagnosis.md).
// With the user's own cat, screen and a typical floating window, driven through the real Sim
// and Mover (provider-shaped surfaces, the app's floor inset, ticks at the rate the sim asks
// for), a valid default configuration must get the cat up regularly without making it
// hyperactive. Seeded and deterministic; the cat is never placed, called, petted or dragged.
import { describe, expect, it } from 'vitest';
import { settingsWith } from './fixtures';
import type { Excursion, LivenessResult, Scenario } from './liveness';
import { MIN, runLiveness, TYPICAL_FRAME, TYPICAL_STRIP } from './liveness';

const seeds = (n: number): number[] => Array.from({ length: n }, (_, i) => i + 1);
const all = (rs: LivenessResult[]): Excursion[] => rs.flatMap((r) => r.excursions);
const pct = (n: number, d: number): string => `${Math.round((100 * n) / Math.max(1, d))} %`;

describe('liveness: the default cat gets off the floor (v1.1.1)', () => {
  it('>= 90 % of 20 seeds reach a window top on their own within 10 sim-minutes', () => {
    const rs = seeds(20).map((seed) => runLiveness({ seed }, 10 * MIN));
    const reached = rs.filter((r) => r.firstAt !== null);
    const firsts = reached.map((r) => Math.round((r.firstAt as number) / 1000)).sort((a, b) => a - b);
    console.log(`liveness: ${reached.length}/20 up within 10 min; first arrival after ${firsts[0]}-${firsts[firsts.length - 1]} s (median ${firsts[Math.floor(firsts.length / 2)]} s)`);
    expect(reached.length).toBeGreaterThanOrEqual(18);
    // Observable during normal use: the urge gets it up within ~5 min of activity, before rising
    // boredom alone would (without the urge the median first arrival here was ~325 s, the latest ~9 min).
    expect(reached.filter((r) => (r.firstAt as number) <= 5 * MIN).length).toBeGreaterThanOrEqual(18);
    // The diagnostics count the same arrivals.
    for (const r of rs) expect(r.diagExcursions).toBe(r.excursions.length);
    // The way up takes longer than the old fixed 15 s approach (walk + leap + ~700 px climb), and still arrives.
    expect(all(rs).some((e) => e.via === 'inspectingWindow/explore' && e.approachMs > 15_000)).toBe(true);
  });

  it('3-15 trips up per sim-hour on average, each a real visit: >= 10 s up there and a walk along the top', () => {
    const rs = seeds(6).map((seed) => runLiveness({ seed }, 60 * MIN));
    const ex = all(rs);
    const perHour = ex.length / rs.length;
    const share = rs.reduce((a, r) => a + r.surfaceShare, 0) / rs.length;
    const long = ex.filter((e) => e.stayMs >= 10_000).length;
    const walked = ex.filter((e) => e.walkedBl >= 2).length;
    console.log(`liveness: ${perHour.toFixed(1)} trips/h (${rs.map((r) => r.excursions.length).join(', ')}), up ${(100 * share).toFixed(0)} % of the time; stayed >= 10 s ${pct(long, ex.length)}, walked >= 2 BL ${pct(walked, ex.length)}`);
    expect(perHour).toBeGreaterThanOrEqual(3);
    expect(perHour).toBeLessThanOrEqual(15);
    for (const r of rs) expect(r.excursions.length).toBeGreaterThanOrEqual(1);
    // Most trips are visits, not touch-and-go.
    expect(long / ex.length).toBeGreaterThanOrEqual(0.8);
    expect(walked / ex.length).toBeGreaterThanOrEqual(0.7);
    // Not living up there either. ADR 0003 B2 x B3 (arrivals 4-15 /h, stays of 90-300 s): the v1.1.1 ceiling of 50 % is gone.
    expect(share).toBeLessThan(0.8);
  });

  it('with a browser whose tab strip is listed (provider-shaped, with its open edge), >= 70 % of seeds reach the strip within 20 sim-minutes', () => {
    const browser: Scenario = { seed: 0, windows: { b: TYPICAL_FRAME }, tabStrips: { b: TYPICAL_STRIP }, category: 'browser' };
    const rs = seeds(10).map((seed) => runLiveness({ ...browser, seed }, 20 * MIN));
    const onStrip = rs.filter((r) => r.excursions.some((e) => e.kind === 'tabStrip')).length;
    console.log(`liveness: ${onStrip}/10 reached the tab strip within 20 min`);
    expect(onStrip).toBeGreaterThanOrEqual(7);
  });

  it('heavy typing makes trips rarer but never stops them (>= 1 per sim-hour on average)', () => {
    const typing = seeds(6).map((seed) => runLiveness({ seed, typing: { typing: true, intensity: 0.9 } }, 60 * MIN));
    const perHour = all(typing).length / typing.length;
    console.log(`liveness: heavy typing ${perHour.toFixed(1)} trips/h`);
    expect(perHour).toBeGreaterThanOrEqual(1);
  });
});

describe('liveness: nothing to climb, or climbing switched off', () => {
  it('with nothing reachable (a maximized window in front, or nothing listed) there are no trips and the urge stays 0', () => {
    const maximized = { max: { x: 0, y: 0, width: 1920, height: 1200 }, w: TYPICAL_FRAME };
    for (const seed of [1, 2, 3]) {
      for (const windows of [maximized, {}]) {
        const r = runLiveness({ seed, windows }, 30 * MIN);
        expect(r.excursions).toEqual([]);
        expect(r.upTicks).toBe(0);
        expect(r.maxUrge).toBe(0);
      }
    }
  });

  it('with "Climb windows" or "Sit on windows" off it never climbs', () => {
    for (const disabled of [['climbWindows'], ['perchOnWindows']] as const) {
      for (const seed of [1, 2, 3]) {
        const r = runLiveness({ seed, settings: settingsWith({ behavior: { disabledBehaviors: [...disabled] } }) }, 30 * MIN);
        expect(r.wallTicks, `${disabled[0]} seed ${seed}`).toBe(0);
        // Without climbing the typical window's top (~1075 px up) is out of reach: it stays down.
        expect(r.upTicks).toBe(0);
      }
    }
  });
});
