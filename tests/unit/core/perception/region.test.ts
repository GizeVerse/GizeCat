import { describe, expect, it } from 'vitest';
import { chooseRegion, projectRect, regionKey, scaledSize, stickyRegion, type CaptureDisplay } from '../../../../src/core/perception/region';
import { makeTestPattern } from '../../../../src/core/perception/testPattern';
import type { WindowInfo } from '../../../../src/shared/world';

const primary: CaptureDisplay = { id: '1', boundsPx: { x: 0, y: 0, width: 2400, height: 1500 }, scaleFactor: 1.25, primary: true };
const second: CaptureDisplay = { id: '2', boundsPx: { x: 2400, y: 0, width: 1920, height: 1080 }, scaleFactor: 1, primary: false };
const displays = [primary, second];

const fg = (rect: WindowInfo['rect'], over: Partial<WindowInfo> = {}): WindowInfo => ({
  id: '9',
  rect,
  processName: 'x.exe',
  category: 'other',
  minimized: false,
  maximized: false,
  fullscreen: false,
  excluded: false,
  ...over,
});

const base = { displays, focus: null, catBounds: null, catDisplayId: null, foreground: null } as const;

describe('chooseRegion', () => {
  it('around-cat: 640x400 DIP scaled to px, centred on the cat', () => {
    const c = chooseRegion({ ...base, policy: 'around-cat', catBounds: { x: 1150, y: 700, width: 100, height: 100 } })!;
    expect(c.display.id).toBe('1');
    expect(c.regionPx).toEqual({ x: 800, y: 500, width: 800, height: 500 });
  });

  it('around-cat: clamps inside the display at edges', () => {
    const c = chooseRegion({ ...base, policy: 'around-cat', focus: { x: 10, y: 1490 } })!;
    expect(c.regionPx).toEqual({ x: 0, y: 1000, width: 800, height: 500 });
  });

  it('uses the display containing the focus', () => {
    const c = chooseRegion({ ...base, policy: 'around-cat', focus: { x: 3000, y: 500 } })!;
    expect(c.display.id).toBe('2');
    expect(c.regionPx.width).toBe(640);
  });

  it('falls back to the nearest display for a point off-screen', () => {
    const c = chooseRegion({ ...base, policy: 'display', focus: { x: 5000, y: -50 } })!;
    expect(c.display.id).toBe('2');
  });

  it('display policy returns the whole display', () => {
    expect(chooseRegion({ ...base, policy: 'display', catDisplayId: '2' })!.regionPx).toEqual(second.boundsPx);
  });

  it('active-window: clipped to its display; minimized/tiny falls back to around-cat', () => {
    const c = chooseRegion({ ...base, policy: 'active-window', foreground: fg({ x: 2300, y: 100, width: 800, height: 600 }) })!;
    expect(c.display.id).toBe('2');
    expect(c.regionPx).toEqual({ x: 2400, y: 100, width: 700, height: 600 });
    expect(chooseRegion({ ...base, policy: 'active-window', foreground: fg({ x: 0, y: 0, width: 500, height: 500 }, { minimized: true }) })!.policy).toBe('around-cat');
    expect(chooseRegion({ ...base, policy: 'active-window', foreground: fg({ x: 0, y: 0, width: 30, height: 30 }) })!.policy).toBe('around-cat');
  });

  it('returns null without displays', () => {
    expect(chooseRegion({ ...base, displays: [], policy: 'display' })).toBeNull();
  });
});

describe('stickyRegion', () => {
  it('keeps the previous region while the interest stays in its inner area', () => {
    const a = chooseRegion({ ...base, policy: 'around-cat', focus: { x: 1200, y: 750 } })!;
    const b = chooseRegion({ ...base, policy: 'around-cat', focus: { x: 1300, y: 800 } })!;
    expect(stickyRegion(a, b, { x: 1300, y: 800 })).toBe(a);
    const far = chooseRegion({ ...base, policy: 'around-cat', focus: { x: 1590, y: 800 } })!;
    expect(stickyRegion(a, far, { x: 1590, y: 800 })).toBe(far);
    expect(regionKey(a)).not.toBe(regionKey(far));
  });
});

describe('projectRect / scaledSize', () => {
  it('maps px rects into frame space with padding and clipping', () => {
    const region = { x: 800, y: 500, width: 800, height: 500 };
    expect(projectRect({ x: 1000, y: 600, width: 100, height: 50 }, region, 256, 160, 0)).toEqual({ x: 64, y: 32, width: 32, height: 16 });
    expect(projectRect({ x: 1000, y: 600, width: 100, height: 50 }, region, 256, 160, 2)).toEqual({ x: 62, y: 30, width: 36, height: 20 });
    expect(projectRect({ x: 0, y: 0, width: 900, height: 600 }, region, 256, 160, 0)).toEqual({ x: 0, y: 0, width: 32, height: 32 });
    expect(projectRect({ x: 0, y: 0, width: 10, height: 10 }, region, 256, 160)).toBeNull();
  });

  it('downscales to the width cap and never upscales', () => {
    expect(scaledSize({ x: 0, y: 0, width: 800, height: 500 }, 256)).toEqual({ width: 256, height: 160 });
    expect(scaledSize({ x: 0, y: 0, width: 100, height: 50 }, 256)).toEqual({ width: 100, height: 50 });
  });
});

describe('makeTestPattern', () => {
  it('is deterministic and opaque', () => {
    const a = makeTestPattern(64, 40);
    const b = makeTestPattern(64, 40);
    expect(Buffer.from(a.data).equals(Buffer.from(b.data))).toBe(true);
    for (let i = 3; i < a.data.length; i += 4) expect(a.data[i]).toBe(255);
  });
});
