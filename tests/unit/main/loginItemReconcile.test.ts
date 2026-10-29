// Pure reconcile rules (startup.md §4) as tables over preference × Run state × StartupApproved
// × flags, plus a seeded property test: boots without a user action never bring startup back
// after an opt-out.
import { describe, expect, it } from 'vitest';
import { formatCommandLine } from '../../../src/main/lifecycle/loginItemCommandLine';
import {
  applyUserChoice,
  evaluateWriteGate,
  interpretSnapshot,
  loginItemStatus,
  reconcile,
  type LoginItemSettings,
  type ReconcileFlags,
  type WindowsLoginState,
} from '../../../src/main/lifecycle/loginItemReconcile';
import { defaultSettings } from '../../../src/shared/settings';
import { FakeWindowsLogin, seededRandom, TASK_MANAGER_DISABLED, TASK_MANAGER_ENABLED } from './loginItemFakes';

const EXE = 'C:\\Users\\Ada Lovelace\\AppData\\Local\\Programs\\Desktop Cat\\DesktopCat.exe';
const ARGS = ['--launched-at-login'] as const;
const OLD_EXE = 'D:\\Apps\\Desktop Cat\\DesktopCat.exe';
const DEV_ENTRY = '"C:\\src\\cat\\node_modules\\electron\\dist\\electron.exe" "\\"C:\\src\\cat\\"" --launched-at-login';

type Pref = 'unset' | 'enabled' | 'disabled/user' | 'disabled/windows' | 'disabled/external';
type Run = 'absent' | 'ours' | 'stale' | 'electron';
type Sa = 'absent' | '00' | '02' | '03+FILETIME' | '06';

const PREFS: Pref[] = ['unset', 'enabled', 'disabled/user', 'disabled/windows', 'disabled/external'];
const RUNS: Run[] = ['absent', 'ours', 'stale', 'electron'];
const SAS: Sa[] = ['absent', '00', '02', '03+FILETIME', '06'];

function loginItem(pref: Pref, registeredBefore: boolean): LoginItemSettings {
  const base = defaultSettings().loginItem;
  const registeredPath = registeredBefore ? EXE : null;
  switch (pref) {
    case 'unset':
      return { ...base, registeredPath };
    case 'enabled':
      return { ...base, preference: 'enabled', decidedBy: 'user', registeredPath };
    default: {
      const by = pref.split('/')[1] as 'user' | 'windows' | 'external';
      return { ...base, preference: 'disabled', decidedBy: by === 'user' ? 'user' : 'windows', disabledBy: by, registeredPath };
    }
  }
}

function windowsState(run: Run, sa: Sa): WindowsLoginState {
  const w = new FakeWindowsLogin();
  if (run === 'ours') w.setRunText(formatCommandLine(EXE, ARGS));
  if (run === 'stale') w.setRunText(formatCommandLine(OLD_EXE, ARGS));
  if (run === 'electron') w.setRunText(DEV_ENTRY);
  const bytes: Record<Exclude<Sa, 'absent'>, number[]> = {
    '00': [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
    '02': TASK_MANAGER_ENABLED,
    '03+FILETIME': TASK_MANAGER_DISABLED,
    '06': [6, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
  };
  if (sa !== 'absent') w.setApproved(bytes[sa]);
  return interpretSnapshot(w.readerFor().read());
}

const NORMAL: ReconcileFlags = { execPath: EXE, args: ARGS, writable: true, settingsTrusted: true, launchedAtLogin: false, uninstallMarker: false, v1OptOutLogged: false };

type Flag = 'normal' | 'launched-at-login' | 'unpackaged' | 'test' | 'no-uninstaller' | 'env-off' | 'command-too-long' | 'corrupt-settings';
const FLAGS: Flag[] = ['normal', 'launched-at-login', 'unpackaged', 'test', 'no-uninstaller', 'env-off', 'command-too-long', 'corrupt-settings'];

function flagsFor(flag: Flag): ReconcileFlags {
  const gate = evaluateWriteGate({
    packaged: flag !== 'unpackaged',
    test: flag === 'test',
    envOff: flag === 'env-off',
    uninstallerPresent: flag !== 'no-uninstaller',
    commandLineChars: flag === 'command-too-long' ? 261 : formatCommandLine(EXE, ARGS).length,
  });
  return { ...NORMAL, writable: gate.writable, launchedAtLogin: flag === 'launched-at-login', settingsTrusted: flag !== 'corrupt-settings' };
}

const SA_DISABLED = (sa: Sa): boolean => sa === '03+FILETIME' || sa === '06';

interface Expected {
  pref: 'unset' | 'enabled' | 'disabled';
  disabledBy: LoginItemSettings['disabledBy'];
  write: 'register' | 'remove' | null;
}

/** Declarative expectations for a writable, trusted boot not started at sign-in. */
function expected(pref: Pref, run: Run, sa: Sa, registeredBefore: boolean): Expected {
  const li = loginItem(pref, registeredBefore);
  const keep = (write: Expected['write'] = null): Expected => ({ pref: li.preference, disabledBy: li.disabledBy, write });
  if (SA_DISABLED(sa)) {
    if (run !== 'absent') return { pref: 'disabled', disabledBy: 'windows', write: null };
    return pref.startsWith('disabled') ? keep() : { pref: 'disabled', disabledBy: 'external', write: null };
  }
  if (run === 'absent') {
    if (pref.startsWith('disabled')) return keep();
    return registeredBefore ? { pref: 'disabled', disabledBy: 'external', write: null } : keep('register');
  }
  const stale = run !== 'ours';
  if (pref === 'disabled/user') return keep('remove');
  if (pref === 'disabled/windows' || pref === 'disabled/external') return { pref: 'enabled', disabledBy: null, write: stale ? 'register' : null };
  return keep(stale ? 'register' : null);
}

const writeKind = (w: { openAtLogin: boolean } | null): Expected['write'] => (w === null ? null : w.openAtLogin ? 'register' : 'remove');

describe('reconcile: preference × Run state × StartupApproved (writable boot)', () => {
  const rows = PREFS.flatMap((pref) => RUNS.flatMap((run) => SAS.flatMap((sa) => [false, true].map((reg) => [pref, run, sa, reg] as const))));
  it.each(rows)('%s / run %s / approved %s / registered before: %s', (pref, run, sa, reg) => {
    const r = reconcile(windowsState(run, sa), loginItem(pref, reg), NORMAL);
    const want = expected(pref, run, sa, reg);
    expect({ pref: r.next.preference, disabledBy: r.next.disabledBy, write: writeKind(r.write) }).toEqual(want);
    if (r.write) expect(r.write.enabled).toBe(true);
    if (r.write?.openAtLogin) expect(r.next.registeredPath).toBe(EXE);
  });
});

describe('reconcile: invariants across every flag combination', () => {
  const rows = FLAGS.flatMap((flag) => PREFS.flatMap((pref) => RUNS.flatMap((run) => SAS.map((sa) => [flag, pref, run, sa] as const))));
  it.each(rows)('%s / %s / run %s / approved %s', (flag, pref, run, sa) => {
    for (const reg of [false, true]) {
      const li = loginItem(pref, reg);
      const f = flagsFor(flag);
      const r = reconcile(windowsState(run, sa), li, f);
      // A Task Manager disable is never written over.
      if (SA_DISABLED(sa)) expect(r.write).toBeNull();
      // Programs started from Run do not write the key.
      if (flag === 'launched-at-login') expect(r.write).toBeNull();
      // Dev, test, portable, env-off and over-long builds never write and change nothing.
      if (!f.writable) {
        expect(r.write).toBeNull();
        expect(r.next).toEqual(li);
        expect(r.consumeMarker).toBe(false);
      }
      // Damaged settings: no writes, and a missing entry is recorded as off.
      if (flag === 'corrupt-settings') {
        expect(r.write).toBeNull();
        if (run === 'absent' && !pref.startsWith('disabled')) expect(r.next.preference).toBe('disabled');
      }
      // Registration only while the preference resolves to on.
      if (r.write?.openAtLogin) expect(r.next.preference).not.toBe('disabled');
      if (r.write && !r.write.openAtLogin) expect(r.next.preference).toBe('disabled');
      // A failed write never records a registration.
      if (r.write?.openAtLogin) expect(r.nextIfWriteFails.registeredPath).toBe(li.registeredPath);
    }
  });
});

describe('reconcile: specific rules', () => {
  const base = defaultSettings().loginItem;

  it('registers a missing entry again after an uninstall (marker), and spends the marker', () => {
    const r = reconcile(windowsState('absent', 'absent'), { ...base, registeredPath: OLD_EXE }, { ...NORMAL, uninstallMarker: true });
    expect(r).toMatchObject({ rule: 'register-after-uninstall', write: { openAtLogin: true, enabled: true }, consumeMarker: true });
    expect(r.next.registeredPath).toBe(EXE);
  });

  it('keeps an opt-out across a reinstall even with the marker', () => {
    for (const disabledBy of ['user', 'windows', 'external'] as const) {
      const li: LoginItemSettings = { ...base, preference: 'disabled', decidedBy: 'user', disabledBy, registeredPath: EXE };
      const r = reconcile(windowsState('absent', 'absent'), li, { ...NORMAL, uninstallMarker: true });
      expect(r.write).toBeNull();
      expect(r.next.preference).toBe('disabled');
      expect(r.consumeMarker).toBe(true);
    }
  });

  it('skips repairing a stale entry when started from it at sign-in, and repairs on the next manual start', () => {
    const li = { ...base, registeredPath: OLD_EXE };
    const atLogin = reconcile(windowsState('stale', 'absent'), li, { ...NORMAL, launchedAtLogin: true });
    expect(atLogin).toMatchObject({ rule: 'repair-skipped-launched-at-login', write: null });
    const manual = reconcile(windowsState('stale', 'absent'), li, NORMAL);
    expect(manual).toMatchObject({ rule: 'repair', write: { openAtLogin: true, enabled: true } });
    expect(reconcile(windowsState('electron', '02'), base, NORMAL).rule).toBe('repair');
  });

  it('v1 false: logged opt-out → disabled by the migration; orphan → disabled/external; no evidence → default on', () => {
    const v1False: LoginItemSettings = { ...base, v1Value: false };
    expect(reconcile(windowsState('absent', 'absent'), v1False, { ...NORMAL, v1OptOutLogged: true })).toMatchObject({
      rule: 'v1-opt-out',
      write: null,
      next: { preference: 'disabled', decidedBy: 'migration', disabledBy: 'user' },
    });
    expect(reconcile(windowsState('absent', '03+FILETIME'), v1False, NORMAL)).toMatchObject({
      rule: 'orphan-disabled',
      write: null,
      next: { preference: 'disabled', decidedBy: 'migration', disabledBy: 'external' },
    });
    expect(reconcile(windowsState('absent', 'absent'), v1False, NORMAL)).toMatchObject({ rule: 'register', next: { preference: 'unset', decidedBy: 'default' } });
  });

  it('records an existing entry when settings were damaged, without writing', () => {
    const r = reconcile(windowsState('ours', 'absent'), base, { ...NORMAL, settingsTrusted: false });
    expect(r).toMatchObject({ rule: 'untrusted-settings', write: null, next: { preference: 'unset', registeredPath: EXE } });
  });

  it('treats an unreadable registry as "decide nothing"', () => {
    const w = new FakeWindowsLogin();
    w.readError = 5;
    const state = interpretSnapshot(w.readerFor().read());
    expect(state).toMatchObject({ readable: false, error: '5, 5' });
    expect(reconcile(state, base, NORMAL)).toMatchObject({ rule: 'registry-unreadable', write: null, next: base });
  });

  it('reads a non-string Run value as a stale entry and an odd StartupApproved type by its bytes', () => {
    const w = new FakeWindowsLogin();
    w.run.set('io.github.enesiltas.desktopcat', { type: 3, data: Buffer.from([1, 2, 3]) });
    w.setApproved([0x03, 0], 'io.github.enesiltas.desktopcat', 1);
    const state = interpretSnapshot(w.readerFor().read());
    expect(state.run).toEqual({ raw: '', program: '', args: [] });
    expect(state.approved).toBe('disabled');
  });
});

describe('the user switch', () => {
  const base = defaultSettings().loginItem;
  const target = { execPath: EXE, args: ARGS, writable: true };

  it('enable: never overrides a Task Manager disable', () => {
    const r = applyUserChoice(true, windowsState('ours', '03+FILETIME'), { ...base, preference: 'disabled', decidedBy: 'windows', disabledBy: 'windows' }, target);
    expect(r).toMatchObject({ outcome: 'windows-disabled', write: null, next: { preference: 'enabled', decidedBy: 'user', disabledBy: null } });
  });

  it('enable with only an orphaned disable: re-adds the entry still disabled so Task Manager can show it', () => {
    const r = applyUserChoice(true, windowsState('absent', '03+FILETIME'), base, target);
    expect(r).toMatchObject({ outcome: 'windows-disabled-restored', write: { openAtLogin: true, enabled: false } });
  });

  it('enable registers or repairs; disable removes; both record the user as the decider', () => {
    expect(applyUserChoice(true, windowsState('absent', 'absent'), base, target)).toMatchObject({ outcome: 'registered', write: { openAtLogin: true, enabled: true } });
    expect(applyUserChoice(true, windowsState('stale', '02'), base, target)).toMatchObject({ outcome: 'registered' });
    expect(applyUserChoice(true, windowsState('ours', 'absent'), base, target)).toMatchObject({ outcome: 'unchanged', write: null });
    expect(applyUserChoice(false, windowsState('ours', 'absent'), base, target)).toMatchObject({
      outcome: 'removed',
      write: { openAtLogin: false },
      next: { preference: 'disabled', decidedBy: 'user', disabledBy: 'user' },
    });
    expect(applyUserChoice(false, windowsState('absent', '03+FILETIME'), base, target)).toMatchObject({ outcome: 'unchanged', write: null });
  });

  it('saves the choice but writes nothing in a build that may not write', () => {
    for (const on of [true, false]) {
      const r = applyUserChoice(on, windowsState('absent', 'absent'), base, { ...target, writable: false });
      expect(r).toMatchObject({ outcome: 'not-writable', write: null, next: { preference: on ? 'enabled' : 'disabled' } });
    }
  });
});

describe('status', () => {
  const base = defaultSettings().loginItem;
  const target = { execPath: EXE, args: ARGS, writable: true };

  it('is active only for our approved entry, and shows the one-time notice only for a default registration', () => {
    const fresh = loginItemStatus({ ...base, registeredPath: EXE }, windowsState('ours', 'absent'), target);
    expect(fresh).toEqual({ enabled: true, preference: 'unset', disabledBy: null, active: true, writable: true, reason: null, showNotice: true });
    expect(loginItemStatus({ ...base, noticeShown: true }, windowsState('ours', 'absent'), target).showNotice).toBe(false);
    expect(loginItemStatus({ ...base, preference: 'enabled', decidedBy: 'migration' }, windowsState('ours', 'absent'), target).showNotice).toBe(false);
    expect(loginItemStatus(base, windowsState('stale', 'absent'), target)).toMatchObject({ active: false, reason: expect.stringMatching(/another location/) });
    expect(loginItemStatus(base, windowsState('ours', '03+FILETIME'), target)).toMatchObject({ active: false, reason: expect.stringMatching(/Task Manager/) });
  });

  it('says a dev or portable build cannot manage it', () => {
    const s = loginItemStatus(base, windowsState('absent', 'absent'), { ...target, writable: false });
    expect(s).toMatchObject({ writable: false, active: false, showNotice: false, reason: expect.stringMatching(/Not available in this build/) });
  });
});

// ---------------------------------------------------------------------------
// Property: boots without a user action never bring startup back after an opt-out.

type Ev = 'boot' | 'boot-at-login' | 'tm-disable' | 'tm-enable' | 'delete-run' | 'move' | 'uninstall-reinstall' | 'user-on' | 'user-off' | 'readd-external';
const EVENTS: Ev[] = ['boot', 'boot', 'boot', 'boot-at-login', 'tm-disable', 'tm-enable', 'delete-run', 'move', 'uninstall-reinstall', 'user-on', 'user-off', 'readd-external'];

describe('property: no silent re-enable', () => {
  it('holds over 3000 seeded random histories of 60 events', () => {
    for (let seed = 1; seed <= 3000; seed++) {
      const rnd = seededRandom(seed);
      const w = new FakeWindowsLogin();
      let li = defaultSettings().loginItem;
      let exe = EXE;
      let marker = false;
      /** An opt-out happened and neither the user nor Windows' Startup apps switched it on since. */
      let optedOut = false;
      const trace: string[] = [];
      const launches = (): boolean => {
        const s = interpretSnapshot(w.readerFor().read());
        return s.run !== null && s.approved !== 'disabled';
      };
      const apply = (write: { openAtLogin: boolean; enabled: boolean } | null): void => {
        if (write) w.setLoginItemSettings({ openAtLogin: write.openAtLogin, path: exe, args: [...ARGS], name: 'io.github.enesiltas.desktopcat', enabled: write.enabled });
      };
      const boot = (atLogin: boolean): void => {
        const state = interpretSnapshot(w.readerFor().read());
        const before = launches();
        const saBefore = w.approvedHex();
        const wasDisabledBySa = state.approved === 'disabled';
        const r = reconcile(state, li, { ...NORMAL, execPath: exe, launchedAtLogin: atLogin, uninstallMarker: marker });
        apply(r.write);
        li = r.next;
        if (r.consumeMarker) marker = false;
        const ctx = `seed ${seed}: ${trace.join(' → ')}`;
        if (optedOut) expect(launches() && !before, ctx).toBe(false);
        if (wasDisabledBySa) expect(w.approvedHex(), ctx).toBe(saBefore);
        if (li.preference === 'disabled') optedOut = true;
      };
      for (let step = 0; step < 60; step++) {
        const ev = EVENTS[Math.floor(rnd() * EVENTS.length)] as Ev;
        trace.push(ev);
        const state = interpretSnapshot(w.readerFor().read());
        switch (ev) {
          case 'boot':
          case 'boot-at-login':
            boot(ev === 'boot-at-login');
            break;
          case 'tm-disable':
            if (state.run !== null) {
              w.taskManagerDisable();
              optedOut = true;
            }
            break;
          case 'tm-enable':
            if (state.run !== null && state.approved === 'disabled') {
              w.taskManagerEnable();
              optedOut = false;
            }
            break;
          case 'delete-run':
            // An opt-out once the app has registered (an entry it never saw is not its own).
            if (state.run !== null) {
              w.deleteRun();
              if (li.registeredPath !== null) optedOut = true;
            }
            break;
          case 'readd-external':
            // A restore (.reg import, system restore) of an entry the app had registered.
            if (state.run === null && li.registeredPath !== null) {
              w.setRunText(formatCommandLine(exe, ARGS));
              if (state.approved !== 'disabled') optedOut = false;
            }
            break;
          case 'move':
            exe = exe === EXE ? OLD_EXE : EXE;
            break;
          case 'uninstall-reinstall':
            // The installer starts the reinstalled app (or the user does): nothing else
            // writes our value in between. Without a Run value it cannot start at sign-in.
            marker = w.uninstall() || marker;
            boot(false);
            break;
          case 'user-on':
          case 'user-off': {
            const r = applyUserChoice(ev === 'user-on', state, li, { execPath: exe, args: ARGS, writable: true });
            apply(r.write);
            li = r.next;
            // The service spends a pending uninstall marker on any explicit choice.
            marker = false;
            optedOut = ev === 'user-off';
            break;
          }
        }
      }
    }
  });
});
