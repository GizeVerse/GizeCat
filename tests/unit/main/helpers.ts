import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { Logger } from '../../../src/main/contracts';

export interface LoggedEntry {
  level: 'error' | 'warn' | 'info' | 'debug';
  scope: string;
  msg: string;
  data?: Record<string, unknown>;
}

export function memoryLogger(scope = 'test', sink: LoggedEntry[] = []): Logger & { entries: LoggedEntry[] } {
  const make = (s: string): Logger => ({
    error: (msg, data) => sink.push({ level: 'error', scope: s, msg, data }),
    warn: (msg, data) => sink.push({ level: 'warn', scope: s, msg, data }),
    info: (msg, data) => sink.push({ level: 'info', scope: s, msg, data }),
    debug: (msg, data) => sink.push({ level: 'debug', scope: s, msg, data }),
    child: (sub) => make(`${s}.${sub}`),
  });
  return Object.assign(make(scope), { entries: sink });
}

export function tempDir(prefix = 'dcat-unit-'): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

export function removeDir(dir: string): void {
  fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5 });
}

/** Manually advanced timers for code that accepts injected setTimeout/clearTimeout. */
export function manualTimers() {
  let now = 0;
  let nextId = 1;
  const pending = new Map<number, { at: number; fn: () => void }>();
  return {
    get now() {
      return now;
    },
    setTimeout: (fn: () => void, ms: number): unknown => {
      const id = nextId++;
      pending.set(id, { at: now + Math.max(0, ms), fn });
      return id;
    },
    clearTimeout: (h: unknown): void => {
      pending.delete(h as number);
    },
    get size() {
      return pending.size;
    },
    /** Advances the clock, running due timers in order (including ones they schedule). */
    advance(ms: number): void {
      const end = now + ms;
      for (;;) {
        let best: [number, { at: number; fn: () => void }] | null = null;
        for (const entry of pending) if (entry[1].at <= end && (!best || entry[1].at < best[1].at)) best = entry;
        if (!best) break;
        pending.delete(best[0]);
        now = Math.max(now, best[1].at);
        best[1].fn();
      }
      now = end;
    },
  };
}
