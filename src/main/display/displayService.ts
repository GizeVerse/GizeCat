// DisplayService (src/main/contracts.ts) over Electron's screen module. Create it after
// app 'ready'. Physical rects come from screen.dipToScreenRect(null, rect), which scales
// relative to the display nearest to the rect (correct for mixed-DPI layouts).
import { screen } from 'electron';
import type { Display, Rectangle } from 'electron';
import { displayAtPoint, findDisplay, localDipToPx, nearestDisplay, primaryDisplay, pxToLocalDip } from '../../core/display/displayMath';
import { createTopologyTracker } from '../../core/display/topology';
import type { RawDisplay } from '../../core/display/topology';
import type { Point, Rect } from '../../shared/geometry';
import type { WorldGeometry } from '../../shared/world';
import type { DisplayService, Logger, Unsubscribe } from '../contracts';

export interface DisplayServiceExtras {
  /** Re-reads the topology immediately (e.g. after resume). Returns true if it changed. */
  refresh(): boolean;
}

const DEBOUNCE_MS = 400;

const rectOf = (r: Rectangle): Rect => ({ x: r.x, y: r.y, width: r.width, height: r.height });

function readDisplays(): RawDisplay[] {
  const primaryId = screen.getPrimaryDisplay().id;
  return screen.getAllDisplays().map((d: Display) => ({
    id: String(d.id),
    primary: d.id === primaryId,
    scaleFactor: d.scaleFactor,
    boundsDip: rectOf(d.bounds),
    workAreaDip: rectOf(d.workArea),
    boundsPx: rectOf(screen.dipToScreenRect(null, d.bounds)),
    workAreaPx: rectOf(screen.dipToScreenRect(null, d.workArea)),
  }));
}

const describe = (w: WorldGeometry): Record<string, unknown> => ({
  version: w.version,
  displays: w.displays.map((d) => ({ id: d.id, primary: d.primary, scale: d.scaleFactor, boundsPx: d.boundsPx, workAreaPx: d.workAreaPx })),
});

export function createDisplayService(logger: Logger): DisplayService & DisplayServiceExtras {
  const log = logger.child('display');
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
  else log.info('display topology', describe(tracker.world));
  const offChange = tracker.onChange((w) => log.info('display topology changed', describe(w)));

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
