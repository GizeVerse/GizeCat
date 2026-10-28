// Tier B: coarse statistics of a tiny, masked, in-memory frame. Numbers only;
// nothing here claims to understand what is on screen.
import type { Rect } from '../../shared/geometry';
import type { VisualFeatures } from '../../shared/perception';
import { applyMasks, assertValidFrame, type FrameBuffer } from './frame';

export interface AnalyzerOptions {
  /** Change-detection block edge in frame pixels. */
  blockSize: number;
  /** Mean-luma delta (0..255) above which a block counts as changed. */
  blockChangeThreshold: number;
  /** Share of a block that must be unmasked for it to be compared. */
  minBlockCoverage: number;
  /** Ignore changed blocks with no changed neighbour (sensor/encoder noise, blinking carets). */
  suppressIsolatedBlocks: boolean;
  /** EMA weight of the newest change fraction in `motion`. */
  motionAlpha: number;
  /** |dx| + |dy| luma gradient (0..510) above which a pixel is a strong edge. */
  edgeThreshold: number;
  /** A previous frame older than this is not compared (the screen has moved on). */
  staleAfterMs: number;
}

export const DEFAULT_ANALYZER_OPTIONS: Readonly<AnalyzerOptions> = Object.freeze({
  blockSize: 4,
  blockChangeThreshold: 10,
  minBlockCoverage: 0.5,
  suppressIsolatedBlocks: true,
  motionAlpha: 0.4,
  edgeThreshold: 48,
  staleAfterMs: 10 * 60_000,
});

export interface AnalyzeInput {
  /** Rects (frame pixel coords) to black out and exclude, e.g. the cat and excluded windows. */
  masks?: readonly Rect[];
  /** Capture time (ms, same clock across calls). */
  at: number;
  /**
   * Identifies the captured screen area. Frames are only diffed against a previous
   * frame with the same key and size; a different key starts a new baseline.
   */
  regionKey?: string;
}

export interface FrameAnalysis {
  features: VisualFeatures;
  /** Share of frame pixels excluded by masks. */
  maskedFraction: number;
  /** Unmasked pixels that contributed to the statistics. */
  analysedPixels: number;
}

/** Hasler & Suesstrunk "extremely colourful" level, used to normalise colourfulness to 0..1. */
const COLORFULNESS_FULL_SCALE = 109;

interface Signature {
  means: Float32Array;
  cols: number;
  rows: number;
  width: number;
  height: number;
  blockSize: number;
  at: number;
  regionKey: string;
}

/**
 * Stateful analyser: keeps only a coarse grid of block means (not pixels) of the
 * previous frame for change detection, plus a motion EMA.
 */
export class FrameAnalyzer {
  private readonly opts: AnalyzerOptions;
  private prev: Signature | null = null;
  private motion = 0;

  constructor(options: Partial<AnalyzerOptions> = {}) {
    this.opts = { ...DEFAULT_ANALYZER_OPTIONS, ...options };
    if (!Number.isInteger(this.opts.blockSize) || this.opts.blockSize < 2) throw new RangeError('blockSize must be an integer >= 2');
  }

  /** Forgets the previous frame and motion history. */
  reset(): void {
    this.prev = null;
    this.motion = 0;
  }

  /** Masks `frame` in place, then measures it. */
  analyze(frame: FrameBuffer, input: AnalyzeInput): FrameAnalysis {
    assertValidFrame(frame);
    const { width, height, stride, data } = frame;
    const { mask, maskedCount } = applyMasks(frame, input.masks ?? []);
    const pixelCount = width * height;
    const rOff = frame.format === 'bgra' ? 2 : 0;
    const bOff = frame.format === 'bgra' ? 0 : 2;

    // Pass 1: luma plane + global statistics over unmasked pixels.
    const luma = new Uint8Array(pixelCount);
    let n = 0;
    let sumY = 0;
    let sumY2 = 0;
    let sumRg = 0;
    let sumRg2 = 0;
    let sumYb = 0;
    let sumYb2 = 0;
    for (let y = 0; y < height; y++) {
      let o = y * stride;
      const row = y * width;
      for (let x = 0; x < width; x++, o += 4) {
        if (mask[row + x] === 1) continue;
        const r = data[o + rOff]!;
        const g = data[o + 1]!;
        const b = data[o + bOff]!;
        // Rec. 709 luma in 8.8 fixed point.
        const l = (54 * r + 183 * g + 19 * b) >> 8;
        luma[row + x] = l;
        n++;
        sumY += l;
        sumY2 += l * l;
        const rg = r - g;
        const yb = 0.5 * (r + g) - b;
        sumRg += rg;
        sumRg2 += rg * rg;
        sumYb += yb;
        sumYb2 += yb * yb;
      }
    }

    let brightness = 0;
    let contrast = 0;
    let colorfulness = 0;
    if (n > 0) {
      const meanY = sumY / n;
      const varY = Math.max(0, sumY2 / n - meanY * meanY);
      brightness = meanY / 255;
      contrast = clamp01(Math.sqrt(varY) / 127.5);
      const mRg = sumRg / n;
      const mYb = sumYb / n;
      const vRg = Math.max(0, sumRg2 / n - mRg * mRg);
      const vYb = Math.max(0, sumYb2 / n - mYb * mYb);
      const m = Math.sqrt(vRg + vYb) + 0.3 * Math.sqrt(mRg * mRg + mYb * mYb);
      colorfulness = clamp01(m / COLORFULNESS_FULL_SCALE);
    }

    const edgeDensity = this.edgeDensity(luma, mask, width, height);
    const sig = this.signature(luma, mask, width, height, input.at, input.regionKey ?? '');
    const change = this.compare(sig, input.at);
    this.prev = sig;

    if (change.fraction !== null) this.motion += this.opts.motionAlpha * (change.fraction - this.motion);
    else if (change.reset) this.motion = 0;

    return {
      features: {
        brightness: round4(brightness),
        contrast: round4(contrast),
        colorfulness: round4(colorfulness),
        edgeDensity: round4(edgeDensity),
        changeFraction: change.fraction === null ? null : round4(change.fraction),
        changeBox: change.box,
        motion: round4(clamp01(this.motion)),
      },
      maskedFraction: pixelCount > 0 ? round4(maskedCount / pixelCount) : 0,
      analysedPixels: n,
    };
  }

  /** Share of unmasked pixels whose forward-difference gradient |dx| + |dy| is strong. */
  private edgeDensity(luma: Uint8Array, mask: Uint8Array, width: number, height: number): number {
    if (width < 2 || height < 2) return 0;
    const thr = this.opts.edgeThreshold;
    let counted = 0;
    let edges = 0;
    for (let y = 0; y < height - 1; y++) {
      const row = y * width;
      for (let x = 0; x < width - 1; x++) {
        const i = row + x;
        if (mask[i] === 1 || mask[i + 1] === 1 || mask[i + width] === 1) continue;
        const c = luma[i]!;
        const mag = Math.abs(luma[i + 1]! - c) + Math.abs(luma[i + width]! - c);
        counted++;
        if (mag > thr) edges++;
      }
    }
    return counted > 0 ? edges / counted : 0;
  }

  private signature(luma: Uint8Array, mask: Uint8Array, width: number, height: number, at: number, regionKey: string): Signature {
    const bs = this.opts.blockSize;
    const cols = Math.ceil(width / bs);
    const rows = Math.ceil(height / bs);
    const means = new Float32Array(cols * rows);
    for (let by = 0; by < rows; by++) {
      const y0 = by * bs;
      const y1 = Math.min(height, y0 + bs);
      for (let bx = 0; bx < cols; bx++) {
        const x0 = bx * bs;
        const x1 = Math.min(width, x0 + bs);
        let sum = 0;
        let count = 0;
        for (let y = y0; y < y1; y++) {
          const row = y * width;
          for (let x = x0; x < x1; x++) {
            if (mask[row + x] === 1) continue;
            sum += luma[row + x]!;
            count++;
          }
        }
        const area = (x1 - x0) * (y1 - y0);
        means[by * cols + bx] = count >= area * this.opts.minBlockCoverage && count > 0 ? sum / count : Number.NaN;
      }
    }
    return { means, cols, rows, width, height, blockSize: bs, at, regionKey };
  }

  private compare(cur: Signature, at: number): { fraction: number | null; box: VisualFeatures['changeBox']; reset: boolean } {
    const prev = this.prev;
    const comparable =
      prev !== null &&
      prev.width === cur.width &&
      prev.height === cur.height &&
      prev.blockSize === cur.blockSize &&
      prev.regionKey === cur.regionKey &&
      at >= prev.at &&
      at - prev.at <= this.opts.staleAfterMs;
    if (!comparable) return { fraction: null, box: null, reset: true };

    const { cols, rows } = cur;
    const changed = new Uint8Array(cols * rows);
    let compared = 0;
    for (let i = 0; i < changed.length; i++) {
      const a = cur.means[i]!;
      const b = prev.means[i]!;
      if (Number.isNaN(a) || Number.isNaN(b)) continue;
      compared++;
      if (Math.abs(a - b) > this.opts.blockChangeThreshold) changed[i] = 1;
    }
    if (compared === 0) return { fraction: null, box: null, reset: false };

    let kept = 0;
    let minX = cols;
    let minY = rows;
    let maxX = -1;
    let maxY = -1;
    for (let by = 0; by < rows; by++) {
      for (let bx = 0; bx < cols; bx++) {
        if (changed[by * cols + bx] !== 1) continue;
        if (this.opts.suppressIsolatedBlocks && !hasChangedNeighbour(changed, cols, rows, bx, by)) continue;
        kept++;
        if (bx < minX) minX = bx;
        if (by < minY) minY = by;
        if (bx > maxX) maxX = bx;
        if (by > maxY) maxY = by;
      }
    }
    if (kept === 0) return { fraction: 0, box: null, reset: false };

    const bs = cur.blockSize;
    const px0 = minX * bs;
    const py0 = minY * bs;
    const px1 = Math.min(cur.width, (maxX + 1) * bs);
    const py1 = Math.min(cur.height, (maxY + 1) * bs);
    return {
      fraction: kept / compared,
      box: {
        x: round4(px0 / cur.width),
        y: round4(py0 / cur.height),
        width: round4((px1 - px0) / cur.width),
        height: round4((py1 - py0) / cur.height),
      },
      reset: false,
    };
  }
}

function hasChangedNeighbour(changed: Uint8Array, cols: number, rows: number, bx: number, by: number): boolean {
  for (let dy = -1; dy <= 1; dy++) {
    const y = by + dy;
    if (y < 0 || y >= rows) continue;
    for (let dx = -1; dx <= 1; dx++) {
      if (dx === 0 && dy === 0) continue;
      const x = bx + dx;
      if (x < 0 || x >= cols) continue;
      if (changed[y * cols + x] === 1) return true;
    }
  }
  return false;
}

const clamp01 = (v: number): number => (v < 0 ? 0 : v > 1 ? 1 : v);
const round4 = (v: number): number => Math.round(v * 10_000) / 10_000;

export { VisualEventDeriver, DEFAULT_VISUAL_EVENT_THRESHOLDS, type VisualEventThresholds, type Band } from './visualEvents';
