// The cat simulation, layer 4: cursor play. v1.2 (ADR 0003 §4): the hunt drive is evaluated at
// 4 Hz on sim time from the cursor's prey salience; a hunt starts when it passes its threshold and
// no "never in the way" gate holds, and plays notice -> approach -> stalk -> crouch -> pounce ->
// bat -> re-stalk or lose interest, keeping the hit region short of the hotspot. Also the playful
// retreat, watching the cursor and the opportunistic mischief swat.
import type { HuntGate, HuntOutcome } from '../../shared/behaviorProfile';
import type { Facing } from '../../shared/cat';
import type { Point } from '../../shared/geometry';
import { clamp } from '../../shared/geometry';
import { MOVEMENT } from '../movement';
import type { Activity, FollowUp } from './activity';
import { applyImpulse } from './drives';
import type { HuntGateInput } from './hunt';
import {
  CROUCH_MAX_MS,
  CROUCH_MIN_MS,
  CROUCH_PRESS_GRACE_MS,
  CROUCH_STILL_MAX_MS,
  CROUCH_WAIT_MIN_MS,
  HUNT_LOST_GRACE_MS,
  HUNT_STEP_MS,
  MAX_HUNT_CYCLES,
  MAX_POUNCES_PER_HUNT,
  POUNCE_COOLDOWN_MS,
  PETTING_HOLD_MS,
  BUSY_HAND_PRESSES,
  BUSY_HAND_REST_MS,
  BUSY_HAND_WINDOW_MS,
  PRESS_NEAR_BW,
  WAITED_POUNCE_P,
  pounceHoldMs,
  STALK_IN_REACH_MS,
  STALK_MAX_MS,
  TASKBAR_HIDE_HOLD_MS,
  hitFrontPx,
  huntBaseline,
  huntCooldownMs,
  huntGain,
  huntGate,
  huntThreshold,
  inStartBand,
  inWatchBand,
  pounceShortPx,
  preySalience,
  requiredClearancePx,
  stepHuntDrive,
  strikeClearancePx,
} from './hunt';
import { bumpCounter } from './memory';
import { chance, range } from './random';
import { ASLEEP_STATES, PHYSICAL_STATES } from './states';
import { SimStay } from './simStay';
import { PLAY_RETREAT_APPROACH_BL_S, PLAY_RETREAT_COOLDOWN_MS } from './simCore';
import { activityClassOf } from '../../shared/behaviorProfile';

/** Mischief swat: a cursor passing this close (body widths) while the cat sits. */
const MISCHIEF_SWAT_BW = 1;
/** The cooldown after a hunt a gate cut off before its first pounce. */
const ABORTED_HUNT_COOLDOWN_MS: readonly [number, number] = [45_000, 90_000];
/** In the petting zone below this speed (DIP/s) the cursor is aiming at the cat. */
const PETTING_AIM_DIP_S = 300;
/** However fast, this many evaluations (1.5 s at 4 Hz) in the petting zone end a hunt. */
const PETTING_ZONE_MAX_EVALS = 6;
/** Added to the hunt threshold with video or fast app switching in front. */
const QUIET_CONTEXT_THETA = 0.2;
/** A cursor counts as moving above this speed, DIP/s. */
const MOVING_DIP_S = 30;

export abstract class SimHunt extends SimStay {
  /** The mischief-swat roll was made for the cursor's current pass. */
  private swatPassRolled = false;
  /** Consecutive 4 Hz evaluations with the petting-zone gate holding. */
  private pettingZoneEvals = 0;

  // ---- geometry and bands ------------------------------------------------------------------

  /** The cursor relative to the cat: body widths across, body heights above the feet, on its display. */
  protected preyGeometry(p: Point): { dxBw: number; dyBh: number; sameDisplay: boolean } {
    const m = this.mover;
    const d = m.fullWorldModel.displayAt(p);
    const sameDisplay = d !== null && d.id === m.displayId && !m.isOffLimits(d.id);
    return { dxBw: (p.x - m.x) / m.bodyWidth, dyBh: (m.y - p.y) / m.bodyHeight, sameDisplay };
  }

  /** The cursor in the watch band (14 bw x -0.6..4.5 bh, same display). */
  protected cursorInWatchBand(): boolean {
    return this.cursorBand() !== null;
  }

  /** 'watch' in the watch band, 'chatter' when it is more than 2.5 body heights above the feet there; else null. */
  protected cursorBand(): 'watch' | 'chatter' | null {
    const c = this.env?.cursor;
    if (!c || !Number.isFinite(c.x) || !Number.isFinite(c.y)) return null;
    const g = this.preyGeometry(c);
    if (!g.sameDisplay || !inWatchBand(g.dxBw, g.dyBh)) return null;
    return inStartBand(g.dxBw, g.dyBh) ? 'watch' : 'chatter';
  }

  /** ms since the cursor last moved (the host's value, else from its speed and positions). */
  protected cursorIdle(): number {
    const env = this.env;
    if (env && typeof env.cursorIdleMs === 'number' && Number.isFinite(env.cursorIdleMs)) return env.cursorIdleMs;
    const c = env?.cursor;
    if (c && Number.isFinite(c.speed) && c.speed / this.mover.scale >= MOVING_DIP_S) return 0;
    return this.cursorTrack.idleMs(this.now);
  }

  /** The petting zone: the cursor within the hit rect grown by 0.5 bw, being petted, or within 3 s of petting. */
  protected inPettingZone(p: Point | null): boolean {
    if (this.act.state === 'beingPetted' || this.now - this.lastPetEventAt < PETTING_HOLD_MS) return true;
    if (!p) return false;
    const b = this.approxBounds();
    const g = 0.5 * this.mover.bodyWidth;
    return p.x >= b.x - g && p.x <= b.x + b.width + g && p.y >= b.y - g && p.y <= b.y + b.height + g;
  }

  /** A taskbar is revealed (listed as a ledge), hid less than 1 s ago, or the cursor is in a bottom reveal band. */
  protected taskbarGate(p: Point | null): boolean {
    if (this.now - this.taskbarHiddenAt < TASKBAR_HIDE_HOLD_MS) return true;
    for (const s of this.surfaceIndex.values()) {
      if (s.orientation !== 'ledge' || s.kind !== 'taskbar') continue;
      if (s.excluded !== true) return true;
    }
    if (!p) return false;
    const d = this.mover.fullWorldModel.displayAt(p);
    if (!d) return false;
    const band = 8 * d.scaleFactor;
    return p.y >= d.boundsPx.y + d.boundsPx.height - band;
  }

  /** The cursor in the container of a strip the cat stands on or next to, or in the caption band of the window it stands on. */
  protected stripCaptionGate(p: Point | null): { strip: boolean; caption: boolean } {
    if (!p) return { strip: false, caption: false };
    const m = this.mover;
    const bw = m.bodyWidth;
    const bh = m.bodyHeight;
    let strip = false;
    for (const l of m.ledgeSurfaces) {
      if (l.surfaceKind !== 'tabStrip') continue;
      const nearCat = Math.abs(l.y - m.y) <= 1.5 * bh && m.x >= l.x0 - 2 * bw && m.x <= l.x1 + 2 * bw;
      if (!nearCat) continue;
      if (p.x >= l.x0 && p.x <= l.x1 && p.y >= l.y - 0.25 * bh && p.y <= l.y + bh) strip = true;
    }
    let caption = false;
    const on = m.attachedSurface;
    if (on && (on.surfaceKind === 'windowTop' || on.surfaceKind === 'tabStrip')) {
      const r = this.windowRect(on.ownerId);
      if (r && p.x >= r.x && p.x <= r.x + r.width && p.y >= r.y - 0.25 * bh && p.y <= r.y + bh) caption = true;
    }
    return { strip, caption };
  }

  /** The hand is away from the cat: the cursor and the last press both beyond anything it can reach. */
  protected pressFar(p: Point | null): boolean {
    const m = this.mover;
    const lim = PRESS_NEAR_BW * m.bodyWidth;
    const q = this.lastPressPoint;
    return p !== null && Math.hypot(p.x - m.x, p.y - m.y) > lim && (q === null || Math.hypot(q.x - m.x, q.y - m.y) > lim);
  }

  /** The hand has been pressing again and again and is still moving: it is at work, wherever the cursor is. */
  protected pressBusy(): boolean {
    const t = this.recentPressAt;
    return t.length >= BUSY_HAND_PRESSES && this.now - (t[0] as number) <= BUSY_HAND_WINDOW_MS && this.cursorIdle() < BUSY_HAND_REST_MS;
  }

  protected huntGateInput(p: Point | null): HuntGateInput {
    const s = this.act.state;
    const H = clamp(Number.isFinite(this.settings.behavior.cursorPlay) ? this.settings.behavior.cursorPlay : 0, 0, 1);
    const sc = this.stripCaptionGate(p);
    return {
      off: this.disabled.has('chaseCursor') || !(H > 0),
      typingRaw: this.typingRaw,
      sinceTypingMs: this.now - this.lastTypingRawAt,
      buttonDown: this.env?.pointerButtonDown === true,
      sincePressMs: this.now - this.lastPressAt,
      pressFar: this.pressFar(p),
      pressBusy: this.pressBusy(),
      pettingZone: this.inPettingZone(p),
      taskbar: this.taskbarGate(p),
      stripContainer: sc.strip,
      caption: sc.caption,
      wary: this.cat.drives.wariness > 0.3 || this.cat.stats.fear > 0.3,
      command: this.act.cause === 'command',
      unavailable: this.mode !== 'normal' || ASLEEP_STATES.has(s) || s === 'held' || s === 'away' || s === 'wakingUp',
    };
  }

  // ---- the 4 Hz evaluation ---------------------------------------------------------------------

  /** The hunt drive and its gates are evaluated at 4 Hz on sim time (an accumulator). */
  protected stepHuntClock(dt: number): void {
    if (!(dt > 0) || this.mode === 'quit') return;
    this.huntAccMs += dt;
    while (this.huntAccMs >= HUNT_STEP_MS) {
      this.huntAccMs -= HUNT_STEP_MS;
      this.huntEvaluate(HUNT_STEP_MS / 1000);
    }
  }

  protected huntEvaluate(dtS: number): void {
    const d = this.cat.drives;
    const b = this.settings.behavior;
    const H = clamp(Number.isFinite(b.cursorPlay) ? b.cursorPlay : 0, 0, 1);
    const c = this.env?.cursor;
    const p = c && Number.isFinite(c.x) && Number.isFinite(c.y) ? { x: c.x, y: c.y } : null;
    const flick = this.pendingFlick;
    this.pendingFlick = false;
    const gateIn = this.huntGateInput(p);
    const gate = huntGate(gateIn);
    this.huntGateNow = gate;
    const run = this.hunt && !this.hunt.ended ? this.hunt : null;
    let qHat = 0;
    if (p && c) {
      const g = this.preyGeometry(p);
      const crouching = run !== null && this.act.state === 'chasingCursor' && this.act.phase === 'crouch';
      qHat = preySalience({ dxBw: g.dxBw, dyBh: g.dyBh, speedDip: (Number.isFinite(c.speed) ? Math.max(0, c.speed) : 0) / this.mover.scale, erratic: this.cursorTrack.erratic, idleMs: this.cursorIdle(), crouching, flick, sameDisplay: g.sameDisplay }).qHat;
    }
    const cursorInFg = this.cursorInForeground(p);
    // The press hold only holds the start back: interest keeps building while the button is up, so a hand that
    // comes to rest near the cat is hunted when the hold ends. Typing is never prey.
    d.huntDrive = stepHuntDrive(d.huntDrive, gate === 'typing' || gateIn.buttonDown ? 0 : qHat, huntGain(H, this.cat.traits.playfulness, d.playNeed), huntBaseline(H), dtS, gateIn.pettingZone);
    this.huntThetaNow = huntThreshold(H, d.mischief, b.workDisruption, cursorInFg) + (this.quietContext() ? QUIET_CONTEXT_THETA : 0);
    // The cursor resting in the petting zone (not one passing through it) ends a running hunt.
    this.pettingZoneEvals = gate === 'petting' ? this.pettingZoneEvals + 1 : 0;
    if (run) {
      // A gate ends a running hunt within 0.5 s (the flight of a pounce is never cancelled: it ends on landing).
      if (PHYSICAL_STATES.has(this.act.state)) return;
      if (gate === 'petting') {
        const petted = this.act.state === 'beingPetted' || this.now - this.lastPetEventAt < PETTING_HOLD_MS;
        // A hand slowing down over the cat is aiming at it; prey darting past is not (and lingering ends it anyway).
        const slow = !c || !Number.isFinite(c.speed) || c.speed / this.mover.scale < PETTING_AIM_DIP_S;
        if (petted || (this.pettingZoneEvals >= 2 && slow) || this.pettingZoneEvals >= PETTING_ZONE_MAX_EVALS) this.interruptHunt('petting');
      } else if (gate === 'button') {
        // A press close to the cat (or the button down there) ends the hunt. A press away from it is the user's own
        // business, and an older press only holds the strike back (the crouch below keeps wiggling).
        const fresh = gateIn.buttonDown || this.now - this.lastPressAt < 1000;
        if (fresh && gateIn.pressFar !== true) this.interruptHunt('click');
      } else if (gate !== null) this.interruptHunt(gate);
      return;
    }
    if (this.huntStartable()) this.startHunt();
    else this.checkMischiefSwat(p);
  }

  /** Video or fast app switching in front (ADR 0003 §1.4 C_c: every active candidate damped). */
  protected quietContext(): boolean {
    const fg = this.env?.foreground;
    const media = fg !== null && fg !== undefined && !fg.minimized && (fg.category === 'video' || fg.category === 'game' || fg.category === 'media');
    return media || this.screenIsVideo() || this.now < this.busyUntil;
  }

  protected cursorInForeground(p: Point | null): boolean {
    const fg = this.env?.foreground;
    if (!p || !fg || fg.minimized) return false;
    const r = fg.rect;
    return p.x >= r.x && p.x <= r.x + r.width && p.y >= r.y && p.y <= r.y + r.height;
  }

  /** One start path (the 4 Hz pass and the scheduler's candidate): drive above threshold, cooldown over, no gate, prey in the start band. */
  protected huntReady(): boolean {
    if (this.huntGateNow !== null || this.now < this.huntReadyAt || !(this.cat.drives.huntDrive > this.huntThetaNow)) return false;
    if (this.cursorBand() !== 'watch' || !this.subAllowed('huntStalk')) return false;
    return !this.mover.onWall && this.mover.grounded;
  }

  /** The 4 Hz pass may start a hunt now: ready, and the cat is doing something calm of its own accord. */
  protected huntStartable(): boolean {
    if (!this.huntReady()) return false;
    const a = this.act;
    if (a.cause === 'command' || a.cause === 'interaction') return false;
    return activityClassOf(a.state, a.variant) === 'calm' && a.state !== 'chasingCursor';
  }

  protected startHunt(): void {
    if (this.request('chasingCursor', 'stimulus', { variant: 'hunt' }) !== 'ok') return;
    this.notePick({ state: 'chasingCursor', variant: 'hunt' });
    this.recordDecision('chasingCursor', 'hunt', 'stimulus');
  }

  /** Called when a chasingCursor:hunt activity starts (from either start path). */
  protected beginHunt(a: Activity): void {
    const H = clamp(Number.isFinite(this.settings.behavior.cursorPlay) ? this.settings.behavior.cursorPlay : 0, 0, 1);
    this.huntReadyAt = this.now + huntCooldownMs(this.random, H);
    this.hunt = { startedAt: this.now, cycles: 0, cycleStartedAt: this.now, pounces: 0, pounceTimes: [], minClearancePx: null, caught: false, seenAt: this.now, seenAtPoint: null, ended: false, standoffBw: 2, crouchWaitMs: CROUCH_STILL_MAX_MS, pauseUntil: -Infinity, pauseFromX: this.mover.x, pauseEveryBw: 1.5 };
    this.huntLanded = null;
    bumpCounter(this.cat.memory, 'hunts');
    bumpCounter(this.cat.memory, 'chasesStarted');
    this.phase(a, 'notice', range(this.random, 400, 1200));
    // The hunt's phases, budget and gates end it (self-timed); its dwell is one cycle's budget (§4.2).
    a.dwellMs = this.huntCycleBudgetMs();
  }

  /** Budget of one stalk-to-bat cycle: 1.5 x chaseDurationSec (ADR 0003 §4.2). */
  protected huntCycleBudgetMs(): number {
    const sec = this.settings.behavior.chaseDurationSec;
    return 1.5 * clamp(Number.isFinite(sec) ? sec : 4.5, 1, 20) * 1000;
  }

  /** The outcome so far. */
  private huntOutcome(): HuntOutcome {
    const run = this.hunt;
    if (!run) return 'lostInterest';
    return run.caught ? 'caught' : run.pounces > 0 ? 'missed' : 'lostInterest';
  }

  /** Emits the hunt's record once. */
  protected endHunt(outcome: HuntOutcome, gate: HuntGate | null): void {
    const run = this.hunt;
    if (!run || run.ended) return;
    run.ended = true;
    const scale = this.mover.scale;
    this.emitHunt({
      at: this.now,
      startedAt: run.startedAt,
      durationMs: Math.max(0, this.now - run.startedAt),
      pounces: run.pounces,
      pounceTimes: [...run.pounceTimes],
      minClearanceDip: run.minClearancePx === null ? null : run.minClearancePx / (scale > 0 ? scale : 1),
      outcome,
      gate,
    });
  }

  /** A gate ended the hunt: interrupted, then a calm sit (no startle). */
  protected interruptHunt(gate: HuntGate): void {
    // Cut off before it got to pounce (the cursor over the cat, a taskbar): the long cooldown is not used up.
    if (this.hunt && this.hunt.pounces === 0) this.huntReadyAt = Math.min(this.huntReadyAt, this.now + range(this.random, ABORTED_HUNT_COOLDOWN_MS[0], ABORTED_HUNT_COOLDOWN_MS[1]));
    this.endHunt('interrupted', gate);
    if (this.act.state === 'chasingCursor') this.finish({ state: 'idle', init: {} });
  }

  // ---- phases ----------------------------------------------------------------------------------

  /** Result of the pounce that just landed (set on landing, read when the hunt resumes). */
  protected huntLanded: { caught: boolean } | null = null;

  protected updHunt(a: Activity): void {
    const run = this.hunt;
    const m = this.mover;
    if (!run || run.ended) {
      this.finish({ state: 'idle', init: {} });
      return;
    }
    const c = this.env?.cursor;
    const cur = c && Number.isFinite(c.x) && Number.isFinite(c.y) ? { x: c.x, y: c.y } : null;
    if (cur && c) {
      a.observedMs += this.dt;
      if ((Number.isFinite(c.speed) ? c.speed : 0) / m.scale > 120) a.engagedMs += this.dt;
      const g = this.preyGeometry(cur);
      if (g.sameDisplay && inStartBand(g.dxBw, g.dyBh)) {
        run.seenAt = this.now;
        run.seenAtPoint = cur;
      }
    }
    // The prey hopped out of the start band: the cat lies low for it (the crouch's own window bounds
    // the wait); only a cursor gone altogether, or lost mid-strike, ends the hunt at once.
    const lost = !cur || this.now - run.seenAt > HUNT_LOST_GRACE_MS;
    if (lost && (!cur || (a.phase !== 'notice' && a.phase !== 'approach' && a.phase !== 'stalk' && a.phase !== 'crouch'))) {
      this.loseInterest(a);
      return;
    }
    if (!cur) return;
    if (lost && (a.phase === 'approach' || a.phase === 'stalk')) {
      this.stop();
      this.phase(a, 'crouch', CROUCH_MIN_MS);
      return;
    }
    const dir: Facing = cur.x >= m.x ? 1 : -1;
    const bw = this.bl;
    if (this.huntLanded) {
      const landed = this.huntLanded;
      this.huntLanded = null;
      if (landed.caught) {
        run.caught = true;
        applyImpulse(this.cat.drives, 'caught');
      } else applyImpulse(this.cat.drives, 'missedPounce');
      this.tryStrike(a, cur);
      return;
    }
    // Budget (ADR 0003 §4.2): each stalk-to-bat cycle ends at 1.5 x chaseDurationSec. Past it the
    // cycle closes at once: a stalk turns into the crouch, a crouch into its pounce, a bat ends.
    const over = this.now - run.cycleStartedAt > this.huntCycleBudgetMs();
    if (over && a.phase === 'stalk') {
      this.stop();
      this.phase(a, 'crouch', CROUCH_MIN_MS);
      return;
    }
    if (over && (a.phase === 'bat' || a.phase === 'swat' || a.phase === 'look')) {
      this.nextCycle(a, cur);
      return;
    }
    switch (a.phase) {
      case 'notice':
        this.stop();
        m.faceToward(cur.x, this.now);
        if (this.phaseElapsed(a)) {
          run.startedAt = this.now;
          this.startCycle(a, cur);
          if (lost) this.phase(a, 'crouch', CROUCH_MIN_MS);
        }
        return;
      case 'approach': {
        if (Math.abs(cur.x - m.x) <= 4 * bw) {
          this.phase(a, 'stalk');
          return;
        }
        this.goTo({ x: cur.x - dir * 4 * bw, y: m.y }, 'chase', false, 0.3 * bw);
        if (a.goalStatus === 'unreachable') this.loseInterest(a);
        return;
      }
      case 'stalk': {
        // Toward 1.5-2.5 bw short of the hotspot (from the crouch pose's front), pausing now and then.
        const standoff = run.standoffBw * bw;
        const front = hitFrontPx('crouch', this.settings.appearance.size, m.scale);
        const tx = cur.x - dir * (front + standoff);
        const r = m.walkRange;
        const x = r ? clamp(tx, r.x0, r.x1) : tx;
        // Prey already within a pounce's reach is only crept up on for a moment: it will not wait.
        const inReach = this.now - a.phaseAt > STALK_IN_REACH_MS && this.pounceLanding(cur).dist <= MOVEMENT.pounceReachBodyLengths * m.bodyWidth;
        if (inReach || Math.abs(x - m.x) < 0.25 * bw || this.now - a.phaseAt > STALK_MAX_MS || a.goalStatus === 'unreachable') {
          this.stop();
          this.phase(a, 'crouch', range(this.random, CROUCH_MIN_MS, CROUCH_MAX_MS));
          return;
        }
        if (this.now < run.pauseUntil) {
          // A short pause in the stalk, eyes on the prey.
          this.stop();
          m.faceToward(cur.x, this.now);
          return;
        }
        // Every 1-2 body widths of creeping, a 0.3-1 s pause.
        if (Math.abs(m.x - run.pauseFromX) >= run.pauseEveryBw * bw) {
          run.pauseUntil = this.now + range(this.random, 300, 1000);
          run.pauseFromX = m.x;
          run.pauseEveryBw = range(this.random, 1, 2);
          return;
        }
        this.goTo({ x, y: m.y }, 'stalk', false, 0.15 * bw);
        return;
      }
      case 'crouch': {
        this.stop();
        m.faceToward(cur.x, this.now);
        const elapsed = this.now - a.phaseAt;
        if (elapsed < a.phaseMs) return;
        // A still or absent prey keeps the crouch alive (wiggling) up to 6 s; its next movement in the start band triggers the pounce.
        if (lost || this.cursorIdle() >= 300) {
          if (elapsed < run.crouchWaitMs && !over) return;
          // The leap would follow a press too closely: it holds on a little, it does not give up over that.
          if (this.pounceHeld() && elapsed < run.crouchWaitMs + CROUCH_PRESS_GRACE_MS) return;
          // Waited for it in vain: a lost stalk frustrates a little. Often it leaps anyway, at the prey that never
          // moved or at the place the prey vanished from; a hunter's leap at nothing is a miss like any other.
          if (lost) applyImpulse(this.cat.drives, 'cursorLost');
          if (chance(this.random, WAITED_POUNCE_P) && this.tryHuntPounce(lost ? (run.seenAtPoint ?? cur) : cur)) return;
          this.loseInterest(a);
          return;
        }
        // The press hold still runs: it keeps wiggling a little longer.
        if (this.pounceHeld() && elapsed < CROUCH_STILL_MAX_MS && !over) return;
        if (!this.tryHuntPounce(cur)) this.tryStrike(a, cur);
        return;
      }
      case 'bat':
      case 'swat':
      case 'look':
        this.stop();
        m.faceToward(cur.x, this.now);
        if (!this.phaseElapsed(a)) return;
        // A cycle lasts as long as its budget allows (chaseDurationSec): a prey still moving is stalked on.
        if (!over && this.cursorIdle() < 1000 && this.huntGateNow === null) {
          run.pauseFromX = m.x;
          run.pauseUntil = -Infinity;
          this.phase(a, 'stalk');
        } else this.nextCycle(a, cur);
        return;
      default:
        this.startCycle(a, cur);
    }
  }

  /** A new stalk-to-bat cycle: approach first when far, else stalk. */
  private startCycle(a: Activity, cur: Point): void {
    const run = this.hunt;
    if (!run) return;
    run.cycles++;
    run.cycleStartedAt = this.now;
    run.standoffBw = range(this.random, 1.5, 2.5);
    run.crouchWaitMs = range(this.random, CROUCH_WAIT_MIN_MS, CROUCH_STILL_MAX_MS);
    run.pauseUntil = -Infinity;
    run.pauseFromX = this.mover.x;
    run.pauseEveryBw = range(this.random, 1, 2);
    this.phase(a, Math.abs(cur.x - this.mover.x) > 4 * this.bl ? 'approach' : 'stalk');
  }

  /** After a cycle: re-stalk if the prey still moves in the start band and the cat is keen, else lose interest. */
  private nextCycle(a: Activity, cur: Point): void {
    const run = this.hunt;
    if (!run) return;
    const g = this.preyGeometry(cur);
    const moving = this.cursorIdle() < 1000;
    const keen = this.cat.drives.huntDrive > 0.35 && this.cat.drives.frustration < 0.6;
    if (moving && keen && run.cycles < MAX_HUNT_CYCLES && g.sameDisplay && inStartBand(g.dxBw, g.dyBh) && this.huntGateNow === null) this.startCycle(a, cur);
    else this.loseInterest(a);
  }

  /** Ends the hunt with its outcome; then a look away, a displacement groom or a walk away. */
  protected loseInterest(a: Activity): void {
    const outcome = this.huntOutcome();
    this.endHunt(outcome, null);
    const d = this.cat.drives;
    applyImpulse(d, 'lostInterest');
    if (outcome === 'lostInterest' && a.engagedMs < 0.35 * Math.max(1, a.observedMs)) applyImpulse(d, 'huntIgnored');
    const groom = this.subAllowed('groom') && !this.disabled.has('grooming');
    let next: FollowUp = { state: 'idle', init: {} };
    if (d.frustration > 0.5) {
      this.react('tailFlick');
      if (groom && chance(this.random, 0.3)) next = { state: 'grooming', init: { variant: 'displacement' } };
    } else {
      const r = this.random();
      if (r < 0.4) next = { state: 'idle', init: {} };
      else if (r < 0.65 && groom) next = { state: 'grooming', init: { variant: 'displacement' } };
      else {
        const away = this.retreatTarget();
        if (away) next = { state: 'walking', init: { variant: 'wander', target: away } };
      }
    }
    this.finish(next);
  }

  /** How far a pounce at `cur` would carry the anchor if nothing limited it, and the geometry it lands with. */
  private pounceLanding(cur: Point): { dist: number; front: number; shortPx: number } {
    const m = this.mover;
    const front = hitFrontPx('pounce', this.settings.appearance.size, m.scale);
    const shortPx = pounceShortPx(m.bodyWidth, m.scale);
    const dir: Facing = cur.x >= m.x ? 1 : -1;
    return { dist: Math.abs(cur.x - dir * (front + shortPx) - m.x), front, shortPx };
  }

  /** The button is down or a press is too recent for a leap, by where the hand is now. */
  protected pounceHeld(): boolean {
    const c = this.env?.cursor;
    const p = c && Number.isFinite(c.x) && Number.isFinite(c.y) ? { x: c.x, y: c.y } : null;
    return this.env?.pointerButtonDown === true || this.now - this.lastPressAt < pounceHoldMs(this.pressFar(p));
  }

  /** The ballistic pounce at `cur` (the cursor, or where the prey was last seen), landing short of the hotspot (hit region clearance, T8). */
  protected tryHuntPounce(cur: Point): boolean {
    const run = this.hunt;
    const m = this.mover;
    if (!run || !this.subAllowed('huntPounce') || this.disabled.has('chaseCursor')) return false;
    if (run.pounces >= MAX_POUNCES_PER_HUNT || this.now - this.lastPounceAt < POUNCE_COOLDOWN_MS || this.holdingStill() || (this.huntGateNow !== null && this.huntGateNow !== 'button') || this.typingGate()) return false;
    // The 4 Hz gate may not have seen a press of this very tick: a pounce never follows one (B5b).
    if (this.pounceHeld()) return false;
    const hot = this.env?.cursor;
    const hotPoint = hot && Number.isFinite(hot.x) && Number.isFinite(hot.y) ? { x: hot.x, y: hot.y } : null;
    if (m.balance > 0) return false;
    const dir: Facing = cur.x >= m.x ? 1 : -1;
    const size = this.settings.appearance.size;
    const scale = m.scale;
    const { dist, front, shortPx } = this.pounceLanding(cur);
    const maxDist = MOVEMENT.pounceReachBodyLengths * m.bodyWidth;
    const r = m.walkRange;
    // Prey beyond the reach, or past the end of what it stands on, gets a leap after it that lands short
    // (Mover.pounceAt clamps the same way). The clearance below takes the full leap, the closest it can get.
    const landX = m.x + dir * Math.min(dist, maxDist);
    const margin = MOVEMENT.pounceEndMarginBodyLengths * m.bodyWidth;
    const leap = r ? (clamp(landX, r.x0 + margin, r.x1 - margin) - m.x) * dir : (landX - m.x) * dir;
    if (dist < 0.3 * m.bodyWidth || leap < 0.3 * m.bodyWidth) return false;
    // The clearance from the aim, and from the real hotspot when the aim is the place the prey left.
    const body = { bw: m.bodyWidth, bh: m.bodyHeight };
    const toAim = strikeClearancePx('pounce', { x: landX, y: m.y }, dir, cur, scale, size, body);
    const clearance = hotPoint ? Math.min(toAim, strikeClearancePx('pounce', { x: landX, y: m.y }, dir, hotPoint, scale, size, body)) : toAim;
    if (clearance < requiredClearancePx(scale)) return false;
    if (!m.pounceAt(this.now, { x: cur.x, y: m.y }, { crouchMs: MOVEMENT.pounceCrouchMinMs, shortPx, maxDistPx: maxDist, frontExtentPx: front })) return false;
    if (this.request('jumping', 'physical', { suspend: true }) !== 'ok') {
      m.cancelCrouch();
      return false;
    }
    this.fallReason = 'jump';
    this.pounceFlight = { at: this.now, clearancePx: clearance, targetX: cur.x, mini: false };
    run.pounces++;
    run.pounceTimes.push(this.now);
    run.minClearancePx = run.minClearancePx === null ? clearance : Math.min(run.minClearancePx, clearance);
    this.lastPounceAt = this.now;
    bumpCounter(this.cat.memory, 'pounces');
    applyImpulse(this.cat.drives, 'pounce');
    return true;
  }

  /** A pounce landed: caught when the cursor is within 1 bw of the paw point. */
  protected onPounceLanded(): void {
    const f = this.pounceFlight;
    this.pounceFlight = null;
    if (!f || f.mini) return;
    const m = this.mover;
    const c = this.env?.cursor;
    const paw = m.x + m.facing * hitFrontPx('pounce', this.settings.appearance.size, m.scale);
    const caught = !!c && Number.isFinite(c.x) && Number.isFinite(c.y) && Math.hypot(c.x - paw, c.y - (m.y - 0.3 * m.bodyHeight)) <= m.bodyWidth;
    this.huntLanded = { caught };
  }

  /** Bat (pawAt) or swat at the cursor, only with the paw's whole reach short of the hotspot; else a look. */
  protected tryStrike(a: Activity, cur: Point): void {
    const run = this.hunt;
    const m = this.mover;
    const dir: Facing = cur.x >= m.x ? 1 : -1;
    m.faceToward(cur.x, this.now);
    const pose = Math.abs(cur.x - m.x) < 0.8 * m.bodyWidth ? 'swat' : 'pawAt';
    const clearance = strikeClearancePx(pose, { x: m.x, y: m.y }, dir, cur, m.scale, this.settings.appearance.size, { bw: m.bodyWidth, bh: m.bodyHeight });
    if (this.subAllowed('huntBat') && clearance >= requiredClearancePx(m.scale) && this.huntGateNow === null) {
      if (run) run.minClearancePx = run.minClearancePx === null ? clearance : Math.min(run.minClearancePx, clearance);
      applyImpulse(this.cat.drives, 'bat');
      if (pose === 'swat') this.phase(a, 'swat', 450);
      else this.phase(a, 'bat', range(this.random, 600, 1500));
      return;
    }
    // 'Paw at the pointer' off, or too close: a look (the hunt ends with it).
    this.phase(a, 'look', range(this.random, 800, 1600));
  }

  // ---- watching, the playful retreat and the mischief swat ---------------------------------------

  /**
   * Playful retreat: a playful, energetic cat now and then darts away from a pointer rushing
   * at it, then turns back to face it in a crouch. Rare (long cooldown) and part of cursor play.
   */
  protected checkPlayfulRetreat(): void {
    const cur = this.cursorInfo();
    const prev = this.prevCursorDistBl;
    this.prevCursorDistBl = cur ? cur.distBodyLengths : null;
    if (!cur || prev === null || this.dt <= 0 || this.mode !== 'normal' || this.typing) return;
    const closing = ((prev - cur.distBodyLengths) * 1000) / this.dt;
    if (cur.distBodyLengths > 2 || closing < PLAY_RETREAT_APPROACH_BL_S || !cur.reachable) return;
    const a = this.act;
    if (!(a.state === 'idle' || a.state === 'watchingCursor' || (a.state === 'walking' && a.variant === 'wander'))) return;
    const st = this.cat.stats;
    const t = this.cat.traits;
    const cursorPlay = clamp(this.settings.behavior.cursorPlay, 0, 1);
    if (this.disabled.has('chaseCursor') || !(cursorPlay > 0) || t.playfulness < 0.5 || st.energy < 0.5 || st.annoyance > 0.3 || st.fear > 0.2) return;
    // v1.2: never while the raw typing gate holds, and not while wary (the slink rule decides then).
    if (this.typingGate() || this.cat.drives.wariness > 0.3) return;
    if (!this.reactions.ready('playRetreat', this.now)) return;
    // One roll per rush of the pointer.
    this.reactions.set('playRetreat', this.now, 5000);
    if (!chance(this.random, Math.min(1, 2 * cursorPlay) * t.playfulness * 0.6)) return;
    const target = this.retreatTarget();
    if (!target) return;
    const then: FollowUp = { state: 'watchingCursor', init: { variant: 'playful' } };
    if (this.request('running', 'stimulus', { variant: 'playful', target, then }) === 'ok') this.reactions.set('playRetreat', this.now, PLAY_RETREAT_COOLDOWN_MS);
  }

  /**
   * Watching the cursor. v1.2: pounces belong to hunts only (one start path, the 90 s cooldown and
   * the strike clearance), so the wind-up crouch here is a tease that ends in a look.
   */
  protected updWatchCursor(a: Activity): void {
    this.stop();
    const cur = this.cursorInfo();
    if (!cur) {
      if (this.now - this.lastCursorSeenAt > 2000) this.finish();
      return;
    }
    this.mover.faceToward(cur.point.x, this.now);
    if (a.phase === 'main' && a.variant !== 'chatter' && cur.distBodyLengths < 3 && cur.speedDip > 200 && this.perSecond(0.3 * this.cat.traits.playfulness)) this.phase(a, 'crouch', 900);
    else if (a.phase === 'crouch' && this.phaseElapsed(a)) this.phase(a, 'main');
  }

  /**
   * Mischief swat (ADR 0003 §1.7): with mischief above 0.15, a cursor passing within 1 bw of a
   * sitting cat gets a swat with p = 0.5 m per pass (cooldown 60 s / (0.5 + M)), only with the
   * strike clearance and never through a gate.
   */
  protected checkMischiefSwat(p: Point | null): void {
    const m = this.mover;
    if (!p) {
      this.swatPassRolled = false;
      return;
    }
    const near = Math.abs(p.x - m.x) <= MISCHIEF_SWAT_BW * m.bodyWidth && m.y - p.y >= -0.3 * m.bodyHeight && m.y - p.y <= 1.3 * m.bodyHeight;
    if (!near) {
      if (Math.abs(p.x - m.x) > 1.5 * MISCHIEF_SWAT_BW * m.bodyWidth) this.swatPassRolled = false;
      return;
    }
    if (this.swatPassRolled) return;
    const M = clamp(Number.isFinite(this.settings.behavior.mischief) ? this.settings.behavior.mischief : 0, 0, 1);
    const mood = this.cat.drives.mischief;
    const s = this.act.state;
    const sits = s === 'idle' || s === 'watchingCursor' || s === 'watchingUser' || s === 'resting';
    if (!(mood > 0.15) || !(M > 0) || !sits || !m.grounded || this.cursorIdle() > 300) return;
    if (this.huntGateNow === 'typing' || this.huntGateNow === 'button' || this.huntGateNow === 'command' || this.typingGate()) return;
    if (this.act.state === 'beingPetted' || this.now - this.lastPetEventAt < PETTING_HOLD_MS || this.env?.cursorOverCat) return;
    if (!this.subAllowed('mischiefSwat') || this.now - this.lastMischiefSwatAt < 60_000 / (0.5 + M)) return;
    this.swatPassRolled = true;
    if (!chance(this.random, 0.5 * mood)) return;
    const dir: Facing = p.x >= m.x ? 1 : -1;
    if (strikeClearancePx('swat', { x: m.x, y: m.y }, dir, p, m.scale, this.settings.appearance.size, { bw: m.bodyWidth, bh: m.bodyHeight }) < requiredClearancePx(m.scale)) return;
    m.faceToward(p.x, this.now);
    this.playOneShot('swat', 450);
    this.lastMischiefSwatAt = this.now;
    applyImpulse(this.cat.drives, 'mischiefAct');
  }
}
