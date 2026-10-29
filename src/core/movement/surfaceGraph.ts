// Reachability between everything the cat can stand on or climb: floors, ledges
// (taskbars, window tops, tab strips) and walls (window sides). Nodes are kept by id and a
// geometry hash; each update only recomputes the edges of nodes that appeared or changed.
//
// Nodes: one per floor and ledge, two per wall (`up:` climbing up toward the top corner,
// `down:` climbing down from it). Edges:
//   walk     ledge <-> ledge/floor at the same height whose ends touch (walk across)
//   jump     support -> support within the jump solver's reach (up/across limits)
//   drop     ledge end -> first support below it (computed on demand)
//   mount    support -> up:wall when the wall's bottom is within reach of that support
//   leap     support -> up:wall when the wall ends higher than it can step on: a jump from
//            beside the wall that catches the side (v1.1.1); carries the grip height
//   pullUp   up:wall -> its top ledge at the corner
//   swing    top ledge -> down:wall at the corner (step off the ledge end onto the wall)
//   dismount down:wall -> first support below the wall's foot (computed on demand)
// Costs are seconds of effort (walking time plus a per-move effort), scaled by personality.
import { clamp } from '../../shared/geometry';
import { MOVEMENT, ROUTE_EFFORT } from './constants';
import type { Surface, WallTrack, WorldModel } from './world';

export type GraphNodeKind = 'floor' | 'ledge' | 'wallUp' | 'wallDown';
export type GraphEdgeKind = 'walk' | 'jump' | 'drop' | 'mount' | 'leap' | 'pullUp' | 'swing' | 'dismount';

export interface GraphNode {
  key: string;
  kind: GraphNodeKind;
  /** Floors and ledges. */
  surface: Surface | null;
  /** Wall nodes. */
  wall: WallTrack | null;
  hash: string;
}

export interface GraphEdge {
  kind: GraphEdgeKind;
  from: string;
  to: string;
  /** Where the move may start on the source surface: [lo, hi] (a point when lo === hi). */
  fromLo: number;
  fromHi: number;
  /** Fixed arrival x on the target surface, or null: the take-off x clamped onto the target. */
  toX: number | null;
  /** Effort in seconds before personality multipliers (walking to the take-off point excluded). */
  effort: number;
  effortKind: 'walk' | 'jump' | 'climb';
  /** Leaps: the share of `effort` that is the jump (weighed like a jump; the rest like a climb). */
  jumpPart?: number;
  /** Leaps: anchor height on the wall where the cat catches it. */
  gripY?: number;
}

export interface RouteStep {
  edge: GraphEdge;
  /** Take-off x on the source (for wall nodes: the wall line). */
  fromX: number;
  /** Arrival x on the target (for wall nodes: the wall line). */
  toX: number;
}

export interface Route {
  steps: RouteStep[];
  cost: number;
}

export interface RouteParams {
  /** Walking speed, px/s, for the cost of walking to take-off points. */
  walkSpeedPx: number;
  /** Personality multipliers (1 = neutral). */
  jumpEffort: number;
  climbEffort: number;
  allowClimb: boolean;
  /** Strongly favour climbing over jumping (the cat chose to climb). */
  preferClimb: boolean;
  /** Nodes the cat may not use (off-limits displays). */
  blockedNode: (n: GraphNode) => boolean;
  /** Edges that failed a precise check during this goal. */
  blockedEdge: (e: GraphEdge) => boolean;
  /** Arrival points the cat may not use (a shared floor's off-limits stretch). */
  blockedArrival?: (s: Surface, x: number) => boolean;
}

interface SearchLabel {
  cost: number;
  x: number;
  prev: string | null;
  step: RouteStep | null;
}

export const edgeId = (e: GraphEdge): string => `${e.kind}:${e.from}>${e.to}`;
const upKey = (w: WallTrack): string => `up:${w.key}`;
const downKey = (w: WallTrack): string => `down:${w.key}`;
const r1 = (v: number): number => Math.round(v * 10) / 10;

function ledgeHash(s: Surface): string {
  return `${r1(s.y)}|${r1(s.x0)}|${r1(s.x1)}|${r1(s.landX0)}|${r1(s.landX1)}|${s.phase}|${s.displayIds[0] ?? ''}`;
}

function wallHash(w: WallTrack): string {
  return `${r1(w.x)}|${r1(w.yTop)}|${r1(w.yBottom)}|${r1(w.standX)}|${w.topLedgeId ?? ''}|${w.phase}|${w.displayId}`;
}

export class SurfaceGraph {
  private world: WorldModel | null = null;
  private readonly nodeMap = new Map<string, GraphNode>();
  private readonly out = new Map<string, Map<string, GraphEdge[]>>();
  private readonly prevYs = new Map<string, number>();
  private ledgeList: readonly Surface[] = [];
  private wallList: readonly WallTrack[] = [];
  /** Diagnostics: how many nodes the last update recomputed, and totals. */
  lastChanged = 0;
  rebuilds = 0;
  updates = 0;

  get nodes(): ReadonlyMap<string, GraphNode> {
    return this.nodeMap;
  }
  get ledges(): readonly Surface[] {
    return this.ledgeList;
  }
  get walls(): readonly WallTrack[] {
    return this.wallList;
  }
  get edgeCount(): number {
    let n = 0;
    for (const m of this.out.values()) for (const es of m.values()) n += es.length;
    return n;
  }

  node(key: string): GraphNode | undefined {
    return this.nodeMap.get(key);
  }

  /** Height of a ledge at the previous update (undefined when it is new or not a ledge). */
  prevY(key: string): number | undefined {
    return this.prevYs.get(key);
  }

  /** Eager (pairwise) edges leaving a node. */
  edgesFrom(key: string): GraphEdge[] {
    const m = this.out.get(key);
    if (!m) return [];
    const all: GraphEdge[] = [];
    for (const es of m.values()) all.push(...es);
    return all;
  }

  /**
   * Replaces the node set. A new world model rebuilds everything; otherwise only nodes that
   * were added, removed or whose geometry hash changed get their edges recomputed.
   */
  update(world: WorldModel, ledges: readonly Surface[], walls: readonly WallTrack[]): void {
    this.updates++;
    if (world === this.world && this.sameGeometry(ledges, walls)) {
      // Nothing moved (the usual tick): refresh the payloads (velocity, focus, rest span), keep every edge.
      this.prevYs.clear();
      for (const l of ledges) {
        const n = this.nodeMap.get(l.key);
        if (!n) continue;
        this.prevYs.set(l.key, l.y);
        n.surface = l;
      }
      for (const w of walls) {
        const up = this.nodeMap.get(upKey(w));
        const down = this.nodeMap.get(downKey(w));
        if (up) up.wall = w;
        if (down) down.wall = w;
      }
      this.ledgeList = ledges;
      this.wallList = walls;
      this.lastChanged = 0;
      return;
    }
    this.prevYs.clear();
    for (const n of this.nodeMap.values()) if (n.kind === 'ledge' && n.surface) this.prevYs.set(n.key, n.surface.y);
    this.ledgeList = ledges;
    this.wallList = walls;
    const next = new Map<string, GraphNode>();
    for (const f of world.floors) next.set(f.key, { key: f.key, kind: 'floor', surface: f, wall: null, hash: f.key });
    for (const l of ledges) if (!next.has(l.key)) next.set(l.key, { key: l.key, kind: 'ledge', surface: l, wall: null, hash: ledgeHash(l) });
    for (const w of walls) {
      const h = wallHash(w);
      if (!next.has(upKey(w))) next.set(upKey(w), { key: upKey(w), kind: 'wallUp', surface: null, wall: w, hash: h });
      if (!next.has(downKey(w))) next.set(downKey(w), { key: downKey(w), kind: 'wallDown', surface: null, wall: w, hash: h });
    }
    if (world !== this.world) {
      this.world = world;
      this.rebuilds++;
      this.nodeMap.clear();
      this.out.clear();
      for (const [k, n] of next) this.nodeMap.set(k, n);
      for (const a of this.nodeMap.values()) for (const b of this.nodeMap.values()) if (a !== b) this.setEdges(a, b);
      this.lastChanged = this.nodeMap.size;
      return;
    }
    const changed: GraphNode[] = [];
    for (const key of [...this.nodeMap.keys()]) {
      if (next.has(key)) continue;
      this.nodeMap.delete(key);
      this.out.delete(key);
      for (const m of this.out.values()) m.delete(key);
    }
    for (const [key, n] of next) {
      const old = this.nodeMap.get(key);
      if (old && old.hash === n.hash) {
        // Same geometry: keep the edges, refresh the payload (velocity, focus, rest span).
        old.surface = n.surface;
        old.wall = n.wall;
        continue;
      }
      this.nodeMap.set(key, n);
      changed.push(n);
    }
    const changedKeys = new Set(changed.map((c) => c.key));
    for (const c of changed) {
      this.out.set(c.key, new Map());
      for (const m of this.out.values()) m.delete(c.key);
    }
    for (const c of changed) {
      for (const o of this.nodeMap.values()) {
        if (o === c) continue;
        this.setEdges(c, o);
        if (!changedKeys.has(o.key)) this.setEdges(o, c);
      }
    }
    this.lastChanged = changed.length;
  }

  /** Same surfaces in the same order with exactly the same geometry as at the last update. */
  private sameGeometry(ledges: readonly Surface[], walls: readonly WallTrack[]): boolean {
    const pl = this.ledgeList;
    const pw = this.wallList;
    if (pl.length !== ledges.length || pw.length !== walls.length) return false;
    for (let i = 0; i < ledges.length; i++) {
      const a = pl[i] as Surface;
      const b = ledges[i] as Surface;
      if (a === b) continue;
      if (a.key !== b.key || a.y !== b.y || a.x0 !== b.x0 || a.x1 !== b.x1 || a.landX0 !== b.landX0 || a.landX1 !== b.landX1 || a.phase !== b.phase || a.displayIds[0] !== b.displayIds[0]) return false;
    }
    for (let i = 0; i < walls.length; i++) {
      const a = pw[i] as WallTrack;
      const b = walls[i] as WallTrack;
      if (a === b) continue;
      if (a.key !== b.key || a.x !== b.x || a.yTop !== b.yTop || a.yBottom !== b.yBottom || a.standX !== b.standX || a.topLedgeId !== b.topLedgeId || a.phase !== b.phase || a.displayId !== b.displayId) return false;
    }
    return true;
  }

  /**
   * Cheapest route from `start` (at `startX`) to the surface `destKey` (ending at `destX`).
   * `start` may be a surface that is not in the graph (a ledge kept during its grace).
   */
  route(start: Surface, startX: number, destKey: string, destX: number, p: RouteParams): Route | null {
    if (!this.world) return null;
    if (!this.nodeMap.has(destKey) && destKey !== start.key) return null;
    const labels = this.search(this.startNode(start), startX, p, destKey);
    const end = labels?.get(destKey);
    if (!labels || !end) return null;
    const steps: RouteStep[] = [];
    let k: string | null = destKey;
    while (k !== null) {
      const l = labels.get(k) as SearchLabel;
      if (l.step) steps.unshift(l.step);
      k = l.prev;
    }
    return { steps, cost: end.cost + Math.abs(destX - end.x) / Math.max(1, p.walkSpeedPx) };
  }

  /**
   * Keys of every node a route could reach from `start` (a surface, or the key of the wall node
   * the cat climbs on) with these params: the planner's search without a destination.
   */
  reachable(start: Surface | string, startX: number, p: RouteParams): Set<string> {
    if (!this.world) return new Set();
    const node = typeof start === 'string' ? this.nodeMap.get(start) : this.startNode(start);
    if (!node) return new Set();
    return new Set(this.search(node, startX, p, null)?.keys() ?? []);
  }

  /** `start` may be a surface that is not in the graph (a ledge kept during its grace). */
  private startNode(start: Surface): GraphNode {
    return this.nodeMap.get(start.key) ?? { key: start.key, kind: start.kind === 'floor' ? 'floor' : 'ledge', surface: start, wall: null, hash: '' };
  }

  /**
   * Dijkstra from `startNode` over the eager and on-demand edges. With `destKey` it stops once
   * that node is settled and returns the labels (null when it cannot be reached); without one
   * it labels everything reachable.
   */
  private search(startNode: GraphNode, startX: number, p: RouteParams, destKey: string | null): Map<string, SearchLabel> | null {
    const labels = new Map<string, SearchLabel>([[startNode.key, { cost: 0, x: startX, prev: null, step: null }]]);
    const settled = new Set<string>();
    const walkSec = (dx: number): number => Math.abs(dx) / Math.max(1, p.walkSpeedPx);
    const jumpMult = p.jumpEffort * (p.preferClimb ? 4 : 1);
    const mult = (e: GraphEdge): number => {
      if (e.effortKind === 'jump') return jumpMult;
      if (e.effortKind === 'climb') return p.climbEffort * ROUTE_EFFORT.climbMultiplier * (p.preferClimb ? 0.2 : 1);
      return 1;
    };
    // A leap is a jump followed by a climb: each part weighed as what it is.
    const weighed = (e: GraphEdge): number => {
      const jump = e.jumpPart ?? 0;
      return (e.effort - jump) * mult(e) + jump * jumpMult;
    };
    for (let guard = 0; guard < 512; guard++) {
      let curKey: string | null = null;
      let cur: SearchLabel | null = null;
      for (const [k, l] of labels) {
        if (settled.has(k)) continue;
        if (!cur || l.cost < cur.cost) {
          cur = l;
          curKey = k;
        }
      }
      if (!cur || curKey === null) return destKey === null ? labels : null;
      settled.add(curKey);
      if (curKey === destKey) return labels;
      const node = curKey === startNode.key ? startNode : this.nodeMap.get(curKey);
      if (!node) continue;
      for (const e of this.outgoing(node)) {
        if (settled.has(e.to) || p.blockedEdge(e)) continue;
        if (!p.allowClimb && (e.kind === 'mount' || e.kind === 'leap' || e.kind === 'swing')) continue;
        const target = this.nodeMap.get(e.to);
        if (!target || p.blockedNode(target)) continue;
        const fromX = node.wall ? node.wall.x : clamp(cur.x, e.fromLo, e.fromHi);
        const toX = e.toX ?? (target.surface ? clamp(fromX, target.surface.x0, target.surface.x1) : (target.wall?.x ?? fromX));
        if (target.surface && p.blockedArrival?.(target.surface, toX)) continue;
        const walk = node.wall ? 0 : walkSec(fromX - cur.x);
        const cost = cur.cost + walk + weighed(e);
        const old = labels.get(e.to);
        if (!old || cost < old.cost) labels.set(e.to, { cost, x: toX, prev: curKey, step: { edge: e, fromX, toX } });
      }
    }
    return destKey === null ? labels : null;
  }

  /** Eager edges plus the on-demand drop/dismount edges of a node. */
  outgoing(n: GraphNode): GraphEdge[] {
    const eager = this.out.has(n.key) ? this.edgesFrom(n.key) : this.computeOut(n);
    const extra = this.onDemand(n);
    return extra.length > 0 ? [...eager, ...extra] : eager;
  }

  private computeOut(n: GraphNode): GraphEdge[] {
    const all: GraphEdge[] = [];
    for (const o of this.nodeMap.values()) if (o.key !== n.key) all.push(...this.edgesBetween(n, o));
    return all;
  }

  private setEdges(a: GraphNode, b: GraphNode): void {
    const es = this.edgesBetween(a, b);
    let m = this.out.get(a.key);
    if (!m) {
      m = new Map();
      this.out.set(a.key, m);
    }
    if (es.length > 0) m.set(b.key, es);
    else m.delete(b.key);
  }

  private edgesBetween(a: GraphNode, b: GraphNode): GraphEdge[] {
    const world = this.world;
    if (!world) return [];
    if (a.surface && b.surface) {
      const walk = this.walkEdge(world, a, b);
      if (walk) return [walk];
      const jump = this.jumpEdge(world, a, b);
      return jump ? [jump] : [];
    }
    if (a.surface && b.kind === 'wallUp' && b.wall) {
      const e = this.mountEdge(world, a, b.wall) ?? this.leapEdge(world, a, b.wall);
      return e ? [e] : [];
    }
    if (a.kind === 'wallUp' && a.wall && b.surface && b.kind === 'ledge' && a.wall.topLedgeId === b.key) {
      const x = this.cornerX(world, a.wall, b.surface);
      return x === null ? [] : [{ kind: 'pullUp', from: a.key, to: b.key, fromLo: a.wall.x, fromHi: a.wall.x, toX: x, effort: ROUTE_EFFORT.climbTransition, effortKind: 'climb' }];
    }
    if (a.surface && a.kind === 'ledge' && b.kind === 'wallDown' && b.wall && b.wall.topLedgeId === a.key) {
      const x = this.cornerX(world, b.wall, a.surface);
      return x === null ? [] : [{ kind: 'swing', from: a.key, to: b.key, fromLo: x, fromHi: x, toX: b.wall.x, effort: ROUTE_EFFORT.climbTransition, effortKind: 'climb' }];
    }
    return [];
  }

  /**
   * x on the top ledge where the cat pulls up / swings down at a wall's top corner, or null when
   * that end of the ledge is not at the wall. A ledge whose landing range was widened by its
   * window's open edge (a tab strip, LedgeSurface.land) also counts when that edge reaches the
   * corner although its stand range starts further in: the cat walks onto it from there.
   */
  cornerX(world: WorldModel, w: WallTrack, top: Surface): number | null {
    const bw = world.bodyWidth(w.scale);
    const inward = w.side === 'left' ? 1 : -1;
    const corner = w.x + inward * bw * 0.5;
    const x = clamp(corner, top.x0, top.x1);
    if (Math.abs(x - w.x) <= bw * 1.25) return x;
    if (!top.landWide) return null;
    const lx = clamp(corner, top.landX0, top.landX1);
    return Math.abs(lx - w.x) <= bw * 1.25 ? lx : null;
  }

  /**
   * Anchor height at which a cat leaping from feet at `feetY` catches the wall: about
   * wallLeapGripDip above its feet, within the climbable stretch, at most wallLeapUpDip up.
   * Null when the stretch is out of leap reach (or not above the feet).
   */
  leapGripY(w: WallTrack, feetY: number, scale: number): number | null {
    const highest = Math.max(w.yTop, feetY - MOVEMENT.wallLeapUpDip * scale);
    if (highest > w.yBottom || highest >= feetY) return null;
    return clamp(feetY - MOVEMENT.wallLeapGripDip * scale, highest, w.yBottom);
  }

  /**
   * Two ledges at the same height whose edges overlap or touch (within a small gap) are
   * walked across. Floors join each other in the world model and are never at a ledge's
   * height. The crossing stretch is where the two edges meet (it may lie in the end insets
   * of the stand ranges; the cat walks out to it, see Mover 'cross').
   */
  private walkEdge(world: WorldModel, a: GraphNode, b: GraphNode): GraphEdge | null {
    const sa = a.surface as Surface;
    const sb = b.surface as Surface;
    if (sa.kind === 'floor' || sb.kind === 'floor') return null;
    if (sb.phase === 'leaving') return null;
    const scale = world.scaleAt({ x: (sa.x0 + sa.x1) / 2, y: sa.y });
    const gap = world.bodyWidth(scale) * MOVEMENT.walkJoinGapBodyLengths;
    const lo = Math.max(sa.landX0, sb.landX0 - gap);
    const hi = Math.min(sa.landX1, sb.landX1 + gap);
    if (lo > hi) return null;
    if (Math.abs(sa.y - sb.y) > MOVEMENT.walkJoinToleranceDip * scale) return null;
    // Cross where the two meet: inside the overlap, or at the end of `sa` facing `sb`.
    const cross0 = Math.max(lo, Math.min(sb.landX0, sa.landX1));
    const cross1 = Math.min(hi, Math.max(sb.landX1, sa.landX0));
    const fromLo = Math.min(cross0, cross1);
    const fromHi = Math.max(cross0, cross1);
    return { kind: 'walk', from: a.key, to: b.key, fromLo, fromHi, toX: null, effort: ROUTE_EFFORT.walkJoin, effortKind: 'walk' };
  }

  private jumpEdge(world: WorldModel, a: GraphNode, b: GraphNode): GraphEdge | null {
    const sa = a.surface as Surface;
    const sb = b.surface as Surface;
    if (sb.phase === 'leaving') return null;
    const scale = world.scaleAt({ x: (sa.x0 + sa.x1) / 2, y: sa.y });
    const maxAcross = MOVEMENT.maxJumpAcrossDip * scale;
    const maxUp = MOVEMENT.maxJumpUpDip * scale;
    const lo = Math.max(sa.x0, sb.x0 - maxAcross);
    const hi = Math.min(sa.x1, sb.x1 + maxAcross);
    if (lo > hi) return null;
    // Representative take-off and landing for the height check: the closest pair of points.
    const tx = clamp((sb.x0 + sb.x1) / 2, lo, hi);
    const lx = clamp(tx, sb.x0, sb.x1);
    const up = world.yAt(sa, tx) - world.yAt(sb, lx);
    if (up > maxUp) return null;
    const across = Math.max(0, sb.x0 - sa.x1, sa.x0 - sb.x1);
    const effort =
      ROUTE_EFFORT.jumpBase +
      MOVEMENT.crouchMs / 1000 +
      (up > 0 ? (ROUTE_EFFORT.jumpUpPerMax * up) / maxUp : (ROUTE_EFFORT.jumpDownPerMax * -up) / maxUp) +
      (ROUTE_EFFORT.jumpAcrossPerMax * across) / maxAcross;
    return { kind: 'jump', from: a.key, to: b.key, fromLo: lo, fromHi: hi, toX: null, effort, effortKind: 'jump' };
  }

  private mountEdge(world: WorldModel, a: GraphNode, w: WallTrack): GraphEdge | null {
    const s = a.surface as Surface;
    if (w.phase === 'leaving' || w.topLedgeId === s.key) return null;
    if (w.standX < s.x0 - 1 || w.standX > s.x1 + 1) return null;
    const ys = world.yAt(s, clamp(w.standX, s.x0, s.x1));
    const bw = world.bodyWidth(w.scale);
    const bh = world.bodyHeight(w.scale);
    if (ys < w.yTop + bw * 0.3 || ys > w.yBottom + bh * MOVEMENT.wallReachBodyHeights) return null;
    const climb = (Math.min(ys, w.yBottom) - w.yTop) / w.scale / MOVEMENT.climbUpDip;
    const x = clamp(w.standX, s.x0, s.x1);
    return { kind: 'mount', from: a.key, to: upKey(w), fromLo: x, fromHi: x, toX: w.x, effort: MOVEMENT.mountMs / 1000 + climb, effortKind: 'climb' };
  }

  /**
   * Leap and cling: where the wall ends too high above the support to step on (and only
   * there, so a side reaching the support keeps its proven step-on), the cat jumps from the
   * same stand point beside it and catches the side within jump reach, then climbs. Effort:
   * the jump (as jumpEdge rates one) plus the climb from the grip to the top.
   */
  private leapEdge(world: WorldModel, a: GraphNode, w: WallTrack): GraphEdge | null {
    const s = a.surface as Surface;
    if (w.phase === 'leaving' || w.topLedgeId === s.key) return null;
    if (w.standX < s.x0 - 1 || w.standX > s.x1 + 1) return null;
    const x = clamp(w.standX, s.x0, s.x1);
    const ys = world.yAt(s, x);
    const bw = world.bodyWidth(w.scale);
    const bh = world.bodyHeight(w.scale);
    if (ys < w.yTop + bw * 0.3 || ys <= w.yBottom + bh * MOVEMENT.wallReachBodyHeights) return null;
    const scale = world.scaleAt({ x, y: ys });
    const grip = this.leapGripY(w, ys, scale);
    if (grip === null) return null;
    const jump = ROUTE_EFFORT.jumpBase + MOVEMENT.crouchMs / 1000 + (ROUTE_EFFORT.jumpUpPerMax * (ys - grip)) / (MOVEMENT.maxJumpUpDip * scale);
    const climb = (grip - w.yTop) / w.scale / MOVEMENT.climbUpDip;
    return { kind: 'leap', from: a.key, to: upKey(w), fromLo: x, fromHi: x, toX: w.x, effort: jump + climb, effortKind: 'climb', jumpPart: jump, gripY: grip };
  }

  private onDemand(n: GraphNode): GraphEdge[] {
    const world = this.world;
    if (!world) return [];
    if (n.kind === 'ledge' && n.surface) return this.dropEdges(world, n.surface);
    if (n.kind === 'wallDown' && n.wall) {
      const e = this.dismountEdge(world, n.wall);
      return e ? [e] : [];
    }
    return [];
  }

  private dropEdges(world: WorldModel, s: Surface): GraphEdge[] {
    const scale = world.scaleAt({ x: (s.x0 + s.x1) / 2, y: s.y });
    const bw = world.bodyWidth(scale);
    const maxUp = MOVEMENT.maxJumpUpDip * scale;
    const others = this.ledgeList.filter((l) => l.key !== s.key);
    const out: GraphEdge[] = [];
    for (const dir of [-1, 1] as const) {
      const endX = dir < 0 ? s.x0 : s.x1;
      const below = world.surfaceBelow(endX + dir * bw * 0.6, s.y + 1, others);
      if (!below || below.y <= s.y + 1 || !this.nodeMap.has(below.surface.key)) continue;
      const effort = ROUTE_EFFORT.dropBase + (ROUTE_EFFORT.dropPerMax * (below.y - s.y)) / maxUp;
      out.push({ kind: 'drop', from: s.key, to: below.surface.key, fromLo: endX, fromHi: endX, toX: below.x, effort, effortKind: 'jump' });
    }
    return out;
  }

  /** Where climbing down a wall ends: the first support beside its foot (possibly below it, then the cat hops down). */
  dismountTarget(world: WorldModel, w: WallTrack): { surface: Surface; x: number; y: number } | null {
    const bw = world.bodyWidth(w.scale);
    const top = w.topLedgeId;
    const below = world.surfaceBelow(w.standX, w.yTop + bw * 0.3, top ? this.ledgeList.filter((l) => l.key !== top) : this.ledgeList);
    return below ? { surface: below.surface, x: below.x, y: below.y } : null;
  }

  private dismountEdge(world: WorldModel, w: WallTrack): GraphEdge | null {
    const t = this.dismountTarget(world, w);
    if (!t || !this.nodeMap.has(t.surface.key)) return null;
    const bh = world.bodyHeight(w.scale);
    const exitY = Math.min(t.y, w.yBottom);
    const climb = (exitY - w.yTop) / w.scale / MOVEMENT.climbDownDip;
    const hop = t.y - w.yBottom > bh * MOVEMENT.wallReachBodyHeights ? ROUTE_EFFORT.dropBase : 0;
    return { kind: 'dismount', from: downKey(w), to: t.surface.key, fromLo: w.x, fromHi: w.x, toX: t.x, effort: MOVEMENT.dismountMs / 1000 + climb + hop, effortKind: 'climb' };
  }
}
