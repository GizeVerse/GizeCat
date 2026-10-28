import { describe, expect, it } from 'vitest';
import type { BehaviorState } from '../../../../src/shared/cat';
import type { SimEvent, SimOutput } from '../../../../src/shared/sim';
import type { WindowInfo } from '../../../../src/shared/world';
import { TOGGLEABLE_BEHAVIORS } from '../../../../src/shared/settings';
import { DUAL_MIXED, Harness, settingsWith, SINGLE } from './fixtures';

const MIN = 60_000;

function windowInfo(id: string, rect: WindowInfo['rect'], category: WindowInfo['category'] = 'code'): WindowInfo {
  return { id, rect, processName: 'app.exe', category, minimized: false, maximized: false, fullscreen: false, excluded: false };
}

function timeIn(h: Harness, ms: number, dt: number, each?: (h: Harness, i: number) => readonly SimEvent[] | void): Map<BehaviorState, number> {
  const t = new Map<BehaviorState, number>();
  h.run(ms, dt, (hh, i) => {
    const s = hh.last?.state;
    if (s) t.set(s, (t.get(s) ?? 0) + dt);
    return each?.(hh, i);
  });
  return t;
}

const catPoint = (o: SimOutput | null) => ({ x: o?.x ?? 0, y: (o?.y ?? 0) - 30 });

describe('typing and idleness', () => {
  it('while the user types the cat stays calm (no running around)', () => {
    for (const seed of [1, 2, 3, 4, 5]) {
      const h = new Harness({ seed });
      h.env.typing = true;
      h.env.typingIntensity = 0.8;
      h.env.foreground = windowInfo('ed', { x: 200, y: 100, width: 1400, height: 800 });
      let moving = 0;
      const t = timeIn(h, 20 * MIN, 100, (hh, i) => {
        if ((hh.last?.speed ?? 0) > 1.5) moving += 100;
        return i % 50 === 0 ? [{ type: 'activity.typingStart' }] : [];
      });
      const active = (t.get('running') ?? 0) + (t.get('playing') ?? 0) + (t.get('chasingCursor') ?? 0);
      expect(active).toBe(0);
      expect(moving / (20 * MIN)).toBeLessThan(0.02);
    }
  });

  it('falls asleep once the user has been idle for sleepAfterIdleMinutes and wakes up when they return', () => {
    const s = settingsWith({ behavior: { sleepAfterIdleMinutes: 2 } });
    for (const seed of [11, 12, 13]) {
      const h = new Harness({ seed, settings: s });
      let idle = 0;
      h.run(2 * MIN, 100, () => {
        idle += 100;
        h.env.userIdleMs = idle;
      });
      const asleep = h.runUntil((o) => {
        idle += 100;
        h.env.userIdleMs = idle;
        return o.state === 'sleeping';
      }, 60_000, 100);
      expect(asleep).toBe(true);
      // Stays asleep while nobody is around.
      const t = timeIn(h, 10 * MIN, 200, () => {
        idle += 200;
        h.env.userIdleMs = idle;
      });
      expect(t.get('sleeping')).toBe(10 * MIN);
      expect(h.last?.nextTickMs).toBeGreaterThanOrEqual(100);
      expect(h.last?.nextTickMs).toBeLessThanOrEqual(200);
      h.env.userIdleMs = 0;
      h.step([{ type: 'activity.userReturned', idleMs: idle }], 100);
      expect(h.runUntil((o) => o.state === 'wakingUp', 3000, 50)).toBe(true);
      expect(h.last?.clip).toBe('wake');
    }
  });
});

describe('disabled behaviours', () => {
  it('never occur, whatever the stimuli', () => {
    const s = settingsWith({ behavior: { disabledBehaviors: [...TOGGLEABLE_BEHAVIORS], cursorPlay: 1, attentionSeeking: 1, autonomy: 1 } });
    for (const seed of [21, 22]) {
      const h = new Harness({ seed, settings: s });
      h.env.windows = { w: { x: 600, y: 800, width: 700, height: 240 } };
      h.keepOutputs = true;
      timeIn(h, 30 * MIN, 100, (hh, i) => {
        hh.env.cursor = { x: 900 + 400 * Math.sin(i / 30), y: 1000, speed: 1500 };
        const ev: SimEvent[] = [];
        if (i % 37 === 0) ev.push({ type: 'cursor.flick', speed: 3000, at: { x: hh.env.cursor.x, y: 1000 } });
        if (i % 101 === 0) ev.push({ type: 'perception.ai', report: { scene: 'game', energy: 'intense', interest: 1, reaction: i % 2 ? 'play' : 'groom', caption: '' }, regionPx: { x: 0, y: 0, width: 800, height: 600 } });
        if (i % 257 === 0) ev.push({ type: 'command.play' });
        if (i % 333 === 0) ev.push({ type: 'window.shown', window: windowInfo(`n${i}`, { x: 500, y: 300, width: 900, height: 600 }) });
        if (i % 401 === 0) ev.push({ type: 'activity.userReturned', idleMs: 10 * MIN });
        return ev;
      });
      const states = new Set(h.outputs.map((o) => o.state));
      for (const bad of ['chasingCursor', 'seekingAttention', 'inspectingWindow', 'grooming'] as const) expect(states.has(bad)).toBe(false);
      expect(h.outputs.some((o) => o.clip === 'groom')).toBe(false);
      expect(h.outputs.some((o) => o.support.kind === 'window')).toBe(false);
      expect(h.outputs.some((o) => o.state === 'playing' && o.clip === 'run')).toBe(false);
      expect(states.has('playing')).toBe(true);
    }
  });
});

describe('pause, hide and fullscreen', () => {
  it('pause: settles in place, ignores stimuli, allows petting and dragging, resumes with a stretch', () => {
    const h = new Harness({ seed: 31 });
    h.run(3000);
    h.env.paused = true;
    h.run(3000);
    const x0 = h.last!.x;
    const seen = new Set<BehaviorState>();
    h.run(4 * MIN, 100, (hh, i) => {
      seen.add(hh.last!.state);
      hh.env.cursor = { x: 300 + (i % 100) * 10, y: 1000, speed: 2000 };
      return i % 20 === 0 ? [{ type: 'cursor.flick', speed: 4000, at: { x: 400, y: 1000 } }, { type: 'command.callCat', at: { x: 100, y: 1000 } }, { type: 'window.shown', window: windowInfo(`p${i}`, { x: 0, y: 0, width: 900, height: 900 }) }] : [];
    });
    expect(h.last!.x).toBeCloseTo(x0, 6);
    for (const s of seen) expect(['resting', 'fallingAsleep', 'sleeping', 'landing', 'held', 'falling', 'idle', 'walking', 'grooming', 'watchingUser', 'curious', 'wakingUp']).toContain(s);
    expect(h.last!.state).toBe('sleeping');
    expect(h.last!.nextTickMs).toBe(500);
    // A sleeping cat needs a few strokes to wake up; continued petting then turns into beingPetted.
    h.step([{ type: 'pointer.pet', at: catPoint(h.last), strength: 1 }]);
    expect(h.last!.state).toBe('sleeping');
    h.step([{ type: 'pointer.pet', at: catPoint(h.last), strength: 1 }]);
    h.step([{ type: 'pointer.pet', at: catPoint(h.last), strength: 1 }]);
    expect(h.last!.state).toBe('wakingUp');
    h.step([{ type: 'pointer.pet', at: catPoint(h.last), strength: 1 }]);
    expect(h.last!.state).toBe('beingPetted');
    h.step([{ type: 'pointer.dragStart', at: catPoint(h.last) }]);
    expect(h.last!.state).toBe('held');
    h.env.dragCursor = { x: 1500, y: 500 };
    h.step();
    h.env.dragCursor = null;
    h.step([{ type: 'pointer.dragEnd', at: { x: 1500, y: 500 }, velocity: { x: 0, y: 0 } }]);
    expect(h.runUntil((o) => o.state === 'resting', 5000)).toBe(true);
    h.env.paused = false;
    expect(h.runUntil((o) => o.state === 'wakingUp', 1000)).toBe(true);
  });

  it('hide fades out to invisible "away" and unhide fades back in', () => {
    const h = new Harness({ seed: 32 });
    h.run(2000);
    expect(h.last!.visible).toBe(true);
    h.env.hidden = true;
    h.step();
    expect(h.last!.state).toBe('away');
    expect(h.last!.opacity).toBeLessThan(1);
    expect(h.last!.nextTickMs).toBe(33);
    h.run(600);
    expect(h.last!.visible).toBe(false);
    expect(h.last!.opacity).toBe(0);
    expect(h.last!.nextTickMs).toBe(500);
    h.run(5000, 500, () => [{ type: 'pointer.dragStart', at: { x: 900, y: 1000 } }, { type: 'command.play' }]);
    expect(h.last!.state).toBe('away');
    h.env.hidden = false;
    h.step();
    expect(h.last!.state).not.toBe('away');
    h.run(600);
    expect(h.last!.visible).toBe(true);
    expect(h.last!.opacity).toBeCloseTo(1, 6);
  });

  it('fullscreen on the cat display: hide -> away, quiet -> asleep at half opacity, ignore -> nothing', () => {
    const hide = new Harness({ seed: 33 });
    hide.run(2000);
    hide.env.fullscreenDisplayIds = ['1'];
    hide.run(1000);
    expect(hide.last!.state).toBe('away');
    expect(hide.last!.visible).toBe(false);

    const quiet = new Harness({ seed: 33, settings: settingsWith({ behavior: { fullscreenBehavior: 'quiet' } }) });
    quiet.run(2000);
    quiet.env.fullscreenDisplayIds = ['1'];
    quiet.run(15_000);
    expect(quiet.last!.state).toBe('sleeping');
    expect(quiet.last!.opacity).toBeCloseTo(0.5, 6);
    quiet.env.fullscreenDisplayIds = [];
    expect(quiet.runUntil((o) => o.state === 'wakingUp', 1000)).toBe(true);
    quiet.run(1000);
    expect(quiet.last!.opacity).toBeCloseTo(1, 6);

    const ignore = new Harness({ seed: 33, settings: settingsWith({ behavior: { fullscreenBehavior: 'ignore' } }) });
    ignore.run(2000);
    ignore.env.fullscreenDisplayIds = ['1'];
    ignore.run(3000);
    expect(ignore.last!.state).not.toBe('away');
    expect(ignore.last!.opacity).toBeCloseTo(1, 6);

    const other = new Harness({ seed: 33, world: DUAL_MIXED });
    other.run(2000);
    other.env.fullscreenDisplayIds = ['2'];
    other.run(3000);
    expect(other.last!.visible).toBe(true);
  });

  it('system lock puts the cat to sleep; unlock wakes it', () => {
    const h = new Harness({ seed: 34 });
    h.run(2000);
    h.step([{ type: 'system.lock' }]);
    expect(h.runUntil((o) => o.state === 'sleeping', 10_000)).toBe(true);
    h.run(MIN, 250, (_hh, i) => (i % 10 === 0 ? [{ type: 'cursor.flick', speed: 5000, at: { x: 500, y: 1000 } }] : []));
    expect(h.last!.state).toBe('sleeping');
    h.step([{ type: 'system.unlock' }]);
    expect(h.last!.state).toBe('wakingUp');
  });
});

describe('quit', () => {
  const setups: Array<[string, (h: Harness) => void]> = [
    ['idle', () => {}],
    ['sleeping', (h) => h.step([{ type: 'command.sleep' }])],
    ['held', (h) => h.step([{ type: 'pointer.dragStart', at: catPoint(h.last) }])],
    [
      'thrown',
      (h) => {
        h.step([{ type: 'pointer.dragStart', at: catPoint(h.last) }]);
        h.env.dragCursor = { x: 900, y: 200 };
        h.step();
        h.step([{ type: 'pointer.dragEnd', at: { x: 900, y: 200 }, velocity: { x: 2000, y: -2000 } }]);
      },
    ],
    ['running', (h) => h.step([{ type: 'command.callCat', at: { x: 100, y: 1000 } }])],
    ['away', (h) => ((h.env.hidden = true), h.run(1000))],
    ['paused', (h) => ((h.env.paused = true), h.run(1000))],
  ];

  it.each(setups)('emits quitReady exactly once within 1.2 s from %s', (_name, setup) => {
    for (const dt of [16, 33, 100, 250]) {
      const h = new Harness({ seed: 41 });
      h.run(3000);
      setup(h);
      h.step([]);
      let readyAt: number | null = null;
      let count = 0;
      h.step([{ type: 'lifecycle.quitRequested' }], dt);
      const t0 = h.now; // sim time at which the request was processed
      h.run(3000, dt, (hh) => {
        if (hh.last!.requests.some((r) => r.type === 'quitReady')) {
          readyAt ??= hh.now;
          count++;
        }
      });
      if (h.last!.requests.some((r) => r.type === 'quitReady')) count++;
      expect(readyAt).not.toBeNull();
      expect((readyAt as unknown as number) - t0).toBeLessThanOrEqual(1200);
      expect(count).toBe(1);
      expect(['sleeping', 'away']).toContain(h.last!.state);
      expect(h.last!.support.kind === 'floor' || h.last!.support.kind === 'window').toBe(true);
    }
  });
});

describe('interaction', () => {
  it('petting: beingPetted, bond grows, purr/heart emotes, pets counted', () => {
    const h = new Harness({ seed: 51 });
    h.run(2000);
    const bond0 = h.sim.serialize().stats.bond;
    let hearts = 0;
    h.run(10_000, 33, (hh, i) => {
      if (hh.last!.emote === 'heart') hearts++;
      return i % 10 === 0 ? [{ type: 'pointer.pet', at: catPoint(hh.last), strength: 0.8 }] : [];
    });
    expect(h.last!.state).toBe('beingPetted');
    expect(h.last!.clip).toBe('petted');
    expect(h.last!.contentment).toBeGreaterThan(0.6);
    const after = h.sim.serialize();
    expect(after.stats.bond).toBeGreaterThan(bond0);
    expect(after.memory.counters.pets).toBeGreaterThanOrEqual(7);
    expect(after.memory.recent.some((e) => e.kind === 'pet')).toBe(true);
    expect(hearts).toBeGreaterThan(0);
    h.run(5000);
    expect(h.last!.state).not.toBe('beingPetted');
  });

  it('repeated taps: look/meow, then annoyed, then retreat into hiding', () => {
    const h = new Harness({ seed: 52, settings: settingsWith({ interaction: { patience: 0.2 } }) });
    h.run(2000);
    const seen: BehaviorState[] = [];
    h.run(12_000, 33, (hh, i) => {
      seen.push(hh.last!.state);
      return i % 12 === 0 ? [{ type: 'pointer.tap', at: catPoint(hh.last) }] : [];
    });
    expect(seen).toContain('annoyed');
    expect(seen).toContain('hiding');
    expect(seen.indexOf('annoyed')).toBeLessThan(seen.indexOf('hiding'));
    expect(h.sim.serialize().memory.counters.clicks).toBeGreaterThan(20);
  });

  it('a single tap makes the cat look at the tap point', () => {
    const h = new Harness({ seed: 53 });
    h.run(2000);
    const at = { x: h.last!.x + 30, y: h.last!.y - 40 };
    h.step([{ type: 'pointer.tap', at }]);
    expect(h.last!.look).toEqual(at);
  });

  it('a throw ends with a startle or annoyed reaction; a gentle drop does not', () => {
    const throwIt = (vx: number, seed: number): BehaviorState[] => {
      const h = new Harness({ seed });
      h.run(2000);
      h.step([{ type: 'pointer.dragStart', at: catPoint(h.last) }]);
      h.env.dragCursor = { x: 900, y: 300 };
      h.step();
      h.step([{ type: 'pointer.dragEnd', at: { x: 900, y: 300 }, velocity: { x: vx, y: vx === 0 ? 0 : -1500 } }]);
      h.env.dragCursor = null;
      const states: BehaviorState[] = [];
      h.run(4000, 33, (hh) => void states.push(hh.last!.state));
      return states;
    };
    const hard = throwIt(2500, 54);
    expect(hard).toContain('falling');
    expect(hard).toContain('landing');
    expect(hard.some((s) => s === 'startled' || s === 'annoyed')).toBe(true);
    const soft = throwIt(0, 54);
    expect(soft).toContain('landing');
    expect(soft.some((s) => s === 'startled' || s === 'annoyed')).toBe(false);
  });

  it('callCat brings the cat to the point (waking it first if needed)', () => {
    const h = new Harness({ seed: 55 });
    h.run(2000);
    h.step([{ type: 'command.sleep' }]);
    h.run(8000);
    expect(h.last!.state).toBe('sleeping');
    h.step([{ type: 'command.callCat', at: { x: 200, y: 900 } }]);
    expect(h.last!.state).toBe('wakingUp');
    const seen = new Set<BehaviorState>();
    const arrived = h.runUntil((o) => {
      seen.add(o.state);
      return Math.abs(o.x - 200) < 5 && o.state === 'idle';
    }, 40_000);
    expect(arrived).toBe(true);
    expect(seen.has('running') || seen.has('walking')).toBe(true);
    expect(seen.has('startled')).toBe(false);
    expect(h.last!.look).toEqual({ x: 200, y: 900 });
  });
});

describe('outputs', () => {
  it('requests perception at most every 30 s and saves at most every 60 s', () => {
    const h = new Harness({ seed: 61 });
    const perception: number[] = [];
    const saves: number[] = [];
    h.env.foreground = windowInfo('f', { x: 300, y: 100, width: 1200, height: 800 });
    h.run(20 * MIN, 100, (hh, i) => {
      for (const r of hh.last!.requests) {
        if (r.type === 'perception') perception.push(hh.now);
        if (r.type === 'save') saves.push(hh.now);
      }
      const ev: SimEvent[] = [];
      if (i % 300 === 0) ev.push({ type: 'perception.visual', summary: { features: { brightness: 0.5, contrast: 0.5, colorfulness: 0.5, edgeDensity: 0.5, changeFraction: 0.5, changeBox: null, motion: 0.9 }, events: ['motion', 'bigChange'], regionPx: { x: 0, y: 0, width: 800, height: 800 }, changeCenterPx: { x: 400, y: 400 }, at: hh.now } });
      if (i % 1200 === 0) ev.push({ type: 'pointer.pet', at: catPoint(hh.last), strength: 0.5 });
      return ev;
    });
    expect(perception.length).toBeGreaterThan(0);
    expect(saves.length).toBeGreaterThan(1);
    for (let i = 1; i < perception.length; i++) expect(perception[i]! - perception[i - 1]!).toBeGreaterThanOrEqual(30_000);
    for (let i = 1; i < saves.length; i++) expect(saves[i]! - saves[i - 1]!).toBeGreaterThanOrEqual(60_000);
  });

  it('bounds emote frequency and reports sane tick intervals and bounds', () => {
    const h = new Harness({ seed: 62 });
    let starts = 0;
    let lastStart = -1;
    h.keepOutputs = true;
    h.run(10 * MIN, 50, (hh, i) => {
      const o = hh.last!;
      if (o.emote && o.emoteStartedAt !== lastStart) {
        starts++;
        lastStart = o.emoteStartedAt;
      }
      return i % 7 === 0 ? [{ type: 'pointer.pet', at: catPoint(o), strength: 1 }, { type: 'pointer.tap', at: catPoint(o) }] : [];
    });
    expect(starts).toBeLessThanOrEqual((10 * MIN) / 1200);
    for (const o of h.outputs) {
      expect(o.nextTickMs).toBeGreaterThanOrEqual(33);
      expect(o.nextTickMs).toBeLessThanOrEqual(500);
      expect(o.boundsPx.width).toBeCloseTo(84, 6);
      expect(o.boundsPx.height).toBeCloseTo(64, 6);
      expect(o.boundsPx.x + o.boundsPx.width / 2).toBeCloseTo(o.x, 6);
      expect(o.boundsPx.y + o.boundsPx.height).toBeCloseTo(o.y, 6);
    }
  });

  it('scales bounds and speeds with appearance.size and the display scale factor', () => {
    const h = new Harness({ seed: 63, world: DUAL_MIXED, settings: settingsWith({ appearance: { size: 2 } }) });
    h.step();
    h.step([{ type: 'command.callCat', at: { x: -1500, y: 1200 } }]);
    let maxSpeed = 0;
    h.runUntil((o) => {
      if (o.displayId === '2' && o.support.kind === 'floor') {
        maxSpeed = Math.max(maxSpeed, o.speed);
        expect(o.boundsPx.width).toBeCloseTo(84 * 2 * 1.5, 6);
      }
      return o.state === 'idle' && o.displayId === '2';
    }, 60_000);
    expect(h.last!.displayId).toBe('2');
    // running at 260 DIP/s with a body length of 168 DIP -> ~1.55 body lengths/s
    expect(maxSpeed).toBeGreaterThan(1);
    expect(maxSpeed).toBeLessThan(1.7);
  });

  it('starts with a fade-in and a snapped first frame', () => {
    const h = new Harness({ seed: 64 });
    const first = h.step();
    expect(first.snap).toBe(true);
    expect(first.opacity).toBeLessThan(0.2);
    expect(h.step().snap).toBe(false);
    h.run(500);
    expect(h.last!.opacity).toBeCloseTo(1, 6);
  });
});

describe('memory learning', () => {
  it('learns a favourite spot where it rests and goes back there to sleep', () => {
    const h = new Harness({ seed: 71, world: SINGLE, settings: settingsWith({ behavior: { sleepAfterIdleMinutes: 1 } }) });
    h.step();
    // Nap at the far left for a long time.
    h.step([{ type: 'command.callCat', at: { x: 150, y: 1000 } }]);
    h.runUntil((o) => o.state === 'idle' && Math.abs(o.x - 150) < 5, 60_000);
    h.step([{ type: 'command.sleep' }]);
    h.run(8 * MIN, 250);
    h.step([{ type: 'command.wake' }]);
    h.run(3000);
    const spots = h.sim.serialize().memory.favoriteSpots;
    expect(spots.length).toBeGreaterThan(0);
    expect(spots[0]!.xFrac).toBeCloseTo(150 / 1920, 2);
    // Move away, then let the user go idle: the cat walks back to its spot to sleep.
    h.step([{ type: 'command.callCat', at: { x: 1700, y: 1000 } }]);
    h.runUntil((o) => o.state === 'idle' && Math.abs(o.x - 1700) < 5, 60_000);
    let idle = 0;
    const slept = h.runUntil((o) => {
      idle += 100;
      h.env.userIdleMs = idle;
      return o.state === 'sleeping';
    }, 5 * MIN, 100);
    expect(slept).toBe(true);
    expect(Math.abs(h.last!.x - 150)).toBeLessThan(84 * 2);
  });

  it('learns cursor-play acceptance from whether the user keeps moving the cursor', () => {
    const run = (moving: boolean): number => {
      const h = new Harness({ seed: 72, settings: settingsWith({ behavior: { cursorPlay: 1 } }) });
      h.run(2000);
      const before = h.sim.serialize().memory.preferences.cursorPlayAcceptance;
      h.run(10 * MIN, 50, (hh, i) => {
        const x = moving ? 900 + 500 * Math.sin(i / 15) : 1200;
        hh.env.cursor = { x, y: 1000, speed: moving ? 900 : 0 };
        return i % 400 === 0 ? [{ type: 'cursor.flick', speed: 4000, at: { x, y: 1000 } }] : [];
      });
      const p = h.sim.serialize();
      expect(p.memory.counters.chasesStarted).toBeGreaterThan(0);
      return p.memory.preferences.cursorPlayAcceptance - before;
    };
    expect(run(true)).toBeGreaterThan(0);
    expect(run(false)).toBeLessThan(0);
  });

  it('clearHistory keeps traits; resetPersonality makes a new cat', () => {
    const h = new Harness({ seed: 73 });
    h.run(5000, 50, (hh, i) => (i % 10 === 0 ? [{ type: 'pointer.pet', at: catPoint(hh.last), strength: 1 }] : []));
    const before = h.sim.serialize();
    expect(before.memory.counters.pets).toBeGreaterThan(0);
    h.sim.clearHistory();
    const cleared = h.sim.serialize();
    expect(cleared.traits).toEqual(before.traits);
    expect(cleared.catId).toBe(before.catId);
    expect(cleared.memory.counters.pets).toBe(0);
    expect(cleared.memory.recent).toEqual([]);
    expect(h.step().requests.some((r) => r.type === 'save')).toBe(true);
    h.sim.resetPersonality();
    const reset = h.sim.serialize();
    expect(reset.catId).not.toBe(before.catId);
    expect(reset.traits).not.toEqual(before.traits);
    expect(reset.stats.annoyance).toBe(0);
  });
});
