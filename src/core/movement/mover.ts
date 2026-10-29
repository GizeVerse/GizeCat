// The cat's body: grounded locomotion along surfaces, riding moving ledges (window tops,
// taskbars, tab strips), being lifted and lowered by them, climbing window sides, the
// anticipation crouch, ballistic jumps, free fall with wall bounces, and being
// dragged/thrown. Everything is in physical px; DIP constants are scaled by the display
// under the cat. Routes across surfaces come from the SurfaceGraph.
import { CAT_BASE_WIDTH_DIP, type Facing } from '../../shared/cat';
import { heldScruffOffset, HELD_SETTLE_MS } from '../interaction/held';
import type { Point, Rect } from '../../shared/geometry';
import { clamp, rectBottom, rectRight } from '../../shared/geometry';
import type { SimSupport } from '../../shared/sim';
import type { LedgeSurface, Surface as EnvSurface, SurfaceKind, WallSurface } from '../../shared/surfaces';
import type { WorldGeometry } from '../../shared/world';
import { ARRIVE_RADIUS_DIP, MOVEMENT } from './constants';
import type { JumpPlan } from './jump';
import { ballistic, clearanceFor, descendingCrossing, jumpAt, sampleArc, solveJump } from './jump';
import type { GraphNode, Route, RouteParams } from './surfaceGraph';
import { edgeId, SurfaceGraph } from './surfaceGraph';
import type { FloorPiece, Surface, SurfacePoint, WallTrack } from './world';
import { sameSurface, WorldModel } from './world';

export type Pace = 'slow' | 'walk' | 'run' | 'chase';

/** 'climb': the cat chose to climb (climbing is strongly preferred); 'noClimb': never via a wall. */
export type RoutePreference = 'any' | 'climb' | 'noClimb';

export interface MoveGoal {
  x: number;
  y: number;
  pace: Pace;
  /** false = stay on the current surface (cursor chase, following a window). */
  allowJump: boolean;
  /** Arrival tolerance in px; defaults to ~3 DIP. */
  arriveRadiusPx?: number;
  /** How to get there across surfaces (default 'any'). */
  route?: RoutePreference;
  /**
   * The goal names exactly the surface under (x, y). Without it, a floor goal under a
   * taskbar the cat was lifted onto stays on the taskbar (the cat does not hop off just
   * because the taskbar rose under it); with it the cat really goes down to the floor.
   */
  literal?: boolean;
}

export interface MoverConfig {
  size: number;
  movementSpeed: number;
  allowMultiMonitor: boolean;
  /** Window tops ('Sit on windows'). Taskbars are always supports: a shown one covers the floor ('taskbarPlay' is the sim's). */
  perchOnWindows: boolean;
  /** Climbing window sides ('climbWindows'; default true; also needs window tops). */
  walls?: boolean;
  /** Browser tab strips ('tabStrips'; default true). */
  tabStrips?: boolean;
  /** Personality multipliers for route effort (1 = neutral; higher = avoids that kind of move). */
  jumpEffort?: number;
  climbEffort?: number;
}

export interface MoverInput {
  now: number;
  dtMs: number;
  dragCursor: Point | null;
  /** Live geometry of one surface by id (the one the cat is attached to or jumping onto), or null when gone. */
  getSurface?: (id: string) => EnvSurface | null;
  /** Windows the user is currently moving (the surface list may lag for these). */
  movingWindowIds?: ReadonlySet<string>;
  /** @deprecated v1 window-rect lookup. Ignored: riding uses `getSurface`. Accepted so older callers compile. */
  getWindowRect?: (id: string) => Rect | null;
}

export interface LandingInfo {
  /** Vertical impact speed, DIP/s. */
  impactDip: number;
  thrown: boolean;
  /** Planned jump or deliberate step-off. */
  intentional: boolean;
  /** Height fallen from the highest point of the flight, DIP. */
  fallHeightDip: number;
  /** Landing had to be forced (fell outside the world). */
  forced: boolean;
}

export type GoalStatus = 'none' | 'moving' | 'arrived' | 'unreachable';

/**
 * Why the cat lost the surface it stood on or clung to:
 * gone       getSurface returned null and the window lists no surfaces any more (closed,
 *            minimized, maximized, surface removed);
 * retracted  a taskbar slid away under it, or its ledge sank below the floor;
 * occluded   its spot is covered while the window stays (a window in front), or the surface
 *            stayed out of the usable list or from under its paws (private, cut short) past the grace;
 * headroom   the ledge moved too close to the top of the screen or off every display;
 * disabled   the user switched that kind of surface off.
 */
export type SupportLossReason = 'gone' | 'retracted' | 'occluded' | 'headroom' | 'disabled';

export interface SupportLoss {
  reason: SupportLossReason;
  surfaceId: string;
  surfaceKind: SurfaceKind;
  /** true: the cat is falling now; false: it was set down on the surface just below. */
  fell: boolean;
}

export interface MoverStep {
  goal: GoalStatus;
  crouchStarted: boolean;
  tookOff: boolean;
  steppedOff: boolean;
  landed: LandingInfo | null;
  /** The support was lost and the cat started falling (see supportLost for why). */
  perchLost: boolean;
  snapped: boolean;
  supportLost: SupportLoss | null;
  /** A ledge rising through the cat's feet picked it up. */
  lifted: { surfaceId: string; surfaceKind: SurfaceKind } | null;
  /** A sinking or vanished support set the cat down on the surface below without a fall. */
  lowered: boolean;
  climbStarted: boolean;
  climbEnded: boolean;
}

export type MoverMode = 'ground' | 'crouch' | 'air' | 'held' | 'climb';

/** A climb the behaviour may start from where the cat stands. */
export interface ClimbOption {
  dir: 'up' | 'down';
  wallId: string;
  ownerId: string;
  /** Where the climb ends (the top ledge's corner, or the support below the wall). */
  target: Point;
  /** Where on the current surface the climb starts (beside the wall, or at the ledge's corner). */
  startX: number;
}

type Leg =
  | { kind: 'walk'; x: number; reachable: boolean }
  | { kind: 'jump'; takeoffX: number; landX: number; target: Surface }
  | { kind: 'drop'; dir: 1 | -1 }
  | { kind: 'cross'; x: number; to: Surface }
  | { kind: 'climbUp'; standX: number; wall: WallTrack; ledgeKey: string; cornerX: number }
  | { kind: 'climbDown'; cornerX: number; wall: WallTrack };

interface Flight {
  t0: number;
  lastT: number;
  x0: number;
  y0: number;
  vx: number;
  vy0: number;
  g: number;
  plan: JumpPlan | null;
  target: Surface | null;
  thrown: boolean;
  intentional: boolean;
  /** Ledge the cat just left (not landed on again during this flight). */
  ignoreKey: string | null;
  peakY: number;
  scale: number;
  startedAt: number;
}

/** The ledge the cat stands on, tracked through the provider's live geometry. */
interface Attachment {
  surfaceId: string;
  ownerId: string;
  surfaceKind: SurfaceKind;
  y: number;
  x0: number;
  x1: number;
  missingSince: number | null;
  /** The user switched this kind of surface off: the cat leaves it calmly. */
  disabled: boolean;
}

interface Climb {
  wall: WallTrack;
  phase: 'mount' | 'swing' | 'climb' | 'pullUp' | 'dismount';
  /** -1 = up, +1 = down. */
  dir: -1 | 1;
  t0: number;
  durationMs: number;
  from: Point;
  to: Point;
  /** Top ledge for the pull-up (null: none; the cat climbs down instead). */
  topKey: string | null;
  cornerX: number | null;
  /** Dismount target, chosen when the bottom is reached. */
  exit: { surface: Surface; x: number } | null;
  missingSince: number | null;
  /** The goal changed while climbing: reconsider the direction. */
  replan: boolean;
}

interface Crouch {
  until: number;
  landX: number;
  target: Surface;
  clearanceDip: number | null;
}

interface Drag {
  /** Anchor minus cursor where the user grabbed the cat. */
  grabX: number;
  grabY: number;
  /** Current anchor minus cursor: slides from the grab point to the scruff. */
  offX: number;
  offY: number;
  /** Time of the first held step (null until then). */
  t0: number | null;
}

const MAX_FLIGHT_MS = 6000;
const NO_MOVING: ReadonlySet<string> = new Set<string>();

function isLedgeSurface(s: unknown): s is LedgeSurface {
  if (!s || typeof s !== 'object') return false;
  const l = s as LedgeSurface;
  return l.orientation === 'ledge' && Number.isFinite(l.y) && Number.isFinite(l.x0) && Number.isFinite(l.x1) && l.x1 > l.x0;
}

function isWallSurface(s: unknown): s is WallSurface {
  if (!s || typeof s !== 'object') return false;
  const w = s as WallSurface;
  return w.orientation === 'wall' && Number.isFinite(w.x) && Number.isFinite(w.y0) && Number.isFinite(w.y1) && w.y1 > w.y0;
}

export class Mover {
  x = 0;
  y = 0;
  vx = 0;
  vy = 0;
  facing: Facing = 1;
  private facingChangedAt = -Infinity;
  private modeValue: MoverMode = 'ground';
  private surface: Surface;
  private attach: Attachment | null = null;
  private climbing: Climb | null = null;
  private flight: Flight | null = null;
  private crouch: Crouch | null = null;
  private drag: Drag | null = null;
  private goal: MoveGoal | null = null;
  private leg: Leg | null = null;
  private ledges: Surface[] = [];
  private walls: WallTrack[] = [];
  private readonly graph = new SurfaceGraph();
  private readonly blockedEdges = new Set<string>();
  /** Easing of the anchor height toward its support (after a lift or a gentle set-down), px/s; 0 = none. */
  private easeRate = 0;
  private fullWorld: WorldModel;
  private navWorld: WorldModel;
  private homeDisplayId: string;
  private cfg: MoverConfig;
  private geometry: WorldGeometry;
  private offLimits: ReadonlySet<string> = new Set<string>();
  /** Owners (windows, taskbars) with any surface in this tick's list: a window that lists something is still there. */
  private listedOwners: ReadonlySet<string> = new Set<string>();

  constructor(geometry: WorldGeometry, cfg: MoverConfig, start: { displayId: string | null; xFrac: number }) {
    this.cfg = { ...cfg };
    this.geometry = geometry;
    this.fullWorld = new WorldModel(geometry, cfg.size, cfg.allowMultiMonitor);
    const d = (start.displayId !== null ? this.fullWorld.display(start.displayId) : undefined) ?? this.fullWorld.primary;
    this.homeDisplayId = d.id;
    this.navWorld = this.buildNav();
    const floor = this.navWorld.floorFor(d.id) ?? this.navWorld.firstFloor;
    const xFrac = Number.isFinite(start.xFrac) ? clamp(start.xFrac, 0, 1) : 0.5;
    const p = this.navWorld.floorPoint(floor, d.workAreaPx.x + d.workAreaPx.width * xFrac);
    this.surface = floor;
    this.x = p.x;
    this.y = p.y;
    this.graph.update(this.navWorld, [], []);
  }

  // ---- queries ---------------------------------------------------------------

  get mode(): MoverMode {
    return this.modeValue;
  }
  get world(): WorldModel {
    return this.navWorld;
  }
  get fullWorldModel(): WorldModel {
    return this.fullWorld;
  }
  /** Usable ledges this tick (taskbars, window tops, tab strips). */
  get ledgeSurfaces(): readonly Surface[] {
    return this.ledges;
  }
  /** Usable climbable walls this tick. */
  get wallTracks(): readonly WallTrack[] {
    return this.walls;
  }
  get currentSurface(): Surface | null {
    return this.modeValue === 'ground' || this.modeValue === 'crouch' ? this.surface : null;
  }
  get grounded(): boolean {
    return this.modeValue === 'ground';
  }
  get airborne(): boolean {
    return this.modeValue === 'air';
  }
  get held(): boolean {
    return this.modeValue === 'held';
  }
  /** Clinging to a wall (climbing, pulling up or stepping on/off it). */
  get onWall(): boolean {
    return this.modeValue === 'climb' && this.climbing !== null;
  }
  /** Phase of the current wall manoeuvre, or null when not on a wall. */
  get climbPhase(): Climb['phase'] | null {
    return this.modeValue === 'climb' ? (this.climbing?.phase ?? null) : null;
  }
  /** The wall the cat clings to, or null. */
  get wall(): WallTrack | null {
    return this.modeValue === 'climb' ? (this.climbing?.wall ?? null) : null;
  }
  get thrownFlight(): boolean {
    return this.flight?.thrown ?? false;
  }
  /** Owning window of the ledge or wall the cat is on (null on floors and taskbars). */
  get perchWindowId(): string | null {
    if (this.modeValue === 'climb') return this.climbing?.wall.ownerId || null;
    const a = this.attach;
    return a && a.surfaceKind !== 'taskbar' && (this.modeValue === 'ground' || this.modeValue === 'crouch') ? a.ownerId || null : null;
  }
  /** The environment surface the cat is attached to (ledge or wall), or null. */
  get attachedSurface(): { surfaceId: string; surfaceKind: SurfaceKind; ownerId: string } | null {
    if (this.modeValue === 'climb' && this.climbing) return { surfaceId: this.climbing.wall.key, surfaceKind: 'windowSide', ownerId: this.climbing.wall.ownerId };
    const a = this.attach;
    return a && (this.modeValue === 'ground' || this.modeValue === 'crouch') ? { surfaceId: a.surfaceId, surfaceKind: a.surfaceKind, ownerId: a.ownerId } : null;
  }
  get hasGoal(): boolean {
    return this.goal !== null;
  }
  get scale(): number {
    return this.fullWorld.scaleAt({ x: this.x, y: this.y });
  }
  get bodyWidth(): number {
    return this.fullWorld.bodyWidth(this.scale);
  }
  get bodyHeight(): number {
    return this.fullWorld.bodyHeight(this.scale);
  }
  get displayId(): string {
    const p = { x: this.x, y: this.y };
    return (this.fullWorld.displayAt(p) ?? this.fullWorld.nearestDisplay(p)).id;
  }
  get support(): SimSupport {
    switch (this.modeValue) {
      case 'air':
        return { kind: 'air' };
      case 'held':
        return { kind: 'held' };
      case 'climb':
        if (this.climbing) return { kind: 'surface', surfaceId: this.climbing.wall.key, surfaceKind: 'windowSide', orientation: 'wall' };
        return { kind: 'air' };
      default:
        if (this.attach) return { kind: 'surface', surfaceId: this.attach.surfaceId, surfaceKind: this.attach.surfaceKind, orientation: 'ledge' };
        return { kind: 'floor', displayId: this.navWorld.displayIdOn(this.surface, this.x) };
    }
  }
  /** Horizontal ground speed in px/s (0 while airborne, held or climbing). */
  get groundSpeed(): number {
    return this.modeValue === 'ground' ? Math.abs(this.vx) : 0;
  }
  /** Still easing toward its support's height (lifted by a rising ledge, or set down by a vanished one). */
  get settling(): boolean {
    return this.easeRate > 0;
  }
  /** Speed along the wall while climbing, px/s (0 otherwise). */
  get climbSpeed(): number {
    return this.modeValue === 'climb' && this.climbing?.phase === 'climb' ? Math.abs(this.vy) : 0;
  }
  paceSpeedPx(pace: Pace): number {
    const dip = pace === 'run' ? MOVEMENT.runDip : pace === 'chase' ? MOVEMENT.chaseDip : pace === 'slow' ? MOVEMENT.slowDip : MOVEMENT.walkDip;
    return dip * this.cfg.movementSpeed * this.scale;
  }
  /** Where the cat may walk on its current surface (null while airborne, held or climbing). */
  get walkRange(): { x0: number; x1: number } | null {
    const s = this.currentSurface;
    return s ? this.rangeOn(s, this.x) : null;
  }
  /** The cat may not walk, jump or be called onto this display (it may stay on the one it is on). */
  isOffLimits(displayId: string): boolean {
    return this.offLimits.has(displayId) && displayId !== this.displayId;
  }
  /** A usable ledge by id this tick. */
  ledgeById(id: string): Surface | null {
    return this.ledges.find((l) => l.key === id) ?? null;
  }
  /** Non-sensitive graph statistics for diagnostics. */
  graphInfo(): { nodes: number; edges: number; ledges: number; walls: number; updates: number; rebuilds: number; lastChanged: number } {
    return {
      nodes: this.graph.nodes.size,
      edges: this.graph.edgeCount,
      ledges: this.ledges.length,
      walls: this.walls.length,
      updates: this.graph.updates,
      rebuilds: this.graph.rebuilds,
      lastChanged: this.graph.lastChanged,
    };
  }

  /** Climbs that can start from the surface the cat stands on (up a wall beside it, or down from the ledge's corner). */
  climbOptions(): ClimbOption[] {
    if (this.modeValue !== 'ground' || !this.wallsEnabled()) return [];
    const out: ClimbOption[] = [];
    const s = this.surface;
    for (const e of this.graph.edgesFrom(s.key)) {
      const node = this.graph.node(e.to);
      const w = node?.wall;
      if (!node || !w || this.nodeBlocked(node)) continue;
      if (e.kind === 'mount' && w.topLedgeId) {
        const top = this.ledgeById(w.topLedgeId);
        const cx = top ? this.graph.cornerX(this.navWorld, w, top) : null;
        if (top && cx !== null) out.push({ dir: 'up', wallId: w.key, ownerId: w.ownerId, target: { x: cx, y: top.y }, startX: e.fromLo });
      } else if (e.kind === 'swing') {
        const t = this.graph.dismountTarget(this.navWorld, w);
        if (t && !this.offLimitsAt(t.surface, t.x)) out.push({ dir: 'down', wallId: w.key, ownerId: w.ownerId, target: { x: t.x, y: t.y }, startX: e.fromLo });
      }
    }
    return out;
  }

  // ---- configuration ---------------------------------------------------------

  setWorld(geometry: WorldGeometry): boolean {
    this.geometry = geometry;
    this.fullWorld = new WorldModel(geometry, this.cfg.size, this.cfg.allowMultiMonitor);
    return this.revalidate();
  }

  setConfig(cfg: MoverConfig): boolean {
    const rebuild = cfg.size !== this.cfg.size || cfg.allowMultiMonitor !== this.cfg.allowMultiMonitor;
    this.cfg = { ...cfg };
    this.ledges = this.ledges.filter((l) => l.surfaceKind !== null && this.kindEnabled(l.surfaceKind));
    if (!this.wallsEnabled()) this.walls = [];
    this.graph.update(this.navWorld, this.ledges, this.walls);
    if (this.attach && !this.kindEnabled(this.attach.surfaceKind)) this.attach.disabled = true;
    if (!rebuild) return false;
    if (!cfg.allowMultiMonitor) this.homeDisplayId = this.displayId;
    this.fullWorld = new WorldModel(this.geometry, cfg.size, cfg.allowMultiMonitor);
    return this.revalidate();
  }

  /**
   * Displays with a fullscreen app in front. The cat treats them as off limits: a
   * shared floor ends at their edge like a wall, their surfaces are ignored and
   * no walk or jump ends on them. The display the cat is already on stays usable.
   */
  setOffLimitsDisplays(ids: readonly string[]): void {
    const next = new Set(ids);
    if (next.size === this.offLimits.size && [...next].every((id) => this.offLimits.has(id))) return;
    this.offLimits = next;
    this.leg = null;
  }

  /**
   * Refreshes the usable ledges and walls for this tick from the environment's surfaces
   * (already privacy-filtered by the caller) and updates the surface graph incrementally.
   */
  sense(surfaces: readonly EnvSurface[]): void {
    const ledgesIn: LedgeSurface[] = [];
    const wallsIn: WallSurface[] = [];
    const owners = new Set<string>();
    const walls = this.wallsEnabled();
    for (const s of surfaces) {
      if (!s || typeof s !== 'object') continue;
      if (typeof s.ownerId === 'string' && s.ownerId.length > 0) owners.add(s.ownerId);
      if (s.orientation === 'ledge') {
        if (this.kindEnabled(s.kind)) ledgesIn.push(s);
      } else if (s.orientation === 'wall' && walls) {
        wallsIn.push(s);
      }
    }
    this.listedOwners = owners;
    const keep = this.keptIds();
    let ledges = this.navWorld.ledgeSurfaces(ledgesIn, keep.ledges);
    let wallTracks = this.navWorld.wallTracks(wallsIn, keep.walls);
    if (this.offLimits.size > 0) {
      ledges = ledges.filter((l) => !l.displayIds.some((id) => this.isOffLimits(id)));
      wallTracks = wallTracks.filter((w) => !this.isOffLimits(w.displayId));
    }
    this.ledges = ledges;
    this.walls = wallTracks;
    this.graph.update(this.navWorld, ledges, wallTracks);
    if (this.attach && !this.kindEnabled(this.attach.surfaceKind)) this.attach.disabled = true;
  }

  /** The ledges and walls the cat is on or heading for: the per-kind list caps never drop them. */
  private keptIds(): { ledges: Set<string>; walls: Set<string> } {
    const ledges = new Set<string>();
    const walls = new Set<string>();
    const ledge = (s: Surface | null | undefined): void => {
      if (s?.kind === 'ledge') ledges.add(s.key);
    };
    if (this.attach) ledges.add(this.attach.surfaceId);
    const c = this.climbing;
    if (c) {
      walls.add(c.wall.key);
      if (c.topKey) ledges.add(c.topKey);
      ledge(c.exit?.surface);
    }
    ledge(this.crouch?.target);
    ledge(this.flight?.target);
    const leg = this.leg;
    if (leg?.kind === 'jump') ledge(leg.target);
    else if (leg?.kind === 'cross') ledge(leg.to);
    else if (leg?.kind === 'climbUp') {
      walls.add(leg.wall.key);
      ledges.add(leg.ledgeKey);
    } else if (leg?.kind === 'climbDown') walls.add(leg.wall.key);
    return { ledges, walls };
  }

  // ---- goals -----------------------------------------------------------------

  setGoal(goal: MoveGoal | null): void {
    if (!goal || !Number.isFinite(goal.x) || !Number.isFinite(goal.y)) {
      this.goal = null;
      this.leg = null;
      return;
    }
    const prev = this.goal;
    this.goal = goal;
    const changed =
      !prev ||
      prev.allowJump !== goal.allowJump ||
      (prev.route ?? 'any') !== (goal.route ?? 'any') ||
      (prev.literal ?? false) !== (goal.literal ?? false) ||
      Math.abs(prev.y - goal.y) > 2 ||
      Math.abs(prev.x - goal.x) > this.bodyWidth * 0.5;
    if (changed) {
      this.leg = null;
      this.blockedEdges.clear();
      if (this.climbing) this.climbing.replan = true;
    }
  }

  /** Projects a screen point onto the surface the cat would stand on there. */
  surfacePointFor(p: Point): SurfacePoint {
    const q = this.navWorld.clampInside(p);
    return this.navWorld.surfaceBelow(q.x, q.y - 2, this.ledges) ?? this.navWorld.nearestFloorPoint(q);
  }

  /** Whether a destination can be reached (walking, jumping, dropping or climbing). */
  canReach(p: Point, route: RoutePreference = 'any'): boolean {
    if (this.modeValue !== 'ground' && this.modeValue !== 'crouch') return false;
    const dest = this.surfacePointFor(p);
    if (sameSurface(this.surface, dest.surface)) {
      const r = this.rangeOn(this.surface, this.x);
      return dest.x >= r.x0 - 1 && dest.x <= r.x1 + 1;
    }
    // A hypothetical plan must not leave edges blocked for the goal the cat is pursuing.
    const blocked = [...this.blockedEdges];
    try {
      const leg = this.planLeg({ x: dest.x, y: dest.y, pace: 'walk', allowJump: true, route, literal: true }, this.surface);
      return leg.kind !== 'walk' || leg.reachable;
    } finally {
      this.blockedEdges.clear();
      for (const id of blocked) this.blockedEdges.add(id);
    }
  }

  faceToward(x: number, now: number): void {
    const minDist = this.bodyWidth * 0.6;
    if (Math.abs(x - this.x) < minDist || this.modeValue !== 'ground' || Math.abs(this.vx) > 1) return;
    const want: Facing = x > this.x ? 1 : -1;
    if (want !== this.facing && now - this.facingChangedAt >= MOVEMENT.turnToLookMs) {
      this.facing = want;
      this.facingChangedAt = now;
    }
  }

  /** Small playful hop on the current surface. */
  hop(now: number): boolean {
    return this.hopTo(now, this.x + this.facing * this.bodyWidth * 0.35);
  }

  /**
   * Playful pounce toward `x` on the current surface: a low hop of at most
   * MOVEMENT.pounceMaxBodyLengths, facing the target. False when it cannot pounce.
   */
  pounce(now: number, x: number): boolean {
    if (this.modeValue !== 'ground' || !Number.isFinite(x)) return false;
    const max = MOVEMENT.pounceMaxBodyLengths * this.bodyWidth;
    const dx = clamp(x - this.x, -max, max);
    if (Math.abs(dx) < this.bodyWidth * 0.25) return false;
    this.setFacing(dx > 0 ? 1 : -1, now);
    return this.hopTo(now, this.x + dx);
  }

  private hopTo(now: number, x: number): boolean {
    if (this.modeValue !== 'ground') return false;
    const s = this.surface;
    const r = this.rangeOn(s, this.x);
    const landX = clamp(x, r.x0, r.x1);
    this.goal = null;
    this.leg = null;
    this.vx = 0;
    this.modeValue = 'crouch';
    this.crouch = { until: now + MOVEMENT.crouchMs, landX, target: s, clearanceDip: MOVEMENT.hopClearanceDip };
    return true;
  }

  /** Aborts an anticipation crouch (the jump will not happen). */
  cancelCrouch(): void {
    if (this.modeValue !== 'crouch') return;
    this.crouch = null;
    this.modeValue = 'ground';
    this.goal = null;
    this.leg = null;
  }

  // ---- drag ------------------------------------------------------------------

  startDrag(at: Point): void {
    const bw = this.bodyWidth;
    const bh = this.bodyHeight;
    const offX = Number.isFinite(at.x) ? clamp(this.x - at.x, -bw, bw) : 0;
    const offY = Number.isFinite(at.y) ? clamp(this.y - at.y, -bh * 0.25, bh * 1.25) : bh * 0.5;
    this.drag = { grabX: offX, grabY: offY, offX, offY, t0: null };
    this.modeValue = 'held';
    this.flight = null;
    this.crouch = null;
    this.attach = null;
    this.climbing = null;
    this.easeRate = 0;
    this.goal = null;
    this.leg = null;
    this.vx = 0;
    this.vy = 0;
  }

  /** Releases the cat. Returns the release speed in DIP/s (after clamping). */
  endDrag(at: Point | null, velocity: Point, now: number, allowThrow: boolean): { speedDip: number; thrown: boolean } {
    if (this.modeValue !== 'held') return { speedDip: 0, thrown: false };
    const d = this.drag ?? { grabX: 0, grabY: 0, offX: 0, offY: 0, t0: null };
    if (at && Number.isFinite(at.x) && Number.isFinite(at.y)) {
      // The release point only corrects the last drag sample; a far-off point (stale
      // or out-of-order event) must not teleport the cat away from where it is shown.
      const p = this.fullWorld.clampInside({ x: at.x + d.offX, y: at.y + d.offY });
      if (Math.hypot(p.x - this.x, p.y - this.y) <= this.bodyWidth * 2) {
        this.x = p.x;
        this.y = p.y;
      }
    }
    const scale = this.scale;
    let vx = allowThrow && Number.isFinite(velocity.x) ? velocity.x : 0;
    let vy = allowThrow && Number.isFinite(velocity.y) ? velocity.y : 0;
    const max = MOVEMENT.maxThrowDip * scale;
    const mag = Math.hypot(vx, vy);
    if (mag > max) {
      vx = (vx / mag) * max;
      vy = (vy / mag) * max;
    }
    const speed = Math.hypot(vx, vy);
    if (speed < MOVEMENT.dropSpeedDip * scale) {
      vx = 0;
      vy = 0;
    }
    if (!this.cfg.allowMultiMonitor) {
      this.homeDisplayId = this.displayId;
      this.navWorld = this.buildNav();
    }
    this.drag = null;
    const thrown = speed > MOVEMENT.hardThrowDip * scale;
    this.startFlight(vx, vy, now, { thrown, intentional: false, ignoreKey: null });
    return { speedDip: speed / scale, thrown };
  }

  // ---- immediate placement ---------------------------------------------------

  /** Lands immediately on the floor below (quit, hide). Returns true if the cat moved. */
  settleNow(): boolean {
    if (this.modeValue === 'ground') return false;
    if (this.modeValue === 'crouch') {
      this.crouch = null;
      this.modeValue = 'ground';
      return false;
    }
    const p = this.navWorld.clampInside({ x: this.x, y: this.y });
    const below = this.navWorld.surfaceBelow(p.x, p.y, []) ?? this.navWorld.nearestFloorPoint(p);
    this.setGrounded(below.surface, below.x, null);
    this.drag = null;
    return true;
  }

  /**
   * Puts the cat at once on the floor below `p`, used when it is called away from a
   * display with a fullscreen app in front. Returns false (and leaves it where it is)
   * when it is held or that floor point is on an off-limits display.
   */
  relocate(p: Point): boolean {
    if (this.modeValue === 'held' || !Number.isFinite(p.x) || !Number.isFinite(p.y)) return false;
    const fp = this.navWorld.nearestFloorPoint(this.navWorld.clampInside(p));
    if (this.offLimits.has(this.navWorld.displayIdOn(fp.surface, fp.x))) return false;
    const r = this.openRunAt(fp.surface, fp.x, null);
    this.goal = null;
    this.setGrounded(fp.surface, clamp(fp.x, r.x0, r.x1), null);
    return true;
  }

  // ---- simulation step -------------------------------------------------------

  /**
   * While the cat is away (hidden), nothing moves by itself, but it stays with the ledge it
   * stands on (a window dragged meanwhile carries it along) and never keeps a support that
   * vanished or stayed unlisted past its grace: then it is put straight on the floor below.
   * Returns true when it was moved discontinuously (snap).
   */
  stepAway(input: MoverInput): boolean {
    if (this.modeValue !== 'ground' || !this.attach) return false;
    this.goal = null;
    this.leg = null;
    const out = emptyStep();
    const kept = this.ride(input, out);
    if (kept && this.modeValue === 'ground') {
      this.applySupportY(Math.max(0, input.dtMs) / 1000);
      return out.snapped;
    }
    if (this.modeValue === 'ground') {
      // Set down on the surface below: no easing while nobody sees it.
      this.easeRate = 0;
      this.y = this.attach ? this.attach.y : this.navWorld.yAt(this.surface, this.x);
      return true;
    }
    this.settleNow();
    return true;
  }

  step(input: MoverInput): MoverStep {
    const out = emptyStep();
    switch (this.modeValue) {
      case 'held':
        this.stepHeld(input);
        break;
      case 'air':
        this.stepAir(input, out);
        break;
      case 'crouch':
        this.stepCrouch(input, out);
        break;
      case 'climb':
        this.stepClimb(input, out);
        break;
      case 'ground':
        this.stepGround(input, out);
        break;
    }
    if (this.modeValue === 'air') this.updateFacing(this.vx, input.now);
    if (this.goal && out.goal === 'none' && this.modeValue !== 'ground') out.goal = 'moving';
    return out;
  }

  private stepHeld(input: MoverInput): void {
    const d = this.drag;
    if (!d || !input.dragCursor || !Number.isFinite(input.dragCursor.x) || !Number.isFinite(input.dragCursor.y)) return;
    // The renderer hangs the held cat from its scruff: slide the grab point there while
    // the pose cross-fades into `held`, so the cursor ends up holding the scruff.
    if (d.t0 === null) d.t0 = input.now;
    const k = clamp((input.now - d.t0) / HELD_SETTLE_MS, 0, 1);
    const e = k * k * (3 - 2 * k);
    const scruff = heldScruffOffset(this.facing, this.bodyWidth / CAT_BASE_WIDTH_DIP);
    d.offX = d.grabX + (scruff.x - d.grabX) * e;
    d.offY = d.grabY + (scruff.y - d.grabY) * e;
    const p = this.fullWorld.clampInside({ x: input.dragCursor.x + d.offX, y: input.dragCursor.y + d.offY });
    this.x = p.x;
    this.y = p.y;
  }

  private stepGround(input: MoverInput, out: MoverStep): void {
    if (this.attach && !this.ride(input, out)) return;
    if (this.modeValue !== 'ground') return;
    this.checkLift(input, out);
    const dt = Math.max(0, input.dtMs) / 1000;
    const s = this.surface;
    let range = this.rangeOn(s, this.x);
    let targetX = this.x;
    let pace: Pace = 'walk';
    let stepOffDir = 0;
    if (this.goal) {
      pace = this.goal.pace;
      if (!this.goal.allowJump) {
        const x = clamp(this.goal.x, range.x0, range.x1);
        this.leg = { kind: 'walk', x, reachable: Math.abs(x - this.goal.x) <= this.arriveRadius() };
      } else if (!this.leg) {
        this.leg = this.planLeg(this.goal, s);
      }
      const leg = this.leg;
      switch (leg.kind) {
        case 'walk':
          targetX = leg.x;
          break;
        case 'jump':
          targetX = leg.takeoffX;
          break;
        case 'cross':
          // Walk out to where the edges meet (possibly past the stand range's end inset).
          targetX = clamp(leg.x, s.landX0, s.landX1);
          range = { x0: Math.min(range.x0, targetX), x1: Math.max(range.x1, targetX) };
          break;
        case 'climbUp':
          targetX = leg.standX;
          break;
        case 'climbDown':
          targetX = leg.cornerX;
          break;
        case 'drop':
          stepOffDir = leg.dir;
          targetX = leg.dir > 0 ? s.x1 + this.bodyWidth : s.x0 - this.bodyWidth;
          break;
      }
    }

    const scale = this.scale;
    const vmax = this.paceSpeedPx(pace);
    const dx = targetX - this.x;
    const desired = Math.abs(dx) > 0.25 ? Math.sign(dx) * Math.min(vmax, Math.sqrt(2 * MOVEMENT.brakeDip * scale * Math.abs(dx))) : 0;
    const speedingUp = Math.sign(desired) === Math.sign(this.vx) && Math.abs(desired) > Math.abs(this.vx);
    const accel = (speedingUp ? MOVEMENT.accelDip : MOVEMENT.brakeDip) * scale * this.cfg.movementSpeed;
    this.vx = approach(this.vx, desired, accel * dt);
    let nx = this.x + this.vx * dt;
    if ((dx > 0 && nx > targetX) || (dx < 0 && nx < targetX) || Math.abs(dx) <= 0.25) {
      nx = targetX;
      this.vx = 0;
    }
    if (nx > range.x1 || nx < range.x0) {
      const dir: 1 | -1 = nx > range.x1 ? 1 : -1;
      if (stepOffDir === dir) {
        this.x = dir > 0 ? s.x1 : s.x0;
        const vx = dir * Math.max(Math.abs(this.vx), this.paceSpeedPx('walk') * 0.8);
        this.startFlight(vx, 0, input.now, { thrown: false, intentional: true, ignoreKey: this.attach?.surfaceId ?? null });
        out.steppedOff = true;
        out.goal = 'moving';
        return;
      }
      nx = clamp(nx, range.x0, range.x1);
      this.vx = 0;
    }
    this.x = nx;
    this.applySupportY(dt);
    this.updateFacing(this.vx, input.now);

    if (!this.goal || !this.leg) return;
    const leg = this.leg;
    const settled = Math.abs(this.vx) < 1;
    switch (leg.kind) {
      case 'jump':
        if (Math.abs(this.x - leg.takeoffX) <= 1 && settled) {
          this.vx = 0;
          if (Math.abs(leg.landX - this.x) > 2) this.setFacing(leg.landX > this.x ? 1 : -1, input.now);
          this.modeValue = 'crouch';
          this.crouch = { until: input.now + MOVEMENT.crouchMs, landX: leg.landX, target: leg.target, clearanceDip: null };
          out.crouchStarted = true;
        }
        out.goal = 'moving';
        return;
      case 'cross':
        if (Math.abs(this.x - clamp(leg.x, s.landX0, s.landX1)) <= 1) this.crossTo(leg.to, input);
        out.goal = 'moving';
        return;
      case 'climbUp':
        if (Math.abs(this.x - leg.standX) <= 1 && settled) this.startClimbUp(leg, input, out);
        out.goal = 'moving';
        return;
      case 'climbDown':
        if (Math.abs(this.x - leg.cornerX) <= 1 && settled) this.startClimbDown(leg, input, out);
        out.goal = 'moving';
        return;
      case 'walk':
        if (Math.abs(this.x - leg.x) <= this.arriveRadius() && settled) {
          out.goal = leg.reachable ? 'arrived' : 'unreachable';
          return;
        }
        out.goal = 'moving';
        return;
      case 'drop':
        out.goal = 'moving';
        return;
    }
  }

  /** Puts the anchor at the height of its support, easing after a lift or a gentle set-down. */
  private applySupportY(dt: number): void {
    const target = this.attach ? this.attach.y : this.navWorld.yAt(this.surface, this.x);
    if (this.easeRate > 0) {
      this.y = approach(this.y, target, this.easeRate * dt);
      if (Math.abs(this.y - target) < 0.01) {
        this.y = target;
        this.easeRate = 0;
      }
      return;
    }
    this.y = target;
  }

  private stepCrouch(input: MoverInput, out: MoverStep): void {
    if (this.attach && !this.ride(input, out)) {
      this.crouch = null;
      if (this.modeValue === 'crouch') this.modeValue = 'ground';
      return;
    }
    const c = this.crouch;
    if (!c) {
      this.modeValue = 'ground';
      return;
    }
    this.applySupportY(Math.max(0, input.dtMs) / 1000);
    if (input.now < c.until) return;
    this.crouch = null;
    const target = this.revalidateTarget(c.target, c.landX);
    if (!target || this.offLimitsAt(target, c.landX)) {
      this.modeValue = 'ground';
      this.leg = null;
      return;
    }
    const landX = clamp(c.landX, target.x0, target.x1);
    const from = { x: this.x, y: this.y };
    const to = { x: landX, y: this.navWorld.yAt(target, landX) };
    const scale = this.scale;
    const maxUp = MOVEMENT.maxJumpUpDip * scale;
    const plan =
      from.y - to.y <= maxUp && Math.abs(to.x - from.x) <= MOVEMENT.maxJumpAcrossDip * scale + 1
        ? this.solveChecked(from, to, c.clearanceDip !== null ? c.clearanceDip * scale : null)
        : null;
    if (!plan) {
      this.modeValue = 'ground';
      this.leg = null;
      return;
    }
    const ignore = this.attach?.surfaceId ?? null;
    this.attach = null;
    this.easeRate = 0;
    this.modeValue = 'air';
    this.flight = {
      t0: input.now,
      lastT: input.now,
      x0: from.x,
      y0: from.y,
      vx: plan.vx,
      vy0: plan.vy0,
      g: plan.g,
      plan,
      target,
      thrown: false,
      intentional: true,
      ignoreKey: target.key === ignore ? null : ignore,
      peakY: plan.apexY,
      scale,
      startedAt: input.now,
    };
    this.vx = plan.vx;
    this.vy = plan.vy0;
    out.tookOff = true;
    out.goal = 'moving';
  }

  private stepAir(input: MoverInput, out: MoverStep): void {
    const f = this.flight;
    if (!f) {
      this.settleNow();
      out.snapped = true;
      return;
    }
    const now = input.now;
    if (now - f.startedAt > MAX_FLIGHT_MS) {
      const fp = this.navWorld.nearestFloorPoint(this.navWorld.clampInside({ x: this.x, y: this.y }));
      this.land(fp.surface, fp.x, input, out, Math.abs(this.vy), true);
      out.snapped = true;
      return;
    }
    if (f.plan && f.target) {
      const elapsed = now - f.t0;
      if (elapsed < f.plan.durationMs) {
        const k = jumpAt(f.plan, elapsed);
        this.x = k.x;
        this.y = k.y;
        this.vx = k.vx;
        this.vy = k.vy;
        f.lastT = now;
        return;
      }
      const end = jumpAt(f.plan, f.plan.durationMs);
      const target = this.revalidateTarget(f.target, f.plan.to.x);
      if (target && Math.abs(this.navWorld.yAt(target, f.plan.to.x) - f.plan.to.y) <= 6 * f.scale && (target.kind !== 'ledge' || this.liveLedge(input, target.key) !== null)) {
        this.land(target, f.plan.to.x, input, out, Math.abs(end.vy), false);
        return;
      }
      // Target vanished mid-flight: continue as a free fall from the end of the arc onto the
      // first valid surface below, the one it jumped from included (it is no longer just under its paws).
      this.x = end.x;
      this.y = end.y;
      this.flight = { ...f, t0: now, lastT: now, x0: end.x, y0: end.y, vx: end.vx * 0.5, vy0: end.vy, plan: null, target: null, ignoreKey: null };
      return;
    }

    const s0 = (f.lastT - f.t0) / 1000;
    const s1 = (now - f.t0) / 1000;
    const p0 = ballistic(f.x0, f.y0, f.vx, f.vy0, f.g, s0);
    const p1 = ballistic(f.x0, f.y0, f.vx, f.vy0, f.g, s1);
    f.lastT = now;
    if (p1.vy > 0) {
      const hit = this.findLanding(f, s0, s1, p0.y, p1.y, input);
      if (hit) {
        this.x = hit.x;
        this.y = hit.y;
        this.land(hit.surface, hit.x, input, out, Math.abs(f.vy0 + f.g * hit.s), false);
        return;
      }
    }
    f.peakY = Math.min(f.peakY, p1.y);
    if (!this.navWorld.contains(p1, 0.5)) {
      const c = this.navWorld.clampInside(p1);
      if (c.y < p1.y - 0.01) {
        // Fell past every floor in this column: land on the nearest floor.
        const fp = this.navWorld.nearestFloorPoint(c);
        this.land(fp.surface, fp.x, input, out, Math.abs(p1.vy), true);
        out.snapped = true;
        return;
      }
      let vx = p1.vx;
      let vy = p1.vy;
      if (Math.abs(c.x - p1.x) > 0.01) vx = -vx * MOVEMENT.wallRestitution;
      if (c.y > p1.y + 0.01) vy = Math.max(0, vy);
      this.flight = { ...f, t0: now, lastT: now, x0: c.x, y0: c.y, vx, vy0: vy };
      this.x = c.x;
      this.y = c.y;
      this.vx = vx;
      this.vy = vy;
      return;
    }
    this.x = p1.x;
    this.y = p1.y;
    this.vx = p1.vx;
    this.vy = p1.vy;
  }

  private findLanding(f: Flight, s0: number, s1: number, y0: number, y1: number, input: MoverInput): { s: number; surface: Surface; x: number; y: number } | null {
    // Cheap reject: a descending crossing in (s0, s1] lies below the arc's highest point in that interval.
    const sApex = -f.vy0 / f.g;
    const top = sApex > s0 && sApex < s1 ? f.y0 + f.vy0 * sApex + 0.5 * f.g * sApex * sApex : Math.min(y0, y1);
    const bottom = Math.max(y0, y1);
    const dead = new Set<string>();
    for (let attempt = 0; attempt < 4; attempt++) {
      let best: { s: number; surface: Surface; x: number; y: number } | null = null;
      const consider = (surface: Surface, y: number, left: number, right: number, rightInclusive: boolean): void => {
        if (y < top - 0.5 || y > bottom + 0.5) return;
        const s = descendingCrossing(f.y0, f.vy0, f.g, y);
        if (s === null || s > s1 + 1e-9 || (s0 > 0 ? s <= s0 : s < 0)) return;
        const x = f.x0 + f.vx * s;
        if (x < left || (rightInclusive ? x > right : x >= right)) return;
        if (!best || s < best.s) best = { s, surface, x, y };
      };
      for (const floor of this.navWorld.floors) {
        for (const piece of floor.pieces) consider(floor, piece.y, piece.left, piece.right, false);
      }
      for (const w of this.ledges) {
        if (w.key === f.ignoreKey || dead.has(w.key)) continue;
        consider(w, w.y, w.landX0, w.landX1, true);
      }
      const hit = best as { s: number; surface: Surface; x: number; y: number } | null;
      if (!hit || hit.surface.kind !== 'ledge' || this.liveLedge(input, hit.surface.key) !== null) return hit;
      // That ledge is gone (closed, retracted): fall on to the next surface below.
      dead.add(hit.surface.key);
    }
    return null;
  }

  // ---- riding ledges -----------------------------------------------------------

  /** Live ledge geometry from the provider, or null when gone (or the provider misbehaves). */
  private liveLedge(input: MoverInput, id: string): LedgeSurface | null {
    if (!input.getSurface) return null;
    try {
      const s = input.getSurface(id);
      return isLedgeSurface(s) ? s : null;
    } catch {
      return null;
    }
  }

  private liveWall(input: MoverInput, id: string): WallSurface | null {
    if (!input.getSurface) return null;
    try {
      const s = input.getSurface(id);
      return isWallSurface(s) ? s : null;
    } catch {
      return null;
    }
  }

  private attachmentFrom(live: LedgeSurface): Attachment {
    return {
      surfaceId: live.id,
      ownerId: typeof live.ownerId === 'string' ? live.ownerId : '',
      surfaceKind: live.kind,
      y: live.y,
      x0: live.x0,
      x1: live.x1,
      missingSince: null,
      disabled: !this.kindEnabled(live.kind),
    };
  }

  /**
   * Why a window surface whose live lookup came back null is lost: the window still lists
   * surfaces, so it is there and only the cat's spot is covered (a window in front), or it
   * lists nothing any more (closed, minimized, maximized).
   */
  private lostReason(ownerId: string): SupportLossReason {
    return ownerId.length > 0 && this.listedOwners.has(ownerId) ? 'occluded' : 'gone';
  }

  /** x lies on a side edge of a work area on the row above y: an open span ending there is clipped there, not at its window's edge. */
  private atWorkAreaSide(x: number, y: number): boolean {
    for (const d of this.fullWorld.displays) {
      const b = d.boundsPx;
      if (y - 1 < b.y || y - 1 >= rectBottom(b)) continue;
      const wa = d.workAreaPx;
      if (Math.abs(x - wa.x) <= 0.5 || Math.abs(x - rectRight(wa)) <= 0.5) return true;
    }
    return false;
  }

  /**
   * y lies on the top edge of a work area containing column x, or at or below its bottom (the
   * sim's work areas end a few px above the real ones): a wall span ending there is cut there.
   */
  private atWorkAreaRow(y: number, x: number): boolean {
    for (const d of this.fullWorld.displays) {
      const wa = d.workAreaPx;
      if (x < wa.x || x >= rectRight(wa)) continue;
      if (Math.abs(y - wa.y) <= 0.5 || y >= rectBottom(wa) - 0.5) return true;
    }
    return false;
  }

  /**
   * Keeps the cat on a moving ledge; returns false when the ledge is lost (the cat then
   * falls, or is set down on the surface just below when a taskbar retracts under it).
   */
  private ride(input: MoverInput, out: MoverStep): boolean {
    const a = this.attach as Attachment;
    const live = this.liveLedge(input, a.surfaceId);
    if (!live) return this.loseSupport(a.surfaceKind === 'taskbar' ? 'retracted' : this.lostReason(a.ownerId), input, out);
    // The ledge's height is the window's top edge; how far it moved sideways only shows in
    // the ends of its open span (see spanShift).
    const shift = spanShift([a.x0, a.x1], [live.x0, live.x1], (x) => this.atWorkAreaSide(x, live.y), live.vx, input.dtMs, 2 * this.scale);
    const moved = shift !== 0 || live.y !== a.y;
    this.x += shift;
    a.x0 = live.x0;
    a.x1 = live.x1;
    a.y = live.y;
    // Sank to the floor (a window dragged down past it, a taskbar sliding out): stand on the floor.
    const floorY = this.navWorld.floorYAt(this.x);
    if (floorY !== null && live.y >= floorY - 0.5) {
      const fp = this.navWorld.surfaceBelow(this.x, floorY - 0.5, []) ?? this.navWorld.nearestFloorPoint({ x: this.x, y: floorY });
      this.attach = null;
      this.surface = fp.surface;
      this.x = clamp(this.x, fp.surface.x0, fp.surface.x1);
      out.lowered = true;
      out.supportLost = { reason: 'retracted', surfaceId: a.surfaceId, surfaceKind: a.surfaceKind, fell: false };
      this.leg = null;
      return true;
    }
    const d = this.navWorld.displayAt({ x: this.x, y: live.y });
    if (!d || live.y - this.bodyHeight * 0.8 < d.workAreaPx.y) return this.loseSupport('headroom', input, out);
    const tol = this.bodyWidth * 0.125;
    const onSegment = this.x >= live.x0 - tol && this.x <= live.x1 + tol;
    const listed = this.ledges.find((l) => l.key === a.surfaceId) ?? null;
    // The listed ledge must be under its paws too: a tab strip that shrank away from the cat
    // (tabs closed) or a list naming another part of a cut edge leaves it on the bare edge.
    // While the window moves, the list may be a tick behind the live geometry.
    const underPaws = listed !== null && this.x >= listed.landX0 - tol && this.x <= listed.landX1 + tol;
    const moving = moved || (input.movingWindowIds ?? NO_MOVING).has(a.ownerId);
    if (listed && (underPaws || moving) && onSegment && !a.disabled) {
      a.missingSince = null;
    } else {
      a.missingSince ??= input.now;
      const grace = moving ? MOVEMENT.perchMovingGraceMs : MOVEMENT.perchGraceMs;
      // Switched off by the user: it leaves at once (no grace).
      if (a.disabled || input.now - a.missingSince > grace) return this.loseSupport(a.disabled ? 'disabled' : 'occluded', input, out);
    }
    if (onSegment) {
      const s = listed && underPaws && Math.abs(listed.y - live.y) <= 2 ? listed : this.navWorld.ledgeSurface(live, true);
      if (s) {
        this.surface = s;
        // Kept over the edge, never snapped into the stand range (a crossing or a cut end leaves
        // it in the end inset): the cat is at most `tol` past either surface's edge here.
        this.x = clamp(this.x, Math.min(s.landX0, s.x0), Math.max(s.landX1, s.x1));
      }
    } else if (this.surface.kind === 'ledge') {
      this.surface = { ...this.surface, y: live.y };
    }
    if (moved) this.leg = null;
    return true;
  }

  /**
   * The ledge under the cat is gone. A calm loss (a retracting taskbar, a kind the user
   * switched off) with a surface just below sets the cat down there; otherwise it falls.
   */
  private loseSupport(reason: SupportLossReason, input: MoverInput, out: MoverStep): false {
    const a = this.attach as Attachment;
    this.attach = null;
    this.crouch = null;
    if (this.modeValue === 'crouch') this.modeValue = 'ground';
    // A ledge can carry the cat out of the world before it is noticed: continue from inside.
    const p = this.navWorld.clampInside({ x: this.x, y: this.y });
    if (Math.hypot(p.x - this.x, p.y - this.y) > 1) out.snapped = true;
    this.x = p.x;
    this.y = p.y;
    const calm = reason === 'retracted' || reason === 'disabled';
    const below = this.navWorld.surfaceBelow(p.x, p.y, this.ledges.filter((l) => l.key !== a.surfaceId));
    if (calm && below && below.y - p.y <= MOVEMENT.settleMaxBodyHeights * this.bodyHeight) {
      const live = below.surface.kind === 'ledge' ? this.liveLedge(input, below.surface.key) : null;
      if (below.surface.kind === 'floor' || live) {
        this.setGrounded(below.surface, below.x, live, true);
        this.easeRate = MOVEMENT.settleDip * this.scale;
        out.lowered = true;
        out.supportLost = { reason, surfaceId: a.surfaceId, surfaceKind: a.surfaceKind, fell: false };
        return false;
      }
    }
    this.startFlight(0, 0, input.now, { thrown: false, intentional: false, ignoreKey: a.surfaceId });
    out.perchLost = true;
    out.supportLost = { reason, surfaceId: a.surfaceId, surfaceKind: a.surfaceKind, fell: true };
    return false;
  }

  /**
   * A ledge rising through the cat's feet (an auto-hide taskbar sliding in, a window top
   * dragged up under it) picks the cat up: the support switches and the height eases up.
   * A taskbar is opaque and covers the floor: a cat that ends up standing on the floor
   * inside a shown taskbar (it landed or walked there) steps up onto it too.
   */
  private checkLift(input: MoverInput, out: MoverStep): void {
    const maxLift = MOVEMENT.liftMaxBodyHeights * this.bodyHeight;
    for (const l of this.ledges) {
      if (this.attach?.surfaceId === l.key || l.phase === 'leaving') continue;
      if (this.x < l.landX0 || this.x > l.landX1) continue;
      if (!(l.y < this.y - 0.5 && l.y >= this.y - maxLift)) continue;
      const prev = this.graph.prevY(l.key);
      // A ledge that just appeared above the feet counts only for taskbars (they slide in from the screen edge).
      const rising = prev !== undefined ? prev > l.y + 0.25 && prev >= this.y - 1.5 : l.surfaceKind === 'taskbar';
      const buried = l.surfaceKind === 'taskbar' && this.attach === null && this.surface.kind === 'floor';
      if (!rising && !buried) continue;
      const live = this.liveLedge(input, l.key);
      if (!live) continue;
      this.attach = this.attachmentFrom(live);
      this.surface = l;
      this.x = clamp(this.x, l.x0, l.x1);
      this.easeRate = Math.max(MOVEMENT.liftDip * this.scale, 1.5 * Math.abs(l.vy));
      this.leg = null;
      out.lifted = { surfaceId: l.key, surfaceKind: l.surfaceKind ?? 'taskbar' };
      return;
    }
  }

  /** Walks across onto a touching surface at the same height. */
  private crossTo(to: Surface, input: MoverInput): void {
    this.leg = null;
    if (to.kind === 'floor') {
      this.attach = null;
      this.surface = to;
      this.x = clamp(this.x, to.x0, to.x1);
      return;
    }
    const live = this.liveLedge(input, to.key);
    if (!live) {
      this.blockedEdges.add(`walk:${this.surface.key}>${to.key}`);
      return;
    }
    this.attach = this.attachmentFrom(live);
    this.surface = to;
    // Step over the joint (at most the small gap between the edges); the stand range's
    // end inset is not snapped over: the cat simply walks on from there.
    this.x = clamp(this.x, to.landX0, to.landX1);
    this.y = live.y;
  }

  // ---- climbing --------------------------------------------------------------

  private startClimbUp(leg: Extract<Leg, { kind: 'climbUp' }>, input: MoverInput, out: MoverStep): void {
    const w = this.walls.find((t) => t.key === leg.wall.key);
    if (!w || !this.liveWall(input, w.key)) {
      this.leg = null;
      this.blockedEdges.add(`mount:${this.surface.key}>up:${leg.wall.key}`);
      return;
    }
    const startY = clamp(Math.min(this.y, w.yBottom), w.yTop, w.yBottom);
    this.beginClimb(w, 'mount', -1, MOVEMENT.mountMs, { x: w.x, y: startY }, input.now, leg.ledgeKey, leg.cornerX);
    out.climbStarted = true;
  }

  private startClimbDown(leg: Extract<Leg, { kind: 'climbDown' }>, input: MoverInput, out: MoverStep): void {
    const w = this.walls.find((t) => t.key === leg.wall.key);
    if (!w || !this.liveWall(input, w.key)) {
      this.leg = null;
      this.blockedEdges.add(`swing:${this.surface.key}>down:${leg.wall.key}`);
      return;
    }
    this.beginClimb(w, 'swing', 1, MOVEMENT.swingMs, { x: w.x, y: w.yTop }, input.now, this.surface.key, leg.cornerX);
    out.climbStarted = true;
  }

  private beginClimb(w: WallTrack, phase: 'mount' | 'swing', dir: -1 | 1, ms: number, to: Point, now: number, topKey: string | null, cornerX: number | null): void {
    this.attach = null;
    this.easeRate = 0;
    this.crouch = null;
    this.leg = null;
    this.vx = 0;
    this.vy = 0;
    this.modeValue = 'climb';
    this.climbing = { wall: w, phase, dir, t0: now, durationMs: ms / this.cfg.movementSpeed, from: { x: this.x, y: this.y }, to, topKey, cornerX, exit: null, missingSince: null, replan: false };
    this.setFacing(w.facing, now);
  }

  private stepClimb(input: MoverInput, out: MoverStep): void {
    const c = this.climbing;
    if (!c) {
      this.settleNow();
      return;
    }
    const live = this.liveWall(input, c.wall.key);
    const track = live ? this.navWorld.wallTrack(live) : null;
    if (!live || !track) {
      // Gone (closed, minimized): a sudden loss, unless the window is still there with the
      // cat's spot covered. Still there but no longer climbable (moved against the screen
      // edge, cut too short): the cat simply lets go.
      this.letGoOfWall(input, out, live ? 'occluded' : this.lostReason(c.wall.ownerId));
      return;
    }
    // Ride the window: the wall line is its side; how far it moved up or down only shows in
    // the ends of the open span (a window in front covering part of the side moves nothing).
    const dx = track.x - c.wall.x;
    const column = track.side === 'left' ? track.x - 1 : track.x + 1;
    const dy = spanShift([c.wall.y0, c.wall.y1], [track.y0, track.y1], (y) => this.atWorkAreaRow(y, column), live.vy, input.dtMs, 2 * track.scale);
    if (dx !== 0 || dy !== 0) {
      this.x += dx;
      this.y += dy;
      c.from = { x: c.from.x + dx, y: c.from.y + dy };
      c.to = { x: c.to.x + dx, y: c.to.y + dy };
      if (c.cornerX !== null) c.cornerX += dx;
    }
    c.wall = track;
    // Clinging, the grip must stay on the stretch of the side it can reach: a window in front
    // covering that part leaves it holding still until the grace runs out, then it lets go.
    const tol = this.bodyWidth * 0.125;
    const holds = c.phase !== 'climb' || (this.y >= track.yTop - tol && this.y <= track.yBottom + tol);
    if (holds && this.walls.some((w) => w.key === track.key)) {
      c.missingSince = null;
    } else {
      c.missingSince ??= input.now;
      const moving = (input.movingWindowIds ?? NO_MOVING).has(track.ownerId);
      const grace = dx !== 0 || dy !== 0 || moving ? MOVEMENT.perchMovingGraceMs : MOVEMENT.perchGraceMs;
      if (!this.wallsEnabled() || input.now - c.missingSince > grace) {
        this.letGoOfWall(input, out, this.wallsEnabled() ? 'occluded' : 'disabled');
        return;
      }
    }
    this.facing = track.facing;
    const dt = Math.max(0, input.dtMs) / 1000;
    if (c.phase !== 'climb') {
      const k = clamp((input.now - c.t0) / Math.max(1, c.durationMs), 0, 1);
      const e = k * k * (3 - 2 * k);
      this.x = c.from.x + (c.to.x - c.from.x) * e;
      this.y = c.from.y + (c.to.y - c.from.y) * e;
      if (k < 1) return;
      switch (c.phase) {
        case 'mount':
        case 'swing':
          c.phase = 'climb';
          this.x = track.x;
          return;
        case 'pullUp':
          this.finishPullUp(c, input, out);
          return;
        case 'dismount':
          this.finishDismount(c, input, out);
          return;
      }
    }
    if (c.replan && this.goal) {
      c.replan = false;
      if (this.goal.y > this.y + 1 && c.dir < 0) c.dir = 1;
      else if (this.goal.y < this.y - 1 && c.dir > 0 && c.topKey && this.ledgeById(c.topKey)) c.dir = -1;
    }
    this.x = track.x;
    if (!holds) {
      this.vy = 0;
      return;
    }
    if (c.dir < 0) {
      const speed = MOVEMENT.climbUpDip * this.cfg.movementSpeed * this.scale;
      this.vy = -speed;
      this.y = Math.max(track.yTop, this.y - speed * dt);
      if (this.y > track.yTop + 0.01) return;
      const top = c.topKey ? this.ledgeById(c.topKey) : null;
      // Over the top only from the top corner: a side cut short by a window in front ends below the ledge.
      const cx = top && track.y0 - top.y <= this.bodyWidth * 0.25 ? this.graph.cornerX(this.navWorld, track, top) : null;
      if (!top || cx === null) {
        // No way over the top (the ledge or the top of the side is covered, or gone): climb back down.
        c.dir = 1;
        return;
      }
      c.cornerX = cx;
      c.phase = 'pullUp';
      c.t0 = input.now;
      c.durationMs = MOVEMENT.pullUpMs / this.cfg.movementSpeed;
      c.from = { x: this.x, y: this.y };
      c.to = { x: cx, y: top.y };
      this.vy = 0;
      return;
    }
    const speed = MOVEMENT.climbDownDip * this.cfg.movementSpeed * this.scale;
    this.vy = speed;
    const exit = this.graph.dismountTarget(this.navWorld, track);
    const exitY = exit ? Math.min(exit.y, track.yBottom) : track.yBottom;
    this.y = Math.min(exitY, this.y + speed * dt);
    if (this.y < exitY - 0.01) return;
    this.vy = 0;
    if (!exit || exit.y - track.yBottom > MOVEMENT.wallReachBodyHeights * this.bodyHeight) {
      // The wall ends high above the next support: hop down from its foot.
      const outward = track.side === 'left' ? -1 : 1;
      this.climbing = null;
      this.x = track.x + outward * this.bodyWidth * 0.2;
      this.startFlight(outward * this.paceSpeedPx('walk') * 0.6, 0, input.now, { thrown: false, intentional: true, ignoreKey: null });
      out.steppedOff = true;
      out.climbEnded = true;
      return;
    }
    c.exit = { surface: exit.surface, x: exit.x };
    c.phase = 'dismount';
    c.t0 = input.now;
    c.durationMs = MOVEMENT.dismountMs / this.cfg.movementSpeed;
    c.from = { x: this.x, y: this.y };
    c.to = { x: exit.x, y: exit.y };
  }

  private finishPullUp(c: Climb, input: MoverInput, out: MoverStep): void {
    const top = c.topKey ? this.ledgeById(c.topKey) : null;
    const live = top ? this.liveLedge(input, top.key) : null;
    out.climbEnded = true;
    if (!top || !live) {
      // The ledge dropped out of the list (covered) or its window is gone.
      this.letGoOfWall(input, out, top ? this.lostReason(c.wall.ownerId) : 'occluded');
      return;
    }
    this.climbing = null;
    this.setGrounded(top, c.cornerX ?? this.x, live);
  }

  private finishDismount(c: Climb, input: MoverInput, out: MoverStep): void {
    const exit = c.exit;
    out.climbEnded = true;
    this.climbing = null;
    if (!exit) {
      this.startFlight(0, 0, input.now, { thrown: false, intentional: true, ignoreKey: null });
      out.steppedOff = true;
      return;
    }
    const live = exit.surface.kind === 'ledge' ? this.liveLedge(input, exit.surface.key) : null;
    if (exit.surface.kind === 'ledge' && !live) {
      this.startFlight(0, 0, input.now, { thrown: false, intentional: true, ignoreKey: exit.surface.key });
      out.steppedOff = true;
      return;
    }
    this.setGrounded(exit.surface, exit.x, live);
  }

  /** The wall is gone or unusable: the cat lets go and drops (pushing off slightly). */
  private letGoOfWall(input: MoverInput, out: MoverStep, reason: SupportLossReason): void {
    const c = this.climbing;
    this.climbing = null;
    const outward = c ? (c.wall.side === 'left' ? -1 : 1) : 0;
    const p = this.navWorld.clampInside({ x: this.x, y: this.y });
    if (Math.hypot(p.x - this.x, p.y - this.y) > 1) out.snapped = true;
    this.x = p.x;
    this.y = p.y;
    this.startFlight(outward * this.paceSpeedPx('slow'), 0, input.now, { thrown: false, intentional: false, ignoreKey: null });
    out.perchLost = true;
    out.climbEnded = true;
    if (c) out.supportLost = { reason, surfaceId: c.wall.key, surfaceKind: 'windowSide', fell: true };
  }

  // ---- landing ---------------------------------------------------------------

  private revalidateTarget(target: Surface, landX: number): Surface | null {
    if (target.kind === 'floor') return this.navWorld.floors.find((f) => f.key === target.key) ?? null;
    const tol = this.bodyWidth * 0.25;
    return this.ledges.find((w) => w.key === target.key && landX >= w.landX0 - tol && landX <= w.landX1 + tol) ?? null;
  }

  private land(surface: Surface, x: number, input: MoverInput, out: MoverStep, impactVy: number, forced: boolean): void {
    const f = this.flight;
    const scale = f?.scale ?? this.scale;
    let live: LedgeSurface | null = null;
    if (surface.kind === 'ledge') {
      live = this.liveLedge(input, surface.key);
      if (!live) {
        const fp = this.navWorld.nearestFloorPoint({ x, y: surface.y });
        surface = fp.surface;
        x = fp.x;
        forced = true;
      }
    }
    out.landed = {
      impactDip: impactVy / scale,
      thrown: f?.thrown ?? false,
      intentional: f?.intentional ?? false,
      fallHeightDip: f ? Math.max(0, (this.navWorld.yAt(surface, x) - f.peakY) / scale) : 0,
      forced,
    };
    this.setGrounded(surface, x, live);
  }

  /** Stands the cat on `surface` at x (a ledge needs its live geometry, else it goes to the floor below). */
  private setGrounded(surface: Surface, x: number, live: LedgeSurface | null, keepY = false): void {
    this.modeValue = 'ground';
    this.flight = null;
    this.crouch = null;
    this.climbing = null;
    this.easeRate = 0;
    this.surface = surface;
    this.attach = surface.kind === 'ledge' && live ? this.attachmentFrom(live) : null;
    if (surface.kind === 'ledge' && !this.attach) {
      const fp = this.navWorld.nearestFloorPoint({ x, y: surface.y });
      this.surface = fp.surface;
      x = fp.x;
    }
    this.x = clamp(x, this.surface.x0, this.surface.x1);
    if (!keepY) this.y = this.attach ? this.attach.y : this.navWorld.yAt(this.surface, this.x);
    this.vx = 0;
    this.vy = 0;
    this.leg = null;
  }

  private startFlight(vx: number, vy: number, now: number, o: { thrown: boolean; intentional: boolean; ignoreKey: string | null }): void {
    const scale = this.scale;
    this.modeValue = 'air';
    this.attach = null;
    this.climbing = null;
    this.crouch = null;
    this.easeRate = 0;
    this.leg = null;
    this.flight = {
      t0: now,
      lastT: now,
      x0: this.x,
      y0: this.y,
      vx,
      vy0: vy,
      g: MOVEMENT.gravityDip * scale,
      plan: null,
      target: null,
      thrown: o.thrown,
      intentional: o.intentional,
      ignoreKey: o.ignoreKey,
      peakY: this.y,
      scale,
      startedAt: now,
    };
    this.vx = vx;
    this.vy = vy;
  }

  // ---- planning --------------------------------------------------------------

  private arriveRadius(): number {
    return this.goal?.arriveRadiusPx ?? ARRIVE_RADIUS_DIP * this.scale;
  }

  private kindEnabled(kind: SurfaceKind): boolean {
    switch (kind) {
      case 'taskbar':
        // Physics, not play: a shown taskbar covers the floor, so it lifts, carries and lowers
        // the cat whatever 'taskbarPlay' says (that toggle only gates the sim's reactions).
        return true;
      case 'windowTop':
        return this.cfg.perchOnWindows;
      case 'tabStrip':
        return this.cfg.tabStrips ?? true;
      case 'windowSide':
        return this.wallsEnabled();
    }
  }

  /** Climbing needs the window tops it leads to. */
  private wallsEnabled(): boolean {
    return (this.cfg.walls ?? true) && this.cfg.perchOnWindows;
  }

  private nodeBlocked(n: GraphNode): boolean {
    if (this.offLimits.size === 0) return false;
    if (n.wall) return this.isOffLimits(n.wall.displayId);
    const s = n.surface;
    if (!s) return false;
    return s.displayIds.every((id) => this.isOffLimits(id));
  }

  private routeParams(goal: MoveGoal): RouteParams {
    const route = goal.route ?? 'any';
    const effort = (v: number | undefined): number => (v !== undefined && Number.isFinite(v) && v > 0 ? clamp(v, 0.2, 5) : 1);
    return {
      walkSpeedPx: this.paceSpeedPx('walk'),
      jumpEffort: effort(this.cfg.jumpEffort),
      climbEffort: effort(this.cfg.climbEffort),
      allowClimb: this.wallsEnabled() && route !== 'noClimb',
      preferClimb: route === 'climb',
      blockedNode: (n) => this.nodeBlocked(n),
      blockedEdge: (e) => this.blockedEdges.has(edgeId(e)),
      blockedArrival: (s, x) => this.offLimitsAt(s, x),
    };
  }

  /**
   * A shown taskbar covers the floor under it: a goal on that stretch of floor means the
   * taskbar (a cat lifted onto it does not hop down just because it rose under it, and one
   * heading there lands on it rather than inside it). Only once the taskbar is leaving does a
   * literal goal mean the floor itself (hopping down while it slides away).
   */
  private coveredFloorGoal(dest: SurfacePoint, literal: boolean): SurfacePoint {
    if (dest.surface.kind !== 'floor') return dest;
    const maxLift = MOVEMENT.liftMaxBodyHeights * this.bodyHeight + 1;
    for (const l of this.coveringTaskbars()) {
      if (dest.x < l.landX0 || dest.x > l.landX1 || dest.y < l.y || dest.y - l.y > maxLift) continue;
      if (literal && l.phase === 'leaving') return dest;
      const x = clamp(dest.x, l.x0, l.x1);
      return { surface: l, x, y: l.y };
    }
    return dest;
  }

  /** Usable taskbar ledges, plus the one the cat stands on (it may be missing from the list during its grace). */
  private coveringTaskbars(): Surface[] {
    const out = this.ledges.filter((l) => l.surfaceKind === 'taskbar' && l.phase !== 'leaving');
    const cur = this.surface;
    if (this.attach && cur.kind === 'ledge' && cur.surfaceKind === 'taskbar' && !out.some((l) => l.key === cur.key)) out.unshift(cur);
    return out;
  }

  private planLeg(goal: MoveGoal, cur: Surface): Leg {
    let dest = this.coveredFloorGoal(this.surfacePointFor({ x: goal.x, y: goal.y }), goal.literal === true);
    // Goals on displays the cat may not roam to, or that are off limits, are approached as closely as possible.
    const allowed = this.navWorld.contains(this.fullWorld.clampInside({ x: goal.x, y: goal.y }), 1);
    const range = this.rangeOn(cur, this.x);
    if (sameSurface(cur, dest.surface)) {
      const x = clamp(dest.x, range.x0, range.x1);
      return { kind: 'walk', x, reachable: allowed && Math.abs(x - dest.x) <= this.arriveRadius() };
    }
    const openX = this.openLandX(dest.surface, dest.x);
    if (openX === null) return { kind: 'walk', x: clamp(dest.x, range.x0, range.x1), reachable: false };
    if (openX !== dest.x) dest = { surface: dest.surface, x: openX, y: this.navWorld.yAt(dest.surface, openX) };
    const params = this.routeParams(goal);
    for (let attempt = 0; attempt < 4; attempt++) {
      const route = this.graph.route(cur, this.x, dest.surface.key, dest.x, params);
      const first = route?.steps[0];
      if (!route || !first) break;
      const leg = this.legFrom(route, cur, dest);
      if (leg) return leg;
      // The precise check failed (e.g. the arc would clip a display edge): try another way.
      this.blockedEdges.add(edgeId(first.edge));
    }
    if (cur.kind === 'ledge' && dest.y > cur.y + 1) {
      const pref: 1 | -1 = dest.x > cur.x1 ? 1 : dest.x < cur.x0 ? -1 : this.x - cur.x0 < cur.x1 - this.x ? -1 : 1;
      const others = this.ledges.filter((l) => l.key !== cur.key);
      for (const dir of [pref, -pref as 1 | -1]) {
        // Never step off toward an off-limits display.
        const endX = dir > 0 ? cur.landX1 : cur.landX0;
        const below = this.navWorld.surfaceBelow(endX + dir * this.bodyWidth * 0.6, cur.y + 1, others);
        if (!below || !this.offLimitsAt(below.surface, below.x)) return { kind: 'drop', dir };
      }
    }
    return { kind: 'walk', x: clamp(dest.x, range.x0, range.x1), reachable: false };
  }

  /** The first leg of a route, checked precisely; null when it cannot be executed. */
  private legFrom(route: Route, cur: Surface, dest: SurfacePoint): Leg | null {
    const [first, next] = route.steps;
    if (!first) return null;
    const e = first.edge;
    const surfaceFor = (key: string): Surface | null => (key === dest.surface.key ? dest.surface : (this.graph.node(key)?.surface ?? null));
    switch (e.kind) {
      case 'walk': {
        const to = surfaceFor(e.to);
        return to ? { kind: 'cross', x: first.fromX, to } : null;
      }
      case 'jump': {
        const t = surfaceFor(e.to);
        if (!t) return null;
        const landX = next ? clamp(next.fromX, t.x0, t.x1) : clamp(dest.x, t.x0, t.x1);
        return this.planJumpLeg(cur, this.x, { surface: t, x: landX, y: this.navWorld.yAt(t, landX) });
      }
      case 'drop':
        return { kind: 'drop', dir: Math.abs(first.fromX - cur.x0) <= Math.abs(first.fromX - cur.x1) ? -1 : 1 };
      case 'mount': {
        const w = this.graph.node(e.to)?.wall;
        if (!w || !next || next.edge.kind !== 'pullUp') return null;
        return { kind: 'climbUp', standX: first.fromX, wall: w, ledgeKey: next.edge.to, cornerX: next.toX };
      }
      case 'swing': {
        const w = this.graph.node(e.to)?.wall;
        if (!w || !next || next.edge.kind !== 'dismount') return null;
        return { kind: 'climbDown', cornerX: first.fromX, wall: w };
      }
      default:
        return null;
    }
  }

  private planJumpLeg(cur: Surface, fromX: number, dest: SurfacePoint): Leg | null {
    const scale = this.navWorld.scaleAt({ x: fromX, y: this.navWorld.yAt(cur, fromX) });
    const maxAcross = MOVEMENT.maxJumpAcrossDip * scale;
    const maxUp = MOVEMENT.maxJumpUpDip * scale;
    const bw = this.navWorld.bodyWidth(scale);
    const t = dest.surface;
    const range = this.rangeOn(cur, fromX);
    let landX = clamp(dest.x, t.x0, t.x1);
    let takeoffX = clamp(landX, range.x0, range.x1);
    if (Math.abs(landX - takeoffX) > maxAcross) {
      landX = clamp(takeoffX + Math.sign(landX - takeoffX) * maxAcross, t.x0, t.x1);
      if (Math.abs(landX - takeoffX) > maxAcross + 0.5) return null;
    }
    if (Math.abs(landX - takeoffX) < bw * 0.5) {
      const dir = fromX <= takeoffX ? -1 : 1;
      const alt = clamp(takeoffX + dir * bw * 0.8, range.x0, range.x1);
      if (Math.abs(landX - alt) <= maxAcross) takeoffX = alt;
    }
    // Arcs that would clip a display edge get a longer run-up and/or a landing
    // further in (e.g. jumping up from a lower monitor onto a higher one).
    const away = landX >= takeoffX ? -1 : 1;
    for (const k of [0, 0.5, 1, 2, 3, 4]) {
      const tx = clamp(takeoffX + away * k * bw, range.x0, range.x1);
      if (k > 0 && tx === takeoffX) continue;
      for (const j of [0, 1, 2]) {
        const lx = clamp(landX - away * j * bw, t.x0, t.x1);
        if (j > 0 && lx === landX) continue;
        if (Math.abs(lx - tx) > maxAcross || this.offLimitsAt(t, lx)) continue;
        const from = { x: tx, y: this.navWorld.yAt(cur, tx) };
        const to = { x: lx, y: this.navWorld.yAt(t, lx) };
        if (from.y - to.y > maxUp) continue;
        if (this.solveChecked(from, to, null)) return { kind: 'jump', takeoffX: tx, landX: lx, target: t };
      }
    }
    return null;
  }

  private solveChecked(from: Point, to: Point, clearancePx: number | null): JumpPlan | null {
    const scale = this.navWorld.scaleAt(from);
    const g = MOVEMENT.gravityDip * scale;
    const base = clearancePx ?? clearanceFor(to.x - from.x, MOVEMENT.jumpClearanceDip * scale, MOVEMENT.jumpClearancePerDx);
    for (const c of [base, base * 0.5, MOVEMENT.jumpClearanceDip * scale * 0.35]) {
      const plan = solveJump(from, to, g, c);
      if (sampleArc(plan, 16).every((p) => this.navWorld.contains(p, 2))) return plan;
    }
    return null;
  }

  // ---- off-limits displays ---------------------------------------------------

  /**
   * The stretch of `s` around `x` the cat may walk on. A floor shared with an
   * off-limits display ends at that display's edge (inset by half a body, so the cat
   * stays out of it entirely); a cat already past that point is not pulled back,
   * only kept from going further.
   */
  private rangeOn(s: Surface, x: number): { x0: number; x1: number } {
    const r = this.openRunAt(s, x, this.displayId);
    // On a ledge, a cat still over its edge but past the stand range (it just walked across
    // from a touching ledge) is not pulled back either.
    const lo = s.kind === 'ledge' ? s.landX0 : s.x0;
    const hi = s.kind === 'ledge' ? s.landX1 : s.x1;
    return { x0: Math.min(r.x0, Math.max(x, lo)), x1: Math.max(r.x1, Math.min(x, hi)) };
  }

  /** Walkable range of the open floor pieces around `x`; `exempt` is a display that counts as open. */
  private openRunAt(s: Surface, x: number, exempt: string | null): { x0: number; x1: number } {
    if (this.offLimits.size === 0 || s.pieces.length < 2) return { x0: s.x0, x1: s.x1 };
    const i = s.pieces.indexOf(this.navWorld.floorPieceAt(s, x) as FloorPiece);
    if (i < 0) return { x0: s.x0, x1: s.x1 };
    return this.openRun(s, i, exempt);
  }

  private openRun(s: Surface, i: number, exempt: string | null): { x0: number; x1: number } {
    const pieces = s.pieces;
    const blocked = (k: number): boolean => {
      const id = (pieces[k] as FloorPiece).displayId;
      return id !== exempt && this.offLimits.has(id);
    };
    if (blocked(i)) return { x0: s.x0, x1: s.x1 };
    let a = i;
    let b = i;
    while (a > 0 && !blocked(a - 1)) a--;
    while (b < pieces.length - 1 && !blocked(b + 1)) b++;
    const first = pieces[a] as FloorPiece;
    const last = pieces[b] as FloorPiece;
    const x0 = a === 0 ? s.x0 : first.left + this.navWorld.bodyWidth(first.scale) / 2;
    const x1 = b === pieces.length - 1 ? s.x1 : last.right - this.navWorld.bodyWidth(last.scale) / 2;
    return x1 >= x0 ? { x0, x1 } : { x0: (x0 + x1) / 2, x1: (x0 + x1) / 2 };
  }

  /** `landX` moved onto the nearest open part of a target surface, or null when none of it is open. */
  private openLandX(t: Surface, landX: number): number | null {
    if (this.offLimits.size === 0 || t.kind !== 'floor') return landX;
    const here = this.displayId;
    let best: number | null = null;
    for (let i = 0; i < t.pieces.length; i++) {
      const id = (t.pieces[i] as FloorPiece).displayId;
      if (id !== here && this.offLimits.has(id)) continue;
      const r = this.openRun(t, i, here);
      const x = clamp(landX, r.x0, r.x1);
      if (best === null || Math.abs(x - landX) < Math.abs(best - landX)) best = x;
    }
    return best;
  }

  /** Whether `x` on `s` lies over an off-limits display. */
  private offLimitsAt(s: Surface, x: number): boolean {
    return this.offLimits.size > 0 && this.isOffLimits(this.navWorld.displayIdOn(s, x));
  }

  // ---- world changes ---------------------------------------------------------

  private buildNav(): WorldModel {
    return this.cfg.allowMultiMonitor ? this.fullWorld : this.fullWorld.restrictTo(this.homeDisplayId);
  }

  /** Re-places the cat after a topology/config change. Returns true on a discontinuous move. */
  private revalidate(): boolean {
    const pos = { x: this.x, y: this.y };
    if (!this.fullWorld.display(this.homeDisplayId)) this.homeDisplayId = (this.fullWorld.displayAt(pos) ?? this.fullWorld.nearestDisplay(pos)).id;
    if (!this.cfg.allowMultiMonitor) {
      const here = this.fullWorld.displayAt(pos);
      if (here) this.homeDisplayId = here.id;
    }
    this.navWorld = this.buildNav();
    this.ledges = [];
    this.walls = [];
    this.graph.update(this.navWorld, [], []);
    this.blockedEdges.clear();
    this.leg = null;
    switch (this.modeValue) {
      case 'held': {
        const p = this.fullWorld.clampInside(pos);
        this.x = p.x;
        this.y = p.y;
        return Math.hypot(p.x - pos.x, p.y - pos.y) > 0.5;
      }
      case 'air': {
        if (this.navWorld.contains(pos, 0.5)) return false;
        const p = this.navWorld.clampInside(pos);
        this.x = p.x;
        this.y = p.y;
        if (this.flight) this.flight = { ...this.flight, t0: this.flight.lastT, x0: p.x, y0: p.y, vx: 0, vy0: 0, plan: null, target: null };
        return true;
      }
      default: {
        this.crouch = null;
        const wasClimbing = this.modeValue === 'climb';
        this.climbing = null;
        this.modeValue = 'ground';
        // A ledge the cat stands on stays its support while it is still inside the world.
        if (this.attach && !wasClimbing && this.navWorld.contains(pos, 1)) return false;
        this.attach = null;
        const oldDisplay = this.surface.kind === 'floor' ? (this.surface.pieces.find((p) => pos.x >= p.left && pos.x < p.right)?.displayId ?? this.surface.displayIds[0]) : undefined;
        const floor = oldDisplay !== undefined ? this.navWorld.floorFor(oldDisplay) : undefined;
        const sp = floor && !wasClimbing && this.navWorld.contains(pos, 2) ? this.navWorld.floorPoint(floor, pos.x) : this.navWorld.nearestFloorPoint(this.navWorld.clampInside(pos));
        this.setGrounded(sp.surface, sp.x, null);
        return Math.hypot(this.x - pos.x, this.y - pos.y) > 0.5;
      }
    }
  }

  private updateFacing(vx: number, now: number): void {
    if (Math.abs(vx) <= MOVEMENT.facingSpeedDip * this.scale) return;
    const want: Facing = vx > 0 ? 1 : -1;
    if (want !== this.facing && now - this.facingChangedAt >= MOVEMENT.facingMinFlipMs) this.setFacing(want, now);
  }

  private setFacing(f: Facing, now: number): void {
    if (f === this.facing) return;
    this.facing = f;
    this.facingChangedAt = now;
  }
}

function emptyStep(): MoverStep {
  return {
    goal: 'none',
    crouchStarted: false,
    tookOff: false,
    steppedOff: false,
    landed: null,
    perchLost: false,
    snapped: false,
    supportLost: null,
    lifted: null,
    lowered: false,
    climbStarted: false,
    climbEnded: false,
  };
}

/**
 * How far a window moved along an edge this tick, judged from the ends of the open span of
 * that edge the cat is on (the provider reports open spans, not the window's frame). Both
 * ends moving together is the window moving; one end moving alone is a window in front
 * covering or uncovering part of the edge, or a resize: nothing moves. An end clipped at the
 * edge of a work area (`pinned`) stays put while the window slides under it, so then the
 * other end alone counts, if the window's reported velocity `v` (px/s) says it moves that way
 * and that fast (within 2.5x over `dtMs`, plus `slack` px): an end that jumps further or the
 * other way is a window in front.
 */
function spanShift(prev: readonly [number, number], next: readonly [number, number], pinned: (v: number) => boolean, v: number, dtMs: number, slack: number): number {
  const d0 = next[0] - prev[0];
  const d1 = next[1] - prev[1];
  if (d0 === 0 && d1 === 0) return 0;
  const free0 = !pinned(prev[0]) && !pinned(next[0]);
  const free1 = !pinned(prev[1]) && !pinned(next[1]);
  if (free0 && free1) return Math.abs(d0 - d1) <= 1.5 ? (d0 + d1) / 2 : 0;
  if (free0 === free1) return 0;
  const d = free0 ? d0 : d1;
  const vel = Number.isFinite(v) ? v : 0;
  const reach = (2.5 * Math.abs(vel) * Math.max(0, dtMs)) / 1000 + slack;
  return Math.sign(d) === Math.sign(vel) && Math.abs(d) <= reach ? d : 0;
}

function approach(v: number, target: number, maxDelta: number): number {
  if (v < target) return Math.min(target, v + maxDelta);
  if (v > target) return Math.max(target, v - maxDelta);
  return v;
}
