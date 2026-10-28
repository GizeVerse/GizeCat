import { describe, expect, it } from 'vitest';
import { attachPointerInput, MOVE_MIN_INTERVAL_MS } from '../../../src/renderer/overlay/input';
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
