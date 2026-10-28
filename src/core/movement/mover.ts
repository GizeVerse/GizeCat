// The cat's body: grounded locomotion along surfaces, perch riding, anticipation
// crouch, ballistic jumps, free fall with wall bounces, and being dragged/thrown.
// Everything is in physical px; DIP constants are scaled by the display under the cat.
import type { Facing } from '../../shared/cat';
import type { Point, Rect } from '../../shared/geometry';
import { clamp, isFiniteRect, rectBottom, rectRight } from '../../shared/geometry';
import type { SimSupport } from '../../shared/sim';
import type { Platform, WorldGeometry } from '../../shared/world';
import { ARRIVE_RADIUS_DIP, MOVEMENT } from './constants';
import type { JumpPlan } from './jump';
import { ballistic, clearanceFor, descendingCrossing, jumpAt, sampleArc, solveJump } from './jump';
import type { Surface, SurfacePoint } from './world';
import { sameSurface, WorldModel } from './world';

export type Pace = 'slow' | 'walk' | 'run' | 'chase';

export interface MoveGoal {
  x: number;
  y: number;
  pace: Pace;
  /** false = stay on the current surface (cursor chase, following a window). */
  allowJump: boolean;
  /** Arrival tolerance in px; defaults to ~3 DIP. */
  arriveRadiusPx?: number;
}

export interface MoverConfig {
  size: number;
  movementSpeed: number;
  allowMultiMonitor: boolean;
  perchOnWindows: boolean;
}

export interface MoverInput {
  now: number;
  dtMs: number;
  dragCursor: Point | null;
  getWindowRect: (id: string) => Rect | null;
  /** Windows the user is currently moving (platform list may lag for these). */
  movingWindowIds: ReadonlySet<string>;
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

export interface MoverStep {
  goal: GoalStatus;
  crouchStarted: boolean;
  tookOff: boolean;
  steppedOff: boolean;
  landed: LandingInfo | null;
  perchLost: boolean;
  snapped: boolean;
}

export type MoverMode = 'ground' | 'crouch' | 'air' | 'held';

type Leg =
  | { kind: 'walk'; x: number; reachable: boolean }
  | { kind: 'jump'; takeoffX: number; landX: number; target: Surface }
  | { kind: 'drop'; dir: 1 | -1 };

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
  ignoreWindowId: string | null;
  peakY: number;
  scale: number;
  startedAt: number;
}

interface Perch {
  windowId: string;
  rect: Rect;
  missingSince: number | null;
}

interface Crouch {
  until: number;
  landX: number;
  target: Surface;
  clearanceDip: number | null;
}

interface Drag {
  offX: number;
  offY: number;
}

const MAX_FLIGHT_MS = 6000;

export class Mover {
  x = 0;
  y = 0;
  vx = 0;
  vy = 0;
  facing: Facing = 1;
  private facingChangedAt = -Infinity;
  private modeValue: MoverMode = 'ground';
  private surface: Surface;
  private perch: Perch | null = null;
  private flight: Flight | null = null;
  private crouch: Crouch | null = null;
  private drag: Drag | null = null;
  private goal: MoveGoal | null = null;
  private leg: Leg | null = null;
  private windows: Surface[] = [];
  private fullWorld: WorldModel;
  private navWorld: WorldModel;
  private homeDisplayId: string;
  private cfg: MoverConfig;
  private geometry: WorldGeometry;

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
  get windowSurfaces(): readonly Surface[] {
    return this.windows;
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
  get thrownFlight(): boolean {
    return this.flight?.thrown ?? false;
  }
  get perchWindowId(): string | null {
    return this.perch?.windowId ?? null;
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
      default:
        if (this.perch) return { kind: 'window', windowId: this.perch.windowId };
        return { kind: 'floor', displayId: this.navWorld.displayIdOn(this.surface, this.x) };
    }
  }
  /** Horizontal ground speed in px/s (0 while airborne or held). */
  get groundSpeed(): number {
    return this.modeValue === 'ground' ? Math.abs(this.vx) : 0;
  }
  paceSpeedPx(pace: Pace): number {
    const dip = pace === 'run' ? MOVEMENT.runDip : pace === 'chase' ? MOVEMENT.chaseDip : pace === 'slow' ? MOVEMENT.slowDip : MOVEMENT.walkDip;
    return dip * this.cfg.movementSpeed * this.scale;
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
    if (!cfg.perchOnWindows) this.windows = [];
    if (!rebuild) return false;
    if (!cfg.allowMultiMonitor) this.homeDisplayId = this.displayId;
    this.fullWorld = new WorldModel(this.geometry, cfg.size, cfg.allowMultiMonitor);
    return this.revalidate();
  }

  /** Refreshes walkable window tops for this tick. */
  sense(platforms: readonly Platform[]): void {
    this.windows = this.cfg.perchOnWindows ? this.navWorld.windowSurfaces(platforms) : [];
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
    if (!prev || prev.allowJump !== goal.allowJump || Math.abs(prev.y - goal.y) > 2 || Math.abs(prev.x - goal.x) > this.bodyWidth * 0.5) {
      this.leg = null;
    }
  }

  /** Projects a screen point onto the surface the cat would stand on there. */
  surfacePointFor(p: Point): SurfacePoint {
    const q = this.navWorld.clampInside(p);
    return this.navWorld.surfaceBelow(q.x, q.y - 2, this.windows) ?? this.navWorld.nearestFloorPoint(q);
  }

  /** Whether a destination can be reached (same surface or one/two jumps). */
  canReach(p: Point): boolean {
    if (this.modeValue !== 'ground' && this.modeValue !== 'crouch') return false;
    const dest = this.surfacePointFor(p);
    if (sameSurface(this.surface, dest.surface)) return true;
    const leg = this.planLeg({ x: dest.x, y: dest.y, pace: 'walk', allowJump: true }, this.surface);
    return leg.kind !== 'walk' || leg.reachable;
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
    if (this.modeValue !== 'ground') return false;
    const s = this.surface;
    const dx = this.facing * this.bodyWidth * 0.35;
    const landX = clamp(this.x + dx, s.x0, s.x1);
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
    this.drag = { offX, offY };
    this.modeValue = 'held';
    this.flight = null;
    this.crouch = null;
    this.perch = null;
    this.goal = null;
    this.leg = null;
    this.vx = 0;
    this.vy = 0;
  }

  /** Releases the cat. Returns the release speed in DIP/s (after clamping). */
  endDrag(at: Point | null, velocity: Point, now: number, allowThrow: boolean): { speedDip: number; thrown: boolean } {
    if (this.modeValue !== 'held') return { speedDip: 0, thrown: false };
    const d = this.drag ?? { offX: 0, offY: 0 };
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
    this.startFlight(vx, vy, now, { thrown, intentional: false, ignoreWindowId: null });
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

  // ---- simulation step -------------------------------------------------------

  step(input: MoverInput): MoverStep {
    const out: MoverStep = { goal: 'none', crouchStarted: false, tookOff: false, steppedOff: false, landed: null, perchLost: false, snapped: false };
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
    const p = this.fullWorld.clampInside({ x: input.dragCursor.x + d.offX, y: input.dragCursor.y + d.offY });
    this.x = p.x;
    this.y = p.y;
  }

  private stepGround(input: MoverInput, out: MoverStep): void {
    if (this.perch && !this.ride(input, out)) return;
    const dt = Math.max(0, input.dtMs) / 1000;
    const s = this.surface;
    let targetX = this.x;
    let pace: Pace = 'walk';
    let stepOffDir = 0;
    if (this.goal) {
      pace = this.goal.pace;
      if (!this.goal.allowJump) {
        const x = clamp(this.goal.x, s.x0, s.x1);
        this.leg = { kind: 'walk', x, reachable: Math.abs(x - this.goal.x) <= this.arriveRadius() };
      } else if (!this.leg) {
        this.leg = this.planLeg(this.goal, s);
      }
      const leg = this.leg;
      if (leg.kind === 'walk') targetX = leg.x;
      else if (leg.kind === 'jump') targetX = leg.takeoffX;
      else {
        stepOffDir = leg.dir;
        targetX = leg.dir > 0 ? s.x1 + this.bodyWidth : s.x0 - this.bodyWidth;
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
    if (nx > s.x1 || nx < s.x0) {
      const dir: 1 | -1 = nx > s.x1 ? 1 : -1;
      if (stepOffDir === dir) {
        this.x = dir > 0 ? s.x1 : s.x0;
        const vx = dir * Math.max(Math.abs(this.vx), this.paceSpeedPx('walk') * 0.8);
        this.startFlight(vx, 0, input.now, { thrown: false, intentional: true, ignoreWindowId: this.perch?.windowId ?? null });
        out.steppedOff = true;
        out.goal = 'moving';
        return;
      }
      nx = clamp(nx, s.x0, s.x1);
      this.vx = 0;
    }
    this.x = nx;
    this.y = this.perch ? this.perch.rect.y : this.navWorld.yAt(s, nx);
    this.updateFacing(this.vx, input.now);

    if (!this.goal || !this.leg) return;
    const leg = this.leg;
    if (leg.kind === 'jump') {
      if (Math.abs(this.x - leg.takeoffX) <= 1 && Math.abs(this.vx) < 1) {
        this.vx = 0;
        if (Math.abs(leg.landX - this.x) > 2) this.setFacing(leg.landX > this.x ? 1 : -1, input.now);
        this.modeValue = 'crouch';
        this.crouch = { until: input.now + MOVEMENT.crouchMs, landX: leg.landX, target: leg.target, clearanceDip: null };
        out.crouchStarted = true;
      }
      out.goal = 'moving';
      return;
    }
    if (leg.kind === 'walk' && Math.abs(this.x - leg.x) <= this.arriveRadius() && Math.abs(this.vx) < 1) {
      out.goal = leg.reachable ? 'arrived' : 'unreachable';
      return;
    }
    out.goal = 'moving';
  }

  private stepCrouch(input: MoverInput, out: MoverStep): void {
    if (this.perch && !this.ride(input, out)) {
      this.crouch = null;
      return;
    }
    const c = this.crouch;
    if (!c) {
      this.modeValue = 'ground';
      return;
    }
    if (input.now < c.until) return;
    this.crouch = null;
    const target = this.revalidateTarget(c.target, c.landX);
    if (!target) {
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
    const ignore = this.perch?.windowId ?? null;
    this.perch = null;
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
      ignoreWindowId: target.windowId === ignore ? null : ignore,
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
      if (target && Math.abs(this.navWorld.yAt(target, f.plan.to.x) - f.plan.to.y) <= 6 * f.scale && this.rectFor(target, input) !== false) {
        this.land(target, f.plan.to.x, input, out, Math.abs(end.vy), false);
        return;
      }
      // Target vanished mid-flight: continue as a free fall from the end of the arc.
      this.x = end.x;
      this.y = end.y;
      this.flight = { ...f, t0: now, lastT: now, x0: end.x, y0: end.y, vx: end.vx * 0.5, vy0: end.vy, plan: null, target: null };
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
    let best: { s: number; surface: Surface; x: number; y: number } | null = null;
    // Cheap reject: a descending crossing in (s0, s1] lies below the arc's highest point in that interval.
    const sApex = -f.vy0 / f.g;
    const top = sApex > s0 && sApex < s1 ? f.y0 + f.vy0 * sApex + 0.5 * f.g * sApex * sApex : Math.min(y0, y1);
    const bottom = Math.max(y0, y1);
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
    for (const w of this.windows) {
      if (w.windowId === f.ignoreWindowId) continue;
      if (input.getWindowRect(w.windowId as string) === null) continue;
      consider(w, w.y, w.landX0, w.landX1, true);
    }
    return best;
  }

  /** Keeps the cat on a moving perch; returns false (and starts a fall) when the perch is lost. */
  private ride(input: MoverInput, out: MoverStep): boolean {
    const perch = this.perch as Perch;
    const lose = (): false => {
      this.crouch = null;
      // A window can carry the cat out of the world before it is noticed: fall from inside.
      const p = this.navWorld.clampInside({ x: this.x, y: this.y });
      if (Math.hypot(p.x - this.x, p.y - this.y) > 1) out.snapped = true;
      this.x = p.x;
      this.y = p.y;
      this.startFlight(0, 0, input.now, { thrown: false, intentional: false, ignoreWindowId: perch.windowId });
      out.perchLost = true;
      return false;
    };
    const rect = input.getWindowRect(perch.windowId);
    if (!rect || !isFiniteRect(rect) || rect.width < 1 || rect.height < 1) return lose();
    if (this.coversWorkArea(rect)) return lose();
    const dx = rect.x - perch.rect.x;
    const dy = rect.y - perch.rect.y;
    const moved = dx !== 0 || dy !== 0;
    if (moved) {
      this.x += dx;
      perch.rect = rect;
    }
    this.y = rect.y;
    const hw = this.bodyWidth / 2;
    if (this.x < rect.x - hw * 0.25 || this.x > rectRight(rect) + hw * 0.25) return lose();
    const d = this.navWorld.displayAt({ x: this.x, y: this.y });
    if (!d || this.y - this.bodyHeight * 0.8 < d.workAreaPx.y || rectBottom(d.workAreaPx) - this.y < 1) return lose();
    const seg = this.windows.find((w) => w.windowId === perch.windowId && this.x >= w.landX0 - hw && this.x <= w.landX1 + hw);
    if (seg) {
      perch.missingSince = null;
    } else {
      perch.missingSince ??= input.now;
      const grace = moved || input.movingWindowIds.has(perch.windowId) ? MOVEMENT.perchMovingGraceMs : MOVEMENT.perchGraceMs;
      if (input.now - perch.missingSince > grace) return lose();
    }
    this.surface = seg && Math.abs(seg.y - rect.y) <= 2 ? seg : this.surfaceFromRect(rect, perch.windowId, d.id);
    this.x = clamp(this.x, this.surface.x0, this.surface.x1);
    if (moved) this.leg = null;
    return true;
  }

  private surfaceFromRect(rect: Rect, windowId: string, displayId: string): Surface {
    const d = this.navWorld.display(displayId) ?? this.navWorld.primary;
    const bw = this.navWorld.bodyWidth(d.scaleFactor);
    const lx0 = Math.max(rect.x, d.workAreaPx.x);
    const lx1 = Math.min(rectRight(rect), rectRight(d.workAreaPx));
    let x0 = lx0 + bw * 0.25;
    let x1 = lx1 - bw * 0.25;
    if (x1 < x0) {
      x0 = (lx0 + lx1) / 2;
      x1 = x0;
    }
    return { kind: 'window', key: `win:${windowId}`, windowId, displayIds: [d.id], y: rect.y, x0, x1, landX0: lx0, landX1: lx1, pieces: [] };
  }

  private coversWorkArea(rect: Rect): boolean {
    const d = this.fullWorld.nearestDisplay({ x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 });
    const wa = d.workAreaPx;
    return rect.width >= wa.width - 2 && rect.height >= wa.height - 2 && rect.y <= wa.y + 2;
  }

  /** false when the target is a window that no longer exists. */
  private rectFor(target: Surface, input: MoverInput): Rect | null | false {
    if (target.kind !== 'window' || !target.windowId) return null;
    const r = input.getWindowRect(target.windowId);
    return r && isFiniteRect(r) ? r : false;
  }

  private revalidateTarget(target: Surface, landX: number): Surface | null {
    if (target.kind === 'floor') return this.navWorld.floors.find((f) => f.key === target.key) ?? null;
    const tol = this.bodyWidth * 0.25;
    return this.windows.find((w) => w.windowId === target.windowId && landX >= w.landX0 - tol && landX <= w.landX1 + tol) ?? null;
  }

  private land(surface: Surface, x: number, input: MoverInput, out: MoverStep, impactVy: number, forced: boolean): void {
    const f = this.flight;
    const scale = f?.scale ?? this.scale;
    let perchRect: Rect | null = null;
    if (surface.kind === 'window' && surface.windowId) {
      const r = input.getWindowRect(surface.windowId);
      perchRect = r && isFiniteRect(r) ? r : null;
      if (!perchRect) {
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
    this.setGrounded(surface, x, perchRect);
  }

  private setGrounded(surface: Surface, x: number, perchRect: Rect | null): void {
    this.modeValue = 'ground';
    this.flight = null;
    this.crouch = null;
    this.surface = surface;
    this.perch = surface.kind === 'window' && surface.windowId && perchRect ? { windowId: surface.windowId, rect: perchRect, missingSince: null } : null;
    if (surface.kind === 'window' && !this.perch) {
      const fp = this.navWorld.nearestFloorPoint({ x, y: surface.y });
      this.surface = fp.surface;
      x = fp.x;
    }
    this.x = clamp(x, this.surface.x0, this.surface.x1);
    this.y = this.perch ? this.perch.rect.y : this.navWorld.yAt(this.surface, this.x);
    this.vx = 0;
    this.vy = 0;
    this.leg = null;
  }

  private startFlight(vx: number, vy: number, now: number, o: { thrown: boolean; intentional: boolean; ignoreWindowId: string | null }): void {
    const scale = this.scale;
    this.modeValue = 'air';
    this.perch = null;
    this.crouch = null;
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
      ignoreWindowId: o.ignoreWindowId,
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

  private planLeg(goal: MoveGoal, cur: Surface): Leg {
    const dest = this.surfacePointFor({ x: goal.x, y: goal.y });
    // Goals on displays the cat may not roam to are approached as closely as possible.
    const allowed = this.navWorld.contains(this.fullWorld.clampInside({ x: goal.x, y: goal.y }), 1);
    if (sameSurface(cur, dest.surface)) return { kind: 'walk', x: clamp(dest.x, cur.x0, cur.x1), reachable: allowed };
    const direct = this.planJumpLeg(cur, this.x, dest);
    if (direct) return direct;
    // One intermediate window top (e.g. floor -> low window -> high window).
    for (const w of this.windows) {
      if (sameSurface(w, cur) || sameSurface(w, dest.surface)) continue;
      const first = this.planJumpLeg(cur, this.x, { surface: w, x: clamp(dest.x, w.x0, w.x1), y: w.y });
      if (first && first.kind === 'jump' && this.planJumpLeg(w, first.landX, dest)) return first;
    }
    if (cur.kind === 'window' && dest.y > cur.y + 1) {
      const dir: 1 | -1 = dest.x > cur.x1 ? 1 : dest.x < cur.x0 ? -1 : this.x - cur.x0 < cur.x1 - this.x ? -1 : 1;
      return { kind: 'drop', dir };
    }
    return { kind: 'walk', x: clamp(dest.x, cur.x0, cur.x1), reachable: false };
  }

  private planJumpLeg(cur: Surface, fromX: number, dest: SurfacePoint): Leg | null {
    const scale = this.navWorld.scaleAt({ x: fromX, y: this.navWorld.yAt(cur, fromX) });
    const maxAcross = MOVEMENT.maxJumpAcrossDip * scale;
    const maxUp = MOVEMENT.maxJumpUpDip * scale;
    const bw = this.navWorld.bodyWidth(scale);
    const t = dest.surface;
    let landX = clamp(dest.x, t.x0, t.x1);
    let takeoffX = clamp(landX, cur.x0, cur.x1);
    if (Math.abs(landX - takeoffX) > maxAcross) {
      landX = clamp(takeoffX + Math.sign(landX - takeoffX) * maxAcross, t.x0, t.x1);
      if (Math.abs(landX - takeoffX) > maxAcross + 0.5) return null;
    }
    if (Math.abs(landX - takeoffX) < bw * 0.5) {
      const dir = fromX <= takeoffX ? -1 : 1;
      const alt = clamp(takeoffX + dir * bw * 0.8, cur.x0, cur.x1);
      if (Math.abs(landX - alt) <= maxAcross) takeoffX = alt;
    }
    // Arcs that would clip a display edge get a longer run-up and/or a landing
    // further in (e.g. jumping up from a lower monitor onto a higher one).
    const away = landX >= takeoffX ? -1 : 1;
    for (const k of [0, 0.5, 1, 2, 3, 4]) {
      const tx = clamp(takeoffX + away * k * bw, cur.x0, cur.x1);
      if (k > 0 && tx === takeoffX) continue;
      for (const j of [0, 1, 2]) {
        const lx = clamp(landX - away * j * bw, t.x0, t.x1);
        if (j > 0 && lx === landX) continue;
        if (Math.abs(lx - tx) > maxAcross) continue;
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
    this.windows = [];
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
        this.modeValue = 'ground';
        if (this.perch) {
          if (this.navWorld.contains(pos, 1)) return false;
          this.perch = null;
        }
        const oldDisplay = this.surface.kind === 'floor' ? this.surface.pieces.find((p) => pos.x >= p.left && pos.x < p.right)?.displayId ?? this.surface.displayIds[0] : undefined;
        const floor = oldDisplay !== undefined ? this.navWorld.floorFor(oldDisplay) : undefined;
        const sp = floor && this.navWorld.contains(pos, 2) ? this.navWorld.floorPoint(floor, pos.x) : this.navWorld.nearestFloorPoint(this.navWorld.clampInside(pos));
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

function approach(v: number, target: number, maxDelta: number): number {
  if (v < target) return Math.min(target, v + maxDelta);
  if (v > target) return Math.max(target, v - maxDelta);
  return v;
}
