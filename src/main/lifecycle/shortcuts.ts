// Global show/hide shortcut. Registration can fail silently when another app owns
// the accelerator, so the result is reported in the app status.
import type { Logger } from '../contracts';

export interface GlobalShortcutApi {
  register(accelerator: string, callback: () => void): boolean;
  unregister(accelerator: string): void;
  unregisterAll(): void;
}

export interface ShortcutManager {
  /** Applies the desired state; returns whether the toggle shortcut is currently registered. */
  apply(enabled: boolean, accelerator: string): boolean;
  readonly registered: boolean;
  readonly lastError: string | null;
  dispose(): void;
}

export function createShortcutManager(api: GlobalShortcutApi, logger: Logger, onToggle: () => void): ShortcutManager {
  let active: string | null = null;
  let lastError: string | null = null;

  function release(): void {
    if (active === null) return;
    try {
      api.unregister(active);
    } catch (err) {
      logger.warn('unregistering shortcut failed', { error: err });
    }
    active = null;
  }

  return {
    apply(enabled, accelerator) {
      if (!enabled) {
        release();
        lastError = null;
        return false;
      }
      if (active === accelerator) return true;
      release();
      let ok: boolean;
      try {
        ok = api.register(accelerator, () => {
          try {
            onToggle();
          } catch (err) {
            logger.error('shortcut handler failed', { error: err });
          }
        });
      } catch (err) {
        lastError = `Invalid shortcut "${accelerator}"`;
        logger.warn('shortcut rejected', { accelerator, error: err });
        return false;
      }
      if (ok) {
        active = accelerator;
        lastError = null;
        logger.info('shortcut registered', { accelerator });
      } else {
        lastError = `"${accelerator}" is already used by another application`;
        logger.warn('shortcut registration failed (in use by another app?)', { accelerator });
      }
      return ok;
    },
    get registered() {
      return active !== null;
    },
    get lastError() {
      return lastError;
    },
    dispose() {
      active = null;
      try {
        api.unregisterAll();
      } catch (err) {
        logger.warn('unregisterAll failed', { error: err });
      }
    },
  };
}
