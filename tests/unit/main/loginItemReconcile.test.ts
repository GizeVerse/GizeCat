// Pure reconcile rules (startup.md §4) as tables over preference × Run state × StartupApproved
// × flags, plus a seeded property test: boots without a user action never bring startup back
// after an opt-out.
import { describe, expect, it } from 'vitest';
import { formatCommandLine } from '../../../src/main/lifecycle/loginItemCommandLine';
import {
  applyUserChoice,
  describeState,
  evaluateWriteGate,
  interpretSnapshot,
  liveLoginItem,
  loginItemStatus,
  needsV1Evidence,
  reconcile,
  type LoginItemSettings,
  type ReconcileFlags,
  type WindowsLoginState,
} from '../../../src/main/lifecycle/loginItemReconcile';
import { defaultSettings } from '../../../src/shared/settings';
import { DISABLE_BYTES, FakeWindowsLogin, seededRandom, TASK_MANAGER_DISABLED, TASK_MANAGER_ENABLED } from './loginItemFakes';

const EXE = 'C:\\Users\\Ada Lovelace\\AppData\\Local\\Programs\\Desktop Cat\\DesktopCat.exe';
const ARGS = ['--launched-at-login'] as const;
const OLD_EXE = 'D:\\Apps\\Desktop Cat\\DesktopCat.exe';
const DEV_ENTRY = '"C:\\src\\cat\\node_modules\\electron\\dist\\electron.exe" "\\"C:\\src\\cat\\"" --launched-at-login';

type Pref = 'unset' | 'enabled' | 'disabled/user' | 'disabled/windows' | 'disabled/external';
type Run = 'absent' | 'ours' | 'stale' | 'electron';
/** '03' is Electron's own disabled record (03 + zeros), written by the in-app opt-out. */
type Sa = 'absent' | '00' | '02' | '03' | '03+FILETIME' | '06';

const PREFS: Pref[] = ['unset', 'enabled', 'disabled/user', 'disabled/windows', 'disabled/external'];
const RUNS: Run[] = ['absent', 'ours', 'stale', 'electron'];
const SAS: Sa[] = ['absent', '00', '02', '03', '03+FILETIME', '06'];

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
    '03': DISABLE_BYTES,
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

const SA_DISABLED = (sa: Sa): boolean => sa === '03' || sa === '03+FILETIME' || sa === '06';

interface Expected {
  pref: 'unset' | 'enabled' | 'disabled';
  disabledBy: LoginItemSettings['disabledBy'];
  /** 'disable': our entry written disabled (the opt-out record), with removing it as the fallback. */
  write: 'register' | 'disable' | 'remove' | null;
}

/** Declarative expectations for a writable, trusted boot not started at sign-in. */
function expected(pref: Pref, run: Run, sa: Sa, registeredBefore: boolean): Expected {
  const li = loginItem(pref, registeredBefore);
  const keep = (write: Expected['write'] = null): Expected => ({ pref: li.preference, disabledBy: li.disabledBy, write });
  if (SA_DISABLED(sa)) {
    // The in-app opt-out's own record stays the user's, and an in-app on saved over it without
    // taking effect (no registered path) is applied; any other disable is Windows'.
    if (run !== 'absent') {
      if (sa === '03' && pref === 'disabled/user') return keep();
      if (sa === '03' && pref === 'enabled' && !registeredBefore) return keep('register');
      return { pref: 'disabled', disabledBy: 'windows', write: null };
    }
    return pref.startsWith('disabled') ? keep() : { pref: 'disabled', disabledBy: 'external', write: null };
  }
  if (run === 'absent') {
    if (pref.startsWith('disabled')) return keep();
    return registeredBefore ? { pref: 'disabled', disabledBy: 'external', write: null } : keep('register');
  }
  const stale = run !== 'ours';
  const adopted: Expected = { pref: 'enabled', disabledBy: null, write: stale ? 'register' : null };
  // After an in-app opt-out an explicit "enabled" value is Startup apps switching it on; without one, the opt-out is applied again.
  if (pref === 'disabled/user') return sa === 'absent' ? keep('disable') : adopted;
  if (pref === 'disabled/windows' || pref === 'disabled/external') return adopted;
  return keep(stale ? 'register' : null);
}

const writeKind = (w: { openAtLogin: boolean; enabled: boolean } | null): Expected['write'] =>
  w === null ? null : !w.openAtLogin ? 'remove' : w.enabled ? 'register' : 'disable';
const REMOVE = { openAtLogin: false, enabled: true };

describe('reconcile: preference × Run state × StartupApproved (writable boot)', () => {
  const rows = PREFS.flatMap((pref) => RUNS.flatMap((run) => SAS.flatMap((sa) => [false, true].map((reg) => [pref, run, sa, reg] as const))));
  it.each(rows)('%s / run %s / approved %s / registered before: %s', (pref, run, sa, reg) => {
    const r = reconcile(windowsState(run, sa), loginItem(pref, reg), NORMAL);
    const want = expected(pref, run, sa, reg);
    expect({ pref: r.next.preference, disabledBy: r.next.disabledBy, write: writeKind(r.write) }).toEqual(want);
    expect(r.fallback).toEqual(writeKind(r.write) === 'disable' ? REMOVE : null);
    if (writeKind(r.write) === 'register') expect(r.next.registeredPath).toBe(EXE);
  });
});

describe('reconcile: invariants across every flag combination', () => {
  const rows = FLAGS.flatMap((flag) => PREFS.flatMap((pref) => RUNS.flatMap((run) => SAS.map((sa) => [flag, pref, run, sa] as const))));
  it.each(rows)('%s / %s / run %s / approved %s', (flag, pref, run, sa) => {
    for (const reg of [false, true]) {
      const li = loginItem(pref, reg);
      const f = flagsFor(flag);
      const r = reconcile(windowsState(run, sa), li, f);
      // A disable made in Startup apps is never written over; the app's own record (03 + zeros)
      // only for the user's in-app on that was saved without taking effect.
      if (SA_DISABLED(sa) && sa !== '03') expect(r.write).toBeNull();
      if (sa === '03' && r.write) expect([pref, reg, writeKind(r.write)]).toEqual(['enabled', false, 'register']);
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
      // Registration only while the preference resolves to on; anything else written is an opt-out.
      const registers = writeKind(r.write) === 'register';
      if (registers) expect(r.next.preference).not.toBe('disabled');
      if (r.write && !registers) expect(r.next.preference).toBe('disabled');
      // A failed write never records a registration.
      if (registers) expect(r.nextIfWriteFails.registeredPath).toBe(li.registeredPath);
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

  it('keeps an in-app opt-out across a reinstall even with the marker', () => {
    const li: LoginItemSettings = { ...base, preference: 'disabled', decidedBy: 'user', disabledBy: 'user', registeredPath: EXE };
    const r = reconcile(windowsState('absent', 'absent'), li, { ...NORMAL, uninstallMarker: true });
    expect(r).toMatchObject({ rule: 'off', write: null, consumeMarker: true, next: li });
  });

  it('a reinstall after an off from the Windows side that was undone there registers again (the marker proves the entry was approved)', () => {
    for (const disabledBy of ['windows', 'external'] as const) {
      const li: LoginItemSettings = { ...base, preference: 'disabled', decidedBy: 'windows', disabledBy, registeredPath: EXE };
      const r = reconcile(windowsState('absent', 'absent'), li, { ...NORMAL, uninstallMarker: true });
      expect(r).toMatchObject({ rule: 'register-after-uninstall', write: { openAtLogin: true, enabled: true }, consumeMarker: true });
      expect(r.next).toMatchObject({ preference: 'enabled', decidedBy: 'windows', disabledBy: null, registeredPath: EXE });
      // A registration that does not land keeps the recorded off (and the marker, see the service).
      expect(r.nextIfWriteFails).toEqual(li);
      // Without the marker the off stays.
      expect(reconcile(windowsState('absent', 'absent'), li, NORMAL)).toMatchObject({ rule: 'off', write: null });
      // Never written at sign-in.
      expect(reconcile(windowsState('absent', 'absent'), li, { ...NORMAL, uninstallMarker: true, launchedAtLogin: true })).toMatchObject({
        rule: 'register-skipped-launched-at-login',
        write: null,
        consumeMarker: false,
      });
    }
  });

  it('the in-app opt-out record (Electron 03 + zeros) keeps disabled/user; a Task Manager disable over it is Windows', () => {
    const optedOut: LoginItemSettings = { ...base, preference: 'disabled', decidedBy: 'user', disabledBy: 'user', registeredPath: EXE };
    expect(reconcile(windowsState('ours', '03'), optedOut, NORMAL)).toMatchObject({ rule: 'off', write: null, next: optedOut });
    expect(reconcile(windowsState('ours', '03+FILETIME'), optedOut, NORMAL)).toMatchObject({ rule: 'windows-disabled', write: null, next: { disabledBy: 'windows' } });
    // Enabled again in Task Manager (02 00…): adopted, not disabled again.
    expect(reconcile(windowsState('ours', '02'), optedOut, NORMAL)).toMatchObject({ rule: 'windows-reenabled', write: null, next: { preference: 'enabled', decidedBy: 'windows' } });
    // No StartupApproved value: the record did not land (or the entry was re-added outside): disabled again.
    expect(reconcile(windowsState('ours', 'absent'), optedOut, NORMAL)).toMatchObject({ rule: 'opt-out', write: { openAtLogin: true, enabled: false }, fallback: REMOVE });
    expect(reconcile(windowsState('ours', 'absent'), optedOut, { ...NORMAL, launchedAtLogin: true })).toMatchObject({ rule: 'opt-out-skipped-launched-at-login', write: null });
    expect(describeState(windowsState('ours', '03'), { execPath: EXE, args: ARGS })).toEqual({ readable: true, run: 'ours', approved: 'disabled-by-app' });
  });

  it('an in-app opt-out survives settings that come back without it (v1.0 round trip, reset file): never registered again', () => {
    // v1.0 drops the loginItem section and saves launchAtLogin:false; the migration then reads it as undecided.
    const v1Shaped: LoginItemSettings = { ...base, v1Value: false };
    expect(needsV1Evidence(v1Shaped)).toBe(true);
    for (const li of [v1Shaped, base]) {
      const r = reconcile(windowsState('ours', '03'), li, NORMAL);
      expect(r).toMatchObject({ rule: 'windows-disabled', write: null, next: { preference: 'disabled', disabledBy: 'windows' } });
    }
    // Before the fix the opt-out deleted both values, leaving nothing to find: the boot registered.
    expect(reconcile(windowsState('absent', 'absent'), v1Shaped, NORMAL).rule).toBe('register');
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

  it('enable registers or repairs; disable leaves the entry listed as disabled; both record the user as the decider', () => {
    expect(applyUserChoice(true, windowsState('absent', 'absent'), base, target)).toMatchObject({ outcome: 'registered', write: { openAtLogin: true, enabled: true } });
    expect(applyUserChoice(true, windowsState('stale', '02'), base, target)).toMatchObject({ outcome: 'registered' });
    expect(applyUserChoice(true, windowsState('ours', 'absent'), base, target)).toMatchObject({ outcome: 'unchanged', write: null });
    for (const run of ['ours', 'absent', 'stale'] as const) {
      expect(applyUserChoice(false, windowsState(run, 'absent'), base, target)).toMatchObject({
        outcome: 'opted-out',
        write: { openAtLogin: true, enabled: false },
        fallback: REMOVE,
        next: { preference: 'disabled', decidedBy: 'user', disabledBy: 'user' },
      });
    }
    // Already disabled in Startup apps: Windows' record is kept as it is.
    for (const sa of ['03+FILETIME', '03'] as const) {
      expect(applyUserChoice(false, windowsState('absent', sa), base, target)).toMatchObject({ outcome: 'unchanged', write: null });
      expect(applyUserChoice(false, windowsState('ours', sa), base, target)).toMatchObject({ outcome: 'unchanged', write: null });
    }
  });

  it('enable undoes the app’s own opt-out record, never a disable made in Task Manager', () => {
    const optedOut: LoginItemSettings = { ...base, preference: 'disabled', decidedBy: 'user', disabledBy: 'user', registeredPath: EXE };
    for (const run of ['ours', 'absent'] as const) {
      expect(applyUserChoice(true, windowsState(run, '03'), optedOut, target)).toMatchObject({ outcome: 'registered', write: { openAtLogin: true, enabled: true } });
    }
    expect(applyUserChoice(true, windowsState('ours', '03+FILETIME'), optedOut, target)).toMatchObject({ outcome: 'windows-disabled', write: null });
    // The same bytes standing for a Windows disable (the restored entry) are not the user's to undo here.
    const windowsOff: LoginItemSettings = { ...optedOut, decidedBy: 'windows', disabledBy: 'windows' };
    expect(applyUserChoice(true, windowsState('ours', '03'), windowsOff, target)).toMatchObject({ outcome: 'windows-disabled', write: null });
  });

  it('an on saved without a registration that took effect records no registered path, so the next start registers', () => {
    const previouslyRegistered: LoginItemSettings = { ...base, preference: 'disabled', decidedBy: 'user', disabledBy: 'user', registeredPath: OLD_EXE };
    const unread = interpretSnapshot({ run: { kind: 'error', code: 5 }, approved: { kind: 'error', code: 5 } });
    const saved = [
      applyUserChoice(true, windowsState('absent', 'absent'), previouslyRegistered, { ...target, writable: false }).next,
      applyUserChoice(true, unread, previouslyRegistered, target).next,
      applyUserChoice(true, windowsState('absent', 'absent'), previouslyRegistered, target).nextIfWriteFails,
      applyUserChoice(true, windowsState('absent', '03+FILETIME'), previouslyRegistered, target).nextIfWriteFails,
    ];
    for (const li of saved) {
      expect(li).toMatchObject({ preference: 'enabled', decidedBy: 'user', registeredPath: null });
      // Rule 5 then registers instead of reading the missing entry as removed outside the app.
      expect(reconcile(windowsState('absent', 'absent'), li, NORMAL)).toMatchObject({ rule: 'register', write: { openAtLogin: true, enabled: true } });
    }
    // With the old path kept (the defect) the same boot turned the explicit on into off.
    expect(reconcile(windowsState('absent', 'absent'), { ...saved[0]!, registeredPath: OLD_EXE }, NORMAL).rule).toBe('external-removal');
  });

  it('an on saved over the app’s own opt-out record without taking effect is applied at the next start, not read as a Windows disable', () => {
    const optedOut: LoginItemSettings = { ...base, preference: 'disabled', decidedBy: 'user', disabledBy: 'user', registeredPath: EXE };
    const record = windowsState('ours', '03');
    const unread = interpretSnapshot({ run: { kind: 'error', code: 5 }, approved: { kind: 'error', code: 5 } });
    const saved = [
      applyUserChoice(true, record, optedOut, { ...target, writable: false }).next,
      applyUserChoice(true, unread, optedOut, target).next,
      applyUserChoice(true, record, optedOut, target).nextIfWriteFails,
    ];
    for (const li of saved) {
      expect(li).toMatchObject({ preference: 'enabled', decidedBy: 'user', registeredPath: null });
      expect(reconcile(record, li, NORMAL)).toMatchObject({ rule: 'register', write: { openAtLogin: true, enabled: true }, next: { preference: 'enabled', registeredPath: EXE }, nextIfWriteFails: li });
      expect(reconcile(record, li, { ...NORMAL, launchedAtLogin: true })).toMatchObject({ rule: 'register-skipped-launched-at-login', write: null });
      expect(reconcile(record, li, { ...NORMAL, settingsTrusted: false })).toMatchObject({ rule: 'untrusted-settings', write: null, next: li });
      expect(loginItemStatus(li, record, target)).toMatchObject({ enabled: true, active: false, disabledBy: null, reason: 'GizeCat registers itself the next time it starts.' });
      // Switching on again applies it; switching off keeps the record as the user's off.
      expect(applyUserChoice(true, record, li, target)).toMatchObject({ outcome: 'registered', write: { openAtLogin: true, enabled: true } });
      expect(applyUserChoice(false, record, li, target)).toMatchObject({ outcome: 'unchanged', write: null, next: { preference: 'disabled', disabledBy: 'user' } });
    }
    // A disable made in Task Manager (03 + FILETIME) is never taken for that record.
    expect(reconcile(windowsState('ours', '03+FILETIME'), saved[0]!, NORMAL)).toMatchObject({ rule: 'windows-disabled', write: null });
  });

  it('an on saved while Windows keeps our entry disabled records the entry, so it is never taken for an on still to apply', () => {
    // Settings reset (or downgraded) while the app's own record is in place: Windows' disable from then on.
    const boot = reconcile(windowsState('ours', '03'), base, NORMAL);
    expect(boot).toMatchObject({ rule: 'windows-disabled', write: null, next: { disabledBy: 'windows', registeredPath: EXE } });
    const on = applyUserChoice(true, windowsState('ours', '03'), boot.next, target);
    expect(on).toMatchObject({ outcome: 'windows-disabled', write: null, next: { preference: 'enabled', decidedBy: 'user', registeredPath: EXE } });
    expect(reconcile(windowsState('ours', '03'), on.next, NORMAL)).toMatchObject({ rule: 'windows-disabled', write: null });
    // Also when that boot could not record it.
    expect(applyUserChoice(true, windowsState('ours', '03'), { ...boot.next, registeredPath: null }, target).next.registeredPath).toBe(EXE);
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

  it('names the app GizeCat, and what Windows lists by the installed name Desktop Cat (ADR 0004 §9)', () => {
    // Task Manager › Startup apps and the Start menu shortcut keep "Desktop Cat" until the installer names change.
    const disabled = loginItemStatus(base, windowsState('ours', '03+FILETIME'), target).reason;
    expect(disabled).toBe('Disabled in Windows Startup apps. To turn it back on, open Task Manager › Startup apps and enable the Desktop Cat entry.');
    const stale = loginItemStatus(base, windowsState('stale', 'absent'), target).reason;
    expect(stale).toBe('The Windows startup entry points to another location. GizeCat repairs it the next time you open Desktop Cat from the Start menu or a shortcut, even while it is running.');
    const unreadable = loginItemStatus(base, { ...windowsState('ours', 'absent'), readable: false }, target).reason;
    expect(unreadable).toBe('GizeCat could not read its Windows startup entry.');
  });

  it('follows the registry while the app runs: an off undone outside the app shows as on, matching the next start', () => {
    for (const [disabledBy, sa] of [
      ['windows', '02'],
      ['external', 'absent'],
      ['user', '02'],
    ] as const) {
      const li: LoginItemSettings = { ...base, preference: 'disabled', decidedBy: disabledBy === 'user' ? 'user' : 'windows', disabledBy, registeredPath: EXE };
      const s = loginItemStatus(li, windowsState('ours', sa), target);
      expect(s).toEqual({ enabled: true, preference: 'enabled', disabledBy: null, active: true, writable: true, reason: null, showNotice: false });
      // The next start records exactly that.
      expect(reconcile(windowsState('ours', sa), li, NORMAL).next).toMatchObject({ preference: 'enabled', disabledBy: null });
    }
    // A build that may not write never reconciles, so it shows what is recorded.
    const windowsOff: LoginItemSettings = { ...base, preference: 'disabled', decidedBy: 'windows', disabledBy: 'windows', registeredPath: EXE };
    expect(liveLoginItem(windowsOff, windowsState('ours', '02'), false)).toEqual(windowsOff);
  });

  it('an entry left after an in-app opt-out is explained as turned off at the next start by the user (not as removed)', () => {
    const optedOut: LoginItemSettings = { ...base, preference: 'disabled', decidedBy: 'user', disabledBy: 'user', registeredPath: EXE };
    const s = loginItemStatus(optedOut, windowsState('ours', 'absent'), target);
    // The second instance reconciles, so the user need not quit first (startup#4).
    expect(s).toMatchObject({ enabled: false, disabledBy: 'user', active: true, reason: expect.stringMatching(/next time you open Desktop Cat .*even while it is running/) });
    expect(s.reason).not.toMatch(/removed/);
    // The opt-out record itself is simply off.
    expect(loginItemStatus(optedOut, windowsState('ours', '03'), target)).toMatchObject({ enabled: false, disabledBy: 'user', active: false, reason: null });
  });

  it('a Windows disable whose entry is gone no longer points to Task Manager', () => {
    const windowsOff: LoginItemSettings = { ...base, preference: 'disabled', decidedBy: 'windows', disabledBy: 'windows', registeredPath: EXE };
    expect(loginItemStatus(windowsOff, windowsState('absent', 'absent'), target)).toMatchObject({ enabled: false, disabledBy: 'external', active: false });
    expect(loginItemStatus(windowsOff, windowsState('absent', '03+FILETIME'), target)).toMatchObject({ disabledBy: 'external' });
    expect(loginItemStatus(windowsOff, windowsState('ours', '03+FILETIME'), target)).toMatchObject({ disabledBy: 'windows', reason: null });
  });

  it('says a dev or portable build cannot manage it', () => {
    const s = loginItemStatus(base, windowsState('absent', 'absent'), { ...target, writable: false });
    expect(s).toMatchObject({ writable: false, active: false, showNotice: false, reason: expect.stringMatching(/Not available in this build/) });
    const dev = loginItemStatus(base, windowsState('stale', 'absent'), { ...target, writable: false, blockedBy: ['unpackaged', 'no-uninstaller', 'command-too-long'] });
    expect(dev.reason).toMatch(/development or portable.*another copy/);
  });

  it('an installed copy blocked only by the path length or the environment switch says exactly that', () => {
    const long = loginItemStatus(base, windowsState('absent', 'absent'), { ...target, writable: false, blockedBy: ['command-too-long'] });
    expect(long.reason).toMatch(/path is too long .*260 characters/);
    const off = loginItemStatus(base, windowsState('ours', 'absent'), { ...target, writable: false, blockedBy: ['env-off', 'command-too-long'] });
    expect(off).toMatchObject({ active: true, reason: expect.stringMatching(/DESKTOP_CAT_LOGIN_ITEM=off/) });
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
