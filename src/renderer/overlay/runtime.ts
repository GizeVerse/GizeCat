// Overlay renderer runtime: receives render snapshots, interpolates, runs the frame loop
// only while the cat is visible, draws at the display rate only while the cat moves fast
// (frameRate.ts), clears and redraws only dirty regions, reports the hit region and
// forwards pointer input. Never decides behaviour.
import type { CatRenderState } from '../../shared/cat';
import type { RenderProp } from '../../shared/companion';
import type { OverlayApi, OverlayConfig } from '../../shared/ipc';
import type { Ctx2D } from './cat/draw';
import { CALM_FRAME_MS, FramePacer, FULL_RATE_MS } from './frameRate';
import { blendProps, drawLaser, drawProps, laserBounds, propsBounds, type PropRect } from './props';
import { HIT_REFRESH_MS, HitRegionReporter } from './hitRegion';
import { attachPointerInput } from './input';
import { SnapshotInterpolator, type InterpSample } from './interpolation';
import { CatScene, type DeviceRect, type Layer, type LayerProvider } from './scene';
import { createSoundPlayer, type AudioContextLike, type SoundPlayer } from './sound';
import { isOverlayConfig, isRenderState } from './validate';

/**
 * 1.4.0: optional host hooks for the web host (src/web/main.ts). The desktop overlay passes none
 * and behaves exactly as before: the browser's AudioContext and window.innerWidth/innerHeight.
 */
export interface OverlayRuntimeOptions {
  /** Makes the sound player's AudioContext (the web host shares one gesture-unlocked context). */
  audio?: () => AudioContextLike;
  /** The canvas's CSS size (the web host measures the layout viewport, as its display service does). */
  viewport?: () => { width: number; height: number };
}

const windowViewport = (): { width: number; height: number } => ({ width: window.innerWidth, height: window.innerHeight });

const NO_PROPS: readonly RenderProp[] = [];
const MAX_FRAME_DT_MS = 250;
const MAX_CONSECUTIVE_ERRORS = 30;
const ERROR_REPORT_INTERVAL_MS = 2000;
/** Heartbeat timer period; the region itself is re-sent every HIT_REFRESH_MS at most. */
const HEARTBEAT_TICK_MS = HIT_REFRESH_MS / 2;

/** Invisible placeholder until the first snapshot arrives (never drawn). */
const INITIAL_STATE: CatRenderState = {
  seq: -1,
  t: 0,
  x: 0,
  y: 0,
  snap: true,
  scale: 1,
  facing: 1,
  state: 'idle',
  clip: 'stand',
  clipStartedAt: 0,
  speed: 0,
  vy: 0,
  look: null,
  arousal: 0,
  contentment: 0.5,
  emote: null,
  emoteStartedAt: 0,
  opacity: 0,
  visible: false,
  skin: 'ginger',
  style: 'smooth',
  shadow: true,
  animSpeed: 1,
};

export class OverlayRuntime {
  private readonly ctx: CanvasRenderingContext2D;
  private readonly interp = new SnapshotInterpolator();
  private readonly sample: InterpSample;
  private readonly scene = new CatScene(Math.random);
  private readonly pacer = new FramePacer();
  private readonly hits: HitRegionReporter;
  /** v1.2 (ADR 0003 §10): plays the cues main sends this overlay (only while sound is on). */
  private readonly sound: SoundPlayer;
  private config: OverlayConfig = { displayId: '', scaleFactor: 1, debug: false };
  private dpr = 1;
  private cssW = 0;
  private cssH = 0;
  private rafId = 0;
  private running = false;
  private lastUpdateAt = Number.NaN;
  private readonly prevDirty: DeviceRect = { x: 0, y: 0, w: 0, h: 0 };
  private hasPrevDirty = false;
  private readonly curDirty: DeviceRect = { x: 0, y: 0, w: 0, h: 0 };
  /** Reused by the per-frame prop blend (no allocation of the array per frame). */
  private readonly propScratch: RenderProp[] = [];
  private layerCanvas: OffscreenCanvas | null = null;
  private layer: Layer | null = null;
  private consecutiveErrors = 0;
  private lastErrorAt = Number.NEGATIVE_INFINITY;
  private heartbeat: ReturnType<typeof setInterval> | null = null;
  /** Drawing failed for good: stay silent so main recreates this overlay. */
  private gaveUp = false;
  private readonly disposers: (() => void)[] = [];
  /** The canvas's CSS size source (window.innerWidth/innerHeight unless the host gives one). */
  private readonly viewportSize: () => { width: number; height: number };
  private readonly windowSize = { width: 0, height: 0 };

  constructor(
    private readonly canvas: HTMLCanvasElement,
    private readonly api: OverlayApi,
    options: OverlayRuntimeOptions = {},
  ) {
    const ctx = canvas.getContext('2d', { alpha: true });
    if (!ctx) throw new Error('overlay: 2D canvas context unavailable');
    this.ctx = ctx;
    this.hits = new HitRegionReporter((r) => api.sendHitRegion(r));
    this.sound = createSoundPlayer({ now: () => performance.now(), audio: options.audio });
    this.viewportSize = options.viewport ?? windowViewport;
    this.sample = { x: 0, y: 0, state: INITIAL_STATE, simTime: 0, snapped: false };
  }

  /**
   * The canvas's CSS size, read every frame: without a host source, window.innerWidth/innerHeight
   * into one reused object (no allocation per frame, as before 1.4.0); a host source that throws or
   * returns a broken size falls back to the window's.
   */
  private viewport(): { width: number; height: number } {
    if (this.viewportSize !== windowViewport) {
      try {
        const v = this.viewportSize();
        if (Number.isFinite(v.width) && Number.isFinite(v.height)) return v;
      } catch {
        // Fall back below.
      }
    }
    this.windowSize.width = window.innerWidth;
    this.windowSize.height = window.innerHeight;
    return this.windowSize;
  }

  start(): void {
    this.resize();
    const onResize = (): void => this.resize();
    window.addEventListener('resize', onResize);
    this.disposers.push(() => window.removeEventListener('resize', onResize));
    this.disposers.push(this.api.onRender((s) => this.onRender(s)));
    this.disposers.push(this.api.onConfig((c) => this.onConfig(c)));
    this.disposers.push(attachPointerInput(this.canvas, (e) => this.api.sendPointer(e)));
    this.api.ready();
  }

  dispose(): void {
    this.stopLoop();
    this.stopHeartbeat();
    this.sound.dispose();
    for (const d of this.disposers.splice(0)) d();
  }

  /**
   * While main shows the cat on this overlay, the hit region is re-reported periodically
   * (from a timer, independent of frame pacing). Main treats the silence of a hung
   * renderer as a hang: forced click-through, then recreation.
   */
  private startHeartbeat(): void {
    if (this.heartbeat !== null || this.gaveUp) return;
    this.heartbeat = setInterval(() => this.hits.refresh(performance.now()), HEARTBEAT_TICK_MS);
  }

  private stopHeartbeat(): void {
    if (this.heartbeat === null) return;
    clearInterval(this.heartbeat);
    this.heartbeat = null;
  }

  reportError(message: string): void {
    const now = performance.now();
    if (now - this.lastErrorAt < ERROR_REPORT_INTERVAL_MS) return;
    this.lastErrorAt = now;
    try {
      this.api.reportError(message.slice(0, 500));
    } catch {
      // Nothing else we can do from the renderer.
    }
  }

  private onRender(s: unknown): void {
    if (!isRenderState(s)) return;
    // The player plays each cue once and drops stale ones, so a duplicate snapshot is harmless.
    if (s.sound && s.visible) this.sound.play(s.sound, s.t);
    // Hidden or away: a cue already playing ends now, not at its own end (ADR 0003 §10).
    if (!s.visible) this.sound.close();
    if (!this.interp.push(s, performance.now())) return;
    if (s.visible) this.startHeartbeat();
    else this.stopHeartbeat();
    if (!this.running && s.visible && s.opacity > 0) this.startLoop();
    if (!this.running && !s.visible) this.hits.clear(performance.now());
  }

  private onConfig(c: unknown): void {
    if (!isOverlayConfig(c)) return;
    this.config = { displayId: c.displayId, scaleFactor: c.scaleFactor, debug: c.debug };
    this.hits.invalidate();
    this.resize();
  }

  private resize(): void {
    const ratio = window.devicePixelRatio;
    const dpr = Number.isFinite(ratio) && ratio > 0 ? ratio : this.config.scaleFactor > 0 ? this.config.scaleFactor : 1;
    const v = this.viewport();
    const w = Math.max(1, v.width);
    const h = Math.max(1, v.height);
    if (dpr === this.dpr && w === this.cssW && h === this.cssH && this.canvas.width > 1) return;
    this.dpr = dpr;
    this.cssW = w;
    this.cssH = h;
    this.canvas.width = Math.max(1, Math.round(w * dpr));
    this.canvas.height = Math.max(1, Math.round(h * dpr));
    // Resizing resets the bitmap: nothing old remains to be cleared.
    this.hasPrevDirty = false;
    if (!this.running && this.interp.newest()?.visible) this.startLoop();
  }

  private readonly layers: LayerProvider = (w, h) => {
    if (!this.layerCanvas) {
      if (typeof OffscreenCanvas === 'undefined') return null;
      this.layerCanvas = new OffscreenCanvas(Math.max(64, w), Math.max(64, h));
      const ctx = this.layerCanvas.getContext('2d', { willReadFrequently: true });
      if (!ctx) return null;
      this.layer = { canvas: this.layerCanvas, ctx: ctx as Ctx2D };
    }
    if (this.layerCanvas.width < w || this.layerCanvas.height < h) {
      this.layerCanvas.width = Math.max(this.layerCanvas.width, w);
      this.layerCanvas.height = Math.max(this.layerCanvas.height, h);
    }
    return this.layer;
  };

  private startLoop(): void {
    this.running = true;
    this.lastUpdateAt = Number.NaN;
    if (this.rafId === 0) this.rafId = requestAnimationFrame(this.frame);
  }

  private stopLoop(): void {
    this.running = false;
    if (this.rafId !== 0) cancelAnimationFrame(this.rafId);
    this.rafId = 0;
  }

  private clearDirty(): void {
    if (!this.hasPrevDirty) return;
    const r = this.prevDirty;
    this.ctx.setTransform(1, 0, 0, 1, 0, 0);
    this.ctx.clearRect(r.x, r.y, r.w, r.h);
    this.hasPrevDirty = false;
  }

  private readonly frame = (now: number): void => {
    this.rafId = 0;
    if (!this.running) return;
    try {
      this.step(now);
      this.consecutiveErrors = 0;
      // Drawing works again: the next snapshot restarts the heartbeat.
      this.gaveUp = false;
    } catch (err) {
      this.consecutiveErrors++;
      this.reportError(`overlay frame failed: ${err instanceof Error ? err.message : String(err)}`);
      if (this.consecutiveErrors >= MAX_CONSECUTIVE_ERRORS) {
        // Give up drawing rather than spin; main sees the error reports and the empty hit
        // region, and the missing heartbeat makes it recreate this overlay.
        this.clearDirty();
        this.hits.clear(now);
        this.stopLoop();
        this.gaveUp = true;
        this.stopHeartbeat();
        return;
      }
    }
    if (this.running && this.rafId === 0) this.rafId = requestAnimationFrame(this.frame);
  };

  private step(now: number): void {
    const v = this.viewport();
    if (window.devicePixelRatio !== this.dpr || v.width !== this.cssW || v.height !== this.cssH) this.resize();
    if (!this.interp.sample(now, this.sample)) {
      this.stopLoop();
      return;
    }
    const st = this.sample.state;
    if (!st.visible || st.opacity <= 0) {
      this.clearDirty();
      this.hits.clear(now);
      this.lastUpdateAt = Number.NaN;
      // Keep running only while a newer visible snapshot is still waiting to be rendered.
      if (!this.interp.newest()?.visible) this.stopLoop();
      return;
    }
    const first = this.sample.snapped || !Number.isFinite(this.lastUpdateAt);
    const props = this.currentProps(st);
    const laser = st.laser ?? null;
    let interval = first ? FULL_RATE_MS : this.scene.frameIntervalMs(this.sample.x, this.sample.y, st);
    // Animated props and the laser dot keep at least a calm 30 fps even while the cat sleeps; with
    // neither, the cat's own (slower) pacing applies again.
    if ((props.length > 0 || laser !== null) && interval > CALM_FRAME_MS) interval = CALM_FRAME_MS;
    if (!this.pacer.shouldDraw(now, interval)) return;

    const dt = Number.isFinite(this.lastUpdateAt) ? Math.min(MAX_FRAME_DT_MS, Math.max(0, now - this.lastUpdateAt)) : 0;
    this.lastUpdateAt = now;
    this.scene.update({ x: this.sample.x, y: this.sample.y, state: st, simTime: this.sample.simTime, dtMs: dt, snapped: this.sample.snapped });

    const cur = this.scene.deviceRect(this.dpr, this.curDirty);
    if (this.config.debug) {
      cur.y -= Math.round(18 * this.dpr);
      cur.h += Math.round(18 * this.dpr);
      cur.w = Math.max(cur.w, Math.round(220 * this.dpr));
    }
    // Props and the laser dot join the dirty rect, so what they drew last frame is cleared when they
    // move or vanish (the previous union is cleared together with this one below).
    const reduced = st.reducedMotion === true;
    const propBox = props.length > 0 ? propsBounds(props, st.scale) : null;
    if (propBox) this.unionDip(cur, propBox);
    const laserBox = laser ? laserBounds(laser.x, laser.y) : null;
    if (laserBox) this.unionDip(cur, laserBox);
    const ctx = this.ctx;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    if (this.hasPrevDirty) {
      const p = this.prevDirty;
      const x0 = Math.min(p.x, cur.x);
      const y0 = Math.min(p.y, cur.y);
      ctx.clearRect(x0, y0, Math.max(p.x + p.w, cur.x + cur.w) - x0, Math.max(p.y + p.h, cur.y + cur.h) - y0);
    } else {
      ctx.clearRect(cur.x, cur.y, cur.w, cur.h);
    }
    // Props behind the cat, the laser dot over it; neither is part of the hit region (reported from the cat only).
    if (propBox) {
      ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
      drawProps(ctx, props, { t: this.sample.simTime, scale: st.scale, style: st.style, reducedMotion: reduced, width: this.cssW, height: this.cssH });
    }
    this.scene.draw(ctx, this.dpr, this.layers);
    if (laser) {
      ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
      drawLaser(ctx, laser.x, laser.y, { t: this.sample.simTime, reducedMotion: reduced });
    }
    if (this.config.debug) this.drawDebug(ctx);
    this.prevDirty.x = cur.x;
    this.prevDirty.y = cur.y;
    this.prevDirty.w = cur.w;
    this.prevDirty.h = cur.h;
    this.hasPrevDirty = true;

    this.hits.update(this.scene.hitRects, this.scene.hitCount, now);
  }

  /** The props to draw this frame: the current snapshot's, blended by id toward the next one when the render time lies between them. */
  private currentProps(st: CatRenderState): readonly RenderProp[] {
    const a = st.props;
    if (!a || a.length === 0) return NO_PROPS;
    const next = this.sample.next;
    const k = this.sample.k ?? 0;
    if (next && next.props && !next.snap && k > 0) return blendProps(a, next.props, k, this.propScratch);
    return a;
  }

  /** Grows `r` (device px) to cover a DIP rectangle, with the same 2 px of anti-aliasing slack as the cat's rect. */
  private unionDip(r: DeviceRect, b: PropRect): void {
    const d = this.dpr;
    const x0 = Math.min(r.x, Math.floor(b.x * d) - 2);
    const y0 = Math.min(r.y, Math.floor(b.y * d) - 2);
    const x1 = Math.max(r.x + r.w, Math.ceil((b.x + b.width) * d) + 2);
    const y1 = Math.max(r.y + r.h, Math.ceil((b.y + b.height) * d) + 2);
    r.x = x0;
    r.y = y0;
    r.w = x1 - x0;
    r.h = y1 - y0;
  }

  private drawDebug(ctx: Ctx2D): void {
    const d = this.dpr;
    ctx.save();
    ctx.setTransform(d, 0, 0, d, 0, 0);
    ctx.globalAlpha = 1;
    ctx.lineWidth = 1;
    ctx.strokeStyle = 'rgba(255,40,80,0.9)';
    for (let i = 0; i < this.scene.hitCount; i++) {
      const r = this.scene.hitRects[i]!;
      ctx.strokeRect(r.x, r.y, r.width, r.height);
    }
    const b = this.scene.bounds;
    ctx.strokeStyle = 'rgba(40,160,255,0.6)';
    ctx.strokeRect(b.x, b.y, b.width, b.height);
    ctx.font = '11px sans-serif';
    ctx.fillStyle = 'rgba(0,0,0,0.65)';
    ctx.fillRect(b.x, b.y - 16, 210, 15);
    ctx.fillStyle = '#ffffff';
    ctx.fillText(`${this.config.displayId} ${this.scene.stateLabel}`, b.x + 3, b.y - 5);
    ctx.restore();
  }
}
