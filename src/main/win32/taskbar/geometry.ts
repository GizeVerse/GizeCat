// Pure taskbar geometry in physical px. RawRect is Win32 LTRB (right/bottom exclusive).
// The "normal axis" is perpendicular to the docked edge (y for top/bottom taskbars, x for
// left/right); "extent" is how many px of the taskbar's thickness are on its monitor.
import type { Point, Rect } from '../../../shared/geometry';
import type { TaskbarEdge } from '../../../shared/surfaces';
import type { RawRect } from '../native';

/** SHAppBarMessage edges (ABE_*) and state bits (ABS_*). */
export const ABE_LEFT = 0;
export const ABE_TOP = 1;
export const ABE_RIGHT = 2;
export const ABE_BOTTOM = 3;
export const ABS_AUTOHIDE = 0x1;

export function edgeFromAbe(abe: number): TaskbarEdge | null {
  switch (abe) {
    case ABE_LEFT:
      return 'left';
    case ABE_TOP:
      return 'top';
    case ABE_RIGHT:
      return 'right';
    case ABE_BOTTOM:
      return 'bottom';
    default:
      return null;
  }
}

export const isHorizontalEdge = (edge: TaskbarEdge): boolean => edge === 'top' || edge === 'bottom';

export const rawWidth = (r: RawRect): number => r.right - r.left;
export const rawHeight = (r: RawRect): number => r.bottom - r.top;
export const toRect = (r: RawRect): Rect => ({ x: r.left, y: r.top, width: r.right - r.left, height: r.bottom - r.top });
export const fromRect = (r: Rect): RawRect => ({ left: r.x, top: r.y, right: r.x + r.width, bottom: r.y + r.height });

export function rawEqual(a: RawRect, b: RawRect, tolerance = 0): boolean {
  return (
    Math.abs(a.left - b.left) <= tolerance &&
    Math.abs(a.top - b.top) <= tolerance &&
    Math.abs(a.right - b.right) <= tolerance &&
    Math.abs(a.bottom - b.bottom) <= tolerance
  );
}

export function rawContains(outer: RawRect, inner: RawRect): boolean {
  return inner.left >= outer.left && inner.top >= outer.top && inner.right <= outer.right && inner.bottom <= outer.bottom;
}

export function rawOverlapArea(a: RawRect, b: RawRect): number {
  const w = Math.min(a.right, b.right) - Math.max(a.left, b.left);
  const h = Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top);
  return w > 0 && h > 0 ? w * h : 0;
}

/**
 * The monitor side a taskbar rect belongs to, from geometry alone: a bar wider than tall is a
 * top/bottom taskbar, and its centre lies on the docked side's half of the monitor (also while
 * auto-hidden, when most of the window is moved off the monitor past that side).
 */
export function inferEdge(rect: RawRect, monitor: RawRect): TaskbarEdge {
  if (rawWidth(rect) >= rawHeight(rect)) {
    return (rect.top + rect.bottom) / 2 >= (monitor.top + monitor.bottom) / 2 ? 'bottom' : 'top';
  }
  return (rect.left + rect.right) / 2 >= (monitor.left + monitor.right) / 2 ? 'right' : 'left';
}

/** Size of the rect along the normal axis (the taskbar's thickness when it is a taskbar window rect). */
export function thicknessOf(rect: RawRect, edge: TaskbarEdge): number {
  return Math.max(0, isHorizontalEdge(edge) ? rawHeight(rect) : rawWidth(rect));
}

/** px of the rect on the monitor along the normal axis, clamped to [0, thickness]. */
export function onScreenExtent(rect: RawRect, monitor: RawRect, edge: TaskbarEdge, thickness: number): number {
  const overlap = isHorizontalEdge(edge)
    ? Math.min(rect.bottom, monitor.bottom) - Math.max(rect.top, monitor.top)
    : Math.min(rect.right, monitor.right) - Math.max(rect.left, monitor.left);
  return Math.max(0, Math.min(thickness, overlap));
}

/**
 * Coordinate (normal axis) of the taskbar's visible inner edge for a given on-screen extent:
 * its top for a bottom taskbar, its bottom for a top one, its right for a left one, its left
 * for a right one.
 */
export function visibleEdgeAt(monitor: RawRect, edge: TaskbarEdge, extent: number): number {
  switch (edge) {
    case 'bottom':
      return monitor.bottom - extent;
    case 'top':
      return monitor.top + extent;
    case 'left':
      return monitor.left + extent;
    case 'right':
      return monitor.right - extent;
  }
}

/** d(visible edge)/d(extent): -1 when the edge coordinate falls as the taskbar slides in (bottom, right). */
export function edgeSign(edge: TaskbarEdge): 1 | -1 {
  return edge === 'bottom' || edge === 'right' ? -1 : 1;
}

/** Where the taskbar is when fully shown: flush with its monitor side, `thickness` deep, along-span of the window. */
export function dockedRectFor(rect: RawRect, monitor: RawRect, edge: TaskbarEdge, thickness: number): RawRect {
  switch (edge) {
    case 'bottom':
      return { left: rect.left, top: monitor.bottom - thickness, right: rect.right, bottom: monitor.bottom };
    case 'top':
      return { left: rect.left, top: monitor.top, right: rect.right, bottom: monitor.top + thickness };
    case 'left':
      return { left: monitor.left, top: rect.top, right: monitor.left + thickness, bottom: rect.bottom };
    case 'right':
      return { left: monitor.right - thickness, top: rect.top, right: monitor.right, bottom: rect.bottom };
  }
}

/** The work area reaches the monitor side: no taskbar space is reserved there (auto-hide). */
export function workAreaReachesEdge(monitor: RawRect, work: RawRect, edge: TaskbarEdge): boolean {
  switch (edge) {
    case 'bottom':
      return work.bottom >= monitor.bottom;
    case 'top':
      return work.top <= monitor.top;
    case 'left':
      return work.left <= monitor.left;
    case 'right':
      return work.right >= monitor.right;
  }
}

/**
 * Distance (px) of a point inside the monitor from the monitor's `edge` side, measured from the
 * outermost pixel row/column (0 = on it); null when the point is not on this monitor.
 */
export function distanceFromEdge(p: Point, monitor: RawRect, edge: TaskbarEdge): number | null {
  if (!(p.x >= monitor.left && p.x < monitor.right && p.y >= monitor.top && p.y < monitor.bottom)) return null;
  switch (edge) {
    case 'bottom':
      return monitor.bottom - 1 - p.y;
    case 'top':
      return p.y - monitor.top;
    case 'left':
      return p.x - monitor.left;
    case 'right':
      return monitor.right - 1 - p.x;
  }
}

/** The overlap of two rects, null when they do not overlap. */
export function rawIntersect(a: RawRect, b: RawRect): RawRect | null {
  const r = { left: Math.max(a.left, b.left), top: Math.max(a.top, b.top), right: Math.min(a.right, b.right), bottom: Math.min(a.bottom, b.bottom) };
  return r.right > r.left && r.bottom > r.top ? r : null;
}

/** The outermost `depth` px of the monitor along its `edge` side, over the span [s0, s1) along that side. */
export function edgeBand(monitor: RawRect, edge: TaskbarEdge, [s0, s1]: readonly [number, number], depth: number): RawRect {
  switch (edge) {
    case 'bottom':
      return { left: s0, top: monitor.bottom - depth, right: s1, bottom: monitor.bottom };
    case 'top':
      return { left: s0, top: monitor.top, right: s1, bottom: monitor.top + depth };
    case 'left':
      return { left: monitor.left, top: s0, right: monitor.left + depth, bottom: s1 };
    case 'right':
      return { left: monitor.right - depth, top: s0, right: monitor.right, bottom: s1 };
  }
}

/** The taskbar's span along its edge, clipped to the monitor: [x0, x1) for top/bottom, [y0, y1) for left/right. */
export function spanOnMonitor(rect: RawRect, monitor: RawRect, edge: TaskbarEdge): [number, number] {
  return isHorizontalEdge(edge)
    ? [Math.max(rect.left, monitor.left), Math.min(rect.right, monitor.right)]
    : [Math.max(rect.top, monitor.top), Math.min(rect.bottom, monitor.bottom)];
}
