// The cat simulation, layer 3: elevated stays, the ways up (scans, urge, excursions) and what it
// does up there (inspecting a window, sitting at the edge).
import type { ArrivalRoute, LeaveKind, StayEndReason } from '../../shared/behaviorProfile';
import type { Point } from '../../shared/geometry';
import { clamp, rectCenter } from '../../shared/geometry';
import type { DecisionTarget, TargetAvailability } from '../../shared/surfaceDiagnostics';
import type { Pace } from '../movement';
import { MOVEMENT } from '../movement';
import type { Activity } from './activity';
import type { StayView } from './decide';
import { applyImpulse } from './drives';
import { arrivalRouteOf } from './profile';
import { chance, range } from './random';
import {
  chooseLeave,
  drawStayIntent,
  LEAVE_DEFER_PETTED_MS,
  LEAVE_FAILURE_WINDOW_MS,
  LEAVE_FAILURES_FOR_EMERGENCY,
  leaveBackoffMs,
  leaveKindWeight,
  PATROL_MIN_GAP_MS,
  STAY_HARD_CAP_MS,
  STAY_OVERDUE_MS,
} from './stay';
import { ASLEEP_STATES, PHYSICAL_STATES } from './states';
import { SimDrives } from './simDrives';
import type { StayTrack, TargetScan } from './simCore';
import { EXCURSION_RETRY_MS, APPROACH_MIN_MS, APPROACH_MAX_MS, PERCH_CANDIDATES, STRIP_CANDIDATES, URGE_SCAN_MS, TOP_MIN_STAY_MS, TOP_PATROL_BL, TOP_MAX_EXPLORE_MS, isElevatedKind } from './simCore';

export abstract class SimStay extends SimDrives {
  /**
   * Stay tracking (ADR 0003 §2): an arrival on a window top or tab strip starts a stay and draws its
   * intent once; the stay ends once the cat stands somewhere else (hops on the same surface do not
   * end it), with the reason: its own leave intent, or an imposed end (a drag, a call, a stimulus,
   * a covered or vanished support).
   */
  protected trackStay(): void {
    const m = this.mover;
    const attach: 'ground' | 'wall' | 'air' | 'held' = m.held ? 'held' : m.onWall ? 'wall' : m.grounded ? 'ground' : 'air';
    const on = attach === 'ground' ? m.attachedSurface : null;
    const kind = on && (on.surfaceKind === 'windowTop' || on.surfaceKind === 'tabStrip') ? on.surfaceKind : null;
    const st = this.stay;
    if (st) {
      if (on && on.surfaceId === st.surfaceId) {
        st.via = 'none';
        st.lastOnAt = this.now;
      } else if (attach !== 'ground') {
        if (attach === 'held') st.via = 'held';
        else if (attach === 'wall') st.via = st.via === 'held' ? 'held' : 'wall';
        else if (st.via === 'none') {
          const r = this.fallReason ?? this.lastFlightReason;
          st.via = r === 'jump' ? 'jump' : r === 'step' ? 'step' : r === 'perch' ? 'gone' : r === 'retracted' && this.lastLossReason === 'occluded' ? 'covered' : 'fall';
        }
      } else {
        const toElevated = kind !== null;
        let endReason: StayEndReason = 'leave';
        let leaveKind: LeaveKind | null = null;
        switch (st.via) {
          case 'held':
            endReason = 'drag';
            break;
          case 'wall':
            leaveKind = 'climbDown';
            break;
          case 'jump':
            leaveKind = toElevated ? 'hop' : 'jumpDown';
            break;
          case 'step':
            leaveKind = 'jumpDown';
            break;
          case 'none':
            leaveKind = 'walkOff';
            break;
          case 'covered':
            endReason = 'covered';
            break;
          case 'gone':
            endReason = 'gone';
            break;
          case 'fall':
            endReason = 'other';
            break;
        }
        // A way off that was not the leave intent is an imposed end (right-censored in B3).
        if (endReason === 'leave' && st.leaving === null) {
          const cause = this.act.cause;
          endReason = cause === 'command' ? 'called' : cause === 'stimulus' || cause === 'interaction' ? 'stimulus' : 'other';
        }
        if (endReason === 'leave' && leaveKind) {
          this.leaveHistory.push(leaveKind);
          if (this.leaveHistory.length > 8) this.leaveHistory.shift();
        }
        this.emitExcursion({
          phase: 'end',
          at: this.now,
          surfaceKind: st.kind,
          arrivedBy: st.arrivedBy,
          plannedMs: Math.round(st.plannedMs),
          dwellMs: Math.max(0, st.lastOnAt - st.since),
          endReason,
          leaveKind: endReason === 'leave' ? leaveKind : null,
        });
        this.stay = null;
      }
    }
    if (!this.stay && on && kind) {
      const prev = this.prevAttach;
      const arrivedBy: ArrivalRoute = arrivalRouteOf(prev, this.fallReason ?? this.lastFlightReason);
      // The stay intent, drawn once (ADR 0003 §2.1; Activity is not in it).
      const t = this.cat.traits;
      const intent = drawStayIntent(this.random, {
        stayLength: clamp(Number.isFinite(this.settings.behavior.stayLength) ? this.settings.behavior.stayLength : 0.5, 0, 1),
        laziness: t.laziness,
        curiosity: t.curiosity,
        zEff: this.zEffNow(),
        strip: kind === 'tabStrip',
        typing: this.typingRaw,
      });
      const ownerId = on.ownerId ?? null;
      this.stay = { kind, surfaceId: on.surfaceId, ownerId, since: this.now, lastOnAt: this.now, arrivedBy, via: 'none', plannedMs: intent.plannedMs, napMs: 0, nextLeaveAt: -Infinity, failures: [], leaving: null, byMover: false, overdue: false };
      if (ownerId) this.placeVisits.set(`w:${ownerId}`, this.now);
      applyImpulse(this.cat.drives, 'arrivedUp');
      this.emitExcursion({ phase: 'arrive', at: this.now, surfaceKind: kind, arrivedBy, plannedMs: Math.round(intent.plannedMs), dwellMs: 0, endReason: null, leaveKind: null });
    }
    this.prevAttach = attach;
    if (attach === 'ground' || attach === 'held') this.lastFlightReason = null;
  }

  /** The stay the cat stands on now (it may be leaving it). */
  protected onStay(): boolean {
    const st = this.stay;
    const on = this.mover.attachedSurface;
    return !!st && !!on && on.surfaceId === st.surfaceId && this.mover.grounded;
  }

  /**
   * The leave intent (ADR 0003 §2.3): once the stay's planned time is up (or its 30 min hard cap),
   * one decision over the Mover's leave options; a failed leave is retried after 2 -> 4 -> 8 s,
   * after three failures in 30 s the emergency option. Deferred 10-20 s while being petted.
   * Until the Mover offers leave options (BEH-b, wave 2) the cat leaves by the v1.1.1 descent
   * (a climb down the window side, else down to the floor below by the planner's own route).
   */
  protected updateStay(): void {
    const st = this.stay;
    if (!st || this.mode !== 'normal' || !this.onStay()) return;
    const s = this.act.state;
    if (ASLEEP_STATES.has(s)) {
      // A nap up there extends the plan by its length (never past the hard cap).
      st.napMs += this.dt;
      st.plannedMs = Math.min(STAY_HARD_CAP_MS, st.plannedMs + this.dt);
      return;
    }
    if (st.leaving !== null) {
      // Still up there with the leave no longer under way: it failed (retry with the backoff).
      const a = this.act;
      if (PHYSICAL_STATES.has(a.state) || (a.state === 'walking' && (a.variant === 'leave' || a.variant === 'climb'))) return;
      st.leaving = null;
      st.byMover = false;
      st.failures = st.failures.filter((t) => t > this.now - LEAVE_FAILURE_WINDOW_MS);
      st.failures.push(this.now);
      st.nextLeaveAt = this.now + leaveBackoffMs(st.failures.length);
      return;
    }
    const elapsed = this.now - st.since;
    if (elapsed < Math.min(st.plannedMs, STAY_HARD_CAP_MS) || this.now < st.nextLeaveAt) {
      if (!st.overdue && elapsed > st.plannedMs + STAY_OVERDUE_MS) st.overdue = true;
      return;
    }
    if (s === 'beingPetted') {
      st.nextLeaveAt = this.now + range(this.random, LEAVE_DEFER_PETTED_MS[0], LEAVE_DEFER_PETTED_MS[1]);
      return;
    }
    const a = this.act;
    if (PHYSICAL_STATES.has(s) || a.cause === 'command' || a.cause === 'interaction' || s === 'startled' || s === 'annoyed' || s === 'hiding' || this.mover.onWall) return;
    if (!this.budgetAvailable()) return;
    const ok = this.leaveStay(st);
    if (ok) return;
    st.failures = st.failures.filter((t) => t > this.now - LEAVE_FAILURE_WINDOW_MS);
    st.failures.push(this.now);
    st.nextLeaveAt = this.now + leaveBackoffMs(st.failures.length);
  }

  /** One leave attempt: the scored leave options, or (none offered) the v1.1.1 descent. */
  protected leaveStay(st: StayTrack): boolean {
    const m = this.mover;
    const t = this.cat.traits;
    const opts = m.leaveOptions();
    const emergencyOnly = st.failures.filter((x) => x > this.now - LEAVE_FAILURE_WINDOW_MS).length >= LEAVE_FAILURES_FOR_EMERGENCY;
    if (opts.length > 0) {
      const choice = chooseLeave(
        this.random,
        opts,
        { heights: this.settings.behavior.heights, confidence: t.confidence, laziness: t.laziness, exploreNeed: this.cat.drives.exploreNeed, typing: this.typingRaw, disabled: this.disabled },
        this.leaveHistory,
        emergencyOnly,
      );
      if (!choice) return false;
      if (this.request('walking', 'autonomous', { variant: 'leave', target: choice.target }) !== 'ok') return false;
      if (!m.leaveBy(choice, 'walk')) {
        this.act.done = true;
        return false;
      }
      st.leaving = choice.kind;
      st.byMover = true;
      this.recordDecision('walking', 'leave', 'leave');
      return true;
    }
    // v1.1.1 descent while the Mover offers no leave options (stub Mover until BEH-b).
    const climbDown = this.climbAllowed() ? m.climbOptions().find((o) => o.dir === 'down' && !this.excludedWindows.has(o.ownerId)) : undefined;
    const climbW = climbDown ? leaveKindWeight({ kind: 'climbDown', impact: null }, { heights: this.settings.behavior.heights, confidence: t.confidence, laziness: t.laziness, exploreNeed: this.cat.drives.exploreNeed, typing: this.typingRaw }) : 0;
    const jumpW = leaveKindWeight({ kind: 'jumpDown', impact: 'medium' }, { heights: this.settings.behavior.heights, confidence: t.confidence, laziness: t.laziness, exploreNeed: this.cat.drives.exploreNeed, typing: this.typingRaw });
    const viaClimb = climbDown !== undefined && this.random() < climbW / (climbW + jumpW);
    const fp = m.world.nearestFloorPoint({ x: m.x, y: m.y + 1 });
    const target = viaClimb && climbDown ? { x: climbDown.target.x, y: climbDown.target.y } : { x: fp.x, y: fp.y };
    if (this.request('walking', 'autonomous', { variant: viaClimb ? 'climb' : 'leave', target }) !== 'ok') return false;
    st.leaving = viaClimb ? 'climbDown' : 'jumpDown';
    this.recordDecision('walking', viaClimb ? 'climb' : 'leave', 'leave');
    return true;
  }

  /** What the decision sees of the stay (the on-surface plan's inputs), or null off a stay. */
  protected stayView(): StayView | null {
    const st = this.stay;
    if (!st || !this.onStay()) return null;
    const m = this.mover;
    const r = m.walkRange;
    const on = m.attachedSurface;
    let watchTab: Point | null = null;
    if (st.kind === 'tabStrip' && on && this.subAllowed('watchTab')) {
      const strip = m.ledgeById(on.surfaceId);
      if (strip && strip.focusX !== null && Number.isFinite(strip.focusX)) watchTab = { x: clamp(strip.focusX, strip.x0, strip.x1), y: strip.y };
    }
    return {
      kind: st.kind,
      walkRangeBl: r ? (r.x1 - r.x0) / this.bl : 0,
      patrolReady: this.now - this.lastPatrolAt >= PATROL_MIN_GAP_MS,
      patrolTarget: this.patrolTarget(),
      watchTab,
    };
  }

  protected updInspect(a: Activity): void {
    if (a.variant === 'edge') return this.updEdge(a);
    const rect = a.windowId ? this.windowRect(a.windowId, true) : null;
    if (!rect) {
      this.finish();
      return;
    }
    const center = rectCenter(rect);
    if (a.phase === 'approach') {
      // As long as the way there takes (walk, leap, climb), not a fixed 15 s (v1.1.1).
      if (a.goalStatus === 'arrived' || a.goalStatus === 'unreachable' || this.now - a.phaseAt > (a.approachMs > 0 ? a.approachMs : APPROACH_MIN_MS)) {
        this.stop();
        const look = range(this.random, 4000, 9000);
        this.phase(a, 'look', look);
        // Having got up to explore, it looks around before anything else comes to mind.
        if (a.variant === 'explore') a.dwellMs = Math.max(a.dwellMs, this.now - a.startedAt + look + 500);
        return;
      }
      const top = this.mover.ledgeSurfaces.find((l) => l.ownerId === a.windowId && (l.surfaceKind === 'windowTop' || l.surfaceKind === 'tabStrip'));
      if (top) {
        // On its way up the cat is not distracted by its next decision: the approach's own timeout ends it.
        a.dwellMs = Math.max(a.dwellMs, this.now - a.startedAt + 1000);
        this.goTo({ x: clamp(this.mover.x, top.x0, top.x1), y: top.y }, 'walk', true);
      } else {
        const side = Math.sign(center.x - this.mover.x) || 1;
        this.goTo({ x: center.x - side * this.bl, y: rect.y + rect.height }, 'walk', true);
      }
      return;
    }
    this.stop();
    this.mover.faceToward(center.x, this.now);
    if (!this.phaseElapsed(a)) return;
    // Up on the top it came to explore: a walk along it first (then a sit up there).
    if (a.phase === 'look' && a.variant === 'explore' && this.mover.perchWindowId === a.windowId && this.topVisit && this.topVisit.walked < TOP_PATROL_BL * this.bl) {
      this.finish({ state: 'walking', init: { variant: 'patrol' } });
      return;
    }
    if (a.phase === 'look' && this.mover.perchWindowId === a.windowId && chance(this.random, 0.5)) this.phase(a, 'loaf', range(this.random, 4000, 9000));
    else this.finish();
  }

  /** Sitting at the edge of the window top it stands on, looking down into the window. */
  protected updEdge(a: Activity): void {
    const m = this.mover;
    const on = m.attachedSurface;
    if (!a.windowId || !on || on.ownerId !== a.windowId || on.surfaceKind !== 'windowTop' || !m.grounded) {
      this.finish();
      return;
    }
    if (a.phase === 'approach') {
      if (!a.target || a.goalStatus === 'arrived' || a.goalStatus === 'unreachable' || this.now - a.phaseAt > 10_000) {
        this.stop();
        this.phase(a, 'look', range(this.random, 4000, 9000));
        return;
      }
      this.goTo(a.target, 'slow', false);
      return;
    }
    this.stop();
    const look = this.edgeLookPoint(a.windowId);
    this.mover.faceToward(look.x, this.now);
    if (!this.phaseElapsed(a)) return;
    if (a.phase === 'look' && chance(this.random, 0.4)) this.phase(a, 'loaf', range(this.random, 5000, 12_000));
    else this.finish();
  }

  /** A point inside the window below the cat on its top edge: where it looks while sitting there. */
  protected edgeLookPoint(windowId: string): Point {
    const m = this.mover;
    const bh = m.bodyHeight;
    const rect = this.windowRect(windowId);
    const ahead = m.x + m.facing * 1.2 * this.bl;
    if (!rect) return { x: ahead, y: m.y + 3 * bh };
    return { x: clamp(ahead, rect.x, rect.x + rect.width), y: Math.max(m.y + bh, Math.min(m.y + 4 * bh, rect.y + rect.height * 0.5)) };
  }

  protected wanderTarget(): Point | null {
    const m = this.mover;
    const s = m.currentSurface;
    const r = m.walkRange;
    if (!s || !r) return null;
    // v1.2 (ADR 0003 §2.4): the v1.1.1 descent paths are gone; a stay ends by its leave intent, so
    // a wander stays on the surface the cat stands on.
    const dir = chance(this.random, 0.5) ? 1 : -1;
    for (const d of [dir, -dir]) {
      const x = clamp(m.x + d * range(this.random, 2, 8) * this.bl, r.x0, r.x1);
      if (Math.abs(x - m.x) >= 1.5 * this.bl) return { x, y: m.y };
    }
    return null;
  }

  /**
   * The far end of the surface the cat stands on (a corner of the floor, of a window top or
   * of the taskbar), when it is a walk away: three body lengths on a floor, 1.5 on a ledge.
   */
  protected cornerTarget(): Point | null {
    const m = this.mover;
    const s = m.currentSurface;
    const r = m.walkRange;
    if (!s || !r || !m.grounded) return null;
    const floor = s.kind === 'floor';
    const inset = (floor ? 0.6 : 0.1) * this.bl;
    const left = r.x0 + inset;
    const right = r.x1 - inset;
    if (right <= left) return null;
    const x = m.x - left > right - m.x ? left : right;
    return Math.abs(x - m.x) >= (floor ? 3 : 1.5) * this.bl ? { x, y: m.y } : null;
  }

  // ---- v1.1.1: where the cat can go up, and the urge to go --------------------------------

  /** Window tops, sides and tab strips the cat could go up to from where it stands, with why it cannot for each. */
  protected scanTargets(): TargetScan {
    const perch = this.scanPerch();
    const climb = this.scanClimb();
    const strip = this.scanStrip();
    return { at: this.now, perch: perch.target, climb: climb.target, strip: strip.target, status: { perch: perch.status, climb: climb.status, tabStrip: strip.status } };
  }

  /** Some way up is within reach, whether or not its cooldown allows it now. */
  protected canGoUp(scan: TargetScan): boolean {
    return scan.perch !== null || scan.climb?.dir === 'up' || scan.strip !== null;
  }

  /** Nothing usable of these kinds: is that because every one listed belongs to a private window? */
  protected noneOrExcluded(kinds: readonly string[]): TargetAvailability {
    for (const s of this.surfaceIndex.values()) {
      if (kinds.includes(s.kind) && (s.excluded === true || this.excludedWindows.has(s.ownerId))) return 'excluded';
    }
    return 'noSurfaces';
  }

  protected climbAllowed(): boolean {
    return !this.disabled.has('climbWindows') && !this.disabled.has('perchOnWindows');
  }

  /**
   * A window top or tab strip to jump or climb up to and explore ('Sit on windows'): not the
   * window the cat is on, not one that is leaving or private; the nearest few are checked for a route.
   */
  protected scanPerch(): { target: TargetScan['perch']; status: TargetAvailability } {
    const m = this.mover;
    if (this.disabled.has('perchOnWindows')) return { target: null, status: 'disabled' };
    if (!m.grounded) return { target: null, status: 'notGrounded' };
    const here = m.perchWindowId;
    const tops = m.ledgeSurfaces.filter((l) => isElevatedKind(l.surfaceKind) && l.ownerId !== null && l.ownerId !== here && l.phase !== 'leaving');
    if (tops.length === 0) return { target: null, status: this.noneOrExcluded(['windowTop', 'tabStrip']) };
    const open = tops.filter((l) => !this.excludedWindows.has(l.ownerId as string));
    if (open.length === 0) return { target: null, status: 'excluded' };
    const options = open
      .map((l) => {
        // On a tab strip it heads for the resting span (the tabs), not the controls beside them.
        const span = l.surfaceKind === 'tabStrip' && l.rest ? l.rest : l;
        const point = { x: clamp(m.x, span.x0, span.x1), y: l.y };
        return { l, point, d: Math.hypot(point.x - m.x, point.y - m.y) };
      })
      .sort((a, b) => a.d - b.d)
      .slice(0, PERCH_CANDIDATES);
    for (const o of options) {
      if (!m.canReach(o.point)) continue;
      return { target: { windowId: o.l.ownerId as string, point: o.point }, status: this.coolingDown('inspectingWindow') ? 'cooldown' : 'available' };
    }
    return { target: null, status: 'unreachable' };
  }

  /**
   * The nearest climb that can start from where the cat stands: up a window side (stepping or
   * leaping onto it), or down from the top it is on once it has explored that top.
   */
  protected scanClimb(): { target: TargetScan['climb']; status: TargetAvailability } {
    const m = this.mover;
    if (!this.climbAllowed()) return { target: null, status: 'disabled' };
    if (!m.grounded) return { target: null, status: 'notGrounded' };
    if (m.wallTracks.length === 0) return { target: null, status: this.noneOrExcluded(['windowSide']) };
    let best: { point: Point; dir: 'up' | 'down'; ownerId: string } | null = null;
    let bestDist = Infinity;
    let options = 0;
    let excluded = 0;
    for (const o of m.climbOptions()) {
      if (o.dir === 'down' && !this.topExplored()) continue;
      options++;
      if (this.excludedWindows.has(o.ownerId)) {
        excluded++;
        continue;
      }
      const dist = Math.abs(o.startX - m.x) / this.bl;
      if (dist > 15 || dist >= bestDist) continue;
      best = { point: { x: o.target.x, y: o.target.y }, dir: o.dir, ownerId: o.ownerId };
      bestDist = dist;
    }
    if (!best) return { target: null, status: options > 0 && excluded === options ? 'excluded' : 'unreachable' };
    return { target: best, status: this.reactions.ready('climb', this.now) ? 'available' : 'cooldown' };
  }

  /**
   * A tab strip worth a visit ('Tab strips'): the nearest few reachable by any way up the cat may
   * take (climbing too, while climbing is on). Standing on a strip: walking along it.
   */
  protected scanStrip(): { target: TargetScan['strip']; status: TargetAvailability } {
    const m = this.mover;
    if (this.disabled.has('tabStrips')) return { target: null, status: 'disabled' };
    if (!m.grounded) return { target: null, status: 'notGrounded' };
    const on = m.attachedSurface;
    if (on?.surfaceKind === 'tabStrip') {
      const strip = m.ledgeById(on.surfaceId) ?? m.currentSurface;
      const rest = strip ? (strip.rest ?? { x0: strip.x0, x1: strip.x1 }) : null;
      return { target: null, status: rest && rest.x1 - rest.x0 >= 1.5 * this.bl ? 'available' : 'unreachable' };
    }
    const strips = m.ledgeSurfaces.filter((l) => l.surfaceKind === 'tabStrip' && l.phase !== 'leaving');
    if (strips.length === 0) return { target: null, status: this.noneOrExcluded(['tabStrip']) };
    const open = strips.filter((l) => !(l.ownerId !== null && this.excludedWindows.has(l.ownerId)));
    if (open.length === 0) return { target: null, status: 'excluded' };
    const route = this.climbAllowed() ? 'any' : 'noClimb';
    const nearest = open
      .map((l) => ({ l, d: Math.hypot(clamp(m.x, l.x0, l.x1) - m.x, l.y - m.y) }))
      .sort((a, b) => a.d - b.d)
      .slice(0, STRIP_CANDIDATES);
    for (const { l } of nearest) {
      const rest = l.rest ?? { x0: l.x0, x1: l.x1 };
      if (!m.canReach({ x: (rest.x0 + rest.x1) / 2, y: l.y }, route)) continue;
      return { target: { y: l.y, rest: { x0: rest.x0, x1: rest.x1 }, ownerId: l.ownerId }, status: this.reactions.ready('tabStripVisit', this.now) ? 'available' : 'cooldown' };
    }
    return { target: null, status: 'unreachable' };
  }

  /**
   * On a tab strip: another point of its resting span to walk to. Elsewhere (when the visit
   * cooldown allows): a resting point on the nearest reachable tab strip.
   */
  protected tabStripTarget(scan: TargetScan): Point | null {
    const m = this.mover;
    if (!m.grounded || this.disabled.has('tabStrips')) return null;
    const on = m.attachedSurface;
    if (on?.surfaceKind === 'tabStrip') {
      const strip = m.ledgeById(on.surfaceId) ?? m.currentSurface;
      if (!strip) return null;
      const rest = strip.rest ?? { x0: strip.x0, x1: strip.x1 };
      if (rest.x1 - rest.x0 < 1.5 * this.bl) return null;
      for (let i = 0; i < 2; i++) {
        const x = range(this.random, rest.x0, rest.x1);
        if (Math.abs(x - m.x) >= 1.5 * this.bl) return { x, y: strip.y };
      }
      return null;
    }
    const strip = scan.status.tabStrip === 'available' ? scan.strip : null;
    if (!strip) return null;
    return { x: strip.rest.x0 + (strip.rest.x1 - strip.rest.x0) * range(this.random, 0.2, 0.8), y: strip.y };
  }

  /**
   * 0..1 urge to go up (DecisionView.exploreUrge). It grows while the cat is awake on the floor
   * or a taskbar (not held, not in the air) and some way up is within reach: faster for a
   * curious, playful cat, slower for a lazy one (0 to 1 in 3-8 min), half as fast while the user
   * types. With nothing within reach it does not grow. Getting up onto a top resets it.
   * The ways up are looked for every URGE_SCAN_MS down there, asleep too, and the decision
   * diagnostics follow that look: windows come and go between decisions (surface verdict).
   */
  protected updateUrge(dt: number): void {
    if (this.mode !== 'normal' || !(dt > 0)) return;
    const m = this.mover;
    const s = this.act.state;
    const on = m.attachedSurface;
    const low = m.grounded && (on === null || on.surfaceKind === 'taskbar');
    if (!low || PHYSICAL_STATES.has(s)) return;
    if (this.now - this.scan.at >= URGE_SCAN_MS) {
      this.scan = this.scanTargets();
      this.decisionTargets = { ...this.scan.status };
    }
    if (ASLEEP_STATES.has(s) || !this.canGoUp(this.scan)) return;
    this.exploreUrge = Math.min(1, this.exploreUrge + ((this.typing ? 0.5 : 1) * dt) / this.urgeTauMs());
  }

  /** Time for the urge to grow from 0 to 1, ms: personality-aware, within 3-8 min. */
  protected urgeTauMs(): number {
    const t = this.cat.traits;
    const c = (v: number): number => (Number.isFinite(v) ? clamp(v, 0, 1) : 0.5);
    const minutes = (5.5 * (0.75 + 0.5 * c(t.laziness))) / (0.7 + 0.4 * c(t.curiosity) + 0.2 * c(t.playfulness));
    return clamp(minutes, 3, 8) * 60_000;
  }

  /**
   * Arrivals on window tops and tab strips (from the floor, a taskbar or a side): the excursion
   * count, the urge reset and the top being explored. A trip up that got onto a side and ended
   * back down without getting there (turned back, let go, missed the leap) has failed.
   */
  protected trackElevation(): void {
    if (this.mode === 'away') return;
    this.trackStay();
    const m = this.mover;
    const e = this.excursion;
    if (!m.grounded) {
      if (m.onWall && e) e.leftGround = true;
      return;
    }
    const on = m.attachedSurface;
    const elevated = on !== null && isElevatedKind(on.surfaceKind);
    if (on && elevated) {
      if (!this.wasElevated) {
        this.excursionCount++;
        this.lastElevatedAt = this.now;
        this.exploreUrge = 0;
      }
      const v = this.topVisit;
      if (!v || v.surfaceId !== on.surfaceId) this.topVisit = { surfaceId: on.surfaceId, since: this.now, x0: m.x, walked: 0 };
      else v.walked = Math.max(v.walked, Math.abs(m.x - v.x0));
      if (e && on.surfaceId !== e.from) e.arrived = true;
    } else {
      this.topVisit = null;
      if (e && e.leftGround && !e.arrived && !e.fromElevated && this.act === e.act) {
        if (e.act.then?.init.variant === 'patrol') e.act.then = null;
        this.finish();
      }
    }
    this.wasElevated = elevated;
  }

  /** Up on a top, it has explored it (stayed a while and walked along it) and may head back down. */
  protected topExplored(): boolean {
    const v = this.topVisit;
    if (!v) return true;
    const stay = this.now - v.since;
    if (stay >= TOP_MAX_EXPLORE_MS) return true;
    if (stay < TOP_MIN_STAY_MS) return false;
    if (v.walked >= TOP_PATROL_BL * this.bl) return true;
    const r = this.mover.walkRange;
    return !r || r.x1 - r.x0 < (TOP_PATROL_BL + 0.5) * this.bl;
  }

  /** Up on a top it has explored: the floor below, to head back down to. */
  protected downTarget(): Point | null {
    const m = this.mover;
    if (!this.topVisit || !m.grounded || !isElevatedKind(m.attachedSurface?.surfaceKind) || !this.topExplored()) return null;
    const fp = m.world.nearestFloorPoint({ x: m.x, y: m.y + 1 });
    return { x: fp.x, y: fp.y };
  }

  /** A point a few body lengths along the top the cat stands on, toward the side with more room. */
  protected patrolTarget(): Point | null {
    const m = this.mover;
    const r = m.walkRange;
    if (!r || !m.grounded || !isElevatedKind(m.attachedSurface?.surfaceKind)) return null;
    const inset = 0.1 * this.bl;
    const roomLeft = m.x - (r.x0 + inset);
    const roomRight = r.x1 - inset - m.x;
    const room = Math.max(roomLeft, roomRight);
    if (room < 0.75 * this.bl) return null;
    const dir = roomRight >= roomLeft ? 1 : -1;
    return { x: m.x + dir * Math.min(room, range(this.random, 2.5, 6) * this.bl), y: m.y };
  }

  /** Starts tracking a trip up: exploring a top, climbing up a side, or visiting a tab strip from elsewhere. */
  protected beginExcursion(a: Activity): void {
    const m = this.mover;
    const on = m.attachedSurface;
    let kind: DecisionTarget | null = null;
    if (a.state === 'inspectingWindow' && a.variant === 'explore') kind = 'perch';
    else if (a.state === 'walking' && a.variant === 'climb' && a.target && a.target.y < m.y - m.bodyHeight) kind = 'climb';
    else if (a.state === 'walking' && a.variant === 'tabStrip' && on?.surfaceKind !== 'tabStrip') kind = 'tabStrip';
    if (!kind) return;
    this.excursion = { kind, act: a, from: on?.surfaceId ?? null, fromElevated: on !== null && isElevatedKind(on.surfaceKind), leftGround: false, arrived: false };
  }

  /** A trip up ended: a failed one is retried after a short cooldown; a successful one keeps the full cooldown. */
  protected settleExcursion(a: Activity): void {
    const e = this.excursion;
    if (!e || e.act !== a) return;
    this.excursion = null;
    if (e.arrived) return;
    // v1.2: a failed trip frustrates a little (ADR 0003 §1.2).
    if (e.leftGround) applyImpulse(this.cat.drives, 'tripFailed');
    const retry = range(this.random, EXCURSION_RETRY_MS[0], EXCURSION_RETRY_MS[1]);
    // Exploring a top keeps the inspect cooldown (30 s): already a short retry.
    if (e.kind === 'climb') this.reactions.set('climb', this.now, retry);
    else if (e.kind === 'tabStrip') this.reactions.set('tabStripVisit', this.now, retry);
  }

  /**
   * How long the way up to `target` may take: the walk there (plus, when it climbs, the length of
   * the top: it may climb the far side and walk back along it), the climb at climbing speed, the
   * leap and the pull-up, and a margin; within APPROACH_MIN_MS..APPROACH_MAX_MS.
   */
  protected approachTimeoutMs(target: Point, pace: Pace, ledgeWidth: number): number {
    const m = this.mover;
    const speed = Math.max(1, m.paceSpeedPx(pace));
    const ms = this.settings.behavior.movementSpeed;
    const climbSpeed = Math.max(1, MOVEMENT.climbUpDip * (Number.isFinite(ms) && ms > 0 ? ms : 1) * m.scale);
    const rise = Math.max(0, m.y - target.y);
    const walk = Math.abs(target.x - m.x) + (rise > m.bodyHeight ? clamp(ledgeWidth, 0, 20 * this.bl) : 0);
    const sec = walk / speed + rise / climbSpeed + 1.5 + 1 + 5;
    return Number.isFinite(sec) ? clamp(sec * 1000, APPROACH_MIN_MS, APPROACH_MAX_MS) : APPROACH_MIN_MS;
  }

  /** Approach timeout of an inspection: the way up onto the window's top, when it has one. */
  protected inspectApproachMs(a: Activity): number {
    const m = this.mover;
    const top = a.windowId ? m.ledgeSurfaces.find((l) => l.ownerId === a.windowId && isElevatedKind(l.surfaceKind)) : undefined;
    if (!top) return APPROACH_MIN_MS;
    return this.approachTimeoutMs({ x: clamp(m.x, top.x0, top.x1), y: top.y }, 'walk', top.x1 - top.x0);
  }

  /** Standing on a window top: a spot along it where the cat may sit at the edge and look down into the window. */
  protected edgeLookTarget(): { windowId: string; point: Point } | null {
    const m = this.mover;
    const on = m.attachedSurface;
    const r = m.walkRange;
    if (!m.grounded || !r || !on || on.surfaceKind !== 'windowTop' || on.ownerId.length === 0) return null;
    if (this.disabled.has('perchOnWindows') || this.disabled.has('inspectWindows') || this.excludedWindows.has(on.ownerId)) return null;
    const x = clamp(m.x + (chance(this.random, 0.5) ? 1 : -1) * range(this.random, 0, 2) * this.bl, r.x0, r.x1);
    return { windowId: on.ownerId, point: { x, y: m.y } };
  }
}
