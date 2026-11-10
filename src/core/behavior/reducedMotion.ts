// Reduced motion in the sim (settings.companion.reducedMotion or SimEnv.reducedMotion, the host's own
// "reduce motion" preference). One pure policy so the rules live in one place and are testable without a
// sim: what the cat may still do by choice and how calm it is. Physics the user or the world causes (a
// drag, a throw, a fall, a landing) is never touched by it, and neither is the hop (a small hop is the
// biggest voluntary jump the policy allows).
import type { BehaviorId } from '../../shared/settings';
import type { Pace } from '../movement';

export interface MotionPolicy {
  /** The user (or the host) asked for less motion. */
  readonly reduced: boolean;
  /** May the cat sprint or run when nothing forces it (an urgent flight from a wave is still a walk)? */
  readonly runByChoice: boolean;
  /** May it make a big voluntary jump (a pounce, a hop between surfaces, a wall jump)? Small hops stay. */
  readonly bigJumps: boolean;
  /** Multiplier on the strength of decorative reactions and body-language overlays (0 = none). */
  readonly reactionScale: number;
  /** Multiplier on the autonomous cadence: dwells are this much longer, so the cat changes what it does less often. */
  readonly cadenceScale: number;
}

const NORMAL: MotionPolicy = Object.freeze({ reduced: false, runByChoice: true, bigJumps: true, reactionScale: 1, cadenceScale: 1 });
const REDUCED: MotionPolicy = Object.freeze({ reduced: true, runByChoice: false, bigJumps: false, reactionScale: 0, cadenceScale: 1.35 });

/** The policy for the current preference. Pure and total: anything that is not exactly `true` is the normal policy. */
export function motionPolicy(reduced: boolean | null | undefined): MotionPolicy {
  return reduced === true ? REDUCED : NORMAL;
}

/** Opt-outs the reduced policy adds on top of the user's own: the big voluntary jumps and the running about. */
export const REDUCED_MOTION_OPT_OUTS: readonly BehaviorId[] = Object.freeze<BehaviorId[]>(['pounce', 'surfaceHops', 'slips', 'zoomies', 'tailChase']);

/**
 * The effective opt-out set under a policy. Without reduced motion this returns `base` itself (not a
 * copy), so the default path is bit-identical to a sim that has no such policy.
 */
export function withMotionOptOuts(base: ReadonlySet<BehaviorId>, policy: MotionPolicy): ReadonlySet<BehaviorId> {
  if (policy.bigJumps) return base;
  const out = new Set<BehaviorId>(base);
  for (const id of REDUCED_MOTION_OPT_OUTS) out.add(id);
  return out;
}

/** The pace the cat may use by choice: running and sprinting become a walk under the reduced policy. */
export function calmPace(pace: Pace, policy: MotionPolicy): Pace {
  if (policy.runByChoice) return pace;
  return pace === 'run' || pace === 'chase' || pace === 'sprint' ? 'walk' : pace;
}

/** A dwell stretched by the policy's cadence (a number that is not finite or not positive passes through unchanged). */
export function calmDwell(ms: number, policy: MotionPolicy): number {
  return Number.isFinite(ms) && ms > 0 ? ms * policy.cadenceScale : ms;
}
