// v1.2 T8 screen-edge guard in the pure click-through decision (ADR 0003 §6.1 (a), §15.1): the
// obstacle cut-outs (wallGuardRects) and the hover dwell in decideInteractive. Pure; no mocks.
import { describe, expect, it } from 'vitest';
import { cursorInHitZone, decideInteractive, wallGuardRects, type ClickThroughInput } from '../../../../src/core/interaction/clickThrough';
import type { Rect } from '../../../../src/shared/geometry';

const R = (x: number, y: number, width: number, height: number): Rect => ({ x, y, width, height });
/** A cat clinging to the left screen edge of a 1920x1200 display. */
const CAT = R(0, 500, 110, 80);
const HIT = [R(10, 505, 90, 70)];

const base = (over: Partial<ClickThroughInput> = {}): ClickThroughInput => ({
  cursor: { x: 50, y: 540 },
  hitRects: HIT,
  excludeRects: [],
  interactive: false,
  interactionsEnabled: true,
  visible: true,
  rendererHealthy: true,
  dragging: false,
  hitRegionAgeMs: 10,
  ...over,
});

describe('wallGuardRects: the obstacle windows meeting the cat are cut out', () => {
  it('returns the obstacles that meet the cat bounds, unclipped, and nothing else', () => {
    const maximized = R(-8, -8, 1936, 1168);
    const farAway = R(900, 100, 400, 300);
    expect(wallGuardRects(CAT, [maximized, farAway])).toEqual([maximized]);
  });

  it("keeps this app's own Settings window and a small topmost picture-in-picture window", () => {
    const settings = R(40, 300, 700, 600);
    const pip = R(60, 560, 320, 180);
    expect(wallGuardRects(CAT, [settings, pip])).toEqual([settings, pip]);
  });

  it('ignores empty and non-finite obstacles; a non-finite or empty cat yields nothing', () => {
    expect(wallGuardRects(CAT, [R(0, 0, 0, 900), R(Number.NaN, 0, 100, 100), R(0, 0, Infinity, 100)])).toEqual([]);
    expect(wallGuardRects(R(Number.NaN, 0, 10, 10), [R(0, 0, 100, 100)])).toEqual([]);
    expect(wallGuardRects(R(0, 0, 0, 10), [R(0, 0, 100, 100)])).toEqual([]);
  });

  it('a cursor over the cat where a guard obstacle lies stays click-through (the click goes to the window)', () => {
    const scrollbarWindow = R(-8, 0, 1936, 1160);
    const guard = wallGuardRects(CAT, [scrollbarWindow]);
    expect(decideInteractive(base({ excludeRects: guard }))).toBe(false);
    // Without the guard the same cursor would grab the cat.
    expect(decideInteractive(base())).toBe(true);
  });

  it('a cat mid-leap over a window is click-through over the window, grabbable over the clear desktop', () => {
    const window = R(0, 0, 60, 1200);
    const leaping = R(20, 400, 110, 80);
    const guard = wallGuardRects(leaping, [window]);
    const hit = [R(25, 405, 100, 70)];
    expect(decideInteractive(base({ hitRects: hit, cursor: { x: 40, y: 440 }, excludeRects: guard }))).toBe(false);
    expect(decideInteractive(base({ hitRects: hit, cursor: { x: 110, y: 440 }, excludeRects: guard }))).toBe(true);
  });

  it('a fail-closed guard (the whole cat, grown) leaves nothing interactive, even with the hysteresis margin', () => {
    const failClosed = [R(CAT.x - 16, CAT.y - 16, CAT.width + 32, CAT.height + 32)];
    for (const interactive of [false, true]) {
      for (let x = 0; x <= 110; x += 5) {
        for (let y = 500; y <= 580; y += 5) expect(decideInteractive(base({ cursor: { x, y }, interactive, excludeRects: failClosed }))).toBe(false);
      }
    }
  });
});

describe('decideInteractive: hover dwell (v1.2)', () => {
  it('without a dwell the cat takes the mouse at once (v1.1 behaviour)', () => {
    expect(decideInteractive(base())).toBe(true);
    expect(decideInteractive(base({ hoverDwellMs: 0 }))).toBe(true);
  });

  it('with a dwell it waits until the cursor rested long enough; unknown hover time counts as not yet', () => {
    expect(decideInteractive(base({ hoverDwellMs: 300 }))).toBe(false);
    expect(decideInteractive(base({ hoverDwellMs: 300, hoveredMs: 299 }))).toBe(false);
    expect(decideInteractive(base({ hoverDwellMs: 300, hoveredMs: 300 }))).toBe(true);
    expect(decideInteractive(base({ hoverDwellMs: 300, hoveredMs: Number.NaN }))).toBe(false);
  });

  it('an already interactive overlay keeps the mouse (the grab that started after the dwell)', () => {
    expect(decideInteractive(base({ hoverDwellMs: 300, interactive: true }))).toBe(true);
  });

  it('fails closed on an impossible dwell, and the dwell never overrides exclusions, health or age', () => {
    expect(decideInteractive(base({ hoverDwellMs: Number.NaN, hoveredMs: 1e9 }))).toBe(false);
    expect(decideInteractive(base({ hoverDwellMs: Infinity, hoveredMs: 1e9 }))).toBe(false);
    expect(decideInteractive(base({ hoverDwellMs: 300, hoveredMs: 1000, excludeRects: [R(0, 0, 200, 1200)] }))).toBe(false);
    expect(decideInteractive(base({ hoverDwellMs: 300, hoveredMs: 1000, rendererHealthy: false }))).toBe(false);
    expect(decideInteractive(base({ hoverDwellMs: 300, hoveredMs: 1000, hitRegionAgeMs: 5000 }))).toBe(false);
  });

  it('a drag in progress is never interrupted by the dwell', () => {
    expect(decideInteractive(base({ hoverDwellMs: 300, dragging: true, cursor: { x: 900, y: 900 } }))).toBe(true);
  });

  it('cursorInHitZone is the geometric part only (no dwell, health or age)', () => {
    expect(cursorInHitZone(base({ rendererHealthy: false, hitRegionAgeMs: 1e9 }))).toBe(true);
    expect(cursorInHitZone(base({ cursor: { x: 500, y: 540 } }))).toBe(false);
    expect(cursorInHitZone(base({ excludeRects: [R(0, 0, 200, 1200)] }))).toBe(false);
    expect(cursorInHitZone(base({ cursor: null }))).toBe(false);
  });
});
