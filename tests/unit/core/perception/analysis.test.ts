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
  it('moving block: change box covers old and new position', () => {
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
  });

  it('change between captures minutes apart is not motion (motion comes from the burst only)', () => {
    const a = new FrameAnalyzer();
    const d = new VisualEventDeriver();
    let t = 0;
    a.analyze(uniform(0), { at: t });
    for (let i = 1; i <= 6; i++) {
      const f = a.analyze(i % 2 === 0 ? uniform(0) : uniform(255), { at: (t += 120_000) }).features;
      expect(f.changeFraction).toBe(1);
      expect(f.motion).toBe(0);
      expect(d.derive(f)).not.toContain('motion');
    }
  });

  it('a burst of moving frames measures motion within the capture and the label follows it', () => {
    const a = new FrameAnalyzer();
    const d = new VisualEventDeriver();
    // A large bright square moving 40 px per frame (~150 ms): a fast animation.
    const at = (i: number) => makeFrame(W, H, (x, y) => (x >= 20 + i * 40 && x < 120 + i * 40 && y >= 20 && y < 120 ? [250, 250, 250] : [30, 30, 30]));
    const r = a.analyze(at(0), { at: 0, burst: [at(1), at(2)] });
    expect(r.burstIntervals).toBe(2);
    expect(r.features.changeFraction).toBeNull(); // no earlier capture to compare with
    expect(r.features.motion).toBeGreaterThan(0.2);
    expect(d.derive(r.features)).toContain('motion');
    // The next capture: a still burst ends the motion at once.
    const still = a.analyze(at(2), { at: 30_000, burst: [at(2), at(2)] });
    expect(still.features.motion).toBe(0);
    expect(still.features.changeFraction).toBe(0); // compared with the newest frame of the previous burst
    const ev = d.derive(still.features);
    expect(ev).not.toContain('motion');
    expect(ev).toContain('still');
  });

  it('a one-off change inside the burst is not motion (motion must last the whole burst)', () => {
    const r = new FrameAnalyzer().analyze(uniform(20), { at: 0, burst: [uniform(220), uniform(220)] });
    expect(r.burstIntervals).toBe(2);
    expect(r.features.motion).toBe(0);
    expect(new FrameAnalyzer().analyze(uniform(20), { at: 0, burst: [uniform(220)] }).features.motion).toBe(1);
  });

  it('burst frames are masked like the first frame and frames of another size are ignored', () => {
    const mask = [{ x: 0, y: 0, width: 128, height: H }];
    // Everything that changes is under the mask.
    const left = (v: number) => makeFrame(W, H, (x) => (x < 128 ? [v, v, v] : [90, 90, 90]));
    const b1 = left(200);
    const r = new FrameAnalyzer().analyze(left(10), { at: 0, masks: mask, burst: [b1, left(10)] });
    expect(r.burstIntervals).toBe(2);
    expect(r.features.motion).toBe(0);
    const o = 10 * b1.stride + 10 * 4;
    expect([b1.data[o], b1.data[o + 1], b1.data[o + 2]]).toEqual([0, 0, 0]);
    const odd = new FrameAnalyzer().analyze(uniform(10), { at: 0, burst: [makeFrame(W - 4, H, () => [250, 250, 250])] });
    expect(odd.burstIntervals).toBe(0);
    expect(odd.features.motion).toBe(0);
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

  it('videoLike needs sustained burst motion in colourful content on two analyses in a row, and has hysteresis', () => {
    const d = new VisualEventDeriver();
    const video = { ...base, motion: 0.3, colorfulness: 0.35 };
    expect(d.derive(video)).not.toContain('videoLike');
    expect(d.derive(video)).toContain('videoLike');
    expect(d.derive({ ...video, motion: 0.07, colorfulness: 0.16 })).toContain('videoLike');
    expect(d.derive({ ...video, motion: 0.04 })).not.toContain('videoLike');
    // A single qualifying analysis between calm ones never enters.
    expect(d.derive(video)).not.toContain('videoLike');
    expect(d.derive({ ...video, motion: 0 })).not.toContain('videoLike');
    expect(d.derive(video)).not.toContain('videoLike');
  });

  it('videoLike is not reported for grey motion (e.g. scrolling text) however long it lasts', () => {
    const d = new VisualEventDeriver();
    for (let i = 0; i < 6; i++) expect(d.derive({ ...base, motion: 0.5, colorfulness: 0.08 })).not.toContain('videoLike');
  });

  it('newElement: a compact changed area that was not changing in the previous analysis', () => {
    const d = new VisualEventDeriver();
    const box = { x: 0.6, y: 0.1, width: 0.3, height: 0.3 };
    expect(d.derive({ ...base, changeFraction: 0.08, changeBox: box })).toContain('newElement');
    // The same area changing again (a playing video, an animation) is not new.
    expect(d.derive({ ...base, changeFraction: 0.08, changeBox: box })).not.toContain('newElement');
    // Elsewhere, it is.
    expect(d.derive({ ...base, changeFraction: 0.06, changeBox: { x: 0.05, y: 0.5, width: 0.25, height: 0.3 } })).toContain('newElement');
  });

  it('newElement is not reported for tiny, huge, scattered or strip-shaped changes, or without a baseline', () => {
    const fresh = () => new VisualEventDeriver();
    expect(fresh().derive({ ...base, changeFraction: 0.01, changeBox: { x: 0.1, y: 0.1, width: 0.1, height: 0.1 } })).not.toContain('newElement');
    expect(fresh().derive({ ...base, changeFraction: 0.4, changeBox: { x: 0, y: 0, width: 0.7, height: 0.7 } })).not.toContain('newElement');
    expect(fresh().derive({ ...base, changeFraction: 0.02, changeBox: { x: 0.1, y: 0.1, width: 0.4, height: 0.4 } })).not.toContain('newElement');
    // Two freshly typed lines across most of a 640x400 region: 0.7 wide x 0.1 tall is 11:1 on screen.
    expect(fresh().derive({ ...base, changeFraction: 0.06, changeBox: { x: 0.1, y: 0.4, width: 0.7, height: 0.1 } }, 1.6)).not.toContain('newElement');
    // A toast-sized panel (about 3.6:1 on screen) still counts.
    expect(fresh().derive({ ...base, changeFraction: 0.12, changeBox: { x: 0.4, y: 0.7, width: 0.56, height: 0.25 } }, 1.6)).toContain('newElement');
    expect(fresh().derive({ ...base, changeFraction: null, changeBox: null })).not.toContain('newElement');
  });

  it('reset forgets videoLike, its streak and the previous change box', () => {
    const d = new VisualEventDeriver();
    const video = { ...base, motion: 0.3, colorfulness: 0.35 };
    d.derive(video);
    d.reset();
    expect(d.derive(video)).not.toContain('videoLike');
    const box = { x: 0.6, y: 0.1, width: 0.3, height: 0.3 };
    d.derive({ ...base, changeFraction: 0.08, changeBox: box });
    d.reset();
    expect(d.derive({ ...base, changeFraction: 0.08, changeBox: box })).toContain('newElement');
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

  it('analyses a 3-frame 256x160 burst well within budget (target < 8 ms)', () => {
    const rnd = mulberry32(7);
    const make = () => makeFrame(256, 160, () => [Math.floor(rnd() * 256), Math.floor(rnd() * 256), Math.floor(rnd() * 256)]);
    const pool = [make(), make(), make(), make()];
    const masks = [{ x: 100, y: 40, width: 40, height: 60 }];
    const a = new FrameAnalyzer();
    const run = (i: number) => a.analyze(pool[i % 4]!, { at: i, masks, burst: [pool[(i + 1) % 4]!, pool[(i + 2) % 4]!] });
    for (let i = 0; i < 10; i++) run(i);
    const times: number[] = [];
    for (let i = 10; i < 50; i++) {
      const t0 = performance.now();
      run(i);
      times.push(performance.now() - t0);
    }
    times.sort((x, y) => x - y);
    const median = times[Math.floor(times.length / 2)]!;
    console.log(`burst analysis 3x256x160: median ${median.toFixed(2)} ms, min ${times[0]!.toFixed(2)} ms, max ${times[times.length - 1]!.toFixed(2)} ms`);
    // Lenient bound: shared machine, parallel test workers.
    expect(median).toBeLessThan(30);
  });
});
