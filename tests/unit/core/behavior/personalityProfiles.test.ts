import { describe, expect, it } from 'vitest';
import type { Counters, Drives, Stats, Traits } from '../../../../src/shared/catState';
import { CountersSchema, DrivesSchema, StatsSchema, TraitsSchema } from '../../../../src/shared/catState';
import { MOODS, PERSONALITY_IDS, type PersonalityId } from '../../../../src/shared/companion';
import { mulberry32, randomTraits, TRAIT_MAX, TRAIT_MIN } from '../../../../src/core/behavior';
import {
  adaptTraits,
  effectiveTraits,
  knobsFor,
  MAX_TRAIT_DRIFT,
  nearestPersonality,
  NEUTRAL_KNOBS,
  PERSONALITY_PROFILES,
  profileTraits,
  temperamentFor,
  type TemperamentInput,
} from '../../../../src/core/behavior/personalityProfiles';

const TRAIT_KEYS = Object.keys(TraitsSchema.shape) as Array<keyof Traits>;
const dist = (a: Traits, b: Traits): number => Math.sqrt(TRAIT_KEYS.reduce((s, k) => s + (a[k] - b[k]) ** 2, 0));

const stats = (over: Partial<Stats> = {}): Stats => StatsSchema.parse(over);
const drives = (over: Partial<Drives> = {}): Drives => DrivesSchema.parse(over);
const counters = (over: Partial<Counters> = {}): Counters => CountersSchema.parse(over);

function input(over: Partial<TemperamentInput> = {}): TemperamentInput {
  return { choice: 'auto', traits: TraitsSchema.parse({}), stats: stats(), drives: drives(), mood: 'relaxed', asleep: false, localHour: 14, ...over };
}

describe('the seven profiles', () => {
  it('is one profile per personality id, in the contract order', () => {
    expect(Object.keys(PERSONALITY_PROFILES)).toEqual([...PERSONALITY_IDS]);
  });

  it('keeps every target trait inside the generator band and every knob in range', () => {
    for (const id of PERSONALITY_IDS) {
      const p = PERSONALITY_PROFILES[id];
      for (const k of TRAIT_KEYS) {
        expect(p.traits[k], `${id}.${k}`).toBeGreaterThanOrEqual(TRAIT_MIN);
        expect(p.traits[k], `${id}.${k}`).toBeLessThanOrEqual(TRAIT_MAX);
      }
      for (const k of ['restBias', 'eventInterest', 'approachBoldness', 'calmness', 'mischief', 'playAppetite'] as const) {
        expect(p[k], `${id}.${k}`).toBeGreaterThanOrEqual(0);
        expect(p[k], `${id}.${k}`).toBeLessThanOrEqual(1);
      }
      expect(p.chaseDuration).toBeGreaterThanOrEqual(0.5);
      expect(p.chaseDuration).toBeLessThanOrEqual(1.6);
      expect(p.startleScale).toBeGreaterThanOrEqual(0.5);
      expect(p.startleScale).toBeLessThanOrEqual(1.5);
    }
  });

  it('differ measurably: every pair of profiles is far apart in trait space', () => {
    for (const a of PERSONALITY_IDS) {
      for (const b of PERSONALITY_IDS) {
        if (a < b) expect(dist(PERSONALITY_PROFILES[a].traits, PERSONALITY_PROFILES[b].traits), `${a} vs ${b}`).toBeGreaterThan(0.3);
      }
    }
  });

  it('honours the described character of each personality', () => {
    const P = PERSONALITY_PROFILES;
    const others = (id: PersonalityId): PersonalityId[] => PERSONALITY_IDS.filter((x) => x !== id);
    // Curious investigates new events readily; shy keeps its distance.
    for (const o of others('curious')) expect(P.curious.eventInterest).toBeGreaterThanOrEqual(P[o].eventInterest);
    expect(P.curious.traits.curiosity).toBe(Math.max(...PERSONALITY_IDS.map((i) => P[i].traits.curiosity)));
    expect(P.shy.watchFromDistance).toBe(true);
    expect(PERSONALITY_IDS.filter((i) => P[i].watchFromDistance)).toEqual(['shy']);
    for (const o of others('shy')) expect(P.shy.approachBoldness).toBeLessThan(P[o].approachBoldness);
    // Playful spends longest with toys; energetic moves most and chases longest.
    for (const o of others('playful')) expect(P.playful.playAppetite).toBeGreaterThan(P[o].playAppetite);
    for (const o of others('energetic')) {
      expect(P.energetic.chaseDuration).toBeGreaterThan(P[o].chaseDuration);
      expect(P.energetic.restBias).toBeLessThan(P[o].restBias);
    }
    // Lazy rests most and ignores minor events.
    for (const o of others('lazy')) expect(P.lazy.restBias).toBeGreaterThan(P[o].restBias);
    expect(PERSONALITY_IDS.filter((i) => P[i].ignoreMinorEvents)).toEqual(['lazy']);
    // Mischievous has the most unusual reactions; calm the fewest sudden movements.
    for (const o of others('mischievous')) expect(P.mischievous.mischief).toBeGreaterThan(P[o].mischief);
    for (const o of others('calm')) {
      expect(P.calm.calmness).toBeGreaterThan(P[o].calmness);
      expect(P.calm.startleScale).toBeLessThanOrEqual(P[o].startleScale);
    }
  });

  it('profileTraits returns a copy of the target traits', () => {
    const t = profileTraits('shy');
    expect(t).toEqual(PERSONALITY_PROFILES.shy.traits);
    t.curiosity = 0;
    expect(PERSONALITY_PROFILES.shy.traits.curiosity).toBe(0.5);
  });
});

describe('nearestPersonality', () => {
  it('round-trips profileTraits', () => {
    for (const id of PERSONALITY_IDS) expect(nearestPersonality(profileTraits(id)), id).toBe(id);
  });

  it('is total: non-finite traits count as the middle and the answer is always a profile', () => {
    const odd = { ...TraitsSchema.parse({}), curiosity: Number.NaN, confidence: Number.POSITIVE_INFINITY };
    expect(PERSONALITY_IDS).toContain(nearestPersonality(odd));
    for (let seed = 1; seed <= 50; seed++) expect(PERSONALITY_IDS).toContain(nearestPersonality(randomTraits(mulberry32(seed))));
  });
});

describe('adaptTraits', () => {
  const busy = counters({ pets: 5000, attentionAnswered: 3000, throws: 900, hardLandings: 900, chasesEngaged: 4000, pounces: 3000, chasesIgnored: 2000, hunts: 3000, windowsInspected: 4000, excursions: 4000, naps: 5000 });

  it('with no experience gives exactly the profile targets', () => {
    for (const id of PERSONALITY_IDS) expect(adaptTraits(id, counters()), id).toEqual(profileTraits(id));
  });

  it('drifts by at most 0.08 per trait, stays in the band, and never changes the profile, however much experience', () => {
    for (const id of PERSONALITY_IDS) {
      for (const c of [counters({ pets: 50 }), busy, counters({ throws: 1e9, naps: 1e9, pets: 1e9 })]) {
        const out = adaptTraits(id, c);
        for (const k of TRAIT_KEYS) {
          expect(Math.abs(out[k] - PERSONALITY_PROFILES[id].traits[k]), `${id}.${k}`).toBeLessThanOrEqual(MAX_TRAIT_DRIFT + 1e-12);
          expect(out[k]).toBeGreaterThanOrEqual(TRAIT_MIN);
          expect(out[k]).toBeLessThanOrEqual(TRAIT_MAX);
        }
        expect(nearestPersonality(out), id).toBe(id);
      }
    }
  });

  it('moves in the obvious directions: petting raises affection, being thrown raises startle and lowers confidence', () => {
    const petted = adaptTraits('calm', counters({ pets: 2000 }));
    expect(petted.affection).toBeGreaterThan(PERSONALITY_PROFILES.calm.traits.affection);
    const thrown = adaptTraits('playful', counters({ throws: 400 }));
    expect(thrown.startleSensitivity).toBeGreaterThan(PERSONALITY_PROFILES.playful.traits.startleSensitivity);
    expect(thrown.confidence).toBeLessThan(PERSONALITY_PROFILES.playful.traits.confidence);
  });

  it('is pure and tolerates odd counters', () => {
    expect(adaptTraits('lazy', busy)).toEqual(adaptTraits('lazy', busy));
    const odd = { ...counters(), pets: Number.NaN, throws: -5 };
    expect(adaptTraits('lazy', odd)).toEqual(profileTraits('lazy'));
  });

  it('effectiveTraits keeps the born traits for auto and adapts a named choice', () => {
    const born = randomTraits(mulberry32(9));
    expect(effectiveTraits('auto', born, busy)).toEqual(born);
    expect(effectiveTraits('shy', born, busy)).toEqual(adaptTraits('shy', busy));
  });
});

describe('temperamentFor', () => {
  it('auto is neutral: the knobs are the neutral ones and nothing moves away from the cat\'s own traits', () => {
    expect(knobsFor('auto')).toBe(NEUTRAL_KNOBS);
    const t = temperamentFor(input());
    for (const [key, v] of Object.entries(t)) {
      expect(Number.isFinite(v), key).toBe(true);
      expect(v, key).toBeGreaterThanOrEqual(key === 'persistence' ? 0.5 : 0);
      expect(v, key).toBeLessThanOrEqual(key === 'persistence' ? 1.6 : 1);
    }
    // An 'auto' cat and a hypothetical profile with neutral knobs agree (nothing is added on top of the traits).
    expect(temperamentFor(input({ choice: 'auto' }))).toEqual(temperamentFor(input({ choice: 'auto', mood: 'relaxed' })));
  });

  it('is monotonic in the obvious inputs for auto', () => {
    const traits = TraitsSchema.parse({});
    const interest = (curiosity: number): number => temperamentFor(input({ traits: { ...traits, curiosity } })).interest;
    expect(interest(0.2)).toBeLessThan(interest(0.5));
    expect(interest(0.5)).toBeLessThan(interest(0.9));
    const startle = (fear: number): number => temperamentFor(input({ stats: stats({ fear }) })).startle;
    expect(startle(0)).toBeLessThan(startle(0.5));
    expect(startle(0.5)).toBeLessThan(startle(1));
    const alert = (sleepiness: number): number => temperamentFor(input({ drives: drives({ sleepiness }) })).alertness;
    expect(alert(0)).toBeGreaterThan(alert(0.5));
    expect(alert(0.5)).toBeGreaterThan(alert(1));
    expect(temperamentFor(input({ asleep: true })).alertness).toBeLessThan(temperamentFor(input({ asleep: false })).alertness);
    const energy = (e: number): number => temperamentFor(input({ stats: stats({ energy: e }) })).energy;
    expect(energy(0.1)).toBeLessThan(energy(0.9));
    const bold = (confidence: number): number => temperamentFor(input({ traits: { ...traits, confidence } })).boldness;
    expect(bold(0.2)).toBeLessThan(bold(0.8));
    const play = (playNeed: number): number => temperamentFor(input({ drives: drives({ playNeed }) })).playfulness;
    expect(play(0.1)).toBeLessThan(play(0.9));
    const persistence = (playfulness: number): number => temperamentFor(input({ traits: { ...traits, playfulness } })).persistence;
    expect(persistence(0.2)).toBeLessThan(persistence(0.9));
    const nightAlert = temperamentFor(input({ localHour: 3 })).alertness;
    expect(nightAlert).toBeLessThan(temperamentFor(input({ localHour: 14 })).alertness);
  });

  it('a named choice moves the temperament the way its description says, on the same cat', () => {
    const t = (choice: PersonalityId): ReturnType<typeof temperamentFor> => temperamentFor(input({ choice, traits: profileTraits(choice) }));
    for (const o of PERSONALITY_IDS.filter((x) => x !== 'curious')) expect(t('curious').interest).toBeGreaterThanOrEqual(t(o).interest);
    expect(t('lazy').interest).toBeLessThan(t('curious').interest);
    expect(t('shy').boldness).toBeLessThan(t('mischievous').boldness);
    expect(t('energetic').persistence).toBeGreaterThan(t('lazy').persistence);
    expect(t('energetic').energy).toBeGreaterThan(t('lazy').energy);
    expect(t('playful').playfulness).toBeGreaterThan(t('calm').playfulness);
    expect(t('calm').calm).toBeGreaterThan(t('energetic').calm);
    expect(t('calm').startle).toBeLessThan(t('shy').startle);
    expect(t('mischievous').mischief).toBeGreaterThan(t('calm').mischief);
  });

  it('a mood colours the reaction a little: scared startles more and dares less, sleepy notices less', () => {
    const calm = temperamentFor(input());
    const scared = temperamentFor(input({ mood: 'scared' }));
    expect(scared.startle).toBeGreaterThan(calm.startle);
    expect(scared.boldness).toBeLessThan(calm.boldness);
    expect(temperamentFor(input({ mood: 'sleepy' })).alertness).toBeLessThan(calm.alertness);
    for (const mood of MOODS) {
      const t = temperamentFor(input({ mood }));
      for (const [k, v] of Object.entries(t)) expect(Number.isFinite(v), `${mood}.${k}`).toBe(true);
    }
  });

  it('stays total on odd input (non-finite hour, extreme stats)', () => {
    const t = temperamentFor(input({ localHour: Number.NaN, stats: stats({ energy: 0, fear: 1 }), drives: drives({ sleepiness: 1, wariness: 1 }) }));
    for (const v of Object.values(t)) expect(Number.isFinite(v)).toBe(true);
  });
});
