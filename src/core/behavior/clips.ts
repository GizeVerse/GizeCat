// State + phase -> animation clip. 'locomotion' resolves to walk/run/stand from the
// body's motion; 'airborne' resolves to jump/fall from vertical velocity.
import type { AnimClip, BehaviorState } from '../../shared/cat';

export type Phase =
  | 'main'
  | 'stand'
  | 'sit'
  | 'loaf'
  | 'approach'
  | 'arrived'
  | 'look'
  | 'stretch'
  | 'settle'
  | 'yawn'
  | 'sleep'
  | 'crouch'
  | 'air'
  | 'stalk'
  | 'pawAt'
  | 'rollOver'
  | 'zoomies'
  | 'hop'
  | 'meow'
  | 'wait'
  | 'flee'
  | 'hide';

type ClipRef = AnimClip | 'locomotion' | 'airborne';

export const CLIP_MAP: Readonly<Record<BehaviorState, Partial<Record<Phase, ClipRef>> & { main: ClipRef }>> = {
  sleeping: { main: 'sleep' },
  wakingUp: { main: 'wake', stretch: 'wake', settle: 'sit' },
  fallingAsleep: { main: 'yawn', yawn: 'yawn', loaf: 'loaf', sleep: 'sleep' },
  idle: { main: 'sit', stand: 'stand', sit: 'sit', meow: 'meow' },
  walking: { main: 'locomotion', approach: 'locomotion', arrived: 'stand', crouch: 'crouch' },
  running: { main: 'locomotion', approach: 'locomotion', arrived: 'stand' },
  chasingCursor: { main: 'locomotion', approach: 'locomotion', stalk: 'crouch', pawAt: 'pawAt', look: 'sit' },
  watchingCursor: { main: 'sit', crouch: 'crouch', loaf: 'loaf' },
  curious: { main: 'sit', approach: 'locomotion', look: 'sit' },
  inspectingWindow: { main: 'sit', approach: 'locomotion', look: 'sit', loaf: 'loaf' },
  watchingUser: { main: 'sit', approach: 'locomotion', sit: 'sit', loaf: 'loaf' },
  playing: { main: 'crouch', crouch: 'crouch', pawAt: 'pawAt', rollOver: 'rollOver', zoomies: 'locomotion', hop: 'crouch', sit: 'sit' },
  beingPetted: { main: 'petted' },
  startled: { main: 'startle' },
  annoyed: { main: 'annoyed' },
  seekingAttention: { main: 'sit', approach: 'locomotion', meow: 'meow', wait: 'sit' },
  resting: { main: 'loaf', loaf: 'loaf', sit: 'sit' },
  grooming: { main: 'groom' },
  hiding: { main: 'hide', flee: 'locomotion', hide: 'hide' },
  held: { main: 'held' },
  jumping: { main: 'crouch', crouch: 'crouch', air: 'airborne' },
  falling: { main: 'airborne' },
  landing: { main: 'land' },
  away: { main: 'sit', sleep: 'sleep' },
};

export interface MotionContext {
  /** Ground speed in px/s. */
  groundSpeed: number;
  /** Speed (px/s) at or above which locomotion uses the run cycle. */
  runThreshold: number;
  /** Below this the cat counts as standing. */
  moveThreshold: number;
  /** Vertical velocity, px/s (negative = rising). */
  vy: number;
}

export function clipFor(state: BehaviorState, phase: Phase, motion: MotionContext): AnimClip {
  const map = CLIP_MAP[state];
  const ref = map[phase] ?? map.main;
  if (ref === 'locomotion') {
    if (motion.groundSpeed < motion.moveThreshold) return 'stand';
    return motion.groundSpeed >= motion.runThreshold ? 'run' : 'walk';
  }
  if (ref === 'airborne') return motion.vy < 0 ? 'jump' : 'fall';
  return ref;
}
