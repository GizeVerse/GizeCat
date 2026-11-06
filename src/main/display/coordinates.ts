// Electron side of the world-coordinate strategies (ADR 0004 §4). On Windows this is exactly
// the conversion the app always used (screen.dipToScreenRect / dipToScreenPoint, which only
// exist there); elsewhere the pure strategies in src/core/display/coordinates.ts apply.
import type { BrowserWindow, Display, Rectangle } from 'electron';
import { logicalPoint, logicalRawDisplays, logicalRect, type CoordinateStrategy, type DipDisplay } from '../../core/display/coordinates';
import type { RawDisplay } from '../../core/display/topology';
import type { Point, Rect } from '../../shared/geometry';
import type { PlatformId } from '../../shared/platform';

/** The parts of Electron's screen module used here (the dip* methods exist on Windows only). */
export interface ScreenLike {
  getAllDisplays(): Display[];
  getPrimaryDisplay(): Display;
  getCursorScreenPoint(): Point;
  dipToScreenRect?: (window: BrowserWindow | null, rect: Rectangle) => Rectangle;
  dipToScreenPoint?: (point: Point) => Point;
}

export interface DisplayCoordinates {
  readonly platform: PlatformId;
  readonly strategy: CoordinateStrategy;
  /** Every display as topology input (DIP and world px). Throws when the OS read fails. */
  readDisplays(): RawDisplay[];
  /** The cursor in world px from Electron's screen module (the fallback when no native cursor exists). */
  cursorFallback(): Point | null;
  /** A DIP rect (of `win`'s display, or the screen when null) in world px. */
  rectToWorld(win: BrowserWindow | null, rect: Rect): Rect;
}

const rectOf = (r: Rectangle): Rect => ({ x: r.x, y: r.y, width: r.width, height: r.height });

function dipDisplays(screen: ScreenLike): DipDisplay[] {
  const primaryId = screen.getPrimaryDisplay().id;
  return screen.getAllDisplays().map((d) => ({
    id: String(d.id),
    primary: d.id === primaryId,
    scaleFactor: d.scaleFactor,
    boundsDip: rectOf(d.bounds),
    workAreaDip: rectOf(d.workArea),
  }));
}

function createWin32Coordinates(screen: ScreenLike): DisplayCoordinates {
  const toRect = (win: BrowserWindow | null, r: Rect): Rect => {
    if (!screen.dipToScreenRect) throw new Error('screen.dipToScreenRect is unavailable');
    return rectOf(screen.dipToScreenRect(win, r));
  };
  return {
    platform: 'win32',
    strategy: 'win32-physical',
    readDisplays() {
      // Unchanged since v1.0: dipToScreenRect(null, rect) scales relative to the display
      // nearest to the rect (correct for mixed-DPI layouts).
      const primaryId = screen.getPrimaryDisplay().id;
      return screen.getAllDisplays().map((d: Display) => ({
        id: String(d.id),
        primary: d.id === primaryId,
        scaleFactor: d.scaleFactor,
        boundsDip: rectOf(d.bounds),
        workAreaDip: rectOf(d.workArea),
        boundsPx: toRect(null, d.bounds),
        workAreaPx: toRect(null, d.workArea),
      }));
    },
    cursorFallback() {
      if (!screen.dipToScreenPoint) return null;
      return screen.dipToScreenPoint(screen.getCursorScreenPoint());
    },
    rectToWorld: toRect,
  };
}

/** Every platform but Windows: the logical world (px = DIP), see src/core/display/coordinates.ts. */
function createLogicalCoordinates(platform: PlatformId, screen: ScreenLike): DisplayCoordinates {
  return {
    platform,
    strategy: 'logical',
    readDisplays: () => logicalRawDisplays(dipDisplays(screen)),
    cursorFallback: () => logicalPoint(screen.getCursorScreenPoint()),
    rectToWorld: (_win, rect) => logicalRect(rect),
  };
}

export function createDisplayCoordinates(platform: PlatformId, screen: ScreenLike): DisplayCoordinates {
  return platform === 'win32' ? createWin32Coordinates(screen) : createLogicalCoordinates(platform, screen);
}
