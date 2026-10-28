// A synthetic, content-free "desktop" picture used by the settings "Test AI"
// button, so testing a provider never sends real screen content.
import { makeFrame, type FrameBuffer, type PixelFormat } from './frame';

type Rgb = readonly [number, number, number];

interface Box {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
  fill: Rgb;
  title: Rgb;
}

export function makeTestPattern(width = 320, height = 200, format: PixelFormat = 'bgra'): FrameBuffer {
  const boxes: Box[] = [
    { x0: 0.08, y0: 0.1, x1: 0.62, y1: 0.78, fill: [245, 245, 245], title: [60, 90, 160] },
    { x0: 0.45, y0: 0.3, x1: 0.92, y1: 0.86, fill: [30, 30, 36], title: [90, 90, 100] },
  ];
  const taskbarTop = 0.92;
  return makeFrame(
    width,
    height,
    (x, y): Rgb => {
      const u = x / width;
      const v = y / height;
      if (v >= taskbarTop) return [32, 32, 40];
      for (let i = boxes.length - 1; i >= 0; i--) {
        const b = boxes[i]!;
        if (u >= b.x0 && u < b.x1 && v >= b.y0 && v < b.y1) {
          if (v < b.y0 + 0.05) return b.title;
          // a few "text lines" made of flat bars
          const line = Math.floor((v - b.y0) * height) % 9;
          const inText = u > b.x0 + 0.03 && u < b.x1 - 0.06 && line >= 5 && line <= 6;
          return inText ? (b.fill[0] > 128 ? [120, 120, 120] : [170, 200, 140]) : b.fill;
        }
      }
      return [Math.round(40 + 60 * v), Math.round(90 + 50 * u), 150]; // wallpaper gradient
    },
    format,
  );
}
