// In-memory settings with validated patches, change notification and debounced
// persistence through an atomic JSON store. Electron-free.
import type { Logger, Unsubscribe } from '../contracts';
import { applySettingsPatch, migrateSettings, type PatchResult, type Settings, type SettingsPatch } from '../../shared/settings';
import type { JsonReadStatus, JsonStore } from './jsonStore';

export type SettingsListener = (next: Settings, prev: Settings) => void;

export interface SettingsStore {
  /** Loads from disk (sync). Safe to call before Electron is ready. */
  load(): { settings: Settings; status: JsonReadStatus };
  get(): Settings;
  /** Validated patch from any source; invalid patches change nothing. */
  patch(patch: SettingsPatch): PatchResult;
  /** Same as patch() for payloads that have not been type-checked (IPC). */
  patchUnknown(patch: unknown): PatchResult;
  onChange(cb: SettingsListener): Unsubscribe;
  /** Writes pending changes now (sync). */
  flushSync(): void;
  /** Writes pending changes now (async). */
  flush(): Promise<void>;
  readonly dirty: boolean;
  dispose(): void;
}

export interface SettingsStoreOptions {
  store: JsonStore;
  logger: Logger;
  debounceMs?: number;
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (handle: unknown) => void;
}

/**
 * Settings taken from the .bak copy (the main file did not parse, or could not be read)
 * are one save older than what the user last chose, and the newer file that would say
 * otherwise is unusable, so they may predate a consent revocation or "Allow cloud
 * processing" being switched off. Restoring consent from them would fail open, so screen
 * analysis needs a fresh opt-in; everything else is restored as it was.
 */
function withoutPerceptionConsent(s: Settings): Settings {
  return { ...s, perception: { ...s.perception, visualMode: 'off', consentAt: null }, ai: { ...s.ai, allowCloud: false } };
}

export function createSettingsStore(opts: SettingsStoreOptions): SettingsStore {
  const debounceMs = opts.debounceMs ?? 500;
  const setTimer = opts.setTimer ?? ((fn: () => void, ms: number) => setTimeout(fn, ms));
  const clearTimer = opts.clearTimer ?? ((h: unknown) => clearTimeout(h as ReturnType<typeof setTimeout>));
  const log = opts.logger;

  let current: Settings = migrateSettings({});
  let dirty = false;
  /**
   * An async write has taken the pending change (dirty is already false) but has not
   * committed it yet. That change counts as unsaved: the session may end before it lands.
   */
  let unconfirmed = false;
  /** Bumped by every successful synchronous write, which supersedes an async write in flight. */
  let syncWrites = 0;
  let timer: unknown = null;
  let disposed = false;
  let chain: Promise<void> = Promise.resolve();
  const listeners = new Set<SettingsListener>();

  function cancelTimer(): void {
    if (timer !== null) {
      clearTimer(timer);
      timer = null;
    }
  }

  function schedule(): void {
    if (disposed) return;
    cancelTimer();
    timer = setTimer(() => {
      timer = null;
      void flush();
    }, debounceMs);
  }

  /** Writes are chained so flush() also waits for a write the debounce timer already started. */
  function flush(): Promise<void> {
    cancelTimer();
    chain = chain.then(async () => {
      if (!dirty) return;
      dirty = false;
      unconfirmed = true;
      const syncBefore = syncWrites;
      const ok = await opts.store.write(current).catch(() => false);
      // A synchronous write in the meantime already saved everything this one carried.
      if (syncWrites !== syncBefore) return;
      unconfirmed = false;
      if (!ok) {
        dirty = true;
        log.warn('settings save failed; will retry on next change or shutdown');
      }
    });
    return chain;
  }

  function flushSync(): void {
    cancelTimer();
    // An async write still in flight may never commit when the session ends now, so
    // write synchronously; the store's generation check turns its late commit into a no-op.
    if (!dirty && !unconfirmed) return;
    if (!opts.store.writeSync(current)) return;
    dirty = false;
    unconfirmed = false;
    syncWrites++;
  }

  function apply(patch: unknown): PatchResult {
    const result = applySettingsPatch(current, patch);
    if (!result.ok) return result;
    const prev = current;
    if (JSON.stringify(prev) === JSON.stringify(result.settings)) return result;
    current = result.settings;
    dirty = true;
    schedule();
    for (const cb of [...listeners]) {
      try {
        cb(current, prev);
      } catch (err) {
        log.error('settings listener failed', { error: err });
      }
    }
    return result;
  }

  return {
    load() {
      const r = opts.store.read();
      current = migrateSettings(r.value);
      if (r.status === 'recovered-backup' || r.status === 'unreadable') {
        const restricted = withoutPerceptionConsent(current);
        if (JSON.stringify(restricted) !== JSON.stringify(current)) log.warn('screen analysis consent reset after restoring settings from a copy');
        current = restricted;
      }
      if (r.status === 'corrupt' || r.status === 'recovered-backup') {
        log.warn('settings file was unreadable', { status: r.status });
        // Persist the recovered/default settings so the next start reads a valid file.
        dirty = true;
      } else if (r.status === 'unreadable') {
        // The file may be fine and only locked; it is left untouched for this session.
        log.warn('settings file could not be read; changes this session will not be saved', { status: r.status });
      }
      return { settings: current, status: r.status };
    },
    get: () => current,
    patch: (patch) => apply(patch),
    patchUnknown: (patch) => apply(patch),
    onChange(cb) {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
    flushSync,
    flush,
    get dirty() {
      return dirty || unconfirmed;
    },
    dispose() {
      cancelTimer();
      disposed = true;
      listeners.clear();
    },
  };
}
