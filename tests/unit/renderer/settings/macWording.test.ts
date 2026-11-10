// 1.4.0: what a macOS (and any non-Windows) user reads in Settings, while Windows keeps its text.
// DOM-free, SIMULATED platform reports built from the declared table; no real Mac.
// Written in the 1.4.0 mission, NOT executed there.
import { describe, expect, it } from 'vitest';
import type { PerceptionStatus } from '../../../../src/shared/perception';
import { declaredRuntime, type CapabilityId, type PlatformId, type RuntimeCapability } from '../../../../src/shared/platform';
import { defaultSettings } from '../../../../src/shared/settings';
import { GLYPH, GLYPH_TEXT, type GlyphName } from '../../../../src/renderer/settings/dom';
import { displayAccelerator, formatShortcut } from '../../../../src/renderer/settings/format';
import { behaviorPageNotes, behaviorRowOffered, FINE_TUNE_SLIDERS, fineTuneDesc, settingRowOffered } from '../../../../src/renderer/settings/pages/behavior';
import { shortcutFieldText, startupStateDesc } from '../../../../src/renderer/settings/pages/general';
import { processRowText, visualModeDesc } from '../../../../src/renderer/settings/pages/privacy';
import { welcomePlatformText } from '../../../../src/renderer/settings/pages/welcome';
import { bannerModel, consentModel, type PrivacyViewInput } from '../../../../src/renderer/settings/privacyView';
import { deviceWords, S } from '../../../../src/renderer/settings/strings';
import { validateShortcut } from '../../../../src/renderer/settings/validate';

const V = S.validation;

function status(id: PlatformId | null, over: Partial<Record<CapabilityId, RuntimeCapability>> = {}): { platform: PrivacyViewInput['status']['platform'] } {
  return { platform: id === null ? undefined : { id, label: id, capabilities: { ...declaredRuntime(id), ...over } } };
}

function view(id: PlatformId | null, perception: Partial<PerceptionStatus>): PrivacyViewInput {
  return {
    settings: defaultSettings(),
    status: { ...status(id), visible: true, perception: { mode: 'off', paused: false, lastCaptureAt: null, capturesThisHour: 0, aiProviderLabel: null, blockedReason: null, lastError: null, ...perception } },
  } as unknown as PrivacyViewInput;
}

describe('deviceWords', () => {
  it('leaves a Windows sentence alone', () => {
    const text = 'Nothing leaves this PC while the PC is locked. It cannot control your PC.';
    expect(deviceWords(text, 'windows')).toBe(text);
  });

  it('names the Mac on macOS and the computer elsewhere', () => {
    expect(deviceWords('Nothing leaves this PC while the PC is locked. It cannot control your PC.', 'mac')).toBe('Nothing leaves this Mac while the Mac is locked. It cannot control your Mac.');
    expect(deviceWords('Ollama (this PC)', 'elsewhere')).toBe('Ollama (this computer)');
  });

  it('does not touch other words', () => {
    expect(deviceWords('PC cards and EPC codes', 'mac')).toBe('PC cards and EPC codes');
  });
});

describe('shortcuts on macOS', () => {
  it('keeps the Windows behaviour and text by default', () => {
    expect(validateShortcut('Command+Shift+C')).toEqual({ ok: false, error: V.shortcutUnknownPart('Command') });
    expect(validateShortcut('Control+Alt+Delete')).toEqual({ ok: false, error: V.shortcutReserved });
    expect(V.shortcutReserved).toBe('Windows reserves this combination. Choose another one.');
    expect(V.shortcutUnknownPart('X')).toBe('"X" is not a key Windows shortcuts understand.');
  });

  it('accepts Command and Cmd, stored as Super', () => {
    expect(validateShortcut('Command+Shift+C', 'mac')).toEqual({ ok: true, value: 'Shift+Super+C' });
    expect(validateShortcut('cmd+Option+C', 'mac')).toEqual({ ok: true, value: 'Alt+Super+C' });
  });

  it('never names Windows in its messages', () => {
    for (const bad of ['', 'Shift+C', 'Control+Hyper+C', 'Control+Alt+Delete']) {
      for (const wording of ['mac', 'elsewhere'] as const) {
        const r = validateShortcut(bad, wording);
        expect(r.ok).toBe(false);
        if (!r.ok) expect(r.error).not.toMatch(/Windows/);
      }
    }
    expect(validateShortcut('Shift+C', 'mac')).toEqual({ ok: false, error: V.shortcutNeedsModifierMac });
    expect(validateShortcut('', 'mac')).toEqual({ ok: false, error: V.shortcutEmptyMac });
  });

  it('names a repeated modifier as macOS does', () => {
    expect(validateShortcut('Command+Cmd+C', 'mac')).toEqual({ ok: false, error: V.shortcutDuplicateModifier('Command') });
  });

  it('shows the stored keys with macOS names, and that text validates back to the same value', () => {
    expect(displayAccelerator('Control+Alt+Shift+C', 'mac')).toBe('Control+Option+Shift+C');
    expect(displayAccelerator('Super+Shift+C', 'mac')).toBe('Command+Shift+C');
    expect(displayAccelerator('Control+Alt+Shift+C', 'windows')).toBe('Control+Alt+Shift+C');
    expect(displayAccelerator('Control+Alt+Shift+C', 'elsewhere')).toBe('Control+Alt+Shift+C');
    for (const stored of ['Control+Alt+Shift+C', 'Alt+Shift+Super+C']) {
      expect(validateShortcut(displayAccelerator(stored, 'mac'), 'mac')).toEqual({ ok: true, value: stored });
    }
    expect(formatShortcut('Control+Alt+Shift+C', 'mac')).toBe('Control + Option + Shift + C');
    expect(formatShortcut('Control+Alt+Shift+C')).toBe('Control + Alt + Shift + C');
  });

  it('gives the hint and placeholder in macOS terms only on macOS', () => {
    expect(shortcutFieldText('windows')).toEqual({ hint: V.shortcutHint, placeholder: S.general.shortcutPlaceholder });
    expect(shortcutFieldText('elsewhere')).toEqual({ hint: V.shortcutHint, placeholder: S.general.shortcutPlaceholder });
    const mac = shortcutFieldText('mac');
    expect(mac.hint).toMatch(/Option/);
    expect(mac.hint).toMatch(/Command/);
    expect(validateShortcut(mac.placeholder, 'mac').ok).toBe(true);
  });
});

describe('General and Welcome', () => {
  it('keeps "starts with Windows" for Windows only', () => {
    expect(startupStateDesc('windows')).toBe('How the cat appears each time the app starts, also when it starts with Windows.');
    for (const wording of ['mac', 'elsewhere'] as const) expect(startupStateDesc(wording)).not.toMatch(/Windows/);
  });

  it('keeps every Welcome text on Windows', () => {
    const t = welcomePlatformText('windows');
    expect(t.intro).toBe(S.welcome.intro);
    expect(t.controls).toBe(S.welcome.controls);
    expect(t.privacyPoints).toBe(S.welcome.privacyPoints);
  });

  it('describes the floor, the menu bar and this Mac on macOS', () => {
    const t = welcomePlatformText('mac');
    expect(t.intro('Miso')).toMatch(/bottom of your screen/);
    expect(t.intro('Miso')).not.toMatch(/taskbar|on top of windows/);
    expect(t.controls.at(-1)).toEqual(S.welcome.controlTrayMac);
    expect(t.controls).toHaveLength(S.welcome.controls.length);
    expect(JSON.stringify(t.controls)).not.toMatch(/notification area/);
    expect(t.privacyPoints.join(' ')).toMatch(/this Mac/);
    expect(t.privacyPoints.join(' ')).not.toMatch(/\bPC\b/);
  });

  it('says only what the app can know where windows are not tracked and typing is not inferred', () => {
    for (const wording of ['mac', 'elsewhere'] as const) {
      const points = welcomePlatformText(wording).privacyPoints;
      expect(points).toHaveLength(S.welcome.privacyPoints.length);
      expect(points[0]).toBe(S.welcome.privacyPoints[0]);
      expect(points[1]).toBe(S.welcome.privacyPointFloorOnly);
      expect(points.join(' ')).not.toMatch(/knows where windows|tell that you are typing/);
    }
    expect(S.welcome.privacyPoints[1]).toBe('It knows where windows are and whether you are active. It can tell that you are typing, but never what you type.');
  });
});

describe('Privacy on macOS', () => {
  it('words the banner and main’s labels and reasons for the Mac', () => {
    const m = bannerModel(view('darwin', { mode: 'ai-local', aiProviderLabel: 'Ollama (this PC)', blockedReason: 'This AI endpoint is not on this PC.' }), 0);
    expect(m.title).toBe('AI vision · server on this Mac');
    expect(m.text).not.toMatch(/\bPC\b/);
    expect(m.details.join(' ')).not.toMatch(/\bPC\b/);
    expect(m.details.join(' ')).toMatch(/Ollama \(this Mac\)/);
  });

  it('leaves the banner untouched on Windows and without a platform report', () => {
    for (const id of ['win32', null] as const) {
      const m = bannerModel(view(id, { mode: 'ai-local', aiProviderLabel: 'Ollama (this PC)' }), 0);
      expect(m.title).toBe(S.privacy.banner['ai-local'].title);
      expect(m.text).toBe(S.privacy.banner['ai-local'].text);
      expect(m.details.join(' ')).toMatch(/Ollama \(this PC\)/);
    }
  });

  it('words the consent dialog for the Mac; Windows by default', () => {
    const settings = defaultSettings();
    const local = consentModel('local-stats', settings, 'mac');
    expect(local.points.join(' ')).toMatch(/this Mac/);
    expect(local.points.join(' ')).not.toMatch(/\bPC\b/);
    expect(consentModel('local-stats', settings)).toEqual(consentModel('local-stats', settings, 'windows'));
    expect(consentModel('local-stats', settings).points.join(' ')).toMatch(/this PC/);
    expect(consentModel('ai', settings, 'mac').points.join(' ')).toMatch(/your Mac/);
  });

  it('says what "Off" knows on each platform', () => {
    expect(visualModeDesc('off', 'windows')).toBe(S.privacy.modes.off.desc);
    expect(S.privacy.modes.off.desc).toBe('The cat only knows where windows are. It never looks at their contents.');
    for (const wording of ['mac', 'elsewhere'] as const) {
      expect(visualModeDesc('off', wording)).toBe(S.privacy.modeOffDescFloorOnly);
      expect(visualModeDesc('off', wording)).not.toMatch(/only knows where windows/);
    }
    expect(visualModeDesc('local-stats', 'mac')).toMatch(/this Mac/);
    expect(visualModeDesc('local-stats', 'windows')).toBe(S.privacy.modes['local-stats'].desc);
  });

  it('says the program list does nothing where main reports analysis unavailable', () => {
    expect(processRowText(status(null))).toEqual({ hint: V.processHint, placeholder: S.privacy.processesPlaceholder });
    expect(processRowText(status('win32', { perception: { available: false, reason: 'x' } }))).toEqual({ hint: V.processHint, placeholder: S.privacy.processesPlaceholder });
    const mac = processRowText(status('darwin', { perception: { available: false, reason: 'x' } }));
    expect(mac).toEqual({ hint: V.processHintUnavailable, placeholder: S.privacy.processesPlaceholderUnavailable });
    expect(`${mac.hint} ${mac.placeholder}`).not.toMatch(/\.exe|Windows/);
    expect(processRowText(status('darwin', { perception: { available: true, reason: null } }))).toEqual({ hint: V.processHint, placeholder: S.privacy.processesPlaceholder });
  });
});

describe('Behaviour rows off Windows', () => {
  const gone = { available: false, reason: 'n/a' };
  const here = { available: true, reason: null };
  const WINDOW_ROWS = ['inspectWindows', 'perchOnWindows', 'climbWindows', 'screenEdges', 'taskbarPlay', 'tabStrips', 'explorerTabs', 'terminalTabs', 'tabReactions', 'surfaceHops'] as const;
  const NEEDS_INPUT = ['behavior.stayLength', 'behavior.activitySensitivity', 'behavior.reactToWindows', 'behavior.reactToTyping'] as const;
  const nothing = { windowSurfaces: gone, taskbarSurfaces: gone, tabStrips: gone, perception: gone };

  it('offers every row on Windows, whatever main reports, and without a platform report', () => {
    for (const id of WINDOW_ROWS) {
      expect(behaviorRowOffered(id, status(null))).toBe(true);
      expect(behaviorRowOffered(id, status('win32', { taskbarSurfaces: gone, tabStrips: gone, windowSurfaces: gone }))).toBe(true);
    }
  });

  it('leaves out the rows that name what macOS does not have', () => {
    const mac = status('darwin', { taskbarSurfaces: gone, tabStrips: gone, windowSurfaces: gone });
    for (const id of WINDOW_ROWS) expect(behaviorRowOffered(id, mac)).toBe(false);
    for (const id of ['chaseCursor', 'pawAtCursor', 'seekAttention', 'zoomies', 'grooming', 'pounce', 'hissing', 'tailChase', 'slips'] as const) expect(behaviorRowOffered(id, mac)).toBe(true);
  });

  it('keeps every setting row on Windows, whatever main reports, and without a platform report', () => {
    for (const id of NEEDS_INPUT) {
      expect(settingRowOffered(id, status(null))).toBe(true);
      expect(settingRowOffered(id, status('win32', nothing))).toBe(true);
    }
  });

  it('leaves out the settings that have nothing to act on where the cat is floor-only', () => {
    for (const platform of ['darwin', 'linux-x11'] as const) {
      for (const id of NEEDS_INPUT) expect(settingRowOffered(id, status(platform, nothing))).toBe(false);
      for (const id of ['behavior.exploration', 'behavior.sleepAfterIdleMinutes', 'behavior.allowMultiMonitor'] as const) expect(settingRowOffered(id, status(platform, nothing))).toBe(true);
    }
  });

  it('follows what main reports, and keeps Activity sensitivity while one of its inputs exists', () => {
    expect(settingRowOffered('behavior.reactToWindows', status('darwin', { windowSurfaces: here }))).toBe(true);
    expect(settingRowOffered('behavior.activitySensitivity', status('darwin', { ...nothing, perception: here }))).toBe(true);
    expect(settingRowOffered('behavior.reactToTyping', status('darwin', { windowSurfaces: here, perception: here }))).toBe(false);
  });

  it('keeps the Fine-tune summary on Windows and drops the stays slider from it elsewhere', () => {
    expect(fineTuneDesc(status(null))).toBe(S.behavior.fineTuneDesc);
    expect(fineTuneDesc(status('win32', nothing))).toBe(S.behavior.fineTuneDesc);
    expect(fineTuneDesc(status('darwin', nothing))).toBe(S.behavior.fineTuneDescFloorOnly);
    expect(S.behavior.fineTuneDescFloorOnly).not.toMatch(/stays/);
  });

  it('keeps both notes on Windows, and gives neither window advice nor hidden rows on the floor', () => {
    const windows = [S.behavior.maximizedNote, S.behavior.extrasPointer];
    expect(behaviorPageNotes(status(null))).toEqual(windows);
    expect(behaviorPageNotes(status('win32', nothing))).toEqual(windows);
    expect(behaviorPageNotes(status('darwin', nothing))).toEqual([S.behavior.extrasPointerFloorOnly]);
    expect(S.behavior.extrasPointerFloorOnly).not.toMatch(/screen edges|windows/);
    expect(S.behavior.extrasPointerFloorOnly).toMatch(/Fine-tune/);
  });

  it('keeps the taskbar in the mischief text on Windows only', () => {
    const spec = FINE_TUNE_SLIDERS.find((s) => s.title === S.behavior.mischiefTitle);
    expect(spec?.desc).toBe(S.behavior.mischiefDesc);
    expect(S.behavior.mischiefDesc).toMatch(/taskbar/);
    expect(S.behavior.mischiefDescFloorOnly).not.toMatch(/taskbar/);
  });
});

describe('Icons without the Segoe fonts', () => {
  it('has a plain stand-in for every glyph, none of them a private-use code point', () => {
    for (const name of Object.keys(GLYPH) as GlyphName[]) {
      const text = GLYPH_TEXT[name];
      expect(text.length).toBeGreaterThan(0);
      expect(text).not.toMatch(/[-]/);
    }
  });

  it('keeps Segoe code points in the Windows set', () => {
    for (const glyph of Object.values(GLYPH)) expect(glyph).toMatch(/^[-]$/);
  });
});
