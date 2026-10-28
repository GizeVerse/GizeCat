// Coarse labels derived from VisualFeatures. States (dark, busy, motion, ...)
// use enter/exit thresholds so a value hovering at a boundary does not flicker.
import { VISUAL_EVENT_KINDS, type VisualEventKind, type VisualFeatures } from '../../shared/perception';

export interface Band {
  enter: number;
  exit: number;
}

export interface VisualEventThresholds {
  /** brightness below enter -> dark; leaves dark above exit. */
  dark: Band;
  /** brightness above enter -> bright; leaves below exit. */
  bright: Band;
  /** edgeDensity above enter -> busy. */
  busy: Band;
  /** edgeDensity below enter -> quiet. */
  quiet: Band;
  /** motion above enter -> motion. */
  motion: Band;
  /** motion and changeFraction below enter -> still. */
  still: Band;
  /** changeFraction at/above this -> bigChange (per frame, no state). */
  bigChange: number;
  /**
   * Burst motion and colourfulness both at/above `enter` in `confirmations` analyses in a
   * row -> videoLike; it ends when either falls below its `exit`.
   */
  videoLike: { motion: Band; colorfulness: Band; confirmations: number };
  /**
   * A compact changed area (per frame, no state): the change box covers between `minArea`
   * and `maxArea` of the frame, is at most `maxAspect` times wider than tall on screen (or
   * the reverse, so a strip of freshly typed lines does not count), changed blocks fill at least `minFill` of it, and at most `maxOverlap` of it
   * lies inside the previous analysis' change box (so an area that keeps changing, such
   * as a playing video or the line being typed, does not count again).
   */
  newElement: { minArea: number; maxArea: number; maxAspect: number; minFill: number; maxOverlap: number };
}

export const DEFAULT_VISUAL_EVENT_THRESHOLDS: Readonly<VisualEventThresholds> = Object.freeze({
  dark: { enter: 0.18, exit: 0.24 },
  bright: { enter: 0.8, exit: 0.74 },
  busy: { enter: 0.14, exit: 0.1 },
  quiet: { enter: 0.03, exit: 0.045 },
  motion: { enter: 0.2, exit: 0.1 },
  still: { enter: 0.01, exit: 0.03 },
  bigChange: 0.35,
  videoLike: { motion: { enter: 0.12, exit: 0.05 }, colorfulness: { enter: 0.2, exit: 0.14 }, confirmations: 2 },
  newElement: { minArea: 0.03, maxArea: 0.3, maxAspect: 4, minFill: 0.5, maxOverlap: 0.25 },
});

type StateKind = Exclude<VisualEventKind, 'bigChange' | 'newElement' | 'videoLike'>;
type Box = NonNullable<VisualFeatures['changeBox']>;

export class VisualEventDeriver {
  private readonly t: VisualEventThresholds;
  private readonly active = new Set<StateKind>();
  private videoLike = false;
  private videoStreak = 0;
  /** Change box of the previous analysis (null without one or without a baseline). */
  private prevBox: Box | null = null;

  constructor(thresholds: Partial<VisualEventThresholds> = {}) {
    this.t = { ...DEFAULT_VISUAL_EVENT_THRESHOLDS, ...thresholds };
  }

  reset(): void {
    this.active.clear();
    this.videoLike = false;
    this.videoStreak = 0;
    this.prevBox = null;
  }

  /** `regionAspect` is the analysed region's width / height (change boxes are normalised per axis). */
  derive(f: VisualFeatures, regionAspect = 1): VisualEventKind[] {
    this.update('dark', f.brightness < this.t.dark.enter, f.brightness > this.t.dark.exit);
    this.update('bright', f.brightness > this.t.bright.enter, f.brightness < this.t.bright.exit);
    this.update('busy', f.edgeDensity > this.t.busy.enter, f.edgeDensity < this.t.busy.exit);
    this.update('quiet', f.edgeDensity < this.t.quiet.enter, f.edgeDensity > this.t.quiet.exit);
    this.update('motion', f.motion > this.t.motion.enter, f.motion < this.t.motion.exit);
    if (f.changeFraction === null) {
      this.active.delete('still');
    } else {
      this.update(
        'still',
        f.motion < this.t.still.enter && f.changeFraction < this.t.still.enter,
        f.motion > this.t.still.exit || f.changeFraction > this.t.still.exit,
      );
    }
    this.updateVideoLike(f);
    const bigChange = f.changeFraction !== null && f.changeFraction >= this.t.bigChange;
    const newElement = this.isNewElement(f, Number.isFinite(regionAspect) && regionAspect > 0 ? regionAspect : 1);
    this.prevBox = f.changeFraction === null ? null : f.changeBox;
    return VISUAL_EVENT_KINDS.filter((k) =>
      k === 'bigChange' ? bigChange : k === 'newElement' ? newElement : k === 'videoLike' ? this.videoLike : this.active.has(k),
    );
  }

  private update(kind: StateKind, enter: boolean, exit: boolean): void {
    if (this.active.has(kind)) {
      if (exit) this.active.delete(kind);
    } else if (enter) {
      this.active.add(kind);
    }
  }

  private updateVideoLike(f: VisualFeatures): void {
    const v = this.t.videoLike;
    if (this.videoLike) {
      if (f.motion < v.motion.exit || f.colorfulness < v.colorfulness.exit) {
        this.videoLike = false;
        this.videoStreak = 0;
      }
      return;
    }
    this.videoStreak = f.motion >= v.motion.enter && f.colorfulness >= v.colorfulness.enter ? this.videoStreak + 1 : 0;
    if (this.videoStreak >= Math.max(1, v.confirmations)) this.videoLike = true;
  }

  private isNewElement(f: VisualFeatures, regionAspect: number): boolean {
    const box = f.changeBox;
    if (f.changeFraction === null || box === null) return false;
    const e = this.t.newElement;
    const area = box.width * box.height;
    if (!(area >= e.minArea && area <= e.maxArea)) return false;
    // On screen the box is `regionAspect` times wider than its normalised edges say.
    const w = box.width * regionAspect;
    const aspect = w >= box.height ? w / Math.max(box.height, 1e-6) : box.height / Math.max(w, 1e-6);
    if (aspect > e.maxAspect) return false;
    // Approximate: changeFraction is a share of compared (unmasked) blocks.
    if (f.changeFraction / area < e.minFill) return false;
    const prev = this.prevBox;
    return prev === null || overlapArea(box, prev) / area <= e.maxOverlap;
  }
}

function overlapArea(a: Box, b: Box): number {
  const w = Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x);
  const h = Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y);
  return w > 0 && h > 0 ? w * h : 0;
}
