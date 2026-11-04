// Need/mood variables over time. Rates are per second; energy and boredom move
// over tens of minutes to hours, annoyance over minutes, fear over seconds.
// v1.2 (ADR 0003 §1.2): energy drains recalibrated so a default cat that is active ~30 % of the
// time keeps its energy at or above 0.5 over hours (with its naps); boredom is a display value
// the sim sets from the play and explore needs (drives.ts).
import type { BehaviorState } from '../../shared/cat';
import type { Stats, Traits } from '../../shared/catState';

type RateTable = Partial<Record<BehaviorState, number>>;

const ENERGY_RATE: RateTable = {
  sleeping: 0.0008,
  fallingAsleep: 0.0001,
  resting: 0.00004,
  away: 0.00003,
  idle: -0.00003,
  wakingUp: -0.00003,
  grooming: -0.00003,
  watchingUser: -0.00003,
  watchingCursor: -0.00003,
  curious: -0.00004,
  inspectingWindow: -0.00004,
  beingPetted: -0.00001,
  landing: -0.0001,
  walking: -0.00012,
  seekingAttention: -0.0001,
  hiding: -0.0001,
  annoyed: -0.00015,
  running: -0.0007,
  chasingCursor: -0.0007,
  playing: -0.0007,
  jumping: -0.0007,
  falling: -0.0003,
  held: -0.0002,
  startled: -0.0004,
};

const BOREDOM_RATE: RateTable = {
  idle: 0.0006,
  resting: 0.0005,
  watchingUser: 0.0004,
  watchingCursor: 0.0001,
  grooming: 0.0003,
  walking: 0.0002,
  hiding: 0.0002,
  wakingUp: 0,
  curious: -0.005,
  inspectingWindow: -0.005,
  playing: -0.012,
  chasingCursor: -0.012,
  running: -0.008,
  beingPetted: -0.006,
  seekingAttention: -0.001,
  sleeping: -0.0006,
};

const BOND_DECAY_PER_S = 3.5e-7; // ~3 % per day
const BOND_FLOOR = 0.05;

const clamp01 = (v: number): number => (v < 0 ? 0 : v > 1 ? 1 : Number.isFinite(v) ? v : 0);

export interface StatsContext {
  state: BehaviorState;
  traits: Traits;
  /** settings.interaction.patience, 0..1. */
  patience: number;
}

export function stepStats(stats: Stats, ctx: StatsContext, dtMs: number): void {
  const dt = Math.max(0, Math.min(dtMs, 1000)) / 1000;
  if (dt === 0) return;
  const t = ctx.traits;
  const e = ENERGY_RATE[ctx.state] ?? 0;
  const drainMul = 1.25 - 0.5 * t.energyLevel;
  stats.energy = clamp01(stats.energy + (e < 0 ? e * drainMul : e) * dt);

  const b = BOREDOM_RATE[ctx.state] ?? 0;
  stats.boredom = clamp01(stats.boredom + (b > 0 ? b * (0.6 + 0.8 * t.curiosity) : b) * dt);

  if (stats.bond > BOND_FLOOR) stats.bond = clamp01(Math.max(BOND_FLOOR, stats.bond - BOND_DECAY_PER_S * dt));

  const annoyanceHalfLife = 90 + 120 * clamp01(ctx.patience);
  stats.annoyance = clamp01(stats.annoyance * Math.pow(0.5, dt / annoyanceHalfLife));
  const fearHalfLife = 2.5 + 3 * t.confidence;
  stats.fear = clamp01(stats.fear * Math.pow(0.5, dt / fearHalfLife));
}

/** At load: annoyance and fear as they would have decayed over the downtime (stepStats' half-lives), capped like the moods. */
export function decayStatsForDowntime(stats: Stats, traits: Pick<Traits, 'confidence'>, patience: number, downtimeS: number): void {
  if (!Number.isFinite(downtimeS) || downtimeS <= 0) return;
  stats.annoyance = clamp01(stats.annoyance * Math.pow(0.5, downtimeS / (90 + 120 * clamp01(patience))));
  stats.fear = clamp01(stats.fear * Math.pow(0.5, downtimeS / (2.5 + 3 * traits.confidence)));
}

export function addStat(stats: Stats, key: keyof Stats, delta: number): void {
  if (!Number.isFinite(delta)) return;
  stats[key] = clamp01(stats[key] + delta);
}

/** Gentle petting: bond grows with diminishing returns; irritation and fear ease. */
export function applyPet(stats: Stats, traits: Traits, strength: number): void {
  const s = clamp01(strength);
  addStat(stats, 'bond', 0.006 * s * (1 - stats.bond) * (0.6 + traits.affection));
  addStat(stats, 'annoyance', -0.06 * s);
  addStat(stats, 'fear', -0.1 * s);
  addStat(stats, 'boredom', -0.02 * s);
}

/** 0..1 contentment target derived from stats (the state adds its own bias). */
export function baseContentment(stats: Stats): number {
  return clamp01(0.45 + 0.35 * stats.bond - 0.6 * stats.annoyance - 0.5 * stats.fear + 0.1 * (stats.energy - 0.5));
}
