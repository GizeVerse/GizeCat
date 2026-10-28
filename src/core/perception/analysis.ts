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
  edgeThreshold: 48,
  staleAfterMs: 10 * 60_000,
});

export interface AnalyzeInput {
  /** Rects (frame pixel coords) to black out and exclude, e.g. the cat and excluded windows. Applied to every burst frame too. */
  masks?: readonly Rect[];
  /** Capture time (ms, same clock across calls). */
  at: number;
  /**
   * Identifies the captured screen area. Frames are only diffed against a previous
   * frame with the same key and size; a different key starts a new baseline.
   */
  regionKey?: string;
  /**
   * Further frames of the same region taken a fraction of a second after `frame`
   * (one capture burst, oldest first, same size and masks). `motion` is measured
   * across them; without a burst it is 0. Frames of another size are ignored.
   */
  burst?: readonly FrameBuffer[];
}

export interface FrameAnalysis {
  features: VisualFeatures;
  /** Share of frame pixels excluded by masks. */
  maskedFraction: number;
  /** Unmasked pixels that contributed to the statistics. */
  analysedPixels: number;
  /** Frame-to-frame intervals of the burst that were compared for `motion`. */
  burstIntervals: number;
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

interface Diff {
  fraction: number;
  box: VisualFeatures['changeBox'];
}

/**
 * Stateful analyser: keeps only a coarse grid of block means (not pixels) of the
 * newest frame of the previous analysis, for "what changed since the last look".
 * Motion is measured within one capture burst only, so it reflects activity over
 * a fraction of a second, never across captures that are minutes apart.
 */
export class FrameAnalyzer {
  private readonly opts: AnalyzerOptions;
  private prev: Signature | null = null;

  constructor(options: Partial<AnalyzerOptions> = {}) {
    this.opts = { ...DEFAULT_ANALYZER_OPTIONS, ...options };
    if (!Number.isInteger(this.opts.blockSize) || this.opts.blockSize < 2) throw new RangeError('blockSize must be an integer >= 2');
  }

  /** Forgets the previous frame. */
  reset(): void {
    this.prev = null;
  }

  /** Masks `frame` (and the burst frames) in place, then measures them. */
  analyze(frame: FrameBuffer, input: AnalyzeInput): FrameAnalysis {
    assertValidFrame(frame);
    const { width, height, stride, data } = frame;
    const masks = input.masks ?? [];
    const { mask, maskedCount } = applyMasks(frame, masks);
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
    const regionKey = input.regionKey ?? '';
    const sig = this.signature(luma, mask, width, height, input.at, regionKey);
    const change = this.compare(sig, input.at);

    // Motion: the smallest share of changed blocks over the burst's intervals, so only
    // change that keeps going (video, game, animation) counts, not a one-off update.
    let latest = sig;
    let motion = 0;
    let intervals = 0;
    for (const next of input.burst ?? []) {
      assertValidFrame(next);
      if (next.width !== width || next.height !== height) continue;
      const nextMask = applyMasks(next, masks).mask;
      const nextSig = this.signature(lumaPlane(next, nextMask), nextMask, width, height, input.at, regionKey);
      const d = this.diff(latest, nextSig);
      latest = nextSig;
      if (d === null) continue;
      motion = intervals === 0 ? d.fraction : Math.min(motion, d.fraction);
      intervals++;
    }
    this.prev = latest;

    return {
      features: {
        brightness: round4(brightness),
        contrast: round4(contrast),
        colorfulness: round4(colorfulness),
        edgeDensity: round4(edgeDensity),
        changeFraction: change === null ? null : round4(change.fraction),
        changeBox: change?.box ?? null,
        motion: round4(clamp01(motion)),
      },
      maskedFraction: pixelCount > 0 ? round4(maskedCount / pixelCount) : 0,
      analysedPixels: n,
      burstIntervals: intervals,
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

  /** Change against the previous analysis; null when there is no comparable baseline. */
  private compare(cur: Signature, at: number): Diff | null {
    const prev = this.prev;
    const comparable =
      prev !== null &&
      prev.width === cur.width &&
      prev.height === cur.height &&
      prev.blockSize === cur.blockSize &&
      prev.regionKey === cur.regionKey &&
      at >= prev.at &&
      at - prev.at <= this.opts.staleAfterMs;
    return comparable ? this.diff(prev, cur) : null;
  }

  /** Changed-block share and bounding box between two same-sized signatures; null when no block was comparable. */
  private diff(prev: Signature, cur: Signature): Diff | null {
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
    if (compared === 0) return null;

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
    if (kept === 0) return { fraction: 0, box: null };

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
    };
  }
}

/** Rec. 709 luma of every unmasked pixel (masked pixels stay 0 and are skipped by the mask). */
function lumaPlane(frame: FrameBuffer, mask: Uint8Array): Uint8Array {
  const { width, height, stride, data } = frame;
  const rOff = frame.format === 'bgra' ? 2 : 0;
  const bOff = frame.format === 'bgra' ? 0 : 2;
  const luma = new Uint8Array(width * height);
  for (let y = 0; y < height; y++) {
    let o = y * stride;
    const row = y * width;
    for (let x = 0; x < width; x++, o += 4) {
      if (mask[row + x] === 1) continue;
      luma[row + x] = (54 * data[o + rOff]! + 183 * data[o + 1]! + 19 * data[o + bOff]!) >> 8;
    }
  }
  return luma;
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
