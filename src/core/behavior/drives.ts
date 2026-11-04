// v1.2 drives (ADR 0003 §1.2): bounded needs (social, play, explore) and moods (sleepiness,
// mischief, hunt drive, irritability, frustration, wariness) with explicit update rules. Pure: the
// sim steps them from an accumulator on sim time (1 Hz; the hunt drive at 4 Hz, see hunt.ts), so a
// 33 ms and a 66 ms host tick give the same results, and applies the event impulses below.
import type { Drives, Stats, Traits } from '../../shared/catState';

/** Drives step once per this much sim time (accumulator, never per host tick). */
export const DRIVE_STEP_MS = 1000;
/** At load, moods decay for the downtime, but at most for this long. */
export const DOWNTIME_DECAY_CAP_MS = 3600_000;
/** Default sleepiness, restored after more than DOWNTIME_DECAY_CAP_MS off. */
export const DEFAULT_SLEEPINESS = 0.2;
/** Mischief relaxes toward its target with this time constant, s. */
export const MISCHIEF_TAU_S = 300;
/** Frustration half-life, s. */
export const FRUSTRATION_HALF_LIFE_S = 90;
/** At most this much irritability per petting bout from frantic strokes or strokes right after a throw. */
export const STROKE_IRRITATION_PER_BOUT = 0.1;
/** Sleepiness change per second while resting (ADR starting value 1/5400; calibrated to 0 against B15). */
export const RESTING_SLEEPINESS_PER_S = 0;

const clamp01 = (v: number): number => (Number.isFinite(v) ? (v < 0 ? 0 : v > 1 ? 1 : v) : 0);
const unit = (v: number, fallback: number): number => (Number.isFinite(v) ? clamp01(v) : fallback);
/** relax(x, x*, tau): x <- x* + (x - x*) e^(-dt/tau). */
export const relax = (x: number, target: number, tauS: number, dtS: number): number => target + (x - target) * Math.exp(-dtS / Math.max(1e-6, tauS));
/** half(x, h): x <- x 2^(-dt/h). */
export const half = (x: number, halfLifeS: number, dtS: number): number => x * Math.pow(2, -dtS / Math.max(1e-6, halfLifeS));

/** What the drives need to know about the cat and its surroundings for one step. */
export interface DriveContext {
  /** Awake and in the world (not asleep, not hidden away). */
  awake: boolean;
  /** Sleeping (sleepiness drains). */
  asleep: boolean;
  /** Resting (loaf): sleepiness drains slowly instead of growing. */
  resting: boolean;
  beingPetted: boolean;
  held: boolean;
  /** Playing or hunting: the play need is being satisfied. */
  playing: boolean;
  /** Zoomies or a tail chase (the play need drains faster). */
  zoomies: boolean;
  /** Curious or inspecting: a little of the explore need is satisfied. */
  inspecting: boolean;
  /** A novel reachable elevated target or a clear screen-edge band exists (explore growth x1, else x0.3). */
  opportunity: boolean;
  traits: Traits;
  stats: Pick<Stats, 'energy' | 'fear' | 'annoyance' | 'bond'>;
  /** settings.behavior.autonomy (A), exploration (X), mischief (M), attentionSeeking (Att); interaction.patience (P). */
  autonomy: number;
  exploration: number;
  mischief: number;
  attentionSeeking: number;
  patience: number;
  /** Local night (23-6 h). */
  night: boolean;
  /** 0..1 dark-screen bias from perception. */
  darkBias: number;
}

/** Effective sleepiness: the sleep pressure plus low energy (drives naps, damps the rhythm). */
export function zEff(sleepiness: number, energy: number): number {
  return clamp01(unit(sleepiness, DEFAULT_SLEEPINESS) + (0.6 * Math.max(0, 0.55 - unit(energy, 0.8))) / 0.55);
}

/** Target the mischief mood relaxes toward: m* = M (0.5 + 0.5 nP)(1 - 0.5 zEff)(1 - 0.8 fear). */
export function mischiefTarget(mischiefSetting: number, playNeed: number, zEffective: number, fear: number): number {
  return clamp01(unit(mischiefSetting, 0.4) * (0.5 + 0.5 * unit(playNeed, 0.4)) * (1 - 0.5 * clamp01(zEffective)) * (1 - 0.8 * unit(fear, 0)));
}

/** Seconds for the sleepiness to grow from 0 to 1 while awake (before the night and dark-screen factors). */
export function sleepinessPeriodS(traits: Pick<Traits, 'laziness' | 'energyLevel'>): number {
  return 3600 * (1.4 - 0.8 * unit(traits.laziness, 0.45)) * (1.2 - 0.4 * unit(traits.energyLevel, 0.5));
}

/** Irritability time constant, s: 120 (1 + 1.5 (1 - patience)). */
export function irritabilityTauS(patience: number): number {
  return 120 * (1 + 1.5 * (1 - unit(patience, 0.5)));
}

/** Wariness half-life, s: 45 (2.5 - 1.5 bond)(1 + 0.5 irritability). */
export function warinessHalfLifeS(bond: number, irritability: number): number {
  return 45 * (2.5 - 1.5 * unit(bond, 0.3)) * (1 + 0.5 * unit(irritability, 0));
}

/** Makes every drive finite and within 0..1 (corrupt or hand-edited input degrades to defaults). */
export function clampDrives(d: Drives): void {
  d.socialNeed = unit(d.socialNeed, 0.3);
  d.playNeed = unit(d.playNeed, 0.4);
  d.exploreNeed = unit(d.exploreNeed, 0.4);
  d.sleepiness = unit(d.sleepiness, DEFAULT_SLEEPINESS);
  d.mischief = unit(d.mischief, 0.3);
  d.huntDrive = unit(d.huntDrive, 0);
  d.irritability = unit(d.irritability, 0);
  d.frustration = unit(d.frustration, 0);
  d.wariness = unit(d.wariness, 0);
}

/**
 * One drive step of `dtMs` (normally DRIVE_STEP_MS). The hunt drive is not stepped here (4 Hz,
 * hunt.ts). Every drive is clamped to 0..1 afterwards.
 */
export function stepDrives(d: Drives, c: DriveContext, dtMs: number): void {
  const dt = Number.isFinite(dtMs) ? Math.max(0, Math.min(dtMs, 10_000)) / 1000 : 0;
  clampDrives(d);
  if (dt === 0) return;
  const t = c.traits;
  const energy = unit(c.stats.energy, 0.8);
  const A = unit(c.autonomy, 0.6);
  const X = unit(c.exploration, 0.6);
  // Social need: grows while awake and untouched; contact satisfies it.
  if (c.awake && !c.beingPetted && !c.held) d.socialNeed += ((0.4 + 0.6 * unit(t.affection, 0.5)) * (0.5 + unit(c.attentionSeeking, 0.35)) * dt) / 1800;
  if (c.beingPetted) d.socialNeed -= 0.004 * dt;
  if (c.held) d.socialNeed -= 0.001 * dt;
  // Play need: grows while awake and not playing; play and hunting satisfy it (petting never does).
  if (c.playing) d.playNeed -= (c.zoomies ? 0.02 : 0.012) * dt;
  else if (c.awake) d.playNeed += ((0.3 + 0.7 * unit(t.playfulness, 0.55)) * (0.5 + A) * dt) / 1500;
  // Explore need: grows faster with somewhere new to go (opportunity), so a maximized window in
  // front does not saturate it; visits satisfy it (exploreVisit), looking around a little.
  if (c.awake) d.exploreNeed += ((0.3 + 0.7 * unit(t.curiosity, 0.6)) * (0.5 + X) * (c.opportunity ? 1 : 0.3) * dt) / 1800;
  if (c.inspecting) d.exploreNeed -= 0.002 * dt;
  // Sleepiness: drains asleep, builds otherwise while awake. Resting holds it (calibration: the ADR's
  // starting value drained it by 1/5400 per s, but the cat rests often enough that the sleep
  // pressure then hardly built and band B15's naps never came; SIMULATED, see RESTING_SLEEPINESS_PER_S).
  if (c.asleep) d.sleepiness -= dt / 720;
  else if (c.resting) d.sleepiness -= RESTING_SLEEPINESS_PER_S * dt;
  else if (c.awake) d.sleepiness += ((c.night ? 1.4 : 1) * (1 + 0.3 * clamp01(c.darkBias)) * dt) / sleepinessPeriodS(t);
  // Mischief relaxes toward a target set by the setting, the play need, sleepiness and fear.
  d.mischief = relax(d.mischief, mischiefTarget(c.mischief, d.playNeed, zEff(d.sleepiness, energy), c.stats.fear), MISCHIEF_TAU_S, dt);
  // Irritability integrates annoyance and recovers over minutes (slower for an impatient cat).
  const tauI = irritabilityTauS(c.patience);
  // 0.001, not the ADR's starting 0.004: annoyance decays as fast as irritability, so 0.004 left i at 0.15 ten minutes after a burst and 0.0025 at 0.10-0.17 (B8, SIMULATED).
  d.irritability += (0.001 * unit(c.stats.annoyance, 0) - d.irritability / tauI) * dt;
  d.frustration = half(d.frustration, FRUSTRATION_HALF_LIFE_S, dt);
  d.wariness = half(d.wariness, warinessHalfLifeS(c.stats.bond, d.irritability), dt);
  clampDrives(d);
}

/**
 * At load: moods decay for the wall-clock downtime (capped at 1 h) as they would have with nothing
 * happening; needs never grow across downtime; after more than 1 h off sleepiness is back to its
 * default. No random draws (the main stream is untouched).
 */
export function decayForDowntime(d: Drives, downtimeMs: number, c: { bond: number; patience: number; mischief: number; fear: number; energy: number; huntBaseline: number }): void {
  clampDrives(d);
  if (!Number.isFinite(downtimeMs) || downtimeMs <= 0) return;
  const dt = Math.min(downtimeMs, DOWNTIME_DECAY_CAP_MS) / 1000;
  d.irritability = d.irritability * Math.exp(-dt / irritabilityTauS(c.patience));
  d.frustration = half(d.frustration, FRUSTRATION_HALF_LIFE_S, dt);
  d.wariness = half(d.wariness, warinessHalfLifeS(c.bond, d.irritability), dt);
  d.mischief = relax(d.mischief, mischiefTarget(c.mischief, d.playNeed, zEff(d.sleepiness, c.energy), c.fear), MISCHIEF_TAU_S, dt);
  d.huntDrive = relax(d.huntDrive, clamp01(c.huntBaseline), 20, dt);
  if (downtimeMs > DOWNTIME_DECAY_CAP_MS) d.sleepiness = DEFAULT_SLEEPINESS;
  clampDrives(d);
}

// ---- event impulses (ADR 0003 §1.2 table) --------------------------------------------------

export type DriveImpulse =
  /** Greeting the user, or an attention request the user answered. */
  | 'socialAnswered'
  /** An attention request nobody answered: asking relieves a little, and it gets cheekier. */
  | 'attentionIgnored'
  /** A hunt the user did not play along with (the cursor stopped or left). */
  | 'huntIgnored'
  /** A mischief act played out. */
  | 'mischiefAct'
  | 'pounce'
  | 'caught'
  | 'bat'
  | 'lostInterest'
  | 'missedPounce'
  | 'cursorLost'
  | 'tripFailed'
  /** A deliberate slip that missed its take-off (ADR 0003 §6.6). */
  | 'slipMiss'
  /** Arrived on a window top or tab strip. */
  | 'arrivedUp'
  /** A full screen-edge climb with the top hold. */
  | 'edgeClimb'
  /** A covered-band peek. */
  | 'edgePeek'
  /** A floor place more than 6 body widths from the last five. */
  | 'newFloorPlace'
  /** A rough drag (> 1500 DIP/s for > 300 ms). */
  | 'roughDrag'
  /** A tap beyond three within 8 s. */
  | 'extraTap';

export function applyImpulse(d: Drives, kind: DriveImpulse): void {
  switch (kind) {
    case 'socialAnswered':
      d.socialNeed -= 0.25;
      break;
    case 'attentionIgnored':
      d.socialNeed -= 0.2;
      d.mischief += 0.15;
      break;
    case 'huntIgnored':
      d.mischief += 0.05;
      break;
    case 'mischiefAct':
      d.mischief -= 0.2;
      break;
    case 'pounce':
      d.playNeed -= 0.08;
      d.huntDrive -= 0.25;
      break;
    case 'caught':
      d.huntDrive -= 0.35;
      break;
    case 'bat':
      d.playNeed -= 0.04;
      break;
    case 'lostInterest':
      d.huntDrive *= 0.5;
      break;
    case 'missedPounce':
      d.frustration += 0.2;
      break;
    case 'cursorLost':
      d.frustration += 0.12;
      break;
    case 'tripFailed':
      d.frustration += 0.15;
      break;
    case 'slipMiss':
      d.frustration += 0.1;
      break;
    case 'arrivedUp':
      d.exploreNeed -= 0.25;
      break;
    case 'edgeClimb':
      d.exploreNeed -= 0.2;
      break;
    case 'edgePeek':
      d.exploreNeed -= 0.12;
      break;
    case 'newFloorPlace':
      d.exploreNeed -= 0.05;
      break;
    case 'roughDrag':
      d.irritability += 0.04;
      break;
    case 'extraTap':
      d.irritability += 0.03;
      break;
  }
  clampDrives(d);
}

/** A hard throw (or a rough drag released slowly, at 0.6 of its severity): irritability +0.12 severity. */
export function applyThrowIrritation(d: Drives, severity: number): void {
  d.irritability += 0.12 * clamp01(severity);
  clampDrives(d);
}

/** After a rough-handling reaction of wariness level `wk`: w <- max(w, wk). */
export function raiseWariness(d: Drives, wk: number): void {
  d.wariness = Math.max(unit(d.wariness, 0), clamp01(wk));
}

/** Frantic strokes: more than this many per second. */
export const FRANTIC_STROKES_PER_S = 3;
/** Strokes this soon after a throw irritate rather than soothe. */
export const STROKE_AFTER_THROW_MS = 15_000;

export interface StrokeContext {
  /** 0..1 stroke strength. */
  strength: number;
  /** Strokes in the last second (this one included). */
  strokesLastSecond: number;
  /** ms since the last throw (Infinity: none). */
  sinceThrowMs: number;
  /** Irritability this petting bout has added so far (the caller keeps it per bout). */
  boutIrritation: number;
}

/**
 * One stroke. Social need -0.04 x strength. Gentle (strength >= 0.5, <= 3 strokes/s, not right after
 * a throw): irritability -0.01, wariness x0.85 and fear -0.03. Frantic or right after a throw:
 * irritability +0.03, at most +0.1 per bout. Petting never touches the play need. Returns the
 * irritability added (for the bout total) and whether it was gentle.
 */
export function applyStroke(d: Drives, stats: Stats, c: StrokeContext): { added: number; gentle: boolean } {
  const s = clamp01(c.strength);
  d.socialNeed -= 0.04 * s;
  const frantic = c.strokesLastSecond > FRANTIC_STROKES_PER_S;
  const afterThrow = c.sinceThrowMs < STROKE_AFTER_THROW_MS;
  let added = 0;
  let gentle = false;
  if (frantic || afterThrow) {
    added = Math.max(0, Math.min(0.03, STROKE_IRRITATION_PER_BOUT - Math.max(0, c.boutIrritation)));
    d.irritability += added;
  } else if (s >= 0.5) {
    gentle = true;
    d.irritability -= 0.01;
    d.wariness *= 0.85;
    stats.fear = clamp01(stats.fear - 0.03);
  }
  clampDrives(d);
  return { added, gentle };
}

/** Fear impulses scale with the startle sensitivity: x (0.5 + sigma). */
export function addFear(stats: Stats, traits: Pick<Traits, 'startleSensitivity'>, amount: number): void {
  if (!Number.isFinite(amount)) return;
  stats.fear = clamp01(stats.fear + amount * (0.5 + unit(traits.startleSensitivity, 0.5)));
}

/** v1.1 boredom stays as a display value: max(play need, explore need), so a 1.1.1 downgrade sees a sensible value. */
export function boredomDisplay(d: Drives): number {
  return clamp01(Math.max(unit(d.playNeed, 0.4), unit(d.exploreNeed, 0.4)));
}
