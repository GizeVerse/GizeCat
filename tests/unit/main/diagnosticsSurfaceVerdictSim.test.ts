// The surface verdict for layouts whose window sides lead to no usable top (BEH-1): the real
// Sim and Mover, provider-shaped surfaces from the app's own span code, and the production
// assembly (assembleSurfaceDiagnostics) on top. SIMULATED desktop; nothing runs in the app.
import { describe, expect, it } from 'vitest';
import { assembleSurfaceDiagnostics, type AssembledSurfaceDiagnostics } from '../../../src/main/diagnostics/surfaceDiagnostics';
import type { Rect } from '../../../src/shared/geometry';
import { emptySurfaceCounts } from '../../../src/shared/surfaceDiagnostics';
import type { Surface } from '../../../src/shared/surfaces';
import { Harness, providerSurfacesFromWindows, WAKE_MS } from '../core/behavior/fixtures';
import { MIN, USER_SCREEN, userCat } from '../core/behavior/liveness';
import { providerDiagnostics } from './diagnosticsSurfaceFixture';

/** Runs the user's cat among `windows` (front first) for `ms` with the user active; reports whether it ever left the floor and the verdict at the end. */
function verdictFor(windows: Record<string, Rect>, seed: number, ms: number): { left: boolean; assembled: AssembledSurfaceDiagnostics } {
  const h = new Harness({ seed, world: USER_SCREEN, persisted: userCat(seed) });
  const surfaces: Surface[] = providerSurfacesFromWindows(windows, USER_SCREEN, { walls: true, now: 0 });
  const byId = new Map(surfaces.map((s) => [s.id, s] as const));
  h.env.surfaces = surfaces;
  h.env.getSurface = (id) => byId.get(id) ?? null;
  h.run(WAKE_MS, 100);
  let left = false;
  let out = h.step([], 33);
  const end = h.now + ms;
  while (h.now < end) {
    h.env.userIdleMs = h.now % 7000;
    out = h.step([], Math.min(200, Math.max(16, out.nextTickMs)));
    if (out.support.kind !== 'floor') left = true;
  }
  const listed = emptySurfaceCounts();
  for (const s of surfaces) listed[s.kind]++;
  const assembled = assembleSurfaceDiagnostics({
    at: h.now,
    dpiAwareness: 'per-monitor',
    world: USER_SCREEN,
    output: { x: out.x, y: out.y, displayId: out.displayId },
    observers: 'tracked',
    provider: () => providerDiagnostics({ windowsConsidered: Object.keys(windows).length, windowsWithSurfaces: Object.keys(windows).length, skipped: {}, listed, frontMaximized: false }),
    sim: () => h.sim.surfaceDiagnostics(),
  });
  return { left, assembled };
}

const NO_TOP = 'none leads to a window top it can stand on (the tops have no room above them or are not usable).';

describe('surface verdict: window sides that lead to no top (real sim)', () => {
  it('a window snapped to the left half of the screen (its top is the screen edge): the cat never gets up and the verdict says why', () => {
    const { left, assembled } = verdictFor({ w: { x: 0, y: 0, width: 960, height: 1200 } }, 13, 3 * MIN);
    const d = assembled.diagnostics;
    expect(left).toBe(false);
    expect(d.decision.exploreUrge).toBe(0);
    expect(d.nav.accepted).toMatchObject({ windowTop: 0, windowSide: 1, tabStrip: 0 });
    expect(assembled.code).toBe('noWayUp');
    expect(d.verdict).toBe(`The cat knows 1 window side, but ${NO_TOP}`);
  });

  it('a window whose top has no room above it (y = 63): the top is turned down, the sides stay, and the verdict says there is no way up', () => {
    const { left, assembled } = verdictFor({ w: { x: 113, y: 63, width: 1315, height: 1082 } }, 13, 3 * MIN);
    const d = assembled.diagnostics;
    expect(left).toBe(false);
    expect(d.nav.rejected).toMatchObject({ noHeadroom: 1 });
    expect(d.nav.accepted).toMatchObject({ windowTop: 0, windowSide: 2, tabStrip: 0 });
    expect(assembled.code).toBe('noWayUp');
    expect(d.verdict).toBe(`The cat knows 2 window sides, but ${NO_TOP}`);
  });

  it('the snapped window beside a window high up: a top the cat knows but cannot reach, a side that leads nowhere: not "exploring"', () => {
    // ADR 0003 §6.2: a wall jump now bridges a gap within reach of the snapped side, so the high window sits farther off.
    const { left, assembled } = verdictFor({ snap: { x: 0, y: 0, width: 960, height: 1200 }, high: { x: 1720, y: 150, width: 190, height: 300 } }, 13, 3 * MIN);
    const d = assembled.diagnostics;
    expect(left).toBe(false);
    expect(d.nav.accepted.windowTop).toBe(1);
    expect(d.nav.reachable).toMatchObject({ windowTop: 0, tabStrip: 0 });
    expect(d.decision.targets.perch).toBe('unreachable');
    expect(d.decision.targets.climb).toBe('unreachable');
    expect(d.decision.exploreUrge).toBe(0);
    // 'noneReachable' while the snapped window's side is not counted as reachable (it leads to no top);
    // 'noWayUp' if it were (the decision found no way up).
    expect(['noWayUp', 'noneReachable']).toContain(assembled.code);
  });
});
