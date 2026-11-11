// The two personality flags reach the event engine through the temperament: shy sets watchFirst, lazy
// sets ignoreMinor, nothing else does ('auto' included). Written without being run.
import { describe, expect, it } from 'vitest';
import { DrivesSchema, StatsSchema, TraitsSchema } from '../../../../src/shared/catState';
import { PERSONALITY_IDS, type PersonalityChoice } from '../../../../src/shared/companion';
import { temperamentFor } from '../../../../src/core/behavior/personalityProfiles';

const temperament = (choice: PersonalityChoice): ReturnType<typeof temperamentFor> =>
  temperamentFor({ choice, traits: TraitsSchema.parse({}), stats: StatsSchema.parse({}), drives: DrivesSchema.parse({}), mood: 'relaxed', asleep: false, localHour: 14 });

describe('temperamentFor: the engine flags', () => {
  it('is false for auto', () => {
    const t = temperament('auto');
    expect(t.watchFirst).toBe(false);
    expect(t.ignoreMinor).toBe(false);
  });

  it('sets watchFirst for shy only and ignoreMinor for lazy only', () => {
    expect(PERSONALITY_IDS.filter((id) => temperament(id).watchFirst)).toEqual(['shy']);
    expect(PERSONALITY_IDS.filter((id) => temperament(id).ignoreMinor)).toEqual(['lazy']);
  });
});
