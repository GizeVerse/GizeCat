// Which overlays to create, recreate or remove after a display topology change.
// Overlays are recreated rather than re-bounded when their display's scale or
// bounds change, because setBounds on transparent windows across DPI is unreliable.
import type { Rect } from '../../shared/geometry';
import type { DisplayGeometry } from '../../shared/world';

export function boundsDiffer(a: Rect, b: Rect, tolerance = 1): boolean {
  return (
    Math.abs(a.x - b.x) > tolerance ||
    Math.abs(a.y - b.y) > tolerance ||
    Math.abs(a.width - b.width) > tolerance ||
    Math.abs(a.height - b.height) > tolerance
  );
}

export function geometryChanged(prev: DisplayGeometry, next: DisplayGeometry): boolean {
  return (
    prev.scaleFactor !== next.scaleFactor ||
    boundsDiffer(prev.workAreaDip, next.workAreaDip, 0) ||
    boundsDiffer(prev.boundsDip, next.boundsDip, 0)
  );
}

export interface OverlaySyncPlan {
  create: DisplayGeometry[];
  recreate: DisplayGeometry[];
  /** Same window, refreshed geometry (e.g. only physical px or primary flag changed). */
  keep: DisplayGeometry[];
  remove: string[];
}

export function planOverlaySync(existing: ReadonlyMap<string, DisplayGeometry>, displays: readonly DisplayGeometry[]): OverlaySyncPlan {
  const plan: OverlaySyncPlan = { create: [], recreate: [], keep: [], remove: [] };
  const seen = new Set<string>();
  for (const d of displays) {
    if (seen.has(d.id)) continue;
    seen.add(d.id);
    const prev = existing.get(d.id);
    if (!prev) plan.create.push(d);
    else if (geometryChanged(prev, d)) plan.recreate.push(d);
    else plan.keep.push(d);
  }
  for (const id of existing.keys()) if (!seen.has(id)) plan.remove.push(id);
  return plan;
}

/** Recreation budget for crashed overlays: at most `max` within `windowMs`, exponential backoff. */
export function crashBackoff(history: readonly number[], now: number, max = 5, windowMs = 10 * 60_000): { allowed: boolean; delayMs: number; recent: number[] } {
  const recent = history.filter((t) => now - t < windowMs);
  if (recent.length >= max) return { allowed: false, delayMs: 0, recent };
  const delayMs = Math.min(30_000, 1000 * 2 ** recent.length);
  return { allowed: true, delayMs, recent: [...recent, now] };
}
