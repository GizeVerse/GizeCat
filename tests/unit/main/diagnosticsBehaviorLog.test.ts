// v1.2 behaviour log lines (ADR 0003 §11): 'stay ended' at most one per 20 s and 60 per hour
// (suppressed stays counted into the next line) and 'behavior summary' at most every 10 minutes
// on change. Neither line carries typing time or any window, surface or app id.
import { describe, expect, it } from 'vitest';
import { emptyBehaviorProfile, STAY_LOG_MAX_PER_HOUR, STAY_LOG_MIN_GAP_MS, type BehaviorProfileSnapshot, type ExcursionRecord } from '../../../src/shared/behaviorProfile';
import { BEHAVIOR_SUMMARY_INTERVAL_MS, behaviorSummary, createBehaviorLog, stayLine } from '../../../src/main/diagnostics/behaviorLog';
import { memoryLogger } from './helpers';

const MIN = 60_000;

function stay(at: number, extra: Partial<ExcursionRecord> = {}): ExcursionRecord {
  return { phase: 'end', at, surfaceKind: 'windowTop', arrivedBy: 'climb', plannedMs: 150_000, dwellMs: 123_456, endReason: 'leave', leaveKind: 'jumpDown', bailOut: null, ...extra };
}

/** A profile whose recentStays end at the given sim times (oldest first, at most 20 like the recorder). */
function profile(stayTimes: number[], patch: Partial<BehaviorProfileSnapshot> = {}): BehaviorProfileSnapshot {
  const p = emptyBehaviorProfile(0);
  p.recentStays = stayTimes.slice(-20).map((t) => stay(t));
  return { ...p, ...patch };
}

const stayLines = (log: ReturnType<typeof memoryLogger>) => log.entries.filter((e) => e.msg === 'stay ended');
const summaries = (log: ReturnType<typeof memoryLogger>) => log.entries.filter((e) => e.msg === 'behavior summary');

describe("'stay ended' line", () => {
  it('carries kind, dwell, planned, reason, leave, arrival route and bail-out, rounded, and nothing else', () => {
    const log = memoryLogger();
    const b = createBehaviorLog(log);
    b.onProfile(profile([]), 0);
    b.onProfile(profile([5000]), 10_000);
    const lines = stayLines(log);
    expect(lines).toHaveLength(1);
    expect(lines[0]!.data).toEqual({ kind: 'windowTop', dwellS: 123.5, plannedS: 150, reason: 'leave', leave: 'jumpDown', arrivedBy: 'climb', bailOut: null });
    expect(lines[0]!.level).toBe('info');
  });

  it('never carries typing time, ids, titles or positions, whatever the record holds', () => {
    const log = memoryLogger();
    const b = createBehaviorLog(log);
    const leaky = {
      ...stay(1000, { endReason: 'covered', leaveKind: null, bailOut: 'hop', resumed: true }),
      surfaceId: 'windowTop:0x1A2B3C',
      windowId: '197482',
      title: 'Inbox - Mail',
      processName: 'outlook.exe',
      typingMs: 42_000,
      x: 812,
    } as unknown as ExcursionRecord;
    const p = profile([]);
    p.recentStays = [leaky];
    p.context = { typing: 31 * MIN, foregroundMaximized: 46 * MIN, cursorInReach: 12 * MIN };
    b.onProfile(p, 0);
    const all = JSON.stringify(log.entries);
    expect(all).not.toMatch(/0x1A2B3C|197482|Inbox|outlook|typing|42000|1860000|812/i);
    const line = stayLines(log)[0]!.data!;
    expect(Object.keys(line).sort()).toEqual(['arrivedBy', 'bailOut', 'dwellS', 'kind', 'leave', 'plannedS', 'reason']);
    expect(line).toMatchObject({ reason: 'covered', bailOut: 'hop', leave: null });
    expect(stayLine({ ...stay(1), overdue: true }).overdue).toBe(true);
  });

  it('maps values outside the contract to other / null instead of passing them through', () => {
    const bad = { ...stay(1), surfaceKind: 'C:\\Users\\x', endReason: 'title:Inbox', leaveKind: 'secret', arrivedBy: 'window 42', bailOut: 'x', plannedMs: 0, dwellMs: Number.NaN } as unknown as ExcursionRecord;
    expect(stayLine(bad)).toEqual({ kind: 'other', dwellS: 0, plannedS: null, reason: 'other', leave: null, arrivedBy: 'other', bailOut: null });
  });

  it('logs at most one per 20 s; stays in between are counted into the next line', () => {
    const log = memoryLogger();
    const b = createBehaviorLog(log);
    const times: number[] = [];
    // A stay ends every 10 s of main time (the 10 s timer sees one new stay per call).
    for (let i = 0; i < 6; i++) {
      times.push(1000 + i * 10_000);
      b.onProfile(profile(times), i * 10_000);
    }
    const lines = stayLines(log);
    // t = 0, 20 s, 40 s logged; 10 s, 30 s, 50 s suppressed.
    expect(lines).toHaveLength(3);
    expect(lines[0]!.data).not.toHaveProperty('suppressed');
    expect(lines[1]!.data!.suppressed).toBe(1);
    expect(lines[2]!.data!.suppressed).toBe(1);
    expect(STAY_LOG_MIN_GAP_MS).toBe(20_000);
  });

  it('logs the newest of several stays that ended between two calls and counts the others', () => {
    const log = memoryLogger();
    const b = createBehaviorLog(log);
    const p = profile([1000, 2000, 3000]);
    p.recentStays[2] = stay(3000, { surfaceKind: 'tabStrip', dwellMs: 9000 });
    b.onProfile(p, 0);
    const lines = stayLines(log);
    expect(lines).toHaveLength(1);
    expect(lines[0]!.data).toMatchObject({ kind: 'tabStrip', dwellS: 9, suppressed: 2 });
    // Nothing new: nothing logged, nothing counted.
    b.onProfile(p, 60_000);
    expect(stayLines(log)).toHaveLength(1);
  });

  it('logs at most 60 per hour (sliding), then resumes with the suppressed count', () => {
    const log = memoryLogger();
    const b = createBehaviorLog(log);
    const times: number[] = [];
    const loggedAt: number[] = [];
    // One stay per 20 s of main time for 2 h: 360 stays.
    for (let i = 0; i < 360; i++) {
      times.push(i + 1);
      const before = stayLines(log).length;
      b.onProfile(profile(times), i * 20_000);
      if (stayLines(log).length > before) loggedAt.push(i * 20_000);
    }
    expect(STAY_LOG_MAX_PER_HOUR).toBe(60);
    // The first 60 (0-19:40), then nothing until the first line is an hour old, then one per freed slot.
    expect(loggedAt).toHaveLength(120);
    expect(loggedAt[59]).toBe(59 * 20_000);
    expect(loggedAt[60]).toBe(60 * MIN);
    for (let k = 0; k < loggedAt.length; k++) {
      const inHour = loggedAt.filter((t) => t > loggedAt[k]! - 60 * MIN && t <= loggedAt[k]!).length;
      expect(inHour).toBeLessThanOrEqual(STAY_LOG_MAX_PER_HOUR);
    }
    const lines = stayLines(log);
    // The 120 stays the cap held back are counted into the first line after it.
    expect(lines[60]!.data!.suppressed).toBe(120);
    expect(lines.filter((e) => e.data!.suppressed !== undefined)).toHaveLength(1);
  });

  it('honours custom limits and starts over when the profile restarts (new since)', () => {
    const log = memoryLogger();
    const b = createBehaviorLog(log, { minGapMs: 0, maxPerHour: 1000 });
    b.onProfile(profile([5000]), 0);
    b.onProfile(profile([5000, 6000]), 1);
    expect(stayLines(log)).toHaveLength(2);
    // A new recorder (since moved) whose first stay ends at an earlier sim time is still new.
    b.onProfile(profile([10], { since: 7 }), 2);
    expect(stayLines(log)).toHaveLength(3);
  });

  it('skips arrive records and malformed input without throwing', () => {
    const log = memoryLogger();
    const b = createBehaviorLog(log);
    const p = profile([]);
    p.recentStays = [{ ...stay(1), phase: 'arrive' }];
    b.onProfile(p, 0);
    b.onProfile(null as unknown as BehaviorProfileSnapshot, 1);
    b.onProfile({ ...p, recentStays: 'nope' } as unknown as BehaviorProfileSnapshot, 2);
    b.onProfile(p, Number.NaN);
    expect(stayLines(log)).toHaveLength(0);
    expect(log.entries.filter((e) => e.level === 'error')).toHaveLength(0);
  });
});

describe("'behavior summary' line", () => {
  function active(arrivals: number, hunts: number): BehaviorProfileSnapshot {
    const p = emptyBehaviorProfile(0);
    p.timeMs = { asleep: 10 * MIN, calm: 30 * MIN, active: 15 * MIN, interaction: 2 * MIN, reaction: 1 * MIN, physical: 2 * MIN, away: 20 * MIN };
    p.activeShare = 15 / 50;
    p.excursions.arrivals = arrivals;
    p.hunts = { count: hunts, pounces: 1, byOutcome: { caught: 1 } };
    p.falls = { count: 3, byCause: { thrown: 2, slip: 1 }, byImpact: { soft: 3 } };
    p.stuckResets = 0;
    p.context = { typing: 25 * MIN, foregroundMaximized: 3 * MIN, cursorInReach: 1 * MIN };
    p.moodMs = { wary: 99_999, irritable: 0, fearful: 0 };
    return p;
  }

  it('summarises active share, arrivals per present hour, hunts, falls by cause and stuck resets, without typing or moods', () => {
    const s = behaviorSummary(active(6, 4));
    expect(s).toEqual({ activeShare: 0.3, arrivals: 6, arrivalsPerHour: 6, hunts: 4, pounces: 1, falls: { thrown: 2, slip: 1 }, stuckResets: 0 });
    expect(JSON.stringify(s)).not.toMatch(/typing|wary|99999|1500000/);
  });

  it('is logged at most every 10 minutes, only on change, never for the first (baseline) snapshot', () => {
    const log = memoryLogger();
    const b = createBehaviorLog(log);
    b.onProfile(active(1, 1), 0);
    expect(summaries(log)).toHaveLength(0);
    b.onProfile(active(2, 1), 5 * MIN);
    expect(summaries(log)).toHaveLength(0);
    b.onProfile(active(2, 1), BEHAVIOR_SUMMARY_INTERVAL_MS);
    expect(summaries(log)).toHaveLength(1);
    expect(summaries(log)[0]!.data).toMatchObject({ arrivals: 2, hunts: 1 });
    // Nothing changed: no line, however long it has been.
    b.onProfile(active(2, 1), 3 * BEHAVIOR_SUMMARY_INTERVAL_MS);
    expect(summaries(log)).toHaveLength(1);
    // A change after the interval is logged at once; one within it waits.
    b.onProfile(active(3, 1), 3 * BEHAVIOR_SUMMARY_INTERVAL_MS + 10_000);
    expect(summaries(log)).toHaveLength(2);
    b.onProfile(active(4, 1), 3 * BEHAVIOR_SUMMARY_INTERVAL_MS + 20_000);
    expect(summaries(log)).toHaveLength(2);
    expect(JSON.stringify(log.entries)).not.toMatch(/typing|context|moodMs/);
  });
});
