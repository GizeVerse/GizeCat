import { describe, expect, it } from 'vitest';
import { ClickThroughGate, clipRects, decideInteractive, suggestPollIntervalMs } from '../../../../src/core/interaction/clickThrough';
import type { ClickThroughInput } from '../../../../src/core/interaction/clickThrough';

const cat = { x: 100, y: 100, width: 80, height: 60 };
const base: ClickThroughInput = {
  cursor: { x: 120, y: 120 },
  hitRects: [cat],
  interactive: false,
  interactionsEnabled: true,
  visible: true,
  rendererHealthy: true,
  dragging: false,
  hitRegionAgeMs: 100,
};

describe('decideInteractive', () => {
  it('is interactive only inside the hit region', () => {
    expect(decideInteractive(base)).toBe(true);
    expect(decideInteractive({ ...base, cursor: { x: 50, y: 50 } })).toBe(false);
    expect(decideInteractive({ ...base, cursor: { x: 180, y: 120 } })).toBe(false); // right edge is exclusive
    expect(decideInteractive({ ...base, hitRects: [{ x: 0, y: 0, width: 10, height: 10 }, cat] })).toBe(true);
  });

  it('applies a 3 px hysteresis margin only while interactive', () => {
    const nearEdge = { ...base, cursor: { x: 182, y: 120 } };
    expect(decideInteractive({ ...nearEdge, interactive: false })).toBe(false);
    expect(decideInteractive({ ...nearEdge, interactive: true })).toBe(true);
    expect(decideInteractive({ ...base, cursor: { x: 184, y: 120 }, interactive: true })).toBe(false);
    expect(decideInteractive({ ...base, cursor: { x: 97, y: 97 }, interactive: true })).toBe(true);
  });

  it('is never interactive when disabled or hidden, even while dragging', () => {
    expect(decideInteractive({ ...base, interactionsEnabled: false })).toBe(false);
    expect(decideInteractive({ ...base, visible: false })).toBe(false);
    expect(decideInteractive({ ...base, interactionsEnabled: false, dragging: true })).toBe(false);
    expect(decideInteractive({ ...base, visible: false, dragging: true })).toBe(false);
  });

  it('refuses an unhealthy renderer or a stale region unless dragging', () => {
    expect(decideInteractive({ ...base, rendererHealthy: false })).toBe(false);
    expect(decideInteractive({ ...base, hitRegionAgeMs: 1501 })).toBe(false);
    expect(decideInteractive({ ...base, hitRegionAgeMs: 1500 })).toBe(true);
    expect(decideInteractive({ ...base, hitRegionAgeMs: Infinity })).toBe(false);
    expect(decideInteractive({ ...base, hitRegionAgeMs: NaN })).toBe(false);
    expect(decideInteractive({ ...base, rendererHealthy: false, dragging: true, cursor: { x: 0, y: 0 } })).toBe(true);
    expect(decideInteractive({ ...base, hitRegionAgeMs: 4000, dragging: true, cursor: null })).toBe(true);
  });

  it('gives up a drag when the renderer died long ago', () => {
    expect(decideInteractive({ ...base, rendererHealthy: false, dragging: true, hitRegionAgeMs: 6000 })).toBe(false);
  });

  it('is not interactive without a cursor or with empty rects', () => {
    expect(decideInteractive({ ...base, cursor: null })).toBe(false);
    expect(decideInteractive({ ...base, cursor: { x: NaN, y: 0 } })).toBe(false);
    expect(decideInteractive({ ...base, hitRects: [] })).toBe(false);
    expect(decideInteractive({ ...base, hitRects: [{ x: 100, y: 100, width: 0, height: 60 }] })).toBe(false);
  });
});

describe('decideInteractive: excluded areas (taskbars)', () => {
  // A taskbar whose top edge is at y = 150: it covers the cat's lower 10 rows.
  const taskbar = { x: 0, y: 150, width: 1920, height: 60 };

  it('never takes the mouse inside an excluded area, also within the hysteresis margin', () => {
    const over = { ...base, excludeRects: [taskbar] };
    expect(decideInteractive({ ...over, cursor: { x: 120, y: 149 } })).toBe(true);
    for (const interactive of [false, true]) {
      for (const y of [150, 155, 159, 161]) expect(decideInteractive({ ...over, interactive, cursor: { x: 120, y } }), `y=${y}`).toBe(false);
    }
    // Without the exclusion the same rows belong to the cat (and the margin reaches 3 px further).
    expect(decideInteractive({ ...base, cursor: { x: 120, y: 155 } })).toBe(true);
    expect(decideInteractive({ ...base, interactive: true, cursor: { x: 120, y: 161 } })).toBe(true);
  });

  it('stays click-through when nothing of the region is left once the excluded areas are cut out', () => {
    const covered = { ...base, excludeRects: [{ x: 0, y: 0, width: 300, height: 130 }, { x: 0, y: 130, width: 300, height: 100 }] };
    for (const cursor of [{ x: 120, y: 120 }, { x: 179, y: 159 }, { x: 100, y: 100 }]) {
      expect(decideInteractive({ ...covered, cursor })).toBe(false);
      expect(decideInteractive({ ...covered, cursor, interactive: true })).toBe(false);
    }
  });

  it('keeps an ongoing drag (the press started outside) and ignores empty or non-finite areas', () => {
    expect(decideInteractive({ ...base, excludeRects: [taskbar], dragging: true, cursor: { x: 120, y: 170 } })).toBe(true);
    const junk = [{ x: 0, y: 0, width: 0, height: 500 }, { x: Number.NaN, y: 0, width: 500, height: 500 }, { x: 0, y: 0, width: Infinity, height: 500 }];
    expect(decideInteractive({ ...base, excludeRects: junk })).toBe(true);
  });
});

describe('clipRects', () => {
  const area = (rs: readonly { width: number; height: number }[]): number => rs.reduce((a, r) => a + r.width * r.height, 0);
  const covers = (rs: readonly { x: number; y: number; width: number; height: number }[], x: number, y: number): number =>
    rs.filter((r) => x >= r.x && x < r.x + r.width && y >= r.y && y < r.y + r.height).length;

  it('cuts holes out exactly, without overlapping pieces', () => {
    const holes = [
      { x: 110, y: 90, width: 20, height: 30 }, // notch at the top
      { x: 150, y: 140, width: 100, height: 100 }, // bottom-right corner
      { x: 0, y: 0, width: 10, height: 10 }, // elsewhere
    ];
    const out = clipRects([cat], holes);
    expect(area(out)).toBe(80 * 60 - 20 * 20 - 30 * 20);
    for (let x = 95; x < 185; x += 1) {
      for (let y = 95; y < 165; y += 1) {
        const inCat = x >= 100 && x < 180 && y >= 100 && y < 160;
        const inHole = holes.some((h) => x >= h.x && x < h.x + h.width && y >= h.y && y < h.y + h.height);
        expect(covers(out, x, y), `${x},${y}`).toBe(inCat && !inHole ? 1 : 0);
      }
    }
  });

  it('returns nothing for a fully covered rect and drops empty input rects', () => {
    expect(clipRects([cat], [{ x: 0, y: 0, width: 500, height: 500 }])).toEqual([]);
    expect(clipRects([{ x: 0, y: 0, width: 0, height: 5 }, cat], [])).toEqual([cat]);
  });
});

describe('ClickThroughGate', () => {
  it('reports changes only on transitions and keeps hysteresis', () => {
    const gate = new ClickThroughGate();
    const { interactive: _i, ...input } = base;
    expect(gate.update({ ...input, cursor: { x: 50, y: 50 } })).toEqual({ interactive: false, changed: false });
    expect(gate.update(input)).toEqual({ interactive: true, changed: true });
    expect(gate.update({ ...input, cursor: { x: 182, y: 120 } })).toEqual({ interactive: true, changed: false });
    expect(gate.update({ ...input, cursor: { x: 190, y: 120 } })).toEqual({ interactive: false, changed: true });
    expect(gate.update({ ...input, cursor: { x: 182, y: 120 } })).toEqual({ interactive: false, changed: false });
    gate.update(input);
    expect(gate.reset()).toEqual({ interactive: false, changed: true });
    expect(gate.interactive).toBe(false);
  });
});

describe('suggestPollIntervalMs', () => {
  const p = { cursor: { x: 0, y: 0 }, catBounds: cat, interactive: false, dragging: false, catAsleep: false, visible: true };
  it('polls at ~60 Hz near the cat, while interactive or dragging', () => {
    expect(suggestPollIntervalMs({ ...p, cursor: { x: 150, y: 250 } })).toBe(16);
    expect(suggestPollIntervalMs({ ...p, cursor: { x: 2000, y: 2000 }, dragging: true })).toBe(16);
    expect(suggestPollIntervalMs({ ...p, cursor: { x: 2000, y: 2000 }, interactive: true })).toBe(16);
  });
  it('polls at ~20 Hz otherwise and ~8 Hz when asleep and far', () => {
    // The cat spans x 100..180; distances below are measured from its right edge.
    expect(suggestPollIntervalMs({ ...p, cursor: { x: 800, y: 100 } })).toBe(50);
    expect(suggestPollIntervalMs({ ...p, cursor: { x: 800, y: 100 }, catAsleep: true })).toBe(125);
    expect(suggestPollIntervalMs({ ...p, cursor: { x: 600, y: 100 }, catAsleep: true })).toBe(50);
    expect(suggestPollIntervalMs({ ...p, cursor: null, catAsleep: true })).toBe(125);
  });
  it('polls slowly when there is nothing to interact with', () => {
    expect(suggestPollIntervalMs({ ...p, visible: false })).toBe(125);
    expect(suggestPollIntervalMs({ ...p, catBounds: null })).toBe(125);
  });
});
