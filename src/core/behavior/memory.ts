// The cat's small, bounded memory: favourite spots, counters, learned preferences
// and a ring of recent episodes. Only coarse kinds are stored: never window titles,
// process names or anything typed.
import type { Counters, FavoriteSpot, Memory, MemoryEntry } from '../../shared/catState';
import { CountersSchema, MAX_FAVORITE_SPOTS, MAX_RECENT_MEMORIES, PreferencesSchema } from '../../shared/catState';

export const MEMORY_KINDS = [
  'pet',
  'nap',
  'chase',
  'inspect',
  'startle',
  'play',
  'throw',
  'attention',
  'greet',
  'annoyed',
  'called',
  'hide',
  // v1.2 (ADR 0003): 1.1.1 drops these on load (unknown kinds are filtered), which is harmless.
  'hunt',
  'pounce',
  'stay',
  'slip',
  'defend',
] as const;
export type MemoryKind = (typeof MEMORY_KINDS)[number];

/** Non-sensitive detail tokens that may accompany a memory entry. */
export const MEMORY_DETAILS = [
  'engaged',
  'ignored',
  'answered',
  'unanswered',
  'zoomies',
  'pawAt',
  'rollOver',
  'hop',
  'window',
  'floor',
  'hard',
  // v1.2: landing hardness, throw reactions (THROW_REACTIONS), hunt outcomes and stay places.
  'soft',
  'medium',
  'shrug',
  'surprise',
  'startledJump',
  'grumpy',
  'defensive',
  'flight',
  'playful',
  'avoid',
  'caught',
  'missed',
  'tabStrip',
  'edge',
] as const;
export type MemoryDetail = (typeof MEMORY_DETAILS)[number];

/** Favourite-spot scores halve every three days of wall-clock time. */
export const SPOT_HALF_LIFE_MS = 3 * 24 * 3600 * 1000;
/** Spots closer than this (fraction of display width) merge. */
export const SPOT_MERGE_XFRAC = 0.06;
const SPOT_MAX_SCORE = 1000;
const SPOT_MIN_SCORE = 0.05;

export function remember(memory: Memory, kind: MemoryKind, at: number, detail?: MemoryDetail): void {
  const entry: MemoryEntry = detail ? { at: Math.max(0, at), kind, detail } : { at: Math.max(0, at), kind };
  memory.recent.push(entry);
  if (memory.recent.length > MAX_RECENT_MEMORIES) memory.recent.splice(0, memory.recent.length - MAX_RECENT_MEMORIES);
}

export function bumpCounter(memory: Memory, key: keyof Counters, by = 1): void {
  memory.counters[key] = Math.min(1e9, Math.max(0, Math.floor(memory.counters[key] + by)));
}

/** Exponential moving average toward a 0..1 sample. */
export function ema01(prev: number, sample: number, alpha: number): number {
  const v = prev + (sample - prev) * alpha;
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

/** Score of a spot after decay up to `nowEpochMs`. */
export function decayedScore(spot: FavoriteSpot, nowEpochMs: number): number {
  const age = Math.max(0, nowEpochMs - spot.lastUsedAt);
  return spot.score * Math.pow(0.5, age / SPOT_HALF_LIFE_MS);
}

/**
 * Credits `weight` (minutes rested) to the spot at (displayKey, xFrac). Nearby
 * spots merge (position weighted by score); the list stays at most
 * MAX_FAVORITE_SPOTS long, evicting the weakest.
 */
export function learnSpot(memory: Memory, spot: { displayKey: string; xFrac: number; kind: 'floor' | 'window' }, weight: number, nowEpochMs: number): void {
  if (!Number.isFinite(weight) || weight <= 0 || !Number.isFinite(spot.xFrac)) return;
  const xFrac = Math.min(1, Math.max(0, spot.xFrac));
  const displayKey = spot.displayKey.slice(0, 64);
  // Stored scores stay raw (decay is applied from lastUsedAt when read); faded spots are pruned.
  const spots = memory.favoriteSpots.filter((s) => decayedScore(s, nowEpochMs) >= SPOT_MIN_SCORE).map((s) => ({ ...s }));
  const match = spots.find((s) => s.displayKey === displayKey && s.kind === spot.kind && Math.abs(s.xFrac - xFrac) <= SPOT_MERGE_XFRAC);
  if (match) {
    const current = decayedScore(match, nowEpochMs);
    const total = current + weight;
    match.xFrac = Math.min(1, Math.max(0, (match.xFrac * current + xFrac * weight) / total));
    match.score = Math.min(SPOT_MAX_SCORE, total);
    match.lastUsedAt = nowEpochMs;
  } else {
    const fresh: FavoriteSpot = { displayKey, xFrac, kind: spot.kind, score: Math.min(SPOT_MAX_SCORE, weight), lastUsedAt: nowEpochMs };
    if (spots.length < MAX_FAVORITE_SPOTS) {
      spots.push(fresh);
    } else {
      let weakest = 0;
      for (let i = 1; i < spots.length; i++) {
        if (decayedScore(spots[i] as FavoriteSpot, nowEpochMs) < decayedScore(spots[weakest] as FavoriteSpot, nowEpochMs)) weakest = i;
      }
      if (decayedScore(spots[weakest] as FavoriteSpot, nowEpochMs) < weight) spots[weakest] = fresh;
    }
  }
  spots.sort((a, b) => decayedScore(b, nowEpochMs) - decayedScore(a, nowEpochMs));
  memory.favoriteSpots = spots.slice(0, MAX_FAVORITE_SPOTS);
}

/** Spots ordered by decayed score (strongest first). */
export function rankedSpots(memory: Memory, nowEpochMs: number): Array<FavoriteSpot & { current: number }> {
  return memory.favoriteSpots
    .map((s) => ({ ...s, current: decayedScore(s, nowEpochMs) }))
    .filter((s) => s.current >= SPOT_MIN_SCORE)
    .sort((a, b) => b.current - a.current);
}

/** Forgets everything except identity-level data (traits/stats live elsewhere). */
export function clearMemory(memory: Memory, nowEpochMs: number): void {
  memory.favoriteSpots = [];
  memory.counters = CountersSchema.parse({});
  memory.preferences = PreferencesSchema.parse({});
  memory.recent = [];
  memory.totalAwakeMs = 0;
  memory.lastSeenAt = Math.max(0, nowEpochMs);
}

/**
 * Continuous-time EMA of an event rate (events per hour), time constant `tauMs`.
 * Call `decayRate` for elapsed active time and `addRateEvent` per event.
 */
export function decayRate(ratePerHour: number, dtMs: number, tauMs: number): number {
  return ratePerHour * Math.exp(-Math.max(0, dtMs) / tauMs);
}

export function addRateEvent(ratePerHour: number, tauMs: number): number {
  return Math.min(10000, ratePerHour + 3_600_000 / tauMs);
}
