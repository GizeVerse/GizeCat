// The cat's state machine definition: which transitions exist, how important each
// state is, how long it lasts, how often it may recur and what may interrupt it.
import type { BehaviorState } from '../../shared/cat';
import { BEHAVIOR_STATES } from '../../shared/cat';

/** Why a transition happens. Determines which guards apply (see `guardsFor`). */
export type TransitionCause =
  | 'autonomous' // the cat's own decision after a dwell
  | 'stimulus' // reaction to an environment event
  | 'interaction' // direct user interaction (tap, pet)
  | 'command' // tray/context menu command
  | 'completion' // the state finished its job / a queued follow-up
  | 'physical' // jump, fall, landing, being held
  | 'lifecycle'; // hide, pause, fullscreen, lock, quit

export const PHYSICAL_STATES: ReadonlySet<BehaviorState> = new Set<BehaviorState>(['held', 'jumping', 'falling', 'landing']);
export const ASLEEP_STATES: ReadonlySet<BehaviorState> = new Set<BehaviorState>(['sleeping', 'fallingAsleep']);
/** States in which the cat sits/lies still and stays quiet. */
export const CALM_STATES: ReadonlySet<BehaviorState> = new Set<BehaviorState>([
  'idle',
  'resting',
  'grooming',
  'watchingUser',
  'watchingCursor',
  'curious',
  'inspectingWindow',
]);
/** States that look like "running around". */
export const ACTIVE_STATES: ReadonlySet<BehaviorState> = new Set<BehaviorState>(['running', 'chasingCursor', 'playing']);

const AWAKE: readonly BehaviorState[] = [
  'idle',
  'walking',
  'running',
  'chasingCursor',
  'watchingCursor',
  'curious',
  'inspectingWindow',
  'watchingUser',
  'playing',
  'beingPetted',
  'startled',
  'annoyed',
  'seekingAttention',
  'resting',
  'grooming',
  'hiding',
];
const ESCAPE: readonly BehaviorState[] = ['held', 'falling', 'away'];

function without(list: readonly BehaviorState[], ...remove: BehaviorState[]): BehaviorState[] {
  return list.filter((s) => !remove.includes(s));
}

/** from -> allowed targets. Anything not listed is impossible. */
export const TRANSITIONS: Readonly<Record<BehaviorState, readonly BehaviorState[]>> = {
  sleeping: ['wakingUp', 'startled', ...ESCAPE],
  wakingUp: ['idle', 'walking', 'resting', 'grooming', 'watchingUser', 'watchingCursor', 'curious', 'seekingAttention', 'beingPetted', 'fallingAsleep', 'startled', 'annoyed', ...ESCAPE],
  fallingAsleep: ['sleeping', 'idle', 'wakingUp', 'beingPetted', 'startled', 'annoyed', ...ESCAPE],
  idle: [...without(AWAKE, 'idle'), 'fallingAsleep', ...ESCAPE],
  walking: [...without(AWAKE, 'walking'), 'fallingAsleep', 'jumping', ...ESCAPE],
  running: ['idle', 'walking', 'chasingCursor', 'watchingCursor', 'playing', 'hiding', 'curious', 'startled', 'annoyed', 'resting', 'beingPetted', 'seekingAttention', 'jumping', ...ESCAPE],
  chasingCursor: ['idle', 'watchingCursor', 'playing', 'running', 'walking', 'resting', 'beingPetted', 'startled', 'annoyed', 'hiding', ...ESCAPE],
  watchingCursor: ['idle', 'chasingCursor', 'playing', 'walking', 'curious', 'resting', 'grooming', 'beingPetted', 'startled', 'annoyed', 'hiding', 'seekingAttention', 'watchingUser', 'fallingAsleep', ...ESCAPE],
  curious: ['idle', 'walking', 'running', 'inspectingWindow', 'watchingUser', 'watchingCursor', 'playing', 'resting', 'grooming', 'beingPetted', 'startled', 'annoyed', 'hiding', 'jumping', ...ESCAPE],
  inspectingWindow: ['idle', 'curious', 'walking', 'watchingUser', 'watchingCursor', 'resting', 'grooming', 'playing', 'fallingAsleep', 'beingPetted', 'startled', 'annoyed', 'hiding', 'jumping', ...ESCAPE],
  watchingUser: ['idle', 'walking', 'curious', 'inspectingWindow', 'watchingCursor', 'chasingCursor', 'playing', 'resting', 'grooming', 'seekingAttention', 'fallingAsleep', 'beingPetted', 'startled', 'annoyed', 'jumping', ...ESCAPE],
  playing: ['running', 'chasingCursor', 'idle', 'walking', 'resting', 'grooming', 'watchingCursor', 'beingPetted', 'startled', 'annoyed', 'jumping', ...ESCAPE],
  beingPetted: ['idle', 'resting', 'grooming', 'fallingAsleep', 'walking', 'watchingUser', 'playing', 'annoyed', 'startled', ...ESCAPE],
  startled: ['hiding', 'running', 'idle', 'walking', 'annoyed', 'curious', 'watchingCursor', 'watchingUser', ...ESCAPE],
  annoyed: ['hiding', 'idle', 'walking', 'running', 'grooming', 'resting', 'startled', 'watchingCursor', ...ESCAPE],
  seekingAttention: ['beingPetted', 'idle', 'walking', 'watchingUser', 'watchingCursor', 'chasingCursor', 'playing', 'resting', 'grooming', 'annoyed', 'startled', 'jumping', ...ESCAPE],
  resting: ['fallingAsleep', 'wakingUp', 'idle', 'walking', 'grooming', 'watchingUser', 'watchingCursor', 'curious', 'beingPetted', 'seekingAttention', 'startled', 'annoyed', ...ESCAPE],
  grooming: ['idle', 'resting', 'fallingAsleep', 'walking', 'watchingUser', 'watchingCursor', 'curious', 'beingPetted', 'startled', 'annoyed', ...ESCAPE],
  hiding: ['idle', 'walking', 'running', 'resting', 'grooming', 'watchingCursor', 'curious', 'startled', 'beingPetted', 'jumping', ...ESCAPE],
  held: ['falling', 'landing', 'away'],
  jumping: ['falling', 'landing', 'held', 'away'],
  falling: ['landing', 'held', 'away'],
  landing: [...AWAKE, 'fallingAsleep', 'jumping', ...ESCAPE],
  away: ['idle', 'wakingUp', 'sleeping', 'fallingAsleep', 'resting'],
};

const TRANSITION_SETS = new Map<BehaviorState, ReadonlySet<BehaviorState>>(
  BEHAVIOR_STATES.map((s) => [s, new Set(TRANSITIONS[s])] as const),
);

export function canTransition(from: BehaviorState, to: BehaviorState): boolean {
  return TRANSITION_SETS.get(from)?.has(to) ?? false;
}

export interface StateSpec {
  /** Higher interrupts lower (for stimulus-driven changes). */
  priority: number;
  /** Bounded random dwell before the cat reconsiders on its own, ms. */
  dwellMs: readonly [number, number];
  /** After leaving, autonomous/stimulus re-entry is blocked for this long, ms. */
  cooldownMs: number;
  /** Lower-or-equal priority stimuli may interrupt once the minimum dwell has passed. */
  interruptible: boolean;
  /** Preferred tick interval while in this state, ms. */
  tickMs: number;
}

export const STATE_SPECS: Readonly<Record<BehaviorState, StateSpec>> = {
  sleeping: { priority: 40, dwellMs: [180_000, 600_000], cooldownMs: 20_000, interruptible: false, tickMs: 150 },
  wakingUp: { priority: 45, dwellMs: [2_000, 3_200], cooldownMs: 5_000, interruptible: false, tickMs: 33 },
  fallingAsleep: { priority: 22, dwellMs: [2_600, 4_800], cooldownMs: 15_000, interruptible: true, tickMs: 33 },
  idle: { priority: 5, dwellMs: [4_000, 14_000], cooldownMs: 0, interruptible: true, tickMs: 66 },
  walking: { priority: 15, dwellMs: [3_000, 25_000], cooldownMs: 1_500, interruptible: true, tickMs: 33 },
  running: { priority: 30, dwellMs: [1_500, 8_000], cooldownMs: 8_000, interruptible: true, tickMs: 33 },
  chasingCursor: { priority: 35, dwellMs: [2_000, 7_000], cooldownMs: 25_000, interruptible: true, tickMs: 33 },
  watchingCursor: { priority: 20, dwellMs: [3_000, 10_000], cooldownMs: 6_000, interruptible: true, tickMs: 33 },
  curious: { priority: 25, dwellMs: [4_000, 10_000], cooldownMs: 15_000, interruptible: true, tickMs: 66 },
  inspectingWindow: { priority: 30, dwellMs: [6_000, 16_000], cooldownMs: 30_000, interruptible: true, tickMs: 66 },
  watchingUser: { priority: 20, dwellMs: [10_000, 45_000], cooldownMs: 10_000, interruptible: true, tickMs: 66 },
  playing: { priority: 35, dwellMs: [3_000, 9_000], cooldownMs: 40_000, interruptible: true, tickMs: 33 },
  beingPetted: { priority: 65, dwellMs: [1_800, 3_000], cooldownMs: 0, interruptible: false, tickMs: 33 },
  startled: { priority: 70, dwellMs: [800, 1_300], cooldownMs: 12_000, interruptible: false, tickMs: 33 },
  annoyed: { priority: 60, dwellMs: [1_600, 3_200], cooldownMs: 8_000, interruptible: false, tickMs: 33 },
  seekingAttention: { priority: 30, dwellMs: [8_000, 18_000], cooldownMs: 600_000, interruptible: true, tickMs: 33 },
  resting: { priority: 10, dwellMs: [15_000, 70_000], cooldownMs: 5_000, interruptible: true, tickMs: 66 },
  grooming: { priority: 15, dwellMs: [5_000, 14_000], cooldownMs: 30_000, interruptible: true, tickMs: 66 },
  hiding: { priority: 50, dwellMs: [6_000, 20_000], cooldownMs: 20_000, interruptible: false, tickMs: 33 },
  held: { priority: 95, dwellMs: [0, 0], cooldownMs: 0, interruptible: false, tickMs: 33 },
  jumping: { priority: 88, dwellMs: [0, 0], cooldownMs: 0, interruptible: false, tickMs: 33 },
  falling: { priority: 90, dwellMs: [0, 0], cooldownMs: 0, interruptible: false, tickMs: 33 },
  landing: { priority: 85, dwellMs: [250, 250], cooldownMs: 0, interruptible: false, tickMs: 33 },
  away: { priority: 100, dwellMs: [0, 0], cooldownMs: 0, interruptible: false, tickMs: 500 },
};

/** Counted transitions (see `isCountedTransition`) allowed per rolling window. */
export const MAX_STATE_CHANGES_PER_WINDOW = 8;
export const STATE_CHANGE_WINDOW_MS = 10_000;

/** Physical and lifecycle changes never count toward the anti-thrash budget. */
export function isCountedTransition(from: BehaviorState, to: BehaviorState, cause: TransitionCause): boolean {
  if (cause === 'physical' || cause === 'lifecycle') return false;
  if (PHYSICAL_STATES.has(from) || PHYSICAL_STATES.has(to)) return false;
  return from !== 'away' && to !== 'away';
}

export interface Guards {
  budget: boolean;
  cooldown: boolean;
  /** Priority / min-dwell / interruptibility check. */
  interrupt: boolean;
}

export function guardsFor(cause: TransitionCause): Guards {
  switch (cause) {
    case 'autonomous':
    case 'stimulus':
      return { budget: true, cooldown: true, interrupt: true };
    case 'interaction':
    case 'command':
    case 'completion':
      return { budget: true, cooldown: false, interrupt: false };
    case 'physical':
    case 'lifecycle':
      return { budget: false, cooldown: false, interrupt: false };
  }
}

/** May a stimulus-driven change to `to` interrupt `from` after `dwellMs` in it? */
export function mayInterrupt(from: BehaviorState, to: BehaviorState, dwellMs: number): boolean {
  const a = STATE_SPECS[from];
  const b = STATE_SPECS[to];
  if (b.priority > a.priority) return true;
  return a.interruptible && dwellMs >= a.dwellMs[0];
}

/**
 * Neutral states a multi-step change may pass through. Reactions (startled,
 * annoyed, ...) are never used as stepping stones: a sleeping cat that is called
 * wakes up and stretches, it does not startle and bolt.
 */
export const PATH_INTERMEDIATES: ReadonlySet<BehaviorState> = new Set<BehaviorState>(['wakingUp', 'idle', 'resting', 'fallingAsleep']);

/**
 * Shortest path of allowed transitions from -> to that only passes through
 * neutral intermediates (PATH_INTERMEDIATES). Returns the states after `from`
 * (ending with `to`), or null when unreachable.
 */
export function findPath(from: BehaviorState, to: BehaviorState): BehaviorState[] | null {
  if (from === to) return [];
  if (canTransition(from, to)) return [to];
  const prev = new Map<BehaviorState, BehaviorState>();
  const queue: BehaviorState[] = [from];
  const seen = new Set<BehaviorState>([from]);
  while (queue.length > 0) {
    const s = queue.shift() as BehaviorState;
    for (const n of TRANSITIONS[s]) {
      if (seen.has(n)) continue;
      seen.add(n);
      prev.set(n, s);
      if (n === to) {
        const path: BehaviorState[] = [to];
        let c = s;
        while (c !== from) {
          path.unshift(c);
          c = prev.get(c) as BehaviorState;
        }
        return path;
      }
      if (PATH_INTERMEDIATES.has(n)) queue.push(n);
    }
  }
  return null;
}

export function isPhysical(s: BehaviorState): boolean {
  return PHYSICAL_STATES.has(s);
}
