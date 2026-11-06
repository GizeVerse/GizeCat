// Screen capture via desktopCapturer, entirely in memory; nothing is written to disk.
//
// Electron cannot grab a region: desktopCapturer returns a reduced-resolution image of
// every display (sized so the region's crop covers the largest output). Each grab is
// cropped to the region at once, the crop's pixels are copied into a buffer this module
// owns, and every display image (and the crop, which would keep its display image
// alive) is unreferenced right there. The copy is masked (cat and excluded windows
// filled black) before it is downscaled, analysed, previewed or encoded for AI, and is
// zeroed afterwards. Electron's own image memory cannot be zeroed: the garbage
// collector frees it once unreferenced.
import * as electron from 'electron';
import { applyMasks, packFrame, type FrameBuffer } from '../../core/perception/frame';
import { projectRect, scaledSize, type CaptureDisplay } from '../../core/perception/region';
import type { Rect } from '../../shared/geometry';
import type { Logger } from '../contracts';
import { runBurst, type BurstClock, type BurstPlan } from './burst';

export type { CaptureDisplay } from '../../core/perception/region';

export interface CaptureRequest {
  display: CaptureDisplay;
  /** Region to capture, physical px, inside display.boundsPx. */
  regionPx: Rect;
  /** Areas to black out before anything is analysed or encoded, physical px. */
  maskRectsPx: readonly Rect[];
  /** Tier B frame width cap (e.g. 256). */
  analysisMaxWidth: number;
  /** Tier C image (from the first frame only); null when no AI request can follow. */
  jpeg: { maxWidth: number; quality: number } | null;
  /** A short burst of analysis frames with the same masks; absent = one frame. */
  burst?: BurstPlan;
  /** Asked before each further burst frame; false ends the burst (the caller then discards the frames). */
  stillClear?: () => boolean;
}

export interface CapturedFrame {
  /** Masked BGRA frame, <= analysisMaxWidth wide (the burst's first frame). */
  analysis: FrameBuffer;
  /** Further masked frames of the burst, oldest first, same size as `analysis` (empty without a burst). */
  burst: FrameBuffer[];
  /** Masked JPEG bytes of the first frame, <= jpeg.maxWidth wide, or null. */
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

function maskFrame(frame: FrameBuffer, regionPx: Rect, masks: readonly Rect[]): void {
  const rects = masks.map((m) => projectRect(m, regionPx, frame.width, frame.height, MASK_PAD)).filter((r): r is Rect => r !== null);
  applyMasks(frame, rects);
}

function bitmapImage(frame: FrameBuffer): Electron.NativeImage {
  const packed = packFrame(frame);
  if (packed.format !== 'bgra') throw new CaptureError('only BGRA frames can be encoded');
  const buf = Buffer.from(packed.data.buffer, packed.data.byteOffset, packed.width * packed.height * 4);
  return electron.nativeImage.createFromBitmap(buf, { width: packed.width, height: packed.height });
}

/** The masked region scaled to exactly `size` (every frame of a burst gets the same size), masked again at that size. */
function scaledMasked(region: FrameBuffer, size: { width: number; height: number }, regionPx: Rect, masks: readonly Rect[]): FrameBuffer {
  const img = bitmapImage(region);
  const out = toBitmapFrame(size.width === region.width && size.height === region.height ? img : img.resize({ width: size.width, height: size.height, quality: 'good' }));
  maskFrame(out, regionPx, masks);
  return out;
}

interface Grab {
  analysis: FrameBuffer;
  jpeg: Uint8Array | null;
}

const wipeGrab = (g: Grab): void => {
  g.analysis.data.fill(0);
  g.jpeg?.fill(0);
};

/**
 * `toWorldRect` maps a screen DIP rect to world px (ADR 0004 §4); it defaults to Windows'
 * screen.dipToScreenRect(null, rect), the only conversion before GizeVerse.
 */
export function createElectronFrameCapturer(
  logger: Logger,
  clock: Partial<BurstClock> = {},
  toWorldRect: (rect: electron.Rectangle) => electron.Rectangle = (rect) => electron.screen.dipToScreenRect(null, rect),
): FrameCapturer {
  const log = logger.child('capture');

  function getDisplays(): CaptureDisplay[] {
    const { screen } = electron;
    const primaryId = screen.getPrimaryDisplay().id;
    return screen.getAllDisplays().map((d) => ({
      id: String(d.id),
      boundsPx: toWorldRect(d.bounds),
      scaleFactor: d.scaleFactor,
      primary: d.id === primaryId,
    }));
  }

  /**
   * One display grab, cropped to the region and copied into a buffer we own (unmasked).
   * The display images go out of scope here, before any further processing.
   */
  async function grabRegion(req: CaptureRequest, wantedWidth: number, signal: AbortSignal): Promise<FrameBuffer> {
    const { display, regionPx } = req;
    const db = display.boundsPx;
    // Ask for a thumbnail just large enough that the region crop covers the largest output.
    const scale = Math.min(1, wantedWidth / regionPx.width);
    const thumbnailSize = { width: Math.max(1, Math.round(db.width * scale)), height: Math.max(1, Math.round(db.height * scale)) };
    const sources = await electron.desktopCapturer.getSources({ types: ['screen'], thumbnailSize, fetchWindowIcons: false });
    try {
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
      // A crop still references its display image: copy its pixels out and let both go.
      return toBitmapFrame(thumb.crop({ x: cx, y: cy, width: cw, height: ch }));
    } finally {
      sources.length = 0;
    }
  }

  async function grabFrame(req: CaptureRequest, jpeg: CaptureRequest['jpeg'], signal: AbortSignal): Promise<Grab> {
    const { regionPx, maskRectsPx } = req;
    const region = await grabRegion(req, Math.max(req.analysisMaxWidth, jpeg?.maxWidth ?? 0), signal);
    try {
      abortIfNeeded(signal);
      // Masked before anything else touches it: later steps only ever see black where private windows were.
      maskFrame(region, regionPx, maskRectsPx);
      const analysis = scaledMasked(region, scaledSize(regionPx, req.analysisMaxWidth), regionPx, maskRectsPx);
      if (!jpeg) return { analysis, jpeg: null };
      const big = scaledMasked(region, scaledSize(regionPx, jpeg.maxWidth), regionPx, maskRectsPx);
      try {
        return { analysis, jpeg: new Uint8Array(bitmapImage(big).toJPEG(Math.round(jpeg.quality))) };
      } finally {
        big.data.fill(0);
      }
    } finally {
      region.data.fill(0);
    }
  }

  async function capture(req: CaptureRequest, signal: AbortSignal): Promise<CapturedFrame> {
    const t0 = performance.now();
    abortIfNeeded(signal);
    const { display, regionPx } = req;
    const db = display.boundsPx;
    if (regionPx.width <= 0 || regionPx.height <= 0 || db.width <= 0 || db.height <= 0) throw new CaptureError('empty capture region');

    let framesMs = 0;
    const frames = await runBurst(
      req.burst,
      async (i) => {
        const g0 = performance.now();
        const g = await grabFrame(req, i === 0 ? req.jpeg : null, signal);
        framesMs += performance.now() - g0;
        return g;
      },
      { signal, release: wipeGrab, stillClear: req.stillClear, clock },
    ).catch((e: unknown) => {
      throw signal.aborted ? new CaptureError('capture cancelled') : e;
    });
    const [first, ...rest] = frames;
    if (!first) throw new CaptureError('no frame was captured');
    const durationMs = Math.round(performance.now() - t0);
    log.debug('frame captured', {
      frames: frames.length,
      // Grabbing and processing the frames; the rest of totalMs is the wait between them.
      framesMs: Math.round(framesMs),
      totalMs: durationMs,
      width: first.analysis.width,
      height: first.analysis.height,
      jpegBytes: first.jpeg?.byteLength ?? 0,
    });
    return { analysis: first.analysis, burst: rest.map((g) => g.analysis), jpeg: first.jpeg, durationMs };
  }

  return {
    getDisplays,
    capture,
    encodePng: (frame) => bitmapImage(frame).toDataURL(),
    encodeJpeg: (frame, quality) => new Uint8Array(bitmapImage(frame).toJPEG(Math.round(quality))),
  };
}
