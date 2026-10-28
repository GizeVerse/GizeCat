// Canvas 2D painter for the rig. The caller sets the view transform (anchor, scale,
// facing); everything here is in cat-local DIP. Groups of shapes are drawn as an
// outline pass followed by a fill pass so that overlapping parts merge into one
// clean silhouette with a single exterior outline. No per-frame allocation.
import { clamp, clamp01, lerp, TAU } from './math';
import { LEG_BF, LEG_BN, LEG_FF, LEG_FN, type Pose } from './pose';
import type { CatPuppet } from './puppet';
import { LEG_SPECS, PAW_RX, PAW_RY, TORSO_POINTS, type LegGeom, type Rig } from './rig';
import type { Mark, Skin } from './skins';
import { TAIL_SEGMENTS, type TailChain } from './tail';

export type Ctx2D = CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D;

export interface DrawOptions {
  /** Outline width, cat-local units. */
  outline: number;
  shadow: boolean;
  /** Device pixels per cat-local unit; small values drop fine detail. */
  pixelsPerUnit: number;
}

const DASH_NONE: number[] = [];
const DASH_RING: number[] = [2.4, 3.4];
const DASH_FUR: number[] = [1.1, 1.5];

/** Head outline in head-local DIP (facing right, 3/4 view), closed Catmull-Rom. */
const HEAD_SHAPE = new Float64Array([
  -1, -13.6, 8.6, -12.4, 15.2, -6.4, 17.6, 1.6, 15.6, 8.4, 9.5, 12.6, 1.5, 13.6, -6.5, 12.9, -13.2, 10.4, -17.6, 5.2, -17.2,
  -1.5, -15.2, -7.6, -9.8, -12.4,
]);
const HEAD_POINTS = HEAD_SHAPE.length / 2;

/** Ears: base point 1, tip, base point 2 (head-local, upright). */
const EAR_BACK = [-15.4, -6.2, -14.2, -24.4, -4.4, -12.8] as const;
const EAR_FRONT = [0.8, -13.4, 9.8, -24.0, 12.2, -9.2] as const;

// Scratch buffers.
const TAIL_SAMPLES = TAIL_SEGMENTS * 2 + 1;
const tailPts = new Float64Array(TAIL_SAMPLES * 2);
const tailRad = new Float64Array(TAIL_SAMPLES);
const tailLen = new Float64Array(TAIL_SAMPLES);
const ear = new Float64Array(6);
// Per-call drawing state (set at the start of drawCat; drawing is never re-entrant).
let unit = 1;
let pixelMode = false;

export function drawCat(ctx: Ctx2D, puppet: CatPuppet, skin: Skin, o: DrawOptions): void {
  const rig = puppet.rig;
  const p = puppet.pose;
  const tail = puppet.tail;
  const ol = o.outline;
  const fine = o.pixelsPerUnit >= 0.9;
  unit = 1 / Math.max(1e-3, o.pixelsPerUnit);
  pixelMode = o.pixelsPerUnit < 0.6;

  if (o.shadow) drawShadow(ctx, rig, p);

  ctx.save();
  const m = rig.m;
  ctx.transform(m[0]!, m[1]!, m[2]!, m[3]!, m[4]!, m[5]!);
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  ctx.setLineDash(DASH_NONE);

  if (skin.halo) drawHalo(ctx, puppet, skin.halo, ol);

  // Far legs behind everything.
  ctx.strokeStyle = skin.outline;
  ctx.fillStyle = skin.outline;
  legOutline(ctx, rig.legs[LEG_FF]!, LEG_FF, ol);
  legOutline(ctx, rig.legs[LEG_BF]!, LEG_BF, ol);
  legFill(ctx, rig.legs[LEG_FF]!, LEG_FF, skin.shade);
  legFill(ctx, rig.legs[LEG_BF]!, LEG_BF, skin.shade);
  legDetails(ctx, rig.legs[LEG_FF]!, LEG_FF, skin, true, fine);
  legDetails(ctx, rig.legs[LEG_BF]!, LEG_BF, skin, true, fine);

  if (!tail.front) drawTail(ctx, tail, skin, ol, fine);

  // Body group outline (torso, neck, near legs, haunch) then fills.
  ctx.strokeStyle = skin.outline;
  ctx.lineWidth = ol * 2;
  traceTorso(ctx, rig);
  ctx.stroke();
  if (p.arch > 0.35 || p.tailPuff > 0.35) furFringe(ctx, rig, skin.outline, ol, clamp01(Math.max(p.arch, p.tailPuff)));
  limbStroke(ctx, rig.nx0, rig.ny0, rig.nx1, rig.ny1, rig.neckW + ol * 2, skin.outline);
  legOutline(ctx, rig.legs[LEG_FN]!, LEG_FN, ol);
  traceHaunch(ctx, rig);
  ctx.lineWidth = ol * 2;
  ctx.stroke();
  legOutline(ctx, rig.legs[LEG_BN]!, LEG_BN, ol);

  ctx.fillStyle = skin.coat;
  traceTorso(ctx, rig);
  ctx.fill();
  limbStroke(ctx, rig.nx0, rig.ny0, rig.nx1, rig.ny1, rig.neckW, skin.coat);
  legFill(ctx, rig.legs[LEG_FN]!, LEG_FN, skin.coat);
  torsoMarks(ctx, rig, skin, fine);
  legDetails(ctx, rig.legs[LEG_FN]!, LEG_FN, skin, false, fine);

  // A front paw lifted off the ground (grooming, batting) gets its own outline so it
  // reads in front of the chest; a shoulder patch hides the stroke's root cap.
  const lift = frontLift(rig.legs[LEG_FN]!);
  if (lift > 0.02) {
    const a = ctx.globalAlpha;
    ctx.globalAlpha = a * lift;
    ctx.strokeStyle = skin.outline;
    legOutline(ctx, rig.legs[LEG_FN]!, LEG_FN, ol);
    ctx.globalAlpha = a;
    legFill(ctx, rig.legs[LEG_FN]!, LEG_FN, skin.coat);
    const g = rig.legs[LEG_FN]!;
    ctx.fillStyle = skin.coat;
    ctx.beginPath();
    ctx.arc(g.rx, g.ry, LEG_SPECS[LEG_FN]!.w1 * 0.62, 0, TAU);
    ctx.fill();
    legDetails(ctx, g, LEG_FN, skin, false, fine);
  }

  // Haunch: fill and marks, then a soft contour along its front edge only.
  legFill(ctx, rig.legs[LEG_BN]!, LEG_BN, skin.coat);
  ctx.fillStyle = skin.coat;
  traceHaunch(ctx, rig);
  ctx.fill();
  haunchMarks(ctx, rig, skin, fine);
  legDetails(ctx, rig.legs[LEG_BN]!, LEG_BN, skin, false, fine);
  const ha = 0.22 + 0.78 * clamp01(p.haunch);
  const a0 = ctx.globalAlpha;
  ctx.globalAlpha = a0 * ha;
  ctx.strokeStyle = skin.outline;
  ctx.lineWidth = ol * 1.2;
  ctx.beginPath();
  ctx.ellipse(rig.hx, rig.hy, Math.max(0.5, rig.hrx), Math.max(0.5, rig.hry), rig.hrot, -1.75, lerp(0.55, 1.25, clamp01(p.haunch)));
  ctx.stroke();
  ctx.globalAlpha = a0;

  if (tail.front) drawTail(ctx, tail, skin, ol, fine);

  drawHead(ctx, rig, p, skin, ol, fine);
  ctx.restore();
}

// ---------------------------------------------------------------------------
// Shadow & halo

/** Soft ground shadow under the body (drawn in the view transform, outside the pose matrix). */
export function drawShadow(ctx: Ctx2D, rig: Rig, p: Pose): void {
  const k = clamp(p.shadow, 0, 1.5);
  if (k <= 0.01) return;
  const m = rig.m;
  // Ground point below the posed body centre.
  const cx = m[0]! * rig.bodyX + m[4]!;
  const air = clamp01(-p.offY / 14);
  const w = 27 * k * (1 - 0.35 * air) * Math.abs(m[0]!) + 4;
  const h = 4.2 * k * (1 - 0.3 * air) + 0.8;
  ctx.save();
  ctx.globalAlpha *= 0.2 * Math.min(1, k) * (1 - 0.5 * air);
  ctx.fillStyle = '#000';
  ctx.beginPath();
  ctx.ellipse(cx, -0.6, w, h, 0, 0, TAU);
  ctx.fill();
  ctx.restore();
}

function drawHalo(ctx: Ctx2D, puppet: CatPuppet, color: string, ol: number): void {
  const rig = puppet.rig;
  const extra = ol * 2 + Math.max(1.8, unit * 2);
  ctx.strokeStyle = color;
  ctx.fillStyle = color;
  for (let i = 0; i < 4; i++) {
    const g = rig.legs[i]!;
    const spec = LEG_SPECS[i]!;
    limbStroke(ctx, g.rx, g.ry, g.kx, g.ky, spec.w1 + extra, color);
    limbStroke(ctx, g.kx, g.ky, g.fx, g.fy, spec.w2 + extra, color);
    tracePaw(ctx, g, extra / 2);
    ctx.fill();
  }
  ctx.lineWidth = extra;
  traceTorso(ctx, rig);
  ctx.stroke();
  traceHaunch(ctx, rig);
  ctx.stroke();
  limbStroke(ctx, rig.nx0, rig.ny0, rig.nx1, rig.ny1, rig.neckW + extra, color);
  const tail = puppet.tail;
  sampleTail(tail);
  for (let i = 0; i < TAIL_SAMPLES - 1; i++) {
    limbStroke(ctx, tailPts[i * 2]!, tailPts[i * 2 + 1]!, tailPts[i * 2 + 2]!, tailPts[i * 2 + 3]!, tailRad[i]! * 2 + extra, color);
  }
  ctx.save();
  ctx.translate(rig.headX, rig.headY);
  ctx.rotate(-rig.headRot);
  if (rig.headFlip !== 1) ctx.scale(1, clamp(rig.headFlip, -1, 1));
  ctx.lineWidth = extra;
  traceHead(ctx);
  ctx.stroke();
  ctx.restore();
}

// ---------------------------------------------------------------------------
// Torso & haunch

function traceTorso(ctx: Ctx2D, rig: Rig): void {
  ctx.beginPath();
  traceClosedSpline(ctx, rig.torso, TORSO_POINTS);
}

function traceHaunch(ctx: Ctx2D, rig: Rig): void {
  ctx.beginPath();
  ctx.ellipse(rig.hx, rig.hy, Math.max(0.5, rig.hrx), Math.max(0.5, rig.hry), rig.hrot, 0, TAU);
}

function traceClosedSpline(ctx: Ctx2D, pts: Float64Array, n: number): void {
  ctx.moveTo(pts[0]!, pts[1]!);
  for (let i = 0; i < n; i++) {
    const i0 = ((i - 1 + n) % n) * 2;
    const i1 = i * 2;
    const i2 = ((i + 1) % n) * 2;
    const i3 = ((i + 2) % n) * 2;
    const c1x = pts[i1]! + (pts[i2]! - pts[i0]!) / 6;
    const c1y = pts[i1 + 1]! + (pts[i2 + 1]! - pts[i0 + 1]!) / 6;
    const c2x = pts[i2]! - (pts[i3]! - pts[i1]!) / 6;
    const c2y = pts[i2 + 1]! - (pts[i3 + 1]! - pts[i1 + 1]!) / 6;
    ctx.bezierCurveTo(c1x, c1y, c2x, c2y, pts[i2]!, pts[i2 + 1]!);
  }
  ctx.closePath();
}

/** Spiky fur along the back when bristling (startle/arched). */
function furFringe(ctx: Ctx2D, rig: Rig, color: string, ol: number, k: number): void {
  ctx.save();
  ctx.setLineDash(DASH_FUR);
  ctx.lineCap = 'butt';
  ctx.strokeStyle = color;
  ctx.lineWidth = ol * 2 + 2.6 * k;
  ctx.beginPath();
  const pts = rig.torso;
  ctx.moveTo(pts[0]!, pts[1]!);
  for (let i = 1; i <= 4; i++) ctx.lineTo(pts[i * 2]!, pts[i * 2 + 1]!);
  ctx.stroke();
  ctx.restore();
}

function torsoMarks(ctx: Ctx2D, rig: Rig, skin: Skin, fine: boolean): void {
  ctx.save();
  traceTorso(ctx, rig);
  ctx.clip();
  ctx.translate(rig.bodyX, rig.bodyY);
  ctx.rotate(-Math.atan2(rig.sin, rig.cos));
  const L = rig.L;
  const T = rig.T;
  // Lighter chest and belly.
  ctx.globalAlpha *= skin.lightAlpha;
  ctx.fillStyle = skin.light;
  ctx.beginPath();
  ctx.ellipse(0.42 * L, 0.78 * T, 0.68 * L, 0.5 * T, 0, 0, TAU);
  ctx.fill();
  ctx.globalAlpha /= skin.lightAlpha;
  drawMarks(ctx, skin.marks, 'torso', L, T, fine);
  if (skin.rim) {
    ctx.strokeStyle = skin.rim;
    ctx.lineWidth = 2.2;
    ctx.beginPath();
    ctx.ellipse(0.05 * L, -0.12 * T, 0.86 * L, 0.84 * T, 0, Math.PI * 1.12, Math.PI * 1.88);
    ctx.stroke();
  }
  ctx.restore();
}

function haunchMarks(ctx: Ctx2D, rig: Rig, skin: Skin, fine: boolean): void {
  let any = false;
  for (const mk of skin.marks) if (mk.region === 'haunch') any = true;
  if (!any) return;
  ctx.save();
  traceHaunch(ctx, rig);
  ctx.clip();
  ctx.translate(rig.hx, rig.hy);
  ctx.rotate(rig.hrot);
  drawMarks(ctx, skin.marks, 'haunch', rig.hrx, rig.hry, fine);
  ctx.restore();
}

function drawMarks(ctx: Ctx2D, marks: readonly Mark[], region: Mark['region'], sx: number, sy: number, fine: boolean): void {
  for (const mk of marks) {
    if (mk.region !== region) continue;
    const a = ctx.globalAlpha;
    ctx.globalAlpha = a * mk.alpha;
    if (mk.kind === 'ellipse') {
      ctx.fillStyle = mk.color;
      ctx.beginPath();
      ctx.ellipse(mk.x * sx, mk.y * sy, Math.max(0.1, mk.rx * sx), Math.max(0.1, mk.ry * sy), mk.rot, 0, TAU);
      ctx.fill();
    } else {
      ctx.strokeStyle = mk.color;
      ctx.lineWidth = fine ? mk.width : mk.width * 1.3;
      ctx.beginPath();
      ctx.moveTo(mk.x0 * sx, mk.y0 * sy);
      ctx.quadraticCurveTo(mk.cx * sx, mk.cy * sy, mk.x1 * sx, mk.y1 * sy);
      ctx.stroke();
    }
    ctx.globalAlpha = a;
  }
}

// ---------------------------------------------------------------------------
// Legs

function limbStroke(ctx: Ctx2D, x0: number, y0: number, x1: number, y1: number, width: number, color: string): void {
  ctx.strokeStyle = color;
  ctx.lineWidth = Math.max(0.1, width);
  ctx.beginPath();
  ctx.moveTo(x0, y0);
  ctx.lineTo(x1, y1);
  ctx.stroke();
}

function tracePaw(ctx: Ctx2D, g: LegGeom, grow: number): void {
  const c = Math.cos(g.paw);
  const s = Math.sin(g.paw);
  const ox = PAW_RX * 0.38;
  const oy = -PAW_RY * 0.12;
  ctx.beginPath();
  ctx.ellipse(g.fx + ox * c - oy * s, g.fy + ox * s + oy * c, PAW_RX + grow, PAW_RY + grow, g.paw, 0, TAU);
}

/** 0 while the near front paw is on the ground, 1 once it is lifted well clear of it. */
function frontLift(g: LegGeom): number {
  return clamp01((-g.fy - 5) / 7);
}

function legOutline(ctx: Ctx2D, g: LegGeom, leg: number, ol: number): void {
  const spec = LEG_SPECS[leg]!;
  const color = ctx.strokeStyle;
  ctx.beginPath();
  ctx.lineWidth = spec.w1 + ol * 2;
  ctx.moveTo(g.rx, g.ry);
  ctx.lineTo(g.kx, g.ky);
  ctx.stroke();
  ctx.beginPath();
  ctx.lineWidth = spec.w2 + ol * 2;
  ctx.moveTo(g.kx, g.ky);
  ctx.lineTo(g.fx, g.fy);
  ctx.stroke();
  tracePaw(ctx, g, 0);
  ctx.lineWidth = ol * 2;
  ctx.strokeStyle = color;
  ctx.stroke();
}

function legFill(ctx: Ctx2D, g: LegGeom, leg: number, color: string): void {
  const spec = LEG_SPECS[leg]!;
  limbStroke(ctx, g.rx, g.ry, g.kx, g.ky, spec.w1, color);
  limbStroke(ctx, g.kx, g.ky, g.fx, g.fy, spec.w2, color);
  ctx.fillStyle = color;
  tracePaw(ctx, g, 0);
  ctx.fill();
}

function legDetails(ctx: Ctx2D, g: LegGeom, leg: number, skin: Skin, far: boolean, fine: boolean): void {
  const spec = LEG_SPECS[leg]!;
  if (skin.socks && skin.sockLen > 0) {
    const k = clamp01(skin.sockLen);
    const sx = lerp(g.fx, g.kx, k);
    const sy = lerp(g.fy, g.ky, k);
    const a = ctx.globalAlpha;
    if (far) ctx.globalAlpha = a * 0.82;
    if (k >= 1) {
      // Full points: lower leg and part of the upper leg.
      limbStroke(ctx, lerp(g.kx, g.rx, 0.45), lerp(g.ky, g.ry, 0.45), g.kx, g.ky, spec.w1 - 0.2, skin.socks);
    }
    limbStroke(ctx, sx, sy, g.fx, g.fy, spec.w2, skin.socks);
    ctx.fillStyle = skin.socks;
    tracePaw(ctx, g, 0);
    ctx.fill();
    ctx.globalAlpha = a;
  }
  if (skin.legBands && fine) {
    ctx.strokeStyle = skin.legBands;
    ctx.lineWidth = 1.6;
    const a = ctx.globalAlpha;
    ctx.globalAlpha = a * (far ? 0.6 : 0.85);
    for (let i = 0; i < 2; i++) {
      const t = 0.3 + i * 0.32;
      const cx = lerp(g.kx, g.fx, t);
      const cy = lerp(g.ky, g.fy, t);
      const dx = g.fx - g.kx;
      const dy = g.fy - g.ky;
      const d = Math.hypot(dx, dy) || 1;
      const nx = (-dy / d) * spec.w2 * 0.42;
      const ny = (dx / d) * spec.w2 * 0.42;
      ctx.beginPath();
      ctx.moveTo(cx - nx, cy - ny);
      ctx.lineTo(cx + nx * 0.2, cy + ny * 0.2);
      ctx.stroke();
    }
    ctx.globalAlpha = a;
  }
  if (fine && !far && Math.abs(g.paw) < 0.6) {
    // Toe hints on near paws standing on something.
    ctx.strokeStyle = skin.outline;
    ctx.lineWidth = 0.7;
    const a = ctx.globalAlpha;
    ctx.globalAlpha = a * 0.55;
    const c = Math.cos(g.paw);
    const s = Math.sin(g.paw);
    for (let i = 0; i < 2; i++) {
      const tx = PAW_RX * (0.55 + i * 0.42);
      const x = g.fx + tx * c;
      const y = g.fy + tx * s;
      ctx.beginPath();
      ctx.moveTo(x - s * 0.2, y + c * 0.2 + 1.6);
      ctx.lineTo(x - s * 0.2 + s * 1.4, y + c * 0.2 + 1.6 - c * 1.6);
      ctx.stroke();
    }
    ctx.globalAlpha = a;
  }
}

// ---------------------------------------------------------------------------
// Tail

function sampleTail(tail: TailChain): void {
  const n = tail.count;
  let k = 0;
  for (let i = 0; i < n - 1; i++) {
    const i0 = Math.max(0, i - 1);
    const i2 = i + 1;
    const i3 = Math.min(n - 1, i + 2);
    for (let j = 0; j < 2; j++) {
      const t = j / 2;
      const t2 = t * t;
      const t3 = t2 * t;
      const x0 = tail.x[i0]!;
      const x1 = tail.x[i]!;
      const x2 = tail.x[i2]!;
      const x3 = tail.x[i3]!;
      const y0 = tail.y[i0]!;
      const y1 = tail.y[i]!;
      const y2 = tail.y[i2]!;
      const y3 = tail.y[i3]!;
      tailPts[k * 2] = 0.5 * (2 * x1 + (-x0 + x2) * t + (2 * x0 - 5 * x1 + 4 * x2 - x3) * t2 + (-x0 + 3 * x1 - 3 * x2 + x3) * t3);
      tailPts[k * 2 + 1] = 0.5 * (2 * y1 + (-y0 + y2) * t + (2 * y0 - 5 * y1 + 4 * y2 - y3) * t2 + (-y0 + 3 * y1 - 3 * y2 + y3) * t3);
      tailRad[k] = tail.radius(i + t);
      k++;
    }
  }
  tailPts[k * 2] = tail.x[n - 1]!;
  tailPts[k * 2 + 1] = tail.y[n - 1]!;
  tailRad[k] = tail.radius(n - 1);
  tailLen[0] = 0;
  for (let i = 1; i < TAIL_SAMPLES; i++) {
    tailLen[i] = tailLen[i - 1]! + Math.hypot(tailPts[i * 2]! - tailPts[i * 2 - 2]!, tailPts[i * 2 + 1]! - tailPts[i * 2 - 1]!);
  }
}

function tailSegment(ctx: Ctx2D, i: number, width: number): void {
  ctx.lineWidth = Math.max(0.1, width);
  ctx.beginPath();
  ctx.moveTo(tailPts[i * 2]!, tailPts[i * 2 + 1]!);
  ctx.lineTo(tailPts[i * 2 + 2]!, tailPts[i * 2 + 3]!);
  ctx.stroke();
}

function drawTail(ctx: Ctx2D, tail: TailChain, skin: Skin, ol: number, fine: boolean): void {
  sampleTail(tail);
  const segs = TAIL_SAMPLES - 1;
  ctx.lineCap = 'round';
  ctx.strokeStyle = skin.outline;
  if (tail.puff > 1.05) {
    ctx.save();
    ctx.setLineDash(DASH_FUR);
    ctx.lineCap = 'butt';
    for (let i = 0; i < segs; i++) {
      ctx.lineDashOffset = -tailLen[i]!;
      tailSegment(ctx, i, tailRad[i]! * 2 + ol * 2 + 2.8 * (tail.puff - 1));
    }
    ctx.restore();
    ctx.strokeStyle = skin.outline;
  }
  for (let i = 0; i < segs; i++) tailSegment(ctx, i, tailRad[i]! * 2 + ol * 2);
  ctx.strokeStyle = skin.tail.color;
  for (let i = 0; i < segs; i++) tailSegment(ctx, i, tailRad[i]! * 2);
  const total = tailLen[segs]!;
  if (skin.tail.rings && fine) {
    ctx.save();
    ctx.setLineDash(DASH_RING);
    ctx.lineCap = 'butt';
    ctx.strokeStyle = skin.tail.rings;
    for (let i = 2; i < segs; i++) {
      ctx.lineDashOffset = -tailLen[i]!;
      tailSegment(ctx, i, tailRad[i]! * 2 - 0.4);
    }
    ctx.restore();
  }
  if (skin.tail.tip && skin.tail.tipFrac > 0) {
    ctx.strokeStyle = skin.tail.tip;
    const start = total * (1 - skin.tail.tipFrac);
    for (let i = 0; i < segs; i++) if (tailLen[i + 1]! > start) tailSegment(ctx, i, tailRad[i]! * 2);
  }
  ctx.lineCap = 'round';
}

// ---------------------------------------------------------------------------
// Head

function traceHead(ctx: Ctx2D): void {
  ctx.beginPath();
  traceClosedSpline(ctx, HEAD_SHAPE, HEAD_POINTS);
}

/** Computes an ear (b1, tip, b2) into `ear` after rotation/flattening about its base. */
function earGeom(src: readonly [number, number, number, number, number, number], rotBack: number, flat: number, shiftX: number): void {
  const mx = (src[0] + src[4]) / 2;
  const my = (src[1] + src[5]) / 2;
  const f = clamp01(flat);
  const ang = -(clamp(rotBack, -0.6, 1.2) + f * 0.95);
  const c = Math.cos(ang);
  const s = Math.sin(ang);
  const shrink = 1 - 0.3 * f;
  for (let i = 0; i < 3; i++) {
    const k = i === 1 ? shrink : 1;
    const dx = (src[i * 2]! - mx) * k;
    const dy = (src[i * 2 + 1]! - my) * k;
    ear[i * 2] = mx + dx * c - dy * s + shiftX;
    ear[i * 2 + 1] = my + dx * s + dy * c;
  }
}

function traceEar(ctx: Ctx2D, inset: number): void {
  let b1x = ear[0]!;
  let b1y = ear[1]!;
  let tx = ear[2]!;
  let ty = ear[3]!;
  let b2x = ear[4]!;
  let b2y = ear[5]!;
  if (inset > 0) {
    const cx = (b1x + tx + b2x) / 3;
    const cy = (b1y + ty + b2y) / 3 + 1.5;
    b1x = lerp(b1x, cx, inset);
    b1y = lerp(b1y, cy, inset * 0.6);
    b2x = lerp(b2x, cx, inset);
    b2y = lerp(b2y, cy, inset * 0.6);
    tx = lerp(tx, cx, inset * 0.75);
    ty = lerp(ty, cy, inset * 0.75);
  }
  const k = 0.22;
  const a1x = tx + (b1x - tx) * k;
  const a1y = ty + (b1y - ty) * k;
  const a2x = tx + (b2x - tx) * k;
  const a2y = ty + (b2y - ty) * k;
  ctx.beginPath();
  ctx.moveTo(b1x, b1y);
  ctx.quadraticCurveTo((b1x + a1x) / 2 - (a1y - b1y) * 0.08, (b1y + a1y) / 2 + (a1x - b1x) * 0.08, a1x, a1y);
  ctx.quadraticCurveTo(tx, ty, a2x, a2y);
  ctx.quadraticCurveTo((b2x + a2x) / 2 + (a2y - b2y) * 0.08, (b2y + a2y) / 2 - (a2x - b2x) * 0.08, b2x, b2y);
  ctx.closePath();
}

function drawEar(ctx: Ctx2D, color: string, inner: string, outline: string, ol: number, innerAlpha: number, withOutline: boolean): void {
  if (withOutline) {
    traceEar(ctx, 0);
    ctx.strokeStyle = outline;
    ctx.lineWidth = ol * 2;
    ctx.stroke();
  }
  traceEar(ctx, 0);
  ctx.fillStyle = color;
  ctx.fill();
  if (innerAlpha > 0.02) {
    const a = ctx.globalAlpha;
    ctx.globalAlpha = a * innerAlpha;
    traceEar(ctx, 0.42);
    ctx.fillStyle = inner;
    ctx.fill();
    ctx.globalAlpha = a;
  }
}

type HeadFrame = Pick<Rig, 'headX' | 'headY' | 'headRot' | 'headFlip'>;

/** Draws only the head (ears, face) centred at the head frame; used for app and tray icons. */
export function drawHeadIcon(ctx: Ctx2D, p: Pose, skin: Skin, outline: number, pixelsPerUnit: number): void {
  unit = 1 / Math.max(1e-3, pixelsPerUnit);
  pixelMode = pixelsPerUnit < 0.6;
  ctx.save();
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  ctx.setLineDash(DASH_NONE);
  drawHead(ctx, { headX: 0, headY: 0, headRot: 0, headFlip: 1 }, p, skin, outline, pixelsPerUnit >= 0.9);
  ctx.restore();
}

function drawHead(ctx: Ctx2D, rig: HeadFrame, p: Pose, skin: Skin, ol: number, fine: boolean): void {
  ctx.save();
  ctx.translate(rig.headX, rig.headY);
  ctx.rotate(-rig.headRot);
  const flip = clamp(rig.headFlip, -1, 1);
  if (flip !== 1) ctx.scale(1, flip);
  const turn = clamp(p.faceTurn, -2, 1);
  const earShift = turn * 1.6;

  // Back ear sits behind the head.
  earGeom(EAR_BACK, p.earBR, p.earBF, earShift * 0.6);
  drawEar(ctx, skin.ears[0] ?? skin.coat, skin.earInner, skin.outline, ol, 1 - 0.55 * clamp01(p.earBF), true);

  // Head + front ear outline, then fills.
  ctx.strokeStyle = skin.outline;
  ctx.lineWidth = ol * 2;
  traceHead(ctx);
  ctx.stroke();
  earGeom(EAR_FRONT, p.earFR, p.earFF, earShift);
  traceEar(ctx, 0);
  ctx.stroke();
  ctx.fillStyle = skin.coat;
  traceHead(ctx);
  ctx.fill();
  drawEar(ctx, skin.ears[1] ?? skin.coat, skin.earInner, skin.outline, ol, 1 - 0.55 * clamp01(p.earFF), false);

  // Face position: 3/4 view, features shift with the turn.
  const fx = 3.6 + turn * 4.2;
  const fy = 1.2;

  ctx.save();
  traceHead(ctx);
  ctx.clip();
  drawMarks(ctx, skin.marks, 'head', 1, 1, fine);
  // Light muzzle and chin.
  ctx.fillStyle = skin.light;
  const a0 = ctx.globalAlpha;
  ctx.globalAlpha = a0 * skin.lightAlpha * 0.95;
  ctx.beginPath();
  ctx.ellipse(fx - 1.6, fy + 6.2, 4.2, 3.3, 0, 0, TAU);
  ctx.fill();
  ctx.beginPath();
  ctx.ellipse(fx + 3.4, fy + 6.0, 4.0, 3.2, 0, 0, TAU);
  ctx.fill();
  ctx.beginPath();
  ctx.ellipse(fx + 1.0, fy + 10.6, 5.2, 2.6, 0, 0, TAU);
  ctx.fill();
  ctx.globalAlpha = a0;
  if (skin.rim) {
    ctx.strokeStyle = skin.rim;
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.ellipse(-0.5, 0.5, 15.2, 12.4, 0, Math.PI * 1.08, Math.PI * 1.75);
    ctx.stroke();
  }
  ctx.restore();

  drawFace(ctx, p, skin, fx, fy, ol, fine, turn);
  ctx.restore();
}

function drawFace(ctx: Ctx2D, p: Pose, skin: Skin, fx: number, fy: number, ol: number, fine: boolean, turn: number): void {
  const frontness = clamp01(-turn);
  // Back (left) and front (right) eye; the front eye is foreshortened in 3/4 view.
  const backScale = turn < -1 ? lerp(1, 0.86, clamp01(-turn - 1)) : 1;
  const frontScale = lerp(0.86, 1, frontness) * (turn < -1 ? 1.04 : 1);
  const ex0 = fx - 7.0;
  const ex1 = fx + 6.4;
  const ey = fy - 1.6;
  const lw = Math.max(0.9, ol * 0.75);

  // Blush.
  const blush = clamp01(skin.blush + 0.4 * clamp01(p.blush));
  if (blush > 0.02 && fine) {
    const a = ctx.globalAlpha;
    ctx.globalAlpha = a * blush;
    ctx.fillStyle = '#ff7d8c';
    ctx.beginPath();
    ctx.ellipse(ex0 - 1.2, ey + 6.6, 2.8 * backScale, 1.5, 0, 0, TAU);
    ctx.fill();
    ctx.beginPath();
    ctx.ellipse(ex1 + 1.6, ey + 6.4, 2.5 * frontScale, 1.4, 0, 0, TAU);
    ctx.fill();
    ctx.globalAlpha = a;
  }

  drawEye(ctx, ex0, ey, 3.7 * backScale, 4.5, p, skin, -1, lw);
  drawEye(ctx, ex1, ey, 3.7 * frontScale, 4.4, p, skin, 1, lw);

  // Mouth (under the nose), then the nose on top.
  const nx = fx + 0.6;
  const ny = fy + 4.0;
  const open = clamp01(p.mouthOpen);
  ctx.strokeStyle = skin.outline;
  ctx.lineWidth = lw;
  if (open > 0.05) {
    const round = clamp01(p.mouthRound);
    const h = 1.4 + 6.4 * open;
    const w = lerp(lerp(3.8, 6.6, open), lerp(2.6, 4.4, open), round);
    const my = ny + 1.6 + h / 2;
    ctx.beginPath();
    ctx.ellipse(nx, my, w / 2, h / 2, 0, 0, TAU);
    ctx.fillStyle = skin.mouth;
    ctx.fill();
    ctx.save();
    ctx.clip();
    ctx.fillStyle = skin.tongue;
    ctx.beginPath();
    ctx.ellipse(nx, my + h * 0.36, w * 0.36, h * (0.26 + 0.12 * clamp01(p.tongue)), 0, 0, TAU);
    ctx.fill();
    if (round < 0.5 && open > 0.45 && fine) {
      ctx.fillStyle = '#ffffff';
      for (let side = -1; side <= 1; side += 2) {
        const fxp = nx + side * w * 0.3;
        ctx.beginPath();
        ctx.moveTo(fxp - 0.6, my - h / 2);
        ctx.lineTo(fxp + 0.6, my - h / 2);
        ctx.lineTo(fxp, my - h / 2 + 1.5);
        ctx.closePath();
        ctx.fill();
      }
    }
    ctx.restore();
    ctx.beginPath();
    ctx.ellipse(nx, my, w / 2, h / 2, 0, 0, TAU);
    ctx.stroke();
  } else {
    ctx.beginPath();
    ctx.moveTo(nx, ny + 1.2);
    ctx.lineTo(nx, ny + 2.4);
    ctx.moveTo(nx - 2.9, ny + 2.5);
    ctx.quadraticCurveTo(nx - 1.4, ny + 4.0, nx, ny + 2.4);
    ctx.quadraticCurveTo(nx + 1.4, ny + 4.0, nx + 2.9, ny + 2.5);
    ctx.stroke();
    const tongue = clamp01(p.tongue);
    if (tongue > 0.05) {
      ctx.fillStyle = skin.tongue;
      ctx.beginPath();
      ctx.ellipse(nx + 0.4, ny + 3.6 + 1.0 * tongue, 1.5, 0.9 + 1.4 * tongue, 0, 0, TAU);
      ctx.fill();
      ctx.lineWidth = lw * 0.8;
      ctx.stroke();
    }
  }

  ctx.fillStyle = skin.nose;
  ctx.beginPath();
  ctx.moveTo(nx - 1.9, ny - 1.1);
  ctx.quadraticCurveTo(nx, ny - 1.7, nx + 1.9, ny - 1.1);
  ctx.quadraticCurveTo(nx + 0.4, ny + 1.4, nx, ny + 1.4);
  ctx.quadraticCurveTo(nx - 0.4, ny + 1.4, nx - 1.9, ny - 1.1);
  ctx.closePath();
  ctx.fill();
  ctx.lineWidth = lw * 0.75;
  ctx.stroke();

  if (fine) drawWhiskers(ctx, p, skin, fx, fy, turn);
}

function drawWhiskers(ctx: Ctx2D, p: Pose, skin: Skin, fx: number, fy: number, turn: number): void {
  const a = ctx.globalAlpha;
  ctx.globalAlpha = a * 0.85;
  ctx.strokeStyle = skin.whisker;
  ctx.lineWidth = 0.6;
  const rot = clamp(p.whisker, -0.6, 0.6);
  const c = Math.cos(rot);
  const s = Math.sin(rot);
  const rx = fx + 6.2;
  const ry = fy + 5.0;
  ctx.beginPath();
  for (let i = 0; i < 3; i++) {
    const ex = 12.5 + (i === 1 ? 1 : 0);
    const ey = -3.4 + i * 3.4;
    ctx.moveTo(rx, ry + i * 0.6);
    ctx.quadraticCurveTo(rx + (ex * 0.5) * c, ry + i * 0.6 + (ey * 0.5 - 1.2) - ex * 0.5 * s, rx + ex * c - ey * s, ry + i * 0.6 + ey * c - ex * s);
  }
  const lx = fx - 6.6;
  const back = 1 - 0.4 * clamp01(turn + 1);
  for (let i = 0; i < 2; i++) {
    const ex = -11.5 * back;
    const ey = -2.6 + i * 3.6;
    ctx.moveTo(lx, ry + i * 0.6);
    ctx.quadraticCurveTo(lx + (ex * 0.5) * c, ry + i * 0.6 + (ey * 0.5 - 1.2) + ex * 0.5 * s, lx + ex * c - ey * s, ry + i * 0.6 + ey * c + ex * s);
  }
  ctx.stroke();
  ctx.globalAlpha = a;
}

/**
 * Pixel style: an eye is a crisp block snapped to the low-res pixel grid (sub-pixel
 * ellipses would blur into the coat), with a bright pixel when there is room.
 */
function drawPixelEye(ctx: Ctx2D, cx: number, cy: number, rx: number, ry: number, open: number, skin: Skin): void {
  const m = ctx.getTransform();
  const dx = m.a * cx + m.c * cy + m.e;
  const dy = m.b * cx + m.d * cy + m.f;
  const sx = Math.hypot(m.a, m.b);
  const sy = Math.hypot(m.c, m.d);
  const w = Math.max(1, Math.round(rx * 1.7 * sx));
  const h = Math.max(1, Math.round(ry * 2 * sy * Math.max(0.3, open)));
  const x0 = Math.round(dx - w / 2);
  const y0 = Math.round(dy + ry * sy * 0.9 - h);
  ctx.save();
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.fillStyle = skin.pixelEye ?? skin.pupil;
  ctx.fillRect(x0, y0, w, h);
  if (w >= 2 && h >= 2) {
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(x0, y0, 1, 1);
  }
  ctx.restore();
}

function drawEye(ctx: Ctx2D, cx: number, cy: number, rx: number, ry: number, p: Pose, skin: Skin, side: number, lw: number): void {
  const open = clamp01(p.eyeOpen);
  const happy = clamp01(p.eyeHappy);
  ctx.strokeStyle = skin.outline;
  if (open < 0.16) {
    ctx.lineWidth = lw * 1.25;
    ctx.beginPath();
    if (happy > 0.5) {
      ctx.moveTo(cx - rx * 0.95, cy + 1.0);
      ctx.quadraticCurveTo(cx, cy - ry * 0.95, cx + rx * 0.95, cy + 1.0);
    } else {
      ctx.moveTo(cx - rx * 0.95, cy + 0.2);
      ctx.quadraticCurveTo(cx, cy + ry * 0.75, cx + rx * 0.95, cy + 0.2);
    }
    ctx.stroke();
    return;
  }
  if (pixelMode) {
    drawPixelEye(ctx, cx, cy, rx, ry, open * (1 - 0.5 * clamp01(p.eyeSquint)), skin);
    return;
  }
  const squint = clamp01(p.eyeSquint);
  const slant = clamp01(p.lidSlant);
  // Top lid height at the inner (towards the nose) and outer corners.
  const top = cy - ry + (1 - open) * 2 * ry * 0.92;
  const innerX = side < 0 ? cx + rx : cx - rx;
  const outerX = side < 0 ? cx - rx : cx + rx;
  const innerY = top + slant * ry * 0.75;
  const outerY = top - slant * ry * 0.25;
  const bottom = cy + ry - squint * ry * 0.85;
  const lidded = open < 0.97 || slant > 0.02;

  ctx.save();
  ctx.beginPath();
  ctx.ellipse(cx, cy, rx, ry, 0, 0, TAU);
  ctx.clip();
  ctx.fillStyle = skin.iris;
  ctx.fill();
  const size = clamp01(p.pupilSize);
  const prx = rx * (0.3 + 0.42 * size);
  const pry = ry * (0.64 + 0.26 * size);
  const pdx = clamp(p.pupilX, -1, 1) * (rx - prx) * 0.95;
  const pdy = clamp(p.pupilY, -1, 1) * (ry - pry) * 0.9;
  ctx.fillStyle = skin.pupil;
  ctx.beginPath();
  ctx.ellipse(cx + pdx, cy + pdy, prx, pry, 0, 0, TAU);
  ctx.fill();
  ctx.fillStyle = '#ffffff';
  ctx.beginPath();
  ctx.arc(cx - rx * 0.28 + pdx * 0.3, cy - ry * 0.34 + pdy * 0.2, rx * 0.34, 0, TAU);
  ctx.fill();
  ctx.beginPath();
  ctx.arc(cx + rx * 0.3 + pdx * 0.3, cy + ry * 0.32 + pdy * 0.2, rx * 0.15, 0, TAU);
  ctx.fill();
  if (lidded || squint > 0.02) {
    ctx.fillStyle = skin.lid ?? skin.coat;
    ctx.beginPath();
    ctx.moveTo(cx - rx - 1, cy - ry - 1);
    ctx.lineTo(cx + rx + 1, cy - ry - 1);
    if (side < 0) {
      ctx.lineTo(cx + rx + 1, innerY);
      ctx.lineTo(cx - rx - 1, outerY);
    } else {
      ctx.lineTo(cx + rx + 1, outerY);
      ctx.lineTo(cx - rx - 1, innerY);
    }
    ctx.closePath();
    ctx.fill();
    if (squint > 0.02) {
      ctx.beginPath();
      ctx.moveTo(cx - rx - 1, cy + ry + 1);
      ctx.lineTo(cx + rx + 1, cy + ry + 1);
      ctx.lineTo(cx + rx + 1, bottom);
      ctx.lineTo(cx - rx - 1, bottom);
      ctx.closePath();
      ctx.fill();
    }
  }
  ctx.restore();

  // Outline of the visible part of the eye, plus a firm lid line.
  ctx.save();
  if (lidded || squint > 0.02) {
    ctx.beginPath();
    ctx.moveTo(cx - rx - 2, side < 0 ? outerY : innerY);
    ctx.lineTo(cx + rx + 2, side < 0 ? innerY : outerY);
    ctx.lineTo(cx + rx + 2, bottom);
    ctx.lineTo(cx - rx - 2, bottom);
    ctx.closePath();
    ctx.clip();
  }
  ctx.lineWidth = lw;
  ctx.beginPath();
  ctx.ellipse(cx, cy, rx, ry, 0, 0, TAU);
  ctx.stroke();
  ctx.restore();
  ctx.lineWidth = lw * 1.35;
  ctx.beginPath();
  if (lidded) {
    ctx.save();
    ctx.beginPath();
    ctx.ellipse(cx, cy, rx + lw, ry + lw, 0, 0, TAU);
    ctx.clip();
    ctx.beginPath();
    ctx.moveTo(outerX, outerY);
    ctx.lineTo(innerX, innerY);
    ctx.stroke();
    ctx.restore();
  } else {
    ctx.ellipse(cx, cy, rx, ry, 0, Math.PI * 1.08, Math.PI * 1.92);
    ctx.stroke();
  }
}
