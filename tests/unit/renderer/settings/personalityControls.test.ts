// v1.2 settings UI (ADR 0003 §9.1, §10): every new settings field has a control, every slider's
// help text says what 0 does, the opt-out toggles edit the tolerant list the way main accepts,
// and the renderer's mirrored id lists match the shared ones (the renderer stays zod-free).
import { describe, expect, it } from 'vitest';
import { applySettingsPatch, defaultSettings, IMPLIED_OPT_OUTS, LIVELY_BEHAVIORS, type LivelyBehavior, type ToggleableBehavior } from '../../../../src/shared/settings';
import { BEHAVIOR_IDS, LIVELY_IDS, LIVELY_PARENT } from '../../../../src/renderer/settings/catalog';
import { NUMERIC_FIELDS } from '../../../../src/renderer/settings/fields';
import { SOUND_FIELD_IDS } from '../../../../src/renderer/settings/pages/audio';
import { extraParentOff, FINE_TUNE_SLIDERS, PERSONALITY_FIELD_IDS, PERSONALITY_SLIDERS } from '../../../../src/renderer/settings/pages/behavior';
import { presetLeaves, setExtraEnabled } from '../../../../src/renderer/settings/patch';
import { PRESET_CHOICES } from '../../../../src/renderer/settings/presetView';
import { S } from '../../../../src/renderer/settings/strings';
import { defaultSettings as defaultSettingsV111 } from '../../../fixtures/v1.1.1/settings';

/** Every settings leaf that schema v3 added (anything the frozen 1.1.1 schema does not have). */
function v3OnlyLeaves(): string[] {
  const v2 = new Set<string>();
  for (const [section, values] of Object.entries(defaultSettingsV111())) {
    if (values !== null && typeof values === 'object') for (const key of Object.keys(values)) v2.add(`${section}.${key}`);
  }
  const out: string[] = [];
  for (const [section, values] of Object.entries(defaultSettings())) {
    if (values === null || typeof values !== 'object') continue;
    // The Living Companion leaves (the companion section, sound.cat, sound.world) are not schema v3 additions: they have their own controls.
    if (section === 'companion') continue;
    for (const key of Object.keys(values)) if (!v2.has(`${section}.${key}`) && !(section === 'sound' && (key === 'cat' || key === 'world'))) out.push(`${section}.${key}`);
  }
  return out;
}

describe('v1.2 settings controls', () => {
  it('every field schema v3 added has a control', () => {
    const added = v3OnlyLeaves();
    expect(added.sort()).toEqual(
      [
        'behavior.activityPreset',
        'behavior.disabledExtras',
        'behavior.exploration',
        'behavior.heights',
        'behavior.mischief',
        'behavior.stayLength',
        'behavior.workDisruption',
        'interaction.reactionIntensity',
        'sound.enabled',
        'sound.volume',
      ].sort(),
    );
    const covered = new Set<string>([...PERSONALITY_FIELD_IDS, ...SOUND_FIELD_IDS]);
    expect(added.filter((id) => !covered.has(id))).toEqual([]);
    // Activity and Cursor hunting (the v2 autonomy and cursorPlay) are the up-front sliders.
    expect(PERSONALITY_SLIDERS.map((s) => s.id)).toEqual(['behavior.autonomy', 'behavior.cursorPlay', 'behavior.workDisruption']);
    expect(FINE_TUNE_SLIDERS.map((s) => s.id)).toEqual(['behavior.exploration', 'behavior.heights', 'behavior.mischief', 'behavior.stayLength', 'interaction.reactionIntensity']);
  });

  it('every slider of the Personality group, and the volume, says what 0 does', () => {
    for (const s of [...PERSONALITY_SLIDERS, ...FINE_TUNE_SLIDERS]) expect(s.desc, s.id).toMatch(/(^|\. )0: \S/);
    expect(S.appearance.volumeDesc).toMatch(/0: silent/);
    // The ADR's wording for the three up-front sliders and Mischief.
    expect(S.behavior.activityDesc).toMatch(/0: mostly rests and watches/);
    expect(S.behavior.huntingDesc).toMatch(/0: it only watches the pointer/);
    expect(S.behavior.workDesc).toMatch(/never while you type or click/);
    expect(S.behavior.mischiefDesc).toMatch(/0: never cheeky/);
    // The v2 0..1 sliders on the same pages say it too.
    for (const d of [S.behavior.attentionDesc, S.behavior.sensitivityDesc, S.interaction.patienceDesc]) expect(d).toMatch(/0: \S/);
  });

  it('labels follow the ADR: Activity, Cursor hunting, Play near my work; presets Calm, Playful, Mischievous and Custom (closest)', () => {
    expect(PERSONALITY_SLIDERS.map((s) => s.title)).toEqual(['Activity', 'Cursor hunting', 'Play near my work']);
    expect(PRESET_CHOICES).toEqual(['calm', 'playful', 'mischievous', 'custom']);
    expect([S.behavior.presets.calm.title, S.behavior.presets.playful.title, S.behavior.presets.mischievous.title]).toEqual(['Calm', 'Playful', 'Mischievous']);
    expect(S.behavior.customTitleClosest('Playful')).toBe('Custom (closest: Playful)');
  });

  it('every slider range accepts the presets’ values, and a preset patch from the renderer is accepted by main', () => {
    for (const id of ['calm', 'playful', 'mischievous'] as const) {
      const leaves = presetLeaves(id);
      const patch: Record<string, Record<string, unknown>> = {};
      for (const l of leaves) (patch[l.section] ??= {})[l.key] = l.value;
      const r = applySettingsPatch(defaultSettings(), patch);
      expect(r.ok, id).toBe(true);
      for (const l of leaves) {
        if (l.key === 'activityPreset') continue;
        const f = Object.values(NUMERIC_FIELDS).find((x) => x.section === l.section && x.key === l.key);
        expect(f, `${l.section}.${l.key}`).toBeDefined();
        expect(l.value as number).toBeGreaterThanOrEqual(f!.min);
        expect(l.value as number).toBeLessThanOrEqual(f!.max);
      }
    }
  });
});

describe('v1.2 opt-out toggles', () => {
  it('the catalog mirrors LIVELY_BEHAVIORS and IMPLIED_OPT_OUTS exactly', () => {
    expect([...LIVELY_IDS]).toEqual([...LIVELY_BEHAVIORS]);
    const implied: Array<[LivelyBehavior, ToggleableBehavior]> = [];
    for (const [parent, kids] of Object.entries(IMPLIED_OPT_OUTS) as Array<[ToggleableBehavior, readonly LivelyBehavior[]]>) for (const k of kids) implied.push([k, parent]);
    expect(Object.entries(LIVELY_PARENT).sort()).toEqual(implied.sort());
    for (const id of LIVELY_IDS) expect(S.behavior.extras[id].title.length).toBeGreaterThan(0);
  });

  it('switching one off or on keeps catalog order, keeps ids of newer versions, and main accepts the list', () => {
    let list: string[] = ['futureThing'];
    list = setExtraEnabled(list, 'slips', false);
    list = setExtraEnabled(list, 'pounce', false);
    expect(list).toEqual(['pounce', 'slips', 'futureThing']);
    expect(setExtraEnabled(list, 'pounce', false)).toEqual(list);
    const r = applySettingsPatch(defaultSettings(), { behavior: { disabledExtras: list } });
    expect(r.ok).toBe(true);
    list = setExtraEnabled(list, 'slips', true);
    expect(list).toEqual(['pounce', 'futureThing']);
    expect(setExtraEnabled(['futureThing', 'futureThing'], 'hissing', false)).toEqual(['hissing', 'futureThing']);
  });

  it('a v1.2 toggle is shown off while the v2 switch it lives under is off', () => {
    expect(extraParentOff('pounce', ['chaseCursor'])).toBe('chaseCursor');
    expect(extraParentOff('terminalTabs', ['zoomies', 'tabStrips'])).toBe('tabStrips');
    expect(extraParentOff('pounce', ['tabStrips'])).toBeNull();
    // Hissing, tail chase and slips live under no single v2 switch.
    for (const id of ['hissing', 'tailChase', 'slips'] as const) expect(extraParentOff(id, [...BEHAVIOR_IDS])).toBeNull();
    expect(S.behavior.extraNeeds(S.behavior.behaviors.chaseCursor.title)).toBe('Turn on “Chase the pointer” first.');
  });
});
