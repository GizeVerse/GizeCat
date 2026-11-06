// World coordinates per platform (ADR 0004 §4). The world is in "world px" and a display's
// scaleFactor is world px per DIP, so any mapping that is consistent across display rects,
// the cursor and overlay-local DIP is correct:
//   win32-physical  Windows: physical virtual-screen pixels (Electron's dipToScreenRect / Point; main only)
//   logical         every other platform: world px = DIP (macOS points), scale 1
// The renderer sizes its canvas from window.devicePixelRatio, so a logical world stays sharp on
// high-DPI screens. An X11 pixel strategy was dropped in review (L3): no consumer needs X11
// pixels yet, and DIP × scale differs from them by rounding at fractional scales.
import type { Point, Rect } from '../../shared/geometry';
import type { PlatformId } from '../../shared/platform';
import type { RawDisplay } from './topology';

export type CoordinateStrategy = 'win32-physical' | 'logical';

/** A display as Electron's screen module reports it (DIP). */
export interface DipDisplay {
  id: string | number;
  primary: boolean;
  scaleFactor: number;
  boundsDip: Rect;
  workAreaDip: Rect;
}

export function coordinateStrategyFor(platform: PlatformId): CoordinateStrategy {
  return platform === 'win32' ? 'win32-physical' : 'logical';
}

const copyRect = (r: Rect): Rect => ({ x: r.x, y: r.y, width: r.width, height: r.height });

/** Electron displays → topology input in the logical world (px = DIP, scale 1). */
export function logicalRawDisplays(displays: readonly DipDisplay[]): RawDisplay[] {
  return displays.map((d) => ({
    id: d.id,
    primary: d.primary,
    scaleFactor: 1,
    boundsDip: copyRect(d.boundsDip),
    workAreaDip: copyRect(d.workAreaDip),
    boundsPx: copyRect(d.boundsDip),
    workAreaPx: copyRect(d.workAreaDip),
  }));
}

/** A screen DIP point → logical world px (the identity, copied). */
export function logicalPoint(p: Point): Point {
  return { x: p.x, y: p.y };
}

/** A screen DIP rect → logical world px (the identity, copied). */
export function logicalRect(r: Rect): Rect {
  return copyRect(r);
}
