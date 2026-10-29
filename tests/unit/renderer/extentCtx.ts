// A Canvas 2D stand-in that tracks the device-space bounding box of everything it
// would paint: path geometry is transformed by the current matrix, curves are
// sampled, strokes are widened by half the (transformed) line width. Clips are
// ignored, so the box is an upper bound of the painted pixels (before anti-aliasing).
// With `record`, every fill and stroke is also kept as device-space subpaths, so a test can ask
// how far a point is from anything painted (paintDistance; again an upper bound of the paint).
import type { Ctx2D } from '../../../src/renderer/overlay/cat/draw';

export interface Box {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

export interface ExtentCtx {
  ctx: Ctx2D;
  /** Device-space box of everything painted since the last reset (empty: x0 = Infinity). */
  readonly box: Box;
  /** drawImage destination rects (device space). */
  readonly images: Box[];
  /** Every visible fill and stroke since the last reset (only with `record`). */
  readonly shapes: PaintedShape[];
  reset(): void;
}

/** One painted path, device space: subpaths as flat [x, y, ...] lists. */
export interface PaintedShape {
  fill: boolean;
  /** Half the stroke width (0 for fills). */
  r: number;
  subs: number[][];
  /** Per subpath: closed (closePath, rect; fills are always closed). */
  closed: boolean[];
}

type Mat = [number, number, number, number, number, number];

interface Saved {
  m: Mat;
  props: Record<string, unknown>;
}

const CURVE_STEPS = 12;
const ARC_STEPS = 48;

export const emptyBox = (): Box => ({ x0: Infinity, y0: Infinity, x1: -Infinity, y1: -Infinity });

export function boxInside(inner: Box, outer: { x: number; y: number; w: number; h: number }, slack = 1e-6): boolean {
  if (!Number.isFinite(inner.x0)) return true;
  return inner.x0 >= outer.x - slack && inner.y0 >= outer.y - slack && inner.x1 <= outer.x + outer.w + slack && inner.y1 <= outer.y + outer.h + slack;
}

function segmentDistance(px: number, py: number, ax: number, ay: number, bx: number, by: number): number {
  const dx = bx - ax;
  const dy = by - ay;
  const len2 = dx * dx + dy * dy;
  const t = len2 > 0 ? Math.min(1, Math.max(0, ((px - ax) * dx + (py - ay) * dy) / len2)) : 0;
  return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
}

/** Crossing-number test of one closed polygon. */
function insidePolygon(px: number, py: number, pts: readonly number[]): boolean {
  let inside = false;
  for (let i = 0, j = pts.length - 2; i < pts.length; j = i, i += 2) {
    const xi = pts[i]!;
    const yi = pts[i + 1]!;
    const xj = pts[j]!;
    const yj = pts[j + 1]!;
    if (yi > py !== yj > py && px < ((xj - xi) * (py - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

/**
 * Device-space distance from (px, py) to the nearest painted pixel of `shapes` (0 inside a fill
 * or a stroke). A point inside any subpath of a fill counts as painted (holes are ignored), so
 * this is an upper bound of the paint, like the box.
 */
export function paintDistance(shapes: readonly PaintedShape[], px: number, py: number): number {
  let best = Infinity;
  for (const s of shapes) {
    for (let k = 0; k < s.subs.length; k++) {
      const pts = s.subs[k]!;
      const n = pts.length;
      if (n < 2) continue;
      if (s.fill && n >= 6 && insidePolygon(px, py, pts)) return 0;
      const closed = s.fill || s.closed[k] === true;
      let d = n === 2 ? Math.hypot(px - pts[0]!, py - pts[1]!) : Infinity;
      for (let i = 0; i + 3 < n; i += 2) d = Math.min(d, segmentDistance(px, py, pts[i]!, pts[i + 1]!, pts[i + 2]!, pts[i + 3]!));
      if (closed && n >= 4) d = Math.min(d, segmentDistance(px, py, pts[n - 2]!, pts[n - 1]!, pts[0]!, pts[1]!));
      d -= s.r;
      if (d <= 0) return 0;
      if (d < best) best = d;
    }
  }
  return best;
}

export function createExtentCtx(width = 4096, height = 4096, opts: { record?: boolean } = {}): ExtentCtx {
  let m: Mat = [1, 0, 0, 1, 0, 0];
  let props: Record<string, unknown> = {
    globalAlpha: 1,
    lineWidth: 1,
    strokeStyle: '#000',
    fillStyle: '#000',
    lineDashOffset: 0,
    lineCap: 'butt',
    lineJoin: 'miter',
    globalCompositeOperation: 'source-over',
    imageSmoothingEnabled: true,
  };
  const stack: Saved[] = [];
  /** Current path, device space; subpaths start at these indices of `path`. */
  let path: number[] = [];
  let subStarts: number[] = [];
  let subClosed: boolean[] = [];
  let curX = 0;
  let curY = 0;
  let startX = 0;
  let startY = 0;
  const box = emptyBox();
  const images: Box[] = [];
  const shapes: PaintedShape[] = [];
  const record = opts.record === true;

  const tx = (x: number, y: number): [number, number] => [m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]];
  const addPoint = (x: number, y: number): void => {
    if (subStarts.length === 0) {
      subStarts.push(0);
      subClosed.push(false);
    }
    const [X, Y] = tx(x, y);
    path.push(X, Y);
    curX = x;
    curY = y;
  };
  const multiply = (a: number, b: number, c: number, d: number, e: number, f: number): void => {
    m = [m[0] * a + m[2] * b, m[1] * a + m[3] * b, m[0] * c + m[2] * d, m[1] * c + m[3] * d, m[0] * e + m[2] * f + m[4], m[1] * e + m[3] * f + m[5]];
  };
  const visible = (): boolean => Number(props.globalAlpha) > 0.001;
  const newSubpath = (): void => {
    subStarts.push(path.length);
    subClosed.push(false);
  };
  const keep = (fill: boolean, r: number): void => {
    if (!record) return;
    const subs: number[][] = [];
    for (let k = 0; k < subStarts.length; k++) subs.push(path.slice(subStarts[k], subStarts[k + 1] ?? path.length));
    shapes.push({ fill, r, subs, closed: [...subClosed] });
  };
  const grow = (x: number, y: number, r: number): void => {
    if (x - r < box.x0) box.x0 = x - r;
    if (y - r < box.y0) box.y0 = y - r;
    if (x + r > box.x1) box.x1 = x + r;
    if (y + r > box.y1) box.y1 = y + r;
  };
  const arcPoints = (x: number, y: number, rx: number, ry: number, rot: number, a0: number, a1: number, ccw: boolean): void => {
    let sweep = a1 - a0;
    if (!ccw && sweep < 0) sweep = (sweep % (2 * Math.PI)) + 2 * Math.PI;
    if (ccw && sweep > 0) sweep = (sweep % (2 * Math.PI)) - 2 * Math.PI;
    if (Math.abs(a1 - a0) >= 2 * Math.PI) sweep = ccw ? -2 * Math.PI : 2 * Math.PI;
    const c = Math.cos(rot);
    const s = Math.sin(rot);
    for (let i = 0; i <= ARC_STEPS; i++) {
      const a = a0 + (sweep * i) / ARC_STEPS;
      const ex = rx * Math.cos(a);
      const ey = ry * Math.sin(a);
      addPoint(x + ex * c - ey * s, y + ex * s + ey * c);
    }
  };

  const api: Record<string, (...args: number[]) => unknown> = {
    save() {
      stack.push({ m: [...m], props: { ...props } });
    },
    restore() {
      const s = stack.pop();
      if (s) {
        m = s.m;
        props = s.props;
      }
    },
    setTransform(a, b, c, d, e, f) {
      m = [a, b, c, d, e, f];
    },
    resetTransform() {
      m = [1, 0, 0, 1, 0, 0];
    },
    transform(a, b, c, d, e, f) {
      multiply(a, b, c, d, e, f);
    },
    translate(x, y) {
      multiply(1, 0, 0, 1, x, y);
    },
    scale(x, y) {
      multiply(x, 0, 0, y, 0, 0);
    },
    rotate(a) {
      multiply(Math.cos(a), Math.sin(a), -Math.sin(a), Math.cos(a), 0, 0);
    },
    getTransform() {
      return { a: m[0], b: m[1], c: m[2], d: m[3], e: m[4], f: m[5] };
    },
    beginPath() {
      path = [];
      subStarts = [];
      subClosed = [];
    },
    moveTo(x, y) {
      newSubpath();
      addPoint(x, y);
      startX = x;
      startY = y;
    },
    lineTo(x, y) {
      addPoint(x, y);
    },
    closePath() {
      if (subClosed.length > 0) subClosed[subClosed.length - 1] = true;
      curX = startX;
      curY = startY;
    },
    bezierCurveTo(c1x, c1y, c2x, c2y, x, y) {
      const x0 = curX;
      const y0 = curY;
      for (let i = 1; i <= CURVE_STEPS; i++) {
        const t = i / CURVE_STEPS;
        const u = 1 - t;
        addPoint(
          u * u * u * x0 + 3 * u * u * t * c1x + 3 * u * t * t * c2x + t * t * t * x,
          u * u * u * y0 + 3 * u * u * t * c1y + 3 * u * t * t * c2y + t * t * t * y,
        );
      }
    },
    quadraticCurveTo(cx, cy, x, y) {
      const x0 = curX;
      const y0 = curY;
      for (let i = 1; i <= CURVE_STEPS; i++) {
        const t = i / CURVE_STEPS;
        const u = 1 - t;
        addPoint(u * u * x0 + 2 * u * t * cx + t * t * x, u * u * y0 + 2 * u * t * cy + t * t * y);
      }
    },
    arc(x, y, r, a0, a1, ccw) {
      arcPoints(x, y, r, r, 0, a0, a1, Boolean(ccw));
    },
    ellipse(x, y, rx, ry, rot, a0, a1, ccw) {
      arcPoints(x, y, rx, ry, rot, a0, a1, Boolean(ccw));
    },
    rect(x, y, w, h) {
      newSubpath();
      addPoint(x, y);
      addPoint(x + w, y);
      addPoint(x + w, y + h);
      addPoint(x, y + h);
      subClosed[subClosed.length - 1] = true;
    },
    fill() {
      if (!visible()) return;
      for (let i = 0; i < path.length; i += 2) grow(path[i]!, path[i + 1]!, 0);
      keep(true, 0);
    },
    stroke() {
      if (!visible()) return;
      // Half the pen width in device space (upper bound for non-uniform matrices).
      const k = Math.max(Math.hypot(m[0], m[1]), Math.hypot(m[2], m[3]));
      const r = (Number(props.lineWidth) / 2) * k;
      for (let i = 0; i < path.length; i += 2) grow(path[i]!, path[i + 1]!, r);
      keep(false, r);
    },
    fillRect(x, y, w, h) {
      if (!visible()) return;
      const corners: number[] = [];
      for (const [px, py] of [
        [x, y],
        [x + w, y],
        [x + w, y + h],
        [x, y + h],
      ] as const) {
        const [X, Y] = tx(px, py);
        grow(X, Y, 0);
        corners.push(X, Y);
      }
      if (record) shapes.push({ fill: true, r: 0, subs: [corners], closed: [true] });
    },
    strokeRect() {
      // Debug overlay only.
    },
    clearRect() {
      // Erasing never grows the painted area.
    },
    clip() {
      // Ignored: the box stays an upper bound.
    },
    setLineDash() {},
    fillText() {},
    getImageData(_x, _y, w, h) {
      return { data: new Uint8ClampedArray(Math.max(1, w) * Math.max(1, h) * 4), width: w, height: h };
    },
    putImageData() {},
  };

  const drawImage = (_img: unknown, ...n: number[]): void => {
    if (!visible()) return;
    let dx: number;
    let dy: number;
    let dw: number;
    let dh: number;
    if (n.length >= 8) [, , , , dx, dy, dw, dh] = n as [number, number, number, number, number, number, number, number];
    else if (n.length >= 4) [dx, dy, dw, dh] = n as [number, number, number, number];
    else return;
    const a = tx(dx, dy);
    const b = tx(dx + dw, dy + dh);
    const r: Box = { x0: Math.min(a[0], b[0]), y0: Math.min(a[1], b[1]), x1: Math.max(a[0], b[0]), y1: Math.max(a[1], b[1]) };
    images.push(r);
    grow(r.x0, r.y0, 0);
    grow(r.x1, r.y1, 0);
  };

  const target: Record<string, unknown> = {};
  const ctx = new Proxy(target, {
    get(_t, key) {
      if (key === 'canvas') return { width, height };
      if (key === 'drawImage') return drawImage;
      if (typeof key === 'string' && key in api) return api[key];
      if (typeof key === 'string' && key in props) return props[key];
      return undefined;
    },
    set(_t, key, value) {
      if (typeof key === 'string') props[key] = value;
      return true;
    },
  }) as unknown as Ctx2D;

  return {
    ctx,
    box,
    images,
    shapes,
    reset() {
      box.x0 = Infinity;
      box.y0 = Infinity;
      box.x1 = -Infinity;
      box.y1 = -Infinity;
      images.length = 0;
      shapes.length = 0;
      path = [];
      subStarts = [];
      subClosed = [];
      m = [1, 0, 0, 1, 0, 0];
      stack.length = 0;
    },
  };
}
