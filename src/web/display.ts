// The web host's display service (ADR 0004 §4, §8): one display, the browser viewport, in the
// logical world (world px = CSS px, scaleFactor 1). The renderer sizes its canvas from
// devicePixelRatio, so the cat stays sharp on high-DPI screens. Resizes are debounced and reported
// once the viewport settles; a size that did not change is not reported.
import { displayAtPoint, localDipToPx, pxToLocalDip } from '../core/display/displayMath';
import type { Point, Rect } from '../shared/geometry';
import type { DisplayGeometry, WorldGeometry } from '../shared/world';
import type { DisplayService, Logger, Unsubscribe } from '../main/contracts';

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
  /** The viewport size in CSS px (window.innerWidth / innerHeight). */
  viewport: () => Viewport;
  /** Calls `cb` whenever the viewport may have changed (window resize); returns the unsubscribe. */
  listen: (cb: () => void) => Unsubscribe;
  timers: WebDisplayTimers;
  logger?: Logger;
  debounceMs?: number;
}

const side = (v: number): number => (Number.isFinite(v) ? Math.min(MAX_SIDE_PX, Math.max(1, Math.round(v))) : 1);

/** The viewport as the world's only display (bounds = work area; nothing is reserved). */
export function viewportDisplay(v: Viewport): DisplayGeometry {
  const r: Rect = { x: 0, y: 0, width: side(v.width), height: side(v.height) };
  return { id: WEB_DISPLAY_ID, primary: true, scaleFactor: 1, boundsDip: { ...r }, workAreaDip: { ...r }, boundsPx: { ...r }, workAreaPx: { ...r } };
}

const sameRect = (a: Rect, b: Rect): boolean => a.x === b.x && a.y === b.y && a.width === b.width && a.height === b.height;

export function createWebDisplayService(opts: WebDisplayOptions): DisplayService {
  const log = opts.logger;
  const debounceMs = opts.debounceMs ?? RESIZE_DEBOUNCE_MS;
  const listeners = new Set<(world: WorldGeometry) => void>();
  let last: Viewport = { width: 1, height: 1 };
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
    return last;
  }

  let world: WorldGeometry = { version, displays: [viewportDisplay(read())] };

  function current(): DisplayGeometry {
    return world.displays[0] ?? viewportDisplay(last);
  }

  function refresh(): boolean {
    if (disposed) return false;
    const next = viewportDisplay(read());
    if (sameRect(current().boundsPx, next.boundsPx)) return false;
    version++;
    world = { version, displays: [next] };
    log?.info('viewport changed', { width: next.boundsPx.width, height: next.boundsPx.height, version });
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
