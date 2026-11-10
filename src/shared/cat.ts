// Shared vocabulary for the single cat: behaviour states, animation clips, emotes,
// skins and the render snapshot the main process sends to overlay renderers.
import type { Mood, RenderProp } from './companion';

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
  // v1.2 (ADR 0003 §8). Until the renderer package draws them, each one renders the pose of an
  // existing clip (renderer CLIP_BASE); the brain does not select them before then.
  'stalk', // low, slow creep toward prey: belly near the ground, shoulders working (gait, rate scales with speed)
  'sprint', // flat-out dash, longer extension than run (gait)
  'pounce', // airborne pounce: forelegs reaching forward and down, hind legs trailing (vy and jumpKind drive it)
  'slip', // a paw misses the edge: scramble with hind legs paddling, then recover (~0.9 s, one-shot)
  'impact', // hard landing: deep squash, legs splayed, head down (~0.45 s, one-shot; `impact` scales it)
  'landRecover', // after a hard landing: shake off, look around, sit up (~0.9 s, one-shot)
  'swat', // one quick defensive/playful paw strike toward `look` (~0.45 s, one-shot)
  'hiss', // defensive: arched back, puffed tail, ears flat, mouth open (~1.2 s, one-shot, silhouette-legible)
  'grumpy', // grumpy stare: low sit, ears sideways, narrowed eyes, slow tail thumps (loop)
  'slink', // retreat gait: low, ears back, tail low (gait)
  'stretch', // standing stretch: front stretch then back stretch (~1.6 s, one-shot)
  'balance', // narrow ledge or top corner: crouched stance, tail out as a counterweight, small sway (loop; `balance` scales it)
  'tailChase', // spinning after its own tail (loop)
  'edgeSit', // sitting at a ledge's edge looking down past its paws (`look` below the ledge) (loop)
  // Living Companion: the body-care and expression clips the catalogue found missing.
  'scratch', // sitting, hind leg scratching behind the ear (loop)
  'shake', // standing full-body shake-off, as after getting wet (~1.1 s, one-shot)
  'confused', // sitting, head tilting side to side, one ear up (loop)
] as const;
export type AnimClip = (typeof ANIM_CLIPS)[number];

/** Clips that play once and then hold their final pose until the brain changes clip. */
export const ONE_SHOT_CLIPS: ReadonlySet<AnimClip> = new Set<AnimClip>([
  'wake',
  'yawn',
  'land',
  'startle',
  'meow',
  'slip',
  'impact',
  'landRecover',
  'swat',
  'hiss',
  'stretch',
  'shake',
]);

/**
 * v1.2: what kind of flight the cat is in (render hint; ADR 0003 §6). 'hop' = a small on-surface
 * hop, 'up'/'across'/'down' = planned jumps by height change, 'pounce' = a hunting pounce, 'leap' =
 * a leap that catches a wall, 'wallJump' = a jump off a wall it clung to.
 */
export const JUMP_KINDS = ['hop', 'up', 'across', 'down', 'pounce', 'leap', 'wallJump'] as const;
export type JumpKind = (typeof JUMP_KINDS)[number];

/** v1.2: landing impact class from the vertical impact speed (ADR 0003 §6.4). */
export const LANDING_IMPACTS = ['soft', 'medium', 'hard'] as const;
export type LandingImpact = (typeof LANDING_IMPACTS)[number];

/** v1.2: optional procedural sounds (ADR 0003 §10). Off unless settings.sound.enabled. */
export const SOUND_CUES = ['meow', 'chirp', 'trill', 'purr', 'hiss', 'growl', 'thud', 'squeak', 'rumble', 'chime', 'splash'] as const;
export type SoundCue = (typeof SOUND_CUES)[number];
/**
 * Living Companion: the cues that belong to the world (world events), not to the cat. Their own
 * switch (settings.sound categories) so a user can keep the cat's voice and mute the world, or the
 * reverse. Everything stays off unless settings.sound.enabled.
 */
export const WORLD_SOUND_CUES: ReadonlySet<SoundCue> = new Set<SoundCue>(['squeak', 'rumble', 'chime', 'splash']);
/**
 * A one-off sound; the renderer plays it once per distinct `at` (sim time, ms) and never a cue
 * older than ~500 ms against the snapshot's `t` (a recreated overlay must not replay it).
 */
export interface CatSoundCue {
  kind: SoundCue;
  at: number;
  /** 0..1 playback volume (settings.sound.volume), set by main; absent = 0.4. */
  volume?: number;
}

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
 * v1.2 (ADR 0003 §6.7, review C2): fastest anchor speed (DIP/s at size 1) each locomotion clip
 * animates without its paws sliding. The renderer authors its gaits to meet at least these (its
 * tests cross-check clips.ts), and the Mover never drives a pace past 1.1x its clip's limit,
 * whatever movementSpeed says. walk/run/climb are the v1.1.1 values (diagnosis §4).
 */
export const GAIT_LIMIT_DIP = { walk: 106, run: 394, climb: 63, stalk: 40, slink: 90, sprint: 440 } as const satisfies Readonly<Record<string, number>>;
export type GaitClip = keyof typeof GAIT_LIMIT_DIP;

/**
 * v1.2 (ADR 0003 §4.2, §6.5, review C2): upper bound (DIP at size 1) on how far the hit region of
 * a pose reaches ahead of the anchor in the facing direction. Pounce landings and strikes are
 * placed from these, never from the anchor: the region stays at least HIT_CLEARANCE_DIP (plus the
 * click-through hysteresis) short of the cursor hotspot (T8). The renderer's tests assert the
 * rig never exceeds them, in both styles and facings.
 */
export const HIT_FRONT_EXTENT_DIP = { crouch: 40, pounce: 46, land: 42, pawAt: 50, swat: 54 } as const satisfies Readonly<Record<string, number>>;
export type StrikePose = keyof typeof HIT_FRONT_EXTENT_DIP;
/** Smallest gap (DIP) between a pounce/strike pose's hit region and the cursor hotspot. */
export const HIT_CLEARANCE_DIP = 8;

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
  /**
   * Movement speed multiplier (settings.behavior.movementSpeed); absent = 1. The sim's wall
   * manoeuvres (mount, swing down, pull-up, step-off) take 1/movementSpeed as long, and the
   * renderer times its fades onto and off the wall to match.
   */
  movementSpeed?: number;
  /** One-off reaction to play on top of the clip (once per distinct `at`). */
  reaction?: CatReaction | null;
  /** v1.2: kind of the current flight while airborne (jump/fall/pounce poses), else null/absent. */
  jumpKind?: JumpKind | null;
  /** v1.2: 0..1 hardness of the landing being played (land/impact/landRecover); absent = 0.5. */
  impact?: number;
  /** v1.2: 0..1 how hard the cat has to balance (narrow ledge, top corner); absent = 0. */
  balance?: number;
  /** v1.2: one-off sound, sent to exactly one overlay (the one holding the anchor); absent/null = none. */
  sound?: CatSoundCue | null;
  // ---- Living Companion (all optional; absent = none / the stated default) --------------------
  /** World-event props, overlay-local DIP; drawn behind the cat, never part of the hit region. At most MAX_PROPS. */
  props?: readonly RenderProp[];
  /** Temporary mood: tunes ears, tail, pupils and eyelids on top of the clip. */
  mood?: Mood;
  /** 0..1 sleep depth (deep sleep breathes slower and quieter); absent = 0. */
  sleepDepth?: number;
  /** The laser dot, overlay-local DIP, only on the overlay whose display holds the cursor; null/absent = no dot. */
  laser?: { x: number; y: number } | null;
  /** Reduced motion: softer pose swings, no particle-like effects, props at half speed. */
  reducedMotion?: boolean;
}

/** Hit region reported by a renderer for its current pose, overlay-local DIP. */
export interface HitRegion {
  rects: Array<{ x: number; y: number; width: number; height: number }>;
}
