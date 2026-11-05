// v1.2 movement test fixtures (ADR 0003 §6): self-contained display / surface builders and a
// driver that emulates the host's provider, so the v1.2 movement suites depend on nothing but
// the movement package and the shared contract (the behaviour package changes in parallel).
import { expect } from 'vitest';
import type { Rect } from '../../../../src/shared/geometry';
import type { LedgeSurface, Surface, SurfaceKind, TaskbarEdge, WallSurface } from '../../../../src/shared/surfaces';
import type { DisplayGeometry, WorldGeometry } from '../../../../src/shared/world';
import type { LandingInfo, MoveGoal, MoverConfig, MoverStep } from '../../../../src/core/movement';
import { Mover } from '../../../../src/core/movement';

export function display(id: string, x: number, y: number, w: number, h: number, opts: { scale?: number; primary?: boolean; taskbar?: number; leftTaskbar?: number } = {}): DisplayGeometry {
  const scale = opts.scale ?? 1;
  const taskbar = opts.taskbar ?? 0;
  const left = opts.leftTaskbar ?? 0;
  const boundsPx = { x, y, width: w, height: h };
  const workAreaPx = { x: x + left, y, width: w - left, height: h - taskbar };
  const dip = (r: Rect): Rect => ({ x: r.x / scale, y: r.y / scale, width: r.width / scale, height: r.height / scale });
  return { id, primary: opts.primary ?? false, scaleFactor: scale, boundsPx, workAreaPx, boundsDip: dip(boundsPx), workAreaDip: dip(workAreaPx) };
}

export function world(...displays: DisplayGeometry[]): WorldGeometry {
  return { version: 1, displays };
}

/** 1920x1080 with a 40 px taskbar: floor y = 1040, floor walk range [42, 1878] (body 84 x 64 px). */
export const SINGLE = world(display('1', 0, 0, 1920, 1080, { primary: true, taskbar: 40 }));
export const BW = 84;
export const BH = 64;
export const FLOOR_Y = 1040;

export const topId = (windowId: string): string => `windowTop:${windowId}`;
export const sideId = (windowId: string, side: 'left' | 'right'): string => `windowSide:${windowId}:${side}`;
export const stripId = (windowId: string): string => `tabStrip:${windowId}`;
export const edgeId = (displayId: string, side: 'left' | 'right'): string => `screenEdge:${displayId}:${side}`;

const BASE = { phase: 'stable' as const, vx: 0, vy: 0, confidence: 1, validatedAt: 0, excluded: false };

export function ledge(id: string, kind: Exclude<SurfaceKind, 'windowSide'>, ownerId: string, y: number, x0: number, x1: number, extra: Partial<LedgeSurface> = {}): LedgeSurface {
  return { ...BASE, id, kind, ownerId, displayId: null, orientation: 'ledge', y, x0, x1, rest: null, focusX: null, ...extra };
}

export function wall(windowId: string, side: 'left' | 'right', x: number, y0: number, y1: number, extra: Partial<WallSurface> = {}): WallSurface {
  return { ...BASE, id: sideId(windowId, side), kind: 'windowSide', ownerId: windowId, displayId: null, orientation: 'wall', x, y0, y1, side, topLedgeId: topId(windowId), ...extra };
}

export function taskbar(hwnd: string, d: DisplayGeometry, top: number, edge: TaskbarEdge = 'bottom'): LedgeSurface {
  return ledge(`taskbar:${hwnd}`, 'taskbar', hwnd, top - 1, d.boundsPx.x, d.boundsPx.x + d.boundsPx.width, { displayId: d.id, edge });
}

/** A window's bare top edge and (optionally) both sides, like the v1.1 movement fixtures. */
export function windowSurfaces(id: string, r: Rect, walls = true): Surface[] {
  const out: Surface[] = [ledge(topId(id), 'windowTop', id, r.y, r.x, r.x + r.width)];
  if (walls) out.push(wall(id, 'left', r.x, r.y, r.y + r.height), wall(id, 'right', r.x + r.width, r.y, r.y + r.height));
  return out;
}

export const CFG: MoverConfig = { size: 1, movementSpeed: 1, allowMultiMonitor: true, perchOnWindows: true };

/** Default jump-down limits of ADR 0003 §6.3 (H_safe ~477 DIP, H_max ~644 DIP). */
export const DEFAULT_LIMITS = { jumpDownSafeDip: 477, jumpDownMaxDip: 644 } as const;

/** Every v1.2 movement flag on, with the default limits. */
export const V12: Partial<MoverConfig> = { screenEdges: true, narrowLedges: true, bailOut: true, wallJumps: true, ...DEFAULT_LIMITS };

/**
 * Emulates the host: windows (front first) become a top and two sides; `extra` adds hand-made
 * surfaces; `hidden` leaves ids out of the list while getSurface still serves them; `gone` makes
 * getSurface return null; `patch` overrides served fields (confidence, geometry) per id.
 */
export class Env {
  now = 0;
  windows: Record<string, Rect | null> = {};
  walls = true;
  extra: Surface[] = [];
  hidden = new Set<string>();
  gone = new Set<string>();
  patch = new Map<string, Partial<Surface>>();
  log: MoverStep[] = [];
  dragCursor: { x: number; y: number } | null = null;
  /** Windows the user is moving (MoverInput.movingWindowIds). */
  moving = new Set<string>();
  /** Every step stays finite and inside some work area. */
  checkInside = true;

  constructor(
    public m: Mover,
    public w: WorldGeometry,
  ) {}

  surfaces(): Surface[] {
    const out: Surface[] = [];
    for (const [id, r] of Object.entries(this.windows)) if (r) out.push(...windowSurfaces(id, r, this.walls));
    out.push(...this.extra);
    return out.map((s) => {
      const p = this.patch.get(s.id);
      return p ? ({ ...s, ...p } as Surface) : s;
    });
  }

  step(dt = 16): MoverStep {
    this.now += dt;
    const all = this.surfaces();
    const byId = new Map(all.map((s) => [s.id, s] as const));
    this.m.sense(all.filter((s) => !this.hidden.has(s.id)));
    const r = this.m.step({ now: this.now, dtMs: dt, dragCursor: this.dragCursor, movingWindowIds: this.moving, getSurface: (id) => (this.gone.has(id) ? null : (byId.get(id) ?? null)) });
    this.log.push(r);
    expect(Number.isFinite(this.m.x) && Number.isFinite(this.m.y)).toBe(true);
    if (this.checkInside) {
      const ok = this.w.displays.some((d) => this.m.x >= d.workAreaPx.x - 2.5 && this.m.x <= d.workAreaPx.x + d.workAreaPx.width + 2.5 && this.m.y >= d.workAreaPx.y - 2.5 && this.m.y <= d.workAreaPx.y + d.workAreaPx.height + 2.5);
      expect(ok, `inside at ${this.m.x},${this.m.y}`).toBe(true);
    }
    return r;
  }

  until(pred: (r: MoverStep) => boolean, maxMs: number, dt = 16): boolean {
    const end = this.now + maxMs;
    while (this.now < end) if (pred(this.step(dt))) return true;
    return false;
  }

  /** Steps until the next landing and returns it (null on timeout). */
  nextLanding(maxMs: number, dt = 16): LandingInfo | null {
    let landed: LandingInfo | null = null;
    this.until((r) => {
      landed = r.landed;
      return landed !== null;
    }, maxMs, dt);
    return landed;
  }

  goal(g: Partial<MoveGoal> & { x: number; y: number }): void {
    this.m.setGoal({ pace: 'walk', allowJump: true, ...g });
  }

  /** Carries the cat (held) to just above (x, y) and drops it there; returns the landing. */
  dropAt(x: number, y: number): LandingInfo | null {
    this.m.startDrag({ x: this.m.x, y: this.m.y });
    this.dragCursor = { x, y: y - 100 };
    for (let i = 0; i < 40; i++) this.step();
    this.dragCursor = null;
    this.m.endDrag(null, { x: 0, y: 0 }, this.now, false);
    return this.nextLanding(3000);
  }

  /** Puts the cat on the ledge `surfaceId` (top y) near x and checks it stands there. */
  placeOn(surfaceId: string, x: number, y: number): void {
    expect(this.dropAt(x, y)).not.toBeNull();
    expect(this.m.support, 'placed').toMatchObject({ kind: 'surface', surfaceId });
  }
}

export function env(w: WorldGeometry = SINGLE, cfg: Partial<MoverConfig> = {}, xFrac = 0.5, displayId: string | null = '1'): Env {
  const e = new Env(new Mover(w, { ...CFG, ...cfg }, { displayId, xFrac }), w);
  e.step();
  return e;
}
