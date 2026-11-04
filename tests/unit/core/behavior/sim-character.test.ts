// Character details from the product brief: the wake-up stretch, ear flicks on a click,
// commands the cat may ignore, learned wariness and affection, corners and surprises.
import { describe, expect, it } from 'vitest';
import type { PersistedCat, Stats, Traits } from '../../../../src/shared/catState';
import type { SimOutput } from '../../../../src/shared/sim';
import { mulberry32, newPersistedCat } from '../../../../src/core/behavior';
import { MAX_COMMAND_IGNORE_CHANCE, REACTION_MIN_GAP_MS, SURPRISE_COOLDOWN_MS } from '../../../../src/core/behavior/sim';
import { huntGain } from '../../../../src/core/behavior/hunt';
import { callCat, commandsIgnored, decisionView, DUAL_FLAT, Harness, scoreOf, settingsWith, WAKE_MS } from './fixtures';

const MIN = 60_000;
const WALL = 1_800_000_000_000;
const catPoint = (o: SimOutput | null) => ({ x: o?.x ?? 0, y: (o?.y ?? 0) - 30 });

function catWith(seed: number, o: { traits?: Partial<Traits>; stats?: Partial<Stats>; recent?: PersistedCat['memory']['recent']; petRate?: number } = {}): PersistedCat {
  const cat = newPersistedCat(mulberry32(seed), WALL - 3600_000);
  Object.assign(cat.traits, o.traits ?? {});
  Object.assign(cat.stats, o.stats ?? {});
  if (o.recent) cat.memory.recent = o.recent;
  if (o.petRate !== undefined) cat.memory.preferences.petRatePerHour = o.petRate;
  return cat;
}

describe('F1: every launch starts with a wake-up stretch', () => {
  it('a brand-new cat (first start) naps briefly and wakes up with the stretch', () => {
    for (const seed of [1, 2, 3]) {
      const h = new Harness({ seed, persisted: null });
      expect(h.step().state).toBe('sleeping');
      expect(h.runUntil((o) => o.state === 'wakingUp' && o.clip === 'wake', WAKE_MS)).toBe(true);
      h.run(WAKE_MS);
      expect(['sleeping', 'wakingUp']).not.toContain(h.last!.state);
    }
  });

  it('so does a cat recovered from an unusable save file', () => {
    const h = new Harness({ seed: 4, persisted: { schemaVersion: 'garbage' } as unknown as PersistedCat });
    expect(h.step().state).toBe('sleeping');
    expect(h.runUntil((o) => o.clip === 'wake', WAKE_MS)).toBe(true);
  });
});

describe('F2: a click makes the cat flick an ear', () => {
  it('a tap on an awake cat starts an ear flick (once per distinct start time)', () => {
    const h = new Harness({ seed: 5 });
    h.run(WAKE_MS);
    expect(h.last!.reaction ?? null).toBeNull();
    const o = h.step([{ type: 'pointer.tap', at: catPoint(h.last) }]);
    expect(o.reaction).toEqual({ kind: 'earFlick', at: h.now });
    // The same reaction stays in the output for the renderer, then clears.
    expect(h.step().reaction).toEqual({ kind: 'earFlick', at: o.reaction!.at });
    h.run(2500);
    expect(h.last!.reaction).toBeNull();
  });

  it('never starts reactions more often than REACTION_MIN_GAP_MS', () => {
    const h = new Harness({ seed: 6, settings: settingsWith({ interaction: { patience: 1 } }) });
    h.run(WAKE_MS);
    const starts: number[] = [];
    // A tap every ~200 ms (not enough to annoy a patient cat in a second and a half).
    h.run(1500, 33, (hh, i) => {
      const r = hh.last!.reaction;
      if (r && starts.at(-1) !== r.at) starts.push(r.at);
      return i % 6 === 0 ? [{ type: 'pointer.tap', at: catPoint(hh.last) }] : [];
    });
    expect(starts.length).toBeGreaterThan(2);
    for (let i = 1; i < starts.length; i++) expect(starts[i]! - starts[i - 1]!).toBeGreaterThanOrEqual(REACTION_MIN_GAP_MS);
  });

  it('a sleeping cat flicks an ear at a tap too', () => {
    const h = new Harness({ seed: 7 });
    h.run(WAKE_MS);
    h.step([{ type: 'command.sleep' }]);
    h.run(8000);
    expect(h.last!.state).toBe('sleeping');
    const o = h.step([{ type: 'pointer.tap', at: catPoint(h.last) }]);
    expect(o.reaction?.kind).toBe('earFlick');
  });
});

describe('F11: the cat may ignore a command', () => {
  /** Sends a call; returns whether the cat ignored it. */
  function call(h: Harness, at = { x: 200, y: 1000 }): boolean {
    const before = commandsIgnored(h);
    h.step([{ type: 'command.callCat', at }]);
    return commandsIgnored(h) > before;
  }

  it('an annoyed, frightened, unbonded cat ignores some calls, but never more than the cap and never twice in a row', () => {
    const h = new Harness({ seed: 8, persisted: catWith(8, { stats: { annoyance: 1, fear: 1, bond: 0.05 }, traits: { affection: 0.12, confidence: 0.9 } }) });
    h.run(WAKE_MS);
    expect(h.sim.commandIgnoreChance()).toBeLessThanOrEqual(MAX_COMMAND_IGNORE_CHANCE);
    expect(h.sim.commandIgnoreChance()).toBeGreaterThan(0.25);
    const ignored: boolean[] = [];
    for (let i = 0; i < 60; i++) {
      const before = h.last!;
      // Called to where it already is, an obeyed call is over at once, so every call is a fresh one.
      const was = call(h, { x: before.x, y: 1000 });
      ignored.push(was);
      if (was) {
        // Not now: a tail flick, and it does not set off.
        expect(h.last!.reaction?.kind).toBe('tailFlick');
        expect(h.last!.state).toBe(before.state);
      }
      h.run(300);
    }
    const n = ignored.filter(Boolean).length;
    expect(n).toBeGreaterThan(3);
    expect(n / ignored.length).toBeLessThanOrEqual(MAX_COMMAND_IGNORE_CHANCE + 0.1);
    for (let i = 1; i < ignored.length; i++) expect(ignored[i - 1] && ignored[i]).toBe(false);
  });

  it('a call it is already answering, or one that fetches it from a fullscreen display, is never ignored', () => {
    const grumpy = (seed: number): PersistedCat => catWith(seed, { stats: { annoyance: 1, fear: 1, bond: 0.05 }, traits: { affection: 0.12, confidence: 0.9 } });
    const h = new Harness({ seed: 18, persisted: grumpy(18) });
    h.run(WAKE_MS);
    callCat(h, { x: 100, y: 1000 });
    const before = commandsIgnored(h);
    let answered = 0;
    for (let i = 0; i < 15 && (h.last!.state === 'walking' || h.last!.state === 'running'); i++) {
      h.step([{ type: 'command.callCat', at: { x: 100 + 10 * i, y: 1000 } }]);
      answered++;
      h.run(150);
    }
    expect(answered).toBeGreaterThan(5);
    expect(commandsIgnored(h)).toBe(before);
    for (let seed = 1; seed <= 12; seed++) {
      const cat = grumpy(seed);
      cat.lastPosition = { displayKey: '2', xFrac: 0.5, support: 'floor' };
      const g = new Harness({ seed, world: DUAL_FLAT, persisted: cat });
      g.env.fullscreenDisplayIds = ['2'];
      g.run(WAKE_MS);
      expect(g.last!.state).toBe('away');
      g.step([{ type: 'command.callCat', at: { x: 600, y: 1000 } }], 100);
      expect(g.last!.displayId).toBe('1');
      expect(commandsIgnored(g)).toBe(0);
    }
  });

  it('a content, bonded cat practically always comes; a fresh cat comes most of the time', () => {
    const content = new Harness({ seed: 9, persisted: catWith(9, { stats: { bond: 0.9, annoyance: 0, fear: 0, energy: 0.9 }, traits: { affection: 0.9 } }) });
    content.run(WAKE_MS);
    expect(content.sim.commandIgnoreChance()).toBeLessThan(0.02);
    for (let seed = 1; seed <= 40; seed++) {
      const h = new Harness({ seed });
      h.run(WAKE_MS);
      expect(h.sim.commandIgnoreChance()).toBeLessThan(0.12);
    }
  });

  it('an ignored Play command starts no play; the next one is obeyed', () => {
    let ignoredPlays = 0;
    for (const seed of [10, 11, 12, 13, 14, 15, 16, 17]) {
      const h = new Harness({ seed, persisted: catWith(seed, { stats: { annoyance: 1, bond: 0.05 }, traits: { affection: 0.12, confidence: 0.9 } }) });
      h.run(WAKE_MS);
      if (h.last!.state === 'playing') continue;
      const before = commandsIgnored(h);
      h.step([{ type: 'command.play' }]);
      if (commandsIgnored(h) > before) {
        ignoredPlays++;
        h.run(300);
        expect(h.last!.state).not.toBe('playing');
        expect(h.last!.reaction?.kind).toBe('tailFlick');
        // The next command is obeyed.
        h.run(500);
        h.step([{ type: 'command.play' }]);
        expect(h.runUntil((o) => o.state === 'playing', 1000)).toBe(true);
      }
    }
    expect(ignoredPlays).toBeGreaterThan(0);
  });
});

describe('F10: what the cat learned changes how it behaves after a restart', () => {
  it('rough handling opens up hiding (no baseline: an unharmed cat never picks it)', () => {
    expect(scoreOf(decisionView(), 'hiding')).toBe(0);
    expect(scoreOf(decisionView({ recentRough: 4 }), 'hiding')).toBeGreaterThan(0);
  });

  it('a cat thrown several times before the restart now and then keeps out of the way; an unharmed one does not', () => {
    const hides = (rough: boolean): number => {
      let n = 0;
      for (const seed of [21, 22, 23, 24]) {
        const recent = rough ? [0, 1, 2, 3].map((i) => ({ at: WALL - 10 * MIN + i, kind: 'throw', detail: 'hard' })) : [];
        const h = new Harness({ seed, persisted: catWith(seed, { recent }), settings: settingsWith({ behavior: { autonomy: 1 } }) });
        h.run(60 * MIN, 100);
        n += h.transitions.filter((t) => t.to === 'hiding' && t.cause === 'autonomous').length;
      }
      return n;
    };
    expect(hides(false)).toBe(0);
    const n = hides(true);
    expect(n).toBeGreaterThan(0);
    // Wary, not frantic: a few short hides an hour at most.
    expect(n).toBeLessThan(4 * 8);
  });
});

describe('F12: corners, surprises and boredom play', () => {
  it('scores a wander to the corner by the explore need, a rare surprise only when its cooldown is over and a stimulus just happened, and hunts more keenly with a play need', () => {
    const corner = { x: 60, y: 1040 };
    expect(scoreOf(decisionView({ cornerTarget: corner, stats: { ...decisionView().stats, boredom: 1 } }), 'walking', 'corner')).toBeGreaterThan(
      2 * scoreOf(decisionView({ cornerTarget: corner, stats: { ...decisionView().stats, boredom: 0 } }), 'walking', 'corner'),
    );
    expect(scoreOf(decisionView(), 'walking', 'corner')).toBe(0);
    expect(scoreOf(decisionView({ surpriseReady: false }), 'startled')).toBe(0);
    expect(scoreOf(decisionView({ surpriseReady: true }), 'startled')).toBe(0);
    expect(scoreOf(decisionView({ surpriseReady: true, recentStimulus: true }), 'startled', 'surprise')).toBeGreaterThan(0);
    expect(scoreOf(decisionView({ surpriseReady: true, recentStimulus: true, typing: true }), 'startled')).toBe(0);
    expect(huntGain(0.5, 0.6, 1)).toBeGreaterThan(2.2 * huntGain(0.5, 0.6, 0));
  });

  it('over a long session the cat sometimes walks into a corner, and is surprised only rarely', () => {
    let corners = 0;
    let surprises = 0;
    const hours = 2;
    const seeds = [31, 32, 33, 34];
    for (const seed of seeds) {
      const h = new Harness({ seed, settings: settingsWith({ behavior: { autonomy: 1 } }) });
      let wasCorner = false;
      // ADR 0003 §1.4: the surprise is only a candidate while a recent stimulus exists; a window comes and goes.
      h.run(hours * 60 * MIN, 100, (hh, i) => {
        const info = hh.sim.debugInfo();
        const inCorner = info.state === 'walking' && info.variant === 'corner';
        if (inCorner && !wasCorner) corners++;
        wasCorner = inCorner;
        return i % 300 === 0 ? [{ type: 'window.shown', window: { id: `w${i}`, rect: { x: 1500, y: 100, width: 300, height: 200 }, processName: 'app.exe', category: 'browser', minimized: false, maximized: false, fullscreen: false, excluded: false } }] : [];
      });
      const startles = h.transitions.filter((t) => t.to === 'startled' && t.cause === 'autonomous').map((t) => t.at);
      surprises += startles.length;
      for (let i = 1; i < startles.length; i++) expect(startles[i]! - startles[i - 1]!).toBeGreaterThanOrEqual(SURPRISE_COOLDOWN_MS);
      // The corner is the end of the floor.
      if (h.transitions.length > 0) expect(Number.isFinite(h.last!.x)).toBe(true);
    }
    expect(corners).toBeGreaterThan(0);
    expect(surprises).toBeGreaterThan(0);
    expect(surprises).toBeLessThanOrEqual(seeds.length * hours * 3);
  });

  it('a wander to the corner ends near the end of the floor', () => {
    let checked = 0;
    for (const seed of [41, 42, 43, 44, 45, 46]) {
      const h = new Harness({ seed, settings: settingsWith({ behavior: { autonomy: 1 } }) });
      let inCorner = false;
      h.run(60 * MIN, 100, (hh) => {
        const info = hh.sim.debugInfo();
        const now = info.state === 'walking' && info.variant === 'corner';
        if (inCorner && !now && info.state !== 'jumping' && info.state !== 'falling') {
          const x = hh.last!.x;
          expect(Math.min(x, 1920 - x)).toBeLessThan(84 * 1.5);
          checked++;
        }
        inCorner = now;
      });
    }
    expect(checked).toBeGreaterThan(0);
  });
});
