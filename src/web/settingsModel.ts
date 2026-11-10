// What the web host's settings sheet may change (1.4.0), as a pure allow-list. Every patch the sheet
// makes goes through applyWebPatch: a leaf outside the allow-list is refused, the patch is then
// applied with the desktop's own validation (applySettingsPatch: every patched leaf must survive
// parsing unchanged) and screen analysis and AI are forced off again (forceWebPrivacy), whatever
// the patch said. The personality is offered only as the named presets (no custom mix on the web).
import { RENDER_STYLES, SKINS, type RenderStyle, type SkinId } from '../shared/cat';
import { ALL_EVENT_IDS, EVENT_PACE_RANGE, PERSONALITY_IDS, type AnyEventId, type PersonalityChoice } from '../shared/companion';
import { applySettingsPatch, IMPLIED_OPT_OUTS, LIVELY_BEHAVIORS, TOGGLEABLE_BEHAVIORS, type BehaviorId, type Settings } from '../shared/settings';
import { ACTIVITY_PRESET_IDS, PRESET_BEHAVIOR_KEYS, PRESET_INTERACTION_KEYS, PRESET_VALUES, presetPatch, type ActivityPresetId } from '../shared/settingsPresets';
import { forceWebPrivacy, webSettings } from './storage';

/** The settings leaves the sheet edits directly (the personality goes through presetPatch). */
export const WEB_EDITABLE: Readonly<Record<string, readonly string[]>> = Object.freeze({
  general: Object.freeze(['catName']),
  appearance: Object.freeze(['skin', 'style', 'size', 'shadow', 'emotes']),
  sound: Object.freeze(['enabled', 'volume', 'cat', 'world']),
  /** Living Companion: personality, world events, calmer motion and the journal switch. */
  companion: Object.freeze(['personality', 'events', 'reducedMotion', 'journal']),
});

/**
 * The behaviour and interaction leaves the Android panel (androidPanel.ts) edits one by one, besides
 * the named personalities: how fast and how lively the cat is, when it falls asleep, how much it
 * plays with a pointer, which behaviours are switched off, and which handling it accepts. Each is a
 * carried setting (profileTransfer.ts), so it is stored and survives a reload; `interaction.enabled`
 * is a per-device accessibility choice and is not offered.
 */
export const WEB_TUNING = Object.freeze({
  behavior: Object.freeze(['movementSpeed', 'autonomy', 'cursorPlay', 'sleepAfterIdleMinutes', 'disabledBehaviors', 'disabledExtras']),
  interaction: Object.freeze(['petting', 'dragging', 'throwing']),
});

/** Movement speed (BehaviorSchema: 0.5 to 2), the 0..1 levels (autonomy, cursor play) and the idle sleep (1 to 120 minutes). */
export const MOVEMENT_RANGE = Object.freeze({ min: 0.5, max: 2, step: 0.05 });
export const LEVEL_RANGE = Object.freeze({ min: 0, max: 1, step: 0.05 });
export const SLEEP_RANGE = Object.freeze({ min: 1, max: 120, step: 1 });
/** How often world events come (CompanionSchema: 0.5 to 2, shared EVENT_PACE_RANGE). */
export const PACE_RANGE = Object.freeze({ min: EVENT_PACE_RANGE.min, max: EVENT_PACE_RANGE.max, step: 0.25 });

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
  /** Living Companion sound categories (only matter while sound is on). */
  | { field: 'soundCat' | 'soundWorld'; value: boolean }
  | { field: 'personality'; value: PersonalityChoice }
  | { field: 'eventsEnabled' | 'rareEvents' | 'reducedMotion' | 'journalEnabled'; value: boolean }
  | { field: 'eventPace'; value: number }
  /** One event on or off, given the current settings (the list is replaced whole, in catalogue order). */
  | { field: 'eventToggle'; id: AnyEventId; enabled: boolean; current: Settings }
  | { field: 'preset'; value: ActivityPresetId }
  | { field: 'movementSpeed'; value: number }
  | { field: 'autonomy'; value: number }
  | { field: 'cursorPlay'; value: number }
  | { field: 'sleepMinutes'; value: number }
  | { field: 'petting' | 'dragging' | 'throwing'; value: boolean }
  /** One behaviour on or off, given the current settings (the opt-out lists are replaced whole). */
  | { field: 'behaviorToggle'; id: BehaviorId; enabled: boolean; current: Settings };

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
    case 'soundCat':
    case 'soundWorld':
      return typeof change.value === 'boolean' ? { sound: { [change.field === 'soundCat' ? 'cat' : 'world']: change.value } } : null;
    case 'personality':
      return change.value === 'auto' || (PERSONALITY_IDS as readonly string[]).includes(change.value) ? { companion: { personality: change.value } } : null;
    case 'eventsEnabled':
      return typeof change.value === 'boolean' ? { companion: { events: { enabled: change.value } } } : null;
    case 'rareEvents':
      return typeof change.value === 'boolean' ? { companion: { events: { rare: change.value } } } : null;
    case 'reducedMotion':
      return typeof change.value === 'boolean' ? { companion: { reducedMotion: change.value } } : null;
    case 'journalEnabled':
      return typeof change.value === 'boolean' ? { companion: { journal: { enabled: change.value } } } : null;
    case 'eventPace':
      return typeof change.value === 'number' && Number.isFinite(change.value) ? { companion: { events: { pace: snap(change.value, PACE_RANGE) } } } : null;
    case 'eventToggle':
      return eventTogglePatch(change.id, change.enabled, change.current);
    case 'preset':
      return (ACTIVITY_PRESET_IDS as readonly string[]).includes(change.value) ? presetPatch(change.value) : null;
    case 'movementSpeed':
      return typeof change.value === 'number' && Number.isFinite(change.value) ? { behavior: { movementSpeed: snap(change.value, MOVEMENT_RANGE) } } : null;
    case 'autonomy':
    case 'cursorPlay':
      return typeof change.value === 'number' && Number.isFinite(change.value) ? { behavior: { [change.field]: snap(change.value, LEVEL_RANGE) } } : null;
    case 'sleepMinutes':
      return typeof change.value === 'number' && Number.isFinite(change.value) ? { behavior: { sleepAfterIdleMinutes: Math.round(snap(change.value, SLEEP_RANGE)) } } : null;
    case 'petting':
    case 'dragging':
    case 'throwing':
      return typeof change.value === 'boolean' ? { interaction: { [change.field]: change.value } } : null;
    case 'behaviorToggle':
      return behaviorTogglePatch(change.id, change.enabled, change.current);
    default:
      return null;
  }
}

/** The patch that switches one world event on or off: the disabled list is sent whole, in catalogue order. */
function eventTogglePatch(id: AnyEventId, enabled: boolean, current: Settings): WebPatch | null {
  if (typeof enabled !== 'boolean' || !(ALL_EVENT_IDS as readonly string[]).includes(id)) return null;
  const off = new Set<AnyEventId>(current.companion.events.disabled);
  if (enabled) off.delete(id);
  else off.add(id);
  return { companion: { events: { disabled: ALL_EVENT_IDS.filter((e) => off.has(e)) } } };
}

const TOGGLEABLE_IDS: readonly string[] = TOGGLEABLE_BEHAVIORS;
const LIVELY_IDS: readonly string[] = LIVELY_BEHAVIORS;

/**
 * The patch that switches one behaviour on or off by replacing the two opt-out lists (a list is
 * always sent whole, never edited in place). A behaviour implied off by another (climbing windows
 * implies no screen edges, IMPLIED_OPT_OUTS) is switched back on together with its parent, so a
 * toggle always does what its label says.
 */
function behaviorTogglePatch(id: BehaviorId, enabled: boolean, current: Settings): WebPatch | null {
  if (typeof enabled !== 'boolean') return null;
  const toggleable = new Set<string>(current.behavior.disabledBehaviors);
  const lively = new Set<string>(current.behavior.disabledExtras);
  const apply = (name: string): boolean => {
    const set = TOGGLEABLE_IDS.includes(name) ? toggleable : LIVELY_IDS.includes(name) ? lively : null;
    if (!set) return false;
    if (enabled) set.delete(name);
    else set.add(name);
    return true;
  };
  if (!apply(id)) return null;
  if (enabled) {
    // A child behaviour cannot run under a parent that is off: turning it on turns its parent on.
    for (const [parent, children] of Object.entries(IMPLIED_OPT_OUTS)) {
      if ((children as readonly string[]).includes(id)) apply(parent);
    }
  }
  return { behavior: { disabledBehaviors: [...toggleable], disabledExtras: [...lively] } };
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

/** A behaviour/interaction patch made only of the panel's tuning leaves (WEB_TUNING), never a personality. */
function isTuningPatch(patch: Record<string, unknown>): boolean {
  for (const section of ['behavior', 'interaction'] as const) {
    if (!(section in patch)) continue;
    const values = patch[section];
    if (!isObject(values)) return false;
    const allowed: readonly string[] = WEB_TUNING[section];
    if (Object.keys(values).length === 0 || !Object.keys(values).every((k) => allowed.includes(k))) return false;
  }
  return true;
}

/** The reason `patch` is outside the web allow-list, or null when every leaf is allowed. */
export function rejectNonWebPatch(patch: unknown): string | null {
  if (!isObject(patch)) return 'patch must be an object';
  const sections = Object.keys(patch);
  if (sections.length === 0) return 'empty patch';
  const hasPreset = 'behavior' in patch || 'interaction' in patch;
  if (hasPreset && !isPresetPatch(patch) && !isTuningPatch(patch)) return 'behaviour and interaction can only be a named personality or one of the panel controls';
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
