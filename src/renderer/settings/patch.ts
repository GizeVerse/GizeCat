// Pure helpers for building the minimal patches sent to main.
import type { Settings, SettingsPatch, ToggleableBehavior } from '../../shared/settings';
import { BEHAVIOR_IDS } from './catalog';
import type { FieldId, FieldKey, SectionKey } from './fields';

export function fieldId<S extends SectionKey>(section: S, key: FieldKey<S>): FieldId {
  return `${section}.${key}` as FieldId;
}

/** A patch that touches exactly one leaf. */
export function buildPatch<S extends SectionKey, K extends FieldKey<S>>(section: S, key: K, value: Settings[S][K]): SettingsPatch {
  const values: Partial<Settings[S]> = {};
  values[key] = value;
  const patch: SettingsPatch = {};
  (patch as Record<SectionKey, unknown>)[section] = values;
  return patch;
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

export function addEntry(list: readonly string[], entry: string): string[] {
  return list.includes(entry) ? [...list] : [...list, entry];
}

export function removeEntry(list: readonly string[], entry: string): string[] {
  return list.filter((e) => e !== entry);
}
