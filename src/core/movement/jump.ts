// Ballistic jump arcs (screen coordinates: y grows downwards, gravity is positive).
import type { Point } from '../../shared/geometry';

export interface JumpPlan {
  from: Point;
  to: Point;
  /** px/s */
  vx: number;
  /** Initial vertical velocity, px/s (negative = up). */
  vy0: number;
  /** px/s^2 */
  g: number;
  durationMs: number;
  apexY: number;
}

export interface Kinematics {
  x: number;
  y: number;
  vx: number;
  vy: number;
}

/**
 * Solves the arc from `from` to `to` whose apex lies `clearancePx` above the higher
 * of the two points. The arc passes exactly through `to` at `durationMs`.
 */
export function solveJump(from: Point, to: Point, g: number, clearancePx: number): JumpPlan {
  const gravity = g > 0 && Number.isFinite(g) ? g : 1;
  const apexY = Math.min(from.y, to.y) - Math.max(1, clearancePx);
  const rise = from.y - apexY;
  const drop = to.y - apexY;
  const tUp = Math.sqrt((2 * rise) / gravity);
  const tDown = Math.sqrt((2 * drop) / gravity);
  const t = tUp + tDown;
  return {
    from: { x: from.x, y: from.y },
    to: { x: to.x, y: to.y },
    vx: (to.x - from.x) / t,
    vy0: -Math.sqrt(2 * gravity * rise),
    g: gravity,
    durationMs: t * 1000,
    apexY,
  };
}

export function ballistic(x0: number, y0: number, vx: number, vy0: number, g: number, seconds: number): Kinematics {
  return { x: x0 + vx * seconds, y: y0 + vy0 * seconds + 0.5 * g * seconds * seconds, vx, vy: vy0 + g * seconds };
}

export function jumpAt(plan: JumpPlan, elapsedMs: number): Kinematics {
  const s = Math.min(Math.max(elapsedMs, 0), plan.durationMs) / 1000;
  return ballistic(plan.from.x, plan.from.y, plan.vx, plan.vy0, plan.g, s);
}

/**
 * Time (s) at which a body launched from y0 with vy0 crosses yTarget while
 * descending, or null if it never reaches it.
 */
export function descendingCrossing(y0: number, vy0: number, g: number, yTarget: number): number | null {
  const disc = vy0 * vy0 + 2 * g * (yTarget - y0);
  if (disc < 0) return null;
  const s = (-vy0 + Math.sqrt(disc)) / g;
  return Number.isFinite(s) ? s : null;
}

/** Apex clearance for a jump spanning dx px horizontally. */
export function clearanceFor(dx: number, baseClearancePx: number, perDx: number): number {
  return baseClearancePx + Math.abs(dx) * perDx;
}

/** Samples the arc (excluding the end points) for containment checks. */
export function sampleArc(plan: JumpPlan, samples: number): Point[] {
  const pts: Point[] = [];
  for (let i = 1; i < samples; i++) {
    const k = jumpAt(plan, (plan.durationMs * i) / samples);
    pts.push({ x: k.x, y: k.y });
  }
  return pts;
}
