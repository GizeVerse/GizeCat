import { describe, expect, it } from 'vitest';
import { MAX_FAVORITE_SPOTS, MAX_RECENT_MEMORIES, MemorySchema } from '../../../../src/shared/catState';
import {
  addRateEvent,
  clearMemory,
  decayedScore,
  decayRate,
  ema01,
  learnSpot,
  rankedSpots,
  remember,
  SPOT_HALF_LIFE_MS,
} from '../../../../src/core/behavior/memory';

const T0 = 1_800_000_000_000;

describe('memory', () => {
  it('keeps the recent ring bounded, oldest dropped first', () => {
    const m = MemorySchema.parse({});
    for (let i = 0; i < MAX_RECENT_MEMORIES * 3; i++) remember(m, 'pet', T0 + i);
    expect(m.recent).toHaveLength(MAX_RECENT_MEMORIES);
    expect(m.recent[0]?.at).toBe(T0 + MAX_RECENT_MEMORIES * 2);
    expect(MemorySchema.safeParse(m).success).toBe(true);
  });

  it('learns favourite spots, merging nearby ones and weighting the position', () => {
    const m = MemorySchema.parse({});
    learnSpot(m, { displayKey: 'd1', xFrac: 0.3, kind: 'floor' }, 10, T0);
    learnSpot(m, { displayKey: 'd1', xFrac: 0.33, kind: 'floor' }, 10, T0);
    expect(m.favoriteSpots).toHaveLength(1);
    expect(m.favoriteSpots[0]?.xFrac).toBeCloseTo(0.315, 6);
    expect(m.favoriteSpots[0]?.score).toBeCloseTo(20, 6);
    learnSpot(m, { displayKey: 'd1', xFrac: 0.33, kind: 'window' }, 1, T0);
    learnSpot(m, { displayKey: 'd2', xFrac: 0.31, kind: 'floor' }, 1, T0);
    expect(m.favoriteSpots).toHaveLength(3);
  });

  it('is bounded and evicts the weakest spot', () => {
    const m = MemorySchema.parse({});
    for (let i = 0; i < MAX_FAVORITE_SPOTS; i++) learnSpot(m, { displayKey: 'd', xFrac: i / 10, kind: 'floor' }, i + 1, T0);
    expect(m.favoriteSpots).toHaveLength(MAX_FAVORITE_SPOTS);
    learnSpot(m, { displayKey: 'd', xFrac: 0.95, kind: 'floor' }, 0.5, T0);
    expect(m.favoriteSpots.some((s) => s.xFrac === 0.95)).toBe(false);
    learnSpot(m, { displayKey: 'd', xFrac: 0.95, kind: 'floor' }, 50, T0);
    expect(m.favoriteSpots).toHaveLength(MAX_FAVORITE_SPOTS);
    expect(m.favoriteSpots[0]?.xFrac).toBe(0.95);
    expect(m.favoriteSpots.some((s) => s.xFrac === 0)).toBe(false);
    expect(MemorySchema.safeParse(m).success).toBe(true);
  });

  it('decays spot scores with a half-life and ranks by current score', () => {
    const m = MemorySchema.parse({});
    learnSpot(m, { displayKey: 'd', xFrac: 0.2, kind: 'floor' }, 100, T0);
    learnSpot(m, { displayKey: 'd', xFrac: 0.8, kind: 'floor' }, 60, T0 + 2 * SPOT_HALF_LIFE_MS);
    const s = m.favoriteSpots.find((x) => x.xFrac === 0.2);
    expect(decayedScore(s!, T0 + SPOT_HALF_LIFE_MS)).toBeCloseTo(50, 6);
    expect(rankedSpots(m, T0 + 2 * SPOT_HALF_LIFE_MS)[0]?.xFrac).toBe(0.8);
  });

  it('ignores invalid spot input', () => {
    const m = MemorySchema.parse({});
    learnSpot(m, { displayKey: 'd', xFrac: Number.NaN, kind: 'floor' }, 5, T0);
    learnSpot(m, { displayKey: 'd', xFrac: 0.5, kind: 'floor' }, -1, T0);
    learnSpot(m, { displayKey: 'x'.repeat(200), xFrac: 2, kind: 'floor' }, 1, T0);
    expect(m.favoriteSpots).toHaveLength(1);
    expect(m.favoriteSpots[0]?.xFrac).toBe(1);
    expect(MemorySchema.safeParse(m).success).toBe(true);
  });

  it('EMAs stay bounded and converge', () => {
    let v = 0.5;
    for (let i = 0; i < 100; i++) v = ema01(v, 1, 0.25);
    expect(v).toBeGreaterThan(0.99);
    expect(ema01(0.5, 7, 1)).toBe(1);
    expect(ema01(0.5, -7, 1)).toBe(0);
    // Event-rate EMA converges to the true rate (6 events per hour).
    const tau = 2 * 3600_000;
    let rate = 0;
    for (let min = 0; min < 24 * 60; min++) {
      rate = decayRate(rate, 60_000, tau);
      if (min % 10 === 0) rate = addRateEvent(rate, tau);
    }
    expect(rate).toBeGreaterThan(5);
    expect(rate).toBeLessThan(7);
  });

  it('clears history', () => {
    const m = MemorySchema.parse({});
    remember(m, 'nap', T0);
    learnSpot(m, { displayKey: 'd', xFrac: 0.2, kind: 'floor' }, 3, T0);
    m.counters.pets = 9;
    m.preferences.attentionAcceptance = 0.9;
    m.totalAwakeMs = 1000;
    clearMemory(m, T0);
    expect(m).toEqual(MemorySchema.parse({ lastSeenAt: T0 }));
  });
});
