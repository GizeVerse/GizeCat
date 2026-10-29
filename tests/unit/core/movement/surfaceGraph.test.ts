// The surface graph: nodes for floors, ledges and walls (up/down), reachability edges
// (walk, jump, drop, mount, pull-up, swing, dismount), incremental updates and routes.
import { describe, expect, it } from 'vitest';
import type { GraphEdgeKind, RouteParams, Surface, WallTrack } from '../../../../src/core/movement';
import { edgeId, MOVEMENT, SurfaceGraph, WorldModel } from '../../../../src/core/movement';
import type { LedgeSurface, WallSurface } from '../../../../src/shared/surfaces';
import { DUAL_MIXED, ledge, SINGLE, sideId, topId, wall } from '../behavior/fixtures';

// SINGLE: 1920x1040 work area at 1x, floor y = 1040; body 84 x 64 px.
const A = ledge(topId('a'), 'windowTop', 'a', 800, 400, 900);
/** Touches A (2 px apart) at the same height. */
const B = ledge(topId('b'), 'windowTop', 'b', 800, 902, 1300);
/** Far too high to jump to from the floor (740 px up). */
const H = ledge(topId('h'), 'windowTop', 'h', 300, 1400, 1800);
const H_LEFT = wall('h', 'left', 1400, 300, 1040);
const A_LEFT = wall('a', 'left', 400, 800, 1040);

function build(ledges: readonly LedgeSurface[] = [A, B, H], walls: readonly WallSurface[] = [H_LEFT, A_LEFT], geometry = SINGLE): { world: WorldModel; graph: SurfaceGraph; ls: Surface[]; ws: WallTrack[] } {
  const world = new WorldModel(geometry, 1, true);
  const ls = world.ledgeSurfaces(ledges);
  const ws = world.wallTracks(walls);
  const graph = new SurfaceGraph();
  graph.update(world, ls, ws);
  return { world, graph, ls, ws };
}

const kinds = (g: SurfaceGraph, from: string): string[] =>
  g
    .outgoing(g.node(from)!)
    .map((e) => `${e.kind}>${e.to}`)
    .sort();

function params(o: Partial<RouteParams> = {}): RouteParams {
  return { walkSpeedPx: MOVEMENT.walkDip, jumpEffort: 1, climbEffort: 1, allowClimb: true, preferClimb: false, blockedNode: () => false, blockedEdge: () => false, ...o };
}

describe('SurfaceGraph: nodes and edges', () => {
  it('has one node per floor and ledge and two per wall (climbing up / down)', () => {
    const { graph } = build();
    expect([...graph.nodes.keys()].sort()).toEqual(
      ['floor:1', topId('a'), topId('b'), topId('h'), `up:${sideId('h', 'left')}`, `down:${sideId('h', 'left')}`, `up:${sideId('a', 'left')}`, `down:${sideId('a', 'left')}`].sort(),
    );
    expect(graph.node('floor:1')?.kind).toBe('floor');
    expect(graph.node(`up:${sideId('h', 'left')}`)?.kind).toBe('wallUp');
  });

  it('walk-connects touching ledges at the same height, both ways, at the joint', () => {
    const { graph } = build();
    const ab = graph.edgesFrom(topId('a')).find((e) => e.to === topId('b'));
    const ba = graph.edgesFrom(topId('b')).find((e) => e.to === topId('a'));
    expect(ab).toMatchObject({ kind: 'walk', fromLo: 900, fromHi: 900 });
    expect(ba).toMatchObject({ kind: 'walk', fromLo: 902, fromHi: 902 });
    // 40 px apart or 3 px higher: no longer one walkway.
    const apart = build([A, ledge(topId('b'), 'windowTop', 'b', 800, 940, 1300)]).graph;
    expect(apart.edgesFrom(topId('a')).find((e) => e.to === topId('b'))?.kind).toBe('jump');
    const higher = build([A, ledge(topId('b'), 'windowTop', 'b', 797, 902, 1300)]).graph;
    expect(higher.edgesFrom(topId('a')).find((e) => e.to === topId('b'))?.kind).toBe('jump');
  });

  it('jumps within the solver reach only (420 DIP up at 1x)', () => {
    const { graph } = build();
    const fromFloor = kinds(graph, 'floor:1');
    expect(fromFloor).toContain(`jump>${topId('a')}`);
    expect(fromFloor).toContain(`jump>${topId('b')}`);
    expect(fromFloor.some((k) => k.endsWith(`>${topId('h')}`))).toBe(false);
    // Down is always within reach.
    expect(kinds(graph, topId('h'))).toContain('jump>floor:1');
  });

  it('scales jump reach with the display: 500 px up is too far at 1x but within reach at 1.5x', () => {
    // DUAL_MIXED display 2: x -2560..0, floor y = 1260, scale 1.5 (max 630 px up).
    const high2 = ledge(topId('h2'), 'windowTop', 'h2', 760, -2000, -1400);
    const g2 = build([high2], [], DUAL_MIXED).graph;
    expect(kinds(g2, 'floor:2')).toContain(`jump>${topId('h2')}`);
    const high1 = ledge(topId('h1'), 'windowTop', 'h1', 1040 - 500, 400, 1000);
    expect(kinds(build([high1], []).graph, 'floor:1').some((k) => k.endsWith(topId('h1')))).toBe(false);
  });

  it('mounts a wall from the support below it, pulls up at its top corner and swings down from the top ledge', () => {
    const { graph } = build();
    const up = `up:${sideId('h', 'left')}`;
    const down = `down:${sideId('h', 'left')}`;
    const mount = graph.edgesFrom('floor:1').find((e) => e.to === up);
    expect(mount?.kind).toBe('mount');
    // Beside the wall, outside the window.
    expect(mount?.fromLo).toBeLessThan(1400);
    expect(mount?.fromLo).toBeGreaterThan(1400 - 84);
    const pull = graph.edgesFrom(up).find((e) => e.to === topId('h'));
    expect(pull?.kind).toBe('pullUp');
    // Onto the top, just inside the corner.
    expect(pull?.toX).toBeGreaterThan(1400);
    expect(graph.edgesFrom(topId('h')).find((e) => e.to === down)?.kind).toBe('swing');
    // A wall's own top never mounts it; a ledge whose span does not reach the wall's foot neither.
    expect(graph.edgesFrom(topId('h')).some((e) => e.to === up)).toBe(false);
    expect(graph.edgesFrom(topId('b')).some((e) => e.to === up)).toBe(false);
  });

  it('computes drops off ledge ends and the dismount at a wall foot on demand', () => {
    const { graph } = build();
    // A's left end drops to the floor; its right end leads onto B (same height: a walk, not a drop).
    const drops = graph.outgoing(graph.node(topId('a'))!).filter((e) => e.kind === 'drop');
    expect(drops.map((e) => [e.to, e.fromLo])).toEqual([['floor:1', 421]]);
    expect(graph.outgoing(graph.node(topId('h'))!).filter((e) => e.kind === 'drop').length).toBe(2);
    const dismount = graph.outgoing(graph.node(`down:${sideId('h', 'left')}`)!);
    expect(dismount.map((e) => `${e.kind}>${e.to}`)).toEqual(['dismount>floor:1']);
  });

  it('never leads onto a ledge that is leaving', () => {
    const leaving = ledge(topId('a'), 'windowTop', 'a', 800, 400, 900, { phase: 'leaving' });
    const { graph } = build([leaving, B], []);
    expect(graph.edgesFrom('floor:1').some((e) => e.to === topId('a'))).toBe(false);
    expect(graph.edgesFrom(topId('b')).some((e) => e.to === topId('a'))).toBe(false);
    // ... but the cat may still leave it.
    expect(graph.edgesFrom(topId('a')).some((e) => e.to === 'floor:1')).toBe(true);
  });
});

describe('SurfaceGraph: incremental updates', () => {
  it('recomputes only nodes whose geometry changed, keeps edges of the others, and rebuilds on a new world', () => {
    const { world, graph, ls, ws } = build();
    const edges0 = graph.edgeCount;
    graph.update(world, ls, ws);
    expect(graph.lastChanged).toBe(0);
    expect(graph.edgeCount).toBe(edges0);
    expect(graph.rebuilds).toBe(1);
    // Window h is dragged 50 px to the right: its top and both wall nodes change.
    const moved = world.ledgeSurfaces([A, B, { ...H, x0: 1450, x1: 1850 }]);
    const movedWalls = world.wallTracks([{ ...H_LEFT, x: 1450 }, A_LEFT]);
    graph.update(world, moved, movedWalls);
    expect(graph.lastChanged).toBe(3);
    const mount = graph.edgesFrom('floor:1').find((e) => e.to === `up:${sideId('h', 'left')}`);
    expect(mount?.fromLo).toBeGreaterThan(1400);
    // Velocity / focus changes alone keep the hash (payload refreshed, no recompute).
    graph.update(world, world.ledgeSurfaces([A, B, { ...H, x0: 1450, x1: 1850, vx: 30, focusX: 1500 }]), movedWalls);
    expect(graph.lastChanged).toBe(0);
    expect(graph.node(topId('h'))?.surface?.focusX).toBe(1500);
    // A ledge that goes away takes its edges with it.
    graph.update(world, world.ledgeSurfaces([A, H]), movedWalls);
    expect(graph.node(topId('b'))).toBeUndefined();
    for (const n of graph.nodes.values()) expect(graph.edgesFrom(n.key).some((e) => e.to === topId('b') || e.from === topId('b'))).toBe(false);
    // The previous height of each ledge is kept for lift detection.
    expect(graph.prevY(topId('a'))).toBe(800);
    const world2 = new WorldModel(SINGLE, 1, true);
    graph.update(world2, world2.ledgeSurfaces([A]), []);
    expect(graph.rebuilds).toBe(2);
    expect(graph.nodes.size).toBe(2);
  });

  it('an incremental update gives the same edges as a full rebuild', () => {
    const { world, graph } = build();
    const next = [A, { ...B, y: 780 }, { ...H, x0: 1300, x1: 1700 }];
    const nextWalls = [{ ...H_LEFT, x: 1300 }, A_LEFT];
    graph.update(world, world.ledgeSurfaces(next), world.wallTracks(nextWalls));
    const fresh = build(next, nextWalls).graph;
    const dump = (g: SurfaceGraph) => [...g.nodes.keys()].flatMap((k) => g.edgesFrom(k).map((e) => `${edgeId(e)}@${e.fromLo.toFixed(1)}-${e.fromHi.toFixed(1)}`)).sort();
    expect(dump(graph)).toEqual(dump(fresh));
  });
});

describe('SurfaceGraph: routes', () => {
  const steps = (r: { steps: { edge: { kind: GraphEdgeKind } }[] } | null): GraphEdgeKind[] | null => r?.steps.map((s) => s.edge.kind) ?? null;

  it('reaches a top that is too high to jump to by climbing a side and pulling up at the corner', () => {
    const { graph, world } = build();
    const r = graph.route(world.firstFloor, 700, topId('h'), 1600, params());
    expect(steps(r)).toEqual(['mount', 'pullUp']);
    expect(graph.route(world.firstFloor, 700, topId('h'), 1600, params({ allowClimb: false }))).toBeNull();
  });

  it('prefers a jump to a climb, unless the cat chose to climb', () => {
    const { graph, world } = build();
    expect(steps(graph.route(world.firstFloor, 200, topId('a'), 600, params()))).toEqual(['jump']);
    expect(steps(graph.route(world.firstFloor, 200, topId('a'), 600, params({ preferClimb: true })))).toEqual(['mount', 'pullUp']);
    // A cat that minds jumping (high jump effort) still jumps when climbing is far costlier.
    expect(steps(graph.route(world.firstFloor, 200, topId('a'), 600, params({ jumpEffort: 2 })))).toEqual(['jump']);
  });

  it('walks across touching ledges instead of jumping between them', () => {
    const { graph, ls } = build();
    const a = ls.find((l) => l.key === topId('a'))!;
    // Two seconds' walk from the joint: the cat walks across.
    const r = graph.route(a, 750, topId('b'), 1200, params());
    expect(steps(r)).toEqual(['walk']);
    expect(r?.steps[0]?.fromX).toBe(900);
    // From the far end (over five seconds away) stepping down there and jumping back up is quicker.
    expect(steps(graph.route(a, 430, topId('b'), 1200, params()))).toEqual(['drop', 'jump']);
  });

  it('climbs down from a top via its corner when the cat chose to climb, else drops or jumps', () => {
    const { graph, ls } = build();
    const h = ls.find((l) => l.key === topId('h'))!;
    expect(steps(graph.route(h, 1600, 'floor:1', 1300, params({ preferClimb: true })))).toEqual(['swing', 'dismount']);
    const plain = steps(graph.route(h, 1600, 'floor:1', 1300, params()));
    expect(plain?.length).toBe(1);
    expect(['jump', 'drop']).toContain(plain?.[0]);
  });

  it('honours blocked nodes, edges and arrival points', () => {
    const { graph, world } = build();
    const blockedA = params({ blockedNode: (n) => n.key === topId('a') });
    expect(graph.route(world.firstFloor, 200, topId('a'), 600, blockedA)).toBeNull();
    const noJump = params({ blockedEdge: (e) => e.kind === 'jump' });
    expect(steps(graph.route(world.firstFloor, 200, topId('a'), 600, noJump))).toEqual(['mount', 'pullUp']);
    const noArrival = params({ blockedArrival: (s) => s.key === topId('a') });
    expect(graph.route(world.firstFloor, 200, topId('a'), 600, noArrival)).toBeNull();
  });
});
