// Closed-form prop motion (src/core/events/tracks.ts). SIMULATED: pure maths. Written in the Living
// Companion sprint, NOT executed there.
import { describe, expect, it } from 'vitest';
import { evalTrack, hold, makeTrack, poseAt, seg, tracksEnd } from '../../../../src/core/events/tracks';

describe('tracks', () => {
  const straight = makeTrack({ kind: 'ball', size: 20, t0: 0, t1: 1000, segs: [seg(0, 1000, 0, 100, 200, 100)], fadeIn: 0, fadeOut: 0 });

  it('moves along a leg, holds before and after, and is invisible outside its life', () => {
    expect(poseAt(straight, -1)).toBeNull();
    expect(poseAt(straight, 1001)).toBeNull();
    expect(poseAt(straight, 0)!.x).toBeCloseTo(0);
    expect(poseAt(straight, 500)!.x).toBeCloseTo(100);
    expect(poseAt(straight, 1000)!.x).toBeCloseTo(200);
    expect(poseAt(straight, 500)!.dir).toBe(1);
    const left = makeTrack({ kind: 'ball', size: 20, t0: 0, t1: 1000, segs: [seg(0, 1000, 200, 100, 0, 100)] });
    expect(poseAt(left, 500)!.dir).toBe(-1);
  });

  it('lifts the middle of an arc and eases', () => {
    const arc = makeTrack({ kind: 'fish', size: 20, t0: 0, t1: 1000, segs: [seg(0, 1000, 0, 100, 100, 100, { arc: 40 })] });
    expect(poseAt(arc, 500)!.y).toBeCloseTo(60);
    expect(poseAt(arc, 0)!.y).toBeCloseTo(100);
    const out = makeTrack({ kind: 'ball', size: 20, t0: 0, t1: 1000, segs: [seg(0, 1000, 0, 0, 100, 0, { ease: 'out' })] });
    expect(poseAt(out, 500)!.x).toBeGreaterThan(50);
  });

  it('holds still between legs and after the last one', () => {
    const t = makeTrack({ kind: 'box', size: 20, t0: 0, t1: 3000, segs: [seg(0, 500, 0, 0, 50, 0), seg(1500, 500, 50, 0, 90, 0)] });
    expect(poseAt(t, 1000)!.x).toBeCloseTo(50);
    expect(poseAt(t, 2500)!.x).toBeCloseTo(90);
    const h = makeTrack({ kind: 'box', size: 20, t0: 0, t1: 1000, segs: [hold(0, 1000, 30, 40, { sway: 5 })] });
    const p = poseAt(h, 250)!;
    expect(p.x).toBeCloseTo(30);
    expect(Math.abs(p.y - 40)).toBeLessThanOrEqual(5 + 1e-6);
  });

  it('fades in and out and reports the progress as p', () => {
    const t = makeTrack({ kind: 'ball', size: 20, t0: 0, t1: 1000, segs: [seg(0, 1000, 0, 0, 10, 0)], fadeIn: 200, fadeOut: 200, peak: 0.8 });
    expect(evalTrack(t, 100, 5, 0)!.alpha).toBeCloseTo(0.4);
    expect(evalTrack(t, 500, 5, 0)!.alpha).toBeCloseTo(0.8);
    expect(evalTrack(t, 900, 5, 0)!.alpha).toBeCloseTo(0.4);
    expect(evalTrack(t, 500, 5, 0)!.p).toBeCloseTo(0.5);
    expect(evalTrack(t, 500, 7, 0)!.id).toBe(7);
    expect(evalTrack(t, 0, 5, 0)).toBeNull();
  });

  it('repeats a loop and is invisible in its gap', () => {
    const drop = makeTrack({ kind: 'raindrop', size: 5, t0: 0, t1: 10_000, segs: [seg(0, 400, 0, 0, 0, 100)], fadeIn: 0, fadeOut: 0, loopMs: 600 });
    expect(poseAt(drop, 200)!.y).toBeCloseTo(50);
    expect(poseAt(drop, 500)).toBeNull();
    expect(poseAt(drop, 800)!.y).toBeCloseTo(50);
  });

  it('applies follow, grow and the longest end', () => {
    const t = makeTrack({ kind: 'cloud', size: 10, t0: 0, t1: 1000, segs: [hold(0, 1000, 100, 50)], fadeIn: 0, fadeOut: 0, follow: 0.5, growFrom: 1, growTo: 2 });
    expect(evalTrack(t, 500, 1, 40)!.x).toBeCloseTo(120);
    expect(evalTrack(t, 500, 1, 0)!.size).toBeCloseTo(15);
    expect(tracksEnd([t, straight])).toBe(1000);
    expect(tracksEnd([])).toBe(0);
  });

  it('headings tilt along the path and stay finite on a zero-length leg', () => {
    const t = makeTrack({ kind: 'paperPlane', size: 10, t0: 0, t1: 1000, segs: [seg(0, 1000, 0, 0, 100, 100)], tilt: 'heading' });
    expect(poseAt(t, 500)!.rot).toBeCloseTo(Math.PI / 4);
    const still = makeTrack({ kind: 'paperPlane', size: 10, t0: 0, t1: 1000, segs: [hold(0, 1000, 5, 5)], tilt: 'heading' });
    expect(poseAt(still, 500)!.rot).toBe(0);
  });
});
