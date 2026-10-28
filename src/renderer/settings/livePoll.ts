// Re-reads the view from main at a fixed interval while a page is on screen. Main
// broadcasts only on state changes; values such as uptime and resource samples
// change without one, so pages that show them poll while they are visible.
import type { PageContext } from './context';
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

/**
 * The poll a page starts in onShow and stops in onHide. It refreshes only while the
 * page element is shown and the window is not minimised.
 */
export function pagePoll(
  ctx: Pick<PageContext, 'timers' | 'refresh'>,
  element: Pick<HTMLElement, 'hidden'>,
  doc: Pick<Document, 'visibilityState'> = document,
): LivePoll {
  return livePoll({
    timers: ctx.timers,
    refresh: () => ctx.refresh(),
    isVisible: () => !element.hidden && doc.visibilityState !== 'hidden',
  });
}
