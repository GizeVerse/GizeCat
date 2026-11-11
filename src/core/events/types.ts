// The seam between the world-event engine (src/core/events) and the cat sim (src/core/behavior).
// The engine is pure and platform-agnostic: it knows nothing about Electron, Win32 or Android. Every
// input arrives through EventTickInput (the clock and the random source included, so the schedule
// and the outcomes are deterministic for a given seed), every effect leaves through EventTickOutput.
// The sim stays the source of truth for the cat's body: the engine only DESCRIBES what the cat is
// invited to do (an EventIntent) and the sim decides whether, and how, to do it (priorities: the
// user's drag, throw, tap or pause always win; sleep and fear can refuse an invitation).
import type { Emote, SoundCue, AnimClip, BehaviorState, Facing } from '../../shared/cat';
import type { AnyEventId, EventHistoryEntry, JournalEntry, Mood, OutcomeId, RenderProp, WorldEventSnapshot } from '../../shared/companion';
import type { Point, Rect } from '../../shared/geometry';

/**
 * How this cat tends to react, 0..1 unless noted, derived by the sim each tick from the chosen
 * personality profile, the born traits, the current mood and the energy. The engine reads only this:
 * it never sees the profile table, so personalities stay tunable in one place
 * (src/core/behavior/personalityProfiles.ts).
 */
export interface EventTemperament {
  /** How readily it notices and engages with an event (0 ignores, 1 pounces on every one). */
  interest: number;
  /** Boldness: how close it dares to go to something new (shy cats watch from afar). */
  boldness: number;
  /** Chase and play duration multiplier (0.5 short .. 1.6 long). */
  persistence: number;
  /** How strongly it startles at sudden things (thunder, a ghost). */
  startle: number;
  /** Appetite for toys and games. */
  playfulness: number;
  /** Calm cats move less suddenly and keep their composure. */
  calm: number;
  /** Mischief: unusual, playful or sneaky reactions. */
  mischief: number;
  /** Wakefulness 0..1 (asleep or very drowsy cats notice less and later). */
  alertness: number;
  /** Energy 0..1: movement intensity, run versus walk. */
  energy: number;
  /**
   * Shy cats (personality knob watchFromDistance): look at a new thing from where they stand for a
   * bounded while before going near it, and keep a larger stand-off afterwards. Absent or false: a
   * bold cat's behaviour, bit for bit (no random draw is made for it).
   */
  watchFirst?: boolean;
  /**
   * Lazy cats (personality knob ignoreMinorEvents): may let a gentle, low-stakes event (EventDef.minor)
   * pass without getting up. Absent or false: every event is engaged with (no random draw is made).
   */
  ignoreMinor?: boolean;
}

/** What the engine may know about the cat this tick. Coordinates are the sim's world px. */
export interface EventCatView {
  x: number;
  y: number;
  facing: Facing;
  /** Body width in px at the current scale (also the unit for stand-off distances). */
  bodyW: number;
  /** Size multiplier (appearance.size); props scale with it. */
  scale: number;
  state: BehaviorState;
  /** True while sleeping, falling asleep or waking. */
  asleep: boolean;
  /** True when something physical or the user holds the cat (held, falling, jumping, being petted, away). */
  busy: boolean;
  mood: Mood;
  /** Distance to the nearest left/right boundary of the floor the cat is on (px), to avoid placing props off-floor. */
  floorLeft: number;
  floorRight: number;
}

export interface EventTickInput {
  /** Monotonic sim clock, ms. */
  now: number;
  /** Real elapsed time since the previous tick, ms (>= 0). The engine detects suspends and clock jumps from it. */
  dt: number;
  /** Wall clock (epoch ms) for persisted history times. */
  wallNow: number;
  /** Local hour 0..24 (the Midnight Visitor only comes at night; a few events prefer daylight). */
  localHour: number;
  /** Uniform [0,1). */
  random: () => number;
  /** The event stage in px: x range is the floor the cat can use, bottom is the floor y, top the highest a prop may fly. */
  stage: Rect;
  cat: EventCatView;
  temperament: EventTemperament;
  /** Settings the engine honours. */
  choices: {
    enabled: boolean;
    rare: boolean;
    pace: number;
    disabled: readonly AnyEventId[];
    reducedMotion: boolean;
  };
  /**
   * The cat may start (or continue) an event: not paused, hidden, away, held, in a fullscreen app's
   * display, under a drag, or typing hard. When false and an event is running, the engine winds it
   * down gracefully (it never freezes a prop in mid-air); when false and none is, scheduling pauses.
   */
  allowed: boolean;
  /** True while the user is actively interacting (pointer on the cat, dragging): defer new events. */
  userBusy: boolean;
}

/** What an event invites the cat to do. The sim maps these onto its mover, clips and reactions. */
export type IntentKind =
  | 'watch' // look at the target, keep position
  | 'approach' // walk to within standoff of the target
  | 'sneak' // stalk to within standoff of the target
  | 'chase' // run after a moving target (never catches)
  | 'flee' // run or retreat away from the target
  | 'play' // bat or pounce at a toy-like prop at the target
  | 'hide' // hide low until the scare passes
  | 'inspect' // sniff/sit by a settled prop
  | 'brace' // crouch and hold (wind, wave)
  | 'climb' // use a screen edge to get out of the way (if the platform has one)
  | 'hop' // small jump (over a wave, at a bubble)
  | 'shake' // shake the body (wet)
  | 'settle' // sit or lie near/in the prop
  | 'react'; // one-off emote/reaction without moving

export interface EventIntent {
  kind: IntentKind;
  /** The target in world px (a prop's ground point, or a point to look at). */
  target?: Point;
  /** Stop this far from the target (px); absent: the sim's default for the kind. */
  standoffPx?: number;
  /** Desired pace; the sim clamps to the gait limits. */
  pace?: 'slow' | 'walk' | 'run';
  /** Suggested clip for a stationary intent (the sim resolves it through the animation catalogue). */
  clip?: AnimClip;
  emote?: Emote;
  sound?: SoundCue;
  /** Mood the event pushes (0..1 strength), decaying quickly. */
  mood?: { mood: Mood; strength: number };
  /**
   * Intent urgency 0..1: the sim yields to anything above its own current priority only when this is
   * high (a wave, thunder); gentle invitations are ignored by a cat that is busy or asleep.
   */
  urgency: number;
}

export interface EventTickOutput {
  /** The props to draw this tick (<= MAX_PROPS), world px. Empty when nothing is running. */
  props: readonly RenderProp[];
  /** What the cat is invited to do, or null. */
  intent: EventIntent | null;
  active: WorldEventSnapshot | null;
  /** Set once, on the tick an event finishes: the history entry and, if journal-worthy, the journal entry. */
  finished: { history: EventHistoryEntry; journal: JournalEntry | null } | null;
}

export type InterruptReason = 'user' | 'drag' | 'pause' | 'hidden' | 'sleep' | 'fullscreen' | 'display' | 'settings' | 'suspend' | 'lock';

/** Everything of the engine that survives a restart: history and counters only, never a half-played event. */
export interface EventEngineMemory {
  history: readonly EventHistoryEntry[];
  /**
   * How many times each event has played (the persisted world.counts). Drives novelty: a cat is a
   * little more drawn to events it has seen less often. Optional (absent = nothing seen yet), whole
   * numbers, sanitised on restore (unknown ids, negatives, NaN and huge values are dropped or capped).
   */
  counts?: Partial<Record<AnyEventId, number>>;
}

export interface WorldEventEngine {
  tick(input: EventTickInput): EventTickOutput;
  /**
   * Something outside needs the event to stop: it ends with a graceful fade (props leave, the cat is
   * released) and the schedule restarts only AFTER it finished. 'user' and 'drag' end it at once.
   */
  interrupt(reason: InterruptReason): void;
  /** True while an event is running (the next one never starts until this is false). */
  readonly active: boolean;
  /** ms of sim time until the next event is due, or null while one runs or scheduling is paused. For status displays and tests. */
  msUntilNext(now: number): number | null;
  /** Restore history after a restart; the next event is rescheduled from scratch (no burst, no half-played event). */
  restore(memory: EventEngineMemory): void;
  snapshot(): EventEngineMemory;
  /** Force an event now (the dev menu and status "play one now"); false if one is running or the id is not allowed. */
  trigger(id: AnyEventId, input: EventTickInput): boolean;
  debugInfo(): Record<string, unknown>;
}

export interface CreateEventEngineOptions {
  /** Sim clock at creation (ms). */
  now: number;
  random: () => number;
  /** Persisted history, if any. */
  memory?: EventEngineMemory;
}

export type OutcomeWeights = readonly { id: OutcomeId; weight: number }[];
