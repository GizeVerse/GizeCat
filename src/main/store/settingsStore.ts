// In-memory settings with validated patches, change notification and debounced
// persistence through an atomic JSON store. Electron-free.
import path from 'node:path';
import type { Logger, Unsubscribe } from '../contracts';
import { applySettingsPatch, migrateSettings, type PatchResult, type Settings, type SettingsPatch } from '../../shared/settings';
import { createJsonStore, type JsonReadStatus, type JsonStore } from './jsonStore';
import { optOutSidecarFile, optOutSidecarPath, readOptOutSidecar, sameOptOuts, unionOptOuts } from './optOutSidecar';

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
  /**
   * v1.2 downgrade-proof copy of behavior.disabledExtras (ADR 0003 §9.3, optOutSidecar.ts).
   * Default: behavior-opt-outs.json next to the settings file when that is a real path on disk;
   * null: no sidecar.
   */
  optOutSidecar?: JsonStore | null;
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

function defaultSidecar(opts: SettingsStoreOptions): JsonStore | null {
  if (opts.optOutSidecar !== undefined) return opts.optOutSidecar;
  // In-memory and relative test stores have no folder to share.
  if (!path.isAbsolute(opts.store.filePath)) return null;
  return createJsonStore({ filePath: optOutSidecarPath(opts.store.filePath), logger: opts.logger });
}

export function createSettingsStore(opts: SettingsStoreOptions): SettingsStore {
  const debounceMs = opts.debounceMs ?? 500;
  const setTimer = opts.setTimer ?? ((fn: () => void, ms: number) => setTimeout(fn, ms));
  const clearTimer = opts.clearTimer ?? ((h: unknown) => clearTimeout(h as ReturnType<typeof setTimeout>));
  const log = opts.logger;
  const sidecar = defaultSidecar(opts);

  let current: Settings = migrateSettings({});
  let dirty = false;
  /**
   * An async write has taken the pending change (dirty is already false) but has not
   * committed it yet. That change counts as unsaved: the session may end before it lands.
   */
  let unconfirmed = false;
  /** Bumped by every successful synchronous write, which supersedes an async write in flight. */
  let syncWrites = 0;
  /** The same three for the opt-out sidecar, which always mirrors current.behavior.disabledExtras. */
  let sidecarDirty = false;
  let sidecarUnconfirmed = false;
  let sidecarSyncWrites = 0;
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

  /**
   * Written after the settings file. A session that ends between the two writes keeps every
   * opt-out (the next load takes the union); at worst a re-enable from the last moments is undone.
   */
  async function writeSidecar(): Promise<void> {
    if (!sidecar || !sidecarDirty) return;
    sidecarDirty = false;
    sidecarUnconfirmed = true;
    const syncBefore = sidecarSyncWrites;
    const ok = await sidecar.write(optOutSidecarFile(current.behavior.disabledExtras)).catch(() => false);
    if (sidecarSyncWrites !== syncBefore) return;
    sidecarUnconfirmed = false;
    if (!ok) {
      sidecarDirty = true;
      log.warn('opt-out sidecar save failed; will retry on next change or shutdown');
    }
  }

  function writeSidecarSync(): void {
    if (!sidecar || (!sidecarDirty && !sidecarUnconfirmed)) return;
    if (!sidecar.writeSync(optOutSidecarFile(current.behavior.disabledExtras))) return;
    sidecarDirty = false;
    sidecarUnconfirmed = false;
    sidecarSyncWrites++;
  }

  async function writeSettings(): Promise<void> {
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
  }

  /** Writes are chained so flush() also waits for a write the debounce timer already started. */
  function flush(): Promise<void> {
    cancelTimer();
    chain = chain.then(async () => {
      await writeSettings();
      await writeSidecar();
    });
    return chain;
  }

  function writeSettingsSync(): void {
    // An async write still in flight may never commit when the session ends now, so
    // write synchronously; the store's generation check turns its late commit into a no-op.
    if (!dirty && !unconfirmed) return;
    if (!opts.store.writeSync(current)) return;
    dirty = false;
    unconfirmed = false;
    syncWrites++;
  }

  function flushSync(): void {
    cancelTimer();
    writeSettingsSync();
    writeSidecarSync();
  }

  function apply(patch: unknown): PatchResult {
    const result = applySettingsPatch(current, patch);
    if (!result.ok) return result;
    const prev = current;
    if (JSON.stringify(prev) === JSON.stringify(result.settings)) return result;
    current = result.settings;
    dirty = true;
    // A patch is the only way an id leaves the list (the user switched it back on).
    if (!sameOptOuts(prev.behavior.disabledExtras, current.behavior.disabledExtras)) sidecarDirty = true;
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

  /**
   * The effective v1.2 opt-outs are the union of the settings list and the sidecar (a 1.1.1 save
   * in between dropped them from the settings file); the sidecar is then brought up to the union.
   */
  function loadOptOuts(settingsStatus: JsonReadStatus): void {
    if (!sidecar) return;
    const sr = sidecar.read();
    const saved = readOptOutSidecar(sr.value);
    const own = current.behavior.disabledExtras;
    const union = unionOptOuts(own, saved);
    if (!sameOptOuts(union, own)) {
      current = { ...current, behavior: { ...current.behavior, disabledExtras: union } };
      log.info('restored switched-off behaviours from the opt-out copy', { restored: union.length - own.length });
      // Persisted with the next save (as for a recovered file); a locked settings file stays untouched.
      if (settingsStatus !== 'unreadable') dirty = true;
    }
    if (!sameOptOuts(saved, union)) sidecarDirty = true;
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
      loadOptOuts(r.status);
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
      return dirty || unconfirmed || sidecarDirty || sidecarUnconfirmed;
    },
    dispose() {
      cancelTimer();
      disposed = true;
      listeners.clear();
    },
  };
}
