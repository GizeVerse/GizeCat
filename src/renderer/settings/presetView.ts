// DOM-free model of the v1.2 Personality selector (ADR 0003 §9.1-9.2): which card is selected and
// what the Custom card says. Computed from the values the user asked for (pending or in flight),
// so the selection follows a slider at once; main stores the same choice after every patch.
import { ACTIVITY_PRESET_IDS, closestPreset, presetChoiceFor, PRESET_BEHAVIOR_KEYS, PRESET_INTERACTION_KEYS, type ActivityPresetChoice, type ActivityPresetId, type PresetReadable } from '../../shared/settingsPresets';
import type { SettingsStore } from './store';
import { S } from './strings';

const B = S.behavior;

/** The selector's cards, in display order; 'custom' is shown but cannot be picked (it is what moving a slider makes). */
export const PRESET_CHOICES = [...ACTIVITY_PRESET_IDS, 'custom'] as const satisfies readonly ActivityPresetChoice[];

export interface PresetSelection {
  choice: ActivityPresetChoice;
  /** The named preset nearest the values (equals `choice` unless custom). */
  closest: ActivityPresetId;
  /** Title of the Custom card: "Custom (closest: Playful)" while custom, else "Custom". */
  customTitle: string;
}

export function presetSelection(values: PresetReadable): PresetSelection {
  const choice = presetChoiceFor(values);
  const closest = choice === 'custom' ? closestPreset(values) : choice;
  return { choice, closest, customTitle: choice === 'custom' ? B.customTitleClosest(B.presets[closest].title) : B.customTitle };
}

/** The governed values as the user intends them right now (pending and in-flight changes included). */
export function intendedPresetValues(store: Pick<SettingsStore, 'intended'>): PresetReadable {
  const behavior = {} as PresetReadable['behavior'];
  for (const k of PRESET_BEHAVIOR_KEYS) behavior[k] = store.intended('behavior', k);
  const interaction = {} as PresetReadable['interaction'];
  for (const k of PRESET_INTERACTION_KEYS) interaction[k] = store.intended('interaction', k);
  return { behavior, interaction };
}
