import { describe, expect, it } from 'vitest';
import type { SimEnv, SimEvent } from '../../../../src/shared/sim';
import { defaultSettings } from '../../../../src/shared/settings';
import { createCatSim, mulberry32 } from '../../../../src/core/behavior';
import { Harness, world } from './fixtures';

function env(now: number, over: Partial<SimEnv> = {}): SimEnv {
  return {
    now,
    dt: 33,
    cursor: null,
    cursorOverCat: false,
    userIdleMs: 0,
    typing: false,
    typingIntensity: 0,
    foreground: null,
    platforms: [],
    getWindowRect: () => null,
    fullscreenDisplayIds: [],
    paused: false,
    hidden: false,
    dragCursor: null,
    localHour: 12,
    ...over,
  };
}

describe('robustness against bad host input', () => {
  it('works in an empty world (fallback display)', () => {
    const sim = createCatSim({ persisted: null, settings: defaultSettings(), world: world(), now: 0, random: mulberry32(1), wallClock: () => 1 });
    let now = 0;
    for (let i = 0; i < 2000; i++) {
      const o = sim.tick(env((now += 33)), []);
      expect(Number.isFinite(o.x) && Number.isFinite(o.y)).toBe(true);
    }
    expect(sim.debugInfo().fallbackWorld).toBe(true);
  });

  it('tolerates NaN clocks, NaN environment values, throwing callbacks and malformed events', () => {
    const sim = createCatSim({ persisted: null, settings: defaultSettings(), world: world(), now: Number.NaN, random: () => Number.NaN, wallClock: () => Number.NaN });
    const garbage = [
      { type: 'window.shown' },
      { type: 'window.foreground', window: { id: 'x', rect: { x: Number.NaN, y: 0, width: 1, height: 1 } }, switchesPerMinute: Number.NaN },
      { type: 'pointer.dragEnd', at: null, velocity: null },
      { type: 'perception.visual', summary: null },
      { type: 'perception.ai', report: { reaction: 'shutdown', interest: 1 }, regionPx: { x: 0, y: 0, width: 10, height: 10 } },
      { type: 'cursor.flick', speed: Number.POSITIVE_INFINITY, at: { x: 1, y: 1 } },
      { type: 'pointer.pet', at: { x: 0, y: 0 }, strength: Number.NaN },
      { type: 'command.callCat', at: { x: Number.NaN, y: 0 } },
      { type: 'totally.unknown' },
    ] as unknown as SimEvent[];
    for (let i = 0; i < 500; i++) {
      const o = sim.tick(
        env(i % 7 === 0 ? Number.NaN : i * 33, {
          dt: i % 5 === 0 ? Number.NaN : i % 3 === 0 ? 10_000 : 33,
          cursor: { x: Number.NaN, y: 5, speed: Number.NaN },
          userIdleMs: Number.NaN,
          localHour: Number.NaN,
          getWindowRect: () => {
            throw new Error('boom');
          },
          platforms: [{ windowId: 'p', y: Number.NaN, x0: 0, x1: 100 }],
        }),
        i % 10 === 0 ? garbage : [],
      );
      for (const v of [o.x, o.y, o.opacity, o.arousal, o.contentment, o.nextTickMs, o.clipStartedAt]) expect(Number.isFinite(v)).toBe(true);
    }
    const p = sim.serialize();
    expect(p.catId.length).toBeGreaterThanOrEqual(8);
  });

  it('keeps a held cat inside the world when the drag cursor leaves every display', () => {
    const h = new Harness({ seed: 3 });
    h.run(1000);
    h.step([{ type: 'pointer.dragStart', at: { x: h.last!.x, y: h.last!.y - 30 } }]);
    for (const p of [
      { x: -5000, y: 500 },
      { x: 99999, y: -99999 },
      { x: 900, y: 1075 },
    ]) {
      h.env.dragCursor = p;
      const o = h.step();
      expect(o.x).toBeGreaterThanOrEqual(0);
      expect(o.x).toBeLessThanOrEqual(1920);
      expect(o.y).toBeGreaterThanOrEqual(0);
      expect(o.y).toBeLessThanOrEqual(1040);
    }
  });

  it('does not let a stale or far-away drag release teleport the cat', () => {
    const h = new Harness({ seed: 3 });
    h.run(1000);
    const x0 = h.last!.x;
    h.step([
      { type: 'pointer.dragStart', at: { x: x0, y: 1010 } },
      { type: 'pointer.dragEnd', at: { x: x0 + 1500, y: 100 }, velocity: { x: 0, y: 0 } },
    ]);
    expect(h.last!.snap).toBe(false);
    expect(Math.abs(h.last!.x - x0)).toBeLessThan(5);
  });
});
