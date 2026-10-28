import { describe, expect, it } from 'vitest';
import type { WorldGeometry } from '../../../../src/shared/world';
import { createTopologyTracker, normalizeDisplays, sameDisplays } from '../../../../src/core/display/topology';
import type { RawDisplay } from '../../../../src/core/display/topology';

const rd = (id: string | number, x: number, y: number, w: number, h: number, scale = 1, primary = false): RawDisplay => ({
  id,
  primary,
  scaleFactor: scale,
  boundsDip: { x: x / scale, y: y / scale, width: w / scale, height: h / scale },
  workAreaDip: { x: x / scale, y: y / scale, width: w / scale, height: (h - 40) / scale },
  boundsPx: { x, y, width: w, height: h },
  workAreaPx: { x, y, width: w, height: h - 40 },
});

describe('normalizeDisplays', () => {
  it('drops unusable displays and duplicate ids', () => {
    const out = normalizeDisplays([
      rd(1, 0, 0, 1920, 1080, 1, true),
      rd(1, 1920, 0, 1920, 1080),
      { ...rd(2, 1920, 0, 1920, 1080), boundsPx: { x: 1920, y: 0, width: 0, height: 1080 } },
      { ...rd(3, 1920, 0, 1920, 1080), scaleFactor: NaN },
      { ...rd(4, 1920, 0, 1920, 1080), boundsDip: { x: NaN, y: 0, width: 1, height: 1 } },
    ]);
    expect(out.map((d) => d.id)).toEqual(['1']);
  });

  it('falls back to the bounds for an invalid or out-of-bounds work area', () => {
    const [d] = normalizeDisplays([{ ...rd(1, 0, 0, 1920, 1080, 1, true), workAreaPx: { x: 0, y: 0, width: 5000, height: 10 } }]);
    expect(d?.workAreaPx).toEqual({ x: 0, y: 0, width: 1920, height: 1080 });
    expect(d?.workAreaDip).toEqual({ x: 0, y: 0, width: 1920, height: 1040 });
  });

  it('guarantees exactly one primary, preferring the display at the origin', () => {
    const none = normalizeDisplays([rd('a', 1920, 0, 1920, 1080), rd('b', 0, 0, 1920, 1080)]);
    expect(none.filter((d) => d.primary).map((d) => d.id)).toEqual(['b']);
    const two = normalizeDisplays([rd('a', -1920, 0, 1920, 1080, 1, true), rd('b', 0, 0, 1920, 1080, 1, true)]);
    expect(two.filter((d) => d.primary).map((d) => d.id)).toEqual(['b']);
  });

  it('sorts primary first, then left-to-right and top-to-bottom', () => {
    const out = normalizeDisplays([rd('r', 1920, 0, 1920, 1080), rd('top', -960, -2160, 3840, 2160, 1.5), rd('p', 0, 0, 1920, 1080, 1, true), rd('l', -1920, 0, 1920, 1080)]);
    expect(out.map((d) => d.id)).toEqual(['p', 'l', 'top', 'r']);
  });
});

describe('sameDisplays', () => {
  it('compares every geometric field', () => {
    const a = normalizeDisplays([rd(1, 0, 0, 1920, 1080, 1, true)]);
    expect(sameDisplays(a, normalizeDisplays([rd(1, 0, 0, 1920, 1080, 1, true)]))).toBe(true);
    expect(sameDisplays(a, normalizeDisplays([rd(1, 0, 0, 1920, 1080, 1.25, true)]))).toBe(false);
    expect(sameDisplays(a, normalizeDisplays([{ ...rd(1, 0, 0, 1920, 1080, 1, true), workAreaPx: { x: 0, y: 40, width: 1920, height: 1040 } }]))).toBe(false);
    expect(sameDisplays(a, [])).toBe(false);
  });
});

function harness(initial: RawDisplay[]) {
  let current: RawDisplay[] | Error = initial;
  let reads = 0;
  const timers: Array<{ fn: () => void; ms: number; cancelled: boolean }> = [];
  const errors: unknown[] = [];
  const tracker = createTopologyTracker({
    read: () => {
      reads++;
      if (current instanceof Error) throw current;
      return current;
    },
    schedule: (fn, ms) => {
      const t = { fn, ms, cancelled: false };
      timers.push(t);
      return () => {
        t.cancelled = true;
      };
    },
    debounceMs: 400,
    onError: (e) => errors.push(e),
  });
  return {
    tracker,
    errors,
    reads: () => reads,
    set: (v: RawDisplay[] | Error) => {
      current = v;
    },
    flush: () => {
      for (const t of timers.splice(0)) if (!t.cancelled) t.fn();
    },
    pending: () => timers.filter((t) => !t.cancelled).length,
    lastDelay: () => timers.at(-1)?.ms,
  };
}

describe('createTopologyTracker', () => {
  it('reads once at creation with version 1', () => {
    const h = harness([rd(1, 0, 0, 1920, 1080, 1, true)]);
    expect(h.tracker.world.version).toBe(1);
    expect(h.tracker.world.displays).toHaveLength(1);
    expect(h.reads()).toBe(1);
  });

  it('debounces bursts of notifications into one re-read', () => {
    const h = harness([rd(1, 0, 0, 1920, 1080, 1, true)]);
    const seen: WorldGeometry[] = [];
    h.tracker.onChange((w) => seen.push(w));
    h.set([rd(1, 0, 0, 1920, 1080, 1, true), rd(2, 1920, 0, 1920, 1080)]);
    h.tracker.notify();
    h.tracker.notify();
    h.tracker.notify();
    expect(h.pending()).toBe(1);
    expect(h.lastDelay()).toBe(400);
    h.flush();
    expect(h.reads()).toBe(2);
    expect(seen.map((w) => [w.version, w.displays.length])).toEqual([[2, 2]]);
  });

  it('keeps the version when nothing changed', () => {
    const h = harness([rd(1, 0, 0, 1920, 1080, 1, true)]);
    h.tracker.notify();
    h.flush();
    expect(h.tracker.world.version).toBe(1);
    expect(h.tracker.refresh()).toBe(false);
  });

  it('increments the version on DPI or work-area changes', () => {
    const h = harness([rd(1, 0, 0, 1920, 1080, 1, true)]);
    h.set([rd(1, 0, 0, 1920, 1080, 1.25, true)]);
    expect(h.tracker.refresh()).toBe(true);
    expect(h.tracker.world.version).toBe(2);
    expect(h.tracker.world.displays[0]?.scaleFactor).toBe(1.25);
  });

  it('keeps the last good world on empty reads and read errors', () => {
    const h = harness([rd(1, 0, 0, 1920, 1080, 1, true)]);
    const before = h.tracker.world;
    h.set([]);
    expect(h.tracker.refresh()).toBe(false);
    h.set(new Error('screen unavailable'));
    expect(h.tracker.refresh()).toBe(false);
    expect(h.tracker.world).toBe(before);
    expect(h.errors).toHaveLength(1);
  });

  it('recovers from an empty initial read', () => {
    const h = harness([]);
    expect(h.tracker.world).toEqual({ version: 0, displays: [] });
    h.set([rd(1, 0, 0, 1920, 1080, 1, true)]);
    expect(h.tracker.refresh()).toBe(true);
    expect(h.tracker.world.version).toBe(1);
  });

  it('isolates listener failures and supports unsubscribe', () => {
    const h = harness([rd(1, 0, 0, 1920, 1080, 1, true)]);
    const got: number[] = [];
    h.tracker.onChange(() => {
      throw new Error('listener bug');
    });
    const off = h.tracker.onChange((w) => got.push(w.version));
    h.set([rd(1, 0, 0, 2560, 1440, 1, true)]);
    h.tracker.refresh();
    off();
    h.set([rd(1, 0, 0, 1920, 1080, 1, true)]);
    h.tracker.refresh();
    expect(got).toEqual([2]);
    expect(h.errors).toHaveLength(2);
  });

  it('dispose cancels pending work', () => {
    const h = harness([rd(1, 0, 0, 1920, 1080, 1, true)]);
    h.tracker.notify();
    h.tracker.dispose();
    expect(h.pending()).toBe(0);
    h.set([rd(1, 0, 0, 2560, 1440, 1, true)]);
    expect(h.tracker.refresh()).toBe(false);
    h.tracker.notify();
    expect(h.pending()).toBe(0);
  });
});
