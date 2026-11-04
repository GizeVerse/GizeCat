// What decides a trip up against everything else, on the scorer the sim really uses (utility.ts, ADR
// 0003 §1.2, §1.4). The exploration urge (v1.1.1) still raises the odds of a trip up for a cat that has
// stayed down with somewhere to go, while sleep, fear, annoyance, typing and switched-off behaviours
// still win, and the way back down or along a strip gets no boost.
import { describe, expect, it } from 'vitest';
import type { DecisionView } from '../../../../src/core/behavior/decide';
import { scoreAll, urgeBonus, urgeCalm } from '../../../../src/core/behavior/utility';
import { decisionView, scoreOf, settingsWith } from './fixtures';
import { USER_STATS, USER_TRAITS } from './liveness';

const TOP = { windowId: 'w', point: { x: 800, y: 120 } };
const CLIMB = { point: { x: 310, y: 120 }, dir: 'up' as const };
const STRIP = { x: 700, y: 120 };

const NEEDS = { socialNeed: 0.3, playNeed: 0.4, exploreNeed: 0.4, sleepiness: 0.2, mischief: 0.3, huntDrive: 0, irritability: 0, frustration: 0, wariness: 0 };

/** The user's cat on the floor at the default settings, every way up within reach, nobody at the keyboard. */
function userView(o: Partial<DecisionView> = {}): DecisionView {
  return decisionView({
    traits: { ...USER_TRAITS },
    stats: { energy: 0.74, boredom: 0.02, bond: 0.28, annoyance: 0, fear: 0, ...USER_STATS },
    behavior: settingsWith({}).behavior,
    cursor: null,
    foreground: { center: { x: 800, y: 540 }, distBodyLengths: 3 },
    wanderTarget: { x: 1200, y: 1195 },
    perchTarget: TOP,
    climbTarget: CLIMB,
    tabStripTarget: STRIP,
    drives: { ...NEEDS },
    ...o,
  });
}

const TRIPS: Array<[string, string]> = [
  ['inspectingWindow', 'explore'],
  ['walking', 'climb'],
  ['walking', 'tabStrip'],
];
const CALM: Array<[string, string | null]> = [
  ['idle', null],
  ['grooming', null],
  ['resting', null],
];

const best = (v: DecisionView, options: Array<[string, string | null]>): number => Math.max(...options.map(([s, vr]) => scoreOf(v, s as never, vr)));
const eachTrip = (v: DecisionView): Array<[string, number]> => TRIPS.map(([s, vr]) => [`${s}/${vr}`, scoreOf(v, s as never, vr)]);

describe('the exploration urge in the scorer the sim uses (ADR 0003 §1.2)', () => {
  it('a satisfied cat at urge 0 prefers to sit (the floor-only report stays explained)', () => {
    const v = userView({ exploreUrge: 0, drives: { ...NEEDS, exploreNeed: 0.02 } });
    for (const [name, u] of eachTrip(v)) expect(u, name).toBeLessThan(scoreOf(v, 'idle'));
  });

  it('at urge 1 with an ordinary explore need every trip up beats sitting, grooming and resting', () => {
    const v = userView({ exploreUrge: 1 });
    const calm = best(v, CALM);
    for (const [name, u] of eachTrip(v)) expect(u, name).toBeGreaterThan(calm);
    // And without the urge none of them does.
    const none = userView({ exploreUrge: 0 });
    const calmNone = best(none, CALM);
    for (const [name, u] of eachTrip(none)) expect(u, name).toBeLessThan(calmNone);
  });

  it('grows cubically with the urge (a cat that just came down stays down a while), with Exploration and the explore need', () => {
    const at = (u: number, X = 0.6, nE = 0.4): number => urgeBonus(u, X, nE);
    expect(at(0)).toBe(0);
    expect(at(0.5)).toBeCloseTo(at(1) / 8, 9);
    expect(at(1, 1)).toBeGreaterThan(at(1, 0.6));
    expect(at(1, 0.6)).toBeGreaterThan(at(1, 0));
    expect(at(1, 0)).toBeGreaterThan(0);
    expect(at(1, 0.6, 0.8)).toBeCloseTo(at(1, 0.6, 0.2) * 2, 9);
    // Nonsense in, nothing out.
    expect(at(Number.NaN)).toBe(0);
    expect(at(-1)).toBe(0);
    expect(at(7)).toBeCloseTo(at(1), 12);
  });

  it('sleep still wins: a tired cat naps, and with nobody around only rest options exist', () => {
    const tired = userView({ exploreUrge: 1, zEff: 1 });
    const nap = scoreOf(tired, 'fallingAsleep');
    for (const [name, u] of eachTrip(tired)) expect(u, name).toBeLessThan(nap);
    const nobody = userView({ exploreUrge: 1, userIdleMs: 60 * 60_000 });
    for (const [name, u] of eachTrip(nobody)) expect(u, name).toBe(0);
    expect(scoreOf(nobody, 'fallingAsleep')).toBeGreaterThan(0);
  });

  it('fear and annoyance take the bonus away, and only the bonus', () => {
    const stats = userView().stats;
    const bonusless = userView({ exploreUrge: 0 });
    const v = (fear: number, annoyance: number): DecisionView => userView({ exploreUrge: 1, stats: { ...stats, fear, annoyance } });
    for (const [s, vr] of TRIPS) {
      const own = scoreOf(bonusless, s as never, vr);
      expect(scoreOf(v(0.6, 0), s as never, vr)).toBeCloseTo(own, 9);
      expect(scoreOf(v(0, 0.7), s as never, vr)).toBeCloseTo(own, 9);
      expect(scoreOf(v(0.3, 0), s as never, vr)).toBeLessThan(scoreOf(v(0, 0), s as never, vr));
      expect(scoreOf(v(0.3, 0), s as never, vr)).toBeGreaterThan(own);
    }
    expect(urgeCalm(0, 0)).toBe(1);
    expect(urgeCalm(0.2, 0.3)).toBe(1);
    expect(urgeCalm(0.5, 0)).toBeCloseTo(0, 9);
    expect(urgeCalm(0, 0.7)).toBeCloseTo(0, 9);
  });

  it('switched-off behaviours never get it', () => {
    const off = userView({ exploreUrge: 1, disabled: new Set(['perchOnWindows', 'climbWindows', 'tabStrips']) });
    for (const [name, u] of eachTrip(off)) expect(u, name).toBe(0);
    const noClimb = userView({ exploreUrge: 1, disabled: new Set(['climbWindows']) });
    expect(scoreOf(noClimb, 'walking', 'climb')).toBe(0);
    expect(scoreOf(noClimb, 'inspectingWindow', 'explore')).toBeGreaterThan(0);
  });

  it('typing makes a trip rarer but never impossible, also for a while after and with "React to typing" off', () => {
    const free = scoreOf(userView({ exploreUrge: 1 }), 'walking', 'climb');
    const typing = scoreOf(userView({ exploreUrge: 1, typing: true, typingRaw: true }), 'walking', 'climb');
    expect(typing).toBeCloseTo(free * 0.35 * 0.6, 9);
    const after = scoreOf(userView({ exploreUrge: 1, sinceTypingMs: 5000 }), 'walking', 'climb');
    expect(after).toBeCloseTo(free * 0.35, 9);
    expect(scoreOf(userView({ exploreUrge: 1, sinceTypingMs: 60_000 }), 'walking', 'climb')).toBeCloseTo(free, 9);
    const ignore = { ...settingsWith({}).behavior, reactToTyping: false };
    const raw = scoreOf(userView({ exploreUrge: 1, typing: true, typingRaw: true, behavior: ignore }), 'walking', 'climb');
    expect(raw).toBeCloseTo(scoreOf(userView({ exploreUrge: 1, behavior: ignore }), 'walking', 'climb') * 0.25, 9);
    expect(raw).toBeGreaterThan(0);
  });

  it('the way down and a walk along the strip it stands on are no trips up: not boosted, not even candidates', () => {
    const down = userView({ exploreUrge: 1, climbTarget: { point: { x: 290, y: 1195 }, dir: 'down' }, perchTarget: null, tabStripTarget: null });
    expect(scoreOf(down, 'walking', 'climb')).toBe(0);
    const onStrip = userView({ exploreUrge: 1, standingOn: 'tabStrip', perchTarget: null, climbTarget: null });
    expect(scoreOf(onStrip, 'walking', 'tabStrip')).toBe(0);
  });

  it('a climb up ends in a patrol along the top', () => {
    const c = scoreAll(userView({ exploreUrge: 1 })).find((x) => x.item.variant === 'climb');
    expect(c?.item.then).toBe('walking');
    expect(c?.item.thenVariant).toBe('patrol');
  });
});
