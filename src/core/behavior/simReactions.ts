// The cat simulation, layer 5: direct handling (petting, taps, drags, throws) and the reactions it
// leads to. v1.2 (ADR 0003 §5): a throw or a rough drag draws one of nine reactions (reactions.ts,
// water-filled caps), played out with existing states as variants; wariness then keeps the cat a
// little away from a rushing cursor (the slink rule), never from the controls; landings are
// impact-scaled (§6.4).
import type { ThrowReactionKind } from '../../shared/behaviorProfile';
import type { Facing } from '../../shared/cat';
import type { Point } from '../../shared/geometry';
import { clamp } from '../../shared/geometry';
import type { LandingInfo } from '../movement';
import { impactLevel } from '../movement';
import type { Activity, FollowUp } from './activity';
import { addFear, applyImpulse, applyStroke, applyThrowIrritation, raiseWariness } from './drives';
import { requiredClearancePx, strikeClearancePx } from './hunt';
import { addRateEvent, bumpCounter } from './memory';
import { fallCauseOf } from './profile';
import { chance, range } from './random';
import {
  drawReaction,
  HANDLING_WINDOW_MS,
  ROUGH_DRAG_MIN_MS,
  ROUGH_DRAG_SEVERITY,
  ROUGH_DRAG_SPEED_DIP,
  ROUGH_DRAG_WINDOW_MS,
  severityOf,
  STARTLE_WINDOW_MS,
  THROW_SPEED_DIP,
  throwReactionWeights,
  WARINESS_BY_REACTION,
} from './reactions';
import { ASLEEP_STATES, CALM_STATES, PHYSICAL_STATES, REACTION_STATES } from './states';
import { addStat, applyPet } from './stats';
import { SimHunt } from './simHunt';
import { PET_RATE_TAU_MS, PET_SESSION_GAP_MS, PET_IRRITATION, IRRITATED_ANNOYANCE, TAP_WINDOW_MS, DRAG_LOST_MS, LANDING_MS, ZERO, isFinitePoint } from './simCore';

/** Reactions that count as recent startles (st). */
const STARTLE_LIKE: ReadonlySet<ThrowReactionKind> = new Set<ThrowReactionKind>(['surprise', 'startledJump', 'flight']);
/** Strokes in one bout before an overstimulated cat may swat at the hand. */
const OVERSTIM_STROKES = 8;

export abstract class SimReactions extends SimHunt {
  /** Previous cursor distance (body widths) and when, for the slink rule's closing speed. */
  private slinkPrev: { at: number; dist: number } | null = null;
  protected updPetted(a: Activity): void {
    this.stop();
    const sinceLast = this.now - a.lastPetAt;
    if (sinceLast > 1800) {
      this.finish(this.afterPetting());
      return;
    }
    if (this.now - a.startedAt > 45_000) this.finish({ state: chance(this.random, 0.5) ? 'walking' : 'idle', init: { variant: 'wander', target: this.wanderTarget() } });
    else if (this.now - a.startedAt > 3000) this.emotes.show('note', this.now);
  }

  protected afterPetting(): FollowUp {
    const sleepy = this.currentSleepiness();
    if (this.mode === 'paused') return { state: 'resting', init: {} };
    if (sleepy > 0.5 && !this.coolingDown('fallingAsleep')) return { state: 'fallingAsleep', init: {} };
    const r = this.random();
    if (r < 0.4) return { state: 'resting', init: {} };
    if (r < 0.65 && !this.disabled.has('grooming')) return { state: 'grooming', init: {} };
    return { state: 'idle', init: {} };
  }

  protected afterStartle(a: Activity): FollowUp {
    // v1.2 rough-handling reactions play out their own way (ADR 0003 §5.1).
    if (a.variant === 'jolt') {
      const groom = this.subAllowed('groom') && chance(this.random, 0.4);
      const look = this.env?.cursor ? { x: this.env.cursor.x, y: this.env.cursor.y } : null;
      return { state: 'idle', init: { variant: 'shrug', target: look, dwellMs: 2000, then: groom ? { state: 'grooming', init: { variant: 'displacement' } } : null } };
    }
    if (a.variant === 'startledJump') {
      const away = this.awayFromCursor(2, 4);
      const back: FollowUp = { state: 'idle', init: { target: this.env?.cursor ? { x: this.env.cursor.x, y: this.env.cursor.y } : null } };
      return away ? { state: 'walking', init: { variant: 'slink', target: away, then: back } } : back;
    }
    const fear = this.cat.stats.fear;
    if (fear > 0.45 && this.cat.traits.confidence < 0.6) return { state: 'hiding', init: { variant: 'flee' } };
    if (a.target && chance(this.random, this.cat.traits.curiosity)) return { state: 'curious', init: { target: a.target } };
    if (this.cursorInfo()) return { state: 'watchingCursor', init: {} };
    return { state: 'idle', init: {} };
  }

  protected afterAnnoyed(a: Activity): FollowUp {
    // v1.2: a grumpy stare or a defensive hiss ends with the cat turning away (no hiding, no flight).
    if (a.variant === 'grumpy' || a.variant === 'defensive') {
      const m = this.mover;
      this.setGlance({ x: m.x - m.facing * 2 * this.bl, y: m.y - 0.3 * m.bodyHeight }, 1500);
      return { state: 'idle', init: {} };
    }
    if (this.cat.stats.annoyance >= IRRITATED_ANNOYANCE) return { state: 'hiding', init: { variant: 'flee' } };
    const r = this.random();
    if (r < 0.4 && !this.disabled.has('grooming')) return { state: 'grooming', init: {} };
    if (r < 0.7) {
      const target = this.retreatTarget();
      if (target) return { state: 'walking', init: { variant: 'retreat', target } };
    }
    return { state: 'idle', init: {} };
  }

  /** A point `lo`..`hi` body widths away from the cursor on the surface the cat stands on (null: no room). */
  protected awayFromCursor(lo: number, hi: number): Point | null {
    const m = this.mover;
    const r = m.walkRange;
    if (!r) return null;
    const threat = this.env?.cursor?.x ?? m.x - m.facing * this.bl;
    const dir = threat < m.x ? 1 : -1;
    const x = clamp(m.x + dir * range(this.random, lo, hi) * this.bl, r.x0, r.x1);
    return Math.abs(x - m.x) >= this.bl ? { x, y: m.y } : null;
  }

  /**
   * The v1.2 reaction to a throw or a rough drag released slowly (ADR 0003 §5): weights from the
   * severity, recent handling, moods, personality and the landing room, one draw, then the kind's
   * play-out as an existing state's variant. Wariness rises to the kind's level.
   */
  protected rollThrowReaction(info: LandingInfo, trigger: 'throw' | 'roughDrag', speedDip: number): FollowUp {
    const d = this.cat.drives;
    const t = this.cat.traits;
    const st = this.cat.stats;
    const m = this.mover;
    const raw = severityOf(speedDip, info.impact);
    const severity = trigger === 'roughDrag' ? raw * ROUGH_DRAG_SEVERITY : raw;
    const wall = this.wall();
    const handling = clamp(this.rough.countSince(wall - HANDLING_WINDOW_MS, ['throw', 'roughDrag']) / 5, 0, 1);
    while (this.startleTimes.length > 0 && (this.startleTimes[0] as number) < this.now - STARTLE_WINDOW_MS) this.startleTimes.shift();
    const on = m.attachedSurface;
    const r = m.walkRange;
    const littleRoom = !!on && (on.surfaceKind === 'windowTop' || on.surfaceKind === 'tabStrip') && !!r && r.x1 - r.x0 < 4 * this.bl;
    const w = throwReactionWeights({
      severity,
      handling,
      irritability: d.irritability,
      confidence: t.confidence,
      bond: st.bond,
      recentStartles: clamp(this.startleTimes.length / 3, 0, 1),
      intensity: this.settings.interaction.reactionIntensity,
      startleSensitivity: t.startleSensitivity,
      playfulness: t.playfulness,
      playNeed: d.playNeed,
      littleRoom,
      previous: this.lastReactionKind,
      disabled: this.disabled,
    });
    const kind = drawReaction(this.random, w.weights);
    this.emitReaction({ at: this.now, kind, speedDip, impact: info.impact, trigger, capped: w.capped, onLedge: littleRoom });
    this.lastReactionKind = kind;
    if (STARTLE_LIKE.has(kind)) this.startleTimes.push(this.now);
    if (trigger === 'throw') applyThrowIrritation(d, severity);
    raiseWariness(d, WARINESS_BY_REACTION[kind]);
    return this.reactionFollowUp(kind);
  }

  /** How each reaction plays out (ADR 0003 §5.1 table), with its immediate mood effects. */
  protected reactionFollowUp(kind: ThrowReactionKind): FollowUp {
    const d = this.cat.drives;
    const st = this.cat.stats;
    const t = this.cat.traits;
    const cursor = this.env?.cursor ? { x: this.env.cursor.x, y: this.env.cursor.y } : null;
    switch (kind) {
      case 'shrug':
        addFear(st, t, 0.02);
        return { state: 'idle', init: { variant: 'shrug', dwellMs: range(this.random, 1000, 2000) } };
      case 'surprise':
        addFear(st, t, 0.15);
        return { state: 'startled', init: { variant: 'jolt', dwellMs: 800 } };
      case 'startledJump':
        addFear(st, t, 0.3);
        return { state: 'startled', init: { variant: 'startledJump' } };
      case 'grumpy':
        d.irritability = clamp(d.irritability + 0.05, 0, 1);
        return { state: 'annoyed', init: { variant: 'grumpy', dwellMs: range(this.random, 3000, 8000) } };
      case 'defensive':
        d.irritability = clamp(d.irritability + 0.08, 0, 1);
        return { state: 'annoyed', init: { variant: 'defensive', dwellMs: 1200 + 3000, target: cursor } };
      case 'flight': {
        addFear(st, t, 0.25);
        const away = this.awayFromCursor(4, 8);
        return away ? { state: 'running', init: { variant: 'flight', target: away, then: { state: 'watchingCursor', init: {} } } } : { state: 'watchingCursor', init: {} };
      }
      case 'playful': {
        d.playNeed = clamp(d.playNeed - 0.1, 0, 1);
        const options: Array<'rollOver' | 'zoomies' | 'hop'> = ['rollOver'];
        if (this.subAllowed('reactionZoomie') && st.energy > 0.3) options.push('zoomies');
        if (st.bond > 0.6 && this.subAllowed('reactionPounce') && this.now - this.lastPounceAt >= 90_000) options.push('hop');
        const pick = options[Math.min(options.length - 1, Math.floor(this.random() * options.length))] as 'rollOver' | 'zoomies' | 'hop';
        // The mini pounce (a playful hop toward the cursor) counts toward the pounce cooldown.
        if (pick === 'hop') this.lastPounceAt = this.now;
        return { state: 'playing', init: { variant: pick, ...(pick === 'zoomies' ? { dwellMs: 3000 } : {}) } };
      }
      case 'avoid':
        this.avoidUntil = this.now + range(this.random, 60_000, 180_000);
        return { state: 'idle', init: { variant: 'avoid' } };
      case 'hide':
        return { state: 'hiding', init: { variant: 'flee', dwellMs: range(this.random, 20_000, 60_000) } };
    }
  }

  /**
   * The slink rule (ADR 0003 §5.3): a wary cat (w > 0.3) slinks 3-6 bw away only from a cursor
   * rushing at it (> 6 bw/s from within 4 bw, at or above its level, not over the window it stands
   * on); never with the cursor over it or within 1 bw (grabbing and petting stay easy), it stops
   * when the user slows down to aim, at most twice per approach; with no room it sits grumpy.
   */
  protected checkSlink(): void {
    const c = this.env?.cursor;
    const m = this.mover;
    if (!c || !Number.isFinite(c.x) || !Number.isFinite(c.y) || this.dt <= 0) {
      this.slinkPrev = null;
      return;
    }
    const dist = Math.abs(c.x - m.x) / this.bl;
    const prev = this.slinkPrev;
    this.slinkPrev = { at: this.now, dist };
    if (dist > 6 || this.now - this.slink.lastAt > 10_000) this.slink.count = 0;
    const a = this.act;
    const slinking = a.state === 'walking' && a.variant === 'slink' && a.cause === 'stimulus';
    const closing = prev && this.now > prev.at ? ((prev.dist - dist) * 1000) / (this.now - prev.at) : 0;
    if (slinking) {
      // The user is aiming (slow and close) or the cursor is right at the cat: stop and let it happen.
      if (this.env?.cursorOverCat || dist < 1 || (Math.abs(closing) < 1.5 && dist <= 3)) this.finish({ state: 'idle', init: {} });
      return;
    }
    if (this.cat.drives.wariness <= 0.3 || this.mode !== 'normal' || !m.grounded || m.onWall) return;
    if (this.env?.cursorOverCat || dist < 1 || dist > 4 || closing <= 6 || c.y > m.y) return;
    if (a.cause === 'command' || a.cause === 'interaction' || PHYSICAL_STATES.has(a.state) || ASLEEP_STATES.has(a.state) || REACTION_STATES.has(a.state)) return;
    if (this.slink.count >= 2) return;
    const sc = this.stripCaptionGate(c);
    const on = m.attachedSurface;
    const r = on ? this.windowRect(on.ownerId) : null;
    if (sc.strip || (r && c.x >= r.x && c.x <= r.x + r.width && c.y >= r.y && c.y <= r.y + r.height)) return;
    this.slink.count++;
    this.slink.lastAt = this.now;
    const away = this.awayFromCursor(3, 6);
    const room = m.walkRange;
    const free = room ? (c.x < m.x ? room.x1 - m.x : m.x - room.x0) / this.bl : 0;
    if (!away || free < 2) {
      this.request('annoyed', 'stimulus', { variant: 'grumpy', dwellMs: 3000 });
      return;
    }
    this.request('walking', 'stimulus', { variant: 'slink', target: away });
  }

  /**
   * Annoyed. v1.2 'defensive': a hiss (1.2 s), then a grumpy stare; a cursor that comes within
   * 1.5 bw in the first 8 s gets one swat, only with the paw's reach short of the hotspot
   * ('defensiveSwat'; with 'Paw at the pointer' off it stays a hiss). 'grumpy': a stare.
   */
  protected updAnnoyed(a: Activity): void {
    this.stop();
    if (a.variant === 'defensive') {
      const elapsed = this.now - a.startedAt;
      if (a.phase === 'hiss' && elapsed >= 1200) this.phase(a, 'grumpy');
      else if (a.phase === 'swat' && this.phaseElapsed(a)) this.phase(a, 'grumpy');
      const c = this.env?.cursor;
      const m = this.mover;
      if (a.counter === 0 && a.phase === 'grumpy' && elapsed < 8000 && c && Number.isFinite(c.x) && Number.isFinite(c.y) && Math.abs(c.x - m.x) <= 1.5 * this.bl && this.subAllowed('defensiveSwat') && !this.typingGate()) {
        const dir: Facing = c.x >= m.x ? 1 : -1;
        if (strikeClearancePx('swat', { x: m.x, y: m.y }, dir, c, m.scale, this.settings.appearance.size, { bw: m.bodyWidth, bh: m.bodyHeight }) >= requiredClearancePx(m.scale)) {
          a.counter = 1;
          m.faceToward(c.x, this.now);
          this.phase(a, 'swat', 450);
        }
      }
    }
    if (this.now - a.startedAt >= a.dwellMs) this.finish(this.afterAnnoyed(a));
  }

  protected enterHiding(a: Activity): void {
    const s = this.mover.walkRange;
    this.rememberEvent('hide');
    if (!s) {
      this.phase(a, 'hide');
      return;
    }
    const threatX = this.env?.cursor?.x ?? this.mover.x + this.mover.facing * this.bl;
    const edge = threatX < this.mover.x ? s.x1 : s.x0;
    if (Math.abs(edge - this.mover.x) < this.bl) {
      this.phase(a, 'hide');
      return;
    }
    a.target = { x: edge, y: this.mover.y };
    this.phase(a, 'flee');
  }

  protected updHiding(a: Activity): void {
    if (a.phase === 'flee') {
      if (!a.target || a.goalStatus === 'arrived' || a.goalStatus === 'unreachable' || this.now - a.phaseAt > 8000) {
        this.stop();
        this.phase(a, 'hide');
        return;
      }
      this.goTo(a.target, this.cat.stats.fear > 0.35 ? 'run' : 'walk', false);
      return;
    }
    this.stop();
    if (this.now - a.startedAt >= a.dwellMs) this.finish({ state: chance(this.random, 0.5) && !this.disabled.has('grooming') ? 'grooming' : 'idle', init: {} });
  }

  protected updHeld(a: Activity): void {
    const env = this.env;
    if (!this.mover.held) return;
    if (env?.dragCursor) {
      this.lastDragCursorAt = this.now;
      // Drag speed samples for the rough-drag trigger (> 1500 DIP/s for > 300 ms within 2 s).
      const p = env.dragCursor;
      const prev = this.lastDragPoint;
      if (prev && this.dt > 0 && Number.isFinite(p.x) && Number.isFinite(p.y)) {
        const speedDip = (Math.hypot(p.x - prev.x, p.y - prev.y) * 1000) / this.dt / this.mover.scale;
        this.dragTrace.push({ at: this.now, speedDip });
        while (this.dragTrace.length > 0 && (this.dragTrace[0] as { at: number }).at < this.now - ROUGH_DRAG_WINDOW_MS) this.dragTrace.shift();
      }
      this.lastDragPoint = Number.isFinite(p.x) && Number.isFinite(p.y) ? { x: p.x, y: p.y } : null;
    } else if (this.now - this.lastDragCursorAt > DRAG_LOST_MS) {
      this.mover.endDrag(null, ZERO, this.now, false);
      this.fallReason = 'drop';
      this.request('falling', 'physical');
      return;
    }
    if (this.now - a.startedAt > 15_000) {
      addStat(this.cat.stats, 'annoyance', (0.01 * this.dt * (1.2 - this.settings.interaction.patience)) / 1000);
      this.emotes.show('anger', this.now);
    }
  }

  /**
   * Landing (v1.2, ADR 0003 §6.4): impact-scaled. Planned: soft 250 ms, medium 350, hard a 300 ms
   * squash only. Unplanned: soft 250, medium 400, hard the 450 ms impact then a 900 ms recovery
   * (fear +0.05 unless confident, energy -0.01); after a throw the reaction replaces the recovery.
   */
  protected enterLanding(a: Activity): void {
    a.dwellMs = LANDING_MS;
    const info: LandingInfo | null = a.landing;
    const reason = this.fallReason;
    this.fallReason = null;
    this.lastFlightReason = reason;
    const cause = info ? fallCauseOf(reason, this.lastLossReason, info) : null;
    if (info && cause) this.emitFall({ at: this.now, cause, heightDip: info.fallHeightDip, impact: info.impact, jumpKind: info.jumpKind });
    this.lastLossReason = null;
    this.impactHint = info ? impactLevel(info.impactDip) : 0;
    const release = this.pendingRelease;
    this.pendingRelease = null;
    if (this.pounceFlight) this.onPounceLanded();
    const slipped = info?.slipped === true;
    const planned = (reason === 'jump' || reason === 'step') && !slipped;
    if (info?.impact === 'hard') this.playSound('thud');
    if (info) {
      if (planned) {
        if (info.impact === 'hard') this.phase(a, 'impact', 300);
        a.dwellMs = info.impact === 'hard' ? 300 : info.impact === 'medium' ? 350 : LANDING_MS;
      } else if (info.impact === 'medium') a.dwellMs = 400;
      else if (info.impact === 'hard') {
        const thrown = reason === 'throw' && info.thrown;
        const impactMs = thrown ? range(this.random, 300, 450) : 450;
        this.phase(a, 'impact', impactMs);
        // The recovery after an unplanned hard landing; a thrown cat's reaction replaces it.
        a.counter = thrown || info.forced ? 0 : 900;
        a.dwellMs = impactMs + a.counter;
        if (!thrown && !info.forced && this.mode === 'normal') {
          addStat(this.cat.stats, 'energy', -0.01);
          if (this.cat.traits.confidence <= 0.7) addFear(this.cat.stats, this.cat.traits, 0.05);
        }
      }
    }
    if (this.mode !== 'normal' || !info) return;
    // Planned moves and calm drops (a retracting taskbar) resume what the cat was doing.
    if (planned || reason === 'retracted') return;
    if (slipped) {
      // A missed take-off (ADR 0003 §6.6): frustrated a little, a retry with p 0.5 after 10-30 s.
      applyImpulse(this.cat.drives, 'slipMiss');
      const s = this.suspended;
      this.slipRetry = s && s.target && chance(this.random, 0.5) ? { at: this.now + range(this.random, 10_000, 30_000), state: s.state, variant: s.variant, target: s.target, windowId: s.windowId } : null;
      this.discardSuspended();
      return;
    }
    this.discardSuspended();
    if (info.forced) return;
    // v1.2: a throw, or a rough drag released slowly, gets one of the nine reactions.
    if (reason === 'throw' && info.thrown) {
      addStat(this.cat.stats, 'annoyance', 0.1);
      a.then = this.rollThrowReaction(info, 'throw', release?.speedDip ?? THROW_SPEED_DIP);
      return;
    }
    if (reason === 'drop' && release?.trigger === 'roughDrag') {
      a.then = this.rollThrowReaction(info, 'roughDrag', release.speedDip);
      return;
    }
    if (reason === 'perch') {
      // The window it sat on vanished: a short start, not a fright.
      a.then = { state: 'startled', init: { variant: 'lostFooting' } };
      return;
    }
    // A hard impact from a high drop: a surprise (fear as a mild start), not a fright.
    if (reason === 'drop' && info.impact === 'hard') {
      addFear(this.cat.stats, this.cat.traits, 0.15);
      a.then = { state: 'startled', init: { variant: 'jolt', dwellMs: 800 } };
      return;
    }
    if (reason === 'drop' || reason === 'throw') {
      a.then = { state: chance(this.random, 0.35) && !this.disabled.has('grooming') ? 'grooming' : 'idle', init: {} };
    }
  }

  protected noteInteraction(): void {
    this.lastInteractionAt = this.now;
    if (this.act.state === 'seekingAttention') this.act.answered = true;
  }

  protected onDragStart(at: Point): void {
    const i = this.settings.interaction;
    if (!i.enabled || !i.dragging || !isFinitePoint(at) || this.mover.held) return;
    this.noteInteraction();
    this.mover.startDrag(at);
    if (this.request('held', 'physical') !== 'ok') {
      this.mover.endDrag(null, ZERO, this.now, false);
      return;
    }
    bumpCounter(this.cat.memory, 'drags');
    addStat(this.cat.stats, 'annoyance', 0.03 * (1.2 - i.patience));
    this.dragTrace.length = 0;
    this.lastDragPoint = isFinitePoint(at) ? { x: at.x, y: at.y } : null;
    this.markDirty();
  }

  /** A rough drag: faster than ROUGH_DRAG_SPEED_DIP for longer than ROUGH_DRAG_MIN_MS within the last 2 s. */
  protected wasRoughDrag(): { speedDip: number } | null {
    let fastMs = 0;
    let peak = 0;
    let prevAt: number | null = null;
    for (const s of this.dragTrace) {
      if (s.at < this.now - ROUGH_DRAG_WINDOW_MS) continue;
      const step = prevAt === null ? 0 : s.at - prevAt;
      prevAt = s.at;
      if (s.speedDip > ROUGH_DRAG_SPEED_DIP) {
        fastMs += step;
        peak = Math.max(peak, s.speedDip);
      }
    }
    return fastMs > ROUGH_DRAG_MIN_MS ? { speedDip: peak } : null;
  }

  protected onDragEnd(at: Point, velocity: Point): void {
    if (!this.mover.held) return;
    const v = isFinitePoint(velocity) ? velocity : ZERO;
    const r = this.mover.endDrag(isFinitePoint(at) ? at : null, v, this.now, this.settings.interaction.throwing);
    this.fallReason = r.thrown ? 'throw' : 'drop';
    const speedDip = Math.hypot(v.x, v.y) / this.mover.scale;
    this.pendingRelease = null;
    if (r.thrown) {
      bumpCounter(this.cat.memory, 'throws');
      addStat(this.cat.stats, 'annoyance', 0.08);
      this.rememberEvent('throw', 'hard');
      this.lastThrowAt = this.now;
      this.pendingRelease = { trigger: 'throw', speedDip: Math.max(THROW_SPEED_DIP, speedDip) };
    } else {
      const rough = this.wasRoughDrag();
      if (rough) {
        applyImpulse(this.cat.drives, 'roughDrag');
        this.rememberRough('roughDrag');
        this.pendingRelease = { trigger: 'roughDrag', speedDip: rough.speedDip };
      }
    }
    this.dragTrace.length = 0;
    this.lastDragPoint = null;
    this.request('falling', 'physical');
  }

  protected onPet(strength: number): void {
    const i = this.settings.interaction;
    if (!i.enabled || !i.petting) return;
    const s = this.act.state;
    if (PHYSICAL_STATES.has(s)) return;
    this.noteInteraction();
    const st = Number.isFinite(strength) ? clamp(strength, 0, 1) : 0.5;
    const irritated = this.irritatedByPetting();
    // Stroking a reacting or irritated cat does not soothe it, it irritates it further.
    if (irritated) addStat(this.cat.stats, 'annoyance', PET_IRRITATION * st * (1.3 - i.patience));
    else applyPet(this.cat.stats, this.cat.traits, st);
    // v1.2 drives (ADR 0003 §1.2): a stroke satisfies the social need (never the play need); gentle
    // strokes soothe wariness, fear and irritability; frantic ones, or strokes right after a throw,
    // irritate a little (at most +0.1 per bout).
    const bout = this.petBout;
    if (this.now - bout.lastAt > PET_SESSION_GAP_MS) {
      bout.strokes = [];
      bout.count = 0;
      bout.irritation = 0;
      bout.swatRolled = false;
    }
    bout.lastAt = this.now;
    bout.strokes = bout.strokes.filter((t) => t > this.now - 1000);
    bout.strokes.push(this.now);
    bout.count++;
    const stroke = applyStroke(this.cat.drives, this.cat.stats, { strength: st, strokesLastSecond: bout.strokes.length, sinceThrowMs: this.now - this.lastThrowAt, boutIrritation: bout.irritation });
    bout.irritation += stroke.added;
    // The rate counts petting sessions: one stroke gesture produces many pet events.
    if (this.now - this.lastPetEventAt > PET_SESSION_GAP_MS) {
      const prefs = this.cat.memory.preferences;
      prefs.petRatePerHour = addRateEvent(prefs.petRatePerHour, PET_RATE_TAU_MS);
    }
    this.lastPetEventAt = this.now;
    // Overstimulation (ADR 0003 §1.7): after 8 strokes in a bout a cheeky, irritable cat may give
    // the hand a soft swat and hop away (the hand is already over it: click-through is unchanged).
    if (!irritated && bout.count >= OVERSTIM_STROKES && !bout.swatRolled && this.mode === 'normal' && !ASLEEP_STATES.has(s)) {
      bout.swatRolled = true;
      const M = clamp(Number.isFinite(this.settings.behavior.mischief) ? this.settings.behavior.mischief : 0, 0, 1);
      const m = this.cat.drives.mischief;
      if (M > 0 && m > 0.15 && this.subAllowed('overstimSwat') && !this.typingGate() && chance(this.random, clamp(((0.1 + 0.3 * this.cat.drives.irritability) * m) / M, 0, 1))) {
        applyImpulse(this.cat.drives, 'mischiefAct');
        this.playOneShot('swat', 450);
        const away = this.awayFromCursor(1, 1.5);
        if (away && this.request('walking', 'interaction', { variant: 'slink', target: away }) === 'ok') return;
      }
    }
    if (this.now - this.lastPetCountedAt >= 1000) {
      bumpCounter(this.cat.memory, 'pets');
      this.lastPetCountedAt = this.now;
      this.markDirty();
    }
    if (this.now - this.lastPetMemoryAt >= 30_000) {
      this.lastPetMemoryAt = this.now;
      this.rememberEvent('pet');
    }
    if (irritated) {
      // A reaction runs its course (afterAnnoyed may then hide); a calm but irritated cat objects.
      if (!REACTION_STATES.has(s) && this.mode === 'normal') this.request('annoyed', 'interaction');
      return;
    }
    this.petTimes = this.petTimes.filter((t) => t > this.now - 60_000);
    this.petTimes.push(this.now);
    this.emotes.show('heart', this.now);
    if (s === 'sleeping') {
      if (this.petTimes.filter((t) => t > this.now - 6000).length >= 3) this.request('beingPetted', 'interaction');
      return;
    }
    const limit = 30 * (0.5 + this.cat.traits.affection);
    if (this.petTimes.length > limit) {
      addStat(this.cat.stats, 'annoyance', 0.15);
      this.petTimes = [];
      if (this.request('annoyed', 'interaction') === 'ok') return;
    }
    this.request('beingPetted', 'interaction');
  }

  /** In the middle of a startle or annoyed reaction, or awake and still irritated: not in the mood to be stroked. */
  protected irritatedByPetting(): boolean {
    const a = this.act;
    if (ASLEEP_STATES.has(a.state)) return false;
    if (!a.done && (a.state === 'annoyed' || a.state === 'startled')) return true;
    return this.cat.stats.annoyance >= IRRITATED_ANNOYANCE;
  }

  protected onTap(at: Point): void {
    const i = this.settings.interaction;
    if (!i.enabled || !isFinitePoint(at) || PHYSICAL_STATES.has(this.act.state)) return;
    this.noteInteraction();
    bumpCounter(this.cat.memory, 'clicks');
    this.tapTimes = this.tapTimes.filter((t) => t > this.now - TAP_WINDOW_MS);
    this.tapTimes.push(this.now);
    const n = this.tapTimes.length;
    const s = this.act.state;
    if (ASLEEP_STATES.has(s)) {
      // A touch makes a sleeping cat flick an ear; often it wakes up.
      this.react('earFlick');
      if (n >= 2 || chance(this.random, 0.5)) this.request('wakingUp', 'interaction');
      return;
    }
    if (n >= 3) addStat(this.cat.stats, 'annoyance', 0.1 * (1.3 - i.patience) * (n - 2));
    // v1.2: taps beyond three within 8 s add to irritability (+0.03 each).
    if (n > 3) applyImpulse(this.cat.drives, 'extraTap');
    const annoyance = this.cat.stats.annoyance;
    if (this.mode === 'normal' && annoyance >= 0.75 && (s === 'annoyed' || this.recentStates.slice(0, 3).includes('annoyed'))) {
      if (this.request('hiding', 'interaction', { variant: 'flee' }) === 'ok') return;
    }
    if (this.mode === 'normal' && annoyance >= 0.45 + 0.3 * i.patience && s !== 'annoyed') {
      if (this.request('annoyed', 'interaction') === 'ok') return;
    }
    this.setGlance(at, 1800);
    this.mover.faceToward(at.x, this.now);
    this.react('earFlick');
    if (CALM_STATES.has(s) && chance(this.random, 0.6)) this.playOneShot('meow', 900);
    else this.emotes.show('question', this.now);
  }

  protected onDoubleTap(at: Point): void {
    const i = this.settings.interaction;
    if (!i.enabled || !isFinitePoint(at) || PHYSICAL_STATES.has(this.act.state)) return;
    this.noteInteraction();
    bumpCounter(this.cat.memory, 'doubleClicks');
    const s = this.act.state;
    if (this.cat.stats.annoyance > 0.5) {
      addStat(this.cat.stats, 'annoyance', 0.1);
      if (this.mode === 'normal' && s !== 'annoyed') this.request('annoyed', 'interaction');
      return;
    }
    if (ASLEEP_STATES.has(s)) {
      this.request('wakingUp', 'interaction');
      return;
    }
    const playful = this.cat.stats.energy > 0.3 && !this.typing && chance(this.random, 0.4 + 0.5 * this.cat.traits.playfulness);
    if (this.mode === 'normal' && playful && this.mover.grounded && this.request('playing', 'interaction', { variant: 'hop' }) === 'ok') return;
    this.setGlance(at, 1500);
    this.emotes.show(chance(this.random, 0.5) ? 'sparkle' : 'note', this.now, true);
  }
}
