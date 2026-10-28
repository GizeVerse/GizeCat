import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { defaultSettings } from '../../../src/shared/settings';
import { createJsonStore } from '../../../src/main/store/jsonStore';
import { createSettingsStore } from '../../../src/main/store/settingsStore';
import { manualTimers, memoryLogger, removeDir, tempDir } from './helpers';

describe('settingsStore', () => {
  let dir: string;
  let file: string;
  beforeEach(() => {
    dir = tempDir();
    file = path.join(dir, 'settings.json');
  });
  afterEach(() => removeDir(dir));

  function make() {
    const timers = manualTimers();
    const store = createSettingsStore({
      store: createJsonStore({ filePath: file }),
      logger: memoryLogger(),
      debounceMs: 500,
      setTimer: timers.setTimeout,
      clearTimer: timers.clearTimeout,
    });
    return { store, timers };
  }

  const onDisk = () => JSON.parse(fs.readFileSync(file, 'utf8'));

  it('loads defaults when the file is missing and does not write until changed', () => {
    const { store } = make();
    const r = store.load();
    expect(r.status).toBe('missing');
    expect(r.settings).toEqual(defaultSettings());
    expect(store.dirty).toBe(false);
    expect(fs.existsSync(file)).toBe(false);
  });

  it('migrates stored values field by field', () => {
    fs.writeFileSync(file, JSON.stringify({ schemaVersion: 1, appearance: { size: 2, skin: 'nope' } }));
    const { store } = make();
    const s = store.load().settings;
    expect(s.appearance.size).toBe(2);
    expect(s.appearance.skin).toBe('ginger');
  });

  it('debounces saves by 500 ms and coalesces bursts', async () => {
    const { store, timers } = make();
    store.load();
    expect(store.patch({ appearance: { size: 1.5 } }).ok).toBe(true);
    timers.advance(300);
    expect(store.patch({ appearance: { size: 1.8 } }).ok).toBe(true);
    timers.advance(499);
    expect(fs.existsSync(file)).toBe(false);
    timers.advance(1);
    await store.flush();
    expect(onDisk().appearance.size).toBe(1.8);
    expect(store.dirty).toBe(false);
  });

  it('flushSync writes pending changes immediately (shutdown path)', () => {
    const { store, timers } = make();
    store.load();
    store.patch({ general: { catName: 'Pixel' } });
    store.flushSync();
    expect(onDisk().general.catName).toBe('Pixel');
    expect(timers.size).toBe(0);
  });

  it('rejects invalid patches without changing state or notifying', () => {
    const { store } = make();
    store.load();
    let calls = 0;
    store.onChange(() => calls++);
    expect(store.patchUnknown({ appearance: { size: 99 } }).ok).toBe(false);
    expect(store.patchUnknown({ perception: { visualMode: 'spy' } }).ok).toBe(false);
    expect(store.patchUnknown('nope').ok).toBe(false);
    expect(calls).toBe(0);
    expect(store.dirty).toBe(false);
    expect(store.get()).toEqual(defaultSettings());
  });

  it('notifies listeners with next and previous settings, and skips no-op patches', () => {
    const { store } = make();
    store.load();
    const seen: Array<[number, number]> = [];
    const off = store.onChange((next, prev) => seen.push([next.behavior.autonomy, prev.behavior.autonomy]));
    store.patch({ behavior: { autonomy: 0.2 } });
    store.patch({ behavior: { autonomy: 0.2 } });
    off();
    store.patch({ behavior: { autonomy: 0.3 } });
    expect(seen).toEqual([[0.2, 0.6]]);
  });

  it('marks a recovered (corrupt) file dirty so a valid file is written back', () => {
    fs.writeFileSync(file, '{not json');
    const { store } = make();
    const r = store.load();
    expect(r.status).toBe('corrupt');
    expect(store.dirty).toBe(true);
    store.flushSync();
    expect(onDisk().schemaVersion).toBe(1);
  });

  it('a listener that throws does not break the store', () => {
    const { store } = make();
    store.load();
    store.onChange(() => {
      throw new Error('boom');
    });
    expect(store.patch({ interaction: { enabled: false } }).ok).toBe(true);
    expect(store.get().interaction.enabled).toBe(false);
  });
});
