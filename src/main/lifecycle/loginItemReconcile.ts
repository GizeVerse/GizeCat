// Pure decisions behind "Start with Windows" (ADR 0002 §1, docs/research/v1.1/startup.md §4):
// how the registry state reads, what the app does at boot (reconcile), what a user's
// switch does (applyUserChoice) and what the settings window shows (loginItemStatus).
// Nothing here touches Electron, the registry or the file system.
import type { LoginItemStatus } from '../../shared/ipc';
import type { Settings } from '../../shared/settings';
import type { LoginRegistrySnapshot, RegistryRead } from '../win32/registry';
import {
  MAX_RUN_COMMAND_CHARS,
  REG_BINARY,
  REG_EXPAND_SZ,
  REG_SZ,
  formatCommandLine,
  isElectronDisabledRecord,
  parseCommandLine,
  samePath,
  startupApprovedEnabled,
  windowsBasename,
} from './loginItemCommandLine';

export type LoginItemSettings = Settings['loginItem'];

export interface RunEntry {
  /** The value as stored. */
  raw: string;
  /** argv[0] (CommandLineToArgvW rules); '' when the value is not a string. */
  program: string;
  args: string[];
}

export type ApprovedState = 'absent' | 'enabled' | 'disabled';

/** Our two registry values, interpreted. */
export interface WindowsLoginState {
  /** false when either value could not be read: nothing may be decided or written from it. */
  readable: boolean;
  run: RunEntry | null;
  approved: ApprovedState;
  /**
   * The StartupApproved value is the record Electron's `enabled: false` writes (03 + zeros): the
   * app's own disable (an in-app opt-out), not one made in Task Manager (03 + the time of the disable).
   */
  disabledByApp: boolean;
  /** Why the state is unreadable (Win32 error code or load failure), for logs. */
  error: string | null;
}

function decodeString(data: Buffer): string {
  let end = data.length - (data.length % 2);
  while (end >= 2 && data[end - 1] === 0 && data[end - 2] === 0) end -= 2;
  return data.toString('utf16le', 0, end);
}

function runEntryOf(read: Extract<RegistryRead, { kind: 'value' }>): RunEntry {
  if (read.type !== REG_SZ && read.type !== REG_EXPAND_SZ) return { raw: '', program: '', args: [] };
  const raw = decodeString(read.data);
  const [program = '', ...args] = parseCommandLine(raw);
  return { raw, program, args };
}

/**
 * StartupApproved bytes are judged with Electron's C-string rule whatever the value type or
 * length (Electron's own getter calls oversized or non-binary values enabled; treating them
 * as disabled is the safe side: a disabled entry is never written over).
 */
export function interpretSnapshot(s: LoginRegistrySnapshot): WindowsLoginState {
  const { run, approved } = s;
  if (run.kind === 'error' || approved.kind === 'error') {
    const codes = [run, approved].flatMap((r) => (r.kind === 'error' ? [String(r.code)] : []));
    return { readable: false, run: null, approved: 'absent', disabledByApp: false, error: codes.join(', ') };
  }
  return {
    readable: true,
    run: run.kind === 'value' ? runEntryOf(run) : null,
    approved: approved.kind === 'absent' ? 'absent' : startupApprovedEnabled(approved.data) ? 'enabled' : 'disabled',
    disabledByApp: approved.kind === 'value' && approved.type === REG_BINARY && isElectronDisabledRecord(approved.data),
    error: null,
  };
}

export interface LoginTarget {
  /** process.execPath of this build. */
  execPath: string;
  /** Arguments the app registers with (['--launched-at-login']). */
  args: readonly string[];
}

/** The entry points at this executable with exactly our arguments. */
export function isOurEntry(run: RunEntry, target: LoginTarget): boolean {
  return samePath(run.program, target.execPath) && run.args.length === target.args.length && run.args.every((a, i) => a === target.args[i]);
}

/** A v1 development run registered electron.exe (plus the repo path) under our value name. */
export function isDevElectronEntry(run: RunEntry): boolean {
  return windowsBasename(run.program) === 'electron.exe';
}

/** 'unset' means the user never chose; the product default (on) applies. */
export function effectiveOn(li: Pick<LoginItemSettings, 'preference'>): boolean {
  return li.preference !== 'disabled';
}

// ---------------------------------------------------------------------------
// Write gate

export interface WriteGateInput {
  packaged: boolean;
  test: boolean;
  /** DESKTOP_CAT_LOGIN_ITEM === 'off' (smoke runs, users who want the app to keep out). */
  envOff: boolean;
  /** The uninstaller next to the exe (uninstallerFileFor): an installed copy, not release/win-unpacked. */
  uninstallerPresent: boolean;
  /** Length of the command line the app would register. */
  commandLineChars: number;
}

export type WriteGateBlock = 'unpackaged' | 'test' | 'env-off' | 'no-uninstaller' | 'command-too-long';

export interface WriteGate {
  writable: boolean;
  blockedBy: WriteGateBlock[];
}

/** Every condition must hold before the app may write its startup entry (ADR 0002 §1). */
export function evaluateWriteGate(g: WriteGateInput): WriteGate {
  const blockedBy: WriteGateBlock[] = [];
  if (!g.packaged) blockedBy.push('unpackaged');
  if (g.test) blockedBy.push('test');
  if (g.envOff) blockedBy.push('env-off');
  if (!g.uninstallerPresent) blockedBy.push('no-uninstaller');
  if (g.commandLineChars > MAX_RUN_COMMAND_CHARS) blockedBy.push('command-too-long');
  return { writable: blockedBy.length === 0, blockedBy };
}

export function commandLineFor(target: LoginTarget): string {
  return formatCommandLine(target.execPath, target.args);
}

// ---------------------------------------------------------------------------
// Boot-time reconcile

export interface ReconcileFlags extends LoginTarget {
  /** Result of the write gate. */
  writable: boolean;
  /** settings.json loaded as ok / missing / recovered-backup (not corrupt or unreadable). */
  settingsTrusted: boolean;
  /** Started from the Run entry: Microsoft says such a program should not write the key. */
  launchedAtLogin: boolean;
  /** The uninstaller removed our entry (reinstall): a missing entry is not an opt-out. */
  uninstallMarker: boolean;
  /** v1 logs record the user switching startup off ('login item updated', openAtLogin:false). */
  v1OptOutLogged: boolean;
}

export type ReconcileRule =
  | 'gate-closed'
  | 'registry-unreadable'
  | 'untrusted-settings'
  | 'windows-disabled'
  | 'orphan-disabled'
  | 'v1-opt-out'
  | 'windows-reenabled'
  | 'external-readded'
  | 'confirmed'
  | 'repair'
  | 'repair-skipped-launched-at-login'
  | 'register'
  | 'register-after-uninstall'
  | 'register-skipped-launched-at-login'
  | 'external-removal'
  | 'opt-out'
  | 'opt-out-skipped-launched-at-login'
  | 'off';

export interface LoginItemWrite {
  openAtLogin: boolean;
  /** Electron's `enabled` (true deletes the StartupApproved value; false writes 03 + zeros). */
  enabled: boolean;
}

export interface ReconcileResult {
  /** loginItem section to persist when the write (if any) took effect. */
  next: LoginItemSettings;
  /** loginItem section to persist when the write did not take effect. */
  nextIfWriteFails: LoginItemSettings;
  write: LoginItemWrite | null;
  /** Written when `write` did not take effect (removing the entry when its disabled record did not land). */
  fallback: LoginItemWrite | null;
  rule: ReconcileRule;
  /** Delete the uninstall marker (it has been taken into account). */
  consumeMarker: boolean;
}

/** True while the v1 → v2 migration of a v1 `false` is still undecided (startup.md §4, option a). */
export function needsV1Evidence(li: LoginItemSettings): boolean {
  return li.preference === 'unset' && li.v1Value === false && li.registeredPath === null;
}

const REGISTER: LoginItemWrite = { openAtLogin: true, enabled: true };
/**
 * Our entry, listed in Task Manager › Startup apps as disabled (Electron writes 03 + zeros). The
 * in-app opt-out writes it, so the opt-out is kept in Windows too, not only in settings.json.
 */
const DISABLED_ENTRY: LoginItemWrite = { openAtLogin: true, enabled: false };
/** Deletes both values: the fallback when a disabled record did not land. */
const REMOVE: LoginItemWrite = { openAtLogin: false, enabled: true };

function result(
  li: LoginItemSettings,
  next: LoginItemSettings,
  rule: ReconcileRule,
  write: LoginItemWrite | null = null,
  consumeMarker = false,
  nextIfWriteFails?: LoginItemSettings,
  fallback: LoginItemWrite | null = null,
): ReconcileResult {
  return { next, nextIfWriteFails: nextIfWriteFails ?? (write ? li : next), write, fallback, rule, consumeMarker };
}

function disabled(li: LoginItemSettings, decidedBy: LoginItemSettings['decidedBy'], disabledBy: NonNullable<LoginItemSettings['disabledBy']>): LoginItemSettings {
  return { ...li, preference: 'disabled', decidedBy, disabledBy };
}

/** The StartupApproved disable is the one the in-app switch wrote for the user's opt-out. */
function ownOptOutRecord(li: LoginItemSettings, state: WindowsLoginState): boolean {
  return li.preference === 'disabled' && li.disabledBy === 'user' && state.approved === 'disabled' && state.disabledByApp;
}

/**
 * Rule 6: after an opt-out the entry is approved again outside the app. A Windows disable undone
 * in Startup apps, an entry removed outside the app and added back, or the in-app opt-out's
 * disabled entry switched on in Startup apps (which writes an explicit "enabled" value).
 */
function reenabledOutside(li: LoginItemSettings, state: WindowsLoginState): 'windows-reenabled' | 'external-readded' | null {
  if (li.preference !== 'disabled' || !state.readable || state.run === null || state.approved === 'disabled') return null;
  if (li.disabledBy === 'external') return 'external-readded';
  if (li.disabledBy === 'windows' || state.approved === 'enabled') return 'windows-reenabled';
  return null;
}

/** The section once the outside change that rule 6 adopts is recorded. */
function adopted(li: LoginItemSettings): LoginItemSettings {
  return { ...li, preference: 'enabled', decidedBy: 'windows', disabledBy: null };
}

/**
 * What the app does at boot. Rules in priority order (startup.md §4):
 * 1. Our entry is disabled in Task Manager → disabled/windows; never written. The disabled
 *    entry the in-app opt-out leaves keeps disabled/user.
 * 2. Only a disabled StartupApproved value is left (orphan) → disabled/external.
 * 3. An undecided v1 `false` with logged evidence of a v1 opt-out → disabled.
 * 4. On (unset or enabled) with an approved entry: confirm it, or repair a stale path or a
 *    v1 dev electron.exe entry.
 * 5. On without an entry: register when the app never registered (new install, migration) or
 *    the uninstaller left its marker; otherwise the entry was removed outside the app →
 *    disabled/external, not re-added. The marker also registers again after an off that came
 *    from the Windows side (disabled/windows or disabled/external): the uninstaller leaves it
 *    only for an entry Windows would have started, so that off had been undone there.
 * 6. Disabled by Windows and the entry is approved again (re-enabled in Task Manager) →
 *    enabled/windows; an entry removed outside the app and added back outside it, and the
 *    in-app opt-out's disabled entry enabled in Startup apps, likewise.
 * 7. Disabled by the user in the app but an approved entry exists (the opt-out did not land,
 *    or the entry was added back outside the app) → disable it again, or remove it when the
 *    disabled record does not land (not when launched at sign-in).
 * A program started from the Run key should not write to it (Microsoft), so a boot with
 * --launched-at-login never writes; the next start by the user catches up, also while the
 * app runs (a second instance).
 * Nothing is written unless the gate allows it and settings.json was trustworthy; with
 * damaged settings the registry's verdict is recorded so the next boot cannot mistake the
 * reset file for a new install.
 */
export function reconcile(state: WindowsLoginState, li: LoginItemSettings, f: ReconcileFlags): ReconcileResult {
  if (!f.writable) return result(li, li, 'gate-closed');
  if (!state.readable) return result(li, li, 'registry-unreadable');

  const run = state.run;
  const approvedEntry = run !== null && state.approved !== 'disabled';

  // 1 and 2: whatever Windows' Startup apps disabled stays disabled and is never written over.
  if (run !== null && state.approved === 'disabled') {
    if (ownOptOutRecord(li, state)) return result(li, li, 'off', null, f.uninstallMarker);
    const next = disabled(li, 'windows', 'windows');
    return result(li, next, 'windows-disabled', null, f.uninstallMarker);
  }
  if (run === null && state.approved === 'disabled') {
    if (li.preference === 'disabled') return result(li, li, 'off', null, f.uninstallMarker);
    const next = disabled(li, needsV1Evidence(li) ? 'migration' : 'windows', 'external');
    return result(li, next, 'orphan-disabled', null, f.uninstallMarker);
  }

  if (!f.settingsTrusted) {
    // Settings were reset from a damaged file: record what the registry says, write nothing.
    if (approvedEntry && isOurEntry(run, f)) return result(li, { ...li, registeredPath: f.execPath }, 'untrusted-settings');
    if (run === null && effectiveOn(li)) return result(li, disabled(li, 'windows', 'external'), 'untrusted-settings');
    return result(li, li, 'untrusted-settings');
  }

  let cur = li;
  // 3. v1 `false` with evidence of a real opt-out.
  if (needsV1Evidence(cur) && f.v1OptOutLogged) cur = disabled(cur, 'migration', 'user');

  // 6. Re-enabled outside the app.
  if (cur.preference === 'disabled' && approvedEntry) {
    const reenabled = reenabledOutside(cur, state);
    if (reenabled) return onWithEntry(li, adopted(cur), run, f, reenabled);
    // 7. Switched off in the app (or by the v1 migration) yet an approved entry exists.
    if (f.launchedAtLogin) return result(li, cur, 'opt-out-skipped-launched-at-login', null, f.uninstallMarker);
    return result(li, cur, 'opt-out', DISABLED_ENTRY, f.uninstallMarker, cur, REMOVE);
  }
  if (cur.preference === 'disabled') {
    // 5 after a reinstall; no entry is left here (rules 1, 2 and 6 cover every other case).
    if (f.uninstallMarker && (cur.disabledBy === 'windows' || cur.disabledBy === 'external')) {
      if (f.launchedAtLogin) return result(li, cur, 'register-skipped-launched-at-login');
      return result(li, { ...adopted(cur), registeredPath: f.execPath }, 'register-after-uninstall', REGISTER, true, cur);
    }
    return result(li, cur, cur === li ? 'off' : 'v1-opt-out', null, f.uninstallMarker);
  }

  // 4. On, with an approved entry.
  if (approvedEntry) return onWithEntry(li, cur, run, f, 'confirmed');

  // 5. On, no entry.
  if (cur.registeredPath === null || f.uninstallMarker) {
    if (f.launchedAtLogin) return result(li, cur, 'register-skipped-launched-at-login');
    const next = { ...cur, registeredPath: f.execPath };
    return result(li, next, f.uninstallMarker && cur.registeredPath !== null ? 'register-after-uninstall' : 'register', REGISTER, f.uninstallMarker, cur);
  }
  return result(li, disabled(cur, 'windows', 'external'), 'external-removal');
}

function onWithEntry(li: LoginItemSettings, cur: LoginItemSettings, run: RunEntry, f: ReconcileFlags, confirmedRule: ReconcileRule): ReconcileResult {
  if (isOurEntry(run, f)) {
    const next = cur.registeredPath === f.execPath ? cur : { ...cur, registeredPath: f.execPath };
    return result(li, next, confirmedRule, null, f.uninstallMarker);
  }
  // Stale: a moved install, other arguments, or a v1 dev electron.exe entry.
  if (f.launchedAtLogin) return result(li, cur, 'repair-skipped-launched-at-login', null, f.uninstallMarker);
  return result(li, { ...cur, registeredPath: f.execPath }, 'repair', REGISTER, f.uninstallMarker, cur);
}

// ---------------------------------------------------------------------------
// The user's switch (enableLaunchAtLogin / disableLaunchAtLogin)

export type UserChoiceOutcome =
  /** Registry already as asked (or already disabled in Startup apps). */
  | 'unchanged'
  | 'registered'
  /** Our entry left listed in Startup apps as disabled (removed when that record did not land). */
  | 'opted-out'
  /** Saved; this build never writes the registry (dev, test, portable, env off). */
  | 'not-writable'
  /** Saved; the registry could not be read, so nothing was written. */
  | 'registry-unreadable'
  /** Saved; Task Manager keeps our entry disabled (not overridden). */
  | 'windows-disabled'
  /** Saved; only a disabled StartupApproved value was left, so the entry was added back still disabled, for Task Manager to show. */
  | 'windows-disabled-restored';

export interface UserChoiceResult {
  next: LoginItemSettings;
  nextIfWriteFails: LoginItemSettings;
  write: LoginItemWrite | null;
  /** Written when `write` did not take effect. */
  fallback: LoginItemWrite | null;
  outcome: UserChoiceOutcome;
}

function choice(next: LoginItemSettings, outcome: UserChoiceOutcome, write: LoginItemWrite | null = null, nextIfWriteFails = next, fallback: LoginItemWrite | null = null): UserChoiceResult {
  return { next, nextIfWriteFails, write, fallback, outcome };
}

export function applyUserChoice(on: boolean, state: WindowsLoginState, li: LoginItemSettings, f: LoginTarget & { writable: boolean }): UserChoiceResult {
  if (!on) {
    const next: LoginItemSettings = { ...li, preference: 'disabled', decidedBy: 'user', disabledBy: 'user' };
    if (!f.writable) return choice(next, 'not-writable');
    // Already disabled in Startup apps (Task Manager, an earlier opt-out, an orphaned value):
    // nothing launches, and a disable Windows recorded is never written over.
    if (state.readable && state.approved === 'disabled') return choice(next, 'unchanged');
    // The entry stays listed in Task Manager › Startup apps as disabled: a record of the opt-out
    // outside settings.json, so a reset or downgraded settings file cannot turn startup back on
    // (the uninstaller still deletes both values, and writes no reinstall marker for it).
    // Electron writes the Run value before the StartupApproved one, so a record that does not
    // land in full is removed instead. Both are safe even unread: neither launches anything.
    return choice(next, 'opted-out', DISABLED_ENTRY, next, REMOVE);
  }
  const next: LoginItemSettings = { ...li, preference: 'enabled', decidedBy: 'user', disabledBy: null };
  const registered: LoginItemSettings = { ...next, registeredPath: f.execPath };
  // Saved without a registration that took effect: no registered path, so the next writable
  // start registers (rule 5) instead of reading the missing entry as removed outside the app.
  const unregistered: LoginItemSettings = { ...next, registeredPath: null };
  if (!f.writable) return choice(unregistered, 'not-writable');
  if (!state.readable) return choice(unregistered, 'registry-unreadable');
  if (state.approved === 'disabled') {
    // The disabled entry the in-app opt-out left: switching on undoes it (enabled:true deletes the value).
    if (ownOptOutRecord(li, state)) return choice(registered, 'registered', REGISTER, unregistered);
    if (state.run !== null) return choice(next, 'windows-disabled');
    // Task Manager lists only entries that have a Run value; without one this disable could
    // never be undone there. Add the entry back still disabled (03 + zeros): Windows keeps it off.
    return choice(registered, 'windows-disabled-restored', DISABLED_ENTRY, unregistered);
  }
  if (state.run !== null && isOurEntry(state.run, f)) return choice(registered, 'unchanged');
  return choice(registered, 'registered', REGISTER, unregistered);
}

/** Whether the registry now shows what `write` intended (read back after writing). */
export function writeTookEffect(write: LoginItemWrite, state: WindowsLoginState, target: LoginTarget): boolean {
  if (!state.readable) return false;
  if (!write.openAtLogin) return state.run === null;
  if (state.run === null || !isOurEntry(state.run, target)) return false;
  return write.enabled ? state.approved !== 'disabled' : state.approved === 'disabled';
}

// ---------------------------------------------------------------------------
// Status shown in Settings and diagnostics

/** Why this build may not write its entry, for the status line (null: a dev, test or portable build). */
function gateReason(blockedBy: readonly WriteGateBlock[]): string | null {
  // Only an installed copy (packaged, uninstaller present, not under test) gets a specific reason.
  if (blockedBy.some((b) => b === 'unpackaged' || b === 'test' || b === 'no-uninstaller')) return null;
  if (blockedBy.includes('env-off')) return 'Turned off on this computer by the DESKTOP_CAT_LOGIN_ITEM=off environment setting.';
  if (blockedBy.includes('command-too-long')) return `Not available: the install folder path is too long for a Windows startup entry (at most ${MAX_RUN_COMMAND_CHARS} characters). Reinstall Desktop Cat in a shorter folder.`;
  return null;
}

/**
 * An off section as the status shows it: what the registry says now, not only what the last
 * reconcile recorded (the registry is re-read while the app runs; the section changes only at
 * a start). An entry approved again outside the app is on and a disable made in Startup apps
 * is Windows' (the next start records both, rules 6 and 1). A Windows disable whose entry is
 * gone reads as an entry removed outside the app: Task Manager no longer lists it, so only the
 * in-app switch can turn startup on again.
 */
export function liveLoginItem(li: LoginItemSettings, state: WindowsLoginState, writable: boolean): LoginItemSettings {
  // A build that may not write never reconciles, so nothing would be recorded either.
  if (!writable || !state.readable || li.preference !== 'disabled') return li;
  if (reenabledOutside(li, state)) return adopted(li);
  if (state.run === null) return li.disabledBy === 'windows' ? { ...li, disabledBy: 'external' } : li;
  if (state.approved === 'disabled' && !ownOptOutRecord(li, state)) return disabled(li, 'windows', 'windows');
  return li;
}

export function loginItemStatus(stored: LoginItemSettings, state: WindowsLoginState, f: LoginTarget & { writable: boolean; blockedBy?: readonly WriteGateBlock[] }): LoginItemStatus {
  const li = liveLoginItem(stored, state, f.writable);
  const enabled = effectiveOn(li);
  const run = state.run;
  const ours = state.readable && run !== null && isOurEntry(run, f);
  const active = ours && state.approved !== 'disabled';
  let reason: string | null = null;
  if (!f.writable) {
    reason =
      gateReason(f.blockedBy ?? []) ??
      (state.readable && run !== null && !ours
        ? 'Not available in this build (development or portable). Windows starts another copy of Desktop Cat (the installed app) at sign-in.'
        : 'Not available in this build (development or portable). The installed app manages Start with Windows.');
  } else if (!state.readable) reason = 'Desktop Cat could not read its Windows startup entry.';
  else if (enabled && run !== null && state.approved === 'disabled') reason = 'Disabled in Windows Startup apps. To turn it back on, open Task Manager › Startup apps and enable Desktop Cat.';
  else if (enabled && !active && run !== null) reason = 'The Windows startup entry points to another location. Desktop Cat repairs it the next time you start it yourself.';
  else if (enabled && !active) reason = li.disabledBy === null && li.registeredPath === null ? 'Desktop Cat registers itself the next time it starts.' : 'Windows has no startup entry for Desktop Cat.';
  else if (!enabled && run !== null && state.approved !== 'disabled') reason = 'Windows still starts Desktop Cat when you sign in. Desktop Cat turns that off the next time you open it yourself.';
  return {
    enabled,
    preference: li.preference,
    disabledBy: li.disabledBy,
    active,
    writable: f.writable,
    reason,
    showNotice: !li.noticeShown && li.preference === 'unset' && li.decidedBy === 'default' && active,
  };
}

/** Short reason codes for logs and diagnostics (no paths). */
export function describeState(state: WindowsLoginState, target: LoginTarget): Record<string, unknown> {
  if (!state.readable) return { readable: false, error: state.error };
  const run = state.run;
  return {
    readable: true,
    run: run === null ? 'absent' : isOurEntry(run, target) ? 'ours' : isDevElectronEntry(run) ? 'dev-electron' : 'stale',
    approved: state.approved === 'disabled' && state.disabledByApp ? 'disabled-by-app' : state.approved,
  };
}
