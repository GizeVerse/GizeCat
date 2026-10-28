// Raw pixel frames and masking. Frames are small, in-memory copies that are
// never persisted; masking blacks out areas that must not be analysed or sent.
import type { Rect } from '../../shared/geometry';

export type PixelFormat = 'bgra' | 'rgba';

export interface FrameBuffer {
  /** 4 bytes per pixel; Node Buffers are accepted (Uint8Array subclass). */
  data: Uint8Array;
  width: number;
  height: number;
  /** Bytes per row, >= width * 4. */
  stride: number;
  format: PixelFormat;
}

export class FrameError extends Error {
  override name = 'FrameError';
}

export function assertValidFrame(frame: FrameBuffer): void {
  const { width, height, stride, data } = frame;
  if (!Number.isInteger(width) || !Number.isInteger(height) || width <= 0 || height <= 0) {
    throw new FrameError(`invalid frame size ${width}x${height}`);
  }
  if (!Number.isInteger(stride) || stride < width * 4) throw new FrameError(`invalid stride ${stride} for width ${width}`);
  const needed = stride * (height - 1) + width * 4;
  if (data.length < needed) throw new FrameError(`frame buffer too small: ${data.length} < ${needed}`);
  if (frame.format !== 'bgra' && frame.format !== 'rgba') throw new FrameError('unsupported pixel format');
}

/** Clips a rect (frame pixel coords, may be fractional) to integer pixel bounds inside the frame. */
export function clipToFrame(r: Rect, width: number, height: number): Rect | null {
  if (!Number.isFinite(r.x) || !Number.isFinite(r.y) || !Number.isFinite(r.width) || !Number.isFinite(r.height)) return null;
  const x0 = Math.max(0, Math.floor(r.x));
  const y0 = Math.max(0, Math.floor(r.y));
  const x1 = Math.min(width, Math.ceil(r.x + r.width));
  const y1 = Math.min(height, Math.ceil(r.y + r.height));
  if (x1 <= x0 || y1 <= y0) return null;
  return { x: x0, y: y0, width: x1 - x0, height: y1 - y0 };
}

export interface MaskResult {
  /** One byte per pixel (row-major, width*height); 1 = masked. */
  mask: Uint8Array;
  maskedCount: number;
}

/**
 * Fills the given rects (frame pixel coords) with opaque black, in place, and
 * returns a per-pixel mask so statistics can skip those pixels entirely.
 */
export function applyMasks(frame: FrameBuffer, rects: readonly Rect[]): MaskResult {
  assertValidFrame(frame);
  const { width, height, stride, data } = frame;
  const mask = new Uint8Array(width * height);
  let maskedCount = 0;
  for (const raw of rects) {
    const r = clipToFrame(raw, width, height);
    if (!r) continue;
    for (let y = r.y; y < r.y + r.height; y++) {
      const rowMask = y * width;
      let o = y * stride + r.x * 4;
      for (let x = r.x; x < r.x + r.width; x++, o += 4) {
        if (mask[rowMask + x] === 0) {
          mask[rowMask + x] = 1;
          maskedCount++;
        }
        data[o] = 0;
        data[o + 1] = 0;
        data[o + 2] = 0;
        data[o + 3] = 255;
      }
    }
  }
  return { mask, maskedCount };
}

/** Allocates a tightly packed, opaque frame filled by `fill(x, y) -> [r, g, b]`. */
export function makeFrame(
  width: number,
  height: number,
  fill: (x: number, y: number) => readonly [number, number, number],
  format: PixelFormat = 'bgra',
  stride = width * 4,
): FrameBuffer {
  const data = new Uint8Array(stride * height);
  const rOff = format === 'bgra' ? 2 : 0;
  const bOff = format === 'bgra' ? 0 : 2;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const [r, g, b] = fill(x, y);
      const o = y * stride + x * 4;
      data[o + rOff] = r;
      data[o + 1] = g;
      data[o + bOff] = b;
      data[o + 3] = 255;
    }
  }
  const frame: FrameBuffer = { data, width, height, stride, format };
  assertValidFrame(frame);
  return frame;
}

/** Copies a frame into a tightly packed buffer (stride = width * 4) in the same pixel format. */
export function packFrame(frame: FrameBuffer): FrameBuffer {
  assertValidFrame(frame);
  const rowBytes = frame.width * 4;
  if (frame.stride === rowBytes && frame.data.length === rowBytes * frame.height) return frame;
  const out = new Uint8Array(rowBytes * frame.height);
  for (let y = 0; y < frame.height; y++) {
    out.set(frame.data.subarray(y * frame.stride, y * frame.stride + rowBytes), y * rowBytes);
  }
  return { data: out, width: frame.width, height: frame.height, stride: rowBytes, format: frame.format };
}
