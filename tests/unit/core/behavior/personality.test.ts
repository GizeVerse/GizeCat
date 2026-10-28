import { describe, expect, it } from 'vitest';
import type { BehaviorState } from '../../../../src/shared/cat';
import { BEHAVIOR_STATES } from '../../../../src/shared/cat';
import type { Stats, Traits } from '../../../../src/shared/catState';
import { PersistedCatSchema } from '../../../../src/shared/catState';
import { mulberry32, newPersistedCat, randomTraits, TRAIT_MAX, TRAIT_MIN } from '../../../../src/core/behavior';
import { applyPet, stepStats } from '../../../../src/core/behavior/stats';

const TRAIT_KEYS = ['curiosity', 'playfulness', 'affection', 'confidence', 'energyLevel', 'laziness'] as const;

describe('newPersistedCat', () => {
  it('creates a valid, seeded cat', () => {
    const a = newPersistedCat(mulberry32(42), 1_800_000_000_000);
    const b = newPersistedCat(mulberry32(42), 1_800_000_000_000);
    const c = newPersistedCat(mulberry32(43), 1_800_000_000_000);
    expect(PersistedCatSchema.safeParse(a).success).toBe(true);
    expect(a).toEqual(b);
    expect(a.catId).not.toBe(c.catId);
    expect(a.traits).not.toEqual(c.traits);
    expect(a.bornAt).toBe(1_800_000_000_000);
    expect(a.lastPosition).toBeNull();
    expect(a.catId).toMatch(/^cat-[0-9a-f]{16}$/);
  });

  it('keeps traits within believable bounds with real variety', () => {
    const sums: Record<string, number> = {};
    const mins: Record<string, number> = {};
    const maxs: Record<string, number> = {};
    const n = 2000;
    for (let i = 0; i < n; i++) {
      const t = randomTraits(mulberry32(i + 1));
      for (const k of TRAIT_KEYS) {
        expect(t[k]).toBeGreaterThanOrEqual(TRAIT_MIN);
        expect(t[k]).toBeLessThanOrEqual(TRAIT_MAX);
        sums[k] = (sums[k] ?? 0) + t[k];
        mins[k] = Math.min(mins[k] ?? 1, t[k]);
        maxs[k] = Math.max(maxs[k] ?? 0, t[k]);
      }
    }
    for (const k of TRAIT_KEYS) {
      const mean = (sums[k] as number) / n;
      expect(mean).toBeGreaterThan(0.35);
      expect(mean).toBeLessThan(0.7);
      expect((maxs[k] as number) - (mins[k] as number)).toBeGreaterThan(0.4);
    }
  });

  it('survives a broken random source', () => {
    for (const r of [() => Number.NaN, () => 5, () => -1]) {
      const cat = newPersistedCat(r, 1);
      expect(PersistedCatSchema.safeParse(cat).success).toBe(true);
    }
  });
});

describe('stats dynamics', () => {
  const traits: Traits = { curiosity: 0.5, playfulness: 0.5, affection: 0.5, confidence: 0.5, energyLevel: 0.5, laziness: 0.5 };
  const fresh = (): Stats => ({ energy: 0.8, boredom: 0.3, bond: 0.3, annoyance: 0, fear: 0 });

  it('stays within [0, 1] under any state sequence', () => {
    const r = mulberry32(9);
    const s = fresh();
    for (let i = 0; i < 100_000; i++) {
      const state = BEHAVIOR_STATES[Math.floor(r() * BEHAVIOR_STATES.length)] as BehaviorState;
      stepStats(s, { state, traits, patience: r() }, r() * 2000);
      if (r() < 0.01) applyPet(s, traits, r() * 3 - 1);
      for (const v of Object.values(s)) {
        expect(v).toBeGreaterThanOrEqual(0);
        expect(v).toBeLessThanOrEqual(1);
      }
    }
  });

  it('recovers energy while sleeping and drains it while playing, over minutes not seconds', () => {
    const s = { ...fresh(), energy: 0.3 };
    for (let i = 0; i < 10 * 60; i++) stepStats(s, { state: 'sleeping', traits, patience: 0.5 }, 1000);
    expect(s.energy).toBeGreaterThan(0.6);
    expect(s.energy).toBeLessThan(1);
    const p = fresh();
    for (let i = 0; i < 60; i++) stepStats(p, { state: 'playing', traits, patience: 0.5 }, 1000);
    expect(p.energy).toBeLessThan(0.8);
    expect(p.energy).toBeGreaterThan(0.7);
  });

  it('decays annoyance over minutes and fear over seconds', () => {
    const s = { ...fresh(), annoyance: 1, fear: 1 };
    for (let i = 0; i < 10; i++) stepStats(s, { state: 'idle', traits, patience: 0.5 }, 1000);
    expect(s.fear).toBeLessThan(0.2);
    expect(s.annoyance).toBeGreaterThan(0.9);
    for (let i = 0; i < 300; i++) stepStats(s, { state: 'idle', traits, patience: 0.5 }, 1000);
    expect(s.annoyance).toBeLessThan(0.3);
  });

  it('grows bond with petting (diminishing) and decays it very slowly', () => {
    const s = fresh();
    applyPet(s, traits, 1);
    const gain1 = s.bond - 0.3;
    expect(gain1).toBeGreaterThan(0);
    s.bond = 0.95;
    applyPet(s, traits, 1);
    expect(s.bond - 0.95).toBeLessThan(gain1);
    const d = { ...fresh(), bond: 0.5 };
    for (let i = 0; i < 24 * 3600; i++) stepStats(d, { state: 'idle', traits, patience: 0.5 }, 1000);
    expect(d.bond).toBeLessThan(0.5);
    expect(d.bond).toBeGreaterThan(0.45);
  });
});
