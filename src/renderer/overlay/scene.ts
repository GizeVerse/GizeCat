// One cat on one overlay: maps a render snapshot to the puppet, owns the view
// transform (anchor, scale, facing turn), computes bounds and hit rects, and draws
// in smooth or pixel style. Uses only the Canvas 2D context it is given (no DOM).
import type { CatRenderState, Emote, RenderStyle } from '../../shared/cat';
import type { Rect } from '../../shared/geometry';
import { drawCat, drawShadow, earCorners, type Ctx2D } from './cat/draw';
import { drawEmote, EMOTE_RADIUS, EMOTE_SIZE, emoteFrame, type EmoteFrame } from './cat/emotes';
import { clamp, smooth } from './cat/math';
import { LEG_COUNT, LEG_FF, LEG_FN } from './cat/pose';
import { CatPuppet } from './cat/puppet';
import { applyMatX, applyMatY, HEAD_RX, HEAD_RY, OUTLINE_W, PAW_RX, TORSO_POINTS } from './cat/rig';
import { getSkin, type Skin } from './cat/skins';
import { frameIntervalMs, isFastMotion, type FrameMotion } from './frameRate';

const TURN_MS = 170;
/** Extra margin around the drawn cat for outline, halo and anti-aliasing (cat-local DIP). */
const DRAW_MARGIN = 5;
/** Pixel style: device pixels per low-res pixel at scale 1 and DPR 1. */
const PIXEL_BLOCK = 3;
/** Hit rects per frame (main accepts up to 8). */
const HIT_RECTS = 7;
/** Points on the head oval of the head's hit rect, and the slack covering the polygon's chords. */
const HEAD_HIT_STEPS = 12;
const HEAD_HIT_SLACK = 0.7;
/** Gap (DIP at size 1) the emote keeps from the overlay's top edge. */
const EMOTE_EDGE_GAP = 2;

export interface SceneInput {
  /** Interpolated ground anchor, overlay-local DIP. */
  x: number;
  y: number;
  state: CatRenderState;
  /** Render-time simulation clock (ms). */
  simTime: number;
  dtMs: number;
  /** Position jumped (teleport/display change): no tail lag, no turn animation. */
  snapped: boolean;
}

/** A scratch 2D surface used for pixel style and translucent rendering. */
export interface Layer {
  readonly canvas: CanvasImageSource;
  readonly ctx: Ctx2D;
}

/** Supplies a layer of at least the requested size (device pixels), or null if unavailable. */
export type LayerProvider = (width: number, height: number) => Layer | null;

export interface DeviceRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

interface LayerGeometry {
  block: number;
  ox: number;
  oy: number;
  lw: number;
  lh: number;
}

export class CatScene {
  readonly puppet: CatPuppet;
  /** Overlay-local DIP bounds of everything drawn this frame. */
  readonly bounds: Rect = { x: 0, y: 0, width: 0, height: 0 };
  /** Hit rects (overlay-local DIP): head, body, front legs, tail base, hind legs, front paws, hind paws. */
  readonly hitRects: Rect[] = [];
  hitCount = 0;

  private x = 0;
  private y = 0;
  private hasPos = false;
  private scale = 1;
  private facingFrom = 1;
  private facingTo = 1;
  private facingNow = 1;
  private turnElapsed = Infinity;
  private skin: Skin = getSkin('ginger');
  private style: RenderStyle = 'smooth';
  private shadow = true;
  private opacity = 1;
  private visible = false;
  private emote: Emote | null = null;
  private emoteVisible = false;
  private readonly emoteF: EmoteFrame = { scale: 0, alpha: 0, rise: 0, wobble: 0, age: 0 };
  private emoteX = 0;
  private emoteY = 0;
  private moved = false;
  private sleeping = false;
  private stateName = '';
  private clipName = '';
  private clipStart = Number.NaN;
  private reactionAt = Number.NaN;

  // Frame-rate policy inputs: the scene's own clock (sum of frame dts), when motion was last
  // fast, and the tracked pose points (tail tip, head front, near front paw; cat-local).
  private clock = 0;
  private lastFastAt = Number.NEGATIVE_INFINITY;
  private poseSpeed = 0;
  private hasPosePoints = false;
  private readonly posePoints = new Float64Array(6);
  private readonly motion: FrameMotion = {
    clip: 'stand',
    state: 'idle',
    speed: 0,
    vy: 0,
    moved: false,
    transition: false,
    poseSpeed: 0,
    quiet: false,
  };

  constructor(random: () => number) {
    this.puppet = new CatPuppet(random);
    for (let i = 0; i < HIT_RECTS; i++) this.hitRects.push({ x: 0, y: 0, width: 0, height: 0 });
  }

  /** Behaviour state and clip of the last update (debug overlay). */
  get stateLabel(): string {
    return `${this.stateName} / ${this.clipName}`;
  }

  get isVisible(): boolean {
    return this.visible && this.opacity > 0.001;
  }

  /** True when the cat is asleep and nothing visibly moves except breathing (frame-rate can drop). */
  get isQuiet(): boolean {
    return this.sleeping && !this.moved && !this.emoteVisible && !this.puppet.animator.blending && this.turnElapsed >= TURN_MS;
  }

  /** A cross-fade, facing turn or reaction layer moved the last frame. */
  private get transitioning(): boolean {
    return this.puppet.animator.blending || this.puppet.animator.reacting || this.turnElapsed < TURN_MS;
  }

  /**
   * Minimum time (ms) until the next frame should be drawn (frameRate.ts): 0 while anything
   * moves fast, ~33 when calm, 50 asleep and still. Judged from the last drawn frame and
   * the pending sample (anchor x, y and its snapshot), so a change that starts fast motion
   * (a new clip, a turn, a reaction, the anchor moving) is drawn at once.
   */
  frameIntervalMs(x: number, y: number, next: CatRenderState): number {
    const m = this.motion;
    m.clip = next.clip;
    m.state = next.state;
    m.speed = next.speed;
    m.vy = next.vy;
    m.moved = this.moved || Math.abs(x - this.x) > 0.01 || Math.abs(y - this.y) > 0.01;
    const r = next.reaction;
    m.transition =
      this.transitioning ||
      next.clip !== this.clipName ||
      next.clipStartedAt !== this.clipStart ||
      (next.facing === -1 ? -1 : 1) !== this.facingTo ||
      (r !== undefined && r !== null && r.at !== this.reactionAt);
    m.poseSpeed = this.poseSpeed;
    m.quiet = this.isQuiet && next.state === 'sleeping';
    m.sleepDepth = next.sleepDepth;
    return frameIntervalMs(m, this.clock - this.lastFastAt);
  }

  update(input: SceneInput): void {
    const s = input.state;
    this.visible = s.visible;
    this.opacity = clamp(Number.isFinite(s.opacity) ? s.opacity : 1, 0, 1);
    this.skin = getSkin(s.skin);
    this.style = s.style === 'pixel' ? 'pixel' : 'smooth';
    this.shadow = s.shadow;
    this.sleeping = s.state === 'sleeping';
    this.stateName = s.state;
    this.clipName = s.clip;
    this.clipStart = s.clipStartedAt;
    const reaction = s.reaction ?? null;
    if (reaction) this.reactionAt = reaction.at;
    const scale = clamp(Number.isFinite(s.scale) && s.scale > 0 ? s.scale : 1, 0.2, 4);
    const dt = Number.isFinite(input.dtMs) ? Math.max(0, input.dtMs) : 0;
    this.clock += dt;

    // Facing: a quick squash-turn instead of an instant mirror.
    const facing = s.facing === -1 ? -1 : 1;
    if (input.snapped || !this.hasPos) {
      this.facingFrom = facing;
      this.facingTo = facing;
      this.turnElapsed = Infinity;
    } else if (facing !== this.facingTo) {
      this.facingFrom = this.facingNow;
      this.facingTo = facing;
      this.turnElapsed = 0;
    }
    if (this.turnElapsed < TURN_MS) this.turnElapsed += dt;
    this.facingNow =
      this.turnElapsed >= TURN_MS ? this.facingTo : this.facingFrom + (this.facingTo - this.facingFrom) * smooth(this.turnElapsed / TURN_MS);

    const sign = this.facingNow >= 0 ? 1 : -1;
    let mx = 0;
    let my = 0;
    if (this.hasPos && !input.snapped) {
      mx = ((input.x - this.x) / scale) * sign;
      my = (input.y - this.y) / scale;
    }
    this.moved = Math.abs(input.x - this.x) > 0.01 || Math.abs(input.y - this.y) > 0.01;
    if (input.snapped) this.puppet.resetTail();
    this.x = input.x;
    this.y = input.y;
    this.scale = scale;
    this.hasPos = true;

    const look = s.look;
    const hasLook = look !== null && Number.isFinite(look.x) && Number.isFinite(look.y);
    this.puppet.advance(
      {
        clip: s.clip,
        clipStartedAt: s.clipStartedAt,
        sleeping: this.sleeping,
        speed: s.speed,
        vy: s.vy / scale,
        lookX: hasLook ? ((look.x - this.x) / scale) * sign : 0,
        lookY: hasLook ? (look.y - this.y) / scale : 0,
        hasLook,
        arousal: s.arousal,
        contentment: s.contentment,
        animSpeed: s.animSpeed,
        reaction,
        movementSpeed: s.movementSpeed,
        jumpKind: s.jumpKind ?? null,
        impact: s.impact,
        balance: s.balance,
        mood: s.mood,
        sleepDepth: s.sleepDepth,
        reducedMotion: s.reducedMotion === true,
      },
      input.simTime,
      dt,
      mx,
      my,
    );

    this.emote = s.emote;
    this.emoteVisible = s.emote !== null && emoteFrame(input.simTime - s.emoteStartedAt, this.emoteF);
    this.computeGeometry();
    this.trackMotion(s, dt, input.snapped);
  }

  /** Measures this frame's motion for the frame-rate policy (allocation-free). */
  private trackMotion(s: CatRenderState, dt: number, snapped: boolean): void {
    const rig = this.puppet.rig;
    const m = rig.m;
    const tail = this.puppet.tail;
    const tip = tail.count - 1;
    const paw = rig.legs[LEG_FN]!;
    // A point at the front of the head, so head turns and tilts count, not just its centre.
    const hx = rig.headX + HEAD_RX * Math.cos(rig.headRot);
    const hy = rig.headY - HEAD_RX * Math.sin(rig.headRot);
    const pts = this.posePoints;
    // A snap resets the tail: that jump is not motion.
    const measure = this.hasPosePoints && dt >= 1 && !snapped;
    let fastest = 0;
    for (let i = 0; i < 3; i++) {
      const lx = i === 0 ? tail.x[tip]! : i === 1 ? hx : paw.fx;
      const ly = i === 0 ? tail.y[tip]! : i === 1 ? hy : paw.fy;
      const X = applyMatX(m, lx, ly);
      const Y = applyMatY(m, lx, ly);
      if (measure) fastest = Math.max(fastest, (Math.hypot(X - pts[i * 2]!, Y - pts[i * 2 + 1]!) * 1000) / dt);
      pts[i * 2] = X;
      pts[i * 2 + 1] = Y;
    }
    this.hasPosePoints = true;
    this.poseSpeed = Number.isFinite(fastest) ? fastest : 0;
    const mo = this.motion;
    mo.clip = s.clip;
    mo.state = s.state;
    mo.speed = s.speed;
    mo.vy = s.vy;
    mo.moved = this.moved;
    mo.transition = this.transitioning;
    mo.poseSpeed = this.poseSpeed;
    mo.quiet = this.isQuiet;
    mo.sleepDepth = s.sleepDepth;
    if (isFastMotion(mo)) this.lastFastAt = this.clock;
  }

  private get sx(): number {
    return this.facingNow * this.scale;
  }
  private get sy(): number {
    return this.scale * (1 + 0.06 * (1 - Math.abs(this.facingNow)));
  }

  // Scratch state for computeGeometry/acc (fields, so the per-frame pass allocates nothing).
  private gsx = 1;
  private gsy = 1;
  private bx0 = 0;
  private by0 = 0;
  private bx1 = 0;
  private by1 = 0;
  private readonly earPts = new Float64Array(6);

  /** Adds a posed cat-local point with radius r (cat units) to the bounds and to hit rect `hit` (or none if < 0). */
  private acc(px: number, py: number, r: number, hit: number): void {
    const m = this.puppet.rig.m;
    const X = this.x + this.gsx * applyMatX(m, px, py);
    const Y = this.y + this.gsy * applyMatY(m, px, py);
    this.accView(X, Y, r * this.scale, hit);
  }

  /** Adds an overlay-DIP point with radius R. Hit rects hold min/max until finalised. */
  private accView(X: number, Y: number, R: number, hit: number): void {
    if (X - R < this.bx0) this.bx0 = X - R;
    if (Y - R < this.by0) this.by0 = Y - R;
    if (X + R > this.bx1) this.bx1 = X + R;
    if (Y + R > this.by1) this.by1 = Y + R;
    if (hit >= 0) {
      const h = this.hitRects[hit]!;
      if (X - R < h.x) h.x = X - R;
      if (Y - R < h.y) h.y = Y - R;
      if (X + R > h.width) h.width = X + R;
      if (Y + R > h.height) h.height = Y + R;
    }
  }

  private computeGeometry(): void {
    const rig = this.puppet.rig;
    const tail = this.puppet.tail;
    const m = rig.m;
    const s = this.scale;
    this.gsx = this.sx;
    this.gsy = this.sy;
    this.bx0 = Infinity;
    this.by0 = Infinity;
    this.bx1 = -Infinity;
    this.by1 = -Infinity;
    const hits = this.hitRects;
    for (const r of hits) {
      r.x = Infinity;
      r.y = Infinity;
      r.width = -Infinity;
      r.height = -Infinity;
    }

    for (let i = 0; i < TORSO_POINTS; i++) this.acc(rig.torso[i * 2]!, rig.torso[i * 2 + 1]!, 0.5, 1);
    this.acc(rig.hx - rig.hrx, rig.hy, 0, 1);
    this.acc(rig.hx + rig.hrx, rig.hy, 0, 1);
    this.acc(rig.hx, rig.hy + rig.hry, 0, 1);
    // Head including ears, drawn bounds: corners of a rotated box.
    const hc = Math.cos(rig.headRot);
    const hs = Math.sin(rig.headRot);
    const hf = rig.headFlip < 0 ? -1 : 1;
    for (let i = 0; i < 4; i++) {
      const lx = i & 1 ? HEAD_RX + 1 : -HEAD_RX - 1;
      const ly = (i & 2 ? HEAD_RY + 1 : -HEAD_RY - 9) * hf;
      this.acc(rig.headX + lx * hc + ly * hs, rig.headY - lx * hs + ly * hc, 0, -1);
    }
    // Head hit region (v1.2): the head oval and the two ears as drawn. The box above swings its
    // empty ear-room corners ahead of the face when the head tips down, which put a pouncing or
    // striking cat's region ~7 DIP closer to the cursor than anything painted (HIT_FRONT_EXTENT_DIP).
    for (let i = 0; i < HEAD_HIT_STEPS; i++) {
      const a = (i * 2 * Math.PI) / HEAD_HIT_STEPS;
      const lx = (HEAD_RX + 1) * Math.cos(a);
      const ly = (HEAD_RY + 1) * Math.sin(a) * hf;
      this.acc(rig.headX + lx * hc + ly * hs, rig.headY - lx * hs + ly * hc, HEAD_HIT_SLACK, 0);
    }
    const pose = this.puppet.pose;
    const ears = this.earPts;
    for (let e = 0; e < 2; e++) {
      earCorners(pose, e === 0 ? 0 : 1, ears);
      for (let i = 0; i < 3; i++) {
        const lx = ears[i * 2]!;
        const ly = ears[i * 2 + 1]! * hf;
        this.acc(rig.headX + lx * hc + ly * hs, rig.headY - lx * hs + ly * hc, 0.5, 0);
      }
    }
    // Room around the ear tips and the whiskers: drawn bounds only, not interactive. Whiskers (drawCat's
    // drawWhiskers) fan out from the face, which shifts with the face turn, and tilt
    // with pose.whisker by up to ~0.6 rad.
    for (let i = 0; i < 2; i++) {
      const lx = i ? 10 : -14;
      const ly = -25 * hf;
      this.acc(rig.headX + lx * hc + ly * hs, rig.headY - lx * hs + ly * hc, 1, -1);
    }
    const turn = clamp(this.puppet.pose.faceTurn, -2, 1);
    const fx = 3.6 + turn * 4.2;
    const back = 1 - 0.4 * clamp(turn + 1, 0, 1);
    for (let i = 0; i < 4; i++) {
      const lx = i & 1 ? fx + 22 : fx - 9 - 11.5 * back;
      const ly = (i & 2 ? 18.7 : -5.3) * hf;
      this.acc(rig.headX + lx * hc + ly * hs, rig.headY - lx * hs + ly * hc, 0.5, -1);
    }
    // Legs per pair (front, hind): knees and legs down to the paw centres, and the paws in a rect of
    // their own. One box over all four legs would span the gap between the pairs at the full width of
    // a knee or paw: on a wall the paws grip the wall line, so it reached into the window the cat
    // clings to over a band where nothing is drawn.
    for (let i = 0; i < LEG_COUNT; i++) {
      const g = rig.legs[i]!;
      const front = i === LEG_FN || i === LEG_FF;
      this.acc(g.kx, g.ky, 4.5, front ? 2 : 4);
      this.acc(g.fx, g.fy, 0, front ? 2 : 4);
      this.acc(g.fx, g.fy, PAW_RX, front ? 5 : 6);
    }
    const n = tail.count;
    for (let i = 0; i < n; i++) this.acc(tail.x[i]!, tail.y[i]!, tail.radius(i) + 1, i <= n * 0.5 ? 3 : -1);
    // Shadow: drawn on the ground line of the view (outside the pose matrix).
    if (this.shadow) {
      // Same extent as drawShadow (upper bound: no airborne shrink).
      const k = clamp(this.puppet.pose.shadow, 0, 1.5);
      const gx = this.x + this.gsx * (m[0]! * rig.bodyX + m[4]!);
      const half = (27 * k * Math.abs(m[0]!) + 4) * Math.abs(this.gsx);
      const rh = (4.2 * k + 0.8) * this.gsy;
      this.accView(gx - half, this.y - 0.6 * this.gsy, rh, -1);
      this.accView(gx + half, this.y - 0.6 * this.gsy, rh, -1);
    }

    const margin = DRAW_MARGIN * s;
    let x0 = this.bx0 - margin;
    let y0 = this.by0 - margin;
    let x1 = this.bx1 + margin;
    let y1 = this.by1 + margin;

    // Emote above the head (not mirrored).
    if (this.emoteVisible) {
      const hx = this.x + this.gsx * applyMatX(m, rig.headX, rig.headY);
      const hy = this.y + this.gsy * applyMatY(m, rig.headX, rig.headY);
      const size = EMOTE_SIZE * clamp(s, 0.85, 2.2);
      this.emoteX = hx + 5 * s * Math.sign(this.facingNow || 1);
      this.emoteY = Math.min(hy, this.y) - (HEAD_RY + 17 + this.emoteF.rise) * s;
      const half = (size * EMOTE_RADIUS) / EMOTE_SIZE;
      // v1.2 (ADR 0003 §8.2): kept inside this overlay at its top edge, so a cat at the top of the
      // screen (a screen-edge climb, a window near the top) shows its whole emote. Only when the cat
      // stands in or below this overlay (anchor at or below its top): an overlay the cat is above
      // must not pull a stray emote in from outside.
      if (this.y >= 0) this.emoteY = Math.max(this.emoteY, half + EMOTE_EDGE_GAP * s);
      x0 = Math.min(x0, this.emoteX - half);
      y0 = Math.min(y0, this.emoteY - half);
      x1 = Math.max(x1, this.emoteX + half);
      y1 = Math.max(y1, this.emoteY + half);
    }
    this.bounds.x = x0;
    this.bounds.y = y0;
    this.bounds.width = x1 - x0;
    this.bounds.height = y1 - y0;

    // Finalise hit rects (stored as min/max above) and drop empty ones.
    let k = 0;
    for (let i = 0; i < hits.length; i++) {
      const h = hits[i]!;
      if (!Number.isFinite(h.x) || !Number.isFinite(h.width) || h.width <= h.x || h.height <= h.y) continue;
      const r = hits[k]!;
      const x0 = h.x;
      const y0 = h.y;
      const w = h.width - h.x;
      const hh = h.height - h.y;
      r.x = x0;
      r.y = y0;
      r.width = w;
      r.height = hh;
      k++;
    }
    this.hitCount = k;
  }

  /**
   * Device-pixel rectangle covering everything draw() can touch (for dirty-rect
   * clearing): the bounds plus anti-aliasing, and in the layered paths the whole blit
   * destination, because pixel style turns every touched low-res pixel into a full
   * block that can reach past the bounds.
   */
  deviceRect(dpr: number, out: DeviceRect): DeviceRect {
    const b = this.bounds;
    let x0 = Math.floor(b.x * dpr) - 2;
    let y0 = Math.floor(b.y * dpr) - 2;
    let x1 = Math.ceil((b.x + b.width) * dpr) + 2;
    let y1 = Math.ceil((b.y + b.height) * dpr) + 2;
    if (this.needsLayer) {
      const g = this.layerGeometry(dpr, this.layerG);
      x0 = Math.min(x0, g.ox);
      y0 = Math.min(y0, g.oy);
      x1 = Math.max(x1, g.ox + g.lw * g.block);
      y1 = Math.max(y1, g.oy + g.lh * g.block);
    }
    out.x = x0;
    out.y = y0;
    out.w = x1 - x0;
    out.h = y1 - y0;
    return out;
  }

  private get needsLayer(): boolean {
    return this.style === 'pixel' || this.opacity < 0.999;
  }

  // Scratch result of layerGeometry (a field, so the per-frame pass allocates nothing).
  private readonly layerG: LayerGeometry = { block: 1, ox: 0, oy: 0, lw: 0, lh: 0 };

  /**
   * Placement of the scratch layer in device pixels: `block` device px per layer px, the
   * layer's top-left at (ox, oy), lw x lh layer px. Aligned to the block grid so pixels
   * do not crawl while moving. drawLayered blits exactly this rectangle.
   */
  private layerGeometry(dpr: number, out: LayerGeometry): LayerGeometry {
    const block = this.style === 'pixel' ? Math.max(2, Math.round(PIXEL_BLOCK * this.scale * dpr)) : 1;
    const b = this.bounds;
    out.block = block;
    out.ox = Math.floor((b.x * dpr) / block) * block - block;
    out.oy = Math.floor((b.y * dpr) / block) * block - block;
    out.lw = Math.ceil(((b.x + b.width) * dpr - out.ox) / block) + 2;
    out.lh = Math.ceil(((b.y + b.height) * dpr - out.oy) / block) + 2;
    return out;
  }

  /** Draws the cat into `ctx` (whose canvas pixels are overlay DIP * dpr). */
  draw(ctx: Ctx2D, dpr: number, layers: LayerProvider | null): void {
    if (!this.isVisible) return;
    if (this.needsLayer && layers) {
      this.drawLayered(ctx, dpr, layers, this.style === 'pixel');
      return;
    }
    ctx.save();
    ctx.globalAlpha = this.opacity;
    this.paint(ctx, dpr, 0, 0, OUTLINE_W, true);
    ctx.restore();
  }

  private drawLayered(ctx: Ctx2D, dpr: number, layers: LayerProvider, pixel: boolean): void {
    const { block, ox, oy, lw, lh } = this.layerGeometry(dpr, this.layerG);
    if (lw <= 0 || lh <= 0 || lw > 4096 || lh > 4096) return;
    const layer = layers(lw, lh);
    if (!layer) return;
    const lc = layer.ctx;
    lc.setTransform(1, 0, 0, 1, 0, 0);
    lc.globalAlpha = 1;
    lc.globalCompositeOperation = 'source-over';
    lc.clearRect(0, 0, lw, lh);
    // Pixel art wants an outline of at least one low-res pixel.
    const outline = pixel ? Math.max(OUTLINE_W, (block / (dpr * this.scale)) * 1.05) : OUTLINE_W;
    this.paint(lc, dpr / block, -ox / block, -oy / block, outline, !pixel);
    if (pixel) {
      hardenAlpha(lc, lw, lh);
      if (this.shadow) {
        lc.globalCompositeOperation = 'destination-over';
        this.setCatTransform(lc, dpr / block, -ox / block, -oy / block);
        drawShadow(lc, this.puppet.rig, this.puppet.pose);
        lc.globalCompositeOperation = 'source-over';
      }
      this.paintEmote(lc, dpr / block, -ox / block, -oy / block);
    }
    ctx.save();
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.globalAlpha = this.opacity;
    ctx.imageSmoothingEnabled = !pixel;
    ctx.drawImage(layer.canvas, 0, 0, lw, lh, ox, oy, lw * block, lh * block);
    ctx.restore();
  }

  private setCatTransform(ctx: Ctx2D, k: number, tx: number, ty: number): void {
    ctx.setTransform(k * this.sx, 0, 0, k * this.sy, k * this.x + tx, k * this.y + ty);
  }

  /** Paints cat (+shadow, +emote unless pixel) with device scale k and device offset (tx, ty). */
  private paint(ctx: Ctx2D, k: number, tx: number, ty: number, outline: number, withExtras: boolean): void {
    this.setCatTransform(ctx, k, tx, ty);
    drawCat(ctx, this.puppet, this.skin, { outline, shadow: this.shadow && withExtras, pixelsPerUnit: k * this.scale });
    if (withExtras) this.paintEmote(ctx, k, tx, ty);
  }

  private paintEmote(ctx: Ctx2D, k: number, tx: number, ty: number): void {
    if (!this.emoteVisible || this.emote === null) return;
    const s = clamp(this.scale, 0.85, 2.2);
    ctx.setTransform(k, 0, 0, k, k * this.emoteX + tx, k * this.emoteY + ty);
    drawEmote(ctx, this.emote, EMOTE_SIZE * s, this.emoteF);
  }
}

/** Pixel style: make every low-res pixel either opaque or transparent for crisp edges. */
function hardenAlpha(ctx: Ctx2D, w: number, h: number): void {
  let img: ImageData;
  try {
    img = ctx.getImageData(0, 0, w, h);
  } catch {
    return;
  }
  const d = img.data;
  for (let i = 3; i < d.length; i += 4) d[i] = d[i]! >= 100 ? 255 : 0;
  ctx.putImageData(img, 0, 0);
}
