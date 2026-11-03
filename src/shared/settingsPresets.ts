// v1.2 activity presets (ADR 0003 §9.2). Plain data and pure functions, no zod: the settings
// renderer imports this module (it must stay zod-free) to build a preset patch, and
// src/shared/settings.ts uses it for the defaults and the v2 -> v3 migration.
//
// Presets set only the activity values below. They never touch consent or privacy (perception,
// ai, loginItem), the opt-out lists, sound, appearance, movementSpeed, sleepAfterIdleMinutes,
// attentionSeeking, activitySensitivity or any other key.

export const ACTIVITY_PRESET_IDS = ['calm', 'playful', 'mischievous'] as const;
export type ActivityPresetId = (typeof ACTIVITY_PRESET_IDS)[number];
export type ActivityPresetChoice = ActivityPresetId | 'custom';

/** The keys a preset governs, by settings section. */
export const PRESET_BEHAVIOR_KEYS = ['autonomy', 'cursorPlay', 'exploration', 'heights', 'mischief', 'workDisruption', 'stayLength'] as const;
export type PresetBehaviorKey = (typeof PRESET_BEHAVIOR_KEYS)[number];
export const PRESET_INTERACTION_KEYS = ['reactionIntensity'] as const;
export type PresetInteractionKey = (typeof PRESET_INTERACTION_KEYS)[number];

export interface PresetValues {
  behavior: Record<PresetBehaviorKey, number>;
  interaction: Record<PresetInteractionKey, number>;
}

/**
 * Playful is the default and equals the v2 defaults for the v2 keys (autonomy 0.6, cursorPlay 0.5):
 * a v2 user who never touched them is on Playful after the migration. Its new keys lean
 * mischievous; the livelier cat comes from the v1.2 behaviour model, not from changed v2 defaults.
 */
export const PRESET_VALUES: Readonly<Record<ActivityPresetId, Readonly<PresetValues>>> = {
  calm: {
    behavior: { autonomy: 0.35, cursorPlay: 0.25, exploration: 0.35, heights: 0.3, mischief: 0.1, workDisruption: 0.05, stayLength: 0.65 },
    interaction: { reactionIntensity: 0.35 },
  },
  playful: {
    behavior: { autonomy: 0.6, cursorPlay: 0.5, exploration: 0.6, heights: 0.55, mischief: 0.4, workDisruption: 0.25, stayLength: 0.5 },
    interaction: { reactionIntensity: 0.5 },
  },
  mischievous: {
    behavior: { autonomy: 0.8, cursorPlay: 0.75, exploration: 0.8, heights: 0.75, mischief: 0.75, workDisruption: 0.45, stayLength: 0.4 },
    interaction: { reactionIntensity: 0.7 },
  },
};

/** Two slider values count as equal within this (slider steps are 0.05). */
const PRESET_TOLERANCE = 1e-6;

/** The structural part of Settings a preset reads (keeps this module free of the zod schema). */
export interface PresetReadable {
  behavior: Record<PresetBehaviorKey, number>;
  interaction: Record<PresetInteractionKey, number>;
}

/** The preset whose values `s` holds exactly, or null (custom). */
export function matchingPreset(s: PresetReadable): ActivityPresetId | null {
  for (const id of ACTIVITY_PRESET_IDS) {
    const v = PRESET_VALUES[id];
    const same =
      PRESET_BEHAVIOR_KEYS.every((k) => Math.abs(s.behavior[k] - v.behavior[k]) <= PRESET_TOLERANCE) &&
      PRESET_INTERACTION_KEYS.every((k) => Math.abs(s.interaction[k] - v.interaction[k]) <= PRESET_TOLERANCE);
    if (same) return id;
  }
  return null;
}

/** What the Personality selector shows for `s`: the matching preset, else 'custom' (main stores the same). */
export function presetChoiceFor(s: PresetReadable): ActivityPresetChoice {
  return matchingPreset(s) ?? 'custom';
}

/** True for a settings leaf a preset sets: changing it alone makes the activity values custom. */
export function isPresetGoverned(section: string, key: string): boolean {
  if (section === 'behavior') return (PRESET_BEHAVIOR_KEYS as readonly string[]).includes(key);
  if (section === 'interaction') return (PRESET_INTERACTION_KEYS as readonly string[]).includes(key);
  return false;
}

/** A multi-section settings patch that applies preset `id` (main applies it atomically). */
export function presetPatch(id: ActivityPresetId): {
  behavior: Record<PresetBehaviorKey, number> & { activityPreset: ActivityPresetId };
  interaction: Record<PresetInteractionKey, number>;
} {
  const v = PRESET_VALUES[id];
  return { behavior: { ...v.behavior, activityPreset: id }, interaction: { ...v.interaction } };
}

/**
 * The named preset nearest to `s` (sum of absolute differences over the governed keys; ties go to
 * the earlier id). The UI shows "Custom (closest: <name>)" with it (ADR 0003 §9.2, review).
 */
export function closestPreset(s: PresetReadable): ActivityPresetId {
  let best: ActivityPresetId = 'playful';
  let bestD = Infinity;
  for (const id of ACTIVITY_PRESET_IDS) {
    const v = PRESET_VALUES[id];
    let d = 0;
    for (const k of PRESET_BEHAVIOR_KEYS) d += Math.abs((Number.isFinite(s.behavior[k]) ? s.behavior[k] : v.behavior[k]) - v.behavior[k]);
    for (const k of PRESET_INTERACTION_KEYS) d += Math.abs((Number.isFinite(s.interaction[k]) ? s.interaction[k] : v.interaction[k]) - v.interaction[k]);
    if (d < bestD - PRESET_TOLERANCE) {
      best = id;
      bestD = d;
    }
  }
  return best;
}
