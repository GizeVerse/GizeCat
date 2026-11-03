// A fully populated v1.2 behaviour profile (every field and optional field set) for the schema,
// IPC and export tests.
import type { BehaviorProfileSnapshot, ExcursionRecord } from '../../../src/shared/behaviorProfile';

const MIN = 60_000;

export function profileStay(at: number, extra: Partial<ExcursionRecord> = {}): ExcursionRecord {
  return { phase: 'end', at, surfaceKind: 'tabStrip', arrivedBy: 'hop', plannedMs: 140_000, dwellMs: 95_000, endReason: 'covered', leaveKind: null, bailOut: 'hop', resumed: false, ...extra };
}

export function fullProfile(): BehaviorProfileSnapshot {
  return {
    since: 0,
    at: 100 * MIN,
    timeMs: { asleep: 17 * MIN, calm: 54 * MIN, active: 22 * MIN, interaction: 4 * MIN, reaction: MIN, physical: 2 * MIN, away: 0 },
    activeShare: 22 / 83,
    decisions: 412,
    excursions: {
      arrivals: 11,
      byKind: { windowTop: 8, tabStrip: 3 },
      dwellS: { n: 10, p10: 38, p50: 142, p90: 405, max: 610 },
      byEnd: { leave: 7, drag: 2, covered: 1 },
      byLeave: { jumpDown: 3, climbDown: 2, hop: 1, climbLeap: 1 },
    },
    hunts: { count: 9, pounces: 4, byOutcome: { caught: 2, missed: 2, lostInterest: 4, interrupted: 1 } },
    falls: { count: 6, byCause: { thrown: 5, slip: 1 }, byImpact: { soft: 3, medium: 2, hard: 1 } },
    slips: 2,
    reactions: { shrug: 2, grumpy: 1 },
    screenEdgeVisits: 2,
    screenEdgePeeks: 1,
    sleeps: 2,
    stuckResets: 0,
    moodMs: { wary: 3 * MIN, irritable: 40_000, fearful: 25_000 },
    context: { typing: 31 * MIN, foregroundMaximized: 46 * MIN, cursorInReach: 12 * MIN },
    recentStays: [profileStay(10 * MIN), profileStay(40 * MIN, { surfaceKind: 'windowTop', arrivedBy: 'climb', endReason: 'leave', leaveKind: 'jumpDown', bailOut: null })],
  };
}
