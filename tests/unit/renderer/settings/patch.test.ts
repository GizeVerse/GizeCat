import { describe, expect, it } from 'vitest';
import { defaultSettings } from '../../../../src/shared/settings';
import { addEntry, buildPatch, fieldId, readField, removeEntry, setBehaviorEnabled, valuesEqual } from '../../../../src/renderer/settings/patch';

describe('patch helpers', () => {
  it('builds minimal one-leaf patches', () => {
    expect(buildPatch('general', 'catName', 'Pixel')).toEqual({ general: { catName: 'Pixel' } });
    expect(buildPatch('behavior', 'disabledBehaviors', ['zoomies'])).toEqual({ behavior: { disabledBehaviors: ['zoomies'] } });
    expect(fieldId('ai', 'allowCloud')).toBe('ai.allowCloud');
  });

  it('reads leaves', () => {
    const s = defaultSettings();
    expect(readField(s, 'appearance', 'skin')).toBe('ginger');
    expect(readField(s, 'perception', 'visualMode')).toBe('off');
  });

  it('compares leaves structurally', () => {
    expect(valuesEqual(1, 1)).toBe(true);
    expect(valuesEqual(0.1 + 0.2, 0.3)).toBe(false);
    expect(valuesEqual(['a', 'b'], ['a', 'b'])).toBe(true);
    expect(valuesEqual(['a', 'b'], ['b', 'a'])).toBe(false);
    expect(valuesEqual(['a'], 'a')).toBe(false);
    expect(valuesEqual(Number.NaN, Number.NaN)).toBe(true);
  });

  it('switches behaviours in canonical order without duplicates', () => {
    expect(setBehaviorEnabled([], 'zoomies', false)).toEqual(['zoomies']);
    expect(setBehaviorEnabled(['zoomies'], 'chaseCursor', false)).toEqual(['chaseCursor', 'zoomies']);
    expect(setBehaviorEnabled(['chaseCursor', 'zoomies'], 'chaseCursor', true)).toEqual(['zoomies']);
    expect(setBehaviorEnabled(['zoomies', 'zoomies'], 'zoomies', false)).toEqual(['zoomies']);
    expect(setBehaviorEnabled(['grooming'], 'zoomies', true)).toEqual(['grooming']);
  });

  it('adds and removes list entries immutably', () => {
    const list = ['a.exe'];
    expect(addEntry(list, 'b.exe')).toEqual(['a.exe', 'b.exe']);
    expect(addEntry(list, 'a.exe')).toEqual(['a.exe']);
    expect(removeEntry(['a.exe', 'b.exe'], 'a.exe')).toEqual(['b.exe']);
    expect(list).toEqual(['a.exe']);
  });
});
