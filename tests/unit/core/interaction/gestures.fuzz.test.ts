// Gesture recogniser fuzz (diagnosis synthesis §3.C; fix F3): 10,000 seeded random pointer
// sequences through the real recogniser, with time jumping forwards and backwards, checking the
// invariants a cat running for days relies on: no press outlives its end, every drag ends exactly
// once, nothing wedges, durations come from the event timestamps. SIMULATED input (no renderer).
import { describe, expect, it } from 'vitest';
import { createGestureRecognizer, DEFAULT_GESTURE_THRESHOLDS, type GesturePointerEvent, type GesturePointerKind } from '../../../../src/core/interaction/gestures';
import type { SimEvent } from '../../../../src/shared/sim';

/** Seeded PRNG (mulberry32). */
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const KINDS: readonly GesturePointerKind[] = ['down', 'down', 'move', 'move', 'move', 'move', 'move', 'up', 'up', 'enter', 'leave', 'context', 'cancel'];
const TAPS = new Set(['pointer.tap', 'pointer.doubleTap']);

/** Cheap assertion for the hot loop: the message is only built when the invariant breaks. */
function ensure(ok: boolean, msg: () => string): void {
  if (!ok) expect.fail(msg());
}

describe('gesture recogniser fuzz (10,000 seeded sequences)', () => {
  it('keeps every press and drag invariant whatever the order, buttons and time base', () => {
    const rand = rng(0x5eed);
    const pick = <T>(xs: readonly T[]): T => xs[Math.floor(rand() * xs.length)]!;
    let drags = 0;
    let backwards = 0;
    let contextsInPress = 0;
    for (let seq = 0; seq < 10_000; seq++) {
      const g = createGestureRecognizer();
      let t = rand() * 1e7;
      let x = 500 + rand() * 500;
      let y = 300 + rand() * 300;
      /** dragStarts minus dragEnds: 0 or 1. */
      let open = 0;
      const check = (out: SimEvent[], label: () => string): void => {
        for (const ev of out) {
          if (ev.type === 'pointer.dragStart') {
            ensure(open === 0, () => `${label()}: dragStart while a drag is open`);
            open++;
            drags++;
          } else if (ev.type === 'pointer.dragEnd') {
            ensure(open === 1, () => `${label()}: dragEnd without a drag`);
            open--;
            const speed = Math.hypot(ev.velocity.x, ev.velocity.y);
            ensure(Number.isFinite(speed) && speed <= DEFAULT_GESTURE_THRESHOLDS.maxReleaseSpeed + 1e-6, () => `${label()}: release speed ${speed}`);
          }
        }
        ensure(g.dragging === (open === 1), () => `${label()}: dragging flag vs events`);
        // A drag is always a press.
        ensure(!g.dragging || g.pressed === true, () => `${label()}: drag without a press`);
      };
      const n = 5 + Math.floor(rand() * 40);
      for (let i = 0; i < n; i++) {
        const r = rand();
        if (r < 0.05) {
          t -= rand() * 5000;
          backwards++;
        } else if (r < 0.1) t += rand() * 5000;
        else t += rand() * 40;
        x += (rand() - 0.5) * 40;
        y += (rand() - 0.5) * 40;
        const kind = pick(KINDS);
        const button = kind === 'down' || kind === 'up' ? (rand() < 0.8 ? 0 : pick([1, 2])) : kind === 'move' ? -1 : pick([-1, 0, 2]);
        const buttons = Math.floor(rand() * 4);
        const ev: GesturePointerEvent = { kind, x, y, t, button, buttons };
        const label = (): string => `seq ${seq} event ${i} (${kind} button ${button} buttons ${buttons})`;
        const wasPressed = g.pressed === true;
        check(g.feed(ev), label);
        if (kind === 'move' && (buttons & 1) === 0) ensure(g.pressed === false, () => `${label()}: a press survived a buttonless move`);
        if (kind === 'context' || kind === 'cancel') {
          if (kind === 'context' && wasPressed) contextsInPress++;
          ensure(g.pressed === false, () => `${label()}: ${kind} must end the press`);
        }
        if (kind === 'up' && button === 0) ensure(g.pressed === false, () => `${label()}: a primary release must end the press`);
        // A primary press always opens a press, also over a stale one whose release was lost.
        if (kind === 'down' && button === 0) ensure(g.pressed === true, () => `${label()}: a primary press was ignored`);
        // Non-finite input is ignored outright.
        if (rand() < 0.02) {
          const before = { pressed: g.pressed, dragging: g.dragging, hovering: g.hovering };
          const a = g.feed({ kind: pick(KINDS), x: Number.NaN, y, t, button: 0, buttons: 0 });
          const b = g.feed({ kind: pick(KINDS), x, y, t: Number.POSITIVE_INFINITY, button: 0, buttons: 1 });
          ensure(a.length === 0 && b.length === 0, () => `${label()}: non-finite input emitted events`);
          ensure(g.pressed === before.pressed && g.dragging === before.dragging && g.hovering === before.hovering, () => `${label()}: non-finite input changed state`);
        }
      }
      // Never wedged: a clean click after the sequence (forwards, or with the clock behind) is a
      // tap exactly when its own timestamps say it is short, and it ends any open drag first.
      const probeT = rand() < 0.5 ? t + 1000 : t - 10_000;
      const d = rand() * 1200;
      const probe = [...g.feed({ kind: 'down', x, y, t: probeT, button: 0, buttons: 1 }), ...g.feed({ kind: 'up', x, y, t: probeT + d, button: 0, buttons: 0 })];
      check(probe, () => `seq ${seq} probe`);
      const taps = probe.filter((e) => TAPS.has(e.type)).length;
      ensure(taps === (d <= DEFAULT_GESTURE_THRESHOLDS.tapMaxDurationMs ? 1 : 0), () => `seq ${seq} probe of ${Math.round(d)} ms gave ${taps} taps`);
      ensure(g.pressed === false && g.dragging === false, () => `seq ${seq}: the probe left a press open`);
    }
    // The fuzz reached the interesting cases.
    expect(drags).toBeGreaterThan(2000);
    expect(backwards).toBeGreaterThan(5000);
    expect(contextsInPress).toBeGreaterThan(500);
  });

  it('a context menu mid-drag ends the drag once, without a throw, and the late release is a no-op', () => {
    const g = createGestureRecognizer();
    const out: SimEvent[] = [];
    out.push(...g.feed({ kind: 'down', x: 0, y: 0, t: 0, button: 0, buttons: 1 }));
    for (let i = 1; i <= 5; i++) out.push(...g.feed({ kind: 'move', x: i * 20, y: 0, t: i * 8, button: -1, buttons: 1 }));
    expect(out.map((e) => e.type)).toEqual(['pointer.dragStart']);
    // The menu opens mid-throw: the drag ends right there, with no speed (not on some later release).
    const atMenu = g.feed({ kind: 'context', x: 100, y: 0, t: 41, button: 2, buttons: 1 });
    expect(atMenu).toEqual([{ type: 'pointer.dragEnd', at: { x: 100, y: 0 }, velocity: { x: 0, y: 0 } }]);
    expect(g.dragging).toBe(false);
    expect(g.feed({ kind: 'up', x: 100, y: 0, t: 400, button: 0, buttons: 0 })).toEqual([]);
  });

  it("a second primary press replaces a stale one (its release was lost) instead of being ignored", () => {
    const g = createGestureRecognizer();
    g.feed({ kind: 'down', x: 10, y: 10, t: 0, button: 0, buttons: 1 });
    // No up, cancel or buttonless move ever arrived for the first press.
    const out = [...g.feed({ kind: 'down', x: 10, y: 10, t: 5000, button: 0, buttons: 1 }), ...g.feed({ kind: 'up', x: 10, y: 10, t: 5060, button: 0, buttons: 0 })];
    expect(out.map((e) => e.type)).toEqual(['pointer.tap']);
  });
});
