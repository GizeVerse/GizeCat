// Click-through decision for the overlays (pure). The overlay ignores the mouse unless
// the cursor is inside the cat's reported hit region, minus the screen areas that must
// always reach the window below (taskbars; v1.2 also the windows next to a cat at a screen
// edge, wallGuardRects); everything uncertain resolves to "click-through" so the cat can
// never block the desktop. v1.2: an optional hover dwell delays interactivity.
import type { Point, Rect } from '../../shared/geometry';

export interface ClickThroughInput {
  /** Cursor in px, null when unknown. */
  cursor: Point | null;
  /** Cat hit region in px (renderer-reported rects mapped to world space). */
  hitRects: readonly Rect[];
  /**
   * Screen areas (px) the overlay never takes the mouse over, whatever the cat's pose:
   * on-screen taskbars and the reveal bands of auto-hide ones. They are cut out of the hit
   * region after the hysteresis margin is added, so the margin never reaches into them.
   */
  excludeRects?: readonly Rect[];
  /** Current state; enables the hysteresis margin. */
  interactive: boolean;
  interactionsEnabled: boolean;
  visible: boolean;
  rendererHealthy: boolean;
  dragging: boolean;
  /** Age of the last hit-region report (ms); Infinity when none was received. */
  hitRegionAgeMs: number;
  /**
   * v1.2 hover dwell (ADR 0003 §6.1, T8): when > 0, an overlay that is not yet interactive turns
   * interactive only after the cursor has stayed inside the (clipped) hit region for this long, so a
   * passing click never lands on a cat clinging to a screen edge while a deliberate grab still works.
   */
  hoverDwellMs?: number;
  /** How long the cursor has been inside the hit region without a break (ms). Unknown = not yet. */
  hoveredMs?: number;
}

export interface ClickThroughConfig {
  /** Extra margin while already interactive, so edge jitter does not toggle the window style. */
  hysteresisPx: number;
  /** A hit region older than this is not trusted. */
  maxRegionAgeMs: number;
  /**
   * While dragging the overlay stays interactive despite a stale region, but only up to
   * this age: a renderer that died mid-drag must not leave the overlay eating clicks.
   */
  maxDragRegionAgeMs: number;
}

export const DEFAULT_CLICK_THROUGH: ClickThroughConfig = {
  hysteresisPx: 3,
  maxRegionAgeMs: 1500,
  maxDragRegionAgeMs: 5000,
};

/** Cut-out for "no hover anywhere": what failing closed excludes (an ongoing drag keeps its captured pointer). */
export const EVERYWHERE: readonly Rect[] = Object.freeze([{ x: -1e9, y: -1e9, width: 2e9, height: 2e9 }]);

function inside(r: Rect, p: Point, margin: number): boolean {
  return p.x >= r.x - margin && p.x < r.x + r.width + margin && p.y >= r.y - margin && p.y < r.y + r.height + margin;
}

const nonEmpty = (r: Rect): boolean => r.width > 0 && r.height > 0;
const finiteRect = (r: Rect): boolean => Number.isFinite(r.x) && Number.isFinite(r.y) && Number.isFinite(r.width) && Number.isFinite(r.height);

/** Appends the parts of `r` outside `hole` (at most four: above, below, left, right). */
function subtract(r: Rect, hole: Rect, out: Rect[]): void {
  const rx1 = r.x + r.width;
  const ry1 = r.y + r.height;
  const hx1 = hole.x + hole.width;
  const hy1 = hole.y + hole.height;
  if (hole.x >= rx1 || hx1 <= r.x || hole.y >= ry1 || hy1 <= r.y) {
    out.push(r);
    return;
  }
  const top = Math.max(r.y, hole.y);
  const bottom = Math.min(ry1, hy1);
  if (hole.y > r.y) out.push({ x: r.x, y: r.y, width: r.width, height: hole.y - r.y });
  if (hy1 < ry1) out.push({ x: r.x, y: hy1, width: r.width, height: ry1 - hy1 });
  if (hole.x > r.x) out.push({ x: r.x, y: top, width: hole.x - r.x, height: bottom - top });
  if (hx1 < rx1) out.push({ x: hx1, y: top, width: rx1 - hx1, height: bottom - top });
}

/**
 * `rects` with every hole cut out: non-overlapping pieces covering exactly the points of
 * the rects outside all holes (half-open rects, like the hit test). Empty or non-finite
 * holes cut nothing.
 */
export function clipRects(rects: readonly Rect[], holes: readonly Rect[]): Rect[] {
  let out = rects.filter(nonEmpty);
  for (const hole of holes) {
    if (!finiteRect(hole) || !nonEmpty(hole)) continue;
    const next: Rect[] = [];
    for (const r of out) subtract(r, hole, next);
    out = next;
  }
  return out;
}

const grow = (r: Rect, m: number): Rect => (m === 0 ? r : { x: r.x - m, y: r.y - m, width: r.width + 2 * m, height: r.height + 2 * m });

const overlaps = (a: Rect, b: Rect): boolean => a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;

/**
 * v1.2 T8 screen-edge guard (ADR 0003 §6.1 (a)): the obstacle windows (px, already grown by their
 * margin) that meet the cat's bounds, unclipped, as cut-outs for `excludeRects`: wherever such a
 * window is, the click goes to it, never to the cat drawn over it. Pure; empty or non-finite rects
 * are ignored, and a non-finite cat yields nothing (the caller fails closed on its own).
 */
export function wallGuardRects(catBoundsPx: Rect, obstacles: readonly Rect[]): Rect[] {
  if (!finiteRect(catBoundsPx) || !nonEmpty(catBoundsPx)) return [];
  const out: Rect[] = [];
  for (const o of obstacles) {
    if (!finiteRect(o) || !nonEmpty(o)) continue;
    if (overlaps(o, catBoundsPx)) out.push({ x: o.x, y: o.y, width: o.width, height: o.height });
  }
  return out;
}

/**
 * The geometric part of the decision: the cursor lies in the hit region (grown by the hysteresis
 * margin while already interactive) after the excluded areas are cut out. No health, age or dwell.
 */
export function cursorInHitZone(input: Pick<ClickThroughInput, 'cursor' | 'hitRects' | 'excludeRects' | 'interactive'>, config: ClickThroughConfig = DEFAULT_CLICK_THROUGH): boolean {
  const c = input.cursor;
  if (!c || !Number.isFinite(c.x) || !Number.isFinite(c.y)) return false;
  const margin = input.interactive ? config.hysteresisPx : 0;
  const zone = input.hitRects.filter(nonEmpty).map((r) => grow(r, margin));
  // Nothing left of the region once the excluded areas are cut out: click-through.
  return clipRects(zone, input.excludeRects ?? []).some((r) => inside(r, c, 0));
}

export function decideInteractive(input: ClickThroughInput, config: ClickThroughConfig = DEFAULT_CLICK_THROUGH): boolean {
  if (!input.interactionsEnabled || !input.visible) return false;
  const age = Number.isNaN(input.hitRegionAgeMs) ? Infinity : input.hitRegionAgeMs;
  // A press can only start inside the clipped region; the overlay then keeps the captured
  // pointer for the whole drag (also across a taskbar) so the moves and the release arrive.
  if (input.dragging) return age <= config.maxDragRegionAgeMs || input.rendererHealthy;
  if (!input.rendererHealthy || age > config.maxRegionAgeMs) return false;
  if (!cursorInHitZone(input, config)) return false;
  // Hover dwell: not yet interactive -> only after the cursor stayed long enough (unknown = not yet).
  const dwell = input.hoverDwellMs ?? 0;
  if (!input.interactive && Number.isFinite(dwell) && dwell > 0) {
    const hovered = input.hoveredMs;
    return typeof hovered === 'number' && Number.isFinite(hovered) && hovered >= dwell;
  }
  // A NaN/infinite dwell asks for something impossible: fail closed.
  if (!input.interactive && !Number.isFinite(dwell)) return false;
  return true;
}

export interface PollIntervalInput {
  cursor: Point | null;
  /** Approximate cat bounds, px. */
  catBounds: Rect | null;
  interactive: boolean;
  dragging: boolean;
  catAsleep: boolean;
  visible: boolean;
}

export interface PollIntervalConfig {
  /** Within this distance of the cat the cursor is polled at the fast rate (px). */
  nearPx: number;
  /** Beyond this distance a sleeping cat is polled at the slow rate (px). */
  farPx: number;
  fastMs: number;
  normalMs: number;
  slowMs: number;
}

export const DEFAULT_POLL_INTERVALS: PollIntervalConfig = {
  nearPx: 160,
  farPx: 480,
  fastMs: 16,
  normalMs: 50,
  slowMs: 125,
};

function distanceToRect(r: Rect, p: Point): number {
  const dx = p.x < r.x ? r.x - p.x : p.x > r.x + r.width ? p.x - (r.x + r.width) : 0;
  const dy = p.y < r.y ? r.y - p.y : p.y > r.y + r.height ? p.y - (r.y + r.height) : 0;
  return Math.hypot(dx, dy);
}

/** Suggested cursor-poll interval: ~60 Hz near the cat or while dragging, ~20 Hz otherwise, ~8 Hz when the cat sleeps and the cursor is far. */
export function suggestPollIntervalMs(input: PollIntervalInput, config: PollIntervalConfig = DEFAULT_POLL_INTERVALS): number {
  if (input.dragging || input.interactive) return config.fastMs;
  if (!input.visible || !input.catBounds) return config.slowMs;
  const dist = input.cursor ? distanceToRect(input.catBounds, input.cursor) : Infinity;
  if (dist <= config.nearPx) return config.fastMs;
  if (input.catAsleep && dist > config.farPx) return config.slowMs;
  return config.normalMs;
}

export interface ClickThroughUpdate {
  interactive: boolean;
  /** True when the overlay's mouse handling must be switched (call setIgnoreMouseEvents once). */
  changed: boolean;
}

/** Stateful wrapper that remembers the current state so the host only touches the window on changes. */
export class ClickThroughGate {
  private state = false;

  constructor(private readonly config: ClickThroughConfig = DEFAULT_CLICK_THROUGH) {}

  get interactive(): boolean {
    return this.state;
  }

  update(input: Omit<ClickThroughInput, 'interactive'>): ClickThroughUpdate {
    const next = decideInteractive({ ...input, interactive: this.state }, this.config);
    const changed = next !== this.state;
    this.state = next;
    return { interactive: next, changed };
  }

  /** Forces click-through (e.g. when an overlay is recreated). */
  reset(): ClickThroughUpdate {
    const changed = this.state;
    this.state = false;
    return { interactive: false, changed };
  }
}
