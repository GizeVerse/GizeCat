// The cat simulation, layer 8: entering, running and leaving each activity.
import type { Point } from '../../shared/geometry';
import { clamp, isFiniteRect, rectCenter } from '../../shared/geometry';
import type { Pace } from '../movement';
import type { Activity } from './activity';
import { userIdleForSleep } from './decide';
import { applyImpulse } from './drives';
import { bumpCounter, ema01 } from './memory';
import { chance, range } from './random';
import { PHYSICAL_STATES, STATE_SPECS } from './states';
import { addStat } from './stats';
import { SimUtility } from './simUtility';
import { ATTENTION_QUIET_MS, SURPRISE_COOLDOWN_MS, LANDING_MS, NAP_COOLDOWN_MS, NAP_DWELL_MUL, TRAVEL_TIMEOUT_MS, CLIMB_TIMEOUT_MS } from './simCore';

export abstract class SimActivities extends SimUtility {
  // ---- activities -----------------------------------------------------------------

  protected override enterActivity(a: Activity): void {
    const s = a.state;
    if (!PHYSICAL_STATES.has(s)) this.stop();
    switch (s) {
      case 'sleeping':
        this.oneShot = null;
        if (a.variant === null) a.dwellMs *= NAP_DWELL_MUL * (1 + 0.3 * this.darkBias());
        break;
      case 'wakingUp':
        this.phase(a, 'stretch', a.quick ? 600 : 1600);
        break;
      case 'fallingAsleep':
        this.phase(a, 'yawn', a.quick ? 350 : 1200);
        break;
      case 'idle':
        if (a.variant === 'stretch') {
          this.phase(a, 'stretch', 1600);
          a.dwellMs = Math.max(a.dwellMs, 2600);
          break;
        }
        if (a.variant === 'shrug') {
          // A look around after landing, then it carries on.
          const m = this.mover;
          this.setGlance({ x: m.x + (chance(this.random, 0.5) ? 1 : -1) * 3 * this.bl, y: m.y - 0.5 * m.bodyHeight }, 1000);
        }
        this.phase(a, a.target || chance(this.random, 0.6) ? 'sit' : 'stand');
        break;
      case 'walking':
      case 'running':
        if (a.variant === 'patrol') {
          // Along the top it just got onto, then a sit up there.
          a.target ??= this.patrolTarget();
          a.then ??= { state: 'idle', init: {} };
          this.lastPatrolAt = this.now;
        }
        this.phase(a, a.variant === 'slink' ? 'slink' : a.variant === 'flight' ? 'sprint' : 'approach');
        // A tab-strip visit may need a climb: it may take as long as its route needs.
        if (a.variant === 'tabStrip' && a.target && this.mover.attachedSurface?.surfaceKind !== 'tabStrip') {
          a.approachMs = Math.max(TRAVEL_TIMEOUT_MS, this.approachTimeoutMs(a.target, 'walk', 0));
        }
        if (a.variant === 'screenEdge') this.beginEdgeVisit(a);
        this.beginExcursion(a);
        break;
      case 'chasingCursor':
        // v1.2: every chase is a hunt (ADR 0003 §4.2).
        a.variant = 'hunt';
        this.beginHunt(a);
        break;
      case 'watchingCursor':
        // After a playful dodge the cat turns back to the pointer in a crouch.
        if (a.variant === 'playful') this.phase(a, 'crouch', range(this.random, 600, 1100));
        else this.phase(a, 'main');
        if (a.variant === 'chatter') this.playSound('chirp');
        break;
      case 'curious': {
        this.emotes.show('question', this.now);
        this.react('headTilt');
        const near = !a.target || Math.abs(a.target.x - this.mover.x) < 2.5 * this.bl;
        if (a.variant === 'look' || near) this.phase(a, 'look', range(this.random, 3000, 7000));
        else this.phase(a, 'approach');
        break;
      }
      case 'inspectingWindow':
        this.phase(a, 'approach');
        if (a.variant !== 'edge') a.approachMs = this.inspectApproachMs(a);
        this.beginExcursion(a);
        break;
      case 'watchingUser':
        if (a.variant === 'nearby') this.phase(a, 'approach');
        else this.phase(a, 'sit', range(this.random, 15_000, 25_000));
        break;
      case 'playing':
        this.enterPlaying(a);
        break;
      case 'beingPetted':
        a.lastPetAt = this.now;
        this.emotes.show('heart', this.now, true);
        this.playSound('purr');
        break;
      case 'startled':
        // An occasional surprise at nothing in particular is a mild start, not a fright.
        if (a.variant === 'surprise') this.reactions.set('surprise', this.now, SURPRISE_COOLDOWN_MS);
        // v1.2: a rough-handling reaction already set its own fear (reactions.ts).
        if (a.variant !== 'jolt' && a.variant !== 'startledJump') addStat(this.cat.stats, 'fear', a.variant === 'surprise' ? 0.12 : a.variant === 'lostFooting' ? 0.15 : 0.35);
        this.emotes.show('exclaim', this.now, true);
        this.rememberEvent('startle');
        break;
      case 'annoyed':
        this.emotes.show('anger', this.now, true);
        this.rememberEvent('annoyed');
        if (a.variant === 'defensive') {
          this.phase(a, 'hiss', 1200);
          this.playSound('hiss');
        } else if (a.variant === 'grumpy') {
          this.phase(a, 'grumpy');
          this.playSound('growl');
        }
        break;
      case 'seekingAttention':
        if (a.variant !== 'greet') bumpCounter(this.cat.memory, 'attentionRequests');
        this.phase(a, 'approach');
        this.playSound(a.variant === 'greet' ? 'trill' : 'meow');
        break;
      case 'resting':
        this.phase(a, chance(this.random, 0.7) ? 'loaf' : 'sit');
        break;
      case 'hiding':
        this.enterHiding(a);
        break;
      case 'held':
        this.lastDragCursorAt = this.now;
        break;
      case 'jumping':
        this.phase(a, 'crouch');
        break;
      case 'landing':
        this.enterLanding(a);
        break;
      case 'away':
        this.phase(a, this.awayWasAsleep ? 'sleep' : 'main');
        break;
      case 'grooming':
      case 'falling':
        break;
    }
  }

  protected override exitActivity(a: Activity): void {
    this.settleExcursion(a);
    switch (a.state) {
      case 'chasingCursor':
        // A hunt left any other way (a drag, a command, petting) ends here.
        if (this.hunt && !this.hunt.ended) this.endHunt('interrupted', this.huntGateNow ?? 'other');
        this.hunt = null;
        if (a.observedMs >= 1200) {
          const engaged = a.engagedMs / a.observedMs >= 0.35;
          const p = this.cat.memory.preferences;
          p.cursorPlayAcceptance = ema01(p.cursorPlayAcceptance, engaged ? 1 : 0, 0.2);
          bumpCounter(this.cat.memory, engaged ? 'chasesEngaged' : 'chasesIgnored');
          if (engaged) addStat(this.cat.stats, 'bond', 0.003);
          // v1.2 (ADR 0003 §5.4): hunts are counted, not written to the recent ring.
        }
        break;
      case 'seekingAttention':
        // v1.2 drives: a greeting or an answered request satisfies the social need; an unanswered one relieves it a little and makes it cheekier.
        applyImpulse(this.cat.drives, a.variant === 'greet' || a.answered ? 'socialAnswered' : 'attentionIgnored');
        if (a.variant !== 'greet') {
          const p = this.cat.memory.preferences;
          p.attentionAcceptance = ema01(p.attentionAcceptance, a.answered ? 1 : 0, 0.25);
          this.nextAttentionAt = this.now + ATTENTION_QUIET_MS * (1.3 - clamp(this.settings.behavior.attentionSeeking, 0, 1));
          if (a.answered) {
            bumpCounter(this.cat.memory, 'attentionAnswered');
            addStat(this.cat.stats, 'bond', 0.01);
          }
          this.rememberEvent('attention', a.answered ? 'answered' : 'unanswered');
        }
        break;
      case 'inspectingWindow':
        if (a.phase !== 'approach') {
          bumpCounter(this.cat.memory, 'windowsInspected');
          this.rememberEvent('inspect', this.mover.perchWindowId ? 'window' : 'floor');
        }
        break;
      case 'sleeping':
        if (a.variant !== 'intro') this.nextNapAt = this.now + range(this.random, NAP_COOLDOWN_MS[0], NAP_COOLDOWN_MS[1]) * (1 - 0.5 * this.darkBias());
        if (this.now - a.startedAt >= 30_000) {
          bumpCounter(this.cat.memory, 'naps');
          this.rememberEvent('nap');
          this.awakeSince = this.now;
        }
        this.flushRestSpot();
        break;
      case 'resting':
        this.flushRestSpot();
        break;
      case 'playing':
        if (a.variant === 'zoomies' || a.variant === 'rollOver' || a.variant === 'pawAt' || a.variant === 'hop') this.rememberEvent('play', a.variant);
        break;
      default:
        break;
    }
  }

  protected updateActivity(): void {
    const a = this.act;
    switch (a.state) {
      case 'sleeping':
        return this.updSleeping(a);
      case 'wakingUp':
        this.stop();
        if (a.phase === 'stretch' && this.phaseElapsed(a)) this.phase(a, 'settle', range(this.random, 500, 1200));
        else if (a.phase === 'settle' && this.phaseElapsed(a)) this.finish();
        return;
      case 'fallingAsleep':
        this.stop();
        if (a.phase === 'yawn' && this.phaseElapsed(a)) this.phase(a, 'loaf', a.quick ? 350 : range(this.random, 1500, 3000));
        else if (a.phase === 'loaf' && this.phaseElapsed(a)) this.finish({ state: 'sleeping', init: { variant: a.variant } });
        return;
      case 'idle':
        if (this.pending) this.finish();
        else if (a.phase === 'stretch' && this.phaseElapsed(a)) this.phase(a, 'sit');
        else if (a.phase === 'stand' && this.now - a.phaseAt > 2500) this.phase(a, 'sit');
        // A follow-up waits for the dwell (a look after a reaction, then a groom).
        else if (a.then && this.now - a.startedAt >= a.dwellMs) this.finish();
        if (a.variant === 'watchTab') this.updWatchTab(a);
        return;
      case 'walking':
      case 'running':
        return this.updMove(a);
      case 'chasingCursor':
        return this.updHunt(a);
      case 'watchingCursor':
        return this.updWatchCursor(a);
      case 'curious':
        return this.updCurious(a);
      case 'inspectingWindow':
        return this.updInspect(a);
      case 'watchingUser':
        return this.updWatchUser(a);
      case 'playing':
        return this.updPlaying(a);
      case 'beingPetted':
        return this.updPetted(a);
      case 'startled':
        this.stop();
        if (this.now - a.startedAt >= a.dwellMs) this.finish(this.afterStartle(a));
        return;
      case 'annoyed':
        return this.updAnnoyed(a);
      case 'seekingAttention':
        return this.updSeekAttention(a);
      case 'resting':
      case 'grooming':
        this.stop();
        return;
      case 'hiding':
        return this.updHiding(a);
      case 'held':
        return this.updHeld(a);
      case 'jumping':
        a.phase = this.mover.mode === 'crouch' ? 'crouch' : 'air';
        return;
      case 'falling':
        return;
      case 'landing':
        // v1.2: an unplanned hard landing's impact squash, then its recovery (counter = recovery ms).
        if (a.phase === 'impact' && a.counter > 0 && this.phaseElapsed(a)) {
          this.phase(a, 'recover', a.counter);
          a.counter = 0;
        }
        if (this.now - a.startedAt >= Math.max(LANDING_MS, a.dwellMs)) this.finish();
        return;
      case 'away':
        this.stop();
        return;
    }
  }

  protected updSleeping(a: Activity): void {
    this.stop();
    const env = this.env;
    if (this.now - a.startedAt > 4000) this.emotes.show('zzz', this.now);
    if (!env || this.mode !== 'normal') return;
    const elapsed = this.now - a.startedAt;
    if (a.variant === 'intro') {
      if (elapsed >= a.dwellMs) this.finish({ state: 'wakingUp', init: {} });
      return;
    }
    const idleSleep = userIdleForSleep({ userIdleMs: env.userIdleMs, behavior: this.settings.behavior });
    if (a.variant === 'idleSleep') {
      if (!idleSleep && env.userIdleMs < 5000 && elapsed > 3000) this.finish({ state: 'wakingUp', init: { then: this.greetFollowUp() } });
      return;
    }
    if (idleSleep) return;
    if (elapsed >= a.dwellMs) {
      if (this.cat.stats.energy >= 0.55 || elapsed >= 2 * STATE_SPECS.sleeping.dwellMs[1]) this.finish({ state: 'wakingUp', init: {} });
      else a.dwellMs += 60_000;
    }
  }


  protected updMove(a: Activity): void {
    const env = this.env;
    if (a.variant === 'follow') {
      const rect = a.windowId ? this.windowRect(a.windowId, true) : null;
      if (!rect || this.now - a.startedAt > 6000) {
        this.finish();
        return;
      }
      this.goTo({ x: rect.x + rect.width / 2, y: this.mover.y }, 'walk', false, this.bl * 1.5);
      return;
    }
    if (!a.target || !env) {
      this.finish();
      return;
    }
    // The Mover carries out the chosen leave (Mover.leaveBy) and the screen-edge visit's phases.
    if (a.variant === 'leave') return this.updLeave(a);
    if (a.variant === 'screenEdge') return this.updEdgeClimb(a);
    const timeout = a.variant === 'climb' ? CLIMB_TIMEOUT_MS : a.approachMs > 0 ? a.approachMs : TRAVEL_TIMEOUT_MS;
    if (a.goalStatus === 'arrived' || a.goalStatus === 'unreachable' || this.now - a.startedAt > timeout) {
      // A trip up that did not get there (a goal whose top vanished ends on the floor below it): no
      // patrol along a top it never reached.
      if (a.then?.init.variant === 'patrol' && !(this.excursion?.act === a && this.excursion.arrived)) a.then = null;
      this.finish(a.then);
      if (a.variant === 'called') this.emotes.show('heart', this.now);
      return;
    }
    switch (a.variant) {
      case 'climb':
        // Up a window side to its top corner (then a pull-up), or down from the corner of the top it stands on.
        this.goTo(a.target, 'walk', true, undefined, { route: 'climb' });
        return;
      case 'patrol':
        // Along the top it is on, never off it.
        this.goTo(a.target, 'walk', false);
        return;
      case 'taskbar':
        // Onto the taskbar, or down off it to the floor it covers: exactly the surface named.
        this.goTo(a.target, 'walk', true, undefined, { literal: true });
        return;
      case 'tabStrip': {
        // Along the strip it is on, slowly; to a strip elsewhere by any way up (climbing too, v1.1.1).
        const onStrip = this.mover.attachedSurface?.surfaceKind === 'tabStrip';
        this.goTo(a.target, onStrip ? 'slow' : 'walk', true, undefined, { route: this.climbAllowed() ? 'any' : 'noClimb' });
        return;
      }
      case 'slink':
      case 'flight': {
        // v1.2 reaction moves stay on the surface the cat is on (ADR 0003 §5.2): no jump, pinned to it.
        const pin = this.mover.attachedSurface?.surfaceId;
        this.goTo(a.target, a.variant === 'flight' ? 'sprint' : 'slow', false, undefined, pin ? { surfaceId: pin } : {});
        return;
      }
      default: {
        const pace: Pace = a.state === 'running' ? 'run' : a.variant === 'favorite' || a.variant === 'nearby' ? 'slow' : 'walk';
        this.goTo(a.target, pace, a.variant !== 'retreat' && a.variant !== 'playful');
      }
    }
  }

  /** On a tab strip: face the active tab (the strip's focusX), now and then moving within 1 bw of it. */
  protected updWatchTab(a: Activity): void {
    const m = this.mover;
    const on = m.attachedSurface;
    if (!on || on.surfaceKind !== 'tabStrip') {
      this.finish();
      return;
    }
    const strip = m.ledgeById(on.surfaceId);
    const fx = strip?.focusX ?? a.target?.x ?? null;
    if (fx === null || !Number.isFinite(fx)) return;
    m.faceToward(fx, this.now);
    if (a.counter !== 0) return;
    a.counter = 1;
    const off = fx - m.x;
    if (strip && Math.abs(off) > 1.5 * this.bl && chance(this.random, 0.4)) {
      const x = fx - Math.sign(off) * range(this.random, 0.3, 1) * this.bl;
      this.finish({ state: 'walking', init: { variant: 'tabStrip', target: { x: clamp(x, strip.x0, strip.x1), y: strip.y }, then: { state: 'idle', init: { variant: 'watchTab', target: { x: fx, y: strip.y } } } } });
    }
  }

  protected updCurious(a: Activity): void {
    const t = a.target;
    if (!t) {
      this.finish();
      return;
    }
    if (a.phase === 'approach') {
      if (a.goalStatus === 'arrived' || a.goalStatus === 'unreachable' || this.now - a.phaseAt > 12_000) {
        this.stop();
        const look = range(this.random, 3000, 7000);
        this.phase(a, 'look', look);
        // It went over to look: the next decision can wait for that.
        a.dwellMs = Math.max(a.dwellMs, this.now - a.startedAt + look + 500);
        return;
      }
      a.dwellMs = Math.max(a.dwellMs, this.now - a.startedAt + 1000);
      const side = Math.sign(t.x - this.mover.x) || 1;
      this.goTo({ x: t.x - side * 1.2 * this.bl, y: t.y }, 'walk', true);
      return;
    }
    this.stop();
    this.mover.faceToward(t.x, this.now);
    if (this.phaseElapsed(a)) this.finish();
  }

  protected updWatchUser(a: Activity): void {
    const fg = this.env?.foreground ?? null;
    if (a.phase === 'approach') {
      if (!fg || a.goalStatus === 'arrived' || a.goalStatus === 'unreachable' || this.now - a.phaseAt > 10_000) {
        this.stop();
        this.phase(a, 'sit', range(this.random, 15_000, 25_000));
        return;
      }
      const c = rectCenter(fg.rect);
      const side = Math.sign(c.x - this.mover.x) || 1;
      this.goTo({ x: c.x - side * this.bl, y: fg.rect.y + fg.rect.height }, 'slow', true);
      return;
    }
    this.stop();
    const look = this.lookForState();
    if (look) this.mover.faceToward(look.x, this.now);
    if (a.phase === 'sit' && this.phaseElapsed(a)) this.phase(a, 'loaf');
  }

  protected enterPlaying(a: Activity): void {
    switch (a.variant) {
      case 'rollOver':
        this.phase(a, 'rollOver', range(this.random, 2500, 5000));
        return;
      case 'hop':
        this.phase(a, 'hop');
        return;
      case 'zoomies':
        a.counter = 0;
        this.phase(a, 'crouch', range(this.random, 300, 700));
        return;
      case 'tailChase':
        this.phase(a, 'tailChase', range(this.random, 3000, 6000));
        return;
      default:
        a.variant = 'pawAt';
        this.phase(a, 'crouch', range(this.random, 400, 900));
    }
  }

  protected updPlaying(a: Activity): void {
    switch (a.variant) {
      case 'hop':
        this.stop();
        if (a.phase === 'hop') {
          if (a.counter === 0) {
            a.counter = 1;
            if (this.mover.hop(this.now) && this.request('jumping', 'physical', { suspend: true }) === 'ok') {
              this.fallReason = 'jump';
              this.emotes.show('sparkle', this.now);
            } else {
              this.mover.cancelCrouch();
              this.finish();
            }
          } else {
            this.phase(a, 'sit', 700);
          }
        } else if (this.phaseElapsed(a)) {
          this.finish();
        }
        return;
      case 'zoomies':
        if (a.phase === 'crouch') {
          this.stop();
          if (this.phaseElapsed(a)) {
            this.phase(a, 'zoomies');
            a.counter = 2 + Math.floor(range(this.random, 0, 3));
            a.target = this.zoomieTarget();
          }
          return;
        }
        if (!a.target || a.goalStatus === 'arrived' || a.goalStatus === 'unreachable') {
          a.counter--;
          a.goalStatus = 'none';
          if (a.counter <= 0) {
            this.finish({ state: this.cat.stats.energy < 0.5 ? 'resting' : 'idle', init: {} });
            return;
          }
          a.target = this.zoomieTarget();
          this.stop();
        }
        if (a.target) this.goTo(a.target, 'run', false);
        return;
      case 'rollOver':
      case 'tailChase':
        this.stop();
        if (this.phaseElapsed(a)) this.finish();
        return;
      default:
        this.stop();
        // Typing started: no paw at the air near the cursor (B6), whatever 'React to typing' says.
        if (a.cause !== 'command' && a.cause !== 'interaction' && this.typingGate()) {
          this.finish();
          return;
        }
        if (a.phase === 'crouch' && this.phaseElapsed(a)) this.phase(a, 'pawAt', range(this.random, 2000, 5000));
        else if (a.phase === 'pawAt' && this.phaseElapsed(a)) this.finish();
    }
  }

  protected zoomieTarget(): Point | null {
    const s = this.mover.walkRange;
    if (!s) return null;
    const x = this.mover.x;
    const room = Math.max(x - s.x0, s.x1 - x);
    if (room < 2 * this.bl) return null;
    const dir = x - s.x0 > s.x1 - x ? -1 : 1;
    const dist = range(this.random, 0.5, 1) * Math.min(room, 14 * this.bl);
    return { x: clamp(x + dir * Math.max(dist, 2 * this.bl), s.x0, s.x1), y: this.mover.y };
  }

  protected updSeekAttention(a: Activity): void {
    const cur = this.cursorInfo();
    const fg = this.env?.foreground ?? null;
    if (a.phase === 'approach') {
      const goal = cur?.point ?? (fg ? { x: fg.rect.x + fg.rect.width / 2, y: fg.rect.y + fg.rect.height } : null);
      const close = goal ? Math.abs(goal.x - this.mover.x) < 1.5 * this.bl : true;
      if (!goal || close || a.goalStatus === 'arrived' || a.goalStatus === 'unreachable' || this.now - a.phaseAt > 12_000 || a.variant === 'greet') {
        this.stop();
        this.phase(a, 'meow', 900);
        this.restartClip = true;
        this.emotes.show(a.variant === 'greet' || this.cat.stats.bond > 0.5 ? 'heart' : 'question', this.now, true);
        return;
      }
      const side = Math.sign(goal.x - this.mover.x) || 1;
      this.goTo({ x: goal.x - side * 1.2 * this.bl, y: goal.y }, 'walk', true);
      return;
    }
    this.stop();
    if (cur) this.mover.faceToward(cur.point.x, this.now);
    if (a.phase === 'meow' && this.phaseElapsed(a)) this.phase(a, 'wait', a.variant === 'greet' ? 2500 : range(this.random, 6000, 12_000));
    else if (a.phase === 'wait' && this.phaseElapsed(a)) this.finish(a.answered ? null : { state: chance(this.random, 0.5) ? 'resting' : 'idle', init: {} });
  }

  protected lookForState(): Point | null {
    const a = this.act;
    const env = this.env;
    if (!env) return null;
    const cursor = env.cursor && Number.isFinite(env.cursor.x) && Number.isFinite(env.cursor.y) ? { x: env.cursor.x, y: env.cursor.y } : null;
    const fg = env.foreground && isFiniteRect(env.foreground.rect) && !env.foreground.minimized ? rectCenter(env.foreground.rect) : null;
    switch (a.state) {
      case 'watchingCursor':
      case 'chasingCursor':
        return cursor;
      case 'seekingAttention':
        return a.phase === 'approach' ? null : cursor;
      case 'watchingUser':
        return a.variant === 'screen' && a.target ? a.target : (fg ?? cursor);
      case 'curious':
        return a.phase === 'look' ? a.target : null;
      case 'inspectingWindow': {
        if (a.phase === 'approach') return null;
        if (a.variant === 'edge' && a.windowId) return this.edgeLookPoint(a.windowId);
        const r = a.windowId ? this.windowRect(a.windowId) : null;
        return r ? rectCenter(r) : a.target;
      }
      case 'playing':
        if (a.variant === 'pawAt' && cursor && !this.disabled.has('pawAtCursor')) {
          const d = Math.hypot(cursor.x - this.mover.x, cursor.y - this.mover.y) / this.bl;
          if (d < 2.5) return cursor;
        }
        return a.variant === 'pawAt' ? { x: this.mover.x + this.mover.facing * 0.8 * this.bl, y: this.mover.y - 0.2 * this.mover.bodyHeight } : null;
      case 'idle': {
        if (a.target) return a.target;
        const c = this.cursorInfo();
        return c && c.distBodyLengths < 6 && c.speedDip > 60 ? c.point : null;
      }
      case 'hiding':
        return a.phase === 'hide' ? cursor : null;
      default:
        return null;
    }
  }
}
