// general.startupState / rememberedState: the state the cat starts in, and the last
// hidden/paused/visible state main keeps for "As I left it" across restarts.
import type { IpcMainInvokeEvent } from 'electron';
import { describe, expect, it } from 'vitest';
import { registerIpcHandlers, type IpcDeps } from '../../../src/main/ipc/handlers';
import {
  applyViewState,
  createViewStateMemory,
  rejectMainOwnedFields,
  startupPlan,
  viewStateOf,
  type CatViewTarget,
} from '../../../src/main/ipc/startupState';
import type { JsonStore } from '../../../src/main/store/jsonStore';
import { createSettingsStore } from '../../../src/main/store/settingsStore';
import { IPC } from '../../../src/shared/ipc';
import { defaultSettings, type Settings } from '../../../src/shared/settings';
import { manualTimers, memoryLogger } from './helpers';

/** A settings file that survives a "restart" (a new store reading the same value). */
function memoryDisk() {
  let value: unknown = null;
  let writes = 0;
  const store: JsonStore = {
    filePath: 'mem://settings.json',
    backupPath: 'mem://settings.json.bak',
    read: () => ({ status: value === null ? 'missing' : 'ok', value: structuredClone(value), quarantinedTo: null }),
    readBackup: () => ({ ok: false }),
    quarantine: () => null,
    writeSync: (v) => {
      value = structuredClone(v);
      writes++;
      return true;
    },
    write: (v) => {
      value = structuredClone(v);
      writes++;
      return Promise.resolve(true);
    },
  };
  return {
    store,
    get writes() {
      return writes;
    },
    get saved() {
      return value as Settings | null;
    },
  };
}

function launch(disk: ReturnType<typeof memoryDisk>) {
  const timers = manualTimers();
  const settings = createSettingsStore({ store: disk.store, logger: memoryLogger(), setTimer: timers.setTimeout, clearTimer: timers.clearTimeout });
  settings.load();
  return { settings, timers };
}

/** The host's hidden/paused flags, as createCatHost keeps them. */
function fakeHost(onChange: (host: CatViewTarget) => void = () => undefined): CatViewTarget & { calls: string[] } {
  let hidden = false;
  let paused = false;
  const calls: string[] = [];
  const host = {
    calls,
    get hidden() {
      return hidden;
    },
    get paused() {
      return paused;
    },
    setHidden(h: boolean) {
      calls.push(`hidden:${h}`);
      if (hidden === h) return;
      hidden = h;
      onChange(host);
    },
    setPaused(p: boolean) {
      calls.push(`paused:${p}`);
      if (paused === p) return;
      paused = p;
      onChange(host);
    },
  };
  return host;
}

const general = (patch: Partial<Settings['general']>): Settings['general'] => ({ ...defaultSettings().general, ...patch });

describe('startup plan', () => {
  it('starts in the chosen state, and in the remembered one for "remember"', () => {
    const at = { launchedAtLogin: false };
    expect(startupPlan(general({}), at).view).toBe('visible');
    expect(startupPlan(general({ startupState: 'hidden' }), at).view).toBe('hidden');
    expect(startupPlan(general({ startupState: 'paused', rememberedState: 'hidden' }), at).view).toBe('paused');
    expect(startupPlan(general({ startupState: 'visible', rememberedState: 'paused' }), at).view).toBe('visible');
    for (const remembered of ['visible', 'hidden', 'paused'] as const) {
      expect(startupPlan(general({ startupState: 'remember', rememberedState: remembered }), at).view).toBe(remembered);
    }
  });

  it('starts a launch at sign-in visible when the setting says visible, even if the cat was hidden last time', () => {
    const plan = startupPlan(general({ startupState: 'visible', rememberedState: 'hidden', firstRunCompleted: true }), { launchedAtLogin: true });
    expect(plan).toEqual({ view: 'visible', openWelcome: false });
    expect(startupPlan(general({ startupState: 'remember', rememberedState: 'paused' }), { launchedAtLogin: true }).view).toBe('paused');
  });

  it('opens the Welcome page on a first run, but not at sign-in', () => {
    expect(startupPlan(general({ firstRunCompleted: false }), { launchedAtLogin: false }).openWelcome).toBe(true);
    expect(startupPlan(general({ firstRunCompleted: false }), { launchedAtLogin: true }).openWelcome).toBe(false);
    expect(startupPlan(general({ firstRunCompleted: true }), { launchedAtLogin: false }).openWelcome).toBe(false);
  });

  it('applies the view state to the host, hidden winning over paused when read back', () => {
    const host = fakeHost();
    applyViewState(host, 'hidden');
    expect([host.hidden, host.paused]).toEqual([true, false]);
    applyViewState(host, 'paused');
    expect([host.hidden, host.paused]).toEqual([false, true]);
    applyViewState(host, 'visible');
    expect([host.hidden, host.paused]).toEqual([false, false]);
    expect(viewStateOf({ hidden: true, paused: true })).toBe('hidden');
    expect(viewStateOf({ hidden: false, paused: true })).toBe('paused');
    expect(viewStateOf({ hidden: false, paused: false })).toBe('visible');
  });
});

describe('remembered state', () => {
  it('follows hide/show/pause/resume through the settings store with a debounced save', async () => {
    const disk = memoryDisk();
    const { settings, timers } = launch(disk);
    const memory = createViewStateMemory({ settings, logger: memoryLogger() });
    let changes = 0;
    settings.onChange(() => changes++);
    const host = fakeHost((h) => memory.update(h));

    host.setPaused(true);
    expect(settings.get().general.rememberedState).toBe('paused');
    host.setHidden(true);
    expect(settings.get().general.rememberedState).toBe('hidden');
    expect(settings.dirty).toBe(true);
    timers.advance(499);
    await new Promise((r) => setImmediate(r));
    expect(disk.writes).toBe(0);
    timers.advance(1);
    await new Promise((r) => setImmediate(r));
    expect(disk.writes).toBe(1);
    expect(disk.saved?.general.rememberedState).toBe('hidden');

    host.setHidden(false);
    expect(settings.get().general.rememberedState).toBe('paused');
    host.setPaused(false);
    expect(settings.get().general.rememberedState).toBe('visible');
    expect(changes).toBe(4);
    // Status changes that leave hidden/paused alone (behaviour states) write nothing.
    memory.update(host);
    memory.update(host);
    expect(changes).toBe(4);
  });

  it('survives a restart: "remember" brings back a paused or hidden cat', () => {
    const disk = memoryDisk();
    const first = launch(disk);
    expect(first.settings.patch({ general: { startupState: 'remember' } }).ok).toBe(true);
    const memory = createViewStateMemory({ settings: first.settings, logger: memoryLogger() });
    const host1 = fakeHost((h) => memory.update(h));
    host1.setPaused(true);
    // Quit saves synchronously before the debounce fires.
    first.settings.flushSync();

    const second = launch(disk);
    const plan = startupPlan(second.settings.get().general, { launchedAtLogin: true });
    expect(plan.view).toBe('paused');
    const host2 = fakeHost();
    applyViewState(host2, plan.view);
    expect([host2.hidden, host2.paused]).toEqual([false, true]);

    // Hidden at quit -> hidden at the next start; "visible" ignores what was remembered.
    const memory2 = createViewStateMemory({ settings: second.settings, logger: memoryLogger() });
    memory2.update({ hidden: true, paused: false });
    second.settings.flushSync();
    expect(startupPlan(launch(disk).settings.get().general, { launchedAtLogin: false }).view).toBe('hidden');
    second.settings.patch({ general: { startupState: 'visible' } });
    second.settings.flushSync();
    expect(startupPlan(launch(disk).settings.get().general, { launchedAtLogin: true }).view).toBe('visible');
  });
});

describe('main-owned settings over IPC', () => {
  function settingsIpc() {
    const disk = memoryDisk();
    const { settings } = launch(disk);
    const handlers = new Map<string, (event: IpcMainInvokeEvent, payload: unknown) => unknown>();
    const deps = {
      ipcMain: {
        on: () => undefined,
        removeAllListeners: () => undefined,
        handle: (channel: string, fn: (event: IpcMainInvokeEvent, payload: unknown) => unknown) => handlers.set(channel, fn),
        removeHandler: () => undefined,
      },
      registry: { register: () => undefined, unregister: () => undefined, kindOf: () => 'settings', ids: () => [3] },
      logger: memoryLogger(),
      overlays: { handleReady: () => undefined, handlePointer: () => undefined, handleHitRegion: () => undefined, handleRendererError: () => undefined },
      settings,
      clock: () => 0,
    } as unknown as IpcDeps;
    registerIpcHandlers(deps);
    const event = { sender: { id: 3 }, senderFrame: { url: 'desktop-cat://app/renderer/settings/index.html#general', parent: null } } as unknown as IpcMainInvokeEvent;
    const update = (patch: unknown) => handlers.get(IPC.settingsUpdate)!(event, patch) as Promise<{ ok: boolean; error?: string }>;
    return { settings, update };
  }

  it('refuses a renderer patch of rememberedState but accepts the startup choice', async () => {
    const { settings, update } = settingsIpc();
    expect(rejectMainOwnedFields({ general: { rememberedState: 'hidden' } })).not.toBeNull();
    expect(rejectMainOwnedFields({ general: { startupState: 'hidden' } })).toBeNull();

    const refused = await update({ general: { rememberedState: 'hidden' } });
    expect(refused.ok).toBe(false);
    expect(settings.get().general.rememberedState).toBe('visible');

    const accepted = await update({ general: { startupState: 'paused' } });
    expect(accepted.ok).toBe(true);
    expect(settings.get().general.startupState).toBe('paused');
  });
});
