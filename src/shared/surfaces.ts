// Environmental surfaces the cat can stand on, walk along, ride or climb, in
// PHYSICAL px (the sim's world space). Produced by the main-process surface provider
// (taskbars, window tops and sides, browser tab strips) and consumed by the pure
// movement engine. Floors (work-area bottoms) are derived from the world geometry and
// are not listed here.

export const SURFACE_KINDS = ['taskbar', 'windowTop', 'windowSide', 'tabStrip'] as const;
export type SurfaceKind = (typeof SURFACE_KINDS)[number];

/**
 * entering: becoming available (e.g. an auto-hide taskbar sliding in);
 * stable: geometry settled; leaving: about to disappear (sliding out, window minimizing).
 */
export const SURFACE_PHASES = ['entering', 'stable', 'leaving'] as const;
export type SurfacePhase = (typeof SURFACE_PHASES)[number];

/** Which screen edge a taskbar is docked to. */
export const TASKBAR_EDGES = ['bottom', 'top', 'left', 'right'] as const;
export type TaskbarEdge = (typeof TASKBAR_EDGES)[number];

interface SurfaceBase {
  /** Stable, recoverable id: `${kind}:${ownerId}` (plus `:left`/`:right` for window sides). */
  id: string;
  kind: SurfaceKind;
  /** Owning top-level window (HWND, decimal string): the window, or the taskbar window. */
  ownerId: string;
  /** Display containing the surface (null if it cannot be attributed). */
  displayId: string | null;
  phase: SurfacePhase;
  /** Current motion of the surface in px/s (window being dragged, taskbar sliding). */
  vx: number;
  vy: number;
  /** 0..1 confidence that the geometry is current and visible (stale or inferred data is lower). */
  confidence: number;
  /** Host clock (ms) at which the geometry was last read from the OS. */
  validatedAt: number;
  /** Belongs to a private/excluded app: never inspected, climbed or rested on. */
  excluded: boolean;
}

/** A horizontal walkable top edge. The cat's feet rest at `y`; it may stand anywhere in [x0, x1]. */
export interface LedgeSurface extends SurfaceBase {
  orientation: 'ledge';
  y: number;
  x0: number;
  x1: number;
  /** Preferred resting span inside [x0, x1] (e.g. a tab strip minus its controls), or null for anywhere. */
  rest: { x0: number; x1: number } | null;
  /**
   * v1.1.1: the open edge the cat may land on or pull up onto, when wider than [x0, x1]
   * (a tab strip's window top, so a climb up the window's side can end at the corner and
   * walk onto the strip). Omitted: landing is limited to [x0, x1].
   */
  land?: { x0: number; x1: number };
  /** Something worth looking at on/under this ledge (e.g. the active tab's centre x), or null. */
  focusX: number | null;
  /** For taskbars: the screen edge it is docked to. */
  edge?: TaskbarEdge;
}

/**
 * A vertical climbable edge at x = `x`, from y0 (top) to y1 (bottom). `side` is the side of
 * the owning window the edge belongs to; the cat clings to the OUTSIDE of the window:
 * on a 'left' edge it hangs left of x facing right, on a 'right' edge right of x facing left.
 */
export interface WallSurface extends SurfaceBase {
  orientation: 'wall';
  x: number;
  y0: number;
  y1: number;
  side: 'left' | 'right';
  /** Ledge reachable by pulling up at the top corner (normally the window's top edge), or null. */
  topLedgeId: string | null;
}

export type Surface = LedgeSurface | WallSurface;

export const isLedge = (s: Surface): s is LedgeSurface => s.orientation === 'ledge';
export const isWall = (s: Surface): s is WallSurface => s.orientation === 'wall';

/** Status of the environment observers, for diagnostics and settings. */
export interface SurfaceStatus {
  taskbar: 'tracked' | 'unavailable';
  /** Number of taskbars currently known (primary + secondary). */
  taskbars: number;
  windowSurfaces: 'tracked' | 'unavailable';
  tabStrips: 'active' | 'idle' | 'off' | 'unavailable';
  /** Short human-readable reason when tabStrips is unavailable (e.g. helper blocked). */
  tabStripReason: string | null;
}
