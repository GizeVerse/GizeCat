import type { WorldGeometry } from '../../shared/world';

/** How far above the work-area bottom the cat's floor sits, so paws and shadow are never clipped. */
export const FLOOR_INSET_DIP = 4;

/**
 * The world as the simulation should see it: each work area is shortened at the
 * bottom by FLOOR_INSET_DIP (in that display's DIP). With an auto-hidden taskbar the
 * work area reaches the screen edge, and a floor exactly on the last pixel row would
 * clip the cat's paws and shadow. Overlays still cover the full work area.
 */
export function simWorld(world: WorldGeometry, insetDip = FLOOR_INSET_DIP): WorldGeometry {
  return {
    version: world.version,
    displays: world.displays.map((d) => {
      const insetPx = Math.min(Math.round(insetDip * d.scaleFactor), Math.max(0, d.workAreaPx.height - 1));
      const insetDipClamped = Math.min(insetDip, Math.max(0, d.workAreaDip.height - 1));
      return {
        ...d,
        workAreaPx: { ...d.workAreaPx, height: d.workAreaPx.height - insetPx },
        workAreaDip: { ...d.workAreaDip, height: d.workAreaDip.height - insetDipClamped },
      };
    }),
  };
}
