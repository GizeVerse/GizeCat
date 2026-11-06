// Console logger for the web host (the Logger contract of src/main/contracts.ts). Warnings and
// errors go to the console; info and debug only when `verbose`. Data is passed through as given:
// nothing the host logs contains page content, and nothing leaves the page.
import type { Logger } from '../main/contracts';

export interface ConsoleLike {
  error(...args: unknown[]): void;
  warn(...args: unknown[]): void;
  info(...args: unknown[]): void;
  debug(...args: unknown[]): void;
}

export function createWebLogger(sink: ConsoleLike, verbose: boolean, scope = 'gizecat'): Logger {
  const out = (level: 'error' | 'warn' | 'info' | 'debug', s: string, msg: string, data?: Record<string, unknown>): void => {
    if (!verbose && (level === 'info' || level === 'debug')) return;
    try {
      if (data === undefined) sink[level](`[${s}] ${msg}`);
      else sink[level](`[${s}] ${msg}`, data);
    } catch {
      // Logging must never throw into the host.
    }
  };
  const make = (s: string): Logger => ({
    error: (msg, data) => out('error', s, msg, data),
    warn: (msg, data) => out('warn', s, msg, data),
    info: (msg, data) => out('info', s, msg, data),
    debug: (msg, data) => out('debug', s, msg, data),
    child: (sub) => make(`${s}.${sub}`),
  });
  return make(scope);
}
