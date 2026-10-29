// Test driver for the Mover: emulates the host's surface provider (window tops and sides
// from plain window rects, plus taskbars / tab strips added by the test), with knobs for the
// provider's lag (`hidden`: listed surfaces missing while still live) and for vanished
// surfaces (`gone`: getSurface returns null).
import type { Point, Rect } from '../../../../src/shared/geometry';
import type { Surface } from '../../../../src/shared/surfaces';
import type { WorldGeometry } from '../../../../src/shared/world';
import type { MoveGoal, Mover, MoverStep } from '../../../../src/core/movement';
import { surfacesFromWindows } from '../behavior/fixtures';

export class SurfaceDriver {
  now = 0;
  windows: Record<string, Rect | null> = {};
  /** Taskbars, tab strips or hand-made surfaces, listed after the windows' ones. */
  extra: Surface[] = [];
  /** Window sides are listed (climbing allowed on the host). */
  walls = true;
  /** Surface ids left out of the list (occluded, stale list) while getSurface still returns them. */
  hidden = new Set<string>();
  /** Surface ids getSurface reports as gone while they may still be listed (list lag). */
  gone = new Set<string>();
  dragCursor: Point | null = null;
  moving = new Set<string>();
  log: MoverStep[] = [];
  getSurfaceCalls = 0;
  /** Replaces the provider's live lookup (malformed answers, throwing providers). */
  liveOverride: ((id: string) => Surface | null) | null = null;

  constructor(
    public m: Mover,
    public w: WorldGeometry,
  ) {}

  surfaces(): Surface[] {
    return [...surfacesFromWindows(this.windows, this.w, { walls: this.walls, now: this.now }), ...this.extra];
  }

  step(dt = 16): MoverStep {
    this.now += dt;
    const all = this.surfaces();
    const byId = new Map(all.map((s) => [s.id, s] as const));
    this.m.sense(all.filter((s) => !this.hidden.has(s.id)));
    const r = this.m.step({
      now: this.now,
      dtMs: dt,
      dragCursor: this.dragCursor,
      getSurface: (id) => {
        this.getSurfaceCalls++;
        if (this.liveOverride) return this.liveOverride(id);
        return this.gone.has(id) ? null : (byId.get(id) ?? null);
      },
      movingWindowIds: this.moving,
    });
    this.log.push(r);
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
