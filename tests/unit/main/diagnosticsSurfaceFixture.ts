// A fully populated SurfaceDiagnostics (every field, every array non-empty) for the
// v1.1.1 surface diagnostics tests. SIMULATED values: counts and geometry only.
import type { DecisionDiagnostics, NavDiagnostics, ProviderDiagnostics, SurfaceDiagnostics } from '../../../src/shared/surfaceDiagnostics';

export function providerDiagnostics(over: Partial<ProviderDiagnostics> = {}): ProviderDiagnostics {
  return {
    windowsConsidered: 6,
    windowsWithSurfaces: 3,
    skipped: { maximized: 2, covered: 1 },
    listed: { taskbar: 1, windowTop: 3, windowSide: 6, tabStrip: 1 },
    lastRefreshAt: 9_500,
    frontMaximized: false,
    tabStrips: { state: 'active', helperRunning: true, interest: 1, strips: 1, reads: 12, errors: 1, lastReadAt: 9_000, lastRejection: 'noHeadroom' },
    recentErrors: [
      { at: 4_000, source: 'uia', kind: 'timeout' },
      { at: 8_000, source: 'tracker', kind: 'enumFailed' },
    ],
    ...over,
  };
}

export function navDiagnostics(over: Partial<NavDiagnostics> = {}): NavDiagnostics {
  return {
    received: { taskbar: 1, windowTop: 3, windowSide: 6, tabStrip: 1 },
    accepted: { taskbar: 1, windowTop: 2, windowSide: 4, tabStrip: 1 },
    rejected: { nearFloor: 1, noRoomBeside: 2 },
    reachable: { taskbar: 1, windowTop: 1, windowSide: 2, tabStrip: 0 },
    graph: { nodes: 14, edges: 22, updates: 40, rebuilds: 3 },
    climbs: { leaps: 2, mounts: 1, pulledUp: 2, reversed: 1, letGo: 0, topReResolved: 1 },
    ...over,
  };
}

export function decisionDiagnostics(over: Partial<DecisionDiagnostics> = {}): DecisionDiagnostics {
  return {
    state: 'walking',
    support: 'floor',
    targetKind: 'windowTop',
    targets: { perch: 'available', climb: 'available', tabStrip: 'unreachable' },
    exploreUrge: 0.35,
    lastElevatedAt: 120_000,
    excursions: 2,
    ...over,
  };
}

export function fullDiagnostics(): SurfaceDiagnostics {
  return {
    at: 10_000,
    coordinates: {
      dpiAwareness: 'per-monitor',
      displays: [
        {
          id: '2528732444',
          primary: true,
          scale: 1.25,
          boundsPx: { x: 0, y: 0, width: 1920, height: 1200 },
          workAreaPx: { x: 0, y: 0, width: 1920, height: 1200 },
          workAreaDip: { x: 0, y: 0, width: 1536, height: 960 },
        },
      ],
      cat: { displayId: '2528732444', xPx: 812, yPx: 1195, floorYPx: 1195 },
    },
    provider: providerDiagnostics(),
    nav: navDiagnostics(),
    decision: decisionDiagnostics(),
    verdict: 'The cat can reach 1 window top and 2 window sides from where it is; its urge to explore is 35%.',
  };
}
