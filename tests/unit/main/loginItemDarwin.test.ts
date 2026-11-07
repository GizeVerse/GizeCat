// Open at login on macOS (1.4.0, decision D6): the SMAppService backend behind Electron's
// app.setLoginItemSettings / getLoginItemSettings. MOCKED: FakeMacLogin stands in for Electron's
// darwin implementation (status 'not-registered' | 'enabled' | 'requires-approval' | 'not-found'),
// so nothing here says how macOS really answers; no Mac run exists.
import { describe, expect, it } from 'vitest';
import { createActionRunner, type ActionTargets } from '../../../src/main/ipc/actions';
import type { SettingsStore } from '../../../src/main/store/settingsStore';
import { SETTINGS_ACTIONS, SettingsActionSchema } from '../../../src/shared/ipc';
import {
  createDarwinLoginItemService,
  DARWIN_LOGIN_ITEMS_SETTINGS_URL,
  DARWIN_LOGIN_REASONS,
  darwinLoginStatus,
  evaluateDarwinGate,
  type DarwinLoginApp,
} from '../../../src/main/lifecycle/loginItemDarwin';
import { IDENTITY } from '../../../src/shared/identity';
import { memorySettings } from './loginItemFakes';
import { memoryLogger } from './helpers';

class FakeMacLogin implements DarwinLoginApp {
  status = 'not-registered';
  inApplications = true;
  /** What a register (openAtLogin: true) leaves: 'enabled', or 'requires-approval' when the user must allow it. */
  afterRegister = 'enabled';
  failWrites: 'throw' | 'ignore' | null = null;
  readonly writes: Array<{ openAtLogin: boolean }> = [];
  reads = 0;

  getLoginItemSettings(): { openAtLogin: boolean; status?: string } {
    this.reads++;
    return { openAtLogin: this.status === 'enabled', status: this.status };
  }

  setLoginItemSettings(s: { openAtLogin: boolean }): void {
    this.writes.push(s);
    if (this.failWrites === 'throw') throw new Error('simulated SMAppService failure');
    if (this.failWrites === 'ignore') return;
    this.status = s.openAtLogin ? this.afterRegister : 'not-registered';
  }

  isInApplicationsFolder(): boolean {
    return this.inApplications;
  }
}

function setup(opts: { packaged?: boolean; test?: boolean; env?: Record<string, string | undefined>; mac?: FakeMacLogin } = {}) {
  const mac = opts.mac ?? new FakeMacLogin();
  const settings = memorySettings();
  let now = 0;
  const log = memoryLogger();
  const service = createDarwinLoginItemService({
    app: mac,
    settings,
    logger: log,
    packaged: opts.packaged ?? true,
    test: opts.test ?? false,
    env: opts.env ?? {},
    clock: () => now,
  });
  return {
    mac,
    settings,
    service,
    log,
    advance: (ms: number) => {
      now += ms;
    },
  };
}

describe('macOS login item: the write gate', () => {
  it('opens only for a packaged, non-test build in an Applications folder without DESKTOP_CAT_LOGIN_ITEM=off', () => {
    expect(evaluateDarwinGate({ packaged: true, test: false, envOff: false, inApplications: true })).toEqual({ writable: true, blockedBy: [] });
    expect(evaluateDarwinGate({ packaged: false, test: true, envOff: true, inApplications: false })).toEqual({
      writable: false,
      blockedBy: ['unpackaged', 'test', 'env-off', 'not-in-applications'],
    });
  });

  it('a copy outside /Applications (Downloads, App Translocation) never registers, and says where to move it', () => {
    const mac = new FakeMacLogin();
    mac.inApplications = false;
    const { service, settings } = setup({ mac });
    expect(service.gate.blockedBy).toEqual(['not-in-applications']);
    const r = service.setLaunchAtLogin(true);
    expect(r.ok).toBe(true);
    expect(mac.writes).toEqual([]);
    // The choice is kept for when it runs from Applications.
    expect(settings.get().loginItem.preference).toBe('enabled');
    const s = service.status();
    expect(s.writable).toBe(false);
    expect(s.reason).toBe(DARWIN_LOGIN_REASONS.notInApplications);
    expect(s.reason).toMatch(/Applications/);
  });

  it('the environment switch and development builds block writes with their own reasons', () => {
    const off = setup({ env: { [IDENTITY.env.loginItem]: ' OFF ' } });
    expect(off.service.gate.blockedBy).toEqual(['env-off']);
    expect(off.service.status().reason).toBe(DARWIN_LOGIN_REASONS.envOff);
    off.service.setLaunchAtLogin(true);
    expect(off.mac.writes).toEqual([]);
    const dev = setup({ packaged: false });
    expect(dev.service.status().reason).toBe(DARWIN_LOGIN_REASONS.unpackaged);
  });

  it('a throwing isInApplicationsFolder fails closed', () => {
    const mac = new FakeMacLogin();
    mac.isInApplicationsFolder = () => {
      throw new Error('boom');
    };
    expect(setup({ mac }).service.gate.blockedBy).toEqual(['not-in-applications']);
  });
});

describe('macOS login item: opt-in only, no writes at startup', () => {
  it('a new install is OFF ("unset" means off on macOS) and startup only reads the status', () => {
    const { service, mac, settings } = setup();
    service.reconcileAtStartup();
    service.reconcileOnUserLaunch();
    expect(mac.writes).toEqual([]);
    expect(settings.patches).toEqual([]);
    const s = service.status();
    expect(s).toMatchObject({ enabled: false, preference: 'unset', active: false, writable: true, reason: null, showNotice: false });
  });

  it('turning it on registers through setLoginItemSettings({ openAtLogin: true }) only, and records the user’s choice', () => {
    const { service, mac, settings } = setup();
    const r = service.setLaunchAtLogin(true);
    expect(r.ok).toBe(true);
    // No Windows-only fields (path, args, name, enabled) reach Electron on macOS.
    expect(mac.writes).toEqual([{ openAtLogin: true }]);
    expect(settings.get().loginItem).toMatchObject({ preference: 'enabled', decidedBy: 'user', disabledBy: null });
    expect(service.status()).toMatchObject({ enabled: true, active: true, reason: null });
  });

  it('turning it off unregisters and records an opt-out by the user', () => {
    const { service, mac, settings } = setup();
    service.setLaunchAtLogin(true);
    const r = service.setLaunchAtLogin(false);
    expect(r.ok).toBe(true);
    expect(mac.writes).toEqual([{ openAtLogin: true }, { openAtLogin: false }]);
    expect(settings.get().loginItem).toMatchObject({ preference: 'disabled', decidedBy: 'user', disabledBy: 'user' });
    expect(service.status()).toMatchObject({ enabled: false, active: false });
  });

  it('there is never a launch notice on macOS', () => {
    const { service } = setup();
    service.setLaunchAtLogin(true);
    expect(service.status().showNotice).toBe(false);
    expect(service.dismissNotice()).toEqual({ ok: true });
  });
});

describe('macOS login item: what macOS reports', () => {
  it('requires-approval: saved, and the message and status point to System Settings › General › Login Items', () => {
    const mac = new FakeMacLogin();
    mac.afterRegister = 'requires-approval';
    const { service } = setup({ mac });
    const r = service.setLaunchAtLogin(true);
    expect(r.ok).toBe(true);
    expect(r.message).toMatch(/Login Items/);
    const s = service.status();
    expect(s).toMatchObject({ enabled: true, active: false, reason: DARWIN_LOGIN_REASONS.requiresApproval });
  });

  it('a register that leaves it not-registered or not-found is reported as a failure, with the reason in the status', () => {
    for (const after of ['not-registered', 'not-found'] as const) {
      const mac = new FakeMacLogin();
      mac.afterRegister = after;
      const { service } = setup({ mac });
      expect(service.setLaunchAtLogin(true).ok, after).toBe(false);
      expect(service.status().reason, after).toBe(after === 'not-found' ? DARWIN_LOGIN_REASONS.notFound : DARWIN_LOGIN_REASONS.notRegistered);
    }
  });

  it('a throwing write is reported, never thrown', () => {
    const mac = new FakeMacLogin();
    mac.failWrites = 'throw';
    const { service, settings } = setup({ mac });
    const r = service.setLaunchAtLogin(true);
    expect(r.ok).toBe(false);
    expect(settings.get().loginItem.preference).toBe('unset');
    expect(service.debugInfo().lastWriteError).toMatch(/simulated/);
  });

  it('turned on in System Settings outside the app: the switch shows on, with the reason', () => {
    const mac = new FakeMacLogin();
    mac.status = 'enabled';
    const { service } = setup({ mac });
    expect(service.status()).toMatchObject({ enabled: true, active: true, preference: 'unset', reason: DARWIN_LOGIN_REASONS.onOutside });
  });

  it('an unreadable status is "unknown" with a reason, and status() never throws', () => {
    const mac = new FakeMacLogin();
    mac.getLoginItemSettings = () => {
      throw new Error('no status');
    };
    const { service } = setup({ mac });
    expect(service.status().reason).toBe(DARWIN_LOGIN_REASONS.unknown);
  });

  it('re-reads the status at most every 2 s for Settings, and at once after a write', () => {
    const { service, mac, advance } = setup();
    service.status();
    const reads = mac.reads;
    service.status();
    expect(mac.reads).toBe(reads);
    advance(2001);
    service.status();
    expect(mac.reads).toBe(reads + 1);
    service.setLaunchAtLogin(true);
    expect(service.status().active).toBe(true);
  });

  it('darwinLoginStatus maps every state (pure)', () => {
    const open = { writable: true, blockedBy: [] };
    const on = { preference: 'enabled' as const, disabledBy: null };
    expect(darwinLoginStatus(on, 'enabled', open)).toMatchObject({ enabled: true, active: true, reason: null });
    expect(darwinLoginStatus(on, 'requires-approval', open).reason).toBe(DARWIN_LOGIN_REASONS.requiresApproval);
    expect(darwinLoginStatus(on, 'not-registered', open).reason).toBe(DARWIN_LOGIN_REASONS.notRegistered);
    expect(darwinLoginStatus(on, 'not-found', open).reason).toBe(DARWIN_LOGIN_REASONS.notFound);
    expect(darwinLoginStatus({ preference: 'disabled', disabledBy: 'user' }, 'not-registered', open)).toMatchObject({ enabled: false, disabledBy: 'user', reason: null });
  });
});

describe('macOS login item: diagnostics and the settings link', () => {
  it('debugInfo holds status words and gate codes only, never a path', () => {
    const { service } = setup();
    const info = service.debugInfo();
    expect(info).toMatchObject({ backend: 'darwin-smappservice', writable: true, blockedBy: [], state: 'not-registered', preference: 'unset' });
    expect(JSON.stringify(info)).not.toMatch(/[/\\]Applications|Users/);
  });

  it('the Login Items settings link is a fixed System Settings URL (main never takes one from a renderer)', () => {
    expect(DARWIN_LOGIN_ITEMS_SETTINGS_URL).toBe('x-apple.systempreferences:com.apple.LoginItems-Settings.extension');
  });

  it('openLoginItemsSettings is a validated action that takes no payload; without main’s macOS target it fails', async () => {
    expect(SETTINGS_ACTIONS).toContain('openLoginItemsSettings');
    expect(SettingsActionSchema.safeParse('openLoginItemsSettings').success).toBe(true);
    // A URL can never ride along: the action is a bare enum value.
    expect(SettingsActionSchema.safeParse({ action: 'openLoginItemsSettings', url: 'a renderer-chosen target' }).success).toBe(false);
    const settings = memorySettings() as unknown as SettingsStore;
    let opened = 0;
    const targets = {
      openLoginItemsSettings: () => {
        opened++;
        return Promise.resolve({ ok: true });
      },
    } as unknown as ActionTargets;
    expect(await createActionRunner({ targets, settings, logger: memoryLogger() }).run('openLoginItemsSettings')).toEqual({ ok: true });
    expect(opened).toBe(1);
    const elsewhere = createActionRunner({ targets: {} as ActionTargets, settings, logger: memoryLogger() });
    expect((await elsewhere.run('openLoginItemsSettings')).ok).toBe(false);
  });
});
