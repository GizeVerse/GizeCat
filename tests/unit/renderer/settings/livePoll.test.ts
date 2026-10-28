import { describe, expect, it } from 'vitest';
import { LIVE_REFRESH_MS, livePoll, pagePoll } from '../../../../src/renderer/settings/livePoll';
import type { Timers } from '../../../../src/renderer/settings/store';

/** Manual clock: advance() runs due timeouts in order. */
function fakeTimers(): Timers & { advance(ms: number): void; pending(): number } {
  let now = 0;
  let next = 1;
  const queue = new Map<number, { at: number; fn: () => void }>();
  return {
    setTimeout(fn, ms) {
      const id = next++;
      queue.set(id, { at: now + ms, fn });
      return id;
    },
    clearTimeout(id) {
      queue.delete(id);
    },
    advance(ms) {
      const end = now + ms;
      for (;;) {
        const due = [...queue].filter(([, t]) => t.at <= end).sort((a, b) => a[1].at - b[1].at)[0];
        if (!due) break;
        queue.delete(due[0]);
        now = due[1].at;
        due[1].fn();
      }
      now = end;
    },
    pending: () => queue.size,
  };
}

const flush = async (): Promise<void> => {
  for (let i = 0; i < 5; i++) await Promise.resolve();
};

describe('livePoll', () => {
  it('re-reads the view right away and then every interval while visible', async () => {
    const timers = fakeTimers();
    let calls = 0;
    const poll = livePoll({ timers, refresh: () => Promise.resolve(void calls++), isVisible: () => true });
    poll.start();
    expect(calls).toBe(1);
    await flush();
    timers.advance(LIVE_REFRESH_MS - 1);
    expect(calls).toBe(1);
    timers.advance(1);
    expect(calls).toBe(2);
    await flush();
    timers.advance(LIVE_REFRESH_MS * 3);
    await flush();
    expect(calls).toBeGreaterThanOrEqual(3);
    expect(poll.running).toBe(true);
  });

  it('stops for good on stop() and does not double up on a second start()', async () => {
    const timers = fakeTimers();
    let calls = 0;
    const poll = livePoll({ timers, refresh: () => Promise.resolve(void calls++), isVisible: () => true });
    poll.start();
    poll.start();
    expect(calls).toBe(1);
    expect(timers.pending()).toBe(1);
    await flush();
    poll.stop();
    expect(poll.running).toBe(false);
    expect(timers.pending()).toBe(0);
    timers.advance(LIVE_REFRESH_MS * 10);
    expect(calls).toBe(1);
  });

  it('skips reads while hidden, never overlaps them and survives failures', async () => {
    const timers = fakeTimers();
    let visible = false;
    let calls = 0;
    const gate: { release?: () => void } = {};
    const poll = livePoll({
      timers,
      refresh: () => {
        calls++;
        if (calls === 2) return Promise.reject(new Error('Too many requests'));
        return new Promise<void>((resolve) => {
          gate.release = resolve;
        });
      },
      isVisible: () => visible,
    });
    poll.start();
    expect(calls).toBe(0);
    visible = true;
    timers.advance(LIVE_REFRESH_MS);
    expect(calls).toBe(1);
    // The first read is still pending: the next tick must not start another one.
    timers.advance(LIVE_REFRESH_MS);
    expect(calls).toBe(1);
    gate.release?.();
    await flush();
    timers.advance(LIVE_REFRESH_MS);
    expect(calls).toBe(2);
    await flush();
    timers.advance(LIVE_REFRESH_MS);
    expect(calls).toBe(3);
    poll.stop();
  });
});

describe('pagePoll', () => {
  it('refreshes from main only while the page is shown and the window is not minimised', async () => {
    const timers = fakeTimers();
    let refreshes = 0;
    const ctx = { timers, refresh: () => Promise.resolve(void refreshes++) };
    const element: Pick<HTMLElement, 'hidden'> = { hidden: false };
    const doc: { visibilityState: DocumentVisibilityState } = { visibilityState: 'visible' };
    const poll = pagePoll(ctx, element, doc);
    poll.start();
    expect(refreshes).toBe(1);
    await flush();
    timers.advance(LIVE_REFRESH_MS);
    expect(refreshes).toBe(2);
    await flush();
    doc.visibilityState = 'hidden';
    timers.advance(LIVE_REFRESH_MS);
    expect(refreshes).toBe(2);
    doc.visibilityState = 'visible';
    element.hidden = true;
    timers.advance(LIVE_REFRESH_MS);
    expect(refreshes).toBe(2);
    element.hidden = false;
    timers.advance(LIVE_REFRESH_MS);
    expect(refreshes).toBe(3);
    poll.stop();
  });
});
