// The login-item service end to end against FakeWindowsLogin (Electron's write semantics),
// the real settings migration and patch validation, and an in-memory file system. MOCKED:
// no real registry, no Electron.
import { describe, expect, it } from 'vitest';
import {
  createLoginItemService,
  LOGIN_ITEM_ENV,
  LOGIN_ITEM_NAME,
  UNINSTALL_MARKER_FILE,
  UNINSTALLER_FILE,
  type LoginItemServiceOptions,
} from '../../../src/main/lifecycle/loginItem';
import { findV1OptOutInLogs, isV1OptOutLine } from '../../../src/main/lifecycle/loginItemEvidence';
import { UNSUPPORTED_PLATFORM_LOGIN_REASON } from '../../../src/main/lifecycle/loginItemReconcile';
import type { JsonReadStatus } from '../../../src/main/store/jsonStore';
import { migrateSettings, type Settings } from '../../../src/shared/settings';
import { memoryLogger } from './helpers';
import { DISABLE_HEX, FakeWindowsLogin, memoryFs, memorySettings, TASK_MANAGER_DISABLED, TASK_MANAGER_ENABLED } from './loginItemFakes';

const DIR = 'C:\\Users\\Ada Lovelace\\AppData\\Local\\Programs\\Desktop Cat';
const EXE = `${DIR}\\DesktopCat.exe`;
const USER_DATA = 'C:\\Users\\Ada Lovelace\\AppData\\Roaming\\Desktop Cat';
const LOGS = `${USER_DATA}\\logs`;
const MARKER = `${USER_DATA}\\${UNINSTALL_MARKER_FILE}`;
const EXPECTED_RUN = `"${EXE}" --launched-at-login`;
const V1_OPT_OUT_LINE = JSON.stringify({ t: '2026-09-01T10:00:00.000Z', l: 'info', s: 'app.login-item', m: 'login item updated', d: { openAtLogin: false } });

interface Rig {
  win: FakeWindowsLogin;
  settings: ReturnType<typeof memorySettings>;
  fs: ReturnType<typeof memoryFs>;
  log: ReturnType<typeof memoryLogger>;
  boot(over?: Partial<LoginItemServiceOptions>): ReturnType<typeof createLoginItemService>;
}

function rig(initial: Settings = migrateSettings({}), files: Record<string, string> = {}): Rig {
  const win = new FakeWindowsLogin();
  const settings = memorySettings(initial);
  const fs = memoryFs({ [`${DIR}\\${UNINSTALLER_FILE}`]: '', ...files });
  const log = memoryLogger();
  let t = 0;
  return {
    win,
    settings,
    fs,
    log,
    boot(over = {}) {
      const svc = createLoginItemService({
        writer: win,
        registry: win.readerFor(),
        settings,
        logger: log,
        execPath: EXE,
        userData: USER_DATA,
        logDir: LOGS,
        packaged: true,
        test: false,
        launchedAtLogin: false,
        env: {},
        settingsLoadStatus: 'ok',
        clock: () => (t += 10),
        fs,
        ...over,
      });
      svc.reconcileAtStartup();
      return svc;
    },
  };
}

const v1 = (launchAtLogin: boolean | undefined): Settings =>
  migrateSettings({ schemaVersion: 1, general: { catName: 'Miso', ...(launchAtLogin === undefined ? {} : { launchAtLogin }) } });

describe('first start of an installed copy', () => {
  it('registers exactly "<exe>" --launched-at-login with no StartupApproved value, once', () => {
    const r = rig();
    const svc = r.boot();
    expect(r.win.runText()).toBe(EXPECTED_RUN);
    expect(r.win.approvedHex()).toBeNull();
    expect(r.win.writes).toEqual([{ openAtLogin: true, path: EXE, args: ['--launched-at-login'], name: LOGIN_ITEM_NAME, enabled: true }]);
    expect(r.settings.get().loginItem).toMatchObject({ preference: 'unset', decidedBy: 'default', registeredPath: EXE, noticeShown: false });
    expect(svc.status()).toEqual({ enabled: true, preference: 'unset', disabledBy: null, active: true, writable: true, reason: null, showNotice: true });

    r.boot();
    r.boot({ launchedAtLogin: true });
    expect(r.win.writes).toHaveLength(1);
  });

  it('dismissing the notice is remembered', () => {
    const r = rig();
    const svc = r.boot();
    expect(svc.dismissNotice()).toEqual({ ok: true });
    expect(svc.status().showNotice).toBe(false);
    expect(r.settings.get().loginItem.noticeShown).toBe(true);
  });
});

describe('write gate', () => {
  const cases: Array<[string, Partial<LoginItemServiceOptions>, string]> = [
    ['unpackaged (npm run dev)', { packaged: false }, 'unpackaged'],
    ['test mode', { test: true }, 'test'],
    ['DESKTOP_CAT_LOGIN_ITEM=off (smoke runs)', { env: { [LOGIN_ITEM_ENV]: 'off' } }, 'env-off'],
    ['no uninstaller next to the exe (release/win-unpacked)', { execPath: 'C:\\repo\\release\\win-unpacked\\DesktopCat.exe' }, 'no-uninstaller'],
    ['a command line over 260 characters', { execPath: `${DIR}\\${'x'.repeat(240)}\\DesktopCat.exe` }, 'command-too-long'],
  ];
  it.each(cases)('%s: never writes and changes nothing', (_name, over, block) => {
    const r = rig();
    if (over.execPath?.includes('xxxx')) r.fs.files.set(`${DIR}\\${'x'.repeat(240)}\\${UNINSTALLER_FILE}`.toLowerCase(), '');
    const before = r.settings.get();
    const svc = r.boot(over);
    expect(svc.gate.blockedBy).toContain(block);
    expect(r.win.writes).toEqual([]);
    expect(r.settings.get()).toEqual(before);
    expect(svc.status()).toMatchObject({ writable: false, active: false, showNotice: false });
    // The switch is saved but still writes nothing.
    expect(svc.setLaunchAtLogin(false)).toMatchObject({ ok: true, message: expect.stringMatching(/cannot change Windows startup/) });
    expect(svc.setLaunchAtLogin(true).ok).toBe(true);
    expect(r.win.writes).toEqual([]);
    expect(r.settings.get().loginItem).toMatchObject({ preference: 'enabled', decidedBy: 'user' });
  });

  it('a dev run leaves a v1 dev electron.exe entry for the installed app to repair', () => {
    const r = rig();
    r.win.setRunText('"C:\\src\\cat\\node_modules\\electron\\dist\\electron.exe" "\\"C:\\src\\cat\\"" --launched-at-login');
    r.boot({ packaged: false, execPath: 'C:\\src\\cat\\node_modules\\electron\\dist\\electron.exe' });
    expect(r.win.writes).toEqual([]);
    r.boot();
    expect(r.win.runText()).toBe(EXPECTED_RUN);
  });
});

describe('Windows Startup apps always wins', () => {
  it('a Task Manager disable is never written over at boot, and is adopted as disabled/windows', () => {
    const r = rig();
    r.boot();
    r.win.taskManagerDisable();
    const svc = r.boot();
    expect(r.win.writes).toHaveLength(1);
    expect(r.win.approved.get(LOGIN_ITEM_NAME)?.data).toEqual(Buffer.from(TASK_MANAGER_DISABLED));
    expect(r.win.runText()).toBe(EXPECTED_RUN);
    expect(r.settings.get().loginItem).toMatchObject({ preference: 'disabled', decidedBy: 'windows', disabledBy: 'windows' });
    expect(svc.status()).toMatchObject({ enabled: false, active: false, disabledBy: 'windows' });
  });

  it('the in-app switch explains a Task Manager disable instead of overriding it', () => {
    const r = rig();
    r.boot();
    r.win.taskManagerDisable();
    const svc = r.boot();
    const res = svc.setLaunchAtLogin(true);
    expect(res).toMatchObject({ ok: true, message: expect.stringMatching(/Task Manager › Startup apps/) });
    expect(r.win.writes).toHaveLength(1);
    expect(r.win.approved.get(LOGIN_ITEM_NAME)?.data).toEqual(Buffer.from(TASK_MANAGER_DISABLED));
    expect(svc.status()).toMatchObject({ enabled: true, active: false, reason: expect.stringMatching(/Disabled in Windows Startup apps/) });
  });

  it('re-enabling in Task Manager is adopted without a write', () => {
    const r = rig();
    r.boot();
    r.win.taskManagerDisable();
    r.boot();
    r.win.taskManagerEnable();
    const svc = r.boot();
    expect(r.win.writes).toHaveLength(1);
    expect(r.settings.get().loginItem).toMatchObject({ preference: 'enabled', decidedBy: 'windows', disabledBy: null });
    expect(svc.status()).toMatchObject({ enabled: true, active: true });
    expect(r.win.approved.get(LOGIN_ITEM_NAME)?.data).toEqual(Buffer.from(TASK_MANAGER_ENABLED));
  });
});

describe('repairs and removals outside the app', () => {
  it('repairs a moved install, but not while started from the Run key', () => {
    const r = rig();
    r.boot();
    r.win.setRunText('"D:\\Old place\\DesktopCat.exe" --launched-at-login');
    r.boot({ launchedAtLogin: true });
    expect(r.win.writes).toHaveLength(1);
    r.boot();
    expect(r.win.writes).toHaveLength(2);
    expect(r.win.runText()).toBe(EXPECTED_RUN);
  });

  it('an entry removed outside the app stays removed (external opt-out)', () => {
    const r = rig();
    r.boot();
    r.win.deleteRun();
    const svc = r.boot();
    r.boot();
    expect(r.win.writes).toHaveLength(1);
    expect(r.win.runText()).toBeNull();
    expect(svc.status()).toMatchObject({ enabled: false, disabledBy: 'external' });
  });

  it('a reinstall (uninstaller marker) registers again and spends the marker', () => {
    const r = rig();
    r.boot();
    if (r.win.uninstall()) r.fs.files.set(MARKER.toLowerCase(), 'removed by the Desktop Cat uninstaller');
    expect(r.fs.existsSync(MARKER)).toBe(true);
    r.boot();
    expect(r.win.runText()).toBe(EXPECTED_RUN);
    expect(r.fs.existsSync(MARKER)).toBe(false);
  });

  it('keeps the marker when the reinstall registration did not land', () => {
    const r = rig();
    r.boot();
    r.win.uninstall();
    r.fs.files.set(MARKER.toLowerCase(), 'x');
    r.win.failWrites = 'ignore';
    r.boot();
    expect(r.fs.existsSync(MARKER)).toBe(true);
    r.win.failWrites = null;
    r.boot();
    expect(r.win.runText()).toBe(EXPECTED_RUN);
    expect(r.fs.existsSync(MARKER)).toBe(false);
  });
});

describe('the switch', () => {
  it('off leaves the entry listed in Startup apps as disabled; on deletes that record and starts again', () => {
    const r = rig();
    const svc = r.boot();
    r.win.taskManagerEnable();
    expect(svc.setLaunchAtLogin(false)).toMatchObject({ ok: true, message: expect.stringMatching(/no longer starts/) });
    // Electron's enabled:false record (03 + zeros): Task Manager shows Desktop Cat as Disabled.
    expect([r.win.runText(), r.win.approvedHex()]).toEqual([EXPECTED_RUN, DISABLE_HEX]);
    expect(r.win.writes.at(-1)).toMatchObject({ openAtLogin: true, enabled: false });
    expect(r.settings.get().loginItem).toMatchObject({ preference: 'disabled', decidedBy: 'user', disabledBy: 'user' });
    expect(svc.status()).toMatchObject({ enabled: false, disabledBy: 'user', active: false, reason: null });
    // Boots (also at sign-in) keep the user's own record: nothing written, still the user's off.
    r.boot();
    r.boot({ launchedAtLogin: true });
    expect(r.win.writes).toHaveLength(2);
    expect(r.settings.get().loginItem).toMatchObject({ preference: 'disabled', disabledBy: 'user' });
    expect(svc.setLaunchAtLogin(true)).toMatchObject({ ok: true });
    expect([r.win.runText(), r.win.approvedHex()]).toEqual([EXPECTED_RUN, null]);
    expect(svc.status()).toMatchObject({ enabled: true, active: true, showNotice: false });
  });

  it('off whose disabled record does not land removes the entry instead (nothing left that launches)', () => {
    const r = rig();
    const svc = r.boot();
    r.win.failApprovedWrites = true;
    expect(svc.setLaunchAtLogin(false)).toMatchObject({ ok: true });
    expect(r.win.writes.slice(-2)).toMatchObject([
      { openAtLogin: true, enabled: false },
      { openAtLogin: false, enabled: true },
    ]);
    expect([r.win.runText(), r.win.approvedHex()]).toEqual([null, null]);
    expect(r.settings.get().loginItem).toMatchObject({ preference: 'disabled', disabledBy: 'user' });
  });

  it('an in-app off survives a v1.0 round trip that drops the loginItem section (startup#3)', () => {
    const r = rig();
    const svc = r.boot();
    svc.setLaunchAtLogin(false);
    // v1.0 drops the unknown section and saves launchAtLogin:false; v1.1 then migrates that file again.
    r.settings.set(v1(false));
    expect(r.settings.get().loginItem).toMatchObject({ preference: 'unset', v1Value: false, registeredPath: null });
    const after = r.boot();
    expect(r.win.writes).toHaveLength(2);
    expect([r.win.runText(), r.win.approvedHex()]).toEqual([EXPECTED_RUN, DISABLE_HEX]);
    expect(r.settings.get().loginItem.preference).toBe('disabled');
    expect(after.status()).toMatchObject({ enabled: false, active: false, showNotice: false });
    // A settings file reset to defaults likewise.
    r.settings.set(migrateSettings({}));
    r.boot();
    expect(r.win.approvedHex()).toBe(DISABLE_HEX);
    expect(r.win.writes).toHaveLength(2);
  });

  it('the uninstaller still deletes both values of an in-app off, writes no marker, and the reinstall stays off', () => {
    const r = rig();
    const svc = r.boot();
    svc.setLaunchAtLogin(false);
    expect(r.win.uninstall()).toBe(false);
    expect([r.win.runText(), r.win.approvedHex()]).toEqual([null, null]);
    const reinstalled = r.boot();
    expect(r.win.writes).toHaveLength(2);
    expect(reinstalled.status()).toMatchObject({ enabled: false, disabledBy: 'user', active: false });
  });

  it('only a disabled StartupApproved value left: re-adds the entry still disabled so Task Manager lists it', () => {
    const r = rig();
    r.boot();
    r.win.taskManagerDisable();
    r.win.deleteRun();
    const svc = r.boot();
    expect(r.settings.get().loginItem).toMatchObject({ preference: 'disabled', disabledBy: 'external' });
    const res = svc.setLaunchAtLogin(true);
    expect(res.message).toMatch(/listed in Task Manager/);
    expect(r.win.runText()).toBe(EXPECTED_RUN);
    expect(r.win.approvedHex()).toBe('030000000000000000000000');
    expect(svc.status().active).toBe(false);
  });

  it('reports a write that throws or does not land, and does not record a registration', () => {
    for (const mode of ['throw', 'ignore'] as const) {
      const r = rig();
      r.win.failWrites = mode;
      const svc = r.boot();
      expect(r.settings.get().loginItem.registeredPath).toBeNull();
      expect(svc.debugInfo()).toMatchObject({ lastReconcile: { rule: 'register', ok: false } });
      expect(svc.setLaunchAtLogin(true)).toMatchObject({ ok: false, message: expect.stringMatching(/did not accept/) });
      expect(r.log.entries.some((e) => e.level === 'error')).toBe(true);
      // The next start retries instead of reading the missing entry as an opt-out.
      r.win.failWrites = null;
      r.boot();
      expect(r.win.runText()).toBe(EXPECTED_RUN);
    }
  });

  it('an unreadable registry decides and writes nothing at boot', () => {
    const r = rig();
    r.win.readError = 5;
    const svc = r.boot();
    expect(r.win.writes).toEqual([]);
    expect(svc.status()).toMatchObject({ active: false, reason: expect.stringMatching(/could not read/) });
    expect(svc.setLaunchAtLogin(true)).toMatchObject({ ok: true, message: expect.stringMatching(/could not be read/) });
    expect(r.win.writes).toEqual([]);
  });
});

describe('an on the user chose that has not taken effect yet (startup#2)', () => {
  it('a write that does not land is retried at the next start, not read as a removal outside the app', () => {
    const r = rig();
    const svc = r.boot();
    // An off whose disabled record did not land: both values removed.
    r.win.failApprovedWrites = true;
    svc.setLaunchAtLogin(false);
    r.win.failApprovedWrites = false;
    expect(r.win.runText()).toBeNull();
    // Security software ignores the write to HKCU Run.
    r.win.failWrites = 'ignore';
    expect(svc.setLaunchAtLogin(true)).toMatchObject({ ok: false, message: expect.stringMatching(/did not accept/) });
    expect(r.settings.get().loginItem).toMatchObject({ preference: 'enabled', decidedBy: 'user', registeredPath: null });
    r.win.failWrites = null;
    const next = r.boot();
    expect(next.debugInfo()).toMatchObject({ lastReconcile: { rule: 'register', ok: true } });
    expect(r.win.runText()).toBe(EXPECTED_RUN);
    expect(r.settings.get().loginItem).toMatchObject({ preference: 'enabled', decidedBy: 'user', registeredPath: EXE });
  });

  it('an on saved while the registry could not be read is applied at the next readable start', () => {
    const r = rig();
    const svc = r.boot();
    r.win.failApprovedWrites = true;
    svc.setLaunchAtLogin(false);
    r.win.failApprovedWrites = false;
    r.win.readError = 5;
    expect(svc.setLaunchAtLogin(true)).toMatchObject({ ok: true, message: expect.stringMatching(/could not be read/) });
    r.win.readError = null;
    r.boot();
    expect(r.win.runText()).toBe(EXPECTED_RUN);
    expect(r.settings.get().loginItem).toMatchObject({ preference: 'enabled', decidedBy: 'user', registeredPath: EXE });
  });

  it('an on over the app’s own opt-out record that does not land is retried at the next start (not taken for a Task Manager disable)', () => {
    const r = rig();
    const svc = r.boot();
    svc.setLaunchAtLogin(false);
    expect(r.win.approvedHex()).toBe(DISABLE_HEX);
    r.win.failWrites = 'ignore';
    expect(svc.setLaunchAtLogin(true).ok).toBe(false);
    expect(svc.status()).toMatchObject({ enabled: true, active: false, reason: 'Desktop Cat registers itself the next time it starts.' });
    r.win.failWrites = null;
    const next = r.boot();
    expect([r.win.runText(), r.win.approvedHex()]).toEqual([EXPECTED_RUN, null]);
    expect(next.status()).toMatchObject({ enabled: true, active: true, disabledBy: null });
  });
});

describe('status while the app runs (startup#0)', () => {
  it('a Windows disable undone in Task Manager shows as on at once, as the next start records it', () => {
    const r = rig();
    r.boot();
    r.win.taskManagerDisable();
    let now = 0;
    const svc = r.boot({ clock: () => now });
    expect(svc.status()).toMatchObject({ enabled: false, disabledBy: 'windows', active: false });
    // The user follows the on-screen advice while the app runs.
    r.win.taskManagerEnable();
    now += 5000;
    expect(svc.status()).toEqual({ enabled: true, preference: 'enabled', disabledBy: null, active: true, writable: true, reason: null, showNotice: false });
    // The next start records exactly that and removes nothing.
    r.boot();
    expect(r.settings.get().loginItem).toMatchObject({ preference: 'enabled', decidedBy: 'windows', disabledBy: null });
    expect(r.win.runText()).toBe(EXPECTED_RUN);
    expect(r.win.writes).toHaveLength(1);
  });

  it('an entry removed outside the app and added back outside it, likewise', () => {
    const r = rig();
    r.boot();
    r.win.deleteRun();
    let now = 0;
    const svc = r.boot({ clock: () => now });
    expect(svc.status()).toMatchObject({ enabled: false, disabledBy: 'external' });
    r.win.setRunText(EXPECTED_RUN);
    now += 5000;
    const s = svc.status();
    expect(s).toMatchObject({ enabled: true, disabledBy: null, active: true, reason: null });
    r.boot();
    expect(r.settings.get().loginItem).toMatchObject({ preference: 'enabled', disabledBy: null });
    expect(r.win.runText()).toBe(EXPECTED_RUN);
  });
});

describe('a start by the user while the app runs (startup#4)', () => {
  it('does the work sign-in boots had to skip: the entry left after an off is disabled again', () => {
    const r = rig();
    const svc = r.boot();
    // The off did not land (security software), so Windows keeps starting the app at sign-in.
    r.win.failWrites = 'ignore';
    expect(svc.setLaunchAtLogin(false).ok).toBe(false);
    r.win.failWrites = null;
    let running = svc;
    for (let i = 0; i < 3; i++) {
      running = r.boot({ launchedAtLogin: true });
      expect(running.debugInfo()).toMatchObject({ lastReconcile: { rule: 'opt-out-skipped-launched-at-login' } });
    }
    expect([r.win.runText(), r.win.approvedHex()]).toEqual([EXPECTED_RUN, null]);
    expect(running.status().reason).toMatch(/even while it is running/);
    // Opening Desktop Cat from the Start menu reaches the running instance (second instance).
    expect(running.reconcileOnUserLaunch()).toMatchObject({ rule: 'opt-out', ok: true });
    expect([r.win.runText(), r.win.approvedHex()]).toEqual([EXPECTED_RUN, DISABLE_HEX]);
    expect(running.status()).toMatchObject({ enabled: false, disabledBy: 'user', active: false, reason: null });
    expect(r.log.entries.some((e) => e.msg === 'login item reconciled' && e.data?.trigger === 'user-launch')).toBe(true);
  });

  it('repairs a stale entry a sign-in boot left, and is a no-op when nothing is pending', () => {
    const r = rig();
    r.boot();
    r.win.setRunText('"D:\\Old place\\DesktopCat.exe" --launched-at-login');
    const running = r.boot({ launchedAtLogin: true });
    expect(r.win.writes).toHaveLength(1);
    expect(running.reconcileOnUserLaunch()).toMatchObject({ rule: 'repair', ok: true });
    expect(r.win.runText()).toBe(EXPECTED_RUN);
    expect(running.reconcileOnUserLaunch()).toMatchObject({ rule: 'confirmed', write: null });
    expect(r.win.writes).toHaveLength(2);
  });

  it('never writes from a build that may not write', () => {
    const r = rig();
    r.win.setRunText('"D:\\Old place\\DesktopCat.exe" --launched-at-login');
    const svc = r.boot({ test: true, launchedAtLogin: true });
    expect(svc.reconcileOnUserLaunch()).toMatchObject({ rule: 'gate-closed', write: null });
    expect(r.win.writes).toEqual([]);
  });
});

describe('a reinstall after an off undone outside the app (startup#5)', () => {
  it('registers again: the uninstaller saw an approved entry and left its marker', () => {
    const r = rig();
    r.boot();
    r.win.taskManagerDisable();
    r.boot();
    expect(r.settings.get().loginItem).toMatchObject({ preference: 'disabled', disabledBy: 'windows' });
    // Re-enabled in Task Manager, then uninstalled in the same session (no start in between).
    r.win.taskManagerEnable();
    expect(r.win.uninstall()).toBe(true);
    r.fs.files.set(MARKER.toLowerCase(), 'removed by the Desktop Cat uninstaller');
    const reinstalled = r.boot();
    expect(reinstalled.debugInfo()).toMatchObject({ lastReconcile: { rule: 'register-after-uninstall', ok: true, markerConsumed: true } });
    expect([r.win.runText(), r.win.approvedHex()]).toEqual([EXPECTED_RUN, null]);
    expect(r.fs.existsSync(MARKER)).toBe(false);
    expect(reinstalled.status()).toMatchObject({ enabled: true, active: true });
  });

  it('an in-app off is kept: its disabled record gets no marker from the uninstaller', () => {
    const r = rig();
    const svc = r.boot();
    svc.setLaunchAtLogin(false);
    expect(r.win.uninstall()).toBe(false);
    r.boot();
    expect(r.win.runText()).toBeNull();
    expect(r.settings.get().loginItem).toMatchObject({ preference: 'disabled', disabledBy: 'user' });
  });
});

describe('settings that are not trustworthy', () => {
  it.each(['corrupt', 'unreadable'] satisfies JsonReadStatus[])('%s settings: no writes that session; a missing entry is recorded as off', (status) => {
    const r = rig();
    r.boot({ settingsLoadStatus: status });
    expect(r.win.writes).toEqual([]);
    expect(r.settings.get().loginItem).toMatchObject({ preference: 'disabled', disabledBy: 'external' });
    r.boot();
    expect(r.win.writes).toEqual([]);
  });

  it('corrupt settings with our entry present keep it on', () => {
    const r = rig();
    r.win.setRunText(EXPECTED_RUN);
    r.boot({ settingsLoadStatus: 'corrupt' });
    expect(r.win.writes).toEqual([]);
    expect(r.settings.get().loginItem).toMatchObject({ preference: 'unset', registeredPath: EXE });
  });
});

describe('migration from v1 settings', () => {
  it('v1 true: kept on (no notice: the user chose it)', () => {
    const r = rig(v1(true));
    expect(r.settings.get().loginItem).toMatchObject({ preference: 'enabled', decidedBy: 'migration', v1Value: true });
    const svc = r.boot();
    expect(r.win.runText()).toBe(EXPECTED_RUN);
    expect(svc.status()).toMatchObject({ enabled: true, active: true, showNotice: false });
  });

  it('v1 false without evidence: the new default applies, with the one-time notice', () => {
    const r = rig(v1(false));
    const svc = r.boot();
    expect(r.win.runText()).toBe(EXPECTED_RUN);
    expect(svc.status().showNotice).toBe(true);
  });

  it('v1 false with a logged v1 opt-out: stays off', () => {
    const r = rig(v1(false), { [`${LOGS}\\main.2.log`]: `${JSON.stringify({ m: 'other' })}\n${V1_OPT_OUT_LINE}\n` });
    const svc = r.boot();
    expect(r.win.writes).toEqual([]);
    expect(r.settings.get().loginItem).toMatchObject({ preference: 'disabled', decidedBy: 'migration', disabledBy: 'user' });
    expect(svc.status().showNotice).toBe(false);
  });

  it('v1 false with an orphaned Task Manager disable: stays off', () => {
    const r = rig(v1(false));
    r.win.taskManagerDisable();
    r.boot();
    expect(r.win.writes).toEqual([]);
    expect(r.settings.get().loginItem).toMatchObject({ preference: 'disabled', disabledBy: 'external' });
  });

  it('v1 file without the field, and a corrupt v1 file', () => {
    const missing = rig(v1(undefined));
    expect(missing.settings.get().loginItem).toMatchObject({ preference: 'unset', v1Value: null });
    missing.boot();
    expect(missing.win.runText()).toBe(EXPECTED_RUN);

    // A corrupt file loads as defaults with status 'corrupt': no writes this session.
    const corrupt = rig(migrateSettings(null));
    corrupt.boot({ settingsLoadStatus: 'corrupt' });
    expect(corrupt.win.writes).toEqual([]);
  });
});

describe('v1 log evidence', () => {
  it('matches only the v1 opt-out line', () => {
    expect(isV1OptOutLine(V1_OPT_OUT_LINE)).toBe(true);
    expect(isV1OptOutLine(V1_OPT_OUT_LINE.replace('false', 'true'))).toBe(false);
    expect(isV1OptOutLine(JSON.stringify({ s: 'app.login-item', m: 'login item change skipped (test mode)', d: { openAtLogin: false } }))).toBe(false);
    expect(isV1OptOutLine(JSON.stringify({ s: 'app.other', m: 'login item updated', d: { openAtLogin: false } }))).toBe(false);
    expect(isV1OptOutLine('{"m":"login item updated", broken')).toBe(false);
  });

  it('scans main.log and its rotations only, and treats a missing folder as no evidence', () => {
    const fs = memoryFs({ [`${LOGS}\\notes.txt`]: V1_OPT_OUT_LINE, [`${LOGS}\\main.log`]: '' });
    expect(findV1OptOutInLogs(LOGS, fs)).toBe(false);
    fs.files.set(`${LOGS}\\main.1.log`.toLowerCase(), V1_OPT_OUT_LINE);
    expect(findV1OptOutInLogs(LOGS, fs)).toBe(true);
    expect(findV1OptOutInLogs('C:\\nowhere', fs)).toBe(false);
    expect(findV1OptOutInLogs(null, fs)).toBe(false);
  });
});

describe('GizeVerse: platforms without login items (ADR 0004 §7)', () => {
  it('an installed copy on an unsupported platform writes nothing and explains why', () => {
    const r = rig();
    const svc = r.boot({ platformSupported: false });
    expect(r.win.writes).toEqual([]);
    expect(r.win.run.size).toBe(0);
    const s = svc.status();
    expect(s.writable).toBe(false);
    expect(s.reason).toBe(UNSUPPORTED_PLATFORM_LOGIN_REASON);
    svc.setLaunchAtLogin(true);
    expect(r.win.writes).toEqual([]);
  });

  it('the Windows default (platformSupported omitted) still registers the installed copy', () => {
    const r = rig();
    r.boot();
    expect(r.win.runText()).toBe(EXPECTED_RUN);
  });
});
