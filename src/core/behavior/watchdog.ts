// v1.2 progress monitor (ADR 0003 §6.9): the same activity with a goal the Mover reports as
// 'moving' and less than 0.25 body widths of progress for 10 s is stuck; the sim resets it to a
// calm idle (decision cause 'watchdog', counted as stuckResets; band B14 wants none). Pure.
import type { Point } from '../../shared/geometry';

export const STUCK_AFTER_MS = 10_000;
export const STUCK_PROGRESS_BW = 0.25;
/** Landings on one spot: this many within LOOP_WINDOW_MS, within LOOP_SPOT_BW body widths, is a loop no 'moving' goal would show. */
export const LOOP_LANDINGS = 6;
export const LOOP_WINDOW_MS = 20_000;
export const LOOP_SPOT_BW = 1;

export class ProgressMonitor {
  private token: object | null = null;
  private anchor: Point | null = null;
  private since = 0;
  private landings: Array<{ at: number; x: number }> = [];

  /** A landing (physical states are not observed: a fall-and-land loop has no goal 'moving' on the ground). True when it is a loop. */
  noteLanding(now: number, x: number, bodyWidth: number): boolean {
    this.landings = this.landings.filter((l) => now - l.at <= LOOP_WINDOW_MS && Math.abs(l.x - x) <= LOOP_SPOT_BW * bodyWidth);
    this.landings.push({ at: now, x });
    if (this.landings.length < LOOP_LANDINGS) return false;
    this.landings = [];
    return true;
  }

  /**
   * One observation: the running activity (identity), whether its goal is 'moving', where the cat
   * is and its body width. True when it has been stuck long enough to reset.
   */
  observe(now: number, activity: object, moving: boolean, at: Point, bodyWidth: number): boolean {
    if (!moving || activity !== this.token || !this.anchor) {
      this.token = moving ? activity : null;
      this.anchor = moving ? { x: at.x, y: at.y } : null;
      this.since = now;
      return false;
    }
    if (Math.hypot(at.x - this.anchor.x, at.y - this.anchor.y) >= STUCK_PROGRESS_BW * bodyWidth) {
      this.anchor = { x: at.x, y: at.y };
      this.since = now;
      return false;
    }
    return now - this.since >= STUCK_AFTER_MS;
  }

  reset(): void {
    this.token = null;
    this.anchor = null;
  }
}
