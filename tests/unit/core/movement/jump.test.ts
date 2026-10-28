import { describe, expect, it } from 'vitest';
import { ballistic, descendingCrossing, jumpAt, sampleArc, solveJump } from '../../../../src/core/movement';

describe('ballistic jump solver', () => {
  const g = 2600;
  const cases = [
    { from: { x: 100, y: 1000 }, to: { x: 400, y: 700 } }, // up and right
    { from: { x: 900, y: 600 }, to: { x: 700, y: 1000 } }, // down and left
    { from: { x: 0, y: 500 }, to: { x: 0, y: 200 } }, // straight up
    { from: { x: -2000, y: 1200 }, to: { x: -1500, y: 1200 } }, // level, negative coords
  ];

  it.each(cases)('lands exactly on the target %#', ({ from, to }) => {
    const plan = solveJump(from, to, g, 40);
    const end = jumpAt(plan, plan.durationMs);
    expect(end.x).toBeCloseTo(to.x, 6);
    expect(end.y).toBeCloseTo(to.y, 6);
    expect(plan.durationMs).toBeGreaterThan(0);
    // Descending at landing, rising at take-off.
    expect(end.vy).toBeGreaterThan(0);
    expect(plan.vy0).toBeLessThan(0);
    // Apex is above both points by the clearance.
    expect(plan.apexY).toBeCloseTo(Math.min(from.y, to.y) - 40, 6);
    const lowest = Math.min(...sampleArc(plan, 50).map((p) => p.y));
    expect(lowest).toBeGreaterThanOrEqual(plan.apexY - 1e-6);
    expect(lowest).toBeLessThan(Math.min(from.y, to.y));
  });

  it('follows constant gravity', () => {
    const k1 = ballistic(0, 0, 10, -100, g, 0.5);
    expect(k1.y).toBeCloseTo(-100 * 0.5 + 0.5 * g * 0.25, 9);
    expect(k1.vy).toBeCloseTo(-100 + g * 0.5, 9);
    expect(k1.x).toBeCloseTo(5, 9);
  });

  it('finds the descending crossing time', () => {
    const s = descendingCrossing(0, -500, g, 100);
    expect(s).not.toBeNull();
    const k = ballistic(0, 0, 0, -500, g, s as number);
    expect(k.y).toBeCloseTo(100, 6);
    expect(k.vy).toBeGreaterThan(0);
    // Never reaches a point above its apex.
    expect(descendingCrossing(0, -100, g, -1000)).toBeNull();
  });

  it('never produces non-finite values for degenerate input', () => {
    const plan = solveJump({ x: 5, y: 5 }, { x: 5, y: 5 }, 0, 0);
    for (const v of [plan.vx, plan.vy0, plan.durationMs, plan.apexY]) expect(Number.isFinite(v)).toBe(true);
  });
});
