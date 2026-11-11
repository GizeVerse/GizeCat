// The cat simulation, layer 10: Laser Mode, reduced motion and the body-care variety of the Living
// Companion (the world-event layer is simCompanion.ts; the pure rules are laser.ts and reducedMotion.ts).
//
// LASER MODE. While env.laserMode is on and the cursor is on the cat's display, the cat treats the cursor
// as a light: one 'walking' activity with the variant 'laser' follows it, sits and watches it, reaches
// toward it with the pawAt clip and now and then hops at it. It holds laserStandoffPx short of it,
// horizontally, always, and never closes that gap: no hunt, no pounce, no 'caught', no hunt or pounce
// counters or memories, no catch emote. The dot IS the real cursor and the overlay must never block the
// user, so the stand-off also keeps the whole paw reach and the click-through clearance (T8) between the
// hit region and the hotspot, and a pressed button, typing, a drag, a pause, a hidden or fullscreen
// display and every physical state take priority: the cat lets go of the light and lets the user click.
// Following costs stamina (a chase budget scaled by the personality), so the cat sits, grooms or yawns
// and only then goes back to the light; it is never an endless loop.
//
// REDUCED MOTION. One policy (reducedMotion.ts): no running by choice, only hops for jumps, calmer
// reactions, a slower cadence. Drags, throws and falls are the user's and the world's and stay as they are.
//
// BODY CARE. Grooming gets variants (face wash, paw wash, scratch), a cat settling to sleep gets a
// small sit or stretch before its yawn, and a flourish (shake, confused) is played over an idle body.
//
// Randomness: every draw of this layer comes from two streams derived from the cat id and the session
// counter (laserRandom, careRandom), never from the main one, so a seeded run that never uses Laser Mode
// and never reaches a body-care variant draws exactly what it drew before. The only main-stream draws are
// those of the existing machinery this layer starts (an idle activity's pose, an edge visit's hold).
import { canSwitch, resolveClip } from '../../shared/animationCatalog';
import type { AnimClip, BehaviorState, CatReactionKind, Emote, Facing } from '../../shared/cat';
import type { Point } from '../../shared/geometry';
import { disabledBehaviorSet } from '../../shared/settings';
import type { BehaviorId } from '../../shared/settings';
import type { Pace, RoutePreference } from '../movement';
import type { Activity, ActivityInit, FollowUp } from './activity';
import type { Phase } from './clips';
import { requiredClearancePx, strikeClearancePx } from './hunt';
import { laserBreakMs, laserChaseBudgetMs, laserDecision } from './laser';
import type { Random } from './random';
import { chance, mulberry32, range } from './random';
import { calmDwell, calmPace, motionPolicy, withMotionOptOuts } from './reducedMotion';
import { SimCompanion } from './simCompanion';
import type { RequestStatus, SimHooks } from './simCore';
import type { CatSimOptions } from '../../shared/sim';
import { ASLEEP_STATES, PHYSICAL_STATES, REACTION_STATES } from './states';
import { addStat } from './stats';
import type { TransitionCause } from './states';

/** Laser Mode wakes a sleeping cat only after the dot has been around this long (the cat wakes gently, never at once). */
export const LASER_WAKE_DELAY_MS = 2500;
/** After a press (or while a button is down) the cat leaves the light alone for this long: it never stands in the way of a click. */
export const LASER_PRESS_PAUSE_MS = 4000;
/** A command or a touch of the user owns the cat's activity for this long: the light waits. */
const LASER_USER_HOLD_MS = 8000;
/** The dot may be missing this long (a display change, a hitch) before the cat gives up on it. */
const LASER_LOST_GRACE_MS = 700;
/** Following for at least this long before the dot vanishes makes the cat look confused about it. */
const LASER_CONFUSED_MIN_MS = 2500;
/** Reaching for a resting dot: how long a paw stays out and how long the cat waits before the next. */
const LASER_REACH_ON_MS: readonly [number, number] = [1100, 2200];
const LASER_REACH_OFF_MS: readonly [number, number] = [1800, 4200];
/** Two hops at the dot are at least this far apart. */
const LASER_HOP_GAP_MS = 2600;
/** A dot that has rested this long lets the cat settle into a loaf. */
const LASER_SETTLE_IDLE_MS = 12_000;
/** After a goal the Mover calls unreachable the cat just watches for this long. */
const LASER_NO_GO_MS = 1500;
/** A climb toward a dot on a side edge is tried at most this often, and only for a dot this close (body widths) to the edge. */
const LASER_EDGE_TRY_MS = 4000;
const LASER_EDGE_NEAR_BW = 2.5;
/** Energy spent by following, per second. */
const LASER_ENERGY_RUN = 0.0025;
const LASER_ENERGY_WALK = 0.001;
/** Probability of the confused flourish after a prey cursor vanished mid-hunt, and of the shake after an annoyed or a hard landing. */
const CONFUSED_AFTER_HUNT_P = 0.5;
const CONFUSED_AFTER_LASER_P = 0.7;
const SHAKE_AFTER_ANNOYED_P = 0.25;
const SHAKE_AFTER_LANDING_P = 0.35;
/** Settling to sleep: a sit or a stretch leads into the yawn (the total stays what it was: the lead takes time from the yawn). */
const SETTLE_SIT_P = 0.25;
const SETTLE_STRETCH_P = 0.17;
const SETTLE_SIT_MS = 450;
const SETTLE_STRETCH_MS = 500;

/** Autonomous and stimulus requests for these are refused while the laser body runs: the light is not prey and not a thing to hunt or study. */
const LASER_REFUSED: ReadonlySet<BehaviorState> = new Set<BehaviorState>(['chasingCursor', 'watchingCursor', 'curious', 'playing', 'seekingAttention']);

type LaserEnd = 'off' | 'blocked' | 'press' | 'typing' | 'lost' | 'tired';

/** FNV-1a over a few parts with a salt: the seed of one of this layer's own random streams. */
function seedOf(salt: string, ...parts: Array<string | number>): number {
  let h = 0x811c9dc5;
  for (const part of [salt, ...parts]) {
    const s = String(part);
    for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 0x01000193);
    h = Math.imul(h ^ 0x7c, 0x01000193);
  }
  return h >>> 0;
}

export abstract class SimLaser extends SimCompanion {
  private readonly laserRandom: Random;
  private readonly careRandom: Random;
  // ---- reduced motion ----
  private reducedApplied = false;
  private baseDisabled: ReadonlySet<BehaviorId> | null = null;
  // ---- laser ----
  private laserWasOn = false;
  private laserDotSeenAt = -Infinity;
  private laserPressAt = -Infinity;
  private laserPrevButton = false;
  private laserWakeSince: number | null = null;
  private laserBreakUntil = -Infinity;
  private laserChaseMs = 0;
  private laserBodyMs = 0;
  private laserEngaged = false;
  private laserReachUntil = -Infinity;
  private laserReachOffUntil = -Infinity;
  private laserLastHopAt = -Infinity;
  private laserNoGoUntil = -Infinity;
  private laserEdgeTryAt = -Infinity;

  constructor(opts: CatSimOptions, hooks: SimHooks = {}) {
    super(opts, hooks);
    const id = this.cat.catId;
    const sessions = this.cat.memory.counters.sessions;
    this.laserRandom = mulberry32(seedOf('laser', id, sessions));
    this.careRandom = mulberry32(seedOf('care', id, sessions));
  }

  // ---- reduced motion --------------------------------------------------------------------------------

  /** The effective opt-outs for the settings, under the current motion policy; remembers the user's own set. */
  protected withMotionPolicy(base: ReadonlySet<BehaviorId>): ReadonlySet<BehaviorId> {
    this.reducedApplied = this.reducedNow();
    this.baseDisabled = base;
    return withMotionOptOuts(base, motionPolicy(this.reducedApplied));
  }

  /** The opt-outs the user chose themselves (without what reduced motion adds): hops follow these. */
  protected userOptOuts(): ReadonlySet<BehaviorId> {
    return this.reducedApplied && this.baseDisabled ? this.baseDisabled : this.disabled;
  }

  /** Follows env.reducedMotion and the setting: a change recomputes the opt-outs and the Mover's jump rules. */
  protected syncMotionPolicy(): void {
    const reduced = this.reducedNow();
    if (reduced === this.reducedApplied) return;
    this.disabled = this.withMotionPolicy(disabledBehaviorSet(this.settings.behavior));
    if (this.mover.setConfig(this.moverConfig())) this.snapNext = true;
  }

  /** Every walk the sim starts goes through here: no running or sprinting by choice under reduced motion. */
  protected override goTo(p: Point, pace: Pace, allowJump: boolean, arriveRadiusPx?: number, opts: { route?: RoutePreference; literal?: boolean; surfaceId?: string } = {}): void {
    super.goTo(p, calmPace(pace, motionPolicy(this.reducedNow())), allowJump, arriveRadiusPx, opts);
  }

  protected override dwellFor(state: BehaviorState): number {
    const ms = super.dwellFor(state);
    return this.reducedNow() ? calmDwell(ms, motionPolicy(true)) : ms;
  }

  /** Decorative body-language overlays (ear and tail flicks, a head tilt) are dropped under reduced motion. */
  protected override react(kind: CatReactionKind): boolean {
    if (this.reducedNow()) return false;
    return super.react(kind);
  }

  // ---- the per-tick step ---------------------------------------------------------------------------------

  /** Once per tick, after the world-event layer and before the activity is updated. */
  protected stepLaser(): void {
    const env = this.env;
    if (!env) return;
    const on = env.laserMode === true;
    if (on !== this.laserWasOn) this.noteLaserEdge(on);
    if (!on) {
      this.laserWakeSince = null;
      return;
    }
    // A press, or a button held down, is the user's: the cat leaves the light alone for a few seconds.
    const down = env.pointerButtonDown === true;
    if (down) this.laserPressAt = this.now;
    else if (this.laserPrevButton) this.laserPressAt = this.now;
    this.laserPrevButton = down;
    if (this.lastPressAt > this.laserPressAt) this.laserPressAt = this.lastPressAt;

    const dot = this.laserDot();
    if (dot) this.laserDotSeenAt = this.now;
    this.laserWake(dot);
    if (this.act.variant === 'laser' && !this.act.done) return;
    if (dot && this.laserBlocked() === null && this.laserMayTake()) this.laserTake();
  }

  private noteLaserEdge(on: boolean): void {
    this.laserWasOn = on;
    this.laserChaseMs = 0;
    this.laserBodyMs = 0;
    this.laserEngaged = false;
    this.laserBreakUntil = -Infinity;
    this.laserNoGoUntil = -Infinity;
    this.laserWakeSince = null;
    // The user's game with the cat starts: a running world event ends at once, none starts beside it.
    if (on) this.events.interrupt('user');
  }

  /** The dot: the cursor, when it is on the display the cat is on (the cat never follows it across a gap or onto a fullscreen display). */
  private laserDot(): Point | null {
    const c = this.env?.cursor;
    if (!c || !Number.isFinite(c.x) || !Number.isFinite(c.y)) return null;
    const p = { x: c.x, y: c.y };
    return this.preyGeometry(p).sameDisplay ? p : null;
  }

  /** Why the cat may not follow the light right now (null: it may). */
  private laserBlocked(): 'mode' | 'fullscreen' | 'press' | 'typing' | 'break' | 'user' | null {
    const env = this.env;
    const m = this.mover;
    if (!env || this.mode !== 'normal' || env.hidden || env.paused) return 'mode';
    const fs: unknown = env.fullscreenDisplayIds;
    if (Array.isArray(fs) && fs.includes(m.displayId)) return 'fullscreen';
    if (this.now - this.laserPressAt < LASER_PRESS_PAUSE_MS) return 'press';
    if (this.typingGate()) return 'typing';
    if (m.held || env.dragCursor !== null) return 'user';
    if (this.now < this.laserBreakUntil) return 'break';
    return null;
  }

  /** May the laser body take the cat's activity? Never from the physics, the user, a reaction playing out or a trip of its own. */
  private laserMayTake(): boolean {
    const a = this.act;
    const s = a.state;
    const m = this.mover;
    if (a.variant === 'laser') return true;
    if (PHYSICAL_STATES.has(s) || s === 'away' || s === 'beingPetted' || m.held || m.airborne || m.onWall) return false;
    if (ASLEEP_STATES.has(s) || s === 'wakingUp') return false;
    if (REACTION_STATES.has(s) && !a.done) return false;
    if ((a.cause === 'command' || a.cause === 'interaction') && this.now - a.startedAt < LASER_USER_HOLD_MS) return false;
    if (this.pending || this.edgeVisit !== null || this.stay?.leaving) return false;
    return true;
  }

  private laserTake(): void {
    if (this.request('walking', 'completion', { variant: 'laser' }) !== 'ok') return;
    this.laserEngaged = false;
    this.laserNoGoUntil = -Infinity;
  }

  /** A sleeping cat is woken by the light through the existing wake path, after a short delay (never at once). */
  private laserWake(dot: Point | null): void {
    const a = this.act;
    if (!ASLEEP_STATES.has(a.state) || a.variant === 'intro' || a.variant === 'forced' || a.cause === 'command' || !dot || this.laserBlocked() !== null) {
      this.laserWakeSince = null;
      return;
    }
    this.laserWakeSince ??= this.now;
    if (this.now - this.laserWakeSince < LASER_WAKE_DELAY_MS || this.pending) return;
    this.laserWakeSince = null;
    this.request('wakingUp', 'completion', {});
  }

  // ---- the laser body -----------------------------------------------------------------------------------------

  protected override updMove(a: Activity): void {
    if (a.variant === 'laser') {
      this.updLaser(a);
      return;
    }
    super.updMove(a);
  }

  /** The head follows the light while the laser body runs. */
  protected override lookForState(): Point | null {
    if (this.act.variant === 'laser') return this.laserDot();
    return super.lookForState();
  }

  /** Autonomous hunts, watches and studies are not started over the laser body. */
  protected override request(to: BehaviorState, cause: TransitionCause, init: ActivityInit = {}): RequestStatus {
    if ((cause === 'autonomous' || cause === 'stimulus') && LASER_REFUSED.has(to) && this.act.variant === 'laser' && !this.act.done && this.laserModeOn()) return 'blocked';
    return super.request(to, cause, init);
  }

  private updLaser(a: Activity): void {
    const env = this.env;
    const m = this.mover;
    if (!env || !this.laserModeOn()) {
      this.endLaser(a, 'off');
      return;
    }
    const blocked = this.laserBlocked();
    if (blocked !== null) {
      this.endLaser(a, blocked === 'press' ? 'press' : blocked === 'typing' ? 'typing' : blocked === 'break' ? 'tired' : 'blocked');
      return;
    }
    const dot = this.laserDot();
    if (!dot) {
      if (this.now - this.laserDotSeenAt > LASER_LOST_GRACE_MS) this.endLaser(a, 'lost');
      else this.stop();
      return;
    }
    this.laserBodyMs += this.dt;

    const bw = m.bodyWidth;
    const bh = m.bodyHeight;
    const scale = m.scale;
    const size = this.settings.appearance.size;
    const range0 = m.walkRange;
    const c = env.cursor;
    const speed = c && Number.isFinite(c.speed) ? Math.max(0, c.speed) / scale : 0;
    const dir: Facing = dot.x >= m.x ? 1 : -1;
    const clearanceOk = strikeClearancePx('pawAt', { x: m.x, y: m.y }, dir, dot, scale, size, { bw, bh }) >= requiredClearancePx(scale);
    const opt = this.userOptOuts();
    const budget = laserChaseBudgetMs(this.knobs.chaseDuration, this.cat.stats.energy);
    const idleMs = this.cursorIdle();
    const reduced = this.reducedNow();
    // A goal the Mover called unreachable (the light is on another surface): just watch for a moment.
    if (a.goalStatus === 'unreachable') {
      a.goalStatus = 'none';
      this.laserNoGoUntil = this.now + LASER_NO_GO_MS;
    }
    const noGo = this.now < this.laserNoGoUntil;
    const d = laserDecision({
      catX: m.x,
      dotX: dot.x,
      dyBh: (m.y - dot.y) / bh,
      bodyWidth: bw,
      bodyHeight: bh,
      scale,
      size,
      walkMin: range0 ? range0.x0 : null,
      walkMax: range0 ? range0.x1 : null,
      dotSpeedDip: speed,
      dotIdleMs: idleMs,
      energy: this.cat.stats.energy,
      staminaLeft: budget > 0 ? Math.max(0, 1 - this.laserChaseMs / budget) : 0,
      restBias: this.knobs.restBias,
      playAppetite: this.knobs.playAppetite,
      engaged: this.laserEngaged,
      reduced,
      reachAllowed: !opt.has('pawAtCursor') && clearanceOk && m.grounded && m.balance <= 0,
      hopAllowed: !opt.has('pounce') && !opt.has('surfaceHops'),
      hopReady: this.laserHopReady(dir),
    });

    m.faceToward(dot.x, this.now);
    if (d.mode !== 'hold' && d.goalX !== null && !noGo) {
      this.laserEngaged = true;
      this.laserChaseMs += this.dt;
      const run = d.mode === 'run';
      addStat(this.cat.stats, 'energy', -(run ? LASER_ENERGY_RUN : LASER_ENERGY_WALK) * (this.dt / 1000));
      this.laserGo(d.goalX, calmPace(run ? 'run' : 'walk', motionPolicy(reduced)));
      if (a.phase !== 'approach') this.phase(a, 'approach');
    } else {
      this.laserEngaged = false;
      this.stop();
      this.laserChaseMs = Math.max(0, this.laserChaseMs - 0.5 * this.dt);
      if (d.hop && this.laserHop(dir)) return;
      if (this.laserEdgeClimb(dot)) return;
      this.laserHoldPose(a, d.reach, idleMs);
    }
    if (this.laserChaseMs >= budget) this.endLaser(a, 'tired');
  }

  /** The cat's own goal setter: no hold-still pause (the stand-off, not a pause, keeps the hit region off the hotspot), never a jump. */
  private laserGo(x: number, pace: Pace): void {
    const m = this.mover;
    this.goalPoint = { x, y: m.y };
    m.setGoal({ x, y: m.y, pace, allowJump: false, arriveRadiusPx: 0.2 * m.bodyWidth });
  }

  /** Sitting and watching, a paw out now and then toward a resting dot, a loaf when it stays still for long. */
  private laserHoldPose(a: Activity, reach: boolean, idleMs: number): void {
    const appetite = this.knobs.playAppetite;
    let want: Phase = a.phase === 'pawAt' ? 'pawAt' : idleMs >= LASER_SETTLE_IDLE_MS ? 'loaf' : 'sit';
    if (reach) {
      if (a.phase === 'pawAt') {
        if (this.now >= this.laserReachUntil) {
          want = 'sit';
          this.laserReachOffUntil = this.now + range(this.laserRandom, LASER_REACH_OFF_MS[0], LASER_REACH_OFF_MS[1]);
        }
      } else if (this.now >= this.laserReachOffUntil && chance(this.laserRandom, 1 - Math.exp((-(0.25 + 0.9 * appetite) * this.dt) / 1000))) {
        want = 'pawAt';
        this.laserReachUntil = this.now + range(this.laserRandom, LASER_REACH_ON_MS[0], LASER_REACH_ON_MS[1]);
      }
    } else if (a.phase === 'pawAt') {
      want = idleMs >= LASER_SETTLE_IDLE_MS ? 'loaf' : 'sit';
    }
    if (a.phase !== want) this.phase(a, want);
  }

  private laserHopReady(dir: Facing): boolean {
    const m = this.mover;
    return this.now - this.laserLastHopAt >= LASER_HOP_GAP_MS && m.grounded && !m.onWall && m.facing === dir && !this.typingGate() && this.act.state === 'walking';
  }

  /** A small hop at a dot overhead (the walk is the state the table lets jump); a refused hop is a puzzled look. */
  private laserHop(dir: Facing): boolean {
    const m = this.mover;
    if (!this.laserHopReady(dir)) return false;
    this.laserLastHopAt = this.now;
    if (m.hop(this.now) && this.request('jumping', 'physical', { suspend: true }) === 'ok') {
      this.fallReason = 'jump';
      return true;
    }
    m.cancelCrouch();
    this.maybeConfused(CONFUSED_AFTER_LASER_P);
    return false;
  }

  /**
   * A dot up on a side edge of the screen: the existing screen-edge machinery may climb toward it, only
   * with the host's edge bands (edgesOn), a full climb and the scanner's own gates (cooldown, typing,
   * cursor clearance). Anything else and the cat just looks up.
   */
  private laserEdgeClimb(dot: Point): boolean {
    const m = this.mover;
    if (!this.edgesOn || this.edgeVisit !== null || !m.grounded || m.attachedSurface !== null || this.now - this.laserEdgeTryAt < LASER_EDGE_TRY_MS) return false;
    if ((m.y - dot.y) / m.bodyHeight < 1) return false;
    const d = m.fullWorldModel.displayAt(dot);
    if (!d) return false;
    const wa = d.workAreaPx;
    const near = LASER_EDGE_NEAR_BW * m.bodyWidth;
    const side: 'left' | 'right' | null = dot.x - wa.x <= near ? 'left' : wa.x + wa.width - dot.x <= near ? 'right' : null;
    if (side === null) return false;
    this.laserEdgeTryAt = this.now;
    const t = this.scanEdge();
    if (!t || t.peek || t.side !== side) return false;
    if (this.request('walking', 'completion', { variant: 'screenEdge', target: t.point, dwellMs: 30_000 }) !== 'ok') return false;
    this.laserEngaged = false;
    return true;
  }

  /** Lets go of the light: a calm sit (or a groom or a stretch after a tiring chase), never a teleport. */
  private endLaser(a: Activity, why: LaserEnd): void {
    this.stop();
    this.laserEngaged = false;
    let next: FollowUp = { state: 'idle', init: {} };
    if (why === 'tired') {
      this.laserBreakUntil = this.now + laserBreakMs(this.knobs.restBias, this.laserRandom());
      this.laserChaseMs = 0;
      next = this.subAllowed('groom') && !this.disabled.has('grooming') ? { state: 'grooming', init: {} } : { state: 'idle', init: { variant: 'stretch' } };
    } else if (why === 'lost' && this.laserBodyMs >= LASER_CONFUSED_MIN_MS) {
      this.maybeConfused(CONFUSED_AFTER_LASER_P);
    }
    this.laserBodyMs = 0;
    if (a.phase !== 'sit') this.phase(a, 'sit');
    this.finish(next);
  }

  // ---- body care ---------------------------------------------------------------------------------------------------

  /** A one-shot flourish over an idle body, honouring the catalogue's priorities (a non-interruptible clip finishes first). */
  protected careClip(clip: AnimClip, ms: number, emote: Emote | null = null): boolean {
    const m = this.mover;
    const c = resolveClip(clip, { walls: false, ledges: m.attachedSurface !== null });
    if (!canSwitch(this.clip, c, Math.max(0, (this.now - this.clipStartedAt) / 1000))) return false;
    this.playOneShot(c, ms);
    if (emote) this.emotes.show(emote, this.now);
    return true;
  }

  /** The confused flourish (head tilting, one ear up) with probability `p` from the care stream. */
  protected maybeConfused(p: number): boolean {
    if (!chance(this.careRandom, p)) return false;
    return this.careClip('confused', 2200, 'question');
  }

  /** The prey cursor vanished mid-hunt: a puzzled look follows the end of the hunt. */
  protected override loseInterest(a: Activity): void {
    const preyGone = !this.env?.cursor;
    super.loseInterest(a);
    if (preyGone) this.maybeConfused(CONFUSED_AFTER_HUNT_P);
  }

  protected override enterActivity(a: Activity): void {
    super.enterActivity(a);
    if (a.state === 'grooming' && a.variant !== 'event') this.beginCare(a);
    else if (a.state === 'fallingAsleep' && !a.quick) this.beginSettle(a);
  }

  /** A shake-off after being annoyed for a while or after a hard landing (small odds, care stream). */
  protected override exitActivity(a: Activity): void {
    super.exitActivity(a);
    if (this.mode !== 'normal' || this.now - a.startedAt < 600) return;
    if (a.state === 'annoyed' && chance(this.careRandom, SHAKE_AFTER_ANNOYED_P)) this.careClip('shake', 1100);
    else if (a.state === 'landing' && a.phase === 'recover' && chance(this.careRandom, SHAKE_AFTER_LANDING_P)) this.careClip('shake', 1100);
  }

  protected override updateActivity(): void {
    const a = this.act;
    if (!a.done) {
      if (a.state === 'fallingAsleep' && (a.phase === 'sit' || a.phase === 'stretch') && this.phaseElapsed(a)) {
        const rest = a.counter > 0 ? a.counter : 750;
        a.counter = 0;
        this.phase(a, 'yawn', rest);
      } else if (a.state === 'grooming' && a.variant !== 'event') this.updCare(a);
    }
    super.updateActivity();
  }

  /** A cat settling to sleep sometimes sits up or stretches first; the sequence's length is unchanged. */
  private beginSettle(a: Activity): void {
    const r = this.careRandom();
    if (r < SETTLE_SIT_P) {
      this.phase(a, 'sit', SETTLE_SIT_MS);
      a.counter = Math.max(0, 1200 - SETTLE_SIT_MS);
    } else if (r < SETTLE_SIT_P + SETTLE_STRETCH_P && resolveClip('stretch') === 'stretch') {
      this.phase(a, 'stretch', SETTLE_STRETCH_MS);
      a.counter = Math.max(0, 1200 - SETTLE_STRETCH_MS);
    }
  }

  /** Grooming starts with a face wash, or now and then a scratch; updCare strings a few more together. */
  private beginCare(a: Activity): void {
    a.counter = 0;
    if (chance(this.careRandom, 0.16) && this.careHas('scratch')) this.phase(a, 'scratch', range(this.careRandom, 2200, 3800));
    else this.phase(a, 'main', range(this.careRandom, 2500, 4500));
  }

  private careHas(clip: AnimClip): boolean {
    return resolveClip(clip, { walls: false, ledges: this.mover.attachedSurface !== null }) === clip;
  }

  /** Face wash, then a paw wash or a scratch, at most three steps: the grooming dwell ends the whole thing as before. */
  private updCare(a: Activity): void {
    if (!this.phaseElapsed(a)) return;
    a.counter++;
    const r = this.careRandom();
    const stop = (): void => {
      a.phaseMs = 0;
    };
    if (a.counter >= 3) {
      stop();
      return;
    }
    switch (a.phase) {
      case 'main':
        if (r < 0.45) this.phase(a, 'paw', range(this.careRandom, 2000, 3500));
        else if (r < 0.57 && this.careHas('scratch')) this.phase(a, 'scratch', range(this.careRandom, 2200, 3800));
        else stop();
        return;
      case 'paw':
        if (r < 0.2 && this.careHas('scratch')) this.phase(a, 'scratch', range(this.careRandom, 2200, 3800));
        else stop();
        return;
      case 'scratch':
        this.phase(a, 'main', range(this.careRandom, 1200, 2000));
        return;
      default:
        stop();
    }
  }
}
