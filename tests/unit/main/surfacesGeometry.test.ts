// Pure window-surface geometry and the injected-surface validator.
import { describe, expect, it } from 'vitest';
import { parseInjectedSurfaces } from '../../../src/main/surfaces';
import {
  bareWindowSurface,
  buildWindowSurfaces,
  computeOpenSpans,
  coversWorkArea,
  defaultCornerRadiusDip,
  offersSurfaces,
  parseSurfaceId,
  pickSpan,
  type SurfaceMeta,
  type WindowSurfaceOptions,
} from '../../../src/main/surfaces/windowSurfaces';
import type { DisplayGeometry } from '../../../src/shared/world';

const rect = (x: number, y: number, width: number, height: number) => ({ x, y, width, height });

function disp(id: string, x: number, y: number, w: number, h: number, scale = 1, workH = h): DisplayGeometry {
  const b = rect(x, y, w, h);
  const wa = rect(x, y, w, workH);
  return { id, primary: id === '1', scaleFactor: scale, boundsDip: b, workAreaDip: wa, boundsPx: b, workAreaPx: wa };
}

const OPTS: WindowSurfaceOptions = { cornerRadiusDip: 8, minLedgeWidthPx: 80, minWallHeightDip: 96, wallClearanceDip: 40, climbWindows: true };
const META: SurfaceMeta = { phase: 'stable', confidence: 1, validatedAt: 5, excluded: false, vx: 0, vy: 0, vxRight: 0 };

describe('surface ids', () => {
  it('parses the documented id shapes only', () => {
    expect(parseSurfaceId('windowTop:132')).toEqual({ kind: 'windowTop', owner: '132' });
    expect(parseSurfaceId('tabStrip:132')).toEqual({ kind: 'tabStrip', owner: '132' });
    expect(parseSurfaceId('taskbar:65552')).toEqual({ kind: 'taskbar', owner: '65552' });
    expect(parseSurfaceId('windowSide:132:left')).toEqual({ kind: 'windowSide', owner: '132', side: 'left' });
    for (const bad of ['', 'windowTop', 'windowTop:', 'windowSide:1', 'windowSide:1:top', 'windowTop:1:2', 'floor:1', ':1']) expect(parseSurfaceId(bad), bad).toBeNull();
  });

  it('uses rounded-corner insets on Windows 11 builds only', () => {
    expect(defaultCornerRadiusDip('10.0.26200')).toBe(8);
    expect(defaultCornerRadiusDip('10.0.22000')).toBe(8);
    expect(defaultCornerRadiusDip('10.0.19045')).toBe(0);
    expect(defaultCornerRadiusDip('garbage')).toBe(0);
  });
});

describe('span selection', () => {
  const spans = [
    [0, 100],
    [150, 400],
  ] as const;
  it('prefers the span holding the attachment, else the longest (a covered attachment is not an error)', () => {
    expect(pickSpan(spans, null, 12)).toEqual([150, 400]);
    expect(pickSpan(spans, 50, 12)).toEqual([0, 100]);
    expect(pickSpan(spans, 108, 12)).toEqual([0, 100]);
    expect(pickSpan(spans, 125, 12)).toEqual([150, 400]);
    expect(pickSpan([], null, 12)).toBeNull();
  });
});

describe('maximized and covering frames', () => {
  const displays = [disp('1', 0, 0, 1920, 1200, 1, 1152)];
  it('treats a frame covering a work area as maximized', () => {
    expect(coversWorkArea(rect(0, 0, 1920, 1152), displays)).toBe(true);
    expect(coversWorkArea(rect(-1, -1, 1922, 1154), displays)).toBe(true);
    expect(coversWorkArea(rect(0, 0, 960, 1152), displays)).toBe(false);
    expect(offersSurfaces({ minimized: false, maximized: false, fullscreen: false }, rect(10, 10, 500, 500), displays)).toBe(true);
    expect(offersSurfaces({ minimized: false, maximized: true, fullscreen: false }, rect(10, 10, 500, 500), displays)).toBe(false);
    expect(offersSurfaces({ minimized: false, maximized: false, fullscreen: false }, rect(10, 10, 0, 500), displays)).toBe(false);
  });
});

describe('open spans across displays', () => {
  it('keeps a wall whose open space lies on the neighbouring display, but not past the outer screen edge', () => {
    const displays = [disp('1', 0, 0, 1920, 1080), disp('2', 1920, 0, 2560, 1440, 1.5)];
    // A window on display 2 touching the boundary with display 1: its left side has room on display 1.
    const spans = computeOpenSpans(rect(1930, 100, 900, 600), [], displays, OPTS);
    expect(spans.inset).toBe(12);
    expect(spans.left).toEqual([[112, 688]]);
    // A window at the far right of display 2 has no room on its right.
    expect(computeOpenSpans(rect(3800, 100, 680, 600), [], displays, OPTS).right).toEqual([]);
  });

  it('clips the top ledge to the work areas holding the row above the edge', () => {
    const displays = [disp('1', 0, 0, 1920, 1080), disp('2', 1920, 300, 1920, 1080)];
    // Row 199 is on display 1 only: the part over display 2 (whose top is 300) is cut.
    expect(computeOpenSpans(rect(1500, 200, 800, 400), [], displays, OPTS).top).toEqual([[1508, 1920]]);
  });

  it('builds no walls while climbing is off', () => {
    const spans = computeOpenSpans(rect(300, 300, 800, 500), [], [disp('1', 0, 0, 1920, 1080)], { ...OPTS, climbWindows: false });
    expect([spans.left, spans.right]).toEqual([[], []]);
  });
});

describe('built surfaces', () => {
  const displays = [disp('1', 0, 0, 1920, 1200, 1, 1152)];
  it('carries phase, velocity (right wall: right-edge speed), confidence and the privacy flag', () => {
    const r = rect(300, 400, 800, 500);
    const spans = computeOpenSpans(r, [], displays, OPTS);
    const b = buildWindowSurfaces('7', r, spans, displays, { ...META, phase: 'entering', excluded: true, vx: 10, vy: -5, vxRight: 30, confidence: 0.7 }, null, null);
    expect(b.windowTop).toMatchObject({ id: 'windowTop:7', phase: 'entering', excluded: true, vx: 10, vy: -5, confidence: 0.7, validatedAt: 5 });
    expect(b.left).toMatchObject({ vx: 10 });
    expect(b.right).toMatchObject({ vx: 30 });
  });

  it('a strip on a top edge covered all along leaves no top at all', () => {
    const r = rect(300, 200, 1100, 700);
    const spans = computeOpenSpans(r, [rect(300, 100, 1200, 200)], displays, OPTS);
    const source = {
      id: 'tabStrip:7', kind: 'tabStrip', orientation: 'ledge', ownerId: '7', displayId: '1', phase: 'stable', vx: 0, vy: 0, confidence: 1, validatedAt: 1, excluded: false, y: 200, x0: 341, x1: 1250, rest: null, focusX: null,
    } as const;
    const b = buildWindowSurfaces('7', r, spans, displays, META, { source, y: 200, x0: 341, x1: 1250, rest: null, focusX: null, confidence: 1 }, null);
    expect(b.strip).toBeNull();
    expect(b.windowTop).toBeNull();
    expect(b.top).toBeNull();
  });

  describe('with a tab strip', () => {
    const r = rect(300, 200, 1100, 700);
    const source = {
      id: 'tabStrip:7', kind: 'tabStrip', orientation: 'ledge', ownerId: '7', displayId: '1', phase: 'stable', vx: 0, vy: 0, confidence: 1, validatedAt: 1, excluded: false, y: 200, x0: 341, x1: 1250, rest: null, focusX: null,
    } as const;
    const placed = { source, y: 200, x0: 341, x1: 1250, rest: null, focusX: null, confidence: 1 };

    it('walls pull up onto the strip when the open edge runs from their corner to it (the sim judges the distance)', () => {
      const b = buildWindowSurfaces('7', r, computeOpenSpans(r, [], displays, OPTS), displays, META, placed, null);
      expect(b.top).toBe(b.strip);
      expect([b.left?.topLedgeId, b.right?.topLedgeId]).toEqual(['tabStrip:7', 'tabStrip:7']);
      // A window above cutting the edge between the left corner and the strip: no way up there.
      const cut = buildWindowSurfaces('7', r, computeOpenSpans(r, [rect(320, 150, 15, 100)], displays, OPTS), displays, META, placed, null);
      expect([cut.left?.topLedgeId, cut.right?.topLedgeId]).toEqual([null, 'tabStrip:7']);
    });

    it('keeps the plain top listed (and named by the walls) under a cat standing on it', () => {
      const spans = computeOpenSpans(r, [], displays, OPTS);
      const b = buildWindowSurfaces('7', r, spans, displays, META, placed, { surfaceId: 'windowTop:7', x: 1350, y: 200 });
      expect(b.top).toBe(b.windowTop);
      expect(b.top).toMatchObject({ id: 'windowTop:7', x0: 308, x1: 1392 });
      expect(b.strip).toMatchObject({ id: 'tabStrip:7' });
      expect([b.left?.topLedgeId, b.right?.topLedgeId]).toEqual(['windowTop:7', 'windowTop:7']);
    });

    it('falls back to the plain top when the strip has no open part, so a side still pulls up (v1.1.1)', () => {
      // A palette over the tab area: only the caption end of the top edge, [1270, 1392), is open.
      const spans = computeOpenSpans(r, [rect(330, 150, 940, 100)], displays, OPTS);
      const b = buildWindowSurfaces('7', r, spans, displays, META, placed, null);
      expect(b.strip).toBeNull();
      expect(b.top).toBe(b.windowTop);
      expect(b.top).toMatchObject({ id: 'windowTop:7', x0: 1270, x1: 1392 });
      expect([b.left?.topLedgeId, b.right?.topLedgeId]).toEqual([null, 'windowTop:7']);
    });

    it('gives the strip the open top edge it lies on as its landing span, none when it is no wider (v1.1.1)', () => {
      const b = buildWindowSurfaces('7', r, computeOpenSpans(r, [], displays, OPTS), displays, META, placed, null);
      expect(b.strip?.land).toEqual({ x0: 308, x1: 1392 });
      expect(b.strip?.land).toEqual({ x0: b.windowTop?.x0, x1: b.windowTop?.x1 });
      // Cut by a window above near the right corner: the landing span ends there too.
      const cut = buildWindowSurfaces('7', r, computeOpenSpans(r, [rect(1300, 100, 200, 200)], displays, OPTS), displays, META, placed, null);
      expect(cut.strip?.land).toEqual({ x0: 308, x1: 1300 });
      expect(cut.windowTop).toMatchObject({ x0: 308, x1: 1300 });
      // A strip over the whole open edge needs none.
      const whole = buildWindowSurfaces('7', r, computeOpenSpans(r, [], displays, OPTS), displays, META, { ...placed, x0: 300, x1: 1400 }, null);
      expect(whole.strip).toMatchObject({ x0: 308, x1: 1392 });
      expect(whole.strip !== null && 'land' in whole.strip).toBe(false);
    });

    it('holds the top listed when the cat got onto a side, whichever way the strip changed since (v1.1.1)', () => {
      const spans = computeOpenSpans(r, [], displays, OPTS);
      const onSide = (heldTop: 'windowTop' | 'tabStrip') => ({ surfaceId: 'windowSide:7:left', x: 300, y: 600, heldTop });
      // Got on while the plain top was listed; a strip has been found since.
      const a = buildWindowSurfaces('7', r, spans, displays, META, placed, onSide('windowTop'));
      expect(a.top).toBe(a.windowTop);
      expect([a.left?.topLedgeId, a.right?.topLedgeId]).toEqual(['windowTop:7', 'windowTop:7']);
      // Got on while the strip was listed; it is gone since: the edge under the strip's id.
      const b = buildWindowSurfaces('7', r, spans, displays, META, null, onSide('tabStrip'));
      expect(b.top).toMatchObject({ id: 'tabStrip:7', kind: 'tabStrip', x0: 308, x1: 1392, confidence: 0.5 });
      expect(b.left?.topLedgeId).toBe('tabStrip:7');
      // Nothing changed: the strip it set out for.
      const c = buildWindowSurfaces('7', r, spans, displays, META, placed, onSide('tabStrip'));
      expect(c.top).toBe(c.strip);
      // Not on a side of this window: nothing is held.
      expect(buildWindowSurfaces('7', r, spans, displays, META, placed, { surfaceId: 'windowSide:8:left', x: 300, y: 600, heldTop: 'windowTop' }).top?.kind).toBe('tabStrip');
    });

    it('carries a strip that vanished under the cat along the plain top edge, under the strip id', () => {
      const spans = computeOpenSpans(r, [], displays, OPTS);
      const b = buildWindowSurfaces('7', r, spans, displays, META, null, { surfaceId: 'tabStrip:7', x: 700, y: 200 });
      expect(b.strip).toBeNull();
      expect(b.top).toMatchObject({ id: 'tabStrip:7', kind: 'tabStrip', x0: 308, x1: 1392, confidence: 0.5 });
      expect(b.left?.topLedgeId).toBe('tabStrip:7');
      // Nobody on it: the plain top is listed again.
      expect(buildWindowSurfaces('7', r, spans, displays, META, null, null).top).toMatchObject({ id: 'windowTop:7' });
    });
  });

  it('the bare edge of a covered surface keeps the frame minus the corner insets', () => {
    const r = rect(300, 400, 800, 500);
    expect(bareWindowSurface('windowTop:7', r, 8, displays, META)).toMatchObject({ id: 'windowTop:7', kind: 'windowTop', ownerId: '7', y: 400, x0: 308, x1: 1092, displayId: '1' });
    expect(bareWindowSurface('windowSide:7:right', r, 8, displays, { ...META, vxRight: 40 })).toMatchObject({ kind: 'windowSide', side: 'right', x: 1100, y0: 408, y1: 892, vx: 40, topLedgeId: null });
    expect(bareWindowSurface('taskbar:7', r, 8, displays, META)).toBeNull();
    expect(bareWindowSurface('windowTop:7', rect(0, 0, 10, 10), 8, displays, META)).toBeNull();
  });
});

describe('injected surface validation', () => {
  const good = {
    id: 'taskbar:e2e', kind: 'taskbar', orientation: 'ledge', ownerId: '1', displayId: '1', phase: 'entering', vx: 0, vy: -200, confidence: 1, validatedAt: 0, excluded: false, y: 1100, x0: 0, x1: 1920, rest: null, focusX: null, edge: 'bottom',
  };
  it('accepts well-formed ledges and walls and null', () => {
    expect(parseInjectedSurfaces(null)).toBeNull();
    expect(parseInjectedSurfaces([good])).toEqual([good]);
    const w = { id: 'windowSide:1:left', kind: 'windowSide', orientation: 'wall', ownerId: '1', displayId: null, phase: 'stable', vx: 0, vy: 0, confidence: 1, validatedAt: 0, excluded: false, x: 10, y0: 10, y1: 200, side: 'left', topLedgeId: null };
    expect(parseInjectedSurfaces([w])).toEqual([w]);
  });

  it('accepts a ledge landing span that contains the ledge, rejects one that does not (v1.1.1)', () => {
    const strip = { id: 'tabStrip:1', kind: 'tabStrip', orientation: 'ledge', ownerId: '1', displayId: '1', phase: 'stable', vx: 0, vy: 0, confidence: 1, validatedAt: 0, excluded: false, y: 300, x0: 100, x1: 900, rest: null, focusX: null };
    expect(parseInjectedSurfaces([{ ...strip, land: { x0: 40, x1: 960 } }])).toEqual([{ ...strip, land: { x0: 40, x1: 960 } }]);
    expect(() => parseInjectedSurfaces([{ ...strip, land: { x0: 140, x1: 960 } }])).toThrow(/land/);
    expect(() => parseInjectedSurfaces([{ ...strip, land: { x0: 40, x1: 960, y: 3 } }])).toThrow();
  });

  it('rejects malformed, unbounded, duplicate or extra-field input', () => {
    expect(() => parseInjectedSurfaces({})).toThrow(/injectSurfaces/);
    expect(() => parseInjectedSurfaces([{ ...good, x1: -5 }])).toThrow();
    expect(() => parseInjectedSurfaces([{ ...good, y: Number.NaN }])).toThrow();
    expect(() => parseInjectedSurfaces([{ ...good, y: Infinity }])).toThrow();
    expect(() => parseInjectedSurfaces([{ ...good, title: 'secret' }])).toThrow();
    expect(() => parseInjectedSurfaces([good, good])).toThrow(/unique/);
    expect(() => parseInjectedSurfaces(Array.from({ length: 65 }, (_, i) => ({ ...good, id: `taskbar:${i}` })))).toThrow();
    expect(() => parseInjectedSurfaces([{ ...good, orientation: 'wall' }])).toThrow();
  });
});
