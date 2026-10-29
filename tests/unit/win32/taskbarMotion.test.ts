// Pure taskbar geometry and the per-taskbar motion state machine (SIMULATED sample sequences).
import { describe, expect, it } from 'vitest';
import {
  distanceFromEdge,
  dockedRectFor,
  edgeFromAbe,
  edgeSign,
  inferEdge,
  onScreenExtent,
  spanOnMonitor,
  visibleEdgeAt,
  workAreaReachesEdge,
} from '../../../src/main/win32/taskbar/geometry';
import { TaskbarMotion } from '../../../src/main/win32/taskbar/motion';

const MON = { left: 0, top: 0, right: 1920, bottom: 1200 };
// Measured on the probe machine (125 %): Explorer moves the 60 px window and leaves 2 px on screen.
const BOTTOM_HIDDEN = { left: 0, top: 1198, right: 1920, bottom: 1258 };
const BOTTOM_SHOWN = { left: 0, top: 1140, right: 1920, bottom: 1200 };

describe('taskbar geometry', () => {
  it('infers the docked side from the rect, shown or auto-hidden', () => {
    expect(inferEdge(BOTTOM_SHOWN, MON)).toBe('bottom');
    expect(inferEdge(BOTTOM_HIDDEN, MON)).toBe('bottom');
    expect(inferEdge({ left: 0, top: -58, right: 1920, bottom: 2 }, MON)).toBe('top');
    expect(inferEdge({ left: 0, top: 0, right: 1920, bottom: 60 }, MON)).toBe('top');
    expect(inferEdge({ left: -58, top: 0, right: 2, bottom: 1200 }, MON)).toBe('left');
    expect(inferEdge({ left: 1918, top: 0, right: 1978, bottom: 1200 }, MON)).toBe('right');
    // A monitor that is not at the origin.
    const second = { left: 1920, top: -200, right: 3840, bottom: 880 };
    expect(inferEdge({ left: 1920, top: 878, right: 3840, bottom: 926 }, second)).toBe('bottom');
  });

  it('measures the on-screen extent along the normal axis', () => {
    expect(onScreenExtent(BOTTOM_HIDDEN, MON, 'bottom', 60)).toBe(2);
    expect(onScreenExtent(BOTTOM_SHOWN, MON, 'bottom', 60)).toBe(60);
    expect(onScreenExtent({ left: 0, top: 1170, right: 1920, bottom: 1230 }, MON, 'bottom', 60)).toBe(30);
    expect(onScreenExtent({ left: 0, top: 1300, right: 1920, bottom: 1360 }, MON, 'bottom', 60)).toBe(0);
    expect(onScreenExtent({ left: -58, top: 0, right: 2, bottom: 1200 }, MON, 'left', 60)).toBe(2);
    expect(onScreenExtent({ left: 1890, top: 0, right: 1950, bottom: 1200 }, MON, 'right', 60)).toBe(30);
  });

  it('maps extents to the visible inner edge and its direction', () => {
    expect(visibleEdgeAt(MON, 'bottom', 60)).toBe(1140);
    expect(visibleEdgeAt(MON, 'top', 60)).toBe(60);
    expect(visibleEdgeAt(MON, 'left', 2)).toBe(2);
    expect(visibleEdgeAt(MON, 'right', 60)).toBe(1860);
    expect([edgeSign('bottom'), edgeSign('top'), edgeSign('left'), edgeSign('right')]).toEqual([-1, 1, 1, -1]);
  });

  it('builds docked rects, spans, edge distances and the work-area auto-hide test', () => {
    expect(dockedRectFor(BOTTOM_HIDDEN, MON, 'bottom', 60)).toEqual(BOTTOM_SHOWN);
    expect(dockedRectFor({ left: -58, top: 0, right: 2, bottom: 1200 }, MON, 'left', 60)).toEqual({ left: 0, top: 0, right: 60, bottom: 1200 });
    expect(spanOnMonitor({ left: -10, top: 1140, right: 2000, bottom: 1200 }, MON, 'bottom')).toEqual([0, 1920]);
    expect(distanceFromEdge({ x: 5, y: 1199 }, MON, 'bottom')).toBe(0);
    expect(distanceFromEdge({ x: 5, y: 1190 }, MON, 'bottom')).toBe(9);
    expect(distanceFromEdge({ x: 5, y: 1200 }, MON, 'bottom')).toBeNull();
    expect(distanceFromEdge({ x: 0, y: 500 }, MON, 'left')).toBe(0);
    expect(workAreaReachesEdge(MON, MON, 'bottom')).toBe(true);
    expect(workAreaReachesEdge(MON, { ...MON, bottom: 1140 }, 'bottom')).toBe(false);
    expect(workAreaReachesEdge(MON, { ...MON, bottom: 1140 }, 'top')).toBe(true);
    expect([0, 1, 2, 3, 9].map(edgeFromAbe)).toEqual(['left', 'top', 'right', 'bottom', null]);
  });
});

describe('taskbar motion state machine', () => {
  it('classifies hidden, shown and the moving phases, with speed from successive samples', () => {
    const m = new TaskbarMotion();
    m.update(0, 2, 60);
    expect(m.snapshot()).toMatchObject({ phase: 'hidden', extent: 2, extentSpeed: 0, inferred: false });
    // Observed slide-in at 60 Hz: 6 px per 16 ms.
    const seen: string[] = [];
    let t = 0;
    for (let e = 8; e <= 56; e += 6) {
      t += 16;
      m.update(t, e, 60);
      seen.push(m.snapshot().phase);
      expect(m.snapshot().extentSpeed).toBeCloseTo((6 / 16) * 1000, 5);
      expect(m.snapshot().inferred).toBe(false);
    }
    expect(new Set(seen)).toEqual(new Set(['showing']));
    t += 16;
    m.update(t, 60, 60);
    expect(m.snapshot().phase).toBe('shown');
    t += 250;
    m.update(t, 60, 60);
    expect(m.snapshot()).toMatchObject({ phase: 'shown', extentSpeed: 0, fraction: 1 });
    // Slide out.
    t += 16;
    m.update(t, 54, 60);
    expect(m.snapshot().phase).toBe('hiding');
    expect(m.snapshot().extentSpeed).toBeLessThan(0);
    t += 16;
    m.update(t, 3, 60); // jump to the strip: eased
    t += 200;
    m.update(t, 2, 60);
    expect(m.snapshot().phase).toBe('hidden');
  });

  it('holds the speed between Explorer frames sampled faster than they arrive (measured ~31 ms steps)', () => {
    // REAL slide-out shape (probe, 2026-10-29): ~4-5 px every ~31 ms, sampled every 16 ms.
    const m = new TaskbarMotion();
    m.update(0, 60, 60);
    let t = 0;
    let extent = 60;
    const speeds: number[] = [];
    for (let frame = 0; frame < 10; frame++) {
      for (const dt of [16, 15]) {
        t += dt;
        if (dt === 15) extent -= 4.5;
        m.update(t, extent, 60);
        // The first step after rest is divided by the sample interval (nothing better is known).
        if (frame >= 2) speeds.push(m.snapshot().extentSpeed);
      }
    }
    // Never back to 0 mid-slide; each step of 4.5 px per 31 ms is one consistent speed.
    expect(speeds.every((s) => s < 0)).toBe(true);
    for (const s of speeds) expect(s).toBeCloseTo((-4.5 / 31) * 1000, 5);
    expect(m.snapshot().phase).toBe('hiding');
    // At rest the held speed expires.
    m.update(t + 16, extent, 60);
    m.update(t + 70, extent, 60);
    expect(m.snapshot().extentSpeed).toBe(0);
  });

  it('keeps the direction while momentarily still between hidden and shown', () => {
    const m = new TaskbarMotion();
    m.update(0, 60, 60);
    m.update(16, 50, 60);
    m.update(32, 50, 60);
    expect(m.snapshot().phase).toBe('hiding');
    const n = new TaskbarMotion();
    n.update(0, 2, 60);
    n.update(16, 10, 60);
    n.update(32, 10, 60);
    expect(n.snapshot().phase).toBe('showing');
  });

  it('eases an unobserved jump over 150 ms and marks it inferred', () => {
    const m = new TaskbarMotion();
    m.update(0, 2, 60);
    m.update(250, 60, 60); // idle sample: the whole slide happened in between
    expect(m.snapshot()).toMatchObject({ extent: 2, measured: 60, inferred: true });
    expect(m.snapshot().extentSpeed).toBeCloseTo((58 / 150) * 1000, 5);
    m.update(325, 60, 60);
    expect(m.snapshot().extent).toBeCloseTo(31, 5);
    expect(m.snapshot().phase).toBe('showing');
    m.update(400, 60, 60);
    expect(m.snapshot()).toMatchObject({ extent: 60, inferred: false, phase: 'shown' });
  });

  it('retargets an ease on small corrections and restarts it from the current position on a new jump', () => {
    const m = new TaskbarMotion();
    m.update(0, 2, 60);
    m.update(100, 60, 60);
    m.update(175, 56, 60); // small correction mid-ease
    expect(m.snapshot().extent).toBeCloseTo(2 + (56 - 2) * 0.5, 5);
    m.update(190, 2, 60); // jumps back before the ease finished
    const at = m.snapshot().extent;
    expect(m.snapshot().inferred).toBe(true);
    m.update(206, 2, 60);
    expect(m.snapshot().extent).toBeLessThan(at);
    m.update(400, 2, 60);
    expect(m.snapshot()).toMatchObject({ extent: 2, phase: 'hidden', inferred: false });
  });

  it('clamps measurements to the thickness and hides on demand', () => {
    const m = new TaskbarMotion();
    m.update(0, 90, 60);
    expect(m.snapshot()).toMatchObject({ extent: 60, fraction: 1, phase: 'shown' });
    m.hide(16);
    m.update(400, 0, 60);
    expect(m.snapshot()).toMatchObject({ extent: 0, phase: 'hidden' });
  });
});
