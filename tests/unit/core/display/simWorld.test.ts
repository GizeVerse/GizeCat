import { describe, expect, it } from 'vitest';
import { FLOOR_INSET_DIP, simWorld } from '../../../../src/core/display/simWorld';
import type { WorldGeometry } from '../../../../src/shared/world';

const world: WorldGeometry = {
  version: 3,
  displays: [
    {
      id: 'a',
      primary: true,
      scaleFactor: 1.25,
      boundsDip: { x: 0, y: 0, width: 1536, height: 960 },
      workAreaDip: { x: 0, y: 0, width: 1536, height: 960 },
      boundsPx: { x: 0, y: 0, width: 1920, height: 1200 },
      workAreaPx: { x: 0, y: 0, width: 1920, height: 1200 },
    },
    {
      id: 'b',
      primary: false,
      scaleFactor: 2,
      boundsDip: { x: -1280, y: 0, width: 1280, height: 720 },
      workAreaDip: { x: -1280, y: 0, width: 1280, height: 680 },
      boundsPx: { x: -2560, y: 0, width: 2560, height: 1440 },
      workAreaPx: { x: -2560, y: 0, width: 2560, height: 1360 },
    },
  ],
};

describe('simWorld', () => {
  it('raises each floor by the inset in that display\'s DIP', () => {
    const w = simWorld(world);
    expect(w.version).toBe(3);
    expect(w.displays[0]!.workAreaPx.height).toBe(1200 - Math.round(FLOOR_INSET_DIP * 1.25));
    expect(w.displays[1]!.workAreaPx.height).toBe(1360 - FLOOR_INSET_DIP * 2);
    expect(w.displays[1]!.workAreaDip.height).toBe(680 - FLOOR_INSET_DIP);
    expect(w.displays[0]!.workAreaPx.x).toBe(0);
    expect(w.displays[1]!.boundsPx).toEqual(world.displays[1]!.boundsPx);
  });

  it('does not mutate its input and never produces an empty work area', () => {
    const before = JSON.stringify(world);
    const tiny = simWorld({ version: 1, displays: [{ ...world.displays[0]!, workAreaPx: { x: 0, y: 0, width: 10, height: 2 }, workAreaDip: { x: 0, y: 0, width: 8, height: 1 } }] });
    expect(JSON.stringify(world)).toBe(before);
    expect(tiny.displays[0]!.workAreaPx.height).toBeGreaterThanOrEqual(1);
    expect(tiny.displays[0]!.workAreaDip.height).toBeGreaterThanOrEqual(1);
  });
});
