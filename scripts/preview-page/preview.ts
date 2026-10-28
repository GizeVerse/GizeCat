// Preview page for scripts/render-preview.cjs: renders contact sheets of the real
// overlay rig (same CatScene used by the overlay renderer) into canvases.
import { ANIM_CLIPS, EMOTES, SKINS, type AnimClip, type CatRenderState, type Emote, type SkinId } from '../../src/shared/cat';
import { clipDurationS, gaitHz, loopPeriodS } from '../../src/renderer/overlay/cat/clips';
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
  if (clip === 'walk' || clip === 'run') {
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

function speedFor(clip: AnimClip): number {
  return clip === 'walk' ? 0.7 : clip === 'run' ? 2.6 : 0;
}

function vyFor(clip: AnimClip): number {
  return clip === 'jump' ? -400 : clip === 'fall' ? 450 : 0;
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
  };
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
    const gy = cy + sheet.cellH * (sheet.ground ?? 0.8);
    ctx.strokeStyle = 'rgba(128,128,128,0.35)';
    ctx.beginPath();
    ctx.moveTo(cx + 6, gy + 0.5);
    ctx.lineTo(cx + sheet.cellW - 6, gy + 0.5);
    ctx.stroke();
    renderCell(ctx, c, cx + sheet.cellW / 2, gy, dpr);
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
    for (const t of phases(clip, 6, speed)) {
      cells.push({ label: `${clip} ${t.toFixed(2)}s`, clip, t, look: clip === 'pawAt' ? { x: 40, y: -40 } : null, ...extra });
    }
  }
  return { cols: 6, cellW: 190, cellH: 165, bg, fg, cells, ground: 0.84 };
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
