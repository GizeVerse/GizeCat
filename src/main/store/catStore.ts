// Persistence of the cat's identity (PersistedCat). Loads with migration and
// corrupt-file recovery; saves periodically while dirty, on request and
// synchronously on shutdown paths. Electron-free.
import type { Logger } from '../contracts';
import type { PersistedCat } from '../../shared/catState';
import type { JsonStore } from './jsonStore';

export type MigrateCatState = (raw: unknown, random: () => number, nowEpochMs: number) => { cat: PersistedCat; recovered: boolean };

export interface CatLoadResult {
  cat: PersistedCat;
  /** True when the stored state was unreadable or invalid and had to be rebuilt or restored from backup. */
  recovered: boolean;
  source: 'file' | 'backup' | 'new';
}

export interface CatStore {
  load(): CatLoadResult;
  /** Provides the live state for periodic and shutdown saves and starts the autosave timer. */
  attach(snapshot: () => PersistedCat): void;
  markDirty(): void;
  readonly dirty: boolean;
  /** Async save of the current snapshot (no-op without attach). */
  save(): Promise<boolean>;
  /** Sync save for quit / suspend / session-end. */
  saveSync(): boolean;
  dispose(): void;
}

export interface CatStoreOptions {
  store: JsonStore;
  migrate: MigrateCatState;
  logger: Logger;
  random: () => number;
  wallClock?: () => number;
  autosaveMs?: number;
  setInterval?: (fn: () => void, ms: number) => unknown;
  clearInterval?: (handle: unknown) => void;
}

export function createCatStore(opts: CatStoreOptions): CatStore {
  const log = opts.logger;
  const wallClock = opts.wallClock ?? Date.now;
  const autosaveMs = opts.autosaveMs ?? 60_000;
  const setIv = opts.setInterval ?? ((fn: () => void, ms: number) => setInterval(fn, ms));
  const clearIv = opts.clearInterval ?? ((h: unknown) => clearInterval(h as ReturnType<typeof setInterval>));

  let snapshot: (() => PersistedCat) | null = null;
  let dirty = false;
  let interval: unknown = null;
  let saving = false;

  function migrate(raw: unknown): { cat: PersistedCat; recovered: boolean } {
    return opts.migrate(raw, opts.random, wallClock());
  }

  function take(): PersistedCat | null {
    if (!snapshot) return null;
    try {
      return snapshot();
    } catch (err) {
      log.error('cat snapshot failed', { error: err });
      return null;
    }
  }

  async function save(): Promise<boolean> {
    const cat = take();
    if (!cat) return false;
    if (saving) {
      // A save is in flight; the newer snapshot is written by the next autosave tick.
      dirty = true;
      return true;
    }
    saving = true;
    dirty = false;
    try {
      const ok = await opts.store.write(cat);
      if (!ok) dirty = true;
      return ok;
    } finally {
      saving = false;
    }
  }

  return {
    load() {
      const r = opts.store.read();
      if (r.status === 'missing') {
        return { ...migrate(null), recovered: false, source: 'new' };
      }
      if (r.status === 'corrupt') {
        log.warn('cat state unreadable and no usable backup; starting a new cat');
        dirty = true;
        return { cat: migrate(null).cat, recovered: true, source: 'new' };
      }
      if (r.status === 'unreadable') {
        // The stored cat may be fine and only locked by another program: the store refuses
        // to overwrite it, so this session runs on the backup (or a stand-in) without saving.
        log.warn('cat state could not be read; this session will not save the cat');
        const fromBak = r.value === null ? null : migrate(r.value);
        if (fromBak && !fromBak.recovered) return { cat: fromBak.cat, recovered: true, source: 'backup' };
        return { cat: migrate(null).cat, recovered: true, source: 'new' };
      }
      const fromFile = migrate(r.value);
      if (r.status === 'recovered-backup') {
        dirty = true;
        return { cat: fromFile.cat, recovered: true, source: 'backup' };
      }
      if (!fromFile.recovered) return { cat: fromFile.cat, recovered: false, source: 'file' };
      // Parseable but invalid: keep a copy for inspection and prefer a valid backup.
      log.warn('cat state failed validation; trying backup');
      opts.store.quarantine();
      dirty = true;
      const bak = opts.store.readBackup();
      if (bak.ok) {
        const fromBak = migrate(bak.value);
        if (!fromBak.recovered) return { cat: fromBak.cat, recovered: true, source: 'backup' };
      }
      return { cat: fromFile.cat, recovered: true, source: 'file' };
    },
    attach(fn) {
      snapshot = fn;
      if (interval === null) {
        interval = setIv(() => {
          if (dirty) void save();
        }, autosaveMs);
      }
    },
    markDirty() {
      dirty = true;
    },
    get dirty() {
      return dirty;
    },
    save,
    saveSync() {
      const cat = take();
      if (!cat) return false;
      const ok = opts.store.writeSync(cat);
      if (ok) dirty = false;
      return ok;
    },
    dispose() {
      if (interval !== null) {
        clearIv(interval);
        interval = null;
      }
    },
  };
}
