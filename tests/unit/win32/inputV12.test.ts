// v1.2 Win32 input (ADR 0003 §4.3, §13 Q2; PRV): the mouse-button sampler and press counter (mouse
// buttons only, never keys), the koffi facade's input extension over FakeNative (MOCKED native), and
// the typing detector that no longer counts clicks as typing.
import { describe, expect, it } from 'vitest';
import type { Point } from '../../../src/shared/geometry';
import type { SimEvent } from '../../../src/shared/sim';
import { createActivityMonitor } from '../../../src/main/win32/activityMonitor';
import { createMouseButtonSampler, MOUSE_BUTTON_VKS } from '../../../src/main/win32/mouseButtons';
import { createKoffiWin32Api, createUnavailableWin32Api, hasWin32InputExtensions, type Win32InputExtensions } from '../../../src/main/win32/win32Api';
import { createTestLogger, FakeNative, FakeWin32Api, raw } from './fakes';

const DOWN = 0x8000;
const PRESSED_SINCE = 0x0001;

describe('mouse-button sampler', () => {
  function keys() {
    const state = new Map<number, number>();
    const reads: number[] = [];
    const read = (vk: number): number => {
      reads.push(vk);
      const v = state.get(vk) ?? 0;
      // The low bit is consumed by the read, as GetAsyncKeyState does.
      state.set(vk, v & ~PRESSED_SINCE);
      return v;
    };
    return { state, reads, read };
  }

  it('reads the left, right and middle buttons only (never a key)', () => {
    const k = keys();
    const s = createMouseButtonSampler(k.read);
    s.sample();
    s.sample();
    expect([...new Set(k.reads)].sort()).toEqual([1, 2, 4]);
    expect(MOUSE_BUTTON_VKS).toEqual([1, 2, 4]);
  });

  it('counts a down edge once while the button stays held, and reports it held', () => {
    const k = keys();
    const s = createMouseButtonSampler(k.read);
    expect(s.sample()).toEqual({ down: false, presses: 0 });
    k.state.set(1, DOWN | PRESSED_SINCE);
    expect(s.sample()).toEqual({ down: true, presses: 1 });
    k.state.set(1, DOWN);
    expect(s.sample()).toEqual({ down: true, presses: 1 });
    k.state.set(1, 0);
    expect(s.sample()).toEqual({ down: false, presses: 1 });
  });

  it('counts a click entirely between two samples (the pressed-since bit) and a re-press while held', () => {
    const k = keys();
    const s = createMouseButtonSampler(k.read);
    s.sample();
    k.state.set(2, PRESSED_SINCE);
    expect(s.sample()).toEqual({ down: false, presses: 1 });
    k.state.set(4, DOWN);
    s.sample();
    k.state.set(4, DOWN | PRESSED_SINCE);
    expect(s.sample().presses).toBe(3);
  });

  it('a throwing read counts as up and never throws', () => {
    const s = createMouseButtonSampler(() => {
      throw new Error('boom');
    });
    expect(s.sample()).toEqual({ down: false, presses: 0 });
  });
});

describe('koffi facade input extension (FakeNative)', () => {
  it('exposes the input extension; the unavailable facade fails closed', () => {
    const api = createKoffiWin32Api(new FakeNative(), createTestLogger());
    expect(hasWin32InputExtensions(api)).toBe(true);
    const none = createUnavailableWin32Api();
    expect(hasWin32InputExtensions(none)).toBe(true);
    expect(none.clickObstaclesPx()).toEqual({ rects: [], fresh: false });
    expect(none.mouseButtons()).toEqual({ down: false, presses: 0 });
    expect(none.windowProcessId('1')).toBeNull();
    expect(hasWin32InputExtensions(new FakeWin32Api())).toBe(false);
  });

  it('mouseButtons goes through one sampler: every reader sees the same monotonic count', () => {
    const native = new FakeNative();
    const api = createKoffiWin32Api(native, createTestLogger());
    native.keyState.set(1, DOWN);
    expect(api.mouseButtons()).toEqual({ down: true, presses: 1 });
    expect(api.mouseButtons()).toEqual({ down: true, presses: 1 });
    native.keyState.set(1, 0);
    native.keyState.set(2, DOWN);
    expect(api.mouseButtons()).toEqual({ down: true, presses: 2 });
  });

  it('windowProcessId: the owning pid, null for a gone window or a bad id', () => {
    const native = new FakeNative();
    native.add(10n, { pid: 77, frame: raw(0, 0, 400, 300) });
    const api = createKoffiWin32Api(native, createTestLogger());
    expect(api.windowProcessId('10')).toBe(77);
    expect(api.windowProcessId('11')).toBeNull();
    expect(api.windowProcessId('abc')).toBeNull();
  });
});

describe('typing detector with mouse buttons (v1.2)', () => {
  const STEP = 33;
  /** An activity monitor over a FakeWin32Api that also has the input extension (scripted buttons). */
  function setup(withButtons: boolean) {
    const api = new FakeWin32Api() as FakeWin32Api & Partial<Win32InputExtensions>;
    let presses = 0;
    let held = false;
    if (withButtons) {
      api.windowProcessId = () => null;
      api.mouseButtons = () => ({ down: held, presses });
      api.clickObstaclesPx = () => ({ rects: [], fresh: false });
      api.setObstacleWatch = () => undefined;
      api.obstacleStats = () => null;
    }
    let t = 0;
    let lastInput = 0;
    const cursor: Point = { x: 500, y: 500 };
    const monitor = createActivityMonitor(api, createTestLogger(), { idleProvider: () => Math.max(0, t - lastInput) });
    monitor.start();
    const events: SimEvent[] = [];
    const run = (ms: number, each: (now: number) => void) => {
      const end = t + ms;
      while (t < end) {
        t += STEP;
        each(t);
        monitor.sample(t, { ...cursor });
        events.push(...monitor.drainEvents());
      }
    };
    return {
      monitor,
      events,
      run,
      input: () => {
        lastInput = t;
      },
      click: () => {
        // A quick click: the button went down and up between two samples (counted, not held).
        presses++;
        lastInput = t;
      },
      setHeld: (v: boolean) => {
        held = v;
      },
    };
  }

  it('clicking repeatedly without moving the mouse is not typing (input extension)', () => {
    const r = setup(true);
    let last = -Infinity;
    r.run(6000, (now) => {
      if (now - last >= 200) {
        last = now;
        r.click();
      }
    });
    expect(r.monitor.typing).toBe(false);
    expect(r.events.map((e) => e.type)).not.toContain('activity.typingStart');
  });

  it('the same clicks counted as typing before (v1.1 path, no input extension: the button is up at each sample)', () => {
    const r = setup(false);
    let last = -Infinity;
    r.run(6000, (now) => {
      if (now - last >= 200) {
        last = now;
        r.input();
      }
    });
    expect(r.monitor.typing).toBe(true);
  });

  it('keyboard-like input with no button activity is still typing; a held button (drag-select) is not', () => {
    const r = setup(true);
    let last = -Infinity;
    r.run(4000, (now) => {
      if (now - last >= 165) {
        last = now;
        r.input();
      }
    });
    expect(r.monitor.typing).toBe(true);
    const held = setup(true);
    held.setHeld(true);
    let l2 = -Infinity;
    held.run(4000, (now) => {
      if (now - l2 >= 165) {
        l2 = now;
        held.input();
      }
    });
    expect(held.monitor.typing).toBe(false);
  });

  it('a click long ago does not turn later typing into clicks (the counter is read every sample)', () => {
    const r = setup(true);
    r.run(100, () => r.click());
    r.run(2000, () => undefined);
    let last = -Infinity;
    r.run(4000, (now) => {
      if (now - last >= 165) {
        last = now;
        r.input();
      }
    });
    expect(r.monitor.typing).toBe(true);
  });
});
