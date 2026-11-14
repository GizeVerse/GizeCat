// Accessory attachment and painting (currently one: the heart pendant necklace). Everything is in
// cat-local DIP, inside the pose matrix drawCat sets, so the necklace follows the body, the turn,
// the roll and every animation. The attachment maths is pure and allocation-free: computeNecklace
// fills a scratch struct, drawNecklace paints it.
import { clamp, clamp01, lerp, TAU } from './math';
import type { Pose } from './pose';
import type { Rig } from './rig';
import type { Ctx2D } from './draw';

export interface NecklaceGeom {
  /** Collar band: end A, end B and the quadratic control point (bowed towards the hang direction). */
  ax: number;
  ay: number;
  bx: number;
  by: number;
  qx: number;
  qy: number;
  /** Where the two chain strands meet (chest). */
  sx: number;
  sy: number;
  /** Heart centre, half-width and rotation (its local +y, the tip, points along the hang direction). */
  hx: number;
  hy: number;
  hw: number;
  ang: number;
  /** Unit hang direction (cat-local). */
  dx: number;
  dy: number;
  /** False when any input was non-finite: nothing is drawn. */
  ok: boolean;
}

export function createNecklaceGeom(): NecklaceGeom {
  return { ax: 0, ay: 0, bx: 0, by: 0, qx: 0, qy: 0, sx: 0, sy: 0, hx: 0, hy: 0, hw: 0, ang: 0, dx: 0, dy: 1, ok: false };
}

/** Palette: chain gold-grey and a red cord with a light edge read on every coat (black too), skin.outline frames them. */
const CHAIN = '#c8a85a';
const CORD = '#c8283e';
const CORD_EDGE = '#f6b3bd';
const HEART = '#e0243c';
const HEART_RIM = '#9d1229';
const HEART_SHINE = '#ffd9de';

// ---------------------------------------------------------------------------
// Attachment metadata. Base values at scale 1, then per-pose adjustments.

/**
 * The collar sits CHIN_GAP DIP below the head silhouette, measured along the neck axis from the
 * head centre (head outline approximated by an ellipse HEAD_RX x HEAD_RY in head-local DIP), and is
 * never moved more than COLLAR_BACK behind the shoulder point so its ends stay inside the neck
 * capsule (radius neckW/2) or the torso top.
 */
const CHIN_GAP = 3.2;
const COLLAR_BACK = 2.5;
const HEAD_RX = 17.4;
const HEAD_RY = 13.6;
/** Chest anchor (torso u, v) the chain meets when the head is tucked onto the chest. */
const CHEST_U = 0.66;
const CHEST_V = 0.3;
/** Max push of the pendant along the hang direction to clear the head silhouette (steps x DIP). */
const PUSH_STEP = 0.75;
const PUSH_STEPS = 14;
/** Base chain drop from the collar to the chest meeting point, and heart half-width (DIP). */
const DROP = 7.5;
const HEART_HW = 4.1;
/** Neck length (DIP) at which the necklace has full size; shorter necks shrink it. */
const NECK_REF = 14;
const DROP_MIN = 4;
const DROP_MAX = 11;
const HW_MIN = 2.4;
const HW_MAX = 4.8;
/** The pendant never hangs further than this from straight belly-side (dot with the belly direction). */
const MIN_BELLY_DOT = 0.3;

/**
 * Per-pose adjustments, one row per pose feature, columns [drop, size]: each is added to 1 in
 * proportion to the feature (0..1).
 *  - curl:   sleeping/curled: the head is tucked onto the chest, so the chain shortens and tightens.
 *  - arch:   arched back (startle): the chest lifts, a slightly shorter drop.
 *  - haunch: sitting: the chest is upright and open, a slightly longer drop.
 *  - down:   head rotated down (headRot < 0): the chin covers more chest, shorter drop.
 *  - lying:  |tilt| large (lying, climbing): a short drop so it does not reach the floor or the wall.
 */
const ADJ_CURL = [-0.5, -0.22] as const;
const ADJ_ARCH = [-0.12, 0] as const;
const ADJ_HAUNCH = [0.08, 0] as const;
const ADJ_DOWN = [-0.18, -0.05] as const;
const ADJ_LYING = [-0.2, -0.05] as const;

const fin = (v: number, d: number): number => (Number.isFinite(v) ? v : d);

/**
 * Computes the necklace for the solved rig `rig` and pose `p` into `out`.
 *
 * Hang direction: the belly side of the torso (rig.sin, rig.cos) blended with world-down (mapped
 * back through the pose matrix) when the body is tilted (lying on a side, climbing) or belly-up
 * (headFlip < 0), then kept within MIN_BELLY_DOT of the belly direction so it always lies on the chest.
 */
export function computeNecklace(rig: Rig, p: Pose, out: NecklaceGeom): void {
  // Neck axis; a degenerate capsule falls back to the shoulder->head direction, then to straight up.
  let nx = rig.nx1 - rig.nx0;
  let ny = rig.ny1 - rig.ny0;
  let len = Math.hypot(nx, ny);
  if (!(len > 1e-3)) {
    nx = rig.headX - rig.nx0;
    ny = rig.headY - rig.ny0;
    const hl = Math.hypot(nx, ny);
    if (hl > 1e-3) {
      nx /= hl;
      ny /= hl;
    } else {
      nx = 0;
      ny = -1;
    }
    len = 0;
  } else {
    nx /= len;
    ny /= len;
  }

  const curl = clamp01(fin(p.curl, 0));
  const arch = clamp(fin(p.arch, 0), 0, 1);
  const haunch = clamp01(fin(p.haunch, 0));
  const down = clamp01(-fin(p.headRot, 0) / 0.8);
  const tilt = fin(p.tilt, 0);
  const lying = clamp01((Math.abs(tilt) - 0.35) / 0.8);
  const short = clamp01(len / NECK_REF);
  const neckScale = lerp(0.6, 1, short);
  const ws = clamp(fin(rig.neckW, 15) / 15, 0.8, 1.3);

  const dropK = clamp(1 + curl * ADJ_CURL[0] + arch * ADJ_ARCH[0] + haunch * ADJ_HAUNCH[0] + down * ADJ_DOWN[0] + lying * ADJ_LYING[0], 0.35, 1.2);
  const sizeK = clamp(1 + curl * ADJ_CURL[1] + arch * ADJ_ARCH[1] + haunch * ADJ_HAUNCH[1] + down * ADJ_DOWN[1] + lying * ADJ_LYING[1], 0.6, 1.1);
  // Hang direction. World-down (0, 1) expressed in cat-local coordinates: M^-1 (0, 1) = (-c, a) / det.
  const bx = rig.sin;
  const by = rig.cos;
  let hx = bx;
  let hy = by;
  let w = clamp01((Math.abs(tilt) - 0.25) / 0.6) * 0.7;
  let minDot = MIN_BELLY_DOT;
  const flipped = fin(p.headFlip, 1) < 0;
  {
    const m = rig.m;
    const a = m[0]!;
    const b = m[1]!;
    const c = m[2]!;
    const d = m[3]!;
    const det = a * d - b * c;
    if (Math.abs(det) > 1e-4) {
      let gx = -c / det;
      let gy = a / det;
      const gl = Math.hypot(gx, gy);
      if (gl > 1e-6) {
        gx /= gl;
        gy /= gl;
        // Belly turned away from the ground (rolled over, headFlip < 0): gravity wins, the pendant
        // hangs world-down even though that is the back side of the torso.
        const gb = gx * bx + gy * by;
        const r = flipped ? 1 : clamp01((0.2 - gb) / 0.6);
        if (r > 0) {
          w = Math.max(w, 0.7 + 0.3 * r);
          minDot = lerp(MIN_BELLY_DOT, -1, r);
        }
        if (w > 0) {
          hx = bx * (1 - w) + gx * w;
          hy = by * (1 - w) + gy * w;
        }
      }
    }
  }
  const dot = hx * bx + hy * by;
  if (dot < minDot) {
    hx += bx * (minDot - dot);
    hy += by * (minDot - dot);
  }
  const hl = Math.hypot(hx, hy);
  if (hl > 1e-6) {
    hx /= hl;
    hy /= hl;
  } else {
    hx = bx;
    hy = by;
  }

  // Collar across the neck, perpendicular to its axis, bowed towards the chest.
  // Head frame: the head outline is an ellipse in head-local space (x axis (cos r, -sin r), y axis (sin r, cos r)).
  const headX = fin(rig.headX, rig.nx0);
  const headY = fin(rig.headY, rig.ny0);
  const hr = fin(rig.headRot, 0);
  const hcos = Math.cos(hr);
  const hsin = Math.sin(hr);
  // Ellipse radius from the head centre towards the shoulder (-neck axis).
  const rl = -nx * hcos + ny * hsin;
  const rm = -nx * hsin - ny * hcos;
  const rad = 1 / Math.sqrt((rl / HEAD_RX) ** 2 + (rm / HEAD_RY) ** 2);
  // Collar: CHIN_GAP below the chin along the neck axis, measured from the shoulder point.
  const sT = Math.hypot(headX - rig.nx0, headY - rig.ny0) - rad - CHIN_GAP;
  const sd = clamp(sT, -COLLAR_BACK, Math.max(0, len));
  // Head tucked onto the chest (short visible neck): the chain meets the chest instead.
  const tuck = clamp01((-COLLAR_BACK - sT) / 4);
  const cx = rig.nx0 + nx * sd;
  const cy = rig.ny0 + ny * sd;
  const half = clamp(fin(rig.neckW, 15) * 0.46, 5, 11);
  const qx = -ny;
  const qy = nx;
  out.ax = cx - qx * half;
  out.ay = cy - qy * half;
  out.bx = cx + qx * half;
  out.by = cy + qy * half;
  const sag = 2.2 * ws;
  out.qx = cx + hx * sag * 2;
  out.qy = cy + hy * sag * 2;

  // Chain meeting point and pendant.
  const drop = clamp(DROP * dropK * neckScale * ws, DROP_MIN, DROP_MAX);
  let sx = cx + hx * drop;
  let sy = cy + hy * drop;
  if (tuck > 0) {
    sx = lerp(sx, rig.tx(CHEST_U, CHEST_V), tuck);
    sy = lerp(sy, rig.ty(CHEST_U, CHEST_V), tuck);
    const ddx = sx - cx;
    const ddy = sy - cy;
    if (!(Math.hypot(ddx, ddy) >= DROP_MIN)) {
      sx = cx + hx * DROP_MIN;
      sy = cy + hy * DROP_MIN;
    }
  }
  const hw = clamp(HEART_HW * sizeK * neckScale * ws, HW_MIN, HW_MAX);
  // Never let the heart lie inside the head silhouette (the head is drawn last): push the chain
  // meeting point along the hang direction until the heart clears the inflated head ellipse.
  const ex = HEAD_RX + hw * 0.9 + 0.6;
  const ey = HEAD_RY + hw * 0.9 + 0.6;
  let hcx = sx + hx * hw * 0.7;
  let hcy = sy + hy * hw * 0.7;
  for (let i = 0; i < PUSH_STEPS; i++) {
    const ddx = hcx - headX;
    const ddy = hcy - headY;
    const lx = ddx * hcos - ddy * hsin;
    const ly = ddx * hsin + ddy * hcos;
    if ((lx / ex) ** 2 + (ly / ey) ** 2 >= 1) break;
    sx += hx * PUSH_STEP;
    sy += hy * PUSH_STEP;
    hcx += hx * PUSH_STEP;
    hcy += hy * PUSH_STEP;
  }
  out.sx = sx;
  out.sy = sy;
  out.hw = hw;
  out.hx = hcx;
  out.hy = hcy;
  out.ang = Math.atan2(hy, hx) - Math.PI / 2;
  out.dx = hx;
  out.dy = hy;
  out.ok =
    Number.isFinite(out.ax) &&
    Number.isFinite(out.ay) &&
    Number.isFinite(out.bx) &&
    Number.isFinite(out.by) &&
    Number.isFinite(out.qx) &&
    Number.isFinite(out.qy) &&
    Number.isFinite(out.sx) &&
    Number.isFinite(out.sy) &&
    Number.isFinite(out.hx) &&
    Number.isFinite(out.hy) &&
    Number.isFinite(out.ang);
}

/**
 * Paints the necklace: collar cord, two chain strands, then the heart. Each part is an outline
 * stroke in `outline` (so it matches every coat) under its own colour. Pixel mode (< 0.6 device
 * px per unit) uses a polygon heart without rim or highlight.
 */
export function drawNecklace(ctx: Ctx2D, g: NecklaceGeom, outline: string, ol: number, pixelsPerUnit: number): void {
  if (!g.ok) return;
  const pixel = pixelsPerUnit < 0.6;
  const px = 1 / Math.max(1e-3, pixelsPerUnit);
  const chainW = Math.max(1, 1.1 * px);
  const cordW = Math.max(2, 2.2 * Math.max(1, px * 0.9));
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';

  // Collar cord.
  ctx.beginPath();
  ctx.moveTo(g.ax, g.ay);
  ctx.quadraticCurveTo(g.qx, g.qy, g.bx, g.by);
  ctx.strokeStyle = outline;
  ctx.lineWidth = cordW + ol * 1.2;
  ctx.stroke();
  ctx.strokeStyle = CORD_EDGE;
  ctx.lineWidth = cordW;
  ctx.stroke();
  ctx.strokeStyle = CORD;
  ctx.lineWidth = cordW * 0.6;
  ctx.stroke();

  // Chain: two strands from the collar ends meeting at the chest, sagging a little outwards.
  const mx = (g.ax + g.sx) / 2 + g.dx * 1.2;
  const my = (g.ay + g.sy) / 2 + g.dy * 1.2;
  const nx2 = (g.bx + g.sx) / 2 + g.dx * 1.2;
  const ny2 = (g.by + g.sy) / 2 + g.dy * 1.2;
  ctx.beginPath();
  ctx.moveTo(g.ax, g.ay);
  ctx.quadraticCurveTo(mx, my, g.sx, g.sy);
  ctx.quadraticCurveTo(nx2, ny2, g.bx, g.by);
  ctx.strokeStyle = outline;
  ctx.lineWidth = chainW + ol * 0.8;
  ctx.stroke();
  ctx.strokeStyle = CHAIN;
  ctx.lineWidth = chainW;
  ctx.stroke();

  // Heart: the tip points along the hang direction. Drawn in a local frame, restored right after.
  const w = g.hw;
  ctx.save();
  ctx.translate(g.hx, g.hy);
  ctx.rotate(g.ang);
  ctx.beginPath();
  if (pixel) {
    ctx.moveTo(0, 0.95 * w);
    ctx.lineTo(-w, -0.05 * w);
    ctx.lineTo(-0.8 * w, -0.75 * w);
    ctx.lineTo(-0.25 * w, -0.8 * w);
    ctx.lineTo(0, -0.35 * w);
    ctx.lineTo(0.25 * w, -0.8 * w);
    ctx.lineTo(0.8 * w, -0.75 * w);
    ctx.lineTo(w, -0.05 * w);
  } else {
    ctx.moveTo(0, 0.95 * w);
    ctx.bezierCurveTo(-0.35 * w, 0.6 * w, -w, 0.2 * w, -w, -0.3 * w);
    ctx.bezierCurveTo(-w, -0.8 * w, -0.2 * w, -0.9 * w, 0, -0.4 * w);
    ctx.bezierCurveTo(0.2 * w, -0.9 * w, w, -0.8 * w, w, -0.3 * w);
    ctx.bezierCurveTo(w, 0.2 * w, 0.35 * w, 0.6 * w, 0, 0.95 * w);
  }
  ctx.closePath();
  ctx.strokeStyle = outline;
  ctx.lineWidth = Math.max(1, ol * 1.5);
  ctx.stroke();
  ctx.fillStyle = HEART;
  ctx.fill();
  if (!pixel) {
    ctx.strokeStyle = HEART_RIM;
    ctx.lineWidth = 0.8;
    ctx.stroke();
    ctx.globalAlpha *= 0.75;
    ctx.fillStyle = HEART_SHINE;
    ctx.beginPath();
    ctx.ellipse(-0.45 * w, -0.4 * w, 0.22 * w, 0.14 * w, -0.6, 0, TAU);
    ctx.fill();
  }
  ctx.restore();
}
