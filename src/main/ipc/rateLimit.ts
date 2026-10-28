// Small timing utilities for IPC: a per-key fixed-window message budget and a
// leading+trailing throttle. Pure (clock and timers injected).

export interface RateLimiter {
  /** True if a message from `key` at time `now` is within budget. */
  allow(key: number, now: number): boolean;
  /** Messages dropped for `key` since the last call (resets the counter). */
  takeDropped(key: number): number;
  forget(key: number): void;
}

export function createRateLimiter(maxPerWindow: number, windowMs = 1000): RateLimiter {
  const buckets = new Map<number, { start: number; count: number; dropped: number }>();
  return {
    allow(key, now) {
      let b = buckets.get(key);
      if (!b || now - b.start >= windowMs || now < b.start) {
        b = { start: now, count: 0, dropped: b?.dropped ?? 0 };
        buckets.set(key, b);
      }
      if (b.count >= maxPerWindow) {
        b.dropped++;
        return false;
      }
      b.count++;
      return true;
    },
    takeDropped(key) {
      const b = buckets.get(key);
      if (!b) return 0;
      const d = b.dropped;
      b.dropped = 0;
      return d;
    },
    forget(key) {
      buckets.delete(key);
    },
  };
}

export interface Throttle {
  /** Requests a run; runs at most once per interval (first call immediately, the rest coalesced). */
  trigger(): void;
  cancel(): void;
}

export function createThrottle(
  fn: () => void,
  intervalMs: number,
  clock: () => number,
  setTimer: (cb: () => void, ms: number) => unknown = (cb, ms) => setTimeout(cb, ms),
  clearTimer: (h: unknown) => void = (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
): Throttle {
  let last = -Infinity;
  let timer: unknown = null;

  function fire(): void {
    timer = null;
    last = clock();
    fn();
  }

  return {
    trigger() {
      if (timer !== null) return;
      const wait = last + intervalMs - clock();
      if (wait <= 0) fire();
      else timer = setTimer(fire, wait);
    },
    cancel() {
      if (timer !== null) clearTimer(timer);
      timer = null;
    },
  };
}
