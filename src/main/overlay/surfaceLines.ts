// v1.1.1 on-desktop surface outlines: a session-only debug aid (never persisted, off after
// every restart) that draws the cat's world on the overlays. While on, the sim's segments
// (physical px; kinds and roles only, no ids or titles) are mapped into each overlay's
// local DIP with the same conversion as the cat's render state and sent at most every
// SURFACE_LINES_INTERVAL_MS; while off, no timer runs and nothing is sent. Pure apart from
// the timer.
import type { Point, Rect } from '../../shared/geometry';
import { MAX_DEBUG_LINES, type SurfaceDebugLine } from '../../shared/surfaceDiagnostics';
import type { Logger } from '../contracts';

/** 4 Hz: plenty for a debug picture, cheap for main and the renderers. */
export const SURFACE_LINES_INTERVAL_MS = 250;
/** Segments within this distance (px) of a display still go to its overlay (strokes have width). */
const EDGE_SLACK_PX = 8;

/**
 * The segments that touch `bounds` (one display, physical px), in that overlay's local DIP.
 * `toLocalDip` is the overlay's own mapping (DisplayService.toLocalDip for its display).
 */
export function surfaceLinesForDisplay(lines: readonly SurfaceDebugLine[], bounds: Rect, toLocalDip: (p: Point) => Point): SurfaceDebugLine[] {
  const out: SurfaceDebugLine[] = [];
  const x0 = bounds.x - EDGE_SLACK_PX;
  const y0 = bounds.y - EDGE_SLACK_PX;
  const x1 = bounds.x + bounds.width + EDGE_SLACK_PX;
  const y1 = bounds.y + bounds.height + EDGE_SLACK_PX;
  for (const l of lines) {
    if (out.length >= MAX_DEBUG_LINES) break;
    if (![l.x0, l.y0, l.x1, l.y1].every(Number.isFinite)) continue;
    if (Math.max(l.x0, l.x1) < x0 || Math.min(l.x0, l.x1) > x1 || Math.max(l.y0, l.y1) < y0 || Math.min(l.y0, l.y1) > y1) continue;
    const a = toLocalDip({ x: l.x0, y: l.y0 });
    const b = toLocalDip({ x: l.x1, y: l.y1 });
    out.push({ kind: l.kind, role: l.role, x0: a.x, y0: a.y, x1: b.x, y1: b.y });
  }
  return out;
}

/** Where outline frames go (the overlay manager). */
export interface SurfaceLinesSink {
  /**
   * Sends each ready overlay the segments on its display (physical px in). Overlays on
   * `quietDisplayIds` (a fullscreen app in front) and, while the cat is hidden or out of sight,
   * every overlay get none: one clearing frame, then nothing until there is something to draw.
   */
  renderSurfaceLines(lines: readonly SurfaceDebugLine[], quietDisplayIds?: readonly string[]): void;
  /** One empty frame to every overlay that still shows outlines. */
  clearSurfaceLines(): void;
}

export interface SurfaceOutlines {
  readonly enabled: boolean;
  setEnabled(on: boolean): void;
  dispose(): void;
}

export interface SurfaceOutlinesTimers {
  setInterval(fn: () => void, ms: number): unknown;
  clearInterval(handle: unknown): void;
}

const realTimers: SurfaceOutlinesTimers = {
  setInterval: (fn, ms) => setInterval(fn, ms),
  clearInterval: (h) => clearInterval(h as ReturnType<typeof setInterval>),
};

export function createSurfaceOutlines(opts: {
  /** The sim's segments (physical px). */
  getLines: () => readonly SurfaceDebugLine[];
  /** Displays to keep clear of outlines (a fullscreen app in front); default none. */
  getQuietDisplayIds?: () => readonly string[];
  sink: SurfaceLinesSink;
  logger: Logger;
  timers?: SurfaceOutlinesTimers;
  intervalMs?: number;
}): SurfaceOutlines {
  const timers = opts.timers ?? realTimers;
  const intervalMs = Math.max(SURFACE_LINES_INTERVAL_MS, opts.intervalMs ?? SURFACE_LINES_INTERVAL_MS);
  // Session-only: every start begins with the outlines off.
  let timer: unknown = null;
  let failures = 0;

  const frame = (): void => {
    try {
      opts.sink.renderSurfaceLines(opts.getLines().slice(0, MAX_DEBUG_LINES), opts.getQuietDisplayIds?.() ?? []);
      failures = 0;
    } catch (err) {
      failures++;
      if (failures <= 3 || failures % 100 === 0) opts.logger.warn('surface outlines frame failed', { error: err, count: failures });
    }
  };

  const stop = (): void => {
    if (timer === null) return;
    timers.clearInterval(timer);
    timer = null;
  };

  return {
    get enabled() {
      return timer !== null;
    },
    setEnabled(on) {
      if (on === (timer !== null)) return;
      if (on) {
        timer = timers.setInterval(frame, intervalMs);
        opts.logger.info('surface outlines on (session only)');
        frame();
      } else {
        stop();
        opts.logger.info('surface outlines off');
        try {
          opts.sink.clearSurfaceLines();
        } catch (err) {
          opts.logger.warn('clearing surface outlines failed', { error: err });
        }
      }
    },
    dispose: stop,
  };
}
