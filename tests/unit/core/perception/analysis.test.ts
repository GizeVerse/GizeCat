import { describe, expect, it } from 'vitest';
import { FrameAnalyzer, VisualEventDeriver } from '../../../../src/core/perception/analysis';
import { applyMasks, makeFrame, type FrameBuffer } from '../../../../src/core/perception/frame';
import type { VisualFeatures } from '../../../../src/shared/perception';

const W = 256;
const H = 144;

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const uniform = (v: number) => makeFrame(W, H, () => [v, v, v]);
const checker = (cell: number) => makeFrame(W, H, (x, y) => ((Math.floor(x / cell) + Math.floor(y / cell)) % 2 === 0 ? [0, 0, 0] : [255, 255, 255]));
const withBlock = (bx: number, by: number, size = 32) =>
  makeFrame(W, H, (x, y) => (x >= bx && x < bx + size && y >= by && y < by + size ? [250, 250, 250] : [60, 60, 60]));

describe('FrameAnalyzer statistics', () => {
  it('uniform dark frame: dark, flat, no edges, no colour', () => {
    const a = new FrameAnalyzer();
    const r = a.analyze(uniform(20), { at: 0 });
    expect(r.features.brightness).toBeCloseTo(20 / 255, 2);
    expect(r.features.contrast).toBe(0);
    expect(r.features.edgeDensity).toBe(0);
    expect(r.features.colorfulness).toBe(0);
    expect(r.features.changeFraction).toBeNull();
    expect(r.features.changeBox).toBeNull();
    expect(new VisualEventDeriver().derive(r.features)).toEqual(['dark', 'quiet']);
  });

  it('uniform bright frame: bright and quiet', () => {
    const r = new FrameAnalyzer().analyze(uniform(240), { at: 0 });
    expect(r.features.brightness).toBeGreaterThan(0.9);
    expect(new VisualEventDeriver().derive(r.features)).toEqual(['bright', 'quiet']);
  });

  it('checkerboard is busy with full contrast', () => {
    const r = new FrameAnalyzer().analyze(checker(4), { at: 0 });
    expect(r.features.contrast).toBeGreaterThan(0.95);
    expect(r.features.edgeDensity).toBeGreaterThan(0.3);
    expect(new VisualEventDeriver().derive(r.features)).toContain('busy');
  });

  it('even a 1-pixel checkerboard registers as edges', () => {
    const r = new FrameAnalyzer().analyze(checker(1), { at: 0 });
    expect(r.features.edgeDensity).toBeGreaterThan(0.9);
  });

  it('smooth gradient is quiet', () => {
    const f = makeFrame(W, H, (x) => {
      const v = Math.round((x / (W - 1)) * 255);
      return [v, v, v];
    });
    const r = new FrameAnalyzer().analyze(f, { at: 0 });
    expect(r.features.edgeDensity).toBe(0);
    expect(r.features.contrast).toBeGreaterThan(0.5);
    expect(new VisualEventDeriver().derive(r.features)).toContain('quiet');
  });

  it('colourfulness: saturated colours score high, grey scores zero', () => {
    const colourful = makeFrame(W, H, (x) => (x % 2 === 0 ? [255, 0, 0] : [0, 0, 255]));
    expect(new FrameAnalyzer().analyze(colourful, { at: 0 }).features.colorfulness).toBeGreaterThan(0.8);
    expect(new FrameAnalyzer().analyze(uniform(128), { at: 0 }).features.colorfulness).toBe(0);
  });

  it('gives identical results for BGRA and RGBA input of the same picture', () => {
    const fill = (x: number, y: number) => [(x * 7) % 256, (y * 13) % 256, (x + y) % 256] as const;
    const bgra = new FrameAnalyzer().analyze(makeFrame(W, H, fill, 'bgra'), { at: 0 });
    const rgba = new FrameAnalyzer().analyze(makeFrame(W, H, fill, 'rgba'), { at: 0 });
    expect(rgba.features).toEqual(bgra.features);
  });

  it('honours stride padding (row padding bytes are ignored)', () => {
    const fill = (x: number, y: number) => ((x >> 3) + (y >> 3)) % 2 === 0 ? ([10, 200, 30] as const) : ([220, 20, 90] as const);
    const tight = makeFrame(W, H, fill);
    const padded = makeFrame(W, H, fill, 'bgra', W * 4 + 64);
    // Garbage in the padding must not matter.
    for (let y = 0; y < H; y++) padded.data.fill(255, y * padded.stride + W * 4, (y + 1) * padded.stride);
    expect(new FrameAnalyzer().analyze(padded, { at: 0 }).features).toEqual(new FrameAnalyzer().analyze(tight, { at: 0 }).features);
  });

  it('rejects malformed frames', () => {
    const bad: FrameBuffer = { data: new Uint8Array(10), width: 10, height: 10, stride: 40, format: 'bgra' };
    expect(() => new FrameAnalyzer().analyze(bad, { at: 0 })).toThrow(/too small/);
    expect(() => new FrameAnalyzer().analyze({ ...uniform(0), stride: 3 }, { at: 0 })).toThrow(/stride/);
  });
});

describe('FrameAnalyzer change detection', () => {
  it('moving block: change box covers old and new position, motion rises', () => {
    const a = new FrameAnalyzer();
    a.analyze(withBlock(20, 20), { at: 0 });
    const r = a.analyze(withBlock(100, 60), { at: 1000 });
    const f = r.features;
    expect(f.changeFraction).not.toBeNull();
    expect(f.changeFraction!).toBeGreaterThan(0.05);
    expect(f.changeFraction!).toBeLessThan(0.15);
    const box = f.changeBox!;
    expect(box.x).toBeCloseTo(20 / W, 1);
    expect(box.y).toBeCloseTo(20 / H, 1);
    expect(box.x + box.width).toBeCloseTo(132 / W, 1);
    expect(box.y + box.height).toBeCloseTo(92 / H, 1);
    expect(f.motion).toBeGreaterThan(0);
  });

  it('motion is an EMA over frames and decays when the screen stops changing', () => {
    const a = new FrameAnalyzer();
    const d = new VisualEventDeriver();
    let t = 0;
    const big = [uniform(0), uniform(255)];
    a.analyze(big[0]!, { at: t });
    let last: VisualFeatures | null = null;
    for (let i = 1; i <= 6; i++) {
      last = a.analyze(big[i % 2]!, { at: (t += 1000) }).features;
      d.derive(last);
    }
    expect(last!.motion).toBeGreaterThan(0.9);
    expect(d.derive(last!)).toContain('motion');
    expect(d.derive(last!)).toContain('bigChange');
    let ev: string[] = [];
    for (let i = 0; i < 12; i++) ev = d.derive(a.analyze(uniform(255), { at: (t += 1000) }).features);
    expect(ev).toContain('still');
    expect(ev).not.toContain('motion');
  });

  it('identical frames: zero change, no box', () => {
    const a = new FrameAnalyzer();
    a.analyze(checker(8), { at: 0 });
    const r = a.analyze(checker(8), { at: 100 });
    expect(r.features.changeFraction).toBe(0);
    expect(r.features.changeBox).toBeNull();
  });

  it('is robust to dense low-amplitude noise and sparse impulse noise', () => {
    const base = (x: number, y: number) => 100 + ((x * 3 + y * 5) % 40);
    const noisy = (seed: number) => {
      const rnd = mulberry32(seed);
      return makeFrame(W, H, (x, y) => {
        let v = base(x, y) + Math.round((rnd() - 0.5) * 16); // +-8
        if (rnd() < 0.002) v = rnd() < 0.5 ? 0 : 255; // salt and pepper
        return [v, v, v];
      });
    };
    const a = new FrameAnalyzer();
    a.analyze(noisy(1), { at: 0 });
    const r = a.analyze(noisy(2), { at: 1000 });
    expect(r.features.changeFraction!).toBeLessThan(0.005);
  });

  it('a single isolated changed block (e.g. a blinking caret) is suppressed', () => {
    const a = new FrameAnalyzer();
    a.analyze(uniform(50), { at: 0 });
    const caret = makeFrame(W, H, (x, y) => (x >= 40 && x < 44 && y >= 40 && y < 44 ? [255, 255, 255] : [50, 50, 50]));
    expect(a.analyze(caret, { at: 500 }).features.changeFraction).toBe(0);
    const strict = new FrameAnalyzer({ suppressIsolatedBlocks: false });
    strict.analyze(uniform(50), { at: 0 });
    expect(strict.analyze(caret, { at: 500 }).features.changeFraction!).toBeGreaterThan(0);
  });

  it('changes inside masked rects are ignored and masked pixels are blacked out', () => {
    const a = new FrameAnalyzer();
    const mask = [{ x: 90, y: 50, width: 60, height: 50 }];
    a.analyze(withBlock(100, 60, 32), { at: 0, masks: mask });
    const f2 = withBlock(110, 62, 32); // moved, but only inside the mask
    const r = a.analyze(f2, { at: 1000, masks: mask });
    expect(r.features.changeFraction).toBe(0);
    expect(r.maskedFraction).toBeCloseTo((60 * 50) / (W * H), 3);
    const o = 70 * f2.stride + 120 * 4;
    expect([f2.data[o], f2.data[o + 1], f2.data[o + 2], f2.data[o + 3]]).toEqual([0, 0, 0, 255]);
  });

  it('a moving mask (the cat walking) does not register as change', () => {
    const a = new FrameAnalyzer();
    const bg = () => checker(8);
    a.analyze(bg(), { at: 0, masks: [{ x: 10, y: 10, width: 40, height: 40 }] });
    const r = a.analyze(bg(), { at: 1000, masks: [{ x: 60, y: 10, width: 40, height: 40 }] });
    expect(r.features.changeFraction).toBe(0);
  });

  it('masked pixels do not bias brightness', () => {
    const f = uniform(255);
    const r = new FrameAnalyzer().analyze(f, { at: 0, masks: [{ x: 0, y: 0, width: 128, height: 144 }] });
    expect(r.features.brightness).toBe(1);
    expect(r.analysedPixels).toBe(128 * 144);
  });

  it('a different region key or a stale previous frame starts a new baseline', () => {
    const a = new FrameAnalyzer({ staleAfterMs: 5000 });
    a.analyze(uniform(10), { at: 0, regionKey: 'A' });
    expect(a.analyze(uniform(200), { at: 100, regionKey: 'B' }).features.changeFraction).toBeNull();
    expect(a.analyze(uniform(10), { at: 200, regionKey: 'B' }).features.changeFraction).toBe(1);
    expect(a.analyze(uniform(10), { at: 60_000, regionKey: 'B' }).features.changeFraction).toBeNull();
  });

  it('applyMasks clips out-of-frame rects and ignores empty ones', () => {
    const f = uniform(100);
    const { maskedCount } = applyMasks(f, [
      { x: -10, y: -10, width: 20, height: 20 },
      { x: 500, y: 500, width: 10, height: 10 },
      { x: 5, y: 5, width: 0, height: 10 },
      { x: Number.NaN, y: 0, width: 10, height: 10 },
    ]);
    expect(maskedCount).toBe(100);
  });
});

describe('VisualEventDeriver hysteresis', () => {
  const base: VisualFeatures = { brightness: 0.5, contrast: 0.3, colorfulness: 0.2, edgeDensity: 0.07, changeFraction: 0.02, changeBox: null, motion: 0.05 };

  it('dark enters below 0.18 and only leaves above 0.24', () => {
    const d = new VisualEventDeriver();
    expect(d.derive({ ...base, brightness: 0.2 })).not.toContain('dark');
    expect(d.derive({ ...base, brightness: 0.17 })).toContain('dark');
    expect(d.derive({ ...base, brightness: 0.22 })).toContain('dark');
    expect(d.derive({ ...base, brightness: 0.25 })).not.toContain('dark');
  });

  it('busy/quiet bands do not flicker around a single threshold', () => {
    const d = new VisualEventDeriver();
    expect(d.derive({ ...base, edgeDensity: 0.15 })).toContain('busy');
    expect(d.derive({ ...base, edgeDensity: 0.12 })).toContain('busy');
    expect(d.derive({ ...base, edgeDensity: 0.09 })).not.toContain('busy');
    expect(d.derive({ ...base, edgeDensity: 0.02 })).toContain('quiet');
    expect(d.derive({ ...base, edgeDensity: 0.04 })).toContain('quiet');
    expect(d.derive({ ...base, edgeDensity: 0.05 })).not.toContain('quiet');
  });

  it('bigChange is per frame and never sticky', () => {
    const d = new VisualEventDeriver();
    expect(d.derive({ ...base, changeFraction: 0.5 })).toContain('bigChange');
    expect(d.derive({ ...base, changeFraction: 0.3 })).not.toContain('bigChange');
  });

  it('still is never reported without a comparison frame', () => {
    const d = new VisualEventDeriver();
    expect(d.derive({ ...base, motion: 0, changeFraction: null })).not.toContain('still');
    expect(d.derive({ ...base, motion: 0, changeFraction: 0 })).toContain('still');
    expect(d.derive({ ...base, motion: 0, changeFraction: null })).not.toContain('still');
  });
});

describe('performance', () => {
  it('analyses a 256x144 frame well within budget (target < 5 ms)', () => {
    const rnd = mulberry32(42);
    const frames = [0, 1].map(() => makeFrame(W, H, () => [Math.floor(rnd() * 256), Math.floor(rnd() * 256), Math.floor(rnd() * 256)]));
    const a = new FrameAnalyzer();
    for (let i = 0; i < 10; i++) a.analyze(frames[i % 2]!, { at: i, masks: [{ x: 100, y: 40, width: 40, height: 60 }] });
    const times: number[] = [];
    for (let i = 0; i < 40; i++) {
      const t0 = performance.now();
      a.analyze(frames[i % 2]!, { at: 100 + i, masks: [{ x: 100, y: 40, width: 40, height: 60 }] });
      times.push(performance.now() - t0);
    }
    times.sort((x, y) => x - y);
    const median = times[Math.floor(times.length / 2)]!;
    console.log(`analysis 256x144: median ${median.toFixed(2)} ms, min ${times[0]!.toFixed(2)} ms, max ${times[times.length - 1]!.toFixed(2)} ms`);
    // Lenient bound: shared machine, parallel test workers.
    expect(median).toBeLessThan(20);
  });
});
