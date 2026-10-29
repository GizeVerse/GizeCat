// Per-taskbar motion state machine over successive geometry samples: hidden / showing /
// shown / hiding, the on-screen fraction and the edge-normal speed. Pure (time is passed in).
//
// Explorer slides an auto-hide taskbar by moving its window; at the idle sampling rate the
// slide is usually not observed and the window appears to jump. A jump larger than
// `jumpPx(thickness)` is eased over EASE_MS so the surface (and a cat riding it) moves
// continuously; while easing the reported geometry is inferred, not measured.
import type { TaskbarState } from '../../contracts';

export type TaskbarPhase = TaskbarState['phase'];

export interface MotionConfig {
  /** Duration over which an unobserved jump is eased. */
  easeMs: number;
  /** A change of more than max(minJumpPx, jumpFraction * thickness) between two samples is a jump. */
  jumpFraction: number;
  minJumpPx: number;
  /** At or below max(hiddenPx, hiddenFraction * thickness) on screen the taskbar is hidden (auto-hide leaves a 1-2 px strip). */
  hiddenPx: number;
  hiddenFraction: number;
  /** Within this many px of the full thickness it is shown. */
  shownTolerancePx: number;
  /**
   * Explorer moves a sliding taskbar every ~15-47 ms (measured), so 16 ms samples often see no
   * change in between: the last speed is held this long after a change instead of dropping to 0,
   * and a change within twice this long of the previous one is divided by the time since it.
   */
  speedHoldMs: number;
}

export const DEFAULT_MOTION_CONFIG: MotionConfig = {
  easeMs: 150,
  jumpFraction: 0.4,
  minJumpPx: 8,
  hiddenPx: 3,
  hiddenFraction: 0.08,
  shownTolerancePx: 1,
  speedHoldMs: 60,
};

interface Ease {
  from: number;
  to: number;
  t0: number;
}

export interface MotionSnapshot {
  /** Effective on-screen extent (px): measured, or eased across a jump. */
  extent: number;
  /** Last measured extent (px). */
  measured: number;
  thickness: number;
  /** extent / thickness, 0..1. */
  fraction: number;
  phase: TaskbarPhase;
  /** d(extent)/dt in px/s: positive while sliding in. */
  extentSpeed: number;
  /** The extent is interpolated across an unobserved jump. */
  inferred: boolean;
}

export class TaskbarMotion {
  private extent = 0;
  private measured = 0;
  private thickness = 1;
  private phaseValue: TaskbarPhase = 'hidden';
  private speed = 0;
  private ease: Ease | null = null;
  private lastAt: number | null = null;
  /** When the measurement last changed (null: never since the first sample). */
  private changedAt: number | null = null;

  constructor(private readonly cfg: MotionConfig = DEFAULT_MOTION_CONFIG) {}

  /** Feeds one measurement (extent on screen, px) taken at `now`. Returns true when the measurement changed. */
  update(now: number, measuredExtent: number, thickness: number): boolean {
    const t = Math.max(1, thickness);
    const raw = Math.max(0, Math.min(t, measuredExtent));
    if (this.lastAt === null) {
      this.lastAt = now;
      this.thickness = t;
      this.measured = raw;
      this.extent = raw;
      this.speed = 0;
      this.phaseValue = this.classify(raw, 0, null);
      return true;
    }
    const dt = Math.max(0, now - this.lastAt);
    const prevExtent = this.effectiveAt(now);
    const changed = raw !== this.measured;
    const jump = Math.abs(raw - this.measured) > Math.max(this.cfg.minJumpPx, this.cfg.jumpFraction * t);
    this.thickness = t;
    if (changed && jump) {
      // Not observed sliding: ease from where the surface is now to the new position.
      this.ease = { from: prevExtent, to: raw, t0: now };
    } else if (this.ease !== null) {
      // Small corrections while easing retarget the ease (continuous to within the correction).
      this.ease.to = raw;
    }
    this.measured = raw;
    if (this.ease !== null && now - this.ease.t0 >= this.cfg.easeMs) this.ease = null;
    const next = this.ease !== null ? this.effectiveAt(now) : raw;
    const sinceChange = this.changedAt === null ? Number.POSITIVE_INFINITY : now - this.changedAt;
    if (this.ease !== null) this.speed = ((this.ease.to - this.ease.from) / this.cfg.easeMs) * 1000;
    else if (changed) {
      // Mid-slide the previous change is recent: the distance covered since it is the frame step.
      const span = sinceChange <= 2 * this.cfg.speedHoldMs ? sinceChange : dt;
      if (span > 0) this.speed = ((next - prevExtent) / span) * 1000;
    } else if (sinceChange > this.cfg.speedHoldMs) this.speed = 0;
    if (changed) this.changedAt = now;
    this.extent = next;
    this.lastAt = now;
    this.phaseValue = this.classify(next, this.speed, this.phaseValue);
    return changed;
  }

  /** Forces the taskbar fully off screen (window gone or invisible). */
  hide(now: number): void {
    this.update(now, 0, this.thickness);
  }

  snapshot(): MotionSnapshot {
    return {
      extent: this.extent,
      measured: this.measured,
      thickness: this.thickness,
      fraction: this.extent / this.thickness,
      phase: this.phaseValue,
      extentSpeed: this.speed,
      inferred: this.ease !== null,
    };
  }

  get easing(): boolean {
    return this.ease !== null;
  }

  private effectiveAt(now: number): number {
    const e = this.ease;
    if (e === null) return this.extent;
    const k = Math.min(1, Math.max(0, (now - e.t0) / this.cfg.easeMs));
    return e.from + (e.to - e.from) * k;
  }

  private classify(extent: number, speed: number, prev: TaskbarPhase | null): TaskbarPhase {
    // Easing across a jump: the direction is known before the surface has moved.
    if (this.ease !== null && this.ease.to !== extent) return this.ease.to > extent ? 'showing' : 'hiding';
    if (extent <= Math.max(this.cfg.hiddenPx, this.cfg.hiddenFraction * this.thickness)) return 'hidden';
    if (extent >= this.thickness - this.cfg.shownTolerancePx) return 'shown';
    if (speed > 0) return 'showing';
    if (speed < 0) return 'hiding';
    // Momentarily still between the two: keep the direction it was going in.
    if (prev === 'shown' || prev === 'hiding') return 'hiding';
    return 'showing';
  }
}
