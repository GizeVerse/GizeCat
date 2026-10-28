// The cat's physical world: floors (bottom edge of each display's work area),
// walls, window-top platforms and containment, all in physical px.
import { CAT_BASE_HEIGHT_DIP, CAT_BASE_WIDTH_DIP } from '../../shared/cat';
import type { Point } from '../../shared/geometry';
import { clamp, isFiniteRect, rectBottom, rectRight } from '../../shared/geometry';
import type { DisplayGeometry, Platform, WorldGeometry } from '../../shared/world';
import { MOVEMENT } from './constants';

/** One display's share of a floor. */
export interface FloorPiece {
  displayId: string;
  y: number;
  /** Work-area edges (not inset by the cat's width). */
  left: number;
  right: number;
  scale: number;
}

/** A walkable horizontal surface. */
export interface Surface {
  kind: 'floor' | 'window';
  /** Stable identity: joined display ids for floors, window id for windows. */
  key: string;
  windowId: string | null;
  displayIds: readonly string[];
  /** Representative height (floors: of the first piece). */
  y: number;
  /** Range the anchor may occupy while standing on the surface. */
  x0: number;
  x1: number;
  /** Range in which a falling anchor lands on the surface. */
  landX0: number;
  landX1: number;
  /** Floors only, sorted left to right. */
  pieces: readonly FloorPiece[];
}

export interface SurfacePoint {
  surface: Surface;
  x: number;
  y: number;
}

/** Used when the host reports no usable display, so the simulation never sees an empty world. */
export const FALLBACK_DISPLAY: DisplayGeometry = {
  id: 'fallback',
  primary: true,
  scaleFactor: 1,
  boundsDip: { x: 0, y: 0, width: 1920, height: 1080 },
  workAreaDip: { x: 0, y: 0, width: 1920, height: 1040 },
  boundsPx: { x: 0, y: 0, width: 1920, height: 1080 },
  workAreaPx: { x: 0, y: 0, width: 1920, height: 1040 },
};

export function isUsableDisplay(d: DisplayGeometry): boolean {
  return (
    typeof d.id === 'string' &&
    d.id.length > 0 &&
    Number.isFinite(d.scaleFactor) &&
    d.scaleFactor > 0 &&
    isFiniteRect(d.workAreaPx) &&
    d.workAreaPx.width >= 1 &&
    d.workAreaPx.height >= 1
  );
}

export class WorldModel {
  readonly displays: readonly DisplayGeometry[];
  readonly version: number;
  readonly size: number;
  readonly joinFloors: boolean;
  readonly usedFallback: boolean;
  readonly floors: readonly Surface[];
  private readonly floorByDisplay = new Map<string, Surface>();

  constructor(geometry: WorldGeometry, size: number, joinFloors: boolean) {
    const usable = geometry.displays.filter(isUsableDisplay);
    this.usedFallback = usable.length === 0;
    this.displays = this.usedFallback ? [FALLBACK_DISPLAY] : usable;
    this.version = geometry.version;
    this.size = Number.isFinite(size) && size > 0 ? size : 1;
    this.joinFloors = joinFloors;
    this.floors = this.buildFloors();
    for (const f of this.floors) for (const id of f.displayIds) this.floorByDisplay.set(id, f);
  }

  /** A world containing only one display (used when multi-monitor roaming is off). */
  restrictTo(displayId: string): WorldModel {
    const d = this.display(displayId) ?? this.primary;
    return new WorldModel({ version: this.version, displays: [d] }, this.size, false);
  }

  /** Always present: the world has at least one display. */
  get firstFloor(): Surface {
    return this.floors[0] as Surface;
  }

  get primary(): DisplayGeometry {
    return this.displays.find((d) => d.primary) ?? (this.displays[0] as DisplayGeometry);
  }

  display(id: string): DisplayGeometry | undefined {
    return this.displays.find((d) => d.id === id);
  }

  bodyWidth(scale: number): number {
    return CAT_BASE_WIDTH_DIP * this.size * scale;
  }

  bodyHeight(scale: number): number {
    return CAT_BASE_HEIGHT_DIP * this.size * scale;
  }

  /** Display whose work area contains p (bottom edge inclusive), or null. */
  displayAt(p: Point): DisplayGeometry | null {
    for (const d of this.displays) {
      const wa = d.workAreaPx;
      if (p.x >= wa.x && p.x < rectRight(wa) && p.y >= wa.y && p.y <= rectBottom(wa)) return d;
    }
    return null;
  }

  nearestDisplay(p: Point): DisplayGeometry {
    let best = this.primary;
    let bestD = Infinity;
    for (const d of this.displays) {
      const q = clampToWorkArea(d, p);
      const dist = Math.hypot(q.x - p.x, q.y - p.y);
      if (dist < bestD) {
        bestD = dist;
        best = d;
      }
    }
    return best;
  }

  scaleAt(p: Point): number {
    return (this.displayAt(p) ?? this.nearestDisplay(p)).scaleFactor;
  }

  contains(p: Point, tolerance = 0.5): boolean {
    if (!Number.isFinite(p.x) || !Number.isFinite(p.y)) return false;
    for (const d of this.displays) {
      const wa = d.workAreaPx;
      if (p.x >= wa.x - tolerance && p.x <= rectRight(wa) + tolerance && p.y >= wa.y - tolerance && p.y <= rectBottom(wa) + tolerance) {
        return true;
      }
    }
    return false;
  }

  /** Nearest point inside the union of work areas. */
  clampInside(p: Point): Point {
    const safe = { x: Number.isFinite(p.x) ? p.x : this.primary.workAreaPx.x, y: Number.isFinite(p.y) ? p.y : this.primary.workAreaPx.y };
    if (this.contains(safe, 0)) return safe;
    return clampToWorkArea(this.nearestDisplay(safe), safe);
  }

  floorFor(displayId: string): Surface | undefined {
    return this.floorByDisplay.get(displayId);
  }

  floorPieceAt(surface: Surface, x: number): FloorPiece | null {
    if (surface.pieces.length === 0) return null;
    let best: FloorPiece | null = null;
    let bestD = Infinity;
    for (const p of surface.pieces) {
      if (x >= p.left && x < p.right) return p;
      const d = x < p.left ? p.left - x : x - p.right;
      if (d < bestD) {
        bestD = d;
        best = p;
      }
    }
    return best;
  }

  /** Height of the surface at x. */
  yAt(surface: Surface, x: number): number {
    if (surface.kind === 'window') return surface.y;
    return this.floorPieceAt(surface, x)?.y ?? surface.y;
  }

  /** Display id under x on a surface. */
  displayIdOn(surface: Surface, x: number): string {
    if (surface.kind === 'floor') return this.floorPieceAt(surface, x)?.displayId ?? (surface.displayIds[0] as string);
    return surface.displayIds[0] ?? this.primary.id;
  }

  /** Floor point nearest to p, preferring the floor directly below it. */
  nearestFloorPoint(p: Point): SurfacePoint {
    const below = this.surfaceBelow(p.x, p.y, []);
    if (below) return below;
    let best: SurfacePoint | null = null;
    let bestD = Infinity;
    for (const f of this.floors) {
      const x = clamp(p.x, f.x0, f.x1);
      const y = this.yAt(f, x);
      const d = Math.hypot(x - p.x, y - p.y);
      if (d < bestD) {
        bestD = d;
        best = { surface: f, x, y };
      }
    }
    return best ?? this.floorPoint(this.firstFloor, p.x);
  }

  floorPoint(surface: Surface, x: number): SurfacePoint {
    const cx = clamp(x, surface.x0, surface.x1);
    return { surface, x: cx, y: this.yAt(surface, cx) };
  }

  /**
   * First surface at or below (x, y) whose landing range contains x. Floors are
   * only considered on the display column containing x.
   */
  surfaceBelow(x: number, y: number, windows: readonly Surface[], tolerance = 1): SurfacePoint | null {
    let best: SurfacePoint | null = null;
    for (const f of this.floors) {
      for (const piece of f.pieces) {
        if (x < piece.left || x >= piece.right || piece.y < y - tolerance) continue;
        if (!best || piece.y < best.y) best = { surface: f, x: clamp(x, f.x0, f.x1), y: piece.y };
      }
    }
    for (const w of windows) {
      if (x < w.landX0 || x > w.landX1 || w.y < y - tolerance) continue;
      if (!best || w.y < best.y) best = { surface: w, x: clamp(x, w.x0, w.x1), y: w.y };
    }
    return best;
  }

  /**
   * Converts the host's visible window-top segments into walkable surfaces:
   * each must lie inside a work area, leave head room for the cat and be wide enough.
   */
  windowSurfaces(platforms: readonly Platform[], maxCount = 64): Surface[] {
    const out: Surface[] = [];
    for (const p of platforms) {
      if (out.length >= maxCount) break;
      if (!Number.isFinite(p.y) || !Number.isFinite(p.x0) || !Number.isFinite(p.x1) || p.x1 - p.x0 < 1) continue;
      const d = this.displayAt({ x: (p.x0 + p.x1) / 2, y: p.y });
      if (!d) continue;
      const wa = d.workAreaPx;
      const bw = this.bodyWidth(d.scaleFactor);
      const bh = this.bodyHeight(d.scaleFactor);
      if (p.y - bh * 0.8 < wa.y) continue;
      if (rectBottom(wa) - p.y < bh * 0.5) continue;
      const lx0 = Math.max(p.x0, wa.x);
      const lx1 = Math.min(p.x1, rectRight(wa));
      if (lx1 - lx0 < bw * 0.9) continue;
      out.push({
        kind: 'window',
        key: `win:${p.windowId}`,
        windowId: p.windowId,
        displayIds: [d.id],
        y: p.y,
        x0: lx0 + bw * 0.25,
        x1: lx1 - bw * 0.25,
        landX0: lx0,
        landX1: lx1,
        pieces: [],
      });
    }
    return out;
  }

  private buildFloors(): Surface[] {
    const pieces: FloorPiece[] = this.displays.map((d) => ({
      displayId: d.id,
      y: rectBottom(d.workAreaPx),
      left: d.workAreaPx.x,
      right: rectRight(d.workAreaPx),
      scale: d.scaleFactor,
    }));
    if (!this.joinFloors) return pieces.map((p) => this.floorFromPieces([p]));
    const sorted = [...pieces].sort((a, b) => a.left - b.left || a.y - b.y);
    const groups: FloorPiece[][] = [];
    for (const piece of sorted) {
      const group = groups.find((g) => {
        const last = g[g.length - 1] as FloorPiece;
        const tol = MOVEMENT.floorJoinToleranceDip * Math.max(last.scale, piece.scale);
        return Math.abs(last.right - piece.left) <= tol && Math.abs(last.y - piece.y) <= tol;
      });
      if (group) group.push(piece);
      else groups.push([piece]);
    }
    return groups.map((g) => this.floorFromPieces(g));
  }

  private floorFromPieces(pieces: FloorPiece[]): Surface {
    const first = pieces[0] as FloorPiece;
    const last = pieces[pieces.length - 1] as FloorPiece;
    let x0 = first.left + this.bodyWidth(first.scale) / 2;
    let x1 = last.right - this.bodyWidth(last.scale) / 2;
    if (x1 < x0) {
      const mid = (first.left + last.right) / 2;
      x0 = mid;
      x1 = mid;
    }
    const ids = pieces.map((p) => p.displayId);
    return {
      kind: 'floor',
      key: `floor:${ids.join('+')}`,
      windowId: null,
      displayIds: ids,
      y: first.y,
      x0,
      x1,
      landX0: first.left,
      landX1: last.right,
      pieces,
    };
  }
}

function clampToWorkArea(d: DisplayGeometry, p: Point): Point {
  const wa = d.workAreaPx;
  return { x: clamp(p.x, wa.x, rectRight(wa) - 0.01), y: clamp(p.y, wa.y, rectBottom(wa)) };
}

export function sameSurface(a: Surface, b: Surface): boolean {
  if (a.kind !== b.kind) return false;
  if (a.kind === 'floor') return a.key === b.key;
  return a.windowId === b.windowId && a.x0 <= b.x1 && b.x0 <= a.x1;
}
