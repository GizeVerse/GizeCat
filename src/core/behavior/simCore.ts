// The cat simulation, layer 1 of 9: state, helpers, transitions, modes, physics coupling and the
// profile emitters. The layers (simDrives, simStay, simHunt, simReactions, simSalience, simUtility,
// simActivities, sim) extend it in that order; sim.ts is the public face (CatSimImpl). The pure
// models they use live in drives.ts, utility.ts, rhythm.ts, stay.ts, hunt.ts, reactions.ts,
// salience.ts and watchdog.ts. Pure TypeScript; time, randomness and the environment are injected.
import type { AnimClip, BehaviorState, CatReaction, CatReactionKind, CatSoundCue, SoundCue } from '../../shared/cat';
import type {
  ArrivalRoute,
  BailOutKind,
  DecisionRecord,
  EdgeVisitRecord,
  ExcursionRecord,
  FallRecord,
  HuntGate,
  HuntRecord,
  LeaveKind,
  ReactionRecord,
  RhythmEpisode,
  SlipRecord,
  StaySurfaceKind,
  ThrowReactionKind,
} from '../../shared/behaviorProfile';
import { activityClassOf } from '../../shared/behaviorProfile';
import type { SubBehavior } from '../../shared/behaviorGates';
import { subBehaviorAllowed } from '../../shared/behaviorGates';
import type { PersistedCat } from '../../shared/catState';
import type { Point, Rect } from '../../shared/geometry';
import { clamp, isFiniteRect } from '../../shared/geometry';
import type { BehaviorId, Settings } from '../../shared/settings';
import { disabledBehaviorSet } from '../../shared/settings';
import type { CatSimOptions, SimEnv, SimRequest } from '../../shared/sim';
import type { DecisionTarget, TargetAvailability } from '../../shared/surfaceDiagnostics';
import type { LedgeSurface, Surface as EnvSurface, WallSurface } from '../../shared/surfaces';
import type { LeaveOption, MoverConfig, MoverStep, Pace, RoutePreference, SlipKind, SupportLoss } from '../movement';
import { MOVEMENT, Mover } from '../movement';
import type { Activity, ActivityInit, FollowUp } from './activity';
import { makeActivity } from './activity';
import type { Phase } from './clips';
import type { Candidate, DecisionView, EdgeTarget, Variant } from './decide';
import { sleepiness, userIdleForSleep } from './decide';
import { decayForDowntime } from './drives';
import { EmoteController } from './emotes';
import { CursorTracker, huntBaseline, TYPING_HOLD_MS } from './hunt';
import type { MemoryDetail } from './memory';
import { bumpCounter, rankedSpots, remember } from './memory';
import { migrateCatState } from './migrate';
import { newPersistedCat } from './personality';
import { BehaviorProfileRecorder } from './profile';
import type { Random } from './random';
import { chance, range, safeRandom } from './random';
import type { TransitionCause } from './states';
import type { RoughKind } from './reactions';
import { ROUGH_MEMORY_MS as ROUGH_LIST_MS, RoughMemory } from './reactions';
import { Rhythm } from './rhythm';
import { EventDedupe } from './salience';
import { ACTIVE_STATES, ASLEEP_STATES, canTransition, findPath, guardsFor, isCountedTransition, MAX_STATE_CHANGES_PER_WINDOW, mayInterrupt, PHYSICAL_STATES, REACTION_STATES, STATE_CHANGE_WINDOW_MS, STATE_SPECS } from './states';
import { jumpDownLimitsFor } from './stay';
import { Cooldowns, Habituation, RecentIds } from './stimuli';
import { candidateKey, pickWithVariety, scoreAll, variantAllowed } from './utility';
import { ProgressMonitor } from './watchdog';

export type SimMode = 'normal' | 'paused' | 'quiet' | 'locked' | 'away' | 'quit';
export type RequestStatus = 'ok' | 'blocked' | 'invalid';
/** 'retracted': the surface went away calmly under the cat (taskbar auto-hide, covered window): never startling. */
export type FallReason = 'drop' | 'throw' | 'perch' | 'step' | 'jump' | 'retracted';

export interface TransitionRecord {
  at: number;
  from: BehaviorState;
  to: BehaviorState;
  cause: TransitionCause;
  /** Time since the activity being left started, ms. */
  dwellMs: number;
  /** The activity being left had finished its job. */
  fromDone: boolean;
  counted: boolean;
}

export interface SimHooks {
  onTransition?: (r: TransitionRecord) => void;
  // ---- v1.2 (ADR 0003 §11): the records the behaviour profile is built from ----------------
  /** Every decision that started an activity (autonomous now; stay/leave/stimulus once v1.2 lands). */
  onDecision?: (r: DecisionRecord) => void;
  /** An elevated stay started (phase 'arrive') or ended (phase 'end'). */
  onExcursion?: (r: ExcursionRecord) => void;
  /** An unplanned airborne phase ended (throws, drops, lost supports, slips). Planned jumps are not falls. */
  onFall?: (r: FallRecord) => void;
  /** The reaction chosen after a throw or rough handling (v1.2 reaction model). */
  onReaction?: (r: ReactionRecord) => void;
  /** A cursor hunt ended (v1.2 hunting model). */
  onHunt?: (r: HuntRecord) => void;
  /** A deliberate slip happened (v1.2 slips; a 'miss' also reports onFall with cause 'slip'). */
  onSlip?: (r: SlipRecord) => void;
  /** A screen-edge climb ended (v1.2 screen edges). */
  onEdgeVisit?: (r: EdgeVisitRecord) => void;
}

/** Hard floor between perception requests; the user's minimum interval applies above it. */
export const PERCEPTION_FLOOR_MS = 5000;
export const SAVE_MIN_INTERVAL_MS = 60_000;
/** Body-language reactions (ear flick, tail flick, head tilt) start at most this often. */
export const REACTION_MIN_GAP_MS = 400;
/** How long a reaction stays in the output (the renderer plays it once per distinct start time). */
export const REACTION_HOLD_MS = 2000;
/** A call or play command is never ignored more often than this, and never twice in a row. */
export const MAX_COMMAND_IGNORE_CHANCE = 0.35;
/** Typical chase length at chaseDurationSec = 4.5 (the middle of the chasingCursor dwell range). */
export const NOMINAL_CHASE_SEC = 4.5;
/** How long the look of the screen from local statistics stays relevant. */
export const SCREEN_FRESH_MS = 3 * 60_000;
/** Rough handling is remembered this long (wall clock, so it survives a restart). */
export const ROUGH_MEMORY_MS = 60 * 60_000;
export const SURPRISE_COOLDOWN_MS = 20 * 60_000;
export const POUNCE_COOLDOWN_MS = 6000;
export const PLAY_RETREAT_COOLDOWN_MS = 2 * 60_000;
/** Closing speed (body lengths/s) of the pointer that a playful cat dodges. */
export const PLAY_RETREAT_APPROACH_BL_S = 4;
export const QUIT_DEADLINE_MS = 900;
export const FADE_MS = 400;
export const PET_RATE_TAU_MS = 2 * 3600_000;
export const PET_SESSION_GAP_MS = 10_000;
/** Annoyance one full-strength stroke adds to a reacting or irritated cat (scaled by 1.3 - patience). */
export const PET_IRRITATION = 0.15;
/** At most this much annoyance from one petting bout of a reacting or irritated cat. */
export const PET_BOUT_ANNOYANCE_MAX = 0.1;
/** At least this annoyed, the cat hides after a reaction and refuses to be stroked. */
export const IRRITATED_ANNOYANCE = 0.6;
export const TAP_WINDOW_MS = 8000;
export const SPOT_LEARN_MIN_MS = 60_000;
export const SPOT_FLUSH_MS = 5 * 60_000;
export const DRAG_LOST_MS = 1500;
export const LANDING_MS = 250;
/** Longest a walk/run toward a destination may take before the cat gives up. */
export const TRAVEL_TIMEOUT_MS = 40_000;
/** Climbing is slow: a climb may take this long before the cat gives up. */
export const CLIMB_TIMEOUT_MS = 90_000;
/** Most environment surfaces the sim looks at per tick (the provider caps its list too). */
export const MAX_SURFACES = 256;
/** Window rects learned from events stay usable this long without fresh geometry. */
export const WINDOW_RECT_TTL_MS = 60_000;
export const MAX_WINDOW_RECTS = 64;
/** Surfaces below this confidence are not used for new moves (the one the cat is on is kept). */
export const MIN_SURFACE_CONFIDENCE = 0.25;
/** Taskbar reactions: at most one decision per this many ms, however often it flaps. */
export const TASKBAR_REACT_GAP_MS = 4000;
export const TASKBAR_LOOK_COOLDOWN_MS = 20_000;
export const TASKBAR_HOP_COOLDOWN_MS: readonly [number, number] = [120_000, 300_000];
export const TASKBAR_WAKE_COOLDOWN_MS = 10 * 60_000;
export const CLIMB_COOLDOWN_MS: readonly [number, number] = [90_000, 240_000];
export const TAB_VISIT_COOLDOWN_MS = 120_000;
export const TAB_INVESTIGATE_COOLDOWN_MS = 60_000;
/** "Never in the way" (ADR 0003 §14): trips up in any rolling hour, so window churn cannot push climbs past the ceiling of 12. */
export const TRIPS_PER_HOUR_MAX = 8;
/** While the user is typing (or typed in the last minute) trips up keep at least this far apart (B6: 0.2-0.6 x the rate of a user who is not typing). */
export const TYPING_TRIP_GAP_MS = 20 * 60_000;
/** Between two hides the cat decides on by itself (rough-handling memory); reactions are not limited by it. */
export const AUTO_HIDE_COOLDOWN_MS: readonly [number, number] = [6 * 60_000, 12 * 60_000];
/** After a nap the cat does not settle down for another one this soon (B15: 0.8-2.5 naps per hour; interrupted naps do not stack up). */
export const NAP_COOLDOWN_MS: readonly [number, number] = [13 * 60_000, 24 * 60_000];
/** A nap of its own runs this much longer than the state's dwell (B15: handling at the REAL rate wakes many early). */
export const NAP_DWELL_MUL = 1.6;
/**
 * v1.1.1: a trip up that failed (unreachable when tried, timed out, turned back on the side, let
 * go, target lost) is retried after this instead of the full climb / tab-strip visit cooldown.
 */
export const EXCURSION_RETRY_MS: readonly [number, number] = [15_000, 40_000];
/** An approach to a window top may take as long as its route needs (walk, leap, climb), within these bounds. */
export const APPROACH_MIN_MS = 15_000;
export const APPROACH_MAX_MS = 60_000;
/** Window tops / tab strips checked for a way up per decision, nearest first (bounded planner cost). */
export const PERCH_CANDIDATES = 6;
export const STRIP_CANDIDATES = 4;
/** What the exploration urge counts as within reach is refreshed at most this often. */
export const URGE_SCAN_MS = 2000;
/** Up on a top, the cat explores it before it heads back down: at least this long, ... */
export const TOP_MIN_STAY_MS = 20_000;
/** ... having walked this many body lengths along it (a short top: its length), ... */
export const TOP_PATROL_BL = 2;
/** ... or this long at the most. */
export const TOP_MAX_EXPLORE_MS = 60_000;
/** Longest tick the simulation integrates; the host clamps dt to the same 250 ms. */
export const MAX_SIM_DT_MS = 250;
/** How far the paws of a cat on a wall reach past the wall line into the window, body lengths (~5.5 DIP). */
export const WALL_PAW_REACH_BL = 0.065;
/**
 * Slowest tick the sim asks for (hidden, or asleep outside normal mode). It stays clear
 * of MAX_SIM_DT_MS so a timer that fires a little late still delivers its whole delay
 * as dt: sim time keeps pace with real time instead of being clamped.
 */
export const SLOWEST_TICK_MS = 200;
/** v1.2 sound (ADR 0003 §10): at most one cue per this gap. */
export const SOUND_MIN_GAP_MS = 1500;
/** v1.2 decisions remember this many repetition keys. */
export const RECENT_KEYS = 8;
/** v1.2 place novelty: a place visited within this long is 'recent'. */
export const PLACE_RECENT_MS = 20 * 60_000;
/** v1.2 hold-still zone: the hotspot within this many body widths of the hit region pauses take-offs and walking for up to HOLD_STILL_MAX_MS. */
export const HOLD_STILL_BW = 0.5;
export const HOLD_STILL_MAX_MS = 3000;

/** States whose handler decides when they end (the generic dwell rule does not apply). */
export const SELF_TIMED: ReadonlySet<BehaviorState> = new Set<BehaviorState>([
  'walking',
  'running',
  'chasingCursor',
  'sleeping',
  'wakingUp',
  'fallingAsleep',
  'startled',
  'annoyed',
  'beingPetted',
  'held',
  'jumping',
  'falling',
  'landing',
  'away',
]);

export const AROUSAL: Readonly<Record<BehaviorState, number>> = {
  sleeping: 0.05,
  wakingUp: 0.3,
  fallingAsleep: 0.12,
  idle: 0.3,
  walking: 0.4,
  running: 0.85,
  chasingCursor: 0.95,
  watchingCursor: 0.6,
  curious: 0.6,
  inspectingWindow: 0.55,
  watchingUser: 0.35,
  playing: 0.9,
  beingPetted: 0.35,
  startled: 1,
  annoyed: 0.75,
  seekingAttention: 0.55,
  resting: 0.15,
  grooming: 0.25,
  hiding: 0.7,
  held: 0.7,
  jumping: 0.8,
  falling: 0.85,
  landing: 0.6,
  away: 0.1,
};

export const CONTENTMENT_BIAS: Partial<Record<BehaviorState, number>> = {
  beingPetted: 0.4,
  sleeping: 0.2,
  resting: 0.15,
  grooming: 0.1,
  playing: 0.1,
  annoyed: -0.35,
  startled: -0.3,
  hiding: -0.2,
  held: -0.15,
};

export const ZERO: Point = { x: 0, y: 0 };

/** Where the cat can go up from where it stands, and why not (v1.1.1; reachability ignores cooldowns). */
export interface TargetScan {
  at: number;
  perch: { windowId: string; point: Point } | null;
  /** v1.2: `ownerId` names the window (place novelty, in memory only). */
  climb: { point: Point; dir: 'up' | 'down'; ownerId?: string } | null;
  /** A tab strip to visit: its height and resting span (v1.2: and its window, for place novelty). */
  strip: { y: number; rest: { x0: number; x1: number }; ownerId?: string | null } | null;
  status: Record<DecisionTarget, TargetAvailability>;
}

export const NO_TARGETS: Record<DecisionTarget, TargetAvailability> = { perch: 'noSurfaces', climb: 'noSurfaces', tabStrip: 'noSurfaces' };
export const EMPTY_SCAN: TargetScan = { at: -Infinity, perch: null, climb: null, strip: null, status: NO_TARGETS };

/**
 * v1.2 elevated stay (window top or tab strip, ADR 0003 §2): the intent drawn on arrival, the leave
 * attempts, and how the cat is leaving (`via`) while it is not standing on the stay's surface; the
 * stay ends once it stands elsewhere.
 */
export interface StayTrack {
  kind: StaySurfaceKind;
  surfaceId: string;
  /** The window the surface belongs to (in memory only: place novelty). */
  ownerId: string | null;
  since: number;
  lastOnAt: number;
  arrivedBy: ArrivalRoute;
  via: 'none' | 'held' | 'wall' | 'jump' | 'step' | 'fall' | 'covered' | 'gone' | 'disabled' | 'slip';
  /** The stay intent (ms), extended by naps up there (never beyond the hard cap). */
  plannedMs: number;
  /** Time asleep on the stay so far (naps extend the plan). */
  napMs: number;
  /** The leave intent: not before this (backoff, deferral while petted). */
  nextLeaveAt: number;
  /** Failed leave attempts and when they happened. */
  failures: number[];
  /** The leave under way (its kind once it is known), or null. */
  leaving: LeaveKind | null;
  /** The chosen option, until the walking:leave activity starts it (the transition may take a stepping stone). */
  pendingLeave: LeaveOption | null;
  /** The Mover carries out the leave (Mover.leaveBy); the activity only waits for it. */
  byMover: boolean;
  /** How a covered or vanished support was left (ADR 0003 §3). */
  bailOut: BailOutKind | null;
  /** A resumed stay (ADR 0003 §2.4). */
  resumed: boolean;
  /** The leave was forced by a need, not by the plan's end (end reason 'stimulus', ADR 0003 §2.4). */
  forcedLeave: boolean;
  /** 'stay overdue' was counted for this stay. */
  overdue: boolean;
}

/** v1.2: the screen-edge visit under way (ADR 0003 §6.1); one EdgeVisitRecord when the cat is off the wall. */
export interface EdgeVisit {
  target: EdgeTarget | null;
  /** The activity that went there (null: a bail-out put the cat on the edge). */
  act: Activity | null;
  startedAt: number;
  /** Clinging to the edge since (null: still on its way). */
  mountedAt: number | null;
  holdMs: number;
  /** When the hold began and when it ends (null: not yet). */
  holdFrom: number | null;
  holdUntil: number | null;
  /** Leaving the wall: climbing down, or the leave option taken. */
  leaving: LeaveOption['kind'] | 'retreat' | null;
  /** How the visit is going to be recorded when it ends. */
  side: 'left' | 'right';
}

/** v1.2: the hunt being played (ADR 0003 §4.2); one HuntRecord when it ends. */
export interface HuntRun {
  /** When it left 'notice', sim ms (null: still noticing). */
  startedAt: number;
  /** Stalk-to-bat cycles started, and when the current one began. */
  cycles: number;
  cycleStartedAt: number;
  pounces: number;
  pounceTimes: number[];
  /** Smallest predicted clearance of a pounce landing or strike, px (null: none yet). */
  minClearancePx: number | null;
  /** The cursor was caught (within 1 bw of the paw point at a landing) at least once. */
  caught: boolean;
  /** When the cursor was last in the start band, and where. */
  seenAt: number;
  seenAtPoint: Point | null;
  /** Set when the hunt is over (the record is emitted once). */
  ended: boolean;
  /** This cycle's stalk stand-off from the hotspot, body widths (1.5-2.5), and the current stalk pause's end. */
  standoffBw: number;
  /** How long this cycle's crouch waits for a still prey, ms. */
  crouchWaitMs: number;
  pauseUntil: number;
  /** Where the last stalk pause ended (x, px) and after how many body widths of creeping the next one comes (1-2). */
  pauseFromX: number;
  pauseEveryBw: number;
}

/** One trip up the cat set out on (exploring a top, climbing a side, visiting a tab strip). */
export interface Excursion {
  kind: DecisionTarget;
  act: Activity;
  /** The surface it set out from (null: the floor), and whether that was already up on a window. */
  from: string | null;
  fromElevated: boolean;
  /** Got onto a window side (leaping or stepping on) on the way. */
  leftGround: boolean;
  arrived: boolean;
}

export const isElevatedKind = (k: string | null | undefined): boolean => k === 'windowTop' || k === 'tabStrip';
export const isFinitePoint = (p: Point | null | undefined): p is Point => !!p && Number.isFinite(p.x) && Number.isFinite(p.y);

export abstract class SimCore {
  protected cat: PersistedCat;
  protected settings: Settings;
  /** Switched-off behaviours: disabledBehaviorSet (both lists, the implied opt-outs). */
  protected disabled: ReadonlySet<BehaviorId>;
  protected readonly random: Random;
  protected readonly wallClock: () => number;
  protected readonly mover: Mover;
  protected readonly emotes = new EmoteController();
  protected readonly habit = new Habituation();
  /** Surface appearances (taskbar shows, tab changes) habituate quickly: the second show matters much less. */
  protected readonly surfaceHabit = new Habituation(120_000, 0.4);
  protected readonly reactions = new Cooldowns();
  /** This tick's environment surfaces by id, and by owning window. */
  protected readonly surfaceIndex = new Map<string, EnvSurface>();
  protected readonly ownerIndex = new Map<string, EnvSurface[]>();
  /** Window rects learned from events (in memory only), for windows without usable surface geometry. */
  protected readonly windowRects = new Map<string, { rect: Rect; at: number }>();
  protected readonly seenWindows = new RecentIds(128);
  /** Windows the host marked as private: the cat does not follow, inspect or climb onto them. */
  protected readonly excludedWindows = new RecentIds(64);
  protected readonly movingWindows = new Set<string>();
  protected readonly cooldownUntil = new Map<BehaviorState, number>();
  protected readonly changeTimes: number[] = [];
  protected readonly recentStates: BehaviorState[] = [];
  protected readonly log: TransitionRecord[] = [];
  protected readonly hooks: SimHooks;

  protected act: Activity;
  protected suspended: Activity | null = null;
  protected pending: { state: BehaviorState; init: ActivityInit; expiresAt: number } | null = null;
  protected now: number;
  protected dt = 0;
  protected env: SimEnv | null = null;
  protected requests: SimRequest[] = [];
  protected mode: SimMode = 'normal';
  protected quitting = false;
  protected quitAt = 0;
  protected quitReadySent = false;
  protected systemLocked = false;
  protected systemSuspended = false;
  protected awayWasAsleep = false;
  protected awaySince = 0;
  protected fade = 0;
  protected snapNext = true;
  protected clip: AnimClip = 'sit';
  protected clipStartedAt: number;
  protected restartClip = false;
  protected arousal = 0.3;
  protected contentment = 0.5;
  protected glance: { target: Point; until: number } | null = null;
  protected oneShot: { clip: AnimClip; until: number } | null = null;
  protected reaction: CatReaction | null = null;
  protected lastCommandIgnored = false;
  protected commandsIgnored = 0;
  protected screen: { kind: 'video' | 'busy' | 'quiet'; until: number } | null = null;
  protected prevCursorDistBl: number | null = null;
  protected lastPerceptionAt = -Infinity;
  protected lastSaveAt = -Infinity;
  protected dirty = false;
  protected tapTimes: number[] = [];
  protected petTimes: number[] = [];
  protected lastPetCountedAt = -Infinity;
  protected lastPetMemoryAt = -Infinity;
  protected lastPetEventAt = -Infinity;
  protected lastDragCursorAt = 0;
  protected lastCursorSeenAt = -Infinity;
  protected busyUntil = -Infinity;
  protected darkUntil = -Infinity;
  protected typing = false;
  protected restAccumMs = 0;
  protected awakeSince: number;
  protected fallReason: FallReason | null = null;
  protected nextDecisionAt = -Infinity;
  protected nextAdvanceAt = -Infinity;
  protected nextDriveAt = -Infinity;
  /** Where goTo last sent the mover; what it is heading for while the mover still pursues it (diagnostics). */
  protected goalPoint: Point | null = null;
  /** v1.1.1 exploration: the urge (DecisionView.exploreUrge), what is reachable, the trip under way, the top being explored. */
  protected exploreUrge = 0;
  protected scan: TargetScan = EMPTY_SCAN;
  protected decisionTargets: Record<DecisionTarget, TargetAvailability> = { ...NO_TARGETS };
  protected excursion: Excursion | null = null;
  protected wasElevated = false;
  protected topVisit: { surfaceId: string; since: number; x0: number; walked: number } | null = null;
  protected lastElevatedAt = 0;
  protected excursionCount = 0;
  protected invalidRequests = 0;
  protected readonly invalidSamples: string[] = [];
  protected eventErrors = 0;
  protected transitionsTotal = 0;
  /** v1.2 behaviour profile (ADR 0003 §11) and the stay being tracked for it. */
  protected readonly profile: BehaviorProfileRecorder;
  protected stay: StayTrack | null = null;
  /** The lonely leave (ADR 0003 §2.4): armed, and when it last fired. */
  protected lonelyArmed = true;
  protected lastLonelyAt = -Infinity;
  /** How the cat was attached last tick (arrival route of a stay). */
  protected prevAttach: 'ground' | 'wall' | 'air' | 'held' = 'ground';
  /** Why the support was lost most recently (fall cause of the next landing). */
  protected lastLossReason: SupportLoss['reason'] | null = null;
  /**
   * Why the cat last flew, kept past enterLanding (which clears fallReason on the landing tick,
   * before trackStay runs), so a stay's arrival route is known (review C2). Cleared once grounded.
   */
  protected lastFlightReason: FallReason | null = null;

  // ---- v1.2 behaviour model (ADR 0003 §1-§5) ------------------------------------------------
  /** Sim-time accumulators: drives at 1 Hz, the hunt evaluation at 4 Hz (never per host tick). */
  protected driveAccMs = 0;
  protected huntAccMs = 0;
  protected readonly rhythm = new Rhythm();
  /** Throws, rough drags and annoyed reactions, in their own bounded list (§5.4). */
  protected readonly rough = new RoughMemory();
  protected readonly progress = new ProgressMonitor();
  protected readonly dedupe = new EventDedupe();
  protected readonly cursorTrack = new CursorTracker();
  /** Raw keyboard-like input this tick, whatever 'React to typing' says (every "never in the way" gate). */
  protected typingRaw = false;
  protected lastTypingRawAt = -Infinity;
  /** Last seen SimEnv.pointerButtonPresses and when it last increased. */
  protected lastPresses: number | null = null;
  protected lastPressAt = -Infinity;
  /** Where the last press happened (content-free: only the button gate's distance to the cat reads it). */
  protected lastPressPoint: Point | null = null;
  /** The last few press times, oldest first (the hand at work, ADR 0003 §4.3). */
  protected recentPressAt: number[] = [];
  /** Hunting: when the next hunt may start, the global pounce cooldown, the evaluation's verdicts. */
  protected huntReadyAt = -Infinity;
  protected lastPounceAt = -Infinity;
  protected huntGateNow: HuntGate | null = null;
  protected huntThetaNow = 1;
  protected pendingFlick = false;
  protected hunt: HuntRun | null = null;
  /** The next landing ends a hunting pounce (predicted clearance, the paw point aimed at). */
  protected pounceFlight: { at: number; clearancePx: number; targetX: number; mini: boolean } | null = null;
  /** Repetition keys of the last autonomous picks, most recent first. */
  protected readonly recentKeys: string[] = [];
  /** Places (window ids, in memory only) and when the cat last arrived on them. */
  protected readonly placeVisits = new Map<string, number>();
  /** Start of the current contiguous rest or sleep (a stretch after >= 60 s). */
  protected restSince: number | null = null;
  protected lastRestMs = 0;
  protected restEndedAt = -Infinity;
  protected lastStimulusAt = -Infinity;
  /** Soft cursor avoidance after an 'avoid' reaction, until this sim time. */
  protected avoidUntil = -Infinity;
  /** The previous rough-handling reaction and recent startle-like ones (sim time). */
  protected lastReactionKind: ThrowReactionKind | null = null;
  protected readonly startleTimes: number[] = [];
  /** The last throw (sim time), for strokes right after it. */
  protected lastThrowAt = -Infinity;
  /** The release that is in the air: a throw or a rough drag, with what the reaction needs. */
  protected pendingRelease: { trigger: 'throw' | 'roughDrag'; speedDip: number } | null = null;
  /** Drag speed samples (sim time, DIP/s) for the rough-drag trigger. */
  protected readonly dragTrace: Array<{ at: number; speedDip: number }> = [];
  protected lastDragPoint: Point | null = null;
  /** The petting bout: strokes (sim time), irritability added, whether the overstimulation roll was made. */
  protected petBout = { lastAt: -Infinity, strokes: [] as number[], count: 0, irritation: 0, annoyed: 0, swatRolled: false };
  /** Leave kinds of the last stays (N_leave). */
  protected readonly leaveHistory: LeaveKind[] = [];
  protected lastPatrolAt = -Infinity;
  /** Slink rule: retreats in the current approach episode. */
  protected slink = { count: 0, lastAt: -Infinity, episodeAt: -Infinity };
  /** Hold-still zone: when the hotspot came within 0.5 bw of the hit region (null: not now), and whether 3 s are used up. */
  protected holdSince: number | null = null;
  /** Revealed taskbars (by surface id) and when the last one hid. */
  protected readonly taskbarsShown = new Set<string>();
  protected taskbarHiddenAt = -Infinity;
  protected lastMischiefSwatAt = -Infinity;
  /** Rhythm episode of the last decision (records). */
  protected lastEpisode: RhythmEpisode = 'none';
  /** One-off sound for this tick's output (settings.sound.enabled), at most one per SOUND_MIN_GAP_MS. */
  protected sound: CatSoundCue | null = null;
  protected lastSoundAt = -Infinity;
  /** Render hint: 0..1 hardness of the landing being played. */
  protected impactHint = 0;
  /** A cut-short stay's surface and the time it has left (ADR 0003 §2.4). */
  protected resumeToken: { surfaceId: string; place: string | null; remainingMs: number; until: number } | null = null;
  /** env.edgeBands present and the opt-outs allow edges: what the Mover was last told (fail closed). */
  protected edgesOn = false;
  /** The H_safe the Mover was last given (re-sent when energy moved it noticeably). */
  protected safeDipNow = 0;
  protected edgePlan: EdgeTarget | null = null;
  protected edgeVisit: EdgeVisit | null = null;
  protected nextEdgeAt = -Infinity;
  protected readonly tripStarts: number[] = [];
  protected nextHideAt = -Infinity;
  protected nextNapAt = -Infinity;
  protected readonly edgePeeks: number[] = [];
  /** Recent cursor positions (the cursor moving toward a band within the last second). */
  protected readonly cursorSamples: Array<{ at: number; x: number }> = [];
  /** Slips (ADR 0003 §6.6): the armed slip's risk, the climb it was drawn for, the scramble's clip, a retry after a miss. */
  protected slipRisk = 0;
  protected slipDrawnOnWall = false;
  protected slipClipUntil = -Infinity;
  protected slipRetry: { at: number; state: BehaviorState; variant: Variant | null; target: Point | null; windowId: string | null } | null = null;

  constructor(opts: CatSimOptions, hooks: SimHooks = {}) {
    this.hooks = hooks;
    // eslint-disable-next-line no-restricted-properties -- the injection default (ADR 0003 D1)
    this.random = safeRandom(opts.random ?? Math.random);
    // eslint-disable-next-line no-restricted-properties -- the injection default (ADR 0003 D1)
    this.wallClock = opts.wallClock ?? Date.now;
    this.settings = opts.settings;
    this.disabled = disabledBehaviorSet(opts.settings.behavior);
    this.now = Number.isFinite(opts.now) ? opts.now : 0;
    this.clipStartedAt = this.now;
    this.awakeSince = this.now;
    this.profile = new BehaviorProfileRecorder(this.now);
    const wall = this.wall();
    let restoring = false;
    if (opts.persisted) {
      const m = migrateCatState(opts.persisted, this.random, wall);
      this.cat = m.cat;
      restoring = !m.recovered;
    } else {
      this.cat = newPersistedCat(this.random, wall);
    }
    bumpCounter(this.cat.memory, 'sessions');
    // v1.2 drives (ADR 0003 §1.2): a restored cat's moods decay for the downtime (capped at 1 h),
    // its needs do not grow across it; a new cat's hunt drive starts at its baseline. No draws.
    const H = clamp(Number.isFinite(this.settings.behavior.cursorPlay) ? this.settings.behavior.cursorPlay : 0.5, 0, 1);
    if (restoring) {
      decayForDowntime(this.cat.drives, wall - this.cat.savedAt, {
        bond: this.cat.stats.bond,
        patience: this.settings.interaction.patience,
        mischief: this.settings.behavior.mischief,
        fear: this.cat.stats.fear,
        energy: this.cat.stats.energy,
        huntBaseline: huntBaseline(H),
      });
    } else {
      this.cat.drives.huntDrive = huntBaseline(H);
    }
    // Rough handling remembered from before the restart (the persisted ring), oldest first.
    this.rough.seed(this.cat.memory.recent);
    const lp = restoring ? this.cat.lastPosition : null;
    this.mover = new Mover(opts.world, this.moverConfig(), { displayId: lp?.displayKey ?? null, xFrac: lp?.xFrac ?? range(this.random, 0.3, 0.7) });
    this.syncEmotes();
    // Every launch, a brand-new or recovered cat included, starts with a short nap and a wake-up stretch.
    this.act = makeActivity('sleeping', 'lifecycle', this.now, range(this.random, 700, 1300), { variant: 'intro' });
    // No surprise startle right after launch.
    this.reactions.set('surprise', this.now, SURPRISE_COOLDOWN_MS / 2);
  }

  // ---- helpers ------------------------------------------------------------------

  protected wall(): number {
    try {
      const w = this.wallClock();
      return Number.isFinite(w) && w > 0 ? w : 0;
    } catch {
      return 0;
    }
  }

  /** Emote bubbles follow the setting, and never show while the cat stays quiet over a fullscreen app. */
  protected syncEmotes(): void {
    this.emotes.enabled = this.settings.appearance.emotes && this.mode !== 'quiet';
  }

  protected moverConfig(): MoverConfig {
    const b = this.settings.behavior;
    const t = this.cat.traits;
    const limits = jumpDownLimitsFor(b.heights, t.confidence, this.cat.stats.energy);
    this.safeDipNow = limits.safeDip;
    return {
      size: this.settings.appearance.size,
      movementSpeed: b.movementSpeed,
      allowMultiMonitor: b.allowMultiMonitor,
      // A shown taskbar is always a support ('taskbarPlay' only gates the reactions to it, see onTaskbarShown).
      perchOnWindows: !b.disabledBehaviors.includes('perchOnWindows'),
      walls: !b.disabledBehaviors.includes('climbWindows'),
      tabStrips: !b.disabledBehaviors.includes('tabStrips'),
      // A confident cat jumps more readily; an energetic, curious one minds climbing less.
      jumpEffort: 1.3 - 0.6 * clamp(t.confidence, 0, 1),
      climbEffort: 1.4 - 0.5 * clamp(t.energyLevel, 0, 1) - 0.2 * clamp(t.curiosity, 0, 1),
      // v1.2 (ADR 0003 §6): screen edges only with the host's bands (the click guard, fail closed).
      screenEdges: this.edgesOn,
      jumpDownSafeDip: limits.safeDip,
      jumpDownMaxDip: limits.maxDip,
      narrowLedges: true,
      bailOut: true,
      wallJumps: subBehaviorAllowed('windowWallJump', this.disabled),
    };
  }

  /** Screen edges follow env.edgeBands and the opt-outs: a host without the guard never gets edge climbs. */
  protected syncEdges(env: SimEnv): void {
    const on = Array.isArray(env.edgeBands) && this.subAllowed('screenEdgeClimb');
    if (on === this.edgesOn) return;
    this.edgesOn = on;
    if (this.mover.setConfig(this.moverConfig())) this.snapNext = true;
  }

  /** The jump-down limits follow the energy (ADR 0003 §6.3): re-sent when H_safe moved noticeably. */
  protected syncJumpLimits(): void {
    const b = this.settings.behavior;
    const limits = jumpDownLimitsFor(b.heights, this.cat.traits.confidence, this.cat.stats.energy);
    if (Math.abs(limits.safeDip - this.safeDipNow) < 20) return;
    if (this.mover.setConfig(this.moverConfig())) this.snapNext = true;
  }

  /** Indexes this tick's surfaces (bounded, malformed entries skipped). */
  protected indexSurfaces(env: SimEnv): void {
    this.surfaceIndex.clear();
    this.ownerIndex.clear();
    const list: unknown = env.surfaces;
    if (!Array.isArray(list)) return;
    for (const s of list as readonly unknown[]) {
      if (this.surfaceIndex.size >= MAX_SURFACES) break;
      if (!s || typeof s !== 'object') continue;
      const surface = s as EnvSurface;
      if (typeof surface.id !== 'string' || surface.id.length === 0 || this.surfaceIndex.has(surface.id)) continue;
      this.surfaceIndex.set(surface.id, surface);
      if (typeof surface.ownerId !== 'string') continue;
      const owned = this.ownerIndex.get(surface.ownerId);
      if (owned) owned.push(surface);
      else this.ownerIndex.set(surface.ownerId, [surface]);
    }
  }

  /**
   * Surfaces the cat may use: never those of private windows (host flag or a privacy verdict),
   * nor stale low-confidence geometry. The surface it is on stays until it leaves.
   */
  protected usableSurfaces(): EnvSurface[] {
    const attached = this.mover.attachedSurface?.surfaceId ?? null;
    const out: EnvSurface[] = [];
    for (const s of this.surfaceIndex.values()) {
      if (s.id !== attached) {
        if (s.excluded === true || this.excludedWindows.has(s.ownerId)) continue;
        if (typeof s.confidence === 'number' && s.confidence < MIN_SURFACE_CONFIDENCE) continue;
      }
      out.push(s);
    }
    return out;
  }

  /** Live geometry of one surface from the host, or null (gone, or the host misbehaves). */
  protected safeSurface(id: string): EnvSurface | null {
    const env = this.env;
    if (!env || typeof env.getSurface !== 'function') return null;
    try {
      const s = env.getSurface(id);
      return s && typeof s === 'object' ? s : null;
    } catch {
      return null;
    }
  }

  protected noteWindowRect(id: string, rect: Rect | null | undefined): void {
    if (typeof id !== 'string' || !rect || !isFiniteRect(rect) || rect.width < 1 || rect.height < 1) return;
    this.windowRects.delete(id);
    this.windowRects.set(id, { rect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height }, at: this.now });
    while (this.windowRects.size > MAX_WINDOW_RECTS) {
      const oldest = this.windowRects.keys().next().value;
      if (oldest === undefined) break;
      this.windowRects.delete(oldest);
    }
  }

  /**
   * A window's frame as far as the cat can tell: from its surfaces (top edge and sides,
   * `live` reads them fresh from the host), else from a recent window event.
   */
  protected windowRect(id: string | null, live = false): Rect | null {
    if (typeof id !== 'string') return null;
    let top: LedgeSurface | null = null;
    let left: WallSurface | null = null;
    let right: WallSurface | null = null;
    let strip: LedgeSurface | null = null;
    for (const s of this.ownerIndex.get(id) ?? []) {
      const g = live ? this.safeSurface(s.id) : s;
      if (!g) continue;
      if (g.orientation === 'ledge' && g.kind === 'windowTop') top = g;
      else if (g.orientation === 'ledge' && g.kind === 'tabStrip') strip = g;
      else if (g.orientation === 'wall' && g.kind === 'windowSide') {
        if (g.side === 'left') left = g;
        else right = g;
      }
    }
    // A browser listed with its tab strip instead of its top: the open edge the strip lies on is the top (v1.1.1).
    if (!top && strip) top = strip.land ? { ...strip, x0: strip.land.x0, x1: strip.land.x1 } : strip;
    const cached = this.windowRects.get(id) ?? null;
    if (top || left || right) {
      const x0 = left?.x ?? top?.x0 ?? cached?.rect.x;
      const x1 = right?.x ?? top?.x1 ?? (cached ? cached.rect.x + cached.rect.width : undefined);
      const y0 = top?.y ?? Math.min(left?.y0 ?? Infinity, right?.y0 ?? Infinity);
      const sideBottom = Math.max(left?.y1 ?? -Infinity, right?.y1 ?? -Infinity);
      const y1 = Number.isFinite(sideBottom) ? sideBottom : cached ? y0 + cached.rect.height : y0 + this.mover.bodyHeight * 4;
      if (x0 !== undefined && x1 !== undefined && Number.isFinite(x0) && Number.isFinite(x1) && Number.isFinite(y0) && Number.isFinite(y1) && x1 - x0 >= 1 && y1 - y0 >= 1) {
        const rect = { x: x0, y: y0, width: x1 - x0, height: y1 - y0 };
        this.noteWindowRect(id, rect);
        return rect;
      }
    }
    return cached && this.now - cached.at <= WINDOW_RECT_TTL_MS ? cached.rect : null;
  }

  protected get bl(): number {
    return this.mover.bodyWidth;
  }

  protected perSecond(rate: number): boolean {
    return chance(this.random, 1 - Math.exp((-rate * this.dt) / 1000));
  }

  protected markDirty(urgent = false): void {
    this.dirty = true;
    if (urgent) this.lastSaveAt = -Infinity;
  }

  protected dwellFor(state: BehaviorState): number {
    const [lo, hi] = STATE_SPECS[state].dwellMs;
    if (hi <= 0) return 0;
    // The chase length follows settings.behavior.chaseDurationSec; at the default it is the spec range.
    if (state === 'chasingCursor') {
      const sec = Number.isFinite(this.settings.behavior.chaseDurationSec) ? clamp(this.settings.behavior.chaseDurationSec, 1, 20) : NOMINAL_CHASE_SEC;
      return range(this.random, lo, hi) * (sec / NOMINAL_CHASE_SEC);
    }
    // v1.2 (ADR 0003 §1.1, T3/P8): Activity no longer shortens calm dwells; it sets the odds and
    // length of active episodes (rhythm.ts).
    return range(this.random, lo, hi);
  }

  protected phase(a: Activity, p: Phase, ms = 0): void {
    a.phase = p;
    a.phaseAt = this.now;
    a.phaseMs = ms;
  }

  protected phaseElapsed(a: Activity): boolean {
    return a.phaseMs > 0 && this.now - a.phaseAt >= a.phaseMs;
  }

  protected finish(next: FollowUp | null = null): void {
    this.act.done = true;
    if (next) this.act.then = next;
    this.stop();
  }

  protected goTo(p: Point, pace: Pace, allowJump: boolean, arriveRadiusPx?: number, opts: { route?: RoutePreference; literal?: boolean; surfaceId?: string } = {}): void {
    // Hold-still zone (ADR 0003 §4.3): with the hotspot right at the cat it takes no take-off and
    // pauses its walk (grabbing and petting stay easy), for at most HOLD_STILL_MAX_MS.
    if (this.holdingStill()) {
      this.stop();
      return;
    }
    this.goalPoint = isFinitePoint(p) ? { x: p.x, y: p.y } : null;
    this.mover.setGoal({
      x: p.x,
      y: p.y,
      pace,
      allowJump,
      ...(arriveRadiusPx !== undefined ? { arriveRadiusPx } : {}),
      ...(opts.route !== undefined ? { route: opts.route } : {}),
      ...(opts.literal !== undefined ? { literal: opts.literal } : {}),
      ...(opts.surfaceId !== undefined ? { surfaceId: opts.surfaceId } : {}),
    });
  }

  protected stop(): void {
    this.goalPoint = null;
    this.mover.setGoal(null);
  }

  protected setGlance(p: Point, ms = 1500): void {
    if (isFinitePoint(p)) this.glance = { target: { x: p.x, y: p.y }, until: this.now + ms };
  }

  protected playOneShot(clip: AnimClip, ms: number): void {
    this.oneShot = { clip, until: this.now + ms };
    this.restartClip = true;
  }

  /** Starts a short body-language reaction on top of the clip, at most once per REACTION_MIN_GAP_MS. */
  protected react(kind: CatReactionKind): boolean {
    if (this.reaction && this.now - this.reaction.at < REACTION_MIN_GAP_MS) return false;
    this.reaction = { kind, at: this.now };
    return true;
  }

  /** Records the host's privacy verdict for a window (undefined: no verdict in this event). */
  protected notePrivacy(id: string, excluded: boolean | undefined): void {
    if (typeof id !== 'string' || excluded === undefined) return;
    if (excluded) this.excludedWindows.add(id);
    else this.excludedWindows.delete(id);
  }

  protected budgetAvailable(): boolean {
    const cutoff = this.now - STATE_CHANGE_WINDOW_MS;
    while (this.changeTimes.length > 0 && (this.changeTimes[0] as number) <= cutoff) this.changeTimes.shift();
    return this.changeTimes.length < MAX_STATE_CHANGES_PER_WINDOW;
  }

  protected coolingDown(s: BehaviorState): boolean {
    return this.now < (this.cooldownUntil.get(s) ?? -Infinity);
  }

  /** The v2 switches and the v1.2 sub-act gates (utility.ts variantAllowed, behaviorGates.ts). */
  protected allowedByToggles(state: BehaviorState, variant: Variant | null): boolean {
    return variantAllowed(state, variant, this.disabled);
  }

  /** A sub-act (behaviorGates.ts) may run with the current opt-outs. */
  protected subAllowed(act: SubBehavior): boolean {
    return subBehaviorAllowed(act, this.disabled);
  }

  /** Raw typing now or within the last TYPING_HOLD_MS (every "never in the way" gate). */
  protected typingGate(): boolean {
    return this.typingRaw || this.now - this.lastTypingRawAt < TYPING_HOLD_MS;
  }

  /**
   * Hold-still zone (ADR 0003 §4.3): the cursor hotspot within HOLD_STILL_BW body widths of the
   * cat's bounds pauses walking and take-offs for up to HOLD_STILL_MAX_MS (commands, direct
   * handling and the body's own physics are not held).
   */
  protected holdingStill(): boolean {
    const c = this.env?.cursor;
    const a = this.act;
    if (!c || !Number.isFinite(c.x) || !Number.isFinite(c.y) || a.cause === 'command' || a.cause === 'interaction' || PHYSICAL_STATES.has(a.state) || this.mover.onWall) {
      this.holdSince = null;
      return false;
    }
    const b = this.approxBounds();
    const m = HOLD_STILL_BW * this.mover.bodyWidth;
    const near = c.x >= b.x - m && c.x <= b.x + b.width + m && c.y >= b.y - m && c.y <= b.y + b.height + m;
    if (!near) {
      this.holdSince = null;
      return false;
    }
    this.holdSince ??= this.now;
    return this.now - this.holdSince < HOLD_STILL_MAX_MS;
  }

  /** Upright body box at the anchor, px (the click-through fallback the renderer refines). */
  protected approxBounds(): Rect {
    const m = this.mover;
    return { x: m.x - m.bodyWidth / 2, y: m.y - m.bodyHeight, width: m.bodyWidth, height: m.bodyHeight };
  }

  /** Queues a one-off sound for this tick's output (only while sounds are on; at most one per SOUND_MIN_GAP_MS). */
  protected playSound(kind: SoundCue): void {
    const s = this.settings.sound;
    if (!s.enabled || this.mode !== 'normal' || this.now - this.lastSoundAt < SOUND_MIN_GAP_MS) return;
    if (kind !== 'purr' && ASLEEP_STATES.has(this.act.state)) return;
    this.lastSoundAt = this.now;
    this.sound = { kind, at: this.now, volume: Number.isFinite(s.volume) ? clamp(s.volume, 0, 1) : 0.4 };
  }

  /** Remembers a throw, rough drag or annoyed reaction in the rough-handling list (and the v1.1 ring). */
  protected rememberRough(kind: RoughKind): void {
    this.rough.add(this.wall(), kind);
  }

  protected allowedInMode(state: BehaviorState): boolean {
    if (PHYSICAL_STATES.has(state)) return true;
    switch (this.mode) {
      case 'normal':
        return true;
      case 'paused':
        return state === 'resting' || state === 'fallingAsleep' || state === 'sleeping' || state === 'beingPetted' || state === 'wakingUp';
      case 'quiet':
      case 'locked':
      case 'quit':
        return state === 'fallingAsleep' || state === 'sleeping';
      case 'away':
        return state === 'away';
    }
  }

  // ---- transitions --------------------------------------------------------------

  protected request(to: BehaviorState, cause: TransitionCause, init: ActivityInit = {}): RequestStatus {
    const from = this.act.state;
    const free = cause === 'physical' || cause === 'lifecycle';
    // While held, airborne or away the cat cannot act on anything else; the request simply waits.
    if (!free && ((PHYSICAL_STATES.has(from) && from !== 'landing') || from === 'away')) return 'blocked';
    // Clinging to a wall it finishes the climb first: only direct interaction and commands get through.
    if ((cause === 'autonomous' || cause === 'stimulus') && this.mover.onWall) return 'blocked';
    if (!free && (!this.allowedInMode(to) || !this.allowedByToggles(to, init.variant ?? null))) return 'invalid';
    if (from === to) return this.refresh(to, cause, init);
    // Physical changes are immediate consequences of the body: never routed through other states.
    if (cause === 'physical') return canTransition(from, to) ? this.go(to, cause, init) : 'invalid';
    const path = findPath(from, to);
    if (!path || path.length === 0) return this.invalid(from, to, cause);
    if (path.length === 1) return this.go(to, cause, init);
    // Interaction skips the interrupt guard, but a reaction is not left through a stepping stone
    // (annoyed -> idle -> playing) before its minimum dwell.
    if (cause === 'interaction' && REACTION_STATES.has(from) && !this.act.done && this.now - this.act.startedAt < STATE_SPECS[from].dwellMs[0]) return 'blocked';
    const r = this.go(path[0] as BehaviorState, cause, {});
    if (r !== 'ok') return r;
    this.pending = { state: to, init, expiresAt: this.now + 20_000 };
    if (cause === 'lifecycle') this.flushPending();
    return 'ok';
  }

  protected flushPending(): void {
    for (let guard = 0; this.pending && guard < 6; guard++) {
      const p = this.pending;
      const path = findPath(this.act.state, p.state);
      if (!path || path.length === 0) {
        this.pending = null;
        return;
      }
      const last = path.length === 1;
      if (this.go(path[0] as BehaviorState, 'lifecycle', last ? p.init : {}) !== 'ok') return;
      if (last) this.pending = null;
    }
  }

  /** The same state was requested again: extend or restart without a state change. */
  protected refresh(state: BehaviorState, cause: TransitionCause, init: ActivityInit): RequestStatus {
    const a = this.act;
    if (cause === 'physical' || cause === 'lifecycle') return 'ok';
    if (state === 'beingPetted') {
      a.lastPetAt = this.now;
      return 'ok';
    }
    // Timed sequences (sleep, wake-up, reactions, physics) are not restarted; travel gets the new destination.
    if (SELF_TIMED.has(state) && state !== 'walking' && state !== 'running') {
      if (state === 'sleeping' && cause === 'command') a.dwellMs = Math.max(a.dwellMs, this.now - a.startedAt + 180_000);
      return 'ok';
    }
    this.exitActivity(a);
    this.act = makeActivity(state, cause, this.now, init.dwellMs ?? this.dwellFor(state), init);
    this.enterActivity(this.act);
    return 'ok';
  }

  protected go(to: BehaviorState, cause: TransitionCause, init: ActivityInit, resume: Activity | null = null): RequestStatus {
    const prev = this.act;
    const from = prev.state;
    if (!canTransition(from, to)) return this.invalid(from, to, cause);
    const free = cause === 'physical' || cause === 'lifecycle';
    if (!free && (!this.allowedInMode(to) || !this.allowedByToggles(to, resume?.variant ?? init.variant ?? null))) return 'invalid';
    const g = guardsFor(cause);
    const counted = isCountedTransition(from, to, cause);
    if (g.budget && counted && !this.budgetAvailable()) return 'blocked';
    if (g.cooldown && this.coolingDown(to)) return 'blocked';
    const dwell = this.now - prev.startedAt;
    if (g.interrupt && !prev.done && !mayInterrupt(from, to, dwell)) return 'blocked';

    const enteringPhysical = PHYSICAL_STATES.has(to) && !PHYSICAL_STATES.has(from);
    if (enteringPhysical && init.suspend && from !== 'away') {
      this.discardSuspended();
      this.suspended = prev;
    } else {
      if (to === 'held' || to === 'away' || (to === 'falling' && !init.suspend && from !== 'jumping')) this.discardSuspended();
      if (to === 'held' || to === 'away') this.pending = null;
      this.exitActivity(prev);
    }
    if (counted) this.changeTimes.push(this.now);
    if (!PHYSICAL_STATES.has(from) && from !== 'away') this.cooldownUntil.set(from, this.now + STATE_SPECS[from].cooldownMs);
    const rec: TransitionRecord = { at: this.now, from, to, cause, dwellMs: dwell, fromDone: prev.done, counted };
    this.transitionsTotal++;
    this.log.push(rec);
    if (this.log.length > 64) this.log.shift();
    this.hooks.onTransition?.(rec);

    if (resume) {
      resume.done = false;
      resume.goalStatus = 'none';
      this.act = resume;
      return 'ok';
    }
    this.act = makeActivity(to, cause, this.now, init.dwellMs ?? this.dwellFor(to), init);
    if (!PHYSICAL_STATES.has(to) && to !== 'away') {
      this.recentStates.unshift(to);
      if (this.recentStates.length > 8) this.recentStates.pop();
    }
    this.enterActivity(this.act);
    return 'ok';
  }

  /** A request no path can satisfy: a logic error worth surfacing in diagnostics. */
  protected invalid(from: BehaviorState, to: BehaviorState, cause: TransitionCause): 'invalid' {
    this.invalidRequests++;
    this.invalidSamples.push(`${from}->${to}:${cause}`);
    if (this.invalidSamples.length > 8) this.invalidSamples.shift();
    return 'invalid';
  }

  protected discardSuspended(): void {
    const s = this.suspended;
    this.suspended = null;
    if (s) this.exitActivity(s);
  }

  /** Next step once the current activity is done: queued path, resume after landing, follow-up, or a new decision. */
  protected advance(): void {
    if (this.now < this.nextAdvanceAt) return;
    const a = this.act;
    if (this.mode !== 'normal' && this.mode !== 'quit') {
      if (this.pending && !this.allowedInMode(this.pending.state)) this.pending = null;
      if (a.then && !this.allowedInMode(a.then.state)) a.then = null;
    }
    if (this.pending) {
      const p = this.pending;
      const path = this.now <= p.expiresAt ? findPath(a.state, p.state) : null;
      if (!path || path.length === 0) {
        this.pending = null;
      } else {
        const last = path.length === 1;
        const r = this.go(path[0] as BehaviorState, 'completion', last ? p.init : {});
        if (r === 'ok') {
          if (last) this.pending = null;
          return;
        }
        if (r === 'blocked') {
          this.nextAdvanceAt = this.now + 250;
          return;
        }
        this.pending = null;
      }
    }
    if (a.state === 'landing' && this.suspended && !a.then) {
      const s = this.suspended;
      if (this.mode === 'normal' && canTransition('landing', s.state) && this.allowedByToggles(s.state, s.variant) && this.now - s.startedAt < 60_000) {
        const r = this.go(s.state, 'completion', {}, s);
        if (r === 'ok') {
          this.suspended = null;
          return;
        }
        if (r === 'blocked') {
          this.nextAdvanceAt = this.now + 250;
          return;
        }
      }
      this.discardSuspended();
    }
    if (a.then) {
      const t = a.then;
      const r = this.request(t.state, 'completion', t.init);
      if (r === 'ok') return;
      if (r === 'blocked') {
        this.nextAdvanceAt = this.now + 250;
        return;
      }
      a.then = null;
    }
    this.reconsider();
  }

  /** Autonomous re-decision (dwell elapsed or activity done). */
  protected reconsider(): void {
    if (this.now < this.nextDecisionAt) return;
    this.nextDecisionAt = this.now + 400;
    switch (this.mode) {
      case 'away':
        return;
      case 'quit':
      case 'quiet':
      case 'locked':
        this.settleAsleep('lifecycle');
        return;
      case 'paused':
        this.settlePaused();
        return;
      case 'normal':
        break;
    }
    if (!this.budgetAvailable()) return;
    // On a wall the cat finishes the climb before deciding anything new.
    if (this.mover.onWall) return;
    // v1.2 (ADR 0003 §6.6): the retry after a missed take-off.
    const retry = this.slipRetry;
    if (retry && this.now >= retry.at) {
      this.slipRetry = null;
      if (this.request(retry.state, 'autonomous', { variant: retry.variant, target: retry.target, windowId: retry.windowId }) === 'ok') {
        this.recordDecision(retry.state, retry.variant, 'autonomous');
        return;
      }
    }
    // v1.2 (ADR 0003 §1.3-§1.5): every feasible candidate scored, softmax at τ = 0.5.
    const view = this.decisionView();
    const scored = scoreAll(view);
    const pick = pickWithVariety(this.random, scored);
    if (!pick) {
      this.act.dwellMs += 2000;
      return;
    }
    const choice = pick.item;
    const r = this.requestCandidate(choice, 'autonomous');
    if (r !== 'ok') this.act.dwellMs = Math.max(this.act.dwellMs, this.now - this.act.startedAt + range(this.random, 1000, 3000));
    else {
      this.notePick(choice);
      let best = 0;
      for (const c of scored) if (c.score > best) best = c.score;
      this.emitDecision({
        at: this.now,
        state: choice.state,
        variant: choice.variant,
        cause: this.stay ? 'stay' : 'autonomous',
        utility: pick.score,
        bestUtility: best,
        candidates: scored.length,
        episode: this.rhythm.started ? this.rhythm.episode : 'none',
        activityClass: activityClassOf(choice.state, choice.variant),
        standingOn: this.mover.attachedSurface?.surfaceKind ?? 'floor',
        typing: this.typingRaw,
      });
    }
  }

  /** Remembers a started candidate's repetition key (most recent first). */
  protected notePick(c: Pick<Candidate, 'state' | 'variant' | 'surfaceKind'>): void {
    this.recentKeys.unshift(candidateKey(c));
    if (this.recentKeys.length > RECENT_KEYS) this.recentKeys.length = RECENT_KEYS;
  }

  /** Records a decision taken outside the scorer (stimulus, leave, watchdog). */
  protected recordDecision(state: BehaviorState, variant: Variant | null, cause: DecisionRecord['cause']): void {
    this.emitDecision({
      at: this.now,
      state,
      variant,
      cause,
      utility: null,
      bestUtility: null,
      candidates: 0,
      episode: this.rhythm.started ? this.rhythm.episode : 'none',
      activityClass: activityClassOf(state, variant),
      standingOn: this.mover.attachedSurface?.surfaceKind ?? 'floor',
      typing: this.typingRaw,
    });
  }

  // ---- v1.2 profile records (ADR 0003 §11) ----------------------------------------

  protected emitDecision(r: DecisionRecord): void {
    this.profile.decision(r);
    this.hooks.onDecision?.(r);
  }

  protected emitExcursion(r: ExcursionRecord): void {
    this.profile.excursion(r);
    this.hooks.onExcursion?.(r);
  }

  protected emitFall(r: FallRecord): void {
    this.profile.fall(r);
    this.hooks.onFall?.(r);
  }

  /** v1.2 reaction model entry point (not called before the behaviour package lands). */
  protected emitReaction(r: ReactionRecord): void {
    this.profile.reaction(r);
    this.hooks.onReaction?.(r);
  }

  /** v1.2 hunting model entry point (not called before the behaviour package lands). */
  protected emitHunt(r: HuntRecord): void {
    this.profile.hunt(r);
    this.hooks.onHunt?.(r);
  }

  protected emitSlip(r: SlipRecord): void {
    this.profile.slip(r);
    this.hooks.onSlip?.(r);
  }

  /** v1.2 screen-edge entry point (not called before the behaviour package lands). */
  protected emitEdgeVisit(r: EdgeVisitRecord): void {
    this.profile.edgeVisit(r);
    this.hooks.onEdgeVisit?.(r);
  }

  // ---- modes ----------------------------------------------------------------------

  protected computeMode(): SimMode {
    if (this.quitting) return 'quit';
    const env = this.env;
    if (!env) return this.mode;
    const fsHere = env.fullscreenDisplayIds.includes(this.mover.displayId);
    const fsb = this.settings.behavior.fullscreenBehavior;
    if (env.hidden || (fsHere && fsb === 'hide')) return 'away';
    if (this.systemLocked || this.systemSuspended) return 'locked';
    if (fsHere && fsb === 'quiet') return 'quiet';
    if (env.paused) return 'paused';
    return 'normal';
  }

  /** Hidden ('hide') or quiet only because a fullscreen app is in front on the cat's display. */
  protected onFullscreenDisplay(): boolean {
    const env = this.env;
    if (!env || env.hidden || this.systemLocked || this.systemSuspended) return false;
    const fsb = this.settings.behavior.fullscreenBehavior;
    return fsb !== 'ignore' && (this.mode === 'away' || this.mode === 'quiet') && env.fullscreenDisplayIds.includes(this.mover.displayId);
  }

  protected updateMode(): void {
    const next = this.computeMode();
    if (next === this.mode) return;
    const prev = this.mode;
    this.mode = next;
    this.syncEmotes();
    if (prev === 'away' && next !== 'quit') this.leaveAway(next);
    switch (next) {
      case 'quit':
        return;
      case 'away':
        this.enterAway();
        return;
      case 'quiet':
      case 'locked':
        this.releaseIfHeld();
        this.settleAsleep('lifecycle');
        return;
      case 'paused':
        this.settlePaused();
        return;
      case 'normal':
        if (prev === 'paused' || prev === 'quiet' || prev === 'locked') {
          const s = this.act.state;
          if (s === 'sleeping' || s === 'fallingAsleep' || s === 'resting') this.request('wakingUp', 'lifecycle');
        }
        return;
    }
  }

  protected releaseIfHeld(): void {
    if (this.mover.held) {
      this.mover.endDrag(null, ZERO, this.now, false);
      this.fallReason = 'drop';
      this.request('falling', 'physical');
    }
  }

  protected enterAway(): void {
    if (this.mover.held) this.mover.endDrag(null, ZERO, this.now, false);
    if (this.mover.settleNow()) this.snapNext = true;
    this.stop();
    this.awayWasAsleep = ASLEEP_STATES.has(this.act.state);
    this.awaySince = this.now;
    this.request('away', 'lifecycle');
  }

  protected leaveAway(next: SimMode): void {
    if (this.act.state !== 'away') return;
    if (next === 'quiet' || next === 'locked') this.request('sleeping', 'lifecycle', { variant: 'forced' });
    else if (next === 'paused') this.request(this.awayWasAsleep ? 'sleeping' : 'resting', 'lifecycle', this.awayWasAsleep ? { variant: 'forced' } : {});
    else if (this.awayWasAsleep) {
      // The interrupted sleep (the startup intro, a nap, an idle sleep) is not resumed as a fresh
      // nap: shown again with the user around, the cat wakes up; with nobody around it sleeps on
      // until the user returns.
      if (this.env && userIdleForSleep({ userIdleMs: this.env.userIdleMs, behavior: this.settings.behavior })) this.request('sleeping', 'lifecycle', { variant: 'idleSleep' });
      else this.request('wakingUp', 'lifecycle');
    } else this.request(this.now - this.awaySince > 60_000 ? 'wakingUp' : 'idle', 'lifecycle');
  }

  protected settleAsleep(cause: TransitionCause): void {
    const s = this.act.state;
    if ((PHYSICAL_STATES.has(s) && !(s === 'landing' && this.act.done)) || s === 'away') return;
    if (s === 'sleeping') return;
    if (s === 'fallingAsleep') {
      if (this.act.done) this.request('sleeping', cause);
      return;
    }
    this.request('fallingAsleep', cause, { variant: 'forced', quick: this.mode === 'quit' });
  }

  protected settlePaused(): void {
    const s = this.act.state;
    const settledPhysical = PHYSICAL_STATES.has(s) && !(s === 'landing' && this.act.done);
    if (settledPhysical || s === 'away' || s === 'sleeping' || s === 'beingPetted') {
      if (s === 'beingPetted' && this.act.done) this.request('resting', 'lifecycle');
      return;
    }
    if (s === 'fallingAsleep') {
      if (this.act.done) this.request('sleeping', 'lifecycle');
      return;
    }
    if (s === 'resting') {
      if (this.act.done || this.now - this.act.startedAt >= this.act.dwellMs) this.request('fallingAsleep', 'lifecycle', { variant: 'forced' });
      return;
    }
    this.stop();
    this.request('resting', 'lifecycle');
  }

  protected startQuit(): void {
    if (this.quitting) return;
    this.quitting = true;
    this.quitAt = this.now;
    this.mode = 'quit';
    if (this.mover.held) this.mover.endDrag(null, ZERO, this.now, false);
    if (this.mover.settleNow()) this.snapNext = true;
    this.stop();
    this.pending = null;
    this.discardSuspended();
    const s = this.act.state;
    if (s === 'sleeping') return;
    if (s === 'away' || s === 'fallingAsleep') {
      this.request('sleeping', 'lifecycle');
      return;
    }
    if (s === 'held' || s === 'jumping' || s === 'falling') this.go('landing', 'lifecycle', { landing: null });
    this.request('fallingAsleep', 'lifecycle', { variant: 'forced', quick: true });
  }

  protected checkQuit(): void {
    if (!this.quitting || this.quitReadySent) return;
    if (this.act.state === 'sleeping' || this.now - this.quitAt >= QUIT_DEADLINE_MS) {
      this.requests.push({ type: 'quitReady' });
      this.quitReadySent = true;
    }
  }

  // ---- physics coupling -----------------------------------------------------------

  protected onMoverStep(step: MoverStep): void {
    if (step.supportLost) this.lastLossReason = step.supportLost.reason;
    if (step.supportLost?.reason === 'disabled' && this.stay?.surfaceId === step.supportLost.surfaceId) this.stay.via = 'disabled';
    if (step.bailedOut) this.onBailedOut(step);
    if (step.crouchStarted) {
      if (this.request('jumping', 'physical', { suspend: true }) === 'ok') {
        this.fallReason = 'jump';
        this.drawSlip();
      } else this.mover.cancelCrouch();
    }
    if (step.slipped) this.onSlipped(step.slipped);
    if (step.steppedOff) {
      this.fallReason = 'step';
      this.request('falling', 'physical', { suspend: true });
    }
    if (step.perchLost) {
      if (this.calmLoss(step.supportLost)) {
        // A taskbar sliding away, a covered window, a switched-off surface: the cat just drops
        // down and carries on with what it was doing.
        this.fallReason = 'retracted';
        this.request('falling', 'physical', { suspend: true });
      } else {
        this.fallReason = 'perch';
        this.request('falling', 'physical');
        if (this.act.state === 'falling') this.discardSuspended();
      }
    }
    if (step.lifted || step.lowered) this.onCarried(step.lifted !== null);
    if (step.clung) this.resumeAfterLeap();
    if (step.landed) {
      this.request('landing', 'physical', { landing: step.landed });
      return;
    }
    if (!PHYSICAL_STATES.has(this.act.state)) this.act.goalStatus = step.goal;
  }

  /**
   * The support was covered or vanished and the Mover left it with a controlled bail-out (ADR 0003
   * §3): calm (an ear flick, a glance at what covered it, no startle); the stay ends covered or gone.
   */
  protected onBailedOut(step: MoverStep): void {
    const st = this.stay;
    const m = this.mover;
    if (st && step.supportLost?.surfaceId === st.surfaceId) {
      st.via = step.supportLost.reason === 'gone' ? 'gone' : 'covered';
      st.bailOut = m.bailOutKind;
    }
    // A bail-out onto a window side is a climb too (the ceiling of 12 an hour holds under window churn).
    if (m.bailOutKind === 'wall') this.tripStarts.push(this.now);
    if (this.mode === 'normal') {
      this.react('earFlick');
      const fg = this.env?.foreground;
      if (fg && isFiniteRect(fg.rect) && !fg.minimized) this.setGlance({ x: fg.rect.x + fg.rect.width / 2, y: fg.rect.y + fg.rect.height / 2 }, 1200);
    }
    this.fallReason = 'jump';
    if (m.airborne && !PHYSICAL_STATES.has(this.act.state)) this.enterPlannedFlight();
  }

  /**
   * A planned flight the Mover started without a crouch report (a bail-out, a wall jump): 'jumping'
   * where the state table allows it, else 'falling'; either way the interrupted activity resumes.
   */
  protected enterPlannedFlight(): void {
    this.request(canTransition(this.act.state, 'jumping') ? 'jumping' : 'falling', 'physical', { suspend: true });
  }

  /** Draws a deliberate slip for the take-off being prepared (ADR 0003 §6.6; the sub-act 'slip'). */
  protected drawSlip(): void {
    if (!this.subAllowed('slip')) return;
    const m = this.mover;
    const risk = clamp(m.nextLegRisk, 0, 1);
    const conf = clamp(this.cat.traits.confidence, 0, 1);
    const tired = 1 - clamp(this.cat.stats.energy, 0, 1);
    // The ADR's base 0.03 measured below B10's floor (0.2-0.3 /h at ~10-20 take-offs/h, SIMULATED): the band wins.
    const p = Math.min(0.2, (0.07 + 0.15 * risk) * (1.3 - conf) * (0.7 + 0.6 * tired));
    if (!chance(this.random, p)) return;
    const kind: SlipKind = chance(this.random, 0.7) ? 'scramble' : 'miss';
    if (m.armSlip(kind)) this.slipRisk = risk;
  }

  /** A pull-up onto a strip or a wall jump may slip too: drawn once per climb, when one is prepared. */
  protected drawClimbSlip(): void {
    const m = this.mover;
    if (!m.onWall) {
      this.slipDrawnOnWall = false;
      return;
    }
    if (this.slipDrawnOnWall || m.climbPhase !== 'climb' || !(m.nextLegRisk > 0)) return;
    this.slipDrawnOnWall = true;
    this.drawSlip();
  }

  /** The armed slip happened: a scramble plays its clip, a miss slides off to the support below. */
  protected onSlipped(kind: SlipKind): void {
    this.emitSlip({ at: this.now, kind, risk: this.slipRisk });
    if (kind === 'scramble') {
      this.slipClipUntil = this.now + MOVEMENT.slipScrambleMs;
      this.react('earFlick');
      return;
    }
    if (this.stay) this.stay.via = 'slip';
    this.fallReason = 'jump';
    if (this.mover.airborne && this.act.state !== 'jumping') this.request('falling', 'physical', { suspend: true });
  }

  /**
   * A leap onto a window side ended with the cat clinging to it (v1.1.1): the activity that
   * started the climb (suspended by the jump) carries on from there, so the climb, the pull-up
   * and the walk on top happen as that activity. Without one it simply climbs on (idle).
   */
  protected resumeAfterLeap(): void {
    if (this.act.state !== 'jumping') return;
    this.fallReason = null;
    const s = this.suspended;
    if (s && this.mode === 'normal' && canTransition('jumping', s.state) && this.allowedByToggles(s.state, s.variant)) {
      if (this.go(s.state, 'physical', {}, s) === 'ok') {
        this.suspended = null;
        return;
      }
    }
    this.discardSuspended();
    this.go('idle', 'physical', {});
  }

  /** Only a window (top, side or tab strip) that suddenly vanished under the cat startles it. */
  protected calmLoss(loss: SupportLoss | null): boolean {
    if (!loss) return false;
    if (loss.surfaceKind === 'taskbar') return true;
    return loss.reason !== 'gone';
  }

  /** A rising ledge picked the cat up, or a sinking one set it down: an ear flick and a glance, nothing more. */
  protected onCarried(lifted: boolean): void {
    if (this.mode !== 'normal') return;
    this.react('earFlick');
    const s = this.act.state;
    if (ASLEEP_STATES.has(s) || PHYSICAL_STATES.has(s) || ACTIVE_STATES.has(s)) return;
    const m = this.mover;
    this.setGlance({ x: m.x + m.facing * 1.5 * this.bl, y: m.y + (lifted ? 0.5 : 0.2) * m.bodyHeight }, 1000);
  }

  protected reconcilePhysical(): void {
    const s = this.act.state;
    const m = this.mover;
    if (s === 'away') return;
    if (m.held && s !== 'held') {
      if (this.request('held', 'physical') !== 'ok') m.endDrag(null, ZERO, this.now, false);
    } else if (!m.held && s === 'held') {
      this.fallReason ??= 'drop';
      this.request(m.airborne ? 'falling' : 'landing', 'physical', { landing: null });
    } else if (m.airborne && !PHYSICAL_STATES.has(s)) {
      // A planned take-off from a wall (a wall jump) reports no crouch on the ground: not a fall.
      if (m.jumpKind !== null) {
        this.fallReason ??= 'jump';
        this.enterPlannedFlight();
      } else {
        this.fallReason ??= 'perch';
        this.request('falling', 'physical');
      }
    } else if (s === 'jumping' && m.onWall && m.climbPhase !== 'leap') {
      // Clinging to a side after a leap whose catch was not reported this tick.
      this.resumeAfterLeap();
    } else if (m.grounded && (s === 'jumping' || s === 'falling')) {
      this.request('landing', 'physical', { landing: null });
    }
  }

  protected rememberEvent(kind: Parameters<typeof remember>[1], detail?: MemoryDetail): void {
    remember(this.cat.memory, kind, this.wall(), detail);
    // v1.2 (ADR 0003 §5.4): rough handling also goes to its own bounded list, which frequent
    // ordinary entries (pets, naps) cannot evict.
    if (kind === 'throw' || kind === 'annoyed') this.rememberRough(kind);
    this.markDirty();
  }

  protected currentSleepiness(): number {
    return sleepiness({ stats: this.cat.stats, traits: this.cat.traits, localHour: this.env?.localHour ?? 12, darkBias: this.darkBias(), awakeMs: this.now - this.awakeSince });
  }

  /**
   * Throws, rough drags and annoyed reactions remembered within the last hour (wall clock): the
   * rough-handling list (§5.4), seeded at load from the persisted ring.
   */
  protected recentRough(): number {
    return this.rough.countSince(this.wall() - ROUGH_LIST_MS);
  }

  // ---- context for decisions ----------------------------------------------------------

  protected darkBias(): number {
    return this.now < this.darkUntil ? 1 : 0;
  }

  protected cursorInfo(): { point: Point; speedDip: number; distBodyLengths: number; reachable: boolean } | null {
    const c = this.env?.cursor;
    if (!c || !Number.isFinite(c.x) || !Number.isFinite(c.y)) return null;
    const m = this.mover;
    const bl = m.bodyWidth;
    const bh = m.bodyHeight;
    const dist = Math.hypot(c.x - m.x, c.y - (m.y - bh / 2)) / bl;
    const r = m.walkRange;
    const reachable = r !== null && c.y >= m.y - 3.5 * bh && c.y <= m.y + bh * 0.5 && c.x >= r.x0 - 2 * bl && c.x <= r.x1 + 2 * bl;
    return { point: { x: c.x, y: c.y }, speedDip: (Number.isFinite(c.speed) ? Math.max(0, c.speed) : 0) / m.scale, distBodyLengths: dist, reachable };
  }

  protected retreatTarget(): Point | null {
    const m = this.mover;
    const r = m.walkRange;
    if (!r) return null;
    const threat = this.env?.cursor?.x ?? m.x - m.facing * this.bl;
    const dir = threat < m.x ? 1 : -1;
    const x = clamp(m.x + dir * range(this.random, 3, 6) * this.bl, r.x0, r.x1);
    return Math.abs(x - m.x) >= this.bl ? { x, y: m.y } : null;
  }

  protected favoriteSpotTarget(): { point: Point; distBodyLengths: number } | null {
    const m = this.mover;
    const world = m.world;
    for (const spot of rankedSpots(this.cat.memory, this.wall())) {
      const d = world.display(spot.displayKey);
      if (!d || m.isOffLimits(d.id)) continue;
      const x = d.workAreaPx.x + spot.xFrac * d.workAreaPx.width;
      let point: Point | null = null;
      if (spot.kind === 'floor') {
        const floor = world.floorFor(d.id);
        if (floor) {
          const fp = world.floorPoint(floor, x);
          point = { x: fp.x, y: fp.y };
        }
      } else {
        const w = m.ledgeSurfaces.find((s) => (s.surfaceKind === 'windowTop' || s.surfaceKind === 'tabStrip') && s.displayIds.includes(d.id) && x >= s.x0 && x <= s.x1);
        if (w) point = { x, y: w.y };
      }
      if (point) return { point, distBodyLengths: Math.hypot(point.x - m.x, point.y - m.y) / this.bl };
    }
    return null;
  }

  // ---- implemented by the upper layers ----------------------------------------------

  protected abstract enterActivity(a: Activity): void;
  protected abstract exitActivity(a: Activity): void;
  protected abstract decisionView(): DecisionView;
  protected abstract requestCandidate(c: Candidate, cause: TransitionCause): RequestStatus;
}
