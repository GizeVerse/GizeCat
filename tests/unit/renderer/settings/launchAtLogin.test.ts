// "Start with Windows" in the settings UI: the status line under the switch (General page)
// and the one-word state in Diagnostics, for every LoginItemStatus main can report.
import { describe, expect, it } from 'vitest';
import type { LoginItemStatus } from '../../../../src/shared/ipc';
import { loginItemLabel, statusEntries } from '../../../../src/renderer/settings/pages/diagnostics';
import { launchStatusView } from '../../../../src/renderer/settings/pages/general';
import { S } from '../../../../src/renderer/settings/strings';
import { previewView } from './preview/fixture';

const L = S.general.launchStatus;
const D = S.diagnostics;

const status = (over: Partial<LoginItemStatus> = {}): LoginItemStatus => ({
  enabled: true,
  preference: 'unset',
  disabledBy: null,
  active: true,
  writable: true,
  reason: null,
  showNotice: false,
  ...over,
});

describe('General page: Start with Windows status line', () => {
  it('on and registered', () => {
    expect(launchStatusView(status())).toEqual({ text: L.active, tone: 'ok' });
  });

  it('a build that may not write says so, with main’s reason when it has one, whatever the registry shows', () => {
    for (const active of [true, false]) {
      expect(launchStatusView(status({ writable: false, active }))).toEqual({ text: L.notAvailable, tone: 'info' });
      const reason = 'Not available: the install folder path is too long for a Windows startup entry (at most 260 characters).';
      expect(launchStatusView(status({ writable: false, active, reason }))).toEqual({ text: reason, tone: 'info' });
    }
    expect(L.notAvailable).toMatch(/Not available in this build/);
  });

  it('disabled in Windows Startup apps: explains how to re-enable in Task Manager, never offers to override', () => {
    const v = launchStatusView(status({ enabled: false, preference: 'disabled', disabledBy: 'windows', active: false }));
    expect(v).toEqual({ text: L.windowsDisabled, tone: 'warn' });
    expect(v.text).toMatch(/Task Manager › Startup apps/);
    expect(v.text).toMatch(/never overrides/);
  });

  it('switched on in the app while Windows keeps it disabled: main’s explanation is shown', () => {
    const reason = 'Disabled in Windows Startup apps. To turn it back on, open Task Manager › Startup apps and enable Desktop Cat.';
    expect(launchStatusView(status({ preference: 'enabled', active: false, reason }))).toEqual({ text: reason, tone: 'warn' });
  });

  it('off by the user, and off because the entry was removed outside the app', () => {
    expect(launchStatusView(status({ enabled: false, preference: 'disabled', disabledBy: 'user', active: false }))).toEqual({ text: L.off, tone: 'info' });
    expect(launchStatusView(status({ enabled: false, preference: 'disabled', disabledBy: 'external', active: false }))).toEqual({ text: L.removedOutside, tone: 'info' });
  });

  it('on but not yet registered falls back to the pending wording when main gives no reason', () => {
    expect(launchStatusView(status({ active: false }))).toEqual({ text: L.pending, tone: 'warn' });
    expect(launchStatusView(status({ active: false, reason: 'Desktop Cat could not read its Windows startup entry.' })).text).toMatch(/could not read/);
  });
});

describe('Diagnostics page: Start with Windows', () => {
  it('names the state in one phrase', () => {
    expect(loginItemLabel(status())).toBe(D.active);
    expect(loginItemLabel(status({ writable: false, active: false }))).toBe(D.loginNotAvailable);
    expect(loginItemLabel(status({ enabled: false, disabledBy: 'windows', active: false }))).toBe(D.loginWindowsDisabled);
    expect(loginItemLabel(status({ enabled: false, disabledBy: 'user', active: false }))).toBe(D.loginOff);
    expect(loginItemLabel(status({ active: false }))).toBe(D.inactive);
    // Windows starting the app is reported even from a build that cannot change it.
    expect(loginItemLabel(status({ writable: false, active: true }))).toBe(D.active);
  });

  it('is listed in the status entries from AppStatus.loginItem', () => {
    const v = previewView(Date.UTC(2026, 9, 29), { electron: '44.9.3', chrome: '152.0.0.0', node: '24.0.0' });
    v.status.loginItem = status({ enabled: false, preference: 'disabled', disabledBy: 'windows', active: false });
    const entry = statusEntries(v, Date.UTC(2026, 9, 29)).find(([label]) => label === D.launchAtLogin);
    expect(entry?.[1]).toBe(D.loginWindowsDisabled);
  });
});
