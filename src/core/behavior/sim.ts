// The cat simulation: state machine, activities, stimuli, needs, memory and output.
// Pure TypeScript; time, randomness and the environment are injected.
import type { AnimClip, BehaviorState, CatReaction, CatReactionKind } from '../../shared/cat';
import type { PersistedCat } from '../../shared/catState';
import { PersistedCatSchema } from '../../shared/catState';
import type { Point, Rect } from '../../shared/geometry';
import { clamp, isFiniteRect, rectCenter } from '../../shared/geometry';
import type { Settings, ToggleableBehavior } from '../../shared/settings';
import type { CatSim, CatSimOptions, SimEnv, SimEvent, SimOutput, SimRequest } from '../../shared/sim';
import type { DecisionDiagnostics, DecisionTarget, NavDiagnostics, SurfaceDebugLine, TargetAvailability } from '../../shared/surfaceDiagnostics';
import type { LedgeSurface, Surface as EnvSurface, WallSurface } from '../../shared/surfaces';
import type { WindowInfo, WorldGeometry } from '../../shared/world';
import type { LandingInfo, MoverConfig, MoverStep, Pace, RoutePreference, SupportLoss } from '../movement';
import { MOVEMENT, Mover } from '../movement';
import type { Activity, ActivityInit, FollowUp } from './activity';
import { makeActivity } from './activity';
import type { Phase } from './clips';
import { clipFor } from './clips';
import type { Candidate, DecisionView, Variant } from './decide';
import { chooseActivity, sleepiness, userIdleForSleep } from './decide';
import { EmoteController } from './emotes';
import type { MemoryDetail } from './memory';
import { addRateEvent, bumpCounter, clearMemory, decayRate, ema01, learnSpot, rankedSpots, remember } from './memory';
import { migrateCatState } from './migrate';
import { newPersistedCat } from './personality';
import type { Random } from './random';
import { chance, range, safeRandom } from './random';
import type { TransitionCause } from './states';
import {
  ACTIVE_STATES,
  ASLEEP_STATES,
  CALM_STATES,
  canTransition,
  findPath,
  guardsFor,
  isCountedTransition,
  MAX_STATE_CHANGES_PER_WINDOW,
  mayInterrupt,
  PHYSICAL_STATES,
  REACTION_STATES,
  STATE_CHANGE_WINDOW_MS,
  STATE_SPECS,
} from './states';
import { addStat, applyPet, baseContentment, stepStats } from './stats';
import { Cooldowns, flickRelevance, Habituation, RecentIds, surfaceRelevance, windowRelevance } from './stimuli';

export type SimMode = 'normal' | 'paused' | 'quiet' | 'locked' | 'away' | 'quit';
type RequestStatus = 'ok' | 'blocked' | 'invalid';
/** 'retracted': the surface went away calmly under the cat (taskbar auto-hide, covered window): never startling. */
type FallReason = 'drop' | 'throw' | 'perch' | 'step' | 'jump' | 'retracted';

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
}

/** Hard floor between perception requests; the user's minimum interval applies above it. */
export const PERCEPTION_FLOOR_MS = 5000;
const SAVE_MIN_INTERVAL_MS = 60_000;
/** Body-language reactions (ear flick, tail flick, head tilt) start at most this often. */
export const REACTION_MIN_GAP_MS = 400;
/** How long a reaction stays in the output (the renderer plays it once per distinct start time). */
const REACTION_HOLD_MS = 2000;
/** A call or play command is never ignored more often than this, and never twice in a row. */
export const MAX_COMMAND_IGNORE_CHANCE = 0.35;
/** Typical chase length at chaseDurationSec = 4.5 (the middle of the chasingCursor dwell range). */
const NOMINAL_CHASE_SEC = 4.5;
/** How long the look of the screen from local statistics stays relevant. */
const SCREEN_FRESH_MS = 3 * 60_000;
/** Rough handling is remembered this long (wall clock, so it survives a restart). */
const ROUGH_MEMORY_MS = 60 * 60_000;
export const SURPRISE_COOLDOWN_MS = 20 * 60_000;
const POUNCE_COOLDOWN_MS = 6000;
export const PLAY_RETREAT_COOLDOWN_MS = 2 * 60_000;
/** Closing speed (body lengths/s) of the pointer that a playful cat dodges. */
const PLAY_RETREAT_APPROACH_BL_S = 4;
const QUIT_DEADLINE_MS = 900;
const FADE_MS = 400;
const PET_RATE_TAU_MS = 2 * 3600_000;
const PET_SESSION_GAP_MS = 10_000;
/** Annoyance one full-strength stroke adds to a reacting or irritated cat (scaled by 1.3 - patience). */
const PET_IRRITATION = 0.15;
/** At least this annoyed, the cat hides after a reaction and refuses to be stroked. */
const IRRITATED_ANNOYANCE = 0.6;
const TAP_WINDOW_MS = 8000;
const SPOT_LEARN_MIN_MS = 60_000;
const SPOT_FLUSH_MS = 5 * 60_000;
const DRAG_LOST_MS = 1500;
const LANDING_MS = 250;
/** Longest a walk/run toward a destination may take before the cat gives up. */
const TRAVEL_TIMEOUT_MS = 40_000;
/** Climbing is slow: a climb may take this long before the cat gives up. */
const CLIMB_TIMEOUT_MS = 90_000;
/** Most environment surfaces the sim looks at per tick (the provider caps its list too). */
const MAX_SURFACES = 256;
/** Window rects learned from events stay usable this long without fresh geometry. */
const WINDOW_RECT_TTL_MS = 60_000;
const MAX_WINDOW_RECTS = 64;
/** Surfaces below this confidence are not used for new moves (the one the cat is on is kept). */
const MIN_SURFACE_CONFIDENCE = 0.25;
/** Taskbar reactions: at most one decision per this many ms, however often it flaps. */
const TASKBAR_REACT_GAP_MS = 4000;
const TASKBAR_LOOK_COOLDOWN_MS = 20_000;
const TASKBAR_HOP_COOLDOWN_MS: readonly [number, number] = [120_000, 300_000];
const TASKBAR_WAKE_COOLDOWN_MS = 10 * 60_000;
const CLIMB_COOLDOWN_MS: readonly [number, number] = [90_000, 240_000];
const TAB_VISIT_COOLDOWN_MS = 120_000;
const TAB_INVESTIGATE_COOLDOWN_MS = 60_000;
/**
 * v1.1.1: a trip up that failed (unreachable when tried, timed out, turned back on the side, let
 * go, target lost) is retried after this instead of the full climb / tab-strip visit cooldown.
 */
const EXCURSION_RETRY_MS: readonly [number, number] = [15_000, 40_000];
/** An approach to a window top may take as long as its route needs (walk, leap, climb), within these bounds. */
const APPROACH_MIN_MS = 15_000;
const APPROACH_MAX_MS = 60_000;
/** Window tops / tab strips checked for a way up per decision, nearest first (bounded planner cost). */
const PERCH_CANDIDATES = 6;
const STRIP_CANDIDATES = 4;
/** What the exploration urge counts as within reach is refreshed at most this often. */
const URGE_SCAN_MS = 2000;
/** Up on a top, the cat explores it before it heads back down: at least this long, ... */
const TOP_MIN_STAY_MS = 20_000;
/** ... having walked this many body lengths along it (a short top: its length), ... */
const TOP_PATROL_BL = 2;
/** ... or this long at the most. */
const TOP_MAX_EXPLORE_MS = 60_000;
/** Longest tick the simulation integrates; the host clamps dt to the same 250 ms. */
export const MAX_SIM_DT_MS = 250;
/** How far the paws of a cat on a wall reach past the wall line into the window, body lengths (~5.5 DIP). */
const WALL_PAW_REACH_BL = 0.065;
/**
 * Slowest tick the sim asks for (hidden, or asleep outside normal mode). It stays clear
 * of MAX_SIM_DT_MS so a timer that fires a little late still delivers its whole delay
 * as dt: sim time keeps pace with real time instead of being clamped.
 */
export const SLOWEST_TICK_MS = 200;

/** States whose handler decides when they end (the generic dwell rule does not apply). */
const SELF_TIMED: ReadonlySet<BehaviorState> = new Set<BehaviorState>([
  'walking',
  'running',
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

const AROUSAL: Readonly<Record<BehaviorState, number>> = {
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

const CONTENTMENT_BIAS: Partial<Record<BehaviorState, number>> = {
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

const ZERO: Point = { x: 0, y: 0 };

/** Where the cat can go up from where it stands, and why not (v1.1.1; reachability ignores cooldowns). */
interface TargetScan {
  at: number;
  perch: { windowId: string; point: Point } | null;
  climb: { point: Point; dir: 'up' | 'down' } | null;
  /** A tab strip to visit: its height and resting span. */
  strip: { y: number; rest: { x0: number; x1: number } } | null;
  status: Record<DecisionTarget, TargetAvailability>;
}

const NO_TARGETS: Record<DecisionTarget, TargetAvailability> = { perch: 'noSurfaces', climb: 'noSurfaces', tabStrip: 'noSurfaces' };
const EMPTY_SCAN: TargetScan = { at: -Infinity, perch: null, climb: null, strip: null, status: NO_TARGETS };

/** One trip up the cat set out on (exploring a top, climbing a side, visiting a tab strip). */
interface Excursion {
  kind: DecisionTarget;
  act: Activity;
  /** The surface it set out from (null: the floor), and whether that was already up on a window. */
  from: string | null;
  fromElevated: boolean;
  /** Got onto a window side (leaping or stepping on) on the way. */
  leftGround: boolean;
  arrived: boolean;
}

const isElevatedKind = (k: string | null | undefined): boolean => k === 'windowTop' || k === 'tabStrip';
const isFinitePoint = (p: Point | null | undefined): p is Point => !!p && Number.isFinite(p.x) && Number.isFinite(p.y);

export class CatSimImpl implements CatSim {
  private cat: PersistedCat;
  private settings: Settings;
  private disabled: ReadonlySet<ToggleableBehavior>;
  private readonly random: Random;
  private readonly wallClock: () => number;
  private readonly mover: Mover;
  private readonly emotes = new EmoteController();
  private readonly habit = new Habituation();
  /** Surface appearances (taskbar shows, tab changes) habituate quickly: the second show matters much less. */
  private readonly surfaceHabit = new Habituation(120_000, 0.4);
  private readonly reactions = new Cooldowns();
  /** This tick's environment surfaces by id, and by owning window. */
  private readonly surfaceIndex = new Map<string, EnvSurface>();
  private readonly ownerIndex = new Map<string, EnvSurface[]>();
  /** Window rects learned from events (in memory only), for windows without usable surface geometry. */
  private readonly windowRects = new Map<string, { rect: Rect; at: number }>();
  private readonly seenWindows = new RecentIds(128);
  /** Windows the host marked as private: the cat does not follow, inspect or climb onto them. */
  private readonly excludedWindows = new RecentIds(64);
  private readonly movingWindows = new Set<string>();
  private readonly cooldownUntil = new Map<BehaviorState, number>();
  private readonly changeTimes: number[] = [];
  private readonly recentStates: BehaviorState[] = [];
  private readonly log: TransitionRecord[] = [];
  private readonly hooks: SimHooks;

  private act: Activity;
  private suspended: Activity | null = null;
  private pending: { state: BehaviorState; init: ActivityInit; expiresAt: number } | null = null;
  private now: number;
  private dt = 0;
  private env: SimEnv | null = null;
  private requests: SimRequest[] = [];
  private mode: SimMode = 'normal';
  private quitting = false;
  private quitAt = 0;
  private quitReadySent = false;
  private systemLocked = false;
  private systemSuspended = false;
  private awayWasAsleep = false;
  private awaySince = 0;
  private fade = 0;
  private snapNext = true;
  private clip: AnimClip = 'sit';
  private clipStartedAt: number;
  private restartClip = false;
  private arousal = 0.3;
  private contentment = 0.5;
  private glance: { target: Point; until: number } | null = null;
  private oneShot: { clip: AnimClip; until: number } | null = null;
  private reaction: CatReaction | null = null;
  private lastCommandIgnored = false;
  private commandsIgnored = 0;
  private screen: { kind: 'video' | 'busy' | 'quiet'; until: number } | null = null;
  private prevCursorDistBl: number | null = null;
  private lastPerceptionAt = -Infinity;
  private lastSaveAt = -Infinity;
  private dirty = false;
  private tapTimes: number[] = [];
  private petTimes: number[] = [];
  private lastPetCountedAt = -Infinity;
  private lastPetMemoryAt = -Infinity;
  private lastPetEventAt = -Infinity;
  private lastInteractionAt: number;
  private lastDragCursorAt = 0;
  private lastCursorSeenAt = -Infinity;
  private busyUntil = -Infinity;
  private darkUntil = -Infinity;
  private typing = false;
  private restAccumMs = 0;
  private awakeSince: number;
  private fallReason: FallReason | null = null;
  private nextDecisionAt = -Infinity;
  private nextAdvanceAt = -Infinity;
  private nextDriveAt = -Infinity;
  /** v1.1.1 exploration: the urge (DecisionView.exploreUrge), what is reachable, the trip under way, the top being explored. */
  private exploreUrge = 0;
  private scan: TargetScan = EMPTY_SCAN;
  private decisionTargets: Record<DecisionTarget, TargetAvailability> = { ...NO_TARGETS };
  private excursion: Excursion | null = null;
  private wasElevated = false;
  private topVisit: { surfaceId: string; since: number; x0: number; walked: number } | null = null;
  private lastElevatedAt = 0;
  private excursionCount = 0;
  private invalidRequests = 0;
  private readonly invalidSamples: string[] = [];
  private eventErrors = 0;
  private transitionsTotal = 0;

  constructor(opts: CatSimOptions, hooks: SimHooks = {}) {
    this.hooks = hooks;
    this.random = safeRandom(opts.random ?? Math.random);
    this.wallClock = opts.wallClock ?? Date.now;
    this.settings = opts.settings;
    this.disabled = new Set(opts.settings.behavior.disabledBehaviors);
    this.now = Number.isFinite(opts.now) ? opts.now : 0;
    this.clipStartedAt = this.now;
    this.lastInteractionAt = this.now;
    this.awakeSince = this.now;
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
    const lp = restoring ? this.cat.lastPosition : null;
    this.mover = new Mover(opts.world, this.moverConfig(), { displayId: lp?.displayKey ?? null, xFrac: lp?.xFrac ?? range(this.random, 0.3, 0.7) });
    this.syncEmotes();
    // Every launch, a brand-new or recovered cat included, starts with a short nap and a wake-up stretch.
    this.act = makeActivity('sleeping', 'lifecycle', this.now, range(this.random, 700, 1300), { variant: 'intro' });
    // No surprise startle right after launch.
    this.reactions.set('surprise', this.now, SURPRISE_COOLDOWN_MS / 2);
  }

  // ---- CatSim API -------------------------------------------------------------

  get state(): BehaviorState {
    return this.act.state;
  }

  tick(env: SimEnv, events: readonly SimEvent[]): SimOutput {
    const dt = Number.isFinite(env.dt) ? clamp(env.dt, 0, MAX_SIM_DT_MS) : 0;
    this.now = Number.isFinite(env.now) && env.now >= this.now ? env.now : this.now + dt;
    this.dt = dt;
    this.env = env;
    this.requests = [];
    let snap = this.snapNext;
    this.snapNext = false;

    // Displays with a fullscreen app in front are off limits: the cat neither walks nor jumps onto them.
    this.mover.setOffLimitsDisplays(this.settings.behavior.fullscreenBehavior === 'ignore' ? [] : env.fullscreenDisplayIds);
    if (env.foreground) {
      this.notePrivacy(env.foreground.id, env.foreground.excluded);
      if (!env.foreground.minimized) this.noteWindowRect(env.foreground.id, env.foreground.rect);
    }
    this.indexSurfaces(env);
    this.mover.sense(this.usableSurfaces());
    // 'React to typing' off: the cat does not notice typing at all.
    this.typing = this.settings.behavior.reactToTyping && (env.typing || env.typingIntensity > 0.35);
    if (env.cursor) this.lastCursorSeenAt = this.now;
    this.updateMode();
    for (const ev of events) {
      try {
        this.handleEvent(ev);
      } catch {
        this.eventErrors++;
      }
    }
    this.updateMode();
    this.checkPlayfulRetreat();

    if (this.mode !== 'quit') {
      stepStats(this.cat.stats, { state: this.act.state, traits: this.cat.traits, patience: this.settings.interaction.patience }, dt);
    }
    this.updateActivity();
    if (this.mode !== 'away') {
      const step = this.mover.step({
        now: this.now,
        dtMs: dt,
        dragCursor: env.dragCursor,
        getSurface: (id) => this.safeSurface(id),
        movingWindowIds: this.movingWindows,
      });
      this.onMoverStep(step);
      if (step.snapped) snap = true;
    } else if (this.mover.stepAway({ now: this.now, dtMs: dt, dragCursor: null, getSurface: (id) => this.safeSurface(id), movingWindowIds: this.movingWindows })) {
      // Hidden: it stays with its ledge, and a ledge that vanished meanwhile leaves it on the floor below.
      snap = true;
    }
    this.reconcilePhysical();
    this.trackElevation();
    this.updateUrge(dt);
    this.drives();
    if (this.act.done) this.advance();
    else if (!SELF_TIMED.has(this.act.state) && this.now - this.act.startedAt >= this.act.dwellMs) this.reconsider();
    this.learn(dt);
    this.checkQuit();
    if (this.snapNext) {
      snap = true;
      this.snapNext = false;
    }
    return this.compose(snap);
  }

  updateSettings(settings: Settings): void {
    this.settings = settings;
    this.disabled = new Set(settings.behavior.disabledBehaviors);
    this.syncEmotes();
    if (this.mover.setConfig(this.moverConfig())) this.snapNext = true;
    if (!this.allowedByToggles(this.act.state, this.act.variant)) {
      this.mover.setGoal(null);
      this.act.done = true;
      this.act.then = null;
    }
    if (this.suspended && !this.allowedByToggles(this.suspended.state, this.suspended.variant)) this.discardSuspended();
    if (this.pending && !this.allowedByToggles(this.pending.state, this.pending.init.variant ?? null)) this.pending = null;
  }

  setWorld(world: WorldGeometry): void {
    if (this.mover.setWorld(world)) this.snapNext = true;
    this.glance = null;
  }

  serialize(): PersistedCat {
    const wall = this.wall();
    this.cat.memory.lastSeenAt = wall;
    this.cat.savedAt = wall;
    this.cat.lastPosition = this.lastPosition();
    return PersistedCatSchema.parse(this.cat);
  }

  resetPersonality(): void {
    const fresh = newPersistedCat(this.random, this.wall());
    fresh.memory.counters.sessions = 1;
    fresh.lastPosition = this.cat.lastPosition;
    this.cat = fresh;
    this.habit.clear();
    this.surfaceHabit.clear();
    // Route preferences follow the new personality.
    if (this.mover.setConfig(this.moverConfig())) this.snapNext = true;
    this.markDirty(true);
  }

  clearHistory(): void {
    clearMemory(this.cat.memory, this.wall());
    this.cat.memory.counters.sessions = 1;
    this.restAccumMs = 0;
    this.markDirty(true);
  }

  /** v1.1.1 surface diagnostics (kinds, counts, reasons; no ids or titles). */
  surfaceDiagnostics(): { nav: NavDiagnostics; decision: DecisionDiagnostics } {
    return {
      nav: this.mover.navDiagnostics(),
      decision: {
        state: this.act.state,
        support: this.supportKind(),
        targetKind: this.targetKind(),
        targets: { ...this.decisionTargets },
        exploreUrge: clamp(this.exploreUrge, 0, 1),
        lastElevatedAt: this.lastElevatedAt,
        excursions: this.excursionCount,
      },
    };
  }

  /** What the cat stands on or clings to right now (diagnostics); in mid-leap it is in the air. */
  private supportKind(): DecisionDiagnostics['support'] {
    if (this.mode === 'away') return 'none';
    const m = this.mover;
    if (m.held) return 'held';
    if (m.onWall) return m.climbPhase === 'leap' ? 'air' : 'windowSide';
    if (m.airborne) return 'air';
    return m.attachedSurface?.surfaceKind ?? 'floor';
  }

  /** Kind of surface the current activity (the one a jump interrupted) is heading for, or null. */
  private targetKind(): DecisionDiagnostics['targetKind'] {
    const a = PHYSICAL_STATES.has(this.act.state) && this.suspended ? this.suspended : this.act;
    const t = a.target;
    if (!isFinitePoint(t) || a.done) return null;
    const p = this.mover.surfacePointFor(t);
    return p.surface.kind === 'floor' ? 'floor' : (p.surface.surfaceKind ?? null);
  }

  /** v1.1.1 on-desktop surface visualization segments (physical px). */
  surfaceDebugLines(): SurfaceDebugLine[] {
    return this.mover.debugLines();
  }

  debugInfo(): Record<string, unknown> {
    const recent = this.changeTimes.filter((t) => t > this.now - STATE_CHANGE_WINDOW_MS).length;
    return {
      state: this.act.state,
      phase: this.act.phase,
      variant: this.act.variant,
      mode: this.mode,
      activityAgeMs: Math.round(this.now - this.act.startedAt),
      dwellMs: Math.round(this.act.dwellMs),
      done: this.act.done,
      pending: this.pending?.state ?? null,
      suspended: this.suspended?.state ?? null,
      support: this.mover.support.kind,
      // Kinds and counts only: no window ids or geometry.
      surface: this.mover.attachedSurface?.surfaceKind ?? null,
      surfaces: { listed: this.surfaceIndex.size, ...this.mover.graphInfo() },
      moverMode: this.mover.mode,
      displayId: this.mover.displayId,
      worldVersion: this.mover.fullWorldModel.version,
      fallbackWorld: this.mover.fullWorldModel.usedFallback,
      stats: { ...this.cat.stats },
      changesLast10s: recent,
      transitionsTotal: this.transitionsTotal,
      invalidRequests: this.invalidRequests,
      commandsIgnored: this.commandsIgnored,
      screen: this.currentScreen(),
      invalidSamples: [...this.invalidSamples],
      eventErrors: this.eventErrors,
      lastTransitions: this.log.slice(-16).map((r) => ({ at: Math.round(r.at), from: r.from, to: r.to, cause: r.cause })),
    };
  }

  // ---- helpers ------------------------------------------------------------------

  private wall(): number {
    try {
      const w = this.wallClock();
      return Number.isFinite(w) && w > 0 ? w : 0;
    } catch {
      return 0;
    }
  }

  /** Emote bubbles follow the setting, and never show while the cat stays quiet over a fullscreen app. */
  private syncEmotes(): void {
    this.emotes.enabled = this.settings.appearance.emotes && this.mode !== 'quiet';
  }

  private moverConfig(): MoverConfig {
    const b = this.settings.behavior;
    const t = this.cat.traits;
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
    };
  }

  /** Indexes this tick's surfaces (bounded, malformed entries skipped). */
  private indexSurfaces(env: SimEnv): void {
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
  private usableSurfaces(): EnvSurface[] {
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
  private safeSurface(id: string): EnvSurface | null {
    const env = this.env;
    if (!env || typeof env.getSurface !== 'function') return null;
    try {
      const s = env.getSurface(id);
      return s && typeof s === 'object' ? s : null;
    } catch {
      return null;
    }
  }

  private noteWindowRect(id: string, rect: Rect | null | undefined): void {
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
  private windowRect(id: string | null, live = false): Rect | null {
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

  private get bl(): number {
    return this.mover.bodyWidth;
  }

  private perSecond(rate: number): boolean {
    return chance(this.random, 1 - Math.exp((-rate * this.dt) / 1000));
  }

  private markDirty(urgent = false): void {
    this.dirty = true;
    if (urgent) this.lastSaveAt = -Infinity;
  }

  private dwellFor(state: BehaviorState): number {
    const [lo, hi] = STATE_SPECS[state].dwellMs;
    if (hi <= 0) return 0;
    // The chase length follows settings.behavior.chaseDurationSec; at the default it is the spec range.
    if (state === 'chasingCursor') {
      const sec = Number.isFinite(this.settings.behavior.chaseDurationSec) ? clamp(this.settings.behavior.chaseDurationSec, 1, 20) : NOMINAL_CHASE_SEC;
      return range(this.random, lo, hi) * (sec / NOMINAL_CHASE_SEC);
    }
    const autonomy = clamp(this.settings.behavior.autonomy, 0, 1);
    const mul = CALM_STATES.has(state) || state === 'resting' ? 1.4 - 0.8 * autonomy : 1;
    return clamp(range(this.random, lo, hi) * mul, lo, hi * 1.4);
  }

  private phase(a: Activity, p: Phase, ms = 0): void {
    a.phase = p;
    a.phaseAt = this.now;
    a.phaseMs = ms;
  }

  private phaseElapsed(a: Activity): boolean {
    return a.phaseMs > 0 && this.now - a.phaseAt >= a.phaseMs;
  }

  private finish(next: FollowUp | null = null): void {
    this.act.done = true;
    if (next) this.act.then = next;
    this.mover.setGoal(null);
  }

  private goTo(p: Point, pace: Pace, allowJump: boolean, arriveRadiusPx?: number, opts: { route?: RoutePreference; literal?: boolean } = {}): void {
    this.mover.setGoal({
      x: p.x,
      y: p.y,
      pace,
      allowJump,
      ...(arriveRadiusPx !== undefined ? { arriveRadiusPx } : {}),
      ...(opts.route !== undefined ? { route: opts.route } : {}),
      ...(opts.literal !== undefined ? { literal: opts.literal } : {}),
    });
  }

  private stop(): void {
    this.mover.setGoal(null);
  }

  private setGlance(p: Point, ms = 1500): void {
    if (isFinitePoint(p)) this.glance = { target: { x: p.x, y: p.y }, until: this.now + ms };
  }

  private playOneShot(clip: AnimClip, ms: number): void {
    this.oneShot = { clip, until: this.now + ms };
    this.restartClip = true;
  }

  /** Starts a short body-language reaction on top of the clip, at most once per REACTION_MIN_GAP_MS. */
  private react(kind: CatReactionKind): boolean {
    if (this.reaction && this.now - this.reaction.at < REACTION_MIN_GAP_MS) return false;
    this.reaction = { kind, at: this.now };
    return true;
  }

  /** Records the host's privacy verdict for a window (undefined: no verdict in this event). */
  private notePrivacy(id: string, excluded: boolean | undefined): void {
    if (typeof id !== 'string' || excluded === undefined) return;
    if (excluded) this.excludedWindows.add(id);
    else this.excludedWindows.delete(id);
  }

  private budgetAvailable(): boolean {
    const cutoff = this.now - STATE_CHANGE_WINDOW_MS;
    while (this.changeTimes.length > 0 && (this.changeTimes[0] as number) <= cutoff) this.changeTimes.shift();
    return this.changeTimes.length < MAX_STATE_CHANGES_PER_WINDOW;
  }

  private coolingDown(s: BehaviorState): boolean {
    return this.now < (this.cooldownUntil.get(s) ?? -Infinity);
  }

  private allowedByToggles(state: BehaviorState, variant: Variant | null): boolean {
    const d = this.disabled;
    switch (state) {
      case 'chasingCursor':
        return !d.has('chaseCursor');
      case 'seekingAttention':
        return !d.has('seekAttention');
      case 'inspectingWindow':
        // 'explore' (the autonomous jump onto a window top) is 'Sit on windows'; 'edge' (sitting on a window top
        // looking down into the window) needs both 'Sit on windows' and 'Inspect windows'; the rest is 'Inspect windows'.
        if (variant === 'explore') return !d.has('perchOnWindows');
        if (variant === 'edge') return !d.has('perchOnWindows') && !d.has('inspectWindows');
        return !d.has('inspectWindows');
      case 'walking':
        if (variant === 'climb') return !d.has('climbWindows') && !d.has('perchOnWindows');
        if (variant === 'tabStrip') return !d.has('tabStrips');
        if (variant === 'taskbar') return !d.has('taskbarPlay');
        return true;
      case 'grooming':
        return !d.has('grooming');
      case 'playing':
        return variant !== 'zoomies' || !d.has('zoomies');
      default:
        return true;
    }
  }

  private allowedInMode(state: BehaviorState): boolean {
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

  private request(to: BehaviorState, cause: TransitionCause, init: ActivityInit = {}): RequestStatus {
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

  private flushPending(): void {
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
  private refresh(state: BehaviorState, cause: TransitionCause, init: ActivityInit): RequestStatus {
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

  private go(to: BehaviorState, cause: TransitionCause, init: ActivityInit, resume: Activity | null = null): RequestStatus {
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
  private invalid(from: BehaviorState, to: BehaviorState, cause: TransitionCause): 'invalid' {
    this.invalidRequests++;
    this.invalidSamples.push(`${from}->${to}:${cause}`);
    if (this.invalidSamples.length > 8) this.invalidSamples.shift();
    return 'invalid';
  }

  private discardSuspended(): void {
    const s = this.suspended;
    this.suspended = null;
    if (s) this.exitActivity(s);
  }

  /** Next step once the current activity is done: queued path, resume after landing, follow-up, or a new decision. */
  private advance(): void {
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
  private reconsider(): void {
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
    const choice = chooseActivity(this.decisionView(), this.random);
    if (!choice) {
      this.act.dwellMs += 2000;
      return;
    }
    const r = this.requestCandidate(choice, 'autonomous');
    if (r !== 'ok') this.act.dwellMs = Math.max(this.act.dwellMs, this.now - this.act.startedAt + range(this.random, 1000, 3000));
  }

  private requestCandidate(c: Candidate, cause: TransitionCause): RequestStatus {
    const then: FollowUp | null = c.then ? { state: c.then, init: c.thenVariant ? { variant: c.thenVariant } : {} } : null;
    const r = this.request(c.state, cause, { variant: c.variant, target: c.target, windowId: c.windowId, then });
    if (r === 'ok') {
      // Surface excursions are occasional: each kind has its own cooldown.
      if (c.variant === 'climb') this.reactions.set('climb', this.now, range(this.random, CLIMB_COOLDOWN_MS[0], CLIMB_COOLDOWN_MS[1]));
      else if (c.variant === 'tabStrip') this.reactions.set('tabStripVisit', this.now, TAB_VISIT_COOLDOWN_MS);
    }
    return r;
  }

  // ---- modes ----------------------------------------------------------------------

  private computeMode(): SimMode {
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
  private onFullscreenDisplay(): boolean {
    const env = this.env;
    if (!env || env.hidden || this.systemLocked || this.systemSuspended) return false;
    const fsb = this.settings.behavior.fullscreenBehavior;
    return fsb !== 'ignore' && (this.mode === 'away' || this.mode === 'quiet') && env.fullscreenDisplayIds.includes(this.mover.displayId);
  }

  private updateMode(): void {
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

  private releaseIfHeld(): void {
    if (this.mover.held) {
      this.mover.endDrag(null, ZERO, this.now, false);
      this.fallReason = 'drop';
      this.request('falling', 'physical');
    }
  }

  private enterAway(): void {
    if (this.mover.held) this.mover.endDrag(null, ZERO, this.now, false);
    if (this.mover.settleNow()) this.snapNext = true;
    this.stop();
    this.awayWasAsleep = ASLEEP_STATES.has(this.act.state);
    this.awaySince = this.now;
    this.request('away', 'lifecycle');
  }

  private leaveAway(next: SimMode): void {
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

  private settleAsleep(cause: TransitionCause): void {
    const s = this.act.state;
    if ((PHYSICAL_STATES.has(s) && !(s === 'landing' && this.act.done)) || s === 'away') return;
    if (s === 'sleeping') return;
    if (s === 'fallingAsleep') {
      if (this.act.done) this.request('sleeping', cause);
      return;
    }
    this.request('fallingAsleep', cause, { variant: 'forced', quick: this.mode === 'quit' });
  }

  private settlePaused(): void {
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

  private startQuit(): void {
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

  private checkQuit(): void {
    if (!this.quitting || this.quitReadySent) return;
    if (this.act.state === 'sleeping' || this.now - this.quitAt >= QUIT_DEADLINE_MS) {
      this.requests.push({ type: 'quitReady' });
      this.quitReadySent = true;
    }
  }

  // ---- physics coupling -----------------------------------------------------------

  private onMoverStep(step: MoverStep): void {
    if (step.crouchStarted) {
      if (this.request('jumping', 'physical', { suspend: true }) === 'ok') this.fallReason = 'jump';
      else this.mover.cancelCrouch();
    }
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
   * A leap onto a window side ended with the cat clinging to it (v1.1.1): the activity that
   * started the climb (suspended by the jump) carries on from there, so the climb, the pull-up
   * and the walk on top happen as that activity. Without one it simply climbs on (idle).
   */
  private resumeAfterLeap(): void {
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
  private calmLoss(loss: SupportLoss | null): boolean {
    if (!loss) return false;
    if (loss.surfaceKind === 'taskbar') return true;
    return loss.reason !== 'gone';
  }

  /** A rising ledge picked the cat up, or a sinking one set it down: an ear flick and a glance, nothing more. */
  private onCarried(lifted: boolean): void {
    if (this.mode !== 'normal') return;
    this.react('earFlick');
    const s = this.act.state;
    if (ASLEEP_STATES.has(s) || PHYSICAL_STATES.has(s) || ACTIVE_STATES.has(s)) return;
    const m = this.mover;
    this.setGlance({ x: m.x + m.facing * 1.5 * this.bl, y: m.y + (lifted ? 0.5 : 0.2) * m.bodyHeight }, 1000);
  }

  private reconcilePhysical(): void {
    const s = this.act.state;
    const m = this.mover;
    if (s === 'away') return;
    if (m.held && s !== 'held') {
      if (this.request('held', 'physical') !== 'ok') m.endDrag(null, ZERO, this.now, false);
    } else if (!m.held && s === 'held') {
      this.fallReason ??= 'drop';
      this.request(m.airborne ? 'falling' : 'landing', 'physical', { landing: null });
    } else if (m.airborne && !PHYSICAL_STATES.has(s)) {
      this.fallReason ??= 'perch';
      this.request('falling', 'physical');
    } else if (s === 'jumping' && m.onWall && m.climbPhase !== 'leap') {
      // Clinging to a side after a leap whose catch was not reported this tick.
      this.resumeAfterLeap();
    } else if (m.grounded && (s === 'jumping' || s === 'falling')) {
      this.request('landing', 'physical', { landing: null });
    }
  }

  // ---- per-tick drives --------------------------------------------------------------

  private drives(): void {
    const env = this.env;
    if (!env || this.mode !== 'normal' || this.now < this.nextDriveAt) return;
    this.nextDriveAt = this.now + 1000;
    const s = this.act.state;
    const a = this.act;
    if (userIdleForSleep({ userIdleMs: env.userIdleMs, behavior: this.settings.behavior }) && !ASLEEP_STATES.has(s) && !PHYSICAL_STATES.has(s)) {
      const interruptible = CALM_STATES.has(s) || s === 'walking' || a.done;
      if (interruptible && !(s === 'walking' && a.variant === 'favorite')) {
        const spot = this.favoriteSpotTarget();
        const status =
          spot && spot.distBodyLengths > 1.5 && spot.distBodyLengths < 25 && s !== 'walking'
            ? this.request('walking', 'stimulus', { variant: 'favorite', target: spot.point, then: { state: 'fallingAsleep', init: { variant: 'idleSleep' } } })
            : 'blocked';
        if (status !== 'ok') this.request('fallingAsleep', 'stimulus', { variant: 'idleSleep' });
      }
      return;
    }
    // While the user types the cat settles down instead of running around.
    if (this.typing && ACTIVE_STATES.has(s) && a.cause !== 'command' && a.cause !== 'interaction' && this.now - a.startedAt > 1500 && !a.done) {
      this.finish();
    }
  }

  /**
   * Playful retreat: a playful, energetic cat now and then darts away from a pointer rushing
   * at it, then turns back to face it in a crouch. Rare (long cooldown) and part of cursor play.
   */
  private checkPlayfulRetreat(): void {
    const cur = this.cursorInfo();
    const prev = this.prevCursorDistBl;
    this.prevCursorDistBl = cur ? cur.distBodyLengths : null;
    if (!cur || prev === null || this.dt <= 0 || this.mode !== 'normal' || this.typing) return;
    const closing = ((prev - cur.distBodyLengths) * 1000) / this.dt;
    if (cur.distBodyLengths > 2 || closing < PLAY_RETREAT_APPROACH_BL_S || !cur.reachable) return;
    const a = this.act;
    if (!(a.state === 'idle' || a.state === 'watchingCursor' || (a.state === 'walking' && a.variant === 'wander'))) return;
    const st = this.cat.stats;
    const t = this.cat.traits;
    const cursorPlay = clamp(this.settings.behavior.cursorPlay, 0, 1);
    if (this.disabled.has('chaseCursor') || !(cursorPlay > 0) || t.playfulness < 0.5 || st.energy < 0.5 || st.annoyance > 0.3 || st.fear > 0.2) return;
    if (!this.reactions.ready('playRetreat', this.now)) return;
    // One roll per rush of the pointer.
    this.reactions.set('playRetreat', this.now, 5000);
    if (!chance(this.random, Math.min(1, 2 * cursorPlay) * t.playfulness * 0.6)) return;
    const target = this.retreatTarget();
    if (!target) return;
    const then: FollowUp = { state: 'watchingCursor', init: { variant: 'playful' } };
    if (this.request('running', 'stimulus', { variant: 'playful', target, then }) === 'ok') this.reactions.set('playRetreat', this.now, PLAY_RETREAT_COOLDOWN_MS);
  }

  // ---- activities -----------------------------------------------------------------

  private enterActivity(a: Activity): void {
    const s = a.state;
    if (!PHYSICAL_STATES.has(s)) this.stop();
    switch (s) {
      case 'sleeping':
        this.oneShot = null;
        break;
      case 'wakingUp':
        this.phase(a, 'stretch', a.quick ? 600 : 1600);
        break;
      case 'fallingAsleep':
        this.phase(a, 'yawn', a.quick ? 350 : 1200);
        break;
      case 'idle':
        this.phase(a, a.target || chance(this.random, 0.6) ? 'sit' : 'stand');
        break;
      case 'walking':
      case 'running':
        if (a.variant === 'patrol') {
          // Along the top it just got onto, then a sit up there.
          a.target ??= this.patrolTarget();
          a.then ??= { state: 'idle', init: {} };
        }
        this.phase(a, 'approach');
        // A tab-strip visit may need a climb: it may take as long as its route needs.
        if (a.variant === 'tabStrip' && a.target && this.mover.attachedSurface?.surfaceKind !== 'tabStrip') {
          a.approachMs = Math.max(TRAVEL_TIMEOUT_MS, this.approachTimeoutMs(a.target, 'walk', 0));
        }
        this.beginExcursion(a);
        break;
      case 'chasingCursor': {
        const stalk = chance(this.random, 0.35);
        this.phase(a, stalk ? 'stalk' : 'approach', stalk ? range(this.random, 400, 900) : 0);
        bumpCounter(this.cat.memory, 'chasesStarted');
        break;
      }
      case 'watchingCursor':
        // After a playful dodge the cat turns back to the pointer in a crouch, ready to pounce.
        if (a.variant === 'playful') this.phase(a, 'crouch', range(this.random, 600, 1100));
        else this.phase(a, 'main');
        break;
      case 'curious': {
        this.emotes.show('question', this.now);
        this.react('headTilt');
        const near = !a.target || Math.abs(a.target.x - this.mover.x) < 2.5 * this.bl;
        if (a.variant === 'look' || near) this.phase(a, 'look', range(this.random, 3000, 7000));
        else this.phase(a, 'approach');
        break;
      }
      case 'inspectingWindow':
        this.phase(a, 'approach');
        if (a.variant !== 'edge') a.approachMs = this.inspectApproachMs(a);
        this.beginExcursion(a);
        break;
      case 'watchingUser':
        if (a.variant === 'nearby') this.phase(a, 'approach');
        else this.phase(a, 'sit', range(this.random, 15_000, 25_000));
        break;
      case 'playing':
        this.enterPlaying(a);
        break;
      case 'beingPetted':
        a.lastPetAt = this.now;
        this.emotes.show('heart', this.now, true);
        break;
      case 'startled':
        // An occasional surprise at nothing in particular is a mild start, not a fright.
        if (a.variant === 'surprise') this.reactions.set('surprise', this.now, SURPRISE_COOLDOWN_MS);
        addStat(this.cat.stats, 'fear', a.variant === 'surprise' ? 0.12 : a.variant === 'lostFooting' ? 0.15 : 0.35);
        this.emotes.show('exclaim', this.now, true);
        this.rememberEvent('startle');
        break;
      case 'annoyed':
        this.emotes.show('anger', this.now, true);
        this.rememberEvent('annoyed');
        break;
      case 'seekingAttention':
        if (a.variant !== 'greet') bumpCounter(this.cat.memory, 'attentionRequests');
        this.phase(a, 'approach');
        break;
      case 'resting':
        this.phase(a, chance(this.random, 0.7) ? 'loaf' : 'sit');
        break;
      case 'hiding':
        this.enterHiding(a);
        break;
      case 'held':
        this.lastDragCursorAt = this.now;
        break;
      case 'jumping':
        this.phase(a, 'crouch');
        break;
      case 'landing':
        this.enterLanding(a);
        break;
      case 'away':
        this.phase(a, this.awayWasAsleep ? 'sleep' : 'main');
        break;
      case 'grooming':
      case 'falling':
        break;
    }
  }

  private exitActivity(a: Activity): void {
    this.settleExcursion(a);
    switch (a.state) {
      case 'chasingCursor':
        if (a.observedMs >= 1200) {
          const engaged = a.engagedMs / a.observedMs >= 0.35;
          const p = this.cat.memory.preferences;
          p.cursorPlayAcceptance = ema01(p.cursorPlayAcceptance, engaged ? 1 : 0, 0.2);
          bumpCounter(this.cat.memory, engaged ? 'chasesEngaged' : 'chasesIgnored');
          if (engaged) addStat(this.cat.stats, 'bond', 0.003);
          this.rememberEvent('chase', engaged ? 'engaged' : 'ignored');
        }
        break;
      case 'seekingAttention':
        if (a.variant !== 'greet') {
          const p = this.cat.memory.preferences;
          p.attentionAcceptance = ema01(p.attentionAcceptance, a.answered ? 1 : 0, 0.25);
          if (a.answered) {
            bumpCounter(this.cat.memory, 'attentionAnswered');
            addStat(this.cat.stats, 'bond', 0.01);
          }
          this.rememberEvent('attention', a.answered ? 'answered' : 'unanswered');
        }
        break;
      case 'inspectingWindow':
        if (a.phase !== 'approach') {
          bumpCounter(this.cat.memory, 'windowsInspected');
          this.rememberEvent('inspect', this.mover.perchWindowId ? 'window' : 'floor');
        }
        break;
      case 'sleeping':
        if (this.now - a.startedAt >= 30_000) {
          bumpCounter(this.cat.memory, 'naps');
          this.rememberEvent('nap');
          this.awakeSince = this.now;
        }
        this.flushRestSpot();
        break;
      case 'resting':
        this.flushRestSpot();
        break;
      case 'playing':
        if (a.variant === 'zoomies' || a.variant === 'rollOver' || a.variant === 'pawAt' || a.variant === 'hop') this.rememberEvent('play', a.variant);
        break;
      default:
        break;
    }
  }

  private rememberEvent(kind: Parameters<typeof remember>[1], detail?: MemoryDetail): void {
    remember(this.cat.memory, kind, this.wall(), detail);
    this.markDirty();
  }

  private updateActivity(): void {
    const a = this.act;
    switch (a.state) {
      case 'sleeping':
        return this.updSleeping(a);
      case 'wakingUp':
        this.stop();
        if (a.phase === 'stretch' && this.phaseElapsed(a)) this.phase(a, 'settle', range(this.random, 500, 1200));
        else if (a.phase === 'settle' && this.phaseElapsed(a)) this.finish();
        return;
      case 'fallingAsleep':
        this.stop();
        if (a.phase === 'yawn' && this.phaseElapsed(a)) this.phase(a, 'loaf', a.quick ? 350 : range(this.random, 1500, 3000));
        else if (a.phase === 'loaf' && this.phaseElapsed(a)) this.finish({ state: 'sleeping', init: { variant: a.variant } });
        return;
      case 'idle':
        if (this.pending) this.finish();
        else if (a.phase === 'stand' && this.now - a.phaseAt > 2500) this.phase(a, 'sit');
        return;
      case 'walking':
      case 'running':
        return this.updMove(a);
      case 'chasingCursor':
        return this.updChase(a);
      case 'watchingCursor':
        return this.updWatchCursor(a);
      case 'curious':
        return this.updCurious(a);
      case 'inspectingWindow':
        return this.updInspect(a);
      case 'watchingUser':
        return this.updWatchUser(a);
      case 'playing':
        return this.updPlaying(a);
      case 'beingPetted':
        return this.updPetted(a);
      case 'startled':
        this.stop();
        if (this.now - a.startedAt >= a.dwellMs) this.finish(this.afterStartle(a));
        return;
      case 'annoyed':
        this.stop();
        if (this.now - a.startedAt >= a.dwellMs) this.finish(this.afterAnnoyed());
        return;
      case 'seekingAttention':
        return this.updSeekAttention(a);
      case 'resting':
      case 'grooming':
        this.stop();
        return;
      case 'hiding':
        return this.updHiding(a);
      case 'held':
        return this.updHeld(a);
      case 'jumping':
        a.phase = this.mover.mode === 'crouch' ? 'crouch' : 'air';
        return;
      case 'falling':
        return;
      case 'landing':
        if (this.now - a.startedAt >= LANDING_MS) this.finish();
        return;
      case 'away':
        this.stop();
        return;
    }
  }

  private updSleeping(a: Activity): void {
    this.stop();
    const env = this.env;
    if (this.now - a.startedAt > 4000) this.emotes.show('zzz', this.now);
    if (!env || this.mode !== 'normal') return;
    const elapsed = this.now - a.startedAt;
    if (a.variant === 'intro') {
      if (elapsed >= a.dwellMs) this.finish({ state: 'wakingUp', init: {} });
      return;
    }
    const idleSleep = userIdleForSleep({ userIdleMs: env.userIdleMs, behavior: this.settings.behavior });
    if (a.variant === 'idleSleep') {
      if (!idleSleep && env.userIdleMs < 5000 && elapsed > 3000) this.finish({ state: 'wakingUp', init: { then: this.greetFollowUp() } });
      return;
    }
    if (idleSleep) return;
    if (elapsed >= a.dwellMs) {
      if (this.cat.stats.energy >= 0.55 || elapsed >= 2 * STATE_SPECS.sleeping.dwellMs[1]) this.finish({ state: 'wakingUp', init: {} });
      else a.dwellMs += 60_000;
    }
  }

  /** Greeting after the user returns: off at 'Attention seeking' 0 %, rarer below the default. */
  private greetFollowUp(): FollowUp | null {
    if (this.disabled.has('seekAttention') || !this.reactions.ready('greet', this.now)) return null;
    const seeking = clamp(this.settings.behavior.attentionSeeking, 0, 1);
    if (!(seeking > 0) || (seeking < 0.35 && !chance(this.random, seeking / 0.35))) return null;
    this.reactions.set('greet', this.now, 10 * 60_000);
    return { state: 'seekingAttention', init: { variant: 'greet' } };
  }

  private updMove(a: Activity): void {
    const env = this.env;
    if (a.variant === 'follow') {
      const rect = a.windowId ? this.windowRect(a.windowId, true) : null;
      if (!rect || this.now - a.startedAt > 6000) {
        this.finish();
        return;
      }
      this.goTo({ x: rect.x + rect.width / 2, y: this.mover.y }, 'walk', false, this.bl * 1.5);
      return;
    }
    if (!a.target || !env) {
      this.finish();
      return;
    }
    const timeout = a.variant === 'climb' ? CLIMB_TIMEOUT_MS : a.approachMs > 0 ? a.approachMs : TRAVEL_TIMEOUT_MS;
    if (a.goalStatus === 'arrived' || a.goalStatus === 'unreachable' || this.now - a.startedAt > timeout) {
      // A trip up that did not get there (a goal whose top vanished ends on the floor below it): no
      // patrol along a top it never reached.
      if (a.then?.init.variant === 'patrol' && !(this.excursion?.act === a && this.excursion.arrived)) a.then = null;
      this.finish(a.then);
      if (a.variant === 'called') this.emotes.show('heart', this.now);
      return;
    }
    switch (a.variant) {
      case 'climb':
        // Up a window side to its top corner (then a pull-up), or down from the corner of the top it stands on.
        this.goTo(a.target, 'walk', true, undefined, { route: 'climb' });
        return;
      case 'patrol':
        // Along the top it is on, never off it.
        this.goTo(a.target, 'walk', false);
        return;
      case 'taskbar':
        // Onto the taskbar, or down off it to the floor it covers: exactly the surface named.
        this.goTo(a.target, 'walk', true, undefined, { literal: true });
        return;
      case 'tabStrip': {
        // Along the strip it is on, slowly; to a strip elsewhere by any way up (climbing too, v1.1.1).
        const onStrip = this.mover.attachedSurface?.surfaceKind === 'tabStrip';
        this.goTo(a.target, onStrip ? 'slow' : 'walk', true, undefined, { route: this.climbAllowed() ? 'any' : 'noClimb' });
        return;
      }
      default: {
        const pace: Pace = a.state === 'running' ? 'run' : a.variant === 'favorite' || a.variant === 'nearby' ? 'slow' : 'walk';
        this.goTo(a.target, pace, a.variant !== 'retreat' && a.variant !== 'playful');
      }
    }
  }

  private updChase(a: Activity): void {
    const cur = this.cursorInfo();
    if (!cur) {
      this.finish({ state: 'idle', init: {} });
      return;
    }
    a.observedMs += this.dt;
    if (cur.speedDip > 120) a.engagedMs += this.dt;
    if (!cur.reachable) {
      this.finish({ state: 'watchingCursor', init: {} });
      return;
    }
    const dx = cur.point.x - this.mover.x;
    switch (a.phase) {
      case 'stalk':
        this.stop();
        this.mover.faceToward(cur.point.x, this.now);
        if (this.phaseElapsed(a)) this.phase(a, 'approach');
        return;
      case 'pawAt':
      case 'look':
        this.stop();
        this.mover.faceToward(cur.point.x, this.now);
        if (Math.abs(dx) > 1.6 * this.bl) this.phase(a, 'approach');
        // 'Paw at the pointer' off: it sits and watches the pointer instead of batting at it.
        else if (a.phase === 'pawAt' && this.disabled.has('pawAtCursor')) this.phase(a, 'look');
        return;
      default: {
        const low = cur.point.y > this.mover.y - 1.6 * this.mover.bodyHeight;
        if (Math.abs(dx) < 0.8 * this.bl && low) {
          this.stop();
          this.phase(a, this.disabled.has('pawAtCursor') ? 'look' : 'pawAt');
          return;
        }
        // Closing in, the cat may cover the last body length or two in one pounce.
        const gap = Math.abs(dx) / this.bl;
        if (gap >= 1 && gap <= 2.2 && this.perSecond(0.8) && this.tryPounce(cur, 1)) return;
        this.goTo({ x: cur.point.x, y: this.mover.y }, 'chase', false, 0.5 * this.bl);
      }
    }
  }

  private updWatchCursor(a: Activity): void {
    this.stop();
    const cur = this.cursorInfo();
    if (!cur) {
      if (this.now - this.lastCursorSeenAt > 2000) this.finish();
      return;
    }
    this.mover.faceToward(cur.point.x, this.now);
    if (a.phase === 'main' && cur.distBodyLengths < 3 && cur.speedDip > 200 && this.perSecond(0.3 * this.cat.traits.playfulness)) this.phase(a, 'crouch', 900);
    else if (a.phase === 'crouch' && this.phaseElapsed(a)) {
      // The wind-up ends in a pounce when the pointer is within reach on the cat's level.
      const p = a.variant === 'playful' ? 0.8 : 0.25 + 0.5 * this.cat.traits.playfulness;
      this.phase(a, 'main');
      this.tryPounce(cur, p);
    }
  }

  /**
   * A short pounce toward the pointer on the current surface (cursor play, 'Chase the pointer').
   * Bounded by a cooldown; the interrupted activity resumes after landing.
   */
  private tryPounce(cur: { point: Point; reachable: boolean }, p: number): boolean {
    if (this.mode !== 'normal' || this.typing || this.disabled.has('chaseCursor') || !cur.reachable || !(this.settings.behavior.cursorPlay > 0)) return false;
    const gap = Math.abs(cur.point.x - this.mover.x) / this.bl;
    if (gap < 0.7 || gap > 2.6 || cur.point.y < this.mover.y - 1.6 * this.mover.bodyHeight) return false;
    if (!this.reactions.ready('pounce', this.now) || !chance(this.random, p)) return false;
    if (!this.mover.pounce(this.now, cur.point.x)) return false;
    if (this.request('jumping', 'physical', { suspend: true }) !== 'ok') {
      this.mover.cancelCrouch();
      return false;
    }
    this.fallReason = 'jump';
    this.reactions.set('pounce', this.now, POUNCE_COOLDOWN_MS);
    return true;
  }

  private updCurious(a: Activity): void {
    const t = a.target;
    if (!t) {
      this.finish();
      return;
    }
    if (a.phase === 'approach') {
      if (a.goalStatus === 'arrived' || a.goalStatus === 'unreachable' || this.now - a.phaseAt > 12_000) {
        this.stop();
        this.phase(a, 'look', range(this.random, 3000, 7000));
        return;
      }
      const side = Math.sign(t.x - this.mover.x) || 1;
      this.goTo({ x: t.x - side * 1.2 * this.bl, y: t.y }, 'walk', true);
      return;
    }
    this.stop();
    this.mover.faceToward(t.x, this.now);
    if (this.phaseElapsed(a)) this.finish();
  }

  private updInspect(a: Activity): void {
    if (a.variant === 'edge') return this.updEdge(a);
    const rect = a.windowId ? this.windowRect(a.windowId, true) : null;
    if (!rect) {
      this.finish();
      return;
    }
    const center = rectCenter(rect);
    if (a.phase === 'approach') {
      // As long as the way there takes (walk, leap, climb), not a fixed 15 s (v1.1.1).
      if (a.goalStatus === 'arrived' || a.goalStatus === 'unreachable' || this.now - a.phaseAt > (a.approachMs > 0 ? a.approachMs : APPROACH_MIN_MS)) {
        this.stop();
        const look = range(this.random, 4000, 9000);
        this.phase(a, 'look', look);
        // Having got up to explore, it looks around before anything else comes to mind.
        if (a.variant === 'explore') a.dwellMs = Math.max(a.dwellMs, this.now - a.startedAt + look + 500);
        return;
      }
      const top = this.mover.ledgeSurfaces.find((l) => l.ownerId === a.windowId && (l.surfaceKind === 'windowTop' || l.surfaceKind === 'tabStrip'));
      if (top) {
        // On its way up the cat is not distracted by its next decision: the approach's own timeout ends it.
        a.dwellMs = Math.max(a.dwellMs, this.now - a.startedAt + 1000);
        this.goTo({ x: clamp(this.mover.x, top.x0, top.x1), y: top.y }, 'walk', true);
      } else {
        const side = Math.sign(center.x - this.mover.x) || 1;
        this.goTo({ x: center.x - side * this.bl, y: rect.y + rect.height }, 'walk', true);
      }
      return;
    }
    this.stop();
    this.mover.faceToward(center.x, this.now);
    if (!this.phaseElapsed(a)) return;
    // Up on the top it came to explore: a walk along it first (then a sit up there).
    if (a.phase === 'look' && a.variant === 'explore' && this.mover.perchWindowId === a.windowId && this.topVisit && this.topVisit.walked < TOP_PATROL_BL * this.bl) {
      this.finish({ state: 'walking', init: { variant: 'patrol' } });
      return;
    }
    if (a.phase === 'look' && this.mover.perchWindowId === a.windowId && chance(this.random, 0.5)) this.phase(a, 'loaf', range(this.random, 4000, 9000));
    else this.finish();
  }

  /** Sitting at the edge of the window top it stands on, looking down into the window. */
  private updEdge(a: Activity): void {
    const m = this.mover;
    const on = m.attachedSurface;
    if (!a.windowId || !on || on.ownerId !== a.windowId || on.surfaceKind !== 'windowTop' || !m.grounded) {
      this.finish();
      return;
    }
    if (a.phase === 'approach') {
      if (!a.target || a.goalStatus === 'arrived' || a.goalStatus === 'unreachable' || this.now - a.phaseAt > 10_000) {
        this.stop();
        this.phase(a, 'look', range(this.random, 4000, 9000));
        return;
      }
      this.goTo(a.target, 'slow', false);
      return;
    }
    this.stop();
    const look = this.edgeLookPoint(a.windowId);
    this.mover.faceToward(look.x, this.now);
    if (!this.phaseElapsed(a)) return;
    if (a.phase === 'look' && chance(this.random, 0.4)) this.phase(a, 'loaf', range(this.random, 5000, 12_000));
    else this.finish();
  }

  /** A point inside the window below the cat on its top edge: where it looks while sitting there. */
  private edgeLookPoint(windowId: string): Point {
    const m = this.mover;
    const bh = m.bodyHeight;
    const rect = this.windowRect(windowId);
    const ahead = m.x + m.facing * 1.2 * this.bl;
    if (!rect) return { x: ahead, y: m.y + 3 * bh };
    return { x: clamp(ahead, rect.x, rect.x + rect.width), y: Math.max(m.y + bh, Math.min(m.y + 4 * bh, rect.y + rect.height * 0.5)) };
  }

  private updWatchUser(a: Activity): void {
    const fg = this.env?.foreground ?? null;
    if (a.phase === 'approach') {
      if (!fg || a.goalStatus === 'arrived' || a.goalStatus === 'unreachable' || this.now - a.phaseAt > 10_000) {
        this.stop();
        this.phase(a, 'sit', range(this.random, 15_000, 25_000));
        return;
      }
      const c = rectCenter(fg.rect);
      const side = Math.sign(c.x - this.mover.x) || 1;
      this.goTo({ x: c.x - side * this.bl, y: fg.rect.y + fg.rect.height }, 'slow', true);
      return;
    }
    this.stop();
    const look = this.lookForState();
    if (look) this.mover.faceToward(look.x, this.now);
    if (a.phase === 'sit' && this.phaseElapsed(a)) this.phase(a, 'loaf');
  }

  private enterPlaying(a: Activity): void {
    switch (a.variant) {
      case 'rollOver':
        this.phase(a, 'rollOver', range(this.random, 2500, 5000));
        return;
      case 'hop':
        this.phase(a, 'hop');
        return;
      case 'zoomies':
        a.counter = 0;
        this.phase(a, 'crouch', range(this.random, 300, 700));
        return;
      default:
        a.variant = 'pawAt';
        this.phase(a, 'crouch', range(this.random, 400, 900));
    }
  }

  private updPlaying(a: Activity): void {
    switch (a.variant) {
      case 'hop':
        this.stop();
        if (a.phase === 'hop') {
          if (a.counter === 0) {
            a.counter = 1;
            if (this.mover.hop(this.now) && this.request('jumping', 'physical', { suspend: true }) === 'ok') {
              this.fallReason = 'jump';
              this.emotes.show('sparkle', this.now);
            } else {
              this.mover.cancelCrouch();
              this.finish();
            }
          } else {
            this.phase(a, 'sit', 700);
          }
        } else if (this.phaseElapsed(a)) {
          this.finish();
        }
        return;
      case 'zoomies':
        if (a.phase === 'crouch') {
          this.stop();
          if (this.phaseElapsed(a)) {
            this.phase(a, 'zoomies');
            a.counter = 2 + Math.floor(range(this.random, 0, 3));
            a.target = this.zoomieTarget();
          }
          return;
        }
        if (!a.target || a.goalStatus === 'arrived' || a.goalStatus === 'unreachable') {
          a.counter--;
          a.goalStatus = 'none';
          if (a.counter <= 0) {
            this.finish({ state: this.cat.stats.energy < 0.5 ? 'resting' : 'idle', init: {} });
            return;
          }
          a.target = this.zoomieTarget();
          this.stop();
        }
        if (a.target) this.goTo(a.target, 'run', false);
        return;
      case 'rollOver':
        this.stop();
        if (this.phaseElapsed(a)) this.finish();
        return;
      default:
        this.stop();
        if (a.phase === 'crouch' && this.phaseElapsed(a)) this.phase(a, 'pawAt', range(this.random, 2000, 5000));
        else if (a.phase === 'pawAt' && this.phaseElapsed(a)) this.finish();
    }
  }

  private zoomieTarget(): Point | null {
    const s = this.mover.walkRange;
    if (!s) return null;
    const x = this.mover.x;
    const room = Math.max(x - s.x0, s.x1 - x);
    if (room < 2 * this.bl) return null;
    const dir = x - s.x0 > s.x1 - x ? -1 : 1;
    const dist = range(this.random, 0.5, 1) * Math.min(room, 14 * this.bl);
    return { x: clamp(x + dir * Math.max(dist, 2 * this.bl), s.x0, s.x1), y: this.mover.y };
  }

  private updPetted(a: Activity): void {
    this.stop();
    const sinceLast = this.now - a.lastPetAt;
    if (sinceLast > 1800) {
      this.finish(this.afterPetting());
      return;
    }
    if (this.now - a.startedAt > 45_000) this.finish({ state: chance(this.random, 0.5) ? 'walking' : 'idle', init: { variant: 'wander', target: this.wanderTarget() } });
    else if (this.now - a.startedAt > 3000) this.emotes.show('note', this.now);
  }

  private afterPetting(): FollowUp {
    const sleepy = this.currentSleepiness();
    if (this.mode === 'paused') return { state: 'resting', init: {} };
    if (sleepy > 0.5 && !this.coolingDown('fallingAsleep')) return { state: 'fallingAsleep', init: {} };
    const r = this.random();
    if (r < 0.4) return { state: 'resting', init: {} };
    if (r < 0.65 && !this.disabled.has('grooming')) return { state: 'grooming', init: {} };
    return { state: 'idle', init: {} };
  }

  private afterStartle(a: Activity): FollowUp {
    const fear = this.cat.stats.fear;
    if (fear > 0.45 && this.cat.traits.confidence < 0.6) return { state: 'hiding', init: { variant: 'flee' } };
    if (a.target && chance(this.random, this.cat.traits.curiosity)) return { state: 'curious', init: { target: a.target } };
    if (this.cursorInfo()) return { state: 'watchingCursor', init: {} };
    return { state: 'idle', init: {} };
  }

  private afterAnnoyed(): FollowUp {
    if (this.cat.stats.annoyance >= IRRITATED_ANNOYANCE) return { state: 'hiding', init: { variant: 'flee' } };
    const r = this.random();
    if (r < 0.4 && !this.disabled.has('grooming')) return { state: 'grooming', init: {} };
    if (r < 0.7) {
      const target = this.retreatTarget();
      if (target) return { state: 'walking', init: { variant: 'retreat', target } };
    }
    return { state: 'idle', init: {} };
  }

  private updSeekAttention(a: Activity): void {
    const cur = this.cursorInfo();
    const fg = this.env?.foreground ?? null;
    if (a.phase === 'approach') {
      const goal = cur?.point ?? (fg ? { x: fg.rect.x + fg.rect.width / 2, y: fg.rect.y + fg.rect.height } : null);
      const close = goal ? Math.abs(goal.x - this.mover.x) < 1.5 * this.bl : true;
      if (!goal || close || a.goalStatus === 'arrived' || a.goalStatus === 'unreachable' || this.now - a.phaseAt > 12_000 || a.variant === 'greet') {
        this.stop();
        this.phase(a, 'meow', 900);
        this.restartClip = true;
        this.emotes.show(a.variant === 'greet' || this.cat.stats.bond > 0.5 ? 'heart' : 'question', this.now, true);
        return;
      }
      const side = Math.sign(goal.x - this.mover.x) || 1;
      this.goTo({ x: goal.x - side * 1.2 * this.bl, y: goal.y }, 'walk', true);
      return;
    }
    this.stop();
    if (cur) this.mover.faceToward(cur.point.x, this.now);
    if (a.phase === 'meow' && this.phaseElapsed(a)) this.phase(a, 'wait', a.variant === 'greet' ? 2500 : range(this.random, 6000, 12_000));
    else if (a.phase === 'wait' && this.phaseElapsed(a)) this.finish(a.answered ? null : { state: chance(this.random, 0.5) ? 'resting' : 'idle', init: {} });
  }

  private enterHiding(a: Activity): void {
    const s = this.mover.walkRange;
    this.rememberEvent('hide');
    if (!s) {
      this.phase(a, 'hide');
      return;
    }
    const threatX = this.env?.cursor?.x ?? this.mover.x + this.mover.facing * this.bl;
    const edge = threatX < this.mover.x ? s.x1 : s.x0;
    if (Math.abs(edge - this.mover.x) < this.bl) {
      this.phase(a, 'hide');
      return;
    }
    a.target = { x: edge, y: this.mover.y };
    this.phase(a, 'flee');
  }

  private updHiding(a: Activity): void {
    if (a.phase === 'flee') {
      if (!a.target || a.goalStatus === 'arrived' || a.goalStatus === 'unreachable' || this.now - a.phaseAt > 8000) {
        this.stop();
        this.phase(a, 'hide');
        return;
      }
      this.goTo(a.target, this.cat.stats.fear > 0.35 ? 'run' : 'walk', false);
      return;
    }
    this.stop();
    if (this.now - a.startedAt >= a.dwellMs) this.finish({ state: chance(this.random, 0.5) && !this.disabled.has('grooming') ? 'grooming' : 'idle', init: {} });
  }

  private updHeld(a: Activity): void {
    const env = this.env;
    if (!this.mover.held) return;
    if (env?.dragCursor) this.lastDragCursorAt = this.now;
    else if (this.now - this.lastDragCursorAt > DRAG_LOST_MS) {
      this.mover.endDrag(null, ZERO, this.now, false);
      this.fallReason = 'drop';
      this.request('falling', 'physical');
      return;
    }
    if (this.now - a.startedAt > 15_000) {
      addStat(this.cat.stats, 'annoyance', (0.01 * this.dt * (1.2 - this.settings.interaction.patience)) / 1000);
      this.emotes.show('anger', this.now);
    }
  }

  private enterLanding(a: Activity): void {
    a.dwellMs = LANDING_MS;
    const info: LandingInfo | null = a.landing;
    const reason = this.fallReason;
    this.fallReason = null;
    if (this.mode !== 'normal' || !info) return;
    // Planned moves and calm drops (a retracting taskbar) resume what the cat was doing.
    if (reason === 'jump' || reason === 'step' || reason === 'retracted') return;
    this.discardSuspended();
    if (info.forced) return;
    // Cats land on their feet after a plain drop; only a hard throw upsets them.
    if (reason === 'throw' && info.thrown) {
      addStat(this.cat.stats, 'fear', 0.25);
      addStat(this.cat.stats, 'annoyance', 0.1);
      const annoyed = this.cat.stats.annoyance > 0.35 || this.cat.traits.confidence > 0.65;
      a.then = { state: annoyed ? 'annoyed' : 'startled', init: {} };
      return;
    }
    if (reason === 'perch') {
      // The window it sat on vanished: a short start, not a fright.
      a.then = { state: 'startled', init: { variant: 'lostFooting' } };
      return;
    }
    if (reason === 'drop' || reason === 'throw') {
      a.then = { state: chance(this.random, 0.35) && !this.disabled.has('grooming') ? 'grooming' : 'idle', init: {} };
    }
  }

  // ---- events ---------------------------------------------------------------------

  private handleEvent(ev: SimEvent): void {
    let relocated = false;
    switch (ev.type) {
      case 'lifecycle.quitRequested':
        this.startQuit();
        return;
      // A locked session stays locked across suspend/resume: only unlock ends it.
      case 'system.lock':
        this.systemLocked = true;
        return;
      case 'system.unlock':
        this.systemLocked = false;
        return;
      case 'system.suspend':
        this.systemSuspended = true;
        return;
      case 'system.resume':
        this.systemSuspended = false;
        return;
      case 'display.changed':
        return;
      // Privacy verdicts are kept in every mode, so a window marked private stays off limits.
      // Window rects from events back up surface geometry (in memory only).
      case 'window.shown':
      case 'window.restored':
      case 'window.foreground':
        if (ev.window) {
          this.notePrivacy(ev.window.id, ev.window.excluded);
          if (!ev.window.minimized) this.noteWindowRect(ev.window.id, ev.window.rect);
        }
        break;
      case 'window.moveStart':
        this.notePrivacy(ev.id, ev.excluded);
        break;
      case 'window.moveEnd':
        this.notePrivacy(ev.id, ev.excluded);
        this.noteWindowRect(ev.id, ev.rect);
        break;
      case 'window.closed':
      case 'window.minimized':
        this.windowRects.delete(ev.id);
        break;
      case 'command.callCat':
        // Called while a fullscreen app keeps it hidden or quiet: it comes over to the caller's display.
        if (this.onFullscreenDisplay() && isFinitePoint(ev.at) && this.mover.relocate(ev.at)) {
          relocated = true;
          this.snapNext = true;
          this.updateMode();
        }
        break;
      default:
        break;
    }
    if (this.mode === 'quit' || this.mode === 'away') return;
    switch (ev.type) {
      case 'pointer.dragStart':
        return this.onDragStart(ev.at);
      case 'pointer.dragEnd':
        return this.onDragEnd(ev.at, ev.velocity);
      case 'pointer.pet':
        return this.onPet(ev.strength);
      case 'pointer.tap':
        return this.onTap(ev.at);
      case 'pointer.doubleTap':
        return this.onDoubleTap(ev.at);
      case 'pointer.hoverStart':
        if (this.settings.interaction.enabled && isFinitePoint(ev.at)) {
          this.lastInteractionAt = this.now;
          if (!ASLEEP_STATES.has(this.act.state)) this.setGlance(ev.at, 2000);
        }
        return;
      case 'pointer.hoverEnd':
        return;
      case 'command.sleep':
        if (this.mode === 'normal' || this.mode === 'paused') this.request('fallingAsleep', 'command', { variant: 'forced' });
        return;
      default:
        break;
    }
    if (this.mode !== 'normal') return;
    switch (ev.type) {
      case 'window.shown':
      case 'window.restored':
        return this.onWindowAppeared(ev.window, ev.type === 'window.shown');
      case 'window.closed': {
        this.movingWindows.delete(ev.id);
        const excluded = ev.excluded === true || this.excludedWindows.has(ev.id);
        this.excludedWindows.delete(ev.id);
        // The window the cat is on: losing its footing is the reaction (the mover drops it).
        if (ev.rect && isFiniteRect(ev.rect) && this.mover.perchWindowId !== ev.id) this.onWindowClosed(ev.rect, ev.category, excluded);
        return;
      }
      case 'window.foreground':
        return this.onForeground(ev.window, ev.switchesPerMinute);
      case 'window.moveStart':
        return this.onMoveStart(ev.id, this.excludedWindows.has(ev.id));
      case 'window.moveEnd':
        this.movingWindows.delete(ev.id);
        if (ev.rect && isFiniteRect(ev.rect)) this.onMoveEnd(ev.id, ev.rect, this.excludedWindows.has(ev.id));
        return;
      case 'window.minimized':
        this.movingWindows.delete(ev.id);
        return;
      case 'activity.typingStart':
        return this.onTypingStart();
      case 'activity.typingEnd':
        return;
      case 'activity.userIdle':
        this.nextDriveAt = this.now;
        return;
      case 'activity.userReturned':
        return this.onUserReturned(ev.idleMs);
      case 'cursor.flick':
        return this.onFlick(ev.speed, ev.at);
      case 'perception.visual':
        return this.onVisual(ev.summary.events, ev.summary.changeCenterPx, ev.summary.regionPx);
      case 'perception.ai':
        // An AI-described video or game counts like video-like local statistics: the cat keeps calmer.
        if (ev.report.scene === 'video' || ev.report.scene === 'game') this.screen = { kind: 'video', until: this.now + SCREEN_FRESH_MS };
        return this.onAi(ev.report.reaction, ev.report.interest, ev.regionPx);
      case 'command.callCat':
        return this.onCallCat(ev.at, relocated);
      case 'command.wake':
        if (ASLEEP_STATES.has(this.act.state) || this.act.state === 'resting') this.request('wakingUp', 'command');
        else this.playOneShot('meow', 900);
        return;
      case 'command.play':
        return this.onPlayCommand();
      case 'taskbar.shown':
        return this.onTaskbarShown(ev.surfaceId);
      case 'taskbar.hidden':
        return this.onTaskbarHidden(ev.surfaceId);
      case 'tabs.changed':
        return this.onTabsChanged(ev.surfaceId, ev.ownerId, ev.change, ev.focusX);
      default:
        return;
    }
  }

  // ---- environment surfaces ---------------------------------------------------------

  /**
   * Current geometry of a ledge of the given kind: the usable one the mover knows, else the
   * listed surface (not yet usable, e.g. still sliding in). Never a private window's, and
   * never a surface of another kind (a stale or mismatched id in an event).
   */
  private ledgeGeometry(id: string, kind: 'taskbar' | 'tabStrip'): { y: number; x0: number; x1: number; rest: { x0: number; x1: number } | null; ownerId: string | null } | null {
    const usable = this.mover.ledgeById(id);
    if (usable) return usable.surfaceKind === kind ? { y: usable.y, x0: usable.x0, x1: usable.x1, rest: usable.rest, ownerId: usable.ownerId } : null;
    const s = this.surfaceIndex.get(id);
    if (!s || s.orientation !== 'ledge' || s.kind !== kind || s.excluded === true || this.excludedWindows.has(s.ownerId)) return null;
    if (!Number.isFinite(s.y) || !Number.isFinite(s.x0) || !Number.isFinite(s.x1) || s.x1 <= s.x0) return null;
    return { y: s.y, x0: s.x0, x1: s.x1, rest: null, ownerId: s.ownerId };
  }

  /** Distance from the cat's anchor to the nearest point of a ledge, in body lengths. */
  private ledgeDistanceBl(l: { y: number; x0: number; x1: number }): number {
    const m = this.mover;
    return Math.hypot(clamp(m.x, l.x0, l.x1) - m.x, l.y - m.y) / this.bl;
  }

  /**
   * An auto-hide taskbar slid into view. How much the cat cares depends on how close it
   * is, what it is doing and its personality, and habituates fast: repeated shows soon get
   * nothing more than a glance. It may look toward it, or walk over and hop onto it (rare,
   * with a long cooldown); however often it flaps, at most one decision per few seconds.
   * Held, airborne or thrown, it ignores it; asleep it wakes only when it is right there and
   * curious enough (the physical lift of a cat standing above it happens regardless).
   */
  private onTaskbarShown(surfaceId: string): void {
    if (this.disabled.has('taskbarPlay') || typeof surfaceId !== 'string') return;
    const s = this.act.state;
    if (PHYSICAL_STATES.has(s)) return;
    const tb = this.ledgeGeometry(surfaceId, 'taskbar');
    if (!tb) return;
    const habituation = this.surfaceHabit.register(`taskbar:${surfaceId}`, this.now);
    if (!this.reactions.take('taskbarReact', this.now, TASKBAR_REACT_GAP_MS)) return;
    const m = this.mover;
    const t = this.cat.traits;
    const st = this.cat.stats;
    const dist = this.ledgeDistanceBl(tb);
    const r = surfaceRelevance({
      distBodyLengths: dist,
      curiosity: t.curiosity,
      playfulness: t.playfulness,
      energy: st.energy,
      confidence: t.confidence,
      sensitivity: this.settings.behavior.activitySensitivity,
      habituation,
      typing: this.typing,
    });
    const point = { x: clamp(m.x, tb.x0, tb.x1), y: tb.y };
    if (m.attachedSurface?.surfaceId === surfaceId) return;
    if (ASLEEP_STATES.has(s)) {
      // Right next to it, a curious, rested cat may get up to see; otherwise an ear flick at most.
      const wakes = s === 'sleeping' && this.act.variant !== 'intro' && dist < 1.5 && r >= 0.5 && t.curiosity >= 0.6 && st.energy >= 0.5;
      if (wakes && chance(this.random, 0.5 * t.curiosity) && this.reactions.take('taskbarWake', this.now, TASKBAR_WAKE_COOLDOWN_MS)) {
        this.request('wakingUp', 'stimulus');
        return;
      }
      if (dist < 3) this.react('earFlick');
      return;
    }
    if (m.onWall) {
      if (r >= 0.05) this.setGlance(point, 1200);
      return;
    }
    // Standing on the floor it covers: the taskbar lifts the cat (physics); nothing to walk over to.
    const cur = m.currentSurface;
    if (cur?.kind === 'floor' && m.x >= tb.x0 && m.x <= tb.x1 && tb.y < m.y && m.y - tb.y <= 1.5 * m.bodyHeight) return;
    const intense = this.typing || (this.settings.behavior.reactToTyping && this.env !== null && this.env.typingIntensity > 0.5);
    const calm = CALM_STATES.has(s) || (s === 'walking' && this.act.cause !== 'command' && this.act.cause !== 'interaction');
    if (r >= 0.45 && calm && !intense && st.fear < 0.3 && this.reactions.ready('taskbarHop', this.now) && dist > 0.5 && m.canReach(point)) {
      if (this.request('walking', 'stimulus', { variant: 'taskbar', target: point, windowId: surfaceId }) === 'ok') {
        this.reactions.set('taskbarHop', this.now, range(this.random, TASKBAR_HOP_COOLDOWN_MS[0], TASKBAR_HOP_COOLDOWN_MS[1]));
        return;
      }
    }
    if (r >= 0.2 && CALM_STATES.has(s) && s !== 'curious' && this.reactions.take('taskbarLook', this.now, TASKBAR_LOOK_COOLDOWN_MS)) {
      if (this.request('curious', 'stimulus', { target: point, variant: 'look' }) === 'ok') return;
    }
    if (r >= 0.05 && !ACTIVE_STATES.has(s)) this.setGlance(point, 1500);
  }

  /**
   * A taskbar started sliding away. A trip to it is called off. Standing on it, the cat
   * flicks an ear and rides it down (the mover then sets it down or lets it drop calmly);
   * now and then a lively one hops down to the floor instead.
   */
  private onTaskbarHidden(surfaceId: string): void {
    if (this.disabled.has('taskbarPlay') || typeof surfaceId !== 'string') return;
    const a = this.act;
    if ((a.state === 'walking' || a.state === 'running') && a.variant === 'taskbar' && a.windowId === surfaceId) this.finish();
    const m = this.mover;
    if (m.attachedSurface?.surfaceId !== surfaceId || !m.grounded) return;
    const s = a.state;
    if (PHYSICAL_STATES.has(s) || ASLEEP_STATES.has(s)) return;
    this.react('earFlick');
    const t = this.cat.traits;
    const st = this.cat.stats;
    if (this.typing || !(CALM_STATES.has(s) || s === 'walking') || st.energy < 0.4) return;
    if (!chance(this.random, 0.5 * t.playfulness * st.energy) || !this.reactions.take('taskbarHopOff', this.now, 60_000)) return;
    const floor = m.world.surfaceBelow(m.x, m.y + 1, []);
    if (!floor) return;
    this.request('walking', 'stimulus', { variant: 'taskbar', target: { x: floor.x, y: floor.y } });
  }

  /**
   * A tab was selected or added in a browser tab strip (geometry only, never names). Nearby
   * and awake, the cat glances at the active tab; standing on the strip it may now and then
   * walk over to it (cooldown, habituation, not while the user types).
   */
  private onTabsChanged(surfaceId: string, ownerId: string, change: 'added' | 'removed' | 'selected' | 'geometry', focusX: number | null): void {
    if (this.disabled.has('tabStrips') || (change !== 'selected' && change !== 'added')) return;
    if (typeof focusX !== 'number' || !Number.isFinite(focusX) || typeof surfaceId !== 'string') return;
    if (typeof ownerId === 'string' && this.excludedWindows.has(ownerId)) return;
    const s = this.act.state;
    if (ASLEEP_STATES.has(s) || PHYSICAL_STATES.has(s)) return;
    const strip = this.ledgeGeometry(surfaceId, 'tabStrip');
    if (!strip) return;
    const m = this.mover;
    const onIt = m.attachedSurface?.surfaceId === surfaceId;
    const focus = { x: clamp(focusX, strip.x0, strip.x1), y: strip.y };
    if (!onIt && this.ledgeDistanceBl({ y: strip.y, x0: focus.x, x1: focus.x }) > 10) return;
    const habituation = this.surfaceHabit.register(`tabs:${surfaceId}`, this.now);
    if (habituation > 0.9) return;
    // Look at the tab itself, just below the strip's top edge.
    const look = { x: focus.x, y: strip.y + 0.4 * m.bodyHeight };
    if (onIt && m.grounded && CALM_STATES.has(s) && !this.typing && habituation < 0.6) {
      const rest = strip.rest ?? { x0: strip.x0, x1: strip.x1 };
      const x = clamp(focus.x, rest.x0, rest.x1);
      if (Math.abs(x - m.x) > 1.5 * this.bl && chance(this.random, 0.2 + 0.4 * this.cat.traits.curiosity) && this.reactions.take('tabInvestigate', this.now, TAB_INVESTIGATE_COOLDOWN_MS)) {
        const then: FollowUp = { state: 'idle', init: { target: look } };
        if (this.request('walking', 'stimulus', { variant: 'tabStrip', target: { x, y: strip.y }, then }) === 'ok') return;
      }
    }
    if (!ACTIVE_STATES.has(s)) {
      this.setGlance(look, 1500);
      if (onIt) this.mover.faceToward(focus.x, this.now);
    }
  }

  private noteInteraction(): void {
    this.lastInteractionAt = this.now;
    if (this.act.state === 'seekingAttention') this.act.answered = true;
  }

  private onDragStart(at: Point): void {
    const i = this.settings.interaction;
    if (!i.enabled || !i.dragging || !isFinitePoint(at) || this.mover.held) return;
    this.noteInteraction();
    this.mover.startDrag(at);
    if (this.request('held', 'physical') !== 'ok') {
      this.mover.endDrag(null, ZERO, this.now, false);
      return;
    }
    bumpCounter(this.cat.memory, 'drags');
    addStat(this.cat.stats, 'annoyance', 0.03 * (1.2 - i.patience));
    this.markDirty();
  }

  private onDragEnd(at: Point, velocity: Point): void {
    if (!this.mover.held) return;
    const r = this.mover.endDrag(isFinitePoint(at) ? at : null, isFinitePoint(velocity) ? velocity : ZERO, this.now, this.settings.interaction.throwing);
    this.fallReason = r.thrown ? 'throw' : 'drop';
    if (r.thrown) {
      bumpCounter(this.cat.memory, 'throws');
      addStat(this.cat.stats, 'annoyance', 0.08);
      this.rememberEvent('throw', 'hard');
    }
    this.request('falling', 'physical');
  }

  private onPet(strength: number): void {
    const i = this.settings.interaction;
    if (!i.enabled || !i.petting) return;
    const s = this.act.state;
    if (PHYSICAL_STATES.has(s)) return;
    this.noteInteraction();
    const st = Number.isFinite(strength) ? clamp(strength, 0, 1) : 0.5;
    const irritated = this.irritatedByPetting();
    // Stroking a reacting or irritated cat does not soothe it, it irritates it further.
    if (irritated) addStat(this.cat.stats, 'annoyance', PET_IRRITATION * st * (1.3 - i.patience));
    else applyPet(this.cat.stats, this.cat.traits, st);
    // The rate counts petting sessions: one stroke gesture produces many pet events.
    if (this.now - this.lastPetEventAt > PET_SESSION_GAP_MS) {
      const prefs = this.cat.memory.preferences;
      prefs.petRatePerHour = addRateEvent(prefs.petRatePerHour, PET_RATE_TAU_MS);
    }
    this.lastPetEventAt = this.now;
    if (this.now - this.lastPetCountedAt >= 1000) {
      bumpCounter(this.cat.memory, 'pets');
      this.lastPetCountedAt = this.now;
      this.markDirty();
    }
    if (this.now - this.lastPetMemoryAt >= 30_000) {
      this.lastPetMemoryAt = this.now;
      this.rememberEvent('pet');
    }
    if (irritated) {
      // A reaction runs its course (afterAnnoyed may then hide); a calm but irritated cat objects.
      if (!REACTION_STATES.has(s) && this.mode === 'normal') this.request('annoyed', 'interaction');
      return;
    }
    this.petTimes = this.petTimes.filter((t) => t > this.now - 60_000);
    this.petTimes.push(this.now);
    this.emotes.show('heart', this.now);
    if (s === 'sleeping') {
      if (this.petTimes.filter((t) => t > this.now - 6000).length >= 3) this.request('beingPetted', 'interaction');
      return;
    }
    const limit = 30 * (0.5 + this.cat.traits.affection);
    if (this.petTimes.length > limit) {
      addStat(this.cat.stats, 'annoyance', 0.15);
      this.petTimes = [];
      if (this.request('annoyed', 'interaction') === 'ok') return;
    }
    this.request('beingPetted', 'interaction');
  }

  /** In the middle of a startle or annoyed reaction, or awake and still irritated: not in the mood to be stroked. */
  private irritatedByPetting(): boolean {
    const a = this.act;
    if (ASLEEP_STATES.has(a.state)) return false;
    if (!a.done && (a.state === 'annoyed' || a.state === 'startled')) return true;
    return this.cat.stats.annoyance >= IRRITATED_ANNOYANCE;
  }

  private onTap(at: Point): void {
    const i = this.settings.interaction;
    if (!i.enabled || !isFinitePoint(at) || PHYSICAL_STATES.has(this.act.state)) return;
    this.noteInteraction();
    bumpCounter(this.cat.memory, 'clicks');
    this.tapTimes = this.tapTimes.filter((t) => t > this.now - TAP_WINDOW_MS);
    this.tapTimes.push(this.now);
    const n = this.tapTimes.length;
    const s = this.act.state;
    if (ASLEEP_STATES.has(s)) {
      // A touch makes a sleeping cat flick an ear; often it wakes up.
      this.react('earFlick');
      if (n >= 2 || chance(this.random, 0.5)) this.request('wakingUp', 'interaction');
      return;
    }
    if (n >= 3) addStat(this.cat.stats, 'annoyance', 0.1 * (1.3 - i.patience) * (n - 2));
    const annoyance = this.cat.stats.annoyance;
    if (this.mode === 'normal' && annoyance >= 0.75 && (s === 'annoyed' || this.recentStates.slice(0, 3).includes('annoyed'))) {
      if (this.request('hiding', 'interaction', { variant: 'flee' }) === 'ok') return;
    }
    if (this.mode === 'normal' && annoyance >= 0.45 + 0.3 * i.patience && s !== 'annoyed') {
      if (this.request('annoyed', 'interaction') === 'ok') return;
    }
    this.setGlance(at, 1800);
    this.mover.faceToward(at.x, this.now);
    this.react('earFlick');
    if (CALM_STATES.has(s) && chance(this.random, 0.6)) this.playOneShot('meow', 900);
    else this.emotes.show('question', this.now);
  }

  private onDoubleTap(at: Point): void {
    const i = this.settings.interaction;
    if (!i.enabled || !isFinitePoint(at) || PHYSICAL_STATES.has(this.act.state)) return;
    this.noteInteraction();
    bumpCounter(this.cat.memory, 'doubleClicks');
    const s = this.act.state;
    if (this.cat.stats.annoyance > 0.5) {
      addStat(this.cat.stats, 'annoyance', 0.1);
      if (this.mode === 'normal' && s !== 'annoyed') this.request('annoyed', 'interaction');
      return;
    }
    if (ASLEEP_STATES.has(s)) {
      this.request('wakingUp', 'interaction');
      return;
    }
    const playful = this.cat.stats.energy > 0.3 && !this.typing && chance(this.random, 0.4 + 0.5 * this.cat.traits.playfulness);
    if (this.mode === 'normal' && playful && this.mover.grounded && this.request('playing', 'interaction', { variant: 'hop' }) === 'ok') return;
    this.setGlance(at, 1500);
    this.emotes.show(chance(this.random, 0.5) ? 'sparkle' : 'note', this.now, true);
  }

  private onWindowAppeared(w: WindowInfo, isNew: boolean): void {
    const b = this.settings.behavior;
    if (!b.reactToWindows || !w || !isFiniteRect(w.rect) || w.minimized) return;
    if (ASLEEP_STATES.has(this.act.state) || PHYSICAL_STATES.has(this.act.state)) return;
    const novel = isNew && !this.seenWindows.has(w.id);
    this.seenWindows.add(w.id);
    const r = this.windowRelevanceFor(w.rect, w.category, w.excluded, novel, 'window');
    const center = rectCenter(w.rect);
    // A private window gets a glance at most: the cat does not walk over to it or sit and stare.
    const calm = (CALM_STATES.has(this.act.state) || this.act.state === 'walking') && !w.excluded;
    if (r >= 0.5 && calm && !this.typing && !this.disabled.has('inspectWindows') && this.reactions.ready('approach', this.now)) {
      if (this.request('inspectingWindow', 'stimulus', { windowId: w.id, target: center }) === 'ok') {
        this.reactions.set('approach', this.now, 25_000);
        return;
      }
    }
    if (r >= 0.25 && calm && this.reactions.take('look', this.now, 8000)) {
      if (this.request('curious', 'stimulus', { target: center, variant: 'look' }) === 'ok') return;
    }
    if (r >= 0.1) this.setGlance(center, 1500);
  }

  private onWindowClosed(rect: Rect, category: WindowInfo['category'], excluded: boolean): void {
    if (!this.settings.behavior.reactToWindows || ASLEEP_STATES.has(this.act.state) || PHYSICAL_STATES.has(this.act.state)) return;
    const r = this.windowRelevanceFor(rect, category, excluded, true, 'closed');
    const target = { x: rect.x + rect.width / 2, y: rect.y + rect.height };
    const calm = (CALM_STATES.has(this.act.state) || this.act.state === 'walking') && !excluded;
    if (r >= 0.3 && calm && !this.typing && this.reactions.take('exposed', this.now, 20_000)) {
      if (this.request('curious', 'stimulus', { target }) === 'ok') return;
    }
    if (r >= 0.1) this.setGlance(rectCenter(rect), 1200);
  }

  private onForeground(w: WindowInfo | null, switchesPerMinute: number): void {
    // 'React to windows' off: foreground changes, fast app switching included, are not noticed.
    if (!this.settings.behavior.reactToWindows) return;
    if (Number.isFinite(switchesPerMinute) && switchesPerMinute >= 8) {
      this.busyUntil = this.now + 20_000;
      const s = this.act.state;
      const moving = s === 'walking' || ACTIVE_STATES.has(s) || s === 'curious' || s === 'inspectingWindow';
      if (moving && this.act.cause !== 'command' && this.act.cause !== 'interaction' && this.reactions.take('busy', this.now, 15_000)) {
        this.request('watchingUser', 'stimulus');
      }
      return;
    }
    if (!w || !isFiniteRect(w.rect) || ASLEEP_STATES.has(this.act.state)) return;
    const r = this.windowRelevanceFor(w.rect, w.category, w.excluded, false, 'foreground');
    if (r >= 0.15) this.setGlance(rectCenter(w.rect), 1200);
  }

  private onMoveStart(id: string, excluded: boolean): void {
    this.movingWindows.add(id);
    if (!this.settings.behavior.reactToWindows || this.mover.perchWindowId === id) return;
    const rect = this.windowRect(id);
    if (!rect || ASLEEP_STATES.has(this.act.state) || PHYSICAL_STATES.has(this.act.state)) return;
    const r = this.windowRelevanceFor(rect, 'unknown', excluded, false, 'move');
    // A private window being moved gets a glance at most.
    const calm = CALM_STATES.has(this.act.state) && !excluded;
    if (r >= 0.2 && calm && !this.typing && chance(this.random, 0.5 * this.cat.traits.curiosity) && this.reactions.take('follow', this.now, 30_000)) {
      if (this.request('walking', 'stimulus', { variant: 'follow', windowId: id, target: rectCenter(rect) }) === 'ok') return;
    }
    if (r >= 0.08) this.setGlance(rectCenter(rect), 2000);
  }

  private onMoveEnd(id: string, rect: Rect, excluded: boolean): void {
    if (!this.settings.behavior.reactToWindows || this.mover.perchWindowId === id || excluded) return;
    if (ASLEEP_STATES.has(this.act.state) || PHYSICAL_STATES.has(this.act.state) || this.typing) return;
    const r = this.windowRelevanceFor(rect, 'unknown', false, false, 'moved');
    // Inspecting a moved window is 'Inspect windows'; it only climbs onto it when perching is on too.
    if (r >= 0.45 && !this.disabled.has('inspectWindows') && chance(this.random, 0.35) && this.reactions.take('approach', this.now, 25_000)) {
      this.request('inspectingWindow', 'stimulus', { windowId: id, target: rectCenter(rect) });
    }
  }

  private onTypingStart(): void {
    const b = this.settings.behavior;
    if (!b.reactToTyping || ASLEEP_STATES.has(this.act.state) || !CALM_STATES.has(this.act.state)) return;
    if (!chance(this.random, 0.35 * b.activitySensitivity) || !this.reactions.take('typing', this.now, 60_000)) return;
    const fg = this.env?.foreground;
    const far = fg ? Math.abs(rectCenter(fg.rect).x - this.mover.x) > 6 * this.bl : false;
    this.request('watchingUser', 'stimulus', { variant: far ? 'nearby' : null });
  }

  private onUserReturned(idleMs: number): void {
    if (!Number.isFinite(idleMs) || idleMs < 60_000) return;
    const s = this.act.state;
    if (ASLEEP_STATES.has(s)) {
      this.request('wakingUp', 'stimulus', { then: this.greetFollowUp() });
      return;
    }
    if (idleMs >= 120_000 && !PHYSICAL_STATES.has(s)) {
      const greet = this.greetFollowUp();
      if (greet && this.request(greet.state, 'stimulus', greet.init) === 'ok') return;
      this.emotes.show('heart', this.now);
    }
  }

  private onFlick(speed: number, at: Point): void {
    if (!isFinitePoint(at) || !Number.isFinite(speed) || this.typing) return;
    const s = this.act.state;
    if (ASLEEP_STATES.has(s) || PHYSICAL_STATES.has(s) || s === 'chasingCursor') return;
    const cur = this.cursorInfo();
    const speedDip = speed / this.mover.scale;
    const dist = Math.hypot(at.x - this.mover.x, at.y - (this.mover.y - this.mover.bodyHeight / 2)) / this.bl;
    const r = flickRelevance({
      speedDip,
      distBodyLengths: dist,
      cursorPlay: this.settings.behavior.cursorPlay,
      playfulness: this.cat.traits.playfulness,
      energy: this.cat.stats.energy,
      acceptance: this.cat.memory.preferences.cursorPlayAcceptance,
      habituation: this.habit.register('flick', this.now),
    });
    if (r >= 0.4 && cur?.reachable && !this.disabled.has('chaseCursor') && this.reactions.take('flick', this.now, 8000)) {
      if (this.request('chasingCursor', 'stimulus') === 'ok') return;
    }
    if (r >= 0.2 && s !== 'watchingCursor' && this.reactions.take('flickWatch', this.now, 5000)) {
      if (this.request('watchingCursor', 'stimulus') === 'ok') return;
    }
    if (r >= 0.05) this.setGlance(at, 1200);
  }

  private onVisual(events: readonly string[], changeCenter: Point | null, region: Rect): void {
    const sens = this.settings.behavior.activitySensitivity;
    if (events.includes('dark')) this.darkUntil = this.now + 10 * 60_000;
    if (events.includes('bright')) this.darkUntil = -Infinity;
    this.noteScreen(events);
    const s = this.act.state;
    if (ASLEEP_STATES.has(s) || PHYSICAL_STATES.has(s)) return;
    if (events.includes('bigChange')) {
      if (this.reactions.ready('bigChange', this.now) && chance(this.random, (1 - this.cat.traits.confidence) * 0.6 * sens)) {
        this.reactions.set('bigChange', this.now, 10 * 60_000);
        if (this.request('startled', 'stimulus', { target: isFinitePoint(changeCenter) ? changeCenter : null }) === 'ok') return;
      }
      if (isFinitePoint(changeCenter) && CALM_STATES.has(s) && this.reactions.take('visualApproach', this.now, 30_000)) {
        if (this.request('curious', 'stimulus', { target: changeCenter }) === 'ok') return;
      }
    }
    // Something video- or game-like is playing: the cat sits down and watches it, without walking over.
    if (events.includes('videoLike') && CALM_STATES.has(s) && isFiniteRect(region) && this.reactions.ready('video', this.now)) {
      this.reactions.set('video', this.now, 3 * 60_000);
      const target = isFinitePoint(changeCenter) ? changeCenter : rectCenter(region);
      if (s !== 'watchingUser' && chance(this.random, 0.2 + 0.5 * sens) && this.request('watchingUser', 'stimulus', { variant: 'screen', target }) === 'ok') return;
      this.setGlance(target, 3000);
      return;
    }
    // A compact new thing appeared: a curious cat may go and have a look; otherwise a head tilt.
    if (events.includes('newElement') && isFinitePoint(changeCenter) && this.reactions.ready('newElement', this.now)) {
      this.reactions.set('newElement', this.now, 45_000);
      const go = CALM_STATES.has(s) && !this.typing && chance(this.random, (0.2 + 0.5 * this.cat.traits.curiosity) * sens);
      if (go && this.request('curious', 'stimulus', { target: changeCenter }) === 'ok') return;
      if (!ACTIVE_STATES.has(s)) {
        this.setGlance(changeCenter, 1800);
        this.react('headTilt');
      }
      return;
    }
    if (events.includes('motion') && CALM_STATES.has(s) && isFiniteRect(region) && chance(this.random, 0.4 * sens) && this.reactions.take('motion', this.now, 60_000)) {
      const target = isFinitePoint(changeCenter) ? changeCenter : rectCenter(region);
      if (chance(this.random, 0.3 * this.cat.traits.curiosity) && !this.typing) this.request('curious', 'stimulus', { target });
      else if (s !== 'watchingUser') this.request('watchingUser', 'stimulus');
      else this.setGlance(target, 2000);
    }
  }

  private currentScreen(): 'video' | 'busy' | 'quiet' | null {
    return this.screen && this.now < this.screen.until ? this.screen.kind : null;
  }

  /** The latest coarse look of the screen; it lowers activity for a while (see DecisionView.screen). */
  private noteScreen(events: readonly string[]): void {
    const kind = events.includes('videoLike') ? 'video' : events.includes('busy') ? 'busy' : events.includes('quiet') || events.includes('still') ? 'quiet' : null;
    this.screen = kind ? { kind, until: this.now + SCREEN_FRESH_MS } : null;
  }

  private onAi(reaction: string, interest: number, region: Rect): void {
    if (!isFiniteRect(region) || !Number.isFinite(interest)) return;
    if (!this.reactions.take('ai', this.now, 20_000)) return;
    const s = this.act.state;
    if (PHYSICAL_STATES.has(s)) return;
    const center = rectCenter(region);
    const asleep = ASLEEP_STATES.has(s);
    if (reaction !== 'sleep' && (interest < 0.25 || asleep)) return;
    switch (reaction) {
      case 'watch':
        if (s !== 'watchingUser') this.request('watchingUser', 'stimulus');
        this.setGlance(center, 3000);
        return;
      case 'approach':
        if (!this.typing) this.request('curious', 'stimulus', { target: center });
        return;
      case 'sit_nearby':
        this.request('curious', 'stimulus', { target: { x: center.x, y: region.y + region.height } });
        return;
      case 'play':
        if (this.cat.stats.energy > 0.3 && !this.typing) {
          const variant: Variant = !this.disabled.has('zoomies') && chance(this.random, 0.2) ? 'zoomies' : chance(this.random, 0.5) ? 'rollOver' : 'pawAt';
          this.request('playing', 'stimulus', { variant });
        }
        return;
      case 'startle':
        if (this.reactions.take('bigChange', this.now, 10 * 60_000)) this.request('startled', 'stimulus', { target: center });
        return;
      case 'sleep':
        if (!asleep && this.cat.stats.energy < 0.85) this.request('fallingAsleep', 'stimulus');
        return;
      case 'groom':
        if (!this.disabled.has('grooming')) this.request('grooming', 'stimulus');
        return;
      default:
        return; // 'ignore' and anything unexpected
    }
  }

  /** `relocated`: the call already brought the cat over from a fullscreen display; it then always comes. */
  private onCallCat(at: Point, relocated: boolean): void {
    if (!isFinitePoint(at) || PHYSICAL_STATES.has(this.act.state)) return;
    this.noteInteraction();
    // Already on its way to a call: a new call only changes where it goes.
    const coming = (this.act.state === 'walking' || this.act.state === 'running') && this.act.variant === 'called';
    if (!relocated && !coming && this.ignoresCommand()) {
      // Not now: a flick of the tail and a look toward the caller, and it stays where it is.
      this.react('tailFlick');
      if (!ASLEEP_STATES.has(this.act.state)) this.setGlance(at, 1500);
      return;
    }
    const dest = this.mover.surfacePointFor(at);
    const far = Math.abs(dest.x - this.mover.x) > 6 * this.bl || Math.abs(dest.y - this.mover.y) > 2 * this.mover.bodyHeight;
    const target = { x: dest.x, y: dest.y };
    this.rememberEvent('called');
    this.request(far ? 'running' : 'walking', 'command', { variant: 'called', target, then: { state: 'idle', init: { target: { x: at.x, y: at.y } } } });
  }

  private onPlayCommand(): void {
    if (PHYSICAL_STATES.has(this.act.state)) return;
    this.noteInteraction();
    if (this.ignoresCommand()) {
      this.react('tailFlick');
      return;
    }
    const zoom = !this.disabled.has('zoomies') && !this.typing && this.cat.stats.energy > 0.35 && chance(this.random, 0.4);
    const variant: Variant = zoom ? 'zoomies' : chance(this.random, 0.5) ? 'pawAt' : 'rollOver';
    this.request('playing', 'command', { variant });
  }

  /** Rolls whether the cat ignores a call or play command; never twice in a row. */
  private ignoresCommand(): boolean {
    if (this.lastCommandIgnored) {
      this.lastCommandIgnored = false;
      return false;
    }
    this.lastCommandIgnored = chance(this.random, this.commandIgnoreChance());
    if (this.lastCommandIgnored) this.commandsIgnored++;
    return this.lastCommandIgnored;
  }

  /**
   * 0..MAX_COMMAND_IGNORE_CHANCE: an annoyed, frightened, sleepy, independent or barely
   * bonded cat sometimes does not come; a content, bonded cat almost always does.
   */
  commandIgnoreChance(): number {
    const st = this.cat.stats;
    const t = this.cat.traits;
    const lowBond = clamp((0.35 - st.bond) / 0.35, 0, 1);
    const independence = (1 - t.affection) * (0.5 + 0.5 * t.confidence);
    // Asleep makes it likelier, but not the short nap every launch starts with.
    const napping = ASLEEP_STATES.has(this.act.state) && this.act.variant !== 'intro';
    const sleepy = this.currentSleepiness() + (napping ? 0.5 : 0);
    const rough = clamp(this.recentRough() / 4, 0, 1);
    const p = 0.4 * st.annoyance + 0.3 * st.fear + 0.08 * lowBond + 0.08 * Math.min(1, sleepy) + 0.06 * independence + 0.05 * rough - 0.03;
    return Number.isFinite(p) ? clamp(p, 0, MAX_COMMAND_IGNORE_CHANCE) : 0;
  }

  private currentSleepiness(): number {
    return sleepiness({ stats: this.cat.stats, traits: this.cat.traits, localHour: this.env?.localHour ?? 12, darkBias: this.darkBias(), awakeMs: this.now - this.awakeSince });
  }

  /** Throws and annoyed reactions remembered within ROUGH_MEMORY_MS (wall clock, persisted). */
  private recentRough(): number {
    const since = this.wall() - ROUGH_MEMORY_MS;
    let n = 0;
    for (const e of this.cat.memory.recent) if (e.at >= since && (e.kind === 'throw' || e.kind === 'annoyed')) n++;
    return n;
  }

  private windowRelevanceFor(rect: Rect, category: WindowInfo['category'], excluded: boolean, novel: boolean, kind: string): number {
    const d = this.mover.fullWorldModel.display(this.mover.displayId) ?? this.mover.fullWorldModel.primary;
    return windowRelevance({
      cat: { x: this.mover.x, y: this.mover.y },
      rect,
      displayRect: d.workAreaPx,
      category,
      excluded,
      novel,
      curiosity: this.cat.traits.curiosity,
      sensitivity: this.settings.behavior.activitySensitivity,
      habituation: this.habit.register(kind, this.now),
      typing: this.typing,
    });
  }

  // ---- context for decisions ----------------------------------------------------------

  private darkBias(): number {
    return this.now < this.darkUntil ? 1 : 0;
  }

  private cursorInfo(): { point: Point; speedDip: number; distBodyLengths: number; reachable: boolean } | null {
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

  private decisionView(): DecisionView {
    const env = this.env as SimEnv;
    const cur = this.cursorInfo();
    const scan = this.scanTargets();
    this.scan = scan;
    this.decisionTargets = { ...scan.status };
    const fg = env.foreground && !env.foreground.minimized && isFiniteRect(env.foreground.rect) ? env.foreground : null;
    const media = fg !== null && (fg.category === 'video' || fg.category === 'game' || fg.category === 'media');
    return {
      traits: this.cat.traits,
      stats: this.cat.stats,
      prefs: this.cat.memory.preferences,
      behavior: this.settings.behavior,
      disabled: this.disabled,
      localHour: Number.isFinite(env.localHour) ? env.localHour : 12,
      typing: this.typing,
      userIdleMs: Number.isFinite(env.userIdleMs) ? env.userIdleMs : 0,
      busySwitching: this.now < this.busyUntil,
      mediaForeground: media,
      screen: this.currentScreen(),
      recentRough: this.recentRough(),
      darkBias: this.darkBias(),
      quietMs: this.now - this.lastInteractionAt,
      awakeMs: this.now - this.awakeSince,
      cursor: cur,
      foreground: fg ? { center: rectCenter(fg.rect), distBodyLengths: Math.abs(rectCenter(fg.rect).x - this.mover.x) / this.bl } : null,
      favoriteSpot: this.favoriteSpotTarget(),
      perchTarget: scan.status.perch === 'available' ? scan.perch : null,
      wanderTarget: this.wanderTarget(),
      cornerTarget: this.cornerTarget(),
      typingIntensity: this.settings.behavior.reactToTyping && Number.isFinite(env.typingIntensity) ? clamp(env.typingIntensity, 0, 1) : 0,
      standingOn: this.mover.attachedSurface?.surfaceKind ?? 'floor',
      climbTarget: scan.status.climb === 'available' ? scan.climb : null,
      tabStripTarget: this.tabStripTarget(scan),
      edgeLook: this.edgeLookTarget(),
      surpriseReady: this.reactions.ready('surprise', this.now),
      exploreUrge: this.exploreUrge,
      downTarget: this.downTarget(),
      elevatedMs: this.topVisit ? this.now - this.topVisit.since : 0,
      recentStates: this.recentStates,
      current: this.act.state,
      isCoolingDown: (s) => this.coolingDown(s),
    };
  }

  private wanderTarget(): Point | null {
    const m = this.mover;
    const s = m.currentSurface;
    const r = m.walkRange;
    if (!s || !r) return null;
    // From a window top or tab strip the cat often wanders back down once it has explored it (v1.1.1);
    // a taskbar is walked along like a floor.
    if (s.kind === 'ledge' && s.surfaceKind !== 'taskbar' && this.topExplored() && chance(this.random, 0.5)) {
      const fp = m.world.nearestFloorPoint({ x: m.x, y: m.y + 1 });
      return { x: fp.x, y: fp.y };
    }
    const dir = chance(this.random, 0.5) ? 1 : -1;
    for (const d of [dir, -dir]) {
      const x = clamp(m.x + d * range(this.random, 2, 8) * this.bl, r.x0, r.x1);
      if (Math.abs(x - m.x) >= 1.5 * this.bl) return { x, y: m.y };
    }
    return null;
  }

  /**
   * The far end of the surface the cat stands on (a corner of the floor, of a window top or
   * of the taskbar), when it is a walk away: three body lengths on a floor, 1.5 on a ledge.
   */
  private cornerTarget(): Point | null {
    const m = this.mover;
    const s = m.currentSurface;
    const r = m.walkRange;
    if (!s || !r || !m.grounded) return null;
    const floor = s.kind === 'floor';
    const inset = (floor ? 0.6 : 0.1) * this.bl;
    const left = r.x0 + inset;
    const right = r.x1 - inset;
    if (right <= left) return null;
    const x = m.x - left > right - m.x ? left : right;
    return Math.abs(x - m.x) >= (floor ? 3 : 1.5) * this.bl ? { x, y: m.y } : null;
  }

  // ---- v1.1.1: where the cat can go up, and the urge to go --------------------------------

  /** Window tops, sides and tab strips the cat could go up to from where it stands, with why it cannot for each. */
  private scanTargets(): TargetScan {
    const perch = this.scanPerch();
    const climb = this.scanClimb();
    const strip = this.scanStrip();
    return { at: this.now, perch: perch.target, climb: climb.target, strip: strip.target, status: { perch: perch.status, climb: climb.status, tabStrip: strip.status } };
  }

  /** Some way up is within reach, whether or not its cooldown allows it now. */
  private canGoUp(scan: TargetScan): boolean {
    return scan.perch !== null || scan.climb?.dir === 'up' || scan.strip !== null;
  }

  /** Nothing usable of these kinds: is that because every one listed belongs to a private window? */
  private noneOrExcluded(kinds: readonly string[]): TargetAvailability {
    for (const s of this.surfaceIndex.values()) {
      if (kinds.includes(s.kind) && (s.excluded === true || this.excludedWindows.has(s.ownerId))) return 'excluded';
    }
    return 'noSurfaces';
  }

  private climbAllowed(): boolean {
    return !this.disabled.has('climbWindows') && !this.disabled.has('perchOnWindows');
  }

  /**
   * A window top or tab strip to jump or climb up to and explore ('Sit on windows'): not the
   * window the cat is on, not one that is leaving or private; the nearest few are checked for a route.
   */
  private scanPerch(): { target: TargetScan['perch']; status: TargetAvailability } {
    const m = this.mover;
    if (this.disabled.has('perchOnWindows')) return { target: null, status: 'disabled' };
    if (!m.grounded) return { target: null, status: 'notGrounded' };
    const here = m.perchWindowId;
    const tops = m.ledgeSurfaces.filter((l) => isElevatedKind(l.surfaceKind) && l.ownerId !== null && l.ownerId !== here && l.phase !== 'leaving');
    if (tops.length === 0) return { target: null, status: this.noneOrExcluded(['windowTop', 'tabStrip']) };
    const open = tops.filter((l) => !this.excludedWindows.has(l.ownerId as string));
    if (open.length === 0) return { target: null, status: 'excluded' };
    const options = open
      .map((l) => {
        // On a tab strip it heads for the resting span (the tabs), not the controls beside them.
        const span = l.surfaceKind === 'tabStrip' && l.rest ? l.rest : l;
        const point = { x: clamp(m.x, span.x0, span.x1), y: l.y };
        return { l, point, d: Math.hypot(point.x - m.x, point.y - m.y) };
      })
      .sort((a, b) => a.d - b.d)
      .slice(0, PERCH_CANDIDATES);
    for (const o of options) {
      if (!m.canReach(o.point)) continue;
      return { target: { windowId: o.l.ownerId as string, point: o.point }, status: this.coolingDown('inspectingWindow') ? 'cooldown' : 'available' };
    }
    return { target: null, status: 'unreachable' };
  }

  /**
   * The nearest climb that can start from where the cat stands: up a window side (stepping or
   * leaping onto it), or down from the top it is on once it has explored that top.
   */
  private scanClimb(): { target: TargetScan['climb']; status: TargetAvailability } {
    const m = this.mover;
    if (!this.climbAllowed()) return { target: null, status: 'disabled' };
    if (!m.grounded) return { target: null, status: 'notGrounded' };
    if (m.wallTracks.length === 0) return { target: null, status: this.noneOrExcluded(['windowSide']) };
    let best: { point: Point; dir: 'up' | 'down' } | null = null;
    let bestDist = Infinity;
    let options = 0;
    let excluded = 0;
    for (const o of m.climbOptions()) {
      if (o.dir === 'down' && !this.topExplored()) continue;
      options++;
      if (this.excludedWindows.has(o.ownerId)) {
        excluded++;
        continue;
      }
      const dist = Math.abs(o.startX - m.x) / this.bl;
      if (dist > 15 || dist >= bestDist) continue;
      best = { point: { x: o.target.x, y: o.target.y }, dir: o.dir };
      bestDist = dist;
    }
    if (!best) return { target: null, status: options > 0 && excluded === options ? 'excluded' : 'unreachable' };
    return { target: best, status: this.reactions.ready('climb', this.now) ? 'available' : 'cooldown' };
  }

  /**
   * A tab strip worth a visit ('Tab strips'): the nearest few reachable by any way up the cat may
   * take (climbing too, while climbing is on). Standing on a strip: walking along it.
   */
  private scanStrip(): { target: TargetScan['strip']; status: TargetAvailability } {
    const m = this.mover;
    if (this.disabled.has('tabStrips')) return { target: null, status: 'disabled' };
    if (!m.grounded) return { target: null, status: 'notGrounded' };
    const on = m.attachedSurface;
    if (on?.surfaceKind === 'tabStrip') {
      const strip = m.ledgeById(on.surfaceId) ?? m.currentSurface;
      const rest = strip ? (strip.rest ?? { x0: strip.x0, x1: strip.x1 }) : null;
      return { target: null, status: rest && rest.x1 - rest.x0 >= 1.5 * this.bl ? 'available' : 'unreachable' };
    }
    const strips = m.ledgeSurfaces.filter((l) => l.surfaceKind === 'tabStrip' && l.phase !== 'leaving');
    if (strips.length === 0) return { target: null, status: this.noneOrExcluded(['tabStrip']) };
    const open = strips.filter((l) => !(l.ownerId !== null && this.excludedWindows.has(l.ownerId)));
    if (open.length === 0) return { target: null, status: 'excluded' };
    const route = this.climbAllowed() ? 'any' : 'noClimb';
    const nearest = open
      .map((l) => ({ l, d: Math.hypot(clamp(m.x, l.x0, l.x1) - m.x, l.y - m.y) }))
      .sort((a, b) => a.d - b.d)
      .slice(0, STRIP_CANDIDATES);
    for (const { l } of nearest) {
      const rest = l.rest ?? { x0: l.x0, x1: l.x1 };
      if (!m.canReach({ x: (rest.x0 + rest.x1) / 2, y: l.y }, route)) continue;
      return { target: { y: l.y, rest: { x0: rest.x0, x1: rest.x1 } }, status: this.reactions.ready('tabStripVisit', this.now) ? 'available' : 'cooldown' };
    }
    return { target: null, status: 'unreachable' };
  }

  /**
   * On a tab strip: another point of its resting span to walk to. Elsewhere (when the visit
   * cooldown allows): a resting point on the nearest reachable tab strip.
   */
  private tabStripTarget(scan: TargetScan): Point | null {
    const m = this.mover;
    if (!m.grounded || this.disabled.has('tabStrips')) return null;
    const on = m.attachedSurface;
    if (on?.surfaceKind === 'tabStrip') {
      const strip = m.ledgeById(on.surfaceId) ?? m.currentSurface;
      if (!strip) return null;
      const rest = strip.rest ?? { x0: strip.x0, x1: strip.x1 };
      if (rest.x1 - rest.x0 < 1.5 * this.bl) return null;
      for (let i = 0; i < 2; i++) {
        const x = range(this.random, rest.x0, rest.x1);
        if (Math.abs(x - m.x) >= 1.5 * this.bl) return { x, y: strip.y };
      }
      return null;
    }
    const strip = scan.status.tabStrip === 'available' ? scan.strip : null;
    if (!strip) return null;
    return { x: strip.rest.x0 + (strip.rest.x1 - strip.rest.x0) * range(this.random, 0.2, 0.8), y: strip.y };
  }

  /**
   * 0..1 urge to go up (DecisionView.exploreUrge). It grows while the cat is awake on the floor
   * or a taskbar (not held, not in the air) and some way up is within reach: faster for a
   * curious, playful cat, slower for a lazy one (0 to 1 in 3-8 min), half as fast while the user
   * types. With nothing within reach it does not grow. Getting up onto a top resets it.
   */
  private updateUrge(dt: number): void {
    if (this.mode !== 'normal' || !(dt > 0)) return;
    const m = this.mover;
    const s = this.act.state;
    const on = m.attachedSurface;
    const low = m.grounded && (on === null || on.surfaceKind === 'taskbar');
    if (!low || ASLEEP_STATES.has(s) || PHYSICAL_STATES.has(s)) return;
    if (this.now - this.scan.at >= URGE_SCAN_MS) this.scan = this.scanTargets();
    if (!this.canGoUp(this.scan)) return;
    this.exploreUrge = Math.min(1, this.exploreUrge + ((this.typing ? 0.5 : 1) * dt) / this.urgeTauMs());
  }

  /** Time for the urge to grow from 0 to 1, ms: personality-aware, within 3-8 min. */
  private urgeTauMs(): number {
    const t = this.cat.traits;
    const c = (v: number): number => (Number.isFinite(v) ? clamp(v, 0, 1) : 0.5);
    const minutes = (5.5 * (0.75 + 0.5 * c(t.laziness))) / (0.7 + 0.4 * c(t.curiosity) + 0.2 * c(t.playfulness));
    return clamp(minutes, 3, 8) * 60_000;
  }

  /**
   * Arrivals on window tops and tab strips (from the floor, a taskbar or a side): the excursion
   * count, the urge reset and the top being explored. A trip up that got onto a side and ended
   * back down without getting there (turned back, let go, missed the leap) has failed.
   */
  private trackElevation(): void {
    if (this.mode === 'away') return;
    const m = this.mover;
    const e = this.excursion;
    if (!m.grounded) {
      if (m.onWall && e) e.leftGround = true;
      return;
    }
    const on = m.attachedSurface;
    const elevated = on !== null && isElevatedKind(on.surfaceKind);
    if (on && elevated) {
      if (!this.wasElevated) {
        this.excursionCount++;
        this.lastElevatedAt = this.now;
        this.exploreUrge = 0;
      }
      const v = this.topVisit;
      if (!v || v.surfaceId !== on.surfaceId) this.topVisit = { surfaceId: on.surfaceId, since: this.now, x0: m.x, walked: 0 };
      else v.walked = Math.max(v.walked, Math.abs(m.x - v.x0));
      if (e && on.surfaceId !== e.from) e.arrived = true;
    } else {
      this.topVisit = null;
      if (e && e.leftGround && !e.arrived && !e.fromElevated && this.act === e.act) {
        if (e.act.then?.init.variant === 'patrol') e.act.then = null;
        this.finish();
      }
    }
    this.wasElevated = elevated;
  }

  /** Up on a top, it has explored it (stayed a while and walked along it) and may head back down. */
  private topExplored(): boolean {
    const v = this.topVisit;
    if (!v) return true;
    const stay = this.now - v.since;
    if (stay >= TOP_MAX_EXPLORE_MS) return true;
    if (stay < TOP_MIN_STAY_MS) return false;
    if (v.walked >= TOP_PATROL_BL * this.bl) return true;
    const r = this.mover.walkRange;
    return !r || r.x1 - r.x0 < (TOP_PATROL_BL + 0.5) * this.bl;
  }

  /** Up on a top it has explored: the floor below, to head back down to. */
  private downTarget(): Point | null {
    const m = this.mover;
    if (!this.topVisit || !m.grounded || !isElevatedKind(m.attachedSurface?.surfaceKind) || !this.topExplored()) return null;
    const fp = m.world.nearestFloorPoint({ x: m.x, y: m.y + 1 });
    return { x: fp.x, y: fp.y };
  }

  /** A point a few body lengths along the top the cat stands on, toward the side with more room. */
  private patrolTarget(): Point | null {
    const m = this.mover;
    const r = m.walkRange;
    if (!r || !m.grounded || !isElevatedKind(m.attachedSurface?.surfaceKind)) return null;
    const inset = 0.1 * this.bl;
    const roomLeft = m.x - (r.x0 + inset);
    const roomRight = r.x1 - inset - m.x;
    const room = Math.max(roomLeft, roomRight);
    if (room < 0.75 * this.bl) return null;
    const dir = roomRight >= roomLeft ? 1 : -1;
    return { x: m.x + dir * Math.min(room, range(this.random, 2.5, 6) * this.bl), y: m.y };
  }

  /** Starts tracking a trip up: exploring a top, climbing up a side, or visiting a tab strip from elsewhere. */
  private beginExcursion(a: Activity): void {
    const m = this.mover;
    const on = m.attachedSurface;
    let kind: DecisionTarget | null = null;
    if (a.state === 'inspectingWindow' && a.variant === 'explore') kind = 'perch';
    else if (a.state === 'walking' && a.variant === 'climb' && a.target && a.target.y < m.y - m.bodyHeight) kind = 'climb';
    else if (a.state === 'walking' && a.variant === 'tabStrip' && on?.surfaceKind !== 'tabStrip') kind = 'tabStrip';
    if (!kind) return;
    this.excursion = { kind, act: a, from: on?.surfaceId ?? null, fromElevated: on !== null && isElevatedKind(on.surfaceKind), leftGround: false, arrived: false };
  }

  /** A trip up ended: a failed one is retried after a short cooldown; a successful one keeps the full cooldown. */
  private settleExcursion(a: Activity): void {
    const e = this.excursion;
    if (!e || e.act !== a) return;
    this.excursion = null;
    if (e.arrived) return;
    const retry = range(this.random, EXCURSION_RETRY_MS[0], EXCURSION_RETRY_MS[1]);
    // Exploring a top keeps the inspect cooldown (30 s): already a short retry.
    if (e.kind === 'climb') this.reactions.set('climb', this.now, retry);
    else if (e.kind === 'tabStrip') this.reactions.set('tabStripVisit', this.now, retry);
  }

  /**
   * How long the way up to `target` may take: the walk there (plus, when it climbs, the length of
   * the top: it may climb the far side and walk back along it), the climb at climbing speed, the
   * leap and the pull-up, and a margin; within APPROACH_MIN_MS..APPROACH_MAX_MS.
   */
  private approachTimeoutMs(target: Point, pace: Pace, ledgeWidth: number): number {
    const m = this.mover;
    const speed = Math.max(1, m.paceSpeedPx(pace));
    const ms = this.settings.behavior.movementSpeed;
    const climbSpeed = Math.max(1, MOVEMENT.climbUpDip * (Number.isFinite(ms) && ms > 0 ? ms : 1) * m.scale);
    const rise = Math.max(0, m.y - target.y);
    const walk = Math.abs(target.x - m.x) + (rise > m.bodyHeight ? clamp(ledgeWidth, 0, 20 * this.bl) : 0);
    const sec = walk / speed + rise / climbSpeed + 1.5 + 1 + 5;
    return Number.isFinite(sec) ? clamp(sec * 1000, APPROACH_MIN_MS, APPROACH_MAX_MS) : APPROACH_MIN_MS;
  }

  /** Approach timeout of an inspection: the way up onto the window's top, when it has one. */
  private inspectApproachMs(a: Activity): number {
    const m = this.mover;
    const top = a.windowId ? m.ledgeSurfaces.find((l) => l.ownerId === a.windowId && isElevatedKind(l.surfaceKind)) : undefined;
    if (!top) return APPROACH_MIN_MS;
    return this.approachTimeoutMs({ x: clamp(m.x, top.x0, top.x1), y: top.y }, 'walk', top.x1 - top.x0);
  }

  /** Standing on a window top: a spot along it where the cat may sit at the edge and look down into the window. */
  private edgeLookTarget(): { windowId: string; point: Point } | null {
    const m = this.mover;
    const on = m.attachedSurface;
    const r = m.walkRange;
    if (!m.grounded || !r || !on || on.surfaceKind !== 'windowTop' || on.ownerId.length === 0) return null;
    if (this.disabled.has('perchOnWindows') || this.disabled.has('inspectWindows') || this.excludedWindows.has(on.ownerId)) return null;
    const x = clamp(m.x + (chance(this.random, 0.5) ? 1 : -1) * range(this.random, 0, 2) * this.bl, r.x0, r.x1);
    return { windowId: on.ownerId, point: { x, y: m.y } };
  }

  private retreatTarget(): Point | null {
    const m = this.mover;
    const r = m.walkRange;
    if (!r) return null;
    const threat = this.env?.cursor?.x ?? m.x - m.facing * this.bl;
    const dir = threat < m.x ? 1 : -1;
    const x = clamp(m.x + dir * range(this.random, 3, 6) * this.bl, r.x0, r.x1);
    return Math.abs(x - m.x) >= this.bl ? { x, y: m.y } : null;
  }

  private favoriteSpotTarget(): { point: Point; distBodyLengths: number } | null {
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

  // ---- memory ---------------------------------------------------------------------------

  private learn(dt: number): void {
    const s = this.act.state;
    const mem = this.cat.memory;
    if (this.mode !== 'away' && !ASLEEP_STATES.has(s)) mem.totalAwakeMs = Math.min(Number.MAX_SAFE_INTEGER, mem.totalAwakeMs + dt);
    if (this.mode !== 'away' && (this.env?.userIdleMs ?? Infinity) < 60_000) {
      mem.preferences.petRatePerHour = decayRate(mem.preferences.petRatePerHour, dt, PET_RATE_TAU_MS);
    }
    // Favourite spots come from rests the cat takes in normal life, not from sleep imposed while the
    // session is locked, a fullscreen app keeps it quiet, the user paused it or the app is quitting.
    if (this.mode === 'normal' && (s === 'resting' || s === 'sleeping') && this.mover.grounded) {
      this.restAccumMs += dt;
      if (this.restAccumMs >= SPOT_FLUSH_MS) this.flushRestSpot();
    }
  }

  private flushRestSpot(): void {
    const ms = this.restAccumMs;
    this.restAccumMs = 0;
    if (ms < SPOT_LEARN_MIN_MS || !this.mover.grounded) return;
    const m = this.mover;
    const d = m.fullWorldModel.display(m.displayId);
    if (!d) return;
    const xFrac = clamp((m.x - d.workAreaPx.x) / d.workAreaPx.width, 0, 1);
    // A spot on a window top or tab strip is a 'window' spot; on a taskbar it is the floor it covers.
    const on = m.attachedSurface;
    const kind = on && on.surfaceKind !== 'taskbar' ? 'window' : 'floor';
    learnSpot(this.cat.memory, { displayKey: d.id, xFrac, kind }, ms / 60_000, this.wall());
    this.markDirty();
  }

  /**
   * Where to come back after a restart. Surfaces (taskbars, windows, tab strips) are gone or
   * elsewhere by then, so a cat on one is restored on the floor below the same spot.
   */
  private lastPosition(): PersistedCat['lastPosition'] {
    const m = this.mover;
    const d = m.fullWorldModel.display(m.displayId);
    if (!d) return null;
    const xFrac = clamp((m.x - d.workAreaPx.x) / d.workAreaPx.width, 0, 1);
    const kind = m.support.kind;
    const support = kind === 'floor' || kind === 'surface' ? 'floor' : 'air';
    return { displayKey: d.id.slice(0, 64), xFrac: Number.isFinite(xFrac) ? xFrac : 0.5, support };
  }

  // ---- output ---------------------------------------------------------------------------

  private lookForState(): Point | null {
    const a = this.act;
    const env = this.env;
    if (!env) return null;
    const cursor = env.cursor && Number.isFinite(env.cursor.x) && Number.isFinite(env.cursor.y) ? { x: env.cursor.x, y: env.cursor.y } : null;
    const fg = env.foreground && isFiniteRect(env.foreground.rect) && !env.foreground.minimized ? rectCenter(env.foreground.rect) : null;
    switch (a.state) {
      case 'watchingCursor':
      case 'chasingCursor':
        return cursor;
      case 'seekingAttention':
        return a.phase === 'approach' ? null : cursor;
      case 'watchingUser':
        return a.variant === 'screen' && a.target ? a.target : (fg ?? cursor);
      case 'curious':
        return a.phase === 'look' ? a.target : null;
      case 'inspectingWindow': {
        if (a.phase === 'approach') return null;
        if (a.variant === 'edge' && a.windowId) return this.edgeLookPoint(a.windowId);
        const r = a.windowId ? this.windowRect(a.windowId) : null;
        return r ? rectCenter(r) : a.target;
      }
      case 'playing':
        if (a.variant === 'pawAt' && cursor && !this.disabled.has('pawAtCursor')) {
          const d = Math.hypot(cursor.x - this.mover.x, cursor.y - this.mover.y) / this.bl;
          if (d < 2.5) return cursor;
        }
        return a.variant === 'pawAt' ? { x: this.mover.x + this.mover.facing * 0.8 * this.bl, y: this.mover.y - 0.2 * this.mover.bodyHeight } : null;
      case 'idle': {
        if (a.target) return a.target;
        const c = this.cursorInfo();
        return c && c.distBodyLengths < 6 && c.speedDip > 60 ? c.point : null;
      }
      case 'hiding':
        return a.phase === 'hide' ? cursor : null;
      default:
        return null;
    }
  }

  private computeLook(): Point | null {
    const s = this.act.state;
    if (ASLEEP_STATES.has(s) || s === 'away' || s === 'held' || s === 'beingPetted' || PHYSICAL_STATES.has(s)) return null;
    if (this.glance && this.now < this.glance.until && !ACTIVE_STATES.has(s)) return this.glance.target;
    const p = this.lookForState();
    return isFinitePoint(p) ? p : null;
  }

  private computeClip(): AnimClip {
    const a = this.act;
    const m = this.mover;
    if (this.oneShot && this.now >= this.oneShot.until) this.oneShot = null;
    // On a wall the body is in the vertical climbing pose while getting on and climbing. During
    // the corner pull-up and the step-off the renderer cross-fades back to a ground clip (its
    // off-wall fade is tuned to the pull-up duration), so the cat does not glide rigidly.
    if (m.onWall) {
      const phase = m.climbPhase;
      // Leaping onto the side (v1.1.1): the jump pose (the renderer shapes it by vy), then onto the wall.
      if (phase === 'leap') return 'jump';
      return phase === 'pullUp' || phase === 'dismount' ? 'walk' : 'climb';
    }
    if (this.oneShot && CALM_STATES.has(a.state)) return this.oneShot.clip;
    const scale = m.scale;
    return clipFor(a.state, a.phase, {
      groundSpeed: m.groundSpeed,
      runThreshold: 140 * this.settings.behavior.movementSpeed * scale,
      moveThreshold: 6 * scale,
      vy: m.vy,
    });
  }

  /**
   * Approximate body bounds, px (also the overlay's click-through fallback until the renderer
   * reports its hit region). Upright: one body width across and one body height above the
   * anchor. On a wall the body hangs outside the window, about one body length up from the
   * grip at the anchor and one body height out from the wall line; the box covers that
   * vertical pose and the upright footprint (so the presence margins the renderer is tested
   * against still contain the drawing while it blends between poses), but never reaches into
   * the window past the paws on the wall line, except while it crosses the top corner.
   */
  private bodyBounds(): Rect {
    const m = this.mover;
    const bw = m.bodyWidth;
    const bh = m.bodyHeight;
    const upright = { x0: m.x - bw / 2, y0: m.y - bh, x1: m.x + bw / 2, y1: m.y };
    // In mid-leap it is airborne, in the upright jump pose: the hanging pose starts at the catch.
    const wall = m.onWall && m.climbPhase !== 'leap' ? m.wall : null;
    if (!wall) return { x: upright.x0, y: upright.y0, width: bw, height: bh };
    const out = wall.side === 'left' ? -1 : 1;
    const outer = m.x + out * 0.95 * bh;
    const inner = m.x - out * 0.15 * bh;
    let x0 = Math.min(upright.x0, outer, inner);
    let x1 = Math.max(upright.x1, outer, inner);
    const phase = m.climbPhase;
    if (phase !== 'pullUp' && phase !== 'swing') {
      const paws = WALL_PAW_REACH_BL * bw;
      if (out < 0) x1 = Math.max(x0, Math.min(x1, wall.x + paws));
      else x0 = Math.min(x1, Math.max(x0, wall.x - paws));
    }
    const y0 = Math.min(upright.y0, m.y - bw);
    return { x: x0, y: y0, width: x1 - x0, height: upright.y1 - y0 };
  }

  private fadeTarget(): number {
    if (this.mode === 'away') return 0;
    return this.mode === 'quiet' ? 0.5 : 1;
  }

  private nextTickMs(): number {
    if (Math.abs(this.fade - this.fadeTarget()) > 0.005) return 33;
    if (this.mode === 'away') return SLOWEST_TICK_MS;
    if (this.quitting) return 33;
    const s = this.act.state;
    const env = this.env;
    const m = this.mover;
    // Carried by its support (eased onto / off a taskbar, riding a window being dragged), asleep or not.
    const on = m.attachedSurface;
    if (m.settling || (on !== null && this.movingWindows.has(on.ownerId))) return 33;
    if (s === 'sleeping') return this.mode === 'normal' ? 150 : SLOWEST_TICK_MS;
    if (!m.grounded || m.groundSpeed > 1 || env?.cursorOverCat || env?.dragCursor) return 33;
    return Math.min(STATE_SPECS[s].tickMs, SLOWEST_TICK_MS);
  }

  private compose(snap: boolean): SimOutput {
    const m = this.mover;
    const now = this.now;
    this.emotes.update(now);
    const clip = this.computeClip();
    if (clip !== this.clip || this.restartClip) {
      this.clip = clip;
      this.clipStartedAt = now;
      this.restartClip = false;
    }
    const bw = m.bodyWidth;
    const bh = m.bodyHeight;
    // Gait rate: along the ground, or along the wall while climbing.
    const speedBl = m.grounded ? m.groundSpeed / bw : m.onWall ? m.climbSpeed / bw : 0;
    const k = 1 - Math.exp(-this.dt / 600);
    const st = this.cat.stats;
    this.arousal += (clamp(AROUSAL[this.act.state] + 0.3 * st.fear, 0, 1) - this.arousal) * k;
    const contentTarget = clamp(baseContentment(st) + (CONTENTMENT_BIAS[this.act.state] ?? 0), 0, 1);
    this.contentment += (contentTarget - this.contentment) * (1 - Math.exp(-this.dt / 1000));
    const ft = this.fadeTarget();
    const fstep = this.dt / FADE_MS;
    this.fade = this.fade < ft ? Math.min(ft, this.fade + fstep) : Math.max(ft, this.fade - fstep);
    const visible = this.fade > 0.01;
    const look = this.computeLook();

    const requests = this.requests;
    const s = this.act.state;
    const userIntervalMs = this.settings.perception.minIntervalSec * 1000;
    const perceptionGapMs = Number.isFinite(userIntervalMs) ? Math.max(PERCEPTION_FLOOR_MS, userIntervalMs) : PERCEPTION_FLOOR_MS;
    if ((s === 'curious' || s === 'watchingUser') && this.mode === 'normal' && now - this.lastPerceptionAt >= perceptionGapMs) {
      requests.push({ type: 'perception', reason: s === 'curious' ? 'curious' : 'watching', focus: look ?? { x: m.x, y: m.y - bh / 2 } });
      this.lastPerceptionAt = now;
    }
    if (this.dirty && now - this.lastSaveAt >= SAVE_MIN_INTERVAL_MS) {
      requests.push({ type: 'save' });
      this.dirty = false;
      this.lastSaveAt = now;
    }

    return {
      x: m.x,
      y: m.y,
      facing: m.facing,
      state: s,
      clip: this.clip,
      clipStartedAt: this.clipStartedAt,
      speed: speedBl < 0.02 ? 0 : speedBl,
      vy: m.airborne || m.climbPhase === 'leap' ? m.vy : 0,
      look,
      arousal: clamp(this.arousal, 0, 1),
      contentment: clamp(this.contentment, 0, 1),
      emote: visible ? this.emotes.emote : null,
      emoteStartedAt: this.emotes.emoteStartedAt,
      opacity: clamp(this.settings.appearance.opacity, 0, 1) * this.fade,
      visible,
      snap,
      displayId: m.displayId,
      support: m.support,
      boundsPx: this.bodyBounds(),
      nextTickMs: this.nextTickMs(),
      requests,
      reaction: visible && this.reaction && now - this.reaction.at < REACTION_HOLD_MS ? { ...this.reaction } : null,
    };
  }
}

/** Factory with test/diagnostic hooks (transition observer). */
export function createInstrumentedCatSim(opts: CatSimOptions, hooks: SimHooks): CatSimImpl {
  return new CatSimImpl(opts, hooks);
}

