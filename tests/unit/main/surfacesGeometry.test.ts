// Pure window-surface geometry and the injected-surface validator.
import { describe, expect, it } from 'vitest';
import { parseInjectedSurfaces } from '../../../src/main/surfaces';
import {
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
  it('prefers the span holding the attachment, else the longest; strict mode reports a covered attachment', () => {
    expect(pickSpan(spans, null, 12)).toEqual([150, 400]);
    expect(pickSpan(spans, 50, 12)).toEqual([0, 100]);
    expect(pickSpan(spans, 108, 12)).toEqual([0, 100]);
    expect(pickSpan(spans, 125, 12)).toEqual([150, 400]);
    expect(pickSpan(spans, 125, 12, true)).toBeNull();
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

  it('drops a strip whose safe span is fully covered rather than falling back to the plain top', () => {
    const r = rect(300, 200, 1100, 700);
    const spans = computeOpenSpans(r, [rect(300, 100, 1200, 200)], displays, OPTS);
    const source = {
      id: 'tabStrip:7', kind: 'tabStrip', orientation: 'ledge', ownerId: '7', displayId: '1', phase: 'stable', vx: 0, vy: 0, confidence: 1, validatedAt: 1, excluded: false, y: 200, x0: 341, x1: 1250, rest: null, focusX: null,
    } as const;
    const b = buildWindowSurfaces('7', r, spans, displays, META, { source, y: 200, x0: 341, x1: 1250, rest: null, focusX: null, confidence: 1 }, null);
    expect(b.strip).toBeNull();
    expect(b.windowTop).toBeNull();
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
