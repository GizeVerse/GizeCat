// The animated cat as pure state: animator -> pose -> rig -> tail. No DOM.
import { CatAnimator, type AnimInput } from './animator';
import type { Pose } from './pose';
import { Rig } from './rig';
import { TailChain, TAIL_RADIUS_TIP, TAIL_SEG_LEN, TAIL_SEGMENTS } from './tail';

/**
 * Once the ground a climbing cat left is this far below its anchor (cat-local DIP), the hanging
 * tail can no longer reach it: the clamp is dropped for the rest of the climb.
 */
const CLIMB_GROUND_REACH = TAIL_SEGMENTS * TAIL_SEG_LEN + 8;

export class CatPuppet {
  readonly animator: CatAnimator;
  readonly rig = new Rig();
  readonly tail = new TailChain();
  /**
   * Ground line relative to the anchor (cat-local DIP, + = below it) while climbing: the floor or
   * ledge the cat climbed up from, which falls away as it climbs. NaN when unknown or out of reach.
   */
  private climbGround = Number.NaN;

  constructor(random: () => number) {
    this.animator = new CatAnimator(random);
  }

  get pose(): Pose {
    return this.animator.pose;
  }

  /**
   * Advances one frame.
   * @param motionX,motionY body motion since the last frame in cat-local DIP (facing-normalised,
   *   divided by scale); the tail lags behind it, the held swing follows it and a climb down a wall
   *   runs the climbing gait backwards.
   */
  advance(input: AnimInput, simTimeMs: number, dtMs: number, motionX: number, motionY: number): void {
    const p = this.animator.update(input, simTimeMs, dtMs, motionX, motionY);
    this.rig.solve(p);
    // The ground clamp only makes sense while the cat is upright and not airborne. A cat on a wall
    // has no ground under it, except the one it just climbed up from: its tail rests on that until
    // the climb lifts it clear.
    const airborne = input.clip === 'held' || input.clip === 'jump' || input.clip === 'fall';
    const climbing = input.clip === 'climb';
    const upright = !airborne && !climbing && Math.abs(p.rot) < 0.3 && p.rollY > 0.6 && p.offY > -2;
    if (climbing) {
      if (Number.isFinite(motionY)) this.climbGround -= motionY;
      if (!(this.climbGround > -1 && this.climbGround < CLIMB_GROUND_REACH)) this.climbGround = Number.NaN;
    } else {
      this.climbGround = upright ? 0 : Number.NaN;
    }
    const lift = -TAIL_RADIUS_TIP * this.tail.puff - 0.4;
    const groundY = upright ? lift : climbing ? this.climbGround + lift : Number.NaN;
    this.tail.step(this.rig.tailRootX, this.rig.tailRootY, p, dtMs, -motionX, -motionY, groundY);
  }

  /** Forget the tail's momentum (teleports, display changes). */
  resetTail(): void {
    this.tail.reset();
    this.climbGround = Number.NaN;
  }
}
