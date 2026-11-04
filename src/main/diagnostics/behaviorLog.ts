// v1.2 behaviour log lines (ADR 0003 §11): app.ts hands the sim's behaviour profile to onProfile
// from its 10 s diagnostics timer (main clock). Two lines come out of it:
//  - 'stay ended' for each finished stay on a window top or tab strip, at most one per
//    STAY_LOG_MIN_GAP_MS and STAY_LOG_MAX_PER_HOUR per hour; stays that could not be logged are
//    counted into the next line ('suppressed'). The newest stay is the one logged.
//  - 'behavior summary' at most every 10 minutes, and only when something in it changed.
// Neither carries typing time or any window, surface or app id: every field is picked by name,
// enum values are checked against the contract's lists, and numbers are rounded.
import {
  ARRIVAL_ROUTES,
  FALL_CAUSES,
  LEAVE_KINDS,
  STAY_END_REASONS,
  STAY_LOG_MAX_PER_HOUR,
  STAY_LOG_MIN_GAP_MS,
  STAY_SURFACE_KINDS,
  type ArrivalRoute,
  type BailOutKind,
  type BehaviorProfileSnapshot,
  type ExcursionRecord,
  type FallCause,
  type LeaveKind,
  type StayEndReason,
  type StaySurfaceKind,
} from '../../shared/behaviorProfile';
import { BAIL_OUT_KINDS } from '../../shared/behaviorProfileSchema';
import type { Logger } from '../contracts';

export const BEHAVIOR_SUMMARY_INTERVAL_MS = 10 * 60_000;
const HOUR_MS = 3_600_000;

export interface BehaviorLog {
  /** Called about every 10 s (main clock `now`, ms) with the current profile snapshot. Never throws. */
  onProfile(profile: BehaviorProfileSnapshot, now: number): void;
}

export interface BehaviorLogOptions {
  minGapMs?: number;
  maxPerHour?: number;
  summaryIntervalMs?: number;
}

/** The 'stay ended' line: kinds and durations of one finished stay, nothing else. */
export interface StayLine {
  kind: StaySurfaceKind | 'other';
  dwellS: number;
  /** The stay intent drawn on arrival, s; null when none was drawn. */
  plannedS: number | null;
  reason: StayEndReason | 'other';
  leave: LeaveKind | null;
  arrivedBy: ArrivalRoute | 'other';
  bailOut: BailOutKind | null;
  /** It ran well past its plan (only present when it did). */
  overdue?: true;
  /** Stays since the previous line that the rate limit kept out of the log. */
  suppressed?: number;
}

/** The 'behavior summary' line (no typing time, no moods, no ids). */
export interface BehaviorSummaryLine {
  /** Active share of awake time, 0..1 (two decimals). */
  activeShare: number;
  arrivals: number;
  /** Arrivals per hour the cat was present (not away), one decimal; 0 before a minute of presence. */
  arrivalsPerHour: number;
  hunts: number;
  pounces: number;
  falls: Partial<Record<FallCause, number>>;
  stuckResets: number;
}

const pick = <T extends string>(list: readonly T[], value: unknown): T | null => ((list as readonly unknown[]).includes(value) ? (value as T) : null);
const finite = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0);
const round = (v: number, decimals: number): number => {
  const f = 10 ** decimals;
  return Math.round(v * f) / f;
};
const countOf = (v: unknown): number => Math.max(0, Math.round(finite(v)));

/** The log line for one finished stay (fields picked one by one; unknown kinds become 'other'). */
export function stayLine(r: ExcursionRecord): StayLine {
  const planned = finite(r.plannedMs);
  return {
    kind: pick(STAY_SURFACE_KINDS, r.surfaceKind) ?? 'other',
    dwellS: round(Math.max(0, finite(r.dwellMs)) / 1000, 1),
    plannedS: planned > 0 ? round(planned / 1000, 1) : null,
    reason: pick(STAY_END_REASONS, r.endReason) ?? 'other',
    leave: pick(LEAVE_KINDS, r.leaveKind),
    arrivedBy: pick(ARRIVAL_ROUTES, r.arrivedBy) ?? 'other',
    bailOut: pick(BAIL_OUT_KINDS, r.bailOut),
    ...(r.overdue === true ? { overdue: true as const } : {}),
  };
}

/** The summary line for a profile snapshot. */
export function behaviorSummary(p: BehaviorProfileSnapshot): BehaviorSummaryLine {
  const t = p.timeMs;
  const present = finite(t.asleep) + finite(t.calm) + finite(t.active) + finite(t.interaction) + finite(t.reaction) + finite(t.physical);
  const arrivals = countOf(p.excursions.arrivals);
  const falls: Partial<Record<FallCause, number>> = {};
  for (const cause of FALL_CAUSES) {
    const n = countOf(p.falls.byCause[cause]);
    if (n > 0) falls[cause] = n;
  }
  return {
    activeShare: round(Math.min(1, Math.max(0, finite(p.activeShare))), 2),
    arrivals,
    arrivalsPerHour: present >= 60_000 ? round(arrivals / (present / HOUR_MS), 1) : 0,
    hunts: countOf(p.hunts.count),
    pounces: countOf(p.hunts.pounces),
    falls,
    stuckResets: countOf(p.stuckResets),
  };
}

/** What 'on change' compares: the summary without the per-hour rate (which drifts with time alone). */
function summaryKey(s: BehaviorSummaryLine): string {
  const { arrivalsPerHour: _rate, ...rest } = s;
  return JSON.stringify(rest);
}

export function createBehaviorLog(log: Logger, opts: BehaviorLogOptions = {}): BehaviorLog {
  const minGapMs = opts.minGapMs ?? STAY_LOG_MIN_GAP_MS;
  const maxPerHour = opts.maxPerHour ?? STAY_LOG_MAX_PER_HOUR;
  const summaryIntervalMs = opts.summaryIntervalMs ?? BEHAVIOR_SUMMARY_INTERVAL_MS;

  /** Profile `since` the stay cursor belongs to (a new recorder starts the cursor over). */
  let since: number | null = null;
  /** Sim time of the newest stay already handled (logged or counted). */
  let lastStayAt = -Infinity;
  let lastLineAt = -Infinity;
  const lineTimes: number[] = [];
  let suppressed = 0;
  let summaryAt: number | null = null;
  let summaryKeyLogged: string | null = null;

  function noteStays(profile: BehaviorProfileSnapshot, now: number): void {
    if (profile.since !== since) {
      since = profile.since;
      lastStayAt = -Infinity;
    }
    const fresh = (Array.isArray(profile.recentStays) ? profile.recentStays : []).filter((r) => r.phase === 'end' && finite(r.at) > lastStayAt);
    const newest = fresh[fresh.length - 1];
    if (!newest) return;
    lastStayAt = finite(newest.at);
    while (lineTimes.length > 0 && now - (lineTimes[0] as number) >= HOUR_MS) lineTimes.shift();
    if (now - lastLineAt < minGapMs || lineTimes.length >= maxPerHour) {
      suppressed += fresh.length;
      return;
    }
    suppressed += fresh.length - 1;
    const line = stayLine(newest);
    log.info('stay ended', suppressed > 0 ? { ...line, suppressed } : { ...line });
    suppressed = 0;
    lastLineAt = now;
    lineTimes.push(now);
  }

  function noteSummary(profile: BehaviorProfileSnapshot, now: number): void {
    const summary = behaviorSummary(profile);
    const key = summaryKey(summary);
    if (summaryAt === null) {
      // The first snapshot is the baseline: a summary only says something once the cat did something.
      summaryAt = now;
      summaryKeyLogged = key;
      return;
    }
    if (now - summaryAt < summaryIntervalMs || key === summaryKeyLogged) return;
    summaryAt = now;
    summaryKeyLogged = key;
    log.info('behavior summary', { ...summary, falls: { ...summary.falls } });
  }

  return {
    onProfile(profile, now) {
      if (profile === null || typeof profile !== 'object' || !Number.isFinite(now)) return;
      try {
        noteStays(profile, now);
        noteSummary(profile, now);
      } catch (err) {
        log.warn('behavior log line failed', { error: err });
      }
    },
  };
}
