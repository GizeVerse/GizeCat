// The cat simulation, layer 6: events from the desktop (windows, taskbars, tabs, typing, the
// cursor, perception) and commands.
import type { Point, Rect } from '../../shared/geometry';
import { clamp, isFiniteRect, rectCenter } from '../../shared/geometry';
import type { SimEvent } from '../../shared/sim';
import type { WindowInfo } from '../../shared/world';
import type { FollowUp } from './activity';
import type { Variant } from './decide';
import { chance, range } from './random';
import { eventSalience, INTERRUPT_SALIENCE, receptivity, RESTORED_SALIENCE } from './salience';
import { ACTIVE_STATES, ASLEEP_STATES, CALM_STATES, PHYSICAL_STATES } from './states';
import { flickRelevance, surfaceRelevance, windowRelevance } from './stimuli';
import { SimReactions } from './simReactions';
import { MAX_COMMAND_IGNORE_CHANCE, SCREEN_FRESH_MS, TASKBAR_REACT_GAP_MS, TASKBAR_LOOK_COOLDOWN_MS, TASKBAR_HOP_COOLDOWN_MS, TASKBAR_WAKE_COOLDOWN_MS, TAB_INVESTIGATE_COOLDOWN_MS, isFinitePoint } from './simCore';

/** Dedupe key of a desktop event that can cause a reaction (null: not deduped). */
function salienceKey(ev: SimEvent): string | null {
  switch (ev.type) {
    case 'window.shown':
    case 'window.restored':
      return ev.window && typeof ev.window.id === 'string' ? `win:${ev.window.id}` : null;
    case 'window.closed':
    case 'window.minimized':
      return `gone:${ev.id}`;
    case 'window.moveStart':
    case 'window.moveEnd':
      return `${ev.type}:${ev.id}`;
    case 'taskbar.shown':
    case 'taskbar.hidden':
      return `${ev.type}:${ev.surfaceId}`;
    case 'tabs.changed':
      return `tabs:${ev.surfaceId}:${ev.change}:${ev.focusX ?? ''}`;
    default:
      return null;
  }
}

export abstract class SimSalience extends SimReactions {
  /**
   * A window was restored or un-maximized (ADR 0003 §1.8): salience 0.7 times how receptive the
   * cat is; above the interrupt level a calm cat takes a curious look at the window's new top
   * ('inspectWindow'), and the urge to go up grows by 0.2.
   */
  protected onWindowRestored(w: WindowInfo): void {
    if (!w || !isFiniteRect(w.rect) || w.minimized || w.excluded || this.excludedWindows.has(w.id)) return;
    if (!this.settings.behavior.reactToWindows || !this.subAllowed('inspectWindow')) return;
    const s = this.act.state;
    const sal = eventSalience(RESTORED_SALIENCE, this.settings.behavior.activitySensitivity, receptivity(s, this.onStay()));
    this.exploreUrge = Math.min(1, this.exploreUrge + 0.2);
    const top = { x: w.rect.x + w.rect.width / 2, y: w.rect.y };
    if (sal >= INTERRUPT_SALIENCE && CALM_STATES.has(s) && !this.typingGate() && this.reactions.take('restoredLook', this.now, 20_000)) {
      if (this.request('curious', 'stimulus', { target: top, variant: 'restored' }) === 'ok') {
        this.recordDecision('curious', 'restored', 'stimulus');
        return;
      }
    }
    if (sal >= 0.1) this.setGlance(top, 1500);
  }

  /** How open the cat is to an event now (asleep 0.2, calm 1, active 0.5, on a stay 0.6, reacting 0). */
  protected receptivityNow(): number {
    return receptivity(this.act.state, this.onStay());
  }

  /** Greeting after the user returns: off at 'Attention seeking' 0 %, rarer below the default. */
  protected greetFollowUp(): FollowUp | null {
    if (this.disabled.has('seekAttention') || !this.reactions.ready('greet', this.now)) return null;
    const seeking = clamp(this.settings.behavior.attentionSeeking, 0, 1);
    if (!(seeking > 0) || (seeking < 0.35 && !chance(this.random, seeking / 0.35))) return null;
    this.reactions.set('greet', this.now, 10 * 60_000);
    return { state: 'seekingAttention', init: { variant: 'greet' } };
  }

  // ---- events ---------------------------------------------------------------------

  protected handleEvent(ev: SimEvent): void {
    let relocated = false;
    switch (ev.type) {
      case 'lifecycle.quitRequested':
        this.startQuit();
        return;
      // A locked session stays locked across suspend/resume: only unlock ends it.
      case 'system.lock':
        this.systemLocked = true;
        return;
      case 'system.unlock':
        this.systemLocked = false;
        return;
      case 'system.suspend':
        this.systemSuspended = true;
        return;
      case 'system.resume':
        this.systemSuspended = false;
        return;
      case 'display.changed':
        return;
      // Privacy verdicts are kept in every mode, so a window marked private stays off limits.
      // Window rects from events back up surface geometry (in memory only).
      case 'window.shown':
      case 'window.restored':
      case 'window.foreground':
        if (ev.window) {
          this.notePrivacy(ev.window.id, ev.window.excluded);
          if (!ev.window.minimized) this.noteWindowRect(ev.window.id, ev.window.rect);
        }
        break;
      case 'window.moveStart':
        this.notePrivacy(ev.id, ev.excluded);
        break;
      case 'window.moveEnd':
        this.notePrivacy(ev.id, ev.excluded);
        this.noteWindowRect(ev.id, ev.rect);
        // Bookkeeping, whatever the mode and whether or not the event gets a reaction below.
        this.movingWindows.delete(ev.id);
        break;
      case 'window.closed':
      case 'window.minimized':
        this.windowRects.delete(ev.id);
        this.movingWindows.delete(ev.id);
        break;
      case 'command.callCat':
        // Called while a fullscreen app keeps it hidden or quiet: it comes over to the caller's display.
        if (this.onFullscreenDisplay() && isFinitePoint(ev.at) && this.mover.relocate(ev.at)) {
          relocated = true;
          this.snapNext = true;
          this.updateMode();
        }
        break;
      default:
        break;
    }
    if (this.mode === 'quit' || this.mode === 'away') return;
    switch (ev.type) {
      case 'pointer.dragStart':
        return this.onDragStart(ev.at);
      case 'pointer.dragEnd':
        return this.onDragEnd(ev.at, ev.velocity);
      case 'pointer.pet':
        return this.onPet(ev.strength);
      case 'pointer.tap':
        return this.onTap(ev.at);
      case 'pointer.doubleTap':
        return this.onDoubleTap(ev.at);
      case 'pointer.hoverStart':
        if (this.settings.interaction.enabled && isFinitePoint(ev.at) && !ASLEEP_STATES.has(this.act.state)) this.setGlance(ev.at, 2000);
        return;
      case 'pointer.hoverEnd':
        return;
      case 'command.sleep':
        if (this.mode === 'normal' || this.mode === 'paused') this.request('fallingAsleep', 'command', { variant: 'forced' });
        return;
      default:
        break;
    }
    // v1.2: a taskbar that just slid away still blocks hunts for a moment (ADR 0003 §4.3), in any mode.
    if (ev.type === 'taskbar.hidden') this.taskbarHiddenAt = this.now;
    if (this.mode !== 'normal') return;
    // v1.2 (ADR 0003 §1.8): one desktop change delivered twice in a row (shown and restored, a strip
    // re-announced) gets one reaction; every such event counts as a recent stimulus.
    if (ev.type === 'window.moveStart') this.movingWindows.add(ev.id);
    const key = salienceKey(ev);
    if (key !== null) {
      if (!this.dedupe.fresh(key, this.now)) return;
      this.lastStimulusAt = this.now;
    }
    switch (ev.type) {
      case 'window.shown':
        return this.onWindowAppeared(ev.window, true);
      case 'window.restored':
        this.onWindowRestored(ev.window);
        return this.onWindowAppeared(ev.window, false);
      case 'window.closed': {
        const excluded = ev.excluded === true || this.excludedWindows.has(ev.id);
        this.excludedWindows.delete(ev.id);
        // The window the cat is on: losing its footing is the reaction (the mover drops it).
        if (ev.rect && isFiniteRect(ev.rect) && this.mover.perchWindowId !== ev.id) this.onWindowClosed(ev.rect, ev.category, excluded);
        return;
      }
      case 'window.foreground':
        return this.onForeground(ev.window, ev.switchesPerMinute);
      case 'window.moveStart':
        return this.onMoveStart(ev.id, this.excludedWindows.has(ev.id));
      case 'window.moveEnd':
        if (ev.rect && isFiniteRect(ev.rect)) this.onMoveEnd(ev.id, ev.rect, this.excludedWindows.has(ev.id));
        return;
      case 'window.minimized':
        return;
      case 'activity.typingStart':
        return this.onTypingStart();
      case 'activity.typingEnd':
        return;
      case 'activity.userIdle':
        this.nextDriveAt = this.now;
        return;
      case 'activity.userReturned':
        return this.onUserReturned(ev.idleMs);
      case 'cursor.flick':
        return this.onFlick(ev.speed, ev.at);
      case 'perception.visual':
        return this.onVisual(ev.summary.events, ev.summary.changeCenterPx, ev.summary.regionPx);
      case 'perception.ai':
        // An AI-described video or game counts like video-like local statistics: the cat keeps calmer.
        if (ev.report.scene === 'video' || ev.report.scene === 'game') this.screen = { kind: 'video', until: this.now + SCREEN_FRESH_MS };
        return this.onAi(ev.report.reaction, ev.report.interest, ev.regionPx);
      case 'command.callCat':
        return this.onCallCat(ev.at, relocated);
      case 'command.wake':
        if (ASLEEP_STATES.has(this.act.state) || this.act.state === 'resting') this.request('wakingUp', 'command');
        else this.playOneShot('meow', 900);
        return;
      case 'command.play':
        return this.onPlayCommand();
      case 'taskbar.shown':
        return this.onTaskbarShown(ev.surfaceId);
      case 'taskbar.hidden':
        return this.onTaskbarHidden(ev.surfaceId);
      case 'tabs.changed':
        return this.onTabsChanged(ev.surfaceId, ev.ownerId, ev.change, ev.focusX);
      default:
        return;
    }
  }

  // ---- environment surfaces ---------------------------------------------------------

  /**
   * Current geometry of a ledge of the given kind: the usable one the mover knows, else the
   * listed surface (not yet usable, e.g. still sliding in). Never a private window's, and
   * never a surface of another kind (a stale or mismatched id in an event).
   */
  protected ledgeGeometry(id: string, kind: 'taskbar' | 'tabStrip'): { y: number; x0: number; x1: number; rest: { x0: number; x1: number } | null; ownerId: string | null } | null {
    const usable = this.mover.ledgeById(id);
    if (usable) return usable.surfaceKind === kind ? { y: usable.y, x0: usable.x0, x1: usable.x1, rest: usable.rest, ownerId: usable.ownerId } : null;
    const s = this.surfaceIndex.get(id);
    if (!s || s.orientation !== 'ledge' || s.kind !== kind || s.excluded === true || this.excludedWindows.has(s.ownerId)) return null;
    if (!Number.isFinite(s.y) || !Number.isFinite(s.x0) || !Number.isFinite(s.x1) || s.x1 <= s.x0) return null;
    return { y: s.y, x0: s.x0, x1: s.x1, rest: null, ownerId: s.ownerId };
  }

  /** Distance from the cat's anchor to the nearest point of a ledge, in body lengths. */
  protected ledgeDistanceBl(l: { y: number; x0: number; x1: number }): number {
    const m = this.mover;
    return Math.hypot(clamp(m.x, l.x0, l.x1) - m.x, l.y - m.y) / this.bl;
  }

  /**
   * An auto-hide taskbar slid into view. How much the cat cares depends on how close it
   * is, what it is doing and its personality, and habituates fast: repeated shows soon get
   * nothing more than a glance. It may look toward it, or walk over and hop onto it (rare,
   * with a long cooldown); however often it flaps, at most one decision per few seconds.
   * Held, airborne or thrown, it ignores it; asleep it wakes only when it is right there and
   * curious enough (the physical lift of a cat standing above it happens regardless).
   */
  protected onTaskbarShown(surfaceId: string): void {
    if (this.disabled.has('taskbarPlay') || typeof surfaceId !== 'string') return;
    const s = this.act.state;
    if (PHYSICAL_STATES.has(s)) return;
    const tb = this.ledgeGeometry(surfaceId, 'taskbar');
    if (!tb) return;
    const habituation = this.surfaceHabit.register(`taskbar:${surfaceId}`, this.now);
    if (!this.reactions.take('taskbarReact', this.now, TASKBAR_REACT_GAP_MS)) return;
    const m = this.mover;
    const t = this.cat.traits;
    const st = this.cat.stats;
    const dist = this.ledgeDistanceBl(tb);
    const r = surfaceRelevance({
      distBodyLengths: dist,
      curiosity: t.curiosity,
      playfulness: t.playfulness,
      energy: st.energy,
      confidence: t.confidence,
      sensitivity: this.settings.behavior.activitySensitivity,
      habituation,
      typing: this.typing,
    });
    const point = { x: clamp(m.x, tb.x0, tb.x1), y: tb.y };
    if (m.attachedSurface?.surfaceId === surfaceId) return;
    if (ASLEEP_STATES.has(s)) {
      // Right next to it, a curious, rested cat may get up to see; otherwise an ear flick at most.
      const wakes = s === 'sleeping' && this.act.variant !== 'intro' && dist < 1.5 && r >= 0.5 && t.curiosity >= 0.6 && st.energy >= 0.5;
      if (wakes && chance(this.random, 0.5 * t.curiosity) && this.reactions.take('taskbarWake', this.now, TASKBAR_WAKE_COOLDOWN_MS)) {
        this.request('wakingUp', 'stimulus');
        return;
      }
      if (dist < 3) this.react('earFlick');
      return;
    }
    if (m.onWall) {
      if (r >= 0.05) this.setGlance(point, 1200);
      return;
    }
    // Standing on the floor it covers: the taskbar lifts the cat (physics); nothing to walk over to.
    const cur = m.currentSurface;
    if (cur?.kind === 'floor' && m.x >= tb.x0 && m.x <= tb.x1 && tb.y < m.y && m.y - tb.y <= 1.5 * m.bodyHeight) return;
    const intense = this.typing || (this.settings.behavior.reactToTyping && this.env !== null && this.env.typingIntensity > 0.5);
    const calm = CALM_STATES.has(s) || (s === 'walking' && this.act.cause !== 'command' && this.act.cause !== 'interaction');
    if (r >= 0.45 && calm && !intense && st.fear < 0.3 && this.reactions.ready('taskbarHop', this.now) && dist > 0.5 && m.canReach(point)) {
      if (this.request('walking', 'stimulus', { variant: 'taskbar', target: point, windowId: surfaceId }) === 'ok') {
        this.reactions.set('taskbarHop', this.now, range(this.random, TASKBAR_HOP_COOLDOWN_MS[0], TASKBAR_HOP_COOLDOWN_MS[1]));
        return;
      }
    }
    if (r >= 0.2 && CALM_STATES.has(s) && s !== 'curious' && this.reactions.take('taskbarLook', this.now, TASKBAR_LOOK_COOLDOWN_MS)) {
      if (this.request('curious', 'stimulus', { target: point, variant: 'look' }) === 'ok') return;
    }
    if (r >= 0.05 && !ACTIVE_STATES.has(s)) this.setGlance(point, 1500);
  }

  /**
   * A taskbar started sliding away. A trip to it is called off. Standing on it, the cat
   * flicks an ear and rides it down (the mover then sets it down or lets it drop calmly);
   * now and then a lively one hops down to the floor instead.
   */
  protected onTaskbarHidden(surfaceId: string): void {
    if (this.disabled.has('taskbarPlay') || typeof surfaceId !== 'string') return;
    const a = this.act;
    if ((a.state === 'walking' || a.state === 'running') && a.variant === 'taskbar' && a.windowId === surfaceId) this.finish();
    const m = this.mover;
    if (m.attachedSurface?.surfaceId !== surfaceId || !m.grounded) return;
    const s = a.state;
    if (PHYSICAL_STATES.has(s) || ASLEEP_STATES.has(s)) return;
    this.react('earFlick');
    const t = this.cat.traits;
    const st = this.cat.stats;
    if (this.typing || !(CALM_STATES.has(s) || s === 'walking') || st.energy < 0.4) return;
    if (!chance(this.random, 0.5 * t.playfulness * st.energy) || !this.reactions.take('taskbarHopOff', this.now, 60_000)) return;
    const floor = m.world.surfaceBelow(m.x, m.y + 1, []);
    if (!floor) return;
    this.request('walking', 'stimulus', { variant: 'taskbar', target: { x: floor.x, y: floor.y } });
  }

  /**
   * A tab was selected or added in a browser tab strip (geometry only, never names). Nearby
   * and awake, the cat glances at the active tab; standing on the strip it may now and then
   * walk over to it (cooldown, habituation, not while the user types).
   */
  /**
   * A tab strip changed (geometry only, never names; ADR 0003 §1.8). Selected: an ear flick, a head
   * turn to the active tab and, standing on the strip, now and then (p 0.3) a walk toward it. Added:
   * a look toward the new tab. Removed within 1.5 bw of the cat: a small surprise. Geometry: nothing.
   * All of it is 'tabReaction' ('Tab strips' and 'Tab reactions').
   */
  protected onTabsChanged(surfaceId: string, ownerId: string, change: 'added' | 'removed' | 'selected' | 'geometry', focusX: number | null): void {
    if (!this.subAllowed('tabReaction') || change === 'geometry' || typeof surfaceId !== 'string') return;
    if (typeof ownerId === 'string' && this.excludedWindows.has(ownerId)) return;
    const s = this.act.state;
    if (ASLEEP_STATES.has(s) || PHYSICAL_STATES.has(s)) return;
    const strip = this.ledgeGeometry(surfaceId, 'tabStrip');
    if (!strip) return;
    const m = this.mover;
    const onIt = m.attachedSurface?.surfaceId === surfaceId;
    const hasFocus = typeof focusX === 'number' && Number.isFinite(focusX);
    const focus = hasFocus ? { x: clamp(focusX, strip.x0, strip.x1), y: strip.y } : null;
    if (!onIt && (!focus || this.ledgeDistanceBl({ y: strip.y, x0: focus.x, x1: focus.x }) > 10)) return;
    const habituation = this.surfaceHabit.register(`tabs:${surfaceId}`, this.now);
    if (habituation > 0.9) return;
    if (change === 'removed') {
      if (onIt && focus && Math.abs(focus.x - m.x) <= 1.5 * this.bl && CALM_STATES.has(s) && this.reactions.take('tabRemoved', this.now, 20_000)) {
        this.request('startled', 'stimulus', { variant: 'surprise', target: { x: focus.x, y: strip.y + 0.4 * m.bodyHeight } });
      }
      return;
    }
    if (!focus) return;
    // Look at the tab itself, just below the strip's top edge.
    const look = { x: focus.x, y: strip.y + 0.4 * m.bodyHeight };
    if (change === 'selected') {
      if (onIt || this.ledgeDistanceBl({ y: strip.y, x0: focus.x, x1: focus.x }) < 4) this.react('earFlick');
      if (onIt && !PHYSICAL_STATES.has(s)) this.setGlance(look, 1500);
      if (onIt && m.grounded && CALM_STATES.has(s) && !this.typingGate() && habituation < 0.6) {
        const rest = strip.rest ?? { x0: strip.x0, x1: strip.x1 };
        const x = clamp(focus.x, rest.x0, rest.x1);
        if (Math.abs(x - m.x) > 1.5 * this.bl && chance(this.random, 0.3) && this.reactions.take('tabInvestigate', this.now, TAB_INVESTIGATE_COOLDOWN_MS)) {
          const then: FollowUp = { state: 'idle', init: { target: look } };
          if (this.request('walking', 'stimulus', { variant: 'tabStrip', target: { x, y: strip.y }, then }) === 'ok') return;
        }
      }
    }
    if (!ACTIVE_STATES.has(s)) {
      this.setGlance(look, 1500);
      if (onIt) this.mover.faceToward(focus.x, this.now);
    } else if (s === 'walking' && onIt) {
      this.setGlance(look, 1500);
    }
  }

  protected onWindowAppeared(w: WindowInfo, isNew: boolean): void {
    const b = this.settings.behavior;
    if (!b.reactToWindows || !w || !isFiniteRect(w.rect) || w.minimized) return;
    if (ASLEEP_STATES.has(this.act.state) || PHYSICAL_STATES.has(this.act.state)) return;
    const novel = isNew && !this.seenWindows.has(w.id);
    this.seenWindows.add(w.id);
    const r = this.windowRelevanceFor(w.rect, w.category, w.excluded, novel, 'window');
    const center = rectCenter(w.rect);
    // A private window gets a glance at most: the cat does not walk over to it or sit and stare.
    const calm = (CALM_STATES.has(this.act.state) || this.act.state === 'walking') && !w.excluded;
    if (r >= 0.5 && calm && !this.typing && !this.disabled.has('inspectWindows') && this.reactions.ready('approach', this.now)) {
      if (this.request('inspectingWindow', 'stimulus', { windowId: w.id, target: center }) === 'ok') {
        this.reactions.set('approach', this.now, 25_000);
        return;
      }
    }
    if (r >= 0.25 && calm && this.reactions.take('look', this.now, 8000)) {
      if (this.request('curious', 'stimulus', { target: center, variant: 'look' }) === 'ok') return;
    }
    if (r >= 0.1) this.setGlance(center, 1500);
  }

  protected onWindowClosed(rect: Rect, category: WindowInfo['category'], excluded: boolean): void {
    if (!this.settings.behavior.reactToWindows || ASLEEP_STATES.has(this.act.state) || PHYSICAL_STATES.has(this.act.state)) return;
    const r = this.windowRelevanceFor(rect, category, excluded, true, 'closed');
    const target = { x: rect.x + rect.width / 2, y: rect.y + rect.height };
    const calm = (CALM_STATES.has(this.act.state) || this.act.state === 'walking') && !excluded;
    if (r >= 0.3 && calm && !this.typing && this.reactions.take('exposed', this.now, 20_000)) {
      if (this.request('curious', 'stimulus', { target }) === 'ok') return;
    }
    if (r >= 0.1) this.setGlance(rectCenter(rect), 1200);
  }

  protected onForeground(w: WindowInfo | null, switchesPerMinute: number): void {
    // 'React to windows' off: foreground changes, fast app switching included, are not noticed.
    if (!this.settings.behavior.reactToWindows) return;
    if (Number.isFinite(switchesPerMinute) && switchesPerMinute >= 8) {
      this.busyUntil = this.now + 20_000;
      const s = this.act.state;
      const moving = s === 'walking' || ACTIVE_STATES.has(s) || s === 'curious' || s === 'inspectingWindow';
      if (moving && this.act.cause !== 'command' && this.act.cause !== 'interaction' && this.reactions.take('busy', this.now, 15_000)) {
        this.request('watchingUser', 'stimulus');
      }
      return;
    }
    if (!w || !isFiniteRect(w.rect) || ASLEEP_STATES.has(this.act.state)) return;
    const r = this.windowRelevanceFor(w.rect, w.category, w.excluded, false, 'foreground');
    if (r >= 0.15) this.setGlance(rectCenter(w.rect), 1200);
  }

  protected onMoveStart(id: string, excluded: boolean): void {
    if (!this.settings.behavior.reactToWindows || this.mover.perchWindowId === id) return;
    const rect = this.windowRect(id);
    if (!rect || ASLEEP_STATES.has(this.act.state) || PHYSICAL_STATES.has(this.act.state)) return;
    const r = this.windowRelevanceFor(rect, 'unknown', excluded, false, 'move');
    // A private window being moved gets a glance at most.
    const calm = CALM_STATES.has(this.act.state) && !excluded;
    if (r >= 0.2 && calm && !this.typing && chance(this.random, 0.5 * this.cat.traits.curiosity) && this.reactions.take('follow', this.now, 30_000)) {
      if (this.request('walking', 'stimulus', { variant: 'follow', windowId: id, target: rectCenter(rect) }) === 'ok') return;
    }
    if (r >= 0.08) this.setGlance(rectCenter(rect), 2000);
  }

  protected onMoveEnd(id: string, rect: Rect, excluded: boolean): void {
    if (!this.settings.behavior.reactToWindows || this.mover.perchWindowId === id || excluded) return;
    if (ASLEEP_STATES.has(this.act.state) || PHYSICAL_STATES.has(this.act.state) || this.typing) return;
    const r = this.windowRelevanceFor(rect, 'unknown', false, false, 'moved');
    // Inspecting a moved window is 'Inspect windows'; it only climbs onto it when perching is on too.
    if (r >= 0.45 && !this.disabled.has('inspectWindows') && chance(this.random, 0.35) && this.reactions.take('approach', this.now, 25_000)) {
      this.request('inspectingWindow', 'stimulus', { windowId: id, target: rectCenter(rect) });
    }
  }

  protected onTypingStart(): void {
    const b = this.settings.behavior;
    if (!b.reactToTyping || ASLEEP_STATES.has(this.act.state) || !CALM_STATES.has(this.act.state)) return;
    if (!chance(this.random, 0.35 * b.activitySensitivity) || !this.reactions.take('typing', this.now, 60_000)) return;
    const fg = this.watchableForeground();
    const far = fg ? Math.abs(rectCenter(fg.rect).x - this.mover.x) > 6 * this.bl : false;
    this.request('watchingUser', 'stimulus', { variant: far ? 'nearby' : null });
  }

  protected onUserReturned(idleMs: number): void {
    if (!Number.isFinite(idleMs) || idleMs < 60_000) return;
    const s = this.act.state;
    if (ASLEEP_STATES.has(s)) {
      // Only the sleep that waited for the user ends with their return; a nap of its own runs its course (B15).
      if (this.act.variant === 'idleSleep' || this.act.variant === 'forced') this.request('wakingUp', 'stimulus', { then: this.greetFollowUp() });
      return;
    }
    if (idleMs >= 120_000 && !PHYSICAL_STATES.has(s)) {
      const greet = this.greetFollowUp();
      if (greet && this.request(greet.state, 'stimulus', greet.init) === 'ok') return;
      this.emotes.show('heart', this.now);
    }
  }

  /**
   * A fast cursor flick. v1.2 (ADR 0003 §1.8, §4.1): it adds 0.5 to the prey signal of the next
   * 4 Hz evaluation (no direct chase: hunts have one start path); a calm cat may turn to watch.
   */
  protected onFlick(speed: number, at: Point): void {
    if (!isFinitePoint(at) || !Number.isFinite(speed) || this.typingGate()) return;
    this.pendingFlick = true;
    const s = this.act.state;
    if (ASLEEP_STATES.has(s) || PHYSICAL_STATES.has(s) || s === 'chasingCursor') return;
    const speedDip = speed / this.mover.scale;
    const dist = Math.hypot(at.x - this.mover.x, at.y - (this.mover.y - this.mover.bodyHeight / 2)) / this.bl;
    const r = flickRelevance({
      speedDip,
      distBodyLengths: dist,
      cursorPlay: this.settings.behavior.cursorPlay,
      playfulness: this.cat.traits.playfulness,
      energy: this.cat.stats.energy,
      acceptance: this.cat.memory.preferences.cursorPlayAcceptance,
      habituation: this.habit.register('flick', this.now),
    });
    if (r >= 0.2 && s !== 'watchingCursor' && CALM_STATES.has(s) && this.reactions.take('flickWatch', this.now, 5000)) {
      if (this.request('watchingCursor', 'stimulus') === 'ok') return;
    }
    if (r >= 0.05) this.setGlance(at, 1200);
  }

  protected onVisual(events: readonly string[], changeCenter: Point | null, region: Rect): void {
    const sens = this.settings.behavior.activitySensitivity;
    if (events.includes('dark')) this.darkUntil = this.now + 10 * 60_000;
    if (events.includes('bright')) this.darkUntil = -Infinity;
    this.noteScreen(events);
    const s = this.act.state;
    if (ASLEEP_STATES.has(s) || PHYSICAL_STATES.has(s)) return;
    if (events.includes('bigChange')) {
      if (this.reactions.ready('bigChange', this.now) && chance(this.random, (1 - this.cat.traits.confidence) * 0.6 * sens)) {
        this.reactions.set('bigChange', this.now, 10 * 60_000);
        if (this.request('startled', 'stimulus', { target: isFinitePoint(changeCenter) ? changeCenter : null }) === 'ok') return;
      }
      if (isFinitePoint(changeCenter) && CALM_STATES.has(s) && this.reactions.take('visualApproach', this.now, 30_000)) {
        if (this.request('curious', 'stimulus', { target: changeCenter }) === 'ok') return;
      }
    }
    // Something video- or game-like is playing: the cat sits down and watches it, without walking over.
    if (events.includes('videoLike') && CALM_STATES.has(s) && isFiniteRect(region) && this.reactions.ready('video', this.now)) {
      this.reactions.set('video', this.now, 3 * 60_000);
      const target = isFinitePoint(changeCenter) ? changeCenter : rectCenter(region);
      if (s !== 'watchingUser' && chance(this.random, 0.2 + 0.5 * sens) && this.request('watchingUser', 'stimulus', { variant: 'screen', target }) === 'ok') return;
      this.setGlance(target, 3000);
      return;
    }
    // A compact new thing appeared: a curious cat may go and have a look; otherwise a head tilt.
    if (events.includes('newElement') && isFinitePoint(changeCenter) && this.reactions.ready('newElement', this.now)) {
      this.reactions.set('newElement', this.now, 45_000);
      const go = CALM_STATES.has(s) && !this.typing && chance(this.random, (0.2 + 0.5 * this.cat.traits.curiosity) * sens);
      if (go && this.request('curious', 'stimulus', { target: changeCenter }) === 'ok') return;
      if (!ACTIVE_STATES.has(s)) {
        this.setGlance(changeCenter, 1800);
        this.react('headTilt');
      }
      return;
    }
    if (events.includes('motion') && CALM_STATES.has(s) && isFiniteRect(region) && chance(this.random, 0.4 * sens) && this.reactions.take('motion', this.now, 60_000)) {
      const target = isFinitePoint(changeCenter) ? changeCenter : rectCenter(region);
      if (chance(this.random, 0.3 * this.cat.traits.curiosity) && !this.typing) this.request('curious', 'stimulus', { target });
      else if (s !== 'watchingUser') this.request('watchingUser', 'stimulus');
      else this.setGlance(target, 2000);
    }
  }

  protected currentScreen(): 'video' | 'busy' | 'quiet' | null {
    return this.screen && this.now < this.screen.until ? this.screen.kind : null;
  }

  /** The latest coarse look of the screen; it lowers activity for a while (see DecisionView.screen). */
  protected noteScreen(events: readonly string[]): void {
    const kind = events.includes('videoLike') ? 'video' : events.includes('busy') ? 'busy' : events.includes('quiet') || events.includes('still') ? 'quiet' : null;
    this.screen = kind ? { kind, until: this.now + SCREEN_FRESH_MS } : null;
  }

  protected onAi(reaction: string, interest: number, region: Rect): void {
    if (!isFiniteRect(region) || !Number.isFinite(interest)) return;
    if (!this.reactions.take('ai', this.now, 20_000)) return;
    const s = this.act.state;
    if (PHYSICAL_STATES.has(s)) return;
    const center = rectCenter(region);
    const asleep = ASLEEP_STATES.has(s);
    if (reaction !== 'sleep' && (interest < 0.25 || asleep)) return;
    switch (reaction) {
      case 'watch':
        if (s !== 'watchingUser') this.request('watchingUser', 'stimulus');
        this.setGlance(center, 3000);
        return;
      case 'approach':
        if (!this.typing) this.request('curious', 'stimulus', { target: center });
        return;
      case 'sit_nearby':
        this.request('curious', 'stimulus', { target: { x: center.x, y: region.y + region.height } });
        return;
      case 'play':
        // v1.2: no play near the cursor while the raw typing gate holds (B6).
        if (this.cat.stats.energy > 0.3 && !this.typingGate()) {
          const variant: Variant = !this.disabled.has('zoomies') && chance(this.random, 0.2) ? 'zoomies' : chance(this.random, 0.5) ? 'rollOver' : 'pawAt';
          this.request('playing', 'stimulus', { variant });
        }
        return;
      case 'startle':
        if (this.reactions.take('bigChange', this.now, 10 * 60_000)) this.request('startled', 'stimulus', { target: center });
        return;
      case 'sleep':
        if (!asleep && this.cat.stats.energy < 0.85) this.request('fallingAsleep', 'stimulus');
        return;
      case 'groom':
        if (!this.disabled.has('grooming')) this.request('grooming', 'stimulus');
        return;
      default:
        return; // 'ignore' and anything unexpected
    }
  }

  /** `relocated`: the call already brought the cat over from a fullscreen display; it then always comes. */
  protected onCallCat(at: Point, relocated: boolean): void {
    if (!isFinitePoint(at) || PHYSICAL_STATES.has(this.act.state)) return;
    this.noteInteraction();
    // Already on its way to a call: a new call only changes where it goes.
    const coming = (this.act.state === 'walking' || this.act.state === 'running') && this.act.variant === 'called';
    if (!relocated && !coming && this.ignoresCommand()) {
      // Not now: a flick of the tail and a look toward the caller, and it stays where it is.
      this.react('tailFlick');
      if (!ASLEEP_STATES.has(this.act.state)) this.setGlance(at, 1500);
      return;
    }
    const dest = this.mover.surfacePointFor(at);
    const far = Math.abs(dest.x - this.mover.x) > 6 * this.bl || Math.abs(dest.y - this.mover.y) > 2 * this.mover.bodyHeight;
    const target = { x: dest.x, y: dest.y };
    this.rememberEvent('called');
    this.request(far ? 'running' : 'walking', 'command', { variant: 'called', target, then: { state: 'idle', init: { target: { x: at.x, y: at.y } } } });
  }

  protected onPlayCommand(): void {
    if (PHYSICAL_STATES.has(this.act.state)) return;
    this.noteInteraction();
    if (this.ignoresCommand()) {
      this.react('tailFlick');
      return;
    }
    const zoom = !this.disabled.has('zoomies') && !this.typing && this.cat.stats.energy > 0.35 && chance(this.random, 0.4);
    const variant: Variant = zoom ? 'zoomies' : chance(this.random, 0.5) ? 'pawAt' : 'rollOver';
    this.request('playing', 'command', { variant });
  }

  /** Rolls whether the cat ignores a call or play command; never twice in a row. */
  protected ignoresCommand(): boolean {
    if (this.lastCommandIgnored) {
      this.lastCommandIgnored = false;
      return false;
    }
    this.lastCommandIgnored = chance(this.random, this.commandIgnoreChance());
    if (this.lastCommandIgnored) this.commandsIgnored++;
    return this.lastCommandIgnored;
  }

  /**
   * 0..MAX_COMMAND_IGNORE_CHANCE: an annoyed, frightened, sleepy, independent or barely
   * bonded cat sometimes does not come; a content, bonded cat almost always does.
   */
  commandIgnoreChance(): number {
    const st = this.cat.stats;
    const t = this.cat.traits;
    const lowBond = clamp((0.35 - st.bond) / 0.35, 0, 1);
    const independence = (1 - t.affection) * (0.5 + 0.5 * t.confidence);
    // Asleep makes it likelier, but not the short nap every launch starts with.
    const napping = ASLEEP_STATES.has(this.act.state) && this.act.variant !== 'intro';
    const sleepy = this.currentSleepiness() + (napping ? 0.5 : 0);
    const rough = clamp(this.recentRough() / 4, 0, 1);
    const p = 0.4 * st.annoyance + 0.3 * st.fear + 0.08 * lowBond + 0.08 * Math.min(1, sleepy) + 0.06 * independence + 0.05 * rough - 0.03;
    return Number.isFinite(p) ? clamp(p, 0, MAX_COMMAND_IGNORE_CHANCE) : 0;
  }

  /**
   * v1.1 window relevance (habituation and sensitivity included) times how receptive the cat is
   * (v1.2 salience, ADR 0003 §1.8: a busy or perched cat cares less, a reacting one not at all).
   */
  protected windowRelevanceFor(rect: Rect, category: WindowInfo['category'], excluded: boolean, novel: boolean, kind: string): number {
    const d = this.mover.fullWorldModel.display(this.mover.displayId) ?? this.mover.fullWorldModel.primary;
    return this.receptivityNow() * windowRelevance({
      cat: { x: this.mover.x, y: this.mover.y },
      rect,
      displayRect: d.workAreaPx,
      category,
      excluded,
      novel,
      curiosity: this.cat.traits.curiosity,
      sensitivity: this.settings.behavior.activitySensitivity,
      habituation: this.habit.register(kind, this.now),
      typing: this.typing,
    });
  }
}
