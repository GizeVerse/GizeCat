// Safe-area insets (src/web/safeArea.ts) and the work area they shape (src/web/display.ts): the
// cat's floor above the home indicator, the origin unchanged, a change of the insets alone reported.
import { describe, expect, it } from 'vitest';
import { simWorld } from '../../../src/core/display/simWorld';
import type { WorldGeometry } from '../../../src/shared/world';
import { createWebDisplayService, RESIZE_DEBOUNCE_MS, viewportDisplay } from '../../../src/web/display';
import { insetsFromPadding, NO_INSETS, readSafeAreaInsets, sameInsets, type Insets } from '../../../src/web/safeArea';
import { manualTime, memoryLogger } from './helpers';

const pad = (t: string, r: string, b: string, l: string) => ({ paddingTop: t, paddingRight: r, paddingBottom: b, paddingLeft: l });

describe('safe-area insets', () => {
  it('reads the probe padding in CSS px; unreadable, negative or absurd values are 0 or clamped', () => {
    expect(insetsFromPadding(pad('24px', '0px', '20px', '0px'))).toEqual({ top: 24, right: 0, bottom: 20, left: 0 });
    expect(insetsFromPadding(pad('', 'auto', '-3px', 'NaNpx'))).toEqual({ top: 0, right: 0, bottom: 0, left: 0 });
    expect(insetsFromPadding(pad('9999px', '0px', '0px', '0px')).top).toBe(400);
    expect(insetsFromPadding(null)).toEqual(NO_INSETS);
  });

  it('never throws: a missing probe or a failing getComputedStyle gives no insets', () => {
    expect(readSafeAreaInsets(null, () => pad('1px', '1px', '1px', '1px'))).toEqual(NO_INSETS);
    expect(
      readSafeAreaInsets({}, () => {
        throw new Error('gone');
      }),
    ).toEqual(NO_INSETS);
    expect(readSafeAreaInsets({}, () => pad('0px', '0px', '34px', '0px')).bottom).toBe(34);
    expect(sameInsets({ top: 1, right: 2, bottom: 3, left: 4 }, { top: 1, right: 2, bottom: 3, left: 4 })).toBe(true);
    expect(sameInsets(NO_INSETS, { ...NO_INSETS, bottom: 1 })).toBe(false);
  });
});

describe('the work area with insets', () => {
  it('shrinks only the height by the bottom inset; bounds and origin stay the viewport', () => {
    const d = viewportDisplay({ width: 834, height: 1194 }, { top: 24, right: 0, bottom: 20, left: 0 });
    expect(d.boundsPx).toEqual({ x: 0, y: 0, width: 834, height: 1194 });
    expect(d.workAreaPx).toEqual({ x: 0, y: 0, width: 834, height: 1174 });
    expect(d.workAreaDip).toEqual(d.workAreaPx);
    // The sim's floor is inside the shrunk work area.
    const floor = simWorld({ version: 1, displays: [d] }).displays[0]!.workAreaPx;
    expect(floor.y + floor.height).toBeLessThanOrEqual(1174);
  });

  it('keeps at least 1 px and ignores broken insets', () => {
    expect(viewportDisplay({ width: 100, height: 50 }, { ...NO_INSETS, bottom: 500 }).workAreaPx.height).toBe(1);
    expect(viewportDisplay({ width: 100, height: 50 }, { ...NO_INSETS, bottom: Number.NaN }).workAreaPx.height).toBe(50);
  });

  it('reports a change of the insets alone (rotation): a new world version with the new work area', () => {
    const time = manualTime();
    let insets: Insets = { ...NO_INSETS, bottom: 20 };
    // Typed through `as`, so the control flow does not narrow it to null (it is assigned in a callback).
    let fire = null as (() => void) | null;
    const svc = createWebDisplayService({
      viewport: () => ({ width: 1194, height: 834 }),
      insets: () => insets,
      listen: (cb) => {
        fire = cb;
        return () => undefined;
      },
      timers: time.timers,
      logger: memoryLogger(),
    });
    const changes: WorldGeometry[] = [];
    svc.onChange((w) => changes.push(w));
    expect(svc.world.displays[0]!.workAreaPx.height).toBe(814);
    insets = { ...NO_INSETS, bottom: 0 };
    fire!();
    time.advance(RESIZE_DEBOUNCE_MS);
    expect(changes).toHaveLength(1);
    expect(changes[0]!.displays[0]!.workAreaPx.height).toBe(834);
    expect(svc.refresh()).toBe(false);
  });

  it('keeps the last good insets when reading them throws', () => {
    let ok = true;
    const svc = createWebDisplayService({
      viewport: () => ({ width: 800, height: 600 }),
      insets: () => {
        if (!ok) throw new Error('gone');
        return { ...NO_INSETS, bottom: 10 };
      },
      listen: () => () => undefined,
      timers: manualTime().timers,
      logger: memoryLogger(),
    });
    ok = false;
    expect(svc.refresh()).toBe(false);
    expect(svc.world.displays[0]!.workAreaPx.height).toBe(590);
  });
});
