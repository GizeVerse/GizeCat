// Re-reads the view from main at a fixed interval while a page is on screen. Main
// broadcasts only on state changes; values such as uptime and resource samples
// change without one, so pages that show them poll while they are visible.
import type { Timers } from './store';

export const LIVE_REFRESH_MS = 5_000;

export interface LivePoll {
  /** Refreshes now and then every interval until stop(). Calling it again while running does nothing. */
  start(): void;
  stop(): void;
  readonly running: boolean;
}

export interface LivePollOptions {
  timers: Timers;
  refresh: () => Promise<void>;
  /** Checked before every refresh: false skips it (page hidden, window minimised). */
  isVisible: () => boolean;
  intervalMs?: number;
}

export function livePoll(opts: LivePollOptions): LivePoll {
  const intervalMs = opts.intervalMs ?? LIVE_REFRESH_MS;
  let timer: number | null = null;
  let inFlight = false;

  const tick = (): void => {
    timer = opts.timers.setTimeout(tick, intervalMs);
    if (inFlight || !opts.isVisible()) return;
    inFlight = true;
    // A failed read (e.g. rate limited) is retried on the next tick.
    void opts
      .refresh()
      .catch(() => undefined)
      .finally(() => {
        inFlight = false;
      });
  };

  return {
    start() {
      if (timer !== null) return;
      tick();
    },
    stop() {
      if (timer === null) return;
      opts.timers.clearTimeout(timer);
      timer = null;
    },
    get running() {
      return timer !== null;
    },
  };
}
