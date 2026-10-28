// Display topology bookkeeping: validates raw display data, detects real changes and
// debounces bursts of OS notifications. Platform-agnostic; the host injects the
// display reader and the timer.
import { isFiniteRect } from '../../shared/geometry';
import type { Rect } from '../../shared/geometry';
import type { DisplayGeometry, WorldGeometry } from '../../shared/world';

export interface RawDisplay {
  id: string | number;
  primary: boolean;
  scaleFactor: number;
  boundsDip: Rect;
  workAreaDip: Rect;
  boundsPx: Rect;
  workAreaPx: Rect;
}

const validRect = (r: Rect): boolean => isFiniteRect(r) && r.width > 0 && r.height > 0;
const copyRect = (r: Rect): Rect => ({ x: r.x, y: r.y, width: r.width, height: r.height });

function rectWithin(inner: Rect, outer: Rect): boolean {
  return inner.x >= outer.x && inner.y >= outer.y && inner.x + inner.width <= outer.x + outer.width && inner.y + inner.height <= outer.y + outer.height;
}

/**
 * Drops displays with unusable geometry, de-duplicates ids, guarantees exactly one
 * primary and sorts deterministically (primary first, then left-to-right, top-to-bottom).
 * A work area that is invalid or outside its display falls back to the display bounds.
 */
export function normalizeDisplays(raw: readonly RawDisplay[]): DisplayGeometry[] {
  const seen = new Set<string>();
  const out: DisplayGeometry[] = [];
  for (const r of raw) {
    const id = String(r.id);
    if (seen.has(id) || !validRect(r.boundsDip) || !validRect(r.boundsPx)) continue;
    if (!Number.isFinite(r.scaleFactor) || r.scaleFactor <= 0 || r.scaleFactor > 10) continue;
    seen.add(id);
    const workPxOk = validRect(r.workAreaPx) && rectWithin(r.workAreaPx, r.boundsPx);
    const workDipOk = validRect(r.workAreaDip) && rectWithin(r.workAreaDip, r.boundsDip);
    out.push({
      id,
      primary: r.primary,
      scaleFactor: r.scaleFactor,
      boundsDip: copyRect(r.boundsDip),
      workAreaDip: copyRect(workDipOk ? r.workAreaDip : r.boundsDip),
      boundsPx: copyRect(r.boundsPx),
      workAreaPx: copyRect(workPxOk ? r.workAreaPx : r.boundsPx),
    });
  }
  const primaries = out.filter((d) => d.primary);
  if (primaries.length !== 1 && out.length > 0) {
    // Windows' primary monitor is the one at the virtual-screen origin.
    const chosen = out.find((d) => d.boundsPx.x === 0 && d.boundsPx.y === 0) ?? primaries[0] ?? out[0];
    for (const d of out) d.primary = d === chosen;
  }
  out.sort((a, b) => Number(b.primary) - Number(a.primary) || a.boundsPx.x - b.boundsPx.x || a.boundsPx.y - b.boundsPx.y || (a.id < b.id ? -1 : 1));
  return out;
}

const rectEq = (a: Rect, b: Rect): boolean => a.x === b.x && a.y === b.y && a.width === b.width && a.height === b.height;

export function sameDisplays(a: readonly DisplayGeometry[], b: readonly DisplayGeometry[]): boolean {
  if (a.length !== b.length) return false;
  return a.every((d, i) => {
    const e = b[i];
    return (
      e !== undefined &&
      d.id === e.id &&
      d.primary === e.primary &&
      d.scaleFactor === e.scaleFactor &&
      rectEq(d.boundsDip, e.boundsDip) &&
      rectEq(d.workAreaDip, e.workAreaDip) &&
      rectEq(d.boundsPx, e.boundsPx) &&
      rectEq(d.workAreaPx, e.workAreaPx)
    );
  });
}

export interface TopologyTrackerOptions {
  read: () => readonly RawDisplay[];
  /** Runs `fn` after `ms`; returns a cancel function. */
  schedule: (fn: () => void, ms: number) => () => void;
  debounceMs?: number;
  onError?: (error: unknown) => void;
}

export interface TopologyTracker {
  readonly world: WorldGeometry;
  onChange(cb: (world: WorldGeometry) => void): () => void;
  /** Coalesces OS display notifications; re-reads after `debounceMs` of quiet. */
  notify(): void;
  /** Re-reads now. Returns true when the topology changed (version incremented). */
  refresh(): boolean;
  dispose(): void;
}

export function createTopologyTracker(opts: TopologyTrackerOptions): TopologyTracker {
  const debounceMs = opts.debounceMs ?? 400;
  const listeners = new Set<(world: WorldGeometry) => void>();
  let world: WorldGeometry = { version: 0, displays: [] };
  let cancelPending: (() => void) | null = null;
  let disposed = false;

  const readSafely = (): DisplayGeometry[] | null => {
    try {
      return normalizeDisplays(opts.read());
    } catch (e) {
      opts.onError?.(e);
      return null;
    }
  };

  function refresh(): boolean {
    if (disposed) return false;
    const displays = readSafely();
    // An empty read happens transiently during topology changes: keep the last good world.
    if (displays === null || displays.length === 0) return false;
    if (world.version > 0 && sameDisplays(world.displays, displays)) return false;
    world = { version: world.version + 1, displays };
    for (const cb of [...listeners]) {
      try {
        cb(world);
      } catch (e) {
        opts.onError?.(e);
      }
    }
    return true;
  }

  refresh();

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
    notify() {
      if (disposed) return;
      cancelPending?.();
      cancelPending = opts.schedule(() => {
        cancelPending = null;
        refresh();
      }, debounceMs);
    },
    refresh,
    dispose() {
      disposed = true;
      cancelPending?.();
      cancelPending = null;
      listeners.clear();
    },
  };
}
