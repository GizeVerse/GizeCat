// Restart policy for the UI Automation helper: exponential backoff, and a budget of restarts per
// sliding window after which the feature is reported unavailable. Pure; the clock is passed in.

export interface RestartBudgetOptions {
  /** Delay before the first restart (ms); doubles per recent failure. */
  baseDelayMs: number;
  maxDelayMs: number;
  /** Restarts allowed inside `windowMs`; one more failure exhausts the budget. */
  maxRestarts: number;
  windowMs: number;
}

export const DEFAULT_RESTART_BUDGET: RestartBudgetOptions = { baseDelayMs: 1000, maxDelayMs: 60_000, maxRestarts: 5, windowMs: 10 * 60_000 };

export class RestartBudget {
  private failures: number[] = [];
  private exhaustedFlag = false;

  constructor(private readonly opts: RestartBudgetOptions = DEFAULT_RESTART_BUDGET) {}

  /**
   * Records a failure (crash, hang, spawn error) at `now`. Returns the earliest time the helper
   * may be started again, or null once more than `maxRestarts` failures fell inside the window.
   */
  recordFailure(now: number): number | null {
    this.failures = this.failures.filter((t) => now - t < this.opts.windowMs);
    this.failures.push(now);
    if (this.failures.length > this.opts.maxRestarts) {
      this.exhaustedFlag = true;
      return null;
    }
    const delay = Math.min(this.opts.maxDelayMs, this.opts.baseDelayMs * 2 ** (this.failures.length - 1));
    return now + delay;
  }

  get exhausted(): boolean {
    return this.exhaustedFlag;
  }

  /** Failures inside the window as of the last record. */
  get recentFailures(): number {
    return this.failures.length;
  }

  reset(): void {
    this.failures = [];
    this.exhaustedFlag = false;
  }
}
