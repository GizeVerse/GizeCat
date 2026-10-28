import { describe, expect, it } from 'vitest';
import type { Point, Rect } from '../../../../src/shared/geometry';
import type { WorldGeometry } from '../../../../src/shared/world';
import type { MoveGoal, MoverConfig, MoverStep } from '../../../../src/core/movement';
import { MOVEMENT, Mover } from '../../../../src/core/movement';
import { display, DUAL_FLAT, DUAL_MIXED, insideAnyWorkArea, platformsFrom, SINGLE, world } from '../behavior/fixtures';

class Driver {
  now = 0;
  windows: Record<string, Rect | null> = {};
  hiddenPlatforms = new Set<string>();
  dragCursor: Point | null = null;
  moving = new Set<string>();
  log: MoverStep[] = [];
  constructor(
    public m: Mover,
    public w: WorldGeometry,
  ) {}

  step(dt = 16): MoverStep {
    this.now += dt;
    const visible: Record<string, Rect | null> = {};
    for (const [k, v] of Object.entries(this.windows)) if (!this.hiddenPlatforms.has(k)) visible[k] = v;
    this.m.sense(platformsFrom(visible));
    const r = this.m.step({ now: this.now, dtMs: dt, dragCursor: this.dragCursor, getWindowRect: (id) => this.windows[id] ?? null, movingWindowIds: this.moving });
    this.log.push(r);
    expect(Number.isFinite(this.m.x) && Number.isFinite(this.m.y)).toBe(true);
    expect(insideAnyWorkArea(this.w, this.m.x, this.m.y, 2.5)).toBe(true);
    return r;
  }

  until(pred: (r: MoverStep) => boolean, maxMs: number, dt = 16): boolean {
    const end = this.now + maxMs;
    while (this.now < end) if (pred(this.step(dt))) return true;
    return false;
  }

  goal(g: Partial<MoveGoal> & { x: number; y: number }): void {
    this.m.setGoal({ pace: 'walk', allowJump: true, ...g });
  }
}

const CFG: MoverConfig = { size: 1, movementSpeed: 1, allowMultiMonitor: true, perchOnWindows: true };

function make(w: WorldGeometry = SINGLE, cfg: Partial<MoverConfig> = {}, start: { displayId: string | null; xFrac: number } = { displayId: '1', xFrac: 0.5 }): Driver {
  return new Driver(new Mover(w, { ...CFG, ...cfg }, start), w);
}

/** Grabs the cat at its anchor and moves it to `p` (anchor coordinates). */
function liftTo(d: Driver, p: Point): void {
  d.m.startDrag({ x: d.m.x, y: d.m.y });
  d.dragCursor = p;
  d.step();
  d.dragCursor = null;
}

describe('Mover: gravity and landing', () => {
  it('falls with constant gravity and lands exactly on the floor', () => {
    const d = make();
    liftTo(d, { x: 960, y: 300 });
    expect(d.m.held).toBe(true);
    expect(d.m.x).toBeCloseTo(960);
    expect(d.m.y).toBeCloseTo(300);
    const t0 = d.now;
    d.m.endDrag(null, { x: 0, y: 0 }, t0, true);
    const g = MOVEMENT.gravityDip;
    let landed: MoverStep['landed'] = null;
    while (!landed) {
      const r = d.step(10);
      if (r.landed) landed = r.landed;
      else {
        const s = (d.now - t0) / 1000;
        expect(d.m.y).toBeCloseTo(300 + 0.5 * g * s * s, 6);
      }
      expect(d.now - t0).toBeLessThan(2000);
    }
    expect(d.m.y).toBe(1040);
    expect(d.m.support).toEqual({ kind: 'floor', displayId: '1' });
    expect(landed.thrown).toBe(false);
    expect(landed.fallHeightDip).toBeCloseTo(740, 0);
    expect(landed.impactDip).toBeCloseTo(Math.sqrt(2 * g * 740), -1);
  });

  it('does not tunnel through a thin platform at large time steps', () => {
    const d = make();
    d.windows = { a: { x: 700, y: 700, width: 600, height: 300 } };
    liftTo(d, { x: 960, y: 100 });
    d.m.endDrag(null, { x: 0, y: 0 }, d.now, true);
    expect(d.until((r) => r.landed !== null, 3000, 250)).toBe(true);
    expect(d.m.support).toEqual({ kind: 'window', windowId: 'a' });
    expect(d.m.y).toBe(700);
  });
});

describe('Mover: jumps', () => {
  it('crouches, jumps and lands on a reachable window top, then walks to the goal', () => {
    const d = make();
    d.windows = { w: { x: 1100, y: 800, width: 500, height: 240 } };
    d.goal({ x: 1400, y: 799 });
    let crouched = false;
    let tookOff = false;
    let landedAt: Point | null = null;
    const ok = d.until((r) => {
      crouched ||= r.crouchStarted;
      tookOff ||= r.tookOff;
      if (r.landed) {
        expect(r.landed.intentional).toBe(true);
        landedAt = { x: d.m.x, y: d.m.y };
      }
      return r.goal === 'arrived';
    }, 20_000);
    expect(ok).toBe(true);
    expect(crouched && tookOff).toBe(true);
    expect(landedAt).not.toBeNull();
    expect((landedAt as unknown as Point).y).toBe(800);
    expect(d.m.support).toEqual({ kind: 'window', windowId: 'w' });
    expect(d.m.x).toBeCloseTo(1400, 0);
  });

  it('the anticipation crouch lasts MOVEMENT.crouchMs before take-off', () => {
    const d = make();
    d.windows = { w: { x: 700, y: 800, width: 500, height: 240 } };
    d.goal({ x: 950, y: 799 });
    expect(d.until((r) => r.crouchStarted, 20_000)).toBe(true);
    const t0 = d.now;
    expect(d.until((r) => r.tookOff, 2000, 10)).toBe(true);
    expect(d.now - t0).toBeGreaterThanOrEqual(MOVEMENT.crouchMs);
    expect(d.now - t0).toBeLessThan(MOVEMENT.crouchMs + 20);
  });

  it('reports unreachable for a surface higher than the maximum jump', () => {
    const d = make();
    d.windows = { w: { x: 700, y: 1040 - 500, width: 500, height: 400 } };
    d.goal({ x: 950, y: 539 });
    expect(d.until((r) => r.goal === 'unreachable', 30_000)).toBe(true);
    expect(d.log.some((r) => r.crouchStarted)).toBe(false);
    expect(d.m.support.kind).toBe('floor');
  });

  it('reaches a high window via an intermediate one', () => {
    const d = make();
    d.windows = {
      low: { x: 400, y: 740, width: 500, height: 300 },
      high: { x: 800, y: 440, width: 500, height: 300 },
    };
    d.goal({ x: 1100, y: 439 });
    expect(d.until((r) => r.goal === 'arrived', 40_000)).toBe(true);
    expect(d.m.support).toEqual({ kind: 'window', windowId: 'high' });
    expect(d.log.filter((r) => r.tookOff).length).toBe(2);
  });

  it('falls to the floor when the target window disappears mid-flight', () => {
    const d = make();
    d.windows = { w: { x: 1100, y: 750, width: 500, height: 290 } };
    d.goal({ x: 1300, y: 749 });
    expect(d.until((r) => r.tookOff, 20_000)).toBe(true);
    d.step();
    d.windows = {};
    expect(d.until((r) => r.landed !== null, 3000)).toBe(true);
    expect(d.m.support.kind).toBe('floor');
    expect(d.m.y).toBe(1040);
  });

  it('drops down from a window top toward a lower goal', () => {
    const d = make();
    d.windows = { w: { x: 800, y: 700, width: 400, height: 340 } };
    d.goal({ x: 1000, y: 699 });
    expect(d.until((r) => r.goal === 'arrived', 20_000)).toBe(true);
    d.goal({ x: 300, y: 1040 });
    expect(d.until((r) => r.goal === 'arrived', 30_000)).toBe(true);
    expect(d.m.support.kind).toBe('floor');
    expect(d.m.x).toBeCloseTo(300, 0);
  });
});

describe('Mover: perches', () => {
  function onWindow(): Driver {
    const d = make();
    d.windows = { w: { x: 800, y: 800, width: 600, height: 240 } };
    d.goal({ x: 1100, y: 799 });
    expect(d.until((r) => r.goal === 'arrived', 20_000)).toBe(true);
    d.m.setGoal(null);
    expect(d.m.perchWindowId).toBe('w');
    return d;
  }

  it('rides a moving window', () => {
    const d = onWindow();
    const x0 = d.m.x;
    for (let i = 1; i <= 10; i++) {
      d.windows.w = { x: 800 + 20 * i, y: 800 - 10 * i, width: 600, height: 240 };
      d.moving.add('w');
      d.step();
      expect(d.m.x).toBeCloseTo(x0 + 20 * i, 6);
      expect(d.m.y).toBe(800 - 10 * i);
      expect(d.m.perchWindowId).toBe('w');
    }
  });

  it.each([
    ['minimized/closed', (d: Driver) => (d.windows.w = null)],
    ['maximized', (d: Driver) => (d.windows.w = { x: 0, y: 0, width: 1920, height: 1040 })],
  ])('falls when the perch is %s', (_label, change) => {
    const d = onWindow();
    change(d);
    const r = d.step();
    expect(r.perchLost).toBe(true);
    expect(d.m.airborne).toBe(true);
    expect(d.until((s) => s.landed !== null, 3000)).toBe(true);
    expect(d.m.support.kind).toBe('floor');
  });

  it('falls when the perch stays occluded past the grace period', () => {
    const d = onWindow();
    d.hiddenPlatforms.add('w');
    const t0 = d.now;
    expect(d.until((r) => r.perchLost, 2000)).toBe(true);
    expect(d.now - t0).toBeGreaterThanOrEqual(MOVEMENT.perchGraceMs);
  });
});

describe('Mover: drag and throw', () => {
  it('keeps the grab offset while held and clamps into the world', () => {
    const d = make();
    const grab = { x: d.m.x + 10, y: d.m.y - 30 };
    d.m.startDrag(grab);
    d.dragCursor = { x: 500, y: 500 };
    d.step();
    expect(d.m.x).toBeCloseTo(490);
    expect(d.m.y).toBeCloseTo(530);
    d.dragCursor = { x: 99_999, y: -99_999 };
    d.step();
    expect(d.m.x).toBeLessThanOrEqual(1920);
    expect(d.m.y).toBeGreaterThanOrEqual(0);
  });

  it('clamps the throw speed, bounces off walls and lands on the first surface below', () => {
    const d = make();
    d.windows = { w: { x: 200, y: 700, width: 400, height: 340 } };
    liftTo(d, { x: 1600, y: 500 });
    const r = d.m.endDrag(null, { x: 9000, y: -4000 }, d.now, true);
    expect(r.speedDip).toBeCloseTo(MOVEMENT.maxThrowDip, 6);
    expect(r.thrown).toBe(true);
    expect(d.until((s) => s.landed !== null, 8000)).toBe(true);
    const landed = d.log.find((s) => s.landed)?.landed;
    expect(landed?.thrown).toBe(true);
    expect(d.m.grounded).toBe(true);
  });

  it('drops without velocity when throwing is disabled', () => {
    const d = make();
    liftTo(d, { x: 900, y: 400 });
    const r = d.m.endDrag(null, { x: 3000, y: 0 }, d.now, false);
    expect(r.speedDip).toBe(0);
    expect(d.until((s) => s.landed !== null, 3000)).toBe(true);
    expect(d.m.x).toBeCloseTo(900, 6);
  });
});

describe('Mover: multiple monitors', () => {
  it('walks across displays whose floors meet', () => {
    const d = make(DUAL_FLAT, {}, { displayId: '1', xFrac: 0.9 });
    d.goal({ x: 2300, y: 1040 });
    expect(d.until((r) => r.goal === 'arrived', 30_000)).toBe(true);
    expect(d.log.some((r) => r.tookOff || r.steppedOff)).toBe(false);
    expect(d.m.displayId).toBe('2');
    expect(d.m.support).toEqual({ kind: 'floor', displayId: '2' });
  });

  it('jumps down and up between displays with different floor heights and scale factors', () => {
    const d = make(DUAL_MIXED, {}, { displayId: '1', xFrac: 0.05 });
    d.goal({ x: -600, y: 1260 });
    expect(d.until((r) => r.goal === 'arrived', 40_000)).toBe(true);
    expect(d.m.displayId).toBe('2');
    expect(d.m.y).toBe(1260);
    expect(d.log.some((r) => r.tookOff)).toBe(true);
    d.log = [];
    d.goal({ x: 300, y: 1040 });
    expect(d.until((r) => r.goal === 'arrived', 40_000)).toBe(true);
    expect(d.m.displayId).toBe('1');
    expect(d.m.y).toBe(1040);
  });

  it('converts DIP walking speed with the scale factor of the current display', () => {
    const d = make(DUAL_MIXED, {}, { displayId: '2', xFrac: 0.2 });
    d.goal({ x: d.m.x + 1500, y: 1260 });
    let max = 0;
    d.until((r) => {
      max = Math.max(max, d.m.groundSpeed);
      return r.goal === 'arrived';
    }, 30_000);
    expect(max).toBeCloseTo(MOVEMENT.walkDip * 1.5, 3);
  });

  it('re-places the cat with a snap when its display is removed', () => {
    const d = make(DUAL_MIXED, {}, { displayId: '2', xFrac: 0.5 });
    const single = world(display('1', 0, 0, 1920, 1080, { primary: true, taskbar: 40 }));
    expect(d.m.setWorld(single)).toBe(true);
    d.w = single;
    expect(d.m.displayId).toBe('1');
    expect(d.m.y).toBe(1040);
    d.step();
  });

  it('stays on its display when multi-monitor roaming is off', () => {
    const d = make(DUAL_FLAT, { allowMultiMonitor: false }, { displayId: '1', xFrac: 0.8 });
    d.goal({ x: 2500, y: 1040 });
    expect(d.until((r) => r.goal === 'unreachable', 30_000)).toBe(true);
    expect(d.m.x).toBeLessThanOrEqual(1920 - 42 + 1e-6);
    expect(d.m.displayId).toBe('1');
  });
});

describe('Mover: facing', () => {
  it('follows velocity with hysteresis', () => {
    const d = make();
    d.goal({ x: d.m.x + 400, y: 1040 });
    d.until(() => d.m.groundSpeed > 30, 2000);
    expect(d.m.facing).toBe(1);
    d.goal({ x: d.m.x - 400, y: 1040 });
    d.step();
    // Still moving right while braking: no flip yet.
    expect(d.m.facing).toBe(1);
    expect(d.until(() => d.m.facing === -1, 3000)).toBe(true);
    expect(d.m.vx).toBeLessThan(0);
  });
});
