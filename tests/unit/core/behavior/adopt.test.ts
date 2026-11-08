// 1.4.0 profile import: CatSimImpl.adoptCat and adoptCatInto (src/core/behavior). The host computes
// the next cat with applyProfile (src/shared/profileTransfer.ts); the sim validates it, clamps the
// traits to the generator band, keeps this device's lastPosition and starts the session's habits
// over for another cat. SIMULATED: a seeded sim on the fixture world. Written in the 1.4.0 mission,
// NOT executed there.
import { describe, expect, it } from 'vitest';
import type { PersistedCat } from '../../../../src/shared/catState';
import type { CatSim } from '../../../../src/shared/sim';
import { adoptCatInto, mulberry32, newPersistedCat, TRAIT_MAX, TRAIT_MIN } from '../../../../src/core/behavior';
import { applyProfile, buildProfile } from '../../../../src/shared/profileTransfer';
import { defaultSettings } from '../../../../src/shared/settings';
import { Harness } from './fixtures';

const WALL = 1_800_000_000_000;

function localCat(): PersistedCat {
  const cat = newPersistedCat(mulberry32(5), WALL - 86_400_000);
  cat.lastPosition = { displayKey: '1', xFrac: 0.25, support: 'floor' };
  cat.memory.counters.pets = 40;
  return cat;
}

function otherCat(): PersistedCat {
  const cat = newPersistedCat(mulberry32(99), WALL - 30 * 86_400_000);
  cat.memory.counters.pets = 7;
  return cat;
}

describe('CatSimImpl.adoptCat', () => {
  it('takes another cat: identity and traits from the file, its own lastPosition kept, saved soon', () => {
    const h = new Harness({ seed: 3, persisted: localCat() });
    h.run(2000);
    const before = h.sim.serialize();
    const next = { ...otherCat(), lastPosition: { displayKey: 'elsewhere', xFrac: 0.9, support: 'floor' as const } };
    h.sim.adoptCat(next);
    const after = h.sim.serialize();
    expect(after.catId).toBe(next.catId);
    expect(after.bornAt).toBe(next.bornAt);
    expect(after.traits).toEqual(next.traits);
    expect(after.memory.counters.pets).toBe(7);
    // lastPosition is this device's (serialize recomputes it from the live position, never the file's).
    expect(after.lastPosition?.displayKey).not.toBe('elsewhere');
    expect(before.catId).not.toBe(after.catId);
    // markDirty(true): the next tick asks the host to save.
    const out = h.step();
    expect(out.requests.some((r) => r.type === 'save')).toBe(true);
  });

  it('clamps traits to the generator band (a hand-edited file may carry 0 or 1)', () => {
    const h = new Harness({ seed: 4, persisted: localCat() });
    h.run(500);
    const next = otherCat();
    next.traits.curiosity = 1;
    next.traits.laziness = 0;
    h.sim.adoptCat(next);
    const t = h.sim.serialize().traits;
    expect(t.curiosity).toBe(TRAIT_MAX);
    expect(t.laziness).toBe(TRAIT_MIN);
  });

  it('the same cat keeps its identity; a refused (invalid) cat changes nothing and throws', () => {
    const h = new Harness({ seed: 5, persisted: localCat() });
    h.run(500);
    const same = h.sim.serialize();
    same.traits.playfulness = 0.8;
    h.sim.adoptCat(same);
    expect(h.sim.serialize().traits.playfulness).toBeCloseTo(0.8, 10);
    const id = h.sim.serialize().catId;
    const broken = { ...h.sim.serialize(), catId: '' } as PersistedCat;
    expect(() => h.sim.adoptCat(broken)).toThrow();
    expect(h.sim.serialize().catId).toBe(id);
  });

  it('runs on after an adoption (no throw over a few simulated minutes)', () => {
    const h = new Harness({ seed: 6, persisted: localCat() });
    h.run(1000);
    h.sim.adoptCat(otherCat());
    expect(() => h.run(3 * 60_000, 100)).not.toThrow();
  });
});

describe('adoptCatInto', () => {
  it('hands the cat to this core’s simulation, and refuses another CatSim (a fake) without touching it', () => {
    const h = new Harness({ seed: 7, persisted: localCat() });
    const next = otherCat();
    expect(adoptCatInto(h.sim, next)).toBe(true);
    expect(h.sim.serialize().catId).toBe(next.catId);
    const fake = { serialize: () => localCat() } as unknown as CatSim;
    expect(adoptCatInto(fake, next)).toBe(false);
  });

  it('end to end with applyProfile: a profile of another cat replaces this one, memory cleared, sessions 1', () => {
    const h = new Harness({ seed: 8, persisted: localCat() });
    h.run(500);
    const theirs = otherCat();
    const profile = buildProfile(defaultSettings(), theirs, { includeMemory: false, app: { version: '1.4.0', host: 'darwin' }, now: WALL });
    const r = applyProfile(profile, { cat: true, appearance: false, preferences: false, memory: false }, defaultSettings(), h.sim.serialize(), { now: WALL });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.catReplaced).toBe(true);
    expect(adoptCatInto(h.sim, r.catState)).toBe(true);
    const after = h.sim.serialize();
    expect(after.catId).toBe(theirs.catId);
    expect(after.memory.counters.pets).toBe(0);
    expect(after.memory.counters.sessions).toBe(1);
  });
});
