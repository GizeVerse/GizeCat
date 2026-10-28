// Lifecycle modes (hidden, locked, suspended, paused, quiet) and what they must not leave behind.
import { describe, expect, it } from 'vitest';
import type { BehaviorState } from '../../../../src/shared/cat';
import type { PersistedCat } from '../../../../src/shared/catState';
import type { SimOutput } from '../../../../src/shared/sim';
import { mulberry32, newPersistedCat } from '../../../../src/core/behavior';
import { Harness, settingsWith } from './fixtures';

const MIN = 60_000;
const HOUR = 60 * MIN;
const WALL = 1_800_000_000_000;
const catPoint = (o: SimOutput | null) => ({ x: o?.x ?? 0, y: (o?.y ?? 0) - 30 });
const ASLEEP: readonly BehaviorState[] = ['sleeping', 'fallingAsleep'];

function restored(): PersistedCat {
  const cat = newPersistedCat(mulberry32(3), WALL - 60_000);
  cat.lastPosition = { displayKey: '1', xFrac: 0.4, support: 'floor' };
  return cat;
}

/** Runs until the cat is asleep with the user idle for longer than the idle-sleep threshold. */
function idleAsleep(h: Harness): void {
  let idle = 0;
  const asleep = h.runUntil((o) => {
    idle += 100;
    h.env.userIdleMs = idle;
    return o.state === 'sleeping';
  }, 10 * MIN, 100);
  expect(asleep).toBe(true);
}

describe('favourite spots are learned from naps the cat chooses', () => {
  it.each<[string, (h: Harness) => void]>([
    ['the session is locked', (h) => h.step([{ type: 'system.lock' }])],
    ['the cat is paused', (h) => (h.env.paused = true)],
    ['a fullscreen app keeps it quiet', (h) => (h.env.fullscreenDisplayIds = ['1'])],
  ])('no spot from hours of forced sleep while %s', (_label, force) => {
    const h = new Harness({ seed: 81, settings: settingsWith({ behavior: { fullscreenBehavior: 'quiet' } }) });
    h.run(2000);
    force(h);
    h.run(8 * HOUR, 250);
    expect(h.last!.state).toBe('sleeping');
    expect(h.sim.serialize().memory.favoriteSpots).toEqual([]);
  });

  it('a voluntary nap interrupted by a lock is credited for its own minutes only', () => {
    const h = new Harness({ seed: 82 });
    h.step();
    h.step([{ type: 'command.sleep' }]);
    h.run(4 * MIN, 250);
    expect(h.last!.state).toBe('sleeping');
    h.step([{ type: 'system.lock' }]);
    h.run(4 * HOUR, 250);
    h.step([{ type: 'system.unlock' }]);
    h.run(3000);
    const spots = h.sim.serialize().memory.favoriteSpots;
    expect(spots).toHaveLength(1);
    expect(spots[0]!.score).toBeGreaterThan(3.5);
    expect(spots[0]!.score).toBeLessThan(4.5);
  });
});

describe('hidden while asleep: re-decided on unhide', () => {
  it('hiding during the start-up intro does not turn it into a long nap while the user is active', () => {
    for (const seed of [1, 2, 3, 4, 5]) {
      const h = new Harness({ seed, persisted: restored() });
      h.env.hidden = true;
      h.run(500, 50);
      expect(h.last!.state).toBe('away');
      h.env.hidden = false;
      let asleepMs = 0;
      const seen = new Set<BehaviorState>();
      h.run(10_000, 50, (hh) => {
        seen.add(hh.last!.state);
        if (ASLEEP.includes(hh.last!.state)) asleepMs += 50;
      });
      expect(seen.has('wakingUp')).toBe(true);
      expect(asleepMs).toBeLessThan(1000);
    }
  });

  it('an idle-sleeping cat hidden while the user comes back wakes up when shown', () => {
    const h = new Harness({ seed: 91, settings: settingsWith({ behavior: { sleepAfterIdleMinutes: 1 } }) });
    h.run(2000);
    idleAsleep(h);
    h.env.hidden = true;
    h.run(MIN, 200);
    h.env.userIdleMs = 0;
    h.step([{ type: 'activity.userReturned', idleMs: 5 * MIN }], 200);
    h.run(MIN, 200);
    h.env.hidden = false;
    expect(h.runUntil((o) => o.state === 'wakingUp', 1000, 50)).toBe(true);
  });

  it('shown again with nobody around it sleeps on, and wakes when the user returns', () => {
    const h = new Harness({ seed: 92, settings: settingsWith({ behavior: { sleepAfterIdleMinutes: 1 } }) });
    h.run(2000);
    idleAsleep(h);
    const idle = h.env.userIdleMs as number;
    h.env.hidden = true;
    h.run(MIN, 200);
    h.env.userIdleMs = idle + MIN;
    h.env.hidden = false;
    h.run(10 * MIN, 200, (hh) => void (hh.env.userIdleMs = (hh.env.userIdleMs as number) + 200));
    expect(h.last!.state).toBe('sleeping');
    h.env.userIdleMs = 0;
    expect(h.runUntil((o) => o.state === 'wakingUp', 6000, 100)).toBe(true);
  });

  it('a nap interrupted by hiding is not restarted as a fresh nap while the user is active', () => {
    const h = new Harness({ seed: 93 });
    h.run(2000);
    h.step([{ type: 'command.sleep' }]);
    expect(h.runUntil((o) => o.state === 'sleeping', 10_000)).toBe(true);
    h.env.hidden = true;
    h.run(5000, 100);
    h.env.hidden = false;
    expect(h.runUntil((o) => o.state === 'wakingUp', 1000, 50)).toBe(true);
  });
});

describe('lock and suspend', () => {
  it('lock -> suspend -> resume keeps the cat asleep until the session is unlocked', () => {
    const h = new Harness({ seed: 101 });
    h.run(2000);
    h.step([{ type: 'system.lock' }]);
    h.run(10_000);
    h.step([{ type: 'system.suspend' }]);
    h.run(1000, 250);
    h.step([{ type: 'system.resume' }]);
    const states = new Set<BehaviorState>();
    h.run(2 * MIN, 100, (hh) => void states.add(hh.last!.state));
    expect([...states]).toEqual(['sleeping']);
    expect(h.sim.debugInfo().mode).toBe('locked');
    h.step([{ type: 'system.unlock' }]);
    expect(h.last!.state).toBe('wakingUp');
    expect(h.sim.debugInfo().mode).toBe('normal');
  });

  it('suspend -> resume without a lock wakes the cat; unlock while suspended keeps it asleep until resume', () => {
    const plain = new Harness({ seed: 102 });
    plain.run(2000);
    plain.step([{ type: 'system.suspend' }]);
    plain.run(10_000);
    expect(plain.last!.state).toBe('sleeping');
    plain.step([{ type: 'system.resume' }]);
    expect(plain.last!.state).toBe('wakingUp');

    const h = new Harness({ seed: 103 });
    h.run(2000);
    h.step([{ type: 'system.lock' }, { type: 'system.suspend' }]);
    h.run(10_000);
    h.step([{ type: 'system.unlock' }]);
    h.run(2000);
    expect(h.sim.debugInfo().mode).toBe('locked');
    h.step([{ type: 'system.resume' }]);
    expect(h.sim.debugInfo().mode).toBe('normal');
  });
});

describe('quiet over a fullscreen app', () => {
  it('shows no emote bubbles at all, even when petted or tapped; they return afterwards', () => {
    const h = new Harness({ seed: 111, settings: settingsWith({ behavior: { fullscreenBehavior: 'quiet' } }) });
    h.run(2000);
    h.env.fullscreenDisplayIds = ['1'];
    h.keepOutputs = true;
    h.run(10 * MIN, 100, (hh, i) => (i % 150 === 0 ? [{ type: 'pointer.pet', at: catPoint(hh.last), strength: 1 }, { type: 'pointer.tap', at: catPoint(hh.last) }] : []));
    const quiet = h.outputs.filter((o) => o.opacity < 0.6);
    expect(quiet.length).toBeGreaterThan(5000);
    expect(quiet.every((o) => o.state === 'sleeping' || o.state === 'fallingAsleep')).toBe(true);
    expect(h.outputs.filter((o) => o.emote !== null)).toEqual([]);
    h.env.fullscreenDisplayIds = [];
    h.run(4000);
    h.outputs.length = 0;
    h.run(3000, 33, (hh, i) => (i % 10 === 0 ? [{ type: 'pointer.pet', at: catPoint(hh.last), strength: 1 }] : []));
    expect(h.outputs.some((o) => o.emote === 'heart')).toBe(true);
  });
});
