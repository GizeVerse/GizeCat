// Animation clips: pure functions (clip, phase, context) -> Pose. Procedural layers
// (breathing, blinking, look-at, tail physics, mood) are added by the animator.
import { CAT_BASE_WIDTH_DIP, ONE_SHOT_CLIPS, type AnimClip, type GaitClip, type JumpKind } from '../../../shared/cat';
import { HELD_SCRUFF_DIP } from '../../../core/interaction/held';
import { clamp, clamp01, easeInOut, lerp, noise1, pulse, seg, sseg, TAU, wrap01 } from './math';
import { blendPose, copyPose, createPose, LEG_BF, LEG_BN, LEG_FF, LEG_FN, resetPose, setFoot, type Pose } from './pose';
import { torsoPointX, torsoPointY } from './rig';

export interface ClipContext {
  /** Seconds since the clip started, already scaled by animation speed. */
  t: number;
  /** Integrated gait cycles (walk/run), continuous across speed changes. */
  cycle: number;
  /** Body-lengths per second. */
  speed: number;
  /** DIP/s, + = downwards. */
  vy: number;
  /** Look target in cat-local coordinates (facing right, scale 1). */
  lookX: number;
  lookY: number;
  hasLook: boolean;
  arousal: number;
  contentment: number;
  /**
   * Climb only: 0 clinging still .. 1 climbing, eased by the animator so starting and stopping on
   * the wall blend in; when absent the clip derives it from `speed`.
   */
  engage?: number;
  /** Climb only: 0 climbing up (or clinging) .. 1 climbing down, eased by the animator; absent = 0. */
  descend?: number;
  /**
   * v1.2 render hints (ADR 0003 §8): the kind of flight (jump/fall poses; absent or null plays the
   * v1.1 poses), the landing's hardness 0..1 (land/impact/landRecover; absent = 0.5) and how hard
   * the cat balances 0..1 (balance, clinging; absent = 0).
   */
  jumpKind?: JumpKind | null;
  impact?: number;
  balance?: number;
}

/** Hint values as the clips read them (absent or broken -> the contract's defaults). */
const impactOf = (c: ClipContext): number => (c.impact !== undefined && Number.isFinite(c.impact) ? clamp01(c.impact) : 0.5);
const balanceOf = (c: ClipContext): number => (c.balance !== undefined && Number.isFinite(c.balance) ? clamp01(c.balance) : 0);

/** Durations (s) of clips that play once and hold their final pose. */
export const ONE_SHOT_DURATION_S: Readonly<Partial<Record<AnimClip, number>>> = {
  wake: 1.6,
  yawn: 1.2,
  land: 0.25,
  startle: 0.8,
  meow: 0.9,
  // v1.2 (ADR 0003 §8)
  slip: 0.9,
  impact: 0.45,
  landRecover: 0.9,
  swat: 0.45,
  hiss: 1.2,
  stretch: 1.6,
};

/**
 * v1.2 contract step: the pose each new clip borrowed until the renderer package authored it (ADR
 * 0003 §8). A clip listed here samples, paces its gait and loops exactly like its base clip. All
 * 14 v1.2 clips are drawn now, so it is empty; it stays as the mechanism for a future placeholder.
 */
export const CLIP_BASE: Readonly<Partial<Record<AnimClip, AnimClip>>> = {};

/** The clip whose motion `clip` uses (itself once authored). */
export const baseClip = (clip: AnimClip): AnimClip => CLIP_BASE[clip] ?? clip;

export function clipDurationS(clip: AnimClip): number | null {
  return ONE_SHOT_CLIPS.has(clip) ? (ONE_SHOT_DURATION_S[clip] ?? null) : null;
}

/**
 * Cat-local point the cat hangs from in the `held` clip (back of the neck), DIP at
 * scale 1, facing right. The mover keeps the grabbing cursor at
 * anchor + (HELD_SCRUFF.x * facing, HELD_SCRUFF.y) * scale (src/core/interaction/held.ts).
 */
export const HELD_SCRUFF = HELD_SCRUFF_DIP;

const BODY_LENGTH_DIP = CAT_BASE_WIDTH_DIP;
const WALK_DUTY = 0.64;
const WALK_MAX_STRIDE = 20;
const RUN_DUTY = 0.38;
const RUN_MAX_STRIDE = 34;
/**
 * Climb: share of a cycle each paw grips the wall, the step the cadence aims for and the longest
 * step (DIP, vertical). Paws keep their grip exactly up to CLIMB_MAX_GRIP_SPEED; a faster climb
 * scrambles (the paws slip a little, like a walk past its longest stride).
 */
const CLIMB_DUTY = 0.62;
const CLIMB_STEP = 10;
const CLIMB_MAX_STRIDE = 15;
const CLIMB_MAX_HZ = 2.6;
/** Fastest climb (body-lengths/s) at which every gripping paw stays exactly put on the wall. */
export const CLIMB_MAX_GRIP_SPEED = (CLIMB_MAX_HZ * CLIMB_MAX_STRIDE) / CLIMB_DUTY / CAT_BASE_WIDTH_DIP;
/** Climbing speed (body-lengths/s) at which the climbing motion is fully developed; slower fades into clinging. */
export const CLIMB_FULL_SPEED = 0.14;
/** Period (s) of the clinging-still idle of the climb clip: a glance down at the viewer, a re-grip, a look up. */
export const CLIMB_IDLE_PERIOD_S = 7.2;

/** How far the climbing motion is developed at a climbing speed: 0 clinging still .. 1 climbing. */
export function climbEngagement(speed: number): number {
  return Number.isFinite(speed) ? sseg(speed, 0, CLIMB_FULL_SPEED) : 0;
}

/**
 * v1.2 gaits (ADR 0003 §6.7): share of a cycle each paw is on the ground, the longest step (DIP)
 * and the cadence range (Hz). Like the walk, each aims for its longest step and quickens only once
 * that is reached, so the planted paws stay put up to maxHz * maxStride / duty.
 * stalk: slow, high, deliberate steps; slink: a low, quick retreat walk; sprint: a flat-out gallop
 * with a longer reach than the run. Unlike the v1.1 run, whose legs cannot reach its stride's ends
 * (the drawn paws slide), the sprint's body dips through each stance so the planted paws of the
 * drawn rig stay put too.
 */
const STALK = { duty: 0.72, minStride: 2, maxStride: 14, minHz: 0.8, maxHz: 2.4 } as const;
const SLINK = { duty: 0.62, minStride: 3, maxStride: 19, minHz: 1.4, maxHz: 3.1 } as const;
const SPRINT = { duty: 0.28, minStride: 12, maxStride: 26, minHz: 2.4, maxHz: 4.8 } as const;

/**
 * Fastest anchor speed (DIP/s at size 1) at which each locomotion clip's planted paws stay exactly
 * put: the renderer's side of GAIT_LIMIT_DIP (shared/cat.ts), which tests compare with it.
 */
export const GAIT_CLEAN_LIMIT_DIP: Readonly<Record<GaitClip, number>> = {
  walk: (3.4 * WALK_MAX_STRIDE) / WALK_DUTY,
  run: (4.4 * RUN_MAX_STRIDE) / RUN_DUTY,
  climb: (CLIMB_MAX_HZ * CLIMB_MAX_STRIDE) / CLIMB_DUTY,
  stalk: (STALK.maxHz * STALK.maxStride) / STALK.duty,
  slink: (SLINK.maxHz * SLINK.maxStride) / SLINK.duty,
  sprint: (SPRINT.maxHz * SPRINT.maxStride) / SPRINT.duty,
};

/** Gait cycle rate (Hz at animation speed 1) for a locomotion clip. */
export function gaitHz(anyClip: AnimClip, speed: number): number {
  const clip = baseClip(anyClip);
  const v = Math.max(0, Number.isFinite(speed) ? speed : 0) * BODY_LENGTH_DIP;
  if (clip === 'walk') return clamp((v * WALK_DUTY) / WALK_MAX_STRIDE, 1.3, 3.4);
  if (clip === 'run') return clamp((v * RUN_DUTY) / RUN_MAX_STRIDE, 2.1, 4.4);
  if (clip === 'climb') return clamp((v * CLIMB_DUTY) / CLIMB_STEP, 0.9, CLIMB_MAX_HZ);
  if (clip === 'stalk') return clamp((v * STALK.duty) / STALK.maxStride, STALK.minHz, STALK.maxHz);
  if (clip === 'slink') return clamp((v * SLINK.duty) / SLINK.maxStride, SLINK.minHz, SLINK.maxHz);
  if (clip === 'sprint') return clamp((v * SPRINT.duty) / SPRINT.maxStride, SPRINT.minHz, SPRINT.maxHz);
  return 0;
}

function strideFor(anyClip: AnimClip, speed: number): number {
  const clip = baseClip(anyClip);
  const v = Math.max(0, Number.isFinite(speed) ? speed : 0) * BODY_LENGTH_DIP;
  const hz = gaitHz(clip, speed);
  if (clip === 'walk') return clamp((v * WALK_DUTY) / hz, 3, WALK_MAX_STRIDE);
  // Climb: the gripping paws must stay put on the wall while the anchor climbs, so the stride follows
  // the speed exactly and is 0 when the cat holds still.
  if (clip === 'climb') return clamp((v * CLIMB_DUTY) / hz, 0, CLIMB_MAX_STRIDE);
  if (clip === 'stalk') return clamp((v * STALK.duty) / hz, STALK.minStride, STALK.maxStride);
  if (clip === 'slink') return clamp((v * SLINK.duty) / hz, SLINK.minStride, SLINK.maxStride);
  if (clip === 'sprint') return clamp((v * SPRINT.duty) / hz, SPRINT.minStride, SPRINT.maxStride);
  return clamp((v * RUN_DUTY) / hz, 12, RUN_MAX_STRIDE);
}

// Scratch outputs of footCycle (avoids allocating tuples per frame).
let fcX = 0;
let fcY = 0;
let fcS = 0;

/** Foot path for one leg: stance moves the foot back along the ground, swing lifts it forward. */
function footCycle(phase: number, duty: number, stride: number, lift: number): void {
  const ph = wrap01(phase);
  if (ph < duty) {
    fcX = stride * (0.5 - ph / duty);
    fcY = 0;
    fcS = 0;
  } else {
    const s = (ph - duty) / (1 - duty);
    fcX = stride * (-0.5 + easeInOut(s));
    fcY = -lift * Math.sin(Math.PI * s);
    fcS = Math.sin(Math.PI * s);
  }
}

/**
 * Paw path on a wall (cat facing the wall at +x, up = -y): while gripping the paw slides down
 * relative to the climbing body (it stays put on the wall), then it lets go, swings out from the
 * wall (fcX < 0) and reaches up. fcS is 0..1 through the reach.
 */
function wallCycle(phase: number, duty: number, stride: number, lift: number): void {
  const ph = wrap01(phase);
  if (ph < duty) {
    fcY = stride * (ph / duty - 0.5);
    fcX = 0;
    fcS = 0;
  } else {
    const s = (ph - duty) / (1 - duty);
    fcY = stride * (0.5 - easeInOut(s));
    fcS = Math.sin(Math.PI * s);
    fcX = -lift * fcS;
  }
}

// Scratch poses for keyframed clips (module-level so no per-frame allocation).
const KA = createPose();
const KB = createPose();
const KC = createPose();

// ---------------------------------------------------------------------------
// Base poses

function standPose(p: Pose): void {
  resetPose(p);
}

function sitPose(p: Pose): void {
  resetPose(p);
  p.tilt = 0.98;
  p.bodyLen = 0.86;
  p.bodyH = 1.06;
  p.haunch = 1;
  p.bodyX = -6;
  p.bodyY = -16.5;
  p.pivY = -20;
  p.headX = 7.5;
  p.headY = -44.5;
  p.faceTurn = -0.45;
  p.pupilX = 0.05;
  setFoot(p, LEG_FN, 7.5, 0, 0);
  setFoot(p, LEG_FF, 3.5, 0, 0);
  setFoot(p, LEG_BN, 1, 0, 0);
  setFoot(p, LEG_BF, -3, 0, 0);
  // Tail leaves from under the haunch, runs forward along the ground, tip curls up.
  p.tailBase = -3.1;
  p.tailCurl = -1.0;
  p.tailBend = 0;
  p.tailFront = 1;
  p.tailStiff = 0.7;
}

function loafPose(p: Pose): void {
  resetPose(p);
  p.bodyX = -3;
  p.bodyY = -12.5;
  p.bodyLen = 1.0;
  p.bodyH = 1.02;
  p.curl = 0.22;
  p.haunch = 0.15;
  p.pivY = -12;
  p.headX = 17;
  p.headY = -27;
  p.headRot = -0.04;
  p.faceTurn = -0.3;
  setFoot(p, LEG_FN, 12, -1.5, 0);
  setFoot(p, LEG_FF, 9, -1.5, 0);
  setFoot(p, LEG_BN, -9, -1.5, 0);
  setFoot(p, LEG_BF, -12, -1.5, 0);
  p.tailBase = -2.75;
  p.tailCurl = -1.0;
  p.tailBend = 0;
  p.tailFront = 1;
  p.tailStiff = 0.75;
  p.shadow = 1.1;
}

function sleepPose(p: Pose): void {
  loafPose(p);
  p.curl = 1;
  p.bodyX = -5;
  p.bodyY = -10.5;
  p.bodyLen = 0.98;
  p.bodyH = 0.92;
  p.haunch = 0.75;
  p.headX = 12;
  p.headY = -16.5;
  p.headRot = -0.32;
  p.faceTurn = -0.55;
  p.eyeOpen = 0;
  p.eyeHappy = 0;
  p.earBR = 0.12;
  p.earFR = 0.1;
  p.blinkOK = 0;
  p.lookW = 0;
  setFoot(p, LEG_FN, 9, -1.5, 0);
  setFoot(p, LEG_FF, 6, -1.5, 0);
  setFoot(p, LEG_BN, -11, -1.5, 0);
  setFoot(p, LEG_BF, -14, -1.5, 0);
  p.tailBase = -2.8;
  p.tailCurl = -0.9;
  p.tailBend = 0;
  p.tailFront = 1;
  p.tailStiff = 0.85;
  p.shadow = 1.15;
}

function crouchPose(p: Pose, depth: number): void {
  resetPose(p);
  p.bodyY = -23 + 8 * depth;
  p.bodyX = -3;
  p.tilt = -0.1 * depth;
  p.bodyLen = 1.04;
  // v1.2: the head stays over the front paws (it was 1.5 DIP further forward per unit of depth), so
  // the crouch's hit region stays within HIT_FRONT_EXTENT_DIP.crouch whatever the cat looks at.
  p.headX = 20.5 + 0.5 * depth;
  p.headY = -39 + 8 * depth;
  p.headRot = 0.06 * depth;
  p.earFR = -0.12 * depth;
  p.earBR = -0.08 * depth;
  p.pupilSize = 0.62 + 0.33 * depth;
  setFoot(p, LEG_FN, 15, 0, 0);
  setFoot(p, LEG_FF, 11, 0, 0);
  setFoot(p, LEG_BN, -11, 0, 0);
  setFoot(p, LEG_BF, -15, 0, 0);
  p.tailBase = lerp(1.15, 0.12, depth);
  p.tailCurl = lerp(1.5, 0.5, depth);
}

/**
 * Clinging to a wall at +x (the anchor is the hind-paw grip on the wall line): body upright along
 * the wall, belly towards it, front paws up on the edge, hind paws braced under the haunch, head on
 * top turned towards the viewer and the tail hanging. Built with the torso tilt rather than the
 * global rotation, so "down" stays down for the tail and the head stays upright.
 */
function climbPose(p: Pose): void {
  resetPose(p);
  p.tilt = 1.42;
  p.bodyX = -15;
  p.bodyY = -30;
  p.bodyLen = 1.06;
  p.bodyH = 0.96;
  p.arch = 0.15;
  p.haunch = 0.35;
  p.pivX = -14;
  p.pivY = -34;
  p.headX = -23.5;
  p.headY = -65;
  p.headRot = 0.1;
  p.faceTurn = -0.75;
  p.pupilX = 0.1;
  p.pupilY = -0.2;
  p.pupilSize = 0.7;
  p.earBR = 0.05;
  setFoot(p, LEG_FN, -1, -63, -1.25);
  setFoot(p, LEG_FF, -0.5, -54, -1.25);
  setFoot(p, LEG_BN, -2, -1, -1.35);
  setFoot(p, LEG_BF, -3, -6, -1.35);
  // Tail: hangs from under the rump, mostly straight down (loose, so gravity shapes it), tip curling
  // away from the wall.
  p.tailBase = -1.45;
  p.tailCurl = 0.9;
  p.tailBend = 0;
  p.tailFront = 0;
  p.tailStiff = 0.3;
  p.shadow = 0;
  p.lookW = 0.6;
}

// ---------------------------------------------------------------------------
// Clips

function clipStand(p: Pose, c: ClipContext): void {
  standPose(p);
  const t = c.t;
  p.bodyX += 0.35 * Math.sin(TAU * 0.21 * t);
  p.headY += 0.3 * Math.sin(TAU * 0.21 * t + 1.1);
}

function clipSit(p: Pose, c: ClipContext): void {
  sitPose(p);
  p.headY += 0.25 * Math.sin(TAU * 0.18 * c.t);
}

function clipLoaf(p: Pose, c: ClipContext): void {
  loafPose(p);
  const content = clamp01(c.contentment);
  p.eyeOpen = lerp(0.9, 0.42, content);
  p.eyeHappy = 0;
  p.blush = 0.25 * content;
}

function clipSleep(p: Pose, c: ClipContext): void {
  sleepPose(p);
  // A very slow tail-tip twitch now and then.
  p.tailCurl += 0.18 * Math.max(0, Math.sin(TAU * 0.09 * c.t)) ** 6;
}

function clipWake(p: Pose, c: ClipContext): void {
  const t = c.t;
  // KA: front stretch ("downward dog"), KB: back stretch, KC: standing.
  resetPose(KA);
  KA.bodyX = 2;
  KA.bodyY = -17.5;
  KA.tilt = -0.4;
  KA.bodyLen = 1.08;
  KA.headX = 25;
  KA.headY = -23;
  KA.headRot = 0.35;
  KA.faceTurn = -0.2;
  KA.eyeOpen = 0.04;
  KA.eyeHappy = 0.85;
  KA.earBR = 0.32;
  KA.earFR = 0.28;
  KA.blinkOK = 0;
  setFoot(KA, LEG_FN, 37, 0, 0);
  setFoot(KA, LEG_FF, 34, 0, 0);
  setFoot(KA, LEG_BN, -11, 0, 0);
  setFoot(KA, LEG_BF, -15, 0, 0);
  KA.tailBase = 1.2;
  KA.tailCurl = 0.8;

  resetPose(KB);
  KB.bodyX = 3;
  KB.bodyY = -23;
  KB.tilt = 0.16;
  KB.bodyLen = 1.1;
  KB.headX = 25;
  KB.headY = -41;
  KB.headRot = 0.16;
  KB.eyeOpen = 0.5;
  KB.blinkOK = 0;
  setFoot(KB, LEG_FN, 15, 0, 0);
  setFoot(KB, LEG_FF, 11, 0, 0);
  setFoot(KB, LEG_BN, -27, 0, 0.35);
  setFoot(KB, LEG_BF, -31, -0.5, 0.35);
  KB.tailBase = 0.65;
  KB.tailCurl = 0.4;

  standPose(KC);

  if (t < 0.62) {
    copyPose(p, KA);
  } else if (t < 1.02) {
    blendPose(p, KA, KB, sseg(t, 0.62, 0.86));
  } else {
    blendPose(p, KB, KC, sseg(t, 1.02, 1.2));
  }
  // Stretch-yawn during the front stretch.
  const yawn = pulse(t, 0.16, 0.3, 0.5, 0.62);
  p.mouthOpen = 0.85 * yawn;
  p.mouthRound = 0.1;
  p.tongue = 0.4 * yawn;
  // Final shake: head and ears flap quickly.
  const shake = pulse(t, 1.12, 1.2, 1.45, 1.58);
  if (shake > 0) {
    const w = Math.sin(TAU * 7.5 * (t - 1.12));
    p.headRot += 0.22 * w * shake;
    p.headX += 0.8 * w * shake;
    p.offX += 0.7 * Math.sin(TAU * 7.5 * (t - 1.12) + 1.3) * shake;
    p.earBR += 0.35 * w * shake;
    p.earFR -= 0.35 * w * shake;
    p.eyeOpen = Math.min(p.eyeOpen, 1 - 0.85 * shake);
    p.blinkOK = 0;
  }
}

function clipYawn(p: Pose, c: ClipContext): void {
  sitPose(p);
  const t = c.t;
  const up = pulse(t, 0.08, 0.38, 0.82, 1.05);
  p.headRot += 0.38 * up;
  p.headY -= 1.2 * up;
  p.headX -= 1 * up;
  p.mouthOpen = pulse(t, 0.14, 0.42, 0.78, 1.0);
  p.mouthRound = 0.05;
  p.tongue = 0.6 * p.mouthOpen;
  p.eyeOpen = 1 - pulse(t, 0.12, 0.3, 0.86, 1.12);
  p.eyeHappy = 0.3;
  p.eyeSquint = 0.4 * up;
  p.earBR += 0.32 * up;
  p.earFR += 0.28 * up;
  p.earBF += 0.18 * up;
  p.earFF += 0.18 * up;
  p.blinkOK = t > 1.15 ? 1 : 0;
  p.lookW = 1 - up;
}

function clipWalk(p: Pose, c: ClipContext): void {
  standPose(p);
  const cyc = c.cycle;
  const stride = strideFor('walk', c.speed);
  const lift = clamp(3 + stride * 0.18, 3, 6.5);
  // Lateral-sequence walk: hind near, front near, hind far, front far.
  footCycle(cyc + 0.0, WALK_DUTY, stride, lift);
  setFoot(p, LEG_BN, -12 + fcX, fcY, 0.45 * fcS);
  footCycle(cyc + 0.25, WALK_DUTY, stride, lift);
  setFoot(p, LEG_FN, 13.5 + fcX, fcY, 0.7 * fcS);
  footCycle(cyc + 0.5, WALK_DUTY, stride, lift);
  setFoot(p, LEG_BF, -16.5 + fcX, fcY, 0.45 * fcS);
  footCycle(cyc + 0.75, WALK_DUTY, stride, lift);
  setFoot(p, LEG_FF, 8.5 + fcX, fcY, 0.7 * fcS);
  const bob = Math.cos(TAU * 2 * cyc);
  p.bodyY += -0.7 * bob;
  p.tilt += 0.018 * Math.sin(TAU * cyc);
  p.headX += 1;
  p.headY += 0.8 + 0.5 * Math.cos(TAU * 2 * cyc + 0.7);
  p.headRot -= 0.03;
  p.tailBase = 1.28;
  p.tailCurl = 0.9 + 0.25 * Math.sin(TAU * cyc);
}

function clipRun(p: Pose, c: ClipContext): void {
  standPose(p);
  const ph = wrap01(c.cycle);
  const stride = strideFor('run', c.speed);
  const lift = 9;
  footCycle(ph + 0.0, RUN_DUTY, stride, lift);
  setFoot(p, LEG_BN, -13 + fcX, fcY - 1.5 * fcS, 0.8 * fcS);
  footCycle(ph + 0.08, RUN_DUTY, stride, lift);
  setFoot(p, LEG_BF, -17 + fcX, fcY - 1.5 * fcS, 0.8 * fcS);
  footCycle(ph + 0.5, RUN_DUTY, stride, lift);
  setFoot(p, LEG_FN, 15 + fcX, fcY, 0.9 * fcS);
  footCycle(ph + 0.58, RUN_DUTY, stride, lift);
  setFoot(p, LEG_FF, 11 + fcX, fcY, 0.9 * fcS);
  const flex = Math.sin(TAU * (ph - 0.12));
  p.bodyLen = 1 + 0.12 * flex;
  p.arch = 0.32 * Math.max(0, -flex);
  p.tilt = 0.09 * Math.sin(TAU * (ph + 0.15));
  p.bodyY = -24.5 - 2.6 * Math.abs(Math.sin(TAU * ph));
  p.bodyX = -1;
  p.headX = 24 + 1.2 * flex;
  p.headY = -38 + 1.2 * Math.sin(TAU * ph + 0.5);
  p.headRot = -0.06;
  p.earBR = 0.35;
  p.earFR = 0.3;
  p.earBF = 0.15;
  p.earFF = 0.15;
  p.pupilSize = 0.8;
  p.tailBase = 0.38 + 0.12 * Math.sin(TAU * ph);
  p.tailCurl = -0.15 + 0.3 * Math.sin(TAU * ph + 1);
  p.tailStiff = 0.45;
  p.lookW = 0.4;
}

/** Seconds the crouch's butt wiggle takes to build up from the start of the clip (v1.2: from 0 s). */
export const CROUCH_WIGGLE_RAMP_S = 0.2;

function clipCrouch(p: Pose, c: ClipContext): void {
  const t = c.t;
  const depth = 0.55 + 0.45 * sseg(t, 0, 0.35);
  crouchPose(p, depth);
  // Butt wiggle: the rear sways and the hind feet tread alternately. v1.2: it starts at once (it
  // used to wait 0.35 s, longer than the v1.1 pounce crouch, so it never showed).
  const w = sseg(t, 0, CROUCH_WIGGLE_RAMP_S);
  const f = TAU * 3.1 * t;
  p.tilt -= 0.045 * w * (1 + Math.sin(f));
  p.bodyX -= 1.2 * w * Math.sin(f);
  p.bodyY += 0.4 * w * Math.cos(f);
  p.bnY = -1.6 * w * Math.max(0, Math.sin(f));
  p.bfY = -1.6 * w * Math.max(0, -Math.sin(f));
  p.tailCurl += 0.6 * w * Math.sin(TAU * 1.7 * t);
  p.tailBase += 0.15 * w * Math.sin(TAU * 1.7 * t + 0.6);
  p.pupilSize = 1;
  p.blinkOK = 0;
  // Eyes on the prey, but the head tips only part way towards it (hit extent, see crouchPose).
  p.lookW = 0.75;
}

function clipJump(p: Pose, c: ClipContext): void {
  const kind = c.jumpKind;
  if (kind !== undefined && kind !== null) {
    // v1.2: a flight with a known kind takes off from the compressed crouch into that kind's pose.
    const ext = sseg(c.t, 0, 0.14);
    if (kind === 'pounce') {
      pouncePose(p, ext, c.vy);
      return;
    }
    takeoffPose(KA);
    flightPose(KB, kind, c.vy, c.t);
    blendPose(p, KA, KB, ext);
    return;
  }
  standPose(p);
  const t = c.t;
  // Push-off: from compressed to stretched over the first 0.14 s.
  const ext = sseg(t, 0, 0.14);
  const rising = clamp01(-c.vy / 600);
  const apex = 1 - rising;
  p.bodyLen = lerp(0.92, 1.12, ext);
  p.bodyH = lerp(1.05, 0.93, ext);
  p.tilt = lerp(-0.05, 0.28, ext) - 0.18 * apex * ext;
  p.bodyY = lerp(-17.5, -26, ext);
  p.headX = lerp(23, 25, ext);
  p.headY = lerp(-32, -43, ext);
  p.headRot = 0.12 * ext;
  setFoot(p, LEG_FN, lerp(15, 26, ext) - 6 * apex, lerp(0, -21, ext) + 6 * apex, -0.4 * ext);
  setFoot(p, LEG_FF, lerp(11, 23, ext) - 6 * apex, lerp(0, -18, ext) + 6 * apex, -0.4 * ext);
  setFoot(p, LEG_BN, lerp(-11, -24, ext) + 6 * apex, lerp(0, -3, ext), 0.9 * ext);
  setFoot(p, LEG_BF, lerp(-15, -27, ext) + 6 * apex, lerp(0, -6, ext), 0.9 * ext);
  p.sqY = lerp(0.9, 1.04, ext);
  p.sqX = lerp(1.06, 0.98, ext);
  p.earBR = 0.25;
  p.earFR = 0.22;
  p.pupilSize = 0.9;
  p.tailBase = 0.3;
  p.tailCurl = 0.3;
  p.tailStiff = 0.4;
  p.shadow = lerp(1, 0.45, ext);
  p.lookW = 0.6;
}

function clipFall(p: Pose, c: ClipContext): void {
  const kind = c.jumpKind;
  if (kind !== undefined && kind !== null) {
    // v1.2: the way down of a planned flight: the same pose the jump reached, following vy (a calm,
    // prepared landing instead of the v1.1 startled fall).
    if (kind === 'pounce') pouncePose(p, 1, c.vy);
    else flightPose(p, kind, c.vy, c.t);
    return;
  }
  standPose(p);
  const t = c.t;
  const reach = clamp01(c.vy / 500 + 0.4);
  const w = Math.sin(TAU * 2.4 * t);
  p.tilt = -0.18 * reach;
  p.bodyY = -25;
  p.bodyLen = 1.03;
  p.headX = 22;
  p.headY = -40 - 1.5 * reach;
  p.headRot = -0.12;
  setFoot(p, LEG_FN, 17 + 1.2 * w, 3 + 2 * reach, 0.9);
  setFoot(p, LEG_FF, 13 - 1.2 * w, 2.5 + 2 * reach, 0.9);
  setFoot(p, LEG_BN, -12 - 1.2 * w, 2 + 2 * reach, 0.7);
  setFoot(p, LEG_BF, -16 + 1.2 * w, 1.5 + 2 * reach, 0.7);
  p.earBR = 0.45;
  p.earFR = 0.4;
  p.earBF = 0.25;
  p.earFF = 0.25;
  p.eyeOpen = 1;
  p.pupilSize = 0.95;
  p.mouthOpen = 0.15;
  p.mouthRound = 0.6;
  p.tailBase = 1.45 + 0.1 * w;
  p.tailCurl = -0.6;
  p.tailStiff = 0.35;
  p.shadow = 0.4;
  p.lookW = 0.3;
}

function clipLand(p: Pose, c: ClipContext): void {
  standPose(p);
  const t = c.t;
  // v1.2: the squash deepens with the landing's hardness (impact 0.5, the default, is the v1.1
  // depth); the cat widens less and pulls its head in rather than forward, so a pounce landing's
  // hit region stays within HIT_FRONT_EXTENT_DIP.land.
  const k = lerp(0.75, 1.25, impactOf(c));
  const squash = Math.exp(-(((t - 0.05) / 0.055) ** 2));
  const rebound = Math.exp(-(((t - 0.15) / 0.045) ** 2));
  const sq = (-0.2 * squash + 0.05 * rebound) * k;
  p.sqY = 1 + sq;
  p.sqX = 1 - 0.4 * sq;
  p.bodyY += 5 * squash * k;
  p.headY += (7 * squash - 1 * rebound) * k;
  p.headX -= 2 * squash * k;
  p.headRot -= 0.08 * squash;
  p.lookW = 1 - 0.6 * squash;
  setFoot(p, LEG_FN, 14.5, 0, 0);
  setFoot(p, LEG_FF, 9.5, 0, 0);
  setFoot(p, LEG_BN, -13.5, 0, 0);
  setFoot(p, LEG_BF, -18, 0, 0);
  p.earBR = 0.2 * squash;
  p.earFR = 0.2 * squash;
  p.eyeOpen = 1 - 0.5 * squash;
  p.tailBase = 1.15 - 0.5 * squash;
  p.tailCurl = 1.5 - 1.0 * squash;
}

function clipStartle(p: Pose, c: ClipContext): void {
  standPose(p);
  const t = c.t;
  const k = sseg(t, 0, 0.09);
  const hop = Math.sin(Math.PI * seg(t, 0.05, 0.4));
  const landSq = pulse(t, 0.38, 0.42, 0.46, 0.56);
  // Halloween-cat arch: high rounded back, head held low in front, stiff straight legs.
  p.arch = 1.2 * k;
  p.bodyX = lerp(-2, -3, k);
  p.bodyY = lerp(-23, -25.5, k);
  p.bodyLen = lerp(1, 1.04, k);
  p.bodyH = lerp(1, 0.92, k);
  p.offY = -9 * hop;
  p.offX = -5 * sseg(t, 0.05, 0.4);
  p.sqY = 1 - 0.08 * landSq;
  p.sqX = 1 + 0.05 * landSq;
  p.headX = lerp(21, 23.5, k);
  p.headY = lerp(-39, -33.5, k);
  p.headRot = 0.08 * k;
  p.faceTurn = -0.6 * k;
  setFoot(p, LEG_FN, 12, 0, 0);
  setFoot(p, LEG_FF, 9, 0, 0);
  setFoot(p, LEG_BN, -15, 0, 0);
  setFoot(p, LEG_BF, -18.5, 0, 0);
  p.earBF = 0.7 * k;
  p.earFF = 0.7 * k;
  p.earBR = 0.2 * k;
  p.earFR = 0.2 * k;
  p.eyeOpen = 1;
  p.pupilSize = lerp(0.62, 1, k);
  p.mouthOpen = 0.4 * k * (1 - 0.6 * sseg(t, 0.5, 0.8));
  p.mouthRound = 0.15;
  p.tailBase = lerp(1.15, 1.52, k);
  p.tailCurl = lerp(1.5, 0.15, k);
  p.tailPuff = k;
  p.tailStiff = lerp(0.55, 0.92, k);
  p.shadow = 1 - 0.4 * hop;
  p.blinkOK = 0;
}

function clipAnnoyed(p: Pose, c: ClipContext): void {
  standPose(p);
  const t = c.t;
  const lash = TAU * 1.35 * t;
  p.bodyY += 1;
  p.headY += 2.5;
  p.headX -= 0.5;
  p.headRot = -0.08;
  p.faceTurn = -0.3;
  p.earBF = 0.8;
  p.earFF = 0.8;
  p.earBR = 0.25;
  p.earFR = 0.2;
  p.eyeOpen = 0.62;
  p.eyeSquint = 0.35;
  p.lidSlant = 0.85;
  p.pupilSize = 0.28;
  p.whisker = -0.18;
  p.tailBase = 0.55 + 0.7 * Math.sin(lash);
  p.tailCurl = 0.7 * Math.sin(lash - 1.3);
  p.tailStiff = 0.8;
}

function clipPetted(p: Pose, c: ClipContext): void {
  standPose(p);
  const t = c.t;
  const lean = Math.sin(TAU * 0.33 * t);
  p.bodyY += 1;
  p.tilt = 0.05;
  p.bodyX += 0.8 * lean;
  p.headX = 20 + 0.8 * lean;
  p.headY = -40.5;
  p.headRot = 0.2 + 0.07 * Math.sin(TAU * 0.33 * t + 0.8);
  p.faceTurn = -0.55;
  p.eyeOpen = 0;
  p.eyeHappy = 1;
  p.blush = 1;
  p.earBR = 0.2;
  p.earFR = 0.14;
  p.earBF = 0.12;
  p.earFF = 0.08;
  p.purr = 1;
  p.blinkOK = 0;
  p.lookW = 0.25;
  p.tailBase = 1.3;
  p.tailCurl = 1.15 + 0.3 * Math.sin(TAU * 0.4 * t);
  p.tailStiff = 0.5;
}

function clipGroom(p: Pose, c: ClipContext): void {
  sitPose(p);
  const t = wrap01(c.t / 3.4) * 3.4;
  const raise = pulse(t, 0.0, 0.35, 2.95, 3.35);
  const lick = pulse(t, 0.35, 0.45, 1.45, 1.55);
  const wipe = pulse(t, 1.45, 1.6, 2.8, 2.95);
  const mouthX = p.headX + 6;
  const mouthY = p.headY + 11;
  // Paw path: up to the mouth, then arcs over the face towards the ear.
  const wipeArc = wipe > 0 ? 0.5 - 0.5 * Math.cos(TAU * 1.4 * (t - 1.55)) : 0;
  const px = mouthX + 2 - 6 * wipeArc * wipe;
  const py = mouthY - 1 - 15 * wipeArc * wipe;
  setFoot(p, LEG_FN, lerp(7.5, px, raise), lerp(0, py, raise), lerp(0, -1.1, raise));
  p.bodyX -= 1 * raise;
  const bob = Math.sin(TAU * 3.2 * t);
  p.headRot = -0.18 * raise + 0.06 * bob * lick - 0.22 * wipe * wipeArc;
  p.headY += 1.5 * raise + 0.7 * bob * lick + 1.5 * wipe;
  p.headX -= 1.0 * raise;
  p.faceTurn = -0.2;
  p.tongue = lick * (0.5 + 0.5 * Math.max(0, bob));
  p.eyeOpen = lerp(1, 0.12, Math.max(lick, wipe));
  p.eyeHappy = 0.6 * Math.max(lick, wipe);
  p.earFR += 0.3 * wipe * wipeArc;
  p.earFF += 0.35 * wipe * wipeArc;
  p.blinkOK = raise > 0.1 ? 0 : 1;
  p.lookW = 0.15;
}

function clipPawAt(p: Pose, c: ClipContext): void {
  sitPose(p);
  const t = wrap01(c.t / 1.15) * 1.15;
  // Target: the look point, clamped to the reach of the near front leg.
  const rx = torsoPointX(p, 0.6, 0.32);
  const ry = torsoPointY(p, 0.6, 0.32);
  let tx = c.hasLook ? c.lookX : 34;
  let ty = c.hasLook ? c.lookY : -34;
  let dx = Math.max(6, tx - rx);
  let dy = ty - ry;
  const d = Math.hypot(dx, dy) || 1;
  const reach = Math.min(d, 24);
  dx = (dx / d) * reach;
  dy = (dy / d) * reach;
  tx = rx + dx;
  ty = Math.min(-2, ry + dy);
  const lift = pulse(t, 0, 0.14, 0.5, 0.7);
  const strike = pulse(t, 0.14, 0.24, 0.32, 0.48);
  const hoverX = rx + 6;
  const hoverY = ry + 6;
  const fx = lerp(lerp(7.5, hoverX, lift), tx, strike);
  const fy = lerp(lerp(0, hoverY, lift), ty, strike);
  setFoot(p, LEG_FN, fx, fy, lerp(0, -0.9, lift));
  p.bodyX += 2 * strike;
  p.tilt -= 0.06 * strike;
  p.headX += 1.5 * strike;
  p.earFR = -0.15;
  p.earBR = -0.1;
  p.pupilSize = 0.95;
  p.eyeOpen = 1;
  p.lookW = 1;
  p.tailBase = -0.9;
  p.tailCurl = -2.2 + 0.5 * Math.sin(TAU * 2.2 * c.t);
  p.blinkOK = 0;
}

function clipHeld(p: Pose, c: ClipContext): void {
  resetPose(p);
  const t = c.t;
  p.pivX = HELD_SCRUFF.x;
  p.pivY = HELD_SCRUFF.y;
  // Long, slightly curved body hanging below the scruff; legs dangle loosely.
  p.tilt = 1.5;
  p.arch = -0.25;
  p.bodyX = -2.5;
  p.bodyY = -42;
  p.bodyLen = 0.98;
  p.bodyH = 0.92;
  p.headX = 2.5;
  p.headY = -62;
  p.headRot = -0.14;
  p.faceTurn = -0.8;
  p.earBR = 0.35;
  p.earFR = 0.3;
  p.earBF = 0.3;
  p.earFF = 0.3;
  p.eyeOpen = 1;
  p.pupilSize = 0.9;
  p.mouthOpen = 0;
  p.blush = 0.4;
  const kick = Math.sin(TAU * 0.55 * t);
  const fnRx = torsoPointX(p, 0.6, 0.38);
  const fnRy = torsoPointY(p, 0.6, 0.38);
  const bnRx = torsoPointX(p, -0.5, 0.42);
  const bnRy = torsoPointY(p, -0.5, 0.42);
  setFoot(p, LEG_FN, fnRx + 5 + 0.6 * kick, fnRy + 14.5, 1.75);
  setFoot(p, LEG_FF, fnRx + 2.5, fnRy + 14, 1.75);
  setFoot(p, LEG_BN, bnRx + 3, bnRy + 18.5 + 0.8 * kick, 1.45);
  setFoot(p, LEG_BF, bnRx - 1.5, bnRy + 18 - 0.8 * kick, 1.45);
  p.tailBase = -1.5;
  p.tailCurl = 0.6;
  p.tailStiff = 0.12;
  p.shadow = 0;
  p.lookW = 0.5;
}

function clipMeow(p: Pose, c: ClipContext): void {
  sitPose(p);
  const t = c.t;
  const up = pulse(t, 0.06, 0.26, 0.55, 0.8);
  p.headRot += 0.2 * up;
  p.headY -= 1.5 * up;
  p.faceTurn = -0.7;
  p.mouthOpen = 0.9 * pulse(t, 0.14, 0.3, 0.5, 0.72);
  p.mouthRound = 1;
  p.eyeOpen = 1 - 0.3 * up;
  p.eyeHappy = 0.2 * up;
  p.earBR += 0.1 * up;
  p.blinkOK = t > 0.85 ? 1 : 0;
  p.lookW = 0.6;
}

function clipHide(p: Pose, c: ClipContext): void {
  resetPose(p);
  const t = c.t;
  p.bodyX = -4;
  p.bodyY = -13.5;
  p.bodyH = 0.95;
  p.bodyLen = 1.02;
  p.tilt = -0.05;
  p.haunch = 0.4;
  p.pivY = -13;
  const peek = pulse(wrap01(t / 2.6) * 2.6, 0.9, 1.15, 1.6, 1.9);
  p.headX = 22;
  p.headY = -22 - 4.5 * peek;
  p.headRot = 0.04 + 0.08 * peek;
  p.faceTurn = -0.1;
  p.earBF = 0.75 - 0.35 * peek;
  p.earFF = 0.75 - 0.35 * peek;
  p.earBR = 0.35;
  p.earFR = 0.3;
  p.pupilSize = 1;
  p.eyeOpen = 1;
  p.offX = 0.18 * Math.sin(TAU * 9 * t);
  setFoot(p, LEG_FN, 16, -1, 0);
  setFoot(p, LEG_FF, 12, -1, 0);
  setFoot(p, LEG_BN, -8, -1, 0);
  setFoot(p, LEG_BF, -12, -1, 0);
  p.tailBase = -0.25;
  p.tailCurl = -1.4;
  p.tailStiff = 0.85;
  p.lookW = 0.6;
}

function clipRollOver(p: Pose, c: ClipContext): void {
  resetPose(p);
  const t = c.t;
  // Lie down, then roll onto the back about the spine (roll = y-scale), then wiggle.
  const lie = sseg(t, 0, 0.3);
  const roll = sseg(t, 0.3, 0.6);
  const loop = Math.max(0, t - 0.85);
  const wig = sseg(t, 0.8, 1.1);
  p.pivX = -2;
  p.pivY = -12;
  p.rollY = Math.cos(Math.PI * roll);
  p.rot = 0.12 * Math.sin(TAU * 0.75 * loop) * wig;
  p.bodyX = -2;
  p.bodyY = lerp(-23, -12, lie);
  p.bodyH = lerp(1, 0.95, lie);
  // Head: below the spine line pre-roll, i.e. resting on the ground once belly-up.
  p.headX = lerp(21, 20, lie);
  p.headY = lerp(-39, lerp(-26, -10.5, roll), lie);
  p.headRot = lerp(0, 0.3, roll) + 0.16 * Math.sin(TAU * 0.75 * loop + 0.9) * wig;
  // Keep the head upright (looking at the viewer) while the body is belly-up.
  p.headFlip = p.rollY;
  p.faceTurn = -0.6 * roll;
  p.eyeOpen = 1;
  p.pupilY = 0.2 * roll;
  p.blush = 0.7 * roll;
  p.mouthOpen = 0.18 * wig;
  p.mouthRound = 0.8;
  p.pupilSize = 0.85;
  // Paws in the air: pre-roll targets sit below the roots so they point up when inverted.
  const pad = TAU * 1.5 * loop;
  const upF = lerp(0, 7, roll);
  setFoot(p, LEG_FN, lerp(13, 15 + 2.5 * Math.sin(pad) * wig, lie), lerp(0, upF - 1 + 2 * Math.cos(pad) * wig, roll), lerp(0, 1.2, roll));
  setFoot(p, LEG_FF, lerp(8, 10 - 2.5 * Math.sin(pad) * wig, lie), lerp(0, upF + 1 - 2 * Math.cos(pad) * wig, roll), lerp(0, 1.2, roll));
  setFoot(p, LEG_BN, lerp(-12, -9 - 2 * Math.sin(pad + 1) * wig, lie), lerp(0, upF + 0.5 * Math.cos(pad + 1) * wig, roll), lerp(0, 1.0, roll));
  setFoot(p, LEG_BF, lerp(-16.5, -14 + 2 * Math.sin(pad + 1) * wig, lie), lerp(0, upF + 2 - 0.5 * Math.cos(pad + 1) * wig, roll), lerp(0, 1.0, roll));
  p.tailBase = lerp(1.15, -0.25, roll);
  p.tailCurl = lerp(1.5, 0.9, roll) + 0.4 * Math.sin(TAU * 1.1 * loop) * wig;
  p.tailStiff = 0.6;
  p.blinkOK = roll > 0.5 && roll < 0.99 ? 0 : 1;
  p.lookW = 0.2;
}

function clipClimb(p: Pose, c: ClipContext): void {
  climbPose(p);
  const t = c.t;
  const cyc = c.cycle;
  const speed = Number.isFinite(c.speed) ? Math.max(0, c.speed) : 0;
  // 0 holding still .. 1 climbing (eased by the animator, so it never jumps).
  const move = c.engage !== undefined && Number.isFinite(c.engage) ? clamp01(c.engage) : climbEngagement(speed);
  const still = 1 - move;
  // The step opens up with the climbing motion, so starting and stopping never jerks the paws.
  const stride = strideFor('climb', speed) * move;
  const lift = 2 + 3 * move;

  // Ladder climb: diagonal pairs reach together (near front with far hind, then the other pair).
  // Holding still, the front paws keep a staggered grip; climbing, they alternate about one height.
  // Every paw uses the same stride, so each one stays put on the wall while it grips.
  wallCycle(cyc, CLIMB_DUTY, stride, lift * move);
  setFoot(p, LEG_FN, -1 + fcX, lerp(-63, -61, move) + fcY, -1.25 - 0.35 * fcS * move);
  wallCycle(cyc + 0.5, CLIMB_DUTY, stride, lift * move);
  setFoot(p, LEG_FF, -0.5 + fcX, lerp(-54, -61, move) + fcY, -1.25 - 0.35 * fcS * move);
  wallCycle(cyc + 0.08, CLIMB_DUTY, stride, 2.5 * move);
  setFoot(p, LEG_BF, -3 + fcX, lerp(-6, -3.5, move) + fcY, -1.35 - 0.25 * fcS * move);
  wallCycle(cyc + 0.58, CLIMB_DUTY, stride, 2.5 * move);
  setFoot(p, LEG_BN, -2 + fcX, lerp(-1, -1.5, move) + fcY, -1.35 - 0.25 * fcS * move);

  // Each pull lifts the body a little and rocks it towards the gripping side.
  const pull = Math.cos(TAU * 2 * cyc);
  p.bodyY += -1.1 * pull * move;
  p.tilt += 0.035 * Math.sin(TAU * cyc) * move;
  p.bodyX += -0.6 * Math.sin(TAU * cyc + 0.4) * move;
  p.headY += -0.8 * Math.cos(TAU * 2 * cyc + 0.6) * move;
  p.headRot += 0.1 * move;
  p.pupilY -= 0.2 * move;
  p.earBR += 0.08 * move;
  p.earFR += 0.06 * move;

  // Holding still: a glance down at the viewer, a quick re-grip of the near paw, a look up the wall.
  const it = wrap01(t / CLIMB_IDLE_PERIOD_S) * CLIMB_IDLE_PERIOD_S;
  const down = pulse(it, 1.6, 2.1, 3.0, 3.5) * still;
  const regrip = pulse(it, 3.8, 3.95, 4.1, 4.35) * still;
  const up = pulse(it, 4.7, 5.2, 5.9, 6.4) * still;
  p.headRot += -0.26 * down + 0.3 * up;
  p.faceTurn += -0.45 * down + 0.12 * up;
  p.headX += -1.2 * down;
  p.headY += 1.2 * down - 0.8 * up;
  p.pupilY += 0.6 * down - 0.5 * up;
  p.pupilX -= 0.25 * down;
  p.earBR += 0.12 * down;
  p.earFR -= 0.1 * up;
  p.fnX -= 2.5 * regrip;
  p.fnY -= 2 * regrip;
  p.fnPaw -= 0.3 * regrip;

  // Tail hangs with gravity: a slow pendulum sway (two per idle loop), plus a swing in time with the pulls.
  const sw = (TAU * 2 * t) / CLIMB_IDLE_PERIOD_S;
  p.tailBase += 0.1 * Math.sin(sw) * still + 0.12 * Math.sin(TAU * cyc + 1) * move;
  p.tailCurl += 0.22 * Math.sin(sw - 1.1) * still + 0.3 * Math.sin(TAU * cyc) * move;
  // Climbing down tail first, the cat holds its tail out to the side for balance (it would otherwise
  // reach the floor well before the paws), and looks down where it is going.
  const dn = c.descend !== undefined && Number.isFinite(c.descend) ? clamp01(c.descend) : 0;
  p.tailBase += 0.6 * dn;
  p.tailCurl += 0.5 * dn;
  p.tailStiff += 0.25 * dn;
  p.headRot -= 0.12 * dn;
  p.pupilY += 0.45 * dn;
  p.blinkOK = down > 0.2 || up > 0.2 ? 0 : 1;
  // v1.2: holding on at a top (balance hint) the tail stiffens out as a counterweight and the body
  // sways a little; the gripping paws stay where they are.
  const bal = balanceOf(c) * still;
  if (bal > 0) {
    p.tailBase += 0.45 * bal;
    p.tailStiff += 0.3 * bal;
    p.tailCurl += 0.3 * bal * Math.sin(TAU * 0.55 * t);
    p.bodyX += 0.8 * bal * Math.sin(TAU * 0.4 * t);
    p.headRot += 0.04 * bal * Math.sin(TAU * 0.4 * t + 1.2);
  }
}

// ---------------------------------------------------------------------------
// v1.2 clips (ADR 0003 §8)

/** Push-off of a jump: compressed on its hind legs (the v1.1 jump's first frame). */
function takeoffPose(p: Pose): void {
  resetPose(p);
  p.bodyLen = 0.92;
  p.bodyH = 1.05;
  p.tilt = -0.05;
  p.bodyY = -17.5;
  p.headX = 22;
  p.headY = -32;
  setFoot(p, LEG_FN, 15, 0, 0);
  setFoot(p, LEG_FF, 11, 0, 0);
  setFoot(p, LEG_BN, -11, 0, 0);
  setFoot(p, LEG_BF, -15, 0, 0);
  p.sqY = 0.9;
  p.sqX = 1.06;
  p.earBR = 0.25;
  p.earFR = 0.22;
  p.pupilSize = 0.9;
  p.tailBase = 0.3;
  p.tailCurl = 0.3;
  p.tailStiff = 0.4;
  p.lookW = 0.6;
}

/**
 * In flight, by kind (ADR 0003 §6.2), following vy (rising .. falling): 'up' reaches up for a ledge,
 * 'down' leans nose-first towards the landing with the hind legs tucked, 'across' and 'wallJump'
 * stretch out flying, 'leap' reaches forward-up for a wall, 'hop' stays compact. A calm face: these
 * are planned flights.
 */
function flightPose(p: Pose, kind: JumpKind, vy: number, t: number): void {
  resetPose(p);
  const v = Number.isFinite(vy) ? vy : 0;
  const rise = clamp01(-v / 500);
  const fall = clamp01(v / 500);
  p.earBR = 0.22;
  p.earFR = 0.18;
  p.pupilSize = 0.85;
  p.blinkOK = 0;
  p.lookW = 0.6;
  p.shadow = 0.45;
  p.tailStiff = 0.5;
  const sway = 0.06 * Math.sin(TAU * 1.6 * t);
  switch (kind) {
    case 'up':
      p.tilt = 0.12 + 0.42 * rise - 0.12 * fall;
      p.bodyY = -27;
      p.bodyX = -3;
      p.bodyLen = 1.1;
      p.bodyH = 0.94;
      p.headX = 19.5;
      p.headY = -49 + 6 * fall;
      p.headRot = 0.28 * rise;
      setFoot(p, LEG_FN, 31, -30 + 26 * fall, -0.8 + 1.1 * fall);
      setFoot(p, LEG_FF, 28, -27 + 24 * fall, -0.8 + 1.1 * fall);
      setFoot(p, LEG_BN, -9, 3 - 4 * fall, 1.1);
      setFoot(p, LEG_BF, -13, 2 - 3 * fall, 1.1);
      p.tailBase = -0.35 + 0.8 * fall + sway;
      p.tailCurl = 0.6;
      p.tailStiff = 0.35;
      break;
    case 'down':
      p.tilt = -0.3 + 0.18 * rise - 0.08 * fall;
      p.bodyY = -24;
      p.bodyX = -2;
      p.bodyLen = 1.06;
      p.headX = 22.5;
      p.headY = -33;
      p.headRot = -0.26;
      p.lookW = 0.4;
      setFoot(p, LEG_FN, 19, 5, 0.6);
      setFoot(p, LEG_FF, 15, 4, 0.6);
      setFoot(p, LEG_BN, -15, -9, 1);
      setFoot(p, LEG_BF, -18.5, -11, 1);
      p.earBR = 0.32;
      p.earFR = 0.28;
      p.tailBase = 1.0 + sway;
      p.tailCurl = 0.6;
      break;
    case 'hop':
      p.tilt = 0.07 * rise - 0.07 * fall;
      p.bodyY = -25;
      p.headX = 22;
      p.headY = -40.5;
      setFoot(p, LEG_FN, 16, -5 + 4 * fall, 0.3);
      setFoot(p, LEG_FF, 13, -4 + 4 * fall, 0.3);
      setFoot(p, LEG_BN, -11, -3 + 3 * fall, 0.5);
      setFoot(p, LEG_BF, -15, -2 + 2 * fall, 0.5);
      p.tailBase = 1.0;
      p.tailCurl = 1.0;
      p.shadow = 0.75;
      break;
    case 'leap':
      p.tilt = 0.4 + 0.1 * rise;
      p.bodyY = -26;
      p.bodyX = -3;
      p.bodyLen = 1.12;
      p.bodyH = 0.93;
      p.headX = 21.5;
      p.headY = -47;
      p.headRot = 0.24;
      setFoot(p, LEG_FN, 33, -27, -1.1);
      setFoot(p, LEG_FF, 30, -24, -1.1);
      setFoot(p, LEG_BN, -5, 1, 0.9);
      setFoot(p, LEG_BF, -9, 0, 0.9);
      p.tailBase = 0.1 + sway;
      p.tailCurl = 0.3;
      break;
    case 'wallJump':
      // Pushed off the wall: hind legs fully extended behind, forelegs to the target.
      p.tilt = 0.05 * rise - 0.25 * fall;
      p.bodyY = -25;
      p.bodyX = -1.5;
      p.bodyLen = 1.16;
      p.bodyH = 0.9;
      p.headX = 24.5;
      p.headY = -39;
      p.headRot = -0.05 - 0.15 * fall;
      setFoot(p, LEG_FN, 26, -10 + 14 * fall, -0.3 + 0.8 * fall);
      setFoot(p, LEG_FF, 23, -8 + 13 * fall, -0.3 + 0.8 * fall);
      setFoot(p, LEG_BN, -30 + 6 * fall, -2 + 2 * fall, 1.2);
      setFoot(p, LEG_BF, -33 + 6 * fall, 1 * fall, 1.2);
      p.tailBase = 0.6 + sway;
      p.tailCurl = -0.3;
      break;
    default:
      // 'across' (and any kind without a pose of its own): a stretched-out flying leap.
      p.tilt = 0.18 * rise - 0.22 * fall;
      p.bodyY = -25;
      p.bodyX = -1;
      p.bodyLen = 1.14;
      p.bodyH = 0.92;
      p.headX = 24;
      p.headY = -41 + 3 * fall;
      p.headRot = 0.1 * rise - 0.15 * fall;
      setFoot(p, LEG_FN, 27 - 4 * fall, -16 + 18 * fall, -0.3 + 0.9 * fall);
      setFoot(p, LEG_FF, 24 - 4 * fall, -13 + 17 * fall, -0.3 + 0.9 * fall);
      setFoot(p, LEG_BN, -26 + 8 * fall, -5 + 3 * fall, 0.9);
      setFoot(p, LEG_BF, -29 + 8 * fall, -3 + 3 * fall, 0.9);
      p.tailBase = 0.35 + 0.25 * fall + sway;
      p.tailCurl = 0.2;
  }
}

/**
 * Hunting pounce (also `jump`/`fall` with jumpKind 'pounce'): from the crouch into a long, low
 * stretch, forelegs reaching forward (and down onto the prey as it falls), hind legs trailing,
 * ears forward. The head stays over the forepaws (HIT_FRONT_EXTENT_DIP.pounce).
 */
function pouncePose(p: Pose, ext: number, vy: number): void {
  resetPose(p);
  const v = Number.isFinite(vy) ? vy : 0;
  const rise = clamp01(-v / 500);
  const fall = clamp01(v / 500);
  p.bodyLen = lerp(0.94, 1.16, ext);
  p.bodyH = lerp(1.04, 0.9, ext);
  p.tilt = lerp(-0.08, 0.2 * rise - 0.28 * fall, ext);
  p.bodyY = lerp(-18, -24, ext);
  p.bodyX = lerp(-3, -4.5, ext);
  p.headX = lerp(21, 21.5, ext);
  p.headY = lerp(-31, -35 + 5 * fall, ext);
  p.headRot = ext * (0.06 * rise - 0.2 * fall);
  setFoot(p, LEG_FN, lerp(14, 26, ext), lerp(0, -10 + 16 * fall, ext), ext * (-0.5 + 0.9 * fall));
  setFoot(p, LEG_FF, lerp(10, 23, ext), lerp(0, -8 + 15 * fall, ext), ext * (-0.5 + 0.9 * fall));
  setFoot(p, LEG_BN, lerp(-11, -30, ext), lerp(0, -7 + 3 * fall, ext), 1.1 * ext);
  setFoot(p, LEG_BF, lerp(-15, -33, ext), lerp(0, -5 + 3 * fall, ext), 1.1 * ext);
  p.sqY = lerp(0.9, 1, ext);
  p.sqX = lerp(1.04, 1, ext);
  p.earFR = -0.22;
  p.earBR = -0.16;
  p.pupilSize = 1;
  p.eyeOpen = 1;
  p.whisker = 0.25;
  p.blinkOK = 0;
  p.lookW = 0.7;
  p.tailBase = 0.45 - 0.2 * fall;
  p.tailCurl = 0.15;
  p.tailStiff = 0.6;
  p.shadow = lerp(1, 0.4, ext);
}

function clipPounce(p: Pose, c: ClipContext): void {
  pouncePose(p, sseg(c.t, 0, 0.12), c.vy);
}

function clipStalk(p: Pose, c: ClipContext): void {
  standPose(p);
  const cyc = c.cycle;
  const stride = strideFor('stalk', c.speed);
  // Slow, high, deliberate steps (lateral sequence like the walk).
  const lift = clamp(4 + stride * 0.3, 4, 8.2);
  footCycle(cyc + 0.0, STALK.duty, stride, lift);
  setFoot(p, LEG_BN, -11 + fcX, fcY, 0.5 * fcS);
  footCycle(cyc + 0.25, STALK.duty, stride, lift);
  setFoot(p, LEG_FN, 14 + fcX, fcY, 0.85 * fcS);
  footCycle(cyc + 0.5, STALK.duty, stride, lift);
  setFoot(p, LEG_BF, -15 + fcX, fcY, 0.5 * fcS);
  footCycle(cyc + 0.75, STALK.duty, stride, lift);
  setFoot(p, LEG_FF, 9.5 + fcX, fcY, 0.85 * fcS);
  // Belly ~30 % closer to the ground, back level; the shoulder blades roll with each front step.
  const sh = Math.sin(TAU * (cyc + 0.25));
  p.bodyY = -17.8 - 0.35 * Math.cos(TAU * 2 * cyc);
  p.bodyX = -2.5;
  p.bodyH = 0.96;
  p.bodyLen = 1.03;
  p.tilt = -0.03 + 0.025 * sh;
  p.arch = 0.12 + 0.1 * Math.abs(sh);
  // Head level with the back and forward, steady on the prey.
  p.headX = 25;
  p.headY = -29.5 + 0.25 * Math.cos(TAU * 2 * cyc + 0.5);
  p.headRot = -0.02;
  p.earFR = -0.14;
  p.earBR = -0.1;
  p.pupilSize = 0.95;
  p.whisker = 0.2;
  p.blinkOK = 0;
  // Tail low and straight, only its tip twitching.
  p.tailBase = -0.12;
  p.tailBend = 0;
  p.tailCurl = 0.3 + 0.35 * Math.max(0, Math.sin(TAU * 2.2 * c.t)) ** 3 - 0.2 * Math.max(0, Math.sin(TAU * 2.2 * c.t + 2.1)) ** 3;
  p.tailStiff = 0.7;
}

function clipSlink(p: Pose, c: ClipContext): void {
  standPose(p);
  const cyc = c.cycle;
  const stride = strideFor('slink', c.speed);
  const lift = clamp(2.5 + stride * 0.15, 2.5, 5.2);
  footCycle(cyc + 0.0, SLINK.duty, stride, lift);
  setFoot(p, LEG_BN, -12 + fcX, fcY, 0.45 * fcS);
  footCycle(cyc + 0.25, SLINK.duty, stride, lift);
  setFoot(p, LEG_FN, 13 + fcX, fcY, 0.7 * fcS);
  footCycle(cyc + 0.5, SLINK.duty, stride, lift);
  setFoot(p, LEG_BF, -16 + fcX, fcY, 0.45 * fcS);
  footCycle(cyc + 0.75, SLINK.duty, stride, lift);
  setFoot(p, LEG_FF, 8.5 + fcX, fcY, 0.7 * fcS);
  // Low and wary: body and head down, ears back and flat, tail low.
  p.bodyY = -19.8 - 0.5 * Math.cos(TAU * 2 * cyc);
  p.bodyX = -3;
  p.bodyLen = 1.04;
  p.bodyH = 0.95;
  p.tilt = -0.07 + 0.015 * Math.sin(TAU * cyc);
  p.headX = 22.5;
  p.headY = -30.5 + 0.4 * Math.cos(TAU * 2 * cyc + 0.7);
  p.headRot = -0.1;
  p.earBR = 0.6;
  p.earFR = 0.55;
  p.earBF = 0.45;
  p.earFF = 0.45;
  p.pupilSize = 0.9;
  p.whisker = -0.2;
  p.lookW = 0.5;
  p.tailBase = -0.38;
  p.tailBend = 0;
  p.tailCurl = 0.3 + 0.12 * Math.sin(TAU * cyc);
  p.tailStiff = 0.6;
}

function clipSprint(p: Pose, c: ClipContext): void {
  standPose(p);
  const ph = wrap01(c.cycle);
  const stride = strideFor('sprint', c.speed);
  const lift = 9;
  footCycle(ph + 0.0, SPRINT.duty, stride, lift);
  setFoot(p, LEG_BN, -12.5 + fcX, fcY - 2 * fcS, 0.85 * fcS);
  footCycle(ph + 0.07, SPRINT.duty, stride, lift);
  setFoot(p, LEG_BF, -16 + fcX, fcY - 2 * fcS, 0.85 * fcS);
  footCycle(ph + 0.5, SPRINT.duty, stride, lift);
  setFoot(p, LEG_FN, 12.5 + fcX, fcY, 0.95 * fcS);
  footCycle(ph + 0.56, SPRINT.duty, stride, lift);
  setFoot(p, LEG_FF, 9 + fcX, fcY, 0.95 * fcS);
  // Longer extension and gather than the run, flatter and lower; ears back, tail straight out. The
  // body is lowest in the middle of each pair's stance (ph ~0.1 hind, ~0.6 front) and rises in flight.
  const flex = Math.sin(TAU * (ph - 0.12));
  p.bodyLen = 1.03 + 0.17 * flex;
  p.arch = 0.42 * Math.max(0, -flex);
  p.tilt = 0.06 * Math.sin(TAU * (ph + 0.15));
  p.bodyY = -20 - 2.8 * (0.5 - 0.5 * Math.cos(2 * TAU * (ph - 0.1)));
  p.bodyX = -1;
  p.headX = 24.5 + 1.6 * flex;
  p.headY = -36 + 1 * Math.sin(TAU * ph + 0.5);
  p.headRot = -0.1;
  p.earBR = 0.85;
  p.earFR = 0.8;
  p.earBF = 0.45;
  p.earFF = 0.45;
  p.pupilSize = 0.85;
  p.whisker = -0.3;
  p.lookW = 0.3;
  p.tailBase = 0.06 + 0.05 * Math.sin(TAU * ph);
  p.tailBend = 0;
  p.tailCurl = 0.05 + 0.12 * Math.sin(TAU * ph + 1);
  p.tailStiff = 0.88;
}

/**
 * A slip off a ledge edge (scramble, ADR 0003 §6.6): the front paws catch the edge, the body hangs
 * below it with the hind legs paddling, then it pulls itself up and stands. The anchor is where the
 * cat stands once it has pulled up; the edge it slipped over is SLIP_EDGE_X behind it.
 */
export const SLIP_EDGE_X = -18;

function hangPose(p: Pose, t: number): void {
  resetPose(p);
  const e = SLIP_EDGE_X;
  p.tilt = 0.82;
  p.bodyLen = 0.92;
  p.bodyH = 0.96;
  p.bodyX = e - 13;
  p.bodyY = 9;
  p.arch = -0.2;
  p.headX = e - 1;
  p.headY = -17;
  p.headRot = 0.12;
  p.faceTurn = -0.35;
  p.earBR = 0.55;
  p.earFR = 0.5;
  p.earBF = 0.35;
  p.earFF = 0.35;
  p.eyeOpen = 1;
  p.pupilSize = 1;
  p.mouthOpen = 0.25;
  p.mouthRound = 0.6;
  p.blinkOK = 0;
  p.lookW = 0;
  // Front paws hooked over the edge, on top of the ledge.
  setFoot(p, LEG_FN, e + 15, -1, 0.1);
  setFoot(p, LEG_FF, e + 11, -1, 0.1);
  // Hind legs paddling against the wall below the edge.
  const w = TAU * 4.2 * t;
  setFoot(p, LEG_BN, e - 16 + 4 * Math.sin(w), 27 - 4 * Math.max(0, Math.cos(w)), -0.9);
  setFoot(p, LEG_BF, e - 20 - 4 * Math.sin(w), 26 - 4 * Math.max(0, -Math.cos(w)), -0.9);
  // Tail up and out behind for balance, flailing.
  p.tailBase = 1.2 + 0.2 * Math.sin(TAU * 2.6 * t);
  p.tailCurl = 0.3 * Math.sin(TAU * 2.6 * t + 1.2);
  p.tailStiff = 0.75;
  p.shadow = 0;
}

function clipSlip(p: Pose, c: ClipContext): void {
  const t = c.t;
  const e = SLIP_EDGE_X;
  hangPose(KA, t);
  // Halfway up: chest over the edge, hind legs scrambling onto it.
  resetPose(KB);
  KB.tilt = 0.3;
  KB.bodyX = e - 2;
  KB.bodyY = -14;
  KB.bodyLen = 1.0;
  KB.headX = e + 21;
  KB.headY = -32;
  KB.headRot = -0.08;
  KB.earBR = 0.3;
  KB.earFR = 0.25;
  KB.pupilSize = 0.9;
  KB.blinkOK = 0;
  KB.lookW = 0;
  setFoot(KB, LEG_FN, e + 22, 0, 0);
  setFoot(KB, LEG_FF, e + 18, 0, 0);
  setFoot(KB, LEG_BN, e - 4, 8, -0.6);
  setFoot(KB, LEG_BF, e - 7, 12, -0.6);
  KB.tailBase = 1.1;
  KB.tailCurl = 0.4;
  KB.tailStiff = 0.6;
  KB.shadow = 0.5;
  standPose(KC);
  if (t < 0.18) {
    // The catch: from the flight into the hang.
    copyPose(p, KA);
    p.bodyY -= 10 * (1 - sseg(t, 0, 0.18));
  } else if (t < 0.55) {
    copyPose(p, KA);
  } else if (t < 0.75) {
    blendPose(p, KA, KB, sseg(t, 0.55, 0.75));
  } else {
    blendPose(p, KB, KC, sseg(t, 0.75, 0.9));
  }
  // A shiver of effort while hanging.
  const hang = 1 - sseg(t, 0.5, 0.65);
  p.offX += 0.35 * hang * Math.sin(TAU * 11 * t);
}

/** Hard landing (ADR 0003 §6.4): deep squash, legs splayed, head dips; depth follows `impact`. */
function clipImpact(p: Pose, c: ClipContext): void {
  impactPose(p, c.t, impactOf(c));
}

const IMPACT_END_S = 0.45;

function impactPose(p: Pose, t: number, impact: number): void {
  standPose(p);
  const k = lerp(0.55, 1, impact);
  const hit = Math.exp(-(((t - 0.06) / 0.075) ** 2));
  // After the squash the cat stays low (landRecover or the next clip takes over from here).
  const low = sseg(t, 0.03, 0.12) * (1 - 0.45 * sseg(t, 0.2, 0.45));
  p.sqY = 1 - 0.3 * k * hit;
  p.sqX = 1 + 0.1 * k * hit;
  p.bodyY += 4 * k * low + 4 * k * hit;
  p.bodyX -= 1.5 * k * hit;
  p.headY += 6 * k * low + 7 * k * hit;
  p.headX -= 2 * k * hit;
  p.headRot -= 0.22 * k * hit + 0.08 * low;
  setFoot(p, LEG_FN, 13 + 5 * k * low, 0, 0);
  setFoot(p, LEG_FF, 8 + 5 * k * low, 0, 0);
  setFoot(p, LEG_BN, -12 - 4 * k * low, 0, 0);
  setFoot(p, LEG_BF, -16.5 - 4 * k * low, 0, 0);
  p.earBF = 0.45 * k * low;
  p.earFF = 0.45 * k * low;
  p.earBR = 0.3 * k * low;
  p.earFR = 0.3 * k * low;
  p.eyeOpen = 1 - Math.min(1, 1.3 * hit * k);
  p.eyeSquint = 0.3 * low * k;
  p.mouthOpen = 0.25 * hit * k;
  p.mouthRound = 0.3;
  p.pupilSize = 0.9;
  p.blinkOK = 0;
  p.lookW = 0.2;
  p.tailBase = 0.9 - 0.9 * k * low;
  p.tailCurl = 0.6;
  p.tailStiff = 0.55;
}

/** After a hard landing: a head shake, a look left and right, then it sits up (ends as `sit`). */
function clipLandRecover(p: Pose, c: ClipContext): void {
  const t = c.t;
  // KA: low, legs apart (where impact ends for the same hardness); KC: sitting.
  impactPose(KA, IMPACT_END_S, impactOf(c));
  sitPose(KC);
  blendPose(p, KA, KC, sseg(t, 0.55, 0.9));
  // Shake it off.
  const shake = pulse(t, 0.04, 0.1, 0.32, 0.4);
  if (shake > 0) {
    const w = Math.sin(TAU * 8 * (t - 0.04));
    p.headRot += 0.24 * w * shake;
    p.headX += 0.8 * w * shake;
    p.earBR += 0.4 * w * shake;
    p.earFR -= 0.4 * w * shake;
    p.earBF += 0.2 * shake;
    p.earFF += 0.2 * shake;
    p.eyeOpen = Math.min(p.eyeOpen, 1 - 0.85 * shake);
    p.offX += 0.6 * Math.sin(TAU * 8 * (t - 0.04) + 1.3) * shake;
  }
  // Look back over the shoulder, then forward and away.
  const back = pulse(t, 0.38, 0.48, 0.56, 0.64);
  const away = pulse(t, 0.58, 0.66, 0.74, 0.84);
  p.faceTurn += -1.9 * back + 0.9 * away;
  p.pupilX += -0.8 * back + 0.6 * away;
  p.headRot += 0.1 * back - 0.06 * away;
  p.headX -= 2.5 * back;
  p.lookW = 1 - Math.max(back, away, shake);
  p.blinkOK = t > 0.85 ? 1 : 0;
}

/** One quick paw strike toward `look` (defensive or play), weight shifted back; ~0.45 s. */
function clipSwat(p: Pose, c: ClipContext): void {
  standPose(p);
  const t = c.t;
  const back = pulse(t, 0, 0.08, 0.3, 0.45);
  const lift = pulse(t, 0, 0.11, 0.3, 0.43);
  const strike = pulse(t, 0.1, 0.19, 0.23, 0.33);
  p.bodyX -= 3 * back;
  p.bodyY -= 1.2 * back;
  p.tilt += 0.16 * back;
  p.headX -= 2 * back;
  p.headY -= 1.5 * back;
  p.headRot += 0.05 * back;
  // Target: the look point, within the near foreleg's reach.
  const rx = torsoPointX(p, 0.6, 0.38);
  const ry = torsoPointY(p, 0.6, 0.38);
  const lx = c.hasLook ? c.lookX : 40;
  const ly = c.hasLook ? c.lookY : -26;
  // Aimed forward at chest height whatever the height of the target: a higher paw would vanish
  // behind the head, and the jab in front of the chest is what reads, in pixel style too.
  let dx = Math.max(16, lx - rx);
  let dy = clamp(ly - ry, -7, 3);
  const d = Math.hypot(dx, dy) || 1;
  const reach = Math.min(d, 26);
  dx = (dx / d) * reach;
  dy = (dy / d) * reach;
  const raisedX = rx + 4;
  const raisedY = ry - 2;
  const fx = lerp(lerp(13, raisedX, lift), rx + dx, strike);
  const fy = lerp(lerp(0, raisedY, lift), Math.min(-8, ry + dy), strike);
  setFoot(p, LEG_FN, fx, fy, lerp(lerp(0, -0.9, lift), 0.5, strike));
  // Braced hind legs; the far forepaw takes the weight.
  setFoot(p, LEG_FF, 9, 0, 0);
  setFoot(p, LEG_BN, -13.5, 0, 0);
  setFoot(p, LEG_BF, -18, 0, 0);
  p.earBR = 0.45 * back;
  p.earFR = 0.4 * back;
  p.earBF = 0.25 * back;
  p.earFF = 0.25 * back;
  p.eyeSquint = 0.25 * back;
  p.pupilSize = 0.95;
  p.whisker = -0.2 * back;
  p.mouthOpen = 0.2 * strike;
  p.lookW = 1;
  p.blinkOK = 0;
  p.tailBase = 0.7 + 0.45 * Math.sin(TAU * 2.2 * t);
  p.tailCurl = 0.3;
  p.tailStiff = 0.7;
}

/**
 * Defensive hiss (~1.2 s): a high arched back, stiff legs, puffed tail held up, ears pinned flat,
 * mouth wide. Its silhouette (hump, bottle-brush tail, flat ears) reads without the face details.
 */
function clipHiss(p: Pose, c: ClipContext): void {
  standPose(p);
  const t = c.t;
  const k = sseg(t, 0, 0.14);
  const hiss = pulse(t, 0.12, 0.22, 0.85, 1.05);
  const ease = 0.3 * sseg(t, 0.95, 1.2);
  p.arch = 1.2 * k * (1 - 0.3 * ease);
  p.bodyX = lerp(-2, -4, k);
  p.bodyY = lerp(-23, -26.5, k);
  p.bodyLen = lerp(1, 1.02, k);
  p.bodyH = lerp(1, 0.9, k);
  p.offX = -1.5 * k;
  p.headX = lerp(21, 22, k);
  p.headY = lerp(-39, -33, k);
  p.headRot = -0.04 * k;
  p.faceTurn = -0.55 * k;
  setFoot(p, LEG_FN, 12, 0, 0);
  setFoot(p, LEG_FF, 9, 0, 0);
  setFoot(p, LEG_BN, -15.5, 0, 0);
  setFoot(p, LEG_BF, -19, 0, 0);
  p.earBF = k;
  p.earFF = k;
  p.earBR = 0.95 * k;
  p.earFR = 0.95 * k;
  p.eyeOpen = 1 - 0.15 * k;
  p.lidSlant = 0.65 * k;
  p.pupilSize = lerp(0.62, 0.95, k);
  p.whisker = -0.5 * k;
  p.mouthOpen = 0.95 * hiss + 0.15 * k * (1 - hiss);
  p.mouthRound = 0;
  p.tailBase = lerp(1.15, 1.5, k);
  p.tailCurl = lerp(1.5, 0.45, k);
  p.tailBend = 0;
  p.tailPuff = k;
  p.tailStiff = lerp(0.55, 0.94, k);
  p.offX += 0.25 * hiss * Math.sin(TAU * 26 * t);
  p.blinkOK = 0;
  p.lookW = 0.6;
}

/** Grumpy stare: a low sit, ears out sideways, narrowed eyes, the tail thumping slowly behind. */
export const GRUMPY_THUMP_S = 1.8;

function clipGrumpy(p: Pose, c: ClipContext): void {
  sitPose(p);
  const t = c.t;
  p.bodyY += 2;
  p.bodyX -= 0.5;
  p.headY += 3.5;
  p.headX += 1;
  p.headRot = -0.06;
  p.faceTurn = -0.35;
  p.earBR = 0.5;
  p.earFR = 0.45;
  p.earBF = 0.55;
  p.earFF = 0.5;
  p.eyeOpen = 0.55;
  p.eyeSquint = 0.45;
  p.lidSlant = 0.55;
  p.pupilSize = 0.3;
  p.whisker = -0.12;
  p.lookW = 0.7;
  // Tail lying behind, lifted slowly and slapped down.
  const ph = wrap01(t / GRUMPY_THUMP_S) * GRUMPY_THUMP_S;
  const lift = sseg(ph, 0.4, 1.0) * (1 - sseg(ph, 1.0, 1.12));
  p.tailFront = 0;
  p.tailBase = -0.25 + 0.75 * lift;
  p.tailCurl = 0.35 - 0.2 * lift;
  p.tailBend = 0.3;
  p.tailStiff = 0.65;
}

/** Standing stretch (~1.6 s): front stretch, a back stretch with one hind leg out, then standing. */
function clipStretch(p: Pose, c: ClipContext): void {
  const t = c.t;
  resetPose(KA);
  KA.bodyX = 1;
  KA.bodyY = -18.5;
  KA.tilt = -0.45;
  KA.bodyLen = 1.12;
  KA.headX = 27;
  KA.headY = -21.5;
  KA.headRot = 0.3;
  KA.faceTurn = -0.25;
  KA.eyeOpen = 0;
  KA.eyeHappy = 1;
  KA.blinkOK = 0;
  KA.earBR = 0.2;
  KA.earFR = 0.18;
  setFoot(KA, LEG_FN, 38, 0, 0.1);
  setFoot(KA, LEG_FF, 35, 0, 0.1);
  setFoot(KA, LEG_BN, -11, 0, 0);
  setFoot(KA, LEG_BF, -15, 0, 0);
  KA.tailBase = 1.35;
  KA.tailCurl = 0.35;
  KA.tailStiff = 0.85;

  resetPose(KB);
  KB.bodyX = 4;
  KB.bodyY = -22.5;
  KB.tilt = 0.12;
  KB.bodyLen = 1.08;
  KB.headX = 26;
  KB.headY = -40;
  KB.headRot = 0.12;
  KB.eyeOpen = 0.05;
  KB.eyeHappy = 0.9;
  KB.blinkOK = 0;
  setFoot(KB, LEG_FN, 17, 0, 0);
  setFoot(KB, LEG_FF, 13, 0, 0);
  setFoot(KB, LEG_BN, -31, -4, 0.55);
  setFoot(KB, LEG_BF, -20, 0, 0);
  KB.tailBase = 0.9;
  KB.tailCurl = 0.6;

  standPose(KC);
  if (t < 0.35) blendPose(p, KC, KA, sseg(t, 0, 0.35));
  else if (t < 0.95) blendPose(p, KA, KB, sseg(t, 0.7, 0.95));
  else blendPose(p, KB, KC, sseg(t, 1.25, 1.55));
  // The tail quivers at the peak of the front stretch.
  const peak = pulse(t, 0.3, 0.4, 0.62, 0.72);
  p.tailCurl += 0.12 * peak * Math.sin(TAU * 9 * t);
}

/** Narrow ledge or top corner: crouched, paws together, tail straight out as a counterweight; sway follows `balance`. */
function clipBalance(p: Pose, c: ClipContext): void {
  standPose(p);
  const t = c.t;
  const b = balanceOf(c);
  p.bodyY = -19.5;
  p.bodyX = -2;
  p.bodyLen = 0.94;
  p.bodyH = 1.02;
  p.tilt = -0.03;
  p.headX = 19;
  p.headY = -32;
  p.headRot = -0.16;
  p.earBR = 0.1;
  p.pupilSize = 0.8;
  p.lookW = 0.6;
  setFoot(p, LEG_FN, 7, 0, 0);
  setFoot(p, LEG_FF, 4.5, 0, 0);
  setFoot(p, LEG_BN, -6.5, 0, 0);
  setFoot(p, LEG_BF, -9.5, 0, 0);
  // Sway about the paws, the head kept level and the tail swinging the other way.
  const amp = 0.012 + 0.07 * b;
  const w = Math.sin(TAU * 0.55 * t) + 0.35 * Math.sin(TAU * 1.7 * t + 0.8) + 0.25 * b * noise1(t * 2.3, 5);
  p.pivX = 0;
  p.pivY = -1;
  p.rot = amp * w;
  p.headRot -= 0.8 * p.rot;
  p.tailBase = 0.05 - 1.6 * amp * w;
  p.tailCurl = 2 * amp * w;
  p.tailBend = 0;
  p.tailStiff = 0.85;
  // A wobblier ledge: now and then a forepaw re-grips.
  const regrip = b * pulse(wrap01(t / 2.4) * 2.4, 1.2, 1.32, 1.42, 1.56);
  p.fnY -= 3 * regrip;
  p.fnX += 1.5 * regrip;
}

/** Tail chase: spinning on the spot after its own tail, which leads the turn (turnX spins the pose). */
export const TAIL_CHASE_REV_S = 0.84;

function clipTailChase(p: Pose, c: ClipContext): void {
  resetPose(p);
  const t = c.t;
  const into = sseg(t, 0, 0.3);
  const th = (TAU * t) / TAIL_CHASE_REV_S;
  p.turnX = lerp(1, Math.cos(th), into);
  p.sqY = 1 + 0.07 * into * (1 - Math.abs(p.turnX));
  p.pivX = -3;
  p.pivY = -20;
  // Curled after the tail: head turned back towards it, back rounded, quick little steps.
  p.arch = 0.35 * into;
  p.bodyY = -22;
  p.bodyLen = 0.96;
  p.headX = 19;
  p.headY = -37;
  p.headRot = -0.1 * into;
  p.faceTurn = -1.5 * into;
  p.pupilX = -0.8 * into;
  p.pupilSize = 1;
  p.earFR = -0.1;
  p.blinkOK = 0;
  p.lookW = 0;
  const cyc = t * 3.2;
  footCycle(cyc, 0.55, 6 * into, 4);
  setFoot(p, LEG_FN, 12 + fcX, fcY, 0.6 * fcS);
  footCycle(cyc + 0.5, 0.55, 6 * into, 4);
  setFoot(p, LEG_FF, 8 + fcX, fcY, 0.6 * fcS);
  footCycle(cyc + 0.25, 0.55, 6 * into, 3);
  setFoot(p, LEG_BN, -11 + fcX, fcY, 0.4 * fcS);
  footCycle(cyc + 0.75, 0.55, 6 * into, 3);
  setFoot(p, LEG_BF, -15 + fcX, fcY, 0.4 * fcS);
  // The tail swings up and forward over the back, ahead of the head.
  p.tailBase = lerp(1.15, 0.7, into);
  p.tailCurl = lerp(1.5, 2.5, into) + 0.35 * into * Math.sin(th * 2);
  p.tailBend = 0.2;
  p.tailStiff = 0.6;
}

/** Sitting at the very end of a ledge, paws at its edge, peering down past them toward `look`. */
export const EDGE_SIT_PERIOD_S = 6;

function clipEdgeSit(p: Pose, c: ClipContext): void {
  sitPose(p);
  const t = wrap01(c.t / EDGE_SIT_PERIOD_S) * EDGE_SIT_PERIOD_S;
  const lean = pulse(t, 1.2, 1.9, 3.4, 4.2);
  p.tilt = 0.86;
  p.bodyX = -4;
  p.headX = 12.5 + 2 * lean;
  p.headY = -38 + 3 * lean;
  p.headRot = -0.3 - 0.1 * lean;
  p.faceTurn = -0.25;
  p.pupilY = 0.5;
  p.earFR = -0.1;
  p.earBR = -0.05 + 0.25 * pulse(t, 4.6, 4.8, 5.1, 5.4);
  p.lookW = 0.8;
  setFoot(p, LEG_FN, 9.5, 0, 0);
  setFoot(p, LEG_FF, 6, 0, 0);
}

type ClipFn = (p: Pose, c: ClipContext) => void;

const CLIPS: Readonly<Record<AnimClip, ClipFn>> = {
  stand: clipStand,
  sit: clipSit,
  loaf: clipLoaf,
  sleep: clipSleep,
  wake: clipWake,
  yawn: clipYawn,
  walk: clipWalk,
  run: clipRun,
  crouch: clipCrouch,
  jump: clipJump,
  fall: clipFall,
  land: clipLand,
  startle: clipStartle,
  annoyed: clipAnnoyed,
  petted: clipPetted,
  groom: clipGroom,
  pawAt: clipPawAt,
  held: clipHeld,
  meow: clipMeow,
  hide: clipHide,
  rollOver: clipRollOver,
  climb: clipClimb,
  // v1.2 (ADR 0003 §8)
  stalk: clipStalk,
  sprint: clipSprint,
  pounce: clipPounce,
  slip: clipSlip,
  impact: clipImpact,
  landRecover: clipLandRecover,
  swat: clipSwat,
  hiss: clipHiss,
  grumpy: clipGrumpy,
  slink: clipSlink,
  stretch: clipStretch,
  balance: clipBalance,
  tailChase: clipTailChase,
  edgeSit: clipEdgeSit,
};

/** Samples `clip` at the context's phase into `out`. One-shot clips hold their last pose. */
export function sampleClip(clip: AnimClip, ctx: ClipContext, out: Pose): Pose {
  const fn = CLIPS[clip] ?? clipStand;
  const dur = clipDurationS(clip);
  const t = Number.isFinite(ctx.t) ? Math.max(0, ctx.t) : 0;
  const prevT = ctx.t;
  const prevCycle = ctx.cycle;
  ctx.t = dur === null ? t : Math.min(t, dur);
  if (!Number.isFinite(ctx.cycle)) ctx.cycle = 0;
  try {
    fn(out, ctx);
  } finally {
    ctx.t = prevT;
    ctx.cycle = prevCycle;
  }
  return out;
}

/**
 * Cross-fade (ms) onto the wall at movement speed 1 (the mover's mount takes 320 ms, the swing down
 * from a top 460 ms).
 */
export const CLIMB_FADE_MS = 280;
/**
 * Cross-fade (ms) from the wall back to a ground clip at movement speed 1: the pull-up over a top
 * corner carries the anchor up onto the ledge for 520 ms, and the cat should keep hold of the wall
 * for most of it.
 */
export const CLIMB_OFF_FADE_MS = 400;
/** Cross-fade (ms) from the wall into a quick clip (letting go and falling, leaping off, a startle). */
const CLIMB_QUICK_FADE_MS = 240;

const quickClip = (c: AnimClip): boolean =>
  c === 'jump' || c === 'fall' || c === 'land' || c === 'startle' || c === 'pounce' || c === 'slip' || c === 'impact' || c === 'hiss';

/**
 * True for a clip change the mover times as a wall manoeuvre: getting onto a wall (mount, swing
 * down from a top) or off it onto a support (pull-up, step-off). Those take 1/movementSpeed as long
 * (src/core/movement/mover.ts), so the renderer's fades and off-wall timing must scale with them.
 */
export function isWallManoeuvre(from: AnimClip | null, to: AnimClip): boolean {
  if (from === null || from === 'held' || to === 'held') return false;
  if (to === 'climb') return from !== 'climb';
  return from === 'climb' && !quickClip(to);
}

/** settings.behavior.movementSpeed as the wall timings use it (1 when missing or invalid). */
export function wallTimeScale(movementSpeed: number | undefined): number {
  return movementSpeed !== undefined && Number.isFinite(movementSpeed) && movementSpeed > 0 ? clamp(movementSpeed, 0.25, 4) : 1;
}

/** Cross-fade duration (ms) when switching between clips (wall manoeuvres at `movementSpeed`). */
export function crossFadeMs(from: AnimClip | null, to: AnimClip, movementSpeed = 1): number {
  if (from === null) return 0;
  // The climb pose turns the whole body through 90 degrees, with the front paws a body length up:
  // rearing up onto a wall or pulling up over a corner onto the ledge takes a little longer, and even
  // the quick ways off the wall are slower than the usual quick fades (so nothing pops). Picking the
  // cat up keeps the held fade below, which the mover's scruff settle is timed to.
  if (from === 'climb' && to !== 'held') return quickClip(to) ? CLIMB_QUICK_FADE_MS : CLIMB_OFF_FADE_MS / wallTimeScale(movementSpeed);
  if (to === 'climb' && from !== 'held') return CLIMB_FADE_MS / wallTimeScale(movementSpeed);
  if (to === 'startle' || to === 'land' || to === 'jump') return 150;
  // v1.2 quick clips: a strike, a hiss, a pounce or a hard landing must not lag behind the event.
  if (to === 'pounce' || to === 'impact' || to === 'swat' || to === 'hiss') return 140;
  if (to === 'fall' || from === 'land' || from === 'impact') return 170;
  if (to === 'sleep' || from === 'sleep' || to === 'loaf' || to === 'rollOver' || from === 'rollOver' || to === 'tailChase' || from === 'tailChase') return 250;
  if (to === 'sit' || from === 'sit' || to === 'held' || from === 'held') return 220;
  return 200;
}

/** Whether a clip is a locomotion cycle driven by `speed`. */
export const isGait = (anyClip: AnimClip): boolean => {
  const clip = baseClip(anyClip);
  return clip === 'walk' || clip === 'run' || clip === 'climb' || clip === 'stalk' || clip === 'slink' || clip === 'sprint';
};

/** Seconds of one loop of a looping clip (used by previews/tests), null if not periodic. */
export function loopPeriodS(anyClip: AnimClip): number | null {
  if (ONE_SHOT_CLIPS.has(anyClip)) return null;
  const clip = baseClip(anyClip);
  switch (clip) {
    case 'groom':
      return 3.4;
    case 'pawAt':
      return 1.15;
    case 'hide':
      return 2.6;
    case 'climb':
      // Holding still; while climbing the motion follows the gait cycle instead.
      return CLIMB_IDLE_PERIOD_S;
    case 'grumpy':
      return 2 * GRUMPY_THUMP_S;
    case 'tailChase':
      return TAIL_CHASE_REV_S;
    case 'edgeSit':
      return EDGE_SIT_PERIOD_S;
    default:
      return null;
  }
}
