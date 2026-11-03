// The cat simulation, layer 7: what the autonomous decision sees (v1.2: drives, rhythm, stay,
// repetition keys, place novelty, the hunt's readiness; ADR 0003 §1.4), how a chosen candidate
// starts, and the progress monitor.
import type { Point } from '../../shared/geometry';
import { clamp, isFiniteRect, rectCenter } from '../../shared/geometry';
import type { SimEnv } from '../../shared/sim';
import type { FollowUp } from './activity';
import type { Candidate, DecisionView } from './decide';
import { userIdleForSleep } from './decide';
import { range } from './random';
import type { TransitionCause } from './states';
import { PHYSICAL_STATES } from './states';
import { candidateKey } from './utility';
import { SimSalience } from './simSalience';
import type { RequestStatus } from './simCore';
import { AUTO_HIDE_COOLDOWN_MS, CLIMB_COOLDOWN_MS, PLACE_RECENT_MS, TAB_VISIT_COOLDOWN_MS } from './simCore';

export abstract class SimUtility extends SimSalience {
  protected override requestCandidate(c: Candidate, cause: TransitionCause): RequestStatus {
    const then: FollowUp | null = c.then ? { state: c.then, init: c.thenVariant ? { variant: c.thenVariant } : {} } : null;
    const r = this.request(c.state, cause, { variant: c.variant, target: c.target, windowId: c.windowId, then });
    if (r === 'ok') {
      // Surface excursions are occasional: each kind has its own cooldown.
      if (c.variant === 'climb') this.reactions.set('climb', this.now, range(this.random, CLIMB_COOLDOWN_MS[0], CLIMB_COOLDOWN_MS[1]));
      else if (c.variant === 'tabStrip') this.reactions.set('tabStripVisit', this.now, TAB_VISIT_COOLDOWN_MS);
      // A wary cat keeps out of the way now and then, not again and again (a few short hides an hour).
      else if (c.state === 'hiding') this.nextHideAt = this.now + range(this.random, AUTO_HIDE_COOLDOWN_MS[0], AUTO_HIDE_COOLDOWN_MS[1]);
    }
    return r;
  }

  protected override decisionView(): DecisionView {
    const env = this.env as SimEnv;
    const cur = this.cursorInfo();
    const scan = this.scanTargets();
    this.scan = scan;
    this.decisionTargets = { ...scan.status };
    const fg = env.foreground && !env.foreground.minimized && isFiniteRect(env.foreground.rect) ? env.foreground : null;
    const noTrips = this.tripsExhausted();
    const media = fg !== null && (fg.category === 'video' || fg.category === 'game' || fg.category === 'media');
    return {
      traits: this.cat.traits,
      stats: this.cat.stats,
      prefs: this.cat.memory.preferences,
      behavior: this.settings.behavior,
      disabled: this.disabled,
      localHour: Number.isFinite(env.localHour) ? env.localHour : 12,
      typing: this.typing,
      userIdleMs: Number.isFinite(env.userIdleMs) ? env.userIdleMs : 0,
      busySwitching: this.now < this.busyUntil,
      mediaForeground: media,
      screen: this.currentScreen(),
      recentRough: this.recentRough(),
      darkBias: this.darkBias(),
      quietMs: this.now - this.lastInteractionAt,
      awakeMs: this.now - this.awakeSince,
      cursor: cur,
      foreground: fg ? { center: rectCenter(fg.rect), distBodyLengths: Math.abs(rectCenter(fg.rect).x - this.mover.x) / this.bl } : null,
      favoriteSpot: this.favoriteSpotTarget(),
      perchTarget: scan.status.perch === 'available' && !noTrips ? scan.perch : null,
      tabStripOwner: scan.strip?.ownerId ?? null,
      edgeTarget: this.stay ? null : this.scanEdge(),
      resumePlace: this.resumeToken && this.now <= this.resumeToken.until ? this.resumeToken.place : null,
      wanderTarget: this.wanderTarget(),
      cornerTarget: this.cornerTarget(),
      typingIntensity: this.settings.behavior.reactToTyping && Number.isFinite(env.typingIntensity) ? clamp(env.typingIntensity, 0, 1) : 0,
      standingOn: this.mover.attachedSurface?.surfaceKind ?? 'floor',
      climbTarget: scan.status.climb === 'available' && !noTrips ? scan.climb : null,
      tabStripTarget: noTrips && this.mover.attachedSurface?.surfaceKind !== 'tabStrip' ? null : this.tabStripTarget(scan),
      edgeLook: this.edgeLookTarget(),
      surpriseReady: this.reactions.ready('surprise', this.now),
      exploreUrge: this.exploreUrge,
      downTarget: null,
      elevatedMs: this.topVisit ? this.now - this.topVisit.since : 0,
      recentStates: this.recentStates,
      current: this.act.state,
      isCoolingDown: (s) => this.coolingDown(s) || (s === 'hiding' && this.now < this.nextHideAt) || (s === 'fallingAsleep' && this.now < this.nextNapAt && !userIdleForSleep({ userIdleMs: env.userIdleMs, behavior: this.settings.behavior })),
      // ---- v1.2 (ADR 0003 §1.4) ----
      drives: this.cat.drives,
      zEff: this.zEffNow(),
      typingRaw: this.typingGate(),
      sinceTypingMs: this.now - this.lastTypingRawAt,
      episode: this.rhythm.started ? this.rhythm.episode : 'none',
      stay: this.stayView(),
      recentKeys: this.recentKeys,
      currentKey: candidateKey(this.act),
      placeSeen: (place) => {
        const at = this.placeVisits.get(place);
        return at === undefined ? 'never' : this.now - at <= PLACE_RECENT_MS ? 'recent' : 'session';
      },
      huntReady: this.huntReady(),
      cursorBand: this.cursorBand(),
      cat: { x: this.mover.x, y: this.mover.y, bw: this.bl },
      cursorInForeground: this.cursorInForeground(cur ? cur.point : null),
      restedMs: this.restedMs(),
      recentStimulus: this.now - this.lastStimulusAt < 10_000,
      ambushSpot: this.ambushSpot(),
      avoidCursor: this.now < this.avoidUntil,
      foregroundId: fg ? fg.id : null,
    };
  }

  /** At a wall's foot, a strip's end or a corner of the surface it stands on: a spot to lie in wait (ambush). */
  protected ambushSpot(): Point | null {
    const m = this.mover;
    const r = m.walkRange;
    if (!r || !m.grounded) return null;
    const near = 0.75 * this.bl;
    if (m.x - r.x0 <= near || r.x1 - m.x <= near) return { x: m.x, y: m.y };
    for (const w of m.wallTracks) {
      if (Math.abs(w.x - m.x) <= near && Math.abs(w.yBottom - m.y) <= m.bodyHeight) return { x: m.x, y: m.y };
    }
    return null;
  }

  /**
   * Progress monitor (ADR 0003 §6.9): the same activity with a goal the Mover reports as moving and
   * less than 0.25 bw of progress for 10 s is reset to a calm idle (decision cause 'watchdog').
   */
  protected checkProgress(): void {
    const a = this.act;
    const m = this.mover;
    const moving = this.mode === 'normal' && !PHYSICAL_STATES.has(a.state) && a.goalStatus === 'moving' && m.grounded;
    if (!this.progress.observe(this.now, a, moving, { x: m.x, y: m.y }, m.bodyWidth)) return;
    this.progress.reset();
    if (this.go('idle', 'lifecycle', {}) === 'ok') this.recordDecision('idle', null, 'watchdog');
  }
}
