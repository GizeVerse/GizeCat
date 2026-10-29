// Window surfaces built the way the app's provider builds them (src/main/surfaces): DWM frames
// in z-order (front first), each cut by the ones in front of it, with the provider's default
// options (Windows 11 corners, 96 DIP minimum side, 40 DIP clearance), in REAL display space.
// The sim sees the same displays shortened by the floor inset (simWorld), as in the app.
import type { Rect } from '../../../../src/shared/geometry';
import type { Surface } from '../../../../src/shared/surfaces';
import type { DisplayGeometry } from '../../../../src/shared/world';
import { buildWindowSurfaces, computeOpenSpans, type SurfaceMeta, type WindowSurfaceOptions } from '../../../../src/main/surfaces/windowSurfaces';

/** src/main/surfaces/provider.ts defaults on Windows 11. */
export const PROVIDER_OPTS: WindowSurfaceOptions = { cornerRadiusDip: 8, minLedgeWidthPx: 80, minWallHeightDip: 96, wallClearanceDip: 40, climbWindows: true };

const META: SurfaceMeta = { phase: 'stable', confidence: 1, validatedAt: 0, excluded: false, vx: 0, vy: 0, vxRight: 0 };

/** Listed surfaces (top ledge, then left and right sides) of windows given front to back. */
export function providerSurfaces(windows: ReadonlyArray<readonly [string, Rect]>, displays: readonly DisplayGeometry[], opts: WindowSurfaceOptions = PROVIDER_OPTS): Surface[] {
  const out: Surface[] = [];
  const above: Rect[] = [];
  for (const [id, rect] of windows) {
    const spans = computeOpenSpans(rect, above, displays, opts);
    const b = buildWindowSurfaces(id, rect, spans, displays, META, null, null);
    for (const s of [b.top, b.left, b.right]) if (s) out.push(s);
    above.push(rect);
  }
  return out;
}
