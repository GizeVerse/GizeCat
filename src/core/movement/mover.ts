// The cat's body: grounded locomotion along surfaces, riding moving ledges (window tops,
// taskbars, tab strips), being lifted and lowered by them, climbing window sides, the
// anticipation crouch, ballistic jumps, free fall with wall bounces, and being
// dragged/thrown. Everything is in physical px; DIP constants are scaled by the display
// under the cat. Routes across surfaces come from the SurfaceGraph.
import { CAT_BASE_HEIGHT_DIP, CAT_BASE_WIDTH_DIP, type Facing, type JumpKind, type LandingImpact } from '../../shared/cat';
import { heldScruffOffset, HELD_SETTLE_MS } from '../interaction/held';
import type { Point, Rect } from '../../shared/geometry';
import { clamp, rectBottom, rectRight } from '../../shared/geometry';
import type { BailOutKind, LeaveKind } from '../../shared/behaviorProfile';
import type { SimSupport } from '../../shared/sim';
import type { DebugLineRole, NavDiagnostics, NavRejectReason, SurfaceCounts, SurfaceDebugLine } from '../../shared/surfaceDiagnostics';
import { emptySurfaceCounts, MAX_DEBUG_LINES } from '../../shared/surfaceDiagnostics';
import type { LedgeSurface, Surface as EnvSurface, SupportSurfaceKind, SurfaceKind, WallSurface } from '../../shared/surfaces';
import { SCREEN_EDGE_KIND, SURFACE_KINDS } from '../../shared/surfaces';
import type { WorldGeometry } from '../../shared/world';
import { ARRIVE_RADIUS_DIP, MOVEMENT, ROUTE_EFFORT } from './constants';
import type { JumpPlan } from './jump';
import { ballistic, clearanceFor, descendingCrossing, jumpAt, sampleArc, solveJump } from './jump';
import { impactClass } from './landing';
import { clampedClimbDip, clampedPaceDip, classifyJump, descentClearancePx, dropImpact, dropRisk, HARD_DROP_DIP, jumpDownLimits, leaveLimits, takeoffRisk } from './limits';
import type { GraphNode, Route, RouteParams } from './surfaceGraph';
import { edgeId, isWindowHop, SurfaceGraph } from './surfaceGraph';
import type { FloorPiece, Surface, SurfacePoint, WallTrack } from './world';
import { sameSurface, setDownX, WorldModel } from './world';

/** v1.2 adds 'stalk' (hunting creep) and 'sprint' (dash); see MOVEMENT.stalkDip / sprintDip. */
export type Pace = 'stalk' | 'slow' | 'walk' | 'run' | 'chase' | 'sprint';

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
  /**
   * v1.2 (ADR 0003 §7.4, T6): pin the goal to this surface (a ledge's surface id, or a floor key).
   * At every replan x is clamped into that surface's current walk range; the goal never re-maps to
   * another surface, and it is 'unreachable' once that surface is gone. Absent: v1.1.1 mapping.
   *
   * A screen-edge wall's id (ClimbOption.wallId with wallKind 'screenEdge') makes the goal a climb
   * up that edge to the grip height y (clamped to the edge's stretch): the cat mounts it, climbs,
   * holds there (goal 'arrived'; holdOnWall sets how long, MOVEMENT.maxWallHoldMs at most), then
   * climbs down. Screen edges are never used by any other route (the behaviour gates them, T8).
   */
  surfaceId?: string;
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
  // ---- v1.2 (ADR 0003 §6); every flag defaults to off = v1.1.1 behaviour -----------------
  /** Climbable walls at outer display edges (never between monitors). Default false. */
  screenEdges?: boolean;
  /**
   * Jump-down limits, DIP below the feet: planned jumps and drops prefer at most `jumpDownSafeDip`
   * and never exceed `jumpDownMaxDip` (capped at MOVEMENT.jumpDownAbsoluteMaxDip); beyond it the
   * cat climbs down. Absent: unlimited (v1.1.1).
   */
  jumpDownSafeDip?: number;
  jumpDownMaxDip?: number;
  /** Accept ledges 0.25..0.9 body lengths wide as narrow ledges (balance). Default false. */
  narrowLedges?: boolean;
  /** A covered support is left with a controlled bail-out jump to a visible support, never a free fall. Default false. */
  bailOut?: boolean;
  /** Jumps off a wall the cat clings to onto a support within reach (and climb-then-leap descents). Default false. */
  wallJumps?: boolean;
  /**
   * False ('Jump between windows' off): no jump or drop from one window's top or strip onto another's,
   * in the routes as in the leave options. Floors, taskbars and the bail-out are not hops. Default on.
   */
  surfaceHops?: boolean;
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
  /** v1.2: impact class of impactDip (MOVEMENT.impactSoftBelowDip / impactHardFromDip). */
  impact: LandingImpact;
  /**
   * v1.2: kind of the flight that ended: a planned jump's kind, 'down' for a deliberate step off a
   * ledge end or a wall's foot; null for a fall, a release (drop) or a throw, and an emergency drop.
   */
  jumpKind: JumpKind | null;
  /** v1.2: the landing ends a deliberate slip ('miss'). */
  slipped: boolean;
  /**
   * v1.2 (review C2): the support a planned jump aimed at (a ledge's surface id or a floor key);
   * null when the flight was not a planned jump (falls, drops, throws, step-offs, leaps onto walls).
   */
  plannedSupportId: string | null;
  /**
   * v1.2: how a planned jump ended against its plan: 'landed' on that support, 'missed' it (it
   * still exists: it moved or shrank mid-air), or it was 'gone' at landing. null: not planned.
   * The sim's fall accounting turns 'missed' into a physics error and 'gone' into an environmental fall.
   */
  plannedOutcome: PlannedLandingOutcome | null;
}

/** v1.2: see LandingInfo.plannedOutcome. */
export type PlannedLandingOutcome = 'landed' | 'missed' | 'gone';

export type GoalStatus = 'none' | 'moving' | 'arrived' | 'unreachable';

/**
 * Why the cat lost the surface it stood on or clung to:
 * gone       getSurface returned null (window closed/minimized/maximized, surface removed);
 * retracted  a taskbar slid away under it, or its ledge sank below the floor;
 * occluded   its spot is covered while the window stays (a window in front: the live surface
 *            no longer holds it), or the surface stayed out of the usable list or from under
 *            its paws (private, cut short) past the grace;
 * headroom   the ledge moved too close to the top of the screen or off every display;
 * disabled   the user switched that kind of surface off.
 */
export type SupportLossReason = 'gone' | 'retracted' | 'occluded' | 'headroom' | 'disabled';

export interface SupportLoss {
  reason: SupportLossReason;
  surfaceId: string;
  /** v1.2: also 'screenEdge' (a display change removed the edge the cat clung to). */
  surfaceKind: SupportSurfaceKind;
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
  /**
   * A leap ended with the cat clinging to the side (v1.1.1); it climbs from here. The leap
   * itself reports crouchStarted (cancelCrouch() aborts it), then tookOff + climbStarted.
   */
  clung: boolean;
  /** v1.2: a deliberate slip (armSlip) happened this step. */
  slipped: SlipKind | null;
  /** v1.2: the support was covered and the cat left it with a controlled bail-out jump (no free fall). */
  bailedOut: boolean;
  /** v1.2: a planned take-off was cancelled during the crouch: its target vanished, moved or was covered (stale plan). */
  planCancelled: boolean;
}

/**
 * v1.2 deliberate slip, drawn by the sim on a risky leap (ADR 0003 §6.6): 'scramble' = the front
 * paws catch the edge and it pulls itself up; 'miss' = it drops to the support below (only where
 * that is within the jump-down limit; otherwise the mover turns it into a scramble).
 */
export type SlipKind = 'scramble' | 'miss';

/** v1.2: one way off the elevated surface the cat stands on (Mover.leaveOptions). */
export interface LeaveOption {
  kind: LeaveKind;
  /** Where the cat ends up (its anchor on the support it reaches), px. */
  target: { x: number; y: number };
  /** Kind and id of that support. */
  toKind: 'floor' | SupportSurfaceKind;
  toSurfaceId: string | null;
  /** Height from the feet down to the support reached, DIP (negative for a hop up). */
  dropDip: number;
  /** Impact class of the jump or drop part (null for a pure climb or walk). */
  impact: LandingImpact | null;
  /** Planner effort, seconds (walking time plus move efforts, before personality). */
  effort: number;
  /** 0..1: height against the limits, landing width, a moving target. */
  risk: number;
  /** Where on the current surface the move starts (take-off x, the corner, the joined end). */
  startX: number;
  /**
   * v1.2 (review C2): the emergency way off, offered only when no other option exists (the cat
   * was carried up, nothing within jumpDownMaxDip, no wall): the cat hangs from the edge first
   * (about one body height lower) and drops. Only this kind of leg may exceed jumpDownMaxDip and
   * MOVEMENT.jumpDownAbsoluteMaxDip.
   */
  emergency: boolean;
}

/** v1.2: a ballistic hunting pounce (Mover.pounceAt). */
export interface PounceOptions {
  /** Anticipation crouch with a visible wiggle, ms (MOVEMENT.pounceCrouchMinMs..MaxMs). */
  crouchMs: number;
  /**
   * Clearance (px) between the target x (the cursor hotspot) and the leading edge of the landing
   * pose's hit region: the anchor stops at target.x - facing * (frontExtentPx + shortPx), so the
   * hit region never ends under the hotspot (T8).
   */
  shortPx: number;
  /**
   * v1.2 (review C2): how far the landing pose's hit region reaches ahead of the anchor, px
   * (HIT_FRONT_EXTENT_DIP.pounce x size x scale). Default 0 keeps the v1.1.1 anchor rule.
   */
  frontExtentPx?: number;
  /** Longest pounce, px (at most MOVEMENT.pounceReachBodyLengths body lengths). */
  maxDistPx: number;
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
  /**
   * v1.2: what is climbed; absent = 'windowSide'. A 'screenEdge' climb up ends at the edge's top
   * hold point (no ledge to pull up onto): the sim holds there (holdOnWall), then leaves it.
   */
  wallKind?: 'windowSide' | 'screenEdge';
}

/** v1.2: a planned jump off a wall the cat clings to (screen-edge hold, climbLeap, a route over a side's top). */
interface WallJump {
  /** Anchor height on the wall where it pushes off (it climbs there first). */
  gripY: number;
  /** The support it jumps onto (a ledge's key or a floor key) and where on it. */
  targetKey: string;
  landX: number;
  /** End of the push-off crouch once at the grip (null: not crouching yet). */
  crouchUntil: number | null;
  slip: SlipKind | null;
}

type Leg =
  | { kind: 'walk'; x: number; reachable: boolean }
  | { kind: 'jump'; takeoffX: number; landX: number; target: Surface }
  | { kind: 'drop'; dir: 1 | -1 }
  | { kind: 'cross'; x: number; to: Surface }
  /**
   * gripY: leap from the stand point and catch the side there (null: step onto it). v1.2: ledgeKey
   * null for a screen edge (no pull-up; it holds at holdY), jumpTo: a route continuing with a wall
   * jump from the side's top instead of the pull-up.
   */
  | { kind: 'climbUp'; standX: number; wall: WallTrack; ledgeKey: string | null; cornerX: number | null; gripY: number | null; holdY?: number | null; jumpTo?: string | null }
  /** v1.2 wallJump: climbLeap leaves climb down to a grip and push off from there. */
  | { kind: 'climbDown'; cornerX: number; wall: WallTrack; wallJump?: WallJump | null }
  /** v1.2 emergency leave: walk to the ledge end at x, hang from it (dir = outward) and drop. */
  | { kind: 'hang'; x: number; dir: 1 | -1 };

/** v1.2: the controlled bail-out in progress (from the cover until the landing or the catch). */
interface BailOut {
  reason: SupportLossReason;
  surfaceId: string;
  surfaceKind: SupportSurfaceKind;
  ownerId: string;
  /** Sim time the support was reported covered or gone. */
  since: number;
}

/** v1.2: what leaveBy executes for one LeaveOption. */
type LeavePlan =
  | { type: 'leg'; leg: Leg; goalKey: string }
  | { type: 'wallDown'; goalKey: string }
  | { type: 'wallJump'; jump: WallJump; goalKey: string }
  | { type: 'wallLetGo' };

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
  /** v1.2: key of the support a planned jump aimed at; kept when the target is lost mid-air. */
  plannedKey: string | null;
  thrown: boolean;
  intentional: boolean;
  /** Ledge the cat just left (not landed on again during this flight). */
  ignoreKey: string | null;
  peakY: number;
  scale: number;
  startedAt: number;
  /** v1.2: kind of the planned flight (render hint and LandingInfo.jumpKind); null: a fall, a drop or a throw. */
  kind: JumpKind | null;
  /** v1.2 armed slip: 'miss' slides off at the end of the arc, 'scramble' scrambles up after landing. */
  slip: SlipKind | null;
  /** v1.2: this flight is the fall after a deliberate 'miss' (LandingInfo.slipped). */
  slipped: boolean;
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
  /** 'leap': v1.1.1 ballistic jump from a support onto a side whose foot is out of step reach. */
  phase: 'leap' | 'mount' | 'swing' | 'climb' | 'pullUp' | 'dismount';
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
  /** At the top corner with no top ledge listed: since when (it waits the grace before turning back). */
  topMissingSince: number | null;
  /**
   * Phase 'leap': the arc from the take-off point to the grip `to` as planned at take-off. v1.2:
   * `down` = a bail-out leap onto a wall below or level with the feet (then it climbs down);
   * `slip` = an armed deliberate slip for the catch.
   */
  leap: { plan: JumpPlan; peakY: number; scale: number; down?: boolean; slip?: SlipKind | null } | null;
  /** v1.2: grip height to stop and hold at (screen-edge climbs), or null. */
  holdY: number | null;
  /** v1.2: holding still on the wall (holdOnWall, or a screen edge's hold point) until `until`, capped. */
  hold: { since: number; until: number } | null;
  /** v1.2: a jump off this wall to make (climbs to its grip first), or null. */
  wallJump: WallJump | null;
  /** v1.2: at the top of a side, push off onto this support instead of pulling up (a route over the top). */
  jumpTo: string | null;
  /** v1.2: an armed deliberate slip for the pull-up onto a tab strip. */
  slip: SlipKind | null;
  /** v1.2: a 'scramble' slip holds the cat still until then (sim time). */
  scrambleUntil: number;
}

/** v1.2: what a crouch is for (slips are drawn only before a take-off onto another support). */
type CrouchKind = 'jump' | 'hop' | 'pounce' | 'leap' | 'bail' | 'hang';

interface Crouch {
  until: number;
  landX: number;
  target: Surface;
  clearanceDip: number | null;
  /** The crouch before a leap onto this wall (then `target` is the surface it stands on). */
  leap: { wallKey: string; ledgeKey: string | null; cornerX: number | null; holdY: number | null; jumpTo: string | null } | null;
  /** v1.2 */
  kind: CrouchKind;
  /** The target's geometry when the crouch began (stale-plan check), or null. */
  snap: { y: number; x0: number; x1: number } | null;
  /** Armed deliberate slip for this take-off (armSlip). */
  slip: SlipKind | null;
  /** v1.1.1 hops and pounces: the render kind of the flight. */
  jumpKind: JumpKind | null;
  /** Pounce on the cat's own surface: landing x relative to the anchor (it rides along with a moving window). */
  offsetX: number | null;
  /** 'hang': where the hang started and the outward direction. */
  hang: { x: number; y: number; dir: 1 | -1 } | null;
}

type ClimbStats = NavDiagnostics['climbs'];

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
/** Reachability for diagnostics is recomputed at most this often (sim clock). */
const REACH_CACHE_MS = 500;
/** Rejected surfaces whose geometry is kept for the debug visualization (drawn last, cut first). */
const MAX_REJECTED_LINES = MAX_DEBUG_LINES;

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
  /** Set down on a ledge's widened landing range outside its stand range: it walks in (no snap). */
  private walkIn = false;
  /** Sim clock of the last step (diagnostics caching). */
  private clock = 0;
  /** Final surface of the route being followed (diagnostics), or null. */
  private destKey: string | null = null;
  /** What the last sense() received and turned down (counts, kinds and physical-px geometry only). */
  private navIn: { received: SurfaceCounts; rejected: Partial<Record<NavRejectReason, number>>; rejectedLines: SurfaceDebugLine[] } = {
    received: emptySurfaceCounts(),
    rejected: {},
    rejectedLines: [],
  };
  private readonly climbStats: ClimbStats = { leaps: 0, mounts: 0, pulledUp: 0, reversed: 0, letGo: 0, topReResolved: 0 };
  private reachCache: { at: number; keys: ReadonlySet<string> } | null = null;
  // ---- v1.2 state ----------------------------------------------------------------
  /** A 'scramble' slip after landing holds the cat still until then (sim time). */
  private scrambleUntil = -Infinity;
  /** Sim times of recent planCancelled take-offs, and the backoff they triggered. */
  private cancels: number[] = [];
  private backoffUntil = -Infinity;
  private backoffs = 0;
  /** The backoff dropped the plan: plan afresh once it is over. */
  private backoffReplan = false;
  /** `<displayId>:<side>` of displays seen with a side taskbar (auto-hide too): never a screen-edge wall there. */
  private readonly taskbarSides = new Set<string>();
  private edgeCache: { world: WorldModel; sides: number; tracks: WallTrack[] } | null = null;
  /** The controlled bail-out in progress, and the kind of the last one. */
  private bailing: BailOut | null = null;
  private lastBailOut: BailOutKind | null = null;
  /** A support loss noticed outside step() (a display removed while clinging): reported by the next step. */
  private pendingLoss: SupportLoss | null = null;
  /** stepAway: the hidden cat keeps the v1.1.1 handling of lost supports (no bail-out). */
  private away = false;
  /** Plans of the options the last leaveOptions() returned. */
  private leavePlans = new WeakMap<LeaveOption, LeavePlan>();

  constructor(geometry: WorldGeometry, cfg: MoverConfig, start: { displayId: string | null; xFrac: number }) {
    this.cfg = { ...cfg };
    this.geometry = geometry;
    this.graph.setOptions({ wallJumps: cfg.wallJumps === true, surfaceHops: cfg.surfaceHops !== false });
    this.fullWorld = new WorldModel(geometry, cfg.size, cfg.allowMultiMonitor, { narrowLedges: cfg.narrowLedges === true });
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
  /** Clinging to a wall (climbing, pulling up or stepping on/off it), or leaping onto one (climbPhase 'leap'). */
  get onWall(): boolean {
    return this.modeValue === 'climb' && this.climbing !== null;
  }
  /** Phase of the current wall manoeuvre ('leap' while flying onto the side), or null when not on a wall. */
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
  /**
   * The environment surface the cat is attached to (ledge or wall), or null. A screen edge is not
   * an environment surface: null there (see `support`, surfaceKind 'screenEdge', and `onScreenEdge`).
   */
  get attachedSurface(): { surfaceId: string; surfaceKind: SurfaceKind; ownerId: string } | null {
    if (this.modeValue === 'climb' && this.climbing) {
      const w = this.climbing.wall;
      return w.kind === 'screenEdge' ? null : { surfaceId: w.key, surfaceKind: 'windowSide', ownerId: w.ownerId };
    }
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
        if (this.climbing) return { kind: 'surface', surfaceId: this.climbing.wall.key, surfaceKind: this.climbing.wall.kind === 'screenEdge' ? SCREEN_EDGE_KIND : 'windowSide', orientation: 'wall' };
        return { kind: 'air' };
      default:
        if (this.attach) return { kind: 'surface', surfaceId: this.attach.surfaceId, surfaceKind: this.attach.surfaceKind, orientation: 'ledge' };
        // The bail-out crouch on a ledge that just vanished: not on the floor yet.
        if (this.modeValue === 'crouch' && this.surface.kind === 'ledge') return { kind: 'air' };
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
  /**
   * Pace speed in px/s: the pace's DIP speed x movementSpeed, clamped to 1.1 x the clean-gait limit
   * of the clip it is drawn with (GAIT_LIMIT_DIP, ADR 0003 §6.7), x the display scale.
   */
  paceSpeedPx(pace: Pace): number {
    return clampedPaceDip(pace, this.cfg.movementSpeed) * this.scale;
  }

  /** Climbing speed in px/s (clamped to 1.1 x the climb clip's clean-gait limit). */
  private climbSpeedPx(up: boolean): number {
    return clampedClimbDip(up, this.cfg.movementSpeed) * this.scale;
  }

  // ---- v1.2 (ADR 0003 §6) ------------------------------------------------------------------

  /**
   * Kind of the current flight (render jumpKind): hop, up, down, across, pounce, wallJump while
   * airborne on a planned jump, 'leap' while flying onto a wall; null otherwise (falls, drops, throws).
   */
  get jumpKind(): JumpKind | null {
    if (this.modeValue === 'air') return this.flight?.kind ?? null;
    if (this.modeValue === 'climb' && this.climbing?.phase === 'leap') return 'leap';
    return null;
  }

  /**
   * 0..1 how hard the cat balances: on a narrow ledge (MoverConfig.narrowLedges) clamp((0.9 bw -
   * width) / 0.65 bw); MOVEMENT.wallHoldBalance while holding on a wall; else 0.
   */
  get balance(): number {
    if (this.modeValue === 'climb') return this.climbing?.hold ? MOVEMENT.wallHoldBalance : 0;
    if (this.modeValue !== 'ground' && this.modeValue !== 'crouch') return 0;
    const w = this.cfg.narrowLedges === true ? this.surface.narrowWidthPx : undefined;
    if (w === undefined) return 0;
    const bw = this.bodyWidth;
    return clamp((MOVEMENT.narrowLedgeBelowBodyLengths * bw - w) / ((MOVEMENT.narrowLedgeBelowBodyLengths - MOVEMENT.narrowLedgeMinBodyLengths) * bw), 0, 1);
  }

  /** On a narrow ledge (balance > 0 there): slower walking, no running, no pounces. */
  private get onNarrowLedge(): boolean {
    return this.cfg.narrowLedges === true && (this.modeValue === 'ground' || this.modeValue === 'crouch') && this.surface.narrowWidthPx !== undefined;
  }

  /**
   * 0..1 geometric risk of the take-off about to happen (ADR 0003 §6.6: landing span, gap, rise,
   * moving target; the sim adds energy): while crouching for a jump onto another support or a leap
   * onto a wall, while crouching for a wall jump, or while climbing up to a pull-up onto a tab strip.
   * 0 otherwise (and for hops on the same surface, pounces, bail-outs and emergency legs).
   */
  get nextLegRisk(): number {
    return this.slipEligible() ? this.takeoffRiskNow() : 0;
  }

  /** The kind of the last controlled bail-out (set when MoverStep.bailedOut is reported), or null. */
  get bailOutKind(): BailOutKind | null {
    return this.lastBailOut;
  }

  /**
   * A controlled bail-out is in progress: from the moment the support was found covered or gone
   * (the bail-out crouch) until the landing or the catch on a wall. The host's click guard keeps
   * the covering window clickable meanwhile (ADR 0003 §3).
   */
  get bailingOut(): boolean {
    return this.bailing !== null;
  }

  /** Clinging to an outer screen edge (MoverConfig.screenEdges). */
  get onScreenEdge(): boolean {
    return this.modeValue === 'climb' && this.climbing?.wall.kind === 'screenEdge';
  }

  /** Holding still on a wall (holdOnWall, or a screen edge's hold point). */
  get holdingOnWall(): boolean {
    return this.modeValue === 'climb' && (this.climbing?.hold ?? null) !== null;
  }

  /**
   * Ways off the elevated surface the cat stands on, for the stay model's single leave intent
   * (ADR 0003 §2.3): jump down within the jump-down limits, climb down a side, climb part-way down
   * and wall-jump (climbLeap, with MoverConfig.wallJumps), hop to another reachable ledge, walk off a
   * joined end. While holding on a screen edge: climb down, or wall-jump (climbLeap). The
   * `emergency` option (hang from the nearer end, then drop) is offered only when none of these
   * exists. [] on the floor, on a taskbar and when not grounded (or holding on a screen edge).
   * Without configured limits only MOVEMENT.jumpDownAbsoluteMaxDip applies.
   */
  leaveOptions(): LeaveOption[] {
    const listed = this.listLeaveOptions();
    this.leavePlans = new WeakMap();
    for (const { option, plan } of listed) this.leavePlans.set(option, plan);
    return listed.map((l) => l.option);
  }

  /**
   * The emergency way off from where the cat stands, whatever else leaveOptions() lists (ADR 0003
   * §2.3): for the sim, whose opt-outs may rule out everything listed. Null where leaveOptions()
   * is [] too, or when both ends lead off limits. leaveBy takes it like any other option.
   */
  emergencyLeaveOption(): LeaveOption | null {
    return this.emergencyEntry()?.option ?? null;
  }

  /**
   * Leaves by `option` (from leaveOptions this tick or the last): the options are listed again and
   * the matching one (same kind, target surface and emergency flag, target and start within a
   * body length) is executed at `pace`. False when it no longer applies.
   */
  leaveBy(option: LeaveOption, pace: Pace): boolean {
    if (!option || typeof option !== 'object') return false;
    const bw = this.bodyWidth;
    const emergency = option.emergency ? this.emergencyEntry() : null;
    const fresh = (emergency ? [emergency] : this.listLeaveOptions()).find(
      (l) =>
        l.option.kind === option.kind &&
        l.option.toSurfaceId === option.toSurfaceId &&
        l.option.toKind === option.toKind &&
        l.option.emergency === option.emergency &&
        Math.abs(l.option.target.x - option.target.x) <= bw &&
        Math.abs(l.option.target.y - option.target.y) <= bw &&
        Math.abs(l.option.startX - option.startX) <= bw,
    );
    if (!fresh) return false;
    return this.applyLeave(fresh.option, fresh.plan, pace);
  }

  /**
   * Ballistic hunting pounce toward `target` (the cursor's projection; ADR 0003 §6.5): a crouch of
   * opts.crouchMs (the wiggle), then an arc with its apex 30-70 DIP up by distance, landing the
   * anchor at target.x - facing x (frontExtentPx + shortPx) so the landing pose's hit region stops
   * short of the hotspot, at most min(maxDistPx, 3.2 body lengths) away. It lands on the current
   * surface or one walk-joined to it at the same height, inside the walk range; a target past a
   * ledge's end lands 0.2 body lengths inside that end. A surface that vanishes or moves more than
   * half a body length during the crouch cancels it (MoverStep.planCancelled). Never on a narrow
   * ledge, never a slip. False when it cannot pounce (not standing, too close, nowhere to land).
   */
  pounceAt(now: number, target: { x: number; y: number }, opts: PounceOptions): boolean {
    if (this.modeValue !== 'ground' || !target || !Number.isFinite(target.x) || !opts || !Number.isFinite(opts.shortPx)) return false;
    if (this.onNarrowLedge) return false;
    const bw = this.bodyWidth;
    const dir: Facing = target.x >= this.x ? 1 : -1;
    const front = Number.isFinite(opts.frontExtentPx) ? Math.max(0, opts.frontExtentPx ?? 0) : 0;
    const reach = MOVEMENT.pounceReachBodyLengths * bw;
    const maxDist = Number.isFinite(opts.maxDistPx) && opts.maxDistPx > 0 ? Math.min(opts.maxDistPx, reach) : reach;
    let landX = target.x - dir * (front + Math.max(0, opts.shortPx));
    // Too close: the clearance would put the landing behind the cat (it never pounces away).
    if ((landX - this.x) * dir < bw * 0.25) return false;
    const s = this.surface;
    const margin = MOVEMENT.pounceEndMarginBodyLengths * bw;
    const r = this.rangeOn(s, this.x);
    const endX = dir > 0 ? r.x1 - margin : r.x0 + margin;
    let onto: Surface = s;
    if (landX > r.x1 || landX < r.x0) {
      // Past the end: onto a ledge joined there at the same height, else 0.2 body lengths inside the end.
      const joined = this.joinedSurfaceAt(s, landX);
      if (joined) {
        onto = joined;
        landX = clamp(landX, joined.x0 + margin, joined.x1 - margin);
      } else {
        landX = dir > 0 ? Math.min(landX, endX) : Math.max(landX, endX);
      }
    }
    landX = this.x + dir * Math.min(Math.abs(landX - this.x), maxDist);
    if (onto !== s && (landX < onto.landX0 || landX > onto.landX1)) {
      // The reach ends short of the joined ledge: on this one, inside its end.
      onto = s;
      landX = dir > 0 ? Math.min(landX, endX) : Math.max(landX, endX);
    }
    if ((landX - this.x) * dir < bw * 0.25) return false;
    const dist = Math.abs(landX - this.x);
    const apexDip = MOVEMENT.pounceApexMinDip + (MOVEMENT.pounceApexMaxDip - MOVEMENT.pounceApexMinDip) * Math.min(1, dist / maxDist);
    const crouchMs = Number.isFinite(opts.crouchMs) ? clamp(opts.crouchMs, 0, 6000) : MOVEMENT.pounceCrouchMinMs;
    this.setFacing(dir, now);
    this.goal = null;
    this.leg = null;
    this.vx = 0;
    this.modeValue = 'crouch';
    this.crouch = {
      ...this.newCrouch(now + crouchMs, landX, onto, 'pounce'),
      clearanceDip: apexDip,
      jumpKind: 'pounce',
      offsetX: onto === s ? landX - this.x : null,
    };
    return true;
  }

  /**
   * Arms a deliberate slip (the sim draws it, ADR 0003 §6.6) for the take-off being prepared: a
   * jump onto another support or a leap onto a wall (during the crouch), a wall jump (during its
   * push-off crouch or while climbing to its grip), or a pull-up onto a tab strip (while climbing up
   * to it). 'miss' becomes 'scramble' where the drop below would exceed the safe jump-down height.
   * False when no such take-off is pending (pounces, hops on the same surface, bail-outs and
   * emergency legs never slip).
   */
  armSlip(kind: SlipKind): boolean {
    if (kind !== 'scramble' && kind !== 'miss') return false;
    if (!this.slipEligible()) return false;
    const c = this.climbing;
    if (this.modeValue === 'crouch' && this.crouch) this.crouch.slip = kind;
    else if (this.modeValue === 'climb' && c) {
      if (c.wallJump) c.wallJump.slip = kind;
      else c.slip = kind;
    } else return false;
    return true;
  }

  /**
   * Holds the clinging cat where it is on the wall (screen-edge top-corner peek) until `untilMs`
   * (sim clock), never longer than MOVEMENT.maxWallHoldMs from the start of the hold; null releases
   * it (it climbs down unless a new goal or leave follows). False when not clinging (climbing phase).
   */
  holdOnWall(untilMs: number | null): boolean {
    const c = this.climbing;
    if (this.modeValue !== 'climb' || !c || c.phase !== 'climb') return false;
    if (untilMs === null) {
      if (c.hold) this.endHold(c);
      return true;
    }
    if (!Number.isFinite(untilMs)) return false;
    const since = c.hold?.since ?? this.clock;
    c.hold = { since, until: Math.min(untilMs, since + MOVEMENT.maxWallHoldMs) };
    c.wallJump = null;
    this.vy = 0;
    return true;
  }

  /** A hold ended (expired or released): it climbs down; a goal that was the hold point itself is done. */
  private endHold(c: Climb): void {
    c.hold = null;
    c.holdY = null;
    c.dir = 1;
    if (this.goal?.surfaceId === c.wall.key) {
      this.goal = null;
      this.leg = null;
      this.destKey = null;
    }
  }

  /** A take-off that may slip is being prepared (see armSlip). */
  private slipEligible(): boolean {
    const k = this.crouch;
    if (this.modeValue === 'crouch' && k) return (k.kind === 'jump' && k.target.key !== this.surface.key) || k.kind === 'leap';
    const c = this.climbing;
    if (this.modeValue !== 'climb' || !c || c.phase === 'leap' || c.phase === 'pullUp') return false;
    if (c.wallJump) return true;
    return c.dir < 0 && c.topKey !== null && this.ledgeById(c.topKey)?.surfaceKind === 'tabStrip';
  }

  /** Geometric risk of the take-off being prepared (slipEligible). */
  private takeoffRiskNow(): number {
    const scale = this.scale;
    const bw = this.bodyWidth;
    const k = this.crouch;
    if (this.modeValue === 'crouch' && k) {
      if (k.leap) {
        const w = this.walls.find((t) => t.key === k.leap?.wallKey);
        if (!w) return 0;
        const grip = this.graph.leapGripY(w, this.y, scale) ?? this.y - MOVEMENT.wallLeapGripDip * scale;
        return takeoffRisk({ spanPx: Infinity, gapPx: Math.abs(w.x - this.x), upPx: this.y - grip, targetSpeedDip: 0 }, scale, bw);
      }
      const t = k.target;
      const gap = Math.max(0, t.landX0 - this.x, this.x - t.landX1);
      return takeoffRisk({ spanPx: t.landX1 - t.landX0, gapPx: gap, upPx: this.y - t.y, targetSpeedDip: Math.abs(t.vy) / scale }, scale, bw);
    }
    const c = this.climbing;
    if (!c) return 0;
    if (c.wallJump) {
      const t = this.supportByKey(c.wallJump.targetKey);
      if (!t) return 0;
      return takeoffRisk({ spanPx: t.landX1 - t.landX0, gapPx: Math.abs(c.wallJump.landX - c.wall.x), upPx: c.wallJump.gripY - t.y, targetSpeedDip: Math.abs(t.vy) / scale }, scale, bw);
    }
    const top = c.topKey ? this.ledgeById(c.topKey) : null;
    return top ? takeoffRisk({ spanPx: top.x1 - top.x0, gapPx: 0, upPx: 0, targetSpeedDip: Math.abs(top.vy) / scale }, scale, bw) : 0;
  }

  /** A ledge walk-joined to `s` at the same height whose landing range holds x (a pounce may land there). */
  private joinedSurfaceAt(s: Surface, x: number): Surface | null {
    for (const e of this.graph.edgesFrom(s.key)) {
      if (e.kind !== 'walk') continue;
      const t = this.graph.node(e.to)?.surface;
      if (t && t.kind === 'ledge' && t.phase !== 'leaving' && x >= t.landX0 && x <= t.landX1 && !this.offLimitsAt(t, x)) return t;
    }
    return null;
  }

  /** The leave options with the plans that execute them (see leaveOptions). */
  private listLeaveOptions(): Array<{ option: LeaveOption; plan: LeavePlan }> {
    const c = this.climbing;
    if (this.modeValue === 'climb' && c && c.phase === 'climb' && c.wall.kind === 'screenEdge') return this.wallLeaveOptions(c);
    if (this.modeValue !== 'ground' || !this.attach) return [];
    const s = this.surface;
    if (s.kind !== 'ledge' || s.surfaceKind === 'taskbar') return [];
    const scale = this.scale;
    const bw = this.bodyWidth;
    const bh = this.bodyHeight;
    const limits = leaveLimits(this.cfg);
    const walk = Math.max(1, this.paceSpeedPx('walk'));
    const node = this.graph.node(s.key) ?? { key: s.key, kind: 'ledge' as const, surface: s, wall: null, hash: '' };
    const out: Array<{ option: LeaveOption; plan: LeavePlan }> = [];
    const seen = new Set<string>();
    const add = (o: Omit<LeaveOption, 'emergency'>, plan: LeavePlan): void => {
      out.push({ option: { ...o, emergency: false }, plan });
    };
    const spanRisk = (t: Surface, gapPx: number, upPx: number): number => takeoffRisk({ spanPx: t.landX1 - t.landX0, gapPx, upPx, targetSpeedDip: Math.abs(t.vy) / scale }, scale, bw);
    const both = (a: number, b: number): number => 1 - (1 - a) * (1 - b);
    for (const e of this.graph.outgoing(node)) {
      const tn = this.graph.node(e.to);
      if (!tn || this.nodeBlocked(tn) || tn.wall?.kind === 'screenEdge') continue;
      const t = tn.surface;
      if (e.kind === 'walk' && t && t.kind === 'ledge') {
        if (t.phase === 'leaving' || seen.has(`walkOff:${t.key}`)) continue;
        seen.add(`walkOff:${t.key}`);
        const startX = clamp(this.x, e.fromLo, e.fromHi);
        add(
          { kind: 'walkOff', target: { x: clamp(startX, t.x0, t.x1), y: t.y }, toKind: leaveToKind(t), toSurfaceId: t.key, dropDip: (t.y - s.y) / scale, impact: null, effort: Math.abs(startX - this.x) / walk + e.effort, risk: spanRisk(t, 0, 0), startX },
          { type: 'leg', leg: { kind: 'cross', x: startX, to: t }, goalKey: t.key },
        );
      } else if ((e.kind === 'jump' || e.kind === 'drop') && t) {
        if (t.phase === 'leaving') continue;
        const down = this.navWorld.yAt(t, clamp(this.x, t.x0, t.x1)) - s.y > 0.5 * bh;
        const legs: Array<Extract<Leg, { kind: 'jump' }>> = [];
        if (down) {
          // Off one of the ledge's ends, landing a body length beyond it; else straight down from here.
          for (const dir of [-1, 1] as const) {
            if (seen.has(`jumpDown:${t.key}:${dir}`)) continue;
            const endX = dir < 0 ? s.x0 : s.x1;
            const want = endX + dir * bw;
            if (want < t.x0 - bw || want > t.x1 + bw) continue;
            const leg = this.planJumpLeg(s, endX, { surface: t, x: clamp(want, t.x0, t.x1), y: this.navWorld.yAt(t, clamp(want, t.x0, t.x1)) });
            if (leg?.kind === 'jump') {
              seen.add(`jumpDown:${t.key}:${dir}`);
              legs.push(leg);
            }
          }
          if (![-1, 0, 1].some((d) => seen.has(`jumpDown:${t.key}:${d}`))) {
            const lx = clamp(this.x, t.x0, t.x1);
            const leg = this.planJumpLeg(s, this.x, { surface: t, x: lx, y: this.navWorld.yAt(t, lx) });
            if (leg?.kind === 'jump') {
              seen.add(`jumpDown:${t.key}:0`);
              legs.push(leg);
            }
          }
        } else if (t.kind === 'ledge' && !seen.has(`hop:${t.key}`)) {
          const leg = this.planJumpLeg(s, this.x, { surface: t, x: clamp(this.x, t.x0, t.x1), y: t.y });
          if (leg?.kind === 'jump') {
            seen.add(`hop:${t.key}`);
            legs.push(leg);
          }
        }
        for (const leg of legs) {
          const ly = this.navWorld.yAt(t, leg.landX);
          const dropDip = (ly - s.y) / scale;
          if (dropDip > limits.maxDip) continue;
          const gap = Math.max(0, t.landX0 - leg.takeoffX, leg.takeoffX - t.landX1);
          add(
            {
              kind: down ? 'jumpDown' : 'hop',
              target: { x: leg.landX, y: ly },
              toKind: leaveToKind(t),
              toSurfaceId: t.kind === 'floor' ? null : t.key,
              dropDip,
              impact: dropDip > 0 ? dropImpact(dropDip) : 'soft',
              effort: Math.abs(leg.takeoffX - this.x) / walk + e.effort,
              risk: both(dropRisk(dropDip, limits), spanRisk(t, gap, s.y - ly)),
              startX: leg.takeoffX,
            },
            { type: 'leg', leg, goalKey: t.key },
          );
        }
      } else if (e.kind === 'swing' && tn.wall) {
        const w = tn.wall;
        const exit = this.graph.dismountTarget(this.navWorld, w);
        if (!exit || this.offLimitsAt(exit.surface, exit.x) || seen.has(`climbDown:${w.key}`)) continue;
        seen.add(`climbDown:${w.key}`);
        const footDip = exit.y - w.yBottom > MOVEMENT.wallReachBodyHeights * bh ? (exit.y - w.yBottom) / w.scale : 0;
        if (footDip > limits.maxDip) continue;
        const down = clampedClimbDip(false, this.cfg.movementSpeed);
        const walkSec = Math.abs(e.fromLo - this.x) / walk;
        add(
          {
            kind: 'climbDown',
            target: { x: exit.x, y: exit.y },
            toKind: leaveToKind(exit.surface),
            toSurfaceId: exit.surface.kind === 'floor' ? null : exit.surface.key,
            dropDip: (exit.y - s.y) / scale,
            impact: footDip > 0 ? dropImpact(footDip) : null,
            effort: walkSec + e.effort + (Math.min(exit.y, w.yBottom) - w.yTop) / w.scale / down + MOVEMENT.dismountMs / 1000,
            risk: dropRisk(footDip, limits),
            startX: e.fromLo,
          },
          { type: 'leg', leg: { kind: 'climbDown', cornerX: e.fromLo, wall: w }, goalKey: exit.surface.key },
        );
        if (this.cfg.wallJumps !== true) continue;
        // climbLeap: down to a grip at most min(H_safe, 0.8 h_hard) above the support below, then a wall jump.
        const gripMax = Math.min(limits.safeDip, 0.8 * HARD_DROP_DIP) * w.scale;
        const gy = clamp(exit.y - gripMax, w.yTop, w.yBottom);
        if (gy >= w.yBottom - 0.5 * bh) continue;
        const land = this.graph.wallJumpLanding(this.navWorld, w, gy, exit.surface);
        if (!land || this.offLimitsAt(exit.surface, land.x)) continue;
        const leapDip = (land.y - gy) / w.scale;
        if (leapDip > limits.maxDip || !this.solveChecked({ x: w.x, y: gy }, land, null)) continue;
        add(
          {
            kind: 'climbLeap',
            target: land,
            toKind: leaveToKind(exit.surface),
            toSurfaceId: exit.surface.kind === 'floor' ? null : exit.surface.key,
            dropDip: (land.y - s.y) / scale,
            impact: leapDip > 0 ? dropImpact(leapDip) : 'soft',
            effort: walkSec + e.effort + (gy - w.yTop) / w.scale / down + ROUTE_EFFORT.wallJumpBase + MOVEMENT.wallJumpCrouchMs / 1000,
            risk: dropRisk(leapDip, limits),
            startX: e.fromLo,
          },
          { type: 'leg', leg: { kind: 'climbDown', cornerX: e.fromLo, wall: w, wallJump: { gripY: gy, targetKey: exit.surface.key, landX: land.x, crouchUntil: null, slip: null } }, goalKey: exit.surface.key },
        );
      }
    }
    if (out.length > 0) return out;
    const emergency = this.emergencyOffLedge(s);
    return emergency ? [emergency] : [];
  }

  /** The emergency option where leave options exist at all (see emergencyLeaveOption). */
  private emergencyEntry(): { option: LeaveOption; plan: LeavePlan } | null {
    const c = this.climbing;
    if (this.modeValue === 'climb' && c && c.phase === 'climb' && c.wall.kind === 'screenEdge') return this.emergencyOffWall();
    if (this.modeValue !== 'ground' || !this.attach) return null;
    const s = this.surface;
    return s.kind === 'ledge' && s.surfaceKind !== 'taskbar' ? this.emergencyOffLedge(s) : null;
  }

  /** The emergency way off a ledge: hanging from the nearer end first, then letting go; null when both ends lead off limits. */
  private emergencyOffLedge(s: Surface): { option: LeaveOption; plan: LeavePlan } | null {
    const scale = this.scale;
    const bw = this.bodyWidth;
    const walk = Math.max(1, this.paceSpeedPx('walk'));
    const others = this.ledges.filter((l) => l.key !== s.key);
    const ends: Array<1 | -1> = this.x - s.x0 <= s.x1 - this.x ? [-1, 1] : [1, -1];
    const hangDip = MOVEMENT.emergencyHangBodyHeights * CAT_BASE_HEIGHT_DIP * this.navWorld.size;
    for (const dir of ends) {
      const endX = dir < 0 ? s.x0 : s.x1;
      const fx = endX + dir * bw * 0.3;
      const below = this.navWorld.surfaceBelow(fx, s.y + 1, others) ?? this.navWorld.nearestFloorPoint({ x: fx, y: s.y });
      if (this.offLimitsAt(below.surface, below.x)) continue;
      const dropDip = (below.y - s.y) / scale;
      return {
        option: {
          kind: 'jumpDown',
          target: { x: below.x, y: below.y },
          toKind: leaveToKind(below.surface),
          toSurfaceId: below.surface.kind === 'floor' ? null : below.surface.key,
          dropDip,
          impact: dropImpact(Math.max(0, dropDip - hangDip)),
          effort: Math.abs(endX - this.x) / walk + MOVEMENT.emergencyHangMs / 1000,
          risk: 1,
          startX: endX,
          emergency: true,
        },
        plan: { type: 'leg', leg: { kind: 'hang', x: endX, dir }, goalKey: below.surface.key },
      };
    }
    return null;
  }

  /** Ways off a screen edge the cat clings to: climb down, or (wallJumps) push off from a grip within the limits. */
  private wallLeaveOptions(c: Climb): Array<{ option: LeaveOption; plan: LeavePlan }> {
    const w = c.wall;
    const scale = w.scale;
    const limits = leaveLimits(this.cfg);
    const out: Array<{ option: LeaveOption; plan: LeavePlan }> = [];
    const climb = clampedClimbDip(false, this.cfg.movementSpeed);
    const exit = this.graph.dismountTarget(this.navWorld, w);
    if (exit && !this.offLimitsAt(exit.surface, exit.x)) {
      out.push({
        option: {
          kind: 'climbDown',
          target: { x: exit.x, y: exit.y },
          toKind: leaveToKind(exit.surface),
          toSurfaceId: exit.surface.kind === 'floor' ? null : exit.surface.key,
          dropDip: (exit.y - this.y) / scale,
          impact: null,
          effort: Math.max(0, Math.min(exit.y, w.yBottom) - this.y) / scale / climb + MOVEMENT.dismountMs / 1000,
          risk: 0,
          startX: w.x,
          emergency: false,
        },
        plan: { type: 'wallDown', goalKey: exit.surface.key },
      });
    }
    if (this.cfg.wallJumps === true) {
      const gripMax = Math.min(limits.safeDip, 0.8 * HARD_DROP_DIP) * scale;
      for (const t of [...this.navWorld.floors, ...this.ledges]) {
        if (t.phase === 'leaving') continue;
        const gy = clamp(t.y - this.y > gripMax ? t.y - gripMax : this.y, Math.max(this.y, w.yTop), w.yBottom);
        const land = this.graph.wallJumpLanding(this.navWorld, w, gy, t);
        if (!land || this.offLimitsAt(t, land.x)) continue;
        const leapDip = (land.y - gy) / scale;
        if (leapDip > limits.maxDip || !this.solveChecked({ x: w.x, y: gy }, land, null)) continue;
        out.push({
          option: {
            kind: 'climbLeap',
            target: land,
            toKind: leaveToKind(t),
            toSurfaceId: t.kind === 'floor' ? null : t.key,
            dropDip: (land.y - this.y) / scale,
            impact: leapDip > 0 ? dropImpact(leapDip) : 'soft',
            effort: (gy - this.y) / scale / climb + ROUTE_EFFORT.wallJumpBase + MOVEMENT.wallJumpCrouchMs / 1000,
            risk: dropRisk(leapDip, limits),
            startX: w.x,
            emergency: false,
          },
          plan: { type: 'wallJump', jump: { gripY: gy, targetKey: t.key, landX: land.x, crouchUntil: null, slip: null }, goalKey: t.key },
        });
      }
    }
    return out.length > 0 ? out : [this.emergencyOffWall()];
  }

  /** The emergency way off the screen edge the cat clings to: it lets go. */
  private emergencyOffWall(): { option: LeaveOption; plan: LeavePlan } {
    const scale = (this.climbing as Climb).wall.scale;
    const below = this.navWorld.surfaceBelow(this.x, this.y + 1, this.ledges) ?? this.navWorld.nearestFloorPoint({ x: this.x, y: this.y });
    return {
      option: {
        kind: 'jumpDown',
        target: { x: below.x, y: below.y },
        toKind: leaveToKind(below.surface),
        toSurfaceId: below.surface.kind === 'floor' ? null : below.surface.key,
        dropDip: (below.y - this.y) / scale,
        impact: dropImpact((below.y - this.y) / scale),
        effort: 0,
        risk: 1,
        startX: (this.climbing as Climb).wall.x,
        emergency: true,
      },
      plan: { type: 'wallLetGo' },
    };
  }

  /** Executes a leave plan (leaveBy): the mover then pursues the option's target, pinned to its support. */
  private applyLeave(option: LeaveOption, plan: LeavePlan, pace: Pace): boolean {
    const goalTo = (key: string): void => {
      this.goal = { x: option.target.x, y: option.target.y, pace, allowJump: true, literal: true, surfaceId: key };
      this.blockedEdges.clear();
      this.destKey = key;
    };
    const c = this.climbing;
    switch (plan.type) {
      case 'leg':
        if (this.modeValue !== 'ground') return false;
        goalTo(plan.goalKey);
        this.leg = plan.leg;
        return true;
      case 'wallDown':
        if (this.modeValue !== 'climb' || !c) return false;
        c.hold = null;
        c.holdY = null;
        c.wallJump = null;
        c.replan = false;
        c.dir = 1;
        goalTo(plan.goalKey);
        return true;
      case 'wallJump':
        if (this.modeValue !== 'climb' || !c) return false;
        c.hold = null;
        c.holdY = null;
        c.replan = false;
        c.wallJump = { ...plan.jump, crouchUntil: null, slip: null };
        goalTo(plan.goalKey);
        return true;
      case 'wallLetGo': {
        if (this.modeValue !== 'climb' || !c) return false;
        const outward = c.wall.side === 'left' ? -1 : 1;
        this.climbing = null;
        this.goal = null;
        this.startFlight(outward * this.paceSpeedPx('slow'), 0, this.clock, { thrown: false, intentional: true, ignoreKey: null });
        return true;
      }
    }
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
  /**
   * v1.1.1 surface diagnostics (kinds, counts, reasons; no ids): what the last sense() received,
   * accepted and turned down, what is reachable from where the cat is (the planner's own
   * search, recomputed at most every 500 ms of sim time), graph size and climb outcomes.
   */
  navDiagnostics(): NavDiagnostics {
    const g = this.graphInfo();
    const accepted = emptySurfaceCounts();
    const reachable = emptySurfaceCounts();
    const keys = this.reachableKeys();
    for (const l of this.ledges) {
      if (!l.surfaceKind) continue;
      accepted[l.surfaceKind]++;
      if (keys.has(l.key)) reachable[l.surfaceKind]++;
    }
    for (const w of this.walls) {
      // Screen edges are derived, not provider surfaces: the four provider kinds are counted here.
      if (w.kind === 'screenEdge') continue;
      accepted.windowSide++;
      if (this.sideReachable(w, keys)) reachable.windowSide++;
    }
    return {
      received: { ...this.navIn.received },
      accepted,
      rejected: { ...this.navIn.rejected },
      reachable,
      graph: { nodes: g.nodes, edges: g.edges, updates: g.updates, rebuilds: g.rebuilds },
      climbs: { ...this.climbStats },
    };
  }

  /**
   * v1.1.1 on-desktop visualization (physical px, no ids, at most MAX_DEBUG_LINES): floors,
   * ledges and walls as segments by role, most important first: what the cat is on, where its
   * route goes, what it can reach, the rest it accepted, then what it turned down. Nothing is
   * drawn on an off-limits display (a fullscreen app in front): its floor is left out, and the
   * surfaces turned down for lying there ('offDisplay') carry no line (see sense).
   */
  debugLines(): SurfaceDebugLine[] {
    const keys = this.reachableKeys();
    const target = this.targetKeys();
    const c = this.modeValue === 'climb' ? this.climbing : null;
    const on = this.modeValue === 'ground' || this.modeValue === 'crouch' ? this.surface.key : (c?.wall.key ?? null);
    const byRole: Record<DebugLineRole, SurfaceDebugLine[]> = { support: [], target: [], reachable: [], valid: [], rejected: [] };
    const role = (key: string, reach: boolean): DebugLineRole => (key === on ? 'support' : target.has(key) ? 'target' : reach ? 'reachable' : 'valid');
    for (const f of this.navWorld.floors) {
      const r = role(f.key, keys.has(f.key));
      for (const p of f.pieces) if (!this.isOffLimits(p.displayId)) byRole[r].push({ kind: 'floor', role: r, x0: p.left, y0: p.y, x1: p.right, y1: p.y });
    }
    for (const l of this.ledges) {
      const r = role(l.key, keys.has(l.key));
      byRole[r].push({ kind: l.surfaceKind ?? 'windowTop', role: r, x0: l.landX0, y0: l.y, x1: l.landX1, y1: l.y });
    }
    for (const w of this.walls) {
      const r = role(w.key, this.sideReachable(w, keys));
      byRole[r].push({ kind: 'windowSide', role: r, x0: w.x, y0: w.y0, x1: w.x, y1: w.yBottom });
    }
    byRole.rejected.push(...this.navIn.rejectedLines);
    return [...byRole.support, ...byRole.target, ...byRole.reachable, ...byRole.valid, ...byRole.rejected].slice(0, MAX_DEBUG_LINES);
  }

  /**
   * A side counts as reachable only when it leads somewhere: the cat can get onto it from below
   * and pull up over its top (climbOptions' condition), or reach it from its top to climb down.
   * A side whose top is not listed or not usable (no headroom), or not at its corner, leads nowhere.
   */
  private sideReachable(w: WallTrack, keys: ReadonlySet<string>): boolean {
    return (keys.has(`up:${w.key}`) && this.pullUpOnto(w) !== null) || keys.has(`down:${w.key}`);
  }

  /** The usable top a side leads up to and the corner x where the cat pulls up onto it, or null. */
  private pullUpOnto(w: WallTrack): { top: Surface; cornerX: number } | null {
    const top = w.topLedgeId ? this.ledgeById(w.topLedgeId) : null;
    const cornerX = top ? this.graph.cornerX(this.navWorld, w, top) : null;
    return top && cornerX !== null ? { top, cornerX } : null;
  }

  /** Surfaces and walls the cat is heading for: the current leg's and the route's final one. */
  private targetKeys(): Set<string> {
    const out = new Set<string>();
    if (this.destKey !== null) out.add(this.destKey);
    const leg = this.leg;
    if (leg?.kind === 'jump') out.add(leg.target.key);
    else if (leg?.kind === 'cross') out.add(leg.to.key);
    else if (leg?.kind === 'climbUp') {
      out.add(leg.wall.key);
      if (leg.ledgeKey !== null) out.add(leg.ledgeKey);
    } else if (leg?.kind === 'climbDown') out.add(leg.wall.key);
    if (this.crouch?.leap) {
      out.add(this.crouch.leap.wallKey);
      if (this.crouch.leap.ledgeKey !== null) out.add(this.crouch.leap.ledgeKey);
    } else if (this.crouch) out.add(this.crouch.target.key);
    if (this.flight?.target) out.add(this.flight.target.key);
    const c = this.climbing;
    if (c && c.dir < 0 && c.topKey !== null) out.add(c.topKey);
    if (c?.exit) out.add(c.exit.surface.key);
    return out;
  }

  /** Graph nodes reachable from where the cat is, with the planner's default route params (cached). */
  private reachableKeys(): ReadonlySet<string> {
    const cached = this.reachCache;
    if (cached && this.clock >= cached.at && this.clock - cached.at < REACH_CACHE_MS) return cached.keys;
    const params = this.routeParams({ x: this.x, y: this.y, pace: 'walk', allowJump: true });
    const c = this.climbing;
    let keys: Set<string>;
    if (this.modeValue === 'climb' && c) keys = this.graph.reachable(`${c.dir < 0 ? 'up' : 'down'}:${c.wall.key}`, c.wall.x, params);
    else {
      const from = this.modeValue === 'ground' || this.modeValue === 'crouch' ? { surface: this.surface, x: this.x } : this.surfacePointFor({ x: this.x, y: this.y });
      keys = this.graph.reachable(from.surface, from.x, params);
    }
    this.reachCache = { at: this.clock, keys };
    return keys;
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

  /**
   * Climbs that can start from the surface the cat stands on (up a wall beside it, stepping on
   * or leaping onto it, or down from the ledge's corner).
   */
  climbOptions(): ClimbOption[] {
    if (this.modeValue !== 'ground' || !(this.wallsEnabled() || this.edgesEnabled())) return [];
    const out: ClimbOption[] = [];
    const s = this.surface;
    for (const e of this.graph.edgesFrom(s.key)) {
      const node = this.graph.node(e.to);
      const w = node?.wall;
      if (!node || !w || this.nodeBlocked(node)) continue;
      if (w.kind === 'screenEdge') {
        // v1.2: up a screen edge to its top hold point (a goal with surfaceId = wallId, see MoveGoal).
        if (e.kind === 'mount' || e.kind === 'leap') out.push({ dir: 'up', wallId: w.key, ownerId: '', target: { x: w.x, y: w.yTop }, startX: e.fromLo, wallKind: 'screenEdge' });
        continue;
      }
      if (e.kind === 'mount' || e.kind === 'leap') {
        const up = this.pullUpOnto(w);
        if (up) out.push({ dir: 'up', wallId: w.key, ownerId: w.ownerId, target: { x: up.cornerX, y: up.top.y }, startX: e.fromLo });
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
    this.fullWorld = new WorldModel(geometry, this.cfg.size, this.cfg.allowMultiMonitor, this.worldOptions());
    return this.revalidate();
  }

  setConfig(cfg: MoverConfig): boolean {
    const rebuild = cfg.size !== this.cfg.size || cfg.allowMultiMonitor !== this.cfg.allowMultiMonitor || (cfg.narrowLedges === true) !== (this.cfg.narrowLedges === true);
    this.cfg = { ...cfg };
    this.graph.setOptions({ wallJumps: cfg.wallJumps === true, surfaceHops: cfg.surfaceHops !== false });
    this.ledges = this.ledges.filter((l) => l.surfaceKind !== null && this.kindEnabled(l.surfaceKind));
    this.walls = this.walls.filter((w) => (w.kind === 'screenEdge' ? this.edgesEnabled() : this.wallsEnabled()));
    this.graph.update(this.navWorld, this.ledges, this.walls);
    if (this.attach && !this.kindEnabled(this.attach.surfaceKind)) this.attach.disabled = true;
    if (!rebuild) return false;
    if (!cfg.allowMultiMonitor) this.homeDisplayId = this.displayId;
    this.fullWorld = new WorldModel(this.geometry, cfg.size, cfg.allowMultiMonitor, this.worldOptions());
    return this.revalidate();
  }

  private worldOptions(): { narrowLedges: boolean } {
    return { narrowLedges: this.cfg.narrowLedges === true };
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
    const walls = this.wallsEnabled();
    // Diagnostics: counts by kind and reason, and where the turned-down surfaces are.
    const received = emptySurfaceCounts();
    const rejected: Partial<Record<NavRejectReason, number>> = {};
    const rejectedLines: SurfaceDebugLine[] = [];
    const count = (reason: NavRejectReason, line: SurfaceDebugLine | null): void => {
      rejected[reason] = (rejected[reason] ?? 0) + 1;
      if (line && rejectedLines.length < MAX_REJECTED_LINES) rejectedLines.push(line);
    };
    const reject = (s: EnvSurface, reason: NavRejectReason): void => count(reason, rejectedLine(s));
    for (const s of surfaces) {
      if (!s || typeof s !== 'object') continue;
      if (!SURFACE_KINDS.includes(s.kind)) {
        count('invalid', null);
        continue;
      }
      received[s.kind]++;
      if (s.orientation === 'ledge') {
        if (s.kind === 'taskbar' && (s.edge === 'left' || s.edge === 'right')) this.noteSideTaskbar(s);
        if (this.kindEnabled(s.kind)) ledgesIn.push(s);
        else reject(s, 'disabled');
      } else if (s.orientation === 'wall') {
        if (walls) wallsIn.push(s);
        else reject(s, 'disabled');
      } else {
        count('invalid', null);
      }
    }
    const keep = this.keptIds();
    let ledges = this.navWorld.ledgeSurfaces(ledgesIn, keep.ledges, undefined, reject);
    let wallTracks = this.navWorld.wallTracks(wallsIn, keep.walls, undefined, reject);
    // v1.2: outer screen edges, derived from the world (never listed by the provider, never capped).
    if (this.edgesEnabled()) wallTracks = [...wallTracks, ...this.screenEdgeTracks()];
    if (this.offLimits.size > 0) {
      // A display with a fullscreen app in front counts as off the cat's displays. Counted, but
      // never drawn: debug lines stay off that display (they would show over the fullscreen app).
      ledges = ledges.filter((l) => {
        const off = l.displayIds.some((id) => this.isOffLimits(id));
        if (off) count('offDisplay', null);
        return !off;
      });
      wallTracks = wallTracks.filter((w) => {
        const off = this.isOffLimits(w.displayId);
        if (off) count('offDisplay', null);
        return !off;
      });
    }
    this.navIn = { received, rejected, rejectedLines };
    this.ledges = ledges;
    this.walls = wallTracks;
    this.graph.update(this.navWorld, ledges, wallTracks);
    if (this.attach && !this.kindEnabled(this.attach.surfaceKind)) this.attach.disabled = true;
  }

  /** A taskbar docked on a display's left or right edge (auto-hide too): no screen-edge wall on that side, for the session. */
  private noteSideTaskbar(s: LedgeSurface): void {
    const side = s.edge === 'left' ? 'left' : 'right';
    const at = this.fullWorld.displayAt({ x: (s.x0 + s.x1) / 2, y: s.y });
    const id = typeof s.displayId === 'string' && s.displayId.length > 0 ? s.displayId : (at?.id ?? null);
    if (id === null) return;
    const key = `${id}:${side}`;
    if (this.taskbarSides.has(key)) return;
    this.taskbarSides.add(key);
    this.edgeCache = null;
  }

  /** Screen-edge walls of the nav world (cached per world and side-taskbar set). */
  private screenEdgeTracks(): WallTrack[] {
    const c = this.edgeCache;
    if (c && c.world === this.navWorld && c.sides === this.taskbarSides.size) return c.tracks;
    // A nav world restricted to one display (roaming off) keeps every display as neighbours
    // (WorldModel.restrictTo): there is never a wall between two monitors.
    const tracks = this.navWorld.screenEdgeWalls(this.taskbarSides);
    this.edgeCache = { world: this.navWorld, sides: this.taskbarSides.size, tracks };
    return tracks;
  }

  /** Screen edges are climbable (MoverConfig.screenEdges). */
  private edgesEnabled(): boolean {
    return this.cfg.screenEdges === true;
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
    if (this.crouch?.leap) {
      walls.add(this.crouch.leap.wallKey);
      if (this.crouch.leap.ledgeKey !== null) ledges.add(this.crouch.leap.ledgeKey);
    }
    ledge(this.flight?.target);
    const leg = this.leg;
    if (leg?.kind === 'jump') ledge(leg.target);
    else if (leg?.kind === 'cross') ledge(leg.to);
    else if (leg?.kind === 'climbUp') {
      walls.add(leg.wall.key);
      if (leg.ledgeKey !== null) ledges.add(leg.ledgeKey);
    } else if (leg?.kind === 'climbDown') walls.add(leg.wall.key);
    return { ledges, walls };
  }

  // ---- goals -----------------------------------------------------------------

  setGoal(goal: MoveGoal | null): void {
    if (!goal || !Number.isFinite(goal.x) || !Number.isFinite(goal.y)) {
      this.goal = null;
      this.leg = null;
      this.destKey = null;
      return;
    }
    const prev = this.goal;
    this.goal = goal;
    const changed =
      !prev ||
      prev.allowJump !== goal.allowJump ||
      (prev.route ?? 'any') !== (goal.route ?? 'any') ||
      (prev.literal ?? false) !== (goal.literal ?? false) ||
      (prev.surfaceId ?? null) !== (goal.surfaceId ?? null) ||
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
    // A hypothetical plan must not leave edges blocked (or a destination noted) for the goal the cat is pursuing.
    const blocked = [...this.blockedEdges];
    const destKey = this.destKey;
    try {
      const leg = this.planLeg({ x: dest.x, y: dest.y, pace: 'walk', allowJump: true, route, literal: true }, this.surface);
      return leg.kind !== 'walk' || leg.reachable;
    } finally {
      this.blockedEdges.clear();
      for (const id of blocked) this.blockedEdges.add(id);
      this.destKey = destKey;
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
    return this.hopTo(now, this.x + this.facing * this.bodyWidth * 0.35, 'hop');
  }

  /**
   * Playful pounce toward `x` on the current surface: a low hop of at most
   * MOVEMENT.pounceMaxBodyLengths, facing the target. False when it cannot pounce (v1.2: also on a
   * narrow ledge).
   */
  pounce(now: number, x: number): boolean {
    if (this.modeValue !== 'ground' || !Number.isFinite(x) || this.onNarrowLedge) return false;
    const max = MOVEMENT.pounceMaxBodyLengths * this.bodyWidth;
    const dx = clamp(x - this.x, -max, max);
    if (Math.abs(dx) < this.bodyWidth * 0.25) return false;
    this.setFacing(dx > 0 ? 1 : -1, now);
    return this.hopTo(now, this.x + dx, 'pounce');
  }

  private hopTo(now: number, x: number, kind: JumpKind): boolean {
    if (this.modeValue !== 'ground') return false;
    const s = this.surface;
    const r = this.rangeOn(s, this.x);
    const landX = clamp(x, r.x0, r.x1);
    this.goal = null;
    this.leg = null;
    this.vx = 0;
    this.modeValue = 'crouch';
    this.crouch = { ...this.newCrouch(now + MOVEMENT.crouchMs, landX, s, 'hop'), clearanceDip: MOVEMENT.hopClearanceDip, snap: null, jumpKind: kind };
    return true;
  }

  /** A crouch before a take-off onto `target` (its geometry noted for the stale-plan check). */
  private newCrouch(until: number, landX: number, target: Surface, kind: CrouchKind): Crouch {
    return { until, landX, target, clearanceDip: null, leap: null, kind, snap: { y: target.y, x0: target.landX0, x1: target.landX1 }, slip: null, jumpKind: null, offsetX: null, hang: null };
  }

  /** Aborts an anticipation crouch (the jump will not happen). A bail-out or an emergency hang is never aborted. */
  cancelCrouch(): void {
    if (this.modeValue !== 'crouch') return;
    if (this.crouch?.kind === 'bail' || this.crouch?.kind === 'hang') return;
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
    this.bailing = null;
    this.scrambleUntil = -Infinity;
    this.easeRate = 0;
    this.walkIn = false;
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
    // A bail-out or an emergency hang stands on nothing: those go to the floor below like a flight.
    if (this.modeValue === 'crouch' && this.crouch?.kind !== 'bail' && this.crouch?.kind !== 'hang') {
      this.crouch = null;
      this.modeValue = 'ground';
      return false;
    }
    this.bailing = null;
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
    if (Number.isFinite(input.now)) this.clock = input.now;
    if (this.modeValue !== 'ground' || !this.attach) return false;
    this.goal = null;
    this.leg = null;
    const out = emptyStep();
    this.away = true;
    let kept: boolean;
    try {
      kept = this.ride(input, out);
    } finally {
      this.away = false;
    }
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
    if (Number.isFinite(input.now)) this.clock = input.now;
    if (this.pendingLoss) {
      // Noticed by setWorld (a display removed while clinging): the cat is falling now.
      out.supportLost = this.pendingLoss;
      out.perchLost = this.pendingLoss.fell;
      out.climbEnded = true;
      this.pendingLoss = null;
    }
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
    // v1.2: a 'scramble' slip holds the cat still while it pulls itself up the edge it caught.
    if (input.now < this.scrambleUntil) {
      this.vx = 0;
      this.applySupportY(dt);
      if (this.goal) out.goal = 'moving';
      return;
    }
    let range = this.rangeOn(s, this.x);
    let targetX = this.x;
    let pace: Pace = 'walk';
    let stepOffDir = 0;
    if (this.goal) {
      pace = this.goal.pace;
      if (this.backoffReplan && !this.inBackoff(input.now)) {
        // The stale-plan backoff is over: plan afresh (the old plan may be stale too).
        this.backoffReplan = false;
        this.leg = null;
      }
      if (!this.goal.allowJump) {
        // A goal pinned to another surface (v1.2 surfaceId) cannot be reached without leaving this one.
        const pin = this.goal.surfaceId;
        const onPin = pin === undefined || pin === s.key;
        const x = onPin ? clamp(this.goal.x, range.x0, range.x1) : clamp(this.x, range.x0, range.x1);
        this.leg = { kind: 'walk', x, reachable: onPin && Math.abs(x - this.goal.x) <= this.arriveRadius() };
      } else if (!this.leg) {
        this.leg = this.planLeg(this.goal, s);
      }
      if (this.goal.allowJump && this.goal.surfaceId === s.key && this.leg.kind === 'walk') {
        // v1.2 (ADR 0003 §7.3, T6): a goal pinned to this surface follows its current range (a strip that shrank).
        this.leg = { kind: 'walk', x: clamp(clamp(this.goal.x, s.x0, s.x1), range.x0, range.x1), reachable: true };
      }
      const leg = this.leg;
      if (leg.kind !== 'walk' && leg.kind !== 'cross' && this.inBackoff(input.now)) {
        // v1.2 (ADR 0003 §6.8): after repeated stale-plan cancels the goal is reported unreachable
        // for a while, so a window dragged around cannot loop the cat through crouch and cancel.
        this.vx = approach(this.vx, 0, MOVEMENT.brakeDip * this.scale * dt);
        this.x = clamp(this.x + this.vx * dt, range.x0, range.x1);
        this.applySupportY(dt);
        out.goal = 'unreachable';
        return;
      }
      switch (leg.kind) {
        case 'walk':
          targetX = leg.x;
          break;
        case 'hang':
          targetX = clamp(leg.x, range.x0, range.x1);
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
          // Walk out to the corner (on a tab strip it may lie on the open edge beside the stand range).
          targetX = s.kind === 'ledge' ? clamp(leg.cornerX, s.landX0, s.landX1) : leg.cornerX;
          range = { x0: Math.min(range.x0, targetX), x1: Math.max(range.x1, targetX) };
          break;
        case 'drop':
          // Step off past the stand range's end, or past where the cat is when it stands beyond
          // that end (a tab strip's window top beside the strip, walking in): never stall there.
          stepOffDir = leg.dir;
          targetX = leg.dir > 0 ? Math.max(this.x, s.x1) + this.bodyWidth : Math.min(this.x, s.x0) - this.bodyWidth;
          break;
      }
    } else if (this.walkIn) {
      // Set down on the open edge beside a tab strip (a pull-up at the window's corner): it walks onto the strip.
      if (s.kind === 'ledge' && (this.x < s.x0 || this.x > s.x1)) targetX = clamp(this.x, s.x0, s.x1);
      else this.walkIn = false;
    }

    const scale = this.scale;
    // v1.2 narrow ledges: walks slower, never runs.
    const vmax = this.onNarrowLedge ? Math.min(this.paceSpeedPx(pace), MOVEMENT.narrowWalkFactor * this.paceSpeedPx('walk')) : this.paceSpeedPx(pace);
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
    let blocked = false;
    if (nx > range.x1 || nx < range.x0) {
      const dir: 1 | -1 = nx > range.x1 ? 1 : -1;
      if (stepOffDir === dir) {
        // From the end of where it may walk (no snap back to the stand range from beside it).
        this.x = dir > 0 ? range.x1 : range.x0;
        const vx = dir * Math.max(Math.abs(this.vx), this.paceSpeedPx('walk') * 0.8);
        this.startFlight(vx, 0, input.now, { thrown: false, intentional: true, ignoreKey: this.attach?.surfaceId ?? null });
        // v1.2: a deliberate step off a ledge end is a jump down for the render hint.
        if (this.flight) this.flight.kind = 'down';
        out.steppedOff = true;
        out.goal = 'moving';
        return;
      }
      nx = clamp(nx, range.x0, range.x1);
      this.vx = 0;
      blocked = true;
    }
    this.x = nx;
    this.applySupportY(dt);
    this.updateFacing(this.vx, input.now);

    if (!this.goal || !this.leg) return;
    const leg = this.leg;
    const settled = Math.abs(this.vx) < 1;
    // v1.2 (ADR 0003 §6.8, B14): the take-off point went out of the walk range on the way (a window came to cover
    // that part): a plan it can never finish, so it says so instead of 'moving' at the end of what is left.
    const standX = leg.kind === 'jump' ? leg.takeoffX : leg.kind === 'climbUp' ? leg.standX : null;
    if (blocked && standX !== null && Math.abs(this.x - standX) > 1) {
      out.goal = 'unreachable';
      return;
    }
    switch (leg.kind) {
      case 'jump':
        if (Math.abs(this.x - leg.takeoffX) <= 1 && settled) {
          this.vx = 0;
          if (Math.abs(leg.landX - this.x) > 2) this.setFacing(leg.landX > this.x ? 1 : -1, input.now);
          this.modeValue = 'crouch';
          this.crouch = this.newCrouch(input.now + MOVEMENT.crouchMs, leg.landX, leg.target, 'jump');
          out.crouchStarted = true;
        }
        out.goal = 'moving';
        return;
      case 'hang':
        if (Math.abs(this.x - clamp(leg.x, range.x0, range.x1)) <= 1 && settled) this.startHang(leg.dir, input.now);
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
        // v1.2 (B14): the top or strip now ends short of the corner: as with a take-off cut off above.
        else if (Math.abs(this.x - targetX) <= 1 && settled && Math.abs(leg.cornerX - targetX) > 1) {
          out.goal = 'unreachable';
          return;
        }
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
    if (this.crouch?.kind === 'hang') {
      this.stepHang(this.crouch, input, out);
      return;
    }
    if (this.attach && !this.ride(input, out)) {
      // A support that vanished under a bail-out crouch: the bail-out goes on from where it is.
      if (this.crouch?.kind === 'bail' && this.modeValue === 'crouch') return;
      this.crouch = null;
      if (this.modeValue === 'crouch') this.modeValue = 'ground';
      return;
    }
    const c = this.crouch;
    if (!c) {
      this.modeValue = 'ground';
      return;
    }
    if (c.kind !== 'bail' || this.attach) this.applySupportY(Math.max(0, input.dtMs) / 1000);
    if (input.now < c.until) return;
    this.crouch = null;
    if (c.kind === 'bail') {
      this.takeOffBailOut(input, out);
      return;
    }
    if (c.leap) {
      this.takeOffLeap(c.leap, c.slip, input, out);
      return;
    }
    // A pounce on its own surface rode along with it: the landing keeps its offset from the cat.
    const want = c.offsetX !== null && c.target.key === this.surface.key ? this.x + c.offsetX : c.landX;
    const target = this.revalidateTarget(c.target, want);
    const stale = !target || this.offLimitsAt(target, want) || this.staleTarget(c, target, input);
    if (stale) {
      this.modeValue = 'ground';
      this.leg = null;
      // v1.2: the take-off is cancelled because its target vanished, moved or was covered (stale plan).
      if (c.kind !== 'hop') this.cancelPlan(input.now, out);
      return;
    }
    let landX = clamp(want, target.x0, target.x1);
    const scale = this.scale;
    const from = { x: this.x, y: this.y };
    // v1.2 deliberate slip ('miss'): aim just short of the target's near edge when coming from
    // beside it, so the cat slides off that edge to the support below.
    let slip = c.kind === 'jump' && target.key !== this.surface.key ? c.slip : null;
    if (slip === 'miss' && !this.missAllowedBelow(target, landX)) slip = 'scramble';
    if (slip === 'miss' && (from.x < target.landX0 || from.x > target.landX1)) {
      const near = from.x < target.landX0 ? target.landX0 : target.landX1;
      landX = near + (from.x < near ? 1 : -1) * this.bodyWidth * 0.15;
    }
    const to = { x: landX, y: this.navWorld.yAt(target, clamp(landX, target.landX0, target.landX1)) };
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
    const kind = c.jumpKind ?? classifyJump(to.x - from.x, to.y - from.y, this.bodyWidth, this.bodyHeight, target.key === this.surface.key);
    this.takeOffPlanned(plan, target, kind, slip, input, out);
  }

  /** Starts a planned ballistic flight onto `target` along `plan` (jumps, pounces, wall jumps, bail-outs). */
  private takeOffPlanned(plan: JumpPlan, target: Surface, kind: JumpKind | null, slip: SlipKind | null, input: MoverInput, out: MoverStep): void {
    const ignore = this.attach?.surfaceId ?? null;
    this.attach = null;
    this.climbing = null;
    this.easeRate = 0;
    this.walkIn = false;
    this.modeValue = 'air';
    this.flight = {
      t0: input.now,
      lastT: input.now,
      x0: plan.from.x,
      y0: plan.from.y,
      vx: plan.vx,
      vy0: plan.vy0,
      g: plan.g,
      plan,
      target,
      plannedKey: target.key,
      thrown: false,
      intentional: true,
      ignoreKey: target.key === ignore ? null : ignore,
      peakY: plan.apexY,
      scale: this.scale,
      startedAt: input.now,
      kind,
      slip,
      slipped: false,
    };
    this.x = plan.from.x;
    this.y = plan.from.y;
    this.vx = plan.vx;
    this.vy = plan.vy0;
    this.backoffs = 0;
    out.tookOff = true;
    out.goal = 'moving';
  }

  /**
   * v1.2 stale plan (ADR 0003 §6.8, with MoverConfig.bailOut): the take-off target moved more than
   * half a body length since the crouch began (both ends, or its height), or is served covered
   * (confidence below MOVEMENT.planCoveredConfidence). Pounces always check (ADR 0003 §6.5).
   */
  private staleTarget(c: Crouch, target: Surface, input: MoverInput): boolean {
    if (c.kind !== 'pounce' && this.cfg.bailOut !== true) return false;
    const snap = c.snap;
    if (!snap) return false;
    const tol = MOVEMENT.planStaleBodyLengths * this.bodyWidth;
    if (Math.abs(target.y - snap.y) > tol) return true;
    if (Math.abs(target.landX0 - snap.x0) > tol && Math.abs(target.landX1 - snap.x1) > tol) return true;
    if (target.kind === 'ledge') {
      const live = this.liveLedge(input, target.key);
      if (live && Number.isFinite(live.confidence) && live.confidence < MOVEMENT.planCoveredConfidence) return true;
    }
    return false;
  }

  /** Reports a stale-plan cancel and, after planCancelBackoffCount of them within the window, starts the backoff. */
  private cancelPlan(now: number, out: MoverStep): void {
    out.planCancelled = true;
    this.cancels = this.cancels.filter((t) => now - t < MOVEMENT.planCancelBackoffWindowMs);
    this.cancels.push(now);
    if (this.cfg.bailOut !== true || this.cancels.length < MOVEMENT.planCancelBackoffCount) return;
    const ms = Math.min(MOVEMENT.planCancelBackoffMaxMs, MOVEMENT.planCancelBackoffMinMs + 1000 * this.backoffs);
    this.backoffUntil = now + ms;
    this.backoffs++;
    this.backoffReplan = true;
    this.cancels = [];
    this.leg = null;
  }

  /** The stale-plan backoff is running (MoverConfig.bailOut). */
  private inBackoff(now: number): boolean {
    return this.cfg.bailOut === true && now < this.backoffUntil;
  }

  /**
   * A deliberate 'miss' slides off to the support below the landing point: allowed only where that
   * drop is within the safe jump-down height (otherwise it is a scramble, ADR 0003 §6.6).
   */
  private missAllowedBelow(target: Surface, x: number): boolean {
    const others = this.ledges.filter((l) => l.key !== target.key);
    const below = this.navWorld.surfaceBelow(x, target.y + 1, others);
    if (!below) return false;
    return (below.y - target.y) / this.scale <= leaveLimits(this.cfg).safeDip;
  }

  /** v1.2 emergency leave: lower from the ledge end (hang), then let go. */
  private startHang(dir: 1 | -1, now: number): void {
    this.vx = 0;
    this.leg = null;
    this.modeValue = 'crouch';
    this.crouch = { ...this.newCrouch(now + MOVEMENT.emergencyHangMs, this.x, this.surface, 'hang'), snap: null, hang: { x: this.x, y: this.y, dir } };
    this.setFacing(dir === 1 ? -1 : 1, now);
  }

  private stepHang(c: Crouch, input: MoverInput, out: MoverStep): void {
    const h = c.hang;
    if (!h) {
      this.crouch = null;
      this.modeValue = 'ground';
      return;
    }
    const k = clamp((input.now - (c.until - MOVEMENT.emergencyHangMs)) / MOVEMENT.emergencyHangMs, 0, 1);
    const e = k * k * (3 - 2 * k);
    const drop = MOVEMENT.emergencyHangBodyHeights * this.bodyHeight;
    const p = this.navWorld.clampInside({ x: h.x + h.dir * this.bodyWidth * 0.3 * e, y: h.y + drop * e });
    this.x = p.x;
    this.y = p.y;
    if (input.now < c.until) return;
    this.crouch = null;
    const from = this.attach?.surfaceId ?? (this.surface.kind === 'ledge' ? this.surface.key : null);
    this.startFlight(0, 0, input.now, { thrown: false, intentional: true, ignoreKey: from });
    out.steppedOff = true;
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
      if (f.slip === 'miss') {
        // v1.2 deliberate slip: the paws do not hold; it slides off to the support below.
        this.x = end.x;
        this.y = end.y;
        this.flight = { ...f, t0: now, lastT: now, x0: end.x, y0: end.y, vx: end.vx * 0.3, vy0: Math.max(0, end.vy), plan: null, target: null, ignoreKey: f.target.key, slip: null, slipped: true };
        out.slipped = 'miss';
        return;
      }
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
    // Not served any more: gone, unless it is a taskbar sliding away or a kind the user switched off.
    if (!live) {
      const reason: SupportLossReason = a.surfaceKind === 'taskbar' ? 'retracted' : a.disabled ? 'disabled' : 'gone';
      // v1.2: a vanished window top (closed, minimized, maximized) is left by a controlled bail-out.
      if (reason === 'gone' && this.bailOutOn(a)) return this.beginBailOut('gone', input, true);
      return this.loseSupport(reason, input, out);
    }
    // The ledge's height is the window's top edge; how far it moved sideways only shows in
    // the ends of its open span (see spanShift).
    const shift = spanShift([a.x0, a.x1], [live.x0, live.x1], (x) => this.atWorkAreaSide(x, live.y), live.vx, input.dtMs, 2 * this.scale, live.y !== a.y);
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
      this.walkIn = false;
      this.surface = fp.surface;
      this.x = clamp(this.x, fp.surface.x0, fp.surface.x1);
      out.lowered = true;
      out.supportLost = { reason: 'retracted', surfaceId: a.surfaceId, surfaceKind: a.surfaceKind, fell: false };
      this.leg = null;
      return true;
    }
    const d = this.navWorld.displayAt({ x: this.x, y: live.y });
    if (!d || live.y - this.bodyHeight * 0.8 < d.workAreaPx.y) return this.bailOutOn(a) ? this.beginBailOut('headroom', input, true) : this.loseSupport('headroom', input, out);
    const tol = this.bodyWidth * 0.125;
    // A tab strip's window top (`land`) holds the cat too: it walks onto the strip from there.
    const land = live.land && Number.isFinite(live.land.x0) && Number.isFinite(live.land.x1) ? live.land : null;
    const onSegment = this.x >= Math.min(live.x0, land?.x0 ?? live.x0) - tol && this.x <= Math.max(live.x1, land?.x1 ?? live.x1) + tol;
    const listed = this.ledges.find((l) => l.key === a.surfaceId) ?? null;
    // The listed ledge must be under its paws too: a tab strip that shrank away from the cat
    // (tabs closed) or a list naming another part of a cut edge leaves it on the bare edge.
    // While the window moves, the list may be a tick behind the live geometry.
    const underPaws = listed !== null && this.x >= listed.landX0 - tol && this.x <= listed.landX1 + tol;
    const moving = moved || (input.movingWindowIds ?? NO_MOVING).has(a.ownerId);
    if (listed && (underPaws || moving) && onSegment && !a.disabled) {
      a.missingSince = null;
      if (this.crouch?.kind === 'bail') {
        // The list caught up before the bail-out took off (a lagging list, not a cover): stay.
        this.crouch = null;
        this.modeValue = 'ground';
        this.bailing = null;
      }
    } else {
      a.missingSince ??= input.now;
      const grace = moving ? MOVEMENT.perchMovingGraceMs : MOVEMENT.perchGraceMs;
      // Switched off by the user: it leaves at once (no grace).
      if (a.disabled) return this.loseSupport('disabled', input, out);
      if (this.bailOutOn(a)) {
        // v1.2 (ADR 0003 §3): the bail-out crouch starts so that the take-off comes when the grace
        // ends (MOVEMENT.bailOutCrouchMs before it), well within bailOutMaxDelayMs of the cover.
        if (input.now - a.missingSince > grace - MOVEMENT.bailOutCrouchMs && this.crouch?.kind !== 'bail') this.beginBailOut('occluded', input, false);
      } else if (input.now - a.missingSince > grace) {
        return this.loseSupport('occluded', input, out);
      }
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
        // Where it is (setGrounded clamps it like surfaceBelow, except on a tab strip's window top: it walks in).
        this.setGrounded(below.surface, p.x, live, true);
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

  // ---- v1.2 controlled bail-out (ADR 0003 §3) ---------------------------------------

  /** A lost window top or tab strip is left by a controlled bail-out (MoverConfig.bailOut; never while away, never a taskbar). */
  private bailOutOn(a: Attachment): boolean {
    return this.cfg.bailOut === true && !this.away && a.surfaceKind !== 'taskbar';
  }

  /**
   * The support is covered, gone or out of headroom: crouch for MOVEMENT.bailOutCrouchMs (a ledge
   * still served keeps being ridden meanwhile; one that comes back cancels the bail-out), then take
   * off (takeOffBailOut). `drop`: the support is no longer there to ride (returns false, like a loss).
   */
  private beginBailOut(reason: SupportLossReason, input: MoverInput, drop: boolean): boolean {
    const a = this.attach as Attachment;
    const prev = this.bailing;
    this.bailing =
      prev && prev.surfaceId === a.surfaceId
        ? { ...prev, reason: reason === 'occluded' ? prev.reason : reason }
        : { reason, surfaceId: a.surfaceId, surfaceKind: a.surfaceKind, ownerId: a.ownerId, since: a.missingSince ?? input.now };
    if (this.crouch?.kind !== 'bail') {
      this.crouch = { ...this.newCrouch(input.now + MOVEMENT.bailOutCrouchMs, this.x, this.surface, 'bail'), snap: null };
      this.modeValue = 'crouch';
      this.vx = 0;
      this.leg = null;
    }
    if (!drop) return true;
    this.attach = null;
    this.easeRate = 0;
    this.walkIn = false;
    return false;
  }

  /** End of the bail-out crouch: the first way off that applies (ADR 0003 §3), reported as bailedOut. */
  private takeOffBailOut(input: MoverInput, out: MoverStep): void {
    const b = this.bailing ?? {
      reason: 'gone' as const,
      surfaceId: this.attach?.surfaceId ?? this.surface.key,
      surfaceKind: (this.attach?.surfaceKind ?? this.surface.surfaceKind ?? 'windowTop') as SupportSurfaceKind,
      ownerId: this.attach?.ownerId ?? '',
      since: input.now,
    };
    this.bailing = b;
    const plan = this.planBailOut(input, b);
    this.attach = null;
    this.easeRate = 0;
    out.bailedOut = true;
    out.supportLost = { reason: b.reason, surfaceId: b.surfaceId, surfaceKind: b.surfaceKind, fell: plan.kind === 'emergency' };
    this.lastBailOut = plan.kind;
    switch (plan.kind) {
      case 'hop':
      case 'jump': {
        const kind = classifyJump(plan.plan.to.x - plan.plan.from.x, plan.plan.to.y - plan.plan.from.y, this.bodyWidth, this.bodyHeight, plan.target.key === b.surfaceId);
        this.takeOffPlanned(plan.plan, plan.target, kind, null, input, out);
        return;
      }
      case 'wall':
        this.beginClimb(plan.wall, 'leap', 1, plan.plan.durationMs, { x: plan.wall.x, y: plan.plan.to.y }, input.now, null, null);
        this.finishLeapSetup(plan.plan, true, null);
        out.tookOff = true;
        out.climbStarted = true;
        out.goal = 'moving';
        return;
      case 'emergency':
        // Nothing to hop, jump or leap to: a controlled drop from where it is (it may land hard).
        this.startFlight(0, 0, input.now, { thrown: false, intentional: true, ignoreKey: b.surfaceId });
        this.bailing = b;
        out.goal = 'moving';
        return;
    }
  }

  /**
   * The bail-out order of ADR 0003 §3, from where the cat is (it never walks across the covered
   * part): 1. a single hop onto the still-visible stretch of the same edge; 2. one jump onto a
   * visible support within the jump-down maximum, the softest landing first, then the nearest;
   * 3. a leap onto a visible wall within reach (then it climbs down); 4. the emergency drop.
   */
  private planBailOut(
    input: MoverInput,
    b: BailOut,
  ): { kind: 'hop' | 'jump'; plan: JumpPlan; target: Surface } | { kind: 'wall'; plan: JumpPlan; wall: WallTrack } | { kind: 'emergency' } {
    const from = this.navWorld.clampInside({ x: this.x, y: this.y });
    const scale = this.navWorld.scaleAt(from);
    const maxAcross = MOVEMENT.maxJumpAcrossDip * scale;
    const maxUp = MOVEMENT.maxJumpUpDip * scale;
    const limits = leaveLimits(this.cfg);
    if (b.reason === 'occluded') {
      const live = this.liveLedge(input, b.surfaceId);
      // Only a listed stretch is visible: a covered window's bare edge is served but never listed (provider).
      const s = live ? (this.ledges.find((l) => l.key === b.surfaceId) ?? null) : null;
      if (s && s.phase !== 'leaving') {
        const lx = clamp(from.x, s.x0, s.x1);
        const plan = Math.abs(lx - from.x) <= maxAcross ? this.solveChecked(from, { x: lx, y: s.y }, null) : null;
        if (plan) return { kind: 'hop', plan, target: s };
      }
    }
    const rank: Record<LandingImpact, number> = { soft: 0, medium: 1, hard: 2 };
    const candidates: Array<{ t: Surface; x: number; y: number; score: number }> = [];
    const supports: Surface[] = [...this.navWorld.floors, ...this.ledges.filter((l) => l.key !== b.surfaceId && l.phase !== 'leaving' && (b.reason !== 'gone' || l.ownerId !== b.ownerId))];
    for (const t of supports) {
      const lx = clamp(from.x, t.x0, t.x1);
      if (this.offLimitsAt(t, lx)) continue;
      const ty = this.navWorld.yAt(t, lx);
      const dy = ty - from.y;
      if (Math.abs(lx - from.x) > maxAcross || -dy > maxUp || dy / scale > limits.maxDip) continue;
      const impact = dy > 0 ? dropImpact(dy / scale) : 'soft';
      candidates.push({ t, x: lx, y: ty, score: rank[impact] * 1e7 + Math.hypot(lx - from.x, dy) });
    }
    candidates.sort((p, q) => p.score - q.score);
    for (const c of candidates) {
      const plan = this.solveChecked(from, { x: c.x, y: c.y }, null);
      if (plan) return { kind: 'jump', plan, target: c.t };
    }
    for (const w of this.walls) {
      // A screen edge is the behaviour's to use (gated on the bands, ADR 0003 §6.1(b)), never a way out here.
      if (w.kind === 'screenEdge') continue;
      if (b.reason === 'gone' && w.ownerId !== '' && w.ownerId === b.ownerId) continue;
      const outward = w.side === 'left' ? -1 : 1;
      if ((from.x - w.x) * outward < -1 || Math.abs(w.x - from.x) > maxAcross) continue;
      const grip = clamp(from.y, w.yTop, w.yBottom);
      if (from.y - grip > MOVEMENT.wallLeapUpDip * scale || (grip - from.y) / scale > limits.maxDip) continue;
      const plan = this.solveLeapAny(from, { x: w.x, y: grip });
      if (plan) return { kind: 'wall', plan, wall: w };
    }
    return { kind: 'emergency' };
  }

  /** A leap's arc onto a wall at any height within reach (bail-outs: also level with or below the feet). */
  private solveLeapAny(from: Point, to: Point): JumpPlan | null {
    const scale = this.navWorld.scaleAt(from);
    const g = MOVEMENT.gravityDip * scale;
    const base = clearanceFor(to.x - from.x, MOVEMENT.wallLeapClearanceDip * scale, MOVEMENT.jumpClearancePerDx);
    const c0 = descentClearancePx(base, to.y - from.y, scale, jumpDownLimits(this.cfg) !== null);
    for (const c of [c0, c0 * 0.5]) {
      const plan = solveJump(from, to, g, c);
      if (sampleArc(plan, 16).every((p) => this.navWorld.contains(p, 2))) return plan;
    }
    return null;
  }

  /** Puts the leap arc on the climb begun with phase 'leap'. */
  private finishLeapSetup(plan: JumpPlan, down: boolean, slip: SlipKind | null): void {
    const c = this.climbing as Climb;
    c.durationMs = plan.durationMs;
    c.leap = { plan, peakY: plan.from.y, scale: this.navWorld.scaleAt(plan.from), down, slip };
    this.vx = plan.vx;
    this.vy = plan.vy0;
  }

  /**
   * v1.2: the wall the cat clings to is gone or covered (MoverConfig.bailOut): it pushes off onto a
   * visible support within reach (bailOutKind 'jump'), else it lets go as an emergency drop.
   */
  private bailOffWall(input: MoverInput, out: MoverStep, reason: SupportLossReason): void {
    const c = this.climbing as Climb;
    const w = c.wall;
    const from = this.navWorld.clampInside({ x: this.x, y: this.y });
    const scale = this.navWorld.scaleAt(from);
    const limits = leaveLimits(this.cfg);
    const surfaceKind: SupportSurfaceKind = w.kind === 'screenEdge' ? SCREEN_EDGE_KIND : 'windowSide';
    const rank: Record<LandingImpact, number> = { soft: 0, medium: 1, hard: 2 };
    let best: { t: Surface; plan: JumpPlan; score: number } | null = null;
    for (const t of [...this.navWorld.floors, ...this.ledges]) {
      if (t.phase === 'leaving' || (reason === 'gone' && w.ownerId !== '' && t.ownerId === w.ownerId)) continue;
      const land = this.graph.wallJumpLanding(this.navWorld, w, from.y, t);
      if (!land || this.offLimitsAt(t, land.x)) continue;
      const dropDip = (land.y - from.y) / scale;
      if (dropDip > limits.maxDip) continue;
      const score = rank[dropDip > 0 ? dropImpact(dropDip) : 'soft'] * 1e7 + Math.hypot(land.x - from.x, land.y - from.y);
      if (best && score >= best.score) continue;
      const plan = this.solveChecked(from, land, null);
      if (plan) best = { t, plan, score };
    }
    out.bailedOut = true;
    out.climbEnded = true;
    this.climbStats.letGo++;
    this.bailing = { reason, surfaceId: w.key, surfaceKind, ownerId: w.ownerId, since: input.now };
    if (best) {
      this.lastBailOut = 'jump';
      out.supportLost = { reason, surfaceId: w.key, surfaceKind, fell: false };
      this.climbing = null;
      this.takeOffPlanned(best.plan, best.t, 'wallJump', null, input, out);
      return;
    }
    this.lastBailOut = 'emergency';
    const outward = w.side === 'left' ? -1 : 1;
    this.climbing = null;
    this.x = from.x;
    this.y = from.y;
    this.startFlight(outward * this.paceSpeedPx('slow'), 0, input.now, { thrown: false, intentional: true, ignoreKey: null });
    out.supportLost = { reason, surfaceId: w.key, surfaceKind, fell: true };
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
      // Lifted by a tab strip's window top beside the strip: it stays where it is and walks in (like setGrounded).
      this.x = setDownX(l, this.x);
      this.walkIn = l.landWide === true && (this.x < l.x0 || this.x > l.x1);
      this.easeRate = Math.max(MOVEMENT.liftDip * this.scale, 1.5 * Math.abs(l.vy));
      this.leg = null;
      out.lifted = { surfaceId: l.key, surfaceKind: l.surfaceKind ?? 'taskbar' };
      return;
    }
  }

  /** Walks across onto a touching surface at the same height. */
  private crossTo(to: Surface, input: MoverInput): void {
    this.leg = null;
    this.walkIn = false;
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
    if (!w || (w.kind !== 'screenEdge' && !this.liveWall(input, w.key))) {
      this.leg = null;
      this.blockedEdges.add(`${leg.gripY !== null ? 'leap' : 'mount'}:${this.surface.key}>up:${leg.wall.key}`);
      return;
    }
    const holdY = leg.holdY ?? null;
    const jumpTo = leg.jumpTo ?? null;
    if (leg.gripY !== null) {
      // Leap and cling: the anticipation crouch facing the wall, as before any jump (stepCrouch takes off).
      this.vx = 0;
      this.setFacing(w.facing, input.now);
      this.modeValue = 'crouch';
      this.crouch = { ...this.newCrouch(input.now + MOVEMENT.crouchMs, w.x, this.surface, 'leap'), snap: null, leap: { wallKey: w.key, ledgeKey: leg.ledgeKey, cornerX: leg.cornerX, holdY, jumpTo } };
      out.crouchStarted = true;
      return;
    }
    const startY = clamp(Math.min(this.y, w.yBottom), w.yTop, w.yBottom);
    this.beginClimb(w, 'mount', -1, MOVEMENT.mountMs, { x: w.x, y: startY }, input.now, leg.ledgeKey, leg.cornerX);
    const c = this.climbing as Climb;
    c.holdY = holdY;
    c.jumpTo = jumpTo;
    this.climbStats.mounts++;
    out.climbStarted = true;
  }

  /** The current geometry of a wall: a screen edge from the world, a window side from the provider's live surface. */
  private liveTrack(input: MoverInput, w: WallTrack): { track: WallTrack | null; live: WallSurface | null } {
    if (w.kind === 'screenEdge') return { track: this.edgesEnabled() ? (this.screenEdgeTracks().find((t) => t.key === w.key) ?? null) : null, live: null };
    const live = this.liveWall(input, w.key);
    return { track: live ? this.navWorld.wallTrack(live) : null, live };
  }

  /**
   * End of the crouch before a leap: a ballistic jump (the same gravity as every jump) from
   * where the cat stands to the grip on the live wall line. The grip is re-chosen from the
   * live side; a side that is gone, out of reach or whose arc would leave the screen makes
   * the cat stay put and look for another way (v1.2: reported as planCancelled).
   */
  private takeOffLeap(leap: NonNullable<Crouch['leap']>, slip: SlipKind | null, input: MoverInput, out: MoverStep): void {
    const screenEdge = leap.wallKey.startsWith(`${SCREEN_EDGE_KIND}:`);
    const live = !screenEdge && this.wallsEnabled() ? this.liveWall(input, leap.wallKey) : null;
    const track: WallTrack | null = screenEdge
      ? this.edgesEnabled()
        ? (this.screenEdgeTracks().find((t) => t.key === leap.wallKey) ?? null)
        : null
      : live
        ? this.navWorld.wallTrack(live)
        : null;
    const scale = this.scale;
    const from = { x: this.x, y: this.y };
    this.modeValue = 'ground';
    if (track && Math.abs(track.standX - from.x) > this.bodyWidth) {
      // The window moved during the crouch: walk to its new side first.
      this.leg = null;
      this.cancelPlan(input.now, out);
      return;
    }
    const grip = track ? this.graph.leapGripY(track, from.y, scale) : null;
    const plan = track && grip !== null ? this.solveLeap(from, { x: track.x, y: grip }) : null;
    if (!track || grip === null || !plan) {
      this.leg = null;
      this.blockedEdges.add(`leap:${this.surface.key}>up:${leap.wallKey}`);
      if (!track) this.cancelPlan(input.now, out);
      return;
    }
    this.beginClimb(track, 'leap', -1, plan.durationMs, { x: track.x, y: plan.to.y }, input.now, leap.ledgeKey, leap.cornerX);
    const c = this.climbing as Climb;
    // A ballistic arc takes its own time, whatever the movement speed setting.
    c.durationMs = plan.durationMs;
    c.leap = { plan, peakY: from.y, scale, slip };
    c.holdY = leap.holdY;
    c.jumpTo = leap.jumpTo;
    this.vx = plan.vx;
    this.vy = plan.vy0;
    this.climbStats.leaps++;
    this.backoffs = 0;
    out.tookOff = true;
    out.climbStarted = true;
    out.goal = 'moving';
  }

  /** The leap's arc onto a side: it peaks just above the grip (caught near the top of the jump) and stays on screen. */
  private solveLeap(from: Point, to: Point): JumpPlan | null {
    const scale = this.navWorld.scaleAt(from);
    if (from.y - to.y > MOVEMENT.wallLeapUpDip * scale + 0.5 || Math.abs(to.x - from.x) > MOVEMENT.maxJumpAcrossDip * scale) return null;
    const g = MOVEMENT.gravityDip * scale;
    const base = clearanceFor(to.x - from.x, MOVEMENT.wallLeapClearanceDip * scale, MOVEMENT.jumpClearancePerDx);
    for (const c of [base, base * 0.5]) {
      const plan = solveJump(from, to, g, c);
      if (sampleArc(plan, 16).every((p) => this.navWorld.contains(p, 2))) return plan;
    }
    return null;
  }

  /**
   * In the air toward the side: the arc planned at take-off, carried along with the window when
   * it moves (the offset grows with the flight's progress, so the path stays continuous and ends
   * on the moved grip). A grip carried out of reach, or a window jumping away at once, makes the
   * cat miss: it falls on from where it is. v1.2: a bail-out leap (`down`) may catch the side
   * level with or below its feet; an armed slip scrambles at the catch or misses it.
   */
  private stepLeap(c: Climb, track: WallTrack, dy: number, input: MoverInput, out: MoverStep): void {
    const leap = c.leap;
    if (!leap) {
      this.missLeap(input, out);
      return;
    }
    const plan = leap.plan;
    c.wall = track;
    const grip = { x: track.x, y: clamp(c.to.y + dy, track.yTop, track.yBottom) };
    const jumped = Math.hypot(grip.x - c.to.x, grip.y - c.to.y) > this.bodyWidth;
    c.to = grip;
    const tooHigh = plan.from.y - grip.y > MOVEMENT.wallLeapUpDip * leap.scale + 1;
    const notAbove = leap.down === true ? (grip.y - plan.from.y) / leap.scale > leaveLimits(this.cfg).maxDip + 1 : grip.y >= plan.from.y;
    if (jumped || tooHigh || notAbove || Math.abs(grip.x - plan.from.x) > MOVEMENT.maxJumpAcrossDip * leap.scale) {
      this.missLeap(input, out);
      return;
    }
    this.facing = track.facing;
    const elapsed = input.now - c.t0;
    if (elapsed < plan.durationMs) {
      const k = Math.max(0, elapsed) / plan.durationMs;
      const ox = grip.x - plan.to.x;
      const oy = grip.y - plan.to.y;
      const p = jumpAt(plan, elapsed);
      this.x = p.x + ox * k;
      this.y = p.y + oy * k;
      this.vx = p.vx + ox / (plan.durationMs / 1000);
      this.vy = p.vy + oy / (plan.durationMs / 1000);
      leap.peakY = Math.min(leap.peakY, this.y);
      return;
    }
    let slip = leap.slip ?? null;
    if (slip === 'miss' && !this.missAllowedFromWall(track, grip.y)) slip = 'scramble';
    if (slip === 'miss') {
      // v1.2 deliberate slip: the paws slide off the side; it drops back to the support below.
      this.missLeap(input, out);
      if (this.flight) this.flight.slipped = true;
      out.slipped = 'miss';
      return;
    }
    // Caught the side: the climb proper starts at the grip.
    this.x = grip.x;
    this.y = grip.y;
    this.vx = 0;
    this.vy = 0;
    c.phase = 'climb';
    c.t0 = input.now;
    c.leap = null;
    if (leap.down === true) this.bailing = null;
    if (slip === 'scramble') {
      c.scrambleUntil = input.now + MOVEMENT.slipScrambleMs;
      out.slipped = 'scramble';
    }
    out.clung = true;
  }

  /** Falling off a wall at anchor height y lands within the safe jump-down height (a deliberate 'miss' is allowed). */
  private missAllowedFromWall(w: WallTrack, y: number): boolean {
    const outward = w.side === 'left' ? -1 : 1;
    const below = this.navWorld.surfaceBelow(w.x + outward * this.bodyWidth * 0.3, y + 1, this.ledges);
    return below !== null && (below.y - y) / w.scale <= leaveLimits(this.cfg).safeDip;
  }

  /** Mid-leap the side vanished, stopped being climbable or went out of reach: a free fall from the current velocity. */
  private missLeap(input: MoverInput, out: MoverStep): void {
    const peakY = Math.min(this.climbing?.leap?.peakY ?? this.y, this.y);
    this.climbing = null;
    this.climbStats.letGo++;
    this.startFlight(this.vx, this.vy, input.now, { thrown: false, intentional: true, ignoreKey: null });
    if (this.flight) this.flight.peakY = peakY;
    out.climbEnded = true;
  }

  /**
   * The top the climb heads for is no longer listed: take the one the live side leads to now
   * (a tab strip that replaced the window top, or the window top back after the strip went).
   */
  private reResolveTop(c: Climb, track: WallTrack): void {
    if (c.topKey !== null && this.ledgeById(c.topKey)) return;
    const id = track.topLedgeId;
    if (id === null || id === c.topKey) return;
    const top = this.ledgeById(id);
    if (!top) return;
    c.topKey = id;
    c.cornerX = this.graph.cornerX(this.navWorld, track, top);
    this.climbStats.topReResolved++;
  }

  private startClimbDown(leg: Extract<Leg, { kind: 'climbDown' }>, input: MoverInput, out: MoverStep): void {
    const w = this.walls.find((t) => t.key === leg.wall.key);
    if (!w || (w.kind !== 'screenEdge' && !this.liveWall(input, w.key))) {
      this.leg = null;
      this.blockedEdges.add(`swing:${this.surface.key}>down:${leg.wall.key}`);
      return;
    }
    this.beginClimb(w, 'swing', 1, MOVEMENT.swingMs, { x: w.x, y: w.yTop }, input.now, this.surface.key, leg.cornerX);
    // v1.2 climbLeap: climb down to the grip, then push off.
    (this.climbing as Climb).wallJump = leg.wallJump ? { ...leg.wallJump, crouchUntil: null } : null;
    out.climbStarted = true;
  }

  private beginClimb(w: WallTrack, phase: 'leap' | 'mount' | 'swing', dir: -1 | 1, ms: number, to: Point, now: number, topKey: string | null, cornerX: number | null): void {
    this.attach = null;
    this.easeRate = 0;
    this.walkIn = false;
    this.crouch = null;
    this.leg = null;
    this.vx = 0;
    this.vy = 0;
    this.modeValue = 'climb';
    this.climbing = {
      wall: w,
      phase,
      dir,
      t0: now,
      durationMs: ms / this.cfg.movementSpeed,
      from: { x: this.x, y: this.y },
      to,
      topKey,
      cornerX,
      exit: null,
      missingSince: null,
      replan: false,
      topMissingSince: null,
      leap: null,
      holdY: null,
      hold: null,
      wallJump: null,
      jumpTo: null,
      slip: null,
      scrambleUntil: -Infinity,
    };
    this.setFacing(w.facing, now);
  }

  private stepClimb(input: MoverInput, out: MoverStep): void {
    const c = this.climbing;
    if (!c) {
      this.settleNow();
      return;
    }
    const screenEdge = c.wall.kind === 'screenEdge';
    // Switched off by the user: it lets go at once (calmly), whether or not the host still serves the wall.
    // Mid-leap it simply misses the side (it was not holding on yet).
    if (!(screenEdge ? this.edgesEnabled() : this.wallsEnabled())) {
      if (c.phase === 'leap') this.missLeap(input, out);
      else this.letGoOfWall(input, out, 'disabled');
      return;
    }
    const { track, live } = this.liveTrack(input, c.wall);
    if (!track) {
      // Gone (closed, minimized): a sudden loss. Still there but no longer climbable (moved
      // against the screen edge, cut too short): the cat simply lets go.
      if (c.phase === 'leap') this.missLeap(input, out);
      else this.releaseWall(input, out, live ? 'occluded' : 'gone');
      return;
    }
    // Ride the window: the wall line is its side; how far it moved up or down only shows in
    // the ends of the open span (a window in front covering part of the side moves nothing).
    const dx = track.x - c.wall.x;
    const column = track.side === 'left' ? track.x - 1 : track.x + 1;
    const dy = live ? spanShift([c.wall.y0, c.wall.y1], [track.y0, track.y1], (y) => this.atWorkAreaRow(y, column), live.vy, input.dtMs, 2 * track.scale, dx !== 0) : 0;
    if (c.phase === 'leap') {
      this.stepLeap(c, track, dy, input, out);
      return;
    }
    if (dx !== 0 || dy !== 0) {
      this.x += dx;
      this.y += dy;
      c.from = { x: c.from.x + dx, y: c.from.y + dy };
      c.to = { x: c.to.x + dx, y: c.to.y + dy };
      if (c.cornerX !== null) c.cornerX += dx;
      if (c.wallJump) c.wallJump = { ...c.wallJump, gripY: c.wallJump.gripY + dy };
    }
    c.wall = track;
    // Clinging, the grip must stay on the stretch of the side it can reach: a window in front
    // covering that part makes it climb back onto the open stretch (below), and let go calmly
    // when it cannot get there within the grace.
    const tol = this.bodyWidth * 0.125;
    const holds = c.phase !== 'climb' || (this.y >= track.yTop - tol && this.y <= track.yBottom + tol);
    if (holds && this.walls.some((w) => w.key === track.key)) {
      c.missingSince = null;
    } else {
      c.missingSince ??= input.now;
      const moving = (input.movingWindowIds ?? NO_MOVING).has(track.ownerId);
      const grace = dx !== 0 || dy !== 0 || moving ? MOVEMENT.perchMovingGraceMs : MOVEMENT.perchGraceMs;
      if (input.now - c.missingSince > grace) {
        this.releaseWall(input, out, 'occluded');
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
    // v1.2: a 'scramble' slip at the catch holds it still for a moment.
    if (input.now < c.scrambleUntil) {
      this.vy = 0;
      return;
    }
    if (c.hold) {
      this.vy = 0;
      this.x = track.x;
      if (!(c.replan && this.goal)) {
        if (input.now < c.hold.until) {
          if (this.goal) out.goal = 'arrived';
          return;
        }
        // The hold is over (MOVEMENT.maxWallHoldMs at most): it climbs down.
        this.endHold(c);
      }
    }
    if (c.replan && this.goal) {
      c.replan = false;
      this.replanOnWall(c, track);
    }
    this.x = track.x;
    const open = clamp(this.y, track.yTop, track.yBottom);
    if (open !== this.y) {
      // Off the open stretch (its end moved past the grip): climb onto it, never jump there.
      const up = open < this.y;
      const speed = this.climbSpeedPx(up);
      this.vy = up ? -speed : speed;
      this.y = up ? Math.max(open, this.y - speed * dt) : Math.min(open, this.y + speed * dt);
      return;
    }
    if (c.wallJump) {
      this.stepWallJump(c, track, input, out);
      return;
    }
    if (c.dir < 0) {
      // The top may change under the climbing cat (a tab strip replacing the window top).
      this.reResolveTop(c, track);
      const stopY = c.holdY !== null ? clamp(c.holdY, track.yTop, track.yBottom) : track.yTop;
      const speed = this.climbSpeedPx(true);
      this.vy = -speed;
      this.y = Math.max(stopY, this.y - speed * dt);
      if (this.y > stopY + 0.01) return;
      if (c.holdY !== null || screenEdge) {
        // v1.2: a screen edge (or a requested grip height) has no ledge to pull up onto: it holds.
        this.startHold(c, input.now);
        if (this.goal) out.goal = 'arrived';
        return;
      }
      if (c.jumpTo !== null && this.cfg.wallJumps === true) {
        // v1.2: a route over the side's top continuing with a wall jump.
        const target = this.supportByKey(c.jumpTo);
        const land = target ? this.graph.wallJumpLanding(this.navWorld, track, this.y, target) : null;
        c.jumpTo = null;
        if (target && land) {
          c.wallJump = { gripY: this.y, targetKey: target.key, landX: land.x, crouchUntil: null, slip: null };
          this.vy = 0;
          return;
        }
        c.dir = 1;
        this.climbStats.reversed++;
        return;
      }
      const top = c.topKey ? this.ledgeById(c.topKey) : null;
      // Over the top only from the top corner: a side cut short by a window in front ends below the ledge.
      const cx = top && track.y0 - top.y <= this.bodyWidth * 0.25 ? this.graph.cornerX(this.navWorld, track, top) : null;
      if (!top) {
        // Not listed right now (the provider swapping a strip for the window top, a list a tick
        // behind): it waits at the corner for the grace before giving up.
        c.topMissingSince ??= input.now;
        const moving = dx !== 0 || dy !== 0 || (input.movingWindowIds ?? NO_MOVING).has(track.ownerId);
        if (input.now - c.topMissingSince <= (moving ? MOVEMENT.perchMovingGraceMs : MOVEMENT.perchGraceMs)) {
          this.vy = 0;
          return;
        }
      }
      c.topMissingSince = null;
      if (!top || cx === null) {
        // No way over the top (the ledge or the top of the side is covered, or gone): climb back down.
        c.dir = 1;
        this.climbStats.reversed++;
        return;
      }
      c.cornerX = cx;
      c.phase = 'pullUp';
      c.t0 = input.now;
      c.durationMs = MOVEMENT.pullUpMs / this.cfg.movementSpeed;
      c.from = { x: this.x, y: this.y };
      c.to = { x: cx, y: top.y };
      this.vy = 0;
      this.pullUpSlip(c, track, top, input, out);
      return;
    }
    const speed = this.climbSpeedPx(false);
    this.vy = speed;
    const exit = this.graph.dismountTarget(this.navWorld, track);
    let exitY = exit ? Math.min(exit.y, track.yBottom) : track.yBottom;
    const holdBelow = c.holdY !== null && c.holdY > this.y && c.holdY < exitY;
    if (holdBelow) exitY = c.holdY as number;
    this.y = Math.min(exitY, this.y + speed * dt);
    if (this.y < exitY - 0.01) return;
    this.vy = 0;
    if (holdBelow) {
      this.startHold(c, input.now);
      if (this.goal) out.goal = 'arrived';
      return;
    }
    if (!exit || exit.y - track.yBottom > MOVEMENT.wallReachBodyHeights * this.bodyHeight) {
      // The wall ends high above the next support: hop down from its foot.
      const outward = track.side === 'left' ? -1 : 1;
      this.climbing = null;
      this.x = track.x + outward * this.bodyWidth * 0.2;
      this.startFlight(outward * this.paceSpeedPx('walk') * 0.6, 0, input.now, { thrown: false, intentional: true, ignoreKey: null });
      if (this.flight) this.flight.kind = 'down';
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

  /** Holds still where the climb stopped (screen-edge hold point), MOVEMENT.maxWallHoldMs at most unless holdOnWall shortens it. */
  private startHold(c: Climb, now: number): void {
    this.vy = 0;
    c.hold = { since: now, until: now + MOVEMENT.maxWallHoldMs };
  }

  /**
   * A new goal while on a wall (v1.1.1: turn up or down). v1.2: a goal on the same screen edge moves
   * the hold point; with MoverConfig.wallJumps a goal on a support within a push-off's reach makes
   * a wall jump from here; a screen edge otherwise always leads down.
   */
  private replanOnWall(c: Climb, track: WallTrack): void {
    const g = this.goal as MoveGoal;
    if (g.surfaceId === track.key) {
      c.hold = null;
      c.wallJump = null;
      c.holdY = clamp(g.y, track.yTop, track.yBottom);
      c.dir = c.holdY < this.y ? -1 : 1;
      return;
    }
    c.hold = null;
    c.holdY = null;
    if (this.cfg.wallJumps === true) {
      const jump = this.wallJumpToward(track, g);
      if (jump) {
        c.wallJump = jump;
        return;
      }
    }
    this.reResolveTop(c, track);
    if (g.y > this.y + 1 && c.dir < 0) c.dir = 1;
    else if (g.y < this.y - 1 && c.dir > 0 && c.topKey && this.ledgeById(c.topKey)) c.dir = -1;
    if (track.kind === 'screenEdge') c.dir = 1;
  }

  /** A wall jump from where the cat clings onto the goal's support, when one push-off reaches it within the limits. */
  private wallJumpToward(track: WallTrack, g: MoveGoal): WallJump | null {
    const dest = g.surfaceId !== undefined ? this.supportByKey(g.surfaceId) : this.surfacePointFor({ x: g.x, y: g.y }).surface;
    if (!dest) return null;
    const land = this.graph.wallJumpLanding(this.navWorld, track, this.y, dest);
    if (!land || this.offLimitsAt(dest, land.x)) return null;
    // A goal-driven push-off only where it lands within the safe height (climbing down is calmer otherwise).
    if ((land.y - this.y) / track.scale > leaveLimits(this.cfg).safeDip) return null;
    if (!this.solveChecked({ x: track.x, y: this.y }, land, null)) return null;
    return { gripY: this.y, targetKey: dest.key, landX: land.x, crouchUntil: null, slip: null };
  }

  /**
   * v1.2 wall jump: climb to the grip, a short push-off crouch (MoverStep.crouchStarted; slips may
   * be armed), then a planned arc onto the target (jumpKind 'wallJump'). A target that vanished or
   * moved by then cancels it (planCancelled) and the cat climbs down instead.
   */
  private stepWallJump(c: Climb, track: WallTrack, input: MoverInput, out: MoverStep): void {
    const wj = c.wallJump as WallJump;
    const dt = Math.max(0, input.dtMs) / 1000;
    const gripY = clamp(wj.gripY, track.yTop, track.yBottom);
    if (Math.abs(this.y - gripY) > 0.5) {
      const up = gripY < this.y;
      const speed = this.climbSpeedPx(up);
      this.vy = up ? -speed : speed;
      this.y = up ? Math.max(gripY, this.y - speed * dt) : Math.min(gripY, this.y + speed * dt);
      return;
    }
    this.y = gripY;
    this.vy = 0;
    if (wj.crouchUntil === null) {
      wj.crouchUntil = input.now + MOVEMENT.wallJumpCrouchMs;
      out.crouchStarted = true;
      return;
    }
    if (input.now < wj.crouchUntil) return;
    const target = this.supportByKey(wj.targetKey);
    const land = target ? this.graph.wallJumpLanding(this.navWorld, track, this.y, target) : null;
    const tooFar = land !== null && Math.abs(land.x - wj.landX) > MOVEMENT.planStaleBodyLengths * this.bodyWidth;
    if (!target || !land || tooFar || (land.y - this.y) / track.scale > leaveLimits(this.cfg).maxDip) {
      c.wallJump = null;
      c.dir = 1;
      this.cancelPlan(input.now, out);
      return;
    }
    let slip = wj.slip;
    if (slip === 'miss' && !this.missAllowedBelow(target, land.x)) slip = 'scramble';
    const from = { x: track.x, y: this.y };
    const plan = this.solveChecked(from, land, null);
    if (!plan) {
      c.wallJump = null;
      c.dir = 1;
      return;
    }
    this.climbing = null;
    out.climbEnded = true;
    this.takeOffPlanned(plan, target, 'wallJump', slip, input, out);
  }

  /** v1.2: an armed slip on the pull-up onto a tab strip (a scramble lengthens it; a miss drops off the corner). */
  private pullUpSlip(c: Climb, track: WallTrack, top: Surface, input: MoverInput, out: MoverStep): void {
    let slip = top.surfaceKind === 'tabStrip' ? c.slip : null;
    c.slip = null;
    if (slip === null) return;
    if (slip === 'miss' && !this.missAllowedFromWall(track, this.y)) slip = 'scramble';
    if (slip === 'scramble') {
      c.durationMs += MOVEMENT.slipScrambleMs;
      out.slipped = 'scramble';
      return;
    }
    const outward = track.side === 'left' ? -1 : 1;
    this.climbing = null;
    this.climbStats.letGo++;
    this.startFlight(outward * this.paceSpeedPx('slow'), 0, input.now, { thrown: false, intentional: false, ignoreKey: top.key });
    if (this.flight) this.flight.slipped = true;
    out.slipped = 'miss';
    out.climbEnded = true;
  }

  private finishPullUp(c: Climb, input: MoverInput, out: MoverStep): void {
    this.reResolveTop(c, c.wall);
    const top = c.topKey ? this.ledgeById(c.topKey) : null;
    const live = top ? this.liveLedge(input, top.key) : null;
    out.climbEnded = true;
    if (!top || !live) {
      // The ledge dropped out of the list (covered, switched off) or its window is gone.
      this.releaseWall(input, out, top ? 'gone' : 'occluded');
      return;
    }
    this.climbing = null;
    this.climbStats.pulledUp++;
    // Where the pull-up ended (the corner, carried with the window): on a tab strip's window top
    // beside the strip it walks on from there.
    this.setGrounded(top, this.x, live);
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

  /** The wall is lost: v1.2 bails out (MoverConfig.bailOut: covered or gone), else it lets go (v1.1.1). */
  private releaseWall(input: MoverInput, out: MoverStep, reason: SupportLossReason): void {
    if (this.cfg.bailOut === true && (reason === 'gone' || reason === 'occluded') && this.climbing) this.bailOffWall(input, out, reason);
    else this.letGoOfWall(input, out, reason);
  }

  /** The wall is gone or unusable: the cat lets go and drops (pushing off slightly). */
  private letGoOfWall(input: MoverInput, out: MoverStep, reason: SupportLossReason): void {
    const c = this.climbing;
    this.climbing = null;
    this.climbStats.letGo++;
    const outward = c ? (c.wall.side === 'left' ? -1 : 1) : 0;
    const p = this.navWorld.clampInside({ x: this.x, y: this.y });
    if (Math.hypot(p.x - this.x, p.y - this.y) > 1) out.snapped = true;
    this.x = p.x;
    this.y = p.y;
    this.startFlight(outward * this.paceSpeedPx('slow'), 0, input.now, { thrown: false, intentional: false, ignoreKey: null });
    out.perchLost = true;
    out.climbEnded = true;
    if (c) out.supportLost = { reason, surfaceId: c.wall.key, surfaceKind: c.wall.kind === 'screenEdge' ? SCREEN_EDGE_KIND : 'windowSide', fell: true };
  }

  /** A support by key: a usable ledge, a floor, or the surface the cat stands on. */
  private supportByKey(key: string): Surface | null {
    return this.ledgeById(key) ?? this.navWorld.floors.find((f) => f.key === key) ?? (this.surface.key === key ? this.surface : null);
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
      impact: impactClass(impactVy / scale),
      jumpKind: f?.kind ?? null,
      slipped: f?.slipped ?? false,
      ...this.plannedLanding(f?.plannedKey ?? null, surface, forced, input),
    };
    this.bailing = null;
    this.setGrounded(surface, x, live);
    if (f?.slip === 'scramble' && out.landed.plannedOutcome === 'landed') {
      // v1.2 deliberate slip: front paws on the edge, a moment of scrambling, then it is up.
      this.scrambleUntil = input.now + MOVEMENT.slipScrambleMs;
      out.slipped = 'scramble';
    }
  }

  /** v1.2 fall accounting: how a planned jump ended against the support it aimed at. */
  private plannedLanding(key: string | null, surface: Surface, forced: boolean, input: MoverInput): Pick<LandingInfo, 'plannedSupportId' | 'plannedOutcome'> {
    if (key === null) return { plannedSupportId: null, plannedOutcome: null };
    if (!forced && surface.key === key) return { plannedSupportId: key, plannedOutcome: 'landed' };
    const exists = this.navWorld.floors.some((fl) => fl.key === key) || this.liveLedge(input, key) !== null;
    return { plannedSupportId: key, plannedOutcome: exists ? 'missed' : 'gone' };
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
    const s = this.surface;
    // On a ledge's widened landing range (a tab strip's window top) the cat stays where it was
    // set down, never snapped into the stand range: it walks in (stepGround).
    this.x = setDownX(s, x);
    this.walkIn = s.kind === 'ledge' && s.landWide === true && (this.x < s.x0 || this.x > s.x1);
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
    this.walkIn = false;
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
      plannedKey: null,
      thrown: o.thrown,
      intentional: o.intentional,
      ignoreKey: o.ignoreKey,
      peakY: this.y,
      scale,
      startedAt: now,
      kind: null,
      slip: null,
      slipped: false,
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

  /**
   * v1.2: routes never pass over a screen edge on their own (the behaviour decides when one may be
   * climbed, ADR 0003 §6.1 T8 guard (b)); only a goal naming that edge (MoveGoal.surfaceId) uses it.
   */
  private routeParams(goal: MoveGoal): RouteParams {
    const route = goal.route ?? 'any';
    const effort = (v: number | undefined): number => (v !== undefined && Number.isFinite(v) && v > 0 ? clamp(v, 0.2, 5) : 1);
    const edgeKey = goal.surfaceId;
    return {
      walkSpeedPx: this.paceSpeedPx('walk'),
      jumpEffort: effort(this.cfg.jumpEffort),
      climbEffort: effort(this.cfg.climbEffort),
      allowClimb: (this.wallsEnabled() || this.edgesEnabled()) && route !== 'noClimb',
      preferClimb: route === 'climb',
      blockedNode: (n) => this.nodeBlocked(n) || (n.wall?.kind === 'screenEdge' && n.wall.key !== edgeKey),
      blockedEdge: (e) => this.blockedEdges.has(edgeId(e)),
      blockedArrival: (s, x) => this.offLimitsAt(s, x),
      jumpDown: jumpDownLimits(this.cfg),
      allowWallJump: this.cfg.wallJumps === true,
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
    this.destKey = null;
    const range = this.rangeOn(cur, this.x);
    let dest: SurfacePoint;
    if (goal.surfaceId !== undefined) {
      // v1.2 pinned goal (T6): that surface only, x clamped into its current range; a screen edge is a climb.
      const edge = this.walls.find((w) => w.key === goal.surfaceId && w.kind === 'screenEdge');
      if (edge) return this.planEdgeClimb(goal, cur, edge);
      const pinned = this.supportByKey(goal.surfaceId);
      if (!pinned) return { kind: 'walk', x: clamp(this.x, range.x0, range.x1), reachable: false };
      const px = clamp(goal.x, pinned.x0, pinned.x1);
      dest = { surface: pinned, x: px, y: this.navWorld.yAt(pinned, px) };
    } else {
      dest = this.coveredFloorGoal(this.surfacePointFor({ x: goal.x, y: goal.y }), goal.literal === true);
    }
    // Goals on displays the cat may not roam to, or that are off limits, are approached as closely as possible.
    const allowed = this.navWorld.contains(this.fullWorld.clampInside({ x: goal.x, y: goal.y }), 1);
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
      if (leg) {
        this.destKey = dest.surface.key;
        return leg;
      }
      // The precise check failed (e.g. the arc would clip a display edge): try another way.
      this.blockedEdges.add(edgeId(first.edge));
    }
    if (cur.kind === 'ledge' && dest.y > cur.y + 1) {
      const pref: 1 | -1 = dest.x > cur.x1 ? 1 : dest.x < cur.x0 ? -1 : this.x - cur.x0 < cur.x1 - this.x ? -1 : 1;
      const others = this.ledges.filter((l) => l.key !== cur.key);
      const limits = jumpDownLimits(this.cfg);
      for (const dir of [pref, -pref as 1 | -1]) {
        // Never step off toward an off-limits display, nor (v1.2) further down than the jump-down maximum.
        const endX = dir > 0 ? cur.landX1 : cur.landX0;
        const below = this.navWorld.surfaceBelow(endX + dir * this.bodyWidth * 0.6, cur.y + 1, others);
        if (limits && (!below || (below.y - cur.y) / this.scale > limits.maxDip)) continue;
        if (below && this.cfg.surfaceHops === false && isWindowHop(cur, below.surface)) continue;
        if (!below || !this.offLimitsAt(below.surface, below.x)) return { kind: 'drop', dir };
      }
    }
    return { kind: 'walk', x: clamp(dest.x, range.x0, range.x1), reachable: false };
  }

  /** v1.2: a goal naming a screen edge: get onto it (mount or leap) and climb to the grip height goal.y, then hold. */
  private planEdgeClimb(goal: MoveGoal, cur: Surface, edge: WallTrack): Leg {
    const range = this.rangeOn(cur, this.x);
    const holdY = clamp(goal.y, edge.yTop, edge.yBottom);
    const route = this.graph.route(cur, this.x, `up:${edge.key}`, edge.x, this.routeParams(goal));
    const first = route?.steps[0];
    if (route && first) {
      const leg = this.legFrom(route, cur, { surface: cur, x: this.x, y: this.y }, { edge, holdY });
      if (leg) {
        this.destKey = edge.key;
        return leg;
      }
      this.blockedEdges.add(edgeId(first.edge));
    }
    return { kind: 'walk', x: clamp(edge.standX, range.x0, range.x1), reachable: false };
  }

  /** The first leg of a route, checked precisely; null when it cannot be executed. */
  private legFrom(route: Route, cur: Surface, dest: SurfacePoint, edgeClimb: { edge: WallTrack; holdY: number } | null = null): Leg | null {
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
      case 'mount':
      case 'leap': {
        const w = this.graph.node(e.to)?.wall;
        if (!w) return null;
        const edgeHold = w.kind === 'screenEdge' && edgeClimb !== null && edgeClimb.edge.key === w.key && !next;
        const overTop = next?.edge.kind === 'wallJump' && this.cfg.wallJumps === true;
        if (!edgeHold && !overTop && (!next || next.edge.kind !== 'pullUp')) return null;
        let gripY: number | null = null;
        if (e.kind === 'leap') {
          // The precise check: the arc from the stand point to the grip must stay on screen.
          const from = { x: first.fromX, y: this.navWorld.yAt(cur, first.fromX) };
          gripY = this.graph.leapGripY(w, from.y, this.navWorld.scaleAt(from));
          if (gripY === null || !this.solveLeap(from, { x: w.x, y: gripY })) return null;
        }
        // v1.2: up a screen edge to its hold point, or up a side and over its top with a wall jump.
        if (edgeHold) return { kind: 'climbUp', standX: first.fromX, wall: w, ledgeKey: null, cornerX: null, gripY, holdY: (edgeClimb as { holdY: number }).holdY };
        if (overTop && next) return { kind: 'climbUp', standX: first.fromX, wall: w, ledgeKey: null, cornerX: null, gripY, jumpTo: next.edge.to };
        if (!next) return null;
        return { kind: 'climbUp', standX: first.fromX, wall: w, ledgeKey: next.edge.to, cornerX: next.toX, gripY };
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
    // v1.2: with jump-down limits a descent pushes off nearly flat, so it lands no harder than its drop.
    const base = descentClearancePx(clearancePx ?? clearanceFor(to.x - from.x, MOVEMENT.jumpClearanceDip * scale, MOVEMENT.jumpClearancePerDx), to.y - from.y, scale, jumpDownLimits(this.cfg) !== null);
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
        const kept = this.modeValue === 'climb' ? this.keepClimbing(pos) : null;
        if (kept !== null) return kept;
        this.crouch = null;
        this.bailing = null;
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

  /**
   * v1.2 (ADR 0003 §6.8): a topology change while clinging. A screen edge that still exists (same
   * display and side, its line within half a body length) keeps the cat clinging; one that is gone
   * (display removed or now joined to a neighbour) lets it go from where it is, cause 'gone'
   * (reported by the next step). With MoverConfig.bailOut a window side keeps it clinging too (the
   * next step re-validates the side from the provider). Null: the v1.1.1 re-placement on the floor.
   * Returns whether the cat was moved discontinuously.
   */
  private keepClimbing(pos: Point): boolean | null {
    const c = this.climbing;
    if (!c || c.phase === 'leap') return null;
    const w = c.wall;
    if (w.kind === 'screenEdge') {
      const t = this.edgesEnabled() ? this.screenEdgeTracks().find((e) => e.key === w.key) : undefined;
      const tol = MOVEMENT.planStaleBodyLengths * this.navWorld.bodyWidth(t?.scale ?? w.scale);
      if (t && Math.abs(t.x - pos.x) <= tol && pos.y >= t.yTop - tol && pos.y <= t.yBottom + tol) {
        c.wall = t;
        this.x = t.x;
        this.y = clamp(pos.y, t.yTop, t.yBottom);
        return Math.hypot(this.x - pos.x, this.y - pos.y) > 0.5;
      }
      this.pendingLoss = { reason: 'gone', surfaceId: w.key, surfaceKind: SCREEN_EDGE_KIND, fell: true };
      this.climbing = null;
      const p = this.navWorld.clampInside(pos);
      this.x = p.x;
      this.y = p.y;
      this.startFlight(0, 0, this.clock, { thrown: false, intentional: false, ignoreKey: null });
      return Math.hypot(p.x - pos.x, p.y - pos.y) > 0.5;
    }
    if (this.cfg.bailOut === true && this.navWorld.contains(pos, 1)) return false;
    return null;
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

/** LeaveOption.toKind of a support. */
function leaveToKind(t: Surface): LeaveOption['toKind'] {
  return t.kind === 'floor' ? 'floor' : (t.surfaceKind ?? 'windowTop');
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
    clung: false,
    slipped: null,
    bailedOut: false,
    planCancelled: false,
  };
}

/** A turned-down environment surface as a debug segment (physical px), or null for broken geometry. */
function rejectedLine(s: EnvSurface): SurfaceDebugLine | null {
  if (s.orientation === 'ledge') {
    return Number.isFinite(s.y) && Number.isFinite(s.x0) && Number.isFinite(s.x1) ? { kind: s.kind, role: 'rejected', x0: s.x0, y0: s.y, x1: s.x1, y1: s.y } : null;
  }
  if (s.orientation === 'wall') {
    return Number.isFinite(s.x) && Number.isFinite(s.y0) && Number.isFinite(s.y1) ? { kind: 'windowSide', role: 'rejected', x0: s.x, y0: s.y0, x1: s.x, y1: s.y1 } : null;
  }
  return null;
}

/**
 * How far a window moved along an edge this tick, judged from the ends of the open span of
 * that edge the cat is on (the provider reports open spans, not the window's frame). Both
 * ends moving together is the window moving, as long as the span still overlaps where it
 * was or the motion is borne out: by the window's reported velocity `v` (px/s; within 2.5x
 * over `dtMs`, plus `slack` px), or by the frame having moved across the edge (`frameMoved`:
 * the top edge's height, a side's x, which occlusion never changes). Otherwise a span as long
 * as the old one somewhere else is another part of the edge (the cat's part was covered), and
 * nothing moved. One end moving alone is a window in front covering or uncovering part of the
 * edge, or a resize: nothing moves. An end clipped at the edge of a work area (`pinned`) stays
 * put while the window slides under it, so then the other end alone counts if the motion is
 * borne out: an end that jumps further or the other way is a window in front.
 */
function spanShift(prev: readonly [number, number], next: readonly [number, number], pinned: (v: number) => boolean, v: number, dtMs: number, slack: number, frameMoved: boolean): number {
  const d0 = next[0] - prev[0];
  const d1 = next[1] - prev[1];
  if (d0 === 0 && d1 === 0) return 0;
  const vel = Number.isFinite(v) ? v : 0;
  const reach = (2.5 * Math.abs(vel) * Math.max(0, dtMs)) / 1000 + slack;
  const borneOut = (d: number): boolean => frameMoved || (Math.sign(d) === Math.sign(vel) && Math.abs(d) <= reach);
  const free0 = !pinned(prev[0]) && !pinned(next[0]);
  const free1 = !pinned(prev[1]) && !pinned(next[1]);
  if (free0 && free1) {
    if (Math.abs(d0 - d1) > 1.5) return 0;
    const d = (d0 + d1) / 2;
    const overlaps = next[0] < prev[1] && prev[0] < next[1];
    return overlaps || borneOut(d) ? d : 0;
  }
  if (free0 === free1) return 0;
  const d = free0 ? d0 : d1;
  return borneOut(d) ? d : 0;
}

function approach(v: number, target: number, maxDelta: number): number {
  if (v < target) return Math.min(target, v + maxDelta);
  if (v > target) return Math.max(target, v - maxDelta);
  return v;
}
