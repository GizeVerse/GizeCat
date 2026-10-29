// The main thread's DPI awareness for the surface diagnostics, read from the line the Win32
// facade logs once at boot ('thread DPI awareness', src/main/win32/win32Api.ts). The facade
// does not expose the value, so createWin32Api gets a logger that forwards everything
// unchanged and notes that one value on the way, whatever the configured log level.
import type { Logger } from '../contracts';

/** Messages win32Api.ts logs with { awareness } right after loading user32. */
export const DPI_AWARENESS_MESSAGES: ReadonlySet<string> = new Set([
  'thread DPI awareness',
  'thread is not per-monitor DPI aware; Win32 coordinates may be virtualised',
]);

/**
 * DPI_AWARENESS of the calling thread (GetAwarenessFromDpiAwarenessContext) as text. That API
 * reports per-monitor v1 and v2 alike as 2, so the text says 'per-monitor' only.
 */
export function describeDpiAwareness(value: unknown): string {
  if (value === 2) return 'per-monitor';
  if (value === 1) return 'system';
  if (value === 0) return 'unaware';
  if (typeof value === 'number' && Number.isFinite(value)) return `unknown (${value})`;
  return 'unknown';
}

/** A logger that behaves exactly like `logger` and reports the boot DPI awareness line to `onAwareness`. */
export function watchDpiAwareness(logger: Logger, onAwareness: (awareness: string) => void): Logger {
  const note = (msg: string, data: Record<string, unknown> | undefined): void => {
    if (!DPI_AWARENESS_MESSAGES.has(msg)) return;
    try {
      onAwareness(describeDpiAwareness(data?.awareness));
    } catch {
      // Diagnostics only: never let it break logging.
    }
  };
  const wrap = (l: Logger): Logger => ({
    error: (msg, data) => l.error(msg, data),
    warn: (msg, data) => {
      note(msg, data);
      l.warn(msg, data);
    },
    info: (msg, data) => {
      note(msg, data);
      l.info(msg, data);
    },
    debug: (msg, data) => l.debug(msg, data),
    child: (scope) => wrap(l.child(scope)),
  });
  return wrap(logger);
}
