// Plain-language descriptions of the seven selectable personalities for the settings UIs. Data only
// (no DOM, no node, no zod), so the sandboxed settings renderer can bundle it without pulling the
// behaviour tables of src/core in. The numbers behind each line live in PERSONALITY_PROFILES
// (src/core/behavior/personalityProfiles.ts); a unit test checks that every line here still agrees with
// them, so retuning a profile without updating its words fails a test instead of misleading the user.
import type { PersonalityId } from './companion';

export interface PersonalityText {
  /** Display name. */
  name: string;
  /** One plain sentence: what this cat is like. */
  summary: string;
  /** Short "how it behaves" lines, each one a visible consequence of the profile's knobs. */
  behaves: readonly string[];
}

export const PERSONALITY_TEXT: Readonly<Record<PersonalityId, PersonalityText>> = {
  curious: {
    name: 'Curious',
    summary: 'Wants to know what everything is, and goes to look.',
    behaves: ['Notices world events quickly and walks over to look at them.', 'Goes close to anything new.', 'Explores more than it rests.'],
  },
  playful: {
    name: 'Playful',
    summary: 'Turns almost anything into a game.',
    behaves: ['Stays with toys and games the longest.', 'Chases for a little longer than most.', 'Rests less than an average cat.'],
  },
  energetic: {
    name: 'Energetic',
    summary: 'Always on the move.',
    behaves: ['Moves around a lot and rests very little.', 'Chases for the longest of all.', 'Bold with new things.'],
  },
  lazy: {
    name: 'Lazy',
    summary: 'Happiest curled up somewhere comfortable.',
    behaves: ['Rests most of the time.', 'Lets small things, such as a falling leaf, go by.', 'Keeps chases short and plays little.'],
  },
  shy: {
    name: 'Shy',
    summary: 'Careful with anything new.',
    behaves: ['Watches new things from a distance first.', 'Startles easily.', 'Comes closer slowly, if at all.'],
  },
  mischievous: {
    name: 'Mischievous',
    summary: 'Always up to something a little cheeky.',
    behaves: ['Tries unusual, cheeky reactions.', 'Bold: walks straight up to new things.', 'Hard to startle.'],
  },
  calm: {
    name: 'Calm',
    summary: 'Relaxed and composed, whatever happens.',
    behaves: ['Makes few sudden movements.', 'Very hard to startle.', 'Reacts to surprises with a quiet look.'],
  },
};
