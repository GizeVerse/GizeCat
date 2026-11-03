// Preview page for scripts/render-preview.cjs: renders contact sheets of the real
// overlay rig (same CatScene used by the overlay renderer) into canvases.
import {
  ANIM_CLIPS,
  CAT_BASE_WIDTH_DIP,
  EMOTES,
  JUMP_KINDS,
  SKINS,
  type AnimClip,
  type BehaviorState,
  type CatRenderState,
  type Emote,
  type JumpKind,
  type SkinId,
} from '../../src/shared/cat';
import { MOVEMENT } from '../../src/core/movement/constants';
import { CLIMB_FADE_MS, clipDurationS, gaitHz, loopPeriodS, SLIP_EDGE_X } from '../../src/renderer/overlay/cat/clips';
import { seededRandom } from '../../src/renderer/overlay/cat/math';
import { CatScene, type Layer, type LayerProvider } from '../../src/renderer/overlay/scene';

interface Cell {
  label: string;
  clip: AnimClip;
  /** Seconds into the clip at which the frame is captured. */
  t: number;
  skin?: SkinId;
  style?: 'smooth' | 'pixel';
  scale?: number;
  facing?: 1 | -1;
  speed?: number;
  vy?: number;
  arousal?: number;
  contentment?: number;
  /** Look target relative to the anchor (DIP at scale 1, facing right). */
  look?: { x: number; y: number } | null;
  emote?: Emote | null;
  emoteAgeMs?: number;
  /** Play this clip first, then switch to `clip` `t` seconds before capture. */
  from?: AnimClip;
  fromT?: number;
  opacity?: number;
  /** Use real random blinks etc. instead of the quiet deterministic RNG. */
  lively?: boolean;
  bg?: string;
  /** Draw a window behind the cat whose side edge runs through the anchor (climb cells). */
  wall?: boolean;
  /** Scripted run with a moving anchor (`t` = seconds into the script); replaces clip/from. */
  script?: Script;
  /**
   * Draw a ledge (a window top) instead of the floor line: it spans `from`..`to` DIP along the
   * facing direction from the anchor (at scale 1) and drops away beyond its ends.
   */
  ledge?: { from: number; to: number };
  /** v1.2 render hints. */
  jumpKind?: JumpKind | null;
  impact?: number;
  balance?: number;
}

/** One leg of a scripted run: the anchor moves to `to` (cell-local DIP) over `ms`, linearly or eased. */
interface Seg {
  clip: AnimClip;
  ms: number;
  to: { x: number; y: number };
  /** Smoothstep instead of linear motion (the mover's mount, pull-up, swing and dismount). */
  ease?: boolean;
  /** Gait speed (body-lengths/s); default: derived from the anchor motion for walk/run/climb, else 0. */
  speed?: number;
  /** Facing during this leg (default: the cell's). */
  facing?: 1 | -1;
  state?: BehaviorState;
}

interface Script {
  start: { x: number; y: number };
  segs: Seg[];
  /** Window drawn behind the cat (cell-local DIP); its left edge is the climbed wall. */
  window: { x: number; y: number; w: number; h: number };
  /** Floor line (cell-local y). */
  floor: number;
}

interface Sheet {
  cols: number;
  cellW: number;
  cellH: number;
  bg: string;
  fg: string;
  cells: Cell[];
  /** Anchor height inside each cell (fraction of cellH from the top). */
  ground?: number;
}

const LIGHT = '#eef1f5';
const DARK = '#1d2230';

const layerCanvas = new OffscreenCanvas(256, 256);
const layerCtx = layerCanvas.getContext('2d');
const layers: LayerProvider = (w, h) => {
  if (!layerCtx) return null;
  if (layerCanvas.width < w || layerCanvas.height < h) {
    layerCanvas.width = Math.max(layerCanvas.width, w);
    layerCanvas.height = Math.max(layerCanvas.height, h);
  }
  const l: Layer = { canvas: layerCanvas, ctx: layerCtx };
  return l;
};

function phases(clip: AnimClip, n: number, speed: number): number[] {
  const out: number[] = [];
  const dur = clipDurationS(clip);
  if (dur !== null) {
    for (let i = 0; i < n; i++) out.push((dur * i) / (n - 1));
    return out;
  }
  if (clip === 'walk' || clip === 'run' || clip === 'stalk' || clip === 'slink' || clip === 'sprint' || (clip === 'climb' && speed > 0)) {
    const hz = gaitHz(clip, speed);
    for (let i = 0; i < n; i++) out.push(1 + i / n / hz);
    return out;
  }
  const period = loopPeriodS(clip) ?? 3;
  const start = clip === 'rollOver' ? 0.15 : clip === 'crouch' ? 0.1 : 1;
  const span = clip === 'rollOver' ? 2.2 : clip === 'crouch' ? 1.2 : period;
  for (let i = 0; i < n; i++) out.push(start + (span * i) / n);
  return out;
}

/** v1.2 gaits at their paces (ADR 0003 §6.7): stalk 24, slink 84, sprint 360 DIP/s. */
const V12_SPEED: Partial<Record<AnimClip, number>> = { stalk: 24 / CAT_BASE_WIDTH_DIP, slink: 1, sprint: 360 / CAT_BASE_WIDTH_DIP };

function speedFor(clip: AnimClip): number {
  return clip === 'walk' ? 0.7 : clip === 'run' ? 2.6 : clip === 'climb' ? 0.5 : (V12_SPEED[clip] ?? 0);
}

function vyFor(clip: AnimClip): number {
  return clip === 'jump' || clip === 'pounce' ? -400 : clip === 'fall' ? 450 : 0;
}

function makeState(c: Cell, clip: AnimClip, x: number, y: number, t: number, clipStart: number, seq: number): CatRenderState {
  const scale = c.scale ?? 1;
  const facing = c.facing ?? 1;
  const look = c.look ? { x: x + c.look.x * scale * facing, y: y + c.look.y * scale } : null;
  return {
    seq,
    t,
    x,
    y,
    snap: seq === 0,
    scale,
    facing,
    state: clip === 'sleep' ? 'sleeping' : 'idle',
    clip,
    clipStartedAt: clipStart,
    speed: c.speed ?? speedFor(clip),
    vy: (c.vy ?? vyFor(clip)) * scale,
    look,
    arousal: c.arousal ?? 0.2,
    contentment: c.contentment ?? 0.6,
    emote: c.emote ?? null,
    emoteStartedAt: c.emote ? t - (c.emoteAgeMs ?? 500) : 0,
    opacity: c.opacity ?? 1,
    visible: true,
    skin: c.skin ?? 'ginger',
    style: c.style ?? 'smooth',
    shadow: true,
    animSpeed: 1,
    ...(c.jumpKind !== undefined ? { jumpKind: c.jumpKind } : {}),
    ...(c.impact !== undefined ? { impact: c.impact } : {}),
    ...(c.balance !== undefined ? { balance: c.balance } : {}),
  };
}

/** Plays a scripted run (moving anchor, clip per leg) at 60 fps up to `c.t`, then draws it. */
function renderScripted(ctx: CanvasRenderingContext2D, c: Cell, script: Script, ox: number, oy: number, dpr: number): void {
  const scene = new CatScene(() => 0.99);
  const dt = 1000 / 60;
  const t0 = 1000;
  const end = t0 + c.t * 1000;
  const scale = c.scale ?? 1;
  let seq = 0;
  let segStart = t0;
  let from = script.start;
  let i = 0;
  for (let t = t0; ; t = Math.min(end, t + dt)) {
    while (i < script.segs.length - 1 && t >= segStart + script.segs[i]!.ms) {
      segStart += script.segs[i]!.ms;
      from = script.segs[i]!.to;
      i++;
    }
    const seg = script.segs[i]!;
    const k0 = Math.min(1, (t - segStart) / seg.ms);
    const k = seg.ease ? k0 * k0 * (3 - 2 * k0) : k0;
    const x = from.x + (seg.to.x - from.x) * k;
    const y = from.y + (seg.to.y - from.y) * k;
    const dist = Math.hypot(seg.to.x - from.x, seg.to.y - from.y);
    const locomotion = seg.clip === 'walk' || seg.clip === 'run' || seg.clip === 'climb';
    const speed = seg.speed ?? (locomotion && k0 < 1 ? dist / (seg.ms / 1000) / (CAT_BASE_WIDTH_DIP * scale) : 0);
    // A run of legs with the same clip is one clip to the brain: it keeps its start time.
    let clipStart = segStart;
    for (let j = i - 1, at = segStart; j >= 0 && script.segs[j]!.clip === seg.clip; j--) {
      at -= script.segs[j]!.ms;
      clipStart = at;
    }
    const st = makeState({ ...c, speed, vy: 0, facing: seg.facing ?? c.facing }, seg.clip, ox + x, oy + y, t, clipStart, seq);
    st.state = seg.state ?? st.state;
    scene.update({ x: ox + x, y: oy + y, state: st, simTime: t, dtMs: seq === 0 ? 0 : dt, snapped: seq === 0 });
    seq++;
    if (t >= end) break;
  }
  scene.draw(ctx, dpr, layers);
}

/** A window behind a climb cell: its side edge is the wall line through the anchor. */
function drawWindow(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, dark: boolean): void {
  ctx.save();
  ctx.fillStyle = dark ? '#2b3242' : '#ffffff';
  ctx.strokeStyle = dark ? '#566078' : '#a7b0c0';
  ctx.lineWidth = 1;
  ctx.fillRect(x, y, w, h);
  ctx.fillStyle = dark ? '#343c4f' : '#e3e8f0';
  ctx.fillRect(x, y, w, Math.min(h, 14));
  ctx.strokeRect(x + 0.5, y + 0.5, w - 1, h - 1);
  ctx.restore();
}

/** Simulates a cell at 60 fps up to its capture time, then draws it. */
function renderCell(ctx: CanvasRenderingContext2D, c: Cell, x: number, y: number, dpr: number): void {
  const scene = new CatScene(c.lively ? seededRandom(7) : () => 0.99);
  const dt = 1000 / 60;
  const t0 = 1000;
  let t = t0;
  let seq = 0;
  const step = (clip: AnimClip, clipStart: number, until: number): void => {
    while (t < until - 1e-6) {
      const st = makeState(c, clip, x, y, t, clipStart, seq);
      scene.update({ x, y, state: st, simTime: t, dtMs: seq === 0 ? 0 : dt, snapped: seq === 0 });
      seq++;
      t = Math.min(until, t + dt);
    }
    const st = makeState(c, clip, x, y, t, clipStart, seq);
    scene.update({ x, y, state: st, simTime: t, dtMs: dt, snapped: seq === 0 });
    seq++;
  };
  if (c.from) {
    const fromEnd = t0 + (c.fromT ?? 1.2) * 1000;
    step(c.from, t0, fromEnd);
    step(c.clip, fromEnd, fromEnd + c.t * 1000);
  } else {
    // Pre-roll the clip from its start so tail physics and fades settle naturally.
    step(c.clip, t0, t0 + c.t * 1000);
  }
  scene.draw(ctx, dpr, layers);
}

function renderSheet(sheet: Sheet, dpr: number): string {
  const rows = Math.ceil(sheet.cells.length / sheet.cols);
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(sheet.cols * sheet.cellW * dpr);
  canvas.height = Math.round(rows * sheet.cellH * dpr);
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('no 2d context');
  ctx.fillStyle = sheet.bg;
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  sheet.cells.forEach((c, i) => {
    const col = i % sheet.cols;
    const row = Math.floor(i / sheet.cols);
    const cx = col * sheet.cellW;
    const cy = row * sheet.cellH;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    if (c.bg) {
      ctx.fillStyle = c.bg;
      ctx.fillRect(cx, cy, sheet.cellW, sheet.cellH);
    }
    ctx.strokeStyle = 'rgba(128,128,128,0.25)';
    ctx.lineWidth = 1;
    ctx.strokeRect(cx + 0.5, cy + 0.5, sheet.cellW - 1, sheet.cellH - 1);
    const dark = (c.bg ?? sheet.bg) === DARK;
    if (c.script) {
      const w = c.script.window;
      drawWindow(ctx, cx + w.x, cy + w.y, w.w, w.h, dark);
      ctx.strokeStyle = 'rgba(128,128,128,0.35)';
      ctx.beginPath();
      ctx.moveTo(cx + 6, cy + c.script.floor + 0.5);
      ctx.lineTo(cx + sheet.cellW - 6, cy + c.script.floor + 0.5);
      ctx.stroke();
      renderScripted(ctx, c, c.script, cx, cy, dpr);
    } else {
      const gy = cy + sheet.cellH * (sheet.ground ?? 0.8);
      const ax = cx + sheet.cellW / 2;
      if (c.ledge) {
        const f = c.facing ?? 1;
        const k = c.scale ?? 1;
        const a = ax + f * c.ledge.from * k;
        const b = ax + f * c.ledge.to * k;
        const x0 = Math.max(cx + 4, Math.min(a, b));
        const x1 = Math.min(cx + sheet.cellW - 4, Math.max(a, b));
        drawWindow(ctx, x0, gy, x1 - x0, cy + sheet.cellH - 4 - gy, dark);
      } else if (c.wall) {
        // The wall line runs through the anchor; the window is on the side the cat faces.
        const f = c.facing ?? 1;
        const top = cy + 22;
        const bottom = gy + 0.12 * sheet.cellH;
        if (f > 0) drawWindow(ctx, ax, top, cx + sheet.cellW - 8 - ax, bottom - top, dark);
        else drawWindow(ctx, cx + 8, top, ax - cx - 8, bottom - top, dark);
      } else {
        ctx.strokeStyle = 'rgba(128,128,128,0.35)';
        ctx.beginPath();
        ctx.moveTo(cx + 6, gy + 0.5);
        ctx.lineTo(cx + sheet.cellW - 6, gy + 0.5);
        ctx.stroke();
      }
      renderCell(ctx, c, ax, gy, dpr);
    }
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.globalAlpha = 1;
    ctx.fillStyle = c.bg === DARK ? '#c9d1e0' : c.bg === LIGHT ? '#4a5263' : sheet.fg;
    ctx.font = '11px Segoe UI, sans-serif';
    ctx.fillText(c.label, cx + 6, cy + 14);
  });
  return canvas.toDataURL('image/png');
}

// ---------------------------------------------------------------------------
// Sheet definitions

function clipRows(clips: readonly AnimClip[], bg: string, fg: string, extra: Partial<Cell> = {}): Sheet {
  const cells: Cell[] = [];
  for (const clip of clips) {
    const speed = speedFor(clip);
    if (clip === 'pounce') {
      // Airborne: the pose follows vy from the take-off through the apex down onto the prey.
      for (let i = 0; i < 6; i++) {
        const vy = -400 + (800 * i) / 5;
        cells.push({ label: `pounce vy ${vy.toFixed(0)}`, clip, t: i === 0 ? 0.06 : 0.3, vy, look: { x: 90, y: 0 }, ...extra });
      }
      continue;
    }
    for (const t of phases(clip, 6, speed)) {
      const look = clip === 'pawAt' || clip === 'swat' ? { x: 40, y: -40 } : clip === 'edgeSit' ? { x: 50, y: 70 } : null;
      const ledge = clip === 'slip' ? { from: SLIP_EDGE_X, to: 300 } : clip === 'edgeSit' ? { from: -300, to: 13 } : clip === 'balance' ? { from: -300, to: 300 } : undefined;
      cells.push({ label: `${clip} ${t.toFixed(2)}s`, clip, t, look, ...(ledge ? { ledge } : {}), ...(clip === 'balance' ? { balance: 0.7 } : {}), ...extra });
    }
  }
  return { cols: 6, cellW: 190, cellH: 165, bg, fg, cells, ground: 0.84 };
}

// ---------------------------------------------------------------------------
// v1.2 (ADR 0003 §8): the 14 new clips, the flight kinds and the render hints

const V12_A: AnimClip[] = ['stalk', 'sprint', 'slink', 'pounce', 'slip', 'impact', 'landRecover'];
const V12_B: AnimClip[] = ['swat', 'hiss', 'grumpy', 'stretch', 'balance', 'tailChase', 'edgeSit'];

/** Rows of v1.2 clips with room below the ground line (the slip hangs below its ledge). */
function v12Rows(clips: readonly AnimClip[], bg: string, fg: string, extra: Partial<Cell> = {}): Sheet {
  return { ...clipRows(clips, bg, fg, extra), cellH: 175, ground: 0.7 };
}

/** jump/fall for every flight kind (none = the v1.1 poses): take-off, rising, apex, falling. */
function airSheet(style: 'smooth' | 'pixel', scale: number): Sheet {
  const cells: Cell[] = [];
  for (const kind of [null, ...JUMP_KINDS] as (JumpKind | null)[]) {
    const k = kind ?? 'none';
    cells.push({ label: `${k} jump 0.05s`, clip: 'jump', t: 0.05, vy: -450, jumpKind: kind, style, scale });
    cells.push({ label: `${k} jump rising`, clip: 'jump', t: 0.25, vy: -450, jumpKind: kind, style, scale });
    cells.push({ label: `${k} jump apex`, clip: 'jump', t: 0.4, vy: -40, jumpKind: kind, style, scale });
    cells.push({ label: `${k} fall 200`, clip: 'fall', t: 0.2, vy: 200, jumpKind: kind, style, scale });
    cells.push({ label: `${k} fall 500`, clip: 'fall', t: 0.3, vy: 500, jumpKind: kind, style, scale });
  }
  const k = Math.max(1, scale * 0.8);
  return { cols: 5, cellW: 190 * k, cellH: 175 * k, bg: LIGHT, fg: '#333', cells, ground: 0.72 };
}

/** impact and balance hints: landings at 0 / 0.5 / 1, the balance sway, a clinging cat holding on at a top, the crouch wiggle. */
function hintsSheet(style: 'smooth' | 'pixel'): Sheet {
  const cells: Cell[] = [];
  for (const impact of [0, 0.5, 1]) {
    cells.push({ label: `land ${impact} 0.05s`, clip: 'land', t: 0.05, impact, style });
    cells.push({ label: `impact ${impact} 0.06s`, clip: 'impact', t: 0.06, impact, style });
    cells.push({ label: `impact ${impact} 0.45s`, clip: 'impact', t: 0.45, impact, style });
    cells.push({ label: `recover ${impact} 0.2s`, clip: 'landRecover', t: 0.2, impact, style });
    cells.push({ label: `recover ${impact} 0.5s`, clip: 'landRecover', t: 0.5, impact, style });
    cells.push({ label: `recover ${impact} 0.9s`, clip: 'landRecover', t: 0.9, impact, style });
  }
  for (const balance of [0, 0.5, 1]) {
    for (const t of [1.0, 1.45, 1.9, 2.3]) cells.push({ label: `balance ${balance} ${t}s`, clip: 'balance', t, balance, style });
    cells.push({ label: `cling bal ${balance}`, clip: 'climb', t: 1.3, speed: 0, balance, wall: true, style });
    const ct = balance === 0 ? 0.05 : balance === 0.5 ? 0.15 : 0.3;
    cells.push({ label: `crouch ${ct}s`, clip: 'crouch', t: ct, style });
  }
  return { cols: 6, cellW: 190, cellH: 175, bg: LIGHT, fg: '#333', cells, ground: 0.72 };
}

/** The clips that must read as silhouettes in pixel style (hiss, swat), and other v1.2 clips, in every skin. */
function pixelSkinsSheet(bg: string, fg: string): Sheet {
  const cells: Cell[] = [];
  for (const skin of SKINS) {
    cells.push({ label: `${skin} hiss`, clip: 'hiss', t: 0.5, skin, style: 'pixel' });
    cells.push({ label: `${skin} swat`, clip: 'swat', t: 0.21, skin, style: 'pixel', look: { x: 60, y: -30 } });
    cells.push({ label: `${skin} stalk`, clip: 'stalk', t: 1.2, skin, style: 'pixel' });
    cells.push({ label: `${skin} pounce`, clip: 'pounce', t: 0.3, vy: 250, skin, style: 'pixel' });
    cells.push({ label: `${skin} grumpy`, clip: 'grumpy', t: 1.5, skin, style: 'pixel' });
    cells.push({ label: `${skin} slink`, clip: 'slink', t: 1.1, skin, style: 'pixel' });
  }
  return { cols: 6, cellW: 170, cellH: 150, bg, fg, cells, ground: 0.74 };
}

function skinsSheet(bg: string, fg: string, style: 'smooth' | 'pixel'): Sheet {
  const clips: AnimClip[] = ['stand', 'sit', 'walk', 'loaf', 'sleep', 'petted'];
  const cells: Cell[] = [];
  for (const skin of SKINS) {
    for (const clip of clips) {
      cells.push({ label: `${skin} ${clip}`, clip, t: clip === 'walk' ? 1.1 : 1.4, skin, scale: 1.5, style });
    }
  }
  return { cols: clips.length, cellW: 160, cellH: 135, bg, fg, cells, ground: 0.85 };
}

function scalesSheet(): Sheet {
  const cells: Cell[] = [];
  for (const bg of [LIGHT, DARK]) {
    for (const style of ['smooth', 'pixel'] as const) {
      for (const scale of [0.6, 1, 2]) {
        for (const clip of ['stand', 'sit'] as const) {
          cells.push({ label: `${style} x${scale} ${clip}`, clip, t: 1.2, scale, style, bg, skin: bg === DARK ? 'black' : 'ginger' });
        }
      }
    }
  }
  return { cols: 6, cellW: 200, cellH: 175, bg: LIGHT, fg: '#333', cells, ground: 0.86 };
}

function facesSheet(): Sheet {
  const f: [string, AnimClip, number, Partial<Cell>][] = [
    ['stand', 'stand', 1.2, {}],
    ['look up-right', 'stand', 1.2, { look: { x: 60, y: -90 } }],
    ['look down', 'stand', 1.2, { look: { x: 50, y: 10 } }],
    ['look back', 'stand', 1.2, { look: { x: -80, y: -40 } }],
    ['annoyed', 'annoyed', 1.0, {}],
    ['petted', 'petted', 1.0, {}],
    ['meow', 'meow', 0.32, {}],
    ['yawn', 'yawn', 0.5, {}],
    ['startle', 'startle', 0.3, {}],
    ['sleep', 'sleep', 1.0, {}],
    ['loaf content', 'loaf', 1.0, { contentment: 1 }],
    ['groom lick', 'groom', 0.9, {}],
  ];
  const cells: Cell[] = f.map(([label, clip, t, extra]) => ({ label, clip, t, scale: 3.2, ...extra }));
  return { cols: 4, cellW: 300, cellH: 260, bg: LIGHT, fg: '#333', cells, ground: 0.92 };
}

function emotesSheet(): Sheet {
  const cells: Cell[] = [];
  for (const emote of EMOTES) {
    for (const age of [90, 500, 1300]) {
      cells.push({ label: `${emote} ${age}ms`, clip: 'sit', t: 1, emote, emoteAgeMs: age, scale: 1.4 });
    }
  }
  return { cols: 6, cellW: 150, cellH: 165, bg: LIGHT, fg: '#333', cells, ground: 0.88 };
}

function transitionsSheet(): Sheet {
  const pairs: [AnimClip, AnimClip][] = [
    ['stand', 'sit'],
    ['sit', 'loaf'],
    ['loaf', 'sleep'],
    ['sleep', 'wake'],
    ['walk', 'stand'],
    ['stand', 'startle'],
    ['stand', 'rollOver'],
    ['rollOver', 'stand'],
    ['stand', 'held'],
  ];
  const cells: Cell[] = [];
  for (const [a, b] of pairs) {
    for (const ms of [0, 50, 100, 150, 200, 260]) {
      cells.push({ label: `${a}>${b} +${ms}ms`, clip: b, t: ms / 1000, from: a, fromT: 1.2 });
    }
  }
  return { cols: 6, cellW: 180, cellH: 160, bg: LIGHT, fg: '#333', cells, ground: 0.82 };
}

function facingSheet(): Sheet {
  const cells: Cell[] = [];
  for (const clip of ['stand', 'walk', 'sit', 'held'] as const) {
    cells.push({ label: `${clip} facing -1`, clip, t: 1.1, facing: -1, scale: 1.4 });
  }
  return { cols: 4, cellW: 180, cellH: 170, bg: LIGHT, fg: '#333', cells, ground: 0.84 };
}

function focusSheet(clips: AnimClip[]): Sheet {
  const s = clipRows(clips, LIGHT, '#333', { scale: 2.3 });
  return { ...s, cellW: 250, cellH: 215, ground: 0.86 };
}

// ---------------------------------------------------------------------------
// Climb (v1.1): clinging to a window's side edge and climbing it

/** Moments of the clinging-still idle: settled, glance down, re-grip, look up. */
const CLIMB_STILL_T = [1.0, 2.55, 4.0, 5.55];

function climbCells(extra: Partial<Cell>, labelPrefix = ''): Cell[] {
  const cells: Cell[] = [];
  const hz = gaitHz('climb', 0.5);
  for (const t of CLIMB_STILL_T) cells.push({ label: `${labelPrefix}still ${t.toFixed(2)}s`, clip: 'climb', t, speed: 0, wall: true, ...extra });
  for (let i = 0; i < 4; i++) {
    const t = 1 + i / 4 / hz;
    cells.push({ label: `${labelPrefix}climb ${t.toFixed(2)}s`, clip: 'climb', t, speed: 0.5, wall: true, ...extra });
  }
  return cells;
}

function climbFocusSheet(): Sheet {
  const cells = [...climbCells({ scale: 2.3 }), ...climbCells({ scale: 2.3, facing: -1 }, 'f-1 ')];
  return { cols: 4, cellW: 250, cellH: 330, bg: LIGHT, fg: '#333', cells, ground: 0.71 };
}

/** One climbing cycle in 8 phases, at a brisk and a slow climb. */
function climbCycleSheet(): Sheet {
  const cells: Cell[] = [];
  for (const speed of [0.5, 0.2]) {
    const hz = gaitHz('climb', speed);
    for (let i = 0; i < 8; i++) {
      const t = 1 + i / 8 / hz;
      cells.push({ label: `v${speed} ${(i / 8).toFixed(3)}`, clip: 'climb', t, speed, wall: true, scale: 1.8 });
    }
  }
  return { cols: 8, cellW: 190, cellH: 280, bg: LIGHT, fg: '#333', cells, ground: 0.77 };
}

function climbSkinsSheet(bg: string, fg: string, style: 'smooth' | 'pixel'): Sheet {
  const cells: Cell[] = [];
  const hz = gaitHz('climb', 0.5);
  for (const skin of SKINS) {
    const base = { clip: 'climb' as const, skin, scale: 1.4, style, wall: true };
    cells.push({ ...base, label: `${skin} still`, t: 1.0, speed: 0 });
    cells.push({ ...base, label: `${skin} glance`, t: 2.55, speed: 0 });
    cells.push({ ...base, label: `${skin} climb a`, t: 1, speed: 0.5 });
    cells.push({ ...base, label: `${skin} climb b`, t: 1 + 0.5 / hz, speed: 0.5 });
    cells.push({ ...base, label: `${skin} f-1 still`, t: 1.0, speed: 0, facing: -1 });
    cells.push({ ...base, label: `${skin} f-1 climb`, t: 1 + 0.25 / hz, speed: 0.5, facing: -1 });
  }
  return { cols: 6, cellW: 150, cellH: 210, bg, fg, cells, ground: 0.76 };
}

function climbScalesSheet(): Sheet {
  const cells: Cell[] = [];
  for (const bg of [LIGHT, DARK]) {
    for (const style of ['smooth', 'pixel'] as const) {
      for (const scale of [0.6, 1, 2]) {
        cells.push({ label: `${style} x${scale} climb`, clip: 'climb', t: 1.2, speed: 0.5, scale, style, bg, wall: true, skin: bg === DARK ? 'black' : 'ginger' });
      }
    }
  }
  return { cols: 6, cellW: 200, cellH: 280, bg: LIGHT, fg: '#333', cells, ground: 0.76 };
}

function climbEmotesSheet(): Sheet {
  const cells: Cell[] = [];
  for (const emote of EMOTES) cells.push({ label: emote, clip: 'climb', t: 1, speed: 0, emote, emoteAgeMs: 500, scale: 1.4, wall: true });
  cells.push({ label: 'heart f-1', clip: 'climb', t: 1, speed: 0, emote: 'heart', emoteAgeMs: 900, scale: 1.4, wall: true, facing: -1 });
  return { cols: 4, cellW: 170, cellH: 230, bg: LIGHT, fg: '#333', cells, ground: 0.8 };
}

function climbTransitionsSheet(): Sheet {
  const pairs: [AnimClip, AnimClip][] = [
    ['walk', 'climb'],
    ['stand', 'climb'],
    ['crouch', 'climb'],
    ['jump', 'climb'],
    ['climb', 'stand'],
    ['climb', 'walk'],
    ['climb', 'fall'],
    ['climb', 'held'],
  ];
  const cells: Cell[] = [];
  for (const [a, b] of pairs) {
    for (const ms of [0, 60, 120, 180, 230, CLIMB_FADE_MS + 20]) {
      cells.push({
        label: `${a}>${b} +${ms}ms`,
        clip: b,
        t: ms / 1000,
        from: a,
        fromT: a === 'crouch' ? 0.6 : 1.2,
        speed: b === 'climb' ? (a === 'stand' ? 0 : 0.5) : b === 'walk' ? 0.7 : a === 'walk' ? 0.7 : 0,
        vy: b === 'fall' ? 300 : a === 'jump' ? -200 : 0,
        wall: true,
      });
    }
  }
  return { cols: 6, cellW: 180, cellH: 200, bg: LIGHT, fg: '#333', cells, ground: 0.82 };
}

/**
 * Geometry of the climb strips, cell-local DIP, as the mover sees a window side (core/movement
 * world.ts wallTrack and surfaceGraph cornerX): the cat stands 0.55 body lengths out from the wall
 * before mounting it, the climb ends 0.55 body lengths below the top edge, and it pulls up to half
 * a body length inside the top corner.
 */
function stripGeometry(f: 1 | -1, s: number): { W: number; floor: number; top: number; wallX: number; yTop: number; standX: number; cornerX: number; window: Script['window'] } {
  const W = 230;
  const floor = 238;
  const top = 92;
  const wallX = f > 0 ? 150 : W - 150;
  const bl = CAT_BASE_WIDTH_DIP * s;
  const window = f > 0 ? { x: wallX, y: top, w: W - wallX - 4, h: floor - top + 6 } : { x: 4, y: top, w: wallX - 4, h: floor - top + 6 };
  return { W, floor, top, wallX, yTop: top + 0.55 * bl, standX: wallX - f * 0.55 * bl, cornerX: wallX + f * 0.5 * bl, window };
}

/** Seconds into a script at which each of its segments starts (plus its end). */
function segStarts(segs: readonly Seg[]): number[] {
  const out = [0];
  for (const sg of segs) out.push(out[out.length - 1]! + sg.ms / 1000);
  return out;
}

/** Samples `n` moments spread over segment `i` (from `a` to `b` of its duration). */
function within(starts: readonly number[], i: number, n: number, a = 0.15, b = 0.95): number[] {
  const t0 = starts[i]!;
  const d = starts[i + 1]! - t0;
  return Array.from({ length: n }, (_, k) => t0 + d * (n === 1 ? (a + b) / 2 : a + ((b - a) * k) / (n - 1)));
}

/**
 * Walk to a window, mount its side edge, climb it, hold, pull up over the corner and stand on its
 * top, with the mover's timings and speeds (MOVEMENT) at movement speed 1. By default the clip
 * leaves 'climb' as the pull-up starts, so the cross-fade runs while the anchor rises onto the ledge;
 * `pullUpClip: 'climb'` keeps the clip on the wall until the pull-up has ended instead (for comparison).
 */
function climbStripSheet(bg: string, facing: 1 | -1, style: 'smooth' | 'pixel', skin: SkinId, pullUpClip: AnimClip = 'stand'): Sheet {
  const s = 1.3;
  const f = facing;
  const g = stripGeometry(f, s);
  const start = { x: g.standX - f * 80, y: g.floor };
  const segs: Seg[] = [
    { clip: 'walk', ms: (80 / (MOVEMENT.walkDip * s)) * 1000, to: { x: g.standX, y: g.floor } },
    { clip: 'climb', ms: MOVEMENT.mountMs, to: { x: g.wallX, y: g.floor }, speed: 0, ease: true },
    { clip: 'climb', ms: ((g.floor - g.yTop) / (MOVEMENT.climbUpDip * s)) * 1000, to: { x: g.wallX, y: g.yTop }, speed: MOVEMENT.climbUpDip / CAT_BASE_WIDTH_DIP },
    { clip: 'climb', ms: 700, to: { x: g.wallX, y: g.yTop }, speed: 0 },
    { clip: pullUpClip, ms: MOVEMENT.pullUpMs, to: { x: g.cornerX, y: g.top }, speed: 0, ease: true, state: 'idle' },
    { clip: 'stand', ms: 1500, to: { x: g.cornerX, y: g.top }, state: 'idle' },
  ];
  const script: Script = { start, segs, window: g.window, floor: g.floor };
  const st = segStarts(segs);
  const marks = [...within(st, 0, 1, 0.6), ...within(st, 1, 3, 0.25, 1), ...within(st, 2, 4), ...within(st, 3, 1, 0.8), ...within(st, 4, 7, 0.1, 1), ...within(st, 5, 2, 0.1, 0.8)];
  const cells: Cell[] = marks.map((t) => ({ label: `${t.toFixed(2)}s`, clip: 'stand', t, scale: s, facing, style, skin, script }));
  return { cols: 6, cellW: g.W, cellH: 250, bg, fg: bg === DARK ? '#c9d1e0' : '#333', cells };
}

/**
 * Walk along a window top to its corner, swing down onto the side edge (turning to face the
 * window), climb down tail first, step off onto the floor and walk away.
 */
function climbDownStripSheet(bg: string, facing: 1 | -1, style: 'smooth' | 'pixel', skin: SkinId): Sheet {
  const s = 1.3;
  const f = facing;
  const g = stripGeometry(f, s);
  const start = { x: g.cornerX + f * 60, y: g.top };
  const away = { x: g.standX - f * 50, y: g.floor };
  const segs: Seg[] = [
    { clip: 'walk', ms: (60 / (MOVEMENT.walkDip * s)) * 1000, to: { x: g.cornerX, y: g.top }, facing: f > 0 ? -1 : 1 },
    { clip: 'climb', ms: MOVEMENT.swingMs, to: { x: g.wallX, y: g.yTop }, speed: 0, ease: true },
    { clip: 'climb', ms: ((g.floor - g.yTop) / (MOVEMENT.climbDownDip * s)) * 1000, to: { x: g.wallX, y: g.floor }, speed: MOVEMENT.climbDownDip / CAT_BASE_WIDTH_DIP },
    { clip: 'stand', ms: MOVEMENT.dismountMs, to: { x: g.standX, y: g.floor }, ease: true, state: 'idle' },
    { clip: 'walk', ms: (50 / (MOVEMENT.walkDip * s)) * 1000, to: away, facing: f > 0 ? -1 : 1 },
    { clip: 'stand', ms: 800, to: away, facing: f > 0 ? -1 : 1, state: 'idle' },
  ];
  const script: Script = { start, segs, window: g.window, floor: g.floor };
  const st = segStarts(segs);
  const marks = [...within(st, 0, 1, 0.7), ...within(st, 1, 5, 0.1, 1), ...within(st, 2, 6, 0.1, 0.95), ...within(st, 3, 3, 0.2, 1), ...within(st, 4, 2, 0.3, 0.9), ...within(st, 5, 1, 0.5)];
  const cells: Cell[] = marks.map((t) => ({ label: `${t.toFixed(2)}s`, clip: 'stand', t, scale: s, facing, style, skin, script }));
  return { cols: 6, cellW: g.W, cellH: 250, bg, fg: bg === DARK ? '#c9d1e0' : '#333', cells };
}

const SHEETS: Record<string, () => Sheet> = {
  'focus-a': () => focusSheet(['run', 'wake', 'held']),
  'focus-b': () => focusSheet(['crouch', 'jump', 'fall', 'hide']),
  'focus-c': () => focusSheet(['rollOver', 'groom', 'pawAt']),
  'clips-1': () => clipRows(ANIM_CLIPS.slice(0, 7), LIGHT, '#333', { scale: 1.6 }),
  'clips-2': () => clipRows(ANIM_CLIPS.slice(7, 14), LIGHT, '#333', { scale: 1.6 }),
  'clips-3': () => clipRows(ANIM_CLIPS.slice(14), LIGHT, '#333', { scale: 1.6 }),
  'clips-dark': () => clipRows(['stand', 'walk', 'sleep', 'startle'], DARK, '#c9d1e0', { scale: 1.6, skin: 'black' }),
  'skins-light': () => skinsSheet(LIGHT, '#333', 'smooth'),
  'skins-dark': () => skinsSheet(DARK, '#c9d1e0', 'smooth'),
  'pixel-light': () => skinsSheet(LIGHT, '#333', 'pixel'),
  'pixel-dark': () => skinsSheet(DARK, '#c9d1e0', 'pixel'),
  scales: scalesSheet,
  faces: facesSheet,
  emotes: emotesSheet,
  transitions: transitionsSheet,
  facing: facingSheet,
  'climb-focus': climbFocusSheet,
  'climb-cycle': climbCycleSheet,
  'climb-skins-light': () => climbSkinsSheet(LIGHT, '#333', 'smooth'),
  'climb-skins-dark': () => climbSkinsSheet(DARK, '#c9d1e0', 'smooth'),
  'climb-pixel-light': () => climbSkinsSheet(LIGHT, '#333', 'pixel'),
  'climb-pixel-dark': () => climbSkinsSheet(DARK, '#c9d1e0', 'pixel'),
  'climb-scales': climbScalesSheet,
  'climb-emotes': climbEmotesSheet,
  'climb-transitions': climbTransitionsSheet,
  'climb-strip': () => climbStripSheet(LIGHT, 1, 'smooth', 'ginger'),
  'climb-strip-mirror': () => climbStripSheet(DARK, -1, 'pixel', 'tuxedo'),
  'climb-strip-late-switch': () => climbStripSheet(LIGHT, 1, 'smooth', 'ginger', 'climb'),
  'climb-strip-down': () => climbDownStripSheet(LIGHT, 1, 'smooth', 'calico'),
  'climb-strip-down-mirror': () => climbDownStripSheet(DARK, -1, 'smooth', 'gray'),
  // v1.2: render with --dpr=1.25 for the 125 % review (size 1).
  'v12-clips-smooth-a': () => v12Rows(V12_A, LIGHT, '#333'),
  'v12-clips-smooth-b': () => v12Rows(V12_B, LIGHT, '#333'),
  'v12-clips-pixel-a': () => v12Rows(V12_A, LIGHT, '#333', { style: 'pixel' }),
  'v12-clips-pixel-b': () => v12Rows(V12_B, LIGHT, '#333', { style: 'pixel' }),
  'v12-clips-dark-pixel': () => v12Rows([...V12_A, ...V12_B], DARK, '#c9d1e0', { style: 'pixel', skin: 'black' }),
  'v12-focus-a': () => ({ ...focusSheet(V12_A), ground: 0.7 }),
  'v12-focus-b': () => ({ ...focusSheet(V12_B), ground: 0.7 }),
  'v12-air-smooth': () => airSheet('smooth', 1),
  'v12-air-pixel': () => airSheet('pixel', 1),
  'v12-air-focus': () => airSheet('smooth', 2),
  'v12-hints-smooth': () => hintsSheet('smooth'),
  'v12-hints-pixel': () => hintsSheet('pixel'),
  'v12-pixel-skins-light': () => pixelSkinsSheet(LIGHT, '#333'),
  'v12-pixel-skins-dark': () => pixelSkinsSheet(DARK, '#c9d1e0'),
};

/** Average cost of update+draw per frame (ms) over `frames` frames of a walking cat. */
function bench(frames: number, style: 'smooth' | 'pixel'): { avgMs: number; p95Ms: number } {
  const canvas = document.createElement('canvas');
  canvas.width = 800;
  canvas.height = 400;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('no 2d context');
  const scene = new CatScene(seededRandom(3));
  const times: number[] = [];
  const cell: Cell = { label: '', clip: 'walk', t: 0, style, speed: 0.7 };
  for (let i = 0; i < frames; i++) {
    const t = 1000 + i * (1000 / 60);
    const x = 100 + ((i * 1.2) % 600);
    const st = makeState(cell, i % 600 < 300 ? 'walk' : 'sit', x, 300, t, 1000 + Math.floor(i / 300) * 5000, i);
    const t0 = performance.now();
    scene.update({ x, y: 300, state: st, simTime: t, dtMs: 1000 / 60, snapped: i === 0 });
    ctx.clearRect(0, 0, 800, 400);
    scene.draw(ctx, 1.25, layers);
    times.push(performance.now() - t0);
  }
  times.sort((a, b) => a - b);
  const avg = times.reduce((s, v) => s + v, 0) / times.length;
  return { avgMs: avg, p95Ms: times[Math.floor(times.length * 0.95)] ?? avg };
}

declare global {
  interface Window {
    __preview: {
      list(): string[];
      render(name: string, dpr: number): string;
      bench(frames: number, style: 'smooth' | 'pixel'): { avgMs: number; p95Ms: number };
    };
  }
}

window.__preview = {
  list: () => Object.keys(SHEETS),
  render: (name, dpr) => {
    const make = SHEETS[name];
    if (!make) throw new Error(`unknown sheet ${name}`);
    return renderSheet(make(), dpr);
  },
  bench,
};
