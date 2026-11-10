// The floating cat's display service (1.4.0 preview 2): one display, the whole physical screen, in
// the same logical world as the web host (world px = dp = CSS px, scaleFactor 1), but the renderer's
// canvas is only the small transparent window that follows the cat. So overlay-local DIP is the
// world minus the window's origin (setOrigin), not minus the work area's origin as in display.ts.
//
// The work area is the screen minus the system bars and the display cutout (native sends the
// insets), so the cat's floor sits above the navigation bar and it never hides under the status
// bar. Metrics come from native (floatingProtocol.ts ScreenMetrics): rotation, a folding or a
// resized display, and the insets all arrive as an update(); a change is reported once, a repeat is
// not.
//
// Pure: no DOM types.
import { displayAtPoint } from '../core/display/displayMath';
import type { Point, Rect } from '../shared/geometry';
import type { DisplayGeometry, WorldGeometry } from '../shared/world';
import type { DisplayService } from '../main/contracts';
import type { ScreenMetrics } from './floatingProtocol';

export const OVERLAY_DISPLAY_ID = 'android-screen';

const sameRect = (a: Rect, b: Rect): boolean => a.x === b.x && a.y === b.y && a.width === b.width && a.height === b.height;

/** The screen as the world's only display: bounds = the screen, work area = inside the bars (at least 1 dp each way). */
export function screenDisplay(m: ScreenMetrics): DisplayGeometry {
  const bounds: Rect = { x: 0, y: 0, width: Math.max(1, Math.round(m.width)), height: Math.max(1, Math.round(m.height)) };
  const left = Math.min(bounds.width - 1, Math.max(0, Math.round(m.insets.left)));
  const top = Math.min(bounds.height - 1, Math.max(0, Math.round(m.insets.top)));
  const right = Math.min(bounds.width - 1 - left, Math.max(0, Math.round(m.insets.right)));
  const bottom = Math.min(bounds.height - 1 - top, Math.max(0, Math.round(m.insets.bottom)));
  const work: Rect = { x: left, y: top, width: bounds.width - left - right, height: bounds.height - top - bottom };
  return { id: OVERLAY_DISPLAY_ID, primary: true, scaleFactor: 1, boundsDip: { ...bounds }, workAreaDip: { ...work }, boundsPx: { ...bounds }, workAreaPx: { ...work } };
}

export interface OverlayDisplayService extends DisplayService {
  /** New screen metrics from native; true when the display changed (listeners were called). */
  update(metrics: ScreenMetrics): boolean;
  /** Where the overlay window's top-left corner is in the world (dp); local DIP is measured from it. */
  setOrigin(p: Point): void;
  readonly origin: Point;
  readonly metrics: ScreenMetrics;
}

export function createOverlayDisplayService(initial: ScreenMetrics): OverlayDisplayService {
  const listeners = new Set<(world: WorldGeometry) => void>();
  let metrics = initial;
  let version = 1;
  let world: WorldGeometry = { version, displays: [screenDisplay(initial)] };
  let origin: Point = { x: 0, y: 0 };
  let disposed = false;

  return {
    get world() {
      return world;
    },
    get origin() {
      return origin;
    },
    get metrics() {
      return metrics;
    },
    onChange(cb) {
      listeners.add(cb);
      return () => {
        listeners.delete(cb);
      };
    },
    toLocalDip(_displayId, p) {
      return { x: p.x - origin.x, y: p.y - origin.y };
    },
    fromLocalDip(_displayId, p) {
      return { x: p.x + origin.x, y: p.y + origin.y };
    },
    displayAt(p) {
      return displayAtPoint(world.displays, p)?.id ?? null;
    },
    setOrigin(p) {
      if (Number.isFinite(p.x) && Number.isFinite(p.y)) origin = { x: p.x, y: p.y };
    },
    update(next) {
      if (disposed) return false;
      metrics = next;
      const display = screenDisplay(next);
      const cur = world.displays[0];
      if (cur && sameRect(cur.boundsPx, display.boundsPx) && sameRect(cur.workAreaPx, display.workAreaPx)) return false;
      version++;
      world = { version, displays: [display] };
      for (const cb of [...listeners]) {
        try {
          cb(world);
        } catch {
          // One listener's failure must not stop the others.
        }
      }
      return true;
    },
    // Native pushes metrics; there is nothing to re-read. Reports no change.
    refresh() {
      return false;
    },
    dispose() {
      disposed = true;
      listeners.clear();
    },
  };
}
