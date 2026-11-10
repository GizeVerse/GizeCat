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
    settleBootScreen(f.screen, 'started');
    expect(f.removed()).toBe(1);
    expect(f.added).toEqual([]);
  });

  it('shows the failure message when the cat could not be drawn, and stays', () => {
    const f = fakeScreen();
    settleBootScreen(f.screen, 'no-cat');
    expect(f.removed()).toBe(0);
    expect(f.added).toEqual(['failed']);
  });

  it('also marks a page that stopped, so its dead toolbar stays hidden', () => {
    const f = fakeScreen();
    settleBootScreen(f.screen, 'crashed');
    expect(f.removed()).toBe(0);
    expect(f.added).toEqual(['failed', 'crashed']);
  });

  it('does nothing without the element', () => {
    for (const outcome of ['started', 'no-cat', 'crashed'] as const) expect(() => settleBootScreen(null, outcome)).not.toThrow();
  });
});
