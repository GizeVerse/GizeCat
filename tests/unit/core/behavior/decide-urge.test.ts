// v1.1.1 exploration urge in the decision (RC7): with the user's profile (boredom ~0.02) trips up
// scored ~0.08 against ~0.25 for idle/wander and lost every top-4 softmax; at urge ~1 they now
// beat sitting, wandering and grooming for a calm cat, while sleep, fear, annoyance, low energy
// and switched-off behaviours still win; right after a trip they are rarer (rhythm), and up on
// a top it explored the cat is drawn back down the longer it stays.
import { describe, expect, it } from 'vitest';
import type { DecisionView } from '../../../../src/core/behavior/decide';
import { excursionBoost, scoreCandidates } from '../../../../src/core/behavior/decide';
import { decisionView, scoreOf, settingsWith } from './fixtures';
import { USER_STATS, USER_TRAITS } from './liveness';

const TOP = { windowId: 'w', point: { x: 800, y: 120 } };
const CLIMB = { point: { x: 310, y: 120 }, dir: 'up' as const };
const STRIP = { x: 700, y: 120 };

/** The user's cat on the floor at the default settings (autonomy 0.6), every way up within reach, nobody at the keyboard. */
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
    ...o,
  });
}

const EXCURSIONS: Array<[string, string]> = [
  ['inspectingWindow', 'explore'],
  ['walking', 'climb'],
  ['walking', 'tabStrip'],
];
const CALM_OPTIONS: Array<[string, string | null]> = [
  ['idle', null],
  ['walking', 'wander'],
  ['grooming', null],
  ['resting', null],
];

const best = (v: DecisionView, options: Array<[string, string | null]>): number => Math.max(...options.map(([s, vr]) => scoreOf(v, s as never, vr)));

describe('exploration urge in the decision (v1.1.1 RC7)', () => {
  it('at urge 0 the default cat with low boredom loses to sitting and wandering (the floor-only report)', () => {
    const v = userView({ exploreUrge: 0 });
    for (const [s, vr] of EXCURSIONS) expect(scoreOf(v, s as never, vr)).toBeLessThan(scoreOf(v, 'idle') * 0.5);
  });

  it('at urge ~1 each trip up beats idle, wander, grooming and resting at the default autonomy', () => {
    const v = userView({ exploreUrge: 1 });
    const calm = best(v, CALM_OPTIONS);
    for (const [s, vr] of EXCURSIONS) expect(scoreOf(v, s as never, vr), `${s}/${vr}`).toBeGreaterThan(calm * 1.5);
    // So the softmax over the best four picks a trip up nearly every time.
    const top = scoreCandidates(v)
      .sort((a, b) => b.score - a.score)
      .slice(0, 3)
      .map((c) => `${c.item.state}/${c.item.variant}`);
    expect(top.sort()).toEqual(['inspectingWindow/explore', 'walking/climb', 'walking/tabStrip']);
  });

  it('grows with the urge (cubically: a cat that just came down stays down a while) and with autonomy', () => {
    const at = (u: number, autonomy = 0.6): number => excursionBoost(userView({ exploreUrge: u, behavior: { ...settingsWith({}).behavior, autonomy } }));
    expect(at(0)).toBe(0);
    expect(at(0.5)).toBeCloseTo(at(1) / 8, 9);
    expect(at(1, 1)).toBeGreaterThan(at(1, 0.6));
    expect(at(1, 0.6)).toBeGreaterThan(at(1, 0));
    expect(at(1, 0)).toBeGreaterThan(0);
    // Nonsense in, nothing out.
    expect(at(Number.NaN)).toBe(0);
    expect(at(-1)).toBe(0);
    expect(at(7)).toBeCloseTo(at(1), 12);
  });

  it('right after a trip (urge 0) a trip up keeps only part of its own utility', () => {
    const fresh = userView({ exploreUrge: 0, stats: { ...userView().stats, boredom: 0.6 } });
    const later = userView({ exploreUrge: 1, stats: { ...userView().stats, boredom: 0.6 } });
    const own = (v: DecisionView): number => scoreOf(v, 'inspectingWindow', 'explore') - excursionBoost(v);
    expect(own(fresh)).toBeCloseTo(own(later) * 0.35, 9);
  });

  it('sleep still wins: a tired cat naps, and with nobody around only rest options exist', () => {
    const tired = userView({ exploreUrge: 1, stats: { ...userView().stats, energy: 0.2 }, awakeMs: 90 * 60_000 });
    const nap = scoreOf(tired, 'fallingAsleep');
    for (const [s, vr] of EXCURSIONS) expect(scoreOf(tired, s as never, vr)).toBeLessThan(nap);
    const idleUser = userView({ exploreUrge: 1, userIdleMs: 60 * 60_000 });
    for (const [s, vr] of EXCURSIONS) expect(scoreOf(idleUser, s as never, vr)).toBe(0);
  });

  it('fear and annoyance damp it; switched-off behaviours never get it', () => {
    const calm = excursionBoost(userView({ exploreUrge: 1 }));
    expect(excursionBoost(userView({ exploreUrge: 1, stats: { ...userView().stats, fear: 0.6 } }))).toBeCloseTo(0, 9);
    expect(excursionBoost(userView({ exploreUrge: 1, stats: { ...userView().stats, annoyance: 0.7 } }))).toBeCloseTo(0, 9);
    expect(excursionBoost(userView({ exploreUrge: 1, stats: { ...userView().stats, fear: 0.3 } }))).toBeLessThan(calm);
    const off = userView({ exploreUrge: 1, disabled: new Set(['perchOnWindows', 'climbWindows', 'tabStrips']) });
    for (const [s, vr] of EXCURSIONS) expect(scoreOf(off, s as never, vr)).toBe(0);
    const noClimb = userView({ exploreUrge: 1, disabled: new Set(['climbWindows']) });
    expect(scoreOf(noClimb, 'walking', 'climb')).toBe(0);
    expect(scoreOf(noClimb, 'inspectingWindow', 'explore')).toBeGreaterThan(0);
  });

  it('typing halves it and hard typing damps it further, but never to nothing', () => {
    const free = excursionBoost(userView({ exploreUrge: 1 }));
    const typing = excursionBoost(userView({ exploreUrge: 1, typing: true }));
    const hard = excursionBoost(userView({ exploreUrge: 1, typing: true, typingIntensity: 0.95 }));
    expect(typing).toBeCloseTo(free * 0.5, 9);
    expect(hard).toBeLessThan(typing);
    expect(hard).toBeGreaterThan(0);
    // 'React to typing' off: typing does not change it.
    const ignore = { ...settingsWith({}).behavior, reactToTyping: false };
    expect(excursionBoost(userView({ exploreUrge: 1, typing: true, typingIntensity: 0.95, behavior: ignore }))).toBeCloseTo(free, 9);
  });

  it('the climb down from a top and walks along a strip it stands on get no boost', () => {
    const down = userView({ exploreUrge: 1, climbTarget: { point: { x: 290, y: 1195 }, dir: 'down' }, perchTarget: null, tabStripTarget: null });
    expect(scoreOf(down, 'walking', 'climb')).toBeLessThan(0.2);
    const onStrip = userView({ exploreUrge: 1, standingOn: 'tabStrip', tabStripTarget: { x: 900, y: 120 }, perchTarget: null, climbTarget: null });
    expect(scoreOf(onStrip, 'walking', 'tabStrip')).toBeLessThan(0.2);
  });

  it('a climb up ends in a patrol along the top', () => {
    const c = scoreCandidates(userView({ exploreUrge: 1 })).find((x) => x.item.variant === 'climb');
    expect(c?.item.then).toBe('walking');
    expect(c?.item.thenVariant).toBe('patrol');
  });

  it('up on a top it explored, the pull back down grows with the time up there', () => {
    const floor = { x: 800, y: 1195 };
    const on = (elevatedMs: number): number => scoreOf(userView({ standingOn: 'windowTop', perchTarget: null, climbTarget: null, tabStripTarget: null, wanderTarget: null, downTarget: floor, elevatedMs }), 'walking', 'wander');
    expect(on(20_000)).toBeGreaterThan(0);
    expect(on(80_000)).toBeGreaterThan(on(20_000));
    expect(on(140_000)).toBeGreaterThan(on(80_000));
    expect(on(600_000)).toBeCloseTo(on(140_000), 9);
    // Still exploring it (no down target): no pull at all.
    expect(scoreOf(userView({ standingOn: 'windowTop', wanderTarget: null, downTarget: null, elevatedMs: 600_000 }), 'walking', 'wander')).toBe(0);
  });
});
