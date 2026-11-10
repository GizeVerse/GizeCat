// The web settings allow-list (src/web/settingsModel.ts): only the sheet's leaves, named presets
// only, the desktop's validation, and screen analysis and AI forced off whatever the patch says.
import { describe, expect, it } from 'vitest';
import { defaultSettings } from '../../../src/shared/settings';
import { PRESET_VALUES, presetPatch } from '../../../src/shared/settingsPresets';
import { applyWebPatch, patchFor, rejectNonWebPatch, resetWebSettings, selectedPreset, snap, SIZE_RANGE, VOLUME_RANGE } from '../../../src/web/settingsModel';
import { webSettings } from '../../../src/web/storage';

describe('web settings patches', () => {
  it('builds patches for each sheet control, refusing values the control cannot have', () => {
    expect(patchFor({ field: 'catName', value: '  Pamuk ' })).toEqual({ general: { catName: 'Pamuk' } });
    expect(patchFor({ field: 'catName', value: '   ' })).toBeNull();
    expect(patchFor({ field: 'catName', value: 'x'.repeat(25) })).toBeNull();
    expect(patchFor({ field: 'skin', value: 'tuxedo' })).toEqual({ appearance: { skin: 'tuxedo' } });
    expect(patchFor({ field: 'skin', value: 'zebra' as never })).toBeNull();
    expect(patchFor({ field: 'style', value: 'pixel' })).toEqual({ appearance: { style: 'pixel' } });
    expect(patchFor({ field: 'size', value: 1.2000000000000002 })).toEqual({ appearance: { size: 1.2 } });
    expect(patchFor({ field: 'size', value: Number.NaN })).toBeNull();
    expect(patchFor({ field: 'shadow', value: false })).toEqual({ appearance: { shadow: false } });
    expect(patchFor({ field: 'soundEnabled', value: true })).toEqual({ sound: { enabled: true } });
    expect(patchFor({ field: 'volume', value: 0.33 })).toEqual({ sound: { volume: 0.35 } });
    expect(patchFor({ field: 'preset', value: 'calm' })).toEqual(presetPatch('calm'));
    expect(patchFor({ field: 'preset', value: 'custom' as never })).toBeNull();
  });

  it('snaps slider values to their step and range', () => {
    expect(snap(9, SIZE_RANGE)).toBe(2.5);
    expect(snap(0.1, SIZE_RANGE)).toBe(0.5);
    expect(snap(0.512, VOLUME_RANGE)).toBe(0.5);
    expect(snap(Number.POSITIVE_INFINITY, VOLUME_RANGE)).toBe(0);
  });

  it('applies allowed patches without touching the input settings', () => {
    const s = webSettings(null);
    const r = applyWebPatch(s, { appearance: { skin: 'calico', size: 1.5 } });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.settings.appearance.skin).toBe('calico');
    expect(r.settings.appearance.size).toBe(1.5);
    expect(s.appearance.skin).toBe(defaultSettings().appearance.skin);
    const p = applyWebPatch(s, presetPatch('mischievous'));
    expect(p.ok && p.settings.behavior.activityPreset).toBe('mischievous');
    expect(p.ok && p.settings.behavior.autonomy).toBe(PRESET_VALUES.mischievous.behavior.autonomy);
  });

  it('refuses anything outside the allow-list: other leaves and sections, custom mixes, consent and AI', () => {
    const s = webSettings(null);
    const refused = [
      { appearance: { hideFromScreenCapture: true } },
      { general: { startupState: 'hidden' } },
      { behavior: { autonomy: 0.9 } },
      { behavior: { ...presetPatch('calm').behavior, autonomy: 0.9 }, interaction: presetPatch('calm').interaction },
      { behavior: presetPatch('calm').behavior },
      { interaction: { enabled: false } },
      { perception: { visualMode: 'ai' } },
      { ai: { provider: 'anthropic', allowCloud: true } },
      { loginItem: { preference: 'enabled' } },
      { schemaVersion: 1 },
      {},
      null,
      [],
    ];
    for (const patch of refused) {
      expect(rejectNonWebPatch(patch), JSON.stringify(patch)).not.toBeNull();
      expect(applyWebPatch(s, patch).ok, JSON.stringify(patch)).toBe(false);
    }
  });

  it("refuses values the desktop's validation refuses (every patched leaf must survive unchanged)", () => {
    const s = webSettings(null);
    expect(applyWebPatch(s, { appearance: { size: 9 } }).ok).toBe(false);
    expect(applyWebPatch(s, { general: { catName: ' padded ' } }).ok).toBe(false);
    expect(applyWebPatch(s, { sound: { volume: -1 } }).ok).toBe(false);
  });

  it('offers the Living Companion choices: personality, events, pace, calmer motion, journal and the sound categories', () => {
    const s = webSettings(null);
    expect(patchFor({ field: 'personality', value: 'shy' })).toEqual({ companion: { personality: 'shy' } });
    expect(patchFor({ field: 'personality', value: 'auto' })).toEqual({ companion: { personality: 'auto' } });
    expect(patchFor({ field: 'personality', value: 'grumpy' as never })).toBeNull();
    expect(patchFor({ field: 'eventPace', value: 1.3 })).toEqual({ companion: { events: { pace: 1.25 } } });
    expect(patchFor({ field: 'eventPace', value: 99 })).toEqual({ companion: { events: { pace: 2 } } });
    expect(patchFor({ field: 'eventPace', value: Number.NaN })).toBeNull();
    expect(patchFor({ field: 'rareEvents', value: false })).toEqual({ companion: { events: { rare: false } } });
    expect(patchFor({ field: 'journalEnabled', value: false })).toEqual({ companion: { journal: { enabled: false } } });
    expect(patchFor({ field: 'soundWorld', value: false })).toEqual({ sound: { world: false } });
    expect(patchFor({ field: 'soundCat', value: 'yes' as never })).toBeNull();
    const off = patchFor({ field: 'eventToggle', id: 'tinyUfo', enabled: false, current: s });
    expect(off).toEqual({ companion: { events: { disabled: ['tinyUfo'] } } });
    const r = applyWebPatch(s, off);
    expect(r.ok && r.settings.companion.events.disabled).toEqual(['tinyUfo']);
    // The other leaves of `events` are kept: a patch may name one leaf of a small object.
    expect(r.ok && r.settings.companion.events.pace).toBe(1);
    const on = r.ok ? patchFor({ field: 'eventToggle', id: 'tinyUfo', enabled: true, current: r.settings }) : null;
    expect(on).toEqual({ companion: { events: { disabled: [] } } });
    expect(patchFor({ field: 'eventToggle', id: 'notAnEvent' as never, enabled: false, current: s })).toBeNull();
    for (const patch of [{ companion: { personality: 'shy' } }, { companion: { reducedMotion: true } }, { sound: { cat: false } }]) {
      expect(rejectNonWebPatch(patch), JSON.stringify(patch)).toBeNull();
      expect(applyWebPatch(s, patch).ok, JSON.stringify(patch)).toBe(true);
    }
    expect(applyWebPatch(s, { companion: { personality: 'grumpy' } }).ok).toBe(false);
    expect(applyWebPatch(s, { companion: { events: { pace: 3 } } }).ok).toBe(false);
    expect(rejectNonWebPatch({ companion: { nothing: true } })).not.toBeNull();
  });

  it('forces screen analysis and AI off on every result, and resets to the web defaults', () => {
    const s = defaultSettings();
    s.perception.visualMode = 'ai';
    s.ai.provider = 'anthropic';
    s.ai.allowCloud = true;
    const r = applyWebPatch(s, { sound: { enabled: true } });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect([r.settings.perception.visualMode, r.settings.ai.provider, r.settings.ai.allowCloud]).toEqual(['off', 'none', false]);
    expect(resetWebSettings()).toEqual(webSettings(null));
    expect(selectedPreset(resetWebSettings())).toBe('playful');
    const custom = defaultSettings();
    custom.behavior.activityPreset = 'custom';
    expect(selectedPreset(custom)).toBeNull();
  });
});
