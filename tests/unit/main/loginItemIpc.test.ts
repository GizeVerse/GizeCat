// The main-owned loginItem section over the real IPC handlers: the settings renderer cannot
// patch it (rejectMainOwnedPatch on settings:update), and only the dedicated actions reach the
// login-item service. MOCKED: Electron's ipcMain, FakeWindowsLogin instead of the registry.
import type { IpcMainInvokeEvent } from 'electron';
import { describe, expect, it } from 'vitest';
import { createActionRunner, type ActionTargets } from '../../../src/main/ipc/actions';
import { registerIpcHandlers, type IpcDeps } from '../../../src/main/ipc/handlers';
import { createLoginItemService, UNINSTALLER_FILE } from '../../../src/main/lifecycle/loginItem';
import type { JsonStore } from '../../../src/main/store/jsonStore';
import { createSettingsStore } from '../../../src/main/store/settingsStore';
import { IPC, type ActionResult } from '../../../src/shared/ipc';
import { rejectMainOwnedPatch, type PatchResult } from '../../../src/shared/settings';
import { manualTimers, memoryLogger } from './helpers';
import { FakeWindowsLogin, memoryFs } from './loginItemFakes';

const DIR = 'C:\\Users\\Ada Lovelace\\AppData\\Local\\Programs\\Desktop Cat';
const EXE = `${DIR}\\DesktopCat.exe`;

function memoryJson(): JsonStore {
  let value: unknown = null;
  return {
    filePath: 'mem://settings.json',
    backupPath: 'mem://settings.json.bak',
    read: () => ({ status: value === null ? 'missing' : 'ok', value: structuredClone(value), quarantinedTo: null }),
    readBackup: () => ({ ok: false }),
    quarantine: () => null,
    writeSync: (v) => {
      value = structuredClone(v);
      return true;
    },
    write: (v) => {
      value = structuredClone(v);
      return Promise.resolve(true);
    },
  };
}

function rig() {
  const timers = manualTimers();
  const settings = createSettingsStore({ store: memoryJson(), logger: memoryLogger(), setTimer: timers.setTimeout, clearTimer: timers.clearTimeout });
  settings.load();
  const win = new FakeWindowsLogin();
  const loginItem = createLoginItemService({
    writer: win,
    registry: win.readerFor(),
    settings,
    logger: memoryLogger(),
    execPath: EXE,
    userData: 'C:\\Users\\Ada Lovelace\\AppData\\Roaming\\Desktop Cat',
    logDir: null,
    packaged: true,
    test: false,
    launchedAtLogin: false,
    env: {},
    settingsLoadStatus: 'missing',
    clock: () => 0,
    fs: memoryFs({ [`${DIR}\\${UNINSTALLER_FILE}`]: '' }),
  });
  loginItem.reconcileAtStartup();

  const unused = (): never => {
    throw new Error('not used here');
  };
  const targets: ActionTargets = {
    setLaunchAtLogin: (on) => loginItem.setLaunchAtLogin(on),
    dismissLaunchNotice: () => loginItem.dismissNotice(),
    setPaused: unused,
    setHidden: unused,
    callCat: unused,
    enqueue: unused,
    catAnchor: unused,
    resetPersonality: unused,
    clearHistory: unused,
    exportDiagnostics: unused,
    openLogsFolder: unused,
    openSettings: unused,
    quit: unused,
  };
  const actions = createActionRunner({ targets, settings, logger: memoryLogger() });

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
    actions,
    clock: () => 0,
  } as unknown as IpcDeps;
  registerIpcHandlers(deps);
  const event = { sender: { id: 3 }, senderFrame: { url: 'desktop-cat://app/renderer/settings/index.html#general', parent: null } } as unknown as IpcMainInvokeEvent;
  return {
    win,
    settings,
    loginItem,
    update: (patch: unknown) => handlers.get(IPC.settingsUpdate)!(event, patch) as Promise<PatchResult>,
    action: (name: unknown) => handlers.get(IPC.settingsAction)!(event, name) as Promise<ActionResult>,
  };
}

describe('loginItem is main-owned over IPC', () => {
  it('rejectMainOwnedPatch names the section and ignores other sections', () => {
    expect(rejectMainOwnedPatch({ loginItem: { preference: 'enabled' } })).toMatch(/loginItem can only be changed through its dedicated actions/);
    expect(rejectMainOwnedPatch({ loginItem: {} })).not.toBeNull();
    expect(rejectMainOwnedPatch({ general: { catName: 'Pixel' } })).toBeNull();
    expect(rejectMainOwnedPatch(null)).toBeNull();
  });

  it('refuses a renderer patch touching loginItem, also mixed with allowed fields, and changes nothing', async () => {
    const r = rig();
    const before = r.settings.get();
    for (const patch of [
      { loginItem: { preference: 'enabled', decidedBy: 'user' } },
      { loginItem: { noticeShown: true } },
      { loginItem: { registeredPath: 'C:\\evil\\x.exe' } },
      { general: { catName: 'Pixel' }, loginItem: { disabledBy: null } },
    ]) {
      const res = await r.update(patch);
      expect(res).toEqual({ ok: false, error: 'loginItem can only be changed through its dedicated actions' });
    }
    expect(r.settings.get()).toEqual(before);
    expect(r.win.writes).toHaveLength(1); // the boot registration only
    expect((await r.update({ general: { catName: 'Pixel' } })).ok).toBe(true);
  });

  it('the dedicated actions change it and write through Electron’s API', async () => {
    const r = rig();
    expect(r.loginItem.status()).toMatchObject({ active: true, showNotice: true });

    expect(await r.action('dismissLaunchNotice')).toEqual({ ok: true });
    expect(r.settings.get().loginItem.noticeShown).toBe(true);

    expect(await r.action('disableLaunchAtLogin')).toMatchObject({ ok: true, message: expect.stringMatching(/no longer starts/) });
    expect(r.win.runText()).toBeNull();
    expect(r.settings.get().loginItem).toMatchObject({ preference: 'disabled', decidedBy: 'user', disabledBy: 'user' });

    expect(await r.action('enableLaunchAtLogin')).toMatchObject({ ok: true, message: expect.stringMatching(/starts when you sign in/) });
    expect(r.win.runText()).toBe(`"${EXE}" --launched-at-login`);
    expect(r.settings.get().loginItem).toMatchObject({ preference: 'enabled', decidedBy: 'user', disabledBy: null, registeredPath: EXE });
  });

  it('rejects malformed action payloads before they reach the service', async () => {
    const r = rig();
    for (const bad of ['setLaunchAtLogin', { action: 'enableLaunchAtLogin' }, ['enableLaunchAtLogin'], null, 42]) {
      expect(await r.action(bad)).toEqual({ ok: false, message: 'Unknown action.' });
    }
    expect(r.win.writes).toHaveLength(1);
  });
});
