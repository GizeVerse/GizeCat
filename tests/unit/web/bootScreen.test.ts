// The first screen (src/web/bootScreen.ts): it ends when the cat starts, or turns into the failure
// message when the cat could not. The waiting and timed-failure parts are CSS (web.css), covered by
// the page and stylesheet checks in webPage.test.ts. MOCKED: the element is a fake.
import { describe, expect, it } from 'vitest';
import { settleBootScreen } from '../../../src/web/bootScreen';

function fakeScreen() {
  const added: string[] = [];
  let removed = 0;
  return {
    screen: {
      remove: () => {
        removed++;
      },
      classList: { add: (name: string) => void added.push(name) },
    },
    added,
    removed: () => removed,
  };
}

describe('the first screen', () => {
  it('is removed when the cat starts', () => {
    const f = fakeScreen();
    settleBootScreen(f.screen, true);
    expect(f.removed()).toBe(1);
    expect(f.added).toEqual([]);
  });

  it('shows the failure message when the cat could not start, and stays', () => {
    const f = fakeScreen();
    settleBootScreen(f.screen, false);
    expect(f.removed()).toBe(0);
    expect(f.added).toEqual(['failed']);
  });

  it('does nothing without the element', () => {
    expect(() => settleBootScreen(null, true)).not.toThrow();
    expect(() => settleBootScreen(null, false)).not.toThrow();
  });
});
