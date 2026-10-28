// Redacting, levelled logger with a ring buffer (for diagnostics export) and
// batched asynchronous file output with size-based rotation. A failed write is
// retried with backoff (lines are kept, bounded), and the size cap holds even
// when another program keeps the file from being rotated. Electron-free.
import fs from 'node:fs';
import path from 'node:path';
import type { Logger } from '../contracts';
import { redactString, redactValue } from './redact';

export const LOG_LEVELS = ['error', 'warn', 'info', 'debug'] as const;
export type LogLevel = (typeof LOG_LEVELS)[number];
const RANK: Record<LogLevel, number> = { error: 0, warn: 1, info: 2, debug: 3 };

export interface LogEntry {
  at: number;
  level: LogLevel;
  scope: string;
  msg: string;
  data?: unknown;
}

export interface RootLogger extends Logger {
  readonly level: LogLevel;
  setLevel(level: LogLevel): void;
  /** Most recent entries (already redacted), oldest first. */
  recent(limit?: number): LogEntry[];
  /** Entries at warn/error level recorded so far (for health checks and tests). */
  readonly problemCount: { warn: number; error: number };
  flush(): Promise<void>;
  flushSync(): void;
  dispose(): Promise<void>;
  readonly logDir: string | null;
  readonly logFile: string | null;
}

export interface LoggerOptions {
  /** Directory for log files; null keeps logs in memory only. */
  dir: string | null;
  level?: LogLevel;
  fileName?: string;
  maxFileBytes?: number;
  /** Total files kept including the active one (main.log, main.1.log, main.2.log). */
  maxFiles?: number;
  ringSize?: number;
  flushIntervalMs?: number;
  now?: () => number;
  /** Mirror lines to stdout/stderr (dev and test runs). */
  mirror?: (level: LogLevel, line: string) => void;
}

const MAX_PENDING_LINES = 10_000;
/** Waits before retrying the log file after consecutive write failures; the last one repeats. */
const RETRY_DELAYS_MS: readonly number[] = [1_000, 5_000, 30_000, 300_000];

function errCode(err: unknown): string | undefined {
  return err !== null && typeof err === 'object' && 'code' in err && typeof err.code === 'string' ? err.code : undefined;
}

export function formatEntry(e: LogEntry): string {
  const rec: Record<string, unknown> = { t: new Date(e.at).toISOString(), l: e.level, s: e.scope, m: e.msg };
  if (e.data !== undefined) rec.d = e.data;
  try {
    return JSON.stringify(rec);
  } catch {
    return JSON.stringify({ t: rec.t, l: e.level, s: e.scope, m: e.msg, d: '[unserializable]' });
  }
}

export function createLogger(opts: LoggerOptions): RootLogger {
  const now = opts.now ?? Date.now;
  const maxFileBytes = opts.maxFileBytes ?? 1024 * 1024;
  const maxFiles = Math.max(1, opts.maxFiles ?? 3);
  const ringSize = Math.max(1, opts.ringSize ?? 2000);
  const flushIntervalMs = opts.flushIntervalMs ?? 500;
  const fileName = opts.fileName ?? 'main.log';
  let level: LogLevel = opts.level ?? 'info';

  const ring: Array<LogEntry | undefined> = new Array<LogEntry | undefined>(ringSize);
  let ringNext = 0;
  let ringCount = 0;
  const problems = { warn: 0, error: 0 };

  let logDir: string | null = null;
  let logFile: string | null = null;
  let fileSize = 0;
  /** Consecutive failed writes; while > 0, timer flushes wait until retryAt. */
  let failures = 0;
  let retryAt = 0;
  if (opts.dir) {
    try {
      fs.mkdirSync(opts.dir, { recursive: true });
      logDir = opts.dir;
      logFile = path.join(opts.dir, fileName);
      try {
        fileSize = fs.statSync(logFile).size;
      } catch {
        fileSize = 0;
      }
    } catch (err) {
      opts.mirror?.('error', `logger: cannot create log directory: ${String(err)}`);
    }
  }

  let pending: string[] = [];
  let dropped = 0;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let chain: Promise<void> = Promise.resolve();
  let disposed = false;

  const rotatedName = (i: number): string => {
    const ext = path.extname(fileName);
    return path.join(logDir ?? '', `${path.basename(fileName, ext)}.${i}${ext}`);
  };

  function rotateSync(file: string): void {
    try {
      if (maxFiles === 1) {
        fs.rmSync(file, { force: true });
      } else {
        fs.rmSync(rotatedName(maxFiles - 1), { force: true });
        for (let i = maxFiles - 2; i >= 1; i--) {
          try {
            fs.renameSync(rotatedName(i), rotatedName(i + 1));
          } catch {
            /* missing generation */
          }
        }
        fs.renameSync(file, rotatedName(1));
      }
      fileSize = 0;
      return;
    } catch (err) {
      opts.mirror?.('warn', `logger: rotation failed, truncating in place: ${String(err)}`);
    }
    // Another program holds the file open without delete sharing (log viewers, tail
    // tools): keep a copy as the first generation and empty the file in place instead.
    let copied = false;
    try {
      if (maxFiles > 1) {
        try {
          fs.copyFileSync(file, rotatedName(1));
          copied = true;
        } catch (err) {
          opts.mirror?.('warn', `logger: could not keep a copy before truncating: ${String(err)}`);
        }
      }
      fs.truncateSync(file, 0);
      fileSize = 0;
    } catch (err) {
      // The real size stays in force, so roomFor() keeps refusing to grow the file, and
      // the copy (a duplicate of the file still in place) must not count against the cap.
      opts.mirror?.('error', `logger: log file can be neither rotated nor truncated: ${String(err)}`);
      if (copied) {
        try {
          fs.rmSync(rotatedName(1), { force: true });
        } catch {
          /* best effort */
        }
      }
      try {
        fileSize = fs.statSync(file).size;
      } catch {
        /* keep the counted size */
      }
    }
  }

  function takePending(): string[] {
    if (pending.length === 0 && dropped === 0) return [];
    if (dropped > 0) {
      pending.unshift(`${formatEntry({ at: now(), level: 'warn', scope: 'logger', msg: 'log lines dropped', data: { dropped } })}\n`);
      dropped = 0;
    }
    const lines = pending;
    pending = [];
    return lines;
  }

  /** Puts lines that could not be written back in front of newer ones (bounded, oldest dropped first). */
  function requeue(lines: string[]): void {
    pending = lines.concat(pending);
    const excess = pending.length - MAX_PENDING_LINES;
    if (excess > 0) {
      pending.splice(0, excess);
      dropped += excess;
    }
  }

  /**
   * Rotates at the size limit. If the file can be neither rotated nor truncated it may
   * grow to at most twice the limit, then writes are refused, so the size cap always holds.
   */
  function roomFor(file: string, bytes: number): boolean {
    if (fileSize > 0 && fileSize + bytes > maxFileBytes) rotateSync(file);
    return fileSize === 0 || fileSize + bytes <= maxFileBytes * 2;
  }

  function wrote(bytes: number): void {
    fileSize += bytes;
    if (failures === 0) return;
    const failedAttempts = failures;
    failures = 0;
    retryAt = 0;
    record('warn', 'logger', 'log file writes failed and have resumed', { failedAttempts });
  }

  /** Never gives up for good: a transient lock (antivirus, indexer) must not end file logging for the session. */
  function writeFailed(lines: string[], err: unknown): void {
    failures++;
    retryAt = now() + (RETRY_DELAYS_MS[Math.min(failures, RETRY_DELAYS_MS.length) - 1] ?? 0);
    requeue(lines);
    if (failures === 1) opts.mirror?.('error', `logger: log file write failed; will retry: ${String(err)}`);
    scheduleFlush();
  }

  async function appendAsync(file: string, batch: string): Promise<void> {
    try {
      await fs.promises.appendFile(file, batch, 'utf8');
    } catch (err) {
      if (errCode(err) !== 'ENOENT' || !logDir) throw err;
      // The logs folder was deleted while running: recreate it.
      await fs.promises.mkdir(logDir, { recursive: true });
      fileSize = 0;
      await fs.promises.appendFile(file, batch, 'utf8');
    }
  }

  function appendSync(file: string, batch: string): void {
    try {
      fs.appendFileSync(file, batch, 'utf8');
    } catch (err) {
      if (errCode(err) !== 'ENOENT' || !logDir) throw err;
      fs.mkdirSync(logDir, { recursive: true });
      fileSize = 0;
      fs.appendFileSync(file, batch, 'utf8');
    }
  }

  async function writeBatch(lines: string[]): Promise<void> {
    if (!logFile) return;
    const batch = lines.join('');
    const bytes = Buffer.byteLength(batch);
    if (!roomFor(logFile, bytes)) {
      writeFailed(lines, new Error('log file is full and cannot be rotated'));
      return;
    }
    try {
      await appendAsync(logFile, batch);
      wrote(bytes);
    } catch (err) {
      writeFailed(lines, err);
    }
  }

  function scheduleFlush(): void {
    if (timer || disposed || !logFile) return;
    const delay = failures > 0 ? Math.max(flushIntervalMs, retryAt - now()) : flushIntervalMs;
    timer = setTimeout(() => {
      timer = null;
      void flushAsync(false);
    }, delay);
    timer.unref?.();
  }

  /** force: write now even while waiting to retry after a failure (explicit flush, dispose). */
  function flushAsync(force: boolean): Promise<void> {
    chain = chain
      .then(async () => {
        if (!force && failures > 0 && now() < retryAt) {
          scheduleFlush();
          return;
        }
        const lines = takePending();
        if (lines.length > 0) await writeBatch(lines);
      })
      .catch(() => undefined);
    return chain;
  }

  function flush(): Promise<void> {
    return flushAsync(true);
  }

  /** Shutdown, suspend and crash paths: always tries the file, even while waiting to retry. */
  function flushSync(): void {
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
    if (!logFile) return;
    const lines = takePending();
    if (lines.length === 0) return;
    const batch = lines.join('');
    const bytes = Buffer.byteLength(batch);
    if (!roomFor(logFile, bytes)) {
      writeFailed(lines, new Error('log file is full and cannot be rotated'));
      return;
    }
    try {
      appendSync(logFile, batch);
      wrote(bytes);
    } catch (err) {
      writeFailed(lines, err);
    }
  }

  function record(lvl: LogLevel, scope: string, msg: string, data: Record<string, unknown> | undefined): void {
    if (RANK[lvl] > RANK[level]) return;
    if (lvl === 'warn') problems.warn++;
    if (lvl === 'error') problems.error++;
    const entry: LogEntry = { at: now(), level: lvl, scope, msg: redactString(String(msg)) };
    if (data !== undefined) entry.data = redactValue(data);
    ring[ringNext] = entry;
    ringNext = (ringNext + 1) % ringSize;
    ringCount = Math.min(ringCount + 1, ringSize);
    const line = formatEntry(entry);
    opts.mirror?.(lvl, line);
    if (!logFile || disposed) return;
    if (pending.length >= MAX_PENDING_LINES) {
      pending.shift();
      dropped++;
    }
    pending.push(`${line}\n`);
    scheduleFlush();
  }

  function make(scope: string): Logger {
    return {
      error: (msg, data) => record('error', scope, msg, data),
      warn: (msg, data) => record('warn', scope, msg, data),
      info: (msg, data) => record('info', scope, msg, data),
      debug: (msg, data) => record('debug', scope, msg, data),
      child: (sub) => make(scope ? `${scope}.${sub}` : sub),
    };
  }

  const root = make('app');
  return {
    ...root,
    get level() {
      return level;
    },
    setLevel(l: LogLevel) {
      level = l;
    },
    recent(limit = ringSize) {
      const n = Math.min(Math.max(0, limit), ringCount);
      const out: LogEntry[] = [];
      for (let i = ringCount - n; i < ringCount; i++) {
        const idx = (ringNext - ringCount + i + ringSize) % ringSize;
        const e = ring[idx];
        if (e) out.push(e);
      }
      return out;
    },
    get problemCount() {
      return { ...problems };
    },
    flush,
    flushSync,
    async dispose() {
      if (timer) {
        clearTimeout(timer);
        timer = null;
      }
      await flush();
      disposed = true;
      // A failed final write schedules a retry; nothing may run after dispose.
      if (timer) {
        clearTimeout(timer);
        timer = null;
      }
    },
    logDir,
    logFile,
  };
}
