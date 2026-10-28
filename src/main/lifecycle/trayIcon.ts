// Tiny procedurally drawn tray icon (cat head), used when the bundled PNGs are
// missing. Produces a BGRA bitmap for nativeImage.createFromBitmap. Pure.
import type { TrayIconVariant } from './menuModel';

const COLORS: Record<TrayIconVariant, [number, number, number]> = {
  tray: [0xf2, 0xa6, 0x5a],
  'tray-paused': [0x9a, 0xa0, 0xa6],
  'tray-vision': [0x3b, 0xb3, 0xa9],
};

function insideTriangle(px: number, py: number, a: [number, number], b: [number, number], c: [number, number]): boolean {
  const s = (p1: [number, number], p2: [number, number]): number => (px - p2[0]) * (p1[1] - p2[1]) - (p1[0] - p2[0]) * (py - p2[1]);
  const d1 = s(a, b);
  const d2 = s(b, c);
  const d3 = s(c, a);
  const neg = d1 < 0 || d2 < 0 || d3 < 0;
  const pos = d1 > 0 || d2 > 0 || d3 > 0;
  return !(neg && pos);
}

/** size x size BGRA pixels (premultiplied alpha is not required by Electron for opaque/transparent-only pixels). */
export function drawTrayBitmap(variant: TrayIconVariant, size = 32): Buffer {
  const buf = Buffer.alloc(size * size * 4);
  const [r, g, b] = COLORS[variant];
  const k = size / 32;
  const cx = 16 * k;
  const cy = 18.5 * k;
  const rad = 10.5 * k;
  const earL: [[number, number], [number, number], [number, number]] = [[6 * k, 2 * k], [5.5 * k, 15 * k], [15 * k, 10 * k]];
  const earR: [[number, number], [number, number], [number, number]] = [[26 * k, 2 * k], [26.5 * k, 15 * k], [17 * k, 10 * k]];
  const eyeY = 18 * k;
  const eyeDx = 4.6 * k;
  const eyeR = 1.7 * k;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const px = x + 0.5;
      const py = y + 0.5;
      const inHead = Math.hypot(px - cx, py - cy) <= rad || insideTriangle(px, py, ...earL) || insideTriangle(px, py, ...earR);
      if (!inHead) continue;
      const eye = Math.hypot(px - (cx - eyeDx), py - eyeY) <= eyeR || Math.hypot(px - (cx + eyeDx), py - eyeY) <= eyeR;
      const i = (y * size + x) * 4;
      if (eye) {
        buf[i] = 0x30;
        buf[i + 1] = 0x30;
        buf[i + 2] = 0x30;
      } else {
        buf[i] = b;
        buf[i + 1] = g;
        buf[i + 2] = r;
      }
      buf[i + 3] = 0xff;
    }
  }
  return buf;
}
