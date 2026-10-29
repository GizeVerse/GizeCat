// Pure geometry of window surfaces (physical px): the walkable top ledge and the climbable
// side walls of one app window, cut by everything above it in z-order. Inputs are the
// window's DWM extended frame bounds (its visible edge, not the invisible resize border),
// the rects above it and the display layout; nothing here touches the OS.
import { displayForRect } from '../../core/display/displayMath';
import type { Rect } from '../../shared/geometry';
import type { LedgeSurface, SurfacePhase, WallSurface } from '../../shared/surfaces';
import type { DisplayGeometry, WindowInfo } from '../../shared/world';
import { openColumnSpans, openRowSpans, type Span } from '../win32/platforms';

export interface WindowSurfaceOptions {
  /** Rounded-corner radius at 96 dpi (Windows 11: 8; Windows 10: 0). Scaled by the display's scale factor. */
  cornerRadiusDip: number;
  /** Narrowest walkable top-ledge span (px, like v1's MIN_PLATFORM_WIDTH). */
  minLedgeWidthPx: number;
  /** Shortest climbable wall span (DIP, scaled). */
  minWallHeightDip: number;
  /** Open space the cat needs beside a wall to cling to it (DIP, scaled). */
  wallClearanceDip: number;
  /** Side walls are produced only while climbing is allowed (behaviour toggle climbWindows). */
  climbWindows: boolean;
}

/** Tolerance for "the top ledge reaches the corner" and similar edge comparisons (px). */
const CORNER_REACH_PX = 2;
/** Tolerance of a "maximized" frame against the work area (px). */
const COVER_TOLERANCE_PX = 2;

export const ledgeId = (hwnd: string): string => `windowTop:${hwnd}`;
export const wallId = (hwnd: string, side: 'left' | 'right'): string => `windowSide:${hwnd}:${side}`;
export const stripId = (hwnd: string): string => `tabStrip:${hwnd}`;

/** Parses a surface id into its kind and owner (and side for walls); null when malformed. */
export function parseSurfaceId(id: string): { kind: 'taskbar' | 'windowTop' | 'tabStrip'; owner: string } | { kind: 'windowSide'; owner: string; side: 'left' | 'right' } | null {
  const parts = id.split(':');
  const owner = parts[1];
  if (owner === undefined || owner.length === 0) return null;
  const kind = parts[0];
  if (kind === 'windowSide') {
    const side = parts[2];
    return parts.length === 3 && (side === 'left' || side === 'right') ? { kind, owner, side } : null;
  }
  if (parts.length !== 2) return null;
  return kind === 'taskbar' || kind === 'windowTop' || kind === 'tabStrip' ? { kind, owner } : null;
}

/** Windows 11 (build >= 22000) rounds top-level window corners; Windows 10 does not. */
export function defaultCornerRadiusDip(osRelease: string): number {
  const build = Number(osRelease.split('.')[2]);
  return Number.isFinite(build) && build >= 22000 ? 8 : 0;
}

export const scaleForRect = (displays: readonly DisplayGeometry[], r: Rect): number => displayForRect(displays, r)?.scaleFactor ?? 1;

/** Rounded-corner inset in px for a window on a display with this scale factor. */
export const cornerInsetPx = (opts: Pick<WindowSurfaceOptions, 'cornerRadiusDip'>, scale: number): number => Math.round(opts.cornerRadiusDip * scale);

/** The frame covers a display's work area: maximized (or fullscreen, which covers the bounds). */
export function coversWorkArea(r: Rect, displays: readonly DisplayGeometry[]): boolean {
  const t = COVER_TOLERANCE_PX;
  return displays.some((d) => {
    const wa = d.workAreaPx;
    return r.x <= wa.x + t && r.y <= wa.y + t && r.x + r.width >= wa.x + wa.width - t && r.y + r.height >= wa.y + wa.height - t;
  });
}

/** Whether a window offers surfaces at all: shown, not maximized, not fullscreen (privacy is a flag, not a filter). */
export function offersSurfaces(info: Pick<WindowInfo, 'minimized' | 'maximized' | 'fullscreen'>, rect: Rect, displays: readonly DisplayGeometry[]): boolean {
  if (info.minimized || info.maximized || info.fullscreen) return false;
  if (!(rect.width > 0 && rect.height > 0)) return false;
  return !coversWorkArea(rect, displays);
}

/** Clips spans to the x-ranges of the work areas that contain row `y` (where the cat's feet are). */
function clipToWorkAreasOnRow(spans: readonly Span[], y: number, displays: readonly DisplayGeometry[]): Span[] {
  const out: Span[] = [];
  for (const d of displays) {
    const wa = d.workAreaPx;
    if (y < wa.y || y >= wa.y + wa.height) continue;
    for (const [a, b] of spans) {
      const x0 = Math.max(a, wa.x);
      const x1 = Math.min(b, wa.x + wa.width);
      if (x1 > x0) out.push([x0, x1]);
    }
  }
  return out.sort((p, q) => p[0] - q[0]);
}

/** True when the x-spans cover [x0, x1) completely. */
function coversRange(spans: readonly Span[], x0: number, x1: number): boolean {
  let reach = x0;
  for (const [a, b] of [...spans].sort((p, q) => p[0] - q[0])) {
    if (a > reach) return false;
    if (b > reach) reach = b;
    if (reach >= x1) return true;
  }
  return reach >= x1;
}

/**
 * y-ranges of [y0, y1) on which the column band [bx0, bx1) lies entirely inside the union of
 * the work areas (a band may straddle two side-by-side displays; it may not leave the screen).
 */
function workAreaRowsForBand(bx0: number, bx1: number, y0: number, y1: number, displays: readonly DisplayGeometry[]): Span[] {
  if (!(y1 > y0) || !(bx1 > bx0)) return [];
  const areas = displays.map((d) => d.workAreaPx).filter((wa) => wa.x < bx1 && wa.x + wa.width > bx0 && wa.y < y1 && wa.y + wa.height > y0);
  if (areas.length === 0) return [];
  // Elementary rows between the work areas' top/bottom edges: coverage is constant on each.
  const cuts = new Set<number>([y0, y1]);
  for (const wa of areas) {
    if (wa.y > y0 && wa.y < y1) cuts.add(wa.y);
    const bottom = wa.y + wa.height;
    if (bottom > y0 && bottom < y1) cuts.add(bottom);
  }
  const ys = [...cuts].sort((a, b) => a - b);
  const out: Array<[number, number]> = [];
  for (let i = 0; i + 1 < ys.length; i++) {
    const a = ys[i]!;
    const b = ys[i + 1]!;
    const xs: Span[] = areas.filter((wa) => wa.y <= a && wa.y + wa.height >= b).map((wa) => [wa.x, wa.x + wa.width] as const);
    if (!coversRange(xs, bx0, bx1)) continue;
    const prev = out[out.length - 1];
    if (prev && prev[1] === a) prev[1] = b;
    else out.push([a, b]);
  }
  return out;
}

const spanLength = (s: Span): number => s[1] - s[0];

/** Distance from v to the span (0 inside). */
const spanDistance = (s: Span, v: number): number => (v < s[0] ? s[0] - v : v > s[1] ? v - s[1] : 0);

/**
 * Chooses one span: the one containing `prefer` (within `tolerance`), else the longest.
 * With `strict`, a preference that no span contains yields null (the attachment is covered).
 */
export function pickSpan(spans: readonly Span[], prefer: number | null, tolerance: number, strict = false): Span | null {
  if (spans.length === 0) return null;
  if (prefer !== null) {
    let best: Span | null = null;
    let bestDist = Infinity;
    for (const s of spans) {
      const dist = spanDistance(s, prefer);
      if (dist < bestDist) {
        best = s;
        bestDist = dist;
      }
    }
    if (best && bestDist <= tolerance) return best;
    if (strict) return null;
  }
  let longest: Span | null = null;
  for (const s of spans) if (!longest || spanLength(s) > spanLength(longest)) longest = s;
  return longest;
}

/** Metadata shared by every surface of one window build. */
export interface SurfaceMeta {
  phase: SurfacePhase;
  confidence: number;
  validatedAt: number;
  excluded: boolean;
  /** Velocity of the frame's left/top edges and of its right edge (px/s). */
  vx: number;
  vy: number;
  vxRight: number;
}

/** Open (unoccluded, on-screen) parts of a window's top edge and side edges. */
export interface WindowOpenSpans {
  /** Corner inset used (px). */
  inset: number;
  /** x-spans of the top edge (rect.y), each at least minLedgeWidthPx wide. */
  top: Span[];
  /** y-spans of the left / right edge, each at least the minimum wall height; empty when climbing is off. */
  left: Span[];
  right: Span[];
}

/**
 * Computes the open spans of one window's edges. `above` holds every rect above the window
 * in z-order (owned dialogs, tool windows, our Settings window, the taskbar...).
 */
export function computeOpenSpans(rect: Rect, above: readonly Rect[], displays: readonly DisplayGeometry[], opts: WindowSurfaceOptions): WindowOpenSpans {
  const scale = scaleForRect(displays, rect);
  const inset = cornerInsetPx(opts, scale);
  const right = rect.x + rect.width;
  const bottom = rect.y + rect.height;

  // Top ledge: the frame's top row minus the rounded corners, cut by windows above, kept to
  // the work areas where the cat's feet (the row just above the edge) can be drawn.
  const rowSpans = openRowSpans(rect.y, rect.x + inset, right - inset, above);
  const top = clipToWorkAreasOnRow(rowSpans, rect.y - 1, displays).filter((s) => spanLength(s) >= opts.minLedgeWidthPx);

  if (!opts.climbWindows) return { inset, top, left: [], right: [] };
  const clearance = Math.max(1, Math.round(opts.wallClearanceDip * scale));
  const minWall = Math.max(1, Math.round(opts.minWallHeightDip * scale));
  const y0 = rect.y + inset;
  const y1 = bottom - inset;
  const wall = (bandX0: number, bandX1: number, beside0: number, beside1: number): Span[] => {
    // The space beside the edge must be on screen (not against the screen edge) ...
    const rows = workAreaRowsForBand(beside0, beside1, y0, y1, displays);
    const out: Span[] = [];
    for (const [a, b] of rows) {
      // ... and not covered by anything above the window, nor the edge line itself.
      for (const s of openColumnSpans(bandX0, bandX1, a, b, above)) if (spanLength(s) >= minWall) out.push(s);
    }
    return out;
  };
  return {
    inset,
    top,
    left: wall(rect.x - clearance, rect.x + 1, rect.x - clearance, rect.x),
    right: wall(right - 1, right + clearance, right, right + clearance),
  };
}

/** Where a tab-strip ledge sits on its window right now (already shifted to the current frame). */
export interface StripPlacement {
  source: LedgeSurface;
  y: number;
  x0: number;
  x1: number;
  rest: { x0: number; x1: number } | null;
  focusX: number | null;
  confidence: number;
}

/** Which surface of this window the cat is attached to, and where (px). */
export interface Attachment {
  surfaceId: string;
  x: number;
  y: number;
}

export interface BuiltWindowSurfaces {
  /** The plain window-top ledge (also when a tab strip replaces it in listings). */
  windowTop: LedgeSurface | null;
  /** The tab-strip ledge replacing the window top, when the window has one. */
  strip: LedgeSurface | null;
  left: WallSurface | null;
  right: WallSurface | null;
}

export const EMPTY_WINDOW_SURFACES: BuiltWindowSurfaces = Object.freeze({ windowTop: null, strip: null, left: null, right: null });

/** Tolerance when matching the cat's attachment point against spans (px). */
export const ATTACH_TOLERANCE_PX = 12;
/** Narrowest resting span worth reporting inside a tab strip (px). */
const MIN_REST_PX = 8;

function displayIdAt(displays: readonly DisplayGeometry[], x: number, y: number): string | null {
  for (const d of displays) {
    const wa = d.workAreaPx;
    if (x >= wa.x && x < wa.x + wa.width && y >= wa.y && y < wa.y + wa.height) return d.id;
  }
  return null;
}

/**
 * Builds the surfaces of one window from its open spans. `attach` (when the cat is on one
 * of these surfaces) selects the span the cat is on; otherwise the widest/longest wins.
 * `strict` drops a surface whose attachment point is no longer open (covered).
 */
export function buildWindowSurfaces(
  hwnd: string,
  rect: Rect,
  spans: WindowOpenSpans,
  displays: readonly DisplayGeometry[],
  meta: SurfaceMeta,
  strip: StripPlacement | null,
  attach: Attachment | null,
  strict = false,
): BuiltWindowSurfaces {
  const base = { ownerId: hwnd, phase: meta.phase, confidence: meta.confidence, validatedAt: meta.validatedAt, excluded: meta.excluded };
  const topId = ledgeId(hwnd);
  const sId = stripId(hwnd);
  const attachedTop = attach && (attach.surfaceId === topId || attach.surfaceId === sId) ? attach.x : null;

  let windowTop: LedgeSurface | null = null;
  const topSpan = pickSpan(spans.top, attachedTop, ATTACH_TOLERANCE_PX, strict && attachedTop !== null);
  if (topSpan) {
    windowTop = {
      ...base,
      id: topId,
      kind: 'windowTop',
      orientation: 'ledge',
      displayId: displayIdAt(displays, (topSpan[0] + topSpan[1]) / 2, rect.y - 1),
      vx: meta.vx,
      vy: meta.vy,
      y: rect.y,
      x0: topSpan[0],
      x1: topSpan[1],
      rest: null,
      focusX: null,
    };
  }

  let stripLedge: LedgeSurface | null = null;
  if (strip) {
    // Safe span: the strip's walkable part intersected with the open top edge.
    const cut: Span[] = [];
    for (const [a, b] of spans.top) {
      const x0 = Math.max(a, strip.x0);
      const x1 = Math.min(b, strip.x1);
      if (x1 > x0) cut.push([x0, x1]);
    }
    const chosen = pickSpan(cut, attachedTop, ATTACH_TOLERANCE_PX, strict && attachedTop !== null);
    if (chosen) {
      let rest: { x0: number; x1: number } | null = null;
      if (strip.rest) {
        const r0 = Math.max(chosen[0], strip.rest.x0);
        const r1 = Math.min(chosen[1], strip.rest.x1);
        if (r1 - r0 >= MIN_REST_PX) rest = { x0: r0, x1: r1 };
      }
      stripLedge = {
        ...base,
        id: sId,
        kind: 'tabStrip',
        orientation: 'ledge',
        displayId: displayIdAt(displays, (chosen[0] + chosen[1]) / 2, strip.y - 1),
        phase: meta.phase === 'stable' ? strip.source.phase : meta.phase,
        confidence: Math.min(meta.confidence, strip.confidence),
        vx: meta.vx,
        vy: meta.vy,
        y: strip.y,
        x0: chosen[0],
        x1: chosen[1],
        rest,
        focusX: strip.focusX !== null && strip.focusX >= chosen[0] && strip.focusX <= chosen[1] ? strip.focusX : null,
      };
    }
  }

  // The ledge a wall pulls up to: whichever top surface is listed for this window.
  const listedTop = stripLedge ?? (strip ? null : windowTop);
  const right = rect.x + rect.width;
  const cornerTop = rect.y + spans.inset;
  const wall = (side: 'left' | 'right', sideSpans: readonly Span[]): WallSurface | null => {
    const id = wallId(hwnd, side);
    const prefer = attach && attach.surfaceId === id ? attach.y : null;
    // Unattached walls prefer the span that starts at the top corner (pull-up possible).
    const atCorner = prefer === null ? sideSpans.find((s) => s[0] <= cornerTop + CORNER_REACH_PX) ?? null : null;
    const chosen = atCorner ?? pickSpan(sideSpans, prefer, ATTACH_TOLERANCE_PX * 2, strict && prefer !== null);
    if (!chosen) return null;
    const x = side === 'left' ? rect.x : right;
    const reachesCorner = chosen[0] <= cornerTop + CORNER_REACH_PX;
    const ledgeReaches =
      listedTop !== null && (side === 'left' ? listedTop.x0 <= rect.x + spans.inset + CORNER_REACH_PX : listedTop.x1 >= right - spans.inset - CORNER_REACH_PX);
    return {
      ...base,
      id,
      kind: 'windowSide',
      orientation: 'wall',
      displayId: displayIdAt(displays, side === 'left' ? x - 1 : x, (chosen[0] + chosen[1]) / 2),
      vx: side === 'left' ? meta.vx : meta.vxRight,
      vy: meta.vy,
      x,
      y0: chosen[0],
      y1: chosen[1],
      side,
      topLedgeId: reachesCorner && ledgeReaches && listedTop ? listedTop.id : null,
    };
  };

  return { windowTop, strip: stripLedge, left: wall('left', spans.left), right: wall('right', spans.right) };
}
