// Click-through decision for the overlays (pure). The overlay ignores the mouse unless
// the cursor is inside the cat's reported hit region; everything uncertain resolves
// to "click-through" so the cat can never block the desktop.
import type { Point, Rect } from '../../shared/geometry';

export interface ClickThroughInput {
  /** Cursor in px, null when unknown. */
  cursor: Point | null;
  /** Cat hit region in px (renderer-reported rects mapped to world space). */
  hitRects: readonly Rect[];
  /** Current state; enables the hysteresis margin. */
  interactive: boolean;
  interactionsEnabled: boolean;
  visible: boolean;
  rendererHealthy: boolean;
  dragging: boolean;
  /** Age of the last hit-region report (ms); Infinity when none was received. */
  hitRegionAgeMs: number;
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

function inside(r: Rect, p: Point, margin: number): boolean {
  return p.x >= r.x - margin && p.x < r.x + r.width + margin && p.y >= r.y - margin && p.y < r.y + r.height + margin;
}

export function decideInteractive(input: ClickThroughInput, config: ClickThroughConfig = DEFAULT_CLICK_THROUGH): boolean {
  if (!input.interactionsEnabled || !input.visible) return false;
  const age = Number.isNaN(input.hitRegionAgeMs) ? Infinity : input.hitRegionAgeMs;
  if (input.dragging) return age <= config.maxDragRegionAgeMs || input.rendererHealthy;
  if (!input.rendererHealthy || age > config.maxRegionAgeMs) return false;
  const c = input.cursor;
  if (!c || !Number.isFinite(c.x) || !Number.isFinite(c.y)) return false;
  const margin = input.interactive ? config.hysteresisPx : 0;
  return input.hitRects.some((r) => r.width > 0 && r.height > 0 && inside(r, c, margin));
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
