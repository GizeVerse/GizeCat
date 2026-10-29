// Pure tab-strip geometry: the safe walking span on a browser tab strip (docs/research/v1.1/
// uia-tabs.md §4). Physical px throughout. The cat's anchor (between its feet) may stand anywhere
// in [x0, x1]; its feet rest at y = the frame top (inactive tabs have no visible shape, so the
// strip's visual top is the frame's top edge).
import { CAT_BASE_HEIGHT_DIP, CAT_BASE_WIDTH_DIP } from '../../shared/cat';
import type { Rect } from '../../shared/geometry';
import { rectRight } from '../../shared/geometry';

export interface TabRect extends Rect {
  selected: boolean;
}

/** One browser window's tab strip as read through UI Automation, absolute physical px. */
export interface StripGeometry {
  /** DWM extended frame bounds (the visible window edge). */
  frame: Rect;
  /** Work area of the window's monitor, null if unknown. */
  work: Rect | null;
  /** Window DPI (96 = 100 %). */
  dpi: number;
  /** Horizontal tab container; null/empty when tabs are vertical or hidden. */
  container: Rect | null;
  tabs: readonly TabRect[];
  /** Total number of tabs (may exceed tabs.length when the helper capped the list). */
  count: number;
  /** Tab actions (Edge) / tab search (Chrome) button at the strip's start. */
  leftButton: Rect | null;
  newTab: Rect | null;
  /** Empty draggable caption area between the new-tab button and the caption buttons. */
  grab: Rect | null;
  /** Minimize/maximize/close container. */
  captions: Rect | null;
  maximized: boolean;
  vertical: boolean;
}

/** Margin kept from each end of the span (DIP, scaled by the window DPI and rounded). */
export const STRIP_EDGE_MARGIN_DIP = 6;
/** Rounded corners of the active tab kept out of its resting span (DIP; ~12 px measured at 125 %). */
export const ACTIVE_TAB_CORNER_DIP = 10;

export interface CatExtent {
  width: number;
  height: number;
}

/** The cat's body size in px for an appearance size factor on a window of this DPI. */
export function catExtentPx(size: number, dpi: number): CatExtent {
  const scale = dpi / 96;
  return { width: CAT_BASE_WIDTH_DIP * size * scale, height: CAT_BASE_HEIGHT_DIP * size * scale };
}

export type SegmentDisabledReason = 'maximized' | 'vertical' | 'no-tabs' | 'no-head-room' | 'too-narrow';

export type TabStripSegment =
  | {
      ok: true;
      /** Feet height: the frame top. */
      y: number;
      /** Anchor range: [left + margin + half cat width, right - margin - half cat width]. */
      x0: number;
      x1: number;
      /** Free strip edges before insets: tabs clipped by buttons and caption controls. */
      left: number;
      right: number;
      /** Anchor range on the active tab (inside [x0, x1]), or null when the cat does not fit on it. */
      rest: { x0: number; x1: number } | null;
      /** Centre of the selected tab, or null when no tab reports selection. */
      focusX: number | null;
      /** Index of the selected tab in left-to-right order, or null. */
      selectedIndex: number | null;
      tabCount: number;
    }
  | { ok: false; reason: SegmentDisabledReason };

const usable = (r: Rect | null): r is Rect => r !== null && r.width > 0 && r.height > 0;

/**
 * Safe span of a tab strip:
 *  - L = max(first tab left, right edge of controls before the tabs) and R = min(last tab right,
 *    left edge of controls after them). Controls are the tab actions / tab search button, the
 *    new-tab button, the frame grab handle and the caption buttons; which side a control limits is
 *    decided by where its centre lies relative to the tabs, so mirrored (RTL) strips work too.
 *  - Each end is inset by round(6 * dpi / 96) plus half the cat's width.
 * Disabled when maximized (no ledge above the screen top), with vertical tabs, without tabs, when
 * the cat would not fit above the frame inside the work area, or when the span is too short.
 */
export function computeTabStripSegment(g: StripGeometry, cat: CatExtent): TabStripSegment {
  if (g.maximized) return { ok: false, reason: 'maximized' };
  if (g.vertical || !usable(g.container)) return { ok: false, reason: 'vertical' };
  const tabs = g.tabs.filter((t) => t.width > 0 && t.height > 0).sort((a, b) => a.x - b.x);
  const first = tabs[0];
  const last = tabs[tabs.length - 1];
  if (first === undefined || last === undefined) return { ok: false, reason: 'no-tabs' };
  if (g.work !== null && g.frame.y - g.work.y < cat.height) return { ok: false, reason: 'no-head-room' };

  let left = first.x;
  let right = rectRight(last);
  const mid = (first.x + rectRight(last)) / 2;
  for (const c of [g.leftButton, g.newTab, g.grab, g.captions]) {
    if (!usable(c)) continue;
    if (c.x + c.width / 2 < mid) left = Math.max(left, rectRight(c));
    else right = Math.min(right, c.x);
  }
  left = Math.max(left, g.frame.x);
  right = Math.min(right, rectRight(g.frame));

  const scale = g.dpi / 96;
  const margin = Math.round(STRIP_EDGE_MARGIN_DIP * scale);
  const half = cat.width / 2;
  const x0 = left + margin + half;
  const x1 = right - margin - half;
  if (x1 < x0) return { ok: false, reason: 'too-narrow' };

  const selectedIndex = tabs.findIndex((t) => t.selected);
  const sel = selectedIndex >= 0 ? tabs[selectedIndex] : undefined;
  let rest: { x0: number; x1: number } | null = null;
  let focusX: number | null = null;
  if (sel !== undefined) {
    focusX = sel.x + sel.width / 2;
    const corner = Math.round(ACTIVE_TAB_CORNER_DIP * scale);
    const r0 = Math.max(x0, sel.x + corner + half);
    const r1 = Math.min(x1, rectRight(sel) - corner - half);
    if (r1 >= r0) rest = { x0: r0, x1: r1 };
  }
  return {
    ok: true,
    y: g.frame.y,
    x0,
    x1,
    left,
    right,
    rest,
    focusX,
    selectedIndex: sel !== undefined ? selectedIndex : null,
    tabCount: g.count,
  };
}

/**
 * Strip geometry stored relative to its frame so it can follow window moves between UIA reads:
 * everything is anchored to the frame's left edge except controls that sat in the right half of
 * the frame (caption buttons), which keep their distance from the right edge. A size change still
 * needs a fresh read (the service schedules one at once); until then this is a close estimate.
 */
export interface RelativeStrip {
  frameWidth: number;
  frameHeight: number;
  /** Frame position at the read (to detect moves). */
  frameX: number;
  frameY: number;
  work: Rect | null;
  dpi: number;
  container: Rect | null;
  tabs: TabRect[];
  count: number;
  leftButton: Rect | null;
  newTab: Rect | null;
  grab: Rect | null;
  /** Caption buttons: x is the distance of their left edge from the frame's right edge when `captionsFromRight`. */
  captions: Rect | null;
  captionsFromRight: boolean;
  maximized: boolean;
  vertical: boolean;
}

const rel = (r: Rect | null, f: Rect): Rect | null => (r === null ? null : { x: r.x - f.x, y: r.y - f.y, width: r.width, height: r.height });
const abs = (r: Rect | null, f: Rect): Rect | null => (r === null ? null : { x: r.x + f.x, y: r.y + f.y, width: r.width, height: r.height });

export function toRelativeStrip(g: StripGeometry): RelativeStrip {
  const f = g.frame;
  const fromRight = g.captions !== null && g.captions.x + g.captions.width / 2 > f.x + f.width / 2;
  return {
    frameWidth: f.width,
    frameHeight: f.height,
    frameX: f.x,
    frameY: f.y,
    work: g.work,
    dpi: g.dpi,
    container: rel(g.container, f),
    tabs: g.tabs.map((t) => ({ x: t.x - f.x, y: t.y - f.y, width: t.width, height: t.height, selected: t.selected })),
    count: g.count,
    leftButton: rel(g.leftButton, f),
    newTab: rel(g.newTab, f),
    grab: rel(g.grab, f),
    captions: g.captions === null ? null : fromRight ? { x: rectRight(f) - g.captions.x, y: g.captions.y - f.y, width: g.captions.width, height: g.captions.height } : rel(g.captions, f),
    captionsFromRight: fromRight,
    maximized: g.maximized,
    vertical: g.vertical,
  };
}

/** Places a relative strip on the window's current frame. */
export function placeStrip(r: RelativeStrip, frame: Rect, maximized: boolean): StripGeometry {
  const captions =
    r.captions === null
      ? null
      : r.captionsFromRight
        ? { x: rectRight(frame) - r.captions.x, y: frame.y + r.captions.y, width: r.captions.width, height: r.captions.height }
        : abs(r.captions, frame);
  return {
    frame,
    work: r.work,
    dpi: r.dpi,
    container: abs(r.container, frame),
    tabs: r.tabs.map((t) => ({ x: t.x + frame.x, y: t.y + frame.y, width: t.width, height: t.height, selected: t.selected })),
    count: r.count,
    leftButton: abs(r.leftButton, frame),
    newTab: abs(r.newTab, frame),
    grab: abs(r.grab, frame),
    captions,
    maximized,
    vertical: r.vertical,
  };
}
