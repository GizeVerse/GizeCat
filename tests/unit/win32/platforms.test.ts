import { describe, expect, it } from 'vitest';
import type { DisplayGeometry } from '../../../src/shared/world';
import { computeFullscreenDisplayIds, computePlatforms, subtractSpan } from '../../../src/main/win32/platforms';
import { rect, win } from './fakes';

describe('subtractSpan', () => {
  it('cuts, splits and removes spans', () => {
    expect(subtractSpan([[0, 100]], 20, 40)).toEqual([
      [0, 20],
      [40, 100],
    ]);
    expect(subtractSpan([[0, 100]], -10, 50)).toEqual([[50, 100]]);
    expect(subtractSpan([[0, 100]], 50, 200)).toEqual([[0, 50]]);
    expect(subtractSpan([[0, 100]], -1, 101)).toEqual([]);
    expect(subtractSpan([[0, 100]], 100, 200)).toEqual([[0, 100]]);
  });
});

describe('computePlatforms', () => {
  it('returns the full top edge of an unobstructed window', () => {
    expect(computePlatforms([win('a', rect(100, 300, 500, 400))])).toEqual([{ windowId: 'a', y: 300, x0: 100, x1: 600 }]);
  });

  it('subtracts spans of windows above that cover the edge row', () => {
    const top = win('top', rect(250, 200, 100, 300)); // covers y=300 for x in [250,350)
    const below = win('below', rect(100, 300, 500, 400));
    expect(computePlatforms([top, below])).toEqual([
      { windowId: 'top', y: 200, x0: 250, x1: 350 },
      { windowId: 'below', y: 300, x0: 100, x1: 250 },
      { windowId: 'below', y: 300, x0: 350, x1: 600 },
    ]);
  });

  it('ignores windows above that do not contain the edge row', () => {
    const higher = win('higher', rect(0, 0, 1000, 300)); // bottom edge 300 is exclusive
    const lower = win('lower', rect(100, 400, 500, 300)); // starts below the edge
    const target = win('target', rect(100, 300, 500, 400));
    expect(computePlatforms([higher, lower, target]).filter((p) => p.windowId === 'target')).toEqual([{ windowId: 'target', y: 300, x0: 100, x1: 600 }]);
  });

  it('is z-order aware: a window below never occludes one above', () => {
    const front = win('front', rect(100, 300, 500, 400));
    const back = win('back', rect(250, 200, 100, 300));
    expect(computePlatforms([front, back]).filter((p) => p.windowId === 'front')).toEqual([{ windowId: 'front', y: 300, x0: 100, x1: 600 }]);
  });

  it('skips maximized, fullscreen and minimized windows but lets the first two occlude', () => {
    const max = win('max', rect(0, 0, 1920, 1152), { maximized: true });
    const behind = win('behind', rect(100, 300, 500, 400));
    expect(computePlatforms([max, behind])).toEqual([]);
    const full = win('full', rect(0, 0, 1920, 1200), { fullscreen: true });
    expect(computePlatforms([full, behind])).toEqual([]);
    const min = win('min', rect(0, 0, 1920, 1200), { minimized: true });
    expect(computePlatforms([min, behind])).toEqual([{ windowId: 'behind', y: 300, x0: 100, x1: 600 }]);
  });

  it('drops segments narrower than the minimum width', () => {
    const top = win('top', rect(170, 100, 360, 400), { maximized: true });
    const target = win('target', rect(100, 300, 500, 400)); // leaves [100,170) and [530,600): 70 px each
    expect(computePlatforms([top, target])).toEqual([]);
    expect(computePlatforms([top, target], 60)).toHaveLength(2);
    expect(computePlatforms([win('narrow', rect(0, 0, 79, 300))])).toEqual([]);
  });

  it('lets windows that are not app windows occlude when the full z-order is known', () => {
    const browser = win('browser', rect(100, 400, 1200, 600));
    const max = win('max', rect(0, 0, 1920, 1152), { maximized: true });
    const occluders = [
      { id: 'dialog', rect: rect(300, 250, 500, 400) }, // owned dialog: not an app window
      { id: 'browser', rect: browser.rect },
      { id: 'max', rect: max.rect },
    ];
    expect(computePlatforms([browser, max], 80, occluders)).toEqual([
      { windowId: 'browser', y: 400, x0: 100, x1: 300 },
      { windowId: 'browser', y: 400, x0: 800, x1: 1300 },
    ]);
    // An app window missing from the z-order is not shown, so it offers no edge.
    expect(computePlatforms([browser], 80, [])).toEqual([]);
  });
});

function display(id: string, x: number, y: number, w: number, h: number, primary = false): DisplayGeometry {
  const r = { x, y, width: w, height: h };
  return { id, primary, scaleFactor: 1, boundsDip: r, workAreaDip: r, boundsPx: r, workAreaPx: r };
}

describe('computeFullscreenDisplayIds', () => {
  const displays = [display('1', 0, 0, 1920, 1080, true), display('2', 1920, 0, 2560, 1440)];
  const base = { displays, windows: [], foreground: null, foregroundRect: null, notification: 'normal' as const };

  it('marks the display of a fullscreen foreground window', () => {
    const fg = win('g', rect(1920, 0, 2560, 1440), { fullscreen: true });
    expect(computeFullscreenDisplayIds({ ...base, windows: [fg], foreground: fg })).toEqual(['2']);
  });

  it('uses QUNS d3d/presentation for the foreground display, but ignores QUNS_BUSY', () => {
    const fg = win('n', rect(100, 100, 800, 600));
    expect(computeFullscreenDisplayIds({ ...base, foreground: fg, notification: 'd3d-fullscreen' })).toEqual(['1']);
    expect(computeFullscreenDisplayIds({ ...base, foreground: fg, notification: 'presentation' })).toEqual(['1']);
    expect(computeFullscreenDisplayIds({ ...base, foreground: fg, notification: 'busy' })).toEqual([]);
    expect(computeFullscreenDisplayIds({ ...base, foreground: null, foregroundRect: rect(1920, 0, 2560, 1440), notification: 'd3d-fullscreen' })).toEqual(['2']);
    expect(computeFullscreenDisplayIds({ ...base, foreground: null, notification: 'd3d-fullscreen' })).toEqual([]);
  });

  it('finds a fullscreen window in front on another display (e.g. video on monitor 2)', () => {
    const working = win('w', rect(100, 100, 800, 600));
    const sticky = win('s', rect(2000, 50, 300, 300)); // small window above the video
    const video = win('v', rect(1920, 0, 2560, 1440), { fullscreen: true });
    expect(computeFullscreenDisplayIds({ ...base, windows: [working, sticky, video], foreground: working })).toEqual(['2']);
  });

  it('does not count a fullscreen window mostly covered by windows above it', () => {
    const big = win('b', rect(1920, 0, 2000, 1400));
    const video = win('v', rect(1920, 0, 2560, 1440), { fullscreen: true });
    expect(computeFullscreenDisplayIds({ ...base, windows: [big, video] })).toEqual([]);
  });

  it('ignores minimized fullscreen windows', () => {
    const video = win('v', rect(1920, 0, 2560, 1440), { fullscreen: true, minimized: true });
    expect(computeFullscreenDisplayIds({ ...base, windows: [video], foreground: video })).toEqual([]);
  });
});
