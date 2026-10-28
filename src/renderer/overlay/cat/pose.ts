// Parametric pose of the cat rig. All lengths are cat-local DIP at scale 1, with the
// cat facing right (+x), y pointing down and the ground anchor at (0, 0).
// Angles are radians; "+" means counter-clockwise on screen (nose up) unless noted.

export const POSE_KEYS = [
  // Global transform: offset, squash about the ground anchor, rotation and roll
  // (y-scale, cos of the roll angle about the spine) about a pivot.
  'offX',
  'offY',
  'sqX',
  'sqY',
  'rot',
  'pivX',
  'pivY',
  'rollY',
  // Torso: centre, half-length/half-height multipliers, tilt (+ = front up),
  // back arch 0..1, curl (sleeping roundness) 0..1, haunch (sitting thigh) 0..1.
  'bodyX',
  'bodyY',
  'bodyLen',
  'bodyH',
  'tilt',
  'arch',
  'curl',
  'haunch',
  // Head centre, rotation (+ = look up), face turn (-2 looks back, 0 = 3/4 front, 1 = profile),
  // head flip (y-scale of the head alone: -1 keeps it upright while the body rolls belly-up).
  'headX',
  'headY',
  'headRot',
  'faceTurn',
  'headFlip',
  // Ears: back/far (B) and front/near (F); rotation (+ = backwards) and flatness 0..1.
  'earBR',
  'earBF',
  'earFR',
  'earFF',
  // Eyes: open 0..1, squint 0..1 (lower lid), happy-closed shape 0..1, angry lid slant 0..1,
  // pupil offset -1..1 and dilation 0..1.
  'eyeOpen',
  'eyeSquint',
  'eyeHappy',
  'lidSlant',
  'pupilX',
  'pupilY',
  'pupilSize',
  // Mouth open 0..1, round (meow) vs wide (yawn) 0..1, tongue 0..1, whisker angle offset.
  'mouthOpen',
  'mouthRound',
  'tongue',
  'whisker',
  // Legs: foot target (cat-local) and paw axis angle (canvas radians, 0 = toes forward, + = toes down).
  // fn = front near, ff = front far, bn = hind near, bf = hind far.
  'fnX',
  'fnY',
  'fnPaw',
  'ffX',
  'ffY',
  'ffPaw',
  'bnX',
  'bnY',
  'bnPaw',
  'bfX',
  'bfY',
  'bfPaw',
  // Tail: base angle (0 = straight back, + = up), total curl (+ = curls forward over the top),
  // where the curl happens (0 = towards the tip, 1 = near the base),
  // puff 0..1, drawn in front of the body 0..1, stiffness 0..1.
  'tailBase',
  'tailCurl',
  'tailBend',
  'tailPuff',
  'tailFront',
  'tailStiff',
  // Procedural layer controls.
  'purr',
  'lookW',
  'breath',
  'blinkOK',
  'shadow',
  'blush',
] as const;

export type PoseKey = (typeof POSE_KEYS)[number];
export type Pose = Record<PoseKey, number>;

export const LEG_COUNT = 4;
export const LEG_FN = 0;
export const LEG_FF = 1;
export const LEG_BN = 2;
export const LEG_BF = 3;

/** Pose keys of each leg's foot target and paw angle, indexed by leg. */
export const LEG_POSE_KEYS: readonly (readonly [PoseKey, PoseKey, PoseKey])[] = [
  ['fnX', 'fnY', 'fnPaw'],
  ['ffX', 'ffY', 'ffPaw'],
  ['bnX', 'bnY', 'bnPaw'],
  ['bfX', 'bfY', 'bfPaw'],
];

/** Neutral standing pose. Clips start from this and override what they need. */
const BASE: Pose = {
  offX: 0,
  offY: 0,
  sqX: 1,
  sqY: 1,
  rot: 0,
  pivX: 0,
  pivY: -22,
  rollY: 1,
  bodyX: -2,
  bodyY: -23,
  bodyLen: 1,
  bodyH: 1,
  tilt: 0,
  arch: 0,
  curl: 0,
  haunch: 0,
  headX: 21,
  headY: -39,
  headRot: 0,
  faceTurn: 0,
  headFlip: 1,
  earBR: 0,
  earBF: 0,
  earFR: 0,
  earFF: 0,
  eyeOpen: 1,
  eyeSquint: 0,
  eyeHappy: 0,
  lidSlant: 0,
  pupilX: 0.15,
  pupilY: 0,
  pupilSize: 0.62,
  mouthOpen: 0,
  mouthRound: 0,
  tongue: 0,
  whisker: 0,
  fnX: 13,
  fnY: 0,
  fnPaw: 0,
  ffX: 8,
  ffY: 0,
  ffPaw: 0,
  bnX: -12,
  bnY: 0,
  bnPaw: 0,
  bfX: -16.5,
  bfY: 0,
  bfPaw: 0,
  tailBase: 1.15,
  tailCurl: 1.5,
  tailBend: 0,
  tailPuff: 0,
  tailFront: 0,
  tailStiff: 0.55,
  purr: 0,
  lookW: 1,
  breath: 1,
  blinkOK: 1,
  shadow: 1,
  blush: 0,
};

export function createPose(): Pose {
  return { ...BASE };
}

export function resetPose(out: Pose): Pose {
  for (const k of POSE_KEYS) out[k] = BASE[k];
  return out;
}

export function copyPose(out: Pose, src: Pose): Pose {
  for (const k of POSE_KEYS) out[k] = src[k];
  return out;
}

/** out = a + (b - a) * t for every parameter. `out` may alias `a` or `b`. */
export function blendPose(out: Pose, a: Pose, b: Pose, t: number): Pose {
  for (const k of POSE_KEYS) {
    const av = a[k];
    out[k] = av + (b[k] - av) * t;
  }
  return out;
}

export function isPoseFinite(p: Pose): boolean {
  for (const k of POSE_KEYS) if (!Number.isFinite(p[k])) return false;
  return true;
}

/** Replaces non-finite parameters with neutral values; returns how many were fixed. */
export function sanitizePose(p: Pose): number {
  let fixed = 0;
  for (const k of POSE_KEYS) {
    if (!Number.isFinite(p[k])) {
      p[k] = BASE[k];
      fixed++;
    }
  }
  return fixed;
}

export function setFoot(p: Pose, leg: number, x: number, y: number, paw: number): void {
  const keys = LEG_POSE_KEYS[leg];
  if (!keys) return;
  p[keys[0]] = x;
  p[keys[1]] = y;
  p[keys[2]] = paw;
}
