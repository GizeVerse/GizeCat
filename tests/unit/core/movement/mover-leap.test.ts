// v1.1.1 in the Mover, driven only through its public goal/step APIs: leap and cling onto a
// window side (RC1), a top that changes under the climbing cat (RC3), pulling up onto a tab
// strip's window top and walking onto the strip (RC6), and the user's real window layout.
import { describe, expect, it } from 'vitest';
import type { MoverConfig, MoverStep } from '../../../../src/core/movement';
import { MOVEMENT, Mover } from '../../../../src/core/movement';
import { simWorld } from '../../../../src/core/display/simWorld';
import type { Rect } from '../../../../src/shared/geometry';
import type { Surface } from '../../../../src/shared/surfaces';
import type { WorldGeometry } from '../../../../src/shared/world';
import { display, insideAnyWorkArea, ledge, SINGLE, sideId, stripId, tabStrip, topId, wall, world } from '../behavior/fixtures';
import { providerSurfaces } from './providerSurfaces';
import { SurfaceDriver } from './surfaceDriver';

const CFG: MoverConfig = { size: 1, movementSpeed: 1, allowMultiMonitor: true, perchOnWindows: true };

/** Every step stays finite and on screen. */
class Driver extends SurfaceDriver {
  override step(dt = 16): MoverStep {
    const r = super.step(dt);
    expect(Number.isFinite(this.m.x) && Number.isFinite(this.m.y)).toBe(true);
    expect(insideAnyWorkArea(this.w, this.m.x, this.m.y, 2.5)).toBe(true);
    return r;
  }
}

/** Surfaces built by the app's provider code from DWM frames (front first) on the REAL displays. */
class ProviderDriver extends Driver {
  frames: Array<[string, Rect]> = [];
  override surfaces(): Surface[] {
    return [...providerSurfaces(this.frames, this.w.displays), ...this.extra];
  }
}

/** The user's machine: 1920x1200 at 125 %, auto-hide taskbar; the sim sees it with the floor inset. */
const REAL = world(display('1', 0, 0, 1920, 1200, { primary: true, scale: 1.25 }));
const SIM = simWorld(REAL);
const LAYOUT: Record<string, Rect> = {
  claude: { x: 322, y: 122, width: 1308, height: 1001 },
  obsidian: { x: 320, y: 100, width: 1280, height: 1000 },
  docker: { x: 174, y: 150, width: 1597, height: 902 },
  crossdevice: { x: 296, y: 288, width: 404, height: 432 },
  chrome: { x: 1123, y: 113, width: 772, height: 1048 },
};

function onReal(xFrac: number, frames: Array<[string, Rect]>): ProviderDriver {
  const d = new ProviderDriver(new Mover(SIM, CFG, { displayId: '1', xFrac }), REAL);
  d.frames = frames;
  d.step();
  return d;
}

function make(w: WorldGeometry = SINGLE, xFrac = 0.25, cfg: Partial<MoverConfig> = {}): Driver {
  const d = new Driver(new Mover(w, { ...CFG, ...cfg }, { displayId: '1', xFrac }), w);
  d.step();
  return d;
}

const DT = 16;

describe('Mover: leap and cling (v1.1.1 RC1)', () => {
  it('(c) crouches, leaps on one ballistic arc, clings at the grip, climbs, pulls up and walks along the top', () => {
    // The user's Cross Device window: its sides end 485 px above the floor (at the edge of reach).
    const d = onReal(0.05, [['crossdevice', LAYOUT.crossdevice!]]);
    const m = d.m;
    const top = m.ledgeById(topId('crossdevice'))!;
    expect(top).not.toBeNull();
    const cx = (top.x0 + top.x1) / 2;
    d.goal({ x: cx, y: top.y });

    expect(d.until((r) => r.crouchStarted, 20_000, DT)).toBe(true);
    expect(m.mode).toBe('crouch');
    expect(m.facing).toBe(1);
    const feet = { x: m.x, y: m.y };
    const crouchAt = d.now;
    expect(d.until((r) => r.tookOff, 1000, DT)).toBe(true);
    expect(d.now - crouchAt).toBeGreaterThanOrEqual(MOVEMENT.crouchMs);
    expect(d.log.at(-1)?.climbStarted).toBe(true);
    // Still at the take-off point on the take-off tick: no teleport.
    expect(m.x).toBe(feet.x);
    expect(m.y).toBe(feet.y);
    expect(m.climbPhase).toBe('leap');
    expect(m.onWall).toBe(true);
    expect(m.airborne).toBe(false);
    expect(m.support).toEqual({ kind: 'surface', surfaceId: sideId('crossdevice', 'left'), surfaceKind: 'windowSide', orientation: 'wall' });

    const path = [{ x: m.x, y: m.y }];
    let clung = false;
    for (let i = 0; i < 200 && !clung; i++) {
      const r = d.step(DT);
      clung = r.clung;
      if (!clung) {
        expect(m.climbPhase).toBe('leap');
        path.push({ x: m.x, y: m.y });
      }
    }
    expect(clung).toBe(true);
    expect(path.length).toBeGreaterThan(10);
    // Continuous: bounded per-tick displacement (the arc's top speed for the highest grip) ...
    const g = MOVEMENT.gravityDip * 1.25;
    const vmax = Math.sqrt(2 * g * (MOVEMENT.wallLeapUpDip + 2 * MOVEMENT.jumpClearanceDip) * 1.25) + MOVEMENT.maxJumpAcrossDip * 1.25;
    const all = [...path, { x: m.x, y: m.y }];
    for (let i = 1; i < all.length; i++) expect(Math.hypot(all[i]!.x - all[i - 1]!.x, all[i]!.y - all[i - 1]!.y)).toBeLessThan((vmax * DT) / 1000);
    // ... on a parabola with the jumps' gravity: constant second difference of y, x linear.
    for (let i = 2; i < path.length; i++) {
      expect(path[i]!.y - 2 * path[i - 1]!.y + path[i - 2]!.y).toBeCloseTo(g * (DT / 1000) ** 2, 6);
      expect(path[i]!.x - 2 * path[i - 1]!.x + path[i - 2]!.x).toBeCloseTo(0, 6);
    }
    // Rises, then comes down a little onto the grip (caught near the top of the arc).
    const apex = Math.min(...path.map((p) => p.y));
    expect(apex).toBeLessThan(m.y);
    expect(m.y - apex).toBeLessThan(MOVEMENT.jumpClearanceDip * 1.25);
    // Clinging at the grip on the wall line, within reach of the take-off feet.
    const w = m.wall!;
    expect(m.x).toBe(w.x);
    expect(m.y).toBeGreaterThanOrEqual(w.yTop);
    expect(m.y).toBeLessThanOrEqual(w.yBottom);
    expect(feet.y - m.y).toBeLessThanOrEqual(MOVEMENT.wallLeapUpDip * 1.25 + 1e-9);
    expect(feet.y - m.y).toBeGreaterThan(CAT_STEP_PX);

    // Climbing.
    expect(m.climbPhase).toBe('climb');
    const y0 = m.y;
    const t0 = d.now;
    d.until(() => false, 1000, DT);
    expect((y0 - m.y) / ((d.now - t0) / 1000)).toBeCloseTo(MOVEMENT.climbUpDip * 1.25, 6);

    // Pull-up onto the top, never in the air on the way.
    expect(d.until((r) => r.climbEnded, 20_000, DT)).toBe(true);
    expect(d.log.some((r) => r.perchLost || r.landed !== null)).toBe(false);
    expect(m.support).toEqual({ kind: 'surface', surfaceId: topId('crossdevice'), surfaceKind: 'windowTop', orientation: 'ledge' });
    expect(m.y).toBe(top.y);
    expect(d.until((r) => r.goal === 'arrived', 20_000, DT)).toBe(true);
    expect(m.x).toBeCloseTo(cx, 0);
    // Walks along it.
    const n = d.log.length;
    d.goal({ x: top.x1 - 5, y: top.y });
    expect(d.until((r) => r.goal === 'arrived', 20_000, DT)).toBe(true);
    expect(m.x).toBeCloseTo(top.x1 - 5, 0);
    expect(d.log.slice(n).some((r) => r.tookOff || r.crouchStarted)).toBe(false);
    expect(m.navDiagnostics().climbs).toMatchObject({ leaps: 1, mounts: 0, pulledUp: 1, reversed: 0, letGo: 0 });
  });

  for (const [id, rect] of Object.entries(LAYOUT)) {
    it(`(b) from the floor the cat gets onto ${id}'s top (provider-built surfaces, app floor inset)`, () => {
      const d = onReal(0.5, [[id, rect]]);
      const top = d.m.ledgeById(topId(id))!;
      d.goal({ x: (top.x0 + top.x1) / 2, y: top.y });
      expect(d.until((r) => r.goal === 'arrived' || r.goal === 'unreachable', 90_000, DT)).toBe(true);
      expect(d.log.at(-1)?.goal).toBe('arrived');
      expect(d.m.support).toEqual({ kind: 'surface', surfaceId: topId(id), surfaceKind: 'windowTop', orientation: 'ledge' });
      expect(d.log.some((r) => r.perchLost)).toBe(false);
    });
  }

  it('offers a leap as a climb option from where it stands', () => {
    const d = onReal(0.5, [['claude', LAYOUT.claude!]]);
    const opts = d.m.climbOptions();
    expect(opts.map((o) => o.wallId).sort()).toEqual([sideId('claude', 'left'), sideId('claude', 'right')]);
    const left = opts.find((o) => o.wallId === sideId('claude', 'left'))!;
    expect(left.target.y).toBe(122);
    expect(left.startX).toBeLessThan(322);
  });

  // SINGLE (floor 1040, 1x): window x 800..1300, top 300, sides ending at 800 (240 px up: a leap).
  const HIGH = { x: 800, y: 300, width: 500, height: 500 };

  function leaping(): Driver {
    const d = make();
    d.windows = { w: { ...HIGH } };
    d.step();
    d.goal({ x: 1050, y: 300 });
    expect(d.until((r) => r.tookOff, 20_000, DT)).toBe(true);
    expect(d.m.climbPhase).toBe('leap');
    d.step(DT);
    d.step(DT);
    return d;
  }

  it('(e) the side vanishing mid-leap: it falls on from where it is, with its velocity, and lands on the floor', () => {
    const d = leaping();
    const before = { x: d.m.x, y: d.m.y, vx: d.m.vx, vy: d.m.vy };
    expect(before.vy).toBeLessThan(0);
    d.windows = {};
    const r = d.step(DT);
    expect(r.climbEnded).toBe(true);
    expect(r.perchLost).toBe(false);
    expect(d.m.airborne).toBe(true);
    expect(d.m.onWall).toBe(false);
    // Same place, same velocity: a free fall continues the arc.
    expect(d.m.x).toBe(before.x);
    expect(d.m.y).toBe(before.y);
    expect(d.m.vx).toBe(before.vx);
    expect(d.m.vy).toBe(before.vy);
    let prev = { x: d.m.x, y: d.m.y };
    let landed: MoverStep['landed'] = null;
    for (let i = 0; i < 300 && !landed; i++) {
      landed = d.step(DT).landed;
      expect(Math.hypot(d.m.x - prev.x, d.m.y - prev.y)).toBeLessThan((MOVEMENT.maxThrowDip * DT) / 1000);
      prev = { x: d.m.x, y: d.m.y };
    }
    expect(landed).not.toBeNull();
    expect(landed?.forced).toBe(false);
    expect(d.m.support).toEqual({ kind: 'floor', displayId: '1' });
    expect(d.m.y).toBe(1040);
    expect(d.m.navDiagnostics().climbs).toMatchObject({ leaps: 1, letGo: 1, pulledUp: 0 });
  });

  it('(e) a side that stops being climbable mid-leap (window pushed against the screen edge) is missed too', () => {
    const d = leaping();
    d.windows = { w: { ...HIGH, x: 0 } };
    d.step(DT);
    expect(d.m.airborne).toBe(true);
    expect(d.until((r) => r.landed !== null, 3000, DT)).toBe(true);
  });

  it('(e) a drag during the leap picks the cat out of the air like during a jump', () => {
    const d = leaping();
    d.m.startDrag({ x: d.m.x, y: d.m.y - 10 });
    expect(d.m.held).toBe(true);
    expect(d.m.onWall).toBe(false);
    expect(d.m.climbPhase).toBeNull();
    d.dragCursor = { x: 600, y: 700 };
    d.step(DT);
    d.m.endDrag(null, { x: 0, y: 0 }, d.now, true);
    d.dragCursor = null;
    expect(d.until((r) => r.landed !== null, 3000, DT)).toBe(true);
    expect(d.m.support.kind).toBe('floor');
  });

  it('a window dragged during the leap: the arc follows the moving grip and it still catches the side', () => {
    const d = leaping();
    let prev = { x: d.m.x, y: d.m.y };
    let clung = false;
    for (let i = 0; i < 100 && !clung; i++) {
      d.windows.w = { ...d.windows.w!, x: d.windows.w!.x + 4 };
      d.moving.add('w');
      clung = d.step(DT).clung;
      expect(Math.hypot(d.m.x - prev.x, d.m.y - prev.y)).toBeLessThan(40);
      prev = { x: d.m.x, y: d.m.y };
    }
    expect(clung).toBe(true);
    expect(d.m.x).toBe(d.windows.w!.x);
    expect(d.m.climbPhase).toBe('climb');
  });

  it('a window yanked far away at once mid-leap is missed: the cat falls', () => {
    const d = leaping();
    d.windows.w = { ...HIGH, x: HIGH.x + 400 };
    d.step(DT);
    expect(d.m.airborne).toBe(true);
    expect(d.until((r) => r.landed !== null, 3000, DT)).toBe(true);
    expect(d.m.support.kind).toBe('floor');
  });

  it('the behaviour may veto the leap during its crouch (cancelCrouch), as for a jump', () => {
    const d = make();
    d.windows = { w: { ...HIGH } };
    d.step();
    d.goal({ x: 1050, y: 300 });
    expect(d.until((r) => r.crouchStarted, 20_000, DT)).toBe(true);
    d.m.cancelCrouch();
    expect(d.m.grounded).toBe(true);
    d.until(() => false, 1000, DT);
    expect(d.log.some((r) => r.tookOff)).toBe(false);
    expect(d.m.support.kind).toBe('floor');
  });

  it('never leaps with climbing off or with route noClimb', () => {
    for (const [cfg, route] of [
      [{ walls: false }, 'any'],
      [{}, 'noClimb'],
    ] as const) {
      const d = make(SINGLE, 0.25, cfg);
      d.windows = { w: { ...HIGH } };
      d.step();
      expect(d.m.canReach({ x: 1050, y: 300 }, route)).toBe(false);
      d.goal({ x: 1050, y: 300, route });
      expect(d.until((r) => r.goal === 'unreachable', 30_000, DT)).toBe(true);
      expect(d.log.some((r) => r.crouchStarted)).toBe(false);
    }
    const d = make();
    d.windows = { w: { ...HIGH } };
    d.step();
    expect(d.m.canReach({ x: 1050, y: 300 })).toBe(true);
    expect(d.m.canReach({ x: 1050, y: 300 }, 'climb')).toBe(true);
  });
});

/** Highest a side may end above the feet and still be stepped onto at 1.25x. */
const CAT_STEP_PX = 64 * 1.25 * MOVEMENT.wallReachBodyHeights;

describe('Mover: the top changes under the climbing cat (v1.1.1 RC3)', () => {
  // SINGLE: window x 800..1300, top 400, sides reaching the floor (1040); its tab strip's own span
  // 1000..1150 lies beyond 1.25 body widths of both sides, on the open top edge 800..1300.
  const TOP = ledge(topId('w'), 'windowTop', 'w', 400, 800, 1300);
  const STRIP = tabStrip('w', 400, 1000, 1150, { x0: 1020, x1: 1130 }, 1080, { land: { x0: 800, x1: 1300 } });
  const sides = (topLedgeId: string): Surface[] => [wall('w', 'left', 800, 400, 1040, { topLedgeId }), wall('w', 'right', 1300, 400, 1040, { topLedgeId })];
  const withTop = (): Surface[] => [TOP, ...sides(TOP.id)];
  const withStrip = (): Surface[] => [STRIP, ...sides(STRIP.id)];

  function climbing(extra: () => Surface[], goalX = 1100): Driver {
    const d = make();
    d.extra = extra();
    d.step();
    d.goal({ x: goalX, y: 400, route: 'climb' });
    expect(d.until((r) => r.climbStarted, 20_000, DT)).toBe(true);
    d.until(() => false, 2000, DT);
    expect(d.m.climbPhase).toBe('climb');
    return d;
  }

  it('(d) a tab strip replacing the window top mid-climb: the climb still ends on top, on the strip', () => {
    const d = climbing(withTop);
    d.extra = withStrip();
    expect(d.until((r) => r.climbEnded, 30_000, DT)).toBe(true);
    expect(d.m.support).toEqual({ kind: 'surface', surfaceId: stripId('w'), surfaceKind: 'tabStrip', orientation: 'ledge' });
    expect(d.log.some((r) => r.perchLost)).toBe(false);
    expect(d.until((r) => r.goal === 'arrived', 20_000, DT)).toBe(true);
    expect(d.m.x).toBeCloseTo(1100, 0);
    expect(d.m.navDiagnostics().climbs).toMatchObject({ mounts: 1, pulledUp: 1, reversed: 0, topReResolved: 1 });
  });

  it('(d) the strip going and the window top coming back mid-climb: same', () => {
    const d = climbing(withStrip);
    d.extra = withTop();
    expect(d.until((r) => r.climbEnded, 30_000, DT)).toBe(true);
    expect(d.m.support).toEqual({ kind: 'surface', surfaceId: topId('w'), surfaceKind: 'windowTop', orientation: 'ledge' });
    expect(d.m.navDiagnostics().climbs).toMatchObject({ pulledUp: 1, reversed: 0, topReResolved: 1 });
  });

  it('(d) the top swapped during the pull-up itself: it ends on the new one', () => {
    const d = climbing(withTop);
    expect(d.until(() => d.m.climbPhase === 'pullUp', 30_000, DT)).toBe(true);
    d.extra = withStrip();
    expect(d.until((r) => r.climbEnded, 2000, DT)).toBe(true);
    expect(d.m.support).toEqual({ kind: 'surface', surfaceId: stripId('w'), surfaceKind: 'tabStrip', orientation: 'ledge' });
  });

  it('(d) the top briefly unlisted at the corner: it waits there (grace) and pulls up when it is back', () => {
    const d = climbing(withTop);
    const yTop = d.m.wall!.yTop;
    expect(d.until(() => d.m.y - yTop < 20, 30_000, DT)).toBe(true);
    d.hidden.add(TOP.id);
    expect(d.until(() => d.m.y <= yTop + 1e-9, 2000, DT)).toBe(true);
    d.until(() => false, MOVEMENT.perchGraceMs - 100, DT);
    expect(d.m.climbPhase).toBe('climb');
    expect(d.m.y).toBe(yTop);
    d.hidden.delete(TOP.id);
    expect(d.until((r) => r.climbEnded, 2000, DT)).toBe(true);
    expect(d.m.support).toEqual({ kind: 'surface', surfaceId: TOP.id, surfaceKind: 'windowTop', orientation: 'ledge' });
    expect(d.m.navDiagnostics().climbs.reversed).toBe(0);
  });

  it('(d) the top gone for longer than the grace: it climbs back down (counted as reversed)', () => {
    const d = climbing(withTop);
    d.hidden.add(TOP.id);
    expect(d.until(() => d.m.grounded, 60_000, DT)).toBe(true);
    expect(d.m.support.kind).toBe('floor');
    expect(d.m.navDiagnostics().climbs).toMatchObject({ reversed: 1, pulledUp: 0 });
  });

  it('(d) the window closed mid-climb: it lets go safely and lands on the floor', () => {
    const d = climbing(withTop);
    d.extra = [];
    const r = d.step(DT);
    expect(r.supportLost).toEqual({ reason: 'gone', surfaceId: sideId('w', 'left'), surfaceKind: 'windowSide', fell: true });
    expect(d.m.airborne).toBe(true);
    expect(d.until((s) => s.landed !== null, 3000, DT)).toBe(true);
    expect(d.m.support.kind).toBe('floor');
    expect(d.m.navDiagnostics().climbs.letGo).toBe(1);
  });
});

describe('Mover: onto a tab strip via its window top (v1.1.1 RC6)', () => {
  const STRIP = tabStrip('w', 400, 1000, 1150, { x0: 1020, x1: 1130 }, 1080, { land: { x0: 800, x1: 1300 } });
  const sides: Surface[] = [wall('w', 'left', 800, 400, 1040, { topLedgeId: STRIP.id }), wall('w', 'right', 1300, 400, 1040, { topLedgeId: STRIP.id })];

  function pulledUp(cfg: Partial<MoverConfig> = {}, xFrac = 0.25): Driver {
    const d = make(SINGLE, xFrac, cfg);
    d.extra = [STRIP, ...sides];
    d.step();
    d.goal({ x: 1100, y: 400, route: 'climb' });
    expect(d.until((r) => r.climbEnded, 40_000, DT)).toBe(true);
    return d;
  }

  it('(f) pulls up at the corner onto the window top beside the strip, then walks onto the strip (no snap)', () => {
    const d = pulledUp();
    expect(d.m.support).toEqual({ kind: 'surface', surfaceId: STRIP.id, surfaceKind: 'tabStrip', orientation: 'ledge' });
    // Just inside the left corner, outside the strip's own span.
    expect(d.m.x).toBeCloseTo(842, 6);
    expect(d.m.y).toBe(400);
    let prev = d.m.x;
    const maxStep = (MOVEMENT.walkDip * DT) / 1000 + 1e-9;
    expect(
      d.until((r) => {
        expect(Math.abs(d.m.x - prev)).toBeLessThanOrEqual(maxStep);
        prev = d.m.x;
        expect(r.perchLost).toBe(false);
        return r.goal === 'arrived';
      }, 20_000, DT),
    ).toBe(true);
    expect(d.m.x).toBeCloseTo(1100, 0);
    expect(d.m.support.kind).toBe('surface');
  });

  it('(f) with no goal left it still walks onto the strip and stays there', () => {
    const d = pulledUp();
    d.m.setGoal(null);
    expect(d.until(() => d.m.x >= 1000 - 1e-6, 10_000, DT)).toBe(true);
    d.until(() => false, 2000, DT);
    expect(d.m.x).toBeCloseTo(1000, 6);
    expect(d.m.groundSpeed).toBe(0);
    expect(d.m.support).toEqual({ kind: 'surface', surfaceId: STRIP.id, surfaceKind: 'tabStrip', orientation: 'ledge' });
    expect(d.log.some((r) => r.perchLost)).toBe(false);
  });

  it('(f) dropped onto the window top beside the strip, it lands where it touches down and walks onto the strip', () => {
    const d = make();
    d.extra = [STRIP, ...sides];
    d.step();
    d.m.startDrag({ x: d.m.x, y: d.m.y });
    d.dragCursor = { x: 870, y: 300 };
    d.until(() => false, 400, DT);
    d.m.endDrag(null, { x: 0, y: 0 }, d.now, false);
    d.dragCursor = null;
    const x = d.m.x;
    expect(x).toBeLessThan(1000);
    expect(d.until((r) => r.landed !== null, 3000, DT)).toBe(true);
    expect(d.m.support).toEqual({ kind: 'surface', surfaceId: STRIP.id, surfaceKind: 'tabStrip', orientation: 'ledge' });
    expect(d.m.x).toBeCloseTo(x, 6);
    expect(d.until(() => d.m.x >= 1000 - 1e-6, 10_000, DT)).toBe(true);
  });

  it('climbs down from the strip at the corner on the window top beside it', () => {
    // A cat that hates jumping (a drop off the strip's end is otherwise the quicker way down).
    const d = pulledUp({ jumpEffort: 5 });
    d.until((r) => r.goal === 'arrived', 20_000, DT);
    const down = d.m.climbOptions().find((o) => o.dir === 'down' && o.wallId === sideId('w', 'left'));
    expect(down?.startX).toBeCloseTo(842, 6);
    d.goal({ x: 500, y: 1040, route: 'climb' });
    expect(d.until((r) => r.climbStarted, 20_000, DT)).toBe(true);
    expect(d.m.climbPhase).toBe('swing');
    expect(d.log.some((r) => r.perchLost)).toBe(false);
    expect(d.until((r) => r.goal === 'arrived', 30_000, DT)).toBe(true);
    expect(d.m.support.kind).toBe('floor');
  });

  /**
   * A floor goal while the cat stands beside the strip (its quickest way down is the strip's drop):
   * it steps off within a few seconds, moving no more than a walk per tick on the way, then gets
   * to the floor. (v1.1.1 review MC-1: it walked to strip.x0 - bodyWidth and stalled there, or
   * was snapped to the strip's end before falling.)
   */
  function stepsOffToFloor(d: Driver, goalX: number): void {
    d.goal({ x: goalX, y: 1040 });
    const maxStep = (MOVEMENT.walkDip * DT) / 1000 + 1e-9;
    let prev = d.m.x;
    expect(
      d.until((r) => {
        expect(Math.abs(d.m.x - prev)).toBeLessThanOrEqual(maxStep);
        prev = d.m.x;
        return r.steppedOff;
      }, 3000, DT),
    ).toBe(true);
    expect(d.until((r) => r.goal === 'arrived', 30_000, DT)).toBe(true);
    expect(d.m.support.kind).toBe('floor');
  }

  it('a floor goal right after the pull-up at the left corner: steps off from beside the strip', () => {
    const d = pulledUp();
    expect(d.m.x).toBeLessThan(1000 - d.m.bodyWidth);
    stepsOffToFloor(d, 300);
  });

  it('a floor goal right after the pull-up at the right corner: steps off from beside the strip', () => {
    const d = pulledUp({}, 0.75);
    expect(d.m.support).toEqual({ kind: 'surface', surfaceId: STRIP.id, surfaceKind: 'tabStrip', orientation: 'ledge' });
    expect(d.m.x).toBeGreaterThan(1150 + d.m.bodyWidth);
    stepsOffToFloor(d, 1700);
  });

  it('a floor goal while walking in, within a body width of the strip: no snap to the strip end', () => {
    const d = pulledUp();
    d.m.setGoal(null);
    expect(d.until(() => d.m.x > 1000 - d.m.bodyWidth / 2, 10_000, DT)).toBe(true);
    expect(d.m.x).toBeLessThan(1000);
    stepsOffToFloor(d, 300);
  });

  it('a floor goal right after being dropped onto the window top beside the strip: steps off from there', () => {
    const d = make();
    d.extra = [STRIP, ...sides];
    d.step();
    d.m.startDrag({ x: d.m.x, y: d.m.y });
    d.dragCursor = { x: 870, y: 300 };
    d.until(() => false, 400, DT);
    d.m.endDrag(null, { x: 0, y: 0 }, d.now, false);
    d.dragCursor = null;
    expect(d.until((r) => r.landed !== null, 3000, DT)).toBe(true);
    expect(d.m.support).toEqual({ kind: 'surface', surfaceId: STRIP.id, surfaceKind: 'tabStrip', orientation: 'ledge' });
    expect(d.m.x).toBeLessThan(1000 - d.m.bodyWidth);
    stepsOffToFloor(d, 300);
  });
});

describe('Mover: set down on a tab strip\'s window top beside the strip (v1.1.1 review MC-2, MC-3)', () => {
  const maxStep = (MOVEMENT.walkDip * DT) / 1000 + 1e-9;

  /** Drags the cat from the floor and lets go above (x, y): it lands on what is below. */
  function dropAt(d: Driver, x: number, y: number): void {
    d.m.startDrag({ x: d.m.x, y: d.m.y });
    d.dragCursor = { x, y };
    d.until(() => false, 400, DT);
    d.m.endDrag(null, { x: 0, y: 0 }, d.now, false);
    d.dragCursor = null;
    expect(d.until((r) => r.landed !== null, 3000, DT)).toBe(true);
  }

  /** It walks onto the strip's stand range [x0, ...] at walking speed, staying on the strip. */
  function walksInTo(d: Driver, x0: number, surfaceId: string): void {
    let prev = d.m.x;
    expect(
      d.until((r) => {
        expect(Math.abs(d.m.x - prev)).toBeLessThanOrEqual(maxStep);
        prev = d.m.x;
        expect(r.perchLost).toBe(false);
        return d.m.x >= x0 - 1e-6;
      }, 10_000, DT),
    ).toBe(true);
    expect(d.m.support).toMatchObject({ surfaceId });
  }

  it('climbing down a side whose foot ends on a browser\'s top beside its strip: steps off beside the side, no glide', () => {
    // Window B (behind) 900..1400, top 200; its left side is cut at y = 500 by browser A in front
    // (A 800..1500, top 500, strip 1100..1300 on A's open top edge).
    const B_TOP = ledge(topId('b'), 'windowTop', 'b', 200, 900, 1400);
    const B_LEFT = wall('b', 'left', 900, 200, 500);
    const A_STRIP = tabStrip('a', 500, 1100, 1300, null, null, { land: { x0: 800, x1: 1500 } });
    const d = make(SINGLE, 0.25, { jumpEffort: 5 });
    d.extra = [B_TOP, B_LEFT, A_STRIP];
    d.step();
    dropAt(d, 1000, 60);
    expect(d.m.support).toMatchObject({ surfaceId: B_TOP.id });
    d.goal({ x: 1200, y: 500, route: 'climb' });
    // The dismount eases from the wall line to beside it (0.55 body widths): at most 1.5x its mean speed.
    const standX = 900 - 0.55 * d.m.bodyWidth;
    const maxDismountStep = (1.5 * (900 - standX) * DT) / MOVEMENT.dismountMs + 1e-6;
    let prev = d.m.x;
    let sawDismount = false;
    expect(
      d.until((r) => {
        if (d.m.climbPhase === 'dismount') {
          sawDismount = true;
          expect(Math.abs(d.m.x - prev)).toBeLessThanOrEqual(maxDismountStep);
        }
        prev = d.m.x;
        return r.climbEnded && sawDismount;
      }, 60_000, DT),
    ).toBe(true);
    expect(d.m.support).toMatchObject({ surfaceId: A_STRIP.id });
    expect(d.m.x).toBeCloseTo(standX, 6);
    walksInTo(d, 1100, A_STRIP.id);
    expect(d.until((r) => r.goal === 'arrived', 20_000, DT)).toBe(true);
    expect(d.m.x).toBeCloseTo(1200, 0);
  });

  it('set down calmly from a window top switched off onto a browser\'s top beside its strip: stays where it is', () => {
    const C_TOP = ledge(topId('c'), 'windowTop', 'c', 480, 700, 1000);
    const A_STRIP = tabStrip('a', 500, 1100, 1300, null, null, { land: { x0: 800, x1: 1500 } });
    const d = make();
    d.extra = [C_TOP, A_STRIP];
    d.step();
    dropAt(d, 850, 380);
    expect(d.m.support).toMatchObject({ surfaceId: C_TOP.id });
    const x = d.m.x;
    d.m.setConfig({ ...CFG, perchOnWindows: false });
    const r = d.step(DT);
    expect(r.lowered).toBe(true);
    expect(r.supportLost).toMatchObject({ reason: 'disabled', fell: false });
    expect(d.m.support).toMatchObject({ surfaceId: A_STRIP.id });
    expect(d.m.x).toBeCloseTo(x, 6);
    walksInTo(d, 1100, A_STRIP.id);
  });

  it('a browser top dragged up under a perched cat lifts it where it is, then it walks onto the strip', () => {
    const A_TOP = ledge(topId('a'), 'windowTop', 'a', 600, 200, 900);
    const strip = (y: number): Surface => tabStrip('b', y, 700, 900, null, null, { land: { x0: 300, x1: 1200 } });
    const d = make();
    d.extra = [A_TOP, strip(640)];
    d.step();
    dropAt(d, 400, 450);
    expect(d.m.support).toMatchObject({ surfaceId: A_TOP.id });
    d.until(() => false, 200, DT);
    // B (a browser) dragged up 10 px per tick through A's top under the cat.
    let lifted = false;
    for (let y = 630; y >= 590 && !lifted; y -= 10) {
      d.extra = [A_TOP, strip(y)];
      d.moving.add('b');
      const x = d.m.x;
      lifted = d.step(DT).lifted !== null;
      // Lifted where it is: no sideways jump into the strip's stand range (700..900).
      expect(Math.abs(d.m.x - x)).toBeLessThanOrEqual(maxStep);
    }
    expect(d.m.x).toBeLessThan(700);
    expect(lifted).toBe(true);
    expect(d.m.support).toMatchObject({ surfaceId: stripId('b') });
    d.moving.clear();
    walksInTo(d, 700, stripId('b'));
  });
});
