// Guards the UI's mirrored ranges and id lists against the real zod schema.
import { describe, expect, it } from 'vitest';
import { SetApiKeySchema } from '../../../../src/shared/ipc';
import { AI_PROVIDERS, applySettingsPatch, defaultSettings, TOGGLEABLE_BEHAVIORS } from '../../../../src/shared/settings';
import { MAX_SHORTCUT_LENGTH as SHARED_MAX_SHORTCUT_LENGTH } from '../../../../src/shared/shortcut';
import {
  API_KEY_LENGTH,
  BEHAVIOR_IDS,
  CATALOG_COMPLETE,
  isPageId,
  MAX_CAT_NAME_LENGTH,
  MAX_EXCLUDED_PROCESSES,
  MAX_EXCLUDED_TITLE_PATTERNS,
  MAX_LIST_ENTRY_LENGTH,
  MAX_MODEL_LENGTH,
  MAX_SHORTCUT_LENGTH,
  MAX_URL_LENGTH,
  PROVIDER_IDS,
} from '../../../../src/renderer/settings/catalog';
import { intervalStops, nearestStopIndex, NUMERIC_FIELDS, snapToStep, formatValue } from '../../../../src/renderer/settings/fields';
import { buildPatch } from '../../../../src/renderer/settings/patch';

const accepts = (section: string, key: string, v: unknown): boolean => applySettingsPatch(defaultSettings(), { [section]: { [key]: v } }).ok;

describe('numeric field specs match the settings schema', () => {
  for (const [name, f] of Object.entries(NUMERIC_FIELDS)) {
    it(`${name} (${f.section}.${f.key}) bounds`, () => {
      expect(accepts(f.section, f.key, f.min)).toBe(true);
      expect(accepts(f.section, f.key, f.max)).toBe(true);
      expect(accepts(f.section, f.key, f.min - f.step)).toBe(false);
      expect(accepts(f.section, f.key, f.max + f.step)).toBe(false);
      const steps = (f.max - f.min) / f.step;
      expect(Math.abs(steps - Math.round(steps))).toBeLessThan(1e-9);
      const def = (defaultSettings()[f.section] as Record<string, unknown>)[f.key] as number;
      expect(snapToStep(f, def)).toBe(def);
      if (f.step === 1) expect(accepts(f.section, f.key, f.min + 0.5)).toBe(false);
    });
  }

  it('every snapped value on the grid is accepted', () => {
    for (const f of Object.values(NUMERIC_FIELDS)) {
      if (f.step !== 0.05) continue;
      for (let v = f.min; v <= f.max + 1e-9; v += f.step) expect(accepts(f.section, f.key, snapToStep(f, v))).toBe(true);
    }
  });
});

describe('snapToStep', () => {
  const spec = { min: 0.3, max: 1, step: 0.05, format: 'percent' as const };
  it('removes float noise, snaps and clamps', () => {
    expect(snapToStep(spec, 0.30000000000000004)).toBe(0.3);
    expect(snapToStep(spec, 0.47)).toBe(0.45);
    expect(snapToStep(spec, 0.48)).toBe(0.5);
    expect(snapToStep(spec, 5)).toBe(1);
    expect(snapToStep(spec, -1)).toBe(0.3);
    expect(snapToStep(spec, Number.NaN)).toBe(0.3);
  });
});

describe('interval stops', () => {
  it('always include both bounds and stay sorted and inside the range', () => {
    for (const [min, max] of [
      [5, 3600],
      [30, 86400],
      [7, 13],
    ] as const) {
      const stops = intervalStops(min, max);
      expect(stops[0]).toBe(min);
      expect(stops[stops.length - 1]).toBe(max);
      for (let i = 1; i < stops.length; i++) expect(stops[i]!).toBeGreaterThan(stops[i - 1]!);
    }
    expect(intervalStops(7, 13)).toEqual([7, 10, 13]);
  });

  it('finds the nearest stop', () => {
    const stops = intervalStops(5, 3600);
    expect(stops[nearestStopIndex(stops, 20)]).toBe(20);
    expect(stops[nearestStopIndex(stops, 50)]).toBe(45);
    expect(stops[nearestStopIndex(stops, 52.5)]).toBe(45);
    expect(stops[nearestStopIndex(stops, 100000)]).toBe(3600);
    expect(stops[nearestStopIndex(stops, 1)]).toBe(5);
  });

  it('formats values per field kind', () => {
    expect(formatValue('percent', 1)).toBe('100%');
    expect(formatValue('multiplier', 1.5)).toBe('1.5×');
    expect(formatValue('minutes', 5)).toBe('5 min');
    expect(formatValue('duration', 120)).toBe('2 min');
    expect(formatValue('perHour', 12)).toBe('12 per hour');
  });
});

describe('catalog mirrors shared constants', () => {
  it('keeps id lists identical and in order', () => {
    expect([...BEHAVIOR_IDS]).toEqual([...TOGGLEABLE_BEHAVIORS]);
    expect([...PROVIDER_IDS]).toEqual([...AI_PROVIDERS]);
    expect(CATALOG_COMPLETE).toBe(true);
    expect(isPageId('privacy')).toBe(true);
    expect(isPageId('settings')).toBe(false);
  });

  it('keeps list and text limits identical to the schema', () => {
    const procs = Array.from({ length: MAX_EXCLUDED_PROCESSES }, (_, i) => `p${i}.exe`);
    expect(accepts('perception', 'excludedProcesses', procs)).toBe(true);
    expect(accepts('perception', 'excludedProcesses', [...procs, 'one-more.exe'])).toBe(false);
    const pats = Array.from({ length: MAX_EXCLUDED_TITLE_PATTERNS }, (_, i) => `pattern ${i}`);
    expect(accepts('perception', 'excludedTitlePatterns', pats)).toBe(true);
    expect(accepts('perception', 'excludedTitlePatterns', [...pats, 'one more'])).toBe(false);
    expect(accepts('perception', 'excludedProcesses', ['x'.repeat(MAX_LIST_ENTRY_LENGTH)])).toBe(true);
    expect(accepts('perception', 'excludedProcesses', ['x'.repeat(MAX_LIST_ENTRY_LENGTH + 1)])).toBe(false);
    expect(accepts('general', 'catName', 'x'.repeat(MAX_CAT_NAME_LENGTH))).toBe(true);
    expect(accepts('general', 'catName', 'x'.repeat(MAX_CAT_NAME_LENGTH + 1))).toBe(false);
    // The schema also requires a safe, canonical accelerator (src/shared/shortcut.ts).
    expect(MAX_SHORTCUT_LENGTH).toBe(SHARED_MAX_SHORTCUT_LENGTH);
    expect(accepts('general', 'toggleShortcut', 'CommandOrControl+Alt+AltGr+Shift+Super+MediaPreviousTrack')).toBe(true);
    expect(accepts('general', 'toggleShortcut', `Control+Alt+${'x'.repeat(MAX_SHORTCUT_LENGTH)}`)).toBe(false);
    expect(accepts('ai', 'ollamaBaseUrl', 'x'.repeat(MAX_URL_LENGTH))).toBe(true);
    expect(accepts('ai', 'ollamaBaseUrl', 'x'.repeat(MAX_URL_LENGTH + 1))).toBe(false);
    expect(accepts('ai', 'anthropicModel', 'x'.repeat(MAX_MODEL_LENGTH.anthropic))).toBe(true);
    expect(accepts('ai', 'anthropicModel', 'x'.repeat(MAX_MODEL_LENGTH.anthropic + 1))).toBe(false);
    expect(accepts('ai', 'openaiModel', 'x'.repeat(MAX_MODEL_LENGTH.openai + 1))).toBe(false);
    expect(accepts('ai', 'ollamaModel', 'x'.repeat(MAX_MODEL_LENGTH.ollama + 1))).toBe(false);
  });

  it('keeps the API key length identical to the IPC schema', () => {
    const ok = (key: string) => SetApiKeySchema.safeParse({ provider: 'anthropic', key }).success;
    expect(ok('k'.repeat(API_KEY_LENGTH.min))).toBe(true);
    expect(ok('k'.repeat(API_KEY_LENGTH.min - 1))).toBe(false);
    expect(ok('k'.repeat(API_KEY_LENGTH.max))).toBe(true);
    expect(ok('k'.repeat(API_KEY_LENGTH.max + 1))).toBe(false);
  });

  it('builds single-leaf patches main accepts', () => {
    const patch = buildPatch('appearance', 'size', 1.5);
    expect(patch).toEqual({ appearance: { size: 1.5 } });
    expect(applySettingsPatch(defaultSettings(), patch).ok).toBe(true);
  });
});
