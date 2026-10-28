// Skeleton solver: turns a Pose into concrete geometry (torso outline, leg joints via
// two-bone IK, haunch, neck, head frame, tail root and the global pose matrix).
// Pure math, no DOM, no per-frame allocation.
import { clamp, lerp } from './math';
import { LEG_COUNT, LEG_POSE_KEYS, type Pose } from './pose';

export const TORSO_L = 21;
export const TORSO_T = 10.5;
export const HEAD_RX = 17;
export const HEAD_RY = 13.5;
export const OUTLINE_W = 1.6;

/** Max rubber-hose stretch of a leg when its target is out of reach. */
const MAX_LEG_STRETCH = 1.14;

export interface LegSpec {
  /** Root position in torso units (u along the body, v towards the belly). */
  u: number;
  v: number;
  upper: number;
  lower: number;
  /** Stroke widths of the upper and lower segment. */
  w1: number;
  w2: number;
  front: boolean;
  far: boolean;
}

export const LEG_SPECS: readonly LegSpec[] = [
  { u: 0.6, v: 0.38, upper: 10, lower: 10, w1: 8.8, w2: 7.6, front: true, far: false },
  { u: 0.42, v: 0.3, upper: 10, lower: 10, w1: 8.2, w2: 7.2, front: true, far: true },
  { u: -0.5, v: 0.42, upper: 9.8, lower: 10.4, w1: 9.4, w2: 7.8, front: false, far: false },
  { u: -0.66, v: 0.32, upper: 9.8, lower: 10.4, w1: 8.8, w2: 7.4, front: false, far: true },
];

/** Paw ellipse radii. */
export const PAW_RX = 4.6;
export const PAW_RY = 3.1;

// Torso outline control points: [u, v, archDv, curlDu, curlDv] in torso units.
// Arch lifts the back and the belly in the middle; curl rounds the shape (sleeping).
const TORSO_SHAPE: readonly (readonly [number, number, number, number, number])[] = [
  [-0.84, -0.74, -0.25, 0.08, -0.12], // rear top
  [-0.42, -0.98, -0.75, 0.04, -0.12], // back rear
  [0.04, -1.0, -1.0, 0.0, -0.1], // back middle
  [0.46, -0.96, -0.6, -0.04, -0.06], // back front
  [0.84, -0.74, -0.15, -0.1, 0.0], // shoulder
  [1.04, -0.08, 0.0, -0.12, 0.06], // chest front
  [0.86, 0.66, 0.0, -0.1, 0.16], // chest bottom
  [0.4, 0.96, -0.5, -0.04, 0.12], // belly front
  [-0.06, 1.02, -0.85, 0.0, 0.08], // belly middle
  [-0.52, 0.94, -0.45, 0.06, 0.1], // belly rear
  [-0.9, 0.62, -0.1, 0.1, 0.16], // rear bottom
  [-1.04, -0.06, 0.0, 0.14, 0.02], // rear
];
export const TORSO_POINTS = TORSO_SHAPE.length;

export interface LegGeom {
  rx: number;
  ry: number;
  kx: number;
  ky: number;
  fx: number;
  fy: number;
  paw: number;
  /** Effective segment lengths after stretch. */
  a: number;
  b: number;
}

/** 2x3 affine matrix [a, b, c, d, e, f]: x' = a x + c y + e, y' = b x + d y + f. */
export type Mat = Float64Array;

export function applyMatX(m: Mat, x: number, y: number): number {
  return m[0]! * x + m[2]! * y + m[4]!;
}
export function applyMatY(m: Mat, x: number, y: number): number {
  return m[1]! * x + m[3]! * y + m[5]!;
}

export class Rig {
  /** Torso outline, interleaved x,y. */
  readonly torso = new Float64Array(TORSO_POINTS * 2);
  readonly legs: LegGeom[] = [];
  /** Global pose matrix (cat-local -> posed cat space). */
  readonly m: Mat = new Float64Array([1, 0, 0, 1, 0, 0]);

  // Torso frame
  cos = 1;
  sin = 0;
  L = TORSO_L;
  T = TORSO_T;
  bodyX = 0;
  bodyY = 0;

  // Haunch ellipse
  hx = 0;
  hy = 0;
  hrx = 0;
  hry = 0;
  hrot = 0;

  // Neck capsule
  nx0 = 0;
  ny0 = 0;
  nx1 = 0;
  ny1 = 0;
  neckW = 15;

  // Head frame
  headX = 0;
  headY = 0;
  headRot = 0;
  headFlip = 1;

  tailRootX = 0;
  tailRootY = 0;

  constructor() {
    for (let i = 0; i < LEG_COUNT; i++) this.legs.push({ rx: 0, ry: 0, kx: 0, ky: 0, fx: 0, fy: 0, paw: 0, a: 0, b: 0 });
  }

  /** Torso-local (u, v) in torso units -> cat-local x. */
  tx(u: number, v: number): number {
    return this.bodyX + u * this.L * this.cos + v * this.T * this.sin;
  }
  ty(u: number, v: number): number {
    return this.bodyY - u * this.L * this.sin + v * this.T * this.cos;
  }

  solve(p: Pose): void {
    const curl = clamp(p.curl, 0, 1);
    const arch = clamp(p.arch, -0.5, 1.2);
    this.cos = Math.cos(p.tilt);
    this.sin = Math.sin(p.tilt);
    this.L = TORSO_L * clamp(p.bodyLen, 0.5, 1.6) * (1 - 0.16 * curl);
    this.T = TORSO_T * clamp(p.bodyH, 0.5, 1.8) * (1 + 0.42 * curl);
    this.bodyX = p.bodyX;
    this.bodyY = p.bodyY;

    for (let i = 0; i < TORSO_POINTS; i++) {
      const s = TORSO_SHAPE[i]!;
      let u = s[0] + s[3] * curl;
      let v = s[1] + s[2] * arch * 0.9 + s[4] * curl;
      // Curl flattens the belly onto the ground and domes the back.
      if (v > 0) v *= 1 - 0.22 * curl;
      else u *= 1 - 0.05 * curl;
      this.torso[i * 2] = this.tx(u, v);
      this.torso[i * 2 + 1] = this.ty(u, v);
    }

    // Haunch: a thigh oval at the rear, bigger and rounder when sitting.
    const h = clamp(p.haunch, 0, 1);
    const hu = lerp(-0.5, -0.46, h);
    const hv = lerp(0.18, 0.2, h);
    this.hx = this.tx(hu, hv);
    this.hy = this.ty(hu, hv);
    this.hrx = this.L * lerp(0.44, 0.5, h);
    this.hry = this.T * lerp(0.74, 1.02, h);
    // Visual counter-clockwise rotation of the oval: follows the body, but more upright when sitting.
    this.hrot = -p.tilt * lerp(1, 0.25, h) - lerp(0.25, 0.1, h);

    for (let i = 0; i < LEG_COUNT; i++) {
      const spec = LEG_SPECS[i]!;
      const keys = LEG_POSE_KEYS[i]!;
      const g = this.legs[i]!;
      let ru = spec.u;
      let rv = spec.v;
      if (!spec.front) {
        // Hind legs emerge from the bottom-front of the haunch.
        ru = lerp(spec.u, spec.u + 0.12, h);
        rv = lerp(spec.v, spec.v + 0.15, h);
      }
      solveLeg(g, this.tx(ru, rv), this.ty(ru, rv), p[keys[0]], p[keys[1]], spec.upper, spec.lower);
      g.paw = p[keys[2]];
    }

    this.headX = p.headX;
    this.headY = p.headY;
    this.headRot = p.headRot;
    this.headFlip = p.headFlip;

    // Neck: from the shoulder top towards the head, so head and body never detach.
    this.nx0 = this.tx(0.62, -0.3);
    this.ny0 = this.ty(0.62, -0.3);
    const dx = p.headX - this.nx0;
    const dy = p.headY - this.ny0;
    const len = Math.hypot(dx, dy);
    const reach = Math.max(0, len - 6);
    const k = len > 1e-6 ? reach / len : 0;
    this.nx1 = this.nx0 + dx * k;
    this.ny1 = this.ny0 + dy * k;
    this.neckW = 15 + 3 * curl;

    const tv = lerp(-0.42, 0.4, clamp(p.tailFront, 0, 1));
    this.tailRootX = this.tx(-0.88, tv);
    this.tailRootY = this.ty(-0.88, tv);

    computePoseMatrix(this.m, p);
  }
}

/** Two-bone IK. The middle joint bends towards the back (-x) for downward legs. */
export function solveLeg(g: LegGeom, rx: number, ry: number, tx: number, ty: number, upper: number, lower: number): void {
  g.rx = rx;
  g.ry = ry;
  let dx = tx - rx;
  let dy = ty - ry;
  let d = Math.hypot(dx, dy);
  if (!(d > 1e-6) || !Number.isFinite(d)) {
    dx = 0;
    dy = 1;
    d = 1e-6;
  }
  const reach = upper + lower;
  const stretch = d > reach * 0.995 ? Math.min(d / (reach * 0.995), MAX_LEG_STRETCH) : 1;
  const a = upper * stretch;
  const b = lower * stretch;
  const dc = clamp(d, Math.abs(a - b) + 1e-3, (a + b) * 0.995);
  const base = Math.atan2(dy, dx);
  const cosA = clamp((a * a + dc * dc - b * b) / (2 * a * dc), -1, 1);
  const ka = base + Math.acos(cosA);
  g.kx = rx + a * Math.cos(ka);
  g.ky = ry + a * Math.sin(ka);
  const fa = Math.atan2(ty - g.ky, tx - g.kx);
  g.fx = g.kx + b * Math.cos(fa);
  g.fy = g.ky + b * Math.sin(fa);
  g.a = a;
  g.b = b;
}

/**
 * Global pose matrix: roll (y-scale) and rotation about the pivot, then squash about
 * the ground anchor, then offset.
 */
export function computePoseMatrix(m: Mat, p: Pose): void {
  const c = Math.cos(p.rot);
  const s = Math.sin(p.rot);
  const ry = clamp(p.rollY, -1, 1);
  const sx = clamp(p.sqX, 0.3, 2);
  const sy = clamp(p.sqY, 0.3, 2);
  const px = p.pivX;
  const py = p.pivY;
  m[0] = sx * c;
  m[1] = -sy * s;
  m[2] = sx * s * ry;
  m[3] = sy * c * ry;
  m[4] = sx * (px - c * px - s * ry * py) + p.offX;
  m[5] = sy * (py + s * px - c * ry * py) + p.offY;
}

/** Torso point for clip authoring (same frame as Rig.solve), without a Rig instance. */
export function torsoPointX(p: Pose, u: number, v: number): number {
  const L = TORSO_L * clamp(p.bodyLen, 0.5, 1.6) * (1 - 0.16 * clamp(p.curl, 0, 1));
  const T = TORSO_T * clamp(p.bodyH, 0.5, 1.8) * (1 + 0.42 * clamp(p.curl, 0, 1));
  return p.bodyX + u * L * Math.cos(p.tilt) + v * T * Math.sin(p.tilt);
}
export function torsoPointY(p: Pose, u: number, v: number): number {
  const L = TORSO_L * clamp(p.bodyLen, 0.5, 1.6) * (1 - 0.16 * clamp(p.curl, 0, 1));
  const T = TORSO_T * clamp(p.bodyH, 0.5, 1.8) * (1 + 0.42 * clamp(p.curl, 0, 1));
  return p.bodyY - u * L * Math.sin(p.tilt) + v * T * Math.cos(p.tilt);
}
