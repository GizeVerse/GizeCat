// Which part of which display to capture, and how physical-px rects map into
// the (downscaled) captured frame.
import { inflateRect, rectCenter, rectContains, rectIntersection, type Point, type Rect } from '../../shared/geometry';
import type { WindowInfo } from '../../shared/world';

export type RegionPolicy = 'around-cat' | 'active-window' | 'display';

export interface CaptureDisplay {
  /** Electron display id as a string (matches DesktopCapturerSource.display_id). */
  id: string;
  /** Physical virtual-screen px. */
  boundsPx: Rect;
  scaleFactor: number;
  primary: boolean;
}

/** Size of the "around the cat" region in DIP. */
export const AROUND_CAT_DIP = Object.freeze({ width: 640, height: 400 });
/** Smallest active-window region worth analysing, px. */
const MIN_WINDOW_REGION_PX = 64;

export function displayContaining(displays: readonly CaptureDisplay[], p: Point): CaptureDisplay | null {
  return displays.find((d) => rectContains(d.boundsPx, p)) ?? null;
}

function nearestDisplay(displays: readonly CaptureDisplay[], p: Point): CaptureDisplay | null {
  let best: CaptureDisplay | null = null;
  let bestD = Infinity;
  for (const d of displays) {
    const b = d.boundsPx;
    const dx = Math.max(b.x - p.x, 0, p.x - (b.x + b.width));
    const dy = Math.max(b.y - p.y, 0, p.y - (b.y + b.height));
    const dist = dx * dx + dy * dy;
    if (dist < bestD) {
      bestD = dist;
      best = d;
    }
  }
  return best;
}

export interface RegionInput {
  policy: RegionPolicy;
  displays: readonly CaptureDisplay[];
  /** Point of interest (px), e.g. where the cat looks. */
  focus: Point | null;
  catBounds: Rect | null;
  catDisplayId: string | null;
  foreground: WindowInfo | null;
}

export interface RegionChoice {
  display: CaptureDisplay;
  regionPx: Rect;
  policy: RegionPolicy;
}

const roundRect = (r: Rect): Rect => {
  const x = Math.round(r.x);
  const y = Math.round(r.y);
  return { x, y, width: Math.max(0, Math.round(r.x + r.width) - x), height: Math.max(0, Math.round(r.y + r.height) - y) };
};

function aroundPoint(display: CaptureDisplay, centre: Point): Rect {
  const b = display.boundsPx;
  const sf = display.scaleFactor > 0 ? display.scaleFactor : 1;
  const w = Math.min(b.width, AROUND_CAT_DIP.width * sf);
  const h = Math.min(b.height, AROUND_CAT_DIP.height * sf);
  const x = Math.min(Math.max(centre.x - w / 2, b.x), b.x + b.width - w);
  const y = Math.min(Math.max(centre.y - h / 2, b.y), b.y + b.height - h);
  return roundRect({ x, y, width: w, height: h });
}

/** Picks the display (containing the focus, else the cat's, else primary) and the region on it. */
export function chooseRegion(input: RegionInput): RegionChoice | null {
  const { displays } = input;
  if (displays.length === 0) return null;
  const catCentre = input.catBounds ? rectCenter(input.catBounds) : null;
  const interest = input.focus ?? catCentre;
  const fallback =
    (input.catDisplayId ? displays.find((d) => d.id === input.catDisplayId) : undefined) ?? displays.find((d) => d.primary) ?? displays[0]!;
  const focusDisplay = (interest && (displayContaining(displays, interest) ?? nearestDisplay(displays, interest))) || fallback;

  if (input.policy === 'display') return { display: focusDisplay, regionPx: roundRect(focusDisplay.boundsPx), policy: 'display' };

  if (input.policy === 'active-window') {
    const fg = input.foreground;
    if (fg && !fg.minimized) {
      const centre = rectCenter(fg.rect);
      const d = displayContaining(displays, centre) ?? nearestDisplay(displays, centre);
      const clipped = d ? rectIntersection(fg.rect, d.boundsPx) : null;
      if (d && clipped && clipped.width >= MIN_WINDOW_REGION_PX && clipped.height >= MIN_WINDOW_REGION_PX) {
        return { display: d, regionPx: roundRect(clipped), policy: 'active-window' };
      }
    }
  }

  const centre = interest && rectContains(focusDisplay.boundsPx, interest) ? interest : rectCenter(focusDisplay.boundsPx);
  return { display: focusDisplay, regionPx: aroundPoint(focusDisplay, centre), policy: 'around-cat' };
}

/**
 * Keeps an around-cat region stable while the point of interest stays in its
 * inner area, so consecutive frames show the same screen area and can be diffed.
 */
export function stickyRegion(prev: RegionChoice | null, next: RegionChoice, interest: Point | null): RegionChoice {
  if (!prev || prev.policy !== 'around-cat' || next.policy !== 'around-cat' || prev.display.id !== next.display.id || !interest) return next;
  if (prev.regionPx.width !== next.regionPx.width || prev.regionPx.height !== next.regionPx.height) return next;
  const inner = inflateRect(prev.regionPx, -Math.min(prev.regionPx.width, prev.regionPx.height) * 0.2);
  return inner.width > 0 && inner.height > 0 && rectContains(inner, interest) ? prev : next;
}

export const regionKey = (c: RegionChoice): string =>
  `${c.display.id}:${c.regionPx.x},${c.regionPx.y},${c.regionPx.width}x${c.regionPx.height}`;

/** Maps a px rect into the pixel space of a frame that shows `regionPx` at `frameW x frameH`, inflated by `padPx` frame pixels. */
export function projectRect(rectPx: Rect, regionPx: Rect, frameW: number, frameH: number, padPx = 1): Rect | null {
  if (regionPx.width <= 0 || regionPx.height <= 0) return null;
  const sx = frameW / regionPx.width;
  const sy = frameH / regionPx.height;
  const x0 = Math.max(0, Math.floor((rectPx.x - regionPx.x) * sx) - padPx);
  const y0 = Math.max(0, Math.floor((rectPx.y - regionPx.y) * sy) - padPx);
  const x1 = Math.min(frameW, Math.ceil((rectPx.x + rectPx.width - regionPx.x) * sx) + padPx);
  const y1 = Math.min(frameH, Math.ceil((rectPx.y + rectPx.height - regionPx.y) * sy) + padPx);
  if (x1 <= x0 || y1 <= y0) return null;
  return { x: x0, y: y0, width: x1 - x0, height: y1 - y0 };
}

/** Output size for a region downscaled to at most `maxWidth` px wide (never upscaled). */
export function scaledSize(regionPx: Rect, maxWidth: number): { width: number; height: number } {
  const scale = Math.min(1, maxWidth / Math.max(1, regionPx.width));
  return { width: Math.max(1, Math.round(regionPx.width * scale)), height: Math.max(1, Math.round(regionPx.height * scale)) };
}
