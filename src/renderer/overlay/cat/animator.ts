// Turns the brain's clip choice into a living pose: clip sampling, cross-fades on
// clip changes, and procedural layers (breathing, blinks, ear twitches, glances,
// look-at, one-off reactions, mood on tail/ears/pupils, purr vibration, pendulum
// swing while held).
import type { AnimClip, CatReaction, CatReactionKind, JumpKind } from '../../../shared/cat';
import { CLIP_META } from '../../../shared/animationCatalog';
import { MOODS, type Mood } from '../../../shared/companion';
import { climbEngagement, crossFadeMs, gaitHz, isGait, isWallManoeuvre, sampleClip, wallTimeScale, type ClipContext } from './clips';
import { clamp, clamp01, damp, easeOut, lerp, noise1, pulse, smooth, sseg, TAU } from './math';
import { blendPose, copyPose, createPose, sanitizePose, type Pose } from './pose';
import { TORSO_T } from './rig';

export interface AnimInput {
  clip: AnimClip;
  /** Simulation time (ms) at which the clip started. */
  clipStartedAt: number;
  sleeping: boolean;
  speed: number;
  vy: number;
  /** Look target, cat-local (facing right, scale 1). */
  lookX: number;
  lookY: number;
  hasLook: boolean;
  arousal: number;
  contentment: number;
  animSpeed: number;
  /** One-off body-language reaction from the snapshot; plays once per distinct `at`. */
  reaction?: CatReaction | null;
  /**
   * settings.behavior.movementSpeed (absent = 1): the mover's wall manoeuvres take 1/movementSpeed
   * as long, and so do the fades onto and off the wall and the off-wall shadow delay.
   */
  movementSpeed?: number;
  /** v1.2 render hints (ADR 0003 §8): flight kind, landing hardness 0..1, balance 0..1; absent = defaults. */
  jumpKind?: JumpKind | null;
  impact?: number;
  balance?: number;
  /**
   * Living Companion (all optional; absent = exactly the rendering without them): the temporary
   * mood tuning ears, tail, pupils and lids on top of the clip, the 0..1 depth of the sleep (slower,
   * shallower breathing and a more settled posture) and the user's reduced-motion choice.
   */
  mood?: Mood;
  sleepDepth?: number;
  reducedMotion?: boolean;
}

/** Length (s at animation speed 1) of each reaction layer. */
export const REACTION_DURATION_S: Readonly<Record<CatReactionKind, number>> = {
  earFlick: 0.3,
  tailFlick: 0.4,
  headTilt: 0.6,
};
/** Head tilt amplitude: about 12 degrees. */
export const HEAD_TILT_RAD = (12 * Math.PI) / 180;
/** An ear flicked back no further than this (rotation + flatness, as draw.ts combines them). */
const EAR_BACK_LIMIT = 1.3;
const EAR_FLICK_ROT = 0.62;
const EAR_FLICK_FLAT = 0.2;

/** Clips whose tail motion is authored; mood only lightly modulates them. */
const TAIL_AUTHORED: ReadonlySet<AnimClip> = new Set<AnimClip>([
  'startle',
  'annoyed',
  'held',
  'jump',
  'fall',
  'run',
  'sleep',
  'wake',
  'rollOver',
  'land',
  'climb',
  // v1.2
  'stalk',
  'sprint',
  'slink',
  'pounce',
  'slip',
  'impact',
  'swat',
  'hiss',
  'grumpy',
  'stretch',
  'balance',
  'tailChase',
  // Living Companion
  'shake',
]);

/**
 * Mood layers (Living Companion): rate (1/s) at which each mood's weight rises and falls. Every
 * weight is eased, so a mood never pops in or out; a startle comes in quickly and leaves slowly,
 * the sleepy and relaxed looks drift.
 */
const MOOD_RATE: Readonly<Record<Mood, { readonly up: number; readonly down: number }>> = {
  happy: { up: 2.5, down: 1.5 },
  curious: { up: 3, down: 2 },
  sleepy: { up: 1.2, down: 1.2 },
  startled: { up: 8, down: 2.5 },
  scared: { up: 4, down: 1.5 },
  excited: { up: 3, down: 2 },
  relaxed: { up: 1.2, down: 1.2 },
  confused: { up: 3, down: 2 },
};
/** A mood weight below this counts as gone (the layer then costs nothing and leaves no residue). */
const MOOD_EPS = 1e-3;
/** The tail of an authored clip takes only this share of a mood's tail motion. */
const MOOD_TAIL_AUTHORED = 0.35;
/** Rate (1/s) at which the deep-sleep and reduced-motion switches ease in and out. */
const DEPTH_RATE = 1.2;
const REDUCE_RATE = 4;
/** Reduced motion: the tail's swing is low-passed at this rate (1/s) and blended this far towards the result. */
const REDUCED_TAIL_RATE = 1;
const REDUCED_TAIL_BLEND = 0.7;
/** Reduced motion: how much slower the procedural layers (tail sway, purr tremor) run, and how far the hop and the sideways shudder are damped. */
const REDUCED_LAYER_SLOWDOWN = 0.4;
const REDUCED_HOP_DAMP = 0.5;
const REDUCED_SHUDDER_DAMP = 0.6;
/** Reduced motion: a spin (turnX swinging 1 .. -1) shrinks to 1 .. 0.5, never edge-on and never a mirror flash. */
const REDUCED_SPIN_DAMP = 0.75;
/** Deep sleep (at full depth): breathing is this much slower and shallower, and the body this much more settled. */
const DEEP_BREATH_SLOWER = 0.5;
const DEEP_BREATH_SHALLOWER = 0.35;
/** A sleepy cat's blinks take this much longer (at full weight). */
const SLEEPY_BLINK_SLOWER = 1.1;

const MAX_LAYER_DT_S = 0.1;
/** Rate (1/s) at which the climb clip follows speed changes (start/stop on the wall without a pop). */
const CLIMB_SPEED_RATE = 9;
/**
 * Rate (1/s) at which the climbing motion develops after the cat starts climbing on the wall, and
 * settles into clinging after it stops (~0.45 s to 90 %).
 */
const CLIMB_ENGAGE_RATE = 5;
/** Anchor vertical speed (cat-local DIP/s) beyond which the climb gait runs downwards / upwards again. */
const CLIMB_DIR_DIP_S = 4;
/** Rate (1/s) at which the tail and head settle into the climbing-down (or up) carriage. */
const CLIMB_DESCEND_RATE = 4;
/**
 * After leaving the wall the anchor still travels for a while (pulling up onto the ledge, stepping
 * down to the floor): the ground shadow fades back in over this window (s after the clip changed, at
 * movement speed 1), so it does not appear under a cat that is still in the air beside the window.
 */
const OFF_WALL_SHADOW_S: readonly [number, number] = [0.15, 0.5];

export class CatAnimator {
  /** Final pose (clip + cross-fade + procedural layers). */
  readonly pose: Pose = createPose();
  /** Clip pose after cross-fade, before procedural layers. */
  readonly base: Pose = createPose();
  private readonly clipPose: Pose = createPose();
  private readonly fromPose: Pose = createPose();
  private readonly ctx: ClipContext = {
    t: 0,
    cycle: 0,
    speed: 0,
    vy: 0,
    lookX: 0,
    lookY: 0,
    hasLook: false,
    arousal: 0,
    contentment: 0,
  };

  private clip: AnimClip | null = null;
  private clipStart = Number.NaN;
  private fadeElapsed = 0;
  private fadeDur = 0;
  private cycle = 0;
  private time = 0;
  private sleepK = 0;
  private breathPhase = 0;

  /** Eased weight of each mood (indexed like MOODS), whether any is above MOOD_EPS, and the eased deep-sleep and reduced-motion switches. */
  private readonly moodW = new Float64Array(MOODS.length);
  private moodAny = false;
  private depthK = 0;
  private reduceK = 0;
  /** Reduced motion: the low-passed tail keys (valid while the switch is on). */
  private tailBaseLP = 0;
  private tailCurlLP = 0;
  private tailLPValid = false;

  private blinkTimer: number;
  private blinkAge = -1;
  private blinkDouble = false;

  private earTimer: number;
  private earAge = -1;
  private earWhich = 0;

  private glanceTimer: number;
  private glanceX = 0;
  private glanceY = 0;

  private lookHead = 0;
  private lookTurn = 0;
  private lookPX = 0.15;
  private lookPY = 0;

  private swing = 0;
  private swingVel = 0;

  /**
   * Climb: eased speed the gait plays at, eased engagement (0 clinging .. 1 climbing), the anchor's
   * smoothed vertical speed, the gait direction, and seconds since the clip left 'climb'.
   */
  private climbSpeed = 0;
  private climbEngage = 0;
  private climbVy = 0;
  private climbDir = 1;
  /** Eased 0 (up or clinging) .. 1 (climbing down). */
  private climbDescend = 0;
  /** Seconds since the clip left 'climb', in manoeuvre time (wall clock times offWallRate). */
  private offWallS = Number.POSITIVE_INFINITY;
  /** Movement speed of the manoeuvre off the wall (1 for the quick ways off it). */
  private offWallRate = 1;

  /** `at` of the newest reaction seen; each distinct one is considered once. */
  private reactionSeen = Number.NaN;
  /** Sim time (ms) each reaction kind last started, NaN when never. */
  private readonly reactionStart: Record<CatReactionKind, number> = { earFlick: Number.NaN, tailFlick: Number.NaN, headTilt: Number.NaN };
  /** Ear flick variant: 0 far ear, 1 near ear, 2 both. */
  private earFlickWhich = 2;
  private tiltSign = 1;
  private reactionActive = false;

  constructor(private readonly random: () => number) {
    this.blinkTimer = 1 + random() * 3;
    this.earTimer = 3 + random() * 5;
    this.glanceTimer = 2 + random() * 3;
  }

  get currentClip(): AnimClip | null {
    return this.clip;
  }

  /** True while a cross-fade is still blending. */
  get blending(): boolean {
    return this.fadeElapsed < this.fadeDur;
  }

  /** True while a reaction layer (ear flick, tail flick, head tilt) moved the last pose. */
  get reacting(): boolean {
    return this.reactionActive;
  }

  /**
   * True for a short while after the clip left 'climb': the anchor may still be travelling beside
   * the window (pulling up onto the ledge, stepping down to the floor), so it is not on a surface yet.
   */
  get leavingWall(): boolean {
    return this.offWallS < OFF_WALL_SHADOW_S[1];
  }

  /**
   * @param motionX horizontal body motion since the last frame (cat-local DIP), drives the held swing.
   * @param motionY vertical body motion since the last frame (cat-local DIP, + = down): a cat moving
   *   down a wall climbs down tail first, so the climb gait runs backwards and its paws keep their grip.
   */
  update(input: AnimInput, simTimeMs: number, dtMs: number, motionX: number, motionY = 0): Pose {
    const dt = clamp(Number.isFinite(dtMs) ? dtMs / 1000 : 0, 0, MAX_LAYER_DT_S);
    const animSpeed = clamp(Number.isFinite(input.animSpeed) ? input.animSpeed : 1, 0.1, 3);
    this.stepSwitches(input, dt);
    this.time += dt * animSpeed * (1 - REDUCED_LAYER_SLOWDOWN * this.reduceK);
    const speed = Number.isFinite(input.speed) ? Math.max(0, input.speed) : 0;

    if (input.clip !== this.clip || input.clipStartedAt !== this.clipStart) {
      const first = this.clip === null;
      if (!first) copyPose(this.fromPose, this.base);
      if (!isGait(input.clip) || (this.clip !== null && !isGait(this.clip))) this.cycle = 0;
      if (input.clip === 'climb' && this.clip !== 'climb') {
        // The cross-fade carries the pose onto the wall, clinging; the climbing motion then develops.
        this.climbSpeed = speed;
        this.climbEngage = 0;
        this.climbVy = 0;
        this.climbDir = 1;
        this.climbDescend = 0;
      }
      if (this.clip === 'climb' && input.clip !== 'climb') {
        this.offWallS = 0;
        this.offWallRate = isWallManoeuvre(this.clip, input.clip) ? wallTimeScale(input.movementSpeed) : 1;
      }
      this.fadeDur = first ? 0 : crossFadeMs(this.clip, input.clip, input.movementSpeed) / 1000;
      this.fadeElapsed = 0;
      this.clip = input.clip;
      this.clipStart = input.clipStartedAt;
    }

    const c = this.ctx;
    c.t = (Math.max(0, simTimeMs - this.clipStart) * animSpeed) / 1000;
    if (!Number.isFinite(c.t)) c.t = 0;
    let gaitSpeed = speed;
    let dir = 1;
    c.engage = undefined;
    c.descend = undefined;
    if (input.clip === 'climb') {
      this.climbSpeed = damp(this.climbSpeed, speed, CLIMB_SPEED_RATE, dt);
      this.climbEngage = damp(this.climbEngage, climbEngagement(speed), CLIMB_ENGAGE_RATE, dt);
      if (dt > 0 && Number.isFinite(motionY)) this.climbVy = damp(this.climbVy, clamp(motionY / dt, -3000, 3000), 8, dt);
      if (this.climbVy > CLIMB_DIR_DIP_S) this.climbDir = -1;
      else if (this.climbVy < -CLIMB_DIR_DIP_S) this.climbDir = 1;
      gaitSpeed = this.climbSpeed;
      dir = this.climbDir;
      // Holding still keeps whichever way the tail was held; it changes while climbing.
      const descending = this.climbDir < 0 ? 1 : 0;
      this.climbDescend = damp(this.climbDescend, lerp(this.climbDescend, descending, this.climbEngage), CLIMB_DESCEND_RATE, dt);
      c.engage = this.climbEngage;
      c.descend = this.climbDescend;
      this.offWallS = Number.POSITIVE_INFINITY;
    } else if (this.offWallS < OFF_WALL_SHADOW_S[1]) {
      this.offWallS += dt * this.offWallRate;
    }
    if (isGait(input.clip)) this.cycle += dir * gaitHz(input.clip, gaitSpeed) * dt * animSpeed;
    // Gait clips only use the cycle's fractional part; keep it finite and small (a backwards climb counts down).
    if (!Number.isFinite(this.cycle)) this.cycle = 0;
    else if (Math.abs(this.cycle) > 1e6) this.cycle -= Math.trunc(this.cycle);
    c.cycle = this.cycle;
    c.speed = gaitSpeed;
    c.vy = Number.isFinite(input.vy) ? input.vy : 0;
    c.hasLook = input.hasLook && Number.isFinite(input.lookX) && Number.isFinite(input.lookY);
    c.lookX = c.hasLook ? input.lookX : 0;
    c.lookY = c.hasLook ? input.lookY : 0;
    c.arousal = clamp01(Number.isFinite(input.arousal) ? input.arousal : 0);
    c.contentment = clamp01(Number.isFinite(input.contentment) ? input.contentment : 0);
    c.jumpKind = input.jumpKind ?? null;
    c.impact = input.impact;
    c.balance = input.balance;
    c.reducedMotion = input.reducedMotion === true;

    sampleClip(input.clip, c, this.clipPose);
    sanitizePose(this.clipPose);
    if (this.fadeElapsed < this.fadeDur) {
      this.fadeElapsed += dt;
      blendPose(this.base, this.fromPose, this.clipPose, smooth(this.fadeElapsed / this.fadeDur));
    } else {
      copyPose(this.base, this.clipPose);
    }

    const p = copyPose(this.pose, this.base);
    this.applyBreathing(p, input.sleeping, dt);
    this.applySleepDepth(p);
    this.applyLook(p, c, dt);
    this.applyBlink(p, dt);
    this.applyEarTwitch(p, input.sleeping, c.arousal, dt);
    this.noteReaction(input.reaction, simTimeMs, animSpeed);
    this.applyReactions(p, simTimeMs, animSpeed);
    this.applyMood(p, input.clip, c.arousal, c.contentment);
    this.applyMoodLayers(p, input.clip);
    this.applyReducedMotion(p, dt);
    this.applyPurr(p);
    this.applySwing(p, input.clip, motionX, dt);
    if (this.offWallS < OFF_WALL_SHADOW_S[1]) p.shadow *= sseg(this.offWallS, OFF_WALL_SHADOW_S[0], OFF_WALL_SHADOW_S[1]);
    sanitizePose(p);
    return p;
  }

  /** Eases the mood weights, the deep-sleep depth and the reduced-motion switch towards this frame's input. */
  private stepSwitches(input: AnimInput, dt: number): void {
    const mood = typeof input.mood === 'string' ? (MOODS as readonly string[]).indexOf(input.mood) : -1;
    let any = false;
    for (let i = 0; i < MOODS.length; i++) {
      const rate = MOOD_RATE[MOODS[i] as Mood];
      const target = i === mood ? 1 : 0;
      const w = damp(this.moodW[i]!, target, target > this.moodW[i]! ? rate.up : rate.down, dt);
      this.moodW[i] = w < MOOD_EPS ? 0 : w;
      if (w >= MOOD_EPS) any = true;
    }
    this.moodAny = any;
    const depth = input.sleeping && Number.isFinite(input.sleepDepth) ? clamp01(input.sleepDepth as number) : 0;
    this.depthK = damp(this.depthK, depth, DEPTH_RATE, dt);
    if (this.depthK < MOOD_EPS) this.depthK = 0;
    this.reduceK = damp(this.reduceK, input.reducedMotion === true ? 1 : 0, REDUCE_RATE, dt);
    if (this.reduceK < MOOD_EPS) this.reduceK = 0;
  }

  /** Weight (0..1, eased) of a mood. */
  private mood(m: Mood): number {
    return this.moodW[(MOODS as readonly string[]).indexOf(m)] ?? 0;
  }

  /** How deep the sleep is right now: the eased depth, only as far as the cat has settled into sleeping. */
  private get deep(): number {
    return this.depthK * this.sleepK;
  }

  private applyBreathing(p: Pose, sleeping: boolean, dt: number): void {
    this.sleepK = damp(this.sleepK, sleeping ? 1 : 0, 2, dt);
    const deep = this.deep;
    const period = lerp(2.5, 3.8, this.sleepK) * (1 + DEEP_BREATH_SLOWER * deep);
    this.breathPhase = (this.breathPhase + (dt * TAU) / period) % TAU;
    const amp = lerp(0.022, 0.06, this.sleepK) * (1 - DEEP_BREATH_SHALLOWER * deep) * clamp(p.breath, 0, 2);
    const b = amp * Math.sin(this.breathPhase);
    p.bodyY -= b * TORSO_T * p.bodyH;
    p.bodyH *= 1 + b;
    p.headY -= b * lerp(3, 9, this.sleepK);
  }

  private applyLook(p: Pose, c: ClipContext, dt: number): void {
    const w = clamp01(p.lookW);
    let head = 0;
    let turn = 0;
    let px = p.pupilX;
    let py = p.pupilY;
    if (c.hasLook && w > 0) {
      const dx = c.lookX - p.headX;
      const dy = c.lookY - p.headY;
      const dist = Math.hypot(dx, dy);
      if (dist > 6) {
        if (dx > -8) {
          head = clamp(Math.atan2(-dy, Math.max(dx, 4)) * 0.55, -0.4, 0.45);
          px = clamp(dx / 38, -0.3, 1);
        } else {
          turn = -1.6;
          head = clamp(Math.atan2(-dy, -dx) * 0.4, -0.3, 0.35);
          px = clamp(dx / 38, -1, 0.2);
        }
        py = clamp(dy / 34, -1, 1);
      }
    } else {
      this.glanceTimer -= dt;
      if (this.glanceTimer <= 0) {
        this.glanceTimer = 1.8 + this.random() * 3.5;
        const r = this.random();
        this.glanceX = r < 0.45 ? 0 : -0.45 + this.random() * 1.0;
        this.glanceY = r < 0.45 ? 0 : -0.35 + this.random() * 0.6;
      }
      px = p.pupilX + this.glanceX * w;
      py = p.pupilY + this.glanceY * w;
    }
    this.lookHead = damp(this.lookHead, head, 7, dt);
    this.lookTurn = damp(this.lookTurn, turn, 6, dt);
    this.lookPX = damp(this.lookPX, px, 16, dt);
    this.lookPY = damp(this.lookPY, py, 16, dt);
    p.headRot += this.lookHead * w;
    p.faceTurn += this.lookTurn * w;
    p.pupilX = lerp(p.pupilX, this.lookPX, Math.max(w, 0.35));
    p.pupilY = lerp(p.pupilY, this.lookPY, Math.max(w, 0.35));
  }

  private applyBlink(p: Pose, dt: number): void {
    const allowed = p.blinkOK > 0.5 && p.eyeOpen > 0.3;
    if (this.blinkAge < 0) {
      this.blinkTimer -= dt;
      if (this.blinkTimer <= 0) {
        if (allowed) {
          this.blinkAge = 0;
          this.blinkDouble = this.random() < 0.18;
          this.blinkTimer = 2 + this.random() * 4;
        } else {
          this.blinkTimer = 0.4 + this.random() * 0.6;
        }
      }
      return;
    }
    // A sleepy cat's blink is slow: the lids take longer to close and to open again.
    this.blinkAge += dt / (1 + SLEEPY_BLINK_SLOWER * this.mood('sleepy'));
    const end = this.blinkDouble ? 0.44 : 0.2;
    if (this.blinkAge >= end || !allowed) {
      this.blinkAge = -1;
      return;
    }
    const a = this.blinkAge >= 0.24 ? this.blinkAge - 0.24 : this.blinkAge;
    const closure = a < 0.07 ? a / 0.07 : a < 0.1 ? 1 : 1 - (a - 0.1) / 0.1;
    p.eyeOpen *= 1 - clamp01(closure);
  }

  private applyEarTwitch(p: Pose, sleeping: boolean, arousal: number, dt: number): void {
    if (this.earAge < 0) {
      this.earTimer -= dt;
      if (this.earTimer <= 0) {
        this.earAge = 0;
        this.earWhich = this.random() < 0.5 ? 0 : 1;
        // A deep sleeper hardly stirs: twice the pause at full depth.
        const base = (sleeping ? 7 : 3.5) * (1 + this.deep);
        this.earTimer = base * (1 - 0.5 * arousal) + this.random() * base * 1.6;
      }
      return;
    }
    this.earAge += dt;
    const dur = 0.17;
    if (this.earAge >= dur) {
      this.earAge = -1;
      return;
    }
    const k = Math.sin((Math.PI * this.earAge) / dur);
    if (this.earWhich === 0) {
      p.earBR += 0.42 * k;
      p.earBF += 0.12 * k;
    } else {
      p.earFR += 0.42 * k;
      p.earFF += 0.12 * k;
    }
  }

  /**
   * Starts a reaction the first time its `at` is seen. A kind that is still playing is not
   * restarted (that would pop), and one that started long ago (the cat just entered this
   * overlay) has already ended, so it stays invisible. The variant derives from `at`, so
   * every overlay drawing the cat across a monitor seam shows the same flick.
   */
  private noteReaction(r: CatReaction | null | undefined, simTimeMs: number, animSpeed: number): void {
    if (!r || !Number.isFinite(r.at) || r.at === this.reactionSeen) return;
    const dur = REACTION_DURATION_S[r.kind];
    if (dur === undefined) return;
    this.reactionSeen = r.at;
    if (this.reactionAge(r.kind, simTimeMs, animSpeed) < dur) return;
    this.reactionStart[r.kind] = r.at;
    const h = noise1(Math.floor(r.at), 71);
    if (r.kind === 'earFlick') this.earFlickWhich = h < -0.3 ? 0 : h < 0.3 ? 1 : 2;
    else if (r.kind === 'headTilt') this.tiltSign = h < 0 ? -1 : 1;
  }

  /** Seconds (animation time) since a reaction kind started; NaN when it never did. */
  private reactionAge(kind: CatReactionKind, simTimeMs: number, animSpeed: number): number {
    return ((simTimeMs - this.reactionStart[kind]) * animSpeed) / 1000;
  }

  /** Progress 0..1 of a playing reaction, or -1 when it is not playing. */
  private reactionPhase(kind: CatReactionKind, simTimeMs: number, animSpeed: number): number {
    const s = this.reactionAge(kind, simTimeMs, animSpeed) / REACTION_DURATION_S[kind];
    return s >= 0 && s < 1 ? s : -1;
  }

  /** Reaction layers on top of any clip; each is time-based and ends where it started. */
  private applyReactions(p: Pose, simTimeMs: number, animSpeed: number): void {
    let active = false;
    const ear = this.reactionPhase('earFlick', simTimeMs, animSpeed);
    if (ear >= 0) {
      active = true;
      // Snaps back in the first quarter, eases forward again over the rest.
      const e = ear < 0.25 ? easeOut(ear / 0.25) : 1 - smooth((ear - 0.25) / 0.75);
      if (this.earFlickWhich !== 1) flickEar(p, 'earBR', 'earBF', e);
      if (this.earFlickWhich !== 0) flickEar(p, 'earFR', 'earFF', e);
    }
    const tail = this.reactionPhase('tailFlick', simTimeMs, animSpeed);
    if (tail >= 0) {
      active = true;
      // A whip up and over with a smaller counter-swing, on a briefly stiffened tail. Mirrored
      // with the roll, so a cat lying belly-up flicks it away from the ground, not into it.
      const w = Math.sin(TAU * tail) * (1 - tail) * clamp(p.rollY, -1, 1);
      p.tailCurl += 1.5 * w;
      p.tailBase += 0.3 * w;
      p.tailStiff = lerp(p.tailStiff, 0.95, Math.sin(Math.PI * tail));
    }
    const tilt = this.reactionPhase('headTilt', simTimeMs, animSpeed);
    if (tilt >= 0) {
      active = true;
      p.headRot += this.tiltSign * HEAD_TILT_RAD * pulse(tilt, 0, 0.3, 0.6, 1);
    }
    this.reactionActive = active;
  }

  private applyMood(p: Pose, clip: AnimClip, arousal: number, content: number): void {
    const w = TAIL_AUTHORED.has(clip) ? 0.25 : 1;
    const t = this.time;
    p.tailBase += w * ((content - 0.5) * 0.3 + 0.08 * Math.sin(TAU * 0.37 * t));
    p.tailCurl += w * (content * 0.3 + 0.14 * Math.sin(TAU * 0.45 * t + 0.7) + arousal * 0.3 * Math.sin(TAU * 2.4 * t));
    p.earFR -= 0.1 * arousal * w;
    p.earBR -= 0.08 * arousal * w;
    p.pupilSize = clamp01(p.pupilSize + 0.3 * arousal);
  }

  /**
   * Deep sleep: the body settles. Lower and rounder, the head resting nearer the ground, the ears
   * drooping a touch. The belly stays on the ground (the lower torso edge is kept where it was).
   */
  private applySleepDepth(p: Pose): void {
    const d = this.deep;
    if (d <= 0) return;
    p.bodyH *= 1 - 0.04 * d;
    p.bodyLen *= 1 - 0.03 * d;
    p.bodyY += 0.4 * d;
    p.curl = Math.min(1, p.curl + 0.05 * d);
    p.headY += 1.5 * d;
    p.headRot -= 0.05 * d;
    p.earBR += 0.05 * d;
    p.earFR += 0.05 * d;
  }

  /**
   * The mood layers: small additive tweaks on top of the clip, each scaled by its eased weight (so
   * none pops) and the tail ones by how authored the clip's tail is. No mood = nothing touched.
   * Ears are clamped afterwards to the ranges draw.ts expects.
   */
  private applyMoodLayers(p: Pose, clip: AnimClip): void {
    if (!this.moodAny) return;
    const t = this.time;
    const tw = TAIL_AUTHORED.has(clip) ? MOOD_TAIL_AUTHORED : 1;
    // Crouch and head-drop biases only make sense for a cat on its feet or sitting.
    const posture = CLIP_META[clip]?.posture;
    const grounded = posture === 'stand' || posture === 'sit' ? 1 : 0;

    const happy = this.mood('happy');
    if (happy > 0) {
      // Tail up, soft eyes.
      p.tailBase += 0.22 * tw * happy;
      p.tailCurl += 0.12 * tw * happy;
      p.eyeSquint += 0.12 * happy;
      p.eyeOpen *= 1 - 0.08 * happy;
      p.blush = Math.min(1, p.blush + 0.2 * happy);
    }
    const curious = this.mood('curious');
    if (curious > 0) {
      // Ears forward, the head tipped a little, alternately to either side.
      p.earFR -= 0.12 * curious;
      p.earBR -= 0.1 * curious;
      p.headRot += 0.06 * curious * Math.sin(TAU * 0.13 * t);
      p.pupilSize = clamp01(p.pupilSize + 0.08 * curious);
    }
    const sleepy = this.mood('sleepy');
    if (sleepy > 0) {
      // Heavy lids, drooping ears and head, a slow tail.
      p.eyeOpen *= 1 - 0.4 * sleepy;
      p.eyeSquint += 0.1 * sleepy;
      p.earBR += 0.06 * sleepy;
      p.earFR += 0.06 * sleepy;
      p.headY += 1.2 * sleepy * grounded;
      p.headRot -= 0.04 * sleepy;
      p.tailCurl -= 0.1 * tw * sleepy;
    }
    const startled = this.mood('startled');
    if (startled > 0) {
      // Ears flat for a moment, pupils wide.
      p.earBF += 0.45 * startled;
      p.earFF += 0.45 * startled;
      p.earBR += 0.15 * startled;
      p.earFR += 0.15 * startled;
      p.pupilSize = clamp01(p.pupilSize + 0.28 * startled);
    }
    const scared = this.mood('scared');
    if (scared > 0) {
      // Ears back, tail low and puffed, a crouch bias, wide pupils.
      p.earBR += 0.35 * scared;
      p.earFR += 0.3 * scared;
      p.earBF += 0.3 * scared;
      p.earFF += 0.3 * scared;
      p.tailBase -= 0.5 * tw * scared;
      p.tailCurl -= 0.3 * tw * scared;
      p.tailPuff = clamp01(p.tailPuff + 0.35 * scared);
      p.bodyY += 1.5 * scared * grounded;
      p.headY += 3 * scared * grounded;
      p.headX -= 1 * scared * grounded;
      p.pupilSize = clamp01(p.pupilSize + 0.25 * scared);
    }
    const excited = this.mood('excited');
    if (excited > 0) {
      // Wide pupils and a faster, higher tail.
      p.pupilSize = clamp01(p.pupilSize + 0.25 * excited);
      p.tailBase += 0.15 * tw * excited;
      p.tailCurl += 0.35 * tw * excited * Math.sin(TAU * 3.4 * t);
      p.earFR -= 0.08 * excited;
    }
    const relaxed = this.mood('relaxed');
    if (relaxed > 0) {
      // Half-closed eyes, a slow tail.
      p.eyeOpen *= 1 - 0.42 * relaxed;
      p.eyeSquint += 0.08 * relaxed;
      p.blush = Math.min(1, p.blush + 0.15 * relaxed);
      p.earBR += 0.05 * relaxed;
      p.tailCurl += 0.1 * tw * relaxed * Math.sin(TAU * 0.2 * t);
    }
    const confused = this.mood('confused');
    if (confused > 0) {
      // One ear up, the other out, the head tilting slowly, the pupils wandering.
      p.earFR -= 0.25 * confused;
      p.earBR += 0.12 * confused;
      p.headRot += 0.08 * confused * Math.sin(TAU * 0.35 * t);
      p.pupilX += 0.1 * confused * Math.sin(TAU * 0.35 * t + 1);
    }

    p.earBR = clamp(p.earBR, -0.6, EAR_BACK_LIMIT);
    p.earFR = clamp(p.earFR, -0.6, EAR_BACK_LIMIT);
    p.earBF = clamp01(p.earBF);
    p.earFF = clamp01(p.earFF);
    p.eyeSquint = clamp01(p.eyeSquint);
    p.eyeOpen = clamp01(p.eyeOpen);
  }

  /**
   * Reduced motion: the tail's swing is damped (its keys blend towards their own low-passed value, so
   * the carriage stays and the lashing goes), the hop and the sideways shudder shrink, and a spinning
   * cat never turns edge-on. Eased in and out, so toggling it never pops.
   */
  private applyReducedMotion(p: Pose, dt: number): void {
    const k = this.reduceK;
    if (k <= 0) {
      this.tailLPValid = false;
      return;
    }
    if (!this.tailLPValid) {
      this.tailBaseLP = p.tailBase;
      this.tailCurlLP = p.tailCurl;
      this.tailLPValid = true;
    } else {
      this.tailBaseLP = damp(this.tailBaseLP, p.tailBase, REDUCED_TAIL_RATE, dt);
      this.tailCurlLP = damp(this.tailCurlLP, p.tailCurl, REDUCED_TAIL_RATE, dt);
    }
    const blend = REDUCED_TAIL_BLEND * k;
    p.tailBase = lerp(p.tailBase, this.tailBaseLP, blend);
    p.tailCurl = lerp(p.tailCurl, this.tailCurlLP, blend);
    p.offX *= 1 - REDUCED_SHUDDER_DAMP * k;
    if (p.offY < 0) p.offY *= 1 - REDUCED_HOP_DAMP * k;
    p.turnX = lerp(p.turnX, 1, REDUCED_SPIN_DAMP * k);
  }

  private applyPurr(p: Pose): void {
    const k = clamp01(p.purr);
    if (k <= 0) return;
    const t = this.time;
    p.offX += k * 0.24 * noise1(t * 36, 11);
    p.offY += k * 0.18 * noise1(t * 41, 23);
    p.headRot += k * 0.006 * noise1(t * 33, 37);
  }

  private applySwing(p: Pose, clip: AnimClip, motionX: number, dt: number): void {
    if (dt <= 0) return;
    const vx = Number.isFinite(motionX) ? clamp(motionX / dt, -3000, 3000) : 0;
    if (clip === 'held') {
      // Pendulum about the scruff driven by drag velocity; idle sway when still.
      const target = clamp(-vx * 0.0012, -0.6, 0.6) + 0.05 * Math.sin(TAU * 0.6 * this.time);
      const acc = -38 * (this.swing - target) - 4.5 * this.swingVel;
      this.swingVel += acc * dt;
      this.swing += this.swingVel * dt;
      this.swing = clamp(this.swing, -0.8, 0.8);
    } else {
      this.swing = damp(this.swing, 0, 10, dt);
      this.swingVel = 0;
    }
    if (Math.abs(this.swing) > 1e-4) p.rot += this.swing;
  }
}

/** Flicks one ear back by `e` of the full amount, less when it is already laid back. */
function flickEar(p: Pose, rot: 'earBR' | 'earFR', flat: 'earBF' | 'earFF', e: number): void {
  const room = clamp01((EAR_BACK_LIMIT - p[rot] - 0.95 * clamp01(p[flat])) / (EAR_FLICK_ROT + 0.95 * EAR_FLICK_FLAT));
  p[rot] += EAR_FLICK_ROT * e * room;
  p[flat] += EAR_FLICK_FLAT * e * room;
}
