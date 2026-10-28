// "Alive but not hyperactive": over hours of a typical session the cat mostly rests,
// watches and grooms, with short bursts of activity and real variety.
import { describe, expect, it } from 'vitest';
import type { BehaviorState } from '../../../../src/shared/cat';
import type { WindowInfo } from '../../../../src/shared/world';
import { Harness } from './fixtures';

const fg: WindowInfo = { id: 'w1', rect: { x: 300, y: 300, width: 900, height: 500 }, processName: 'code.exe', category: 'code', minimized: false, maximized: false, fullscreen: false, excluded: false };
const CALM: ReadonlySet<BehaviorState> = new Set(['resting', 'watchingUser', 'idle', 'grooming', 'sleeping', 'fallingAsleep', 'wakingUp', 'watchingCursor', 'curious', 'inspectingWindow', 'beingPetted']);
const ACTIVE: ReadonlySet<BehaviorState> = new Set(['running', 'playing', 'chasingCursor']);

describe('behaviour mix over a working session', () => {
  it('is mostly calm, with short bursts of activity, naps and variety', () => {
    const total = new Map<BehaviorState, number>();
    let transitions = 0;
    const hours = 2;
    const seeds = [1, 2, 3, 4, 5, 6];
    for (const seed of seeds) {
      const h = new Harness({ seed });
      h.env.foreground = fg;
      h.env.windows = { w1: fg.rect, w2: { x: 1300, y: 760, width: 500, height: 280 } };
      let cx = 900;
      h.run(hours * 3600_000, 100, (hh, i) => {
        // The user alternates between moving the mouse, typing and reading.
        const phase = Math.floor(i / 600) % 4;
        hh.env.typing = phase === 1;
        if (phase === 0) {
          cx = 900 + 600 * Math.sin(i / 25);
          hh.env.cursor = { x: cx, y: 700 + 300 * Math.cos(i / 31), speed: 500 };
        } else {
          hh.env.cursor = { x: cx, y: 500, speed: 0 };
        }
        const s = hh.last!.state;
        total.set(s, (total.get(s) ?? 0) + 100);
      });
      transitions += h.transitions.filter((t) => t.counted).length;
    }
    const sum = [...total.values()].reduce((a, b) => a + b, 0);
    const share = (pred: (s: BehaviorState) => boolean) => [...total.entries()].filter(([s]) => pred(s)).reduce((a, [, v]) => a + v, 0) / sum;
    expect(share((s) => CALM.has(s))).toBeGreaterThan(0.8);
    expect(share((s) => ACTIVE.has(s))).toBeGreaterThan(0.001);
    expect(share((s) => ACTIVE.has(s))).toBeLessThan(0.08);
    expect(share((s) => s === 'sleeping')).toBeGreaterThan(0.03);
    expect(share((s) => s === 'resting')).toBeLessThan(0.65);
    expect([...total.keys()].length).toBeGreaterThanOrEqual(10);
    const perHour = transitions / (hours * seeds.length);
    expect(perHour).toBeGreaterThan(40);
    expect(perHour).toBeLessThan(400);
  });
});
