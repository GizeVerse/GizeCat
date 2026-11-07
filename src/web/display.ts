// The web host's display service (ADR 0004 §4, §8): one display, the browser viewport, in the
// logical world (world px = CSS px, scaleFactor 1). The renderer sizes its canvas from
// devicePixelRatio, so the cat stays sharp on high-DPI screens. Resizes are debounced and reported
// once the viewport settles; a size that did not change is not reported.
//
// 1.4.0 (tablets): the work area is the viewport minus the bottom safe-area inset (the home
// indicator or gesture bar), so the cat's floor sits above it. Only the height shrinks: the work
// area's origin stays at the viewport's (0, 0), because displayMath puts the overlay's CSS origin at
// the work area's origin. Left, right and top insets are not modelled for the cat (the toolbar and
// the sheet pad themselves in CSS). A change of the insets alone is reported like a resize.
import { displayAtPoint, localDipToPx, pxToLocalDip } from '../core/display/displayMath';
import type { Point, Rect } from '../shared/geometry';
import type { DisplayGeometry, WorldGeometry } from '../shared/world';
import type { DisplayService, Logger, Unsubscribe } from '../main/contracts';
import { NO_INSETS, type Insets } from './safeArea';

export const WEB_DISPLAY_ID = 'web';
export const RESIZE_DEBOUNCE_MS = 150;
/** Upper bound for a viewport side (CSS px); larger or broken readings are clamped. */
const MAX_SIDE_PX = 100_000;

export interface Viewport {
  width: number;
  height: number;
}

export interface WebDisplayTimers {
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}

export interface WebDisplayOptions {
  /** The viewport size in CSS px (the layout viewport: documentElement.clientWidth / clientHeight). */
  viewport: () => Viewport;
  /** Safe-area insets in CSS px (safeArea.ts); absent = none. Only the bottom one shapes the work area. */
  insets?: () => Insets;
  /** Calls `cb` whenever the viewport may have changed (window resize); returns the unsubscribe. */
  listen: (cb: () => void) => Unsubscribe;
  timers: WebDisplayTimers;
  logger?: Logger;
  debounceMs?: number;
}

const side = (v: number): number => (Number.isFinite(v) ? Math.min(MAX_SIDE_PX, Math.max(1, Math.round(v))) : 1);

/**
 * The viewport as the world's only display: bounds = the viewport; the work area = the viewport
 * minus the bottom safe-area inset (without insets, the same as the bounds). At least 1 px stays.
 */
export function viewportDisplay(v: Viewport, insets: Insets = NO_INSETS): DisplayGeometry {
  const r: Rect = { x: 0, y: 0, width: side(v.width), height: side(v.height) };
  const bottom = Number.isFinite(insets.bottom) ? Math.min(r.height - 1, Math.max(0, Math.round(insets.bottom))) : 0;
  const work: Rect = { x: 0, y: 0, width: r.width, height: r.height - bottom };
  return { id: WEB_DISPLAY_ID, primary: true, scaleFactor: 1, boundsDip: { ...r }, workAreaDip: { ...work }, boundsPx: { ...r }, workAreaPx: { ...work } };
}

const sameRect = (a: Rect, b: Rect): boolean => a.x === b.x && a.y === b.y && a.width === b.width && a.height === b.height;

export function createWebDisplayService(opts: WebDisplayOptions): DisplayService {
  const log = opts.logger;
  const debounceMs = opts.debounceMs ?? RESIZE_DEBOUNCE_MS;
  const listeners = new Set<(world: WorldGeometry) => void>();
  let last: Viewport = { width: 1, height: 1 };
  let lastInsets: Insets = { ...NO_INSETS };
  let version = 1;
  let timer: unknown = null;
  let disposed = false;

  function read(): Viewport {
    try {
      const v = opts.viewport();
      last = { width: v.width, height: v.height };
    } catch (err) {
      log?.warn('reading the viewport failed', { error: err });
    }
    if (opts.insets) {
      try {
        const i = opts.insets();
        lastInsets = { top: i.top, right: i.right, bottom: i.bottom, left: i.left };
      } catch (err) {
        log?.warn('reading the safe-area insets failed', { error: err });
      }
    }
    return last;
  }

  let world: WorldGeometry = { version, displays: [viewportDisplay(read(), lastInsets)] };

  function current(): DisplayGeometry {
    return world.displays[0] ?? viewportDisplay(last, lastInsets);
  }

  function refresh(): boolean {
    if (disposed) return false;
    const v = read();
    const next = viewportDisplay(v, lastInsets);
    const cur = current();
    // The insets alone can change (rotation, a keyboard dock): the work area is compared too.
    if (sameRect(cur.boundsPx, next.boundsPx) && sameRect(cur.workAreaPx, next.workAreaPx)) return false;
    version++;
    world = { version, displays: [next] };
    log?.info('viewport changed', { width: next.boundsPx.width, height: next.boundsPx.height, workAreaHeight: next.workAreaPx.height, version });
    for (const cb of [...listeners]) {
      try {
        cb(world);
      } catch (err) {
        log?.error('display change listener failed', { error: err });
      }
    }
    return true;
  }

  const offListen = opts.listen(() => {
    if (disposed) return;
    if (timer !== null) opts.timers.clearTimeout(timer);
    timer = opts.timers.setTimeout(() => {
      timer = null;
      refresh();
    }, debounceMs);
  });

  return {
    get world() {
      return world;
    },
    onChange(cb) {
      listeners.add(cb);
      return () => {
        listeners.delete(cb);
      };
    },
    toLocalDip(_displayId: string, p: Point): Point {
      return pxToLocalDip(current(), p);
    },
    fromLocalDip(_displayId: string, p: Point): Point {
      return localDipToPx(current(), p);
    },
    displayAt(p: Point): string | null {
      return displayAtPoint(world.displays, p)?.id ?? null;
    },
    refresh,
    dispose() {
      disposed = true;
      if (timer !== null) opts.timers.clearTimeout(timer);
      timer = null;
      listeners.clear();
      try {
        offListen();
      } catch {
        // Nothing left to undo.
      }
    },
  };
}
