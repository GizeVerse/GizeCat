// Animation clips: pure functions (clip, phase, context) -> Pose. Procedural layers
// (breathing, blinking, look-at, tail physics, mood) are added by the animator.
import { CAT_BASE_WIDTH_DIP, ONE_SHOT_CLIPS, type AnimClip } from '../../../shared/cat';
import { HELD_SCRUFF_DIP } from '../../../core/interaction/held';
import { clamp, clamp01, easeInOut, lerp, pulse, seg, sseg, TAU, wrap01 } from './math';
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
}

/** Durations (s) of clips that play once and hold their final pose. */
export const ONE_SHOT_DURATION_S: Readonly<Partial<Record<AnimClip, number>>> = {
  wake: 1.6,
  yawn: 1.2,
  land: 0.25,
  startle: 0.8,
  meow: 0.9,
};

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

/** Gait cycle rate (Hz at animation speed 1) for a locomotion clip. */
export function gaitHz(clip: AnimClip, speed: number): number {
  const v = Math.max(0, Number.isFinite(speed) ? speed : 0) * BODY_LENGTH_DIP;
  if (clip === 'walk') return clamp((v * WALK_DUTY) / WALK_MAX_STRIDE, 1.3, 3.4);
  if (clip === 'run') return clamp((v * RUN_DUTY) / RUN_MAX_STRIDE, 2.1, 4.4);
  return 0;
}

function strideFor(clip: AnimClip, speed: number): number {
  const v = Math.max(0, Number.isFinite(speed) ? speed : 0) * BODY_LENGTH_DIP;
  const hz = gaitHz(clip, speed);
  if (clip === 'walk') return clamp((v * WALK_DUTY) / hz, 3, WALK_MAX_STRIDE);
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
  p.headX = 23 + 1.5 * depth;
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

function clipCrouch(p: Pose, c: ClipContext): void {
  const t = c.t;
  const depth = 0.55 + 0.45 * sseg(t, 0, 0.35);
  crouchPose(p, depth);
  // Butt wiggle: the rear sways and the hind feet tread alternately.
  const w = sseg(t, 0.35, 0.7);
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
}

function clipJump(p: Pose, c: ClipContext): void {
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
  const squash = Math.exp(-(((t - 0.05) / 0.055) ** 2));
  const rebound = Math.exp(-(((t - 0.15) / 0.045) ** 2));
  const sq = -0.2 * squash + 0.05 * rebound;
  p.sqY = 1 + sq;
  p.sqX = 1 - 0.65 * sq;
  p.bodyY += 5 * squash;
  p.headY += 7 * squash - 1 * rebound;
  p.headX += 1.5 * squash;
  p.headRot -= 0.08 * squash;
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

/** Cross-fade duration (ms) when switching between clips. */
export function crossFadeMs(from: AnimClip | null, to: AnimClip): number {
  if (from === null) return 0;
  if (to === 'startle' || to === 'land' || to === 'jump') return 150;
  if (to === 'fall' || from === 'land') return 170;
  if (to === 'sleep' || from === 'sleep' || to === 'loaf' || to === 'rollOver' || from === 'rollOver') return 250;
  if (to === 'sit' || from === 'sit' || to === 'held' || from === 'held') return 220;
  return 200;
}

/** Whether a clip is a locomotion cycle driven by `speed`. */
export const isGait = (clip: AnimClip): boolean => clip === 'walk' || clip === 'run';

/** Seconds of one loop of a looping clip (used by previews/tests), null if not periodic. */
export function loopPeriodS(clip: AnimClip): number | null {
  switch (clip) {
    case 'groom':
      return 3.4;
    case 'pawAt':
      return 1.15;
    case 'hide':
      return 2.6;
    default:
      return null;
  }
}
