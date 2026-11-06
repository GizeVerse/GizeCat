// DisplayService (src/main/contracts.ts) over Electron's screen module. Create it after
// app 'ready'. World rects come from the platform's coordinate strategy (ADR 0004 §4): on
// Windows screen.dipToScreenRect(null, rect), which scales relative to the display nearest to
// the rect (correct for mixed-DPI layouts), as since v1.0.
import { screen } from 'electron';
import { displayAtPoint, findDisplay, localDipToPx, nearestDisplay, primaryDisplay, pxToLocalDip } from '../../core/display/displayMath';
import { createTopologyTracker } from '../../core/display/topology';
import type { RawDisplay } from '../../core/display/topology';
import type { Point } from '../../shared/geometry';
import type { WorldGeometry } from '../../shared/world';
import type { DisplayService, Logger, Unsubscribe } from '../contracts';
import { createDisplayCoordinates, type DisplayCoordinates } from './coordinates';

export interface DisplayServiceExtras {
  /** Re-reads the topology immediately (e.g. after resume). Returns true if it changed. */
  refresh(): boolean;
}

const DEBOUNCE_MS = 400;

const describe = (w: WorldGeometry, strategy: string): Record<string, unknown> => ({
  version: w.version,
  coordinates: strategy,
  displays: w.displays.map((d) => ({ id: d.id, primary: d.primary, scale: d.scaleFactor, boundsPx: d.boundsPx, workAreaPx: d.workAreaPx })),
});

/** `coordinates` defaults to the Windows strategy (the only one before GizeVerse). */
export function createDisplayService(logger: Logger, coordinates: DisplayCoordinates = createDisplayCoordinates('win32', screen)): DisplayService & DisplayServiceExtras {
  const log = logger.child('display');
  const readDisplays = (): RawDisplay[] => coordinates.readDisplays();
  const tracker = createTopologyTracker({
    read: readDisplays,
    schedule: (fn, ms) => {
      const t = setTimeout(fn, ms);
      return () => clearTimeout(t);
    },
    debounceMs: DEBOUNCE_MS,
    onError: (e) => log.warn('display topology read failed', { error: e instanceof Error ? e.message : String(e) }),
  });

  if (tracker.world.displays.length === 0) log.error('no usable display found at startup');
  else log.info('display topology', describe(tracker.world, coordinates.strategy));
  const offChange = tracker.onChange((w) => log.info('display topology changed', describe(w, coordinates.strategy)));

  const onScreenEvent = (): void => tracker.notify();
  screen.on('display-added', onScreenEvent);
  screen.on('display-removed', onScreenEvent);
  screen.on('display-metrics-changed', onScreenEvent);

  return {
    get world() {
      return tracker.world;
    },
    onChange(cb: (world: WorldGeometry) => void): Unsubscribe {
      return tracker.onChange(cb);
    },
    toLocalDip(displayId: string, p: Point): Point {
      const displays = tracker.world.displays;
      const d = findDisplay(displays, displayId) ?? nearestDisplay(displays, p);
      return d ? pxToLocalDip(d, p) : { x: p.x, y: p.y };
    },
    fromLocalDip(displayId: string, p: Point): Point {
      const displays = tracker.world.displays;
      const d = findDisplay(displays, displayId) ?? primaryDisplay(displays);
      return d ? localDipToPx(d, p) : { x: p.x, y: p.y };
    },
    displayAt(p: Point): string | null {
      return displayAtPoint(tracker.world.displays, p)?.id ?? null;
    },
    refresh: () => tracker.refresh(),
    dispose() {
      screen.removeListener('display-added', onScreenEvent);
      screen.removeListener('display-removed', onScreenEvent);
      screen.removeListener('display-metrics-changed', onScreenEvent);
      offChange();
      tracker.dispose();
    },
  };
}
