// v1.2 opt-out sidecar (ADR 0003 §9.3): behavior.disabledExtras is mirrored into
// behavior-opt-outs.json next to settings.json, a file 1.1.1 never touches, so the v1.2 opt-outs
// survive a downgrade to 1.1.1 (whose first save drops them) and a later re-upgrade.
import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { defaultSettings, MAX_OPT_OUTS } from '../../../src/shared/settings';
import { createJsonStore, type JsonStore } from '../../../src/main/store/jsonStore';
import { OPT_OUT_SIDECAR_FILE, OPT_OUT_SIDECAR_KIND, optOutSidecarPath, readOptOutSidecar, unionOptOuts } from '../../../src/main/store/optOutSidecar';
import { createSettingsStore } from '../../../src/main/store/settingsStore';
import { migrateSettings as migrateSettingsV111 } from '../../fixtures/v1.1.1/settings';
import { manualTimers, memoryLogger, removeDir, tempDir } from './helpers';

describe('opt-out sidecar', () => {
  let dir: string;
  let file: string;
  let sidecar: string;
  beforeEach(() => {
    dir = tempDir();
    file = path.join(dir, 'settings.json');
    sidecar = path.join(dir, OPT_OUT_SIDECAR_FILE);
  });
  afterEach(() => removeDir(dir));

  function make(opts: { sidecar?: JsonStore | null } = {}) {
    const timers = manualTimers();
    const log = memoryLogger();
    const store = createSettingsStore({
      store: createJsonStore({ filePath: file }),
      ...(opts.sidecar !== undefined ? { optOutSidecar: opts.sidecar } : {}),
      logger: log,
      debounceMs: 500,
      setTimer: timers.setTimeout,
      clearTimer: timers.clearTimeout,
    });
    return { store, timers, log };
  }
  const read = (p: string) => JSON.parse(fs.readFileSync(p, 'utf8'));
  const write = (p: string, v: unknown) => fs.writeFileSync(p, JSON.stringify(v));

  it('lives next to settings.json and is not created until there is something to mirror', async () => {
    expect(optOutSidecarPath(file)).toBe(sidecar);
    const { store } = make();
    store.load();
    expect(store.patch({ appearance: { size: 1.4 } }).ok).toBe(true);
    await store.flush();
    expect(fs.existsSync(file)).toBe(true);
    expect(fs.existsSync(sidecar)).toBe(false);
  });

  it('mirrors every opt-out change, and an explicit re-enable is the only way an id leaves it', async () => {
    const { store } = make();
    store.load();
    expect(store.patch({ behavior: { disabledExtras: ['pounce', 'slips'] } }).ok).toBe(true);
    await store.flush();
    expect(read(sidecar)).toEqual({ kind: OPT_OUT_SIDECAR_KIND, version: 1, disabledExtras: ['pounce', 'slips'] });
    expect(store.patch({ behavior: { disabledExtras: ['slips'] } }).ok).toBe(true);
    await store.flush();
    expect(read(sidecar).disabledExtras).toEqual(['slips']);
    expect(read(file).behavior.disabledExtras).toEqual(['slips']);
  });

  it('survives a 1.1.1 downgrade: 1.1.1 drops the list on save, the re-upgrade restores it from the sidecar', async () => {
    // v1.2 saves the user's opt-outs.
    let s = make();
    s.store.load();
    expect(s.store.patch({ behavior: { autonomy: 0.8, disabledBehaviors: ['zoomies'], disabledExtras: ['pounce', 'hissing'] } }).ok).toBe(true);
    await s.store.flush();
    s.store.dispose();
    // 1.1.1 loads and saves (frozen copy of its schema): disabledExtras is gone, the sidecar untouched.
    const old = migrateSettingsV111(read(file));
    write(file, old);
    expect(read(file).behavior).not.toHaveProperty('disabledExtras');
    expect(read(file).schemaVersion).toBe(2);
    // v1.2 again.
    s = make();
    const loaded = s.store.load().settings;
    expect(loaded.behavior.disabledExtras).toEqual(['pounce', 'hissing']);
    expect(loaded.behavior.disabledBehaviors).toEqual(['zoomies']);
    expect(loaded.behavior.autonomy).toBe(0.8);
    expect(s.store.dirty).toBe(true);
    expect(s.log.entries.some((e) => e.msg === 'restored switched-off behaviours from the opt-out copy' && e.data?.restored === 2)).toBe(true);
    s.store.flushSync();
    expect(read(file).behavior.disabledExtras).toEqual(['pounce', 'hissing']);
    expect(read(file).schemaVersion).toBe(3);
  });

  it('without the sidecar the re-upgrade loses the list (the failure it exists for)', async () => {
    const s = make({ sidecar: null });
    s.store.load();
    expect(s.store.patch({ behavior: { disabledExtras: ['pounce'] } }).ok).toBe(true);
    await s.store.flush();
    expect(fs.existsSync(sidecar)).toBe(false);
    write(file, migrateSettingsV111(read(file)));
    expect(make({ sidecar: null }).store.load().settings.behavior.disabledExtras).toEqual([]);
  });

  it('loads the union of settings and sidecar, and brings the sidecar up to it', async () => {
    const d = defaultSettings();
    write(file, { ...d, behavior: { ...d.behavior, disabledExtras: ['pounce'] } });
    write(sidecar, { kind: OPT_OUT_SIDECAR_KIND, version: 1, disabledExtras: ['slips', 'pounce', 'futureThing'] });
    const { store } = make();
    expect(store.load().settings.behavior.disabledExtras).toEqual(['pounce', 'slips', 'futureThing']);
    await store.flush();
    expect(read(sidecar).disabledExtras).toEqual(['pounce', 'slips', 'futureThing']);
    expect(read(file).behavior.disabledExtras).toEqual(['pounce', 'slips', 'futureThing']);
  });

  it('an opt-out only in the settings file (e.g. a sidecar deleted by hand) is copied into a new sidecar', () => {
    const d = defaultSettings();
    write(file, { ...d, behavior: { ...d.behavior, disabledExtras: ['tailChase'] } });
    const { store } = make();
    expect(store.load().settings.behavior.disabledExtras).toEqual(['tailChase']);
    expect(store.dirty).toBe(true);
    store.flushSync();
    expect(read(sidecar).disabledExtras).toEqual(['tailChase']);
  });

  it('is tolerant: a malformed sidecar or malformed entries cost nothing else, and the list stays bounded', () => {
    write(sidecar, { kind: OPT_OUT_SIDECAR_KIND, version: 7, disabledExtras: ['pounce', 3, 'Bad Id', 'pounce', null, 'slips'] });
    expect(make().store.load().settings.behavior.disabledExtras).toEqual(['pounce', 'slips']);
    write(sidecar, { kind: 'something-else', disabledExtras: ['pounce'] });
    expect(make().store.load().settings.behavior.disabledExtras).toEqual([]);
    write(sidecar, ['pounce']);
    expect(make().store.load().settings.behavior.disabledExtras).toEqual([]);
    write(sidecar, { kind: OPT_OUT_SIDECAR_KIND, disabledExtras: Array.from({ length: 200 }, (_, i) => `extra${i}`) });
    expect(make().store.load().settings.behavior.disabledExtras).toHaveLength(MAX_OPT_OUTS);
    fs.writeFileSync(sidecar, '{"kind": "desktop-cat-opt-ou');
    const { store } = make();
    expect(store.load().settings.behavior.disabledExtras).toEqual([]);
    // The unreadable copy was moved aside, never silently overwritten.
    expect(fs.readdirSync(dir).some((n) => n.startsWith('behavior-opt-outs.corrupt-'))).toBe(true);
  });

  it('holds ids only: the file has exactly kind, version and the list', async () => {
    const { store } = make();
    store.load();
    store.patch({ behavior: { disabledExtras: ['screenEdges'] } });
    await store.flush();
    expect(Object.keys(read(sidecar)).sort()).toEqual(['disabledExtras', 'kind', 'version']);
  });

  it('flushSync writes a pending sidecar change (shutdown path)', () => {
    const { store } = make();
    store.load();
    store.patch({ behavior: { disabledExtras: ['surfaceHops'] } });
    expect(store.dirty).toBe(true);
    store.flushSync();
    expect(read(sidecar).disabledExtras).toEqual(['surfaceHops']);
    expect(store.dirty).toBe(false);
  });

  it('in-memory and relative stores get no sidecar unless one is passed', () => {
    const writes: unknown[] = [];
    const mem: JsonStore = {
      filePath: 'mem://settings.json',
      backupPath: 'mem://settings.json.bak',
      read: () => ({ status: 'missing', value: null, quarantinedTo: null }),
      readBackup: () => ({ ok: false }),
      quarantine: () => null,
      writeSync: (v) => {
        writes.push(v);
        return true;
      },
      write: (v) => {
        writes.push(v);
        return Promise.resolve(true);
      },
    };
    const store = createSettingsStore({ store: mem, logger: memoryLogger() });
    store.load();
    store.patch({ behavior: { disabledExtras: ['pounce'] } });
    store.flushSync();
    expect(writes).toHaveLength(1);
    expect(fs.readdirSync(dir)).toEqual([]);
  });

  it('union and reader helpers', () => {
    expect(unionOptOuts(['a1', 'b2'], ['b2', 'c3'])).toEqual(['a1', 'b2', 'c3']);
    expect(readOptOutSidecar(null)).toEqual([]);
    expect(readOptOutSidecar({ kind: OPT_OUT_SIDECAR_KIND, disabledExtras: 'pounce' })).toEqual([]);
  });
});
