// Pure display geometry. "px" = physical virtual-screen pixels (Win32 / world space);
// "local DIP" = CSS pixels of the overlay window that covers a display's work area.
// An overlay's CSS pixel (0,0) sits at workAreaPx's origin and devicePixelRatio equals
// the display's scaleFactor, so px <-> local DIP is an offset plus a uniform scale.
import { rectArea, rectCenter, rectContains, rectIntersection } from '../../shared/geometry';
import type { Point, Rect } from '../../shared/geometry';
import type { DisplayGeometry } from '../../shared/world';

const scaleOf = (d: DisplayGeometry): number => (Number.isFinite(d.scaleFactor) && d.scaleFactor > 0 ? d.scaleFactor : 1);

export function pxToLocalDip(d: DisplayGeometry, p: Point): Point {
  const s = scaleOf(d);
  return { x: (p.x - d.workAreaPx.x) / s, y: (p.y - d.workAreaPx.y) / s };
}

export function localDipToPx(d: DisplayGeometry, p: Point): Point {
  const s = scaleOf(d);
  return { x: d.workAreaPx.x + p.x * s, y: d.workAreaPx.y + p.y * s };
}

export function rectPxToLocalDip(d: DisplayGeometry, r: Rect): Rect {
  const s = scaleOf(d);
  const o = pxToLocalDip(d, r);
  return { x: o.x, y: o.y, width: r.width / s, height: r.height / s };
}

export function rectLocalDipToPx(d: DisplayGeometry, r: Rect): Rect {
  const s = scaleOf(d);
  const o = localDipToPx(d, r);
  return { x: o.x, y: o.y, width: r.width * s, height: r.height * s };
}

export function findDisplay(displays: readonly DisplayGeometry[], id: string): DisplayGeometry | null {
  return displays.find((d) => d.id === id) ?? null;
}

export function primaryDisplay(displays: readonly DisplayGeometry[]): DisplayGeometry | null {
  return displays.find((d) => d.primary) ?? displays[0] ?? null;
}

/** Display whose physical bounds contain the point (half-open edges), or null. */
export function displayAtPoint(displays: readonly DisplayGeometry[], p: Point): DisplayGeometry | null {
  return displays.find((d) => rectContains(d.boundsPx, p)) ?? null;
}

/** Euclidean distance from a point to a rect (0 inside). */
export function distanceToRect(r: Rect, p: Point): number {
  const dx = p.x < r.x ? r.x - p.x : p.x > r.x + r.width ? p.x - (r.x + r.width) : 0;
  const dy = p.y < r.y ? r.y - p.y : p.y > r.y + r.height ? p.y - (r.y + r.height) : 0;
  return Math.hypot(dx, dy);
}

/** Containing display, else the one whose bounds are closest (ties: first in list). */
export function nearestDisplay(displays: readonly DisplayGeometry[], p: Point): DisplayGeometry | null {
  const inside = displayAtPoint(displays, p);
  if (inside) return inside;
  let best: DisplayGeometry | null = null;
  let bestDist = Infinity;
  for (const d of displays) {
    const dist = distanceToRect(d.boundsPx, p);
    if (dist < bestDist) {
      best = d;
      bestDist = dist;
    }
  }
  return best;
}

/** Display sharing the largest area with a px rect; nearest to its centre when it overlaps none. */
export function displayForRect(displays: readonly DisplayGeometry[], r: Rect): DisplayGeometry | null {
  let best: DisplayGeometry | null = null;
  let bestArea = 0;
  for (const d of displays) {
    const inter = rectIntersection(d.boundsPx, r);
    const area = inter ? rectArea(inter) : 0;
    if (area > bestArea) {
      best = d;
      bestArea = area;
    }
  }
  return best ?? nearestDisplay(displays, rectCenter(r));
}

/** Bounding box of all displays (bounds or work areas), px. null when there are none. */
export function unionBounds(displays: readonly DisplayGeometry[], which: 'boundsPx' | 'workAreaPx' = 'boundsPx'): Rect | null {
  if (displays.length === 0) return null;
  let x0 = Infinity;
  let y0 = Infinity;
  let x1 = -Infinity;
  let y1 = -Infinity;
  for (const d of displays) {
    const r = d[which];
    x0 = Math.min(x0, r.x);
    y0 = Math.min(y0, r.y);
    x1 = Math.max(x1, r.x + r.width);
    y1 = Math.max(y1, r.y + r.height);
  }
  return { x: x0, y: y0, width: x1 - x0, height: y1 - y0 };
}

/** Clamps a point into a rect (inclusive of the far edge minus one pixel for integer grids). */
export function clampPointToRect(r: Rect, p: Point, inset = 0): Point {
  const x0 = r.x + inset;
  const y0 = r.y + inset;
  const x1 = Math.max(x0, r.x + r.width - 1 - inset);
  const y1 = Math.max(y0, r.y + r.height - 1 - inset);
  return { x: Math.min(Math.max(p.x, x0), x1), y: Math.min(Math.max(p.y, y0), y1) };
}
