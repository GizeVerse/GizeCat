// v1.2 behaviour profile (ADR 0003 §11): what the cat did, as kinds, counts and durations only.
// Never window ids, titles, process names, positions of other apps or anything the user typed.
// Produced by the simulation (CatSim.behaviorProfile(), SimHooks records), shown in Settings ->
// Diagnostics, included in the diagnostics export and summarised in a rate-limited stay log line.
import type { BehaviorState, JumpKind, LandingImpact } from './cat';
import type { SupportSurfaceKind } from './surfaces';

/** Coarse class of every behaviour state; the target bands (ADR 0003 §14) are stated in these. */
export const ACTIVITY_CLASSES = ['asleep', 'calm', 'active', 'interaction', 'reaction', 'physical', 'away'] as const;
export type ActivityClass = (typeof ACTIVITY_CLASSES)[number];

/** Same mapping as the v1.2 diagnosis harness (tests/profile/behaviorProfile.ts STATE_CATEGORY). */
export const ACTIVITY_CLASS: Readonly<Record<BehaviorState, ActivityClass>> = {
  sleeping: 'asleep',
  fallingAsleep: 'asleep',
  wakingUp: 'asleep',
  idle: 'calm',
  resting: 'calm',
  grooming: 'calm',
  watchingUser: 'calm',
  watchingCursor: 'calm',
  curious: 'calm',
  inspectingWindow: 'calm',
  walking: 'active',
  running: 'active',
  chasingCursor: 'active',
  playing: 'active',
  seekingAttention: 'active',
  jumping: 'active',
  beingPetted: 'interaction',
  held: 'interaction',
  startled: 'reaction',
  annoyed: 'reaction',
  hiding: 'reaction',
  falling: 'physical',
  landing: 'physical',
  away: 'away',
};

/**
 * Variants whose class differs from their state's (ADR 0003 §1.4, review C2): the scorer, the
 * rhythm and the profile all classify through activityClassOf, so B1 measures what the model
 * controls. 'inspectingWindow:explore' is the trip up onto a window top (walking, jumping).
 */
export const VARIANT_ACTIVITY_CLASS: Readonly<Record<string, ActivityClass>> = {
  'inspectingWindow:explore': 'active',
};

/** Class of a running activity: its `state:variant` override, else its state's class. */
export function activityClassOf(state: BehaviorState, variant: string | null): ActivityClass {
  if (variant !== null) {
    const o = VARIANT_ACTIVITY_CLASS[`${state}:${variant}`];
    if (o) return o;
  }
  return ACTIVITY_CLASS[state] ?? 'calm';
}

/** Elevated surfaces a stay is counted on. */
export const STAY_SURFACE_KINDS = ['windowTop', 'tabStrip'] as const;
export type StaySurfaceKind = (typeof STAY_SURFACE_KINDS)[number];

/** How the cat got onto the surface of a stay. */
export const ARRIVAL_ROUTES = ['climb', 'leap', 'jump', 'hop', 'wallJump', 'walk', 'carried', 'other'] as const;
export type ArrivalRoute = (typeof ARRIVAL_ROUTES)[number];

/** The one way off an elevated surface the stay model's leave intent picks (ADR 0003 §2). */
export const LEAVE_KINDS = ['jumpDown', 'climbDown', 'climbLeap', 'hop', 'walkOff'] as const;
export type LeaveKind = (typeof LEAVE_KINDS)[number];

/** How an imposed stay end (covered / gone) was handled: a controlled bail-out, or none (a fall). */
export type BailOutKind = 'hop' | 'jump' | 'wall' | 'emergency';

/** Why a stay ended. 'leave' = the cat's own leave intent (see LeaveKind); everything else was imposed. */
export const STAY_END_REASONS = ['leave', 'drag', 'covered', 'gone', 'called', 'stimulus', 'disabled', 'fullscreen', 'slip', 'other'] as const;
export type StayEndReason = (typeof STAY_END_REASONS)[number];

/** Reactions to a throw or rough handling (ADR 0003 §5). */
export const THROW_REACTIONS = ['shrug', 'surprise', 'startledJump', 'grumpy', 'defensive', 'flight', 'playful', 'avoid', 'hide'] as const;
export type ThrowReactionKind = (typeof THROW_REACTIONS)[number];

/**
 * Why the cat was airborne without planning it. 'covered' (support covered and no bail-out) and
 * 'physics' (any other loss the cat did not choose: headroom, stale plan, re-validation snap) are
 * physics errors: the target band is 0 (ADR 0003 §12). Planned jumps and drops are not falls.
 */
export const FALL_CAUSES = ['thrown', 'dropped', 'slip', 'gone', 'retracted', 'covered', 'physics'] as const;
export type FallCause = (typeof FALL_CAUSES)[number];
export const PHYSICS_ERROR_CAUSES: ReadonlySet<FallCause> = new Set<FallCause>(['covered', 'physics']);

export const HUNT_OUTCOMES = ['caught', 'missed', 'lostInterest', 'interrupted'] as const;
export type HuntOutcome = (typeof HUNT_OUTCOMES)[number];

/** Why a hunt ended early ('interrupted' outcome) or never started past 'notice' (ADR 0003 §4.3). */
export const HUNT_GATES = ['typing', 'button', 'click', 'petting', 'taskbar', 'stripContainer', 'caption', 'wary', 'budget', 'command', 'other'] as const;
export type HuntGate = (typeof HUNT_GATES)[number];

/** Mood exposure tracked as time above a threshold (ADR 0003 §14 B8b): wariness > 0.3, irritability > 0.5, fear > 0.3. */
export const MOOD_EXPOSURES = ['wary', 'irritable', 'fearful'] as const;
export type MoodExposure = (typeof MOOD_EXPOSURES)[number];
export const MOOD_EXPOSURE_THRESHOLDS: Readonly<Record<MoodExposure, number>> = { wary: 0.3, irritable: 0.5, fearful: 0.3 };

/** Rhythm episode a decision was made in (ADR 0003 §1.5); 'none' before the scheduler exists. */
export type RhythmEpisode = 'calm' | 'active' | 'none';

/** One autonomous (or stimulus-driven) decision. */
export interface DecisionRecord {
  at: number;
  state: BehaviorState;
  /** Variant id of the chosen candidate, or null. */
  variant: string | null;
  /** 'watchdog': the progress monitor reset a stuck activity (ADR 0003 §6.9; band B14 wants none). */
  cause: 'autonomous' | 'stimulus' | 'stay' | 'leave' | 'watchdog';
  /** Class of the chosen activity (activityClassOf), the same table the profile's time uses. */
  activityClass: ActivityClass;
  /** Utility of the chosen and of the best candidate, and how many feasible candidates there were (null: not scored). */
  utility: number | null;
  bestUtility: number | null;
  candidates: number;
  episode: RhythmEpisode;
  standingOn: 'floor' | SupportSurfaceKind;
  typing: boolean;
}

/** An elevated stay starting ('arrive') or ending ('end'). */
export interface ExcursionRecord {
  phase: 'arrive' | 'end';
  at: number;
  surfaceKind: StaySurfaceKind;
  arrivedBy: ArrivalRoute;
  /** Stay intent drawn on arrival, ms (0: none drawn). */
  plannedMs: number;
  /** 'end' only (0 / null on 'arrive'). */
  dwellMs: number;
  endReason: StayEndReason | null;
  leaveKind: LeaveKind | null;
  /** 'end' with endReason covered/gone: how the cat got off (null: it fell, a physics error when covered). */
  bailOut?: BailOutKind | null;
  /** 'arrive': this stay resumes one a cover or a vanished window cut short (ADR 0003 §2.4 resume token). */
  resumed?: boolean;
  /** 'end': it ran more than STAY_OVERDUE_MS past its plan (a leave kept failing or was put off). */
  overdue?: boolean;
}

export interface FallRecord {
  at: number;
  cause: FallCause;
  /** Height fallen from the highest point of the flight, DIP. */
  heightDip: number;
  impact: LandingImpact;
  jumpKind: JumpKind | null;
}

export interface ReactionRecord {
  at: number;
  kind: ThrowReactionKind;
  /** Release speed, DIP/s. */
  speedDip: number;
  impact: LandingImpact;
  /** What triggered it: a throw, or a rough drag released slowly (ADR 0003 §5). */
  trigger?: 'throw' | 'roughDrag';
  /** The hide / 50 % caps changed the softmax for this draw (B7 wants this in < 10 % of draws). */
  capped?: boolean;
  /** Landed on an elevated ledge with little room (the ℓ input). */
  onLedge?: boolean;
}

export interface HuntRecord {
  /** When the hunt ended (sim ms). */
  at: number;
  /** When it started (left 'notice'), sim ms. */
  startedAt?: number;
  durationMs: number;
  pounces: number;
  /** Sim times of the pounces' take-offs (B5: never two within 90 s). */
  pounceTimes?: number[];
  /**
   * Smallest distance (DIP) between the cursor hotspot and the cat's predicted hit region at any
   * pounce landing or strike of this hunt (T8; the band wants >= 8). null: no pounce or strike.
   */
  minClearanceDip?: number | null;
  outcome: HuntOutcome;
  /** For 'interrupted': which gate ended it. */
  gate?: HuntGate | null;
}

/** A deliberate slip (ADR 0003 §6.6); a 'miss' also ends in a FallRecord with cause 'slip'. */
export interface SlipRecord {
  at: number;
  kind: 'scramble' | 'miss';
  /** nextLegRisk of the take-off, 0..1. */
  risk: number;
}

/** A screen-edge climb (ADR 0003 §6.1). Sides only: never which window covered the band. */
export interface EdgeVisitRecord {
  at: number;
  side: 'left' | 'right';
  /** The band was covered by an app window (a short, low, click-through peek). */
  covered: boolean;
  /** Reached the top-corner hold. */
  topReached: boolean;
  holdMs: number;
  /** How it left the wall. */
  leave: 'climbDown' | 'wallJump' | 'drag' | 'gone' | 'other';
}

export interface Quantiles {
  n: number;
  p10: number;
  p50: number;
  p90: number;
  max: number;
}

/** Rolling, session-scoped summary (sim clock). Counts, kinds and durations only. */
export interface BehaviorProfileSnapshot {
  /** Sim clock (ms) when counting started, and when this snapshot was taken. */
  since: number;
  at: number;
  timeMs: Record<ActivityClass, number>;
  /** Active share of awake time (asleep and away excluded), 0..1. */
  activeShare: number;
  decisions: number;
  excursions: {
    arrivals: number;
    byKind: Partial<Record<StaySurfaceKind, number>>;
    /** Finished stays, seconds. */
    dwellS: Quantiles;
    byEnd: Partial<Record<StayEndReason, number>>;
    byLeave: Partial<Record<LeaveKind, number>>;
  };
  hunts: { count: number; pounces: number; byOutcome: Partial<Record<HuntOutcome, number>> };
  falls: { count: number; byCause: Partial<Record<FallCause, number>>; byImpact: Partial<Record<LandingImpact, number>> };
  /** Deliberate slips of both kinds (SlipRecord); misses also count in falls.byCause.slip. */
  slips: number;
  reactions: Partial<Record<ThrowReactionKind, number>>;
  screenEdgeVisits: number;
  /** Of those, peeks over a covered band. */
  screenEdgePeeks: number;
  /** Entries into the asleep class (naps). */
  sleeps: number;
  /** Progress-monitor resets of a stuck activity (B14: 0). */
  stuckResets: number;
  /** Time (ms) a mood stayed above its MOOD_EXPOSURE_THRESHOLDS value. */
  moodMs: Record<MoodExposure, number>;
  /**
   * Content-free context durations (ms of sim time), so a packaged build's profile can be read
   * against what the user was doing: keyboard-like input, a maximized window in front, the cursor
   * moving within hunting reach.
   */
  context: Record<ProfileContext, number>;
  /** Most recent finished stays, oldest first (the stay log line reads these). */
  recentStays: ExcursionRecord[];
}

export const PROFILE_CONTEXTS = ['typing', 'foregroundMaximized', 'cursorInReach'] as const;
export type ProfileContext = (typeof PROFILE_CONTEXTS)[number];

export const MAX_RECENT_STAYS = 20;
/** Finished stays kept for the dwell quantiles. */
export const MAX_DWELL_SAMPLES = 256;
/** The 'stay ended' log line (main): at most one per this gap and this many per hour. */
export const STAY_LOG_MIN_GAP_MS = 20_000;
export const STAY_LOG_MAX_PER_HOUR = 60;

export const emptyQuantiles = (): Quantiles => ({ n: 0, p10: 0, p50: 0, p90: 0, max: 0 });

export function emptyBehaviorProfile(now: number): BehaviorProfileSnapshot {
  const at = Number.isFinite(now) ? now : 0;
  return {
    since: at,
    at,
    timeMs: { asleep: 0, calm: 0, active: 0, interaction: 0, reaction: 0, physical: 0, away: 0 },
    activeShare: 0,
    decisions: 0,
    excursions: { arrivals: 0, byKind: {}, dwellS: emptyQuantiles(), byEnd: {}, byLeave: {} },
    hunts: { count: 0, pounces: 0, byOutcome: {} },
    falls: { count: 0, byCause: {}, byImpact: {} },
    slips: 0,
    reactions: {},
    screenEdgeVisits: 0,
    screenEdgePeeks: 0,
    sleeps: 0,
    stuckResets: 0,
    moodMs: { wary: 0, irritable: 0, fearful: 0 },
    context: { typing: 0, foregroundMaximized: 0, cursorInReach: 0 },
    recentStays: [],
  };
}

/** Nearest-rank quantiles of `values` (any order). */
export function quantiles(values: readonly number[]): Quantiles {
  const v = values.filter((x) => Number.isFinite(x)).sort((a, b) => a - b);
  if (v.length === 0) return emptyQuantiles();
  const q = (p: number): number => v[Math.min(v.length - 1, Math.max(0, Math.ceil(p * v.length) - 1))] as number;
  return { n: v.length, p10: q(0.1), p50: q(0.5), p90: q(0.9), max: v[v.length - 1] as number };
}
