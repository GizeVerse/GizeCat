// Creating a new cat: identity and randomised (seeded) personality traits.
import type { PersistedCat, Stats, Traits } from '../../shared/catState';
import { CAT_STATE_SCHEMA_VERSION, DrivesSchema, MemorySchema, StatsSchema, WorldMemorySchema } from '../../shared/catState';
import type { Random } from './random';
import { mulberry32, randomHex, safeRandom } from './random';

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
  startleSensitivity: 0.5,
};
const TRAIT_SPREAD = 0.32;

const clampTrait = (v: number): number => Math.min(TRAIT_MAX, Math.max(TRAIT_MIN, v));

/** Triangular-ish draw around each mean; laziness is partly the inverse of energy. */
export function randomTraits(random: Random): Traits {
  const r = safeRandom(random);
  const draw = (mean: number): number => clampTrait(mean + (r() + r() - 1) * TRAIT_SPREAD);
  const energyLevel = draw(TRAIT_MEANS.energyLevel);
  const lazyRaw = draw(TRAIT_MEANS.laziness);
  // Same draw order as v1.1.1 (object literal order), so seeded cats are unchanged.
  const curiosity = draw(TRAIT_MEANS.curiosity);
  const playfulness = clampTrait(draw(TRAIT_MEANS.playfulness) * 0.8 + energyLevel * 0.2);
  const affection = draw(TRAIT_MEANS.affection);
  const confidence = draw(TRAIT_MEANS.confidence);
  return {
    curiosity,
    playfulness,
    affection,
    confidence,
    energyLevel,
    laziness: clampTrait(lazyRaw * 0.6 + (1 - energyLevel) * 0.4),
    // v1.2 contract step: derived without an extra draw, so seeded cats (and every seeded test) keep
    // their traits; the behaviour package may give it its own draw (ADR 0003 §1.2).
    startleSensitivity: clampTrait(TRAIT_MEANS.startleSensitivity + (TRAIT_MEANS.confidence - confidence) * 0.8),
  };
}

/**
 * ADR 0003 §1.2: a new cat's startle sensitivity, 0.5 u + 0.5 (1 - confidence), with u from a separate
 * generator seeded by a hash of `bornAt`: the main stream, and every seeded cat's other traits, stay as they are.
 */
export function startleSensitivityFor(bornAt: number, confidence: number): number {
  let h = 0x811c9dc5;
  const s = String(Math.floor(Number.isFinite(bornAt) ? bornAt : 0));
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 0x01000193);
  return clampTrait(0.5 * mulberry32(h >>> 0)() + 0.5 * (1 - confidence));
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
  const catId = newCatId(random);
  const traits = randomTraits(random);
  traits.startleSensitivity = startleSensitivityFor(now, traits.confidence);
  return {
    schemaVersion: CAT_STATE_SCHEMA_VERSION,
    catId,
    bornAt: now,
    traits,
    stats: defaultStats(),
    memory,
    drives: DrivesSchema.parse({}),
    world: WorldMemorySchema.parse({}),
    lastPosition: null,
    savedAt: now,
  };
}
