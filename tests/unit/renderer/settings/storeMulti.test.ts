// v1.2 multi-key path of the settings window's store (ADR 0003 §9.2): a preset is one patch with
// eight values, a governed slider sends activityPreset 'custom' with its value, and every leaf of
// such a change is protected from broadcasts while it is pending or in flight. zod-free on the
// renderer side; main (applySettingsPatch) decides the stored preset.
import { describe, expect, it } from 'vitest';
import type { SettingsViewState } from '../../../../src/shared/ipc';
import { applySettingsPatch, type PatchResult, type SettingsPatch } from '../../../../src/shared/settings';
import { PRESET_VALUES } from '../../../../src/shared/settingsPresets';
import { SLIDER_DEBOUNCE_MS } from '../../../../src/renderer/settings/controls';
import type { FieldId } from '../../../../src/renderer/settings/fields';
import { buildMultiPatch, companionsFor, CUSTOM_PRESET_LEAF, presetLeaves } from '../../../../src/renderer/settings/patch';
import { intendedPresetValues, presetSelection } from '../../../../src/renderer/settings/presetView';
import { SettingsStore, type FieldBinding, type Timers } from '../../../../src/renderer/settings/store';
import { S } from '../../../../src/renderer/settings/strings';
import { previewView } from './preview/fixture';

function fakeTimers(): Timers & { advance(ms: number): void; pending(): number } {
  let now = 0;
  let next = 1;
  const queue = new Map<number, { at: number; fn: () => void }>();
  return {
    setTimeout(fn, ms) {
      const id = next++;
      queue.set(id, { at: now + ms, fn });
      return id;
    },
    clearTimeout(id) {
      queue.delete(id);
    },
    advance(ms) {
      now += ms;
      for (const [id, t] of [...queue].sort((a, b) => a[1].at - b[1].at)) {
        if (t.at <= now) {
          queue.delete(id);
          t.fn();
        }
      }
    },
    pending: () => queue.size,
  };
}

interface Deferred {
  patch: SettingsPatch;
  resolve(r: PatchResult): void;
}

function fakeApi() {
  const calls: Deferred[] = [];
  return {
    calls,
    update(patch: SettingsPatch): Promise<PatchResult> {
      return new Promise<PatchResult>((resolve) => calls.push({ patch, resolve }));
    },
  };
}

function fakeBinding(field: FieldId) {
  const b = {
    field,
    busy: false,
    synced: [] as unknown[],
    errors: [] as Array<string | null>,
    isBusy: () => b.busy,
    sync: (v: unknown) => void b.synced.push(v),
    showError: (m: string | null) => void b.errors.push(m),
  };
  return b satisfies FieldBinding & { busy: boolean };
}

const view = (): SettingsViewState => previewView(0, { electron: 'e', chrome: 'c', node: 'n' });

/** Answers a recorded call the way main does. */
function answer(store: SettingsStore, call: Deferred): void {
  call.resolve(applySettingsPatch(store.settings, call.patch));
}

describe('SettingsStore multi-key changes', () => {
  it('a preset is one multi-section patch main accepts, and every slider follows the result', async () => {
    const api = fakeApi();
    const store = new SettingsStore(api, view(), fakeTimers());
    const autonomy = fakeBinding('behavior.autonomy');
    const reactions = fakeBinding('interaction.reactionIntensity');
    store.bind(autonomy);
    store.bind(reactions);
    store.setMany(presetLeaves('calm'));
    expect(api.calls).toHaveLength(1);
    expect(api.calls[0]!.patch).toEqual({ behavior: { ...PRESET_VALUES.calm.behavior, activityPreset: 'calm' }, interaction: { ...PRESET_VALUES.calm.interaction } });
    answer(store, api.calls[0]!);
    await store.settled();
    expect(store.settings.behavior.activityPreset).toBe('calm');
    expect(autonomy.synced.at(-1)).toBe(0.35);
    expect(reactions.synced.at(-1)).toBe(0.35);
  });

  it('clicking the preset already in place sends nothing', () => {
    const api = fakeApi();
    const store = new SettingsStore(api, view(), fakeTimers());
    store.setMany(presetLeaves('playful'));
    expect(api.calls).toHaveLength(0);
  });

  it('a governed slider sends its value with activityPreset custom in one debounced patch; main names the result', async () => {
    const api = fakeApi();
    const timers = fakeTimers();
    const store = new SettingsStore(api, view(), timers);
    const with_ = companionsFor('behavior', 'autonomy');
    expect(with_).toEqual([CUSTOM_PRESET_LEAF]);
    store.set('behavior', 'autonomy', 0.7, { debounceMs: SLIDER_DEBOUNCE_MS, with: with_ });
    store.set('behavior', 'autonomy', 0.75, { debounceMs: SLIDER_DEBOUNCE_MS, with: with_ });
    expect(store.intended('behavior', 'activityPreset')).toBe('custom');
    timers.advance(SLIDER_DEBOUNCE_MS);
    expect(api.calls.map((c) => c.patch)).toEqual([{ behavior: { autonomy: 0.75, activityPreset: 'custom' } }]);
    answer(store, api.calls[0]!);
    await store.settled();
    expect(store.settings.behavior.activityPreset).toBe('custom');
    // Back onto Playful's value: the patch still says custom, main selects Playful.
    store.set('behavior', 'autonomy', 0.6, { with: with_ });
    answer(store, api.calls[1]!);
    await store.settled();
    expect(store.settings.behavior.activityPreset).toBe('playful');
  });

  it('a slider left where it was sends nothing, even with leaves riding along', () => {
    const api = fakeApi();
    const timers = fakeTimers();
    const store = new SettingsStore(api, view(), timers);
    store.set('behavior', 'autonomy', 0.6, { debounceMs: SLIDER_DEBOUNCE_MS, with: [CUSTOM_PRESET_LEAF] });
    timers.advance(SLIDER_DEBOUNCE_MS);
    expect(api.calls).toHaveLength(0);
  });

  it('only governed values carry the custom leaf', () => {
    expect(companionsFor('behavior', 'mischief')).toEqual([CUSTOM_PRESET_LEAF]);
    expect(companionsFor('interaction', 'reactionIntensity')).toEqual([CUSTOM_PRESET_LEAF]);
    expect(companionsFor('behavior', 'attentionSeeking')).toEqual([]);
    expect(companionsFor('interaction', 'patience')).toEqual([]);
    expect(companionsFor('sound', 'volume')).toEqual([]);
  });

  it('a preset drops a slider move still waiting for its debounce, so the move cannot land after it', async () => {
    const api = fakeApi();
    const timers = fakeTimers();
    const store = new SettingsStore(api, view(), timers);
    store.set('behavior', 'mischief', 0.9, { debounceMs: SLIDER_DEBOUNCE_MS, with: [CUSTOM_PRESET_LEAF] });
    store.setMany(presetLeaves('mischievous'));
    timers.advance(SLIDER_DEBOUNCE_MS * 4);
    expect(api.calls).toHaveLength(1);
    expect(timers.pending()).toBe(0);
    answer(store, api.calls[0]!);
    await store.settled();
    expect(store.settings.behavior.mischief).toBe(0.75);
    expect(store.settings.behavior.activityPreset).toBe('mischievous');
  });

  it('a broadcast never clobbers any leaf of a change in flight; all follow the result', async () => {
    const api = fakeApi();
    const store = new SettingsStore(api, view(), fakeTimers());
    const heights = fakeBinding('behavior.heights');
    const preset = fakeBinding('behavior.activityPreset');
    store.bind(heights);
    store.bind(preset);
    store.setMany(presetLeaves('calm'));
    expect(store.isSettling('behavior.heights')).toBe(true);
    expect(store.isSettling('interaction.reactionIntensity')).toBe(true);
    const before = heights.synced.length;
    store.receive(view());
    expect(heights.synced.length).toBe(before);
    expect(preset.synced.length).toBe(1);
    answer(store, api.calls[0]!);
    await store.settled();
    expect(heights.synced.at(-1)).toBe(0.3);
    expect(preset.synced.at(-1)).toBe('calm');
    expect(store.isSettling('behavior.heights')).toBe(false);
  });

  it('a rejected multi-key patch reverts every leaf and reports on the origin', async () => {
    const api = fakeApi();
    const store = new SettingsStore(api, view(), fakeTimers());
    const origin = fakeBinding('behavior.activityPreset');
    const autonomy = fakeBinding('behavior.autonomy');
    store.bind(origin);
    store.bind(autonomy);
    store.setMany(presetLeaves('mischievous'), { origin });
    expect(store.intended('behavior', 'autonomy')).toBe(0.8);
    api.calls[0]!.resolve({ ok: false, error: 'invalid value for behavior.activityPreset' });
    await store.settled();
    expect(store.settings.behavior.autonomy).toBe(0.6);
    expect(autonomy.synced.at(-1)).toBe(0.6);
    expect(origin.errors.at(-1)).toBe(S.errors.saveFailed('invalid value for behavior.activityPreset'));
  });

  it('buildMultiPatch groups leaves by section; later leaves win', () => {
    expect(
      buildMultiPatch([
        { section: 'behavior', key: 'autonomy', value: 0.2 },
        { section: 'interaction', key: 'reactionIntensity', value: 0.4 },
        { section: 'behavior', key: 'autonomy', value: 0.3 },
      ]),
    ).toEqual({ behavior: { autonomy: 0.3 }, interaction: { reactionIntensity: 0.4 } });
  });
});

describe('Personality selector model', () => {
  it('follows the intended values at once (before main answers) and names the closest preset while custom', () => {
    const api = fakeApi();
    const timers = fakeTimers();
    const store = new SettingsStore(api, view(), timers);
    expect(presetSelection(intendedPresetValues(store))).toEqual({ choice: 'playful', closest: 'playful', customTitle: 'Custom' });
    store.set('behavior', 'autonomy', 0.3, { debounceMs: SLIDER_DEBOUNCE_MS, with: [CUSTOM_PRESET_LEAF] });
    const sel = presetSelection(intendedPresetValues(store));
    expect(sel.choice).toBe('custom');
    expect(sel.closest).toBe('playful');
    expect(sel.customTitle).toBe('Custom (closest: Playful)');
    store.setMany(presetLeaves('calm'));
    expect(presetSelection(intendedPresetValues(store)).choice).toBe('calm');
  });

  it('the user’s 1.1.1 values (autonomy 0.8, cursor play 0.7) read as Custom, closest Playful', () => {
    const v = view();
    v.settings.behavior.autonomy = 0.8;
    v.settings.behavior.cursorPlay = 0.7;
    const store = new SettingsStore(fakeApi(), v, fakeTimers());
    expect(presetSelection(intendedPresetValues(store)).customTitle).toBe(S.behavior.customTitleClosest(S.behavior.presets.playful.title));
  });
});
