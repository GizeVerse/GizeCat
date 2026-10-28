import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { defaultSettings } from '../../../src/shared/settings';
import { createJsonStore, type JsonStore } from '../../../src/main/store/jsonStore';
import { createSettingsStore } from '../../../src/main/store/settingsStore';
import { failFor, manualTimers, memoryLogger, removeDir, tempDir } from './helpers';

/** A store whose async writes stay in flight until released (the open/write/fsync window). */
function slowStore() {
  const syncWrites: unknown[] = [];
  const releases: Array<(ok: boolean) => void> = [];
  const store: JsonStore = {
    filePath: 'settings.json',
    backupPath: 'settings.json.bak',
    read: () => ({ status: 'missing', value: null, quarantinedTo: null }),
    readBackup: () => ({ ok: false }),
    quarantine: () => null,
    writeSync: (value) => {
      syncWrites.push(value);
      return true;
    },
    write: () => new Promise<boolean>((resolve) => releases.push(resolve)),
  };
  return { store, syncWrites, releases };
}

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

  it('flushSync still writes while the debounced async write is in flight (session end)', async () => {
    const timers = manualTimers();
    const slow = slowStore();
    const store = createSettingsStore({ store: slow.store, logger: memoryLogger(), setTimer: timers.setTimeout, clearTimer: timers.clearTimeout });
    store.load();
    store.patch({ general: { launchAtLogin: true } });
    timers.advance(500);
    await Promise.resolve();
    expect(slow.releases).toHaveLength(1);
    expect(store.dirty).toBe(true);
    store.flushSync();
    expect(slow.syncWrites).toHaveLength(1);
    expect((slow.syncWrites[0] as { general: { launchAtLogin: boolean } }).general.launchAtLogin).toBe(true);
    expect(store.dirty).toBe(false);
    // The late async result changes nothing, and there is nothing left to write.
    slow.releases[0]!(false);
    await store.flush();
    store.flushSync();
    expect(slow.syncWrites).toHaveLength(1);
    expect(store.dirty).toBe(false);
  });

  it('settings restored from the backup never bring back screen-analysis consent', () => {
    const first = make().store;
    first.load();
    first.patch({ general: { catName: 'Pixel' }, ai: { allowCloud: true }, perception: { visualMode: 'ai', consentAt: '2026-10-28T10:00:00.000Z' } });
    first.flushSync();
    // The user revokes consent; the file holding that is later damaged.
    first.patch({ ai: { allowCloud: false }, perception: { visualMode: 'off', consentAt: null } });
    first.flushSync();
    fs.writeFileSync(file, '{"schemaVersion":1,"perc');

    const { store } = make();
    const r = store.load();
    expect(r.status).toBe('recovered-backup');
    expect(r.settings.general.catName).toBe('Pixel');
    expect(r.settings.perception.visualMode).toBe('off');
    expect(r.settings.perception.consentAt).toBeNull();
    expect(r.settings.ai.allowCloud).toBe(false);
    store.flushSync();
    expect(onDisk().perception).toMatchObject({ visualMode: 'off', consentAt: null });
  });

  it('a settings file that cannot be read is not overwritten, and its backup grants no consent', () => {
    const first = make().store;
    first.load();
    first.patch({ perception: { visualMode: 'local-stats', consentAt: '2026-10-28T10:00:00.000Z' } });
    first.flushSync();
    first.patch({ general: { catName: 'Pixel' } });
    first.flushSync();
    const before = fs.readFileSync(file, 'utf8');
    const locked = failFor('readFileSync', file);

    const { store } = make();
    const r = store.load();
    expect(r.status).toBe('unreadable');
    expect(r.settings.perception.visualMode).toBe('off');
    expect(r.settings.perception.consentAt).toBeNull();
    expect(store.dirty).toBe(false);
    store.patch({ general: { catName: 'Other' } });
    store.flushSync();
    locked.mockRestore();
    expect(fs.readFileSync(file, 'utf8')).toBe(before);
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
