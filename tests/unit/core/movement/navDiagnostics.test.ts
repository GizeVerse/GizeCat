// v1.1.1 nav diagnostics of the Mover: what it received, accepted and turned down (by kind and
// reason), what is reachable from where the cat is, graph size, climb outcomes, and the debug
// visualization segments (physical px, roles, no ids).
import { describe, expect, it } from 'vitest';
import type { MoverConfig } from '../../../../src/core/movement';
import { Mover } from '../../../../src/core/movement';
import type { Surface } from '../../../../src/shared/surfaces';
import { MAX_DEBUG_LINES } from '../../../../src/shared/surfaceDiagnostics';
import type { WorldGeometry } from '../../../../src/shared/world';
import { DUAL_FLAT, ledge, SINGLE, sideId, tabStrip, taskbar, topId, wall } from '../behavior/fixtures';
import { SurfaceDriver } from './surfaceDriver';

const CFG: MoverConfig = { size: 1, movementSpeed: 1, allowMultiMonitor: true, perchOnWindows: true };

function make(w: WorldGeometry = SINGLE, cfg: Partial<MoverConfig> = {}, xFrac = 0.25): SurfaceDriver {
  return new SurfaceDriver(new Mover(w, { ...CFG, ...cfg }, { displayId: '1', xFrac }), w);
}

// SINGLE: 1920x1080 at 1x, floor 1040; body 84 x 64 px.
const A = ledge(topId('a'), 'windowTop', 'a', 800, 400, 900); // 240 px up: a jump
const H = ledge(topId('h'), 'windowTop', 'h', 300, 1400, 1800); // 740 px up: only via its side
const H_LEFT = wall('h', 'left', 1400, 300, 800); // ends 240 px above the floor: a leap
const K = ledge(topId('k'), 'windowTop', 'k', 200, 100, 350); // 840 px up, no side: unreachable
const REJECTS: Surface[] = [
  ledge(topId('top'), 'windowTop', 'top', 20, 600, 900), // noHeadroom
  ledge(topId('low'), 'windowTop', 'low', 1020, 1000, 1400), // nearFloor
  ledge(topId('thin'), 'windowTop', 'thin', 600, 1000, 1050), // tooNarrow
  { ...taskbar('tbTop', SINGLE.displays[0]!, 40), edge: 'top' }, // unsupportedEdge
  ledge(topId('far'), 'windowTop', 'far', 600, 3000, 3500), // offDisplay
  wall('edge', 'left', 20, 300, 1040), // noRoomBeside
  wall('short', 'left', 1000, 500, 560), // tooShort
  wall('bad', 'right', 1000, 900, 500), // invalid
];

describe('Mover.navDiagnostics', () => {
  it('counts received, accepted and rejected surfaces by kind and reason', () => {
    const d = make(SINGLE, { tabStrips: false });
    d.extra = [A, H, H_LEFT, K, ...REJECTS, tabStrip('s', 800, 420, 880, null, null)];
    d.step();
    const n = d.m.navDiagnostics();
    expect(n.received).toEqual({ taskbar: 1, windowTop: 7, windowSide: 4, tabStrip: 1 });
    expect(n.accepted).toEqual({ taskbar: 0, windowTop: 3, windowSide: 1, tabStrip: 0 });
    expect(n.rejected).toEqual({ noHeadroom: 1, nearFloor: 1, tooNarrow: 1, unsupportedEdge: 1, offDisplay: 1, noRoomBeside: 1, tooShort: 1, invalid: 1, disabled: 1 });
    expect(n.graph).toEqual({ nodes: 6, edges: d.m.graphInfo().edges, updates: d.m.graphInfo().updates, rebuilds: d.m.graphInfo().rebuilds });
    expect(n.graph.edges).toBeGreaterThan(0);
  });

  it('reports what is reachable from where the cat is: a jump, a leap and climb, but not a top out of reach', () => {
    const d = make();
    d.extra = [A, H, H_LEFT, K];
    d.step();
    expect(d.m.navDiagnostics().reachable).toEqual({ taskbar: 0, windowTop: 2, windowSide: 1, tabStrip: 0 });
    // Without the leap (climbing off) the high top is out of reach too.
    const off = make(SINGLE, { walls: false });
    off.extra = [A, H, H_LEFT, K];
    off.step();
    expect(off.m.navDiagnostics().reachable).toEqual({ taskbar: 0, windowTop: 1, windowSide: 0, tabStrip: 0 });
  });

  it('counts a side as reachable only when it leads over a usable top (v1.1.1 review BEH-1)', () => {
    // Each side can be leapt onto from the floor (it ends 240 px up) but leads nowhere: the cat
    // could never get up, so neither the counts nor the outlines may call it reachable.
    const cases: Array<[string, Surface[]]> = [
      ['its top is not listed (a window snapped to the screen top)', [wall('n', 'left', 1000, 300, 800, { topLedgeId: null })]],
      ['its top is turned down (no headroom)', [ledge(topId('n'), 'windowTop', 'n', 40, 1000, 1400), wall('n', 'left', 1000, 40, 800)]],
      ['its top is not at its corner', [H, wall('n', 'left', 1000, 300, 800, { topLedgeId: H.id })]],
    ];
    for (const [why, surfaces] of cases) {
      const d = make();
      d.extra = surfaces;
      d.step();
      const n = d.m.navDiagnostics();
      expect(n.accepted.windowSide, why).toBe(1);
      expect(n.reachable, why).toEqual({ taskbar: 0, windowTop: 0, windowSide: 0, tabStrip: 0 });
      expect(d.m.climbOptions(), why).toEqual([]);
      expect(d.m.debugLines().find((l) => l.kind === 'windowSide')?.role, why).toBe('valid');
    }
  });

  it('counts a side it can only climb down from its top as reachable', () => {
    // The side ends 590 px above the floor (out of leap reach from below); the cat stands on its top.
    const T = ledge(topId('t'), 'windowTop', 't', 300, 1000, 1400);
    const d = make();
    d.extra = [T, wall('t', 'left', 1000, 300, 450)];
    d.step();
    d.m.startDrag({ x: d.m.x, y: d.m.y });
    d.dragCursor = { x: 1200, y: 200 };
    d.until(() => false, 400);
    d.m.endDrag(null, { x: 0, y: 0 }, d.now, false);
    d.dragCursor = null;
    expect(d.until((r) => r.landed !== null, 3000)).toBe(true);
    expect(d.m.support).toMatchObject({ surfaceId: T.id });
    d.step(600);
    expect(d.m.navDiagnostics().reachable.windowSide).toBe(1);
    expect(d.m.debugLines().find((l) => l.kind === 'windowSide')?.role).toBe('reachable');
  });

  it('recomputes reachability at most every 500 ms of sim time', () => {
    const d = make();
    d.extra = [A, H, H_LEFT, K];
    d.step();
    expect(d.m.navDiagnostics().reachable.windowTop).toBe(2);
    d.extra = [A, H, K];
    d.step(100);
    // Accepted counts are live; the reachable search is cached.
    expect(d.m.navDiagnostics().accepted.windowSide).toBe(0);
    expect(d.m.navDiagnostics().reachable.windowTop).toBe(2);
    d.step(450);
    expect(d.m.navDiagnostics().reachable.windowTop).toBe(1);
  });

  it('counts climb outcomes: a leap, the pull-up, and a let-go', () => {
    const d = make();
    d.extra = [A, H, H_LEFT, K];
    d.step();
    d.goal({ x: 1600, y: 300 });
    expect(d.until((r) => r.goal === 'arrived', 60_000)).toBe(true);
    expect(d.m.navDiagnostics().climbs).toEqual({ leaps: 1, mounts: 0, pulledUp: 1, reversed: 0, letGo: 0, topReResolved: 0 });
    // On the top now: reachable counts start from there (the floor and A by jumps down).
    d.step(600);
    expect(d.m.navDiagnostics().reachable.windowTop).toBe(2);
  });

  it('counts surfaces past the per-kind cap and on off-limits displays', () => {
    const many: Surface[] = [];
    for (let i = 0; i < 70; i++) many.push(ledge(topId(`w${i}`), 'windowTop', `w${i}`, 700, 20 + i * 26, 120 + i * 26));
    const d = make();
    d.extra = many;
    d.step();
    expect(d.m.navDiagnostics()).toMatchObject({ accepted: { windowTop: 64 }, rejected: { capped: 6 } });
    const dual = make(DUAL_FLAT);
    dual.m.setOffLimitsDisplays(['2']);
    dual.extra = [A, ledge(topId('b'), 'windowTop', 'b', 800, 2400, 2900)];
    dual.step();
    expect(dual.m.navDiagnostics()).toMatchObject({ accepted: { windowTop: 1 }, rejected: { offDisplay: 1 } });
  });
});

describe('Mover.debugLines', () => {
  it('draws floors, ledges and walls by role, the support first, rejected last, in physical px and without ids', () => {
    const d = make();
    d.extra = [A, H, H_LEFT, K, ...REJECTS];
    d.step();
    const lines = d.m.debugLines();
    expect(lines[0]).toEqual({ kind: 'floor', role: 'support', x0: 0, y0: 1040, x1: 1920, y1: 1040 });
    expect(lines).toContainEqual({ kind: 'windowTop', role: 'reachable', x0: 400, y0: 800, x1: 900, y1: 800 });
    expect(lines).toContainEqual({ kind: 'windowTop', role: 'valid', x0: 100, y0: 200, x1: 350, y1: 200 });
    expect(lines).toContainEqual({ kind: 'windowSide', role: 'reachable', x0: 1400, y0: 300, x1: 1400, y1: 800 });
    expect(lines).toContainEqual({ kind: 'windowTop', role: 'rejected', x0: 600, y0: 20, x1: 900, y1: 20 });
    expect(lines).toContainEqual({ kind: 'windowSide', role: 'rejected', x0: 20, y0: 300, x1: 20, y1: 1040 });
    expect(lines.filter((l) => l.role === 'rejected').length).toBe(REJECTS.length);
    const order = ['support', 'target', 'reachable', 'valid', 'rejected'];
    for (let i = 1; i < lines.length; i++) expect(order.indexOf(lines[i]!.role)).toBeGreaterThanOrEqual(order.indexOf(lines[i - 1]!.role));
    for (const l of lines) {
      expect(Object.keys(l).sort()).toEqual(['kind', 'role', 'x0', 'x1', 'y0', 'y1']);
      expect([l.x0, l.y0, l.x1, l.y1].every(Number.isFinite)).toBe(true);
    }
  });

  it('marks where the route goes as the target, and the wall while clinging as the support', () => {
    const d = make();
    d.extra = [A, H, H_LEFT, K];
    d.step();
    d.goal({ x: 1600, y: 300 });
    d.step();
    const roles = (kind: string, x0: number) => d.m.debugLines().find((l) => l.kind === kind && l.x0 === x0)?.role;
    expect(roles('windowTop', 1400)).toBe('target');
    expect(roles('windowSide', 1400)).toBe('target');
    expect(d.until(() => d.m.climbPhase === 'climb', 30_000)).toBe(true);
    d.step(600);
    expect(roles('windowSide', 1400)).toBe('support');
    expect(roles('windowTop', 1400)).toBe('target');
    expect(d.m.debugLines().some((l) => l.kind === 'floor' && l.role === 'support')).toBe(false);
  });

  it('never returns more than MAX_DEBUG_LINES', () => {
    const many: Surface[] = [];
    for (let i = 0; i < 70; i++) many.push(ledge(topId(`w${i}`), 'windowTop', `w${i}`, 700, 20 + i * 26, 120 + i * 26));
    for (let i = 0; i < 70; i++) many.push(wall(`w${i}`, 'left', 200 + i * 20, 300, 700));
    for (let i = 0; i < 100; i++) many.push(ledge(topId(`x${i}`), 'windowTop', `x${i}`, 10, 100, 900));
    const d = make();
    d.extra = many;
    d.step();
    const lines = d.m.debugLines();
    expect(lines.length).toBe(MAX_DEBUG_LINES);
    expect(lines[0]?.role).toBe('support');
    // Everything accepted is drawn (64 tops, 64 sides, the floor); rejected ones are cut first.
    expect(lines.filter((l) => l.role !== 'rejected').length).toBe(1 + 64 + 64);
  });

  it('draws nothing on an off-limits display (a fullscreen app in front), all of it again once open (v1.1.1 review SEC-1)', () => {
    const d = make(DUAL_FLAT);
    d.m.setOffLimitsDisplays(['2']);
    d.extra = [A, ledge(topId('b'), 'windowTop', 'b', 800, 2400, 2900), wall('b', 'left', 2400, 800, 1040)];
    d.step();
    expect(d.m.navDiagnostics().rejected).toEqual({ offDisplay: 2 });
    const lines = d.m.debugLines();
    expect(lines).toContainEqual({ kind: 'floor', role: 'support', x0: 0, y0: 1040, x1: 1920, y1: 1040 });
    expect(lines).toContainEqual({ kind: 'windowTop', role: 'reachable', x0: 400, y0: 800, x1: 900, y1: 800 });
    expect(lines.filter((l) => Math.max(l.x0, l.x1) > 1920)).toEqual([]);
    d.m.setOffLimitsDisplays([]);
    d.step(600);
    const open = d.m.debugLines();
    expect(open).toContainEqual({ kind: 'floor', role: 'support', x0: 1920, y0: 1040, x1: 3840, y1: 1040 });
    expect(open.filter((l) => l.kind === 'windowTop' && l.x0 === 2400)).toHaveLength(1);
    expect(open.filter((l) => l.kind === 'windowSide' && l.x0 === 2400)).toHaveLength(1);
  });

  it('lists a side it can only leap onto among its climb options', () => {
    const d = make();
    d.extra = [H, H_LEFT];
    d.step();
    expect(d.m.climbOptions().map((o) => o.wallId)).toEqual([sideId('h', 'left')]);
  });
});
