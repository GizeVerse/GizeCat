// Living Companion vocabulary shared by the sim (src/core), the host (src/main, src/web), the renderers
// and the UIs: personality ids, moods, the world-event catalogue ids, the props a world event puts on
// screen, the journal and event-history shapes, and the scheduling constants. Pure data and types
// (platform-agnostic, ESLint-enforced for src/shared); the behaviour lives in src/core/events and
// src/core/behavior. Nothing here is persisted by itself: the schemas that persist these live in
// catState.ts (history, journal) and settings.ts (the user's choices).

// ---- personality and mood --------------------------------------------------------------------

/** The seven selectable base personalities. Chosen by the user; never changed by the cat. */
export const PERSONALITY_IDS = ['curious', 'playful', 'energetic', 'lazy', 'shy', 'mischievous', 'calm'] as const;
export type PersonalityId = (typeof PERSONALITY_IDS)[number];

/**
 * The stored personality choice. 'auto' = the cat keeps the random traits it was born with (every
 * pre-Living-Companion cat), shown as its nearest profile but tuned by no profile table.
 */
export type PersonalityChoice = PersonalityId | 'auto';

/** Temporary mood, derived from stats, drives and recent events. Never persisted, always decaying. */
export const MOODS = ['happy', 'curious', 'sleepy', 'startled', 'scared', 'excited', 'relaxed', 'confused'] as const;
export type Mood = (typeof MOODS)[number];

// ---- world events ----------------------------------------------------------------------------

/** The twenty main world events (camelCase ids; display names live in worldText.ts). */
export const WORLD_EVENT_IDS = [
  'mouseEncounter',
  'miniTsunami',
  'butterflyEncounter',
  'fallingLeaf',
  'yarnTrouble',
  'littleGhost',
  'boxAppears',
  'mysteriousBall',
  'thunderstorm',
  'flyingFish',
  'tinyUfo',
  'windGust',
  'paperPlane',
  'magicSparkles',
  'shadowVisitor',
  'toySpring',
  'bubbleParty',
  'curiousBird',
  'fallingStar',
  'tinyTreasure',
] as const;
export type WorldEventId = (typeof WORLD_EVENT_IDS)[number];

/** The six rare events (a separate, low-probability pool). */
export const RARE_EVENT_IDS = ['goldenButterfly', 'treasureDiscovery', 'friendlyGhost', 'meteorShower', 'tinyDragon', 'midnightVisitor'] as const;
export type RareEventId = (typeof RARE_EVENT_IDS)[number];

export const ALL_EVENT_IDS = [...WORLD_EVENT_IDS, ...RARE_EVENT_IDS] as const;
export type AnyEventId = WorldEventId | RareEventId;

export const isRareEvent = (id: AnyEventId): id is RareEventId => (RARE_EVENT_IDS as readonly string[]).includes(id);

/** Scheduling: a random delay between 5 and 30 minutes (at the default pace), counted from the END of the previous event. */
export const EVENT_DELAY_MIN_MS = 5 * 60_000;
export const EVENT_DELAY_MAX_MS = 30 * 60_000;
/** The user's pace multiplier: 0.5 = twice as long between events, 2 = half as long (never below the floor). */
export const EVENT_PACE_RANGE = { min: 0.5, max: 2, default: 1 } as const;
/** However fast the pace, never closer than this. */
export const EVENT_DELAY_FLOOR_MS = 2 * 60_000;
/** Bounded history: the last N events (repetition control and the journal feed). */
export const EVENT_HISTORY_MAX = 16;
/** Probability that a due event is drawn from the rare pool (when rare events are on). */
export const RARE_EVENT_PROBABILITY = 0.06;

// ---- props -----------------------------------------------------------------------------------

/**
 * Everything a world event can draw. Stylised, small, drawn procedurally by the renderer
 * (src/renderer/overlay/props.ts); never an image, never full-screen, never part of the hit region.
 */
export const PROP_KINDS = [
  'mouse',
  'wave',
  'splash',
  'butterfly',
  'goldenButterfly',
  'leaf',
  'yarn',
  'ghost',
  'box',
  'ball',
  'cloud',
  'raindrop',
  'bolt',
  'fish',
  'ufo',
  'windStreak',
  'paperPlane',
  'sparkle',
  'shadow',
  'spring',
  'bubble',
  'bird',
  'star',
  'meteor',
  'treasure',
  'dragon',
  'visitor',
] as const;
export type PropKind = (typeof PROP_KINDS)[number];

/** At most this many props at once (bubbles, sparkles and raindrops are the many-piece ones). */
export const MAX_PROPS = 24;

/**
 * One drawable prop. In SimOutput (world space) x/y are physical px like the cat's anchor and `size`
 * is the prop's nominal width in px; in CatRenderState they are overlay-local DIP. (x, y) is the
 * prop's ground/centre anchor: for floor props the point on the floor under it, for flyers its centre.
 * `id` is stable for a prop's life (render-side interpolation keys on it); `p` is the event-defined
 * 0..1 progress/animation phase; `variant` picks a palette or shape (0..3).
 */
export interface RenderProp {
  id: number;
  kind: PropKind;
  x: number;
  y: number;
  /** Nominal width (px in the sim, DIP in the render state). */
  size: number;
  /** Facing / travel direction. */
  dir: 1 | -1;
  /** 0..1, fade in/out. */
  alpha: number;
  /** 0..1 progress or animation phase, defined per kind. */
  p: number;
  /** Rotation in radians (0 = upright). */
  rot: number;
  /** 0..3 palette/shape variant. */
  variant: number;
}

/** The active event as the status displays and the journal see it. */
export interface WorldEventSnapshot {
  id: AnyEventId;
  rare: boolean;
  /** Sim time (ms) the event started. */
  startedAt: number;
}

// ---- history and journal ---------------------------------------------------------------------

/** What happened, as a short content-free token (sentences are built from event id + outcome in worldText.ts). */
export type OutcomeId = string;

export interface EventHistoryEntry {
  id: AnyEventId;
  /** Wall-clock epoch ms when it ended (sim time restarts every run, so persisted times are wall time). */
  at: number;
  outcome: OutcomeId;
}

/** A journal line: a meaningful moment, as event id + outcome + date. Local only, bounded, clearable. */
export interface JournalEntry {
  id: AnyEventId;
  at: number;
  outcome: OutcomeId;
}
export const JOURNAL_MAX = 60;

// ---- laser mode ------------------------------------------------------------------------------

/**
 * How close (body lengths) the cat comes to the laser dot before it holds off and reaches. The cat
 * never closes the gap: the dot is light, not prey (no pounce, no catch, no 'caught' memory).
 */
export const LASER_STANDOFF_BODY_LENGTHS = 0.9;

// ---- user choices (the zod schema is the `companion` section of settings.ts) ------------------

export interface CompanionEventChoices {
  /** Master switch for world events. */
  enabled: boolean;
  /** The rare pool. */
  rare: boolean;
  /** Pace multiplier within EVENT_PACE_RANGE. */
  pace: number;
  /** Individually switched-off events. */
  disabled: readonly AnyEventId[];
}
