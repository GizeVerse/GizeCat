// Shared vocabulary for the single cat: behaviour states, animation clips, emotes,
// skins and the render snapshot the main process sends to overlay renderers.

/** Behaviour states of the cat's state machine (src/core/behavior). */
export const BEHAVIOR_STATES = [
  'sleeping',
  'wakingUp',
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
  'fallingAsleep',
  // Physical / lifecycle states
  'held',
  'jumping',
  'falling',
  'landing',
  'away',
] as const;
export type BehaviorState = (typeof BEHAVIOR_STATES)[number];

/**
 * Animation clips the renderer must implement. Clip selection is decided by the
 * brain; pose blending, breathing, blinking, tail physics and look-at are
 * procedural layers in the renderer.
 */
export const ANIM_CLIPS = [
  'stand', // standing idle, breathing, blinking, tail sway
  'sit', // sitting upright, head can track `look`
  'loaf', // lying with paws tucked (resting)
  'sleep', // curled up, slow visible breathing
  'wake', // waking: stretch (front stretch, then back), ~1.6 s, non-looping
  'yawn', // sitting yawn, ~1.2 s, non-looping
  'walk', // walk cycle, rate scales with `speed`
  'run', // gallop cycle, rate scales with `speed`
  'crouch', // low anticipation crouch with butt wiggle (before pounce/jump)
  'jump', // airborne rising
  'fall', // airborne falling, legs reaching down
  'land', // landing squash, ~0.25 s, non-looping
  'startle', // arched back, puffed tail, small hop, ~0.8 s
  'annoyed', // ears flat, tail lashing, narrowed eyes
  'petted', // eyes closed, head lean, purr vibration
  'groom', // licking paw and wiping face (loop)
  'pawAt', // batting a paw toward `look` (loop)
  'held', // dangling while dragged by the user
  'meow', // sitting meow (mouth opens), ~0.9 s
  'hide', // low crouch, ears back, peeking
  'rollOver', // playful belly-up wiggle (loop)
  // v1.1: clinging to a vertical window edge and climbing (loop; rate scales with speed). Anchor = the
  // grip point on the wall line at hind-paw height; the body extends upwards along the wall; facing +1
  // means the wall is to the cat's right (it hangs on a window's LEFT edge), -1 the mirror image.
  'climb',
] as const;
export type AnimClip = (typeof ANIM_CLIPS)[number];

/** Clips that play once and then hold their final pose until the brain changes clip. */
export const ONE_SHOT_CLIPS: ReadonlySet<AnimClip> = new Set<AnimClip>(['wake', 'yawn', 'land', 'startle', 'meow']);

export const EMOTES = ['heart', 'zzz', 'exclaim', 'question', 'anger', 'note', 'sparkle'] as const;
export type Emote = (typeof EMOTES)[number];

export const SKINS = ['ginger', 'gray', 'black', 'tuxedo', 'calico', 'siamese', 'cream'] as const;
export type SkinId = (typeof SKINS)[number];

export const RENDER_STYLES = ['smooth', 'pixel'] as const;
export type RenderStyle = (typeof RENDER_STYLES)[number];

export type Facing = 1 | -1;

export const CAT_REACTIONS = ['earFlick', 'tailFlick', 'headTilt'] as const;
export type CatReactionKind = (typeof CAT_REACTIONS)[number];
/** A short body-language reaction layered on the current clip; `at` is sim time (ms) when it started. */
export interface CatReaction {
  kind: CatReactionKind;
  at: number;
}

/**
 * Nominal footprint of the cat at size 1.0 in DIP. The brain uses it for
 * movement limits; the renderer reports the exact pose bounds via hitboxes.
 */
export const CAT_BASE_WIDTH_DIP = 84;
export const CAT_BASE_HEIGHT_DIP = 64;

/**
 * One render snapshot, main -> overlay renderer. Coordinates are overlay-local DIP
 * (CSS pixels of that overlay window). (x, y) is the cat's ground anchor: the point
 * between its feet on the surface it stands on.
 */
export interface CatRenderState {
  /** Monotonic sequence number. */
  seq: number;
  /** Simulation time in ms (monotonic). */
  t: number;
  x: number;
  y: number;
  /** When true the renderer must not interpolate from the previous position (teleport, display change). */
  snap: boolean;
  /** Size multiplier (settings.appearance.size). 1 => CAT_BASE_* DIP. */
  scale: number;
  facing: Facing;
  state: BehaviorState;
  clip: AnimClip;
  /** Simulation time (ms) at which `clip` started; renderer derives the clip phase from it. */
  clipStartedAt: number;
  /** Locomotion speed in body-lengths per second (drives gait rate). 0 when not moving. */
  speed: number;
  /** Vertical velocity in DIP/s (positive = downwards) while airborne, else 0. */
  vy: number;
  /** Point the cat is looking at, overlay-local DIP, or null to look straight ahead. */
  look: { x: number; y: number } | null;
  /** 0..1 excitement, modulates tail and ears. */
  arousal: number;
  /** 0..1 contentment, modulates eyes and tail. */
  contentment: number;
  emote: Emote | null;
  emoteStartedAt: number;
  /** 0..1 overall opacity (fade-in/out, user transparency). */
  opacity: number;
  visible: boolean;
  skin: SkinId;
  style: RenderStyle;
  shadow: boolean;
  /** Animation playback speed multiplier (settings.appearance.animationSpeed). */
  animSpeed: number;
  /** One-off reaction to play on top of the clip (once per distinct `at`). */
  reaction?: CatReaction | null;
}

/** Hit region reported by a renderer for its current pose, overlay-local DIP. */
export interface HitRegion {
  rects: Array<{ x: number; y: number; width: number; height: number }>;
}
