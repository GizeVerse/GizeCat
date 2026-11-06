// World coordinates off Windows (ADR 0004 §4): the logical world must be consistent and
// overlap-free whatever the displays' scales, and Windows keeps its own strategy.
import { describe, expect, it } from 'vitest';
import { coordinateStrategyFor, logicalPoint, logicalRawDisplays, logicalRect, type DipDisplay } from '../../../../src/core/display/coordinates';
import { displayAtPoint, localDipToPx, pxToLocalDip } from '../../../../src/core/display/displayMath';
import { normalizeDisplays } from '../../../../src/core/display/topology';
import { rectIntersection } from '../../../../src/shared/geometry';
import { PLATFORM_IDS } from '../../../../src/shared/platform';

// A Retina laptop (points 1512×982 at 2×) with an external 1× monitor to its right: the classic
// mixed-scale layout where "DIP × own scale" would overlap the two displays.
const retina: DipDisplay = { id: 1, primary: true, scaleFactor: 2, boundsDip: { x: 0, y: 0, width: 1512, height: 982 }, workAreaDip: { x: 0, y: 38, width: 1512, height: 944 } };
const external: DipDisplay = { id: 2, primary: false, scaleFactor: 1, boundsDip: { x: 1512, y: 0, width: 1920, height: 1080 }, workAreaDip: { x: 1512, y: 25, width: 1920, height: 1055 } };

describe('coordinate strategy per platform', () => {
  it('Windows keeps physical pixels; every other platform is logical', () => {
    for (const p of PLATFORM_IDS) expect(coordinateStrategyFor(p)).toBe(p === 'win32' ? 'win32-physical' : 'logical');
  });
});

describe('logical world', () => {
  const world = normalizeDisplays(logicalRawDisplays([retina, external]));

  it('keeps every display (none rejected by the topology checks)', () => {
    expect(world.map((d) => d.id)).toEqual(['1', '2']);
  });

  it('uses DIP as world px with world scale 1, so mixed scales never overlap', () => {
    for (const d of world) {
      expect(d.scaleFactor).toBe(1);
      expect(d.boundsPx).toEqual(d.boundsDip);
      expect(d.workAreaPx).toEqual(d.workAreaDip);
    }
    expect(rectIntersection(world[0]!.boundsPx, world[1]!.boundsPx)).toBeNull();
  });

  it('a cursor point lands on the display it is over', () => {
    expect(displayAtPoint(world, logicalPoint({ x: 100, y: 500 }))?.id).toBe('1');
    expect(displayAtPoint(world, logicalPoint({ x: 1600, y: 500 }))?.id).toBe('2');
  });

  it('world px ↔ overlay-local DIP is an offset only (the renderer scales by devicePixelRatio itself)', () => {
    const ext = world[1]!;
    const p = { x: 2000, y: 600 };
    const local = pxToLocalDip(ext, p);
    expect(local).toEqual({ x: 2000 - 1512, y: 600 - 25 });
    expect(localDipToPx(ext, local)).toEqual(p);
  });

  it('rects map to themselves and are copies', () => {
    const r = { x: 1, y: 2, width: 3, height: 4 };
    const out = logicalRect(r);
    expect(out).toEqual(r);
    expect(out).not.toBe(r);
  });
});
