// The floating cat's surface provider (Android, 1.4.2): no windows, taskbars or tab strips (an app
// cannot see other apps' windows), only the SCREEN's own edges. The engine already knows how to
// walk the floor, mount an outer screen edge at the corner, climb it, hold, and come off again (its
// v1.2 screen-edge climb, derived from the world geometry); it only needs the host to say that the
// edges may be climbed. On the desktop that permission is the Win32 click guard (nothing under a
// clinging cat may be covered); on the phone the cat's window takes only the cat's own touches, so
// there is nothing to guard, and this provider declares the edges guardless (HostSurfaceProvider.
// guardlessScreenEdges), full height on both sides, and visited often enough to be seen.
//
// Honest scope: the floor (bottom edge), the left and right edges and the corners where they meet
// the floor. The top edge is reached by the climb (it ends below the top clearance) but there is
// no ceiling pose, so the cat does not walk along it. Other apps' windows and tabs are not
// surfaces: they are invisible to an app.
//
// Pure: no DOM types.
import type { HostSurfaceProvider } from '../main/catHost';
import type { DisplayService } from '../main/contracts';
import type { ProviderDiagnostics } from '../shared/surfaceDiagnostics';
import type { ScreenEdgeBand } from '../shared/surfaces';

/** Pause between edge visits relative to the desktop's 4 to 8 minutes: about 30 to 60 seconds at 0.125. */
export const ANDROID_EDGE_COOLDOWN_SCALE = 0.125;

const EMPTY_DIAGNOSTICS: ProviderDiagnostics = {
  windowsConsidered: 0,
  windowsWithSurfaces: 0,
  skipped: {},
  listed: { taskbar: 0, windowTop: 0, windowSide: 0, tabStrip: 0 },
  lastRefreshAt: 0,
  frontMaximized: false,
  tabStrips: { state: 'unavailable', helperRunning: false, interest: 0, strips: 0, reads: 0, errors: 0, lastReadAt: 0, lastRejection: null },
  recentErrors: [],
};

export interface ScreenEdgeProviderOptions {
  /** The pause scale between edge visits, read each tick (a battery or movement setting may change it). */
  cooldownScale?: () => number;
}

export function createScreenEdgeProvider(display: Pick<DisplayService, 'world'>, opts: ScreenEdgeProviderOptions = {}): HostSurfaceProvider {
  return {
    status: { taskbar: 'unavailable', taskbars: 0, windowSurfaces: 'unavailable', tabStrips: 'unavailable', tabStripReason: null },
    getSurfaces: () => [],
    getSurface: () => null,
    drainEvents: () => [],
    updateSettings: () => undefined,
    debugInfo: () => ({ provider: 'screen-edges' }),
    diagnostics: () => EMPTY_DIAGNOSTICS,
    dispose: () => Promise.resolve(),
    /** Both outer edges of every display, clear along the whole work area (nothing is ever underneath). */
    edgeBands(): readonly ScreenEdgeBand[] {
      const bands: ScreenEdgeBand[] = [];
      for (const d of display.world.displays) {
        const work = d.workAreaPx;
        if (!(work.height > 0)) continue;
        const span = { y0: work.y, y1: work.y + work.height };
        bands.push({ displayId: d.id, side: 'left', clearSpans: [span] }, { displayId: d.id, side: 'right', clearSpans: [span] });
      }
      return bands;
    },
    get guardlessScreenEdges() {
      const scale = opts.cooldownScale?.() ?? ANDROID_EDGE_COOLDOWN_SCALE;
      return { fullBothSides: true, cooldownScale: Number.isFinite(scale) ? scale : ANDROID_EDGE_COOLDOWN_SCALE };
    },
  };
}
