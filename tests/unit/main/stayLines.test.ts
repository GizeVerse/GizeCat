// scripts/stay-lines.mjs: what a packaged run reports from the app's 'stay ended' log lines
// (scripts/qa-traversal-packaged.mjs). SIMULATED log lines, in the shape behaviorLog writes.
import { describe, expect, it } from 'vitest';
// @ts-expect-error a plain .mjs script without declarations
import { staysFromLog, summarizeStays } from '../../../scripts/stay-lines.mjs';

interface Stay {
  kind: string;
  dwellS: number;
  reason: string;
  leave: string | null;
  arrivedBy: string;
  overdue: boolean;
  suppressed: number;
}
const parse = staysFromLog as (lines: unknown[]) => Stay[];
const summarize = summarizeStays as (stays: Stay[]) => Record<string, unknown>;

const line = (d: Record<string, unknown>, t = '2026-11-04T12:00:00Z'): unknown => ({ t, l: 'info', s: 'behavior', m: 'stay ended', d });

describe('stay lines of a packaged run', () => {
  const lines = [
    { t: 'x', l: 'info', s: 'surfaces', m: 'surfaces summary', d: { support: 'floor' } },
    line({ kind: 'tabStrip', dwellS: 210, plannedS: 200, reason: 'leave', leave: 'jumpDown', arrivedBy: 'climb', bailOut: null }),
    line({ kind: 'windowTop', dwellS: 90, plannedS: 95, reason: 'leave', leave: 'hop', arrivedBy: 'leap', bailOut: null, suppressed: 2 }),
    line({ kind: 'tabStrip', dwellS: 30, plannedS: 400, reason: 'gone', leave: null, arrivedBy: 'climb', bailOut: 'jump', overdue: true }),
  ];

  it('takes only the stay ended lines, with kind, dwell, reason, leave and route', () => {
    const stays = parse(lines);
    expect(stays).toHaveLength(3);
    expect(stays[0]).toMatchObject({ kind: 'tabStrip', dwellS: 210, reason: 'leave', leave: 'jumpDown', arrivedBy: 'climb' });
    expect(stays[2]).toMatchObject({ reason: 'gone', leave: null, overdue: true });
  });

  it('summarizes n, median, min, max and the counts, without counting a stay without a leave as one', () => {
    expect(summarize(parse(lines))).toMatchObject({
      n: 3,
      medianS: 90,
      minS: 30,
      maxS: 210,
      byKind: { tabStrip: 2, windowTop: 1 },
      byReason: { leave: 2, gone: 1 },
      byLeave: { jumpDown: 1, hop: 1 },
      byArrivedBy: { climb: 2, leap: 1 },
      overdue: 1,
      suppressedByRateLimit: 2,
    });
  });

  it('has no numbers to report for a run without a finished stay', () => {
    expect(summarize(parse([]))).toMatchObject({ n: 0, medianS: null, minS: null, maxS: null });
  });
});
