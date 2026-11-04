// ADR 0003 §14, the short band subset in `verify fast` (SIMULATED): L1 / P2 / U-active, 3 seeds x 1.5
// sim-h through the profile harness (tests/profile, hook records only), each band binomially /
// Poisson widened for the short run (tests/profile/metrics.ts widenShare, widenRate), wall-time
// budget <= 20 s. Over budget, the subset moves to the profile tier (bands-full.test.ts).
//
// Markers: every spec is `it.skip` until the behaviour package (BEH) lands what it asserts; BEH
// flips `it.skip` -> `it` (only the marker; INT owns the bodies, ADR 0003 §16.2). The full-matrix
// bands (8 seeds x 3 sim-h, every cell) are in bands-full.test.ts.
import { describe, expect, it } from 'vitest';
import { BAND_TEXT, cellChecks, FULL_LIMITS, type BandId, type BandLimits } from '../../profile/bands';
import { runProfile, summarizeCell, type CellSummary } from '../../profile/behaviorProfile';
import { widenRate, widenShare } from '../../profile/metrics';

const SEEDS = [1, 2, 3];
// Most stays end by the user's hand at the REAL handling rate: 2 sim-h hold too few own departures for B3 and B4.
const HOURS = 1.5;
const SIM_HOURS = SEEDS.length * HOURS;
/** Wall-time budget of the whole subset (ADR 0003 §14). */
const BUDGET_MS = 20_000;
/** Effective independent observations for the time shares: rhythm episodes (~2.5 min each) in the awake time. */
const EPISODES = Math.round((SIM_HOURS * 60 * 0.85) / 2.5);

const share = (b: readonly [number, number], n = EPISODES): [number, number] => {
  const w = widenShare(b[0], b[1], n);
  return [Math.round(w.lo * 1000) / 1000, Math.round(w.hi * 1000) / 1000];
};
const rate = (b: readonly [number, number], hours = SIM_HOURS): [number, number] => {
  const w = widenRate(b[0], b[1], hours);
  return [Math.round(w.lo * 100) / 100, Math.round(w.hi * 100) / 100];
};

/** The §14 limits widened for 3 seeds x 1.5 sim-h (the stays: ~30 per cell). */
const SHORT_LIMITS: BandLimits = {
  ...FULL_LIMITS,
  activeShare: share(FULL_LIMITS.activeShare),
  activeShareNothingToClimbMax: share([0, FULL_LIMITS.activeShareNothingToClimbMax])[1],
  arrivalsPerHour: rate(FULL_LIMITS.arrivalsPerHour),
  windowClimbsMaxPerHour: rate([0, FULL_LIMITS.windowClimbsMaxPerHour])[1],
  kmMedianS: [60, 400],
  kmP10MinS: 10,
  kmOver5MinMin: 0,
  plannedMedianS: [90, 260],
  plannedP10MinS: 20,
  plannedOver5MinMin: 0,
  plannedP90MaxS: 900,
  asleepShareOfPresent: share(FULL_LIMITS.asleepShareOfPresent),
  napsPerPresentHour: rate(FULL_LIMITS.napsPerPresentHour, SIM_HOURS * 0.75),
  waryMax: 0.2,
  irritableMax: 0.15,
  slipsPerAwakeHour: rate(FULL_LIMITS.slipsPerAwakeHour, SIM_HOURS * 0.85),
};

const KEY = 'P2/L1/U-active';
let cached: { cell: CellSummary; wallMs: number } | null = null;
/** The subset's runs, once (only a non-skipped spec pays for them). */
function short(): CellSummary {
  if (!cached) {
    const t0 = Date.now();
    const runs = SEEDS.map((seed) => runProfile({ profile: 'P2', layout: 'L1', user: 'U-active', seed, hours: HOURS }));
    cached = { cell: summarizeCell(runs), wallMs: Date.now() - t0 };
  }
  return cached.cell;
}

/** The named band's checks on the short cell, as [check, value, status] for a readable failure. */
function verdicts(id: BandId): Array<[string, unknown, string]> {
  return cellChecks(KEY, short(), SHORT_LIMITS)
    .filter((b) => b.id === id)
    .map((b) => [b.check, b.value, b.status]);
}
const failing = (v: Array<[string, unknown, string]>): Array<[string, unknown, string]> => v.filter(([, , s]) => s === 'fail');

describe(`ADR 0003 §14 short subset: ${KEY}, ${SEEDS.length} seeds x ${HOURS} sim-h (SIMULATED, widened)`, () => {
  it(
    `budget: the subset's sim runs take <= ${BUDGET_MS / 1000} s of wall time`,
    () => {
      short();
      expect(cached!.wallMs).toBeLessThanOrEqual(BUDGET_MS);
    },
    60_000,
  );

  it(`B1: ${BAND_TEXT.B1} (widened to ${SHORT_LIMITS.activeShare.join('-')})`, () => {
    const v = verdicts('B1');
    expect(v).toHaveLength(1);
    expect(failing(v)).toEqual([]);
  });

  it(`B2: ${BAND_TEXT.B2} (arrivals widened to ${SHORT_LIMITS.arrivalsPerHour.join('-')} /h, climbs <= ${SHORT_LIMITS.windowClimbsMaxPerHour} /h)`, () => {
    const v = [...verdicts('B2'), ...verdicts('C-climbs')];
    expect(v).toHaveLength(2);
    expect(failing(v)).toEqual([]);
  });

  it(`B3: ${BAND_TEXT.B3} (KM median ${SHORT_LIMITS.kmMedianS.join('-')} s, p10 >= ${SHORT_LIMITS.kmP10MinS} s, plannedMs median ${SHORT_LIMITS.plannedMedianS.join('-')} s, p10 >= ${SHORT_LIMITS.plannedP10MinS} s; tails in the full tier)`, () => {
    const c = short();
    expect(c.stays.km.events).toBeGreaterThanOrEqual(8);
    expect(c.stays.planned.n).toBeGreaterThanOrEqual(8);
    expect(failing(verdicts('B3'))).toEqual([]);
  });

  it(`B4: ${BAND_TEXT.B4} (one window here: >= 2 kinds)`, () => {
    expect(short().stays.leave.departures).toBeGreaterThanOrEqual(8);
    expect(failing(verdicts('B4'))).toEqual([]);
  });

  it(`B8b: ${BAND_TEXT.B8b} (widened: w ${SHORT_LIMITS.waryMax * 100} %, i ${SHORT_LIMITS.irritableMax * 100} %)`, () => {
    expect(failing(verdicts('B8b'))).toEqual([]);
  });

  it(`B9: ${BAND_TEXT.B9}`, () => {
    const c = short();
    expect(c.falls.physicsErrors).toBe(0);
    expect(c.falls.byCause.physics ?? 0).toBe(0);
    expect(c.falls.byCause.covered ?? 0).toBe(0);
  });

  it(`B10: ${BAND_TEXT.B10} (widened to ${SHORT_LIMITS.slipsPerAwakeHour.join('-')} per awake hour: at ~2 sim-h the Poisson floor is 0, so the floor itself is asserted in bands-full)`, () => {
    expect(failing(verdicts('B10'))).toEqual([]);
  });

  it(`B14: ${BAND_TEXT.B14}`, () => {
    const c = short();
    expect(c.stuckResets).toBe(0);
    expect(c.watchdogDecisions).toBe(0);
  });

  it(`B15: ${BAND_TEXT.B15} (widened: asleep ${SHORT_LIMITS.asleepShareOfPresent.join('-')}, naps ${SHORT_LIMITS.napsPerPresentHour.join('-')} /h; the nap floor is asserted in bands-full)`, () => {
    const v = verdicts('B15');
    expect(v).toHaveLength(2);
    expect(failing(v)).toEqual([]);
  });

  it(`C-typing: ${BAND_TEXT['C-typing']}`, () => {
    const c = short();
    expect(c.hunts.startedWhileTyping).toBe(0);
    expect(c.hunts.pouncesWhileTyping).toBe(0);
    expect(c.strikes.playNearCursorWhileTyping).toBe(0);
  });
});
