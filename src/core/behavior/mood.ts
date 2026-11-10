// The cat's temporary mood: derived from the stats, drives and what it is doing, plus short pushes
// from events and reactions that fade within seconds. Mood is colour, not state: it tints the
// temperament (personalityProfiles.ts) and the renderer's hints, it never decides behaviour, and it
// is never persisted. Pure and total; the clock is passed in (no Date, no randomness here).
import type { Drives, Stats } from '../../shared/catState';
import type { BehaviorState } from '../../shared/cat';
import type { Mood } from '../../shared/companion';
import { MOODS } from '../../shared/companion';

// ---- pushes and their decay -------------------------------------------------------------------------

export interface MoodPush {
  mood: Mood;
  /** 0..1. */
  strength: number;
}

/** Seconds-scale half-lives: sudden moods fade fast, gentle ones linger a little. */
export const MOOD_HALF_LIFE_MS: Readonly<Record<Mood, number>> = Object.freeze({
  startled: 2_500,
  scared: 6_000,
  confused: 5_000,
  excited: 9_000,
  curious: 14_000,
  happy: 20_000,
  relaxed: 20_000,
  sleepy: 20_000,
});

/** One push adds at most this share of its strength: a single event is never dramatic. */
export const MOOD_PUSH_GAIN = 0.6;
/** However many pushes pile up, a mood never gets stronger than this from events alone. */
export const MOOD_PUSH_MAX = 0.75;
/** Below this a decayed push counts as gone. */
export const MOOD_PUSH_FLOOR = 0.06;

const finiteOr = (v: number, fallback: number): number => (Number.isFinite(v) ? v : fallback);
const clamp01 = (v: number): number => Math.min(1, Math.max(0, finiteOr(v, 0)));

/**
 * Event and reaction pushes, one decaying strength per mood. Time only moves forward here: a clock
 * that jumps back (suspend, adjustment) decays nothing, one that jumps ahead decays everything it
 * should, so a long suspend leaves a calm cat.
 */
export class MoodTracker {
  private strength: Record<Mood, number> = emptyStrengths();
  private at = 0;
  private started = false;

  /** Adds a push at time `now` (ms). Unknown moods and non-finite strengths are ignored. */
  push(mood: Mood, strength: number, now: number): void {
    if (!(MOODS as readonly string[]).includes(mood) || !Number.isFinite(strength) || strength <= 0) return;
    this.advance(now);
    this.strength[mood] = Math.min(MOOD_PUSH_MAX, this.strength[mood] + clamp01(strength) * MOOD_PUSH_GAIN);
  }

  /** The strongest live push at `now`, or null when every push has faded. */
  strongest(now: number): MoodPush | null {
    this.advance(now);
    let best: MoodPush | null = null;
    for (const mood of MOODS) {
      const s = this.strength[mood];
      if (s >= MOOD_PUSH_FLOOR && (best === null || s > best.strength)) best = { mood, strength: s };
    }
    return best;
  }

  /** The live strength of one mood at `now` (0 when faded). */
  strengthOf(mood: Mood, now: number): number {
    this.advance(now);
    return this.strength[mood] ?? 0;
  }

  clear(): void {
    this.strength = emptyStrengths();
    this.started = false;
  }

  private advance(now: number): void {
    if (!Number.isFinite(now)) return;
    if (!this.started) {
      this.started = true;
      this.at = now;
      return;
    }
    const dt = now - this.at;
    if (dt <= 0) {
      // Never run time backwards; a clock that went back is simply re-anchored.
      this.at = now;
      return;
    }
    this.at = now;
    for (const mood of MOODS) {
      const s = this.strength[mood];
      if (s <= 0) continue;
      const next = s * Math.pow(0.5, dt / MOOD_HALF_LIFE_MS[mood]);
      this.strength[mood] = next < MOOD_PUSH_FLOOR / 2 ? 0 : next;
    }
  }
}

function emptyStrengths(): Record<Mood, number> {
  return { happy: 0, curious: 0, sleepy: 0, startled: 0, scared: 0, excited: 0, relaxed: 0, confused: 0 };
}

// ---- deriving the mood --------------------------------------------------------------------------------

export interface MoodInput {
  stats: Readonly<Stats>;
  drives: Readonly<Drives>;
  state: BehaviorState;
  /** The strongest live push (MoodTracker.strongest), or null. */
  push: MoodPush | null;
  /** The mood shown a moment ago: it gets a head start, so two close moods do not flicker. */
  previous?: Mood;
}

/** A challenger must beat the previous mood's score by this much to take over. */
export const MOOD_HYSTERESIS = 0.12;
/** When no mood scores above this the cat is simply relaxed. */
export const MOOD_NEUTRAL_FLOOR = 0.22;

const DOZING: ReadonlySet<BehaviorState> = new Set<BehaviorState>(['sleeping', 'fallingAsleep', 'wakingUp']);
const LAZING: ReadonlySet<BehaviorState> = new Set<BehaviorState>(['resting', 'grooming', 'idle']);
const LIVELY: ReadonlySet<BehaviorState> = new Set<BehaviorState>(['playing', 'chasingCursor', 'running', 'seekingAttention']);
const INTERESTED: ReadonlySet<BehaviorState> = new Set<BehaviorState>(['curious', 'inspectingWindow', 'watchingCursor', 'watchingUser']);

/** Each mood's score in 0..1 from the stats, drives and state (the push is added by the caller). */
function baseScores(i: MoodInput): Record<Mood, number> {
  const { stats: s, drives: d, state } = i;
  return {
    sleepy: clamp01(0.9 * d.sleepiness + (DOZING.has(state) ? 0.55 : 0) + (state === 'resting' ? 0.1 : 0) - 0.3 * s.energy),
    startled: clamp01(state === 'startled' ? 0.9 : 0),
    scared: clamp01(1.2 * s.fear + (state === 'hiding' ? 0.4 : 0)),
    excited: clamp01((LIVELY.has(state) ? 0.45 : 0) + 0.25 * d.playNeed * s.energy + (state === 'playing' ? 0.2 : 0)),
    curious: clamp01((INTERESTED.has(state) ? 0.5 : 0) + 0.3 * d.exploreNeed * (INTERESTED.has(state) ? 1 : 0.4)),
    happy: clamp01(0.4 * s.bond + (state === 'beingPetted' ? 0.55 : 0) + 0.2 * (1 - s.boredom) - 0.5 * s.annoyance - 0.4 * d.irritability),
    relaxed: clamp01((LAZING.has(state) ? 0.3 : 0.1) + 0.2 * (1 - s.fear) + 0.15 * (1 - s.boredom) - 0.2 * d.sleepiness),
    confused: clamp01(0.9 * d.frustration),
  };
}

/**
 * The mood to show: the highest-scoring one, where a live push adds its strength to its own mood,
 * the previous mood gets a MOOD_HYSTERESIS head start, and a flat field falls back to relaxed. Pure.
 */
export function moodFor(input: MoodInput): Mood {
  const scores = baseScores(input);
  if (input.push && (MOODS as readonly string[]).includes(input.push.mood)) scores[input.push.mood] = clamp01(scores[input.push.mood] + clamp01(input.push.strength));
  if (input.previous && (MOODS as readonly string[]).includes(input.previous)) scores[input.previous] += MOOD_HYSTERESIS;
  let best: Mood = 'relaxed';
  let bestScore = MOOD_NEUTRAL_FLOOR;
  for (const mood of MOODS) {
    if (scores[mood] > bestScore) {
      best = mood;
      bestScore = scores[mood];
    }
  }
  return best;
}

// ---- sleep depth ----------------------------------------------------------------------------------------

/** Time constant of falling into deep sleep (ms): about two thirds of the way after this long asleep. */
export const SLEEP_DEPTH_TAU_MS = 3 * 60_000;

/**
 * How deeply the cat sleeps, 0 (awake or just dropped off) to 1 (deep): grows with the time asleep
 * (the sim passes the elapsed ms) and is deeper for a sleepy, tired cat. The renderer slows the
 * breathing and the ears with it; nothing else reads it.
 */
export function sleepDepthFor(input: { asleepMs: number; sleepiness: number; energy: number }): number {
  const ms = finiteOr(input.asleepMs, 0);
  if (ms <= 0) return 0;
  const need = 0.5 * clamp01(input.sleepiness) + 0.5 * (1 - clamp01(input.energy));
  return clamp01((1 - Math.exp(-ms / SLEEP_DEPTH_TAU_MS)) * (0.4 + 0.6 * need));
}
