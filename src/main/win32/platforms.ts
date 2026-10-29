// Pure computations over a z-ordered window list (top first). The span helpers are shared
// with the v1.1 surface provider (src/main/surfaces), which builds ledges and walls on them.
import { displayForRect } from '../../core/display/displayMath';
import { rectArea, rectIntersection } from '../../shared/geometry';
import type { Rect } from '../../shared/geometry';
import type { DisplayGeometry, Platform, WindowInfo } from '../../shared/world';
import type { NotificationState } from './windowRules';

export const MIN_PLATFORM_WIDTH = 80;

/** A half-open interval [start, end). */
export type Span = readonly [number, number];

/** Removes [cut0, cut1) from every span. */
export function subtractSpan(spans: readonly Span[], cut0: number, cut1: number): Span[] {
  const out: Span[] = [];
  for (const [a, b] of spans) {
    if (cut1 <= a || cut0 >= b) {
      out.push([a, b]);
      continue;
    }
    if (cut0 > a) out.push([a, cut0]);
    if (cut1 < b) out.push([cut1, b]);
  }
  return out;
}

/**
 * Parts of the horizontal segment [x0, x1) on row `y` that no rect in `above` covers
 * (a rect covers the row when y is in [rect.y, rect.y + height)).
 */
export function openRowSpans(y: number, x0: number, x1: number, above: Iterable<Rect>): Span[] {
  if (!(x1 > x0)) return [];
  let spans: Span[] = [[x0, x1]];
  for (const a of above) {
    if (y < a.y || y >= a.y + a.height) continue;
    spans = subtractSpan(spans, a.x, a.x + a.width);
    if (spans.length === 0) break;
  }
  return spans;
}

/**
 * Parts of the vertical extent [y0, y1) of a column band [bandX0, bandX1) that no rect in
 * `above` overlaps (a rect cuts its own y-range wherever it overlaps the band horizontally).
 */
export function openColumnSpans(bandX0: number, bandX1: number, y0: number, y1: number, above: Iterable<Rect>): Span[] {
  if (!(y1 > y0) || !(bandX1 > bandX0)) return [];
  let spans: Span[] = [[y0, y1]];
  for (const a of above) {
    if (a.x >= bandX1 || a.x + a.width <= bandX0) continue;
    spans = subtractSpan(spans, a.y, a.y + a.height);
    if (spans.length === 0) break;
  }
  return spans;
}

/** A shown top-level window that hides what is below it (app window or not). */
export interface Occluder {
  id: string;
  rect: Rect;
}

function pushEdge(out: Platform[], id: string, r: Rect, above: readonly Rect[], minWidth: number): void {
  for (const [x0, x1] of openRowSpans(r.y, r.x, r.x + r.width, above)) if (x1 - x0 >= minWidth) out.push({ windowId: id, y: r.y, x0, x1 });
}

/**
 * Visible top edges of app windows. A window's edge is cut wherever a window above it
 * in z-order covers the edge row. Minimized windows are ignored entirely; maximized,
 * fullscreen and privacy-excluded windows (password managers, sign-in or banking
 * windows) produce no platform but still occlude the windows below them.
 *
 * `occluders`, when known, is every shown window in z-order (top first), including
 * owned dialogs, tool windows and small windows that are not app windows: they cut the
 * edges below them too. App windows missing from it are not shown and get no platform.
 */
export function computePlatforms(windows: readonly WindowInfo[], minWidth = MIN_PLATFORM_WIDTH, occluders: readonly Occluder[] | null = null): Platform[] {
  const out: Platform[] = [];
  const above: Rect[] = [];
  const offersEdge = (w: WindowInfo): boolean => !w.minimized && !w.maximized && !w.fullscreen && !w.excluded;
  if (occluders) {
    const apps = new Map(windows.map((w) => [w.id, w]));
    for (const o of occluders) {
      const r = o.rect;
      if (!(r.width > 0 && r.height > 0)) continue;
      const w = apps.get(o.id);
      if (w && offersEdge(w)) pushEdge(out, w.id, r, above, minWidth);
      above.push(r);
    }
    return out;
  }
  for (const w of windows) {
    if (w.minimized) continue;
    const r = w.rect;
    if (!(r.width > 0 && r.height > 0)) continue;
    if (offersEdge(w)) pushEdge(out, w.id, r, above, minWidth);
    above.push(r);
  }
  return out;
}

export interface FullscreenInput {
  displays: readonly DisplayGeometry[];
  /** App windows in z-order, top first. */
  windows: readonly WindowInfo[];
  foreground: WindowInfo | null;
  /** Rect of the foreground window even when it is not an app window (exclusive games). */
  foregroundRect: Rect | null;
  notification: NotificationState;
}

/** Share of a display that windows above a fullscreen one may cover before it no longer counts as "in front". */
const MAX_COVER_ABOVE_FULLSCREEN = 0.5;

/**
 * Displays on which a fullscreen app is in front:
 * - the foreground app window is fullscreen (its display);
 * - QUNS reports D3D-exclusive, presentation or a fullscreen Store app (foreground's display);
 * - walking the z-order on a display, a fullscreen window is reached before windows above
 *   it cover half the display (e.g. a fullscreen video on a second monitor).
 * QUNS_BUSY is deliberately ignored: our own topmost overlay can trigger it.
 */
export function computeFullscreenDisplayIds(input: FullscreenInput): string[] {
  const { displays } = input;
  const ids = new Set<string>();
  const displayIdOf = (r: Rect): string | null => displayForRect(displays, r)?.id ?? null;

  const fg = input.foreground;
  if (fg && fg.fullscreen && !fg.minimized) {
    const id = displayIdOf(fg.rect);
    if (id) ids.add(id);
  }
  if (input.notification === 'd3d-fullscreen' || input.notification === 'presentation' || input.notification === 'fullscreen') {
    const r = fg && !fg.minimized && fg.rect.width > 0 ? fg.rect : input.foregroundRect;
    const id = r ? displayIdOf(r) : null;
    if (id) ids.add(id);
  }

  for (const d of displays) {
    if (ids.has(d.id)) continue;
    const area = rectArea(d.boundsPx);
    if (area <= 0) continue;
    let covered = 0;
    for (const w of input.windows) {
      if (w.minimized) continue;
      const inter = rectIntersection(w.rect, d.boundsPx);
      if (!inter) continue;
      if (w.fullscreen && displayIdOf(w.rect) === d.id) {
        if (covered < area * MAX_COVER_ABOVE_FULLSCREEN) ids.add(d.id);
        break;
      }
      covered += rectArea(inter);
      if (covered >= area * MAX_COVER_ABOVE_FULLSCREEN) break;
    }
  }
  return displays.filter((d) => ids.has(d.id)).map((d) => d.id);
}
