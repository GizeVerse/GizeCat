// Saving when Windows ends the session (logoff, shutdown, restart). Windows emits
// neither before-quit nor powerMonitor 'shutdown' then; the only signal is
// WM_QUERYENDSESSION / WM_ENDSESSION, which reaches top-level windows only. The
// overlays come and go (crash backoff, display changes, an exhausted recreate
// budget), so main also owns one hidden window that is always there to receive
// them. Every window gets each message, so saves within a short burst are
// coalesced into one. Electron-free.
import type { Logger } from '../contracts';

export type SessionEndKind = 'query-session-end' | 'session-end';

/** A hidden top-level window that reports the session-end messages it receives. */
export interface SessionEndWindow {
  onSessionEnd(listener: (kind: SessionEndKind) => void): void;
  destroy(): void;
}

export interface SessionEndSaverOptions {
  /** Synchronous save of everything (settings, cat, logs). */
  save: () => void;
  logger: Logger;
  /** Creates the hidden receiver window; when this throws, the overlays' own notifications still save. */
  createWindow?: () => SessionEndWindow;
  clock?: () => number;
  /** Notifications within this many ms of a save are the same burst. */
  coalesceMs?: number;
}

export interface SessionEndSaver {
  /** The session may be ending (reported by any window): saves now unless a save just ran. */
  notify(source: string): void;
  /** True while the hidden receiver window exists. */
  readonly watching: boolean;
  dispose(): void;
}

export function createSessionEndSaver(opts: SessionEndSaverOptions): SessionEndSaver {
  const log = opts.logger;
  const clock = opts.clock ?? Date.now;
  const coalesceMs = opts.coalesceMs ?? 1000;
  let lastSaveAt: number | null = null;
  let win: SessionEndWindow | null = null;

  function notify(source: string): void {
    const t = clock();
    if (lastSaveAt !== null && t - lastSaveAt < coalesceMs) return;
    lastSaveAt = t;
    log.info('session may be ending; saving now', { source });
    try {
      opts.save();
    } catch (err) {
      log.error('session-end save failed', { error: err });
    }
  }

  if (opts.createWindow) {
    try {
      const w = opts.createWindow();
      w.onSessionEnd(notify);
      win = w;
    } catch (err) {
      log.error('session-end window unavailable; only overlay windows will report logoff and shutdown', { error: err });
    }
  }

  return {
    notify,
    get watching() {
      return win !== null;
    },
    dispose() {
      const w = win;
      win = null;
      if (!w) return;
      try {
        w.destroy();
      } catch (err) {
        log.warn('destroying the session-end window failed', { error: err });
      }
    },
  };
}
