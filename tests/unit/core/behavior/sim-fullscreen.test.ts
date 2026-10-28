// A display with a fullscreen app in front is off limits: the cat never walks, runs or
// jumps onto it, and a cat already there can be called back to the user's display.
import { describe, expect, it } from 'vitest';
import type { PersistedCat } from '../../../../src/shared/catState';
import type { SimEvent, SimOutput } from '../../../../src/shared/sim';
import type { WindowInfo } from '../../../../src/shared/world';
import { mulberry32, newPersistedCat } from '../../../../src/core/behavior';
import { callCat, DUAL_FLAT, Harness, settingsWith } from './fixtures';

const MIN = 60_000;
const WALL = 1_800_000_000_000;
/** Display 1's right edge minus half a body (84 px at size 1, scale 1). */
const WALL_X = 1920 - 42;

function restoredAt(displayKey: string, xFrac: number): PersistedCat {
  const cat = newPersistedCat(mulberry32(7), WALL - 60_000);
  cat.lastPosition = { displayKey, xFrac, support: 'floor' };
  return cat;
}

const fullscreenApp: WindowInfo = {
  id: 'game',
  rect: { x: 1920, y: 0, width: 1920, height: 1080 },
  processName: 'game.exe',
  category: 'video',
  minimized: false,
  maximized: false,
  fullscreen: true,
  excluded: false,
};

/** User working on display 1 next to a fullscreen app on display 2, with every lure toward display 2. */
function lures(h: Harness, i: number): SimEvent[] {
  const x = 1500 + 900 * Math.sin(i / 40);
  h.env.cursor = { x, y: 1000, speed: 1200 };
  const ev: SimEvent[] = [];
  if (i % 29 === 0) ev.push({ type: 'cursor.flick', speed: 4000, at: { x: 2100, y: 1000 } });
  if (i % 300 === 0) ev.push({ type: 'activity.typingStart' });
  if (i % 450 === 0) ev.push({ type: 'command.callCat', at: { x: 2600, y: 1000 } });
  if (i % 700 === 0) ev.push({ type: 'window.shown', window: { ...fullscreenApp, id: `w${i}`, rect: { x: 2200, y: 300, width: 900, height: 600 }, fullscreen: false } });
  return ev;
}

describe('fullscreen displays are off limits', () => {
  it.each(['hide', 'quiet'] as const)('with "%s", a cat on the other display never goes onto the fullscreen one', (fullscreenBehavior) => {
    for (const seed of [1, 2, 3, 4]) {
      const h = new Harness({ seed, world: DUAL_FLAT, persisted: restoredAt('1', 0.85), settings: settingsWith({ behavior: { fullscreenBehavior, autonomy: 1, cursorPlay: 1 } }) });
      h.env.fullscreenDisplayIds = ['2'];
      h.env.foreground = fullscreenApp;
      let maxX = -Infinity;
      let onFullscreen = 0;
      let hidden = 0;
      h.run(30 * MIN, 100, (hh, i) => {
        const o = hh.last as SimOutput;
        maxX = Math.max(maxX, o.x);
        if (o.displayId === '2') onFullscreen++;
        if (!o.visible) hidden++;
        return lures(hh, i);
      });
      expect(onFullscreen).toBe(0);
      expect(maxX).toBeLessThanOrEqual(WALL_X + 1e-6);
      expect(hidden).toBeLessThanOrEqual(1);
      expect(h.sim.serialize().lastPosition?.displayKey).toBe('1');
    }
  });

  it('a cat already on the display when the app goes fullscreen hides there, and Call cat brings it back', () => {
    const h = new Harness({ seed: 5, world: DUAL_FLAT, persisted: restoredAt('2', 0.5) });
    h.run(2000);
    h.env.fullscreenDisplayIds = ['2'];
    h.run(MIN, 100);
    expect(h.last!.state).toBe('away');
    expect(h.last!.visible).toBe(false);
    callCat(h, { x: 600, y: 1000 }, 100);
    expect(h.last!.displayId).toBe('1');
    expect(h.last!.snap).toBe(true);
    expect(h.last!.state).not.toBe('away');
    const arrived = h.runUntil((o) => o.displayId === '1' && Math.abs(o.x - 600) < 5 && o.state === 'idle', 60_000);
    expect(arrived).toBe(true);
    expect(h.last!.visible).toBe(true);
    // A call that points at a fullscreen display does not move it there.
    h.env.fullscreenDisplayIds = ['1', '2'];
    h.run(2000, 100);
    expect(h.last!.state).toBe('away');
    h.step([{ type: 'command.callCat', at: { x: 2600, y: 1000 } }], 100);
    expect(h.last!.displayId).toBe('1');
    expect(h.last!.x).toBeCloseTo(600, 0);
    expect(h.last!.state).toBe('away');
  });

  it('a quiet cat on the fullscreen display stays asleep there until it is called over', () => {
    const h = new Harness({ seed: 6, world: DUAL_FLAT, persisted: restoredAt('2', 0.5), settings: settingsWith({ behavior: { fullscreenBehavior: 'quiet' } }) });
    h.run(2000);
    h.env.fullscreenDisplayIds = ['2'];
    h.run(MIN, 100);
    expect(h.last!.state).toBe('sleeping');
    expect(h.last!.displayId).toBe('2');
    callCat(h, { x: 400, y: 1000 }, 100);
    expect(h.last!.displayId).toBe('1');
    expect(h.sim.debugInfo().mode).toBe('normal');
    expect(h.runUntil((o) => Math.abs(o.x - 400) < 5 && o.state === 'idle', 60_000)).toBe(true);
  });

  it('"ignore" keeps the fullscreen display walkable', () => {
    const h = new Harness({ seed: 7, world: DUAL_FLAT, persisted: restoredAt('1', 0.85), settings: settingsWith({ behavior: { fullscreenBehavior: 'ignore' } }) });
    h.env.fullscreenDisplayIds = ['2'];
    h.run(1000);
    callCat(h, { x: 2600, y: 1000 });
    expect(h.runUntil((o) => o.displayId === '2' && Math.abs(o.x - 2600) < 5, 60_000)).toBe(true);
  });
});
