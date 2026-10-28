// The animated cat as pure state: animator -> pose -> rig -> tail. No DOM.
import { CatAnimator, type AnimInput } from './animator';
import type { Pose } from './pose';
import { Rig } from './rig';
import { TailChain, TAIL_RADIUS_TIP } from './tail';

export class CatPuppet {
  readonly animator: CatAnimator;
  readonly rig = new Rig();
  readonly tail = new TailChain();

  constructor(random: () => number) {
    this.animator = new CatAnimator(random);
  }

  get pose(): Pose {
    return this.animator.pose;
  }

  /**
   * Advances one frame.
   * @param motionX,motionY body motion since the last frame in cat-local DIP (facing-normalised,
   *   divided by scale); the tail lags behind it and the held swing follows it.
   */
  advance(input: AnimInput, simTimeMs: number, dtMs: number, motionX: number, motionY: number): void {
    const p = this.animator.update(input, simTimeMs, dtMs, motionX);
    this.rig.solve(p);
    // The ground clamp only makes sense while the cat is upright and not airborne.
    const airborne = input.clip === 'held' || input.clip === 'jump' || input.clip === 'fall';
    const upright = !airborne && Math.abs(p.rot) < 0.3 && p.rollY > 0.6 && p.offY > -2;
    const groundY = upright ? -TAIL_RADIUS_TIP * this.tail.puff - 0.4 : Number.NaN;
    this.tail.step(this.rig.tailRootX, this.rig.tailRootY, p, dtMs, -motionX, -motionY, groundY);
  }

  /** Forget the tail's momentum (teleports, display changes). */
  resetTail(): void {
    this.tail.reset();
  }
}
