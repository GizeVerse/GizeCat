// Throttled, change-detected reporting of the cat's interactive hit region to main.
import type { HitRegion } from '../../shared/cat';
import type { Rect } from '../../shared/geometry';

export const HIT_TOLERANCE_DIP = 2;
export const HIT_MIN_INTERVAL_MS = 1000 / 15;
const MAX_RECTS = 8;
const COORD_LIMIT = 100000;
const SIZE_LIMIT = 5000;

function sanitize(r: Rect): Rect | null {
  if (!Number.isFinite(r.x) || !Number.isFinite(r.y) || !Number.isFinite(r.width) || !Number.isFinite(r.height)) return null;
  const width = Math.min(SIZE_LIMIT, Math.max(0, r.width));
  const height = Math.min(SIZE_LIMIT, Math.max(0, r.height));
  if (width <= 0 || height <= 0) return null;
  return {
    x: Math.min(COORD_LIMIT, Math.max(-COORD_LIMIT, r.x)),
    y: Math.min(COORD_LIMIT, Math.max(-COORD_LIMIT, r.y)),
    width,
    height,
  };
}

function differs(a: readonly Rect[], aCount: number, b: readonly Rect[], tol: number): boolean {
  if (aCount !== b.length) return true;
  for (let i = 0; i < aCount; i++) {
    const p = a[i]!;
    const q = b[i]!;
    if (
      Math.abs(p.x - q.x) > tol ||
      Math.abs(p.y - q.y) > tol ||
      Math.abs(p.x + p.width - (q.x + q.width)) > tol ||
      Math.abs(p.y + p.height - (q.y + q.height)) > tol
    )
      return true;
  }
  return false;
}

export class HitRegionReporter {
  private last: Rect[] | null = null;
  private lastSentAt = Number.NEGATIVE_INFINITY;

  constructor(
    private readonly send: (region: HitRegion) => void,
    private readonly minIntervalMs = HIT_MIN_INTERVAL_MS,
    private readonly tolerance = HIT_TOLERANCE_DIP,
  ) {}

  /**
   * Offers the current rects (overlay-local DIP). Sends when they moved by more than the
   * tolerance and the rate limit allows; otherwise a later call sends the change.
   * Returns true when something was sent.
   */
  update(rects: readonly Rect[], count: number, now: number): boolean {
    const n = Math.max(0, Math.min(count, rects.length, MAX_RECTS));
    // Compare before sanitising so the common "nothing changed" frame allocates nothing.
    if (this.last !== null && !differs(rects, n, this.last, this.tolerance)) return false;
    if (now - this.lastSentAt < this.minIntervalMs) return false;
    const clean: Rect[] = [];
    for (let i = 0; i < n; i++) {
      const r = sanitize(rects[i]!);
      if (r) clean.push(r);
    }
    if (this.last !== null && !differs(clean, clean.length, this.last, this.tolerance)) {
      this.last = clean;
      return false;
    }
    return this.emit(clean, now);
  }

  /** Reports an empty region immediately (cat invisible); deduplicated. */
  clear(now: number): boolean {
    if (this.last !== null && this.last.length === 0) return false;
    return this.emit([], now);
  }

  /** Forget what was sent (e.g. after the overlay config changes) so the next update re-sends. */
  invalidate(): void {
    this.last = null;
    this.lastSentAt = Number.NEGATIVE_INFINITY;
  }

  private emit(rects: Rect[], now: number): boolean {
    try {
      this.send({ rects: rects.map((r) => ({ x: r.x, y: r.y, width: r.width, height: r.height })) });
    } catch {
      return false;
    }
    this.last = rects;
    this.lastSentAt = now;
    return true;
  }
}
