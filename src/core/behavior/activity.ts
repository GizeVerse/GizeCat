// One running activity: the state plus everything its handler needs.
import type { BehaviorState } from '../../shared/cat';
import type { Point } from '../../shared/geometry';
import type { GoalStatus, LandingInfo } from '../movement';
import type { Phase } from './clips';
import type { Variant } from './decide';
import type { TransitionCause } from './states';

export interface FollowUp {
  state: BehaviorState;
  init: ActivityInit;
}

export interface ActivityInit {
  variant?: Variant | null;
  target?: Point | null;
  windowId?: string | null;
  then?: FollowUp | null;
  /** Shortened sequence (quit). */
  quick?: boolean;
  /** Overrides the random dwell. */
  dwellMs?: number;
  /** Physical states: keep the interrupted activity to resume after landing. */
  suspend?: boolean;
  landing?: LandingInfo | null;
}

export interface Activity {
  state: BehaviorState;
  cause: TransitionCause;
  /** When this activity began (kept across jump/fall interludes). */
  startedAt: number;
  dwellMs: number;
  phase: Phase;
  phaseAt: number;
  /** Planned duration of the current phase; 0 = event-driven. */
  phaseMs: number;
  variant: Variant | null;
  target: Point | null;
  windowId: string | null;
  then: FollowUp | null;
  quick: boolean;
  /** The activity finished its job and is waiting for the next one. */
  done: boolean;
  goalStatus: GoalStatus;
  counter: number;
  engagedMs: number;
  observedMs: number;
  answered: boolean;
  lastPetAt: number;
  landing: LandingInfo | null;
}

export function makeActivity(state: BehaviorState, cause: TransitionCause, now: number, dwellMs: number, init: ActivityInit): Activity {
  return {
    state,
    cause,
    startedAt: now,
    dwellMs,
    phase: 'main',
    phaseAt: now,
    phaseMs: 0,
    variant: init.variant ?? null,
    target: init.target ? { x: init.target.x, y: init.target.y } : null,
    windowId: init.windowId ?? null,
    then: init.then ?? null,
    quick: init.quick ?? false,
    done: false,
    goalStatus: 'none',
    counter: 0,
    engagedMs: 0,
    observedMs: 0,
    answered: false,
    lastPetAt: now,
    landing: init.landing ?? null,
  };
}
