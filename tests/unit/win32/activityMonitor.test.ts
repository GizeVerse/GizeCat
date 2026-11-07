import { describe, expect, it } from 'vitest';
import type { Point } from '../../../src/shared/geometry';
import type { SimEvent } from '../../../src/shared/sim';
import { createActivityMonitor } from '../../../src/main/win32/activityMonitor';
import { createTestLogger, FakeWin32Api } from './fakes';

const STEP = 33;

function setup(opts: { sleepThresholdMs?: number; jitter?: (t: number) => number } = {}) {
  const api = new FakeWin32Api();
  let t = 0;
  let lastInput = 0;
  const cursor: Point = { x: 500, y: 500 };
  let cursorKnown = true;
  const jitter = opts.jitter ?? (() => 0);
  const monitor = createActivityMonitor(api, createTestLogger(), {
    idleProvider: () => Math.max(0, t - lastInput + jitter(t)),
    sleepThresholdMs: opts.sleepThresholdMs,
  });
  monitor.start();
  const events: Array<SimEvent & { t: number }> = [];
  /** Advances in fixed host ticks (rounded up to whole ticks); `each` runs before every sample and may simulate input. */
  const run = (ms: number, each?: (t: number) => void) => {
    const end = t + ms;
    while (t < end) {
      t += STEP;
      each?.(t);
      monitor.sample(t, cursorKnown ? { ...cursor } : null);
      for (const e of monitor.drainEvents()) events.push({ ...e, t });
    }
  };
  let lastKey = -Infinity;
  /** Keyboard-like input every `everyMs` (input without cursor motion). */
  const typing = (everyMs = 165) => (now: number) => {
    if (now - lastKey >= everyMs) {
      lastKey = now;
      lastInput = now;
    }
  };
  return {
    api,
    monitor,
    events,
    run,
    typing,
    input: () => {
      lastInput = t;
    },
    moveCursor: (dx: number, dy = 0) => {
      cursor.x += dx;
      cursor.y += dy;
    },
    setCursorKnown: (v: boolean) => {
      cursorKnown = v;
    },
    now: () => t,
    types: () => events.map((e) => e.type),
  };
}

describe('typing heuristic', () => {
  it('starts after >= 2 s of keyboard-like activity', () => {
    const s = setup();
    s.run(1000);
    s.run(1800, s.typing());
    expect(s.types()).not.toContain('activity.typingStart');
    expect(s.monitor.typing).toBe(false);
    s.run(500, s.typing());
    expect(s.types()).toContain('activity.typingStart');
    expect(s.monitor.typing).toBe(true);
  });

  it('ignores input that moves the cursor', () => {
    const s = setup();
    s.run(1000);
    let last = -Infinity;
    s.run(5000, (now) => {
      if (now - last >= 165) {
        last = now;
        s.moveCursor(4);
        s.input();
      }
    });
    expect(s.types()).toEqual([]);
    expect(s.monitor.typingIntensity).toBe(0);
  });

  it('ignores input while the mouse button is held (dragging)', () => {
    const s = setup();
    s.api.leftDown = true;
    s.run(1000);
    s.run(5000, s.typing());
    expect(s.types()).toEqual([]);
  });

  it('an unknown button state (the read failed: null) counts as not held, so typing is still recognised', () => {
    const s = setup();
    s.api.leftDown = null;
    s.run(1000);
    s.run(2500, s.typing());
    expect(s.types()).toContain('activity.typingStart');
  });

  it('does not classify input when the cursor position is unknown', () => {
    const s = setup();
    s.setCursorKnown(false);
    s.run(1000);
    s.run(5000, s.typing());
    expect(s.types()).toEqual([]);
  });

  it('ends after 4 s without keyboard-like input and reports the duration', () => {
    const s = setup();
    s.run(1000);
    s.run(6000, s.typing());
    s.run(3800);
    expect(s.types()).toEqual(['activity.typingStart']);
    s.run(400);
    const end = s.events.find((e) => e.type === 'activity.typingEnd');
    expect(end).toBeDefined();
    expect(end && end.type === 'activity.typingEnd' ? end.durationMs : -1).toBeGreaterThan(5500);
    expect(end && end.type === 'activity.typingEnd' ? end.durationMs : -1).toBeLessThanOrEqual(6000);
    expect(s.monitor.typing).toBe(false);
  });

  it('tolerates short pauses inside a typing run', () => {
    const s = setup();
    s.run(1000);
    s.run(1200, s.typing());
    s.run(1000);
    s.run(1200, s.typing());
    expect(s.types()).toEqual(['activity.typingStart']);
  });

  it('measures intensity as the active share of the last 30 one-second buckets', () => {
    const s = setup();
    s.run(30_000);
    s.run(15_000, s.typing());
    s.run(15_000);
    const share = s.monitor.typingIntensity;
    expect(share).toBeGreaterThanOrEqual(14 / 30);
    expect(share).toBeLessThanOrEqual(16 / 30);
    s.run(30_000);
    expect(s.monitor.typingIntensity).toBe(0);
  });

  it('is not fooled by idle-time quantisation jitter', () => {
    const pattern = [0, 15, -15, 8, -8, 12, -12, 0];
    const s = setup({ jitter: (t) => pattern[Math.floor(t / STEP) % pattern.length] ?? 0 });
    s.run(20_000);
    expect(s.types()).toEqual([]);
    expect(s.monitor.typingIntensity).toBe(0);
  });
});

describe('idle and return', () => {
  it('emits userIdle once at 60 s and again at the sleep threshold', () => {
    const s = setup({ sleepThresholdMs: 120_000 });
    s.run(59_000);
    expect(s.types()).toEqual([]);
    s.run(2000);
    expect(s.types()).toEqual(['activity.userIdle']);
    s.run(58_000);
    expect(s.types()).toEqual(['activity.userIdle']);
    s.run(2000);
    expect(s.types()).toEqual(['activity.userIdle', 'activity.userIdle']);
    s.run(120_000);
    expect(s.types()).toHaveLength(2);
    const idle = s.events.map((e) => (e.type === 'activity.userIdle' ? e.idleMs : 0));
    expect(idle[0]).toBeGreaterThanOrEqual(60_000);
    expect(idle[1]).toBeGreaterThanOrEqual(120_000);
  });

  it('honours a sleep threshold set later and does not double-fire when it equals 60 s', () => {
    const s = setup();
    s.monitor.setSleepThresholdMs(60_000);
    s.run(65_000);
    expect(s.types()).toEqual(['activity.userIdle']);
  });

  it('emits userReturned with the idle stretch after >= 60 s', () => {
    const s = setup();
    s.run(90_000);
    s.input();
    s.run(STEP);
    const back = s.events.find((e) => e.type === 'activity.userReturned');
    expect(back && back.type === 'activity.userReturned' ? back.idleMs : 0).toBeGreaterThanOrEqual(90_000 - STEP);
    expect(back && back.type === 'activity.userReturned' ? back.idleMs : 0).toBeLessThanOrEqual(90_000 + STEP);
    // After returning, the idle notifications re-arm.
    s.run(61_000);
    expect(s.types().filter((x) => x === 'activity.userIdle')).toHaveLength(2);
  });

  it('does not report a return after a short pause', () => {
    const s = setup();
    s.run(30_000);
    s.input();
    s.run(1000);
    expect(s.types()).toEqual([]);
    expect(s.monitor.idleMs).toBeLessThan(1100);
  });
});

describe('cursor speed and flicks', () => {
  it('tracks speed with an exponential moving average', () => {
    const s = setup();
    s.run(500);
    s.run(1000, () => s.moveCursor(10)); // 10 px / 33 ms ~= 303 px/s
    expect(s.monitor.cursorSpeed).toBeGreaterThan(280);
    expect(s.monitor.cursorSpeed).toBeLessThan(320);
    s.run(1000);
    expect(s.monitor.cursorSpeed).toBeLessThan(5);
  });

  it('emits one flick for a sustained fast movement, rate-limited to one per 4 s', () => {
    const s = setup();
    s.run(500);
    s.run(200, () => s.moveCursor(100)); // ~3000 px/s for 200 ms
    const flicks = () => s.events.filter((e) => e.type === 'cursor.flick');
    expect(flicks()).toHaveLength(1);
    const f = flicks()[0];
    expect(f && f.type === 'cursor.flick' ? f.speed : 0).toBeGreaterThan(2500);
    s.run(300);
    s.run(200, () => s.moveCursor(-100));
    expect(flicks()).toHaveLength(1);
    s.run(4000);
    s.run(200, () => s.moveCursor(100));
    expect(flicks()).toHaveLength(2);
  });

  it('ignores fast bursts shorter than 80 ms and slow movement', () => {
    const s = setup();
    s.run(500);
    s.run(2 * STEP, () => s.moveCursor(100));
    s.run(500);
    s.run(2000, () => s.moveCursor(40)); // ~1200 px/s
    expect(s.events.filter((e) => e.type === 'cursor.flick')).toEqual([]);
  });
});

describe('lifecycle', () => {
  it('ends typing on stop and ignores samples while stopped', () => {
    const s = setup();
    s.run(1000);
    s.run(3000, s.typing());
    s.monitor.stop();
    expect(s.monitor.drainEvents().map((e) => e.type)).toEqual(['activity.typingEnd']);
    s.run(70_000);
    expect(s.types()).toEqual(['activity.typingStart']);
  });

  it('survives a clock that goes backwards', () => {
    const api = new FakeWin32Api();
    const monitor = createActivityMonitor(api, createTestLogger(), { idleProvider: () => 10 });
    monitor.start();
    monitor.sample(1000, { x: 0, y: 0 });
    expect(() => monitor.sample(500, { x: 0, y: 0 })).not.toThrow();
    monitor.sample(533, { x: 1, y: 0 });
    expect(monitor.drainEvents()).toEqual([]);
  });

  it('falls back to the API idle time and copes with it being unavailable', () => {
    const api = new FakeWin32Api();
    api.idle = null;
    const monitor = createActivityMonitor(api, createTestLogger());
    monitor.start();
    monitor.sample(0, { x: 0, y: 0 });
    monitor.sample(33, { x: 0, y: 0 });
    expect(monitor.idleMs).toBe(0);
    api.idle = 1234;
    monitor.sample(66, { x: 0, y: 0 });
    expect(monitor.idleMs).toBe(1234);
  });
});

describe('coarse idle source off Windows (ADR 0004 §3: powerMonitor.getSystemIdleTime, whole seconds)', () => {
  function coarse(idleResolutionMs: number | undefined) {
    const api = new FakeWin32Api();
    let t = 0;
    let lastInput = 0;
    const monitor = createActivityMonitor(api, createTestLogger(), {
      // What powerMonitor gives, in ms: whole seconds since the last input.
      idleProvider: () => Math.floor(Math.max(0, t - lastInput) / 1000) * 1000,
      ...(idleResolutionMs === undefined ? {} : { idleResolutionMs }),
    });
    monitor.start();
    const events: SimEvent[] = [];
    const run = (ms: number) => {
      const end = t + ms;
      while (t < end) {
        // The host's normal cursor-poll interval (DEFAULT_POLL_INTERVALS.normalMs).
        t += 50;
        monitor.sample(t, { x: 500, y: 500 });
        events.push(...monitor.drainEvents());
      }
    };
    return { events, run, input: () => (lastInput = t) };
  }
  const kinds = (evs: SimEvent[]) => evs.map((e) => e.type);

  it('the fine-grained rule would read a 1 s source as constant new input (why the coarse mode exists)', () => {
    const r = coarse(undefined);
    r.run(70_000);
    expect(kinds(r.events)).toContain('activity.typingStart');
  });

  it('coarse mode: a user away for 70 s gets one idle event, no typing and no spurious return', () => {
    const r = coarse(1000);
    r.run(70_000);
    expect(kinds(r.events)).toEqual(['activity.userIdle']);
  });

  it('coarse mode: input after a long absence is a return', () => {
    const r = coarse(1000);
    r.run(70_000);
    r.input();
    r.run(2000);
    const back = r.events.filter((e) => e.type === 'activity.userReturned');
    expect(back).toHaveLength(1);
    expect(kinds(r.events)).not.toContain('activity.typingStart');
  });
});
