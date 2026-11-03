// Outer screen edges' cling bands for the T8-safe screen-edge walls (ADR 0003 §6.1). Pure, physical px.
//
// A band exists for the left and the right work-area edge of a display that has no neighbouring
// display on that side: a neighbour is another display whose bounds touch that side (within a join
// tolerance of 2 px at the larger scale of the two) over a shared length of more than 2 px; a
// corner-only contact is no neighbour, so there is never a band between monitors. A side whose work
// area is inset from the display bounds (a docked taskbar) has no band either. The band is the
// strip along the edge as wide as the cat's real footprint (body width x size plus both side
// margins); its clear spans are the vertical stretches no obstacle overlaps. The caller passes the
// obstacles already grown by their margin (resize borders) and decides which windows count.
import type { Rect } from '../../shared/geometry';
import { MAX_EDGE_SPANS, type ScreenEdgeBand } from '../../shared/surfaces';
import type { DisplayGeometry, WorldGeometry } from '../../shared/world';

/** Shared length (px) above which a touching display is a neighbour (corner contact is not). */
export const NEIGHBOUR_MIN_OVERLAP_PX = 2;
/** Join tolerance (DIP; taken at the larger scale of the two displays). */
export const NEIGHBOUR_JOIN_TOLERANCE_DIP = 2;

export interface EdgeBandStats {
  bands: number;
  clearSpans: number;
  coveredSpans: number;
}

type Side = ScreenEdgeBand['side'];

const right = (r: Rect): number => r.x + r.width;
const bottom = (r: Rect): number => r.y + r.height;
const finiteRect = (r: Rect): boolean => [r.x, r.y, r.width, r.height].every((v) => Number.isFinite(v)) && r.width > 0 && r.height > 0;

/** Another display joins `d` on `side` over more than NEIGHBOUR_MIN_OVERLAP_PX. */
export function hasNeighbour(d: DisplayGeometry, side: Side, displays: readonly DisplayGeometry[]): boolean {
  const a = d.boundsPx;
  for (const o of displays) {
    if (o.id === d.id) continue;
    const b = o.boundsPx;
    const tol = Math.ceil(NEIGHBOUR_JOIN_TOLERANCE_DIP * Math.max(d.scaleFactor, o.scaleFactor, 1));
    const touches = side === 'left' ? Math.abs(right(b) - a.x) <= tol : Math.abs(b.x - right(a)) <= tol;
    if (!touches) continue;
    const overlap = Math.min(bottom(a), bottom(b)) - Math.max(a.y, b.y);
    if (overlap > NEIGHBOUR_MIN_OVERLAP_PX) return true;
  }
  return false;
}

/** The band's horizontal extent along a side of the work area. */
export function bandXRange(work: Rect, side: Side, footprintPx: number): { x0: number; x1: number } {
  const w = Math.max(1, Math.min(work.width, footprintPx));
  return side === 'left' ? { x0: work.x, x1: work.x + w } : { x0: right(work) - w, x1: right(work) };
}

/** Covered vertical intervals of the band (merged, top to bottom). */
function coveredIntervals(work: Rect, x: { x0: number; x1: number }, obstacles: readonly Rect[]): Array<{ y0: number; y1: number }> {
  const raw: Array<{ y0: number; y1: number }> = [];
  for (const o of obstacles) {
    if (!finiteRect(o)) continue;
    if (o.x >= x.x1 || right(o) <= x.x0) continue;
    const y0 = Math.max(o.y, work.y);
    const y1 = Math.min(bottom(o), bottom(work));
    if (y1 > y0) raw.push({ y0, y1 });
  }
  raw.sort((p, q) => p.y0 - q.y0);
  const out: Array<{ y0: number; y1: number }> = [];
  for (const r of raw) {
    const last = out[out.length - 1];
    if (last && r.y0 <= last.y1) last.y1 = Math.max(last.y1, r.y1);
    else out.push({ ...r });
  }
  return out;
}

/** The band's clear spans: the complement of the covered intervals, at most MAX_EDGE_SPANS (the tallest), top to bottom. */
function clearSpansOf(work: Rect, covered: ReadonlyArray<{ y0: number; y1: number }>): Array<{ y0: number; y1: number }> {
  const spans: Array<{ y0: number; y1: number }> = [];
  let y = work.y;
  for (const c of covered) {
    if (c.y0 > y) spans.push({ y0: y, y1: c.y0 });
    y = Math.max(y, c.y1);
  }
  if (bottom(work) > y) spans.push({ y0: y, y1: bottom(work) });
  if (spans.length <= MAX_EDGE_SPANS) return spans;
  return spans
    .map((s, i) => ({ s, i }))
    .sort((p, q) => q.s.y1 - q.s.y0 - (p.s.y1 - p.s.y0) || p.i - q.i)
    .slice(0, MAX_EDGE_SPANS)
    .sort((p, q) => p.i - q.i)
    .map((p) => p.s);
}

/** The sides of a display that may hold a band: outer (no neighbour) and not inset by a docked taskbar. */
export function outerSides(d: DisplayGeometry, displays: readonly DisplayGeometry[]): Side[] {
  const out: Side[] = [];
  const w = d.workAreaPx;
  const b = d.boundsPx;
  if (!hasNeighbour(d, 'left', displays) && w.x <= b.x) out.push('left');
  if (!hasNeighbour(d, 'right', displays) && right(w) >= right(b)) out.push('right');
  return out;
}

/**
 * The outer screen edges' cling bands with their clear spans (ADR 0003 §6.1). `obstaclesTopDown`:
 * every shown window that must keep its clicks (already grown by its margin), top first; their
 * order does not change the result. `footprintPx(displayId)`: the cat's real width on that display.
 */
export function computeEdgeBands(world: WorldGeometry, obstaclesTopDown: readonly Rect[], footprintPx: (displayId: string) => number): ScreenEdgeBand[] {
  const out: ScreenEdgeBand[] = [];
  for (const d of world.displays) {
    const work = d.workAreaPx;
    if (!finiteRect(work)) continue;
    const fp = footprintPx(d.id);
    if (!Number.isFinite(fp) || fp <= 0) continue;
    for (const side of outerSides(d, world.displays)) {
      const covered = coveredIntervals(work, bandXRange(work, side, fp), obstaclesTopDown);
      out.push({ displayId: d.id, side, clearSpans: clearSpansOf(work, covered) });
    }
  }
  return out;
}

/** Counts for the diagnostics: bands, clear spans and covered stretches between and around them. */
export function edgeBandStats(world: WorldGeometry, bands: readonly ScreenEdgeBand[]): EdgeBandStats {
  let clear = 0;
  let covered = 0;
  for (const b of bands) {
    clear += b.clearSpans.length;
    const work = world.displays.find((d) => d.id === b.displayId)?.workAreaPx;
    if (!work) continue;
    let y = work.y;
    for (const s of b.clearSpans) {
      if (s.y0 > y) covered++;
      y = s.y1;
    }
    if (bottom(work) > y) covered++;
  }
  return { bands: bands.length, clearSpans: clear, coveredSpans: covered };
}
