// Reactions (startled, annoyed, an irritated hide) play out: the next stroke or click
// does not cut them short, and stroking a reacting cat only irritates it further.
import { describe, expect, it } from 'vitest';
import type { BehaviorState } from '../../../../src/shared/cat';
import type { SimOutput } from '../../../../src/shared/sim';
import { STATE_SPECS } from '../../../../src/core/behavior';
import { Harness } from './fixtures';

const catPoint = (o: SimOutput | null) => ({ x: o?.x ?? 0, y: (o?.y ?? 0) - 30 });
const REACTIONS: readonly BehaviorState[] = ['annoyed', 'startled'];

function throwCat(h: Harness): void {
  h.step([{ type: 'pointer.dragStart', at: catPoint(h.last) }]);
  h.env.dragCursor = { x: 900, y: 300 };
  h.step();
  h.step([{ type: 'pointer.dragEnd', at: { x: 900, y: 300 }, velocity: { x: 2500, y: -1500 } }]);
  h.env.dragCursor = null;
}

describe('petting a reacting cat', () => {
  it('continuous over-petting: the annoyed reaction lasts its dwell, and stroking on escalates to hiding', () => {
    for (const seed of [1, 2, 3, 4, 5]) {
      const h = new Harness({ seed });
      h.run(2000);
      let annoyanceAtEntry: number | null = null;
      let rose = false;
      h.run(60_000, 33, (hh, i) => {
        const s = hh.last!.state;
        if (s === 'annoyed') {
          const a = hh.sim.serialize().stats.annoyance;
          annoyanceAtEntry ??= a;
          if (a > annoyanceAtEntry + 0.1) rose = true;
        } else {
          annoyanceAtEntry = null;
        }
        return i % 9 === 0 ? [{ type: 'pointer.pet', at: catPoint(hh.last), strength: 0.8 }] : [];
      });
      const fromAnnoyed = h.transitions.filter((t) => t.from === 'annoyed');
      expect(h.transitions.some((t) => t.to === 'annoyed')).toBe(true);
      expect(fromAnnoyed.length).toBeGreaterThan(0);
      for (const t of fromAnnoyed) {
        expect(t.cause).not.toBe('interaction');
        expect(t.dwellMs).toBeGreaterThanOrEqual(STATE_SPECS.annoyed.dwellMs[0]);
        expect(t.fromDone).toBe(true);
      }
      expect(rose).toBe(true);
      expect(h.transitions.some((t) => t.from === 'annoyed' && t.to === 'hiding')).toBe(true);
    }
  });

  it('a cat that lands startled or annoyed after a throw is not purring at the next stroke', () => {
    let reactions = 0;
    for (const seed of [11, 12, 13, 14, 15, 16]) {
      const h = new Harness({ seed });
      h.run(2000);
      throwCat(h);
      const ok = h.runUntil((o) => REACTIONS.includes(o.state), 4000);
      if (!ok) continue;
      reactions++;
      const reaction = h.last!.state;
      const enteredAt = h.transitions.filter((t) => t.to === reaction).at(-1)!.at;
      h.run(4000, 33, (hh, i) => (i % 3 === 0 ? [{ type: 'pointer.pet', at: catPoint(hh.last), strength: 1 }] : []));
      const left = h.transitions.find((t) => t.from === reaction && t.at >= enteredAt)!;
      expect(left).toBeDefined();
      expect(left.fromDone).toBe(true);
      expect(left.to).not.toBe('beingPetted');
      expect(left.dwellMs).toBeGreaterThanOrEqual(STATE_SPECS[reaction].dwellMs[0]);
      expect(h.transitions.some((t) => t.from === reaction && t.cause === 'interaction')).toBe(false);
    }
    expect(reactions).toBeGreaterThanOrEqual(3);
  });

  it('a double-tap does not turn an annoyed cat into a playful hop before its minimum dwell', () => {
    for (const seed of [21, 22, 23]) {
      const h = new Harness({ seed });
      h.run(2000);
      throwCat(h);
      if (!h.runUntil((o) => o.state === 'annoyed', 4000)) continue;
      const enteredAt = h.now;
      h.run(STATE_SPECS.annoyed.dwellMs[0] - 200, 33, (hh, i) => (i % 4 === 0 ? [{ type: 'pointer.doubleTap', at: catPoint(hh.last) }] : []));
      expect(h.transitions.some((t) => t.at >= enteredAt && t.from === 'annoyed')).toBe(false);
    }
  });

  it('petting still soothes a calm cat and wakes a sleeping one', () => {
    const h = new Harness({ seed: 31 });
    h.run(2000);
    h.run(3000, 33, (hh, i) => (i % 10 === 0 ? [{ type: 'pointer.pet', at: catPoint(hh.last), strength: 0.8 }] : []));
    expect(h.last!.state).toBe('beingPetted');
  });
});
