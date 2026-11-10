// The motion families behind the world events. Eight small mechanics, each reading its event's catalogue
// entry; an event's own character comes from the table (sizes, speeds, heights, outcomes) and from the
// per-event branches inside a family (a ghost drifts, a shadow slides; a golden butterfly lingers and
// leaves a sparkle trail, a plain one flits away at the first approach).
//
// Actors (mouse, butterfly, bird) are small state machines because they react to the cat (a mouse bolts
// when the cat gets close); everything else is a closed-form Track (tracks.ts) planned once at init.
// All positions are world px. A prop's size is a fraction of the cat's body width, so props scale with
// appearance.size and with the display scale alike. Every prop is clamped into the stage by the engine
// afterwards; the mechanics only have to aim sensibly.
import type { PropKind, RenderProp } from '../../shared/companion';
import type { Point, Rect } from '../../shared/geometry';
import type { EventDef, MechanicId, OutcomeDef } from './catalog';
import type { EventCatView } from './types';
import { evalTrack, hold, makeTrack, seg, tracksEnd, type Track, type TrackInit } from './tracks';

/** Wave height as a fraction of its width (prop.size): 0.18 x 3.6 body widths = 0.65 body widths = ~0.85 cat heights. */
export const WAVE_HEIGHT_RATIO = 0.18;
export const WAVE_MAX_WIDTH_BODY = 3.6;
/** Under reducedMotion travel spans shrink to this fraction (the clock also runs at half speed). */
export const REDUCED_SPAN = 0.4;
/** Track slots per run (ids are idBase + slot); MAX_PROPS < this, so ids never collide between events. */
export const RUN_ID_SPAN = 32;
const MAX_TRACKS = 30;

export interface Ctx {
  stage: Rect;
  left: number;
  right: number;
  floorY: number;
  /** Highest a prop may fly (the stage top, but never more than five body widths above the floor). */
  ceilY: number;
  /** The cat's body width, px: the unit every size and distance is a fraction of. */
  unit: number;
  cat: EventCatView;
  reduced: boolean;
  random: () => number;
}

/** Scratch numbers of the actors and builders (all start at 0). */
export interface Mem {
  state: number;
  x: number;
  y: number;
  dir: number;
  cycle: number;
  base: number;
  hole: number;
  fadeAt: number;
  variant: number;
  cx: number;
  cy: number;
  ax: number;
  ay: number;
  w1: number;
  ph1: number;
  ph2: number;
  ph3: number;
  ex: number;
  ey: number;
  tx: number;
  ty: number;
  fleeT: number;
  sx: number;
  sy: number;
  landX: number;
  landMs: number;
  hx0: number;
  hx1: number;
  hT0: number;
  hDur: number;
  pauseUntil: number;
  hopping: number;
  splashed: number;
  shaken: number;
  burst: number;
  entryMs: number;
  sampleAt: number;
  hitX: number;
  chestX: number;
  chestY: number;
}

export function newMem(): Mem {
  return {
    state: 0, x: 0, y: 0, dir: 1, cycle: 0, base: 0, hole: 0, fadeAt: 0, variant: 0, cx: 0, cy: 0, ax: 0, ay: 0, w1: 0, ph1: 0, ph2: 0, ph3: 0, ex: 0, ey: 0, tx: 0, ty: 0,
    fleeT: 0, sx: 0, sy: 0, landX: 0, landMs: 0, hx0: 0, hx1: 0, hT0: 0, hDur: 0, pauseUntil: 0, hopping: 0, splashed: 0, shaken: 0, burst: 0, entryMs: 0, sampleAt: 0,
    hitX: 0, chestX: 0, chestY: 0,
  };
}

/** One running event as the mechanics see it. */
export interface Run {
  def: EventDef;
  outcome: OutcomeDef;
  idBase: number;
  /** Event clock, ms (advances at half speed under reducedMotion). */
  age: number;
  /** End of the engaged window: the props start to leave here (a mechanic may pull it earlier, never later than the safety limit). */
  mainMs: number;
  /** Key moment (wave arrival, thunder, ...) or null: beats at u = 0.5 line up with it. */
  keyAt: number | null;
  tracks: Track[];
  mem: Mem;
  trail: Point[];
  /** The cat's horizontal displacement since the event began, smoothed: what `follow` tracks track. */
  followDx: number;
  cat0x: number;
  /** The prop kind the cat's gaze and approach follow (default: the event's first prop kind). */
  focusKind: PropKind;
  lastFocus: Point | null;
  /** The engine asks the actors to leave now (an interrupt that lets them run off instead of fading in place). */
  scared: boolean;
}

export interface Frame {
  props: RenderProp[];
  focus: Point | null;
  /** Every prop is gone: the aftermath beat can run its course. */
  done: boolean;
}

export interface Mechanic {
  /** Draw the plan. May set run.mainMs and run.keyAt (path events know their own length). */
  init(run: Run, ctx: Ctx): void;
  /** Advance by dt ms of event time (age is already advanced) and report what is on screen. */
  update(run: Run, ctx: Ctx, dt: number): Frame;
}

// ---- helpers ---------------------------------------------------------------------------------

const TAU = Math.PI * 2;

function cl(v: number, lo: number, hi: number): number {
  if (hi < lo) return (lo + hi) / 2;
  return v < lo ? lo : v > hi ? hi : v;
}
const rr = (ctx: Ctx, lo: number, hi: number): number => lo + (hi - lo) * ctx.random();
const sgn = (v: number): 1 | -1 => (v < 0 ? -1 : 1);
const smooth = (v: number): number => {
  const t = cl(v, 0, 1);
  return t * t * (3 - 2 * t);
};

/** Which side of the cat (-1 left, 1 right) an arrival comes from: one with enough room, the facing side a bit more often. */
function sideFor(ctx: Ctx, need: number): 1 | -1 {
  const l = ctx.cat.x - ctx.left;
  const r = ctx.right - ctx.cat.x;
  const okL = l >= need;
  const okR = r >= need;
  if (okL && okR) return ctx.random() < 0.6 ? ctx.cat.facing : ctx.cat.facing === 1 ? -1 : 1;
  if (okR) return 1;
  if (okL) return -1;
  return r >= l ? 1 : -1;
}

/** x at `dist` px from the cat on `side`, kept `margin` px inside the stage. */
function placeX(ctx: Ctx, side: 1 | -1, dist: number, margin: number): number {
  return cl(ctx.cat.x + side * dist, ctx.left + margin, ctx.right - margin);
}

/** A height above the floor, never above the ceiling. */
function airY(ctx: Ctx, aboveFloor: number): number {
  return Math.max(ctx.ceilY + 0.3 * ctx.unit, ctx.floorY - aboveFloor);
}

/** Particle lifetimes under reducedMotion: the clock already runs at half speed, so these must shrink more to make the event shorter. */
function lifeMul(ctx: Ctx): number {
  return ctx.reduced ? 0.45 : 1;
}

function span(ctx: Ctx): number {
  return ctx.reduced ? REDUCED_SPAN : 1;
}

function addTrack(run: Run, init: TrackInit): Track | null {
  if (run.tracks.length >= MAX_TRACKS) return null;
  const tr = makeTrack(init);
  run.tracks.push(tr);
  return tr;
}

function prop(run: Run, slot: number, kind: PropKind, x: number, y: number, size: number, dir: 1 | -1, alpha: number, p: number, variant: number): RenderProp {
  return { id: run.idBase + slot, kind, x, y, size, dir, alpha: cl(alpha, 0, 1), p: ((p % 1) + 1) % 1, rot: 0, variant: variant & 3 };
}

/** Evaluate every track at the run's clock. Focus = the latest visible prop of the focus kind. */
function frameFromTracks(run: Run): Frame {
  const props: RenderProp[] = [];
  let focus: Point | null = null;
  for (let i = 0; i < run.tracks.length; i++) {
    const tr = run.tracks[i];
    if (!tr) continue;
    const p = evalTrack(tr, run.age, run.idBase + i, run.followDx);
    if (!p) continue;
    props.push(p);
    if (p.kind === run.focusKind) focus = { x: p.x, y: p.y };
  }
  return { props, focus, done: run.age >= tracksEnd(run.tracks) };
}

// ---- floorRunner: the mouse --------------------------------------------------------------------

const MOUSE_SIZE = 0.34;
/** The mouse bolts when the cat comes this close (body widths). */
const MOUSE_SCARE = 1.15;
const MOUSE_SPEED = 5.2;

function mouseHole(ctx: Ctx, x: number, dir: 1 | -1): number {
  const u = ctx.unit;
  const edge = dir > 0 ? ctx.right - 0.3 * u : ctx.left + 0.3 * u;
  // A hole in the floor when the edge is far; the edge itself when it is near.
  return Math.abs(edge - x) > 6 * u ? x + dir * rr(ctx, 3.5, 5.5) * u : edge;
}

const floorRunner: Mechanic = {
  init(run, ctx) {
    const u = ctx.unit;
    const m = run.mem;
    const side = sideFor(ctx, 3 * u);
    let x = placeX(ctx, side, rr(ctx, 2.6, 4.2) * u, u);
    if (Math.abs(x - ctx.cat.x) < 1.8 * u) x = placeX(ctx, side === 1 ? -1 : 1, rr(ctx, 2.6, 4) * u, u);
    m.x = x;
    m.base = x;
    m.dir = sgn(x - ctx.cat.x);
    m.variant = Math.floor(ctx.random() * 4);
    m.ph1 = ctx.random() * TAU;
  },
  update(run, ctx, dt) {
    const m = run.mem;
    const u = ctx.unit;
    const size = MOUSE_SIZE * u;
    const lo = ctx.left + size / 2;
    const hi = ctx.right - size / 2;
    let alpha = 1;
    if (m.state === 0) {
      const nx = cl(m.base + 0.35 * u * Math.sin(run.age * 0.0021 + m.ph1), lo, hi);
      const dx = nx - m.x;
      if (Math.abs(dx) > 1e-6) m.dir = sgn(dx);
      m.cycle += (Math.abs(dx) / u) * 1.4;
      m.x = nx;
      alpha = Math.min(1, run.age / 400);
      const close = run.age > 700 && Math.abs(ctx.cat.x - m.x) < MOUSE_SCARE * u;
      if (run.age >= run.mainMs || run.scared || close) {
        // The mouse always gets away: away from the cat, unless a wall is in the way.
        let dir: 1 | -1 = m.x >= ctx.cat.x ? 1 : -1;
        const room = dir > 0 ? hi - m.x : m.x - lo;
        if (room < 1.2 * u) dir = dir === 1 ? -1 : 1;
        m.dir = dir;
        m.hole = cl(mouseHole(ctx, m.x, dir), lo, hi);
        m.state = 1;
        // The cat reacts to the escape: the aftermath starts now.
        run.mainMs = Math.min(run.mainMs, run.age);
      }
    }
    if (m.state === 1) {
      m.hole = cl(m.hole, lo, hi);
      const dir = sgn(m.hole - m.x);
      m.dir = dir;
      const step = MOUSE_SPEED * u * (dt / 1000);
      m.cycle += (step / u) * 1.4;
      if (Math.abs(m.hole - m.x) <= step + 1) {
        m.x = m.hole;
        m.state = 2;
        m.fadeAt = run.age;
      } else {
        m.x += dir * step;
      }
    }
    if (m.state === 2) {
      alpha = 1 - (run.age - m.fadeAt) / 380;
      if (alpha <= 0) m.state = 3;
    }
    const focus = { x: m.x, y: ctx.floorY };
    if (m.state >= 3) return { props: [], focus, done: true };
    return { props: [prop(run, 0, 'mouse', m.x, ctx.floorY, size * (m.state === 2 ? 0.6 + 0.4 * alpha : 1), m.dir === 1 ? 1 : -1, alpha, m.cycle, m.variant)], focus, done: false };
  },
};

// ---- flutter: butterfly and golden butterfly -----------------------------------------------------

function isGolden(run: Run): boolean {
  return run.def.id === 'goldenButterfly';
}

function orbit(run: Run, ctx: Ctx, t: number): Point {
  const m = run.mem;
  const u = ctx.unit;
  const flutter = ctx.reduced ? 0 : 0.07 * u * Math.sin(0.0195 * t);
  return {
    x: m.cx + 0.5 * u * Math.sin(0.0004 * t + m.ph3) + m.ax * Math.sin(m.w1 * t + m.ph1),
    y: m.cy + m.ay * Math.sin(m.w1 * 1.7 * t + m.ph2) + flutter,
  };
}

const flutter: Mechanic = {
  init(run, ctx) {
    const u = ctx.unit;
    const m = run.mem;
    const g = isGolden(run);
    const side = sideFor(ctx, 3 * u);
    m.cx = placeX(ctx, side, rr(ctx, g ? 1.0 : 1.6, g ? 1.8 : 3.2) * u, 1.2 * u);
    m.cy = airY(ctx, rr(ctx, 0.9, g ? 1.5 : 1.8) * u);
    m.ax = rr(ctx, 0.9, 1.5) * u * (g ? 0.6 : 1);
    m.ay = rr(ctx, 0.35, 0.6) * u;
    // The golden one drifts slowly (0.11 Hz); a plain one flits (0.2 Hz).
    m.w1 = (TAU * (g ? 0.11 : 0.2)) / 1000;
    m.ph1 = ctx.random() * TAU;
    m.ph2 = ctx.random() * TAU;
    m.ph3 = ctx.random() * TAU;
    m.ex = side > 0 ? ctx.right - 0.2 * u : ctx.left + 0.2 * u;
    m.ey = ctx.ceilY + rr(ctx, 0.3, 1) * u;
    m.entryMs = g ? 2600 : 1800;
    m.variant = Math.floor(ctx.random() * 4);
    m.x = m.ex;
    m.y = m.ey;
    run.trail = [];
  },
  update(run, ctx, dt) {
    const m = run.mem;
    const u = ctx.unit;
    const g = isGolden(run);
    const size = (g ? 0.42 : 0.3) * u;
    let alpha = 1;
    if (m.state === 0) {
      const target = orbit(run, ctx, run.age);
      const blend = smooth(run.age / m.entryMs);
      const nx = m.ex + (target.x - m.ex) * blend;
      const ny = m.ey + (target.y - m.ey) * blend;
      if (Math.abs(nx - m.x) > 1e-6) m.dir = sgn(nx - m.x);
      m.x = nx;
      m.y = ny;
      alpha = Math.min(1, run.age / (g ? 1200 : 700));
      // A plain butterfly flits off when the cat reaches for it (low and close); the golden one stays until its time is up.
      const reached = !g && run.age > m.entryMs && Math.abs(ctx.cat.x - m.x) < 0.7 * u && m.y > ctx.floorY - 1.0 * u;
      if (run.age >= run.mainMs || run.scared || reached) {
        let dirOut: 1 | -1 = m.x >= ctx.cat.x ? 1 : -1;
        if ((dirOut > 0 ? ctx.right - m.x : m.x - ctx.left) < 1.5 * u) dirOut = dirOut === 1 ? -1 : 1;
        m.tx = dirOut > 0 ? ctx.right - 0.2 * u : ctx.left + 0.2 * u;
        m.ty = ctx.ceilY + 0.2 * u;
        m.state = 1;
        m.fleeT = 0;
        run.mainMs = Math.min(run.mainMs, run.age);
      }
    }
    if (m.state === 1) {
      m.fleeT += dt;
      const v = (g ? 1.4 : 3.4) * u * (dt / 1000);
      const dx = m.tx - m.x;
      const dy = m.ty - m.y;
      const d = Math.hypot(dx, dy);
      if (d > 1e-6) {
        const k = Math.min(1, v / d);
        m.x += dx * k;
        m.y += dy * k + (ctx.reduced ? 0 : Math.sin(run.age * 0.012) * 0.02 * u);
        m.dir = sgn(dx);
      }
      const timeout = g ? 5000 : 3000;
      alpha = Math.min(d / (1.6 * u), 1 - Math.max(0, m.fleeT - timeout) / (g ? 900 : 600));
      if (alpha <= 0.01) m.state = 2;
    }
    const focus = { x: m.x, y: m.y };
    if (m.state >= 2) return { props: [], focus, done: true };
    const props: RenderProp[] = [prop(run, 0, g ? 'goldenButterfly' : 'butterfly', m.x, m.y, size, m.dir === 1 ? 1 : -1, alpha, (run.age * (g ? 3.2 : ctx.reduced ? 3 : 5.5)) / 1000, g ? 0 : m.variant)];
    if (g) {
      if (run.age >= m.sampleAt) {
        run.trail.push({ x: m.x, y: m.y });
        if (run.trail.length > 8) run.trail.shift();
        m.sampleAt = run.age + 140;
      }
      const n = ctx.reduced ? 1 : 3;
      for (let k = 1; k <= n; k++) {
        const pt = run.trail[run.trail.length - 1 - k];
        if (pt) props.push(prop(run, k, 'sparkle', pt.x, pt.y, (0.12 - 0.02 * k) * u, 1, alpha * (0.75 - 0.2 * k), run.age / 900 + k * 0.3, k));
      }
    }
    return { props, focus, done: false };
  },
};

// ---- hopper: the curious bird --------------------------------------------------------------------

const BIRD_SIZE = 0.4;

function startHop(run: Run, ctx: Ctx): void {
  const m = run.mem;
  const u = ctx.unit;
  let dir: 1 | -1 = ctx.random() < 0.5 ? 1 : -1;
  let to = m.x + dir * rr(ctx, 0.6, 1.4) * u;
  // Never hop towards the cat (the bird keeps its distance) or off the floor.
  if (Math.abs(to - ctx.cat.x) < 1.5 * u || to < ctx.left + u || to > ctx.right - u) {
    dir = dir === 1 ? -1 : 1;
    to = m.x + dir * rr(ctx, 0.6, 1.4) * u;
  }
  m.hx0 = m.x;
  m.hx1 = cl(to, ctx.left + u, ctx.right - u);
  m.hT0 = run.age;
  m.hDur = rr(ctx, 320, 440);
  m.hopping = 1;
}

const hopper: Mechanic = {
  init(run, ctx) {
    const u = ctx.unit;
    const m = run.mem;
    const side = sideFor(ctx, 3 * u);
    m.landX = placeX(ctx, side, rr(ctx, 2.4, 4.2) * u, u);
    if (Math.abs(m.landX - ctx.cat.x) < 1.8 * u) m.landX = placeX(ctx, side === 1 ? -1 : 1, rr(ctx, 2.4, 4) * u, u);
    m.sx = cl(m.landX + side * rr(ctx, 2.5, 4) * u, ctx.left + 0.3 * u, ctx.right - 0.3 * u);
    m.sy = ctx.ceilY + 0.3 * u;
    m.landMs = rr(ctx, 1000, 1500);
    m.variant = Math.floor(ctx.random() * 4);
    m.x = m.sx;
    m.y = m.sy;
    m.dir = sgn(m.landX - m.sx);
  },
  update(run, ctx, dt) {
    const m = run.mem;
    const u = ctx.unit;
    const size = BIRD_SIZE * u;
    let alpha = 1;
    let wing = (run.age * 7.5) / 1000;
    if (m.state === 0) {
      const v = cl(run.age / m.landMs, 0, 1);
      const e = 1 - (1 - v) * (1 - v);
      m.x = m.sx + (m.landX - m.sx) * e;
      m.y = m.sy + (ctx.floorY - m.sy) * e - 0.6 * u * 4 * v * (1 - v);
      alpha = Math.min(1, run.age / 300);
      if (Math.abs(m.landX - m.sx) > 1) m.dir = sgn(m.landX - m.sx);
      if (v >= 1) {
        m.state = 1;
        m.x = m.landX;
        m.y = ctx.floorY;
        m.pauseUntil = run.age + 700;
        m.hopping = 0;
      }
    }
    if (m.state === 1) {
      wing = (run.age * 3) / 1000;
      const near = run.age > m.landMs + 400 && Math.abs(ctx.cat.x - m.x) < 1.4 * u;
      if (run.age >= run.mainMs || run.scared || near) {
        let dir: 1 | -1 = m.x >= ctx.cat.x ? 1 : -1;
        if ((dir > 0 ? ctx.right - m.x : m.x - ctx.left) < 2 * u) dir = dir === 1 ? -1 : 1;
        m.dir = dir;
        m.state = 2;
        m.fleeT = 0;
        run.mainMs = Math.min(run.mainMs, run.age);
      } else if (m.hopping === 1) {
        const v = cl((run.age - m.hT0) / m.hDur, 0, 1);
        m.x = m.hx0 + (m.hx1 - m.hx0) * v;
        m.y = ctx.floorY - 0.28 * u * 4 * v * (1 - v);
        if (Math.abs(m.hx1 - m.hx0) > 1) m.dir = sgn(m.hx1 - m.hx0);
        if (v >= 1) {
          m.hopping = 0;
          m.y = ctx.floorY;
          m.pauseUntil = run.age + rr(ctx, 550, 1300);
        }
      } else if (run.age >= m.pauseUntil) {
        startHop(run, ctx);
      }
    }
    if (m.state === 2) {
      m.fleeT += dt;
      m.x += m.dir * 3.0 * u * (dt / 1000);
      m.y -= 2.6 * u * (dt / 1000);
      alpha = m.fleeT < 1000 ? 1 : 1 - (m.fleeT - 1000) / 500;
      if (alpha <= 0.01) m.state = 3;
    }
    const focus = { x: m.x, y: m.y };
    if (m.state >= 3) return { props: [], focus, done: true };
    return { props: [prop(run, 0, 'bird', m.x, m.y, size, m.dir === 1 ? 1 : -1, alpha, wing, m.variant)], focus, done: false };
  },
};

// ---- wave: the mini tsunami ----------------------------------------------------------------------

const wave: Mechanic = {
  init(run, ctx) {
    const u = ctx.unit;
    const m = run.mem;
    const w = rr(ctx, 1.8, WAVE_MAX_WIDTH_BODY) * u;
    const v = (rr(ctx, 1.3, 2.6) * u) / 1000;
    const roomL = ctx.cat.x - ctx.left;
    const roomR = ctx.right - ctx.cat.x;
    let side: 1 | -1 = roomL >= roomR ? -1 : 1;
    const other = side === 1 ? roomL : roomR;
    if (ctx.random() < 0.25 && other >= 4 * u) side = side === 1 ? -1 : 1;
    const roomSide = side === 1 ? roomR : roomL;
    const roomFar = side === 1 ? roomL : roomR;
    const startDist = cl(roomSide - 0.6 * w, 2.5 * u, ctx.reduced ? 5 * u : 9 * u);
    const tail = Math.max(0.5 * u, Math.min(rr(ctx, 2, 4) * u, roomFar - 0.6 * w));
    const startX = ctx.cat.x + side * startDist;
    const endX = ctx.cat.x - side * tail;
    const hitMs = startDist / v;
    const endMs = (startDist + tail) / v;
    run.keyAt = hitMs;
    run.mainMs = endMs + 500;
    m.variant = Math.floor(ctx.random() * 4);
    addTrack(run, {
      kind: 'wave',
      size: w,
      variant: m.variant,
      t0: 0,
      t1: endMs + 500,
      segs: [seg(0, endMs, startX, ctx.floorY, endX, ctx.floorY)],
      fadeIn: 600,
      fadeOut: 700,
      peak: 0.92,
      growFrom: 0.55,
      growTo: 0.8,
    });
  },
  update(run, ctx) {
    const m = run.mem;
    const key = run.keyAt ?? Infinity;
    if (m.splashed === 0 && run.age >= key) {
      m.splashed = 1;
      m.hitX = ctx.cat.x;
      if (run.outcome.id === 'wet') droplets(run, ctx, ctx.reduced ? 2 : 4, 0.5, 1.0, 1.0);
    }
    // The shake-off sprays a few more drops when the shake beat starts (u = 0.72 of the engaged window).
    const shakeAt = key + 0.44 * (run.mainMs - key);
    if (m.shaken === 0 && run.outcome.id === 'wet' && run.age >= shakeAt && shakeAt > key) {
      m.shaken = 1;
      m.hitX = ctx.cat.x;
      droplets(run, ctx, ctx.reduced ? 2 : 3, 0.6, 1.3, 1.5);
    }
    return frameFromTracks(run);
  },
};

/** A few droplets thrown up from the cat's feet. */
function droplets(run: Run, ctx: Ctx, n: number, minLift: number, maxLift: number, spread: number): void {
  const u = ctx.unit;
  for (let i = 0; i < n; i++) {
    const dx = rr(ctx, -spread, spread) * u;
    addTrack(run, {
      kind: 'splash',
      size: rr(ctx, 0.14, 0.2) * u,
      variant: i,
      t0: run.age,
      t1: run.age + 650,
      segs: [seg(run.age, 650, run.mem.hitX + dx * 0.3, ctx.floorY - 0.2 * u, run.mem.hitX + dx, ctx.floorY, { arc: rr(ctx, minLift, maxLift) * u })],
      fadeIn: 60,
      fadeOut: 250,
      peak: 0.85,
    });
  }
}

// ---- weather: thunderstorm and wind gust ----------------------------------------------------------

function initThunder(run: Run, ctx: Ctx): void {
  const u = ctx.unit;
  const reduced = ctx.reduced;
  run.cat0x = ctx.cat.x;
  const cx = cl(ctx.cat.x + rr(ctx, -0.8, 0.8) * u, ctx.left + u, ctx.right - u);
  const cy = Math.max(ctx.ceilY + 0.4 * u, ctx.floorY - 2.4 * u);
  const total = run.mainMs + 900;
  addTrack(run, {
    kind: 'cloud',
    size: 1.8 * u,
    variant: Math.floor(ctx.random() * 4),
    t0: 0,
    t1: total,
    segs: [seg(0, total, cx, cy, cx + sgn(ctx.random() - 0.5) * 0.4 * u, cy, { sway: 0.12 * u, swayHz: 0.35 })],
    fadeIn: 1400,
    fadeOut: 900,
    peak: 0.9,
    follow: 1,
  });
  const drops = reduced ? 5 : 10;
  const top = cy + 0.3 * u;
  for (let i = 0; i < drops; i++) {
    const period = 560 + ctx.random() * 160;
    const x = cx + rr(ctx, -0.85, 0.85) * u;
    addTrack(run, {
      kind: 'raindrop',
      size: 0.06 * u,
      variant: i,
      t0: 900,
      t1: run.mainMs,
      segs: [seg(0, Math.max(380, period * 0.85), x, top, x - 0.12 * u, ctx.floorY)],
      fadeIn: 300,
      fadeOut: 400,
      peak: 0.75,
      follow: 1,
      loopMs: period,
      phaseMs: ctx.random() * period,
      pMode: 'life',
    });
  }
  const key = rr(ctx, 0.42, 0.58) * run.mainMs;
  run.keyAt = key;
  // One small, thin, localized bolt to the side of the cat, a third of a second long: never a flash, and none at all under reducedMotion.
  if (!reduced) {
    const away = sgn(cx - ctx.cat.x + 0.001);
    const bx = cl(cx + away * rr(ctx, 0.6, 0.9) * u, ctx.left + 0.5 * u, ctx.right - 0.5 * u);
    addTrack(run, {
      kind: 'bolt',
      size: 0.5 * u,
      variant: Math.floor(ctx.random() * 4),
      t0: key - 80,
      t1: key + 320,
      segs: [seg(key - 80, 400, bx, ctx.floorY - 0.5 * u, bx, ctx.floorY - 0.5 * u)],
      fadeIn: 40,
      fadeOut: 220,
      peak: 0.9,
      follow: 1,
    });
  }
  run.focusKind = 'cloud';
}

function initWind(run: Run, ctx: Ctx): void {
  const u = ctx.unit;
  const reduced = ctx.reduced;
  const dir = sgn(ctx.random() - 0.5);
  const key = 0.45 * run.mainMs;
  run.keyAt = key;
  const reach = Math.max(4 * u, Math.min(7 * u * span(ctx) + 2 * u, ctx.right - ctx.left));
  const x0 = cl(ctx.cat.x - dir * reach, ctx.left + 0.3 * u, ctx.right - 0.3 * u);
  const x1 = cl(ctx.cat.x + dir * reach, ctx.left + 0.3 * u, ctx.right - 0.3 * u);
  const streaks = reduced ? 3 : 7;
  for (let i = 0; i < streaks; i++) {
    const dur = rr(ctx, 1100, 1900);
    const t0 = cl(key - 1000 + rr(ctx, -0.2, 0.2) * run.mainMs, 300, Math.max(300, run.mainMs - dur));
    const y = Math.max(ctx.ceilY + 0.2 * u, ctx.floorY - rr(ctx, 0.3, 3) * u);
    const sx = x0 + dir * rr(ctx, 0, 1.5) * u;
    addTrack(run, { kind: 'windStreak', size: rr(ctx, 1.2, 2.2) * u, variant: i, t0, t1: t0 + dur, segs: [seg(t0, dur, sx, y, x1, y, { sway: 0.05 * u, swayHz: 1.4 })], fadeIn: 200, fadeOut: 300, peak: 0.5 });
  }
  // Light things the gust carries along: leaves (and a paper plane when the clock is at full speed).
  const lights: PropKind[] = reduced ? ['leaf'] : ['leaf', 'leaf', 'paperPlane'];
  lights.forEach((kind, i) => {
    const dur = rr(ctx, 2200, 3200);
    const t0 = cl(key - 1200 + i * 350 + rr(ctx, 0, 300), 300, Math.max(300, run.mainMs - dur));
    const y0 = Math.max(ctx.ceilY + 0.3 * u, ctx.floorY - rr(ctx, 0.3, 2) * u);
    addTrack(run, {
      kind,
      size: (kind === 'leaf' ? 0.28 : 0.4) * u,
      variant: i,
      t0,
      t1: t0 + dur,
      segs: [seg(t0, dur, x0, y0, x1, ctx.floorY - 0.05 * u, { arc: rr(ctx, 0.2, 0.8) * u, sway: 0.2 * u, swayHz: 1.1 })],
      fadeIn: 250,
      fadeOut: 400,
      tilt: kind === 'leaf' ? 'spin' : 'heading',
      spinTurns: dir * rr(ctx, 1, 2),
    });
  });
  run.focusKind = 'leaf';
}

const weather: Mechanic = {
  init(run, ctx) {
    if (run.def.id === 'thunderstorm') initThunder(run, ctx);
    else initWind(run, ctx);
  },
  update(run) {
    return frameFromTracks(run);
  },
};

// ---- drifter: things that fall, glide, rise and cross -----------------------------------------------

function initLeaf(run: Run, ctx: Ctx): void {
  const u = ctx.unit;
  const x0 = cl(ctx.cat.x + rr(ctx, -3, 3) * u, ctx.left + u, ctx.right - u);
  const xl = cl(x0 + rr(ctx, -1, 1) * u, ctx.left + u, ctx.right - u);
  const fallMs = run.mainMs * 0.5;
  const top = ctx.ceilY + 0.2 * u;
  const dir = sgn(ctx.random() - 0.5);
  const slideTo = cl(xl + dir * 0.35 * u, ctx.left + u, ctx.right - u);
  const segs = [seg(0, fallMs, x0, top, xl, ctx.floorY - 0.04 * u, { sway: 0.7 * u, swayHz: 0.45 }), seg(fallMs, 500, xl, ctx.floorY, slideTo, ctx.floorY, { ease: 'out' })];
  if (run.outcome.id === 'tapped') {
    const t = fallMs + 0.55 * (run.mainMs - fallMs);
    segs.push(seg(t, 700, slideTo, ctx.floorY, cl(slideTo + dir * 0.8 * u, ctx.left + u, ctx.right - u), ctx.floorY, { arc: 0.15 * u, ease: 'out' }));
  }
  addTrack(run, { kind: 'leaf', size: 0.3 * u, variant: Math.floor(ctx.random() * 4), t0: 0, t1: run.mainMs + 900, segs, fadeIn: 500, fadeOut: 900, tilt: 'sway', hz: 0.7 });
}

function initPlane(run: Run, ctx: Ctx): void {
  const u = ctx.unit;
  const dir = sgn(ctx.random() - 0.5);
  const lx = cl(ctx.cat.x + dir * rr(ctx, 1.2, 3.5) * u, ctx.left + u, ctx.right - u);
  const sx = cl(lx - dir * rr(ctx, 5, 8) * u * span(ctx), ctx.left + 0.3 * u, ctx.right - 0.3 * u);
  const y0 = airY(ctx, rr(ctx, 1.9, 2.7) * u);
  const glide = run.mainMs * 0.62;
  const slideTo = cl(lx + dir * 0.7 * u, ctx.left + u, ctx.right - u);
  addTrack(run, {
    kind: 'paperPlane',
    size: 0.42 * u,
    variant: Math.floor(ctx.random() * 4),
    t0: 0,
    t1: run.mainMs + 900,
    segs: [seg(0, glide, sx, y0, lx, ctx.floorY - 0.1 * u, { sway: 0.22 * u, swayHz: 0.8 }), seg(glide, 700, lx, ctx.floorY, slideTo, ctx.floorY, { ease: 'out' })],
    fadeIn: 500,
    fadeOut: 900,
    tilt: 'heading',
  });
}

function initFish(run: Run, ctx: Ctx): void {
  const u = ctx.unit;
  const dir = sgn(ctx.random() - 0.5);
  const ax = cl(ctx.cat.x - dir * 3.4 * u, ctx.left + 0.8 * u, ctx.right - 0.8 * u);
  const bx = cl(ctx.cat.x + dir * 3.4 * u, ctx.left + 0.8 * u, ctx.right - 0.8 * u);
  const arcMs = rr(ctx, 2200, 3000);
  const apex = Math.min(rr(ctx, 1.7, 2.5) * u, ctx.floorY - ctx.ceilY - 0.3 * u);
  const fy = ctx.floorY - 0.1 * u;
  addTrack(run, { kind: 'fish', size: 0.4 * u, variant: Math.floor(ctx.random() * 4), t0: 300, t1: 300 + arcMs, segs: [seg(300, arcMs, ax, fy, bx, fy, { arc: apex })], fadeIn: 120, fadeOut: 120, tilt: 'heading', pMode: 'phase', hz: 4 });
  addTrack(run, { kind: 'splash', size: 0.22 * u, t0: 250, t1: 900, segs: [seg(250, 650, ax, ctx.floorY, ax + dir * 0.3 * u, ctx.floorY, { arc: 0.5 * u })], fadeIn: 60, fadeOut: 300, peak: 0.85 });
  addTrack(run, { kind: 'splash', size: 0.22 * u, t0: 300 + arcMs - 150, t1: 300 + arcMs + 550, segs: [seg(300 + arcMs - 150, 700, bx, ctx.floorY, bx + dir * 0.3 * u, ctx.floorY, { arc: 0.5 * u })], fadeIn: 60, fadeOut: 300, peak: 0.85 });
  run.keyAt = 300 + arcMs / 2;
  run.mainMs = 300 + arcMs + 700;
}

function initUfo(run: Run, ctx: Ctx): void {
  const u = ctx.unit;
  const dir = sgn(ctx.random() - 0.5);
  const y = airY(ctx, rr(ctx, 2.8, 3.5) * u);
  const sp = span(ctx);
  const sx = cl(ctx.cat.x - dir * rr(ctx, 6, 9) * u * sp, ctx.left + 0.5 * u, ctx.right - 0.5 * u);
  const hx = cl(ctx.cat.x + rr(ctx, -1, 1) * u, ctx.left + u, ctx.right - u);
  const tx = cl(ctx.cat.x + dir * rr(ctx, 6, 9) * u * sp, ctx.left + 0.5 * u, ctx.right - 0.5 * u);
  const enter = 2600;
  const exit = 1800;
  const hover = Math.max(1500, run.mainMs - enter - exit);
  addTrack(run, {
    kind: 'ufo',
    size: 0.62 * u,
    variant: Math.floor(ctx.random() * 4),
    t0: 0,
    t1: enter + hover + exit,
    segs: [
      seg(0, enter, sx, y, hx, y, { ease: 'out', sway: 0.1 * u, swayHz: 1.1 }),
      hold(enter, hover, hx, y, { sway: 0.14 * u, swayHz: 0.9 }),
      seg(enter + hover, exit, hx, y, tx, y - 0.4 * u, { ease: 'in' }),
    ],
    fadeIn: 600,
    fadeOut: 400,
    tilt: 'sway',
    hz: 0.6,
  });
  run.mainMs = enter + hover;
}

function initStar(run: Run, ctx: Ctx): void {
  const u = ctx.unit;
  const dir = sgn(ctx.random() - 0.5);
  const sp = span(ctx);
  const sx = cl(ctx.cat.x - dir * rr(ctx, 3, 5) * u, ctx.left + 0.5 * u, ctx.right - 0.5 * u);
  const top = ctx.ceilY + rr(ctx, 0, 0.5) * u;
  const ex = cl(sx + dir * rr(ctx, 4, 7) * u * sp, ctx.left + 0.3 * u, ctx.right - 0.3 * u);
  const ey = Math.min(top + rr(ctx, 1.6, 2.4) * u, ctx.floorY - 1.2 * u);
  const dur = rr(ctx, 1300, 1900);
  const t0 = 700;
  addTrack(run, { kind: 'star', size: 0.24 * u, t0, t1: t0 + dur, segs: [seg(t0, dur, sx, top, ex, ey, { ease: 'in' })], fadeIn: 150, fadeOut: 450, tilt: 'heading' });
  const trail = ctx.reduced ? 1 : 3;
  for (let k = 1; k <= trail; k++) {
    const s0 = t0 + 90 * k;
    addTrack(run, { kind: 'sparkle', size: 0.12 * u * (1 - 0.2 * k), variant: k, t0: s0, t1: s0 + dur, segs: [seg(s0, dur, sx, top, ex, ey, { ease: 'in' })], fadeIn: 150, fadeOut: 400, peak: 0.55 });
  }
  run.mainMs = t0 + dur + 400;
}

function initMeteors(run: Run, ctx: Ctx): void {
  const u = ctx.unit;
  const dir = sgn(ctx.random() - 0.5);
  const n = 5 + Math.floor(ctx.random() * 4);
  const lane = Math.max(1000, run.mainMs - 2500) / n;
  for (let i = 0; i < n; i++) {
    const t0 = 500 + (i + rr(ctx, 0, 0.6)) * lane;
    const dur = rr(ctx, 700, 1100);
    const sx = cl(ctx.cat.x + rr(ctx, -6, 6) * u, ctx.left + 0.5 * u, ctx.right - 0.5 * u);
    const sy = ctx.ceilY + rr(ctx, 0, 1.2) * u;
    const ex = cl(sx + dir * rr(ctx, 3, 5) * u, ctx.left + 0.3 * u, ctx.right - 0.3 * u);
    const ey = sy + rr(ctx, 1.2, 1.8) * u;
    addTrack(run, { kind: 'meteor', size: rr(ctx, 0.2, 0.28) * u, variant: i, t0, t1: t0 + dur, segs: [seg(t0, dur, sx, sy, ex, ey)], fadeIn: 100, fadeOut: 350, tilt: 'heading' });
    addTrack(run, { kind: 'sparkle', size: 0.09 * u, variant: i, t0: t0 + 70, t1: t0 + 70 + dur, segs: [seg(t0 + 70, dur, sx, sy, ex, ey)], fadeIn: 100, fadeOut: 350, peak: 0.5 });
  }
  run.mainMs = Math.max(run.mainMs, 3000);
}

function initBubbles(run: Run, ctx: Ctx): void {
  const u = ctx.unit;
  const side = sideFor(ctx, 2.5 * u);
  const cx = placeX(ctx, side, rr(ctx, 1, 2.2) * u, 1.3 * u);
  const n = ctx.reduced ? 4 : 9;
  const playful = run.outcome.id !== 'watched';
  let end = 0;
  for (let i = 0; i < n; i++) {
    const t0 = 400 + (i * run.mainMs * 0.62) / n + rr(ctx, 0, 300);
    let rise = rr(ctx, 2600, 4200) * lifeMul(ctx);
    let height = Math.min(rr(ctx, 1.5, 3) * u, ctx.floorY - ctx.ceilY - 0.3 * u);
    let fadeOut = 260;
    // Bubbles the cat plays with pop early, at about the height of its head.
    if (playful && ctx.random() < 0.4) {
      height = rr(ctx, 0.7, 1.1) * u;
      rise *= 0.45;
      fadeOut = 120;
    }
    const bx = cx + rr(ctx, -1.1, 1.1) * u;
    addTrack(run, {
      kind: 'bubble',
      size: rr(ctx, 0.14, 0.3) * u,
      variant: i,
      t0,
      t1: t0 + rise,
      segs: [seg(t0, rise, bx, ctx.floorY - 0.05 * u, bx + rr(ctx, -0.3, 0.3) * u, ctx.floorY - height, { sway: 0.22 * u, swayHz: rr(ctx, 0.5, 0.9) })],
      fadeIn: 250,
      fadeOut,
      peak: 0.85,
    });
    end = Math.max(end, t0 + rise);
  }
  run.mainMs = end;
}

function initSparkles(run: Run, ctx: Ctx): void {
  const u = ctx.unit;
  const side = sideFor(ctx, 2.5 * u);
  const sx = placeX(ctx, side, rr(ctx, 1.6, 2.8) * u, 1.0 * u);
  const sy = ctx.floorY - rr(ctx, 0.2, 0.6) * u;
  const n = ctx.reduced ? 3 : 7;
  let end = 0;
  for (let i = 0; i < n; i++) {
    const t0 = 300 + (i / n) * run.mainMs * 0.5 + rr(ctx, 0, 400);
    const life = rr(ctx, 2200, 4200) * lifeMul(ctx);
    const x = sx + rr(ctx, -0.7, 0.7) * u;
    const y0 = Math.min(ctx.floorY - 0.05 * u, sy + rr(ctx, -0.2, 0.5) * u);
    addTrack(run, {
      kind: 'sparkle',
      size: rr(ctx, 0.1, 0.18) * u,
      variant: i,
      t0,
      t1: t0 + life,
      segs: [seg(t0, life, x, y0, x + rr(ctx, -0.2, 0.2) * u, y0 - rr(ctx, 0.2, 0.5) * u, { ease: 'out' })],
      fadeIn: 400,
      fadeOut: 500,
      peak: 0.95,
      blinkHz: rr(ctx, 1.1, 1.9) * (ctx.reduced ? 0.4 : 1),
      phaseMs: ctx.random() * 1000,
    });
    end = Math.max(end, t0 + life);
  }
  run.mainMs = Math.max(2500, end - 500);
}

const drifter: Mechanic = {
  init(run, ctx) {
    switch (run.def.id) {
      case 'fallingLeaf':
        return initLeaf(run, ctx);
      case 'paperPlane':
        return initPlane(run, ctx);
      case 'flyingFish':
        return initFish(run, ctx);
      case 'tinyUfo':
        return initUfo(run, ctx);
      case 'fallingStar':
        return initStar(run, ctx);
      case 'meteorShower':
        return initMeteors(run, ctx);
      case 'bubbleParty':
        return initBubbles(run, ctx);
      default:
        return initSparkles(run, ctx);
    }
  },
  update(run) {
    return frameFromTracks(run);
  },
};

// ---- settler: things that arrive, invite play and stay a while -----------------------------------------

function initBox(run: Run, ctx: Ctx): void {
  const u = ctx.unit;
  const side = sideFor(ctx, 3 * u);
  const bx = placeX(ctx, side, rr(ctx, 2, 3.2) * u, 0.7 * u);
  addTrack(run, {
    kind: 'box',
    size: 1.0 * u,
    variant: Math.floor(ctx.random() * 4),
    t0: 0,
    t1: run.mainMs + 900,
    segs: [
      seg(0, 450, bx, ctx.floorY - 1.1 * u, bx, ctx.floorY, { ease: 'in' }),
      seg(450, 260, bx, ctx.floorY, bx, ctx.floorY, { arc: 0.14 * u, ease: 'out' }),
      hold(710, Math.max(1, run.mainMs - 710), bx, ctx.floorY),
    ],
    fadeIn: 250,
    fadeOut: 900,
  });
}

/** A ball or a ball of yarn: it rolls in, stops near the cat, and (when the cat plays) gets rolled away again. */
function initRoller(run: Run, ctx: Ctx, yarn: boolean): void {
  const u = ctx.unit;
  const side = sideFor(ctx, 3 * u);
  const size = (yarn ? 0.34 : 0.3) * u;
  const stop = placeX(ctx, side, rr(ctx, 2, 3) * u, u);
  const start = cl(stop + side * rr(ctx, 5, 8) * u * span(ctx), ctx.left + 0.3 * u, ctx.right - 0.3 * u);
  const rollMs = yarn ? 1800 : 2400;
  const y = ctx.floorY;
  const segs = [seg(0, rollMs, start, y, stop, y, { ease: 'out' })];
  let dist = Math.abs(stop - start);
  const id = run.outcome.id;
  const playedAway = id === 'tapped' || id === 'chased' || id === 'rolled';
  if (playedAway) {
    const tapAt = cl(0.45 * run.mainMs, rollMs + 800, Math.max(rollMs + 800, run.mainMs - 2500));
    const far = cl(stop + side * rr(ctx, yarn ? 4 : 3, yarn ? 6 : 5) * u, ctx.left + 0.5 * u, ctx.right - 0.5 * u);
    segs.push(seg(tapAt, yarn ? 2200 : 1700, stop, y, far, y, { ease: 'out', arc: 0.08 * u }));
    dist += Math.abs(far - stop);
    if (id === 'chased') {
      const back = cl(far - side * rr(ctx, 2, 3) * u, ctx.left + 0.5 * u, ctx.right - 0.5 * u);
      segs.push(seg(tapAt + 2400, 1400, far, y, back, y, { ease: 'out' }));
      dist += Math.abs(far - back);
    }
  } else if (yarn && id === 'tangled') {
    // The yarn stays put and wobbles while the cat gets itself into a knot.
    const t = Math.max(rollMs + 600, 0.3 * run.mainMs);
    segs.push(hold(t, 3500, stop, y, { sway: 0.06 * u, swayHz: 1.2 }));
  }
  addTrack(run, {
    kind: yarn ? 'yarn' : 'ball',
    size,
    variant: Math.floor(ctx.random() * 4),
    t0: 0,
    t1: run.mainMs + 900,
    segs,
    fadeIn: 400,
    fadeOut: 900,
    tilt: 'spin',
    spinTurns: side * -1 * (dist / (Math.PI * size)),
  });
}

function initSpring(run: Run, ctx: Ctx): void {
  const u = ctx.unit;
  const side = sideFor(ctx, 2.8 * u);
  const sx = placeX(ctx, side, rr(ctx, 1.6, 2.6) * u, 0.8 * u);
  const y = ctx.floorY;
  const segs = [seg(0, 380, sx, y - Math.min(1.4 * u, y - ctx.ceilY - 0.3 * u), sx, y, { ease: 'in' })];
  let t = 380;
  const amps = [1.1, 0.62, 0.34, 0.16];
  const durs = [560, 460, 360, 280];
  amps.forEach((a, i) => {
    const d = durs[i] ?? 280;
    segs.push(seg(t, d, sx, y, sx, y, { arc: a * u }));
    t += d;
  });
  const tapAt = Math.max(t + 400, 0.4 * run.mainMs);
  const sx2 = cl(sx + sgn(ctx.random() - 0.5) * rr(ctx, 0.6, 1.1) * u, ctx.left + 0.8 * u, ctx.right - 0.8 * u);
  segs.push(seg(tapAt, 520, sx, y, sx2, y, { arc: 0.8 * u }), seg(tapAt + 520, 380, sx2, y, sx2, y, { arc: 0.4 * u }), seg(tapAt + 900, 260, sx2, y, sx2, y, { arc: 0.15 * u }));
  if (run.outcome.id === 'played') {
    const t3 = Math.max(tapAt + 1600, 0.72 * run.mainMs);
    segs.push(seg(t3, 480, sx2, y, sx, y, { arc: 0.7 * u }), seg(t3 + 480, 300, sx, y, sx, y, { arc: 0.3 * u }));
  }
  addTrack(run, { kind: 'spring', size: 0.34 * u, variant: Math.floor(ctx.random() * 4), t0: 0, t1: run.mainMs + 700, segs, fadeIn: 200, fadeOut: 700, tilt: 'sway', hz: 1.6 });
}

function initTreasure(run: Run, ctx: Ctx): void {
  const u = ctx.unit;
  const side = sideFor(ctx, 3 * u);
  const tx = placeX(ctx, side, rr(ctx, 1.8, 3.2) * u, 0.7 * u);
  const found = Math.max(0, run.def.outcomes.findIndex((o) => o.id === run.outcome.id));
  addTrack(run, {
    kind: 'treasure',
    size: 0.26 * u,
    variant: found,
    t0: 0,
    t1: run.mainMs + 1000,
    segs: [seg(0, 700, tx, ctx.floorY - 0.5 * u, tx, ctx.floorY, { ease: 'in' }), hold(700, Math.max(1, run.mainMs - 700), tx, ctx.floorY)],
    fadeIn: 500,
    fadeOut: 1000,
  });
  const n = ctx.reduced ? 1 : 3;
  for (let i = 0; i < n; i++) {
    const t0 = 200 + i * 500;
    addTrack(run, {
      kind: 'sparkle',
      size: 0.12 * u,
      variant: i,
      t0,
      t1: t0 + rr(ctx, 1600, 2400),
      segs: [hold(t0, 2400, tx + (i - 1) * 0.4 * u, ctx.floorY - rr(ctx, 0.2, 0.5) * u)],
      fadeIn: 300,
      fadeOut: 500,
      peak: 0.9,
      blinkHz: 1.3,
      phaseMs: i * 300,
    });
  }
}

function initChest(run: Run, ctx: Ctx): void {
  const u = ctx.unit;
  const side = sideFor(ctx, 3.4 * u);
  const m = run.mem;
  m.chestX = placeX(ctx, side, rr(ctx, 2.4, 3.6) * u, 1.0 * u);
  m.chestY = ctx.floorY;
  addTrack(run, {
    kind: 'treasure',
    size: 0.85 * u,
    variant: Math.floor(ctx.random() * 4),
    t0: 0,
    t1: run.mainMs + 1200,
    segs: [hold(0, run.mainMs + 1200, m.chestX, m.chestY)],
    fadeIn: 900,
    fadeOut: 1200,
    growFrom: 0.7,
    growTo: 1,
  });
  const n = ctx.reduced ? 1 : 3;
  for (let i = 0; i < n; i++) {
    addTrack(run, {
      kind: 'sparkle',
      size: 0.11 * u,
      variant: i,
      t0: 600,
      t1: run.mainMs,
      segs: [hold(600, Math.max(1, run.mainMs - 600), m.chestX + (i - 1) * 0.5 * u, m.chestY - rr(ctx, 0.6, 1.0) * u)],
      fadeIn: 400,
      fadeOut: 500,
      peak: 0.8,
      blinkHz: ctx.reduced ? 0.5 : rr(ctx, 1, 1.6),
      phaseMs: i * 400,
    });
  }
  run.keyAt = 0.5 * run.mainMs;
}

function chestBurst(run: Run, ctx: Ctx): void {
  const u = ctx.unit;
  const m = run.mem;
  const n = ctx.reduced ? 3 : 8;
  for (let i = 0; i < n; i++) {
    const t0 = run.age + i * 30;
    addTrack(run, {
      kind: 'sparkle',
      size: rr(ctx, 0.1, 0.16) * u,
      variant: i,
      t0,
      t1: t0 + 1100,
      segs: [seg(t0, 1100, m.chestX, m.chestY - 0.5 * u, m.chestX + rr(ctx, -1.4, 1.4) * u, m.chestY - 0.5 * u - rr(ctx, 0.5, 1.4) * u, { ease: 'out', arc: 0.3 * u })],
      fadeIn: 60,
      fadeOut: 500,
      peak: 0.95,
    });
  }
}

const settler: Mechanic = {
  init(run, ctx) {
    switch (run.def.id) {
      case 'boxAppears':
        return initBox(run, ctx);
      case 'mysteriousBall':
        return initRoller(run, ctx, false);
      case 'yarnTrouble':
        return initRoller(run, ctx, true);
      case 'toySpring':
        return initSpring(run, ctx);
      case 'treasureDiscovery':
        return initChest(run, ctx);
      default:
        return initTreasure(run, ctx);
    }
  },
  update(run, ctx) {
    if (run.def.id === 'treasureDiscovery' && run.mem.burst === 0 && run.keyAt !== null && run.age >= run.keyAt) {
      run.mem.burst = 1;
      chestBurst(run, ctx);
    }
    return frameFromTracks(run);
  },
};

// ---- visitor: ghosts, the shadow, the dragon and the midnight visitor -------------------------------------

function initLittleGhost(run: Run, ctx: Ctx): void {
  const u = ctx.unit;
  const side = sideFor(ctx, 3.5 * u);
  const near = run.outcome.id === 'approached';
  const hx = placeX(ctx, side, (near ? rr(ctx, 1.3, 1.8) : rr(ctx, 2.4, 3.6)) * u, u);
  const hy = airY(ctx, rr(ctx, 0.9, 1.4) * u);
  const sx = cl(hx + side * rr(ctx, 2.5, 4) * u, ctx.left + 0.5 * u, ctx.right - 0.5 * u);
  const enter = 2400;
  const hover = Math.max(1000, run.mainMs - enter);
  const leave = 2200;
  const away = cl(hx + side * 1.2 * u, ctx.left + 0.5 * u, ctx.right - 0.5 * u);
  addTrack(run, {
    kind: 'ghost',
    size: 0.5 * u,
    variant: Math.floor(ctx.random() * 4),
    t0: 0,
    t1: enter + hover + leave,
    segs: [
      seg(0, enter, sx, hy - 0.3 * u, hx, hy, { ease: 'out', sway: 0.15 * u, swayHz: 0.5 }),
      hold(enter, hover, hx, hy, { sway: 0.12 * u, swayHz: 0.7 }),
      seg(enter + hover, leave, hx, hy, away, ctx.ceilY, { ease: 'in', sway: 0.2 * u, swayHz: 0.6 }),
    ],
    fadeIn: 1200,
    fadeOut: 1100,
    peak: 0.85,
    tilt: 'sway',
    hz: 0.5,
  });
  // A harmless little puff of sparkles where it vanishes.
  const puffs = ctx.reduced ? 1 : 3;
  const px = hx + (away - hx) * 0.7;
  const py = hy + (ctx.ceilY - hy) * 0.7;
  for (let i = 0; i < puffs; i++) {
    const t0 = enter + hover + 1500;
    addTrack(run, { kind: 'sparkle', size: 0.1 * u, variant: i, t0, t1: t0 + 900, segs: [seg(t0, 900, px + (i - 1) * 0.3 * u, py, px + (i - 1) * 0.4 * u, py - 0.3 * u, { ease: 'out' })], fadeIn: 100, fadeOut: 500, peak: 0.8 });
  }
  run.mainMs = enter + hover;
}

function initFriendlyGhost(run: Run, ctx: Ctx): void {
  const u = ctx.unit;
  run.cat0x = ctx.cat.x;
  const dirBack: 1 | -1 = ctx.cat.facing === 1 ? -1 : 1;
  const bx = cl(ctx.cat.x + dirBack * 1.5 * u, ctx.left + u, ctx.right - u);
  const by = airY(ctx, 1.3 * u);
  const enter = 2600;
  const hover = Math.max(1500, run.mainMs - enter);
  const leave = 2400;
  addTrack(run, {
    kind: 'ghost',
    size: 0.62 * u,
    variant: 1,
    t0: 0,
    t1: enter + hover + leave,
    segs: [
      seg(0, enter, cl(bx - dirBack * u, ctx.left, ctx.right), ctx.ceilY, bx, by, { ease: 'out', sway: 0.15 * u, swayHz: 0.45 }),
      hold(enter, hover, bx, by, { sway: 0.15 * u, swayHz: 0.45 }),
      seg(enter + hover, leave, bx, by, bx, ctx.ceilY, { ease: 'in' }),
    ],
    fadeIn: 1400,
    fadeOut: 1200,
    peak: 0.9,
    tilt: 'sway',
    hz: 0.45,
    follow: 1,
  });
  // A soft glow of two sparkles that keep it company while it follows the cat.
  const glow = ctx.reduced ? 0 : 2;
  for (let i = 0; i < glow; i++) {
    addTrack(run, {
      kind: 'sparkle',
      size: 0.1 * u,
      variant: i,
      t0: enter,
      t1: enter + hover,
      segs: [hold(enter, hover, bx + (i === 0 ? -0.5 : 0.5) * u, by + 0.2 * u, { sway: 0.1 * u, swayHz: 0.6 })],
      fadeIn: 500,
      fadeOut: 500,
      peak: 0.8,
      blinkHz: 0.9,
      phaseMs: i * 500,
      follow: 1,
    });
  }
  const puffs = ctx.reduced ? 1 : 4;
  for (let i = 0; i < puffs; i++) {
    const t0 = enter + hover + 1200;
    addTrack(run, { kind: 'sparkle', size: 0.1 * u, variant: i, t0, t1: t0 + 1000, segs: [seg(t0, 1000, bx + (i - 1.5) * 0.3 * u, ctx.ceilY + 0.5 * u, bx + (i - 1.5) * 0.4 * u, ctx.ceilY, { ease: 'out' })], fadeIn: 100, fadeOut: 600, peak: 0.8, follow: 1 });
  }
  run.mainMs = enter + hover;
}

function initShadow(run: Run, ctx: Ctx): void {
  const u = ctx.unit;
  const side = sideFor(ctx, 3 * u);
  const stop = placeX(ctx, side, rr(ctx, 2, 2.8) * u, u);
  const start = cl(stop + side * rr(ctx, 5, 8) * u * span(ctx), ctx.left + 0.5 * u, ctx.right - 0.5 * u);
  const y = ctx.floorY;
  const slide = 3800;
  const exit = 2400;
  run.mainMs = Math.max(5000, run.mainMs);
  addTrack(run, {
    kind: 'shadow',
    size: 0.9 * u,
    variant: Math.floor(ctx.random() * 4),
    t0: 0,
    t1: run.mainMs + exit,
    segs: [seg(0, slide, start, y, stop, y, { ease: 'out' }), hold(slide, Math.max(1, run.mainMs - slide), stop, y, { sway: 0.05 * u, swayHz: 0.5 }), seg(run.mainMs, exit, stop, y, start, y, { ease: 'in' })],
    fadeIn: 1800,
    fadeOut: 1600,
    peak: 0.75,
    blinkHz: 0.25,
    growFrom: 1,
    growTo: 0.4,
  });
}

function initDragon(run: Run, ctx: Ctx): void {
  const u = ctx.unit;
  const side = sideFor(ctx, 3.5 * u);
  const hx = placeX(ctx, side, rr(ctx, 1.6, 2.2) * u, u);
  const hy = airY(ctx, rr(ctx, 1.3, 1.8) * u);
  const sx = cl(hx + side * 5 * u, ctx.left + 0.5 * u, ctx.right - 0.5 * u);
  const enter = 2800;
  const leave = 2400;
  const hover = Math.max(2000, run.mainMs - enter);
  addTrack(run, {
    kind: 'dragon',
    size: 0.75 * u,
    variant: Math.floor(ctx.random() * 4),
    t0: 0,
    t1: enter + hover + leave,
    segs: [
      seg(0, enter, sx, ctx.ceilY, hx, hy, { ease: 'out', arc: 0.8 * u, sway: 0.2 * u, swayHz: 0.8 }),
      hold(enter, hover, hx, hy, { sway: 0.16 * u, swayHz: 0.5 }),
      seg(enter + hover, leave, hx, hy, cl(hx + side * 6 * u, ctx.left + 0.5 * u, ctx.right - 0.5 * u), ctx.ceilY, { ease: 'in', arc: 0.3 * u }),
    ],
    fadeIn: 800,
    fadeOut: 900,
    tilt: 'sway',
    hz: 0.5,
    pMode: 'phase',
  });
  // Little puffs of sparkles (never fire) from its mouth, towards the cat, every couple of seconds.
  const mx = hx - side * 0.4 * u;
  const my = hy + 0.1 * u;
  const per = ctx.reduced ? 2 : 3;
  for (let t = 3200; t < enter + hover - 1200 && run.tracks.length < MAX_TRACKS - per; t += 2300) {
    for (let k = 0; k < per; k++) {
      const t0 = t + k * 90;
      addTrack(run, { kind: 'sparkle', size: rr(ctx, 0.09, 0.14) * u, variant: k, t0, t1: t0 + 900, segs: [seg(t0, 900, mx, my, mx - side * rr(ctx, 0.3, 0.8) * u, my - rr(ctx, 0.2, 0.6) * u, { ease: 'out' })], fadeIn: 80, fadeOut: 500, peak: 0.9 });
    }
  }
  run.mainMs = enter + hover;
}

function initMidnight(run: Run, ctx: Ctx): void {
  const u = ctx.unit;
  const side = sideFor(ctx, 3.5 * u);
  const stop = placeX(ctx, side, rr(ctx, 2.6, 3.4) * u, u);
  const start = cl(stop + side * rr(ctx, 6, 9) * u * span(ctx), ctx.left + 0.5 * u, ctx.right - 0.5 * u);
  const y = ctx.floorY;
  // A slow, quiet walk (0.9 body widths a second): in, a long pause, and back the way it came.
  const walk = Math.max(2500, (Math.abs(stop - start) / (0.9 * u)) * 1000);
  const pause = Math.max(2000, 0.4 * run.mainMs);
  addTrack(run, {
    kind: 'visitor',
    size: 0.8 * u,
    variant: Math.floor(ctx.random() * 4),
    t0: 0,
    t1: 2 * walk + pause,
    segs: [seg(0, walk, start, y, stop, y), hold(walk, pause, stop, y), seg(walk + pause, walk, stop, y, start, y)],
    fadeIn: 2000,
    fadeOut: 2000,
    peak: 0.8,
    pMode: 'phase',
    hz: 1.1,
  });
  run.mainMs = walk + pause;
}

const visitor: Mechanic = {
  init(run, ctx) {
    switch (run.def.id) {
      case 'littleGhost':
        return initLittleGhost(run, ctx);
      case 'friendlyGhost':
        return initFriendlyGhost(run, ctx);
      case 'shadowVisitor':
        return initShadow(run, ctx);
      case 'tinyDragon':
        return initDragon(run, ctx);
      default:
        return initMidnight(run, ctx);
    }
  },
  update(run) {
    return frameFromTracks(run);
  },
};

export const MECHANICS: Readonly<Record<MechanicId, Mechanic>> = { floorRunner, flutter, hopper, wave, weather, drifter, settler, visitor };

/** Everything a fresh run needs before its mechanic's init. */
export function createRun(def: EventDef, outcome: OutcomeDef, idBase: number, mainMs: number, catX: number): Run {
  return {
    def,
    outcome,
    idBase,
    age: 0,
    mainMs,
    keyAt: null,
    tracks: [],
    mem: newMem(),
    trail: [],
    followDx: 0,
    cat0x: catX,
    focusKind: def.props[0] ?? 'sparkle',
    lastFocus: null,
    scared: false,
  };
}
