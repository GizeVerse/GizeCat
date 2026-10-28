import { describe, expect, it } from 'vitest';
import {
  applySettingsPatch,
  defaultSettings,
  DEFAULT_EXCLUDED_PROCESSES,
  migrateSettings,
  SETTINGS_SCHEMA_VERSION,
} from '../../../src/shared/settings';

describe('settings schema', () => {
  it('produces complete defaults with privacy-preserving values', () => {
    const s = defaultSettings();
    expect(s.schemaVersion).toBe(SETTINGS_SCHEMA_VERSION);
    expect(s.perception.visualMode).toBe('off');
    expect(s.perception.consentAt).toBeNull();
    expect(s.ai.provider).toBe('none');
    expect(s.ai.allowCloud).toBe(false);
    expect(s.loginItem).toMatchObject({ preference: 'unset', decidedBy: 'default', disabledBy: null });
    expect(s.perception.excludedProcesses).toEqual([...DEFAULT_EXCLUDED_PROCESSES]);
    expect(s.appearance.size).toBe(1);
  });

  it('recovers field-by-field from corrupt values', () => {
    const s = migrateSettings({
      schemaVersion: 1,
      appearance: { size: 'huge', skin: 'dragon', opacity: 0.8 },
      behavior: 'not-an-object',
      perception: { visualMode: 'ai', consentAt: 12 },
    });
    expect(s.appearance.size).toBe(1);
    expect(s.appearance.skin).toBe('ginger');
    expect(s.appearance.opacity).toBe(0.8);
    expect(s.behavior.autonomy).toBe(0.6);
    expect(s.perception.visualMode).toBe('ai');
    expect(s.perception.consentAt).toBeNull();
  });

  it('accepts garbage top-level input', () => {
    for (const raw of [null, 42, 'x', [], { schemaVersion: 'v9' }]) {
      expect(migrateSettings(raw)).toEqual(defaultSettings());
    }
  });

  it('migrates unversioned objects', () => {
    const s = migrateSettings({ general: { catName: 'Pixel' } });
    expect(s.schemaVersion).toBe(SETTINGS_SCHEMA_VERSION);
    expect(s.general.catName).toBe('Pixel');
  });

  it('applies valid patches and rejects invalid ones without mutating', () => {
    const cur = defaultSettings();
    const ok = applySettingsPatch(cur, { appearance: { size: 1.5 }, behavior: { cursorPlay: 0.2 } });
    expect(ok.ok).toBe(true);
    if (ok.ok) {
      expect(ok.settings.appearance.size).toBe(1.5);
      expect(ok.settings.behavior.cursorPlay).toBe(0.2);
    }
    expect(cur.appearance.size).toBe(1);
    expect(applySettingsPatch(cur, { appearance: { size: 99 } }).ok).toBe(false);
    expect(applySettingsPatch(cur, { appearance: { unknownKey: 1 } }).ok).toBe(false);
    expect(applySettingsPatch(cur, { nope: { a: 1 } }).ok).toBe(false);
    expect(applySettingsPatch(cur, { schemaVersion: 2 }).ok).toBe(false);
    expect(applySettingsPatch(cur, null).ok).toBe(false);
    expect(applySettingsPatch(cur, { behavior: { disabledBehaviors: ['chaseCursor'] } }).ok).toBe(true);
    expect(applySettingsPatch(cur, { behavior: { disabledBehaviors: ['rm -rf'] } }).ok).toBe(false);
  });
});
