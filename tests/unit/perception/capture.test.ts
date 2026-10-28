// The Electron capturer against a fake `electron` module: what is grabbed, in which
// order things are masked, which buffers are left behind, and the capture burst.
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Rect } from '../../../src/shared/geometry';

const h = vi.hoisted(() => {
  type Rgb = readonly [number, number, number];
  interface State {
    /** Display content at a physical px. */
    paint: (x: number, y: number) => Rgb;
    display: { x: number; y: number; width: number; height: number };
    grabs: Array<{ thumbnailSize: { width: number; height: number }; sources: unknown[] }>;
    /** Pixels handed to resize / toJPEG / createFromBitmap. */
    resizeInputs: Uint8Array[];
    jpegInputs: Uint8Array[];
    bitmapInputs: Uint8Array[];
    /** Every Buffer returned by toBitmap (copies the capturer owns). */
    bitmaps: Buffer[];
  }
  const state: State = {
    paint: () => [100, 100, 100],
    display: { x: 0, y: 0, width: 1200, height: 750 },
    grabs: [],
    resizeInputs: [],
    jpegInputs: [],
    bitmapInputs: [],
    bitmaps: [],
  };

  /** BGRA image with nearest-neighbour crop/resize. */
  class FakeImage {
    constructor(
      readonly w: number,
      readonly h: number,
      readonly px: Uint8Array,
    ) {}
    getSize() {
      return { width: this.w, height: this.h };
    }
    isEmpty() {
      return this.w === 0 || this.h === 0;
    }
    crop(r: { x: number; y: number; width: number; height: number }) {
      const out = new Uint8Array(r.width * r.height * 4);
      for (let y = 0; y < r.height; y++) out.set(this.px.subarray(((r.y + y) * this.w + r.x) * 4, ((r.y + y) * this.w + r.x + r.width) * 4), y * r.width * 4);
      return new FakeImage(r.width, r.height, out);
    }
    resize(o: { width: number; height: number }) {
      state.resizeInputs.push(this.px.slice());
      const out = new Uint8Array(o.width * o.height * 4);
      for (let y = 0; y < o.height; y++) {
        const sy = Math.min(this.h - 1, Math.floor((y * this.h) / o.height));
        for (let x = 0; x < o.width; x++) {
          const sx = Math.min(this.w - 1, Math.floor((x * this.w) / o.width));
          out.set(this.px.subarray((sy * this.w + sx) * 4, (sy * this.w + sx) * 4 + 4), (y * o.width + x) * 4);
        }
      }
      return new FakeImage(o.width, o.height, out);
    }
    toBitmap() {
      const b = Buffer.from(this.px);
      state.bitmaps.push(b);
      return b;
    }
    toJPEG(_q: number) {
      state.jpegInputs.push(this.px.slice());
      return Buffer.from([0xff, 0xd8, this.w & 255, this.h & 255, 0xff, 0xd9]);
    }
    toDataURL() {
      return 'data:image/png;base64,AAAA';
    }
  }

  function renderDisplay(size: { width: number; height: number }): FakeImage {
    const d = state.display;
    const px = new Uint8Array(size.width * size.height * 4);
    for (let ty = 0; ty < size.height; ty++) {
      for (let tx = 0; tx < size.width; tx++) {
        const [r, g, b] = state.paint(d.x + Math.floor((tx * d.width) / size.width), d.y + Math.floor((ty * d.height) / size.height));
        const o = (ty * size.width + tx) * 4;
        px[o] = b;
        px[o + 1] = g;
        px[o + 2] = r;
        px[o + 3] = 255;
      }
    }
    return new FakeImage(size.width, size.height, px);
  }

  return { state, FakeImage, renderDisplay };
});

vi.mock('electron', () => ({
  desktopCapturer: {
    getSources: (opts: { thumbnailSize: { width: number; height: number } }) => {
      const sources: unknown[] = [{ display_id: '1', thumbnail: h.renderDisplay(opts.thumbnailSize) }];
      h.state.grabs.push({ thumbnailSize: { ...opts.thumbnailSize }, sources });
      return Promise.resolve(sources);
    },
  },
  screen: {
    getPrimaryDisplay: () => ({ id: 1 }),
    getAllDisplays: () => [{ id: 1, bounds: h.state.display, scaleFactor: 1 }],
    dipToScreenRect: (_w: unknown, r: Rect) => r,
  },
  nativeImage: {
    createFromBitmap: (buf: Buffer, o: { width: number; height: number }) => {
      h.state.bitmapInputs.push(Uint8Array.from(buf));
      return new h.FakeImage(o.width, o.height, Uint8Array.from(buf));
    },
  },
}));

// Imported after the mock is registered (vi.mock is hoisted above imports).
import { createElectronFrameCapturer, type CaptureRequest } from '../../../src/main/perception/capture';
import { recordingLogger } from './fakes';

const SECRET = [7, 201, 13] as const;
const PRIVATE: Rect = { x: 500, y: 300, width: 200, height: 100 };
const CAT: Rect = { x: 380, y: 420, width: 60, height: 60 };
const REGION: Rect = { x: 300, y: 200, width: 600, height: 375 };

function hasColour(px: Uint8Array, [r, g, b]: readonly [number, number, number]): boolean {
  for (let o = 0; o + 3 < px.length; o += 4) if (px[o] === b && px[o + 1] === g && px[o + 2] === r) return true;
  return false;
}

const isZero = (b: Uint8Array) => b.every((v) => v === 0);

function request(over: Partial<CaptureRequest> = {}): CaptureRequest {
  return {
    display: { id: '1', boundsPx: { ...h.state.display }, scaleFactor: 1, primary: true },
    regionPx: REGION,
    maskRectsPx: [PRIVATE, CAT],
    analysisMaxWidth: 256,
    jpeg: { maxWidth: 512, quality: 60 },
    burst: { frames: 3, intervalMs: 150 },
    ...over,
  };
}

function capturer() {
  let t = 0;
  const sleeps: number[] = [];
  const clock = {
    now: () => t,
    sleep: (ms: number) => {
      sleeps.push(ms);
      t += ms;
      return Promise.resolve();
    },
  };
  return { cap: createElectronFrameCapturer(recordingLogger(), clock), sleeps };
}

beforeEach(() => {
  h.state.paint = (x, y) => (x >= PRIVATE.x && x < PRIVATE.x + PRIVATE.width && y >= PRIVATE.y && y < PRIVATE.y + PRIVATE.height ? SECRET : [100, 140, 180]);
  h.state.grabs = [];
  h.state.resizeInputs = [];
  h.state.jpegInputs = [];
  h.state.bitmapInputs = [];
  h.state.bitmaps = [];
});

describe('Electron frame capturer', () => {
  it('takes a 3-frame burst: one JPEG from the first grab, smaller grabs after it, all frames the same size', async () => {
    const { cap, sleeps } = capturer();
    const f = await cap.capture(request(), new AbortController().signal);
    expect(h.state.grabs.map((g) => g.thumbnailSize)).toEqual([
      { width: 1024, height: 640 }, // the region's crop covers the 512 px JPEG
      { width: 512, height: 320 }, // analysis only: 256 px
      { width: 512, height: 320 },
    ]);
    expect(sleeps).toHaveLength(2);
    expect(f.jpeg).not.toBeNull();
    expect(h.state.jpegInputs).toHaveLength(1);
    expect(f.burst).toHaveLength(2);
    for (const fr of [f.analysis, ...f.burst]) expect([fr.width, fr.height]).toEqual([256, 160]);
  });

  it('masks every frame before it is resized, encoded or returned', async () => {
    const { cap } = capturer();
    const f = await cap.capture(request(), new AbortController().signal);
    // The private window is in the display images, but in nothing processed after the crop.
    expect(hasColour(h.renderDisplay({ width: 1200, height: 750 }).px, SECRET)).toBe(true);
    for (const px of [...h.state.resizeInputs, ...h.state.jpegInputs, ...h.state.bitmapInputs]) expect(hasColour(px, SECRET)).toBe(false);
    for (const fr of [f.analysis, ...f.burst]) expect(hasColour(fr.data, SECRET)).toBe(false);
  });

  it('keeps no reference to the display images and zeroes every pixel buffer it does not return', async () => {
    const { cap } = capturer();
    const f = await cap.capture(request(), new AbortController().signal);
    for (const g of h.state.grabs) expect(g.sources).toHaveLength(0);
    const kept = new Set<Uint8Array>([f.analysis.data, ...f.burst.map((b) => b.data)]);
    const leftovers = h.state.bitmaps.filter((b) => !kept.has(b));
    expect(leftovers.length).toBeGreaterThan(0);
    for (const b of leftovers) expect(isZero(b)).toBe(true);
    // Only plain buffers come back, no image objects.
    const values = [f.analysis, ...f.burst].flatMap((fr) => Object.values(fr));
    expect(values.some((v) => v instanceof h.FakeImage)).toBe(false);
  });

  it('stillClear = false ends the burst after the frames already taken', async () => {
    const { cap } = capturer();
    let asked = 0;
    const f = await cap.capture(request({ stillClear: () => ++asked < 2 }), new AbortController().signal);
    expect(h.state.grabs).toHaveLength(2);
    expect(f.burst).toHaveLength(1);
  });

  it('without a burst plan it grabs once', async () => {
    const { cap, sleeps } = capturer();
    const f = await cap.capture(request({ burst: undefined, jpeg: null }), new AbortController().signal);
    expect(h.state.grabs).toHaveLength(1);
    expect(h.state.grabs[0]!.thumbnailSize).toEqual({ width: 512, height: 320 });
    expect(f.burst).toEqual([]);
    expect(f.jpeg).toBeNull();
    expect(sleeps).toEqual([]);
  });

  it('a cancelled burst rejects and leaves every pixel buffer zeroed', async () => {
    const ctl = new AbortController();
    const { cap } = capturer();
    let asked = 0;
    const p = cap.capture(
      request({
        stillClear: () => {
          if (++asked === 2) ctl.abort();
          return true;
        },
      }),
      ctl.signal,
    );
    await expect(p).rejects.toThrow(/cancelled/);
    expect(h.state.bitmaps.length).toBeGreaterThan(0);
    for (const b of h.state.bitmaps) expect(isZero(b)).toBe(true);
    for (const g of h.state.grabs) expect(g.sources).toHaveLength(0);
  });
});
