// v1.2 hunting (ADR 0003 §4): a continuous hunt drive evaluated at 4 Hz on sim time from the
// cursor's prey salience, a threshold the 'Cursor hunting' slider moves continuously, the "never
// in the way" gates and the strike clearance that keeps the cat's hit region short of the cursor
// hotspot (T8). Pure; the sim keeps the state and plays the phases (simHunt.ts).
import type { HuntGate } from '../../shared/behaviorProfile';
import type { Facing, StrikePose } from '../../shared/cat';
import { HIT_CLEARANCE_DIP, HIT_FRONT_EXTENT_DIP } from '../../shared/cat';
import type { Point, Rect } from '../../shared/geometry';
import type { Random } from './random';
import { range } from './random';

/** The hunt drive and the gates are evaluated once per this much sim time (accumulator). */
export const HUNT_STEP_MS = 250;
export const HUNT_TAU_S = 45;
/** In the petting zone the prey signal is 0 and the drive relaxes this fast. */
export const HUNT_PETTING_TAU_S = 5;
/** Raw typing keeps blocking hunts and play near the cursor this long after it ends. */
export const TYPING_HOLD_MS = 3000;
/** A mouse-button press holds hunts and strikes back this long while the hand is close to the cat... */
export const PRESS_HOLD_MS = 6000;
/** ... and this long with the press and the cursor both far from it (nothing the cat does reaches them there). */
export const PRESS_HOLD_FAR_MS = 2000;
/** A hand that keeps pressing is at work: this long after its last press, wherever it was. */
export const PRESS_HOLD_BUSY_MS = 10_500;
/** At work: this many presses within BUSY_HAND_WINDOW_MS. */
export const BUSY_HAND_PRESSES = 3;
export const BUSY_HAND_WINDOW_MS = 30_000;
/** Far: more than this many body widths from the cat (the approach range, §4.2; a pounce reaches 3.2). */
export const PRESS_NEAR_BW = 4;
/** After petting the cursor is not prey for this long. */
export const PETTING_HOLD_MS = 3000;
/** A taskbar that just slid away still blocks hunts this long. */
export const TASKBAR_HIDE_HOLD_MS = 1000;
/** A cursor still for longer than this stops being prey (except during a running crouch). */
export const STILL_CURSOR_MS = 1500;
/** A cursor resting in the watch band stays of interest this long after its last movement. */
export const CURSOR_PRESENCE_MS = 20_000;
/** What its presence alone is worth to the prey signal (a cursor moving at full speed is worth 1). */
export const CURSOR_PRESENCE_Q = 0.8;
/** Cursor speeds below this (DIP/s) count as no movement. */
export const CURSOR_MOVE_MIN_DIP_S = 30;
/** Global pounce cooldown and per-hunt limits. */
export const POUNCE_COOLDOWN_MS = 90_000;
export const MAX_POUNCES_PER_HUNT = 2;
export const MAX_HUNT_CYCLES = 3;
/** Stalk at most this long per cycle; a still cursor keeps the crouch alive (wiggling) up to this long. */
export const STALK_MAX_MS = 6000;
export const CROUCH_STILL_MAX_MS = 6000;
/** The crouch before a pounce. */
export const CROUCH_MIN_MS = 600;
export const CROUCH_MAX_MS = 1600;
/** Prey already within a pounce's reach is crept up on for this long, then the crouch. */
export const STALK_IN_REACH_MS = 1200;
/** Prey out of the start band for this long counts as lost: a stalk turns into lying low for it. */
export const HUNT_LOST_GRACE_MS = 1000;
/** Watch band: half-width in body widths, and how far below / above the feet in body heights. */
export const WATCH_BAND_HALF_BW = 7;
export const WATCH_BAND_BELOW_BH = 0.6;
export const WATCH_BAND_ABOVE_BH = 4.5;
/** Start band: the watch band up to this many body heights above the feet. */
export const START_BAND_ABOVE_BH = 2.5;

const clamp01 = (v: number): number => (Number.isFinite(v) ? (v < 0 ? 0 : v > 1 ? 1 : v) : 0);

/** h0 = 0.05 H: what the drive relaxes to. */
export function huntBaseline(cursorPlay: number): number {
  return 0.05 * clamp01(cursorPlay);
}

/**
 * k_h = 0.28 H (0.6 + 0.8 playfulness)(0.6 + 0.8 playNeed). The ADR's starting 0.2 (with the foreground
 * term below at 0.3) measured 3.2-3.5 hunts/h in U-play against B5's 4-12 (SIMULATED): the band wins.
 */
export function huntGain(cursorPlay: number, playfulness: number, playNeed: number): number {
  return 0.28 * clamp01(cursorPlay) * (0.6 + 0.8 * clamp01(playfulness)) * (0.6 + 0.8 * clamp01(playNeed));
}

/** θ_h = 0.4 - 0.15 H - 0.05 m, + 0.1 (1 - W) while the cursor is inside the foreground window. */
export function huntThreshold(cursorPlay: number, mischief: number, workDisruption: number, cursorInForeground: boolean): number {
  return 0.4 - 0.15 * clamp01(cursorPlay) - 0.05 * clamp01(mischief) + (cursorInForeground ? 0.1 * (1 - clamp01(workDisruption)) : 0);
}

/** Time between hunt starts: U(4, 7) min x (1.6 - H). */
export function huntCooldownMs(r: Random, cursorPlay: number): number {
  return range(r, 4, 7) * 60_000 * (1.6 - clamp01(cursorPlay));
}

/** One 4 Hz step: h <- h + (q̂ k_h - (h - h0)/τ_h) dt; in the petting zone q̂ = 0 and τ_h = 5 s. */
export function stepHuntDrive(h: number, qHat: number, gain: number, baseline: number, dtS: number, pettingZone: boolean): number {
  const tau = pettingZone ? HUNT_PETTING_TAU_S : HUNT_TAU_S;
  const q = pettingZone ? 0 : Math.max(0, Number.isFinite(qHat) ? qHat : 0);
  const next = h + (q * gain - (h - baseline) / tau) * Math.max(0, dtS);
  return clamp01(next);
}

export interface PreyInput {
  /** Cursor minus the cat's anchor, in body widths (x) and body heights above the feet (y, positive up). */
  dxBw: number;
  dyBh: number;
  /** Cursor speed, DIP/s. */
  speedDip: number;
  /** The direction turned by more than 90° within the last 400 ms. */
  erratic: boolean;
  /** ms since the cursor last moved. */
  idleMs: number;
  /** A hunt crouch is running (a still cursor keeps the crouch alive). */
  crouching: boolean;
  /** A fast cursor flick was reported this evaluation. */
  flick: boolean;
  /** On the cat's display and not off limits. */
  sameDisplay: boolean;
}

export function inWatchBand(dxBw: number, dyBh: number): boolean {
  return Math.abs(dxBw) <= WATCH_BAND_HALF_BW && dyBh >= -WATCH_BAND_BELOW_BH && dyBh <= WATCH_BAND_ABOVE_BH;
}

export function inStartBand(dxBw: number, dyBh: number): boolean {
  return inWatchBand(dxBw, dyBh) && dyBh <= START_BAND_ABOVE_BH;
}

/**
 * q = inWatchBand · max(move · (1 + 0.3 erratic) · still + flick, presence); q̂ = q · prox, prox = 1/(1 + (dx / 4 bw)²).
 * move = clamp(v / 400) (0 below 30 DIP/s); still = 0 once the cursor rests > 1.5 s (not during a crouch);
 * flick = 0.5; presence = CURSOR_PRESENCE_Q until it has rested CURSOR_PRESENCE_MS. A cursor that merely hangs
 * around near the cat is what ordinary use offers: the movement alone never reached the threshold (SIMULATED).
 */
export function preySalience(p: PreyInput): { q: number; qHat: number } {
  if (!p.sameDisplay || !Number.isFinite(p.dxBw) || !Number.isFinite(p.dyBh) || !inWatchBand(p.dxBw, p.dyBh)) return { q: 0, qHat: 0 };
  const v = Number.isFinite(p.speedDip) ? p.speedDip : 0;
  const move = v < CURSOR_MOVE_MIN_DIP_S ? 0 : clamp01(v / 400);
  const still = p.idleMs > STILL_CURSOR_MS && !p.crouching ? 0 : 1;
  const moving = move * (1 + (p.erratic ? 0.3 : 0)) * still + (p.flick ? 0.5 : 0);
  const presence = p.idleMs <= CURSOR_PRESENCE_MS ? CURSOR_PRESENCE_Q : 0;
  const q = Math.max(moving, presence);
  const prox = 1 / (1 + (p.dxBw / 4) * (p.dxBw / 4));
  return { q, qHat: q * prox };
}

/** Everything the gates of ADR 0003 §4.3 look at (all content-free). */
export interface HuntGateInput {
  /** 'Chase the pointer' off, or Cursor hunting at 0. */
  off: boolean;
  /** Raw keyboard-like input now, and ms since it ended. */
  typingRaw: boolean;
  sinceTypingMs: number;
  /** A mouse button is down, and ms since the last press. */
  buttonDown: boolean;
  sincePressMs: number;
  /** The cursor and the last press are both more than PRESS_NEAR_BW from the cat. */
  pressFar?: boolean;
  /** The hand has been pressing again and again (BUSY_HAND_PRESSES within BUSY_HAND_WINDOW_MS). */
  pressBusy?: boolean;
  /** The cursor within the cat's hit rect grown by 0.5 bw, being petted, or within 3 s of petting. */
  pettingZone: boolean;
  /** A taskbar is revealed, hid less than 1 s ago, or the cursor is in a taskbar's band. */
  taskbar: boolean;
  /** The cursor in the container of a strip the cat stands on or next to. */
  stripContainer: boolean;
  /** The cursor in the caption band (top body height) of the window the cat stands on. */
  caption: boolean;
  /** Wariness or fear above 0.3. */
  wary: boolean;
  /** A command is being carried out. */
  command: boolean;
  /** Asleep, away, paused, quiet, fullscreen, held or airborne. */
  unavailable: boolean;
}

/** How long a press holds hunts and strikes back: the hand at work, else by how far it is from the cat. */
export function pressHoldMs(far: boolean, busy: boolean): number {
  return busy ? PRESS_HOLD_BUSY_MS : far ? PRESS_HOLD_FAR_MS : PRESS_HOLD_MS;
}

/** The first gate that holds (null: none). Every "never in the way" gate reads the raw signals. */
export function huntGate(g: HuntGateInput): HuntGate | null {
  if (g.typingRaw || g.sinceTypingMs < TYPING_HOLD_MS) return 'typing';
  if (g.buttonDown || g.sincePressMs < pressHoldMs(g.pressFar === true, g.pressBusy === true)) return 'button';
  if (g.pettingZone) return 'petting';
  if (g.taskbar) return 'taskbar';
  if (g.stripContainer) return 'stripContainer';
  if (g.caption) return 'caption';
  if (g.wary) return 'wary';
  if (g.command) return 'command';
  if (g.off || g.unavailable) return 'other';
  return null;
}

/** The click-through hysteresis the overlay adds while interactive (src/core/interaction/clickThrough.ts default), px. */
export const CLICK_HYSTERESIS_PX = 3;

/** How far the hit region of `pose` reaches ahead of the anchor, px. */
export function hitFrontPx(pose: StrikePose, size: number, scale: number): number {
  return HIT_FRONT_EXTENT_DIP[pose] * (Number.isFinite(size) ? size : 1) * (Number.isFinite(scale) ? scale : 1);
}

/** Least clearance between the hotspot and any hit region (8 DIP plus the hysteresis), px. */
export function requiredClearancePx(scale: number, hysteresisPx = CLICK_HYSTERESIS_PX): number {
  return HIT_CLEARANCE_DIP * (Number.isFinite(scale) ? scale : 1) + hysteresisPx;
}

/** Pounce landing short of the hotspot: max(0.35 bw, hysteresis + HIT_CLEARANCE_DIP), px. */
export function pounceShortPx(bodyWidthPx: number, scale: number, hysteresisPx = CLICK_HYSTERESIS_PX): number {
  return Math.max(0.35 * bodyWidthPx, requiredClearancePx(scale, hysteresisPx));
}

/**
 * Predicted hit region of a strike or landing pose: from 0.6 body widths behind the anchor to its
 * front extent ahead (facing), from the feet up one body height (plus a margin).
 */
export function strikeRegion(pose: StrikePose, anchor: Point, facing: Facing, size: number, scale: number, body: { bw: number; bh: number }): Rect {
  const front = hitFrontPx(pose, size, scale);
  const back = 0.6 * body.bw;
  const x0 = facing > 0 ? anchor.x - back : anchor.x - front;
  const x1 = facing > 0 ? anchor.x + front : anchor.x + back;
  const top = anchor.y - 1.1 * body.bh;
  return { x: x0, y: top, width: x1 - x0, height: anchor.y - top };
}

/** Distance (px) from the hotspot to the predicted hit region of `pose` (0 when inside it). */
export function strikeClearancePx(pose: StrikePose, anchor: Point, facing: Facing, hotspot: Point, scale: number, size: number, body: { bw: number; bh: number }): number {
  const r = strikeRegion(pose, anchor, facing, size, scale, body);
  const dx = Math.max(r.x - hotspot.x, 0, hotspot.x - (r.x + r.width));
  const dy = Math.max(r.y - hotspot.y, 0, hotspot.y - (r.y + r.height));
  return Math.hypot(dx, dy);
}

/**
 * Tracks the cursor's direction so the prey signal knows when it turns sharply (erratic: a turn
 * of more than 90° within 400 ms) and how long it has been still.
 */
export class CursorTracker {
  private last: Point | null = null;
  private dirs: Array<{ at: number; x: number; y: number }> = [];
  private movedAt = -Infinity;
  erratic = false;

  update(now: number, p: Point | null, scale: number): void {
    if (!p || !Number.isFinite(p.x) || !Number.isFinite(p.y)) {
      this.last = null;
      this.dirs = [];
      this.erratic = false;
      return;
    }
    const prev = this.last;
    this.last = { x: p.x, y: p.y };
    if (!prev) {
      this.movedAt = now;
      return;
    }
    const dx = p.x - prev.x;
    const dy = p.y - prev.y;
    const len = Math.hypot(dx, dy);
    if (len > 2 * (Number.isFinite(scale) && scale > 0 ? scale : 1)) {
      this.movedAt = now;
      const u = { at: now, x: dx / len, y: dy / len };
      this.dirs = this.dirs.filter((d) => now - d.at <= 400);
      this.erratic = this.dirs.some((d) => d.x * u.x + d.y * u.y < 0);
      this.dirs.push(u);
      if (this.dirs.length > 32) this.dirs.shift();
    } else if (this.dirs.length > 0 && now - (this.dirs[this.dirs.length - 1] as { at: number }).at > 400) {
      this.erratic = false;
    }
  }

  /** ms since the cursor last moved more than ~2 DIP (from its positions). */
  idleMs(now: number): number {
    return now - this.movedAt;
  }
}
