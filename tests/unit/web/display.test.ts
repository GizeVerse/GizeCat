// The web host's display service (src/web/display.ts): the viewport as one logical display.
import { describe, expect, it } from 'vitest';
import { simWorld } from '../../../src/core/display/simWorld';
import type { WorldGeometry } from '../../../src/shared/world';
import { createWebDisplayService, RESIZE_DEBOUNCE_MS, viewportDisplay, WEB_DISPLAY_ID, type Viewport } from '../../../src/web/display';
import { manualTime, memoryLogger } from './helpers';

function setup(initial: Viewport = { width: 1280, height: 720 }) {
  const time = manualTime();
  let vp: Viewport | (() => Viewport) = initial;
  let fire: (() => void) | null = null;
  let unsubscribed = false;
  const svc = createWebDisplayService({
    viewport: () => (typeof vp === 'function' ? vp() : vp),
    listen: (cb) => {
      fire = cb;
      return () => {
        unsubscribed = true;
      };
    },
    timers: time.timers,
    logger: memoryLogger(),
  });
  const changes: WorldGeometry[] = [];
  svc.onChange((w) => changes.push(w));
  return {
    svc,
    time,
    changes,
    resize(next: Viewport | (() => Viewport)) {
      vp = next;
      fire?.();
    },
    get unsubscribed() {
      return unsubscribed;
    },
  };
}

describe('web display service', () => {
  it('is one logical display: the viewport, scale 1, bounds = work area, origin top-left', () => {
    const { svc } = setup({ width: 1280, height: 720 });
    expect(svc.world.displays).toHaveLength(1);
    const d = svc.world.displays[0]!;
    const r = { x: 0, y: 0, width: 1280, height: 720 };
    expect(d).toEqual({ id: WEB_DISPLAY_ID, primary: true, scaleFactor: 1, boundsDip: r, workAreaDip: r, boundsPx: r, workAreaPx: r });
    // The sim stands the cat a few px above the bottom of the viewport.
    expect(simWorld(svc.world).displays[0]!.workAreaPx.height).toBeLessThan(720);
  });

  it('maps world px and overlay-local DIP one to one, and finds the display under a point', () => {
    const { svc } = setup();
    expect(svc.toLocalDip(WEB_DISPLAY_ID, { x: 321.5, y: 640 })).toEqual({ x: 321.5, y: 640 });
    expect(svc.fromLocalDip(WEB_DISPLAY_ID, { x: 10, y: 20 })).toEqual({ x: 10, y: 20 });
    expect(svc.displayAt({ x: 5, y: 5 })).toBe(WEB_DISPLAY_ID);
    expect(svc.displayAt({ x: 1280, y: 5 })).toBeNull();
    expect(svc.displayAt({ x: -1, y: 5 })).toBeNull();
  });

  it('debounces resizes into one change with a new version, and ignores a resize back to the same size', () => {
    const h = setup();
    const v0 = h.svc.world.version;
    h.resize({ width: 1000, height: 700 });
    h.time.advance(50);
    h.resize({ width: 900, height: 650 });
    h.time.advance(RESIZE_DEBOUNCE_MS - 1);
    expect(h.changes).toHaveLength(0);
    h.time.advance(1);
    expect(h.changes).toHaveLength(1);
    expect(h.changes[0]!.version).toBe(v0 + 1);
    expect(h.changes[0]!.displays[0]!.workAreaPx).toEqual({ x: 0, y: 0, width: 900, height: 650 });
    h.resize({ width: 900, height: 650 });
    h.time.advance(RESIZE_DEBOUNCE_MS);
    expect(h.changes).toHaveLength(1);
  });

  it('refresh() reports whether the viewport changed', () => {
    const h = setup();
    expect(h.svc.refresh()).toBe(false);
    h.resize({ width: 800, height: 600 });
    expect(h.svc.refresh()).toBe(true);
    expect(h.changes).toHaveLength(1);
  });

  it('clamps broken viewport readings and keeps the last good one when reading throws', () => {
    expect(viewportDisplay({ width: Number.NaN, height: 0 }).boundsPx).toEqual({ x: 0, y: 0, width: 1, height: 1 });
    expect(viewportDisplay({ width: 1e9, height: 100.4 }).boundsPx).toEqual({ x: 0, y: 0, width: 100_000, height: 100 });
    const h = setup({ width: 640, height: 480 });
    h.resize(() => {
      throw new Error('gone');
    });
    expect(h.svc.refresh()).toBe(false);
    expect(h.svc.world.displays[0]!.boundsPx.width).toBe(640);
  });

  it('stops listening on dispose', () => {
    const h = setup();
    h.svc.dispose();
    expect(h.unsubscribed).toBe(true);
    h.resize({ width: 10, height: 10 });
    h.time.advance(RESIZE_DEBOUNCE_MS * 2);
    expect(h.changes).toHaveLength(0);
  });
});
