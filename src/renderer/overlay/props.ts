// World-event props and the laser dot, drawn procedurally with the Canvas 2D API (no images, no
// DOM): small, stylised, a thin dark outline round a light fill so they read on any wallpaper.
// Props are drawn BEHIND the cat and the laser dot over it, both pointer-events none by
// construction (a canvas has no hit testing of its own; the hit region is reported from the cat's
// scene only, so nothing here ever makes the overlay interactive). Pixel style follows the cat's
// look without its scratch layer: flat fills, no gradients, a thicker mitred outline and positions
// snapped to a coarse grid. Under reduced motion every amplitude is halved and flicker is gone.
// A prop's `p` is event-defined; here it drives only what is naturally a progress (a wave's crest, a
// splash, a bubble's pop, a chest lid, a trail); everything else animates from time and the id.
import type { RenderStyle } from '../../shared/cat';
import { MAX_PROPS, type PropKind, type RenderProp } from '../../shared/companion';
import { clamp, laserBounds, LASER_GLOW_DIP, LASER_RADIUS_DIP, outlineScale, PIXEL_GRID, propsBounds, reachDip, type PropRect } from './propBounds';
import type { Ctx2D } from './cat/draw';

export interface DrawPropsOptions {
  /** Render-time simulation clock (ms): the animation phase. */
  t: number;
  /** Cat size multiplier (settings.appearance.size): scales outlines only; a prop's size comes from the sim. */
  scale: number;
  style: RenderStyle;
  reducedMotion: boolean;
  /** The canvas's CSS size: a prop wholly outside it is not drawn. */
  width: number;
  height: number;
}

const TAU = Math.PI * 2;
const INK = 'rgba(32,26,44,0.92)';
const LIGHT = 'rgba(255,255,255,0.78)';
const OUTLINE_DIP = 1.3;
const PIXEL_OUTLINE_DIP = 2.4;


interface Palette {
  main: string;
  accent: string;
  alt: string;
}
const PALETTES: readonly Palette[] = [
  { main: '#f4f1ea', accent: '#ff8fa3', alt: '#ffd166' },
  { main: '#d4eaff', accent: '#5fb8ff', alt: '#fff1a8' },
  { main: '#ffe2c4', accent: '#ff9a62', alt: '#c3ee9c' },
  { main: '#e8dcff', accent: '#b088ff', alt: '#9ff0e2' },
];
const LEAF_COLORS = ['#8fd37e', '#f4bd4f', '#e5803f', '#c9da63'] as const;
const BIRD_COLORS = ['#7fb7e8', '#e8a15f', '#a5d68a', '#d79ac8'] as const;
const DRAGON_COLORS = ['#77d28f', '#f08a7a', '#79b8f0', '#c49af0'] as const;

/** Everything one kind's drawer needs; `ow` is the outline width in the prop's own unit space (1 = its size). */
interface D {
  c: Ctx2D;
  /** Seconds, offset by the id so neighbours do not move in lockstep. */
  ph: number;
  /** Motion amplitude: 1, or 0.5 under reduced motion. */
  mo: number;
  calm: boolean;
  ow: number;
  pal: Palette;
  variant: number;
  p: number;
  id: number;
  pixel: boolean;
}

// ---- path helpers ------------------------------------------------------------------------------

function fillStroke(d: D, fill: string): void {
  d.c.fillStyle = fill;
  d.c.fill();
  d.c.stroke();
}

function ellipsePath(c: Ctx2D, cx: number, cy: number, rx: number, ry: number, rot = 0): void {
  c.beginPath();
  c.ellipse(cx, cy, Math.max(1e-4, rx), Math.max(1e-4, ry), rot, 0, TAU);
}

function disc(d: D, cx: number, cy: number, r: number, fill: string): void {
  ellipsePath(d.c, cx, cy, r, r);
  fillStroke(d, fill);
}

/** A dot with no outline (eyes, glints). */
function dot(c: Ctx2D, cx: number, cy: number, r: number, fill: string): void {
  ellipsePath(c, cx, cy, r, r);
  c.fillStyle = fill;
  c.fill();
}

function polyPath(c: Ctx2D, pts: readonly number[], close = true): void {
  c.beginPath();
  c.moveTo(pts[0] ?? 0, pts[1] ?? 0);
  for (let i = 2; i + 1 < pts.length; i += 2) c.lineTo(pts[i]!, pts[i + 1]!);
  if (close) c.closePath();
}

function starPath(c: Ctx2D, cx: number, cy: number, ro: number, ri: number, points: number, rot: number): void {
  c.beginPath();
  for (let i = 0; i < points * 2; i++) {
    const r = i % 2 === 0 ? ro : ri;
    const a = rot - Math.PI / 2 + (i * Math.PI) / points;
    if (i === 0) c.moveTo(cx + Math.cos(a) * r, cy + Math.sin(a) * r);
    else c.lineTo(cx + Math.cos(a) * r, cy + Math.sin(a) * r);
  }
  c.closePath();
}

/** Strokes the current path twice: a dark underlay `inkW` wide, then `colW` of `color` on top. */
function strokeTwo(d: D, inkW: number, colW: number, color: string): void {
  const c = d.c;
  c.strokeStyle = INK;
  c.lineWidth = inkW;
  c.stroke();
  c.strokeStyle = color;
  c.lineWidth = colW;
  c.stroke();
  c.strokeStyle = INK;
  c.lineWidth = d.ow;
}

const wob = (d: D, freq: number, amp: number, phase = 0): number => Math.sin(d.ph * freq + phase) * amp * d.mo;

// ---- the drawers (unit space: x -0.5..0.5 is the nominal width, y up is negative; floor props stand on y = 0) ----

function drawMouse(d: D): void {
  const c = d.c;
  const run = Math.sin(d.ph * 16) * 0.03 * d.mo;
  c.beginPath();
  c.moveTo(-0.28, -0.12);
  c.quadraticCurveTo(-0.46, -0.3 + wob(d, 5, 0.08), -0.55, -0.06);
  strokeTwo(d, d.ow * 2.4, d.ow * 1.1, d.pal.accent);
  ellipsePath(c, -0.1 + run, -0.01, 0.05, 0.025);
  fillStroke(d, d.pal.main);
  ellipsePath(c, 0.1 - run, -0.01, 0.05, 0.025);
  fillStroke(d, d.pal.main);
  ellipsePath(c, -0.03, -0.14, 0.26, 0.14);
  fillStroke(d, '#b9b4bf');
  disc(d, 0.16, -0.29, 0.07, d.pal.accent);
  ellipsePath(c, 0.27, -0.14, 0.13, 0.1);
  fillStroke(d, '#c8c3cd');
  dot(c, 0.39, -0.14, 0.025, d.pal.accent);
  dot(c, 0.31, -0.17, 0.02, INK);
}

function drawWave(d: D): void {
  const c = d.c;
  // The crest rises and falls with the progress; a slow ripple on top (halved when calm).
  const h = 0.3 + 0.28 * Math.sin(clamp(d.p, 0, 1) * Math.PI) + wob(d, 4, 0.03);
  const water = ['#8fd3ff', '#6fc0f2', '#9ae0e0', '#a9c8ff'][d.variant] ?? '#8fd3ff';
  c.beginPath();
  c.moveTo(-0.5, 0);
  c.bezierCurveTo(-0.42, -h * 0.4, -0.2, -h * 1.05, 0.08, -h);
  c.bezierCurveTo(0.3, -h * 0.98, 0.38, -h * 0.62, 0.26, -h * 0.5);
  c.bezierCurveTo(0.34, -h * 0.4, 0.46, -h * 0.2, 0.5, 0);
  c.closePath();
  fillStroke(d, water);
  c.beginPath();
  c.moveTo(-0.3, -h * 0.35);
  c.quadraticCurveTo(-0.08, -h * 0.85, 0.12, -h * 0.82);
  c.strokeStyle = LIGHT;
  c.lineWidth = d.ow * 1.2;
  c.stroke();
  c.strokeStyle = INK;
  c.lineWidth = d.ow;
}

function drawSplash(d: D): void {
  const c = d.c;
  const q = clamp(d.p, 0, 1);
  const drops = 7;
  for (let i = 0; i < drops; i++) {
    const a = Math.PI + ((i + 0.5) * Math.PI) / drops;
    const reach = 0.12 + 0.34 * Math.sqrt(q);
    // A drop rises on a short arc and falls back: y gains a parabola over the progress.
    const x = Math.cos(a) * reach;
    const y = Math.sin(a) * reach * 1.1 + 0.35 * q * q * (1 - 0.5 * Math.sin(a));
    disc(d, x, y - 0.02, 0.05 * (1 - 0.6 * q) + 0.012, '#9bdcff');
  }
  ellipsePath(c, 0, -0.01, 0.1 + 0.34 * q, 0.04 + 0.03 * q);
  c.strokeStyle = INK;
  c.stroke();
  ellipsePath(c, 0, -0.01, 0.08 + 0.34 * q, 0.03 + 0.03 * q);
  c.strokeStyle = LIGHT;
  c.stroke();
  c.strokeStyle = INK;
}

function drawButterflyBody(d: D, wingA: string, wingB: string, dotColor: string): void {
  const c = d.c;
  // Flapping is the butterfly: halved (shallower) rather than removed under reduced motion.
  const s = Math.abs(Math.sin(d.ph * 9));
  const flap = d.calm ? 0.7 + 0.3 * s : 0.3 + 0.7 * s;
  c.save();
  c.translate(0, wob(d, 3, 0.05));
  for (const side of [-1, 1]) {
    c.save();
    c.scale(side * flap, 1);
    ellipsePath(c, 0.2, -0.12, 0.22, 0.17, -0.45);
    fillStroke(d, wingA);
    ellipsePath(c, 0.16, 0.1, 0.14, 0.1, 0.45);
    fillStroke(d, wingB);
    dot(c, 0.24, -0.14, 0.04, dotColor);
    c.restore();
  }
  ellipsePath(c, 0, 0, 0.035, 0.15);
  fillStroke(d, INK);
  c.beginPath();
  c.moveTo(-0.01, -0.14);
  c.quadraticCurveTo(-0.08, -0.28, -0.12, -0.26);
  c.moveTo(0.01, -0.14);
  c.quadraticCurveTo(0.08, -0.28, 0.12, -0.26);
  c.stroke();
  c.restore();
}

function drawButterfly(d: D): void {
  drawButterflyBody(d, d.pal.accent, d.pal.alt, d.pal.main);
}

function drawGoldenButterfly(d: D): void {
  const c = d.c;
  if (!d.pixel) {
    const g = c.createRadialGradient(0, 0, 0.02, 0, 0, 0.55);
    g.addColorStop(0, 'rgba(255,224,120,0.45)');
    g.addColorStop(1, 'rgba(255,224,120,0)');
    c.fillStyle = g;
    ellipsePath(c, 0, 0, 0.55, 0.55);
    c.fill();
  }
  drawButterflyBody(d, '#ffd24a', '#ffb52e', '#fff6c7');
}

function drawLeaf(d: D): void {
  const c = d.c;
  c.rotate(wob(d, 2.2, 0.45));
  c.beginPath();
  c.moveTo(-0.5, 0);
  c.quadraticCurveTo(-0.1, -0.34, 0.5, 0);
  c.quadraticCurveTo(-0.1, 0.34, -0.5, 0);
  c.closePath();
  fillStroke(d, LEAF_COLORS[d.variant] ?? LEAF_COLORS[0]);
  c.beginPath();
  c.moveTo(-0.46, 0);
  c.lineTo(0.34, 0);
  c.stroke();
}

function drawYarn(d: D): void {
  const c = d.c;
  // The loose thread trails behind (to the left) and ripples a little.
  c.beginPath();
  c.moveTo(-0.3, -0.3);
  c.bezierCurveTo(-0.55, -0.2 + wob(d, 3, 0.06), -0.6, 0.02, -0.85 - 0.1 * clamp(d.p, 0, 1), -0.02 + wob(d, 4, 0.03));
  strokeTwo(d, d.ow * 2.4, d.ow * 1.1, d.pal.accent);
  disc(d, 0, -0.38, 0.38, d.pal.accent);
  c.save();
  c.beginPath();
  ellipsePath(c, 0, -0.38, 0.38, 0.38);
  c.clip();
  c.lineWidth = d.ow * 0.9;
  c.strokeStyle = LIGHT;
  for (let i = -1; i <= 1; i++) {
    c.beginPath();
    c.ellipse(-0.1 + i * 0.12, -0.38, 0.24, 0.4, 0.5, 0, TAU);
    c.stroke();
  }
  c.restore();
  c.strokeStyle = INK;
  c.lineWidth = d.ow;
}

function drawGhost(d: D): void {
  const c = d.c;
  const sway = wob(d, 2, 0.07);
  c.save();
  c.translate(sway, wob(d, 3.1, 0.04, 1));
  c.rotate(sway * 0.8);
  c.beginPath();
  c.moveTo(-0.32, 0.3);
  c.lineTo(-0.32, -0.12);
  c.bezierCurveTo(-0.32, -0.5, 0.32, -0.5, 0.32, -0.12);
  c.lineTo(0.32, 0.3);
  c.quadraticCurveTo(0.24, 0.2, 0.16, 0.3);
  c.quadraticCurveTo(0.08, 0.4, 0, 0.3);
  c.quadraticCurveTo(-0.08, 0.2, -0.16, 0.3);
  c.quadraticCurveTo(-0.24, 0.4, -0.32, 0.3);
  c.closePath();
  c.fillStyle = d.variant === 1 ? 'rgba(210,235,255,0.92)' : 'rgba(255,255,255,0.92)';
  c.fill();
  c.stroke();
  ellipsePath(c, -0.1, -0.14, 0.04, 0.065);
  c.fillStyle = INK;
  c.fill();
  ellipsePath(c, 0.1, -0.14, 0.04, 0.065);
  c.fill();
  ellipsePath(c, 0, -0.02, 0.035, 0.05);
  c.fill();
  dot(c, -0.2, -0.04, 0.04, 'rgba(255,143,163,0.55)');
  dot(c, 0.2, -0.04, 0.04, 'rgba(255,143,163,0.55)');
  c.restore();
}

function drawBox(d: D): void {
  const c = d.c;
  const brown = ['#d9a566', '#c98f55', '#e2b97c', '#b9966a'][d.variant] ?? '#d9a566';
  c.save();
  c.rotate(wob(d, 9, 0.025));
  // Back flaps, the open mouth, then the front.
  polyPath(c, [-0.4, -0.5, -0.3, -0.72, -0.05, -0.5]);
  fillStroke(d, '#e8c48c');
  polyPath(c, [0.4, -0.5, 0.3, -0.72, 0.05, -0.5]);
  fillStroke(d, '#e8c48c');
  polyPath(c, [-0.45, -0.5, 0.45, -0.5, 0.5, -0.4, -0.5, -0.4]);
  fillStroke(d, '#7a5a38');
  polyPath(c, [-0.5, -0.4, 0.5, -0.4, 0.46, 0, -0.46, 0]);
  fillStroke(d, brown);
  polyPath(c, [-0.07, -0.4, 0.07, -0.4, 0.07, -0.18, -0.07, -0.18]);
  c.fillStyle = '#f2e3c0';
  c.fill();
  c.restore();
}

function drawBall(d: D): void {
  const c = d.c;
  const r = 0.34;
  disc(d, 0, -r, r, d.pal.accent);
  c.save();
  ellipsePath(c, 0, -r, r, r);
  c.clip();
  c.translate(0, -r);
  c.rotate(clamp(d.p, 0, 1) * TAU * 3 + d.ph * 0.6 * d.mo);
  c.fillStyle = d.pal.main;
  c.fillRect(-r, -0.07, r * 2, 0.14);
  c.fillRect(-0.07, -r, 0.14, r * 2);
  c.restore();
  c.beginPath();
  c.arc(-0.1, -r - 0.1, 0.17, Math.PI * 1.05, Math.PI * 1.5);
  c.strokeStyle = LIGHT;
  c.lineWidth = d.ow * 1.3;
  c.stroke();
  c.strokeStyle = INK;
  c.lineWidth = d.ow;
}

function cloudCircles(c: Ctx2D, fill: string, ow: number, ink: boolean): void {
  const parts: readonly (readonly [number, number, number])[] = [
    [-0.28, -0.1, 0.18],
    [-0.08, -0.22, 0.24],
    [0.18, -0.14, 0.2],
    [0.34, -0.06, 0.13],
  ];
  c.lineWidth = ow * 2;
  for (const [x, y, r] of parts) {
    ellipsePath(c, x, y, r, r);
    if (ink) c.stroke();
    else {
      c.fillStyle = fill;
      c.fill();
    }
  }
  if (ink) {
    polyPath(c, [-0.46, -0.1, 0.47, -0.06, 0.47, 0.06, -0.46, 0.06]);
    c.stroke();
  } else {
    polyPath(c, [-0.46, -0.1, 0.47, -0.06, 0.47, 0.06, -0.46, 0.06]);
    c.fillStyle = fill;
    c.fill();
  }
}

function drawCloud(d: D): void {
  const c = d.c;
  c.save();
  c.translate(wob(d, 1.3, 0.03), 0.1);
  const fill = d.variant >= 2 ? '#aeb6c6' : '#e4eaf3';
  cloudCircles(c, fill, d.ow, true);
  cloudCircles(c, fill, d.ow, false);
  c.restore();
  c.lineWidth = d.ow;
}

function drawRaindrop(d: D): void {
  const c = d.c;
  c.beginPath();
  c.moveTo(0, -0.5);
  c.bezierCurveTo(0.22, -0.12, 0.24, 0.2, 0, 0.26);
  c.bezierCurveTo(-0.24, 0.2, -0.22, -0.12, 0, -0.5);
  c.closePath();
  fillStroke(d, d.variant === 1 ? '#7ec7ff' : '#9bd6ff');
  c.beginPath();
  c.arc(-0.04, 0.08, 0.1, Math.PI * 0.6, Math.PI * 0.95);
  c.strokeStyle = LIGHT;
  c.stroke();
  c.strokeStyle = INK;
}

function drawBolt(d: D): void {
  const c = d.c;
  // Thin zigzag, never a screen flash. The brief flicker (a blink of the stroke) is gone when calm.
  const flicker = d.calm ? 1 : 0.65 + 0.35 * (Math.sin(d.ph * 70) > -0.2 ? 1 : 0);
  c.globalAlpha *= flicker;
  c.lineJoin = 'miter';
  polyPath(c, [0.08, -0.5, -0.1, -0.12, 0.06, -0.1, -0.12, 0.5], false);
  strokeTwo(d, d.ow * 3.2, d.ow * 1.4, d.variant === 1 ? '#c9f0ff' : '#fff27a');
  c.lineJoin = d.pixel ? 'miter' : 'round';
}

function drawFish(d: D): void {
  const c = d.c;
  const flap = wob(d, 14, 0.5);
  c.save();
  c.rotate(wob(d, 3, 0.08));
  const body = ['#8fc8f2', '#f2a58f', '#a8e0b0', '#d9b0f0'][d.variant] ?? '#8fc8f2';
  polyPath(c, [-0.28, 0, -0.5, -0.17, -0.45, 0, -0.5, 0.17]);
  fillStroke(d, d.pal.accent);
  for (const s of [-1, 1]) {
    c.save();
    c.translate(0.02, -0.04);
    c.rotate(s * (0.9 + flap));
    ellipsePath(c, 0, -0.17, 0.07, 0.19);
    fillStroke(d, d.pal.main);
    c.restore();
  }
  ellipsePath(c, 0.02, 0, 0.3, 0.14);
  fillStroke(d, body);
  c.beginPath();
  c.moveTo(-0.2, 0.05);
  c.quadraticCurveTo(0.05, 0.12, 0.28, 0.04);
  c.strokeStyle = LIGHT;
  c.stroke();
  c.strokeStyle = INK;
  dot(c, 0.2, -0.04, 0.025, INK);
  c.restore();
}

function drawUfo(d: D): void {
  const c = d.c;
  c.save();
  c.translate(0, wob(d, 2.4, 0.04));
  c.rotate(wob(d, 1.7, 0.06));
  c.beginPath();
  c.ellipse(0, -0.08, 0.17, 0.2, 0, Math.PI, TAU);
  c.closePath();
  fillStroke(d, 'rgba(170,230,255,0.9)');
  ellipsePath(c, 0, 0, 0.5, 0.14);
  fillStroke(d, '#c3c8d4');
  for (let i = -1; i <= 1; i++) {
    // The window lights blink in turn; steady (all lit) when calm.
    const on = d.calm || Math.floor(d.ph * 4 + i + 1) % 3 === 1;
    dot(c, i * 0.2, 0.01, 0.035, on ? d.pal.alt : '#8a8fa0');
  }
  c.restore();
}

function drawWindStreak(d: D): void {
  const c = d.c;
  c.lineCap = 'round';
  const slide = wob(d, 2.5, 0.05);
  for (let i = 0; i < 3; i++) {
    const y = -0.2 + i * 0.2;
    const len = 0.5 - i * 0.07;
    c.beginPath();
    c.moveTo(-0.5 + slide, y);
    c.lineTo(len - 0.12 + slide, y);
    c.arc(len - 0.12 + slide, y - 0.07, 0.07, Math.PI / 2, -Math.PI * 0.9, true);
    strokeTwo(d, d.ow * 2.6, d.ow * 1.2, '#eaf6ff');
  }
}

function drawPaperPlane(d: D): void {
  const c = d.c;
  c.save();
  c.rotate(wob(d, 2, 0.15));
  polyPath(c, [0.5, -0.04, -0.5, -0.3, -0.26, 0.0]);
  fillStroke(d, d.pal.main);
  polyPath(c, [0.5, -0.04, -0.26, 0, -0.5, 0.2, -0.1, 0.12]);
  fillStroke(d, d.variant === 1 ? '#bcdcff' : '#dcd7e6');
  c.beginPath();
  c.moveTo(0.5, -0.04);
  c.lineTo(-0.26, 0);
  c.stroke();
  c.restore();
}

function drawSparkle(d: D): void {
  const c = d.c;
  // Twinkle (a size and brightness pulse) only when not calm; calm holds a steady, slightly smaller star.
  const k = d.calm ? 0.9 : 0.72 + 0.28 * Math.sin(d.ph * 6 + d.id);
  const color = ['#fff2a0', '#ffffff', '#ffc2d9', '#b6f0ff'][d.variant] ?? '#fff2a0';
  c.save();
  c.scale(k, k);
  starPath(c, 0, 0, 0.5, 0.11, 4, 0);
  fillStroke(d, color);
  c.restore();
}

function drawShadow(d: D): void {
  const c = d.c;
  const creep = wob(d, 2, 0.02);
  c.save();
  c.translate(creep, 0);
  c.fillStyle = 'rgba(22,18,34,0.82)';
  c.strokeStyle = 'rgba(255,255,255,0.55)';
  ellipsePath(c, -0.02, -0.2, 0.34, 0.2);
  c.fill();
  c.stroke();
  ellipsePath(c, 0.28, -0.34, 0.15, 0.13);
  c.fill();
  c.stroke();
  polyPath(c, [0.18, -0.43, 0.2, -0.58, 0.28, -0.46]);
  c.fill();
  c.stroke();
  polyPath(c, [0.34, -0.45, 0.4, -0.58, 0.41, -0.4]);
  c.fill();
  c.stroke();
  c.beginPath();
  c.moveTo(-0.3, -0.24);
  c.quadraticCurveTo(-0.55, -0.3 + wob(d, 3, 0.1), -0.5, -0.5);
  c.lineWidth = d.ow * 2.6;
  c.strokeStyle = 'rgba(22,18,34,0.82)';
  c.stroke();
  dot(c, 0.25, -0.35, 0.025, '#ffe45c');
  dot(c, 0.33, -0.35, 0.025, '#ffe45c');
  c.restore();
  c.strokeStyle = INK;
  c.lineWidth = d.ow;
}

function drawSpring(d: D): void {
  const c = d.c;
  const squash = 0.5 + 0.5 * Math.sin(d.ph * 8);
  const h = 0.9 - 0.4 * squash * d.mo;
  const color = ['#ff7a8a', '#5fb8ff', '#ffd24a', '#8fe08a'][d.variant] ?? '#ff7a8a';
  ellipsePath(c, 0, -0.01, 0.3, 0.05);
  fillStroke(d, d.pal.alt);
  const turns = 6;
  c.beginPath();
  c.moveTo(0, 0);
  for (let i = 1; i <= turns * 2; i++) c.lineTo(i % 2 === 1 ? 0.26 : -0.26, -(h * i) / (turns * 2));
  c.lineJoin = 'round';
  strokeTwo(d, d.ow * 3, d.ow * 1.5, color);
  disc(d, 0, -h - 0.08, 0.09, d.pal.accent);
}

function drawBubble(d: D): void {
  const c = d.c;
  const q = clamp(d.p, 0, 1);
  // The pop: in the last tenth of its life the film swells and thins out.
  const pop = q > 0.9 ? (q - 0.9) * 10 : 0;
  const w = 1 + wob(d, 5, 0.06) + pop * 0.25;
  const h = 1 - wob(d, 5, 0.06) + pop * 0.25;
  ellipsePath(c, 0, 0, 0.5 * w, 0.5 * h);
  c.fillStyle = 'rgba(190,230,255,0.28)';
  c.fill();
  c.strokeStyle = 'rgba(32,26,44,0.5)';
  c.stroke();
  ellipsePath(c, 0, 0, 0.46 * w, 0.46 * h);
  c.strokeStyle = LIGHT;
  c.stroke();
  c.beginPath();
  c.arc(-0.12, -0.12, 0.28, Math.PI * 1.05, Math.PI * 1.45);
  c.lineWidth = d.ow * 1.6;
  c.stroke();
  c.strokeStyle = INK;
  c.lineWidth = d.ow;
}

function drawBird(d: D): void {
  const c = d.c;
  const body = BIRD_COLORS[d.variant] ?? BIRD_COLORS[0];
  const hop = Math.abs(Math.sin(d.ph * 5)) * 0.07 * d.mo;
  const tilt = wob(d, 2.3, 0.04);
  c.save();
  c.translate(0, -hop);
  c.beginPath();
  c.moveTo(-0.05, 0.02 + hop);
  c.lineTo(-0.05, -0.05);
  c.moveTo(0.08, 0.02 + hop);
  c.lineTo(0.08, -0.05);
  c.stroke();
  polyPath(c, [-0.18, -0.2, -0.5, -0.12, -0.46, -0.24, -0.2, -0.3]);
  fillStroke(d, d.pal.accent);
  ellipsePath(c, 0, -0.22, 0.24, 0.17, -0.2);
  fillStroke(d, body);
  c.save();
  c.translate(-0.04, -0.24);
  c.rotate(wob(d, 9, 0.35) - 0.2);
  ellipsePath(c, -0.06, 0, 0.14, 0.07);
  fillStroke(d, d.pal.main);
  c.restore();
  disc(d, 0.2 + tilt, -0.4, 0.11, body);
  polyPath(c, [0.3 + tilt, -0.42, 0.42 + tilt, -0.38, 0.3 + tilt, -0.35]);
  fillStroke(d, '#ffb347');
  dot(c, 0.23 + tilt, -0.42, 0.022, INK);
  c.restore();
}

function drawStar(d: D): void {
  const c = d.c;
  const q = clamp(d.p, 0, 1);
  // The glowing tail lies behind (to the left); it lengthens as the star gets going.
  const tail = 0.4 + 0.5 * Math.min(1, q * 3);
  polyPath(c, [-0.1, -0.07, -0.1 - tail, 0, -0.1, 0.07]);
  c.fillStyle = 'rgba(255,240,170,0.5)';
  c.fill();
  c.save();
  c.rotate(d.calm ? 0 : d.ph * 1.2);
  starPath(c, 0, 0, 0.3, 0.13, 5, 0);
  fillStroke(d, '#ffe45c');
  c.restore();
}

function drawMeteor(d: D): void {
  const c = d.c;
  const flame = d.calm ? 1 : 0.85 + 0.15 * Math.sin(d.ph * 25);
  polyPath(c, [-0.05, -0.12, -0.5 * flame - 0.4, 0, -0.05, 0.12]);
  c.fillStyle = 'rgba(255,150,70,0.55)';
  c.fill();
  polyPath(c, [-0.05, -0.07, -0.3 * flame - 0.1, 0, -0.05, 0.07]);
  c.fillStyle = 'rgba(255,230,150,0.8)';
  c.fill();
  ellipsePath(c, 0.05, 0, 0.17, 0.15, 0.3);
  fillStroke(d, '#b0a49a');
  dot(c, 0.0, -0.04, 0.03, '#8a7e75');
  dot(c, 0.1, 0.05, 0.022, '#8a7e75');
}

function drawTreasure(d: D): void {
  const c = d.c;
  const open = clamp(d.p, 0, 1);
  const lid = -open * 0.95;
  // Body, then what is inside, then the lid hinged at the back edge.
  polyPath(c, [-0.42, -0.3, 0.42, -0.3, 0.42, 0, -0.42, 0]);
  fillStroke(d, '#a8693a');
  if (open > 0.05) {
    ellipsePath(c, 0, -0.3, 0.4, 0.05);
    fillStroke(d, '#ffd24a');
    dot(c, -0.12, -0.34, 0.05, '#fff1a8');
    dot(c, 0.1, -0.35, 0.045, '#ffb52e');
  }
  c.beginPath();
  c.moveTo(-0.1, -0.3);
  c.lineTo(-0.1, 0);
  c.moveTo(0.1, -0.3);
  c.lineTo(0.1, 0);
  c.strokeStyle = '#ffd24a';
  c.lineWidth = d.ow * 1.6;
  c.stroke();
  c.strokeStyle = INK;
  c.lineWidth = d.ow;
  c.save();
  c.translate(-0.42, -0.3);
  c.rotate(lid);
  c.beginPath();
  c.moveTo(0, 0);
  c.lineTo(0, -0.1);
  c.quadraticCurveTo(0.42, -0.34, 0.84, -0.1);
  c.lineTo(0.84, 0);
  c.closePath();
  fillStroke(d, '#b87743');
  c.beginPath();
  c.moveTo(0.32, -0.02);
  c.lineTo(0.32, -0.2);
  c.moveTo(0.52, -0.02);
  c.lineTo(0.52, -0.2);
  c.strokeStyle = '#ffd24a';
  c.lineWidth = d.ow * 1.6;
  c.stroke();
  c.strokeStyle = INK;
  c.lineWidth = d.ow;
  c.restore();
  disc(d, 0, -0.2, 0.045, '#ffd24a');
}

function drawDragon(d: D): void {
  const c = d.c;
  const g = DRAGON_COLORS[d.variant] ?? DRAGON_COLORS[0];
  const flap = wob(d, 10, 0.5);
  c.save();
  c.translate(0, -Math.abs(Math.sin(d.ph * 3)) * 0.04 * d.mo);
  c.beginPath();
  c.moveTo(-0.22, -0.16);
  c.bezierCurveTo(-0.46, -0.06, -0.42, 0.04 + wob(d, 3, 0.05), -0.55, -0.04);
  strokeTwo(d, d.ow * 3.4, d.ow * 2, g);
  polyPath(c, [-0.58, -0.08, -0.5, -0.02, -0.62, 0.02]);
  fillStroke(d, d.pal.accent);
  c.save();
  c.translate(-0.05, -0.3);
  c.rotate(-0.5 + flap);
  polyPath(c, [0, 0, -0.1, -0.34, 0.08, -0.2, 0.2, -0.3, 0.2, -0.04]);
  fillStroke(d, d.pal.accent);
  c.restore();
  ellipsePath(c, 0, -0.18, 0.26, 0.17);
  fillStroke(d, g);
  ellipsePath(c, 0.02, -0.12, 0.15, 0.09);
  fillStroke(d, '#f6efc4');
  disc(d, 0.26, -0.34, 0.13, g);
  ellipsePath(c, 0.38, -0.31, 0.08, 0.06);
  fillStroke(d, g);
  polyPath(c, [0.2, -0.44, 0.17, -0.58, 0.26, -0.47]);
  fillStroke(d, '#f6efc4');
  dot(c, 0.29, -0.37, 0.022, INK);
  if (d.p > 0.5) {
    // A small puff of flame; steady when calm.
    const f = d.calm ? 1 : 0.8 + 0.2 * Math.sin(d.ph * 20);
    polyPath(c, [0.46, -0.31, 0.46 + 0.16 * f, -0.38, 0.46 + 0.22 * f, -0.3, 0.46 + 0.14 * f, -0.24]);
    c.fillStyle = '#ffb347';
    c.fill();
  }
  c.restore();
}

function drawVisitor(d: D): void {
  const c = d.c;
  const lamp = d.calm ? 1 : 0.85 + 0.15 * Math.sin(d.ph * 13 + d.id);
  c.save();
  c.translate(0, wob(d, 2.2, 0.02));
  polyPath(c, [-0.02, -0.62, -0.3, 0, 0.26, 0]);
  fillStroke(d, '#4b3f78');
  disc(d, -0.02, -0.56, 0.13, '#5d4f90');
  dot(c, -0.07, -0.57, 0.025, '#ffe9a3');
  dot(c, 0.04, -0.57, 0.025, '#ffe9a3');
  // The lantern hangs from an outstretched arm: a warm glow, then the lamp.
  c.beginPath();
  c.moveTo(0.1, -0.36);
  c.lineTo(0.34, -0.3);
  c.stroke();
  if (!d.pixel) {
    const g = c.createRadialGradient(0.36, -0.2, 0.01, 0.36, -0.2, 0.3);
    g.addColorStop(0, `rgba(255,214,120,${0.55 * lamp})`);
    g.addColorStop(1, 'rgba(255,214,120,0)');
    c.fillStyle = g;
    ellipsePath(c, 0.36, -0.2, 0.3, 0.3);
    c.fill();
  }
  polyPath(c, [0.3, -0.3, 0.42, -0.3, 0.43, -0.12, 0.29, -0.12]);
  fillStroke(d, '#ffd878');
  c.restore();
}

const DRAWERS: Readonly<Record<PropKind, (d: D) => void>> = {
  mouse: drawMouse,
  wave: drawWave,
  splash: drawSplash,
  butterfly: drawButterfly,
  goldenButterfly: drawGoldenButterfly,
  leaf: drawLeaf,
  yarn: drawYarn,
  ghost: drawGhost,
  box: drawBox,
  ball: drawBall,
  cloud: drawCloud,
  raindrop: drawRaindrop,
  bolt: drawBolt,
  fish: drawFish,
  ufo: drawUfo,
  windStreak: drawWindStreak,
  paperPlane: drawPaperPlane,
  sparkle: drawSparkle,
  shadow: drawShadow,
  spring: drawSpring,
  bubble: drawBubble,
  bird: drawBird,
  star: drawStar,
  meteor: drawMeteor,
  treasure: drawTreasure,
  dragon: drawDragon,
  visitor: drawVisitor,
};

// ---- entry points ------------------------------------------------------------------------------

export { laserBounds, LASER_RADIUS_DIP, propsBounds };
export type { PropRect };


function drawOne(c: Ctx2D, p: RenderProp, o: DrawPropsOptions, pixel: boolean, d: D): void {
  if (typeof p.kind !== 'string' || !Object.prototype.hasOwnProperty.call(DRAWERS, p.kind)) return;
  const fn = DRAWERS[p.kind];
  const alpha = clamp(Number.isFinite(p.alpha) ? p.alpha : 0, 0, 1);
  const size = Number.isFinite(p.size) ? clamp(p.size, 2, 600) : 0;
  if (alpha <= 0.01 || size < 2 || !Number.isFinite(p.x) || !Number.isFinite(p.y)) return;
  const r = reachDip(p, o.scale);
  if (p.x + r < 0 || p.y + r < 0 || p.x - r > o.width || p.y - r > o.height) return;
  const grid = PIXEL_GRID * outlineScale(o.scale);
  const px = pixel ? Math.round(p.x / grid) * grid : p.x;
  const py = pixel ? Math.round(p.y / grid) * grid : p.y;
  const variant = Number.isInteger(p.variant) ? clamp(p.variant, 0, 3) : 0;
  d.ph = o.t / 1000 + (Number.isFinite(p.id) ? p.id : 0) * 1.37;
  d.pal = PALETTES[variant]!;
  d.variant = variant;
  d.p = Number.isFinite(p.p) ? clamp(p.p, 0, 1) : 0;
  d.id = Number.isFinite(p.id) ? p.id : 0;
  const ow = (pixel ? PIXEL_OUTLINE_DIP : OUTLINE_DIP) * outlineScale(o.scale);
  d.ow = ow / size;
  c.save();
  try {
    c.globalAlpha = alpha;
    c.translate(px, py);
    c.rotate(Number.isFinite(p.rot) ? clamp(p.rot, -20, 20) : 0);
    c.scale(size * (p.dir === -1 ? -1 : 1), size);
    c.lineWidth = d.ow;
    c.lineJoin = pixel ? 'miter' : 'round';
    c.lineCap = pixel ? 'butt' : 'round';
    c.strokeStyle = INK;
    fn(d);
  } finally {
    c.restore();
  }
}

/**
 * Draws the props (overlay-local DIP) into `ctx`, whose transform already maps DIP to device pixels.
 * Unknown kinds and broken numbers draw nothing; this never throws on odd input (a failing drawer
 * is contained to its own prop and the context state is restored).
 */
export function drawProps(ctx: Ctx2D, props: readonly RenderProp[], opts: DrawPropsOptions): void {
  const n = Math.min(props.length, MAX_PROPS);
  if (n === 0) return;
  const pixel = opts.style === 'pixel';
  const d: D = {
    c: ctx,
    ph: 0,
    mo: opts.reducedMotion ? 0.5 : 1,
    calm: opts.reducedMotion,
    ow: 0.04,
    pal: PALETTES[0]!,
    variant: 0,
    p: 0,
    id: 0,
    pixel,
  };
  for (let i = 0; i < n; i++) {
    try {
      drawOne(ctx, props[i]!, opts, pixel, d);
    } catch {
      // One prop's drawer failed: the others (and the cat, drawn after) are not lost to it.
    }
  }
}

// ---- interpolation between two snapshots' props ----------------------------------------------------

const lerp = (a: number, b: number, k: number): number => a + (b - a) * k;

/**
 * Props at fraction `k` between two snapshots, matched by id (a prop only in `a` is drawn as it was,
 * one only in `b` appears when its snapshot becomes current). Reuses `out`; at most MAX_PROPS.
 * A prop that jumped more than `maxJump` DIP between the snapshots (a wrap, a respawn) is not blended.
 */
export function blendProps(a: readonly RenderProp[], b: readonly RenderProp[] | undefined, k: number, out: RenderProp[], maxJump = 400): RenderProp[] {
  out.length = 0;
  const kk = Number.isFinite(k) ? clamp(k, 0, 1) : 0;
  const n = Math.min(a.length, MAX_PROPS);
  for (let i = 0; i < n; i++) {
    const pa = a[i]!;
    let pb: RenderProp | undefined;
    if (b && kk > 0) {
      for (let j = 0; j < b.length && j < MAX_PROPS; j++) {
        if (b[j]!.id === pa.id && b[j]!.kind === pa.kind) {
          pb = b[j];
          break;
        }
      }
    }
    if (!pb || Math.hypot(pb.x - pa.x, pb.y - pa.y) > maxJump) {
      out.push(pa);
      continue;
    }
    out.push({
      id: pa.id,
      kind: pa.kind,
      x: lerp(pa.x, pb.x, kk),
      y: lerp(pa.y, pb.y, kk),
      size: lerp(pa.size, pb.size, kk),
      dir: pa.dir,
      alpha: lerp(pa.alpha, pb.alpha, kk),
      p: lerp(pa.p, pb.p, kk),
      rot: lerp(pa.rot, pb.rot, kk),
      variant: pa.variant,
    });
  }
  return out;
}

// ---- the laser dot ---------------------------------------------------------------------------------


export interface DrawLaserOptions {
  t: number;
  reducedMotion: boolean;
}


/** A red dot with a soft glow; it pulses gently, and not at all under reduced motion. */
export function drawLaser(ctx: Ctx2D, x: number, y: number, o: DrawLaserOptions): void {
  if (!Number.isFinite(x) || !Number.isFinite(y)) return;
  const pulse = o.reducedMotion ? 1 : 1 + 0.12 * Math.sin(o.t / 90);
  const r = LASER_RADIUS_DIP * pulse;
  ctx.save();
  ctx.globalAlpha = 1;
  const glow = ctx.createRadialGradient(x, y, r * 0.6, x, y, LASER_GLOW_DIP);
  glow.addColorStop(0, 'rgba(255,40,40,0.5)');
  glow.addColorStop(1, 'rgba(255,40,40,0)');
  ctx.fillStyle = glow;
  ctx.beginPath();
  ctx.arc(x, y, LASER_GLOW_DIP, 0, TAU);
  ctx.fill();
  ctx.fillStyle = '#ff2a2a';
  ctx.beginPath();
  ctx.arc(x, y, r, 0, TAU);
  ctx.fill();
  ctx.fillStyle = 'rgba(255,220,220,0.9)';
  ctx.beginPath();
  ctx.arc(x - r * 0.3, y - r * 0.3, r * 0.35, 0, TAU);
  ctx.fill();
  ctx.restore();
}
