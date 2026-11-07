// Launch at login on macOS (1.4.0, decision D6; ADR 0004 §7). Separate from the Windows service
// (loginItem.ts), whose HKCU Run reconcile was verified on hardware and stays untouched.
//
// - Backend: Electron's app.setLoginItemSettings({ openAtLogin }) with its default type
//   'mainAppService', which Electron 44 implements with SMAppService (macOS 13+). The app bundle
//   itself is the login item; nothing is written into the bundle or into launchd folders.
// - OFF by default and opt-in only: 'unset' means off here (the Windows default-on applies to the
//   NSIS installer only, ADR 0004 §7). Nothing is written at startup; the only write is the user's
//   switch (enable/disableLaunchAtLogin actions).
// - Write gate: a packaged build, not under test, DESKTOP_CAT_LOGIN_ITEM not 'off', and the app in
//   an Applications folder (app.isInApplicationsFolder()), so a translocated or quarantined copy in
//   Downloads never registers itself.
// - Live state from getLoginItemSettings().status ('not-registered' | 'enabled' |
//   'requires-approval' | 'not-found'), cached for at most 2 s. wasOpenedAtLogin is not used: it is
//   not reliable with SMAppService (UNVERIFIED either way; no Mac run).
// Electron-free: the app is injected. Never throws. Source reading only: never run on a Mac.
import { BRAND } from '../../shared/brand';
import { IDENTITY } from '../../shared/identity';
import type { ActionResult, LoginItemStatus } from '../../shared/ipc';
import type { Logger } from '../contracts';
import type { SettingsStore } from '../store/settingsStore';

/** Settings and diagnostics re-read the status at most this often (as loginItem.ts). */
const STATUS_MAX_AGE_MS = 2000;

/**
 * System Settings › General › Login Items (macOS 13+). A constant: main opens it, never a URL from
 * a renderer. The pane identifier comes from the 1.4.0 design pass, not from Apple documentation
 * (UNVERIFIED on a Mac); if macOS does not open it, the status line still names the place in words.
 */
export const DARWIN_LOGIN_ITEMS_SETTINGS_URL = 'x-apple.systempreferences:com.apple.LoginItems-Settings.extension';

export type DarwinLoginGateBlock = 'unpackaged' | 'test' | 'env-off' | 'not-in-applications';
export type DarwinLoginState = 'not-registered' | 'enabled' | 'requires-approval' | 'not-found' | 'unknown';

/** The part of Electron's app this service uses (macOS signatures). */
export interface DarwinLoginApp {
  getLoginItemSettings(): { openAtLogin: boolean; status?: string };
  setLoginItemSettings(settings: { openAtLogin: boolean }): void;
  isInApplicationsFolder(): boolean;
}

export interface DarwinLoginItemOptions {
  app: DarwinLoginApp;
  settings: Pick<SettingsStore, 'get' | 'patch'>;
  logger: Logger;
  packaged: boolean;
  test: boolean;
  env: Record<string, string | undefined>;
  clock: () => number;
}

/** What app.ts uses from a login-item backend (the Windows LoginItemService has the same shape). */
export interface LoginItemPort {
  reconcileAtStartup(): unknown;
  reconcileOnUserLaunch(): unknown;
  status(): LoginItemStatus;
  setLaunchAtLogin(on: boolean): ActionResult;
  dismissNotice(): ActionResult;
  debugInfo(): Record<string, unknown>;
}

export interface DarwinLoginItemService extends LoginItemPort {
  readonly gate: { writable: boolean; blockedBy: DarwinLoginGateBlock[] };
}

// What the user reads. The bundle (Login Items list, Dock, Finder) is still named "Desktop Cat"
// (frozen, ADR 0004 §9), so text about what to find in System Settings names that.
const PRODUCT = BRAND.product;
const LISTED = BRAND.installedName;
const PLACE = 'System Settings › General › Login Items';

export const DARWIN_LOGIN_REASONS = Object.freeze({
  unpackaged: 'Not available in this build (development build). The installed app manages Open at login.',
  envOff: 'Turned off on this Mac by the DESKTOP_CAT_LOGIN_ITEM=off environment setting.',
  notInApplications: `Move ${LISTED} to the Applications folder, then open it from there to use Open at login.`,
  requiresApproval: `Waiting for your approval: turn on ${LISTED} in ${PLACE}.`,
  notRegistered: `macOS has no login item for ${PRODUCT} right now. Turn the switch off and on again to register it.`,
  notFound: `macOS could not find the login item for ${PRODUCT}. Make sure ${LISTED} is in the Applications folder, then turn the switch off and on again.`,
  unknown: `${PRODUCT} could not read its login item status from macOS.`,
  onOutside: `On in ${PLACE} (turned on outside ${PRODUCT}).`,
});

const MESSAGES = Object.freeze({
  on: `${PRODUCT} opens when you log in to this Mac.`,
  off: `${PRODUCT} no longer opens when you log in.`,
  approval: `macOS needs your approval: turn on ${LISTED} in ${PLACE}.`,
  notWritable: 'Saved. This build cannot change Open at login (development build, or not in the Applications folder).',
  failed: 'macOS did not accept the change; details are in the log.',
  saveFailed: 'Could not save the setting; details are in the log.',
});

function toState(status: string | undefined): DarwinLoginState {
  return status === 'not-registered' || status === 'enabled' || status === 'requires-approval' || status === 'not-found' ? status : 'unknown';
}

export function evaluateDarwinGate(g: { packaged: boolean; test: boolean; envOff: boolean; inApplications: boolean }): { writable: boolean; blockedBy: DarwinLoginGateBlock[] } {
  const blockedBy: DarwinLoginGateBlock[] = [];
  if (!g.packaged) blockedBy.push('unpackaged');
  if (g.test) blockedBy.push('test');
  if (g.envOff) blockedBy.push('env-off');
  if (!g.inApplications) blockedBy.push('not-in-applications');
  return { writable: blockedBy.length === 0, blockedBy };
}

function gateReason(blockedBy: readonly DarwinLoginGateBlock[]): string {
  if (blockedBy.includes('unpackaged') || blockedBy.includes('test')) return DARWIN_LOGIN_REASONS.unpackaged;
  if (blockedBy.includes('env-off')) return DARWIN_LOGIN_REASONS.envOff;
  return DARWIN_LOGIN_REASONS.notInApplications;
}

/**
 * The status Settings shows. `enabled` is the switch: on when the user turned it on here, or when
 * macOS already opens the app at login (turned on in System Settings), so the switch never shows
 * off while macOS starts the app. Pure.
 */
export function darwinLoginStatus(
  li: { preference: 'unset' | 'enabled' | 'disabled'; disabledBy: 'user' | 'windows' | 'external' | null },
  state: DarwinLoginState,
  gate: { writable: boolean; blockedBy: readonly DarwinLoginGateBlock[] },
): LoginItemStatus {
  const active = state === 'enabled';
  const chosenOn = li.preference === 'enabled';
  const enabled = chosenOn || active;
  let reason: string | null = null;
  if (!gate.writable) reason = gateReason(gate.blockedBy);
  else if (state === 'unknown') reason = DARWIN_LOGIN_REASONS.unknown;
  else if (active && !chosenOn) reason = DARWIN_LOGIN_REASONS.onOutside;
  else if (chosenOn && state === 'requires-approval') reason = DARWIN_LOGIN_REASONS.requiresApproval;
  else if (chosenOn && state === 'not-registered') reason = DARWIN_LOGIN_REASONS.notRegistered;
  else if (chosenOn && state === 'not-found') reason = DARWIN_LOGIN_REASONS.notFound;
  return {
    enabled,
    preference: li.preference,
    disabledBy: enabled ? null : li.preference === 'disabled' ? li.disabledBy : null,
    active,
    writable: gate.writable,
    reason,
    // The one-time "startup was turned on" notice is for the Windows installer default only.
    showNotice: false,
  };
}

export function createDarwinLoginItemService(opts: DarwinLoginItemOptions): DarwinLoginItemService {
  const log = opts.logger;
  const inApplications = (() => {
    try {
      return opts.app.isInApplicationsFolder();
    } catch (err) {
      log.warn('isInApplicationsFolder failed', { error: err });
      return false;
    }
  })();
  const gate = evaluateDarwinGate({
    packaged: opts.packaged,
    test: opts.test,
    envOff: (opts.env[IDENTITY.env.loginItem] ?? '').trim().toLowerCase() === 'off',
    inApplications,
  });

  let cached: { state: DarwinLoginState; at: number } | null = null;
  let lastWriteError: string | null = null;

  function readState(fresh: boolean): DarwinLoginState {
    const now = opts.clock();
    if (!fresh && cached && now - cached.at < STATUS_MAX_AGE_MS) return cached.state;
    let state: DarwinLoginState;
    try {
      state = toState(opts.app.getLoginItemSettings().status);
    } catch (err) {
      log.warn('reading the login item status failed', { error: err });
      state = 'unknown';
    }
    cached = { state, at: now };
    return state;
  }

  /** Read-only: logs what macOS reports. Never writes (no registration at startup). */
  function observe(trigger: 'boot' | 'user-launch'): { state: DarwinLoginState; writable: boolean } {
    const state = readState(true);
    log.info('login item status', { trigger, state, preference: opts.settings.get().loginItem.preference, gate: gate.blockedBy });
    return { state, writable: gate.writable };
  }

  function persist(on: boolean): boolean {
    try {
      const r = opts.settings.patch({ loginItem: { preference: on ? 'enabled' : 'disabled', decidedBy: 'user', disabledBy: on ? null : 'user' } });
      if (!r.ok) log.error('saving the login item state failed', { error: r.error });
      return r.ok;
    } catch (err) {
      log.error('saving the login item state failed', { error: err });
      return false;
    }
  }

  return {
    gate,
    reconcileAtStartup: () => observe('boot'),
    reconcileOnUserLaunch: () => observe('user-launch'),
    status() {
      try {
        return darwinLoginStatus(opts.settings.get().loginItem, readState(false), gate);
      } catch (err) {
        log.error('login item status failed', { error: err });
        return { enabled: false, preference: 'unset', disabledBy: null, active: false, writable: false, reason: DARWIN_LOGIN_REASONS.unknown, showNotice: false };
      }
    },
    setLaunchAtLogin(on) {
      if (!gate.writable) {
        // The choice is kept, so it applies once the app runs from Applications; nothing is registered now.
        log.info('launch at login changed by the user; not writable here', { on, blockedBy: gate.blockedBy });
        return persist(on) ? { ok: true, message: MESSAGES.notWritable } : { ok: false, message: MESSAGES.saveFailed };
      }
      try {
        opts.app.setLoginItemSettings({ openAtLogin: on });
        lastWriteError = null;
      } catch (err) {
        lastWriteError = err instanceof Error ? err.message : String(err);
        log.error('writing the login item failed', { error: err, openAtLogin: on });
        readState(true);
        return { ok: false, message: MESSAGES.failed };
      }
      const state = readState(true);
      if (!persist(on)) return { ok: false, message: MESSAGES.saveFailed };
      log.info('launch at login changed by the user', { on, state });
      if (on && state === 'requires-approval') return { ok: true, message: MESSAGES.approval };
      if (on && state !== 'enabled') {
        lastWriteError = `status ${state} after registering`;
        return { ok: false, message: MESSAGES.failed };
      }
      if (!on && state === 'enabled') {
        lastWriteError = 'still enabled after unregistering';
        return { ok: false, message: MESSAGES.failed };
      }
      return { ok: true, message: on ? MESSAGES.on : MESSAGES.off };
    },
    dismissNotice() {
      // There is no launch notice on macOS (showNotice is always false).
      return { ok: true };
    },
    debugInfo() {
      // Status words and gate codes only: never a path.
      return {
        backend: 'darwin-smappservice',
        writable: gate.writable,
        blockedBy: gate.blockedBy,
        state: readState(false),
        preference: opts.settings.get().loginItem.preference,
        lastWriteError,
      };
    },
  };
}
