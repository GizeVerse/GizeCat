// Pure tab-strip segment math (src/main/uia/segment.ts) against the research geometry
// (fixtures.ts: measured at 125 %, scaled for 100/150 %).
import { describe, expect, it } from 'vitest';
import { catExtentPx, computeTabStripSegment, placeStrip, toRelativeStrip, type StripGeometry, type TabStripSegment } from '../../../src/main/uia/segment';
import { geometry, type FixtureOptions } from './fixtures';

function seg(o: FixtureOptions, size = 1): TabStripSegment {
  const g = geometry(o);
  return computeTabStripSegment(g, catExtentPx(size, g.dpi));
}

function ok(s: TabStripSegment): Extract<TabStripSegment, { ok: true }> {
  if (!s.ok) throw new Error(`segment disabled: ${s.reason}`);
  return s;
}

/** The walkable span never reaches the left control, the new-tab button, the grab handle or the captions. */
function assertSafe(g: StripGeometry, s: Extract<TabStripSegment, { ok: true }>, size = 1): void {
  const cat = catExtentPx(size, g.dpi);
  const margin = Math.round((6 * g.dpi) / 96);
  const leftEdge = s.x0 - cat.width / 2;
  const rightEdge = s.x1 + cat.width / 2;
  expect(leftEdge).toBeGreaterThanOrEqual(g.leftButton!.x + g.leftButton!.width + margin);
  expect(rightEdge).toBeLessThanOrEqual(g.newTab!.x - margin);
  expect(rightEdge).toBeLessThan(g.grab!.x);
  expect(rightEdge).toBeLessThan(g.captions!.x);
  expect(leftEdge).toBeGreaterThanOrEqual(g.frame.x);
  expect(rightEdge).toBeLessThanOrEqual(g.frame.x + g.frame.width);
  expect(s.y).toBe(g.frame.y);
}

describe('catExtentPx', () => {
  it('scales the base body size by appearance size and dpi', () => {
    expect(catExtentPx(1, 96)).toEqual({ width: 84, height: 64 });
    expect(catExtentPx(1, 120)).toEqual({ width: 105, height: 80 });
    expect(catExtentPx(1.5, 144)).toEqual({ width: 189, height: 144 });
  });
});

describe('computeTabStripSegment: Edge (measured 125 %)', () => {
  it('3 tabs: span from the tab-actions button to the new-tab button, inset by margin + half cat', () => {
    const g = geometry({ browser: 'edge' });
    const s = ok(seg({ browser: 'edge' }));
    // L = max(first tab 174, actions button right 179) = 179; R = min(last tab 1091, new tab 1086) = 1086.
    expect(s.left).toBe(179);
    expect(s.right).toBe(1086);
    // margin round(7.5) = 8, half cat 52.5
    expect(s.x0).toBe(239.5);
    expect(s.x1).toBe(1025.5);
    expect(s.y).toBe(125);
    expect(s.tabCount).toBe(3);
    expect(s.selectedIndex).toBe(2);
    expect(s.focusX).toBe(771 + 160);
    // Active tab 771..1091, corners round(12.5) = 13 kept out, clipped to [x0, x1].
    expect(s.rest).toEqual({ x0: 836.5, x1: 1025.5 });
    assertSafe(g, s);
  });

  it('24 tabs: span ends at the moved new-tab button; the active tab is too small to rest on', () => {
    const g = geometry({ browser: 'edge', tabs: 24 });
    const s = ok(seg({ browser: 'edge', tabs: 24 }));
    expect(s.left).toBe(179);
    expect(s.right).toBe(133 + 1093);
    expect(s.x0).toBe(239.5);
    expect(s.x1).toBe(1165.5);
    expect(s.tabCount).toBe(24);
    expect(s.selectedIndex).toBe(23);
    expect(s.focusX).toBe(1165 + 33);
    expect(s.rest).toBeNull();
    assertSafe(g, s);
  });

  it('first tab selected: focus and rest move to it', () => {
    const s = ok(seg({ browser: 'edge', selected: 0 }));
    expect(s.selectedIndex).toBe(0);
    expect(s.focusX).toBe(174 + 160);
    // rest = [max(239.5, 174+13+52.5), min(1025.5, 494-13-52.5)]
    expect(s.rest).toEqual({ x0: 239.5, x1: 428.5 });
  });

  it('no selected tab: no focus, no rest', () => {
    const s = ok(seg({ browser: 'edge', selected: null }));
    expect(s.focusX).toBeNull();
    expect(s.rest).toBeNull();
    expect(s.selectedIndex).toBeNull();
  });
});

describe('computeTabStripSegment: Chrome (measured 125 %)', () => {
  it('3 tabs: span from the tab-search button to the new-tab button', () => {
    const g = geometry({ browser: 'chrome' });
    const s = ok(seg({ browser: 'chrome' }));
    // L = max(169, 141+36) = 177; R = min(1084, 1076) = 1076
    expect(s.left).toBe(177);
    expect(s.right).toBe(1076);
    expect(s.x0).toBe(237.5);
    expect(s.x1).toBe(1015.5);
    expect(s.focusX).toBe(764 + 160);
    assertSafe(g, s);
  });

  it('24 tabs', () => {
    const g = geometry({ browser: 'chrome', tabs: 24 });
    const s = ok(seg({ browser: 'chrome', tabs: 24 }));
    expect(s.left).toBe(177);
    expect(s.right).toBe(133 + 1085);
    expect(s.x1).toBe(1157.5);
    expect(s.tabCount).toBe(24);
    assertSafe(g, s);
  });
});

describe('computeTabStripSegment: other scales (layout scaled from 125 %)', () => {
  it('Edge at 100 %', () => {
    const g = geometry({ browser: 'edge', scale: 1 });
    const s = ok(seg({ browser: 'edge', scale: 1 }));
    // frame x 106; actions right 143; new tab 868; margin 6; half cat 42
    expect(s.x0).toBe(191);
    expect(s.x1).toBe(820);
    expect(s.y).toBe(100);
    assertSafe(g, s);
  });

  it('Edge at 150 %', () => {
    const g = geometry({ browser: 'edge', scale: 1.5 });
    const s = ok(seg({ browser: 'edge', scale: 1.5 }));
    // frame x 160; actions right 215; new tab 1304; margin 9; half cat 63
    expect(s.x0).toBe(287);
    expect(s.x1).toBe(1232);
    expect(s.y).toBe(150);
    assertSafe(g, s);
  });

  for (const browser of ['edge', 'chrome'] as const) {
    for (const scale of [1, 1.25, 1.5]) {
      for (const tabs of [3, 24] as const) {
        it(`${browser} ${scale * 100} % ${tabs} tabs stays clear of every control`, () => {
          const g = geometry({ browser, scale, tabs });
          const s = ok(seg({ browser, scale, tabs }));
          assertSafe(g, s);
          expect(s.tabCount).toBe(tabs);
          expect(s.x1 - s.x0).toBeGreaterThan(0);
        });
      }
    }
  }

  it('a bigger cat narrows the span symmetrically and needs more head room', () => {
    const at = { x: 133, y: 300 };
    const a = ok(seg({ browser: 'edge', at }, 1));
    const b = ok(seg({ browser: 'edge', at }, 2));
    expect(b.x0 - a.x0).toBeCloseTo(52.5);
    expect(a.x1 - b.x1).toBeCloseTo(52.5);
    // A size-2 cat is 160 px tall at 125 %: 125 px above the default frame is not enough.
    expect(seg({ browser: 'edge' }, 2)).toEqual({ ok: false, reason: 'no-head-room' });
  });
});

describe('computeTabStripSegment: disabled cases', () => {
  it('maximized (no ledge above the screen top)', () => {
    expect(seg({ browser: 'edge', maximized: true })).toEqual({ ok: false, reason: 'maximized' });
  });

  it('vertical tabs (empty horizontal container)', () => {
    expect(seg({ browser: 'edge', vertical: true })).toEqual({ ok: false, reason: 'vertical' });
  });

  it('no head room above the frame inside the work area', () => {
    // cat height at 125 % = 80 px; frame 40 px below the work-area top
    expect(seg({ browser: 'edge', at: { x: 133, y: 40 } })).toEqual({ ok: false, reason: 'no-head-room' });
    expect(ok(seg({ browser: 'edge', at: { x: 133, y: 80 } })).y).toBe(80);
  });

  it('no tabs', () => {
    const g = { ...geometry({ browser: 'chrome' }), tabs: [] };
    expect(computeTabStripSegment(g, catExtentPx(1, g.dpi))).toEqual({ ok: false, reason: 'no-tabs' });
  });

  it('too narrow for the cat', () => {
    const g = geometry({ browser: 'edge', scale: 1 });
    const narrow: StripGeometry = {
      ...g,
      tabs: [{ x: g.frame.x + 40, y: g.frame.y, width: 120, height: 41, selected: true }],
      newTab: { x: g.frame.x + 130, y: g.frame.y, width: 32, height: 41 },
    };
    expect(computeTabStripSegment(narrow, catExtentPx(1, g.dpi))).toEqual({ ok: false, reason: 'too-narrow' });
  });

  it('ignores empty rects (the hidden caption twin)', () => {
    const g = { ...geometry({ browser: 'edge' }), grab: { x: 0, y: 0, width: 0, height: 0 } };
    expect(ok(computeTabStripSegment(g, catExtentPx(1, g.dpi))).x1).toBe(1025.5);
  });
});

describe('relative strips follow their window', () => {
  it('a moved frame shifts the segment by the same offset', () => {
    const g = geometry({ browser: 'edge' });
    const rel = toRelativeStrip(g);
    const moved = placeStrip(rel, { ...g.frame, x: g.frame.x + 200, y: g.frame.y + 50 }, false);
    const a = ok(computeTabStripSegment(g, catExtentPx(1, 120)));
    const b = ok(computeTabStripSegment(moved, catExtentPx(1, 120)));
    expect(b.x0 - a.x0).toBe(200);
    expect(b.x1 - a.x1).toBe(200);
    expect(b.y - a.y).toBe(50);
  });

  it('caption buttons keep their distance from the right edge when the frame grows', () => {
    const g = geometry({ browser: 'edge' });
    const wider = placeStrip(toRelativeStrip(g), { ...g.frame, width: g.frame.width + 300 }, false);
    expect(wider.captions!.x - g.captions!.x).toBe(300);
    expect(wider.tabs[0]!.x).toBe(g.tabs[0]!.x);
  });

  it('a maximized placement disables the strip', () => {
    const g = geometry({ browser: 'edge' });
    expect(computeTabStripSegment(placeStrip(toRelativeStrip(g), g.frame, true), catExtentPx(1, 120))).toEqual({ ok: false, reason: 'maximized' });
  });
});
