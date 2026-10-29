// The behaviour harness behaves like the app (v1.1.1): the sim sees the world shortened by the
// floor inset, and plain windows become surfaces the way the host's provider builds them
// (rounded-corner insets, occlusion by windows in front, tab strips replacing tops).
import { describe, expect, it } from 'vitest';
import { FLOOR_INSET_DIP } from '../../../../src/core/display/simWorld';
import type { LedgeSurface, WallSurface } from '../../../../src/shared/surfaces';
import { display, Harness, providerSurfacesFromWindows, sideId, SINGLE, stripId, surfacesFromWindows, topId, world } from './fixtures';

const byId = (list: ReturnType<typeof providerSurfacesFromWindows>, id: string) => list.find((s) => s.id === id);

describe('behaviour harness (v1.1.1)', () => {
  it('stands the cat on the floor the app gives the sim: the work-area bottom less FLOOR_INSET_DIP (opt out for the raw world)', () => {
    const h = new Harness({ seed: 1 });
    expect(h.floorY()).toBe(1040 - FLOOR_INSET_DIP);
    expect(h.step().y).toBe(1040 - FLOOR_INSET_DIP);
    const hi = new Harness({ seed: 1, world: world(display('1', 0, 0, 1920, 1200, { primary: true, scale: 1.25 })) });
    expect(hi.step().y).toBe(1200 - Math.round(FLOOR_INSET_DIP * 1.25));
    const raw = new Harness({ seed: 1, floorInset: false });
    expect(raw.step().y).toBe(1040);
    // The overlays' world is still the real one.
    expect(h.world).toBe(SINGLE);
  });

  it('builds window surfaces like the provider: corner insets, a window in front cutting the one behind, room beside the sides', () => {
    const list = providerSurfacesFromWindows({ front: { x: 900, y: 500, width: 400, height: 300 }, back: { x: 600, y: 600, width: 800, height: 440 }, edge: { x: 0, y: 300, width: 400, height: 500 } }, SINGLE);
    const front = byId(list, topId('front')) as LedgeSurface;
    expect([front.x0, front.x1, front.y]).toEqual([908, 1292, 500]);
    // The back window's top is cut where the front window covers it (the longer open part is listed),
    // so its right side, though open, has no top to pull up onto at its corner.
    const back = byId(list, topId('back')) as LedgeSurface;
    expect([back.x0, back.x1]).toEqual([608, 900]);
    const right = byId(list, sideId('back', 'right')) as WallSurface;
    expect([right.y0, right.topLedgeId]).toEqual([608, null]);
    const left = byId(list, sideId('back', 'left')) as WallSurface;
    expect([left.y0, left.y1, left.topLedgeId]).toEqual([608, 1032, topId('back')]);
    // A window against the screen's left edge has no room beside its left side.
    expect(byId(list, sideId('edge', 'left'))).toBeUndefined();
    expect(byId(list, sideId('edge', 'right'))).toBeDefined();
    // The v1.1 fixture (bare edges) stays available for exact-edge tests.
    const bare = surfacesFromWindows({ back: { x: 600, y: 600, width: 800, height: 440 } }, SINGLE) as Array<LedgeSurface | WallSurface>;
    expect((bare.find((s) => s.id === topId('back')) as LedgeSurface).x0).toBe(600);
  });

  it('a maximized window offers nothing and covers the windows behind it; a measured tab strip replaces its window top', () => {
    expect(providerSurfacesFromWindows({ max: { x: 0, y: 0, width: 1920, height: 1040 }, w: { x: 300, y: 120, width: 1000, height: 840 } }, SINGLE)).toEqual([]);
    const list = providerSurfacesFromWindows({ b: { x: 300, y: 120, width: 1000, height: 840 } }, SINGLE, { tabStrips: { b: { x0: 400, x1: 1110, rest: { x0: 420, x1: 1000 }, focusX: 640 } } });
    expect(byId(list, topId('b'))).toBeUndefined();
    const strip = byId(list, stripId('b')) as LedgeSurface;
    expect([strip.kind, strip.x0, strip.x1, strip.y]).toEqual(['tabStrip', 400, 1110, 120]);
    expect(strip.land).toEqual({ x0: 308, x1: 1292 });
    expect((byId(list, sideId('b', 'left')) as WallSurface).topLedgeId).toBe(stripId('b'));
  });
});
