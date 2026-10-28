// Creating a new cat: identity and randomised (seeded) personality traits.
import type { PersistedCat, Stats, Traits } from '../../shared/catState';
import { CAT_STATE_SCHEMA_VERSION, MemorySchema, StatsSchema } from '../../shared/catState';
import type { Random } from './random';
import { randomHex, safeRandom } from './random';

/** Traits never leave this band, so every cat is a believable cat (never 0 or 1). */
export const TRAIT_MIN = 0.12;
export const TRAIT_MAX = 0.92;

const TRAIT_MEANS: Readonly<Traits> = {
  curiosity: 0.6,
  playfulness: 0.55,
  affection: 0.5,
  confidence: 0.5,
  energyLevel: 0.5,
  laziness: 0.45,
};
const TRAIT_SPREAD = 0.32;

const clampTrait = (v: number): number => Math.min(TRAIT_MAX, Math.max(TRAIT_MIN, v));

/** Triangular-ish draw around each mean; laziness is partly the inverse of energy. */
export function randomTraits(random: Random): Traits {
  const r = safeRandom(random);
  const draw = (mean: number): number => clampTrait(mean + (r() + r() - 1) * TRAIT_SPREAD);
  const energyLevel = draw(TRAIT_MEANS.energyLevel);
  const lazyRaw = draw(TRAIT_MEANS.laziness);
  return {
    curiosity: draw(TRAIT_MEANS.curiosity),
    playfulness: clampTrait(draw(TRAIT_MEANS.playfulness) * 0.8 + energyLevel * 0.2),
    affection: draw(TRAIT_MEANS.affection),
    confidence: draw(TRAIT_MEANS.confidence),
    energyLevel,
    laziness: clampTrait(lazyRaw * 0.6 + (1 - energyLevel) * 0.4),
  };
}

export function defaultStats(): Stats {
  return StatsSchema.parse({ bond: 0.15 });
}

export function newCatId(random: Random): string {
  return `cat-${randomHex(safeRandom(random), 16)}`;
}

/** A brand-new cat with seeded traits. `nowEpochMs` becomes its birth time. */
export function newPersistedCat(random: Random, nowEpochMs: number): PersistedCat {
  const now = Number.isFinite(nowEpochMs) && nowEpochMs > 0 ? nowEpochMs : 0;
  const memory = MemorySchema.parse({});
  memory.lastSeenAt = now;
  return {
    schemaVersion: CAT_STATE_SCHEMA_VERSION,
    catId: newCatId(random),
    bornAt: now,
    traits: randomTraits(random),
    stats: defaultStats(),
    memory,
    lastPosition: null,
    savedAt: now,
  };
}
