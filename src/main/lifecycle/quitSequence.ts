// Ordered, bounded shutdown: let the cat react to the quit, save synchronously,
// dispose services, then exit. Electron-free so it can be tested with fakes.
import type { Logger } from '../contracts';

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
  readonly phase: 'idle' | 'quitting' | 'done';
}

export function createQuitSequence(opts: QuitSequenceOptions): QuitSequence {
  const log = opts.logger;
  const simTimeoutMs = opts.simTimeoutMs ?? 1500;
  const disposeTimeoutMs = opts.disposeTimeoutMs ?? 1500;
  const setTimer = opts.setTimer ?? ((fn: () => void, ms: number) => setTimeout(fn, ms));
  const clearTimer = opts.clearTimer ?? ((h: unknown) => clearTimeout(h as ReturnType<typeof setTimeout>));
  let phase: 'idle' | 'quitting' | 'done' = 'idle';
  let running: Promise<void> | null = null;

  function bounded(p: Promise<void>, ms: number, label: string): Promise<void> {
    return new Promise<void>((resolve) => {
      const timer = setTimer(() => {
        log.warn(`${label} timed out`, { ms });
        resolve();
      }, ms);
      p.then(
        () => {
          clearTimer(timer);
          resolve();
        },
        (err: unknown) => {
          clearTimer(timer);
          log.error(`${label} failed`, { error: err });
          resolve();
        },
      );
    });
  }

  async function sequence(): Promise<void> {
    log.info('quit requested');
    let notified: Promise<void>;
    try {
      notified = opts.notifySim();
    } catch (err) {
      notified = Promise.reject(err instanceof Error ? err : new Error(String(err)));
    }
    await bounded(notified, simTimeoutMs, 'quit animation');
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
    await bounded(disposing, disposeTimeoutMs, 'service disposal');
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
    get phase() {
      return phase;
    },
  };
}
