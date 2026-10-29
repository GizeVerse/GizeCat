// The cat's physical world: floors (bottom edge of each display's work area), the
// environment's ledges (taskbars, window tops, tab strips) and climbable walls (window
// sides), and containment, all in physical px.
import type { Facing } from '../../shared/cat';
import { CAT_BASE_HEIGHT_DIP, CAT_BASE_WIDTH_DIP } from '../../shared/cat';
import type { Point } from '../../shared/geometry';
import { clamp, isFiniteRect, rectBottom, rectRight } from '../../shared/geometry';
import type { NavRejectReason } from '../../shared/surfaceDiagnostics';
import type { LedgeSurface, SurfaceKind, SurfacePhase, WallSurface } from '../../shared/surfaces';
import type { DisplayGeometry, WorldGeometry } from '../../shared/world';
import { MOVEMENT } from './constants';

/** Most ledges, and most walls, the cat considers per tick. */
const MAX_PER_KIND = 64;
const NO_IDS: ReadonlySet<string> = new Set<string>();

/** One display's share of a floor. */
export interface FloorPiece {
  displayId: string;
  y: number;
  /** Work-area edges (not inset by the cat's width). */
  left: number;
  right: number;
  scale: number;
}

/** A walkable horizontal surface: a floor, or one of the environment's ledges. */
export interface Surface {
  kind: 'floor' | 'ledge';
  /** Stable identity: joined display ids for floors, the environment surface id for ledges. */
  key: string;
  /** Ledges: the environment surface id (src/shared/surfaces.ts); null for floors. */
  surfaceId: string | null;
  /** Ledges: taskbar, window top or tab strip; null for floors. */
  surfaceKind: SurfaceKind | null;
  /** Ledges: the owning top-level window (or taskbar window); null for floors. */
  ownerId: string | null;
  displayIds: readonly string[];
  /** Representative height (floors: of the first piece). */
  y: number;
  /** Range the anchor may occupy while standing on the surface. */
  x0: number;
  x1: number;
  /** Range in which a falling anchor lands on the surface (ledges: also where a pull-up may end). */
  landX0: number;
  landX1: number;
  /**
   * Ledges: the landing range was widened by the provider's open edge (LedgeSurface.land, a tab
   * strip's window top). A cat set down there is not snapped into [x0, x1]: it walks in.
   */
  landWide?: boolean;
  /** Floors only, sorted left to right. */
  pieces: readonly FloorPiece[];
  /** Ledges: preferred resting span for the anchor (inside [x0, x1]), or null for anywhere. */
  rest: { x0: number; x1: number } | null;
  /** Ledges: something worth looking at on the ledge (a tab strip's active tab), or null. */
  focusX: number | null;
  /** Ledges: lifecycle phase (a 'leaving' ledge is never a jump target). Floors: 'stable'. */
  phase: SurfacePhase;
  /** Ledges: vertical motion reported by the provider, px/s (negative = up). */
  vy: number;
}

/**
 * A climbable vertical edge (a window side) in anchor terms. While climbing, the anchor is
 * the grip point on the wall line at hind-paw height and the body extends upwards.
 */
export interface WallTrack {
  /** The environment surface id. */
  key: string;
  ownerId: string;
  displayId: string;
  /** The wall line (the window's visible side). */
  x: number;
  side: 'left' | 'right';
  /** +1 when the cat hangs on a window's left side (wall to its right), -1 on a right side. */
  facing: Facing;
  /** Raw extent of the edge. */
  y0: number;
  y1: number;
  /** Highest anchor height on the wall: the head peeks over the top corner (pull-up position). */
  yTop: number;
  /** Lowest anchor height on the wall: its bottom end, cut off by the floor. */
  yBottom: number;
  /** Where the cat stands on a support beside the wall before climbing (outside the window). */
  standX: number;
  /** Ledge reachable by pulling up at the top corner, or null. */
  topLedgeId: string | null;
  phase: SurfacePhase;
  scale: number;
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
    if (surface.kind === 'ledge') return surface.y;
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

  /** Floor height under x (the floor of the display column containing x), or null outside every display column. */
  floorYAt(x: number): number | null {
    let best: number | null = null;
    for (const f of this.floors) {
      for (const piece of f.pieces) {
        if (x < piece.left || x >= piece.right) continue;
        if (best === null || piece.y > best) best = piece.y;
      }
    }
    return best;
  }

  /**
   * First surface at or below (x, y) whose landing range contains x. Floors are
   * only considered on the display column containing x.
   */
  surfaceBelow(x: number, y: number, ledges: readonly Surface[], tolerance = 1): SurfacePoint | null {
    let best: SurfacePoint | null = null;
    for (const f of this.floors) {
      for (const piece of f.pieces) {
        if (x < piece.left || x >= piece.right || piece.y < y - tolerance) continue;
        if (!best || piece.y < best.y) best = { surface: f, x: clamp(x, f.x0, f.x1), y: piece.y };
      }
    }
    for (const w of ledges) {
      if (x < w.landX0 || x > w.landX1 || w.y < y - tolerance) continue;
      if (!best || w.y < best.y) best = { surface: w, x: clamp(x, w.x0, w.x1), y: w.y };
    }
    return best;
  }

  /**
   * Converts the environment's ledges into walkable surfaces. Each must lie inside a work
   * area, leave head room for the cat and be wide enough. Window tops and tab strips must
   * also keep clear of the floor; a taskbar only has to be above it (a docked taskbar below
   * the work area is the floor already, and top or side taskbars are a ceiling or a wall).
   * Duplicate ids keep their first entry. At most `maxCount` are kept, in list order; the
   * ids in `keep` (what the cat stands on or is heading for) always make the cut.
   */
  ledgeSurfaces(ledges: readonly LedgeSurface[], keep: ReadonlySet<string> = NO_IDS, maxCount = MAX_PER_KIND, onReject?: RejectSink<LedgeSurface>): Surface[] {
    return capped(ledges, maxCount, keep, (l) => this.ledgeSurfaceOrReason(l, false), onReject);
  }

  /** One ledge as a walkable surface, or null. `relaxed` keeps a ledge the cat already stands on (geometry sanity only). */
  ledgeSurface(l: LedgeSurface, relaxed: boolean): Surface | null {
    const r = this.ledgeSurfaceOrReason(l, relaxed);
    return typeof r === 'string' ? null : r;
  }

  /** Like ledgeSurface, but says why a ledge is not walkable (diagnostics). */
  ledgeSurfaceOrReason(l: LedgeSurface, relaxed: boolean): Surface | NavRejectReason {
    if (l.orientation !== 'ledge' || typeof l.id !== 'string' || l.id.length === 0) return 'invalid';
    if (!Number.isFinite(l.y) || !Number.isFinite(l.x0) || !Number.isFinite(l.x1) || l.x1 - l.x0 < 1) return 'invalid';
    if (l.kind === 'windowSide') return 'invalid';
    if (l.kind === 'taskbar' && (l.edge === 'top' || l.edge === 'left' || l.edge === 'right')) return 'unsupportedEdge';
    const d = this.displayAt({ x: (l.x0 + l.x1) / 2, y: l.y });
    if (!d) return 'offDisplay';
    const wa = d.workAreaPx;
    const bw = this.bodyWidth(d.scaleFactor);
    const bh = this.bodyHeight(d.scaleFactor);
    if (!relaxed) {
      if (l.y - bh * 0.8 < wa.y) return 'noHeadroom';
      if (l.kind === 'taskbar') {
        const floorY = this.floorYAt((l.x0 + l.x1) / 2) ?? rectBottom(wa);
        if (floorY - l.y < 2 * d.scaleFactor) return 'nearFloor';
      } else if (rectBottom(wa) - l.y < bh * 0.5) {
        return 'nearFloor';
      }
    }
    const lx0 = Math.max(l.x0, wa.x);
    const lx1 = Math.min(l.x1, rectRight(wa));
    // Tab strips arrive as ANCHOR spans already clear of the browser controls and inset by half the
    // cat (src/main/uia/segment.ts), so they are not narrowed again and may be shorter than a body.
    const anchorSpan = l.kind === 'tabStrip';
    if (lx1 - lx0 < (relaxed ? 1 : anchorSpan ? bw * 0.25 : bw * 0.9)) return 'tooNarrow';
    // A taskbar spans its display: like on a floor, the cat keeps its whole body on screen.
    const inset = l.kind === 'taskbar' ? bw / 2 : anchorSpan ? 0 : bw * 0.25;
    let x0 = lx0 + inset;
    let x1 = lx1 - inset;
    if (x1 < x0) {
      x0 = (lx0 + lx1) / 2;
      x1 = x0;
    }
    let rest: { x0: number; x1: number } | null = null;
    if (l.rest && Number.isFinite(l.rest.x0) && Number.isFinite(l.rest.x1)) {
      const r0 = clamp(l.rest.x0, x0, x1);
      const r1 = clamp(l.rest.x1, x0, x1);
      if (r1 - r0 >= 1) rest = { x0: r0, x1: r1 };
    }
    // The open edge around the ledge (a tab strip's window top) widens where it is landed or
    // pulled up onto, clamped like the span; the stand range stays [x0, x1].
    let landX0 = lx0;
    let landX1 = lx1;
    const land = l.land;
    if (land && Number.isFinite(land.x0) && Number.isFinite(land.x1) && land.x1 > land.x0) {
      landX0 = Math.min(lx0, Math.max(land.x0, wa.x));
      landX1 = Math.max(lx1, Math.min(land.x1, rectRight(wa)));
    }
    return {
      kind: 'ledge',
      key: l.id,
      surfaceId: l.id,
      surfaceKind: l.kind,
      ownerId: typeof l.ownerId === 'string' ? l.ownerId : null,
      displayIds: [d.id],
      y: l.y,
      x0,
      x1,
      landX0,
      landX1,
      ...(landX0 < lx0 || landX1 > lx1 ? { landWide: true } : {}),
      pieces: [],
      rest,
      focusX: typeof l.focusX === 'number' && Number.isFinite(l.focusX) ? l.focusX : null,
      phase: l.phase === 'entering' || l.phase === 'leaving' ? l.phase : 'stable',
      vy: Number.isFinite(l.vy) ? l.vy : 0,
    };
  }

  /**
   * Converts window sides into climbable walls (duplicates keep their first entry). The cat
   * hangs outside the window, so there must be room for its body beside the edge on the
   * same display; the climbable stretch runs from just below the top corner (head over the
   * edge) down to the bottom end or the floor, whichever is higher. Capped like ledgeSurfaces.
   */
  wallTracks(walls: readonly WallSurface[], keep: ReadonlySet<string> = NO_IDS, maxCount = MAX_PER_KIND, onReject?: RejectSink<WallSurface>): WallTrack[] {
    return capped(walls, maxCount, keep, (w) => this.wallTrackOrReason(w), onReject);
  }

  wallTrack(w: WallSurface): WallTrack | null {
    const r = this.wallTrackOrReason(w);
    return typeof r === 'string' ? null : r;
  }

  /** Like wallTrack, but says why a side is not climbable (diagnostics). */
  wallTrackOrReason(w: WallSurface): WallTrack | NavRejectReason {
    if (w.orientation !== 'wall' || w.kind !== 'windowSide' || typeof w.id !== 'string' || w.id.length === 0) return 'invalid';
    if (!Number.isFinite(w.x) || !Number.isFinite(w.y0) || !Number.isFinite(w.y1) || w.y1 <= w.y0) return 'invalid';
    if (w.side !== 'left' && w.side !== 'right') return 'invalid';
    const outward = w.side === 'left' ? -1 : 1;
    const d = this.displayAt({ x: w.x + outward, y: (w.y0 + w.y1) / 2 }) ?? this.displayAt({ x: w.x + outward, y: w.y0 });
    // Against the screen's edge (a display inside the window, none beside it): no room to hang there.
    if (!d) return this.displayAt({ x: w.x - outward, y: (w.y0 + w.y1) / 2 }) ? 'noRoomBeside' : 'offDisplay';
    const wa = d.workAreaPx;
    const bw = this.bodyWidth(d.scaleFactor);
    const bh = this.bodyHeight(d.scaleFactor);
    // Room for the body beside the edge (it sticks out about one body height while hanging).
    const outer = w.x + outward * bh * 0.85;
    if (outer < wa.x || outer > rectRight(wa)) return 'noRoomBeside';
    const standX = w.x + outward * bw * 0.55;
    const floorY = this.floorYAt(standX) ?? rectBottom(wa);
    // Highest anchor on the wall: the front paws (about 0.73 body lengths above the anchor) rest
    // on the top edge instead of poking over it.
    const yTop = Math.max(w.y0 + bw * 0.73, wa.y + bw);
    const yBottom = Math.min(w.y1, floorY);
    if (yBottom - yTop < bw * 0.25) return 'tooShort';
    return {
      key: w.id,
      ownerId: typeof w.ownerId === 'string' ? w.ownerId : '',
      displayId: d.id,
      x: w.x,
      side: w.side,
      facing: w.side === 'left' ? 1 : -1,
      y0: w.y0,
      y1: w.y1,
      yTop,
      yBottom,
      standX,
      topLedgeId: typeof w.topLedgeId === 'string' && w.topLedgeId.length > 0 ? w.topLedgeId : null,
      phase: w.phase === 'entering' || w.phase === 'leaving' ? w.phase : 'stable',
      scale: d.scaleFactor,
    };
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
      surfaceId: null,
      surfaceKind: null,
      ownerId: null,
      displayIds: ids,
      y: first.y,
      x0,
      x1,
      landX0: first.left,
      landX1: last.right,
      pieces,
      rest: null,
      focusX: null,
      phase: 'stable',
      vy: 0,
    };
  }
}

/** Receives each surface the world model turned down, with the reason (diagnostics). */
export type RejectSink<T> = (item: T, reason: NavRejectReason) => void;

/**
 * Converts surfaces in list order, skipping invalid ones and later duplicates of an id, and
 * keeps at most `maxCount`: the ids in `keep` always, the others first come first served.
 * `onReject` hears about every surface turned down (those past the cap as 'capped').
 */
function capped<T extends { id: string }, R extends object>(
  items: readonly T[],
  maxCount: number,
  keep: ReadonlySet<string>,
  convert: (item: T) => R | NavRejectReason,
  onReject?: RejectSink<T>,
): R[] {
  const out: R[] = [];
  const seen = new Set<string>();
  const room = Math.max(0, maxCount - keep.size);
  let others = 0;
  for (const item of items) {
    if (!item || seen.has(item.id)) continue;
    const kept = keep.has(item.id);
    if (!kept && others >= room) {
      onReject?.(item, 'capped');
      continue;
    }
    const r = convert(item);
    if (typeof r === 'string') {
      onReject?.(item, r);
      continue;
    }
    seen.add(item.id);
    out.push(r);
    if (!kept) others++;
  }
  return out;
}

function clampToWorkArea(d: DisplayGeometry, p: Point): Point {
  const wa = d.workAreaPx;
  return { x: clamp(p.x, wa.x, rectRight(wa) - 0.01), y: clamp(p.y, wa.y, rectBottom(wa)) };
}

export function sameSurface(a: Surface, b: Surface): boolean {
  return a.kind === b.kind && a.key === b.key;
}
