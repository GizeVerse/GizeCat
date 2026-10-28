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

export function createSettingsStore(opts: SettingsStoreOptions): SettingsStore {
  const debounceMs = opts.debounceMs ?? 500;
  const setTimer = opts.setTimer ?? ((fn: () => void, ms: number) => setTimeout(fn, ms));
  const clearTimer = opts.clearTimer ?? ((h: unknown) => clearTimeout(h as ReturnType<typeof setTimeout>));
  const log = opts.logger;

  let current: Settings = migrateSettings({});
  let dirty = false;
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
      const ok = await opts.store.write(current);
      if (!ok) {
        dirty = true;
        log.warn('settings save failed; will retry on next change or shutdown');
      }
    });
    return chain;
  }

  function flushSync(): void {
    cancelTimer();
    if (!dirty) return;
    if (opts.store.writeSync(current)) dirty = false;
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
      if (r.status === 'corrupt' || r.status === 'recovered-backup') {
        log.warn('settings file was unreadable', { status: r.status });
        // Persist the recovered/default settings so the next start reads a valid file.
        dirty = true;
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
      return dirty;
    },
    dispose() {
      cancelTimer();
      disposed = true;
      listeners.clear();
    },
  };
}
