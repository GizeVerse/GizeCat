import { describe, expect, it } from 'vitest';
import { seededRandom } from '../../../src/renderer/overlay/cat/math';
import { createPose } from '../../../src/renderer/overlay/cat/pose';
import { TAIL_SEG_LEN, TailChain } from '../../../src/renderer/overlay/cat/tail';

function assertSane(tail: TailChain, label: string): void {
  for (let i = 0; i < tail.count; i++) {
    expect(Number.isFinite(tail.x[i]!), `${label} x${i}`).toBe(true);
    expect(Number.isFinite(tail.y[i]!), `${label} y${i}`).toBe(true);
  }
  for (let i = 1; i < tail.count; i++) {
    const d = Math.hypot(tail.x[i]! - tail.x[i - 1]!, tail.y[i]! - tail.y[i - 1]!);
    expect(d, `${label} segment ${i}`).toBeGreaterThan(TAIL_SEG_LEN * 0.95);
    expect(d, `${label} segment ${i}`).toBeLessThan(TAIL_SEG_LEN * 1.05);
  }
}

describe('tail spring chain', () => {
  it('stays finite with exact segment lengths under extreme frame times', () => {
    const tail = new TailChain();
    const p = createPose();
    const dts = [0, -16, Number.NaN, Number.POSITIVE_INFINITY, 1e-6, 0.5, 16, 33, 249, 250, 251, 5000, 1e9];
    for (const dt of dts) {
      tail.step(-20, -30, p, dt, 3, -2, -3);
      assertSane(tail, `dt=${dt}`);
    }
  });

  it('survives violent, random root motion without blowing up', () => {
    const tail = new TailChain();
    const p = createPose();
    const rnd = seededRandom(5);
    let maxSpan = 0;
    for (let i = 0; i < 4000; i++) {
      p.tailBase = (rnd() - 0.5) * 6;
      p.tailCurl = (rnd() - 0.5) * 10;
      p.tailStiff = rnd();
      p.tailPuff = rnd();
      const rx = -20 + (rnd() - 0.5) * 30;
      const ry = -30 + (rnd() - 0.5) * 30;
      tail.step(rx, ry, p, 1 + rnd() * 60, (rnd() - 0.5) * 80, (rnd() - 0.5) * 80, rnd() < 0.5 ? -3 : Number.NaN);
      for (let k = 0; k < tail.count; k++) maxSpan = Math.max(maxSpan, Math.hypot(tail.x[k]! - rx, tail.y[k]! - ry));
    }
    assertSane(tail, 'random');
    // A chain can never be farther from its root than its length.
    expect(maxSpan).toBeLessThanOrEqual(TAIL_SEG_LEN * (tail.count - 1) + 1e-6);
  });

  it('settles onto its target shape when held still', () => {
    const tail = new TailChain();
    const p = createPose();
    for (let i = 0; i < 600; i++) tail.step(-20, -30, p, 16, 0, 0, Number.NaN);
    let err = 0;
    for (let i = 0; i < tail.count; i++) err = Math.max(err, Math.hypot(tail.x[i]! - tail.tx[i]!, tail.y[i]! - tail.ty[i]!));
    expect(err).toBeLessThan(1.5);
  });

  it('lags behind body motion (inertia) and recovers', () => {
    const tail = new TailChain();
    const p = createPose();
    for (let i = 0; i < 300; i++) tail.step(-20, -30, p, 16, 0, 0, Number.NaN);
    const tipBefore = tail.x[tail.count - 1]!;
    // Body moves right 6 DIP per frame: free points are shifted left (world-stationary).
    tail.step(-20, -30, p, 16, -6, 0, Number.NaN);
    expect(tail.x[tail.count - 1]!).toBeLessThan(tipBefore);
    for (let i = 0; i < 400; i++) tail.step(-20, -30, p, 16, 0, 0, Number.NaN);
    expect(Math.abs(tail.x[tail.count - 1]! - tipBefore)).toBeLessThan(1.5);
  });

  it('keeps free points above the ground clamp', () => {
    const tail = new TailChain();
    const p = createPose();
    p.tailBase = -1.5;
    p.tailCurl = 0;
    for (let i = 0; i < 200; i++) tail.step(-20, -6, p, 16, 0, 0, -3);
    for (let i = 1; i < tail.count; i++) expect(tail.y[i]!).toBeLessThanOrEqual(-3 + 1e-9);
  });

  it('snaps (no simulation) after a long gap or on reset', () => {
    const tail = new TailChain();
    const p = createPose();
    for (let i = 0; i < 100; i++) tail.step(-20, -30, p, 16, 0, 0, Number.NaN);
    tail.step(200, 300, p, 5000, 0, 0, Number.NaN);
    for (let i = 0; i < tail.count; i++) {
      expect(tail.x[i]!).toBeCloseTo(tail.tx[i]!, 9);
      expect(tail.y[i]!).toBeCloseTo(tail.ty[i]!, 9);
    }
  });
});
