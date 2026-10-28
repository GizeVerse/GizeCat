// Last line of defence for main-process errors: log, try to save, and if errors
// keep coming, relaunch a bounded number of times before giving up cleanly. It
// fails safe (exit, no relaunch) before startup has finished and whenever the
// relaunch budget cannot be recorded.
import fs from 'node:fs';
import path from 'node:path';
import type { Logger } from '../contracts';

export interface CrashGuardOptions {
  /** File remembering recent relaunches (epoch ms list), survives the restart. */
  historyFile: string;
  now?: () => number;
  relaunch: () => void;
  exit: (code: number) => void;
  errorWindowMs?: number;
  /** Escalate when more than this many errors happen within errorWindowMs. */
  maxErrors?: number;
  relaunchWindowMs?: number;
  maxRelaunches?: number;
}

export interface CrashGuard {
  setLogger(logger: Logger): void;
  /** Best-effort synchronous state save run on every caught error. */
  setSaver(save: () => void): void;
  /** Flushes logs before exit/relaunch. */
  setFlusher(flush: () => void): void;
  /**
   * The app has finished starting (tray, overlays). Before this, any uncaught error is
   * fatal: a process that never finished starting has no window or tray, yet it holds
   * the single-instance lock, so every later launch would exit silently.
   */
  setStarted(): void;
  handle(kind: 'uncaughtException' | 'unhandledRejection', error: unknown): void;
  readonly escalated: boolean;
}

export function readRelaunchHistory(file: string): number[] {
  try {
    const raw: unknown = JSON.parse(fs.readFileSync(file, 'utf8'));
    return Array.isArray(raw) ? raw.filter((v): v is number => typeof v === 'number' && Number.isFinite(v)) : [];
  } catch {
    return [];
  }
}

/**
 * The relaunch budget lives only in this file, so it counts as saved only when the next
 * process will read it back: otherwise every new process would see an empty history.
 */
function writeRelaunchHistory(file: string, history: number[]): boolean {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(history));
  } catch {
    return false;
  }
  return JSON.stringify(readRelaunchHistory(file)) === JSON.stringify(history);
}

export function createCrashGuard(opts: CrashGuardOptions): CrashGuard {
  const now = opts.now ?? Date.now;
  const errorWindowMs = opts.errorWindowMs ?? 60_000;
  const maxErrors = opts.maxErrors ?? 3;
  const relaunchWindowMs = opts.relaunchWindowMs ?? 10 * 60_000;
  const maxRelaunches = opts.maxRelaunches ?? 3;

  let logger: Logger | null = null;
  let saver: (() => void) | null = null;
  let flusher: (() => void) | null = null;
  let recent: number[] = [];
  let escalated = false;
  let started = false;

  function log(level: 'error' | 'warn', msg: string, data?: Record<string, unknown>): void {
    try {
      if (logger) logger[level](msg, data);
      else console.error(msg, data ?? '');
    } catch {
      /* logging must never throw from here */
    }
  }

  function trySave(): void {
    try {
      saver?.();
    } catch (err) {
      log('error', 'crash guard: save failed', { error: err });
    }
  }

  function tryFlush(): void {
    try {
      flusher?.();
    } catch {
      /* nothing left to do */
    }
  }

  function escalate(): void {
    escalated = true;
    const t = now();
    const history = readRelaunchHistory(opts.historyFile).filter((at) => t - at < relaunchWindowMs);
    if (history.length >= maxRelaunches) {
      log('error', 'crash guard: repeated errors and relaunch budget exhausted; exiting', { relaunchesInWindow: history.length });
      tryFlush();
      opts.exit(1);
      return;
    }
    history.push(t);
    if (!writeRelaunchHistory(opts.historyFile, history)) {
      // Without a recorded relaunch the budget would never run out: fail safe instead of looping.
      log('error', 'crash guard: repeated errors and the relaunch history cannot be saved; exiting');
      tryFlush();
      opts.exit(1);
      return;
    }
    log('error', 'crash guard: repeated errors, relaunching', { relaunchesInWindow: history.length });
    tryFlush();
    opts.relaunch();
    opts.exit(0);
  }

  return {
    setLogger(l) {
      logger = l;
    },
    setSaver(fn) {
      saver = fn;
    },
    setFlusher(fn) {
      flusher = fn;
    },
    setStarted() {
      started = true;
    },
    handle(kind, error) {
      log('error', `main process ${kind}`, { error });
      if (escalated) return;
      if (!started) {
        escalated = true;
        log('error', 'crash guard: error before startup finished; exiting');
        tryFlush();
        opts.exit(1);
        return;
      }
      trySave();
      const t = now();
      recent = recent.filter((at) => t - at < errorWindowMs);
      recent.push(t);
      if (recent.length > maxErrors) escalate();
    },
    get escalated() {
      return escalated;
    },
  };
}
