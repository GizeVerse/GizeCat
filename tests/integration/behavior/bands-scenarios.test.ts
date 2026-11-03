// ADR 0003 §15.2 integration scenarios for the §14 bands (SIMULATED): the real sim, Mover, host
// and activity monitor with the synthetic users of tests/profile, on short scripted cells: the
// four users' nuisance bands, the screen-edge on / off / no-bands cells, covered-strip and
// maximize churn, window-drag churn, the throw Monte Carlo and the recovery after a burst.
// Short runs, so rates are Poisson-widened (tests/profile/metrics.ts); the full matrix is in
// bands-full.test.ts. Each scenario runs once, lazily, when its first non-skipped spec needs it.
//
// Markers: every spec is `it.skip` until the behaviour package (BEH) lands what it asserts; BEH
// flips `it.skip` -> `it` (only the marker; INT owns the bodies, ADR 0003 §16.2).
import { describe, expect, it } from 'vitest';
import { BAND_TEXT, recoveryChecks, throwMonteCarloChecks, type BandResult } from '../../profile/bands';
import { cellKey, runProfile, runRecovery, runThrowMonteCarlo, summarizeCell, type CellSpec, type CellSummary, type ProfileId, type RecoveryTrace, type RunResult } from '../../profile/behaviorProfile';
import { widenRate } from '../../profile/metrics';

const memo = new Map<string, unknown>();
function once<T>(key: string, f: () => T): T {
  if (!memo.has(key)) memo.set(key, f());
  return memo.get(key) as T;
}

/** A short cell: `seeds` x `hours` of one profile / layout / user (/ variant). */
function cell(spec: CellSpec, seeds: readonly number[] = [1, 2], hours = 1): { c: CellSummary; runs: RunResult[] } {
  return once(`${cellKey(spec)}:${seeds.join(',')}:${hours}`, () => {
    const runs = seeds.map((seed) => runProfile({ ...spec, seed, hours }));
    return { c: summarizeCell(runs), runs };
  });
}

const fails = (rs: readonly BandResult[]): BandResult[] => rs.filter((r) => r.status === 'fail');
const LONG = 120_000;

describe('ADR 0003 §14 nuisance bands per user (P2/L1, 2 seeds x 1 sim-h, widened)', () => {
  it.skip(`B5: ${BAND_TEXT.B5} (U-play)`, () => {
    const { c, runs } = cell({ profile: 'P2', layout: 'L1', user: 'U-play' });
    const hunts = widenRate(4, 12, c.simHours);
    expect(c.hunts.perHour).toBeGreaterThanOrEqual(hunts.lo);
    expect(c.hunts.perHour).toBeLessThanOrEqual(hunts.hi);
    expect(c.hunts.pouncesPerHour).toBeGreaterThanOrEqual(widenRate(1, 1, c.simHours).lo);
    for (const r of runs) {
      const ts = r.records.hunts.flatMap((h) => h.pounceTimes ?? []).sort((a, b) => a - b);
      for (let i = 1; i < ts.length; i++) expect(ts[i]! - ts[i - 1]!).toBeGreaterThanOrEqual(90_000);
    }
  });

  it.skip(`B5c: ${BAND_TEXT.B5c} (U-play)`, () => {
    const { c, runs } = cell({ profile: 'P2', layout: 'L1', user: 'U-play' });
    expect(c.hunts.count).toBeGreaterThan(0);
    for (const r of runs) for (const h of r.records.hunts) if (h.pounces > 0) expect(h.minClearanceDip ?? -1).toBeGreaterThanOrEqual(8);
    expect(c.hunts.clearanceBelow8).toBe(0);
  });

  it.skip(`B5b: ${BAND_TEXT.B5b} (U-mouse-work)`, () => {
    const { c } = cell({ profile: 'P2', layout: 'L1', user: 'U-mouse-work' });
    expect(c.user.pressesPerPresentHour).toBeGreaterThan(300);
    expect(c.hunts.perHour).toBeLessThanOrEqual(widenRate(0, 1, c.simHours).hi);
    expect(c.hunts.pouncesNearPress).toBe(0);
    expect(c.hunts.pounceLandingsNearPressPoint).toBe(0);
  });

  for (const variant of ['default', 'typingReactionsOff'] as const) {
    it.skip(`B6: ${BAND_TEXT.B6} (U-typing, ${variant === 'default' ? 'reactToTyping on' : 'reactToTyping off'})`, () => {
      const { c } = cell({ profile: 'P2', layout: 'L1', user: 'U-typing', variant });
      const { c: active } = cell({ profile: 'P2', layout: 'L1', user: 'U-active' });
      expect(c.user.typingRawPctOfPresent).toBeGreaterThan(45);
      expect(c.hunts.startedWhileTyping).toBe(0);
      expect(c.hunts.pouncesWhileTyping).toBe(0);
      expect(c.strikes.whileTypingNearCursor).toBe(0);
      expect(c.strikes.playNearCursorWhileTyping).toBe(0);
      // Excursions 0.2-0.6 x the U-active rate, widened for 2 sim-h each.
      const lo = widenRate(0.2 * active.stays.ownArrivalsPerHour, 0.2 * active.stays.ownArrivalsPerHour, c.simHours).lo;
      const hi = widenRate(0.6 * active.stays.ownArrivalsPerHour, 0.6 * active.stays.ownArrivalsPerHour, c.simHours).hi;
      expect(c.stays.ownArrivalsPerHour).toBeGreaterThanOrEqual(lo);
      expect(c.stays.ownArrivalsPerHour).toBeLessThanOrEqual(hi);
    });
  }
});

describe('ADR 0003 §14 screen edges (L4, L4b; P2, widened)', () => {
  it.skip(`B11: ${BAND_TEXT.B11} — on (2 seeds x 2 sim-h)`, () => {
    const { c } = cell({ profile: 'P2', layout: 'L4', user: 'U-active' }, [1, 2], 2);
    const w = widenRate(2, 8, c.simHours);
    expect(c.edges.visitsPerHour).toBeGreaterThanOrEqual(w.lo);
    expect(c.edges.visitsPerHour).toBeLessThanOrEqual(w.hi);
    expect(c.falls.physicsErrors).toBe(0);
  });

  it.skip(`B11: ${BAND_TEXT.B11} — setting off`, () => {
    const { c } = cell({ profile: 'P2', layout: 'L4', user: 'U-active', variant: 'edgesOff' });
    expect(c.edges.visits).toBe(0);
    expect(c.timeSharePct.support.screenEdge ?? 0).toBe(0);
  });

  it.skip(`B11: ${BAND_TEXT.B11} — no env.edgeBands`, () => {
    const { c } = cell({ profile: 'P2', layout: 'L4', user: 'U-active', variant: 'noEdgeBands' });
    expect(c.edges.visits).toBe(0);
    expect(c.timeSharePct.support.screenEdge ?? 0).toBe(0);
  });

  it.skip(`B1b: ${BAND_TEXT.B1b} (P2, seeds 1-2 x 3 sim-h)`, () => {
    const l4b = cell({ profile: 'P2', layout: 'L4b', user: 'U-active' }, [1, 2], 3).c;
    const l1 = cell({ profile: 'P2', layout: 'L1', user: 'U-active' }, [1, 2], 3).c;
    for (const seed of ['1', '2']) expect(l4b.activeShareBySeed[seed]!).toBeLessThanOrEqual(l1.activeShareBySeed[seed]!);
    const w = widenRate(1, 4, l4b.simHours);
    expect(l4b.edges.peeksPerHour).toBeGreaterThanOrEqual(w.lo);
    expect(l4b.edges.peeksPerHour).toBeLessThanOrEqual(w.hi);
  }, LONG);
});

describe('ADR 0003 §14 churn (P2, 2 seeds x 1 sim-h)', () => {
  it.skip(`B13: ${BAND_TEXT.B13} (L3c: cover / maximize / minimize every 30-90 s)`, () => {
    const { c } = cell({ profile: 'P2', layout: 'L3c', user: 'U-active' });
    expect(c.desktop.churnPerHour).toBeGreaterThan(20);
    expect((c.falls.byCause.covered ?? 0) + (c.falls.byCause.gone ?? 0) + (c.falls.byCause.physics ?? 0)).toBe(0);
    expect(c.stays.imposedLoss.n).toBeGreaterThan(0);
    expect(c.stays.imposedLoss.withBailOut).toBe(c.stays.imposedLoss.n);
  });

  it.skip(`B9: ${BAND_TEXT.B9} (L3c covered-strip churn and L1d window-drag churn)`, () => {
    expect(cell({ profile: 'P2', layout: 'L3c', user: 'U-active' }).c.falls.physicsErrors).toBe(0);
    const drag = cell({ profile: 'P2', layout: 'L1d', user: 'U-active' }).c;
    expect(drag.desktop.windowDragsPerHour).toBeGreaterThan(40);
    expect(drag.falls.physicsErrors).toBe(0);
  });

  it.skip(`B14: ${BAND_TEXT.B14} (L3c and L1d churn)`, () => {
    for (const layout of ['L3c', 'L1d'] as const) {
      const { c } = cell({ profile: 'P2', layout, user: 'U-active' });
      expect(c.stuckResets).toBe(0);
      expect(c.watchdogDecisions).toBe(0);
    }
  });
});

describe('ADR 0003 §14 handling scenarios', () => {
  for (const profile of ['P1', 'P2'] as ProfileId[]) {
    it.skip(`B7: ${BAND_TEXT.B7} (${profile}, 100 hard throws at the REAL spacing, seed 1)`, () => {
      const run = once(`b7:${profile}`, () => runThrowMonteCarlo(profile, 1, 100));
      expect(fails(throwMonteCarloChecks(`B7 ${profile}`, run, 100))).toEqual([]);
    }, LONG);
  }

  for (const profile of ['P1', 'P2'] as ProfileId[]) {
    it.skip(`B8: ${BAND_TEXT.B8} (${profile}, bond 0.3, seeds 1-2)`, () => {
      for (const seed of [1, 2]) {
        const plain = once<RecoveryTrace>(`b8:${profile}:${seed}`, () => runRecovery(profile, seed, false));
        expect(fails(recoveryChecks(`B8 ${profile} ${seed}`, plain, 10))).toEqual([]);
        const petted = once<RecoveryTrace>(`b8p:${profile}:${seed}`, () => runRecovery(profile, seed, true));
        expect(petted.run.userLog.petSessions).toBeGreaterThan(0);
        expect(fails(recoveryChecks(`B8 ${profile} ${seed} petted`, petted, 8))).toEqual([]);
      }
    }, LONG);
  }
});
