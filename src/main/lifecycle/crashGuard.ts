// Last line of defence for main-process errors: log, try to save, and if errors
// keep coming, relaunch a bounded number of times before giving up cleanly.
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

function writeRelaunchHistory(file: string, history: number[]): void {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(history));
  } catch {
    /* best effort: worst case we relaunch one time too many */
  }
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
    if (history.length < maxRelaunches) {
      history.push(t);
      writeRelaunchHistory(opts.historyFile, history);
      log('error', 'crash guard: repeated errors, relaunching', { relaunchesInWindow: history.length });
      tryFlush();
      opts.relaunch();
      opts.exit(0);
    } else {
      log('error', 'crash guard: repeated errors and relaunch budget exhausted; exiting', { relaunchesInWindow: history.length });
      tryFlush();
      opts.exit(1);
    }
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
    handle(kind, error) {
      log('error', `main process ${kind}`, { error });
      if (escalated) return;
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
