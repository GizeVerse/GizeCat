// Persistence for the web host (ADR 0004 §8): the cat and a small settings subset in the browser's
// localStorage, validated with the same schemas and recovery as the desktop (migrateCatState,
// migrateSettings). Storage that is missing, blocked (private modes, SecurityError), full
// (QuotaExceededError) or holding corrupt data never stops the cat: it starts fresh (logged) and
// the page keeps working; it simply is not remembered.
//
// The web settings are the defaults with screen analysis and AI forced off; only the cat's name,
// its appearance, the behaviour and interaction values a profile carries (PROFILE_SETTINGS_FIELDS
// in src/shared/profileTransfer.ts: the personality the sheet offers as named presets, whose
// values migrateSettings re-derives the preset from, plus the other carried preferences) and the
// sound switch and volume are stored.
//
// 1.4.0: "Start over" removes both keys (clearAll) after freezing the cat store, so the pagehide
// save cannot write the old cat back before the reload; requestPersistence asks the browser to keep
// the data (navigator.storage.persist, for the installed app). The keys and the format stay v1:
// the additions are read through migrateSettings like everything else. A profile loaded from a file
// ("Take your cat to another device", profileUi.ts) is saved here too, so its preferences survive a
// reload and the next export carries them intact; a custom personality mix from another device is
// kept (the sheet then shows no preset selected).
import { migrateCatState } from '../core/behavior/migrate';
import type { PersistedCat } from '../shared/catState';
import { PROFILE_SETTINGS_FIELDS } from '../shared/profileTransfer';
import { applySettingsPatch, defaultSettings, migrateSettings, SETTINGS_SCHEMA_VERSION, type Settings } from '../shared/settings';
import { PRESET_BEHAVIOR_KEYS, PRESET_INTERACTION_KEYS } from '../shared/settingsPresets';
import type { Logger } from '../main/contracts';

export const CAT_STORAGE_KEY = 'gizecat.web.cat.v1';
export const SETTINGS_STORAGE_KEY = 'gizecat.web.settings.v1';
/** Stored values longer than this are not parsed (treated as corrupt). */
export const MAX_STORED_CHARS = 1024 * 1024;
/** The cat is saved this often while it changed (ms), besides pagehide and a hidden page. */
export const AUTOSAVE_MS = 30_000;
const MAX_FAILURE_LOGS = 3;

/** The slice of the Web Storage API used here (window.localStorage satisfies it). */
export interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  /** Optional in the slice (window.localStorage has it); without it clearAll() reports failure. */
  removeItem?(key: string): void;
}

/** Where the cat came from: the stored one, a new one (nothing stored, or no storage), or a new one replacing unusable data. */
export type CatSource = 'stored' | 'new' | 'recovered';

export interface WebStorageStats {
  saves: number;
  failures: number;
  lastSaveOk: boolean | null;
}

export interface WebStorage {
  readonly available: boolean;
  /** Why storage is unavailable (an error name such as SecurityError), null while it is available. */
  readonly unavailableReason: string | null;
  loadCat(random: () => number, nowEpochMs: number): { cat: PersistedCat; source: CatSource };
  saveCat(cat: PersistedCat): boolean;
  loadSettings(): Settings;
  saveSettings(settings: Settings): boolean;
  /** Removes the stored cat and settings ("Start over"); true when both are gone. */
  clearAll(): boolean;
  readonly stats: Readonly<WebStorageStats>;
}

function errorName(err: unknown): string {
  if (err !== null && typeof err === 'object' && 'name' in err) {
    const name = err.name;
    if (typeof name === 'string') return name;
  }
  return 'Error';
}

/** Screen analysis and AI are never available on the web: forced off whatever was stored (mutates and returns `s`). */
export function forceWebPrivacy(s: Settings): Settings {
  s.perception.visualMode = 'off';
  s.perception.consentAt = null;
  s.ai.provider = 'none';
  s.ai.allowCloud = false;
  return s;
}

/** The listed keys of `section`, arrays copied (the carried behaviour and interaction values). */
function pickKeys(section: Readonly<Record<string, unknown>>, keys: readonly string[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const k of keys) {
    if (!Object.hasOwn(section, k)) continue;
    const v = section[k];
    out[k] = Array.isArray(v) ? [...(v as unknown[])] : v;
  }
  return out;
}

/** Behaviour keys stored on the web: the preset-governed ones and every carried one. */
const STORED_BEHAVIOR_KEYS: readonly string[] = [...new Set<string>([...PRESET_BEHAVIOR_KEYS, ...PROFILE_SETTINGS_FIELDS.behavior])];
const STORED_INTERACTION_KEYS: readonly string[] = [...new Set<string>([...PRESET_INTERACTION_KEYS, ...PROFILE_SETTINGS_FIELDS.interaction])];

/**
 * The web settings: defaults, plus the stored cat name, appearance, carried behaviour and
 * interaction values and sound from `raw` when it is usable. migrateSettings defaults anything
 * missing or invalid, so data without a personality reads as Playful (the defaults are its values);
 * stored values that match a preset select it, and a custom mix (only a loaded profile makes one on
 * the web) is kept, with activityPreset re-derived by applySettingsPatch.
 */
export function webSettings(raw: unknown): Settings {
  let s = defaultSettings();
  if (raw !== null && typeof raw === 'object' && !Array.isArray(raw)) {
    try {
      const stored = migrateSettings(raw);
      s.general.catName = stored.general.catName;
      s.appearance = { ...stored.appearance };
      s.sound.enabled = stored.sound.enabled;
      s.sound.volume = stored.sound.volume;
      const r = applySettingsPatch(s, { behavior: pickKeys(stored.behavior, STORED_BEHAVIOR_KEYS), interaction: pickKeys(stored.interaction, STORED_INTERACTION_KEYS) });
      // Refused (never expected: migrated values are valid): the defaults, Playful, stand.
      if (r.ok) s = r.settings;
    } catch {
      // Unusable: the defaults stand.
      s = defaultSettings();
    }
  }
  return forceWebPrivacy(s);
}

/** What is stored of the settings (a partial settings object migrateSettings reads back). */
export function storedSettings(s: Settings): Record<string, unknown> {
  const behavior: Record<string, unknown> = { activityPreset: s.behavior.activityPreset, ...pickKeys(s.behavior, STORED_BEHAVIOR_KEYS) };
  const interaction = pickKeys(s.interaction, STORED_INTERACTION_KEYS);
  return {
    schemaVersion: SETTINGS_SCHEMA_VERSION,
    general: { catName: s.general.catName },
    appearance: { ...s.appearance },
    behavior,
    interaction,
    sound: { enabled: s.sound.enabled, volume: s.sound.volume },
  };
}

/** Whether the browser keeps this origin's storage: granted, best effort (may be cleared under pressure), or no Storage API. */
export type PersistenceState = 'persisted' | 'best-effort' | 'unavailable';

/** The slice of navigator.storage used here. */
export interface StorageManagerLike {
  persist?: () => Promise<boolean>;
  persisted?: () => Promise<boolean>;
}

/**
 * Asks the browser to keep this origin's data (`ask`: navigator.storage.persist(), granted by the
 * browser's own heuristics; otherwise only reads navigator.storage.persisted()). Never throws.
 */
export async function requestPersistence(manager: StorageManagerLike | null | undefined, ask: boolean): Promise<PersistenceState> {
  if (!manager) return 'unavailable';
  try {
    const fn = ask ? manager.persist : manager.persisted;
    if (typeof fn !== 'function') return 'unavailable';
    return (await fn.call(manager)) === true ? 'persisted' : 'best-effort';
  } catch {
    return 'best-effort';
  }
}

type Read = { status: 'ok'; value: unknown } | { status: 'missing' } | { status: 'corrupt' } | { status: 'error'; reason: string };

/** Opens the store. `access` may throw (reading window.localStorage can raise SecurityError). */
export function openWebStorage(access: () => StorageLike | null | undefined, logger: Logger): WebStorage {
  const log = logger;
  let store: StorageLike | null = null;
  let unavailableReason: string | null = null;
  try {
    store = access() ?? null;
    if (store === null) unavailableReason = 'missing';
    // Some browsers only refuse on first use: one read settles it.
    else store.getItem(SETTINGS_STORAGE_KEY);
  } catch (err) {
    store = null;
    unavailableReason = errorName(err);
  }
  if (store === null) log.warn('browser storage unavailable: the cat will not be remembered', { reason: unavailableReason });
  const stats: WebStorageStats = { saves: 0, failures: 0, lastSaveOk: null };

  function read(key: string): Read {
    if (!store) return { status: 'error', reason: unavailableReason ?? 'missing' };
    let text: string | null;
    try {
      text = store.getItem(key);
    } catch (err) {
      return { status: 'error', reason: errorName(err) };
    }
    if (text === null) return { status: 'missing' };
    if (typeof text !== 'string' || text.length > MAX_STORED_CHARS) return { status: 'corrupt' };
    try {
      return { status: 'ok', value: JSON.parse(text) as unknown };
    } catch {
      return { status: 'corrupt' };
    }
  }

  function write(key: string, value: unknown, what: string): boolean {
    if (!store) return false;
    try {
      store.setItem(key, JSON.stringify(value));
      stats.saves++;
      stats.lastSaveOk = true;
      return true;
    } catch (err) {
      stats.failures++;
      stats.lastSaveOk = false;
      if (stats.failures <= MAX_FAILURE_LOGS || stats.failures % 100 === 0) {
        const reason = errorName(err);
        log.warn(`saving the ${what} failed`, { reason, full: reason === 'QuotaExceededError', count: stats.failures });
      }
      return false;
    }
  }

  return {
    get available() {
      return store !== null;
    },
    get unavailableReason() {
      return unavailableReason;
    },
    loadCat(random, nowEpochMs) {
      const fresh = (): PersistedCat => migrateCatState(null, random, nowEpochMs).cat;
      try {
        const r = read(CAT_STORAGE_KEY);
        if (r.status === 'missing') return { cat: fresh(), source: 'new' };
        if (r.status === 'error') {
          if (store) log.warn('stored cat could not be read: starting a new cat', { reason: r.reason });
          return { cat: fresh(), source: store ? 'recovered' : 'new' };
        }
        if (r.status === 'corrupt') {
          log.warn('stored cat unreadable: starting a new cat');
          return { cat: fresh(), source: 'recovered' };
        }
        const m = migrateCatState(r.value, random, nowEpochMs);
        if (m.recovered) log.warn('stored cat failed validation: starting a new cat');
        return { cat: m.cat, source: m.recovered ? 'recovered' : 'stored' };
      } catch (err) {
        log.warn('loading the cat failed: starting a new cat', { error: err });
        return { cat: fresh(), source: 'recovered' };
      }
    },
    saveCat(cat) {
      return write(CAT_STORAGE_KEY, cat, 'cat');
    },
    loadSettings() {
      const r = read(SETTINGS_STORAGE_KEY);
      if (r.status === 'corrupt') log.warn('stored settings unreadable: using the defaults');
      return webSettings(r.status === 'ok' ? r.value : null);
    },
    saveSettings(settings) {
      return write(SETTINGS_STORAGE_KEY, storedSettings(settings), 'settings');
    },
    clearAll() {
      const s = store;
      if (!s || typeof s.removeItem !== 'function') return false;
      let ok = true;
      for (const key of [CAT_STORAGE_KEY, SETTINGS_STORAGE_KEY]) {
        try {
          s.removeItem(key);
        } catch (err) {
          ok = false;
          log.warn('removing stored data failed', { key, reason: errorName(err) });
        }
      }
      return ok;
    },
    get stats() {
      return { ...stats };
    },
  };
}

export interface WebCatStoreOptions {
  storage: WebStorage;
  /** The live cat (sim.serialize). */
  snapshot: () => PersistedCat;
  logger: Logger;
  autosaveMs?: number;
  setInterval: (fn: () => void, ms: number) => unknown;
  clearInterval: (handle: unknown) => void;
}

/** The catStore the host uses ({ markDirty, save }), plus the synchronous save for pagehide. */
export interface WebCatStore {
  markDirty(): void;
  readonly dirty: boolean;
  save(): Promise<boolean>;
  saveSync(): boolean;
  /** Starts the autosave interval (saves only while dirty). */
  start(): void;
  /**
   * Never saves again (1.4.0, "Start over"): the old cat must not be written back by the pagehide
   * or visibility save between clearing storage and the reload.
   */
  freeze(): void;
  readonly frozen: boolean;
  dispose(): void;
}

export function createWebCatStore(opts: WebCatStoreOptions): WebCatStore {
  const autosaveMs = opts.autosaveMs ?? AUTOSAVE_MS;
  let dirty = false;
  let frozen = false;
  let interval: unknown = null;

  function saveSync(): boolean {
    if (frozen) return false;
    let cat: PersistedCat;
    try {
      cat = opts.snapshot();
    } catch (err) {
      opts.logger.error('cat snapshot failed', { error: err });
      return false;
    }
    const ok = opts.storage.saveCat(cat);
    if (ok) dirty = false;
    return ok;
  }

  return {
    markDirty() {
      dirty = true;
    },
    get dirty() {
      return dirty;
    },
    save: () => Promise.resolve(saveSync()),
    saveSync,
    start() {
      if (interval !== null || frozen) return;
      interval = opts.setInterval(() => {
        if (dirty) saveSync();
      }, autosaveMs);
    },
    freeze() {
      frozen = true;
      dirty = false;
      if (interval !== null) {
        opts.clearInterval(interval);
        interval = null;
      }
    },
    get frozen() {
      return frozen;
    },
    dispose() {
      if (interval === null) return;
      opts.clearInterval(interval);
      interval = null;
    },
  };
}
