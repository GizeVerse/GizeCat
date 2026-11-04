// ADR 0003 §14, every target band on the full profile matrix (SIMULATED, profile tier): 8 seeds x 3
// sim-h per cell of MATRICES.bands (tests/profile/behaviorProfile.ts), plus the B7 Monte Carlo
// (100 throws x 8 seeds per profile, and 1000 throws for P2) and the B8 recovery runs.
//
// Opt-in, never in `verify fast` (it is collected there and skipped): DESKTOP_CAT_PROFILE_BANDS=1.
// With DESKTOP_CAT_PROFILE_REPORT=<out/profile/x.json> it asserts a report written by
//   node scripts/with-lock.mjs profile -- node scripts/behavior-profile.mjs --matrix bands --scenarios --label v12
// (run it detached for the whole matrix: --detach); otherwise it runs the matrix itself (minutes).
// A failing band goes to its owner with the report (ADR 0003 §16.2 INT acceptance).
//
// B12 is the REAL bench (scripts/bench.mjs, §15.4), never a vitest band.
import fs from 'node:fs';
import { describe, expect, it } from 'vitest';
import { BAND_TEXT, evaluateBands, recoveryChecks, throwMonteCarloChecks, type BandId, type BandResult } from '../../profile/bands';
import { MATRICES, runProfiles, runRecovery, runThrowMonteCarlo, type ProfileReport } from '../../profile/behaviorProfile';

const enabled = process.env.DESKTOP_CAT_PROFILE_BANDS === '1';
const SEEDS = [1, 2, 3, 4, 5, 6, 7, 8];
const HOURS = 3;

let results: BandResult[] | null = null;
function all(): BandResult[] {
  if (results) return results;
  const file = process.env.DESKTOP_CAT_PROFILE_REPORT;
  if (file) {
    const report = JSON.parse(fs.readFileSync(file, 'utf8')) as ProfileReport & { bands?: { results?: BandResult[] } };
    const scenario = (report.bands?.results ?? []).filter((r) => r.id === 'B7' || r.id === 'B8');
    results = evaluateBands(report.cells, scenario);
    return results;
  }
  const report = runProfiles({ label: 'bands-full', hours: HOURS, seeds: SEEDS, cells: [...MATRICES.bands] });
  const extra: BandResult[] = [];
  for (const p of ['P1', 'P2'] as const) {
    for (const seed of SEEDS) {
      extra.push(...throwMonteCarloChecks(`B7 ${p} seed ${seed}`, runThrowMonteCarlo(p, seed, 100)));
      extra.push(...recoveryChecks(`B8 ${p} seed ${seed}`, runRecovery(p, seed, false), 10));
      extra.push(...recoveryChecks(`B8 ${p} seed ${seed} with petting`, runRecovery(p, seed, true), 8));
    }
  }
  // §15.2: a 1000-throw Monte Carlo (one long run of P2).
  extra.push(...throwMonteCarloChecks('B7 P2 1000 throws', runThrowMonteCarlo('P2', 101, 1000), 1000));
  results = evaluateBands(report.cells, extra);
  return results;
}

/** Every result of band `id` must pass, and there must be at least `min` of them. */
function expectBand(id: BandId, min = 1): void {
  const rs = all().filter((r) => r.id === id && r.status !== 'n/a');
  expect(rs.length, `${id}: checks found`).toBeGreaterThanOrEqual(min);
  expect(rs.filter((r) => r.status === 'fail').map((r) => `${r.cell}: ${r.check} = ${String(r.value)}`)).toEqual([]);
}

const T = 6 * 3600_000;

describe.skipIf(!enabled)('ADR 0003 §14 target bands, full matrix (DESKTOP_CAT_PROFILE_BANDS=1; SIMULATED)', () => {
  it(`B1: ${BAND_TEXT.B1} (P1, P2 x L1-L3 x U-active)`, () => expectBand('B1', 6), T);
  it(`B1b: ${BAND_TEXT.B1b} (L4b vs L1, P1 and P2)`, () => expectBand('B1b', 4), T);
  it(`B2: ${BAND_TEXT.B2} (L1, L2)`, () => expectBand('B2', 4), T);
  it(`B3: ${BAND_TEXT.B3} (L1, L2)`, () => expectBand('B3', 4 * 8), T);
  it(`B4: ${BAND_TEXT.B4} (L5; at least two kinds on L1, L2)`, () => expectBand('B4', 8), T);
  it(`B1c: ${BAND_TEXT.B1c} (L4, L4b, P1 and P2)`, () => expectBand('B1c', 4), T);
  it(`B5d: ${BAND_TEXT.B5d} (P1, P2 x L1, L2, L3, L4b, U-active)`, () => expectBand('B5d', 4), T);
  it(`B5: ${BAND_TEXT.B5} (U-play)`, () => expectBand('B5', 6), T);
  it(`B5b: ${BAND_TEXT.B5b} (U-mouse-work)`, () => expectBand('B5b', 6), T);
  it(`B5c: ${BAND_TEXT.B5c} (all hunting cells)`, () => expectBand('B5c', 2), T);
  it(`B6: ${BAND_TEXT.B6} (U-typing, reactToTyping on and off)`, () => expectBand('B6', 16 + 4), T);
  it(`B7: ${BAND_TEXT.B7} (P1, P2: 100 x 8; P2: 1000)`, () => expectBand('B7', 5 * 17), T);
  it(`B8: ${BAND_TEXT.B8} (P1, P2, bond 0.3, 8 seeds each, with and without petting)`, () => expectBand('B8', 5 * 32), T);
  it(`B8b: ${BAND_TEXT.B8b} (U-active cells)`, () => expectBand('B8b', 2 * 10), T);
  it(`B9: ${BAND_TEXT.B9} (every cell, incl. L3c covered-strip and L1d window-drag churn)`, () => expectBand('B9', MATRICES.bands.length), T);
  it(`B10: ${BAND_TEXT.B10} (L1, L2)`, () => expectBand('B10', 4), T);
  it(`B11: ${BAND_TEXT.B11} (L4 on, off, no bands)`, () => expectBand('B11', 4), T);
  it.todo(`B12: ${BAND_TEXT.B12} — REAL, scripts/bench.mjs on the out/ build with the lively phase (ADR 0003 §15.4), not a vitest band`);
  it(`B13: ${BAND_TEXT.B13} (L3c)`, () => expectBand('B13', 2), T);
  it(`B14: ${BAND_TEXT.B14} (every cell incl. churn)`, () => expectBand('B14', MATRICES.bands.length), T);
  it(`B15: ${BAND_TEXT.B15} (P1, P2 x L1-L3 x U-active)`, () => expectBand('B15', 12), T);
  it(`C-typing: ${BAND_TEXT['C-typing']} (every cell)`, () => expectBand('C-typing', MATRICES.bands.length), T);
  it(`C-climbs: ${BAND_TEXT['C-climbs']} (every cell)`, () => expectBand('C-climbs', MATRICES.bands.length), T);
  it(`presets: ${BAND_TEXT.presets}`, () => expectBand('presets', 2), T);
});
