// v1.2 rhythm (ADR 0003 §1.6): active bursts alternate with calm spells. When an episode ends the
// next is active with probability sigma(4 (D - 0.5)); its length depends on the kind, energy and
// Activity (autonomy). The picker weighs candidates by the episode (rhythmWeight). Pure; every
// draw goes through the injected generator.
import type { ActivityClass } from '../../shared/behaviorProfile';
import type { Random } from './random';
import { range } from './random';

export type Episode = 'active' | 'calm';

const clamp01 = (v: number): number => (Number.isFinite(v) ? (v < 0 ? 0 : v > 1 ? 1 : v) : 0);

export interface RhythmContext {
  /** settings.behavior.autonomy (Activity). */
  autonomy: number;
  energy: number;
  energyLevel: number;
  playNeed: number;
  exploreNeed: number;
  mischief: number;
  huntDrive: number;
  zEff: number;
  /** The typing reaction (raw typing while 'React to typing' is on). */
  typing: boolean;
  /** 0..1 share of recent keyboard-like input (0 while 'React to typing' is off). */
  typingIntensity: number;
  busySwitching: boolean;
  video: boolean;
  night: boolean;
  /** Nothing to go up onto but the screen edges: a maximized window in front, an empty desktop. */
  nothingToClimb?: boolean;
}

/**
 * Calibration offset added to D (ADR 0003 §14: the bands win over the starting constants). With the
 * stay model the cat spends a third or more of its awake time on window tops and strips, where
 * episodes are calm-leaning; without the offset the default cat measured 10-16 % active against
 * B1's 20-35 % (SIMULATED, 2 seeds x 1 sim-h, L1).
 */
export const RHYTHM_D_OFFSET = 0.3;
/**
 * Nothing to explore but the floor and the screen edges (a maximized window in front, the user's commonest
 * state, B1b; an empty desktop, L4): the cat leans calm there, its active share at or below the floating-window
 * one. Without it, and with no stay to sit through, the empty desktop measured 53 % (P1) and 39 % (P2, SIMULATED);
 * the other half of the cause: an explore need nothing can satisfy saturates, so the sim leaves it out of D there.
 */
export const RHYTHM_NOTHING_TO_CLIMB_DAMP = 0.3;
/**
 * Active episodes run this much longer than the ADR's starting U(25, 75) s: with the cat up on window tops a
 * third or more of the time the default cat measured 17-18 % against B1's 20-35 % (SIMULATED, 3 seeds x 2 sim-h).
 */
export const ACTIVE_EPISODE_MUL = 1.3;

/** D = 0.25A + 0.2 energy + 0.25 max(nP, nE, m) + 0.1 h + 0.1 (1 - zEff) - 0.45 zEff - c_ctx (+ RHYTHM_D_OFFSET). */
export function rhythmDrive(c: RhythmContext): number {
  const z = clamp01(c.zEff);
  const ctx = 0.25 * (c.typing ? 1 : 0) + 0.15 * clamp01(c.typingIntensity) + 0.2 * (c.busySwitching ? 1 : 0) + 0.2 * (c.video ? 1 : 0) + 0.1 * (c.night ? 1 : 0);
  return (
    RHYTHM_D_OFFSET +
    0.25 * clamp01(c.autonomy) +
    0.2 * clamp01(c.energy) +
    0.25 * Math.max(clamp01(c.playNeed), clamp01(c.exploreNeed), clamp01(c.mischief)) +
    0.1 * clamp01(c.huntDrive) +
    0.1 * (1 - z) -
    0.45 * z -
    ctx -
    (c.nothingToClimb === true ? RHYTHM_NOTHING_TO_CLIMB_DAMP : 0)
  );
}

/** Probability that the next episode is an active one. */
export function activeEpisodeProbability(c: RhythmContext): number {
  const d = rhythmDrive(c);
  return 1 / (1 + Math.exp(-4 * (d - 0.5)));
}

/** Standard normal draw (Box-Muller, two uniforms). */
export function normalDraw(r: Random): number {
  const u1 = Math.max(1e-9, r());
  const u2 = r();
  return Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
}

/** Log-normal draw with the given median and log-sigma. */
export function logNormalDraw(r: Random, median: number, sigma: number): number {
  return median * Math.exp(sigma * normalDraw(r));
}

export const CALM_EPISODE_MIN_MS = 30_000;
export const CALM_EPISODE_MAX_MS = 600_000;

/**
 * Episode length, ms. Active: U(25, 75) s (0.7 + 0.6 energyLevel)(0.8 + 0.4 A). Calm: LogNormal with
 * median 100 s (1.3 - 0.6 A) and sigma 0.5, clamped to 30..600 s.
 */
export function episodeLengthMs(r: Random, kind: Episode, c: Pick<RhythmContext, 'autonomy' | 'energyLevel'>): number {
  const A = clamp01(c.autonomy);
  if (kind === 'active') return ACTIVE_EPISODE_MUL * range(r, 25_000, 75_000) * (0.7 + 0.6 * clamp01(c.energyLevel)) * (0.8 + 0.4 * A);
  const ms = logNormalDraw(r, 100_000 * (1.3 - 0.6 * A), 0.5);
  return Number.isFinite(ms) ? Math.min(CALM_EPISODE_MAX_MS, Math.max(CALM_EPISODE_MIN_MS, ms)) : CALM_EPISODE_MIN_MS;
}

/** Active candidates during a stay keep this share of their rhythm weight (calm-leaning episodes). */
export const STAY_ACTIVE_RHYTHM = 0.6;
/**
 * Calm candidates' weight in an active episode. The ADR's starting value was 0.3; calibrated to
 * 0.1 against band B1 (the §14 bands win over the starting constants): at 0.3 a calm pick with
 * its long dwell (resting 15-70 s) used up most active episodes and the default cat stayed at
 * 10-16 % active (SIMULATED, 2 seeds x 1 sim-h, L1).
 */
export const CALM_IN_ACTIVE_EPISODE = 0.1;

/**
 * R_e: how the current episode weighs a candidate of class `cls`. Active episode: active x1, calm
 * x CALM_IN_ACTIVE_EPISODE; calm episode: active x(0.12 + 0.2 m), calm x1. On a stay active
 * candidates get x0.6 more. Other classes (reactions) are not weighed.
 */
export function rhythmWeight(episode: Episode | 'none', cls: ActivityClass, mischief: number, onStay: boolean): number {
  if (episode === 'none') return 1;
  const calmLike = cls === 'calm' || cls === 'asleep';
  if (cls === 'active') return (episode === 'active' ? 1 : 0.12 + 0.2 * clamp01(mischief)) * (onStay ? STAY_ACTIVE_RHYTHM : 1);
  if (calmLike) return episode === 'active' ? CALM_IN_ACTIVE_EPISODE : 1;
  return 1;
}

/** The episode the cat is in and when it ends. */
export class Rhythm {
  episode: Episode = 'calm';
  endsAt = -Infinity;
  started = false;

  /** Starts the next episode when the current one is over; true when a new one began. */
  update(r: Random, now: number, c: RhythmContext): boolean {
    if (this.started && now < this.endsAt) return false;
    this.episode = r() < activeEpisodeProbability(c) ? 'active' : 'calm';
    this.endsAt = now + episodeLengthMs(r, this.episode, c);
    this.started = true;
    return true;
  }

  /** Ends the current episode now (the next update draws a new one). */
  reset(): void {
    this.started = false;
    this.endsAt = -Infinity;
  }
}
