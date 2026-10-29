// v1.1.1 surface outlines: a debug picture of the cat's world (window tops, sides, tab
// strips, taskbars, floor) drawn on its own canvas below the cat. The canvas has
// pointer-events: none and is never part of the hit region (hitRegion.ts reports the cat
// only), so it cannot change click-through. It draws once per frame main sends (at most
// 4 Hz, only while the session toggle is on): no animation loop, and while nothing is
// shown the canvas is shrunk to 1x1 so it holds no full-screen bitmap.
import type { DebugLineRole, SurfaceDebugLine } from '../../shared/surfaceDiagnostics';
import { MAX_DEBUG_LINES } from '../../shared/surfaceDiagnostics';
import type { SurfaceLinesPayload } from '../../shared/surfaceDiagnosticsSchema';
import type { Ctx2D } from './cat/draw';

/** Lines vanish if main stops sending (toggle off and the clearing frame lost, main busy). */
export const SURFACE_LINES_STALE_MS = 2000;

/** Back to front: the cat's support and target are drawn over everything else. */
export const ROLE_ORDER = ['rejected', 'valid', 'reachable', 'support', 'target'] as const satisfies readonly DebugLineRole[];

export const ROLE_STYLE: Record<DebugLineRole, { stroke: string; width: number; dash: readonly number[] }> = {
  rejected: { stroke: 'rgba(150, 150, 150, 0.85)', width: 1.5, dash: [6, 4] },
  valid: { stroke: 'rgba(40, 120, 255, 0.9)', width: 2, dash: [] },
  reachable: { stroke: 'rgba(20, 190, 80, 0.95)', width: 3, dash: [] },
  support: { stroke: 'rgba(255, 140, 0, 1)', width: 4, dash: [] },
  target: { stroke: 'rgba(225, 0, 200, 1)', width: 4, dash: [] },
};

export interface LayerCanvas {
  width: number;
  height: number;
  getContext(id: '2d'): Ctx2D | null;
}

export interface LayerEnv {
  /** Device pixels per CSS px. */
  dpr(): number;
  /** Overlay size in CSS px (overlay-local DIP). */
  size(): { width: number; height: number };
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}

export class SurfaceLayer {
  private lines: readonly SurfaceDebugLine[] = [];
  private staleTimer: unknown = null;
  private ctx: Ctx2D | null = null;

  constructor(
    private readonly canvas: LayerCanvas,
    private readonly env: LayerEnv,
  ) {
    this.release();
  }

  /** Segments currently drawn. */
  get lineCount(): number {
    return this.lines.length;
  }

  /** One frame from main (already validated by the preload); an empty frame clears. */
  show(payload: SurfaceLinesPayload): void {
    this.lines = payload.lines.slice(0, MAX_DEBUG_LINES);
    this.stopStaleTimer();
    if (this.lines.length > 0) this.staleTimer = this.env.setTimeout(() => this.clear(), SURFACE_LINES_STALE_MS);
    this.draw();
  }

  clear(): void {
    this.stopStaleTimer();
    this.lines = [];
    this.release();
  }

  /** Window resized or DPI changed: redraws the current lines at the new size. */
  resize(): void {
    if (this.lines.length > 0) this.draw();
  }

  dispose(): void {
    this.clear();
  }

  private stopStaleTimer(): void {
    if (this.staleTimer === null) return;
    this.env.clearTimeout(this.staleTimer);
    this.staleTimer = null;
  }

  /** Nothing to show: a 1x1 bitmap (setting the size also clears it). */
  private release(): void {
    if (this.canvas.width !== 1) this.canvas.width = 1;
    if (this.canvas.height !== 1) this.canvas.height = 1;
  }

  private draw(): void {
    if (this.lines.length === 0) {
      this.release();
      return;
    }
    const ratio = this.env.dpr();
    const dpr = Number.isFinite(ratio) && ratio > 0 ? ratio : 1;
    const { width, height } = this.env.size();
    const w = Math.max(1, Math.round(width * dpr));
    const h = Math.max(1, Math.round(height * dpr));
    if (this.canvas.width !== w) this.canvas.width = w;
    if (this.canvas.height !== h) this.canvas.height = h;
    this.ctx ??= this.canvas.getContext('2d');
    const ctx = this.ctx;
    if (!ctx) return;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, w, h);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.lineCap = 'round';
    for (const role of ROLE_ORDER) {
      const style = ROLE_STYLE[role];
      let any = false;
      ctx.beginPath();
      for (const l of this.lines) {
        if (l.role !== role) continue;
        any = true;
        ctx.moveTo(l.x0, l.y0);
        ctx.lineTo(l.x1, l.y1);
      }
      if (!any) continue;
      ctx.strokeStyle = style.stroke;
      ctx.lineWidth = style.width;
      ctx.setLineDash([...style.dash]);
      ctx.stroke();
    }
    ctx.setLineDash([]);
  }
}
