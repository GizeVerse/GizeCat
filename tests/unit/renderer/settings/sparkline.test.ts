import { describe, expect, it } from 'vitest';
import { niceCeil, sparkline } from '../../../../src/renderer/settings/sparkline';

describe('niceCeil', () => {
  it('rounds up to 1, 2 or 5 times a power of ten', () => {
    expect(niceCeil(0.7, 5)).toBe(5);
    expect(niceCeil(5.2, 5)).toBe(10);
    expect(niceCeil(13)).toBe(20);
    expect(niceCeil(20)).toBe(20);
    expect(niceCeil(211, 100)).toBe(500);
    expect(niceCeil(0.03, 0.01)).toBe(0.05);
    expect(niceCeil(Number.NaN, 5)).toBe(5);
  });
});

describe('sparkline', () => {
  it('returns empty paths for no data', () => {
    expect(sparkline([], 100, 20)).toMatchObject({ line: '', area: '', points: [] });
  });

  it('maps values into the box with y growing downwards', () => {
    const g = sparkline([0, 5, 10], 100, 24, { min: 0, max: 10 }, 2);
    expect(g.points).toEqual([
      { x: 0, y: 22 },
      { x: 50, y: 12 },
      { x: 100, y: 2 },
    ]);
    expect(g.line).toBe('M0 22 L50 12 L100 2');
    expect(g.area).toBe('M0 22 L50 12 L100 2 L100 24 L0 24 Z');
  });

  it('draws a single sample as a flat line across the box', () => {
    const g = sparkline([3], 80, 20, { min: 0, max: 6 }, 0);
    expect(g.points).toEqual([
      { x: 0, y: 10 },
      { x: 80, y: 10 },
    ]);
  });

  it('centres a flat series when no scale is given and clamps out-of-range values', () => {
    const flat = sparkline([4, 4, 4], 10, 10, {}, 0);
    expect(flat.points.every((p) => p.y === 5)).toBe(true);
    const clamped = sparkline([-5, 50], 10, 10, { min: 0, max: 10 }, 0);
    expect(clamped.points.map((p) => p.y)).toEqual([10, 0]);
    const nan = sparkline([Number.NaN, 1], 10, 10, { min: 0, max: 1 }, 0);
    expect(nan.points[0]!.y).toBe(10);
  });
});
