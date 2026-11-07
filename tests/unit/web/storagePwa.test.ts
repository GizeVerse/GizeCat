// 1.4.0 additions to the web host's persistence (src/web/storage.ts): the personality round trip,
// "Start over" (clearAll and a frozen cat store, so the old cat is never written back), and the
// persistence request. MOCKED: storage and navigator.storage are in-memory fakes.
import { describe, expect, it } from 'vitest';
import { PRESET_VALUES, presetPatch } from '../../../src/shared/settingsPresets';
import { applySettingsPatch, defaultSettings } from '../../../src/shared/settings';
import { mulberry32 } from '../../../src/core/behavior/random';
import { CAT_STORAGE_KEY, createWebCatStore, openWebStorage, requestPersistence, SETTINGS_STORAGE_KEY, type StorageLike } from '../../../src/web/storage';
import { memoryLogger } from './helpers';

const NOW = Date.UTC(2026, 10, 8);

function memoryStorage(withRemove = true): StorageLike & { data: Map<string, string> } {
  const data = new Map<string, string>();
  const s: StorageLike & { data: Map<string, string> } = {
    data,
    getItem: (k) => data.get(k) ?? null,
    setItem: (k, v) => {
      data.set(k, String(v));
    },
  };
  if (withRemove) s.removeItem = (k) => void data.delete(k);
  return s;
}

describe('web storage 1.4.0', () => {
  it('keeps a chosen personality across a reload (its values are stored, the preset re-derived from them)', () => {
    const mem = memoryStorage();
    const r = applySettingsPatch(defaultSettings(), presetPatch('calm'));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(openWebStorage(() => mem, memoryLogger()).saveSettings(r.settings)).toBe(true);
    const back = openWebStorage(() => mem, memoryLogger()).loadSettings();
    expect(back.behavior.activityPreset).toBe('calm');
    expect(back.behavior.autonomy).toBe(PRESET_VALUES.calm.behavior.autonomy);
    expect(back.interaction.reactionIntensity).toBe(PRESET_VALUES.calm.interaction.reactionIntensity);
  });

  it('settings stored before 1.4.0 (no personality) read back as Playful', () => {
    const mem = memoryStorage();
    mem.setItem(SETTINGS_STORAGE_KEY, JSON.stringify({ schemaVersion: 3, general: { catName: 'Pamuk' }, sound: { enabled: true, volume: 0.5 } }));
    const back = openWebStorage(() => mem, memoryLogger()).loadSettings();
    expect(back.general.catName).toBe('Pamuk');
    expect(back.behavior.activityPreset).toBe('playful');
  });

  it('clearAll removes the cat and the settings; without removeItem or storage it reports failure', () => {
    const mem = memoryStorage();
    const store = openWebStorage(() => mem, memoryLogger());
    store.saveCat(store.loadCat(mulberry32(1), NOW).cat);
    store.saveSettings(store.loadSettings());
    expect(mem.data.size).toBe(2);
    expect(store.clearAll()).toBe(true);
    expect(mem.data.has(CAT_STORAGE_KEY) || mem.data.has(SETTINGS_STORAGE_KEY)).toBe(false);
    expect(openWebStorage(() => mem, memoryLogger()).loadCat(mulberry32(2), NOW).source).toBe('new');
    expect(openWebStorage(() => memoryStorage(false), memoryLogger()).clearAll()).toBe(false);
    expect(openWebStorage(() => null, memoryLogger()).clearAll()).toBe(false);
  });

  it('a frozen cat store never saves again (the pagehide save after Start over)', () => {
    const mem = memoryStorage();
    const storage = openWebStorage(() => mem, memoryLogger());
    const cat = storage.loadCat(mulberry32(3), NOW).cat;
    const cleared: unknown[] = [];
    const store = createWebCatStore({
      storage,
      snapshot: () => cat,
      logger: memoryLogger(),
      setInterval: () => 7,
      clearInterval: (h) => cleared.push(h),
    });
    store.start();
    expect(storage.clearAll()).toBe(true);
    store.freeze();
    expect(store.frozen).toBe(true);
    expect(cleared).toEqual([7]);
    store.markDirty();
    expect(store.saveSync()).toBe(false);
    expect(mem.data.has(CAT_STORAGE_KEY)).toBe(false);
  });

  it('asks for persistence only when told to, and never throws', async () => {
    let asked = 0;
    const granted = { persist: () => (asked++, Promise.resolve(true)), persisted: () => Promise.resolve(false) };
    expect(await requestPersistence(granted, true)).toBe('persisted');
    expect(asked).toBe(1);
    expect(await requestPersistence(granted, false)).toBe('best-effort');
    expect(asked).toBe(1);
    expect(await requestPersistence(undefined, true)).toBe('unavailable');
    expect(await requestPersistence({}, true)).toBe('unavailable');
    expect(await requestPersistence({ persist: () => Promise.reject(new Error('no')) }, true)).toBe('best-effort');
  });
});
