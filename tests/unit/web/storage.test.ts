// The web host's localStorage persistence (src/web/storage.ts): valid, corrupt, unavailable and
// full storage; the settings subset with perception and AI forced off.
import { describe, expect, it } from 'vitest';
import { mulberry32 } from '../../../src/core/behavior/random';
import { defaultSettings } from '../../../src/shared/settings';
import { AUTOSAVE_MS, CAT_STORAGE_KEY, createWebCatStore, openWebStorage, SETTINGS_STORAGE_KEY, storedSettings, webSettings, type StorageLike } from '../../../src/web/storage';
import { memoryLogger } from './helpers';

function memoryStorage(init: Record<string, string> = {}): StorageLike & { data: Map<string, string> } {
  const data = new Map(Object.entries(init));
  return {
    data,
    getItem: (k) => data.get(k) ?? null,
    setItem: (k, v) => {
      data.set(k, String(v));
    },
  };
}

const named = (name: string): Error => Object.assign(new Error(name), { name });
const NOW = Date.UTC(2026, 10, 6);

describe('web storage: the cat', () => {
  it('starts a new cat when nothing is stored, and keeps it across a reload', () => {
    const mem = memoryStorage();
    const log = memoryLogger();
    const first = openWebStorage(() => mem, log);
    const a = first.loadCat(mulberry32(1), NOW);
    expect(a.source).toBe('new');
    expect(first.saveCat(a.cat)).toBe(true);
    expect(mem.data.has(CAT_STORAGE_KEY)).toBe(true);
    const again = openWebStorage(() => mem, log).loadCat(mulberry32(2), NOW + 1000);
    expect(again.source).toBe('stored');
    expect(again.cat.catId).toBe(a.cat.catId);
    expect(again.cat.bornAt).toBe(a.cat.bornAt);
    expect(log.entries.filter((e) => e.level === 'warn' || e.level === 'error')).toEqual([]);
  });

  it('replaces corrupt JSON, invalid data and oversized values with a new cat (logged, no throw)', () => {
    for (const bad of ['{not json', JSON.stringify({ hello: 'world' }), JSON.stringify([1, 2]), JSON.stringify({ schemaVersion: 1, catId: 'x' }), `"${'a'.repeat(1024 * 1024 + 8)}"`]) {
      const log = memoryLogger();
      const r = openWebStorage(() => memoryStorage({ [CAT_STORAGE_KEY]: bad }), log).loadCat(mulberry32(3), NOW);
      expect(r.source).toBe('recovered');
      expect(r.cat.catId.length).toBeGreaterThanOrEqual(8);
      expect(log.entries.some((e) => e.level === 'warn')).toBe(true);
    }
  });

  it('runs without storage when it is unavailable (SecurityError, missing, failing reads): a new cat, nothing saved', () => {
    const cases: Array<() => StorageLike | null> = [
      () => {
        throw named('SecurityError');
      },
      () => null,
      () => ({
        getItem: () => {
          throw named('SecurityError');
        },
        setItem: () => undefined,
      }),
    ];
    for (const access of cases) {
      const log = memoryLogger();
      const s = openWebStorage(access, log);
      expect(s.available).toBe(false);
      expect(s.unavailableReason).not.toBeNull();
      const r = s.loadCat(mulberry32(4), NOW);
      expect(r.source).toBe('new');
      expect(s.saveCat(r.cat)).toBe(false);
      expect(s.saveSettings(defaultSettings())).toBe(false);
      expect(s.loadSettings().perception.visualMode).toBe('off');
      expect(log.entries.filter((e) => e.level === 'warn')).toHaveLength(1);
    }
    expect(openWebStorage(cases[0]!, memoryLogger()).unavailableReason).toBe('SecurityError');
  });

  it('survives a full store (QuotaExceededError): the save fails, is counted and logged a bounded number of times', () => {
    const mem = memoryStorage();
    let full = true;
    const store: StorageLike = {
      getItem: mem.getItem,
      setItem: (k, v) => {
        if (full) throw named('QuotaExceededError');
        mem.setItem(k, v);
      },
    };
    const log = memoryLogger();
    const s = openWebStorage(() => store, log);
    const { cat } = s.loadCat(mulberry32(5), NOW);
    for (let i = 0; i < 10; i++) expect(s.saveCat(cat)).toBe(false);
    expect(s.stats).toMatchObject({ failures: 10, saves: 0, lastSaveOk: false });
    const warns = log.entries.filter((e) => e.level === 'warn');
    expect(warns.length).toBe(3);
    expect(warns[0]?.data).toMatchObject({ reason: 'QuotaExceededError', full: true });
    full = false;
    expect(s.saveCat(cat)).toBe(true);
    expect(s.stats.lastSaveOk).toBe(true);
  });

  it('a read that throws after a good start recovers with a new cat', () => {
    let fail = false;
    const mem = memoryStorage();
    const store: StorageLike = {
      getItem: (k) => {
        if (fail) throw named('InvalidStateError');
        return mem.getItem(k);
      },
      setItem: mem.setItem,
    };
    const s = openWebStorage(() => store, memoryLogger());
    fail = true;
    expect(s.loadCat(mulberry32(6), NOW).source).toBe('recovered');
  });
});

describe('web storage: settings', () => {
  it('stores only the cat name, appearance, personality and sound, and reads them back over the defaults', () => {
    const s = defaultSettings();
    s.general.catName = 'Pamuk';
    s.appearance.size = 1.5;
    s.appearance.skin = defaultSettings().appearance.skin;
    s.sound.enabled = true;
    s.sound.volume = 0.7;
    s.behavior.autonomy = 0.1;
    s.behavior.movementSpeed = 1.7;
    const stored = storedSettings(s);
    // 1.4.0: the preset-governed values travel with the preset name (migrateSettings re-derives it from them).
    expect(Object.keys(stored).sort()).toEqual(['appearance', 'behavior', 'general', 'interaction', 'schemaVersion', 'sound']);
    expect(stored.general).toEqual({ catName: 'Pamuk' });
    expect(Object.keys(stored.behavior as object).sort()).toEqual(['activityPreset', 'autonomy', 'cursorPlay', 'exploration', 'heights', 'mischief', 'stayLength', 'workDisruption']);
    expect(Object.keys(stored.interaction as object)).toEqual(['reactionIntensity']);
    const mem = memoryStorage();
    const store = openWebStorage(() => mem, memoryLogger());
    expect(store.saveSettings(s)).toBe(true);
    const back = openWebStorage(() => mem, memoryLogger()).loadSettings();
    expect(back.general.catName).toBe('Pamuk');
    expect(back.appearance.size).toBe(1.5);
    expect(back.sound).toEqual({ enabled: true, volume: 0.7 });
    // A custom mix is not offered on the web: it reads back as Playful (the default values).
    expect(back.behavior.activityPreset).toBe('playful');
    expect(back.behavior.autonomy).toBe(defaultSettings().behavior.autonomy);
    // Not stored at all: the default stands.
    expect(back.behavior.movementSpeed).toBe(defaultSettings().behavior.movementSpeed);
  });

  it('forces screen analysis and AI off whatever is stored', () => {
    const raw = {
      schemaVersion: 3,
      perception: { visualMode: 'ai', consentAt: '2026-01-01T00:00:00.000Z' },
      ai: { provider: 'anthropic', allowCloud: true },
      general: { catName: 'Tarçın' },
    };
    const mem = memoryStorage({ [SETTINGS_STORAGE_KEY]: JSON.stringify(raw) });
    const s = openWebStorage(() => mem, memoryLogger()).loadSettings();
    expect(s.perception.visualMode).toBe('off');
    expect(s.perception.consentAt).toBeNull();
    expect(s.ai.provider).toBe('none');
    expect(s.ai.allowCloud).toBe(false);
    expect(s.general.catName).toBe('Tarçın');
  });

  it('uses the defaults for corrupt or invalid stored settings', () => {
    for (const bad of ['nope{', '42', 'null', JSON.stringify({ general: { catName: '' }, sound: { volume: 9 } })]) {
      const log = memoryLogger();
      const s = openWebStorage(() => memoryStorage({ [SETTINGS_STORAGE_KEY]: bad }), log).loadSettings();
      expect(s.general.catName).toBe(defaultSettings().general.catName);
      expect(s.sound.volume).toBe(defaultSettings().sound.volume);
    }
    expect(webSettings(undefined)).toEqual(webSettings(null));
  });
});

describe('web cat store', () => {
  it('autosaves only while dirty, saves synchronously on demand, and never throws on a failing snapshot', async () => {
    const intervals: Array<{ fn: () => void; ms: number }> = [];
    const mem = memoryStorage();
    const storage = openWebStorage(() => mem, memoryLogger());
    const { cat } = storage.loadCat(mulberry32(7), NOW);
    let fail = false;
    const log = memoryLogger();
    const store = createWebCatStore({
      storage,
      snapshot: () => {
        if (fail) throw new Error('snapshot');
        return cat;
      },
      logger: log,
      setInterval: (fn, ms) => {
        intervals.push({ fn, ms });
        return intervals.length;
      },
      clearInterval: () => undefined,
    });
    store.start();
    store.start();
    expect(intervals).toHaveLength(1);
    expect(intervals[0]?.ms).toBe(AUTOSAVE_MS);
    intervals[0]?.fn();
    expect(storage.stats.saves).toBe(0);
    store.markDirty();
    intervals[0]?.fn();
    expect(storage.stats.saves).toBe(1);
    expect(store.dirty).toBe(false);
    await expect(store.save()).resolves.toBe(true);
    fail = true;
    store.markDirty();
    expect(store.saveSync()).toBe(false);
    expect(store.dirty).toBe(true);
    expect(log.entries.some((e) => e.level === 'error')).toBe(true);
  });
});
