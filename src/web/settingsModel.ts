// What the web host's settings sheet may change (1.4.0), as a pure allow-list. Every patch the sheet
// makes goes through applyWebPatch: a leaf outside the allow-list is refused, the patch is then
// applied with the desktop's own validation (applySettingsPatch: every patched leaf must survive
// parsing unchanged) and screen analysis and AI are forced off again (forceWebPrivacy), whatever
// the patch said. The personality is offered only as the named presets (no custom mix on the web).
import { RENDER_STYLES, SKINS, type RenderStyle, type SkinId } from '../shared/cat';
import { applySettingsPatch, type Settings } from '../shared/settings';
import { ACTIVITY_PRESET_IDS, PRESET_BEHAVIOR_KEYS, PRESET_INTERACTION_KEYS, PRESET_VALUES, presetPatch, type ActivityPresetId } from '../shared/settingsPresets';
import { forceWebPrivacy, webSettings } from './storage';

/** The settings leaves the sheet edits directly (the personality goes through presetPatch). */
export const WEB_EDITABLE: Readonly<Record<string, readonly string[]>> = Object.freeze({
  general: Object.freeze(['catName']),
  appearance: Object.freeze(['skin', 'style', 'size', 'shadow', 'emotes']),
  sound: Object.freeze(['enabled', 'volume']),
});

/** Size slider bounds (AppearanceSchema: 0.5 to 2.5) and step. */
export const SIZE_RANGE = Object.freeze({ min: 0.5, max: 2.5, step: 0.05 });
/** Volume slider bounds (SoundSchema: 0 to 1) and step. */
export const VOLUME_RANGE = Object.freeze({ min: 0, max: 1, step: 0.05 });
/** The cat's name: 1 to 24 characters after trimming (GeneralSchema). */
export const CAT_NAME_MAX = 24;

export type WebPatch = Record<string, Record<string, unknown>>;
export type WebPatchResult = { ok: true; settings: Settings } | { ok: false; error: string };

export type WebField =
  | { field: 'catName'; value: string }
  | { field: 'skin'; value: SkinId }
  | { field: 'style'; value: RenderStyle }
  | { field: 'size'; value: number }
  | { field: 'shadow'; value: boolean }
  | { field: 'emotes'; value: boolean }
  | { field: 'soundEnabled'; value: boolean }
  | { field: 'volume'; value: number }
  | { field: 'preset'; value: ActivityPresetId };

/** Rounds a slider value to its step (so 1.2000000000000002 never reaches the schema). */
export function snap(value: number, range: { min: number; max: number; step: number }): number {
  if (!Number.isFinite(value)) return range.min;
  const clamped = Math.min(range.max, Math.max(range.min, value));
  const steps = Math.round((clamped - range.min) / range.step);
  return Math.round((range.min + steps * range.step) * 1000) / 1000;
}

/** The settings patch for one sheet control, or null when the value is not acceptable for that control. */
export function patchFor(change: WebField): WebPatch | null {
  switch (change.field) {
    case 'catName': {
      if (typeof change.value !== 'string') return null;
      const name = change.value.trim();
      if (name.length < 1 || name.length > CAT_NAME_MAX) return null;
      return { general: { catName: name } };
    }
    case 'skin':
      return (SKINS as readonly string[]).includes(change.value) ? { appearance: { skin: change.value } } : null;
    case 'style':
      return (RENDER_STYLES as readonly string[]).includes(change.value) ? { appearance: { style: change.value } } : null;
    case 'size':
      return typeof change.value === 'number' && Number.isFinite(change.value) ? { appearance: { size: snap(change.value, SIZE_RANGE) } } : null;
    case 'shadow':
    case 'emotes':
      return typeof change.value === 'boolean' ? { appearance: { [change.field]: change.value } } : null;
    case 'soundEnabled':
      return typeof change.value === 'boolean' ? { sound: { enabled: change.value } } : null;
    case 'volume':
      return typeof change.value === 'number' && Number.isFinite(change.value) ? { sound: { volume: snap(change.value, VOLUME_RANGE) } } : null;
    case 'preset':
      return (ACTIVITY_PRESET_IDS as readonly string[]).includes(change.value) ? presetPatch(change.value) : null;
    default:
      return null;
  }
}

const isObject = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v);

/** A behavior/interaction patch is acceptable only as exactly one named preset's patch. */
function isPresetPatch(patch: Record<string, unknown>): boolean {
  const b = patch['behavior'];
  const i = patch['interaction'];
  if (!isObject(b) || !isObject(i)) return false;
  const id = b['activityPreset'];
  if (typeof id !== 'string' || !(ACTIVITY_PRESET_IDS as readonly string[]).includes(id)) return false;
  const v = PRESET_VALUES[id as ActivityPresetId];
  const bKeys = Object.keys(b).sort();
  const iKeys = Object.keys(i).sort();
  if (JSON.stringify(bKeys) !== JSON.stringify([...PRESET_BEHAVIOR_KEYS, 'activityPreset'].sort())) return false;
  if (JSON.stringify(iKeys) !== JSON.stringify([...PRESET_INTERACTION_KEYS].sort())) return false;
  return PRESET_BEHAVIOR_KEYS.every((k) => b[k] === v.behavior[k]) && PRESET_INTERACTION_KEYS.every((k) => i[k] === v.interaction[k]);
}

/** The reason `patch` is outside the web allow-list, or null when every leaf is allowed. */
export function rejectNonWebPatch(patch: unknown): string | null {
  if (!isObject(patch)) return 'patch must be an object';
  const sections = Object.keys(patch);
  if (sections.length === 0) return 'empty patch';
  const hasPreset = 'behavior' in patch || 'interaction' in patch;
  if (hasPreset && !isPresetPatch(patch)) return 'the personality can only be one of the named presets';
  for (const section of sections) {
    if (section === 'behavior' || section === 'interaction') continue;
    const allowed = WEB_EDITABLE[section];
    const values = patch[section];
    if (!allowed) return `${section} cannot be changed on the web`;
    if (!isObject(values)) return `section ${section} must be an object`;
    for (const key of Object.keys(values)) if (!allowed.includes(key)) return `${section}.${key} cannot be changed on the web`;
  }
  return null;
}

/** Applies a sheet patch: allow-list, the desktop's validation, then screen analysis and AI forced off. Never mutates `settings`. */
export function applyWebPatch(settings: Settings, patch: unknown): WebPatchResult {
  const refused = rejectNonWebPatch(patch);
  if (refused) return { ok: false, error: refused };
  let r: ReturnType<typeof applySettingsPatch>;
  try {
    r = applySettingsPatch(settings, patch);
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
  if (!r.ok) return r;
  return { ok: true, settings: forceWebPrivacy(r.settings) };
}

/** "Reset settings": the web defaults (the cat itself is kept; only the settings start over). */
export function resetWebSettings(): Settings {
  return webSettings(null);
}

/** The personality the sheet shows as selected (a custom mix cannot be chosen on the web; it shows as none). */
export function selectedPreset(s: Settings): ActivityPresetId | null {
  const p = s.behavior.activityPreset;
  return p === 'custom' ? null : p;
}
