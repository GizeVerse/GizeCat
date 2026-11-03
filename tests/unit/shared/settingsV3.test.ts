// v1.2 settings package (ADR 0003 §9): preset reconciliation in main after every patch and at
// load, the rule for patches that name a preset, and the tolerant opt-out list helper the
// downgrade-proof sidecar shares with the schema.
import { describe, expect, it } from 'vitest';
import { applySettingsPatch, defaultSettings, MAX_OPT_OUTS, migrateSettings, normalizeOptOutList, type Settings } from '../../../src/shared/settings';
import { isPresetGoverned, PRESET_BEHAVIOR_KEYS, PRESET_INTERACTION_KEYS, PRESET_VALUES, presetChoiceFor, presetPatch } from '../../../src/shared/settingsPresets';

function patched(cur: Settings, patch: unknown): Settings {
  const r = applySettingsPatch(cur, patch);
  if (!r.ok) throw new Error(r.error);
  return r.settings;
}

describe('activity preset reconciliation (main re-runs matchingPreset after every patch)', () => {
  it('a governed slider change sent with activityPreset custom makes the settings custom', () => {
    const s = patched(defaultSettings(), { behavior: { autonomy: 0.65, activityPreset: 'custom' } });
    expect(s.behavior.autonomy).toBe(0.65);
    expect(s.behavior.activityPreset).toBe('custom');
  });

  it('moving the slider back onto the preset value selects the preset again, even though the patch said custom', () => {
    const custom = patched(defaultSettings(), { behavior: { autonomy: 0.65, activityPreset: 'custom' } });
    const back = patched(custom, { behavior: { autonomy: 0.6, activityPreset: 'custom' } });
    expect(back.behavior.activityPreset).toBe('playful');
  });

  it('a governed value patched alone (no activityPreset, e.g. an old client or a test hook) is reconciled too', () => {
    expect(patched(defaultSettings(), { behavior: { autonomy: 0.25 } }).behavior.activityPreset).toBe('custom');
    expect(patched(defaultSettings(), { interaction: { reactionIntensity: 0.9 } }).behavior.activityPreset).toBe('custom');
    // Reaching another preset's values key by key selects it.
    let s = defaultSettings();
    for (const k of PRESET_BEHAVIOR_KEYS) s = patched(s, { behavior: { [k]: PRESET_VALUES.calm.behavior[k] } });
    expect(s.behavior.activityPreset).toBe('custom');
    for (const k of PRESET_INTERACTION_KEYS) s = patched(s, { interaction: { [k]: PRESET_VALUES.calm.interaction[k] } });
    expect(s.behavior.activityPreset).toBe('calm');
  });

  it('a patch naming a preset must carry that preset’s values; presetPatch always does', () => {
    const cur = defaultSettings();
    expect(applySettingsPatch(cur, { behavior: { activityPreset: 'calm' } })).toEqual({ ok: false, error: 'invalid value for behavior.activityPreset' });
    expect(applySettingsPatch(cur, { behavior: { ...presetPatch('calm').behavior, autonomy: 0.5 }, interaction: presetPatch('calm').interaction }).ok).toBe(false);
    for (const id of ['calm', 'playful', 'mischievous'] as const) expect(patched(cur, presetPatch(id)).behavior.activityPreset).toBe(id);
    // Naming the current preset with its own values is fine (a re-click).
    expect(applySettingsPatch(cur, { behavior: { activityPreset: 'playful' } }).ok).toBe(true);
    // 'custom' alone is a hint main resolves: values that match a preset stay on it.
    expect(patched(cur, { behavior: { activityPreset: 'custom' } }).behavior.activityPreset).toBe('playful');
  });

  it('an unrelated patch repairs an inconsistent stored preset name', () => {
    const cur = defaultSettings();
    cur.behavior.autonomy = 0.8;
    expect(cur.behavior.activityPreset).toBe('playful');
    expect(patched(cur, { appearance: { size: 1.2 } }).behavior.activityPreset).toBe('custom');
  });

  it('a preset patch touches only the governed keys and activityPreset', () => {
    const cur = defaultSettings();
    cur.behavior.attentionSeeking = 0.9;
    cur.behavior.disabledExtras = ['slips'];
    cur.sound = { enabled: true, volume: 0.2 };
    const next = patched(cur, presetPatch('mischievous'));
    expect(next.behavior.attentionSeeking).toBe(0.9);
    expect(next.behavior.disabledExtras).toEqual(['slips']);
    expect(next.sound).toEqual({ enabled: true, volume: 0.2 });
    expect(next.perception).toEqual(cur.perception);
  });
});

describe('activity preset at load', () => {
  it('a v3 file whose preset name disagrees with its values is shown as what the values are', () => {
    const file = JSON.parse(JSON.stringify(defaultSettings())) as Record<string, Record<string, unknown>>;
    file.behavior!.autonomy = 0.8;
    file.behavior!.activityPreset = 'calm';
    expect(migrateSettings(file).behavior.activityPreset).toBe('custom');
    const calm = JSON.parse(JSON.stringify(patched(defaultSettings(), presetPatch('calm')))) as Record<string, Record<string, unknown>>;
    calm.behavior!.activityPreset = 'mischievous';
    expect(migrateSettings(calm).behavior.activityPreset).toBe('calm');
    // An unknown preset name (a newer version's) falls back to what the values match.
    calm.behavior!.activityPreset = 'sleepy';
    expect(migrateSettings(calm).behavior.activityPreset).toBe('calm');
  });

  it('stays idempotent and leaves a consistent file untouched', () => {
    const s = patched(defaultSettings(), { behavior: { mischief: 0.9, activityPreset: 'custom' } });
    const again = migrateSettings(JSON.parse(JSON.stringify(s)));
    expect(again).toEqual(s);
    expect(migrateSettings(JSON.parse(JSON.stringify(again)))).toEqual(again);
  });
});

describe('preset helpers', () => {
  it('know which leaves a preset governs', () => {
    for (const k of PRESET_BEHAVIOR_KEYS) expect(isPresetGoverned('behavior', k)).toBe(true);
    for (const k of PRESET_INTERACTION_KEYS) expect(isPresetGoverned('interaction', k)).toBe(true);
    for (const [section, key] of [
      ['behavior', 'attentionSeeking'],
      ['behavior', 'activityPreset'],
      ['behavior', 'disabledExtras'],
      ['interaction', 'patience'],
      ['sound', 'volume'],
      ['perception', 'visualMode'],
    ] as const) {
      expect(isPresetGoverned(section, key), `${section}.${key}`).toBe(false);
    }
  });

  it('name the choice for the selector', () => {
    expect(presetChoiceFor(defaultSettings())).toBe('playful');
    expect(presetChoiceFor(patched(defaultSettings(), presetPatch('calm')))).toBe('calm');
    expect(presetChoiceFor(patched(defaultSettings(), { behavior: { heights: 0.1 } }))).toBe('custom');
  });
});

describe('normalizeOptOutList (settings list and sidecar)', () => {
  it('keeps well-formed ids in order, drops malformed entries and duplicates one by one', () => {
    expect(normalizeOptOutList(['pounce', 7, 'pounce', 'Bad Id', '', 'x'.repeat(40), 'futureThing', null, { id: 'slips' }, 'slips'])).toEqual(['pounce', 'futureThing', 'slips']);
  });

  it('is the empty list for anything but an array', () => {
    for (const v of [null, undefined, 'pounce', 42, { 0: 'pounce' }]) expect(normalizeOptOutList(v)).toEqual([]);
  });

  it('is bounded at MAX_OPT_OUTS, first ones win', () => {
    const many = Array.from({ length: MAX_OPT_OUTS + 20 }, (_, i) => `extra${i}`);
    const out = normalizeOptOutList(many);
    expect(out).toHaveLength(MAX_OPT_OUTS);
    expect(out[0]).toBe('extra0');
    expect(out[MAX_OPT_OUTS - 1]).toBe(`extra${MAX_OPT_OUTS - 1}`);
  });
});
