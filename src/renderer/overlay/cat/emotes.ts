// Small vector emote icons shown above the cat's head: pop-in, gentle float, fade.
import type { Emote } from '../../../shared/cat';
import type { Ctx2D } from './draw';
import { clamp01, easeOut, easeOutBack, sseg, TAU } from './math';

export const EMOTE_DURATION_MS = 1600;
/** Nominal icon size in DIP at scale 1. */
export const EMOTE_SIZE = 14;
/**
 * Every emote stays within this distance of its origin (strokes, wobble and the pop-in
 * overshoot included), in the same units as EMOTE_SIZE; the tallest is the zzz.
 */
export const EMOTE_RADIUS = 16;

export interface EmoteFrame {
  scale: number;
  alpha: number;
  /** Upward float in DIP (at scale 1). */
  rise: number;
  /** Small rotation wobble (rad). */
  wobble: number;
  /** Seconds since start. */
  age: number;
}

/** Animation state of an emote `ageMs` after it started; false when it is not visible. */
export function emoteFrame(ageMs: number, out: EmoteFrame): boolean {
  if (!Number.isFinite(ageMs) || ageMs < 0 || ageMs >= EMOTE_DURATION_MS) return false;
  out.age = ageMs / 1000;
  out.scale = Math.max(0, easeOutBack(ageMs / 220));
  out.alpha = 1 - sseg(ageMs, EMOTE_DURATION_MS - 420, EMOTE_DURATION_MS);
  out.rise = 11 * easeOut(ageMs / EMOTE_DURATION_MS);
  out.wobble = 0.09 * Math.sin(out.age * 5.2) * (1 - clamp01(ageMs / EMOTE_DURATION_MS));
  return out.alpha > 0.001;
}

/** Draws `emote` centred at the current origin, `size` DIP tall. */
export function drawEmote(ctx: Ctx2D, emote: Emote, size: number, f: EmoteFrame): void {
  ctx.save();
  ctx.globalAlpha *= f.alpha;
  ctx.rotate(f.wobble);
  const k = (size / EMOTE_SIZE) * f.scale;
  ctx.scale(k, k);
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  switch (emote) {
    case 'heart':
      heart(ctx);
      break;
    case 'zzz':
      zzz(ctx, f.age);
      break;
    case 'exclaim':
      exclaim(ctx);
      break;
    case 'question':
      question(ctx);
      break;
    case 'anger':
      anger(ctx, f.age);
      break;
    case 'note':
      note(ctx);
      break;
    case 'sparkle':
      sparkle(ctx, f.age);
      break;
  }
  ctx.restore();
}

function heartPath(ctx: Ctx2D): void {
  ctx.beginPath();
  ctx.moveTo(0, 6.2);
  ctx.bezierCurveTo(-2.5, 4.2, -7.2, 1.2, -7.2, -2.4);
  ctx.bezierCurveTo(-7.2, -5.6, -4.6, -7.2, -2.6, -7.2);
  ctx.bezierCurveTo(-1.2, -7.2, -0.3, -6.3, 0, -5.2);
  ctx.bezierCurveTo(0.3, -6.3, 1.2, -7.2, 2.6, -7.2);
  ctx.bezierCurveTo(4.6, -7.2, 7.2, -5.6, 7.2, -2.4);
  ctx.bezierCurveTo(7.2, 1.2, 2.5, 4.2, 0, 6.2);
  ctx.closePath();
}

function heart(ctx: Ctx2D): void {
  heartPath(ctx);
  ctx.strokeStyle = '#7d1531';
  ctx.lineWidth = 2.6;
  ctx.stroke();
  ctx.fillStyle = '#ff5b7f';
  ctx.fill();
  ctx.fillStyle = '#ffd0db';
  ctx.beginPath();
  ctx.ellipse(-3.6, -3.4, 1.7, 1.1, -0.6, 0, TAU);
  ctx.fill();
}

function zPath(ctx: Ctx2D, x: number, y: number, s: number): void {
  ctx.moveTo(x - s, y - s);
  ctx.lineTo(x + s, y - s);
  ctx.lineTo(x - s, y + s);
  ctx.lineTo(x + s, y + s);
}

/** x, y, half-size, appear delay (s) of the three Zs. */
const ZS: readonly (readonly [number, number, number, number])[] = [
  [-4.5, 3.5, 2.4, 0],
  [0.5, -1.0, 3.0, 0.25],
  [5.5, -6.0, 3.6, 0.5],
];

function zzz(ctx: Ctx2D, age: number): void {
  for (const [x, y, s, delay] of ZS) {
    const a = clamp01((age - delay) / 0.2);
    if (a <= 0) continue;
    const ga = ctx.globalAlpha;
    ctx.globalAlpha = ga * a;
    ctx.beginPath();
    zPath(ctx, x, y, s);
    ctx.strokeStyle = '#1f3157';
    ctx.lineWidth = 3.4;
    ctx.stroke();
    ctx.strokeStyle = '#d4e6ff';
    ctx.lineWidth = 1.6;
    ctx.stroke();
    ctx.globalAlpha = ga;
  }
}

function exclaim(ctx: Ctx2D): void {
  ctx.beginPath();
  ctx.moveTo(-1.9, -7.4);
  ctx.lineTo(1.9, -7.4);
  ctx.lineTo(1.0, 2.2);
  ctx.lineTo(-1.0, 2.2);
  ctx.closePath();
  ctx.strokeStyle = '#6b1410';
  ctx.lineWidth = 2.6;
  ctx.stroke();
  ctx.fillStyle = '#ff5a44';
  ctx.fill();
  ctx.beginPath();
  ctx.arc(0, 5.6, 1.7, 0, TAU);
  ctx.stroke();
  ctx.fill();
}

function question(ctx: Ctx2D): void {
  ctx.beginPath();
  ctx.moveTo(-3.6, -3.6);
  ctx.bezierCurveTo(-3.6, -7.6, 3.8, -7.8, 3.8, -3.6);
  ctx.bezierCurveTo(3.8, -0.8, 0, -0.6, 0, 2.2);
  ctx.strokeStyle = '#123d70';
  ctx.lineWidth = 4.6;
  ctx.stroke();
  ctx.strokeStyle = '#5fb0ff';
  ctx.lineWidth = 2.2;
  ctx.stroke();
  ctx.beginPath();
  ctx.arc(0, 6.0, 1.6, 0, TAU);
  ctx.fillStyle = '#5fb0ff';
  ctx.strokeStyle = '#123d70';
  ctx.lineWidth = 1.2;
  ctx.fill();
  ctx.stroke();
}

function anger(ctx: Ctx2D, age: number): void {
  const pulse = 1 + 0.12 * Math.max(0, Math.sin(age * 14));
  ctx.scale(pulse, pulse);
  // Four rounded "L" corners around the centre, opening outwards (the classic vein mark).
  ctx.beginPath();
  for (let i = 0; i < 4; i++) {
    const sx = i === 0 || i === 3 ? 1 : -1;
    const sy = i < 2 ? -1 : 1;
    ctx.moveTo(sx * 1.4, sy * 6.2);
    ctx.quadraticCurveTo(sx * 1.4, sy * 1.4, sx * 6.2, sy * 1.4);
  }
  ctx.strokeStyle = '#5c0c0c';
  ctx.lineWidth = 4.2;
  ctx.stroke();
  ctx.strokeStyle = '#ff3d3d';
  ctx.lineWidth = 2.0;
  ctx.stroke();
}

function note(ctx: Ctx2D): void {
  ctx.beginPath();
  ctx.ellipse(-2.4, 4.4, 3.0, 2.2, -0.45, 0, TAU);
  ctx.moveTo(0.3, 3.6);
  ctx.lineTo(0.3, -6.8);
  ctx.quadraticCurveTo(3.4, -5.6, 5.0, -2.4);
  ctx.strokeStyle = '#26175e';
  ctx.lineWidth = 2.8;
  ctx.stroke();
  ctx.beginPath();
  ctx.ellipse(-2.4, 4.4, 3.0, 2.2, -0.45, 0, TAU);
  ctx.fillStyle = '#8f74ff';
  ctx.fill();
  ctx.beginPath();
  ctx.moveTo(0.3, 3.6);
  ctx.lineTo(0.3, -6.8);
  ctx.quadraticCurveTo(3.4, -5.6, 5.0, -2.4);
  ctx.strokeStyle = '#8f74ff';
  ctx.lineWidth = 1.2;
  ctx.stroke();
}

function starPath(ctx: Ctx2D, x: number, y: number, r: number): void {
  const i = r * 0.28;
  ctx.moveTo(x, y - r);
  ctx.quadraticCurveTo(x + i, y - i, x + r, y);
  ctx.quadraticCurveTo(x + i, y + i, x, y + r);
  ctx.quadraticCurveTo(x - i, y + i, x - r, y);
  ctx.quadraticCurveTo(x - i, y - i, x, y - r);
  ctx.closePath();
}

function sparkle(ctx: Ctx2D, age: number): void {
  const tw = 0.85 + 0.15 * Math.sin(age * 11);
  ctx.beginPath();
  starPath(ctx, -1.2, 0.6, 6.4 * tw);
  starPath(ctx, 5.0, -5.2, 3.0 * (2 - tw));
  ctx.strokeStyle = '#7a5a00';
  ctx.lineWidth = 2.2;
  ctx.stroke();
  ctx.fillStyle = '#ffd94a';
  ctx.fill();
  ctx.fillStyle = '#fff6c8';
  ctx.beginPath();
  ctx.arc(-1.2, 0.6, 1.2, 0, TAU);
  ctx.fill();
}
