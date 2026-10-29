// Launch at Windows sign-in (ADR 0002 §1). The app owns one HKCU Run value, written only
// through Electron's setLoginItemSettings and only when the boot-time reconcile or the
// user's switch asks for it: writing at every start would erase a "Disabled" choice made
// in Task Manager (enabled:true deletes the StartupApproved value). State is read with
// koffi (win32/registry.ts), never with getLoginItemSettings, whose answer is wrong for
// paths with spaces. Electron-free: the writer, registry and file system are injected.
import nodeFs from 'node:fs';
import path from 'node:path';
import type { ActionResult, LoginItemStatus } from '../../shared/ipc';
import type { Logger } from '../contracts';
import type { JsonReadStatus } from '../store/jsonStore';
import type { SettingsStore } from '../store/settingsStore';
import type { LoginItemRegistry } from '../win32/registry';
import { LAUNCHED_AT_LOGIN_FLAG } from './launchArgs';
import { samePath } from './loginItemCommandLine';
import { findV1OptOutInLogs, type EvidenceFs } from './loginItemEvidence';
import {
  applyUserChoice,
  commandLineFor,
  describeState,
  evaluateWriteGate,
  interpretSnapshot,
  loginItemStatus,
  needsV1Evidence,
  reconcile,
  writeTookEffect,
  type LoginItemSettings,
  type LoginItemWrite,
  type LoginTarget,
  type ReconcileRule,
  type UserChoiceOutcome,
  type WindowsLoginState,
  type WriteGate,
} from './loginItemReconcile';

/** Registry value name under HKCU\...\Run. Fixed so the uninstaller (build/installer.nsh) can remove it. */
export const LOGIN_ITEM_NAME = 'io.github.enesiltas.desktopcat';
export const LOGIN_ITEM_ARGS: readonly string[] = [LAUNCHED_AT_LOGIN_FLAG];
/** DESKTOP_CAT_LOGIN_ITEM=off keeps any build from writing the entry (smoke runs). */
export const LOGIN_ITEM_ENV = 'DESKTOP_CAT_LOGIN_ITEM';
/**
 * The uninstaller electron-builder writes next to the exe of an installed copy (never into
 * release/win-unpacked): `Uninstall ${productFilename}.exe`, where productFilename is
 * `win.executableName` when set and the exe is `${productFilename}.exe`, so the name follows the
 * exe's own base name in every configuration (VERIFIED on a real install: `Uninstall DesktopCat.exe`).
 */
export function uninstallerFileFor(execPath: string): string {
  return `Uninstall ${path.win32.parse(execPath).name}.exe`;
}
/** This build's uninstaller (electron-builder.yml: executableName DesktopCat). */
export const UNINSTALLER_FILE = uninstallerFileFor('DesktopCat.exe');
/** Left in userData by a real uninstall (installer.nsh): a missing entry then means "reinstalled", not "opted out". */
export const UNINSTALL_MARKER_FILE = 'login-item-removed-by-uninstall';
/** Settings and diagnostics re-read the registry at most this often. */
const STATUS_MAX_AGE_MS = 2000;

/** Electron's app.setLoginItemSettings (the only writer). */
export interface LoginItemWriter {
  setLoginItemSettings(settings: { openAtLogin: boolean; path: string; args: string[]; name: string; enabled: boolean }): void;
}

export interface LoginItemFs extends EvidenceFs {
  existsSync(p: string): boolean;
  rmSync(p: string, opts: { force: boolean }): void;
}

export interface LoginItemServiceOptions {
  writer: LoginItemWriter;
  registry: LoginItemRegistry;
  settings: Pick<SettingsStore, 'get' | 'patch'>;
  logger: Logger;
  execPath: string;
  userData: string;
  logDir: string | null;
  packaged: boolean;
  test: boolean;
  launchedAtLogin: boolean;
  env: Record<string, string | undefined>;
  settingsLoadStatus: JsonReadStatus;
  clock: () => number;
  fs?: LoginItemFs;
}

export interface ReconcileReport {
  rule: ReconcileRule;
  write: LoginItemWrite | null;
  /** The write, or its fallback, took effect (true when there was none). */
  ok: boolean;
  markerConsumed: boolean;
  durationMs: number;
}

export interface LoginItemService {
  readonly gate: WriteGate;
  /** Boot-time reconcile (once, before the cat host starts). Never throws. */
  reconcileAtStartup(): ReconcileReport;
  /**
   * The user started Desktop Cat again while it runs (second instance): reconciled as a start
   * by the user, so work a sign-in boot had to skip (repair, register, disable a leftover
   * entry) is done now instead of waiting for a cold start that may never come. Never throws.
   */
  reconcileOnUserLaunch(): ReconcileReport;
  status(): LoginItemStatus;
  /** The enable/disableLaunchAtLogin actions: the only way the preference changes. */
  setLaunchAtLogin(on: boolean): ActionResult;
  dismissNotice(): ActionResult;
  debugInfo(): Record<string, unknown>;
}

const MESSAGES: Record<UserChoiceOutcome, (on: boolean) => string> = {
  unchanged: (on) => (on ? 'Desktop Cat starts when you sign in to Windows.' : 'Desktop Cat no longer starts when you sign in.'),
  registered: () => 'Desktop Cat starts when you sign in to Windows.',
  'opted-out': () => 'Desktop Cat no longer starts when you sign in.',
  'not-writable': () => 'Saved. This build cannot change Windows startup (development or portable build); the installed app does.',
  'registry-unreadable': () => 'Saved, but the Windows startup entry could not be read, so it was left as it is. It is checked again the next time Desktop Cat starts.',
  'windows-disabled': () =>
    'Saved. Windows Startup apps keeps Desktop Cat disabled, and Desktop Cat does not override that. To turn it on, open Task Manager › Startup apps and enable Desktop Cat.',
  'windows-disabled-restored': () =>
    'Saved. Windows Startup apps has Desktop Cat disabled, and Desktop Cat does not override that. Its entry is listed in Task Manager › Startup apps again: enable it there to start Desktop Cat when you sign in.',
};
const WRITE_FAILED = 'Windows did not accept the startup change; details are in the log.';

const TRUSTED_LOADS: ReadonlySet<JsonReadStatus> = new Set(['ok', 'missing', 'recovered-backup']);

export function createLoginItemService(opts: LoginItemServiceOptions): LoginItemService {
  const log = opts.logger;
  const fsApi: LoginItemFs = opts.fs ?? nodeFs;
  const target: LoginTarget = { execPath: opts.execPath, args: LOGIN_ITEM_ARGS };
  const markerPath = path.join(opts.userData, UNINSTALL_MARKER_FILE);

  const exists = (p: string): boolean => {
    try {
      return fsApi.existsSync(p);
    } catch {
      return false;
    }
  };

  const gate = evaluateWriteGate({
    packaged: opts.packaged,
    test: opts.test,
    envOff: (opts.env[LOGIN_ITEM_ENV] ?? '').trim().toLowerCase() === 'off',
    uninstallerPresent: exists(path.join(path.dirname(opts.execPath), uninstallerFileFor(opts.execPath))),
    commandLineChars: commandLineFor(target).length,
  });
  const writeTarget = { ...target, writable: gate.writable, blockedBy: gate.blockedBy };

  let cached: { state: WindowsLoginState; at: number } | null = null;
  let lastReport: ReconcileReport | null = null;
  let lastWriteError: string | null = null;

  function readState(fresh: boolean): WindowsLoginState {
    const now = opts.clock();
    if (!fresh && cached && now - cached.at < STATUS_MAX_AGE_MS) return cached.state;
    let state: WindowsLoginState;
    try {
      state = interpretSnapshot(opts.registry.read());
    } catch (err) {
      state = { readable: false, run: null, approved: 'absent', disabledByApp: false, error: err instanceof Error ? err.message : String(err) };
    }
    cached = { state, at: now };
    return state;
  }

  /** Writes through Electron, then reads back: a write that did not land is reported, never assumed. */
  function performWrite(write: LoginItemWrite): boolean {
    if (!gate.writable) {
      log.error('login item write refused by the write gate', { blockedBy: gate.blockedBy });
      return false;
    }
    try {
      opts.writer.setLoginItemSettings({ openAtLogin: write.openAtLogin, path: opts.execPath, args: [...LOGIN_ITEM_ARGS], name: LOGIN_ITEM_NAME, enabled: write.enabled });
    } catch (err) {
      lastWriteError = err instanceof Error ? err.message : String(err);
      log.error('writing the login item failed', { error: err, openAtLogin: write.openAtLogin });
      readState(true);
      return false;
    }
    const after = readState(true);
    const ok = writeTookEffect(write, after, target);
    if (ok) {
      lastWriteError = null;
      log.info('login item written', { openAtLogin: write.openAtLogin, enabled: write.enabled });
    } else {
      lastWriteError = 'the registry does not show the change';
      log.error('login item write did not take effect', { openAtLogin: write.openAtLogin, enabled: write.enabled, state: describeState(after, target) });
    }
    return ok;
  }

  /** The planned write, then its fallback when the write did not take effect. True when one of them did (or there was none). */
  function performPlanned(write: LoginItemWrite | null, fallback: LoginItemWrite | null): boolean {
    if (!write) return true;
    if (performWrite(write)) return true;
    if (!fallback) return false;
    log.warn('falling back after a login item write that did not take effect', { openAtLogin: fallback.openAtLogin, enabled: fallback.enabled });
    return performWrite(fallback);
  }

  function persist(next: LoginItemSettings): boolean {
    const r = opts.settings.patch({ loginItem: next });
    if (!r.ok) log.error('saving the login item state failed', { error: r.error });
    return r.ok;
  }

  function consumeMarker(): boolean {
    try {
      fsApi.rmSync(markerPath, { force: true });
      return true;
    } catch (err) {
      log.warn('could not remove the uninstall marker', { error: err });
      return false;
    }
  }

  /**
   * One reconcile. `launchedAtLogin` is this start's: the boot of a process Windows started from
   * the Run entry, or false for a start by the user (a cold start, or a second instance).
   */
  function reconcileNow(trigger: 'boot' | 'user-launch', launchedAtLogin: boolean): ReconcileReport {
    const t0 = opts.clock();
    try {
      const li = opts.settings.get().loginItem;
      const state = readState(true);
      const settingsTrusted = TRUSTED_LOADS.has(opts.settingsLoadStatus);
      const marker = exists(markerPath);
      const v1OptOutLogged = gate.writable && state.readable && settingsTrusted && needsV1Evidence(li) ? findV1OptOutInLogs(opts.logDir, fsApi) : false;
      const r = reconcile(state, li, { ...target, writable: gate.writable, settingsTrusted, launchedAtLogin, uninstallMarker: marker, v1OptOutLogged });
      const ok = performPlanned(r.write, r.fallback);
      const next = ok ? r.next : r.nextIfWriteFails;
      if (JSON.stringify(next) !== JSON.stringify(li)) persist(next);
      // A marker is only spent once its reinstall registration actually landed.
      const markerConsumed = r.consumeMarker && marker && ok ? consumeMarker() : false;
      lastReport = { rule: r.rule, write: r.write, ok, markerConsumed, durationMs: opts.clock() - t0 };
      log.info('login item reconciled', {
        trigger,
        rule: r.rule,
        write: r.write,
        ok,
        state: describeState(state, target),
        gate: gate.blockedBy,
        launchedAtLogin,
        settings: opts.settingsLoadStatus,
        marker,
        v1Evidence: v1OptOutLogged,
        ms: lastReport.durationMs,
      });
      return lastReport;
    } catch (err) {
      log.error('login item reconcile failed', { error: err, trigger });
      lastReport = { rule: 'registry-unreadable', write: null, ok: false, markerConsumed: false, durationMs: opts.clock() - t0 };
      return lastReport;
    }
  }

  return {
    gate,
    reconcileAtStartup: () => reconcileNow('boot', opts.launchedAtLogin),
    // Written as at a cold start by the user. A process Windows started from the Run entry is
    // past the point where Explorer read that entry, so the write no longer races sign-in.
    reconcileOnUserLaunch: () => reconcileNow('user-launch', false),
    status() {
      return loginItemStatus(opts.settings.get().loginItem, readState(false), writeTarget);
    },
    setLaunchAtLogin(on) {
      const li = opts.settings.get().loginItem;
      const state = readState(true);
      const r = applyUserChoice(on, state, li, writeTarget);
      const ok = performPlanned(r.write, r.fallback);
      if (!persist(ok ? r.next : r.nextIfWriteFails)) return { ok: false, message: 'Could not save the setting; details are in the log.' };
      // An explicit choice supersedes a pending reinstall marker: a later missing entry is the user's or another tool's doing.
      if (gate.writable && exists(markerPath)) consumeMarker();
      log.info('launch at sign-in changed by the user', { on, outcome: r.outcome, write: r.write, ok });
      return ok ? { ok: true, message: MESSAGES[r.outcome](on) } : { ok: false, message: WRITE_FAILED };
    },
    dismissNotice() {
      const li = opts.settings.get().loginItem;
      if (li.noticeShown) return { ok: true };
      return persist({ ...li, noticeShown: true }) ? { ok: true } : { ok: false, message: 'Could not save the setting; details are in the log.' };
    },
    debugInfo() {
      const registered = opts.settings.get().loginItem.registeredPath;
      return {
        registryAvailable: opts.registry.available,
        // Never the path itself: it contains the Windows account name.
        registeredPath: registered === null ? 'none' : samePath(registered, opts.execPath) ? 'this-exe' : 'other',
        writable: gate.writable,
        blockedBy: gate.blockedBy,
        launchedAtLogin: opts.launchedAtLogin,
        state: describeState(readState(false), target),
        lastReconcile: lastReport,
        lastWriteError,
      };
    },
  };
}
