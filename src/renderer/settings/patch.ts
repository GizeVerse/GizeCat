// Pure helpers for building the minimal patches sent to main.
import type { Settings, SettingsPatch, ToggleableBehavior } from '../../shared/settings';
import { isPresetGoverned, presetPatch, type ActivityPresetId } from '../../shared/settingsPresets';
import { BEHAVIOR_IDS, LIVELY_IDS } from './catalog';
import type { FieldId, FieldKey, SectionKey } from './fields';

export function fieldId<S extends SectionKey>(section: S, key: FieldKey<S>): FieldId {
  return `${section}.${key}` as FieldId;
}

/** One setting leaf of a (possibly multi-key) patch. */
export interface Leaf {
  readonly section: SectionKey;
  readonly key: string;
  readonly value: unknown;
}

export function leafId(leaf: Leaf): FieldId {
  return `${leaf.section}.${leaf.key}` as FieldId;
}

/** A patch that touches exactly one leaf. */
export function buildPatch<S extends SectionKey, K extends FieldKey<S>>(section: S, key: K, value: Settings[S][K]): SettingsPatch {
  const values: Partial<Settings[S]> = {};
  values[key] = value;
  const patch: SettingsPatch = {};
  (patch as Record<SectionKey, unknown>)[section] = values;
  return patch;
}

/** One patch holding every leaf (several sections allowed; main applies it atomically). Later leaves win. */
export function buildMultiPatch(leaves: readonly Leaf[]): SettingsPatch {
  const patch: Record<string, Record<string, unknown>> = {};
  for (const l of leaves) (patch[l.section] ??= {})[l.key] = l.value;
  return patch;
}

/** v1.2: the leaves of a preset (its values plus activityPreset), for the store's multi-key path. */
export function presetLeaves(id: ActivityPresetId): Leaf[] {
  const p = presetPatch(id);
  return [
    ...Object.entries(p.behavior).map(([key, value]) => ({ section: 'behavior' as const, key, value })),
    ...Object.entries(p.interaction).map(([key, value]) => ({ section: 'interaction' as const, key, value })),
  ];
}

/** The leaf that rides along with a change of a preset-governed value (main re-derives the real name). */
export const CUSTOM_PRESET_LEAF: Leaf = { section: 'behavior', key: 'activityPreset', value: 'custom' };

/** Leaves to send with a change of `section.key`: activityPreset 'custom' for a governed value, else none. */
export function companionsFor(section: SectionKey, key: string): Leaf[] {
  return isPresetGoverned(section, key) ? [CUSTOM_PRESET_LEAF] : [];
}

export function readField<S extends SectionKey, K extends FieldKey<S>>(settings: Settings, section: S, key: K): Settings[S][K] {
  return settings[section][key];
}

/** Structural equality for setting leaves (primitives and arrays of primitives). */
export function valuesEqual(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) return true;
  if (Array.isArray(a) && Array.isArray(b)) return a.length === b.length && a.every((v, i) => Object.is(v, b[i]));
  return false;
}

/** Returns the disabled-behaviour list with one behaviour switched, in canonical order, without duplicates. */
export function setBehaviorEnabled(
  disabled: readonly ToggleableBehavior[],
  behavior: ToggleableBehavior,
  enabled: boolean,
): ToggleableBehavior[] {
  const set = new Set(disabled);
  if (enabled) set.delete(behavior);
  else set.add(behavior);
  return BEHAVIOR_IDS.filter((b) => set.has(b));
}

/**
 * The v1.2 opt-out list (behavior.disabledExtras) with one behaviour switched: known ids in
 * catalog order, then ids of newer versions this one does not know, kept as they were.
 */
export function setExtraEnabled(disabled: readonly string[], behavior: (typeof LIVELY_IDS)[number], enabled: boolean): string[] {
  const set = new Set(disabled);
  if (enabled) set.delete(behavior);
  else set.add(behavior);
  const known: ReadonlySet<string> = new Set(LIVELY_IDS);
  return [...LIVELY_IDS.filter((b) => set.has(b)), ...disabled.filter((id, i) => !known.has(id) && disabled.indexOf(id) === i)];
}

export function addEntry(list: readonly string[], entry: string): string[] {
  return list.includes(entry) ? [...list] : [...list, entry];
}

export function removeEntry(list: readonly string[], entry: string): string[] {
  return list.filter((e) => e !== entry);
}
