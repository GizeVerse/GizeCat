// The seven selectable personalities as explicit, tunable data, and the pure functions that turn
// a personality into numbers the sim and the world-event engine read. The user's choice is the
// source of truth: 'auto' keeps the traits a cat was born with (every pre-Living-Companion cat) and
// uses neutral knobs, so those cats behave exactly as before; a named choice gives the cat that
// profile's traits (plus a small, bounded drift from experience) and its knobs. The cat never
// changes the choice.
//
// Everything here is a table or a small formula over explicit parameters (spans, weights, nudges):
// retuning a personality is editing PERSONALITY_PROFILES, never hunting for an if-chain. Pure, total
// (odd input is clamped, nothing throws), no clock and no randomness.
import type { Counters, Drives, Stats, Traits } from '../../shared/catState';
import { TraitsSchema } from '../../shared/catState';
import type { Mood, PersonalityChoice, PersonalityId } from '../../shared/companion';
import { PERSONALITY_IDS } from '../../shared/companion';
import type { EventTemperament } from '../events/types';
import { TRAIT_MAX, TRAIT_MIN } from './personality';

// ---- the profile table ---------------------------------------------------------------------------

/**
 * Knobs beyond the seven traits that the sim and the events read. 0..1 unless noted; 0.5 (1 for the
 * multipliers) is neutral, which is what 'auto' uses.
 */
export interface PersonalityKnobs {
  /** How much it prefers resting over wandering (0 restless, 1 a sofa). */
  readonly restBias: number;
  /** How readily it notices and engages with world events. */
  readonly eventInterest: number;
  /** How close it dares to go to something new. */
  readonly approachBoldness: number;
  /** Chase and play duration multiplier, 0.5 short .. 1.6 long. */
  readonly chaseDuration: number;
  /** Scales how strongly it startles, 0.5 unflappable .. 1.5 jumpy. */
  readonly startleScale: number;
  /** Fewer sudden movements, relaxed reactions. */
  readonly calmness: number;
  /** Weight of unusual, playful or sneaky reactions. */
  readonly mischief: number;
  /** Appetite for toys and games: how long it stays with a toy. */
  readonly playAppetite: number;
  /** Observes something new from a distance before (if ever) approaching it. */
  readonly watchFromDistance: boolean;
  /** Does not bother with minor events (a falling leaf); only the big ones wake its interest. */
  readonly ignoreMinorEvents: boolean;
}

export interface PersonalityProfile extends PersonalityKnobs {
  /** The target traits (inside the generator band TRAIT_MIN..TRAIT_MAX). */
  readonly traits: Readonly<Traits>;
}

/** What 'auto' uses: no knob moves anything away from what the cat's own traits and state give. */
export const NEUTRAL_KNOBS: PersonalityKnobs = Object.freeze({
  restBias: 0.5,
  eventInterest: 0.5,
  approachBoldness: 0.5,
  chaseDuration: 1,
  startleScale: 1,
  calmness: 0.5,
  mischief: 0.5,
  playAppetite: 0.5,
  watchFromDistance: false,
  ignoreMinorEvents: false,
});

export const PERSONALITY_PROFILES: Readonly<Record<PersonalityId, PersonalityProfile>> = Object.freeze({
  /** Investigates every new thing readily and goes close to look. */
  curious: {
    traits: { curiosity: 0.88, playfulness: 0.55, affection: 0.5, confidence: 0.62, energyLevel: 0.55, laziness: 0.3, startleSensitivity: 0.4 },
    restBias: 0.4,
    eventInterest: 0.9,
    approachBoldness: 0.7,
    chaseDuration: 1,
    startleScale: 0.9,
    calmness: 0.45,
    mischief: 0.45,
    playAppetite: 0.55,
    watchFromDistance: false,
    ignoreMinorEvents: false,
  },
  /** Spends longer with toys and games. */
  playful: {
    traits: { curiosity: 0.6, playfulness: 0.88, affection: 0.62, confidence: 0.6, energyLevel: 0.68, laziness: 0.25, startleSensitivity: 0.45 },
    restBias: 0.35,
    eventInterest: 0.7,
    approachBoldness: 0.65,
    chaseDuration: 1.3,
    startleScale: 1,
    calmness: 0.35,
    mischief: 0.55,
    playAppetite: 0.95,
    watchFromDistance: false,
    ignoreMinorEvents: false,
  },
  /** Moves more and chases for longer. */
  energetic: {
    traits: { curiosity: 0.62, playfulness: 0.72, affection: 0.45, confidence: 0.66, energyLevel: 0.9, laziness: 0.14, startleSensitivity: 0.45 },
    restBias: 0.15,
    eventInterest: 0.75,
    approachBoldness: 0.75,
    chaseDuration: 1.6,
    startleScale: 1,
    calmness: 0.2,
    mischief: 0.5,
    playAppetite: 0.75,
    watchFromDistance: false,
    ignoreMinorEvents: false,
  },
  /** Rests more and lets the small things go by. */
  lazy: {
    traits: { curiosity: 0.38, playfulness: 0.3, affection: 0.58, confidence: 0.5, energyLevel: 0.18, laziness: 0.88, startleSensitivity: 0.4 },
    restBias: 0.92,
    eventInterest: 0.25,
    approachBoldness: 0.35,
    chaseDuration: 0.55,
    startleScale: 0.85,
    calmness: 0.7,
    mischief: 0.2,
    playAppetite: 0.25,
    watchFromDistance: false,
    ignoreMinorEvents: true,
  },
  /** Watches from a distance first, jumpy, comes closer only slowly. */
  shy: {
    traits: { curiosity: 0.5, playfulness: 0.35, affection: 0.42, confidence: 0.16, energyLevel: 0.4, laziness: 0.45, startleSensitivity: 0.84 },
    restBias: 0.55,
    eventInterest: 0.5,
    approachBoldness: 0.12,
    chaseDuration: 0.7,
    startleScale: 1.5,
    calmness: 0.5,
    mischief: 0.15,
    playAppetite: 0.3,
    watchFromDistance: true,
    ignoreMinorEvents: false,
  },
  /** Unusual, cheeky reactions; bold and quick to try something. */
  mischievous: {
    traits: { curiosity: 0.72, playfulness: 0.8, affection: 0.3, confidence: 0.78, energyLevel: 0.66, laziness: 0.22, startleSensitivity: 0.25 },
    restBias: 0.3,
    eventInterest: 0.8,
    approachBoldness: 0.8,
    chaseDuration: 1.2,
    startleScale: 0.7,
    calmness: 0.25,
    mischief: 0.95,
    playAppetite: 0.85,
    watchFromDistance: false,
    ignoreMinorEvents: false,
  },
  /** Few sudden movements, relaxed and composed reactions. */
  calm: {
    traits: { curiosity: 0.45, playfulness: 0.35, affection: 0.66, confidence: 0.62, energyLevel: 0.34, laziness: 0.62, startleSensitivity: 0.14 },
    restBias: 0.65,
    eventInterest: 0.5,
    approachBoldness: 0.5,
    chaseDuration: 0.8,
    startleScale: 0.5,
    calmness: 0.95,
    mischief: 0.25,
    playAppetite: 0.4,
    watchFromDistance: false,
    ignoreMinorEvents: false,
  },
});

export const isPersonalityId = (v: unknown): v is PersonalityId => typeof v === 'string' && (PERSONALITY_IDS as readonly string[]).includes(v);

/** The knobs of a choice: the profile's, or the neutral ones for 'auto' (and for anything unknown). */
export function knobsFor(choice: PersonalityChoice): PersonalityKnobs {
  return isPersonalityId(choice) ? PERSONALITY_PROFILES[choice] : NEUTRAL_KNOBS;
}

/** A copy of a profile's target traits. */
export function profileTraits(id: PersonalityId): Traits {
  return { ...PERSONALITY_PROFILES[id].traits };
}

// ---- nearest profile -------------------------------------------------------------------------------

const TRAIT_KEYS = Object.keys(TraitsSchema.shape) as ReadonlyArray<keyof Traits>;

const finiteOr = (v: number, fallback: number): number => (Number.isFinite(v) ? v : fallback);
const clamp = (v: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, finiteOr(v, lo)));
const clamp01 = (v: number): number => clamp(v, 0, 1);

/** Squared distance between two trait sets (a missing or non-finite trait counts as the middle, 0.5). */
function traitDistance(a: Readonly<Traits>, b: Readonly<Traits>): number {
  let sum = 0;
  for (const k of TRAIT_KEYS) {
    const d = finiteOr(a[k], 0.5) - finiteOr(b[k], 0.5);
    sum += d * d;
  }
  return sum;
}

/**
 * The profile whose target traits are closest to `traits` (Euclidean over the seven traits; a tie goes
 * to the earlier id in PERSONALITY_IDS). This is how 'auto' cats are shown, and what keeps adapted
 * traits from ever leaving their own profile.
 */
export function nearestPersonality(traits: Readonly<Traits>): PersonalityId {
  let best: PersonalityId = PERSONALITY_IDS[0];
  let bestD = Number.POSITIVE_INFINITY;
  for (const id of PERSONALITY_IDS) {
    const d = traitDistance(traits, PERSONALITY_PROFILES[id].traits);
    if (d < bestD) {
      bestD = d;
      best = id;
    }
  }
  return best;
}

// ---- experience-driven drift -----------------------------------------------------------------------

/** No trait ever moves further than this from the chosen profile's target. */
export const MAX_TRAIT_DRIFT = 0.08;

interface AdaptRule {
  readonly counter: keyof Counters;
  readonly trait: keyof Traits;
  /** +1 raises the trait, -1 lowers it. */
  readonly sign: 1 | -1;
  /** The count at which the rule has reached half of its weight (saturating: n / (n + scale)). */
  readonly scale: number;
  /** The most this rule alone moves the trait. */
  readonly weight: number;
}

/** What a life of petting, rough handling, play and exploring slowly does to a cat, as explicit data. */
const ADAPT_RULES: readonly AdaptRule[] = [
  { counter: 'pets', trait: 'affection', sign: 1, scale: 400, weight: 0.05 },
  { counter: 'attentionAnswered', trait: 'affection', sign: 1, scale: 150, weight: 0.04 },
  { counter: 'throws', trait: 'startleSensitivity', sign: 1, scale: 40, weight: 0.05 },
  { counter: 'hardLandings', trait: 'startleSensitivity', sign: 1, scale: 80, weight: 0.03 },
  { counter: 'throws', trait: 'confidence', sign: -1, scale: 60, weight: 0.04 },
  { counter: 'chasesEngaged', trait: 'playfulness', sign: 1, scale: 200, weight: 0.05 },
  { counter: 'pounces', trait: 'playfulness', sign: 1, scale: 150, weight: 0.03 },
  { counter: 'chasesIgnored', trait: 'playfulness', sign: -1, scale: 150, weight: 0.04 },
  { counter: 'hunts', trait: 'energyLevel', sign: 1, scale: 200, weight: 0.03 },
  { counter: 'windowsInspected', trait: 'curiosity', sign: 1, scale: 200, weight: 0.05 },
  { counter: 'excursions', trait: 'curiosity', sign: 1, scale: 150, weight: 0.04 },
  { counter: 'naps', trait: 'laziness', sign: 1, scale: 400, weight: 0.04 },
];

/** Drift steps tried, largest first; the last (0) is the profile's own targets and always keeps the choice. */
const ADAPT_FACTORS: readonly number[] = [1, 0.5, 0.25, 0.125, 0];

function driftDeltas(counters: Readonly<Partial<Counters>>): Partial<Record<keyof Traits, number>> {
  const out: Partial<Record<keyof Traits, number>> = {};
  for (const r of ADAPT_RULES) {
    const n = Math.max(0, finiteOr(counters[r.counter] ?? 0, 0));
    out[r.trait] = (out[r.trait] ?? 0) + r.sign * r.weight * (n / (n + r.scale));
  }
  return out;
}

/**
 * The chosen personality's traits after a little life experience: the profile's targets moved by at
 * most MAX_TRAIT_DRIFT per trait according to the memory counters (ADAPT_RULES), never outside the
 * generator band, and never far enough that another profile becomes the nearest one (the drift is
 * halved until the cat still reads as its own personality; with no drift it always does). Pure: the
 * same counters give the same traits. Counters only grow slowly, so this changes over days, not minutes.
 */
export function adaptTraits(id: PersonalityId, counters: Readonly<Partial<Counters>>): Traits {
  const target = PERSONALITY_PROFILES[id].traits;
  const deltas = driftDeltas(counters);
  for (const factor of ADAPT_FACTORS) {
    const out = { ...target };
    for (const k of TRAIT_KEYS) {
      const d = clamp(deltas[k] ?? 0, -MAX_TRAIT_DRIFT, MAX_TRAIT_DRIFT) * factor;
      out[k] = clamp(target[k] + d, Math.max(TRAIT_MIN, target[k] - MAX_TRAIT_DRIFT), Math.min(TRAIT_MAX, target[k] + MAX_TRAIT_DRIFT));
    }
    if (factor === 0 || nearestPersonality(out) === id) return out;
  }
  return { ...target };
}

/**
 * The traits the sim should act on for a choice: the cat's born traits for 'auto' (unchanged, so
 * existing cats behave exactly as before), else the chosen profile's adapted traits.
 */
export function effectiveTraits(choice: PersonalityChoice, born: Readonly<Traits>, counters: Readonly<Partial<Counters>>): Traits {
  return isPersonalityId(choice) ? adaptTraits(choice, counters) : { ...born };
}

// ---- temperament -------------------------------------------------------------------------------------

type TemperamentKey = Exclude<keyof EventTemperament, 'persistence'>;

/** How far a knob (0..1, 0.5 neutral) may move each trait-derived value up or down. */
const KNOB_SPAN: Readonly<Partial<Record<TemperamentKey, number>>> = {
  interest: 0.6,
  boldness: 0.7,
  playfulness: 0.6,
  calm: 0.7,
  mischief: 0.7,
  energy: 0.5,
};

/** How the current mood nudges the temperament (small: a mood colours a reaction, it does not decide it). */
const MOOD_NUDGE: Readonly<Record<Mood, Partial<Record<TemperamentKey, number>>>> = {
  happy: { playfulness: 0.05, calm: 0.05 },
  curious: { interest: 0.12, boldness: 0.05 },
  sleepy: { interest: -0.15, playfulness: -0.15, alertness: -0.25, energy: -0.15 },
  startled: { startle: 0.15, boldness: -0.1, calm: -0.2, alertness: 0.1 },
  scared: { startle: 0.25, boldness: -0.25, calm: -0.3, interest: -0.1 },
  excited: { interest: 0.1, playfulness: 0.12, energy: 0.1, calm: -0.1 },
  relaxed: { calm: 0.12, startle: -0.08, energy: -0.05 },
  confused: { boldness: -0.05, interest: 0.05 },
};

/** Late at night even an awake cat is a little drowsy. */
const NIGHT_ALERTNESS = -0.08;
/** Alertness taken away while asleep or dozing off. */
const ASLEEP_ALERTNESS = 0.55;
/** Persistence limits (EventTemperament.persistence: 0.5 short .. 1.6 long). */
const PERSISTENCE_MIN = 0.5;
const PERSISTENCE_MAX = 1.6;

export interface TemperamentInput {
  choice: PersonalityChoice;
  /** The traits to act on (effectiveTraits): the born ones for 'auto'. */
  traits: Readonly<Traits>;
  stats: Readonly<Stats>;
  drives: Readonly<Drives>;
  mood: Mood;
  asleep: boolean;
  /** Local hour 0..24. */
  localHour: number;
}

const isNight = (hour: number): boolean => {
  const h = finiteOr(hour, 12);
  return h >= 23 || h < 6;
};

/** Base value moved by a knob around its neutral 0.5, within the knob's span. */
const shifted = (base: number, knob: number, span: number): number => base + (finiteOr(knob, 0.5) - 0.5) * span;

/**
 * How this cat tends to react to a world event right now: the engine's whole view of the
 * personality (it never sees the profile table). Derived from the traits, the live stats and
 * drives, the mood and the time of day, then moved by the choice's knobs; for 'auto' the knobs are
 * neutral, so only the cat's own traits and state matter. Monotonic in the obvious inputs (more
 * curiosity, more interest; more fear, more startle; more sleepiness, less alertness).
 */
export function temperamentFor(input: TemperamentInput): EventTemperament {
  const { traits: t, stats: s, drives: d } = input;
  const k = knobsFor(input.choice);
  const nudge = MOOD_NUDGE[input.mood] ?? {};
  const n = (key: TemperamentKey): number => nudge[key] ?? 0;
  const span = (key: TemperamentKey): number => KNOB_SPAN[key] ?? 0;

  const interest = 0.15 + 0.55 * t.curiosity + 0.2 * d.exploreNeed + 0.1 * s.boredom;
  const boldness = 0.2 + 0.5 * t.confidence + 0.2 * (1 - t.startleSensitivity) + 0.1 * s.bond - 0.4 * s.fear;
  const startle = (0.15 + 0.7 * t.startleSensitivity + 0.15 * s.fear + 0.1 * d.wariness) * k.startleScale;
  const playfulness = 0.1 + 0.55 * t.playfulness + 0.25 * d.playNeed + 0.1 * (1 - d.sleepiness);
  const calm = 0.2 + 0.3 * (1 - t.energyLevel) + 0.3 * (1 - t.startleSensitivity) + 0.2 * (1 - s.fear);
  const mischief = 0.1 + 0.45 * d.mischief + 0.25 * t.playfulness + 0.2 * t.confidence;
  const energy = 0.5 * s.energy + 0.5 * t.energyLevel;
  const alertness = 1 - 0.5 * d.sleepiness - (input.asleep ? ASLEEP_ALERTNESS : 0) + (isNight(input.localHour) ? NIGHT_ALERTNESS : 0);
  const persistence = (1 + 0.4 * (t.playfulness - 0.5) + 0.4 * (t.energyLevel - 0.5)) * (0.8 + 0.4 * s.energy) * k.chaseDuration;

  return {
    interest: clamp01(shifted(interest, k.eventInterest, span('interest')) + n('interest')),
    boldness: clamp01(shifted(boldness, k.approachBoldness, span('boldness')) + n('boldness')),
    persistence: clamp(persistence, PERSISTENCE_MIN, PERSISTENCE_MAX),
    startle: clamp01(startle + n('startle')),
    playfulness: clamp01(shifted(playfulness, k.playAppetite, span('playfulness')) + n('playfulness')),
    calm: clamp01(shifted(calm, k.calmness, span('calm')) + n('calm')),
    mischief: clamp01(shifted(mischief, k.mischief, span('mischief')) + n('mischief')),
    alertness: clamp01(alertness + n('alertness')),
    energy: clamp01(shifted(energy, 1 - k.restBias, span('energy')) + n('energy')),
  };
}
