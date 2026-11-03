// v1.2 computeEdgeBands (ADR 0003 §6.1): which outer screen edges get a cling band and where it is
// clear of windows. Pure, SIMULATED layouts (the user's machine is one 1920x1200 display at 125 %).
import { describe, expect, it } from 'vitest';
import type { Rect } from '../../../src/shared/geometry';
import { MAX_EDGE_SPANS } from '../../../src/shared/surfaces';
import type { DisplayGeometry, WorldGeometry } from '../../../src/shared/world';
import { bandXRange, computeEdgeBands, edgeBandStats, hasNeighbour } from '../../../src/main/surfaces/edgeBands';

const R = (x: number, y: number, width: number, height: number): Rect => ({ x, y, width, height });

function display(id: string, bounds: Rect, scale = 1, work: Rect = bounds): DisplayGeometry {
  return {
    id,
    primary: id === 'P',
    scaleFactor: scale,
    boundsDip: R(bounds.x / scale, bounds.y / scale, bounds.width / scale, bounds.height / scale),
    workAreaDip: R(work.x / scale, work.y / scale, work.width / scale, work.height / scale),
    boundsPx: bounds,
    workAreaPx: work,
  };
}
const world = (...displays: DisplayGeometry[]): WorldGeometry => ({ version: 1, displays });
const FP = 160;
const fp = (): number => FP;
const sides = (bands: ReturnType<typeof computeEdgeBands>): string[] => bands.map((b) => `${b.displayId}:${b.side}`).sort();

describe('computeEdgeBands: outer edges only', () => {
  it("the user's single display gets both side bands, clear top to bottom on an empty desktop", () => {
    const w = world(display('P', R(0, 0, 1920, 1200), 1.25));
    const bands = computeEdgeBands(w, [], fp);
    expect(sides(bands)).toEqual(['P:left', 'P:right']);
    for (const b of bands) expect(b.clearSpans).toEqual([{ y0: 0, y1: 1200 }]);
  });

  it('never a band between two monitors side by side (also with negative origins)', () => {
    const w = world(display('L', R(-1920, 0, 1920, 1080)), display('P', R(0, 0, 2560, 1440), 1.5));
    expect(sides(computeEdgeBands(w, [], fp))).toEqual(['L:left', 'P:right']);
  });

  it('a diagonal corner-only contact is no neighbour; a 2 px overlap is none either, 3 px is', () => {
    const corner = world(display('P', R(0, 0, 1920, 1080)), display('D', R(1920, 1080, 1920, 1080)));
    expect(sides(computeEdgeBands(corner, [], fp))).toEqual(['D:left', 'D:right', 'P:left', 'P:right']);
    const two = world(display('P', R(0, 0, 1920, 1080)), display('D', R(1920, 1078, 1920, 1080)));
    expect(hasNeighbour(two.displays[0]!, 'right', two.displays)).toBe(false);
    const three = world(display('P', R(0, 0, 1920, 1080)), display('D', R(1920, 1077, 1920, 1080)));
    expect(hasNeighbour(three.displays[0]!, 'right', three.displays)).toBe(true);
  });

  it('a seam a pixel or two off at mixed 100/150 % still joins (tolerance at the larger scale)', () => {
    const w = world(display('P', R(0, 0, 1920, 1080), 1), display('H', R(1922, 0, 2560, 1440), 1.5));
    expect(sides(computeEdgeBands(w, [], fp))).toEqual(['H:right', 'P:left']);
    // 4 px apart at 1.5 (tolerance 3 px): not joined.
    const gap = world(display('P', R(0, 0, 1920, 1080), 1), display('H', R(1924, 0, 2560, 1440), 1.5));
    expect(sides(computeEdgeBands(gap, [], fp))).toEqual(['H:left', 'H:right', 'P:left', 'P:right']);
  });

  it('a side with a docked taskbar (work area inset) has no band', () => {
    const w = world(display('P', R(0, 0, 1920, 1080), 1, R(48, 0, 1872, 1080)));
    expect(sides(computeEdgeBands(w, [], fp))).toEqual(['P:right']);
  });

  it('a stacked monitor above does not remove the side bands', () => {
    const w = world(display('P', R(0, 0, 1920, 1080)), display('T', R(0, -1080, 1920, 1080)));
    expect(sides(computeEdgeBands(w, [], fp))).toEqual(['P:left', 'P:right', 'T:left', 'T:right']);
  });
});

describe('computeEdgeBands: clear spans', () => {
  const single = world(display('P', R(0, 0, 1920, 1200), 1.25));

  it('a maximized window covers both bands completely', () => {
    const bands = computeEdgeBands(single, [R(-8, -8, 1936, 1216)], fp);
    for (const b of bands) expect(b.clearSpans).toEqual([]);
    expect(edgeBandStats(single, bands)).toEqual({ bands: 2, clearSpans: 0, coveredSpans: 2 });
  });

  it('a window reaching into the band by one pixel covers its height there; one just outside does not', () => {
    const touching = R(FP - 1, 300, 600, 400);
    const outside = R(FP, 300, 600, 400);
    const left = (obs: Rect[]) => computeEdgeBands(single, obs, fp).find((b) => b.side === 'left')!;
    expect(left([touching]).clearSpans).toEqual([
      { y0: 0, y1: 300 },
      { y0: 700, y1: 1200 },
    ]);
    expect(left([outside]).clearSpans).toEqual([{ y0: 0, y1: 1200 }]);
  });

  it('overlapping obstacles merge; spans come top to bottom; order of obstacles does not matter', () => {
    const obs = [R(0, 900, 100, 100), R(0, 100, 100, 200), R(50, 250, 100, 100)];
    const a = computeEdgeBands(single, obs, fp).find((b) => b.side === 'left')!;
    const b = computeEdgeBands(single, [...obs].reverse(), fp).find((x) => x.side === 'left')!;
    expect(a.clearSpans).toEqual([
      { y0: 0, y1: 100 },
      { y0: 350, y1: 900 },
      { y0: 1000, y1: 1200 },
    ]);
    expect(b).toEqual(a);
    expect(edgeBandStats(single, [a]).coveredSpans).toBe(2);
  });

  it('keeps at most MAX_EDGE_SPANS spans (the tallest), still top to bottom', () => {
    const obs: Rect[] = [];
    for (let i = 0; i < 12; i++) obs.push(R(0, 50 + i * 95, 50, 10 + i));
    const left = computeEdgeBands(single, obs, fp).find((b) => b.side === 'left')!;
    expect(left.clearSpans).toHaveLength(MAX_EDGE_SPANS);
    for (let i = 1; i < left.clearSpans.length; i++) expect(left.clearSpans[i]!.y0).toBeGreaterThan(left.clearSpans[i - 1]!.y0);
  });

  it('the band is as wide as the footprint, inside the work area', () => {
    expect(bandXRange(R(0, 0, 1920, 1200), 'left', 160)).toEqual({ x0: 0, x1: 160 });
    expect(bandXRange(R(0, 0, 1920, 1200), 'right', 160)).toEqual({ x0: 1760, x1: 1920 });
    // A larger cat: a wider band, so a window 170 px from the edge now covers it.
    const left = (f: number) => computeEdgeBands(single, [R(170, 0, 400, 400)], () => f).find((b) => b.side === 'left')!;
    expect(left(160).clearSpans).toEqual([{ y0: 0, y1: 1200 }]);
    expect(left(200).clearSpans).toEqual([{ y0: 400, y1: 1200 }]);
  });

  it('ignores non-finite obstacles and displays without a usable footprint', () => {
    expect(computeEdgeBands(single, [R(Number.NaN, 0, 100, 100)], fp).every((b) => b.clearSpans.length === 1)).toBe(true);
    expect(computeEdgeBands(single, [], () => Number.NaN)).toEqual([]);
  });
});
