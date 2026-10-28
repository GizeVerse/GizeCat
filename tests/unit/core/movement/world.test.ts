import { describe, expect, it } from 'vitest';
import { WorldModel } from '../../../../src/core/movement';
import { display, DUAL_FLAT, DUAL_MIXED, SINGLE, world } from '../behavior/fixtures';

describe('WorldModel', () => {
  it('puts a floor at the bottom of each work area, inset by half the cat width', () => {
    const w = new WorldModel(SINGLE, 1, true);
    expect(w.floors).toHaveLength(1);
    const f = w.firstFloor;
    expect(f.y).toBe(1040);
    expect(f.x0).toBe(42);
    expect(f.x1).toBe(1920 - 42);
  });

  it('joins floors of side-by-side displays at the same height only when allowed', () => {
    const joined = new WorldModel(DUAL_FLAT, 1, true);
    expect(joined.floors).toHaveLength(1);
    expect(joined.firstFloor.displayIds).toEqual(['1', '2']);
    expect(joined.firstFloor.x1).toBe(3840 - 42);
    const separate = new WorldModel(DUAL_FLAT, 1, false);
    expect(separate.floors).toHaveLength(2);
  });

  it('keeps floors of different heights separate (mixed DPI, negative coordinates)', () => {
    const w = new WorldModel(DUAL_MIXED, 1, true);
    expect(w.floors).toHaveLength(2);
    const f2 = w.floorFor('2');
    expect(f2?.y).toBe(-180 + 1440);
    // 1.5x scale: half width 63 px.
    expect(f2?.x0).toBe(-2560 + 63);
    expect(f2?.x1).toBe(-63);
    expect(w.scaleAt({ x: -100, y: 0 })).toBe(1.5);
    expect(w.displayAt({ x: -1, y: 1260 })?.id).toBe('2');
    expect(w.displayAt({ x: 0, y: 1100 })).toBeNull();
  });

  it('clamps points into the union of work areas', () => {
    const w = new WorldModel(DUAL_MIXED, 1, true);
    for (const p of [
      { x: 5000, y: 500 },
      { x: -9000, y: -9000 },
      { x: 500, y: 1070 }, // inside the taskbar
      { x: Number.NaN, y: 3 },
    ]) {
      const q = w.clampInside(p);
      expect(w.contains(q, 0.02)).toBe(true);
    }
    expect(w.clampInside({ x: 500, y: 1070 })).toEqual({ x: 500, y: 1040 });
  });

  it('finds the first surface below a point, preferring window tops above the floor', () => {
    const w = new WorldModel(SINGLE, 1, true);
    const windows = w.windowSurfaces([{ windowId: 'a', y: 600, x0: 400, x1: 900 }]);
    expect(windows).toHaveLength(1);
    expect(w.surfaceBelow(500, 300, windows)?.surface.windowId).toBe('a');
    expect(w.surfaceBelow(500, 700, windows)?.surface.kind).toBe('floor');
    expect(w.surfaceBelow(1500, 300, windows)?.y).toBe(1040);
  });

  it('rejects window tops that are too narrow, too close to the top or to the floor', () => {
    const w = new WorldModel(SINGLE, 1, true);
    const s = w.windowSurfaces([
      { windowId: 'narrow', y: 500, x0: 100, x1: 150 },
      { windowId: 'top', y: 10, x0: 100, x1: 900 },
      { windowId: 'floor', y: 1030, x0: 100, x1: 900 },
      { windowId: 'off', y: 500, x0: 4000, x1: 4800 },
      { windowId: 'nan', y: Number.NaN, x0: 100, x1: 900 },
      { windowId: 'ok', y: 500, x0: 100, x1: 900 },
    ]);
    expect(s.map((x) => x.windowId)).toEqual(['ok']);
  });

  it('falls back to a default display for an empty world', () => {
    const w = new WorldModel(world(), 1, true);
    expect(w.usedFallback).toBe(true);
    expect(w.floors).toHaveLength(1);
    const bad = new WorldModel(world(display('x', 0, 0, 0, 0)), 1, true);
    expect(bad.usedFallback).toBe(true);
  });
});
