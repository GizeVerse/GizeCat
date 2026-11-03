// State + phase -> animation clip. 'locomotion' resolves to walk/run/stand from the
// body's motion; 'airborne' resolves to jump/fall from vertical velocity. v1.2 (ADR 0003 §8):
// the stalk, slink and sprint gaits resolve to their clip while moving and to a still pose
// otherwise; the new one-shots (impact, landRecover, swat, hiss, stretch) and loops (grumpy,
// tailChase) are reached through phases.
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
  | 'hide'
  // ---- v1.2 ----
  /** Hunt: ears forward, a look at the prey before anything else. */
  | 'notice'
  /** Hunt: batting at the cursor (pawAt) or one quick swat. */
  | 'bat'
  | 'swat'
  /** Landing: the impact squash, then the recovery after an unplanned hard landing. */
  | 'impact'
  | 'recover'
  /** Annoyed: the defensive hiss, the grumpy stare. */
  | 'hiss'
  | 'grumpy'
  /** Playing: chasing its own tail. */
  | 'tailChase'
  /** Walking: the low retreat gait; running: the flat-out dash. */
  | 'slink'
  | 'sprint';

type ClipRef = AnimClip | 'locomotion' | 'airborne' | 'stalkGait' | 'slinkGait' | 'sprintGait';

export const CLIP_MAP: Readonly<Record<BehaviorState, Partial<Record<Phase, ClipRef>> & { main: ClipRef }>> = {
  sleeping: { main: 'sleep' },
  wakingUp: { main: 'wake', stretch: 'wake', settle: 'sit' },
  fallingAsleep: { main: 'yawn', yawn: 'yawn', loaf: 'loaf', sleep: 'sleep' },
  idle: { main: 'sit', stand: 'stand', sit: 'sit', meow: 'meow', stretch: 'stretch' },
  walking: { main: 'locomotion', approach: 'locomotion', arrived: 'stand', crouch: 'crouch', slink: 'slinkGait' },
  running: { main: 'locomotion', approach: 'locomotion', arrived: 'stand', sprint: 'sprintGait' },
  chasingCursor: { main: 'locomotion', approach: 'locomotion', stalk: 'stalkGait', pawAt: 'pawAt', look: 'sit', notice: 'crouch', crouch: 'crouch', bat: 'pawAt', swat: 'swat' },
  watchingCursor: { main: 'sit', crouch: 'crouch', loaf: 'loaf' },
  curious: { main: 'sit', approach: 'locomotion', look: 'sit' },
  inspectingWindow: { main: 'sit', approach: 'locomotion', look: 'sit', loaf: 'loaf' },
  watchingUser: { main: 'sit', approach: 'locomotion', sit: 'sit', loaf: 'loaf' },
  playing: { main: 'crouch', crouch: 'crouch', pawAt: 'pawAt', rollOver: 'rollOver', zoomies: 'locomotion', hop: 'crouch', sit: 'sit', tailChase: 'tailChase' },
  beingPetted: { main: 'petted' },
  startled: { main: 'startle' },
  annoyed: { main: 'annoyed', hiss: 'hiss', grumpy: 'grumpy', swat: 'swat' },
  seekingAttention: { main: 'sit', approach: 'locomotion', meow: 'meow', wait: 'sit' },
  resting: { main: 'loaf', loaf: 'loaf', sit: 'sit' },
  grooming: { main: 'groom' },
  hiding: { main: 'hide', flee: 'locomotion', hide: 'hide' },
  held: { main: 'held' },
  jumping: { main: 'crouch', crouch: 'crouch', air: 'airborne' },
  falling: { main: 'airborne' },
  landing: { main: 'land', impact: 'impact', recover: 'landRecover' },
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
  const moving = motion.groundSpeed >= motion.moveThreshold;
  switch (ref) {
    case 'locomotion':
      if (!moving) return 'stand';
      return motion.groundSpeed >= motion.runThreshold ? 'run' : 'walk';
    case 'airborne':
      return motion.vy < 0 ? 'jump' : 'fall';
    case 'stalkGait':
      return moving ? 'stalk' : 'crouch';
    case 'slinkGait':
      return moving ? 'slink' : 'stand';
    case 'sprintGait':
      return moving ? 'sprint' : 'stand';
    default:
      return ref;
  }
}
