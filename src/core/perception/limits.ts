// Rate limits (minimum interval + sliding hourly budget) and an AI circuit breaker.
// All time comes from the caller so behaviour is deterministic under test.

export interface RateLimitOptions {
  minIntervalMs: number;
  maxPerWindow: number;
  windowMs?: number;
}

export type RateCheck = { ok: true } | { ok: false; reason: 'interval' | 'budget'; retryInMs: number };

export class RateLimiter {
  private minIntervalMs: number;
  private maxPerWindow: number;
  private readonly windowMs: number;
  private readonly stamps: number[] = [];
  private last: number | null = null;

  constructor(opts: RateLimitOptions) {
    this.minIntervalMs = Math.max(0, opts.minIntervalMs);
    this.maxPerWindow = Math.max(0, Math.floor(opts.maxPerWindow));
    this.windowMs = opts.windowMs ?? 3_600_000;
  }

  configure(opts: Omit<RateLimitOptions, 'windowMs'>): void {
    this.minIntervalMs = Math.max(0, opts.minIntervalMs);
    this.maxPerWindow = Math.max(0, Math.floor(opts.maxPerWindow));
  }

  check(now: number): RateCheck {
    this.prune(now);
    if (this.last !== null) {
      const since = now - this.last;
      if (since < this.minIntervalMs) return { ok: false, reason: 'interval', retryInMs: this.minIntervalMs - since };
    }
    if (this.stamps.length >= this.maxPerWindow) {
      const oldest = this.stamps[0];
      const retryInMs = oldest === undefined ? this.windowMs : Math.max(1, oldest + this.windowMs - now);
      return { ok: false, reason: 'budget', retryInMs };
    }
    return { ok: true };
  }

  record(now: number): void {
    this.prune(now);
    this.stamps.push(now);
    this.last = now;
  }

  /** Events inside the sliding window ending at `now`. */
  count(now: number): number {
    this.prune(now);
    return this.stamps.length;
  }

  reset(): void {
    this.stamps.length = 0;
    this.last = null;
  }

  private prune(now: number): void {
    // A clock that jumped backwards must not unlock early or block for days:
    // clamp future stamps to `now` (conservative: they still count).
    for (let i = 0; i < this.stamps.length; i++) if (this.stamps[i]! > now) this.stamps[i] = now;
    if (this.last !== null && this.last > now) this.last = now;
    const cutoff = now - this.windowMs;
    let drop = 0;
    while (drop < this.stamps.length && this.stamps[drop]! <= cutoff) drop++;
    if (drop > 0) this.stamps.splice(0, drop);
  }
}

export interface BreakerOptions {
  failureThreshold: number;
  baseBackoffMs: number;
  maxBackoffMs: number;
}

export const DEFAULT_BREAKER_OPTIONS: Readonly<BreakerOptions> = Object.freeze({
  failureThreshold: 3,
  baseBackoffMs: 60_000,
  maxBackoffMs: 30 * 60_000,
});

export type BreakerState = 'closed' | 'open' | 'half-open';

/**
 * closed -> (N consecutive failures) -> open for a backoff that doubles on each
 * trip (base .. max) -> half-open: exactly one probe may run; success closes,
 * failure re-opens with the next backoff.
 */
export class CircuitBreaker {
  private readonly opts: BreakerOptions;
  private failures = 0;
  private trips = 0;
  private openUntil = 0;
  private opened = false;
  private probeInFlight = false;

  constructor(opts: Partial<BreakerOptions> = {}) {
    this.opts = { ...DEFAULT_BREAKER_OPTIONS, ...opts };
  }

  state(now: number): BreakerState {
    if (!this.opened) return 'closed';
    return now >= this.openUntil ? 'half-open' : 'open';
  }

  /** Whether a request may start now. Does not reserve the half-open probe. */
  canRequest(now: number): boolean {
    const s = this.state(now);
    return s === 'closed' || (s === 'half-open' && !this.probeInFlight);
  }

  /** Reserves the right to send one request; returns false when the breaker forbids it. */
  tryAcquire(now: number): boolean {
    const s = this.state(now);
    if (s === 'closed') return true;
    if (s === 'half-open' && !this.probeInFlight) {
      this.probeInFlight = true;
      return true;
    }
    return false;
  }

  recordSuccess(): void {
    this.failures = 0;
    this.trips = 0;
    this.opened = false;
    this.openUntil = 0;
    this.probeInFlight = false;
  }

  recordFailure(now: number): void {
    const wasProbe = this.opened && this.probeInFlight;
    this.probeInFlight = false;
    this.failures++;
    if (wasProbe || this.failures >= this.opts.failureThreshold) {
      this.trips++;
      this.opened = true;
      this.openUntil = now + this.backoffForTrip(this.trips);
      this.failures = 0;
    }
  }

  /** Releases a reserved probe without counting it (e.g. the request was aborted by the user). */
  releaseProbe(): void {
    this.probeInFlight = false;
  }

  /** ms until a probe is allowed (0 when closed or half-open). */
  retryInMs(now: number): number {
    return this.state(now) === 'open' ? this.openUntil - now : 0;
  }

  reset(): void {
    this.recordSuccess();
  }

  private backoffForTrip(trip: number): number {
    const exp = Math.min(30, Math.max(0, trip - 1));
    return Math.min(this.opts.maxBackoffMs, this.opts.baseBackoffMs * 2 ** exp);
  }
}
