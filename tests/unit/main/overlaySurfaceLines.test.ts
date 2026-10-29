// v1.1.1 on-desktop surface outlines in main: px -> overlay-local DIP with the cat's own
// mapping (scale 1.25, displays with non-zero and negative origins), per-display
// filtering, and the 4 Hz driver that sends frames only while the session toggle is on.
import { describe, expect, it } from 'vitest';
import { pxToLocalDip } from '../../../src/core/display/displayMath';
import { createSurfaceOutlines, SURFACE_LINES_INTERVAL_MS, surfaceLinesForDisplay, type SurfaceLinesSink } from '../../../src/main/overlay/surfaceLines';
import { MAX_DEBUG_LINES, type SurfaceDebugLine } from '../../../src/shared/surfaceDiagnostics';
import type { DisplayGeometry } from '../../../src/shared/world';
import { memoryLogger } from './helpers';

/** A 125 % monitor right of a 100 % primary, its work area starting 40 px below the top (taskbar on top). */
const right: DisplayGeometry = {
  id: 'R',
  primary: false,
  scaleFactor: 1.25,
  boundsDip: { x: 1920, y: 0, width: 1536, height: 960 },
  workAreaDip: { x: 1920, y: 32, width: 1536, height: 928 },
  boundsPx: { x: 1920, y: 0, width: 1920, height: 1200 },
  workAreaPx: { x: 1920, y: 40, width: 1920, height: 1160 },
};
/** A 150 % monitor left of the primary (negative origin). */
const left: DisplayGeometry = {
  id: 'L',
  primary: false,
  scaleFactor: 1.5,
  boundsDip: { x: -1280, y: -100, width: 1280, height: 720 },
  workAreaDip: { x: -1280, y: -100, width: 1280, height: 720 },
  boundsPx: { x: -1920, y: -150, width: 1920, height: 1080 },
  workAreaPx: { x: -1920, y: -150, width: 1920, height: 1080 },
};

const seg = (x0: number, y0: number, x1: number, y1: number, over: Partial<SurfaceDebugLine> = {}): SurfaceDebugLine => ({ kind: 'windowTop', role: 'valid', x0, y0, x1, y1, ...over });

describe('surface outlines: px -> overlay-local DIP', () => {
  it('uses the display mapping of the cat render state, at scale 1.25 and a non-zero origin', () => {
    const toLocal = (p: { x: number; y: number }) => pxToLocalDip(right, p);
    const out = surfaceLinesForDisplay([seg(2045, 290, 3045, 290, { kind: 'tabStrip', role: 'target' })], right.workAreaPx, toLocal);
    // (2045 - 1920) / 1.25 = 100, (290 - 40) / 1.25 = 200, (3045 - 1920) / 1.25 = 900.
    expect(out).toEqual([{ kind: 'tabStrip', role: 'target', x0: 100, y0: 200, x1: 900, y1: 200 }]);
  });

  it('maps a vertical side on a display with a negative origin at 150 %', () => {
    const out = surfaceLinesForDisplay([seg(-1020, 0, -1020, 600, { kind: 'windowSide', role: 'reachable' })], left.workAreaPx, (p) => pxToLocalDip(left, p));
    expect(out).toEqual([{ kind: 'windowSide', role: 'reachable', x0: 600, y0: 100, x1: 600, y1: 500 }]);
  });

  it('keeps only segments that touch the display (spanning ones go to both) and drops non-finite ones', () => {
    const lines = [seg(100, 500, 900, 500), seg(1800, 700, 2100, 700, { role: 'support' }), seg(2500, 600, 2600, 600, { kind: 'floor' }), seg(Number.NaN, 1, 2, 3)];
    const onRight = surfaceLinesForDisplay(lines, right.workAreaPx, (p) => pxToLocalDip(right, p));
    expect(onRight.map((l) => l.role + ':' + l.kind)).toEqual(['support:windowTop', 'valid:floor']);
    expect(onRight[0]).toMatchObject({ x0: -96, x1: 144 });
    const primaryWa = { x: 0, y: 0, width: 1920, height: 1200 };
    expect(surfaceLinesForDisplay(lines, primaryWa, (p) => p)).toHaveLength(2);
  });

  it('never returns more than MAX_DEBUG_LINES segments', () => {
    const many = Array.from({ length: MAX_DEBUG_LINES + 50 }, (_, i) => seg(2000 + i, 100, 2100 + i, 100));
    expect(surfaceLinesForDisplay(many, right.workAreaPx, (p) => pxToLocalDip(right, p))).toHaveLength(MAX_DEBUG_LINES);
  });
});

function fakeTimers() {
  let now = 0;
  let nextId = 1;
  const intervals = new Map<number, { every: number; next: number; fn: () => void }>();
  return {
    timers: {
      setInterval: (fn: () => void, ms: number): unknown => {
        const id = nextId++;
        intervals.set(id, { every: ms, next: now + ms, fn });
        return id;
      },
      clearInterval: (h: unknown) => {
        intervals.delete(h as number);
      },
    },
    get active() {
      return intervals.size;
    },
    advance(ms: number) {
      const end = now + ms;
      for (;;) {
        const due = [...intervals.values()].filter((t) => t.next <= end).sort((a, b) => a.next - b.next)[0];
        if (!due) break;
        now = due.next;
        due.next += due.every;
        due.fn();
      }
      now = end;
    },
  };
}

function recordingSink() {
  const frames: Array<{ at: string; lines: readonly SurfaceDebugLine[]; quiet?: readonly string[] | undefined }> = [];
  let clears = 0;
  const sink: SurfaceLinesSink = {
    renderSurfaceLines: (lines, quiet) => frames.push({ at: 'render', lines, quiet }),
    clearSurfaceLines: () => {
      clears++;
    },
  };
  return {
    sink,
    frames,
    get clears() {
      return clears;
    },
  };
}

describe('surface outlines driver', () => {
  it('sends nothing and runs no timer while off (the default)', () => {
    const t = fakeTimers();
    const rec = recordingSink();
    let reads = 0;
    const outlines = createSurfaceOutlines({
      getLines: () => {
        reads++;
        return [seg(0, 0, 10, 0)];
      },
      sink: rec.sink,
      logger: memoryLogger(),
      timers: t.timers,
    });
    expect(outlines.enabled).toBe(false);
    t.advance(10_000);
    expect(t.active).toBe(0);
    expect(reads).toBe(0);
    expect(rec.frames).toEqual([]);
    expect(rec.clears).toBe(0);
  });

  it('sends a frame at once and then at most 4 per second while on; one clearing frame when turned off, then silence', () => {
    const t = fakeTimers();
    const rec = recordingSink();
    const outlines = createSurfaceOutlines({ getLines: () => [seg(0, 0, 10, 0)], sink: rec.sink, logger: memoryLogger(), timers: t.timers, intervalMs: 10 });
    outlines.setEnabled(true);
    expect(outlines.enabled).toBe(true);
    expect(rec.frames).toHaveLength(1);
    t.advance(1000);
    // A shorter interval is not honoured: 1 immediate + 4 per second.
    expect(SURFACE_LINES_INTERVAL_MS).toBe(250);
    expect(rec.frames).toHaveLength(5);
    outlines.setEnabled(true);
    t.advance(1000);
    expect(rec.frames).toHaveLength(9);
    outlines.setEnabled(false);
    expect(outlines.enabled).toBe(false);
    expect(rec.clears).toBe(1);
    t.advance(10_000);
    expect(rec.frames).toHaveLength(9);
    expect(t.active).toBe(0);
    outlines.setEnabled(false);
    expect(rec.clears).toBe(1);
  });

  it('hands each frame the displays to keep clear (a fullscreen app in front), read fresh every frame', () => {
    const t = fakeTimers();
    const rec = recordingSink();
    let quiet: string[] = ['2'];
    const outlines = createSurfaceOutlines({ getLines: () => [seg(0, 0, 10, 0)], getQuietDisplayIds: () => quiet, sink: rec.sink, logger: memoryLogger(), timers: t.timers });
    outlines.setEnabled(true);
    quiet = [];
    t.advance(250);
    expect(rec.frames.map((f) => f.quiet)).toEqual([['2'], []]);
    // Without a source: none.
    const plain = recordingSink();
    const other = createSurfaceOutlines({ getLines: () => [], sink: plain.sink, logger: memoryLogger(), timers: fakeTimers().timers });
    other.setEnabled(true);
    expect(plain.frames[0]!.quiet).toEqual([]);
    other.dispose();
    outlines.dispose();
  });

  it('caps every frame at MAX_DEBUG_LINES and contains a failing source', () => {
    const t = fakeTimers();
    const rec = recordingSink();
    const log = memoryLogger();
    let fail = false;
    const outlines = createSurfaceOutlines({
      getLines: () => {
        if (fail) throw new Error('no world');
        return Array.from({ length: MAX_DEBUG_LINES + 10 }, (_, i) => seg(i, 0, i + 1, 0));
      },
      sink: rec.sink,
      logger: log,
      timers: t.timers,
    });
    outlines.setEnabled(true);
    expect(rec.frames[0]!.lines).toHaveLength(MAX_DEBUG_LINES);
    fail = true;
    t.advance(250);
    expect(log.entries.some((e) => e.level === 'warn' && e.msg === 'surface outlines frame failed')).toBe(true);
    outlines.dispose();
    expect(t.active).toBe(0);
  });
});
