// Turns the brain's clip choice into a living pose: clip sampling, cross-fades on
// clip changes, and procedural layers (breathing, blinks, ear twitches, glances,
// look-at, one-off reactions, mood on tail/ears/pupils, purr vibration, pendulum
// swing while held).
import type { AnimClip, CatReaction, CatReactionKind } from '../../../shared/cat';
import { crossFadeMs, gaitHz, isGait, sampleClip, type ClipContext } from './clips';
import { clamp, clamp01, damp, easeOut, lerp, noise1, pulse, smooth, TAU } from './math';
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
]);

const MAX_LAYER_DT_S = 0.1;
/** Rate (1/s) at which the climb clip follows speed changes (start/stop on the wall without a pop). */
const CLIMB_SPEED_RATE = 9;
/** Anchor vertical speed (cat-local DIP/s) beyond which the climb gait runs downwards / upwards again. */
const CLIMB_DIR_DIP_S = 4;

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

  /** Eased speed the climb clip plays at, the anchor's smoothed vertical speed and the gait direction. */
  private climbSpeed = 0;
  private climbVy = 0;
  private climbDir = 1;

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
   * @param motionX horizontal body motion since the last frame (cat-local DIP), drives the held swing.
   * @param motionY vertical body motion since the last frame (cat-local DIP, + = down): a cat moving
   *   down a wall climbs down tail first, so the climb gait runs backwards and its paws keep their grip.
   */
  update(input: AnimInput, simTimeMs: number, dtMs: number, motionX: number, motionY = 0): Pose {
    const dt = clamp(Number.isFinite(dtMs) ? dtMs / 1000 : 0, 0, MAX_LAYER_DT_S);
    const animSpeed = clamp(Number.isFinite(input.animSpeed) ? input.animSpeed : 1, 0.1, 3);
    this.time += dt * animSpeed;
    const speed = Number.isFinite(input.speed) ? Math.max(0, input.speed) : 0;

    if (input.clip !== this.clip || input.clipStartedAt !== this.clipStart) {
      const first = this.clip === null;
      if (!first) copyPose(this.fromPose, this.base);
      if (!isGait(input.clip) || (this.clip !== null && !isGait(this.clip))) this.cycle = 0;
      if (input.clip === 'climb' && this.clip !== 'climb') {
        this.climbSpeed = speed;
        this.climbVy = 0;
        this.climbDir = 1;
      }
      this.fadeDur = first ? 0 : crossFadeMs(this.clip, input.clip) / 1000;
      this.fadeElapsed = 0;
      this.clip = input.clip;
      this.clipStart = input.clipStartedAt;
    }

    const c = this.ctx;
    c.t = (Math.max(0, simTimeMs - this.clipStart) * animSpeed) / 1000;
    if (!Number.isFinite(c.t)) c.t = 0;
    let gaitSpeed = speed;
    let dir = 1;
    if (input.clip === 'climb') {
      this.climbSpeed = damp(this.climbSpeed, speed, CLIMB_SPEED_RATE, dt);
      if (dt > 0 && Number.isFinite(motionY)) this.climbVy = damp(this.climbVy, clamp(motionY / dt, -3000, 3000), 8, dt);
      if (this.climbVy > CLIMB_DIR_DIP_S) this.climbDir = -1;
      else if (this.climbVy < -CLIMB_DIR_DIP_S) this.climbDir = 1;
      gaitSpeed = this.climbSpeed;
      dir = this.climbDir;
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
    this.applyLook(p, c, dt);
    this.applyBlink(p, dt);
    this.applyEarTwitch(p, input.sleeping, c.arousal, dt);
    this.noteReaction(input.reaction, simTimeMs, animSpeed);
    this.applyReactions(p, simTimeMs, animSpeed);
    this.applyMood(p, input.clip, c.arousal, c.contentment);
    this.applyPurr(p);
    this.applySwing(p, input.clip, motionX, dt);
    sanitizePose(p);
    return p;
  }

  private applyBreathing(p: Pose, sleeping: boolean, dt: number): void {
    this.sleepK = damp(this.sleepK, sleeping ? 1 : 0, 2, dt);
    const period = lerp(2.5, 3.8, this.sleepK);
    this.breathPhase = (this.breathPhase + (dt * TAU) / period) % TAU;
    const amp = lerp(0.022, 0.06, this.sleepK) * clamp(p.breath, 0, 2);
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
    this.blinkAge += dt;
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
        const base = sleeping ? 7 : 3.5;
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
