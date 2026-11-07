// Ordered, bounded shutdown: let the cat react to the quit, save synchronously,
// dispose services, then exit. Electron-free so it can be tested with fakes.
// 1.4.0 (macOS, decision D7): expedite() is for logout, restart and shutdown (powerMonitor
// 'shutdown', wired on darwin only): no quit animation, the save at once, and a short disposal
// bound, so the session end never waits on the cat. Without expedite() the sequence is unchanged.
import type { Logger } from '../contracts';

/** Longest disposal of an expedited quit (logout or shutdown). */
export const EXPEDITED_DISPOSE_MS = 500;

export interface QuitSequenceOptions {
  /** Tells the simulation the app is quitting; resolves when it reports quitReady. */
  notifySim: () => Promise<void>;
  saveSync: () => void;
  dispose: () => Promise<void> | void;
  exit: (code: number) => void;
  logger: Logger;
  simTimeoutMs?: number;
  disposeTimeoutMs?: number;
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (handle: unknown) => void;
}

export interface QuitSequence {
  /** Wire to app 'before-quit'. */
  onBeforeQuit(event: { preventDefault(): void }): void;
  /** Starts (or joins) the sequence. */
  run(): Promise<void>;
  /**
   * The session is ending (logout, restart, shutdown): a later or running sequence skips the
   * quit animation (a running wait is cut short), saves at once and bounds disposal at
   * EXPEDITED_DISPOSE_MS. Does not start a quit by itself. Idempotent.
   */
  expedite(): void;
  readonly phase: 'idle' | 'quitting' | 'done';
  readonly expedited: boolean;
}

export function createQuitSequence(opts: QuitSequenceOptions): QuitSequence {
  const log = opts.logger;
  const simTimeoutMs = opts.simTimeoutMs ?? 1500;
  const disposeTimeoutMs = opts.disposeTimeoutMs ?? 1500;
  const setTimer = opts.setTimer ?? ((fn: () => void, ms: number) => setTimeout(fn, ms));
  const clearTimer = opts.clearTimer ?? ((h: unknown) => clearTimeout(h as ReturnType<typeof setTimeout>));
  let phase: 'idle' | 'quitting' | 'done' = 'idle';
  let running: Promise<void> | null = null;
  let expedited = false;
  /** Ends the quit-animation wait early (set only while that wait runs). */
  let cutAnimation: (() => void) | null = null;

  function bounded(p: Promise<void>, ms: number, label: string, onCut?: (cut: () => void) => void): Promise<void> {
    return new Promise<void>((resolve) => {
      let settled = false;
      const settle = (): boolean => {
        if (settled) return false;
        settled = true;
        return true;
      };
      const timer = setTimer(() => {
        if (!settle()) return;
        log.warn(`${label} timed out`, { ms });
        resolve();
      }, ms);
      onCut?.(() => {
        if (!settle()) return;
        clearTimer(timer);
        log.info(`${label} cut short`);
        resolve();
      });
      p.then(
        () => {
          if (!settle()) return;
          clearTimer(timer);
          resolve();
        },
        (err: unknown) => {
          if (!settle()) return;
          clearTimer(timer);
          log.error(`${label} failed`, { error: err });
          resolve();
        },
      );
    });
  }

  async function sequence(): Promise<void> {
    log.info('quit requested', expedited ? { expedited: true } : undefined);
    if (!expedited) {
      let notified: Promise<void>;
      try {
        notified = opts.notifySim();
      } catch (err) {
        notified = Promise.reject(err instanceof Error ? err : new Error(String(err)));
      }
      await bounded(notified, simTimeoutMs, 'quit animation', (cut) => (cutAnimation = cut));
      cutAnimation = null;
    }
    try {
      opts.saveSync();
    } catch (err) {
      log.error('final save failed', { error: err });
    }
    let disposing: Promise<void>;
    try {
      disposing = Promise.resolve(opts.dispose());
    } catch (err) {
      disposing = Promise.reject(err instanceof Error ? err : new Error(String(err)));
    }
    await bounded(disposing, expedited ? Math.min(disposeTimeoutMs, EXPEDITED_DISPOSE_MS) : disposeTimeoutMs, 'service disposal');
    phase = 'done';
    opts.exit(0);
  }

  function run(): Promise<void> {
    if (!running) {
      phase = 'quitting';
      running = sequence();
    }
    return running;
  }

  return {
    onBeforeQuit(event) {
      if (phase === 'done') return;
      event.preventDefault();
      void run();
    },
    run,
    expedite() {
      if (expedited) return;
      expedited = true;
      log.info('quit expedited: the session is ending');
      cutAnimation?.();
    },
    get phase() {
      return phase;
    },
    get expedited() {
      return expedited;
    },
  };
}
