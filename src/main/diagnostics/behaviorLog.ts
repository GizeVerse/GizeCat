// v1.2 behaviour log lines (ADR 0003 §11, review C2 seam): app.ts hands the sim's behaviour
// profile to onProfile from its 10 s diagnostics timer. The settings/diagnostics package
// implements the rate-limited 'stay ended' line (STAY_LOG_MIN_GAP_MS, STAY_LOG_MAX_PER_HOUR;
// suppressed lines counted into the next) and the 10-minute 'behavior summary' line. Neither line
// carries typing time, window, surface or app ids. Contract stub: logs nothing.
import type { BehaviorProfileSnapshot } from '../../shared/behaviorProfile';
import type { Logger } from '../contracts';

export interface BehaviorLog {
  /** Called about every 10 s (main clock `now`, ms) with the current profile snapshot. */
  onProfile(profile: BehaviorProfileSnapshot, now: number): void;
}

export interface BehaviorLogOptions {
  minGapMs?: number;
  maxPerHour?: number;
}

export function createBehaviorLog(log: Logger, opts: BehaviorLogOptions = {}): BehaviorLog {
  void log;
  void opts;
  return {
    onProfile(profile, now) {
      void profile;
      void now;
    },
  };
}
