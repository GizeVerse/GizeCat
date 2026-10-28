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
}

export const DEFAULT_VISUAL_EVENT_THRESHOLDS: Readonly<VisualEventThresholds> = Object.freeze({
  dark: { enter: 0.18, exit: 0.24 },
  bright: { enter: 0.8, exit: 0.74 },
  busy: { enter: 0.14, exit: 0.1 },
  quiet: { enter: 0.03, exit: 0.045 },
  motion: { enter: 0.2, exit: 0.1 },
  still: { enter: 0.01, exit: 0.03 },
  bigChange: 0.35,
});

type StateKind = Exclude<VisualEventKind, 'bigChange'>;

export class VisualEventDeriver {
  private readonly t: VisualEventThresholds;
  private readonly active = new Set<StateKind>();

  constructor(thresholds: Partial<VisualEventThresholds> = {}) {
    this.t = { ...DEFAULT_VISUAL_EVENT_THRESHOLDS, ...thresholds };
  }

  reset(): void {
    this.active.clear();
  }

  derive(f: VisualFeatures): VisualEventKind[] {
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
    const bigChange = f.changeFraction !== null && f.changeFraction >= this.t.bigChange;
    return VISUAL_EVENT_KINDS.filter((k) => (k === 'bigChange' ? bigChange : this.active.has(k)));
  }

  private update(kind: StateKind, enter: boolean, exit: boolean): void {
    if (this.active.has(kind)) {
      if (exit) this.active.delete(kind);
    } else if (enter) {
      this.active.add(kind);
    }
  }
}
