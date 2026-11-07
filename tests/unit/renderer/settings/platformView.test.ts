// GizeVerse in the settings window (ADR 0004 §2.2, §7), DOM-free: the launch-at-sign-in row off
// Windows and the Diagnostics page's Platform section, from the PlatformReport main sends.
// SIMULATED platform reports (built from the declared table), no real macOS or Linux run.
import { describe, expect, it } from 'vitest';
import type { AppStatus } from '../../../../src/shared/ipc';
import { CAPABILITY_IDS, CAPABILITY_LABELS, CAPABILITY_MATRIX, declaredRuntime, PLATFORM_LABELS, type PlatformId, type PlatformReport, type RuntimeCapability } from '../../../../src/shared/platform';
import { platformView } from '../../../../src/renderer/settings/pages/diagnostics';
import { dockRowVisible, launchRowView, launchStatusViewMac } from '../../../../src/renderer/settings/pages/general';
import { S } from '../../../../src/renderer/settings/strings';

const G = S.general;
const PV = S.diagnostics.platform;

function report(id: PlatformId, over: Partial<Record<(typeof CAPABILITY_IDS)[number], RuntimeCapability>> = {}): PlatformReport {
  return { id, label: PLATFORM_LABELS[id], capabilities: { ...declaredRuntime(id), ...over } };
}

const status = (platform: PlatformReport | undefined): Pick<AppStatus, 'platform'> => ({ platform });
const DEV_BUILD = { available: false, reason: 'Not available in this build (development or portable). The installed app manages Start with Windows.' };

describe('General page: the launch-at-sign-in row', () => {
  it('on Windows keeps the switch, also in a development build whose login item is unavailable', () => {
    expect(launchRowView(status(report('win32')))).toEqual({ showSwitch: true });
    expect(launchRowView(status(report('win32', { loginItem: DEV_BUILD })))).toEqual({ showSwitch: true });
  });

  it('without a platform report (an older main) keeps the switch', () => {
    expect(launchRowView(status(undefined))).toEqual({ showSwitch: true });
  });

  it('off Windows, when main reports it unavailable, hides the switch and shows main’s reason', () => {
    for (const id of ['linux-x11', 'linux-xwayland', 'linux-wayland'] as const) {
      const r = report(id);
      expect(r.capabilities.loginItem.available).toBe(false);
      expect(launchRowView(status(r))).toEqual({ showSwitch: false, title: G.launchTitleElsewhere, reason: CAPABILITY_MATRIX[id].loginItem.note });
    }
    // The row no longer says "Windows" there.
    expect(G.launchTitleElsewhere).not.toMatch(/Windows/);
  });

  it('macOS (1.4.0): "Open at login"; unavailable (e.g. not in Applications) hides the switch with main’s reason', () => {
    const reason = 'Move Desktop Cat to the Applications folder, then open it from there to use Open at login.';
    expect(launchRowView(status(report('darwin', { loginItem: { available: false, reason } })))).toEqual({ showSwitch: false, title: G.launchTitleMac, reason });
    expect(launchRowView(status(report('darwin', { loginItem: { available: true, reason: null } })))).toEqual({ showSwitch: true, title: G.launchTitleMac });
    expect(G.launchTitleMac).not.toMatch(/Windows/);
  });

  it('off Windows without a reason falls back to a plain sentence', () => {
    expect(launchRowView(status(report('linux-x11', { loginItem: { available: false, reason: null } })))).toEqual({
      showSwitch: false,
      title: G.launchTitleElsewhere,
      reason: G.launchStatus.unsupported,
    });
  });

  it('off Windows with the capability available (a later implementation) keeps the switch', () => {
    expect(launchRowView(status(report('linux-x11', { loginItem: { available: true, reason: null } })))).toEqual({ showSwitch: true });
  });
});

describe('General page, macOS (1.4.0): the Open at login status line and the Dock row', () => {
  const base = { enabled: false, preference: 'unset' as const, disabledBy: null, active: false, writable: true, reason: null, showNotice: false };
  const M = G.launchStatusMac;

  it('on and active, off, and not writable read in macOS terms', () => {
    expect(launchStatusViewMac({ ...base, enabled: true, preference: 'enabled', active: true })).toEqual({ text: M.active, tone: 'ok', openSettings: false });
    expect(launchStatusViewMac(base)).toEqual({ text: M.off, tone: 'info', openSettings: false });
    expect(launchStatusViewMac({ ...base, writable: false, reason: 'Not available in this build (development build).' })).toEqual({
      text: 'Not available in this build (development build).',
      tone: 'info',
      openSettings: false,
    });
    expect(M.active).toMatch(/macOS/);
    expect(M.active).not.toMatch(/Windows/);
  });

  it('wanted on but not opened by macOS (approval, not registered): main’s reason, a warning and the Login Items button', () => {
    const v = launchStatusViewMac({ ...base, enabled: true, preference: 'enabled', active: false, reason: 'Waiting for your approval: turn on Desktop Cat in System Settings › General › Login Items.' });
    expect(v).toEqual({ text: 'Waiting for your approval: turn on Desktop Cat in System Settings › General › Login Items.', tone: 'warn', openSettings: true });
  });

  it('the Dock row exists on macOS only', () => {
    expect(dockRowVisible(status(report('darwin')))).toBe(true);
    for (const id of ['win32', 'linux-x11', 'web'] as const) expect(dockRowVisible(status(report(id))), id).toBe(false);
    expect(dockRowVisible(status(undefined))).toBe(false);
    expect(G.dockTitle).toMatch(/Dock/);
  });
});

describe('Diagnostics page: Platform section', () => {
  it('says so when main sent no platform report', () => {
    expect(platformView(undefined)).toEqual({ label: null, unavailable: [] });
  });

  it('names this platform and lists every unavailable capability with main’s reason, in table order', () => {
    const r = report('linux-x11', { tray: { available: false, reason: 'The tray icon could not be created.' } });
    const v = platformView(r);
    expect(v.label).toBe('Linux (X11 session)');
    const expected = CAPABILITY_IDS.filter((id) => !r.capabilities[id].available).map((id) => [CAPABILITY_LABELS[id], r.capabilities[id].reason]);
    expect(v.unavailable).toEqual(expected);
    expect(v.unavailable).toContainEqual([CAPABILITY_LABELS.tray, 'The tray icon could not be created.']);
    expect(v.unavailable).toContainEqual([CAPABILITY_LABELS.loginItem, CAPABILITY_MATRIX['linux-x11'].loginItem.note]);
    // Available capabilities are not listed.
    expect(v.unavailable.map(([label]) => label)).not.toContain(CAPABILITY_LABELS.characterView);
  });

  it('lists nothing when everything is available, and a missing reason reads as such', () => {
    const all = Object.fromEntries(CAPABILITY_IDS.map((id) => [id, { available: true, reason: null }]));
    expect(platformView({ id: 'win32', label: PLATFORM_LABELS.win32, capabilities: all as PlatformReport['capabilities'] }).unavailable).toEqual([]);
    const v = platformView(report('win32', { loginItem: { available: false, reason: null } }));
    expect(v.unavailable).toContainEqual([CAPABILITY_LABELS.loginItem, PV.noReason]);
  });

  it('skips capabilities an older main did not report', () => {
    const caps: Partial<Record<(typeof CAPABILITY_IDS)[number], RuntimeCapability>> = { ...declaredRuntime('linux-wayland') };
    delete caps.overlay;
    const v = platformView({ id: 'linux-wayland', label: PLATFORM_LABELS['linux-wayland'], capabilities: caps as PlatformReport['capabilities'] });
    expect(v.unavailable.map(([label]) => label)).not.toContain(CAPABILITY_LABELS.overlay);
    expect(v.unavailable.length).toBeGreaterThan(0);
  });

  it('points to the generated capability matrix without a link', () => {
    expect(PV.docNote).toContain('docs/gizeverse/capability-matrix.md');
    expect(PV.docNote).not.toMatch(/https?:|www\./);
    expect(PV.capabilities).toBe(CAPABILITY_LABELS);
  });
});
