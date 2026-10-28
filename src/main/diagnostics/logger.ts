// Redacting, levelled logger with a ring buffer (for diagnostics export) and
// batched asynchronous file output with size-based rotation. Electron-free.
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
  let fileBroken = false;
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

  function rotateSync(): void {
    if (!logFile) return;
    try {
      if (maxFiles === 1) {
        fs.rmSync(logFile, { force: true });
      } else {
        fs.rmSync(rotatedName(maxFiles - 1), { force: true });
        for (let i = maxFiles - 2; i >= 1; i--) {
          try {
            fs.renameSync(rotatedName(i), rotatedName(i + 1));
          } catch {
            /* missing generation */
          }
        }
        fs.renameSync(logFile, rotatedName(1));
      }
    } catch (err) {
      opts.mirror?.('warn', `logger: rotation failed: ${String(err)}`);
    }
    fileSize = 0;
  }

  function takePending(): string {
    if (pending.length === 0 && dropped === 0) return '';
    if (dropped > 0) {
      pending.unshift(
        `${formatEntry({ at: now(), level: 'warn', scope: 'logger', msg: 'log lines dropped (writer backlog)', data: { dropped } })}\n`,
      );
      dropped = 0;
    }
    const batch = pending.join('');
    pending = [];
    return batch;
  }

  function prepareWrite(bytes: number): void {
    if (fileSize > 0 && fileSize + bytes > maxFileBytes) rotateSync();
  }

  async function writeBatch(batch: string): Promise<void> {
    if (!logFile || fileBroken) return;
    const bytes = Buffer.byteLength(batch);
    prepareWrite(bytes);
    try {
      await fs.promises.appendFile(logFile, batch, 'utf8');
      fileSize += bytes;
    } catch (err) {
      fileBroken = true;
      opts.mirror?.('error', `logger: file logging disabled after write failure: ${String(err)}`);
    }
  }

  function scheduleFlush(): void {
    if (timer || disposed || !logFile) return;
    timer = setTimeout(() => {
      timer = null;
      void flush();
    }, flushIntervalMs);
    timer.unref?.();
  }

  function flush(): Promise<void> {
    chain = chain
      .then(async () => {
        const batch = takePending();
        if (batch) await writeBatch(batch);
      })
      .catch(() => undefined);
    return chain;
  }

  function flushSync(): void {
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
    const batch = takePending();
    if (!batch || !logFile || fileBroken) return;
    const bytes = Buffer.byteLength(batch);
    prepareWrite(bytes);
    try {
      fs.appendFileSync(logFile, batch, 'utf8');
      fileSize += bytes;
    } catch (err) {
      fileBroken = true;
      opts.mirror?.('error', `logger: sync write failed: ${String(err)}`);
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
    if (!logFile || fileBroken || disposed) return;
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
    },
    logDir,
    logFile,
  };
}
