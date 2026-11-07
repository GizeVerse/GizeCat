import { describe, expect, it } from 'vitest';
import { createGestureRecognizer } from '../../../src/core/interaction/gestures';
import { attachPointerInput, eventTime, MAX_EVENT_AGE_MS, MOVE_MIN_INTERVAL_MS } from '../../../src/renderer/overlay/input';
import type { OverlayPointerEvent } from '../../../src/shared/ipc';

/** Drives attachPointerInput with a 1000 Hz mouse and a display refreshing at `hz`. */
function simulate(hz: number, ms: number): OverlayPointerEvent[] {
  const listeners = new Map<string, (e: unknown) => void>();
  const target = {
    addEventListener: (type: string, fn: (e: unknown) => void) => listeners.set(type, fn),
    removeEventListener: () => undefined,
    setPointerCapture: () => undefined,
  } as unknown as HTMLElement;
  const sent: OverlayPointerEvent[] = [];
  let pending: FrameRequestCallback | null = null;
  const detach = attachPointerInput(
    target,
    (e) => sent.push(e),
    (cb) => {
      pending = cb;
      return 1;
    },
    () => {
      pending = null;
    },
  );
  const ev = (x: number, buttons = 1) => ({ clientX: x, clientY: 5, button: 0, buttons, pointerId: 1, preventDefault: () => undefined });
  listeners.get('pointerdown')!(ev(0));
  const frameMs = 1000 / hz;
  let nextFrame = frameMs;
  for (let t = 1; t <= ms; t++) {
    listeners.get('pointermove')!(ev(t));
    while (nextFrame <= t) {
      const cb = pending as FrameRequestCallback | null;
      pending = null;
      cb?.(nextFrame);
      nextFrame += frameMs;
    }
  }
  listeners.get('pointerup')!(ev(ms, 0));
  detach();
  return sent;
}

describe('pointer move pacing', () => {
  for (const hz of [60, 144, 240, 360]) {
    it(`sends moves per time, not per frame, at ${hz} Hz`, () => {
      const sent = simulate(hz, 2000);
      const moves = sent.filter((e) => e.kind === 'move').length / 2;
      expect(moves).toBeLessThanOrEqual(1000 / MOVE_MIN_INTERVAL_MS + 1);
      // Still smooth enough for drag velocity (>= 60/s where the display allows).
      expect(moves).toBeGreaterThanOrEqual(Math.min(hz, 100) - 2);
      // Press and release always go out, the release after the final position.
      expect(sent[0]!.kind).toBe('down');
      expect(sent.at(-1)!.kind).toBe('up');
      expect(sent.at(-2)!).toMatchObject({ kind: 'move', x: 2000 });
    });
  }
});

// Diagnosis H3 / fix F3: events carry their own timestamps (Event.timeStamp, the performance.now()
// time base), not the time their handler ran. SIMULATED DOM events.
describe('pointer event timestamps', () => {
  function harness(now: () => number) {
    const listeners = new Map<string, (e: unknown) => void>();
    const target = {
      addEventListener: (type: string, fn: (e: unknown) => void) => listeners.set(type, fn),
      removeEventListener: () => undefined,
      setPointerCapture: () => undefined,
    } as unknown as HTMLElement;
    const sent: OverlayPointerEvent[] = [];
    let pending: FrameRequestCallback | null = null;
    attachPointerInput(
      target,
      (e) => sent.push(e),
      (cb) => {
        pending = cb;
        return 1;
      },
      () => {
        pending = null;
      },
      now,
    );
    const fire = (type: string, init: Record<string, unknown>) =>
      listeners.get(type)!({ clientX: 0, clientY: 5, button: 0, buttons: 0, pointerId: 1, preventDefault: () => undefined, ...init });
    const frame = (t: number) => {
      const cb = pending;
      pending = null;
      cb?.(t);
    };
    return { fire, frame, sent };
  }

  it('stamps each event with its own timeStamp: a busy renderer still reports a 90 ms click as a tap', () => {
    let now = 1000;
    const h = harness(() => now);
    h.fire('pointerdown', { clientX: 10, buttons: 1, timeStamp: 1000 });
    // The release happened at 1090; the renderer's main thread only gets to it at 1610.
    now = 1610;
    h.fire('pointerup', { clientX: 10, buttons: 0, timeStamp: 1090 });
    expect(h.sent.map((e) => [e.kind, e.t])).toEqual([
      ['down', 1000],
      ['up', 1090],
    ]);
    const g = createGestureRecognizer();
    const out = h.sent.flatMap((e) => g.feed({ kind: e.kind, x: e.x, y: e.y, button: e.button, buttons: e.buttons, t: e.t }));
    expect(out.map((e) => e.type)).toEqual(['pointer.tap']);
  });

  it('sends the newest coalesced sample of a move, with its own position and time', () => {
    const h = harness(() => 500);
    h.fire('pointerdown', { clientX: 0, buttons: 1, timeStamp: 400 });
    h.fire('pointermove', {
      clientX: 15,
      buttons: 1,
      timeStamp: 404,
      getCoalescedEvents: () => [
        { clientX: 10, clientY: 5, buttons: 1, timeStamp: 402 },
        { clientX: 20, clientY: 6, buttons: 1, timeStamp: 408 },
      ],
    });
    h.frame(480);
    expect(h.sent.at(-1)).toMatchObject({ kind: 'move', x: 20, y: 6, t: 408 });
    // Without coalesced samples (or with a throwing accessor) the event itself is used.
    h.fire('pointermove', { clientX: 30, buttons: 1, timeStamp: 420 });
    h.frame(490);
    expect(h.sent.at(-1)).toMatchObject({ kind: 'move', x: 30, t: 420 });
    h.fire('pointermove', {
      clientX: 40,
      buttons: 1,
      timeStamp: 430,
      getCoalescedEvents: () => {
        throw new Error('detached');
      },
    });
    h.frame(500);
    expect(h.sent.at(-1)).toMatchObject({ kind: 'move', x: 40, t: 430 });
  });

  it('falls back to handler time for a missing, zero, future or ancient timestamp', () => {
    const now = 100_000;
    expect(eventTime({}, now)).toBe(now);
    expect(eventTime({ timeStamp: 0 }, now)).toBe(now);
    expect(eventTime({ timeStamp: Number.NaN }, now)).toBe(now);
    expect(eventTime({ timeStamp: now + 50 }, now)).toBe(now);
    expect(eventTime({ timeStamp: now - MAX_EVENT_AGE_MS - 1 }, now)).toBe(now);
    // An epoch-based value (the old DOMTimeStamp) lies far in the future of performance.now().
    expect(eventTime({ timeStamp: Date.UTC(2026, 10, 7) }, now)).toBe(now);
    expect(eventTime({ timeStamp: now - 520 }, now)).toBe(now - 520);
  });
});
