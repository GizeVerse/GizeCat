// v1.1.1 trips up in the sim: the exploration urge (growth, personality, typing, reset),
// short retries after a failed trip (RC7), which tops and strips are considered (RC5), and the
// decision diagnostics (surfaceDiagnostics().decision). Through the real Sim and Mover.
import { describe, expect, it } from 'vitest';
import type { Traits } from '../../../../src/shared/catState';
import type { Rect } from '../../../../src/shared/geometry';
import type { SimOutput } from '../../../../src/shared/sim';
import type { Surface } from '../../../../src/shared/surfaces';
import type { DecisionDiagnostics, TargetAvailability } from '../../../../src/shared/surfaceDiagnostics';
import { DECISION_TARGETS, TARGET_AVAILABILITY } from '../../../../src/shared/surfaceDiagnostics';
import { Harness, providerSurfacesFromWindows, settingsWith, SINGLE, topId, WAKE_MS, type StripSpec } from './fixtures';
import { MIN, TYPICAL_FRAME, USER_SCREEN, userCat } from './liveness';

const decision = (h: Harness): DecisionDiagnostics => h.sim.surfaceDiagnostics().decision;
const elevated = (o: SimOutput): boolean => o.support.kind === 'surface' && (o.support.surfaceKind === 'windowTop' || o.support.surfaceKind === 'tabStrip');
const variant = (h: Harness): unknown => h.sim.debugInfo().variant;

/** The user's cat in front of the typical window on the user's screen; the user is active. */
function userHarness(seed: number, traits: Partial<Traits> = {}): Harness {
  const h = new Harness({ seed, world: USER_SCREEN, persisted: userCat(seed, traits) });
  h.env.windows = { w: TYPICAL_FRAME };
  return h;
}

/** Steps with the user active (input a few seconds ago); `each` sees every output. Stops when `each` returns true. */
function drive(h: Harness, ms: number, each: (o: SimOutput) => boolean | void = () => undefined, dt = 100): boolean {
  const end = h.now + ms;
  while (h.now < end) {
    h.env.userIdleMs = h.now % 7000;
    if (each(h.step([], dt)) === true) return true;
  }
  return false;
}

describe('exploration urge (v1.1.1)', () => {
  /** Growth of the urge over `ms` right after waking up, while the cat stays on the floor. */
  function growth(seed: number, traits: Partial<Traits>, ms: number, typing = false): number {
    const h = userHarness(seed, traits);
    h.env.typing = typing;
    h.run(WAKE_MS, 100);
    const u0 = decision(h).exploreUrge;
    let up = false;
    drive(h, ms, (o) => {
      up ||= elevated(o) || o.support.kind !== 'floor';
    });
    expect(up, `seed ${seed} left the floor during the measurement`).toBe(false);
    return decision(h).exploreUrge - u0;
  }

  it('grows on the floor with a way up in reach: 0 to 1 in 3-8 min, faster for a curious, playful cat, slower for a lazy one', () => {
    const CURIOUS: Partial<Traits> = { curiosity: 1, playfulness: 1, laziness: 0 };
    const LAZY: Partial<Traits> = { curiosity: 0.2, playfulness: 0.1, laziness: 1 };
    for (const seed of [1, 2]) {
      const user = growth(seed, {}, 60_000);
      const curious = growth(seed, CURIOUS, 60_000);
      const lazy = growth(seed, LAZY, 60_000);
      // Implied time to 1 (a little of the minute may be spent in a hop or a stretch, when it does not grow).
      const tauMin = 1 / user;
      expect(tauMin).toBeGreaterThanOrEqual(3);
      expect(tauMin).toBeLessThanOrEqual(8 / 0.9);
      expect(1 / curious).toBeGreaterThanOrEqual(3 * 0.99);
      expect(1 / lazy).toBeLessThanOrEqual(8 / 0.9);
      expect(curious).toBeGreaterThan(user * 1.2);
      expect(lazy).toBeLessThan(user / 1.2);
    }
  });

  it('grows half as fast while the user types', () => {
    for (const seed of [1, 2]) {
      const free = growth(seed, {}, 60_000);
      const typing = growth(seed, {}, 60_000, true);
      expect(typing / free).toBeGreaterThan(0.4);
      expect(typing / free).toBeLessThan(0.6);
    }
  });

  it('resets on the arrival on a window top and does not grow while up there; the arrival is counted with its time', () => {
    const h = userHarness(4);
    h.run(WAKE_MS, 100);
    let before = 0;
    let arrivedAt = -1;
    expect(
      drive(h, 10 * MIN, (o) => {
        if (elevated(o)) {
          arrivedAt = h.now;
          return true;
        }
        before = decision(h).exploreUrge;
        return false;
      }, 33),
    ).toBe(true);
    expect(before).toBeGreaterThan(0.2);
    const d = decision(h);
    expect(d.exploreUrge).toBe(0);
    expect(d.excursions).toBe(1);
    expect(d.lastElevatedAt).toBe(arrivedAt);
    drive(h, 10_000, (o) => {
      if (!elevated(o)) return true;
      expect(decision(h).exploreUrge).toBe(0);
      return false;
    });
  });
});

describe('cooldowns after a trip up (v1.1.1 RC7)', () => {
  /**
   * The typical window, the climb target broken for one climb (its top stops being listed, so
   * the climb is unreachable when tried), then restored. Returns the delay from the failure to
   * the first decision that offers the climb again (null: no climb started in `ms`).
   */
  function failedClimb(seed: number, ms: number): number | null {
    const h = userHarness(seed, { energyLevel: 0.9, confidence: 0.9 });
    const intact = providerSurfacesFromWindows({ w: TYPICAL_FRAME }, USER_SCREEN, { now: 0 });
    const broken: Surface[] = intact.filter((s) => s.id !== topId('w')).map((s) => (s.orientation === 'wall' ? { ...s, topLedgeId: null } : s));
    const serve = (list: Surface[]): void => {
      h.env.surfaces = list;
      h.env.getSurface = (id) => list.find((s) => s.id === id) ?? null;
    };
    serve(intact);
    h.run(WAKE_MS, 100);
    let phase: 'wait' | 'climbing' | 'failed' | 'cooling' = 'wait';
    let failedAt = 0;
    let delay: number | null = null;
    let decisions = 0;
    drive(h, ms, (o) => {
      const climbing = o.state === 'walking' && variant(h) === 'climb';
      // The diagnostics hold the availability seen by the last decision: read them after one.
      const n = h.transitions.filter((t) => t.cause === 'autonomous').length;
      const decided = n > decisions;
      decisions = n;
      if (phase === 'wait' && climbing && o.support.kind === 'floor') {
        phase = 'climbing';
        serve(broken);
      } else if (phase === 'climbing' && !climbing && o.support.kind === 'floor' && o.state !== 'jumping' && o.state !== 'landing') {
        phase = 'failed';
        failedAt = h.now;
        serve(intact);
      } else if (phase === 'failed' && decided && o.support.kind === 'floor') {
        // The next decision sees the (short) cooldown.
        expect(decision(h).targets.climb).toBe('cooldown');
        phase = 'cooling';
      } else if (phase === 'cooling' && decided && o.support.kind === 'floor' && decision(h).targets.climb === 'available') {
        delay = h.now - failedAt;
        return true;
      }
      return false;
    }, 50);
    return phase === 'wait' ? null : delay;
  }

  it('a climb that fails (unreachable when tried) is retried after 15-40 s, not the 90-240 s climb cooldown', () => {
    const delays: number[] = [];
    for (let seed = 1; seed <= 30 && delays.length < 4; seed++) {
      const d = failedClimb(seed, 15 * MIN);
      if (d !== null) delays.push(d);
    }
    console.log(`cooldowns: failed climb offered again after ${delays.map((d) => Math.round(d / 1000)).join(', ')} s`);
    expect(delays.length).toBeGreaterThanOrEqual(3);
    // At least the retry, at most the retry plus the time to the next decision.
    for (const d of delays) expect(d).toBeGreaterThanOrEqual(15_000);
    delays.sort((a, b) => a - b);
    expect(delays[Math.floor(delays.length / 2)]!).toBeLessThanOrEqual(60_000);
  });

  it('a climb that gets there keeps the full cooldown (>= 90 s from the start before it is offered again)', () => {
    let checked = 0;
    for (let seed = 1; seed <= 30 && checked < 3; seed++) {
      const h = userHarness(seed, { energyLevel: 0.9, confidence: 0.9 });
      h.run(WAKE_MS, 100);
      let startedAt = -1;
      let arrived = false;
      drive(h, 20 * MIN, (o) => {
        if (startedAt < 0 && o.state === 'walking' && variant(h) === 'climb' && o.support.kind === 'floor') startedAt = h.now;
        if (startedAt >= 0 && elevated(o)) arrived = true;
        if (arrived && o.support.kind === 'floor' && h.transitions.at(-1)?.cause === 'autonomous' && h.transitions.at(-1)?.at === h.now && decision(h).targets.climb === 'available') {
          expect(h.now - startedAt).toBeGreaterThanOrEqual(90_000);
          checked++;
          return true;
        }
        return false;
      }, 50);
    }
    expect(checked).toBeGreaterThanOrEqual(2);
  });
});

describe('which tops and strips the cat considers (v1.1.1 RC5)', () => {
  // On a 1920x1080 screen (floor 1036), the cat in the middle (x = 960): four window tops 736 px
  // up (too high to jump to, from the floor or from the low top; no sides listed) are nearer than
  // a fifth one 256 px up at the right edge.
  const HIGH: Record<string, Rect> = {
    a: { x: 800, y: 300, width: 140, height: 250 },
    b: { x: 980, y: 300, width: 140, height: 250 },
    c: { x: 600, y: 300, width: 140, height: 250 },
    d: { x: 1160, y: 300, width: 140, height: 250 },
  };
  const LOW: Rect = { x: 1718, y: 780, width: 192, height: 200 };
  const strip = (r: Rect): StripSpec => ({ x0: r.x + 20, x1: r.x + r.width - 20, rest: { x0: r.x + 30, x1: r.x + r.width - 40 }, focusX: r.x + 60 });

  function middleCat(seed: number, tabStrips?: Record<string, StripSpec>): Harness {
    const cat = userCat(seed);
    cat.lastPosition = { displayKey: '1', xFrac: 0.5, support: 'floor' };
    const h = new Harness({ seed, world: SINGLE, persisted: cat });
    h.env.windows = { ...HIGH, e: LOW };
    h.env.walls = false;
    if (tabStrips) h.env.tabStrips = tabStrips;
    return h;
  }

  /** Targets at the first decisions after waking (before it walks off), and whether it later gets onto the low window. */
  function firstDecision(h: Harness): { targets: Record<string, TargetAvailability>; x: number } {
    h.run(WAKE_MS, 100);
    let seen: Record<string, TargetAvailability> | null = null;
    drive(h, 20_000, () => {
      const d = decision(h);
      if (d.targets.perch !== 'noSurfaces') {
        seen = d.targets;
        return true;
      }
      return false;
    }, 50);
    return { targets: seen ?? decision(h).targets, x: h.last!.x };
  }

  it('checks more than the three nearest window tops for a way up before giving up', () => {
    for (const seed of [1, 2, 3]) {
      const h = middleCat(seed);
      const { targets, x } = firstDecision(h);
      expect(Math.abs(x - 960)).toBeLessThan(250);
      expect(targets.perch, `seed ${seed}`).toBe('available');
      // Climbing is on but nothing can be climbed here.
      expect(targets.climb).toBe('noSurfaces');
    }
    // And it does go up there, setting out from where the low top is only the 4th or 5th nearest
    // (left of x ~1030 a three-nearest scan finds nothing reachable).
    let up = 0;
    const startXs: number[] = [];
    for (const seed of [1, 2, 3, 4]) {
      const h = middleCat(seed);
      h.run(WAKE_MS, 100);
      let exploring = false;
      if (
        drive(h, 10 * MIN, (o) => {
          const now = o.state === 'inspectingWindow' && variant(h) === 'explore';
          if (now && !exploring) startXs.push(o.x);
          exploring = now;
          return o.support.kind === 'surface' && o.support.surfaceId === topId('e');
        })
      ) {
        up++;
      }
    }
    expect(up).toBeGreaterThanOrEqual(3);
    expect(startXs.some((x) => x < 1000)).toBe(true);
  });

  it('explores tab strips too, and checks more than the two nearest strips for a visit', () => {
    const strips = { a: strip(HIGH.a!), b: strip(HIGH.b!), c: strip(HIGH.c!), e: strip(LOW) };
    for (const seed of [1, 2, 3]) {
      const { targets } = firstDecision(middleCat(seed, strips));
      expect(targets.perch, `seed ${seed}`).toBe('available');
      expect(targets.tabStrip, `seed ${seed}`).toBe('available');
    }
  });

  it('a tab strip only reachable by climbing is visited (the visit may climb while climbing is on)', () => {
    // The typical browser: its strip (~1075 px up) is out of jumping reach; its sides can be climbed.
    const spec: StripSpec = { x0: 400, x1: 1110, rest: { x0: 420, x1: 1000 }, focusX: 640 };
    let visits = 0;
    for (let seed = 1; seed <= 12 && visits === 0; seed++) {
      const h = userHarness(seed);
      h.env.tabStrips = { w: spec };
      h.run(WAKE_MS, 100);
      let visiting = false;
      drive(h, 20 * MIN, (o) => {
        if (o.state === 'walking' && variant(h) === 'tabStrip' && o.support.kind === 'floor') visiting = true;
        else if (o.state !== 'jumping' && o.state !== 'landing' && !(o.support.kind === 'surface' && o.support.orientation === 'wall') && !(o.state === 'walking' && variant(h) === 'tabStrip')) visiting = false;
        if (visiting && o.support.kind === 'surface' && o.support.surfaceKind === 'tabStrip') {
          visits++;
          return true;
        }
        return false;
      }, 50);
    }
    expect(visits).toBe(1);
  });
});

describe('decision diagnostics (v1.1.1)', () => {
  it('reports what the cat stands on, where it is heading and why each way up is (not) available, in the contract\'s vocabulary', () => {
    const h = userHarness(4);
    h.run(WAKE_MS, 100);
    const kinds = new Set<string>();
    const supports = new Set<string>();
    const targetKinds = new Set<string>();
    drive(h, 15 * MIN, () => {
      const d = decision(h);
      supports.add(d.support);
      targetKinds.add(String(d.targetKind));
      for (const k of DECISION_TARGETS) {
        expect(TARGET_AVAILABILITY).toContain(d.targets[k]);
        kinds.add(`${k}:${d.targets[k]}`);
      }
      expect(d.exploreUrge).toBeGreaterThanOrEqual(0);
      expect(d.exploreUrge).toBeLessThanOrEqual(1);
      expect(d.state).toBe(h.last!.state);
    }, 50);
    expect([...supports]).toEqual(expect.arrayContaining(['floor', 'windowTop', 'windowSide', 'air']));
    expect([...targetKinds]).toEqual(expect.arrayContaining(['floor', 'windowTop']));
    expect([...kinds]).toEqual(expect.arrayContaining(['perch:available', 'climb:available', 'climb:cooldown', 'tabStrip:noSurfaces']));
    const d = decision(h);
    expect(d.excursions).toBeGreaterThanOrEqual(1);
    expect(d.lastElevatedAt).toBeGreaterThan(0);
  });

  it('all three ways up switched off: "disabled" for each (the verdict says switched off)', () => {
    const h = new Harness({ seed: 2, world: USER_SCREEN, persisted: userCat(2), settings: settingsWith({ behavior: { disabledBehaviors: ['perchOnWindows', 'climbWindows', 'tabStrips'] } }) });
    h.env.windows = { w: TYPICAL_FRAME };
    h.run(WAKE_MS + 60_000, 100);
    expect(decision(h).targets).toEqual({ perch: 'disabled', climb: 'disabled', tabStrip: 'disabled' });
    expect(decision(h).exploreUrge).toBe(0);
  });

  it('nothing listed: "noSurfaces"; only private windows: "excluded"; a top out of reach: "unreachable"', () => {
    const none = userHarness(1);
    none.env.windows = {};
    none.run(WAKE_MS + 30_000, 100);
    expect(decision(none).targets).toEqual({ perch: 'noSurfaces', climb: 'noSurfaces', tabStrip: 'noSurfaces' });

    const priv = userHarness(1);
    priv.env.surfaces = providerSurfacesFromWindows({ w: TYPICAL_FRAME }, USER_SCREEN, { now: 0 }).map((s) => ({ ...s, excluded: true }));
    priv.run(WAKE_MS + 30_000, 100);
    expect(decision(priv).targets.perch).toBe('excluded');
    expect(decision(priv).targets.climb).toBe('excluded');
    expect(decision(priv).exploreUrge).toBe(0);

    const high = userHarness(1);
    high.env.walls = false;
    high.run(WAKE_MS + 30_000, 100);
    expect(decision(high).targets.perch).toBe('unreachable');
    expect(decision(high).targets.climb).toBe('noSurfaces');
    expect(decision(high).exploreUrge).toBe(0);
  });

  it('held, the support is "held"; hidden, "none"', () => {
    const h = userHarness(3);
    h.run(WAKE_MS, 100);
    const o = h.last!;
    h.step([{ type: 'pointer.dragStart', at: { x: o.x, y: o.y - 30 } }]);
    h.env.dragCursor = { x: 900, y: 700 };
    h.run(300);
    expect(decision(h).support).toBe('held');
    h.env.dragCursor = null;
    h.step([{ type: 'pointer.dragEnd', at: { x: 900, y: 700 }, velocity: { x: 0, y: 0 } }]);
    h.run(3000);
    h.env.hidden = true;
    h.run(500);
    expect(decision(h).support).toBe('none');
  });

  it('"heading for" is where the cat travels: nothing while it only looks (watching the user, a curious look), the destination while it walks or goes to a window', () => {
    let looking = 0;
    let travelling = 0;
    const wrong: string[] = [];
    const heading = new Set<string>();
    for (const seed of [1, 2]) {
      const h = new Harness({ seed, world: USER_SCREEN, persisted: userCat(seed) });
      // A small window in front whose top lies below the foreground window's centre: the look point projects onto that top.
      h.env.windows = { small: { x: 700, y: 700, width: 400, height: 300 }, w: TYPICAL_FRAME };
      h.env.foreground = { id: 'w', rect: TYPICAL_FRAME, processName: 'app.exe', category: 'code', minimized: false, maximized: false, fullscreen: false, excluded: false };
      h.run(WAKE_MS, 100);
      drive(h, 10 * MIN, (o) => {
        const d = decision(h);
        const phase = h.sim.debugInfo().phase;
        if ((d.state === 'watchingUser' && (phase === 'sit' || phase === 'loaf')) || (d.state === 'curious' && phase === 'look')) {
          looking++;
          if (d.targetKind !== null) wrong.push(`seed ${seed} ${d.state}/${String(phase)} on ${d.support}: ${d.targetKind}`);
        }
        if ((d.state === 'walking' || (d.state === 'inspectingWindow' && phase === 'approach')) && o.speed > 0 && o.support.kind === 'floor') {
          travelling++;
          if (d.targetKind === null) wrong.push(`seed ${seed} ${d.state}/${String(phase)} moving: no destination`);
          else heading.add(d.targetKind);
        }
      }, 50);
    }
    expect(looking).toBeGreaterThan(100);
    expect(travelling).toBeGreaterThan(100);
    expect(wrong.slice(0, 5)).toEqual([]);
    expect([...heading]).toEqual(expect.arrayContaining(['floor', 'windowTop']));
  });

  it('the targets follow the windows between decisions: a window opened while the cat naps on the floor shows up within a few seconds', () => {
    const h = userHarness(5);
    h.env.windows = {};
    h.run(WAKE_MS, 100);
    h.step([{ type: 'command.sleep' }]);
    expect(h.runUntil((o) => o.state === 'sleeping', 30_000, 100)).toBe(true);
    h.run(5000, 100);
    expect(decision(h).targets).toEqual({ perch: 'noSurfaces', climb: 'noSurfaces', tabStrip: 'noSurfaces' });
    h.env.windows = { w: TYPICAL_FRAME };
    h.run(3000, 100);
    expect(h.last!.state).toBe('sleeping');
    expect(decision(h).targets.perch).toBe('available');
    expect(decision(h).targets.climb).toBe('available');
    // Asleep, the urge does not grow.
    expect(decision(h).exploreUrge).toBe(0);
  });
});
