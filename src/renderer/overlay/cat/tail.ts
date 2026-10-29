// Tail: a Verlet spring chain pulled towards the pose's target shape. Lags behind body
// motion, overshoots a little and stays stable for any frame time (fixed sub-steps,
// reset on long gaps or non-finite state).
import { clamp, lerp } from './math';
import type { Pose } from './pose';

export const TAIL_SEGMENTS = 10;
export const TAIL_SEG_LEN = 3.7;
export const TAIL_RADIUS_BASE = 3.9;
export const TAIL_RADIUS_TIP = 3.2;

const POINTS = TAIL_SEGMENTS + 1;
const STEP_S = 1 / 120;
const MAX_STEPS = 30;
/** Gaps longer than this (ms) snap the tail to its target instead of simulating. */
const RESET_GAP_MS = 250;
/** Larger per-frame body displacement (cat-local DIP) is a teleport, not motion. */
const MAX_SHIFT = 40;
/**
 * The ground clamp is hard, but a ground line that appears (landing, stopping after a jump) or moves
 * up by more than GROUND_JUMP DIP in one frame (pulling up onto a ledge) starts at the tail's deepest
 * point and rises to its height at GROUND_RISE_DIP_S, so the tail is lifted out smoothly instead of
 * snapping (about 4 DIP per 60 Hz frame).
 */
const GROUND_JUMP = 1.5;
const GROUND_RISE_DIP_S = 240;
/** Max free-point speed (DIP/s) from inertia and target pull; root drag is not limited. */
const MAX_SPEED = 600;

export class TailChain {
  readonly x = new Float64Array(POINTS);
  readonly y = new Float64Array(POINTS);
  private readonly px = new Float64Array(POINTS);
  private readonly py = new Float64Array(POINTS);
  readonly tx = new Float64Array(POINTS);
  readonly ty = new Float64Array(POINTS);
  private ready = false;
  /** The clamp line in effect (cat-local y): at or below the requested ground, rising to it; NaN for none. */
  private groundLine = Number.NaN;
  private lastGroundY = Number.NaN;
  /** Tail radius multiplier from puff (1 = normal). */
  puff = 1;
  front = false;

  get count(): number {
    return POINTS;
  }

  reset(): void {
    this.ready = false;
  }

  /**
   * Advances the chain.
   * @param shiftX,shiftY displacement to apply to free points this frame (cat-local), i.e.
   *   minus the body's world motion, so the tail lags behind movement.
   * @param groundY clamp free points above this y (cat-local), or NaN for no clamp.
   */
  step(rootX: number, rootY: number, p: Pose, dtMs: number, shiftX: number, shiftY: number, groundY: number): void {
    this.computeTarget(rootX, rootY, p.tailBase, p.tailCurl, p.tailBend);
    this.puff = 1 + 0.55 * clamp(p.tailPuff, 0, 1);
    this.front = p.tailFront > 0.5;

    const valid = Number.isFinite(dtMs) && dtMs > 0;
    if (!this.ready || (valid && dtMs > RESET_GAP_MS) || !Number.isFinite(rootX) || !Number.isFinite(rootY)) {
      this.snapToTarget();
      this.constrain(groundY);
      this.lastGroundY = groundY;
      this.groundLine = groundY;
      for (let i = 0; i < POINTS; i++) {
        this.px[i] = this.x[i]!;
        this.py[i] = this.y[i]!;
      }
      return;
    }
    this.x[0] = rootX;
    this.y[0] = rootY;
    this.px[0] = rootX;
    this.py[0] = rootY;
    if (!valid) return;

    if (Number.isFinite(shiftX) && Number.isFinite(shiftY) && Math.abs(shiftX) + Math.abs(shiftY) < MAX_SHIFT) {
      for (let i = 1; i < POINTS; i++) {
        this.x[i] = this.x[i]! + shiftX;
        this.y[i] = this.y[i]! + shiftY;
        this.px[i] = this.px[i]! + shiftX;
        this.py[i] = this.py[i]! + shiftY;
      }
    }

    const stiff = clamp(p.tailStiff, 0, 1);
    const pullRate = 10 + 46 * stiff;
    const gravity = 60 * (1 - stiff);
    const steps = Math.min(MAX_STEPS, Math.max(1, Math.ceil(dtMs / 1000 / STEP_S)));
    const h = dtMs / 1000 / steps;
    const keep = Math.exp(-5 * h);
    const maxMove = MAX_SPEED * h;
    // The clamp line: a new or raised ground starts under the tail's deepest point and rises; a
    // lower one applies at once (it never moves a point).
    if (!Number.isFinite(groundY)) {
      this.groundLine = Number.NaN;
    } else if (!Number.isFinite(this.groundLine) || groundY < this.lastGroundY - GROUND_JUMP) {
      this.groundLine = Math.max(groundY, this.deepestY());
    } else {
      this.groundLine = Math.max(groundY, this.groundLine);
    }
    this.lastGroundY = groundY;
    const rise = GROUND_RISE_DIP_S * h;
    for (let s = 0; s < steps; s++) {
      for (let i = 1; i < POINTS; i++) {
        const cx = this.x[i]!;
        const cy = this.y[i]!;
        let nx = cx + (cx - this.px[i]!) * keep;
        let ny = cy + (cy - this.py[i]!) * keep + gravity * h * h;
        const frac = i / TAIL_SEGMENTS;
        const k = 1 - Math.exp(-pullRate * (1 - 0.6 * frac) * h);
        nx += (this.tx[i]! - nx) * k;
        ny += (this.ty[i]! - ny) * k;
        // Cap the free motion per sub-step so violent target swings whip, not teleport.
        const mx = nx - cx;
        const my = ny - cy;
        const m = Math.hypot(mx, my);
        if (m > maxMove) {
          nx = cx + (mx / m) * maxMove;
          ny = cy + (my / m) * maxMove;
        }
        this.px[i] = cx;
        this.py[i] = cy;
        this.x[i] = nx;
        this.y[i] = ny;
      }
      if (this.groundLine > groundY) this.groundLine = Math.max(groundY, this.groundLine - rise);
      this.constrain(this.groundLine);
    }

    for (let i = 1; i < POINTS; i++) {
      if (!Number.isFinite(this.x[i]!) || !Number.isFinite(this.y[i]!)) {
        this.snapToTarget();
        return;
      }
    }
  }

  /** Deepest (largest y) free point, -Infinity when none is finite. */
  private deepestY(): number {
    let y = Number.NEGATIVE_INFINITY;
    for (let i = 1; i < POINTS; i++) if (this.y[i]! > y) y = this.y[i]!;
    return y;
  }

  /** Restores the segment lengths and keeps free points at or above `groundY` (NaN: no clamp). */
  private constrain(groundY: number): void {
    for (let i = 1; i < POINTS; i++) {
      const ax = this.x[i - 1]!;
      const ay = this.y[i - 1]!;
      let dx = this.x[i]! - ax;
      let dy = this.y[i]! - ay;
      let d = Math.hypot(dx, dy);
      if (!(d > 1e-6)) {
        dx = this.tx[i]! - this.tx[i - 1]!;
        dy = this.ty[i]! - this.ty[i - 1]!;
        d = Math.hypot(dx, dy) || 1;
      }
      let nx = ax + (dx / d) * TAIL_SEG_LEN;
      let ny = ay + (dy / d) * TAIL_SEG_LEN;
      if (Number.isFinite(groundY) && ny > groundY) {
        // Onto the ground line, keeping the segment length exact.
        const gy = groundY - ay;
        if (Math.abs(gy) < TAIL_SEG_LEN) {
          ny = ay + gy;
          nx = ax + (dx >= 0 ? 1 : -1) * Math.sqrt(TAIL_SEG_LEN * TAIL_SEG_LEN - gy * gy);
        }
      }
      this.x[i] = nx;
      this.y[i] = ny;
    }
  }

  private computeTarget(rootX: number, rootY: number, base: number, curl: number, bend: number): void {
    const a0 = Math.PI + clamp(Number.isFinite(base) ? base : 1, -3.2, 3.2);
    const c = clamp(Number.isFinite(curl) ? curl : 0, -5, 5);
    this.tx[0] = rootX;
    this.ty[0] = rootY;
    for (let i = 1; i < POINTS; i++) {
      const s = (i - 0.5) / TAIL_SEGMENTS;
      // bend 0: the curl gathers towards the tip ("?" shape); bend 1: near the base, so a
      // wrapped tail turns early and then runs along the ground.
      const f = lerp(Math.pow(s, 1.35), 1 - Math.pow(1 - s, 2.2), clamp(Number.isFinite(bend) ? bend : 0, 0, 1));
      const a = a0 + c * f;
      this.tx[i] = this.tx[i - 1]! + Math.cos(a) * TAIL_SEG_LEN;
      this.ty[i] = this.ty[i - 1]! + Math.sin(a) * TAIL_SEG_LEN;
    }
  }

  private snapToTarget(): void {
    for (let i = 0; i < POINTS; i++) {
      const x = Number.isFinite(this.tx[i]!) ? this.tx[i]! : 0;
      const y = Number.isFinite(this.ty[i]!) ? this.ty[i]! : 0;
      this.x[i] = x;
      this.y[i] = y;
      this.px[i] = x;
      this.py[i] = y;
    }
    this.ready = true;
  }

  /** Radius of the tail at chain point i. */
  radius(i: number): number {
    const f = i / TAIL_SEGMENTS;
    return (TAIL_RADIUS_BASE + (TAIL_RADIUS_TIP - TAIL_RADIUS_BASE) * f) * this.puff;
  }
}
