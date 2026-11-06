// Plain-language status for the web page's live region (src/web/status.ts).
import { describe, expect, it } from 'vitest';
import { BEHAVIOR_STATES } from '../../../src/shared/cat';
import { describeCat, isAsleep } from '../../../src/web/status';

describe('web status line', () => {
  it('has a sentence for every behaviour state', () => {
    for (const state of BEHAVIOR_STATES) {
      const text = describeCat({ name: 'Miso', state, paused: false });
      expect(text).toMatch(/^Miso \S.*\.$/);
      expect(text).not.toContain('is here');
    }
  });

  it('says paused while paused and falls back to a generic name', () => {
    expect(describeCat({ name: 'Miso', state: 'walking', paused: true })).toBe('Miso is paused.');
    expect(describeCat({ name: '  ', state: 'beingPetted', paused: false })).toBe('The cat is being petted.');
  });

  it('offers Wake while the cat sleeps or is falling asleep', () => {
    expect(isAsleep('sleeping')).toBe(true);
    expect(isAsleep('fallingAsleep')).toBe(true);
    expect(isAsleep('wakingUp')).toBe(false);
  });
});
