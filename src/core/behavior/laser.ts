// Laser Mode, the pure part (the sim's layer in simLaser.ts carries it out). While the user has it on, the
// real cursor is a LIGHT: the cat follows it, runs when it is far and the cat is keen, walks when it is near
// or the cat is calm, sits and watches when it rests and reaches toward it with a paw. It never catches
// it. The one rule everything here serves: the cat stops at least `laserStandoffPx` short of the dot,
// horizontally, and never closes that gap. The dot is the REAL cursor and the overlay must never block the
// user, so the stand-off is also never less than the paw's whole reach plus the click-through clearance
// (HIT_FRONT_EXTENT_DIP.pawAt + HIT_CLEARANCE_DIP + the hysteresis, T8). No clock, no random, no DOM.
import { LASER_STANDOFF_BODY_LENGTHS } from '../../shared/companion';
import { clamp } from '../../shared/geometry';
import { hitFrontPx, requiredClearancePx } from './hunt';

/** The cat stands this far (body widths) beyond the stand-off so that arriving within its radius still leaves the full stand-off. */
export const LASER_ARRIVE_MARGIN_BW = 0.15;
/** A dot this many body heights above the feet (or more) is overhead: the cat may hop at it, never reach for it. */
export const LASER_HOP_MIN_DY_BH = 1.4;
export const LASER_HOP_MAX_DY_BH = 4;
/**
 * A cat that may hop at an overhead dot stops this much beyond the stand-off instead (a hop carries it
 * 0.35 body widths toward the dot), and hops only with at least LASER_HOP_MIN_GAP_BW of room: the hop
 * itself never closes the gap below the stand-off either.
 */
export const LASER_HOP_MARGIN_BW = 0.75;
export const LASER_HOP_MIN_GAP_BW = 0.4;
/** The paw reaches only for a dot between this far below and this far above the feet (body heights). */
export const LASER_REACH_DY_BH: readonly [number, number] = [-0.4, 1.1];
/** ...and no further than this many body widths beyond the stand-off. */
export const LASER_REACH_SPAN_BW = 1.3;
/** A dot slower than this (DIP/s) counts as resting: a cat reaches for a resting light, it runs after a moving one. */
export const LASER_REACH_MAX_SPEED_DIP = 250;
/** Farther than this beyond the stand-off (body widths) a keen cat runs. */
export const LASER_RUN_GAP_BW = 3.5;
/** A cat farther than this beyond the stand-off runs whatever its appetite (unless it is out of breath). */
export const LASER_RUN_ANY_GAP_BW = 8;

/**
 * How far from the dot (px, along the floor) the cat holds off. At least LASER_STANDOFF_BODY_LENGTHS body
 * widths; never less than the paw-at pose's reach, the 8 DIP clearance and the click-through hysteresis
 * plus a quarter body width of margin, so the hit region never comes near the hotspot at any size or scale.
 */
export function laserStandoffPx(bodyWidthPx: number, scale: number, size: number): number {
  const bw = Number.isFinite(bodyWidthPx) && bodyWidthPx > 0 ? bodyWidthPx : 84;
  const strike = hitFrontPx('pawAt', size, scale) + requiredClearancePx(scale) + 0.25 * bw;
  return Math.max(LASER_STANDOFF_BODY_LENGTHS * bw, strike);
}

export interface LaserSituation {
  catX: number;
  dotX: number;
  /** The dot above the feet, in body heights (negative: below). */
  dyBh: number;
  bodyWidth: number;
  bodyHeight: number;
  scale: number;
  size: number;
  /** The span the cat can walk on, px (null: none). */
  walkMin: number | null;
  walkMax: number | null;
  /** The dot's speed, DIP/s, and how long it has rested, ms. */
  dotSpeedDip: number;
  dotIdleMs: number;
  /** Energy 0..1 and the share of the chase budget still left (0..1). */
  energy: number;
  staminaLeft: number;
  /** PersonalityKnobs.restBias / playAppetite (0..1). */
  restBias: number;
  playAppetite: number;
  /** Already walking after the dot (a hysteresis: a cat on its way does not stop at the dead zone's edge). */
  engaged: boolean;
  reduced: boolean;
  /** Paw-at strikes and jumps are not switched off, and the paw would clear the hotspot. */
  reachAllowed: boolean;
  hopAllowed: boolean;
  hopReady: boolean;
}

export interface LaserDecision {
  /** 'hold' stands or sits where it is; 'walk' and 'run' go to goalX. */
  mode: 'hold' | 'walk' | 'run';
  /** Where to stand (never within the stand-off of the dot), or null. */
  goalX: number | null;
  /** Reach a paw toward the dot (the pawAt clip), never a swat or a pounce. */
  reach: boolean;
  /** A small hop at a dot overhead. */
  hop: boolean;
  /** The dot is inside the stand-off: the cat holds still and lets the user be (a click on the cat, a pet). */
  inside: boolean;
}

const finite = (n: number, fallback: number): number => (Number.isFinite(n) ? n : fallback);

/**
 * What the cat does about the dot this tick. The goal is on the cat's own side of the dot and is dropped
 * (the cat holds) when the walkable span would put it closer than the stand-off; a dot already inside the
 * stand-off (the user moved it onto the cat) makes the cat hold still instead of backing off, so a
 * click or a pet is never dodged and the gap is still never closed by the cat.
 */
export function laserDecision(s: LaserSituation): LaserDecision {
  const bw = s.bodyWidth > 0 && Number.isFinite(s.bodyWidth) ? s.bodyWidth : 84;
  const standoff = laserStandoffPx(bw, s.scale, s.size);
  const dx = finite(s.dotX, 0) - finite(s.catX, 0);
  const gap = Math.abs(dx);
  const hold: LaserDecision = { mode: 'hold', goalX: null, reach: false, hop: false, inside: false };
  if (!Number.isFinite(dx)) return hold;
  // Closer than the stand-off already: stay put, reach for nothing.
  if (gap < standoff - 0.05 * bw) return { ...hold, inside: true };

  const side = dx <= 0 ? 1 : -1;
  const dy = finite(s.dyBh, 0);
  const hopMayBe = s.hopAllowed && dy >= LASER_HOP_MIN_DY_BH && dy <= LASER_HOP_MAX_DY_BH;
  const margin = (hopMayBe ? LASER_HOP_MARGIN_BW : LASER_ARRIVE_MARGIN_BW) * bw;
  const want = finite(s.dotX, 0) + side * (standoff + margin);
  const lo = s.walkMin !== null && Number.isFinite(s.walkMin) ? s.walkMin : null;
  const hi = s.walkMax !== null && Number.isFinite(s.walkMax) ? s.walkMax : null;
  let goalX: number | null = lo !== null && hi !== null ? clamp(want, lo, Math.max(lo, hi)) : null;
  // A surface that ends short of the stand-off: it holds at the end of it rather than creep closer.
  if (goalX !== null && Math.abs(goalX - finite(s.dotX, 0)) < standoff) goalX = null;

  const extra = gap - (standoff + margin);
  const rest = clamp(finite(s.restBias, 0.5), 0, 1);
  // A calm cat lets the light come closer before it bothers to follow; a keen one follows almost at once.
  const dead = bw * (0.5 + 2.2 * rest);
  const far = goalX !== null && extra > (s.engaged ? 0.2 * bw : dead);
  if (far && goalX !== null) {
    const energy = clamp(finite(s.energy, 0.5), 0, 1);
    const appetite = clamp(finite(s.playAppetite, 0.5), 0, 1);
    const winded = energy < 0.35 || s.staminaLeft < 0.25;
    const keen = appetite >= 0.3 || extra > LASER_RUN_ANY_GAP_BW * bw;
    const run = !s.reduced && !winded && extra > LASER_RUN_GAP_BW * bw && keen;
    return { mode: run ? 'run' : 'walk', goalX, reach: false, hop: false, inside: false };
  }

  // Near enough: watch, and now and then reach (a resting light) or hop (a light overhead).
  const resting = finite(s.dotSpeedDip, 0) < LASER_REACH_MAX_SPEED_DIP;
  const reach = s.reachAllowed && resting && gap <= standoff + LASER_REACH_SPAN_BW * bw && dy >= LASER_REACH_DY_BH[0] && dy <= LASER_REACH_DY_BH[1];
  const hop = hopMayBe && s.hopReady && gap >= standoff + LASER_HOP_MIN_GAP_BW * bw;
  return { mode: 'hold', goalX: null, reach, hop, inside: false };
}

/**
 * The chase budget (ms of following) before the cat takes a break: a longer one for a keen, rested cat,
 * a shorter one for a calm or tired one, so the light is never an endless loop.
 */
export function laserChaseBudgetMs(chaseDuration: number, energy: number): number {
  const k = clamp(finite(chaseDuration, 1), 0.3, 2);
  const e = clamp(finite(energy, 0.5), 0, 1);
  return 45_000 * k * clamp(0.5 + e, 0.4, 1.4);
}

/** How long the break lasts (ms), from a unit random number: longer for a cat that likes its rest. */
export function laserBreakMs(restBias: number, u: number): number {
  const r = clamp(finite(restBias, 0.5), 0, 1);
  const x = clamp(finite(u, 0.5), 0, 1);
  return (9000 + 9000 * x) * (0.6 + 0.8 * r);
}
