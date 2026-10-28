import { describe, expect, it } from 'vitest';
import type { Rect } from '../../../../src/shared/geometry';
import type { DisplayGeometry } from '../../../../src/shared/world';
import {
  clampPointToRect,
  displayAtPoint,
  displayForRect,
  distanceToRect,
  findDisplay,
  localDipToPx,
  nearestDisplay,
  primaryDisplay,
  pxToLocalDip,
  rectLocalDipToPx,
  rectPxToLocalDip,
  unionBounds,
} from '../../../../src/core/display/displayMath';

const r = (x: number, y: number, width: number, height: number): Rect => ({ x, y, width, height });

/** Builds a display from its physical layout; DIP rects follow Electron's per-display scaling. */
function display(id: string, boundsPx: Rect, scale: number, taskbarPx = 0, primary = false, dipOrigin?: { x: number; y: number }): DisplayGeometry {
  const origin = dipOrigin ?? { x: boundsPx.x / scale, y: boundsPx.y / scale };
  const workAreaPx = r(boundsPx.x, boundsPx.y, boundsPx.width, boundsPx.height - taskbarPx);
  return {
    id,
    primary,
    scaleFactor: scale,
    boundsPx,
    workAreaPx,
    boundsDip: r(origin.x, origin.y, boundsPx.width / scale, boundsPx.height / scale),
    workAreaDip: r(origin.x, origin.y, workAreaPx.width / scale, workAreaPx.height / scale),
  };
}

// The dev machine: 1920x1200 @125% with a 48 px taskbar, plus a 2560x1440 @100% monitor to the
// right, offset upwards (negative y).
const mixed = [display('1', r(0, 0, 1920, 1200), 1.25, 48, true), display('2', r(1920, -240, 2560, 1440), 1, 0, false, { x: 1536, y: -240 })];
// Secondary to the LEFT: negative x origin.
const leftNeg = [display('1', r(0, 0, 2560, 1440), 1.5, 60, true), display('2', r(-1920, 180, 1920, 1080), 1)];
// Vertically stacked: a 4K @150% above the primary 1080p @100%.
const stacked = [display('1', r(0, 0, 1920, 1080), 1, 40, true), display('2', r(-960, -2160, 3840, 2160), 1.5, 0, false, { x: -640, y: -1440 })];

describe('px <-> overlay-local DIP', () => {
  it('maps the work-area origin to local (0,0) and scales by the display factor', () => {
    const [p, s] = mixed as [DisplayGeometry, DisplayGeometry];
    expect(pxToLocalDip(p, { x: 0, y: 0 })).toEqual({ x: 0, y: 0 });
    expect(pxToLocalDip(p, { x: 1250, y: 625 })).toEqual({ x: 1000, y: 500 });
    expect(pxToLocalDip(s, { x: 1920, y: -240 })).toEqual({ x: 0, y: 0 });
    expect(pxToLocalDip(s, { x: 2020, y: 0 })).toEqual({ x: 100, y: 240 });
  });

  it('round-trips points on every layout, including negative origins', () => {
    for (const layout of [mixed, leftNeg, stacked]) {
      for (const d of layout) {
        for (const px of [
          { x: d.workAreaPx.x, y: d.workAreaPx.y },
          { x: d.workAreaPx.x + 123.5, y: d.workAreaPx.y + 77.25 },
          { x: d.workAreaPx.x + d.workAreaPx.width - 1, y: d.workAreaPx.y + d.workAreaPx.height - 1 },
        ]) {
          const back = localDipToPx(d, pxToLocalDip(d, px));
          expect(back.x).toBeCloseTo(px.x, 9);
          expect(back.y).toBeCloseTo(px.y, 9);
        }
      }
    }
  });

  it('maps a point outside the display to coordinates outside the overlay (no clamping)', () => {
    const d = leftNeg[1]!;
    expect(pxToLocalDip(d, { x: 0, y: 180 })).toEqual({ x: 1920, y: 0 });
    expect(pxToLocalDip(d, { x: -2000, y: 100 })).toEqual({ x: -80, y: -80 });
  });

  it('converts rects in both directions', () => {
    const d = stacked[1]!;
    const local = rectPxToLocalDip(d, r(-960 + 300, -2160 + 150, 126, 96));
    expect(local).toEqual({ x: 200, y: 100, width: 84, height: 64 });
    expect(rectLocalDipToPx(d, local)).toEqual(r(-660, -2010, 126, 96));
  });

  it('falls back to scale 1 for a corrupt scale factor', () => {
    const d = { ...mixed[0]!, scaleFactor: 0 };
    expect(pxToLocalDip(d, { x: 10, y: 20 })).toEqual({ x: 10, y: 20 });
    expect(localDipToPx({ ...d, scaleFactor: NaN }, { x: 10, y: 20 })).toEqual({ x: 10, y: 20 });
  });
});

describe('display lookup', () => {
  it('finds displays by id and the primary', () => {
    expect(findDisplay(mixed, '2')?.scaleFactor).toBe(1);
    expect(findDisplay(mixed, 'nope')).toBeNull();
    expect(primaryDisplay(stacked)?.id).toBe('1');
    expect(primaryDisplay([{ ...mixed[1]!, primary: false }])?.id).toBe('2');
    expect(primaryDisplay([])).toBeNull();
  });

  it('uses half-open bounds at shared edges', () => {
    expect(displayAtPoint(mixed, { x: 1919, y: 10 })?.id).toBe('1');
    expect(displayAtPoint(mixed, { x: 1920, y: 10 })?.id).toBe('2');
    expect(displayAtPoint(leftNeg, { x: -1, y: 500 })?.id).toBe('2');
    expect(displayAtPoint(stacked, { x: 100, y: -1 })?.id).toBe('2');
    expect(displayAtPoint(stacked, { x: 100, y: 0 })?.id).toBe('1');
  });

  it('returns null in gaps between displays, and nearest finds the closest', () => {
    // Above the primary but right of the stacked 4K's left part? (x=3000 is beyond its right edge 2880.)
    const gap = { x: 3000, y: -100 };
    expect(displayAtPoint(stacked, gap)).toBeNull();
    expect(nearestDisplay(stacked, gap)?.id).toBe('2');
    // Below the shorter left monitor.
    expect(displayAtPoint(leftNeg, { x: -500, y: 1400 })).toBeNull();
    expect(nearestDisplay(leftNeg, { x: -500, y: 1400 })?.id).toBe('2');
    expect(nearestDisplay(leftNeg, { x: -10, y: 2000 })?.id).toBe('1');
    expect(nearestDisplay([], { x: 0, y: 0 })).toBeNull();
  });

  it('assigns a rect to the display it overlaps most', () => {
    expect(displayForRect(mixed, r(1800, 100, 400, 300))?.id).toBe('2');
    expect(displayForRect(mixed, r(1700, 100, 400, 300))?.id).toBe('1');
    expect(displayForRect(stacked, r(5000, 5000, 10, 10))?.id).toBe('1');
  });

  it('computes union bounds across negative coordinates', () => {
    expect(unionBounds(mixed)).toEqual(r(0, -240, 4480, 1440));
    expect(unionBounds(leftNeg)).toEqual(r(-1920, 0, 4480, 1440));
    expect(unionBounds(stacked)).toEqual(r(-960, -2160, 3840, 3240));
    expect(unionBounds(stacked, 'workAreaPx')).toEqual(r(-960, -2160, 3840, 3200));
    expect(unionBounds([])).toBeNull();
  });
});

describe('small helpers', () => {
  it('distanceToRect is 0 inside and euclidean outside', () => {
    const box = r(0, 0, 10, 10);
    expect(distanceToRect(box, { x: 5, y: 5 })).toBe(0);
    expect(distanceToRect(box, { x: 13, y: 14 })).toBe(5);
    expect(distanceToRect(box, { x: -3, y: 5 })).toBe(3);
  });

  it('clampPointToRect keeps points on the pixel grid inside the rect', () => {
    const box = r(-100, -50, 200, 100);
    expect(clampPointToRect(box, { x: 500, y: -500 })).toEqual({ x: 99, y: -50 });
    expect(clampPointToRect(box, { x: 0, y: 0 }, 10)).toEqual({ x: 0, y: 0 });
    expect(clampPointToRect(box, { x: -1000, y: 1000 }, 10)).toEqual({ x: -90, y: 39 });
  });
});
