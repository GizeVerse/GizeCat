import { describe, expect, it } from 'vitest';
import type { BehaviorState } from '../../../../src/shared/cat';
import { DrivesSchema, StatsSchema, type Drives, type Stats } from '../../../../src/shared/catState';
import { MOODS, type Mood } from '../../../../src/shared/companion';
import { MOOD_HALF_LIFE_MS, MOOD_HYSTERESIS, MOOD_PUSH_FLOOR, MOOD_PUSH_MAX, moodFor, MoodTracker, sleepDepthFor, type MoodInput } from '../../../../src/core/behavior/mood';

const stats = (over: Partial<Stats> = {}): Stats => StatsSchema.parse(over);
const drives = (over: Partial<Drives> = {}): Drives => DrivesSchema.parse(over);

function input(over: Partial<MoodInput> & { state?: BehaviorState } = {}): MoodInput {
  return { stats: stats(), drives: drives(), state: 'idle', push: null, ...over };
}

describe('moodFor', () => {
  it('derives a mood from stats, drives and state', () => {
    expect(moodFor(input())).toBe('relaxed');
    expect(moodFor(input({ state: 'startled' }))).toBe('startled');
    expect(moodFor(input({ stats: stats({ fear: 0.9 }) }))).toBe('scared');
    expect(moodFor(input({ state: 'sleeping', drives: drives({ sleepiness: 0.8 }) }))).toBe('sleepy');
    expect(moodFor(input({ state: 'playing' }))).toBe('excited');
    expect(moodFor(input({ state: 'curious' }))).toBe('curious');
    expect(moodFor(input({ state: 'beingPetted', stats: stats({ bond: 0.8 }) }))).toBe('happy');
    expect(moodFor(input({ drives: drives({ frustration: 0.9 }) }))).toBe('confused');
  });

  it('is total: every mood is one of the eight, whatever the state', () => {
    for (const state of ['idle', 'sleeping', 'held', 'falling', 'away', 'hiding', 'annoyed', 'landing'] as const) {
      expect(MOODS).toContain(moodFor(input({ state })));
    }
  });

  it('a live push tips a close call, but a weak push never beats a clear state', () => {
    expect(moodFor(input({ push: { mood: 'curious', strength: 0.7 } }))).toBe('curious');
    expect(moodFor(input({ state: 'sleeping', drives: drives({ sleepiness: 0.9 }), push: { mood: 'excited', strength: 0.1 } }))).toBe('sleepy');
    // An unknown mood in a push is ignored.
    expect(moodFor(input({ push: { mood: 'furious' as Mood, strength: 1 } }))).toBe('relaxed');
  });

  it('has hysteresis: a challenger must clearly beat the mood shown a moment ago', () => {
    // Two near-equal moods: the previous one stays whichever it was, so the answer does not flicker.
    const base = input({ push: { mood: 'curious', strength: 0.45 } });
    const a = moodFor({ ...base, previous: 'relaxed' });
    const b = moodFor({ ...base, previous: 'curious' });
    expect(a).toBe('relaxed');
    expect(b).toBe('curious');
    // A strong change still wins over the head start.
    expect(moodFor(input({ state: 'startled', previous: 'relaxed' }))).toBe('startled');
    expect(MOOD_HYSTERESIS).toBeGreaterThan(0);
  });

  it('does not flicker: a value wobbling around a boundary changes the mood far less often than the raw argmax', () => {
    let previous: Mood | undefined;
    let changes = 0;
    let rawChanges = 0;
    let rawPrevious: Mood | undefined;
    for (let i = 0; i < 200; i++) {
      // Curiosity pushed up and down around the point where curious and relaxed tie.
      const strength = 0.5 + 0.08 * Math.sin(i);
      const raw = moodFor(input({ push: { mood: 'curious', strength } }));
      const m = moodFor(input({ push: { mood: 'curious', strength }, previous }));
      if (previous !== undefined && m !== previous) changes++;
      if (rawPrevious !== undefined && raw !== rawPrevious) rawChanges++;
      previous = m;
      rawPrevious = raw;
    }
    expect(rawChanges).toBeGreaterThan(10);
    expect(changes).toBeLessThan(5);
  });
});

describe('MoodTracker', () => {
  it('decays a push by its half-life: startled fast, curious slower', () => {
    const t = new MoodTracker();
    t.push('startled', 1, 0);
    t.push('curious', 1, 0);
    const s0 = t.strengthOf('startled', 0);
    const c0 = t.strengthOf('curious', 0);
    expect(s0).toBeGreaterThan(0);
    expect(t.strengthOf('startled', MOOD_HALF_LIFE_MS.startled)).toBeCloseTo(s0 / 2, 5);
    expect(t.strengthOf('curious', MOOD_HALF_LIFE_MS.startled)).toBeGreaterThan(c0 * 0.85);
    expect(MOOD_HALF_LIFE_MS.startled).toBeLessThan(MOOD_HALF_LIFE_MS.curious);
    expect(MOOD_HALF_LIFE_MS.scared).toBeLessThan(MOOD_HALF_LIFE_MS.happy);
  });

  it('is never dramatic from one event, and capped however many pile up', () => {
    const t = new MoodTracker();
    t.push('scared', 1, 0);
    expect(t.strengthOf('scared', 0)).toBeLessThan(0.7);
    for (let i = 0; i < 50; i++) t.push('scared', 1, 0);
    expect(t.strengthOf('scared', 0)).toBeLessThanOrEqual(MOOD_PUSH_MAX);
  });

  it('reports the strongest live push and forgets it once it has faded', () => {
    const t = new MoodTracker();
    expect(t.strongest(0)).toBeNull();
    t.push('happy', 0.3, 1000);
    t.push('startled', 1, 1000);
    expect(t.strongest(1000)?.mood).toBe('startled');
    // Long after, everything is gone.
    expect(t.strongest(1000 + 10 * 60_000)).toBeNull();
    expect(t.strengthOf('startled', 1000 + 10 * 60_000)).toBe(0);
    expect(MOOD_PUSH_FLOOR).toBeGreaterThan(0);
  });

  it('ignores junk pushes and survives a clock that jumps back or turns non-finite', () => {
    const t = new MoodTracker();
    t.push('furious' as Mood, 1, 0);
    t.push('happy', Number.NaN, 0);
    t.push('happy', -1, 0);
    t.push('happy', 0, 0);
    expect(t.strongest(0)).toBeNull();
    t.push('excited', 1, 5000);
    const before = t.strengthOf('excited', 5000);
    // Back in time: no decay, no growth.
    expect(t.strengthOf('excited', 1000)).toBeCloseTo(before, 10);
    expect(Number.isFinite(t.strengthOf('excited', Number.NaN))).toBe(true);
  });

  it('clear forgets everything', () => {
    const t = new MoodTracker();
    t.push('scared', 1, 0);
    t.clear();
    expect(t.strongest(0)).toBeNull();
  });
});

describe('sleepDepthFor', () => {
  it('is 0 while awake and grows with the time asleep', () => {
    const at = (asleepMs: number): number => sleepDepthFor({ asleepMs, sleepiness: 0.6, energy: 0.4 });
    expect(at(0)).toBe(0);
    expect(at(-5)).toBe(0);
    expect(at(30_000)).toBeLessThan(at(3 * 60_000));
    expect(at(3 * 60_000)).toBeLessThan(at(20 * 60_000));
    expect(at(20 * 60_000)).toBeLessThanOrEqual(1);
  });

  it('is deeper for a sleepy, tired cat and always within 0..1', () => {
    const ms = 5 * 60_000;
    expect(sleepDepthFor({ asleepMs: ms, sleepiness: 0.9, energy: 0.1 })).toBeGreaterThan(sleepDepthFor({ asleepMs: ms, sleepiness: 0.1, energy: 0.9 }));
    for (const v of [sleepDepthFor({ asleepMs: Number.NaN, sleepiness: 2, energy: -1 }), sleepDepthFor({ asleepMs: 1e12, sleepiness: 1, energy: 0 }), sleepDepthFor({ asleepMs: 1000, sleepiness: Number.NaN, energy: Number.NaN })]) {
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThanOrEqual(1);
    }
  });
});
