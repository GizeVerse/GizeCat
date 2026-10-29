// v1.1.1 leap integration in the sim: a window side that ends far above the floor is reached by
// a crouch, one ballistic leap and a catch. During the leap the cat is airborne in the jump pose
// (clip, vy for the renderer's jump clip, upright bounds); once it clings, the activity that
// started the climb carries on (the climb, the pull-up and the walk on top are that activity).
import { describe, expect, it } from 'vitest';
import type { BehaviorState } from '../../../../src/shared/cat';
import type { SimOutput } from '../../../../src/shared/sim';
import { callCat, Harness, topId, WAKE_MS } from './fixtures';
import { TYPICAL_FRAME, USER_SCREEN, userCat } from './liveness';

const SCALE = 1.25;
const BW = 84 * SCALE;
const BH = 64 * SCALE;

const onWall = (o: SimOutput): boolean => o.support.kind === 'surface' && o.support.orientation === 'wall';

interface LeapTrace {
  h: Harness;
  /** Outputs while leaping (jumping state with a wall as support: flying onto the side). */
  leap: SimOutput[];
  /** Diagnostics support seen during the leap and while clinging. */
  leapSupport: Set<string>;
  clingSupport: Set<string>;
  /** The first output after the catch, and the activity variant then. */
  caught: SimOutput | null;
  caughtVariant: unknown;
  /** States between the catch and the arrival on the top. */
  afterCatch: BehaviorState[];
  topped: boolean;
}

/** Calls the cat onto the typical window's top: the only way up is a leap onto a side. */
function leapOnto(seed: number): LeapTrace {
  const h = new Harness({ seed, world: USER_SCREEN, persisted: userCat(seed) });
  h.env.windows = { w: TYPICAL_FRAME };
  h.run(WAKE_MS);
  callCat(h, { x: 800, y: TYPICAL_FRAME.y - 20 });
  const t: LeapTrace = { h, leap: [], leapSupport: new Set(), clingSupport: new Set(), caught: null, caughtVariant: null, afterCatch: [], topped: false };
  const end = h.now + 60_000;
  while (h.now < end) {
    const o = h.step([], 16);
    const d = h.sim.surfaceDiagnostics().decision;
    if (onWall(o) && o.state === 'jumping') {
      t.leap.push(o);
      t.leapSupport.add(d.support);
    } else if (onWall(o)) {
      t.clingSupport.add(d.support);
      if (!t.caught && t.leap.length > 0) {
        t.caught = o;
        t.caughtVariant = h.sim.debugInfo().variant;
      }
    }
    if (t.caught) t.afterCatch.push(o.state);
    if (o.support.kind === 'surface' && o.support.surfaceId === topId('w')) {
      t.topped = true;
      break;
    }
  }
  return t;
}

describe('leap and cling in the sim (v1.1.1)', () => {
  it('leaps in the jump pose: jump clip, rising vy, upright airborne bounds, "air" in diagnostics', () => {
    const t = leapOnto(3);
    expect(t.leap.length).toBeGreaterThan(3);
    for (const o of t.leap) {
      expect(o.clip).toBe('jump');
      expect(Number.isFinite(o.vy)).toBe(true);
      // Upright, one body across and one body height above the anchor: not the hanging pose.
      expect(o.boundsPx.width).toBeCloseTo(BW, 6);
      expect(o.boundsPx.height).toBeCloseTo(BH, 6);
      expect(o.boundsPx.x).toBeCloseTo(o.x - BW / 2, 6);
      expect(o.boundsPx.y).toBeCloseTo(o.y - BH, 6);
    }
    // The renderer's jump clip shapes the push-off from vy (negative = rising).
    expect(t.leap[0]!.vy).toBeLessThan(-100);
    expect(t.leap.some((o) => o.y < t.leap[0]!.y - BH)).toBe(true);
    expect([...t.leapSupport]).toEqual(['air']);
  });

  it('once it clings, the called activity carries on: climb, pull-up and onto the top without landing', () => {
    for (const seed of [1, 2, 3]) {
      const t = leapOnto(seed);
      expect(t.caught, `seed ${seed}`).not.toBeNull();
      // The jump ended in the activity that started it, not in a "landing" on the wall.
      expect(t.caught!.state).toBe('running');
      expect(t.caughtVariant).toBe('called');
      expect(t.caught!.clip).toBe('climb');
      expect([...t.clingSupport]).toContain('windowSide');
      const fromJump = t.h.transitions.filter((r) => r.from === 'jumping');
      expect(fromJump.some((r) => r.to === 'running' && r.cause === 'physical')).toBe(true);
      expect(t.topped, `seed ${seed}`).toBe(true);
      expect(t.afterCatch).not.toContain('landing');
      expect(t.afterCatch).not.toContain('falling');
      expect(t.h.sim.debugInfo().invalidSamples).toEqual([]);
    }
  });
});
