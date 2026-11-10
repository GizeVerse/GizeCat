// The pure geometry of world-event props and the laser dot: the padded rectangles the renderer's dirty
// rect must cover and the host's routing reasons about. No DOM, no canvas types, no drawing: it is
// imported by the web host (src/web/overlaySurface.ts) and by tests that run in the node project, which
// must not reach the DOM-typed drawing code in props.ts. props.ts re-exports everything here, so the
// renderer's own imports keep working.
import { MAX_PROPS, type RenderProp } from '../../shared/companion';

export interface PropRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** Pixel style: DIP per coarse pixel at scale 1 (the cat uses 3 device px per low-res pixel). */
export const PIXEL_GRID = 3;

/** Slack (DIP) around the largest drawn extent, on top of the outline and the pixel snap. */
const BOUNDS_PAD_DIP = 4;

export const clamp = (v: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, v));
export const outlineScale = (scale: number): number => clamp(Number.isFinite(scale) ? scale : 1, 0.85, 2);

/**
 * Half the side (DIP) of the square a prop can touch around its anchor: just over one size up, down
 * or sideways (a spring's ball, a yarn thread, a wind streak's curl), plus slack. The host's
 * propReachPx (renderMapping.ts) uses the same 1.1 factor for display routing.
 */
export function reachDip(p: RenderProp, scale: number): number {
  const size = Number.isFinite(p.size) ? clamp(p.size, 0, 600) : 0;
  return size * 1.1 + BOUNDS_PAD_DIP + PIXEL_GRID * outlineScale(scale);
}

/**
 * A padded rectangle (DIP) covering everything drawProps can touch for these props, for the dirty
 * rect; null when there is nothing to draw. Generous on purpose: a clipped residue is the failure
 * mode, a few extra cleared pixels cost nothing.
 */
export function propsBounds(props: readonly RenderProp[], scale: number): PropRect | null {
  let x0 = Infinity;
  let y0 = Infinity;
  let x1 = -Infinity;
  let y1 = -Infinity;
  const n = Math.min(props.length, MAX_PROPS);
  for (let i = 0; i < n; i++) {
    const p = props[i]!;
    if (!Number.isFinite(p.x) || !Number.isFinite(p.y)) continue;
    const r = reachDip(p, scale);
    x0 = Math.min(x0, p.x - r);
    y0 = Math.min(y0, p.y - r);
    x1 = Math.max(x1, p.x + r);
    y1 = Math.max(y1, p.y + r);
  }
  return x1 > x0 && y1 > y0 ? { x: x0, y: y0, width: x1 - x0, height: y1 - y0 } : null;
}

/** Dot radius (DIP) and the glow's reach; the dirty rect covers the pulse and the glow. */
export const LASER_RADIUS_DIP = 5;
export const LASER_GLOW_DIP = 15;

/** Padded bounds of the laser dot at (x, y), DIP (covers the pulse and the glow). */
export function laserBounds(x: number, y: number): PropRect | null {
  if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
  const r = LASER_GLOW_DIP + 3;
  return { x: x - r, y: y - r, width: r * 2, height: r * 2 };
}
