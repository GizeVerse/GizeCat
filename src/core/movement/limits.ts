// v1.2 movement limits (ADR 0003 §6.2-§6.7): clean-gait pace clamps, jump-down limits and the
// risk of a leg between the safe and the maximum height, landing impact of a drop, the kind of a
// jump, and the geometric slip risk of a take-off. Pure; DIP unless a name says px.
import type { JumpKind, LandingImpact } from '../../shared/cat';
import { GAIT_LIMIT_DIP } from '../../shared/cat';
import { MOVEMENT } from './constants';
import { impactClass } from './landing';

/** Locomotion paces (see Mover.paceSpeedPx). */
export type PaceName = 'stalk' | 'slow' | 'walk' | 'run' | 'chase' | 'sprint';

/** The locomotion clip each pace is drawn with (ADR 0003 §6.7): its clean-gait limit bounds the pace. */
export const PACE_GAIT = { stalk: 'stalk', slow: 'walk', walk: 'walk', chase: 'run', run: 'run', sprint: 'sprint' } as const satisfies Record<PaceName, keyof typeof GAIT_LIMIT_DIP>;

export function paceDip(pace: PaceName): number {
  switch (pace) {
    case 'run':
      return MOVEMENT.runDip;
    case 'chase':
      return MOVEMENT.chaseDip;
    case 'slow':
      return MOVEMENT.slowDip;
    case 'stalk':
      return MOVEMENT.stalkDip;
    case 'sprint':
      return MOVEMENT.sprintDip;
    default:
      return MOVEMENT.walkDip;
  }
}

/** Pace speed in DIP/s at this movement speed, clamped to 1.1 x its clip's clean-gait limit. */
export function clampedPaceDip(pace: PaceName, movementSpeed: number): number {
  const speed = Number.isFinite(movementSpeed) && movementSpeed > 0 ? movementSpeed : 1;
  return Math.min(paceDip(pace) * speed, MOVEMENT.gaitLimitFactor * GAIT_LIMIT_DIP[PACE_GAIT[pace]]);
}

/** Climbing speed (up or down) in DIP/s, clamped to 1.1 x the climb clip's limit. */
export function clampedClimbDip(up: boolean, movementSpeed: number): number {
  const speed = Number.isFinite(movementSpeed) && movementSpeed > 0 ? movementSpeed : 1;
  return Math.min((up ? MOVEMENT.climbUpDip : MOVEMENT.climbDownDip) * speed, MOVEMENT.gaitLimitFactor * GAIT_LIMIT_DIP.climb);
}

/** Height (DIP) from which a free drop lands hard: impactHardFromDip^2 / (2 g), ~492 DIP. */
export const HARD_DROP_DIP = (MOVEMENT.impactHardFromDip * MOVEMENT.impactHardFromDip) / (2 * MOVEMENT.gravityDip);

/** Effective jump-down limits, DIP below the feet. */
export interface JumpDownLimits {
  /** Preferred: legs up to here carry no height risk. */
  safeDip: number;
  /** Never exceeded by a non-emergency leg (at most MOVEMENT.jumpDownAbsoluteMaxDip). */
  maxDip: number;
}

/**
 * The limits from MoverConfig.jumpDownSafeDip / jumpDownMaxDip, or null when neither is set
 * (v1.1.1: unlimited). Only one set: the other follows (max = the absolute cap, safe = max).
 */
export function jumpDownLimits(cfg: { jumpDownSafeDip?: number; jumpDownMaxDip?: number }): JumpDownLimits | null {
  const ok = (v: number | undefined): v is number => v !== undefined && Number.isFinite(v) && v > 0;
  const safe = cfg.jumpDownSafeDip;
  const max = cfg.jumpDownMaxDip;
  if (!ok(safe) && !ok(max)) return null;
  const maxDip = Math.min(ok(max) ? max : MOVEMENT.jumpDownAbsoluteMaxDip, MOVEMENT.jumpDownAbsoluteMaxDip);
  const safeDip = Math.min(ok(safe) ? safe : maxDip, maxDip);
  return { safeDip, maxDip };
}

/** v1.2 limits for the leave and bail-out planners: the configured ones, else only the absolute cap. */
export function leaveLimits(cfg: { jumpDownSafeDip?: number; jumpDownMaxDip?: number }): JumpDownLimits {
  return jumpDownLimits(cfg) ?? { safeDip: MOVEMENT.jumpDownAbsoluteMaxDip, maxDip: MOVEMENT.jumpDownAbsoluteMaxDip };
}

/** 0..1 height risk of a leg dropping `dropDip`: 0 up to the safe height, 1 at the maximum. */
export function dropRisk(dropDip: number, limits: JumpDownLimits | null): number {
  if (!limits || !(dropDip > limits.safeDip)) return 0;
  const span = limits.maxDip - limits.safeDip;
  return span > 0 ? Math.min(1, (dropDip - limits.safeDip) / span) : 1;
}

/** Impact class of a fall of `fallDip` (from rest at the top). */
export function dropImpact(fallDip: number): LandingImpact {
  return impactClass(Math.sqrt(2 * MOVEMENT.gravityDip * Math.max(0, fallDip)));
}

/**
 * Apex clearance (px) for a planned jump that drops `dropPx`: with jump-down limits a descent
 * pushes off nearly flat, so a leg within the hard-landing height lands at most medium (§6.3, §6.4).
 * `basePx` is the usual clearance; climbs and level jumps keep it.
 */
export function descentClearancePx(basePx: number, dropPx: number, scale: number, limited: boolean): number {
  if (!limited || dropPx <= 0) return basePx;
  const room = (HARD_DROP_DIP * 0.97) * scale - dropPx;
  return room <= 0 ? Math.min(basePx, scale) : Math.min(basePx, Math.max(scale, room));
}

/**
 * Kind of a jump from its displacement (px; dy > 0 = down): hop (on the same surface, |dy| < 0.5
 * bh, |dx| <= 1 bw), up / down (|dy| > 0.5 bh), else across. Pounces, leaps and wall jumps are
 * named by the caller.
 */
export function classifyJump(dx: number, dy: number, bodyWidth: number, bodyHeight: number, sameSurface: boolean): JumpKind {
  if (dy < -0.5 * bodyHeight) return 'up';
  if (dy > 0.5 * bodyHeight) return 'down';
  if (sameSurface && Math.abs(dx) <= bodyWidth) return 'hop';
  return 'across';
}

/** Geometry of a take-off for its slip risk (px; widths and gaps >= 0). */
export interface TakeoffGeometry {
  /** Width of the landing span (Infinity for a wall). */
  spanPx: number;
  /** Horizontal gap between the take-off point and the landing span (or the wall line). */
  gapPx: number;
  /** How far the landing is above the take-off feet (<= 0 for level or down). */
  upPx: number;
  /** Speed of the target surface, DIP/s. */
  targetSpeedDip: number;
}

/**
 * 0..1 geometric slip risk of a take-off (ADR 0003 §6.6): a landing span under 1.2 body lengths,
 * a gap over 0.7 x the longest jump, a rise over 0.7 x the highest jump, a target moving faster than
 * 50 DIP/s. Combined as 1 - prod(1 - term). The sim adds the energy term to its slip draw.
 */
export function takeoffRisk(g: TakeoffGeometry, scale: number, bodyWidth: number): number {
  const terms: number[] = [];
  const spanLimit = MOVEMENT.slipRiskSpanBodyLengths * bodyWidth;
  if (Number.isFinite(g.spanPx) && g.spanPx < spanLimit) terms.push((spanLimit - Math.max(0, g.spanPx)) / spanLimit);
  const across = MOVEMENT.maxJumpAcrossDip * scale;
  const gapFrom = MOVEMENT.slipRiskGapFraction * across;
  if (g.gapPx > gapFrom) terms.push((g.gapPx - gapFrom) / (across - gapFrom));
  const up = MOVEMENT.maxJumpUpDip * scale;
  const upFrom = MOVEMENT.slipRiskUpFraction * up;
  if (g.upPx > upFrom) terms.push((g.upPx - upFrom) / (up - upFrom));
  if (g.targetSpeedDip > MOVEMENT.slipRiskMovingDip) terms.push((g.targetSpeedDip - MOVEMENT.slipRiskMovingDip) / (3 * MOVEMENT.slipRiskMovingDip));
  let keep = 1;
  for (const t of terms) keep *= 1 - Math.min(1, Math.max(0, t));
  return Math.min(1, Math.max(0, 1 - keep));
}
