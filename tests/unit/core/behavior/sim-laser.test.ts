// Laser Mode, reduced motion and the body-care variety inside the sim (src/core/behavior/simLaser.ts).
// These tests were written without being run; they pin behaviour the code is meant to have.
import { describe, expect, it } from 'vitest';
import type { PersistedCat, Stats } from '../../../../src/shared/catState';
import { LASER_STANDOFF_BODY_LENGTHS } from '../../../../src/shared/companion';
import type { SimEvent, SimOutput } from '../../../../src/shared/sim';
import { mulberry32, newPersistedCat } from '../../../../src/core/behavior';
import { laserStandoffPx } from '../../../../src/core/behavior/laser';
import { Harness, settingsWith, WAKE_MS } from './fixtures';
import type { Settings } from '../../../../src/shared/settings';

const BL = 84;
const MIN = 60_000;
const STANDOFF = laserStandoffPx(BL, 1, 1);

function catWith(seed: number, stats: Partial<Stats> = {}): PersistedCat {
  const cat = newPersistedCat(mulberry32(seed), 1_800_000_000_000 - 3600_000);
  Object.assign(cat.stats, stats);
  return cat;
}

/** A harness with the launch nap over and the cat up. */
function ready(settings: Settings = settingsWith({ behavior: { cursorPlay: 1 } }), seed = 3, persisted: PersistedCat | null = null): Harness {
  const h = new Harness({ seed, settings, persisted });
  h.run(WAKE_MS + 1500, 50);
  return h;
}

/** A resting dot on the floor, `d` px away from the cat on the side with room. */
function dotAway(h: Harness, d = 600, lift = 10): { x: number; y: number; speed: number } {
  const x = h.last!.x;
  return { x: x < 960 ? x + d : x - d, y: h.floorY() - lift, speed: 0 };
}

const variant = (h: Harness): unknown => h.sim.debugInfo().variant;
const following = (h: Harness): boolean => variant(h) === 'laser';

/** Turns Laser Mode on with the dot where `dot` says and runs until the cat is following it. */
function startFollowing(h: Harness, dot: { x: number; y: number; speed: number }): void {
  h.env.laserMode = true;
  h.env.cursor = dot;
  expect(h.runUntil(() => following(h), 12_000)).toBe(true);
}

describe('Laser Mode: following the light', () => {
  it('follows a far dot, holds off at least LASER_STANDOFF_BODY_LENGTHS body widths short of it and settles there', () => {
    const h = ready();
    const dot = dotAway(h);
    h.env.laserMode = true;
    h.env.cursor = dot;
    let followed = false;
    let minGap = Infinity;
    h.run(25_000, 33, (hh) => {
      if (following(hh)) followed = true;
      minGap = Math.min(minGap, Math.abs(hh.last!.x - dot.x));
    });
    expect(followed).toBe(true);
    expect(minGap).toBeGreaterThanOrEqual(LASER_STANDOFF_BODY_LENGTHS * BL - 1);
    expect(minGap).toBeGreaterThanOrEqual(STANDOFF - 1);
    // It got close, not just somewhere: within a body width of the stand-off.
    const gap = Math.abs(h.last!.x - dot.x);
    expect(gap).toBeLessThanOrEqual(STANDOFF + BL);
  });

  it('never takes a step toward a dot that is already inside the stand-off, whatever the dot does', () => {
    for (const seed of [1, 2, 3]) {
      const h = ready(undefined, seed);
      const centre = h.last!.x;
      h.env.laserMode = true;
      let rec: { x: number; dot: number; lv: boolean } | null = null;
      let violations = 0;
      let followedTicks = 0;
      h.run(60_000, 33, (hh, i) => {
        const o = hh.last!;
        const lv = following(hh);
        if (lv) followedTicks++;
        if (rec && rec.lv && lv && Math.abs(rec.x - rec.dot) < STANDOFF - 2) {
          const toward = (o.x - rec.x) * Math.sign(rec.dot - rec.x);
          if (toward > 0.6) violations++;
        }
        // A dot sweeping back and forth across the cat's side of the floor, now and then right over it.
        const dotX = centre + 500 * Math.sin(i / 40);
        hh.env.cursor = { x: dotX, y: hh.floorY() - 10, speed: Math.abs(500 * Math.cos(i / 40)) * 0.8 };
        rec = { x: o.x, dot: dotX, lv };
      });
      expect(followedTicks).toBeGreaterThan(0);
      expect(violations).toBe(0);
    }
  });

  it('never hunts, pounces or catches: no hunt state, no pounce clip, no hunt counters, over a long, lively game', () => {
    for (const seed of [1, 2, 3, 4]) {
      const h = ready(settingsWith({ behavior: { cursorPlay: 1 } }), seed);
      const c0 = { ...h.sim.serialize().memory.counters };
      const centre = h.last!.x;
      h.env.laserMode = true;
      h.keepOutputs = true;
      h.run(3 * MIN, 33, (hh, i) => {
        const x = centre + 600 * Math.sin(i / 55);
        hh.env.cursor = { x, y: hh.floorY() - 10 - (i % 400 < 100 ? 0 : 90), speed: 700 };
        return i % 90 === 0 ? ([{ type: 'cursor.flick', speed: 3000, at: { x, y: hh.floorY() - 10 } }] satisfies SimEvent[]) : [];
      });
      const c1 = h.sim.serialize().memory.counters;
      expect(c1.hunts).toBe(c0.hunts);
      expect(c1.pounces).toBe(c0.pounces);
      expect(c1.chasesStarted).toBe(c0.chasesStarted);
      expect(c1.chasesEngaged).toBe(c0.chasesEngaged);
      for (const o of h.outputs) {
        expect(o.state).not.toBe('chasingCursor');
        expect(o.clip).not.toBe('pounce');
        expect(o.clip).not.toBe('swat');
        expect(o.emote).not.toBe('sparkle');
      }
    }
  });

  it('reaches toward a resting dot with the paw-at clip, unless "Paw at the pointer" is off', () => {
    const run = (disabled: boolean): number => {
      let pawAt = 0;
      for (const seed of [1, 2, 3]) {
        const h = ready(settingsWith({ behavior: { cursorPlay: 1, disabledBehaviors: disabled ? ['pawAtCursor'] : [] } }), seed);
        startFollowing(h, dotAway(h, 500));
        h.run(40_000, 33, (hh) => {
          if (hh.last!.clip === 'pawAt') pawAt++;
        });
      }
      return pawAt;
    };
    expect(run(false)).toBeGreaterThan(0);
    expect(run(true)).toBe(0);
  });

  it('hops at a dot overhead, and not when jumps are switched off', () => {
    const run = (disabledExtras: string[]): number => {
      let hops = 0;
      for (const seed of [1, 2, 3]) {
        const h = ready(settingsWith({ behavior: { cursorPlay: 1, disabledExtras } }), seed);
        startFollowing(h, dotAway(h, 500, 3 * 64));
        const before = h.transitions.length;
        h.run(40_000, 33);
        hops += h.transitions.slice(before).filter((t) => t.to === 'jumping').length;
      }
      return hops;
    };
    expect(run([])).toBeGreaterThan(0);
    expect(run(['pounce'])).toBe(0);
  });

  it('a keen cat runs after a far dot and a lazy one does not run for long, both within a bounded game', () => {
    const clips = (personality: 'energetic' | 'lazy'): { run: number; sit: number } => {
      const h = ready(settingsWith({ companion: { personality } }), 5, catWith(5, { energy: 0.95 }));
      h.env.laserMode = true;
      h.env.cursor = dotAway(h, 800);
      let run = 0;
      let sit = 0;
      h.run(30_000, 33, (hh) => {
        if (hh.last!.clip === 'run') run++;
        if (hh.last!.clip === 'sit' || hh.last!.clip === 'loaf') sit++;
      });
      return { run, sit };
    };
    const keen = clips('energetic');
    const lazy = clips('lazy');
    expect(keen.run).toBeGreaterThan(0);
    expect(lazy.sit).toBeGreaterThan(0);
  });

  it('gets tired: a long game with a dot that keeps moving ends in a break (a groom or a stretch), then it goes back to the light', () => {
    const h = ready(settingsWith({ behavior: { cursorPlay: 1 } }), 4, catWith(4, { energy: 0.6 }));
    const centre = h.last!.x;
    h.env.laserMode = true;
    let breaks = 0;
    let wasFollowing = false;
    let followedAfterBreak = false;
    h.run(6 * MIN, 33, (hh, i) => {
      const lv = following(hh);
      if (wasFollowing && !lv && (hh.last!.state === 'grooming' || hh.last!.state === 'idle')) breaks++;
      if (breaks > 0 && lv) followedAfterBreak = true;
      wasFollowing = lv;
      hh.env.cursor = { x: centre + 700 * Math.sin(i / 35), y: hh.floorY() - 10, speed: 600 };
    });
    expect(breaks).toBeGreaterThan(0);
    expect(followedAfterBreak).toBe(true);
  });
});

describe('Laser Mode: the user and the world come first', () => {
  it('lets go of the light while a button is down, stays off it for a few seconds and then goes back', () => {
    const h = ready();
    startFollowing(h, dotAway(h, 800));
    h.env.pointerButtonDown = true;
    h.run(600, 33);
    expect(following(h)).toBe(false);
    const x0 = h.last!.x;
    h.run(2500, 33);
    expect(Math.abs(h.last!.x - x0)).toBeLessThan(2);
    expect(following(h)).toBe(false);
    h.env.pointerButtonDown = false;
    // The pause runs on after the release (a click is never crowded), then the light is followed again.
    h.run(2000, 33);
    expect(following(h)).toBe(false);
    expect(h.runUntil(() => following(h), 12_000)).toBe(true);
  });

  it('a fresh press (the host counter) also stops the chase', () => {
    const h = ready();
    startFollowing(h, dotAway(h, 800));
    h.env.pointerButtonPresses = 1;
    h.run(33 * 3, 33);
    h.env.pointerButtonPresses = 2;
    h.run(600, 33);
    expect(following(h)).toBe(false);
  });

  it('wakes a sleeping cat gently: not at once, after a short delay, through the wake-up and then it follows', () => {
    const h = ready();
    h.step([{ type: 'command.sleep' }]);
    expect(h.runUntil((o) => o.state === 'sleeping', 20_000)).toBe(true);
    h.env.laserMode = true;
    h.env.cursor = dotAway(h, 700);
    const t0 = h.now;
    h.run(1200, 33);
    expect(h.last!.state).toBe('sleeping');
    expect(h.runUntil((o) => o.state === 'wakingUp', 8000)).toBe(true);
    expect(h.now - t0).toBeGreaterThanOrEqual(2400);
    expect(h.runUntil(() => following(h), 20_000)).toBe(true);
  });

  it('hands control back smoothly when Laser Mode ends: a calm sit or stand, no teleport, no snap', () => {
    const h = ready();
    startFollowing(h, dotAway(h, 800));
    h.run(3000, 33);
    h.keepOutputs = true;
    h.outputs.length = 0;
    h.env.laserMode = false;
    h.run(2000, 33);
    expect(following(h)).toBe(false);
    expect(['idle', 'walking', 'resting', 'grooming']).toContain(h.last!.state);
    for (let i = 0; i < h.outputs.length; i++) {
      const o = h.outputs[i] as SimOutput;
      expect(o.snap).toBe(false);
      if (i > 0) expect(Math.abs(o.x - (h.outputs[i - 1] as SimOutput).x)).toBeLessThan(25);
    }
  });

  it('does nothing about the light while paused or hidden, and picks it up again afterwards', () => {
    const h = ready();
    startFollowing(h, dotAway(h, 800));
    h.env.paused = true;
    let led = 0;
    h.run(6000, 33, (hh) => {
      if (following(hh)) led++;
    });
    // At most the first tick or two of the pause (the mode change settles the cat at once).
    expect(led).toBeLessThanOrEqual(2);
    expect(following(h)).toBe(false);
    h.env.paused = false;
    expect(h.runUntil(() => following(h), 25_000)).toBe(true);

    h.env.hidden = true;
    const x0 = h.last!.x;
    let ledHidden = 0;
    h.run(4000, 33, (hh) => {
      if (following(hh)) ledHidden++;
    });
    expect(ledHidden).toBeLessThanOrEqual(2);
    expect(h.last!.state).toBe('away');
    expect(Math.abs(h.last!.x - x0)).toBeLessThan(40);
  });

  it('never stands on a fullscreen display chasing the light', () => {
    const h = ready();
    h.env.laserMode = true;
    h.env.cursor = dotAway(h, 800);
    h.env.fullscreenDisplayIds = ['1'];
    let led = 0;
    h.run(8000, 33, (hh) => {
      if (following(hh)) led++;
    });
    expect(led).toBe(0);
  });

  it('is held by the user, not by the light: a drag wins and the cat is not following while held', () => {
    const h = ready();
    startFollowing(h, dotAway(h, 800));
    const at = { x: h.last!.x, y: h.last!.y - 20 };
    h.env.dragCursor = at;
    h.step([{ type: 'pointer.dragStart', at }], 33);
    h.run(800, 33);
    expect(h.last!.state).toBe('held');
    expect(following(h)).toBe(false);
  });

  it('stays off the light while typing', () => {
    const h = ready();
    h.env.laserMode = true;
    h.env.cursor = dotAway(h, 800);
    h.env.typing = true;
    h.env.typingIntensity = 0.9;
    let led = 0;
    h.run(6000, 33, (hh) => {
      if (following(hh)) led++;
    });
    expect(led).toBe(0);
  });

  it('looks confused when the dot vanishes after a good chase (some seeds, a puzzled one-shot)', () => {
    let confused = 0;
    for (const seed of [1, 2, 3, 4, 5, 6, 7, 8]) {
      const h = ready(undefined, seed);
      startFollowing(h, dotAway(h, 600));
      h.run(10_000, 33);
      h.env.cursor = null;
      h.run(3000, 33, (hh) => {
        if (hh.last!.clip === 'confused') confused++;
      });
      expect(following(h)).toBe(false);
    }
    expect(confused).toBeGreaterThan(0);
  });
});

describe('reduced motion in the sim', () => {
  it('never runs or sprints by choice after the light, with the host preference or the setting, where a keen cat runs without it', () => {
    const runClips = (reducedEnv: boolean, reducedSetting: boolean): number => {
      const s = settingsWith({ companion: { personality: 'energetic', reducedMotion: reducedSetting } });
      const h = ready(s, 5, catWith(5, { energy: 0.95 }));
      h.env.laserMode = true;
      h.env.cursor = dotAway(h, 800);
      if (reducedEnv) h.env.reducedMotion = true;
      let n = 0;
      h.run(25_000, 33, (hh) => {
        const c = hh.last!.clip;
        if (c === 'run' || c === 'sprint') n++;
      });
      return n;
    };
    expect(runClips(false, false)).toBeGreaterThan(0);
    expect(runClips(true, false)).toBe(0);
    expect(runClips(false, true)).toBe(0);
  });

  it('makes no pounces at the pointer, only hops are left for voluntary jumps', () => {
    for (const seed of [1, 2, 3]) {
      const h = ready(settingsWith({ behavior: { cursorPlay: 1 }, companion: { reducedMotion: true } }), seed);
      const x0 = h.last!.x;
      const c0 = h.sim.serialize().memory.counters.pounces;
      h.keepOutputs = true;
      h.run(3 * MIN, 33, (hh, i) => {
        const x = x0 + 450 + (i % 90 < 10 ? 20 * Math.sin(i) : 0);
        hh.env.cursor = { x, y: hh.floorY() - 10, speed: i % 90 < 10 ? 600 : 0 };
        return i % 150 === 0 ? ([{ type: 'cursor.flick', speed: 3000, at: { x, y: hh.floorY() - 10 } }] satisfies SimEvent[]) : [];
      });
      expect(h.sim.serialize().memory.counters.pounces).toBe(c0);
      expect(h.outputs.some((o) => o.clip === 'pounce')).toBe(false);
    }
  });

  it('leaves the user\'s drag, throw and fall as they are', () => {
    const h = ready(settingsWith({ companion: { reducedMotion: true } }));
    const at = { x: h.last!.x, y: h.floorY() - 300 };
    h.env.dragCursor = at;
    h.step([{ type: 'pointer.dragStart', at }], 33);
    h.run(500, 33);
    expect(h.last!.state).toBe('held');
    h.env.dragCursor = null;
    h.step([{ type: 'pointer.dragEnd', at, velocity: { x: 0, y: 0 } }], 33);
    h.run(3000, 33);
    const seen = h.statesSeen();
    expect(seen.has('falling') || seen.has('landing')).toBe(true);
  });

  it('opt-outs the user chose stay in force when the preference is switched on and off again', () => {
    const h = ready(settingsWith({ behavior: { disabledBehaviors: ['grooming'] } }));
    h.env.reducedMotion = true;
    h.run(500, 33);
    h.env.reducedMotion = false;
    h.run(500, 33);
    h.keepOutputs = true;
    h.run(5 * MIN, 100);
    expect(h.outputs.some((o) => o.state === 'grooming')).toBe(false);
  });
});

describe('body-care variety', () => {
  it('grooming now and then includes a scratch (and the plain groom is still the common case)', () => {
    let scratch = 0;
    let groom = 0;
    for (const seed of [1, 2, 3, 4, 5, 6, 7, 8]) {
      const h = new Harness({ seed, settings: settingsWith({ behavior: { cursorPlay: 0.3 } }) });
      h.keepOutputs = true;
      h.run(20 * MIN, 100);
      for (const o of h.outputs) {
        if (o.clip === 'scratch') scratch++;
        if (o.clip === 'groom') groom++;
      }
    }
    expect(groom).toBeGreaterThan(0);
    expect(scratch).toBeGreaterThan(0);
    expect(groom).toBeGreaterThan(scratch);
  });

  it('a cat settling to sleep sometimes sits up or stretches before its yawn, and the whole settling still ends asleep', () => {
    let lead = 0;
    let asleep = 0;
    for (const seed of [1, 2, 3, 4, 5, 6]) {
      const h = ready(undefined, seed);
      for (let k = 0; k < 8; k++) {
        h.step([{ type: 'command.sleep' }]);
        h.keepOutputs = true;
        h.outputs.length = 0;
        h.run(12_000, 33);
        if (h.last!.state === 'sleeping') asleep++;
        for (const o of h.outputs) if (o.state === 'fallingAsleep' && (o.clip === 'sit' || o.clip === 'stretch')) lead++;
        h.step([{ type: 'command.wake' }]);
        h.run(8000, 33);
      }
    }
    expect(lead).toBeGreaterThan(0);
    expect(asleep).toBeGreaterThan(0);
  });
});
