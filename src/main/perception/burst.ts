// Capture bursts: a few frames of one region a fixed interval apart, so motion is
// measured over a fraction of a second instead of across captures minutes apart.
// No Electron dependency, so the timing and clean-up rules are unit-tested.

export interface BurstPlan {
  /** Frames to take, the first one at once (clamped to 1..MAX_BURST_FRAMES). */
  frames: number;
  /** Time from the start of one grab to the start of the next, ms. */
  intervalMs: number;
}

export const MAX_BURST_FRAMES = 5;
const MAX_BURST_INTERVAL_MS = 1000;

export interface BurstClock {
  /** Monotonic clock, ms. */
  now: () => number;
  /** Resolves after `ms`, rejects when `signal` aborts. */
  sleep: (ms: number, signal: AbortSignal) => Promise<void>;
}

export class BurstAbortedError extends Error {
  override name = 'BurstAbortedError';
}

/** Resolves after `ms`, or rejects at once when `signal` aborts. */
export function abortableDelay(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(new BurstAbortedError('capture cancelled'));
      return;
    }
    const onAbort = () => {
      clearTimeout(timer);
      reject(new BurstAbortedError('capture cancelled'));
    };
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, Math.max(0, ms));
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

export const DEFAULT_BURST_CLOCK: BurstClock = { now: () => performance.now(), sleep: abortableDelay };

export interface BurstOptions<T> {
  signal: AbortSignal;
  /** Wipes a frame that will not be returned (failure or cancellation). */
  release: (frame: T) => void;
  /** Asked before each further grab; false ends the burst early with the frames taken so far. */
  stillClear?: () => boolean;
  clock?: Partial<BurstClock>;
}

/**
 * Takes frame 0 at once and frame k no earlier than start + k * intervalMs. Returns the
 * frames taken, oldest first (at least one). When a grab fails or the signal aborts,
 * every frame already taken is released and the error is rethrown.
 */
export async function runBurst<T>(plan: BurstPlan | null | undefined, grab: (index: number) => Promise<T>, opts: BurstOptions<T>): Promise<T[]> {
  const clock: BurstClock = { ...DEFAULT_BURST_CLOCK, ...opts.clock };
  const count = plan && Number.isFinite(plan.frames) ? Math.min(MAX_BURST_FRAMES, Math.max(1, Math.floor(plan.frames))) : 1;
  const interval = plan && Number.isFinite(plan.intervalMs) ? Math.min(MAX_BURST_INTERVAL_MS, Math.max(0, plan.intervalMs)) : 0;
  const frames: T[] = [];
  const start = clock.now();
  try {
    for (let k = 0; k < count; k++) {
      if (k > 0) {
        const wait = start + k * interval - clock.now();
        if (wait > 0) await clock.sleep(wait, opts.signal);
        if (opts.signal.aborted) throw new BurstAbortedError('capture cancelled');
        if (opts.stillClear && !opts.stillClear()) break;
      }
      frames.push(await grab(k));
      if (opts.signal.aborted) throw new BurstAbortedError('capture cancelled');
    }
    return frames;
  } catch (e) {
    for (const f of frames.splice(0)) opts.release(f);
    throw e;
  }
}
