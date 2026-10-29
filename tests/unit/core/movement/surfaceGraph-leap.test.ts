// v1.1.1 leap and cling (RC1) and landing spans (RC6) in the surface graph: from a support
// the cat jumps onto a window side that ends too high to step onto, within jump reach of its
// feet, then climbs and pulls up. Fixtures use the app's floor inset (simWorld) and, for the
// user's real layout, the provider's own surface builder.
import { describe, expect, it } from 'vitest';
import type { GraphEdge, GraphEdgeKind, RouteParams, Surface, WallTrack } from '../../../../src/core/movement';
import { edgeId, MOVEMENT, ROUTE_EFFORT, SurfaceGraph, WorldModel } from '../../../../src/core/movement';
import { FLOOR_INSET_DIP, simWorld } from '../../../../src/core/display/simWorld';
import { CAT_BASE_HEIGHT_DIP } from '../../../../src/shared/cat';
import type { Rect } from '../../../../src/shared/geometry';
import type { LedgeSurface, WallSurface } from '../../../../src/shared/surfaces';
import { isLedge, isWall } from '../../../../src/shared/surfaces';
import type { WorldGeometry } from '../../../../src/shared/world';
import { display, ledge, sideId, stripId, tabStrip, topId, wall, world } from '../behavior/fixtures';
import { providerSurfaces } from './providerSurfaces';

/** A 1920x1200 screen with an auto-hidden taskbar (work area = screen), as on the user's machine. */
const screen = (scale: number): WorldGeometry => world(display('1', 0, 0, 1920, 1200, { primary: true, scale }));
const floorYFor = (scale: number): number => 1200 - Math.round(FLOOR_INSET_DIP * scale);

function params(scale: number, o: Partial<RouteParams> = {}): RouteParams {
  return { walkSpeedPx: MOVEMENT.walkDip * scale, jumpEffort: 1, climbEffort: 1, allowClimb: true, preferClimb: false, blockedNode: () => false, blockedEdge: () => false, ...o };
}

function build(geometry: WorldGeometry, ledges: readonly LedgeSurface[], walls: readonly WallSurface[]): { world: WorldModel; graph: SurfaceGraph; ls: Surface[]; ws: WallTrack[] } {
  const w = new WorldModel(geometry, 1, true);
  const ls = w.ledgeSurfaces(ledges);
  const ws = w.wallTracks(walls);
  const graph = new SurfaceGraph();
  graph.update(w, ls, ws);
  return { world: w, graph, ls, ws };
}

/**
 * A window x 600..1400 whose top (y 150) is far beyond a jump from the floor, its sides ending
 * `foot` px above the cat's floor (the work-area bottom minus the app's floor inset).
 */
function tall(scale: number, foot: number, extra: Partial<WallSurface> = {}) {
  const floorY = floorYFor(scale);
  return build(simWorld(screen(scale)), [ledge(topId('w'), 'windowTop', 'w', 150, 600, 1400)], [wall('w', 'left', 600, 160, floorY - foot, extra), wall('w', 'right', 1400, 160, floorY - foot, extra)]);
}

const kinds = (r: { steps: { edge: { kind: GraphEdgeKind } }[] } | null): GraphEdgeKind[] | null => r?.steps.map((s) => s.edge.kind) ?? null;
const leapTo = (g: SurfaceGraph, from: string, wallKey: string): GraphEdge | undefined => g.edgesFrom(from).find((e) => e.kind === 'leap' && e.to === `up:${wallKey}`);

describe('SurfaceGraph: leap and cling (v1.1.1 RC1)', () => {
  const FEET = [40, 82, 150, 300, 480] as const;
  const SCALES = [1, 1.25, 1.5] as const;

  for (const scale of SCALES) {
    for (const foot of FEET) {
      const stepReach = CAT_BASE_HEIGHT_DIP * scale * MOVEMENT.wallReachBodyHeights;
      const reach = MOVEMENT.wallLeapUpDip * scale;
      const expected: GraphEdgeKind | null = foot <= stepReach ? 'mount' : foot <= reach ? 'leap' : null;
      it(`floor -> window top with sides ending ${foot} px up at ${scale}x: ${expected ?? 'none (beyond reach)'}`, () => {
        const { graph, world: w } = tall(scale, foot);
        const r = graph.route(w.firstFloor, 300, topId('w'), 1000, params(scale));
        if (expected === null) {
          expect(r).toBeNull();
          return;
        }
        expect(kinds(r)).toEqual([expected, 'pullUp']);
        const first = r!.steps[0]!.edge;
        expect(first.to).toBe(`up:${sideId('w', 'left')}`);
        if (expected === 'leap') {
          // The grip is on the climbable stretch, within jump reach above the feet, taken off beside the wall.
          const track = graph.node(first.to)!.wall!;
          expect(first.gripY).toBeGreaterThanOrEqual(track.yTop);
          expect(first.gripY).toBeLessThanOrEqual(track.yBottom);
          expect(floorYFor(scale) - first.gripY!).toBeLessThanOrEqual(reach + 1e-9);
          expect(first.fromLo).toBeCloseTo(track.standX, 9);
          expect(first.fromHi).toBe(first.fromLo);
        }
      });
    }
  }

  it('the reach is the jump reach: 480 px at 1x is 480 DIP, beyond wallLeapUpDip (= maxJumpUpDip); 1 px inside it is not', () => {
    expect(MOVEMENT.wallLeapUpDip).toBeLessThanOrEqual(MOVEMENT.maxJumpUpDip);
    for (const scale of [1, 1.25, 1.5]) {
      const reach = MOVEMENT.wallLeapUpDip * scale;
      const inside = tall(scale, Math.floor(reach) - 1);
      expect(kinds(inside.graph.route(inside.world.firstFloor, 300, topId('w'), 1000, params(scale)))).toEqual(['leap', 'pullUp']);
      const beyond = tall(scale, Math.ceil(reach) + 2);
      expect(beyond.graph.route(beyond.world.firstFloor, 300, topId('w'), 1000, params(scale))).toBeNull();
      expect(leapTo(beyond.graph, beyond.world.firstFloor.key, sideId('w', 'left'))).toBeUndefined();
    }
    const at1x = tall(1, 480);
    expect(at1x.graph.route(at1x.world.firstFloor, 300, topId('w'), 1000, params(1))).toBeNull();
  });

  it('catches the side about wallLeapGripDip above its feet, or at its foot when that is higher', () => {
    const scale = 1.25;
    const floorY = floorYFor(scale);
    const low = tall(scale, 82);
    expect(leapTo(low.graph, low.world.firstFloor.key, sideId('w', 'left'))?.gripY).toBeCloseTo(floorY - MOVEMENT.wallLeapGripDip * scale, 9);
    const high = tall(scale, 480);
    expect(leapTo(high.graph, high.world.firstFloor.key, sideId('w', 'left'))?.gripY).toBe(floorY - 480);
  });

  it('a side that reaches the support keeps its step-on mount and gets no leap', () => {
    const { graph, world: w } = tall(1.25, 0);
    const out = graph.edgesFrom(w.firstFloor.key).filter((e) => e.to.startsWith('up:'));
    expect(out.map((e) => e.kind)).toEqual(['mount', 'mount']);
  });

  it('weighs the jump of a leap like a jump and the rest like a climb', () => {
    const scale = 1.25;
    const { graph, world: w } = tall(scale, 150);
    const e = leapTo(graph, w.firstFloor.key, sideId('w', 'left'))!;
    const track = graph.node(e.to)!.wall!;
    const jump = ROUTE_EFFORT.jumpBase + MOVEMENT.crouchMs / 1000 + (ROUTE_EFFORT.jumpUpPerMax * (floorYFor(scale) - e.gripY!)) / (MOVEMENT.maxJumpUpDip * scale);
    expect(e.jumpPart).toBeCloseTo(jump, 9);
    expect(e.effort).toBeCloseTo(jump + (e.gripY! - track.yTop) / scale / MOVEMENT.climbUpDip, 9);
    expect(e.effortKind).toBe('climb');
    const base = graph.route(w.firstFloor, track.standX, topId('w'), 1000, params(scale))!;
    const jumpy = graph.route(w.firstFloor, track.standX, topId('w'), 1000, params(scale, { jumpEffort: 3 }))!;
    const climby = graph.route(w.firstFloor, track.standX, topId('w'), 1000, params(scale, { climbEffort: 2 }))!;
    expect(jumpy.cost - base.cost).toBeCloseTo(2 * e.jumpPart!, 6);
    expect(climby.cost - base.cost).toBeCloseTo((e.effort - e.jumpPart! + ROUTE_EFFORT.climbTransition) * ROUTE_EFFORT.climbMultiplier, 6);
  });

  it('honours climbing off, blocked edges and nodes, leaving sides and the top it stands on', () => {
    const scale = 1.25;
    const { graph, world: w, ls } = tall(scale, 150);
    const route = (o: Partial<RouteParams>) => graph.route(w.firstFloor, 300, topId('w'), 1000, params(scale, o));
    expect(kinds(route({ preferClimb: true }))).toEqual(['leap', 'pullUp']);
    expect(route({ allowClimb: false })).toBeNull();
    expect(route({ blockedEdge: (e) => e.kind === 'leap' })).toBeNull();
    expect(route({ blockedNode: (n) => n.kind === 'wallUp' })).toBeNull();
    // One side blocked (a failed precise check): the other one.
    const left = leapTo(graph, w.firstFloor.key, sideId('w', 'left'))!;
    expect(route({ blockedEdge: (e) => edgeId(e) === edgeId(left) })?.steps[0]?.edge.to).toBe(`up:${sideId('w', 'right')}`);
    // Never from the window's own top, never onto a leaving side.
    const top = ls.find((l) => l.key === topId('w'))!;
    expect(graph.edgesFrom(top.key).some((e) => e.kind === 'leap')).toBe(false);
    const leaving = tall(scale, 150, { phase: 'leaving' });
    expect(leaving.graph.edgesFrom(leaving.world.firstFloor.key).some((e) => e.kind === 'leap')).toBe(false);
  });

  it('leaps from any support: a lower window top under a side that is out of reach from the floor', () => {
    const scale = 1;
    const floorY = floorYFor(scale);
    // Side foot 640 px above the floor (beyond reach), 300 px above the lower window b's top.
    const b = ledge(topId('b'), 'windowTop', 'b', floorY - 340, 250, 700);
    const { graph, world: w } = build(simWorld(screen(scale)), [ledge(topId('w'), 'windowTop', 'w', 150, 600, 1400), b], [wall('w', 'left', 600, 160, floorY - 640)]);
    expect(leapTo(graph, w.firstFloor.key, sideId('w', 'left'))).toBeUndefined();
    expect(leapTo(graph, topId('b'), sideId('w', 'left'))).toBeDefined();
    expect(kinds(graph.route(w.firstFloor, 300, topId('w'), 1000, params(scale)))).toEqual(['jump', 'leap', 'pullUp']);
  });

  it('an incremental update gives the same leap edges as a full rebuild', () => {
    const scale = 1.25;
    const floorY = floorYFor(scale);
    const geo = simWorld(screen(scale));
    const { graph, world: w } = tall(scale, 150);
    const next = [ledge(topId('w'), 'windowTop', 'w', 150, 650, 1450)];
    const nextWalls = [wall('w', 'left', 650, 160, floorY - 300), wall('w', 'right', 1450, 160, floorY - 300)];
    graph.update(w, w.ledgeSurfaces(next), w.wallTracks(nextWalls));
    const fresh = build(geo, next, nextWalls).graph;
    const dump = (g: SurfaceGraph) => [...g.nodes.keys()].flatMap((k) => g.edgesFrom(k).map((e) => `${edgeId(e)}@${e.fromLo.toFixed(1)}/${e.gripY?.toFixed(1) ?? '-'}`)).sort();
    expect(dump(graph)).toEqual(dump(fresh));
    expect(dump(graph).some((d) => d.startsWith('leap:'))).toBe(true);
  });
});

describe('SurfaceGraph: pulling up onto a tab strip via its window top (v1.1.1 RC6)', () => {
  // Window x 800..1300, top 400 (SINGLE-like 1x screen); the strip's own span starts 200 px in
  // from the left side and ends 150 px short of the right one: beyond 1.25 body widths of both.
  const geo = world(display('1', 0, 0, 1920, 1080, { primary: true, taskbar: 40 }));
  const sides = [wall('w', 'left', 800, 400, 1040, { topLedgeId: stripId('w') }), wall('w', 'right', 1300, 400, 1040, { topLedgeId: stripId('w') })];

  it('without the open edge the corner is not at the strip; with it the pull-up ends on the edge beside the strip', () => {
    const bare = build(geo, [tabStrip('w', 400, 1000, 1150, null, null)], sides);
    expect(bare.graph.route(bare.world.firstFloor, 300, stripId('w'), 1100, params(1, { preferClimb: true }))).toBeNull();
    const withLand = build(geo, [tabStrip('w', 400, 1000, 1150, null, null, { land: { x0: 800, x1: 1300 } })], sides);
    const strip = withLand.ls[0]!;
    expect(strip).toMatchObject({ x0: 1000, x1: 1150, landX0: 800, landX1: 1300, landWide: true });
    const r = withLand.graph.route(withLand.world.firstFloor, 300, stripId('w'), 1100, params(1, { preferClimb: true }));
    expect(kinds(r)).toEqual(['mount', 'pullUp']);
    // Just inside the left corner (half a body), on the window's top edge, not snapped to the strip.
    expect(r!.steps[1]!.toX).toBeCloseTo(800 + 42, 9);
    const wl = withLand.ws.find((t) => t.key === sideId('w', 'left'))!;
    const wr = withLand.ws.find((t) => t.key === sideId('w', 'right'))!;
    expect(withLand.graph.cornerX(withLand.world, wl, strip)).toBeCloseTo(842, 9);
    expect(withLand.graph.cornerX(withLand.world, wr, strip)).toBeCloseTo(1258, 9);
    // The swing down at the corner exists as well.
    expect(withLand.graph.edgesFrom(stripId('w')).filter((e) => e.kind === 'swing').length).toBe(2);
  });
});

describe('SurfaceGraph: the user\'s real layout (1920x1200 @1.25, auto-hide taskbar)', () => {
  const REAL = world(display('1', 0, 0, 1920, 1200, { primary: true, scale: 1.25 }));
  /** DWM frames of the user's floating windows (diagnosis 2026-10-29), each tested alone in front. */
  const LAYOUT: Record<string, Rect> = {
    claude: { x: 322, y: 122, width: 1308, height: 1001 },
    obsidian: { x: 320, y: 100, width: 1280, height: 1000 },
    docker: { x: 174, y: 150, width: 1597, height: 902 },
    crossdevice: { x: 296, y: 288, width: 404, height: 432 },
    chrome: { x: 1123, y: 113, width: 772, height: 1048 },
  };

  for (const [id, rect] of Object.entries(LAYOUT)) {
    it(`${id}: the floor has a route to its top`, () => {
      const surfaces = providerSurfaces([[id, rect]], REAL.displays);
      const { graph, world: w, ls, ws } = build(simWorld(REAL), surfaces.filter(isLedge), surfaces.filter(isWall));
      const top = ls.find((l) => l.key === topId(id));
      expect(top).toBeDefined();
      expect(ws.length).toBeGreaterThan(0);
      // Far beyond a jump from the floor: only a climb gets there.
      expect(w.firstFloor.y - top!.y).toBeGreaterThan(MOVEMENT.maxJumpUpDip * 1.25);
      const r = graph.route(w.firstFloor, 960, top!.key, (top!.x0 + top!.x1) / 2, params(1.25));
      expect(r).not.toBeNull();
      expect(kinds(r)?.slice(-1)).toEqual(['pullUp']);
      // Every side of these windows ends 80-490 px above the floor, except Chrome's (44 px: a step).
      const foot = w.firstFloor.y - Math.min(...ws.map((t) => t.yBottom));
      expect(r!.steps[0]!.edge.kind).toBe(foot <= CAT_BASE_HEIGHT_DIP * 1.25 * MOVEMENT.wallReachBodyHeights ? 'mount' : 'leap');
    });
  }

  it('before v1.1.1 (step-on mounts only) the floor had no edge to any of these but Chrome', () => {
    for (const [id, rect] of Object.entries(LAYOUT)) {
      const surfaces = providerSurfaces([[id, rect]], REAL.displays);
      const { graph, world: w } = build(simWorld(REAL), surfaces.filter(isLedge), surfaces.filter(isWall));
      const mounts = graph.edgesFrom(w.firstFloor.key).filter((e) => e.kind === 'mount' || e.kind === 'jump');
      expect(mounts.length > 0).toBe(id === 'chrome');
    }
  });
});
