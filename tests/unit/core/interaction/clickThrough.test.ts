import { describe, expect, it } from 'vitest';
import { ClickThroughGate, decideInteractive, suggestPollIntervalMs } from '../../../../src/core/interaction/clickThrough';
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
