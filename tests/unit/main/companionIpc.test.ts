// Living Companion over IPC: the laser, event-pause and journal actions (session-only state, no
// settings writes), the journal channel (sender check, rate limit, output validation), the live
// status in the view state, and the preload channel table. MOCKED: ipcMain, the window registry
// and the sim (a stub that only answers companionStatus and journal).
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import type { IpcMainInvokeEvent } from 'electron';
import { createActionRunner, type ActionTargets } from '../../../src/main/ipc/actions';
import { registerIpcHandlers, type IpcDeps } from '../../../src/main/ipc/handlers';
import { buildCompanionStatus, sanitizeJournal } from '../../../src/main/ipc/viewState';
import type { JsonStore } from '../../../src/main/store/jsonStore';
import { createSettingsStore } from '../../../src/main/store/settingsStore';
import { ALL_EVENT_IDS, JOURNAL_MAX, type JournalEntry } from '../../../src/shared/companion';
import { IPC, SETTINGS_ACTIONS, SettingsActionSchema } from '../../../src/shared/ipc';
import type { CatSim } from '../../../src/shared/sim';
import { memoryLogger } from './helpers';

function memoryJsonStore(): JsonStore & { writes: number } {
  let value: unknown = null;
  const store = {
    writes: 0,
    filePath: 'mem://settings.json',
    backupPath: 'mem://settings.json.bak',
    read: () => ({ status: value === null ? 'missing' : 'ok', value, quarantinedTo: null }),
    readBackup: () => ({ ok: false }),
    quarantine: () => null,
    writeSync: (v: unknown) => {
      store.writes++;
      value = v;
      return true;
    },
    write: (v: unknown) => {
      store.writes++;
      value = v;
      return Promise.resolve(true);
    },
  };
  return store as unknown as JsonStore & { writes: number };
}

describe('Living Companion actions', () => {
  function setup(targets: Partial<ActionTargets>) {
    const json = memoryJsonStore();
    const settings = createSettingsStore({ store: json, logger: memoryLogger() });
    settings.load();
    return { json, settings, runner: createActionRunner({ targets: targets as ActionTargets, settings, logger: memoryLogger() }) };
  }

  it('are listed and accepted by the action schema', () => {
    for (const a of ['startLaserMode', 'stopLaserMode', 'pauseEvents', 'resumeEvents', 'clearJournal']) {
      expect(SETTINGS_ACTIONS).toContain(a);
      expect(SettingsActionSchema.safeParse(a).success).toBe(true);
    }
  });

  it('reach main session state and never touch the settings', async () => {
    const calls: string[] = [];
    const { json, settings, runner } = setup({
      setLaserMode: (on) => calls.push(`laser:${on}`),
      setEventsPaused: (p) => calls.push(`events:${p}`),
    });
    await settings.flush();
    const before = JSON.stringify(settings.get());
    const writes = json.writes;
    expect(await runner.run('startLaserMode')).toEqual({ ok: true });
    expect(await runner.run('stopLaserMode')).toEqual({ ok: true });
    expect(await runner.run('pauseEvents')).toEqual({ ok: true });
    expect(await runner.run('resumeEvents')).toEqual({ ok: true });
    expect(calls).toEqual(['laser:true', 'laser:false', 'events:true', 'events:false']);
    expect(JSON.stringify(settings.get())).toBe(before);
    await settings.flush();
    expect(json.writes).toBe(writes);
  });

  it('clearJournal clears through the target and nothing else', async () => {
    const calls: string[] = [];
    const { runner } = setup({ clearJournal: () => calls.push('clear') });
    expect(await runner.run('clearJournal')).toEqual({ ok: true, message: 'Journal cleared.' });
    expect(calls).toEqual(['clear']);
  });

  it('report failure, not a throw, where the target is missing, and contain a throwing target', async () => {
    const { runner } = setup({});
    for (const a of ['startLaserMode', 'stopLaserMode', 'pauseEvents', 'resumeEvents', 'clearJournal'] as const) {
      expect((await runner.run(a)).ok).toBe(false);
    }
    const broken = setup({
      setLaserMode: () => {
        throw new Error('boom');
      },
    });
    expect((await broken.runner.run('startLaserMode')).ok).toBe(false);
  });
});

describe('sanitizeJournal', () => {
  const entry = (over: Record<string, unknown> = {}) => ({ id: 'butterflyEncounter', at: 1000, outcome: 'watched', ...over });

  it('keeps valid entries in order and copies them', () => {
    const src = [entry(), entry({ id: ALL_EVENT_IDS.at(-1), at: 2000, outcome: 'played_1' })];
    const out = sanitizeJournal(src);
    expect(out).toEqual(src);
    expect(out[0]).not.toBe(src[0]);
  });

  it('drops unknown ids, odd outcome tokens, bad times and non-objects, and strips extra fields', () => {
    const out = sanitizeJournal([
      entry({ id: 'launch-the-missiles' }),
      entry({ outcome: 'Has Space' }),
      entry({ outcome: 'x'.repeat(25) }),
      entry({ outcome: '' }),
      entry({ outcome: 7 }),
      entry({ at: Number.NaN }),
      entry({ at: Number.POSITIVE_INFINITY }),
      entry({ at: -1 }),
      entry({ at: '5' }),
      null,
      'text',
      42,
      entry({ title: 'Inbox - Mail', x: 10 }),
    ]);
    expect(out).toEqual([{ id: 'butterflyEncounter', at: 1000, outcome: 'watched' }]);
  });

  it('is total: anything that is not a list is an empty list, and the list is bounded to the newest JOURNAL_MAX', () => {
    for (const v of [null, undefined, 'x', 5, {}, { length: 3 }]) expect(sanitizeJournal(v)).toEqual([]);
    const many = Array.from({ length: JOURNAL_MAX + 40 }, (_, i) => entry({ at: i }));
    const out = sanitizeJournal(many);
    expect(out).toHaveLength(JOURNAL_MAX);
    expect(out.at(-1)!.at).toBe(JOURNAL_MAX + 39);
  });
});

const SETTINGS_URL = 'desktop-cat://app/renderer/settings/index.html#companion';

function rig(getJournal: (() => readonly JournalEntry[]) | undefined, kind: 'settings' | 'overlay' = 'settings', clock: () => number = () => 0) {
  const handlers = new Map<string, (event: IpcMainInvokeEvent, payload?: unknown) => unknown>();
  const log = memoryLogger();
  const deps = {
    ipcMain: {
      on: () => undefined,
      removeAllListeners: () => undefined,
      handle: (channel: string, fn: (event: IpcMainInvokeEvent, payload?: unknown) => unknown) => handlers.set(channel, fn),
      removeHandler: () => undefined,
    },
    registry: { register: () => undefined, unregister: () => undefined, kindOf: (id: number) => (id === 3 ? kind : null), ids: () => [3] },
    logger: log,
    overlays: { handleReady: () => undefined, handlePointer: () => undefined, handleHitRegion: () => undefined, handleRendererError: () => undefined },
    getJournal,
    clock,
  } as unknown as IpcDeps;
  registerIpcHandlers(deps);
  const call = (event: { sender: { id: number }; senderFrame: { url: string; parent: unknown } | null }) =>
    Promise.resolve().then(() => handlers.get(IPC.settingsGetJournal)!(event as unknown as IpcMainInvokeEvent));
  const trusted = { sender: { id: 3 }, senderFrame: { url: SETTINGS_URL, parent: null } };
  return { call, trusted, log, handlers };
}

describe('settings:get-journal', () => {
  it('is registered under the documented channel and serves the validated journal', async () => {
    expect(IPC.settingsGetJournal).toBe('settings:get-journal');
    const r = rig(() => [{ id: 'butterflyEncounter', at: 5, outcome: 'watched' }]);
    expect(r.handlers.has(IPC.settingsGetJournal)).toBe(true);
    await expect(r.call(r.trusted)).resolves.toEqual([{ id: 'butterflyEncounter', at: 5, outcome: 'watched' }]);
  });

  it('never sends an entry that fails validation', async () => {
    const r = rig(() => [{ id: 'butterflyEncounter', at: 5, outcome: 'watched' }, { id: 'nope', at: 5, outcome: 'x' }, { id: 'butterflyEncounter', at: 6, outcome: 'Secret Title' }] as unknown as JournalEntry[]);
    await expect(r.call(r.trusted)).resolves.toEqual([{ id: 'butterflyEncounter', at: 5, outcome: 'watched' }]);
  });

  it('answers an empty list when the source is missing or throws, so the page still renders', async () => {
    await expect(rig(undefined).call(rig(undefined).trusted)).resolves.toEqual([]);
    const failing = rig(() => {
      throw new Error('boom');
    });
    await expect(failing.call(failing.trusted)).resolves.toEqual([]);
    expect(failing.log.entries.some((e) => e.msg === 'reading the journal failed')).toBe(true);
  });

  it('rejects untrusted senders without reading the journal', async () => {
    let reads = 0;
    const get = (): JournalEntry[] => {
      reads++;
      return [];
    };
    const overlay = rig(get, 'overlay');
    await expect(overlay.call({ sender: { id: 3 }, senderFrame: { url: 'desktop-cat://app/renderer/overlay/index.html?display=1', parent: null } })).rejects.toThrow('Forbidden');
    const r = rig(get);
    await expect(r.call({ sender: { id: 9 }, senderFrame: { url: SETTINGS_URL, parent: null } })).rejects.toThrow('Forbidden');
    await expect(r.call({ sender: { id: 3 }, senderFrame: { url: SETTINGS_URL, parent: {} } })).rejects.toThrow('Forbidden');
    await expect(r.call({ sender: { id: 3 }, senderFrame: { url: 'https://evil.example/renderer/settings/index.html', parent: null } })).rejects.toThrow('Forbidden');
    expect(reads).toBe(0);
  });

  it('is rate limited like the other settings getters', async () => {
    const r = rig(() => [], 'settings', () => 100);
    let rejected = 0;
    for (let i = 0; i < 80; i++) {
      try {
        await r.call(r.trusted);
      } catch (err) {
        if ((err as Error).message === 'Too many requests') rejected++;
      }
    }
    expect(rejected).toBeGreaterThan(0);
  });
});

describe('view state companion status', () => {
  const stub = (over: Partial<ReturnType<CatSim['companionStatus']>> = {}): Pick<CatSim, 'companionStatus'> => ({
    companionStatus: () => ({ mood: 'happy', event: null, nextEventInMs: 90_000, nearestPersonality: 'curious', personalityIsAuto: true, ...over }),
  });
  const session = { eventsPaused: false, laserActive: false };

  it('combines the sim report with the activity and the session flags', () => {
    expect(buildCompanionStatus(stub(), 'idle', 'auto', { eventsPaused: true, laserActive: true })).toEqual({
      mood: 'happy',
      activity: 'idle',
      personality: 'curious',
      personalityIsAuto: true,
      event: null,
      nextEventInMs: 90_000,
      eventsPaused: true,
      laserActive: true,
    });
  });

  it('shows the chosen personality instead of the nearest one, and is not auto then', () => {
    const s = buildCompanionStatus(stub(), 'idle', 'lazy', session);
    expect(s?.personality).toBe('lazy');
    expect(s?.personalityIsAuto).toBe(false);
  });

  it('reports a running event and drops odd values', () => {
    const running = buildCompanionStatus(stub({ event: 'butterflyEncounter', nextEventInMs: null }), 'watchingCursor', 'auto', session);
    expect(running?.event).toBe('butterflyEncounter');
    expect(running?.nextEventInMs).toBeNull();
    const odd = buildCompanionStatus(stub({ event: 'nope' as never, nextEventInMs: Number.NaN }), 'idle', 'auto', session);
    expect(odd?.event).toBeNull();
    expect(odd?.nextEventInMs).toBeNull();
  });

  it('is absent, never a throw, when the sim cannot answer', () => {
    expect(buildCompanionStatus({} as Pick<CatSim, 'companionStatus'>, 'idle', 'auto', session)).toBeUndefined();
    const throwing: Pick<CatSim, 'companionStatus'> = {
      companionStatus: () => {
        throw new Error('boom');
      },
    };
    expect(buildCompanionStatus(throwing, 'idle', 'auto', session)).toBeUndefined();
    expect(buildCompanionStatus(stub({ mood: 'furious' as never }), 'idle', 'auto', session)).toBeUndefined();
  });
});

describe('settings preload channel table', () => {
  it('carries the journal channel with the satisfies pattern, and a getJournal method', () => {
    const src = fs.readFileSync(path.resolve(__dirname, '../../../src/preload/settings.ts'), 'utf8');
    expect(src).toContain("settingsGetJournal: 'settings:get-journal'");
    expect(src).toContain("| 'settingsGetJournal'");
    expect(src).toContain('getJournal: () => invoke<JournalEntry[]>(CH.settingsGetJournal)');
  });
});
