// Screen capture via desktopCapturer. Frames are cropped, masked (cat and
// excluded windows filled black) and downscaled entirely in memory; nothing is
// written to disk and buffers are dropped after use.
import * as electron from 'electron';
import { applyMasks, packFrame, type FrameBuffer } from '../../core/perception/frame';
import { projectRect, scaledSize, type CaptureDisplay } from '../../core/perception/region';
import type { Rect } from '../../shared/geometry';
import type { Logger } from '../contracts';

export type { CaptureDisplay } from '../../core/perception/region';

export interface CaptureRequest {
  display: CaptureDisplay;
  /** Region to capture, physical px, inside display.boundsPx. */
  regionPx: Rect;
  /** Areas to black out before anything is analysed or encoded, physical px. */
  maskRectsPx: readonly Rect[];
  /** Tier B frame width cap (e.g. 256). */
  analysisMaxWidth: number;
  /** Tier C image; null when no AI request can follow. */
  jpeg: { maxWidth: number; quality: number } | null;
}

export interface CapturedFrame {
  /** Masked BGRA frame, <= analysisMaxWidth wide. */
  analysis: FrameBuffer;
  /** Masked JPEG bytes, <= jpeg.maxWidth wide, or null. */
  jpeg: Uint8Array | null;
  durationMs: number;
}

/** Injectable capture backend (tests use a fake; the app uses createElectronFrameCapturer). */
export interface FrameCapturer {
  getDisplays(): CaptureDisplay[];
  capture(req: CaptureRequest, signal: AbortSignal): Promise<CapturedFrame>;
  /** PNG data URL of a frame (preview only). */
  encodePng(frame: FrameBuffer): string;
  encodeJpeg(frame: FrameBuffer, quality: number): Uint8Array;
}

export class CaptureError extends Error {
  override name = 'CaptureError';
}

/** Mask padding in output pixels, so resampling never bleeds masked content into the frame. */
const MASK_PAD = 2;

function abortIfNeeded(signal: AbortSignal): void {
  if (signal.aborted) throw new CaptureError('capture cancelled');
}

function toBitmapFrame(img: Electron.NativeImage): FrameBuffer {
  const size = img.getSize();
  const data = img.toBitmap();
  if (size.width <= 0 || size.height <= 0 || data.length < size.width * size.height * 4) {
    throw new CaptureError('captured image has an unexpected size');
  }
  // On Windows the bitmap is BGRA (Skia N32).
  return { data, width: size.width, height: size.height, stride: Math.floor(data.length / size.height), format: 'bgra' };
}

function maskedScaled(cropped: Electron.NativeImage, maxWidth: number, regionPx: Rect, masks: readonly Rect[]): FrameBuffer {
  const cur = cropped.getSize();
  const target = scaledSize({ x: 0, y: 0, width: cur.width, height: cur.height }, maxWidth);
  const img = target.width < cur.width ? cropped.resize({ width: target.width, height: target.height, quality: 'good' }) : cropped;
  const frame = toBitmapFrame(img);
  const rects = masks.map((m) => projectRect(m, regionPx, frame.width, frame.height, MASK_PAD)).filter((r): r is Rect => r !== null);
  applyMasks(frame, rects);
  return frame;
}

function bitmapImage(frame: FrameBuffer): Electron.NativeImage {
  const packed = packFrame(frame);
  if (packed.format !== 'bgra') throw new CaptureError('only BGRA frames can be encoded');
  const buf = Buffer.from(packed.data.buffer, packed.data.byteOffset, packed.width * packed.height * 4);
  return electron.nativeImage.createFromBitmap(buf, { width: packed.width, height: packed.height });
}

export function createElectronFrameCapturer(logger: Logger): FrameCapturer {
  const log = logger.child('capture');

  function getDisplays(): CaptureDisplay[] {
    const { screen } = electron;
    const primaryId = screen.getPrimaryDisplay().id;
    return screen.getAllDisplays().map((d) => ({
      id: String(d.id),
      boundsPx: screen.dipToScreenRect(null, d.bounds),
      scaleFactor: d.scaleFactor,
      primary: d.id === primaryId,
    }));
  }

  async function capture(req: CaptureRequest, signal: AbortSignal): Promise<CapturedFrame> {
    const t0 = performance.now();
    abortIfNeeded(signal);
    const { display, regionPx } = req;
    const db = display.boundsPx;
    if (regionPx.width <= 0 || regionPx.height <= 0 || db.width <= 0 || db.height <= 0) throw new CaptureError('empty capture region');

    // Ask for a thumbnail just large enough that the region crop covers the largest output.
    const wanted = Math.max(req.analysisMaxWidth, req.jpeg?.maxWidth ?? 0);
    const scale = Math.min(1, wanted / regionPx.width);
    const thumbnailSize = { width: Math.max(1, Math.round(db.width * scale)), height: Math.max(1, Math.round(db.height * scale)) };

    const sources = await electron.desktopCapturer.getSources({ types: ['screen'], thumbnailSize, fetchWindowIcons: false });
    const tGrab = performance.now();
    abortIfNeeded(signal);
    const source = sources.find((s) => s.display_id === display.id) ?? (sources.length === 1 && getDisplays().length === 1 ? sources[0] : undefined);
    if (!source) throw new CaptureError('could not match the display to a capture source');
    const thumb = source.thumbnail;
    if (thumb.isEmpty()) throw new CaptureError('the display capture was empty');

    const ts = thumb.getSize();
    const sx = ts.width / db.width;
    const sy = ts.height / db.height;
    const cx = Math.max(0, Math.floor((regionPx.x - db.x) * sx));
    const cy = Math.max(0, Math.floor((regionPx.y - db.y) * sy));
    const cw = Math.min(ts.width - cx, Math.max(1, Math.round(regionPx.width * sx)));
    const ch = Math.min(ts.height - cy, Math.max(1, Math.round(regionPx.height * sy)));
    if (cw <= 0 || ch <= 0) throw new CaptureError('capture region is outside the display');
    const cropped = thumb.crop({ x: cx, y: cy, width: cw, height: ch });

    const analysis = maskedScaled(cropped, req.analysisMaxWidth, regionPx, req.maskRectsPx);
    let jpeg: Uint8Array | null = null;
    if (req.jpeg) {
      const big = maskedScaled(cropped, req.jpeg.maxWidth, regionPx, req.maskRectsPx);
      jpeg = new Uint8Array(bitmapImage(big).toJPEG(Math.round(req.jpeg.quality)));
      big.data.fill(0);
    }
    const durationMs = Math.round(performance.now() - t0);
    log.debug('frame captured', {
      grabMs: Math.round(tGrab - t0),
      processMs: Math.round(performance.now() - tGrab),
      totalMs: durationMs,
      width: analysis.width,
      height: analysis.height,
      jpegBytes: jpeg?.byteLength ?? 0,
    });
    return { analysis, jpeg, durationMs };
  }

  return {
    getDisplays,
    capture,
    encodePng: (frame) => bitmapImage(frame).toDataURL(),
    encodeJpeg: (frame, quality) => new Uint8Array(bitmapImage(frame).toJPEG(Math.round(quality))),
  };
}
