// Pure computations over a z-ordered window list (top first).
import { displayForRect } from '../../core/display/displayMath';
import { rectArea, rectIntersection } from '../../shared/geometry';
import type { Rect } from '../../shared/geometry';
import type { DisplayGeometry, Platform, WindowInfo } from '../../shared/world';
import type { NotificationState } from './windowRules';

export const MIN_PLATFORM_WIDTH = 80;

type Span = readonly [number, number];

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
 * Visible top edges of app windows. A window's edge is cut wherever a window above it
 * in z-order covers the edge row. Minimized windows are ignored entirely; maximized and
 * fullscreen windows produce no platform but still occlude the windows below them.
 */
export function computePlatforms(windows: readonly WindowInfo[], minWidth = MIN_PLATFORM_WIDTH): Platform[] {
  const out: Platform[] = [];
  const above: Rect[] = [];
  for (const w of windows) {
    if (w.minimized) continue;
    const r = w.rect;
    if (!(r.width > 0 && r.height > 0)) continue;
    if (!w.maximized && !w.fullscreen) {
      const y = r.y;
      let spans: Span[] = [[r.x, r.x + r.width]];
      for (const a of above) {
        if (y < a.y || y >= a.y + a.height) continue;
        spans = subtractSpan(spans, a.x, a.x + a.width);
        if (spans.length === 0) break;
      }
      for (const [x0, x1] of spans) if (x1 - x0 >= minWidth) out.push({ windowId: w.id, y, x0, x1 });
    }
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
