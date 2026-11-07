// The v1.2 lifetime counters shown in Settings (src/shared/catState.ts Counters: excursions, surfaceHops,
// edgeClimbs, slips, hardLandings) follow the sim's own profile records one for one, and bumping them
// leaves the sim deterministic (they are never read by behaviour and draw no random numbers).
// SIMULATED: the real sim and Mover (the Harness) with an injected environment, clock and seeded randomness.
import { describe, expect, it } from 'vitest';
import type { EdgeVisitRecord, ExcursionRecord, FallRecord, SlipRecord } from '../../../../src/shared/behaviorProfile';
import type { Counters, Traits } from '../../../../src/shared/catState';
import type { ScreenEdgeBand } from '../../../../src/shared/surfaces';
import { mulberry32, newPersistedCat } from '../../../../src/core/behavior';
import { Harness, settingsWith, WAKE_MS } from './fixtures';

const MIN = 60_000;
const WALL = 1_800_000_000_000;
const V12 = ['excursions', 'surfaceHops', 'edgeClimbs', 'slips', 'hardLandings'] as const satisfies ReadonlyArray<keyof Counters>;
type V12Counter = (typeof V12)[number];

const CLEAR_BANDS: ScreenEdgeBand[] = [
  { displayId: '1', side: 'left', clearSpans: [{ y0: 0, y1: 1080 }] },
  { displayId: '1', side: 'right', clearSpans: [{ y0: 0, y1: 1080 }] },
];

/** A timid, curious, restless cat: it goes up, hops, slips and climbs the screen edges within the hour. */
const TRAITS: Partial<Traits> = { confidence: 0.12, curiosity: 0.9, laziness: 0.12 };

interface Run {
  counters: Record<V12Counter, number>;
  oracle: Record<V12Counter, number>;
  trace: string;
}

function run(seed: number, ms: number): Run {
  const records = { excursions: [] as ExcursionRecord[], falls: [] as FallRecord[], slips: [] as SlipRecord[], edges: [] as EdgeVisitRecord[] };
  const persisted = newPersistedCat(mulberry32(seed), WALL - 3600_000);
  Object.assign(persisted.traits, TRAITS);
  const h = new Harness({
    seed,
    persisted,
    settings: settingsWith({ behavior: { stayLength: 0, disabledExtras: [] } }),
    hooks: {
      onExcursion: (r) => records.excursions.push(r),
      onFall: (r) => records.falls.push(r),
      onSlip: (r) => records.slips.push(r),
      onEdgeVisit: (r) => records.edges.push(r),
    },
  });
  h.env.windows = { a: { x: 400, y: 700, width: 400, height: 340 }, b: { x: 880, y: 620, width: 500, height: 420 } };
  h.env.edgeBands = CLEAR_BANDS;
  h.run(WAKE_MS);
  const start = { ...h.sim.serialize().memory.counters };
  // A high drop: a hard landing.
  const o = h.last!;
  h.step([{ type: 'pointer.dragStart', at: { x: o.x, y: o.y - 30 } }]);
  h.env.dragCursor = { x: 1500, y: 100 };
  h.step();
  h.step([{ type: 'pointer.dragEnd', at: { x: 1500, y: 100 }, velocity: { x: 0, y: 0 } }]);
  h.env.dragCursor = null;
  // The user stays around without the cursor near the cat or the bands.
  const trace: number[] = [];
  h.run(ms, 66, (hh, i) => {
    hh.env.userIdleMs = i % 50 === 0 ? 0 : (hh.env.userIdleMs ?? 0) + 100;
    hh.env.cursor = { x: 960, y: 300, speed: 0 };
    if (i % 500 === 0) trace.push(Math.round(hh.last!.x), Math.round(hh.last!.y));
  });
  const end = h.sim.serialize().memory.counters;
  const counters = Object.fromEntries(V12.map((k) => [k, end[k] - start[k]])) as Record<V12Counter, number>;
  const oracle: Record<V12Counter, number> = {
    excursions: records.excursions.filter((r) => r.phase === 'arrive').length,
    surfaceHops: records.excursions.filter((r) => r.phase === 'end' && r.endReason === 'leave' && r.leaveKind === 'hop').length,
    edgeClimbs: records.edges.filter((r) => !r.covered).length,
    slips: records.slips.length,
    hardLandings: records.falls.filter((r) => r.impact === 'hard').length,
  };
  return { counters, oracle, trace: trace.join(',') };
}

describe('v1.2 lifetime counters (Settings: trips up high, jumps between windows, screen-edge climbs, slips, hard landings)', () => {
  it('each one follows its profile record one for one, and each is exercised', () => {
    const r = run(3, 45 * MIN);
    expect(r.counters).toEqual(r.oracle);
    for (const k of V12) expect(r.oracle[k], `${k} happened in the run`).toBeGreaterThan(0);
  }, 60_000);

  it('bumping them keeps the sim deterministic: the same seed gives the same run and counts', () => {
    const a = run(5, 15 * MIN);
    const b = run(5, 15 * MIN);
    expect(b.trace).toBe(a.trace);
    expect(b.counters).toEqual(a.counters);
  }, 60_000);
});
