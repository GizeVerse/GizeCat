import { describe, expect, it } from 'vitest';
import { applySettingsPatch, defaultSettings, migrateSettings } from '../../../src/shared/settings';
import { DEFAULT_TOGGLE_SHORTCUT, isSafeShortcut, parseShortcut } from '../../../src/shared/shortcut';

describe('global shortcut rules (shared by main and the settings UI)', () => {
  it('normalises spelling, case and modifier order', () => {
    expect(parseShortcut('ctrl + alt + shift + c')).toEqual({ ok: true, accelerator: 'Control+Alt+Shift+C' });
    expect(parseShortcut('Shift+Win+f13')).toEqual({ ok: true, accelerator: 'Shift+Super+F13' });
    expect(parseShortcut('Alt+Control+Space')).toEqual({ ok: true, accelerator: 'Control+Alt+Space' });
    expect(isSafeShortcut(DEFAULT_TOGGLE_SHORTCUT)).toBe(true);
  });

  it.each([
    ['A', 'needs-modifier'],
    ['Space', 'needs-modifier'],
    ['Shift+A', 'needs-modifier'],
    ['Enter', 'needs-modifier'],
    ['Control+Alt', 'no-key'],
    ['Control+A+B', 'two-keys'],
    ['Control+Ctrl+A', 'duplicate-modifier'],
    ['Control+Hyper+A', 'unknown-part'],
    ['Alt+F4', 'reserved'],
    ['Control+Alt+Delete', 'reserved'],
    ['Super+L', 'reserved'],
    ['', 'empty'],
  ])('rejects "%s" (%s)', (text, code) => {
    const r = parseShortcut(text);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe(code);
  });

  it('a high function key needs no modifier: nothing types with it', () => {
    expect(parseShortcut('F20')).toEqual({ ok: true, accelerator: 'F20' });
    expect(parseShortcut('F5').ok).toBe(false);
  });
});

describe('toggleShortcut in settings', () => {
  it('a patch with a bare key or reserved combination is rejected in main', () => {
    const cur = defaultSettings();
    for (const toggleShortcut of ['A', 'Space', 'Shift+Z', 'Alt+Tab', 'Control+Alt+Shift+C+D']) {
      expect(applySettingsPatch(cur, { general: { toggleShortcut } }).ok).toBe(false);
    }
    const ok = applySettingsPatch(cur, { general: { toggleShortcut: 'Control+Alt+K' } });
    expect(ok.ok && ok.settings.general.toggleShortcut).toBe('Control+Alt+K');
  });

  it('a hand-edited unsafe value in settings.json falls back to the default; a valid one is normalised', () => {
    expect(migrateSettings({ schemaVersion: 1, general: { toggleShortcut: 'A' } }).general.toggleShortcut).toBe(DEFAULT_TOGGLE_SHORTCUT);
    expect(migrateSettings({ schemaVersion: 1, general: { toggleShortcut: 42 } }).general.toggleShortcut).toBe(DEFAULT_TOGGLE_SHORTCUT);
    expect(migrateSettings({ schemaVersion: 1, general: { toggleShortcut: 'ctrl+alt+k', catName: 'Pixel' } }).general).toMatchObject({
      toggleShortcut: 'Control+Alt+K',
      catName: 'Pixel',
    });
  });
});
