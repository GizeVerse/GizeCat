// The cat simulation: state machine, activities, stimuli, needs, memory and output.
// Pure TypeScript; time, randomness and the environment are injected. The class is built in
// layers (simCore -> simDrives -> simStay -> simHunt -> simReactions -> simSalience -> simUtility
// -> simActivities); this file adds the CatSim API and the per-tick output.
import type { AnimClip, BehaviorState } from '../../shared/cat';
import type { BehaviorProfileSnapshot } from '../../shared/behaviorProfile';
import type { PersistedCat, Traits } from '../../shared/catState';
import { PersistedCatSchema } from '../../shared/catState';
import type { Point, Rect } from '../../shared/geometry';
import { clamp } from '../../shared/geometry';
import type { Settings } from '../../shared/settings';
import { disabledBehaviorSet } from '../../shared/settings';
import type { CatSim, CatSimOptions, SimEnv, SimEvent, SimOutput } from '../../shared/sim';
import type { DecisionDiagnostics, NavDiagnostics, SurfaceDebugLine } from '../../shared/surfaceDiagnostics';
import type { WorldGeometry } from '../../shared/world';
import { clipFor } from './clips';
import { huntBaseline } from './hunt';
import { clearMemory } from './memory';
import { newPersistedCat, TRAIT_MAX, TRAIT_MIN } from './personality';
import { ACTIVE_STATES, ASLEEP_STATES, CALM_STATES, PHYSICAL_STATES, STATE_CHANGE_WINDOW_MS, STATE_SPECS } from './states';
import { baseContentment, stepStats } from './stats';
import { SimActivities } from './simActivities';
import type { SimHooks } from './simCore';
import { PERCEPTION_FLOOR_MS, SAVE_MIN_INTERVAL_MS, REACTION_HOLD_MS, FADE_MS, MAX_SIM_DT_MS, WALL_PAW_REACH_BL, SLOWEST_TICK_MS, SELF_TIMED, AROUSAL, CONTENTMENT_BIAS, isFinitePoint } from './simCore';

export type { SimHooks, SimMode, TransitionRecord } from './simCore';
export { MAX_COMMAND_IGNORE_CHANCE, MAX_SIM_DT_MS, PERCEPTION_FLOOR_MS, PLAY_RETREAT_COOLDOWN_MS, REACTION_MIN_GAP_MS, SLOWEST_TICK_MS, SURPRISE_COOLDOWN_MS } from './simCore';

export class CatSimImpl extends SimActivities implements CatSim {
  // ---- CatSim API -------------------------------------------------------------

  get state(): BehaviorState {
    return this.act.state;
  }

  tick(env: SimEnv, events: readonly SimEvent[]): SimOutput {
    const dt = Number.isFinite(env.dt) ? clamp(env.dt, 0, MAX_SIM_DT_MS) : 0;
    this.now = Number.isFinite(env.now) && env.now >= this.now ? env.now : this.now + dt;
    this.dt = dt;
    this.env = env;
    this.requests = [];
    let snap = this.snapNext;
    this.snapNext = false;

    // Displays with a fullscreen app in front are off limits: the cat neither walks nor jumps onto them.
    this.mover.setOffLimitsDisplays(this.settings.behavior.fullscreenBehavior === 'ignore' ? [] : env.fullscreenDisplayIds);
    if (env.foreground) {
      this.notePrivacy(env.foreground.id, env.foreground.excluded);
      if (!env.foreground.minimized) this.noteWindowRect(env.foreground.id, env.foreground.rect);
    }
    this.syncEdges(env);
    this.indexSurfaces(env);
    this.mover.sense(this.usableSurfaces());
    this.noteCursorSample();
    // The raw keyboard-like signal drives every "never in the way" gate whatever 'React to typing'
    // says (ADR 0003 §4.3); with the setting off the cat shows no typing reactions (calming down,
    // watching the user).
    this.typingRaw = env.typing === true || (Number.isFinite(env.typingIntensity) && env.typingIntensity > 0.35);
    if (this.typingRaw) this.lastTypingRawAt = this.now;
    this.typing = this.settings.behavior.reactToTyping && this.typingRaw;
    this.notePresses(env);
    this.cursorTrack.update(this.now, env.cursor ? { x: env.cursor.x, y: env.cursor.y } : null, this.mover.scale);
    this.sound = null;
    if (env.cursor) this.lastCursorSeenAt = this.now;
    this.updateMode();
    for (const ev of events) {
      try {
        this.handleEvent(ev);
      } catch {
        this.eventErrors++;
      }
    }
    this.updateMode();
    this.checkPlayfulRetreat();
    this.checkSlink();

    if (this.mode !== 'quit') {
      stepStats(this.cat.stats, { state: this.act.state, traits: this.cat.traits, patience: this.settings.interaction.patience }, dt);
    }
    // v1.2: drives (1 Hz) and the hunt evaluation (4 Hz) on sim-time accumulators.
    this.stepDriveClock(dt);
    this.stepHuntClock(dt);
    this.profile.addTime(this.act.state, dt, this.act.variant);
    {
      const d = this.cat.drives;
      this.profile.addMoods({ wary: d.wariness, irritable: d.irritability, fearful: this.cat.stats.fear }, dt);
    }
    if (this.typingRaw) this.profile.addContext('typing', dt);
    if (env.foreground?.maximized === true && !env.foreground.minimized) this.profile.addContext('foregroundMaximized', dt);
    if (this.cursorInWatchBand()) this.profile.addContext('cursorInReach', dt);
    this.updateActivity();
    if (this.mode !== 'away') {
      const step = this.mover.step({
        now: this.now,
        dtMs: dt,
        dragCursor: env.dragCursor,
        getSurface: (id) => this.safeSurface(id),
        movingWindowIds: this.movingWindows,
      });
      this.onMoverStep(step);
      if (step.snapped) snap = true;
    } else if (this.mover.stepAway({ now: this.now, dtMs: dt, dragCursor: null, getSurface: (id) => this.safeSurface(id), movingWindowIds: this.movingWindows })) {
      // Hidden: it stays with its ledge, and a ledge that vanished meanwhile leaves it on the floor below.
      snap = true;
    }
    this.reconcilePhysical();
    this.drawClimbSlip();
    this.trackEdgeVisit();
    this.trackElevation();
    this.updateUrge(dt);
    this.drives();
    this.updateStay();
    this.checkProgress();
    if (this.act.done) this.advance();
    else if (!SELF_TIMED.has(this.act.state) && this.now - this.act.startedAt >= this.act.dwellMs) this.reconsider();
    this.learn(dt);
    this.checkQuit();
    if (this.snapNext) {
      snap = true;
      this.snapNext = false;
    }
    return this.compose(snap);
  }

  updateSettings(settings: Settings): void {
    this.settings = settings;
    this.disabled = disabledBehaviorSet(settings.behavior);
    this.syncEmotes();
    if (this.mover.setConfig(this.moverConfig())) this.snapNext = true;
    if (!this.allowedByToggles(this.act.state, this.act.variant)) {
      this.stop();
      this.act.done = true;
      this.act.then = null;
    }
    if (this.suspended && !this.allowedByToggles(this.suspended.state, this.suspended.variant)) this.discardSuspended();
    if (this.pending && !this.allowedByToggles(this.pending.state, this.pending.init.variant ?? null)) this.pending = null;
  }

  setWorld(world: WorldGeometry): void {
    if (this.mover.setWorld(world)) this.snapNext = true;
    this.glance = null;
  }

  serialize(): PersistedCat {
    const wall = this.wall();
    this.cat.memory.lastSeenAt = wall;
    this.cat.savedAt = wall;
    this.cat.lastPosition = this.lastPosition();
    return PersistedCatSchema.parse(this.cat);
  }

  resetPersonality(): void {
    const fresh = newPersistedCat(this.random, this.wall());
    fresh.memory.counters.sessions = 1;
    fresh.lastPosition = this.cat.lastPosition;
    this.cat = fresh;
    this.habit.clear();
    this.surfaceHabit.clear();
    this.rough.clear();
    this.cat.drives.huntDrive = huntBaseline(clamp(this.settings.behavior.cursorPlay, 0, 1));
    // Route preferences follow the new personality.
    if (this.mover.setConfig(this.moverConfig())) this.snapNext = true;
    this.markDirty(true);
  }

  /**
   * 1.4.0 (profile import): replaces the live cat with `next`, already computed and validated by
   * the host (applyProfile in src/shared/profileTransfer.ts). Traits are clamped to the generator
   * band; lastPosition stays this device's. Another catId is another cat: the session's habits and
   * rough-handling memory start over and the hunt drive starts from its baseline, as after
   * resetPersonality. Throws (changing nothing) when `next` is not a valid persisted cat.
   */
  adoptCat(next: PersistedCat): void {
    const cat = PersistedCatSchema.parse(next);
    for (const k of Object.keys(cat.traits) as Array<keyof Traits>) cat.traits[k] = clamp(cat.traits[k], TRAIT_MIN, TRAIT_MAX);
    cat.lastPosition = this.cat.lastPosition;
    const other = cat.catId !== this.cat.catId;
    this.cat = cat;
    if (other) {
      this.habit.clear();
      this.surfaceHabit.clear();
      this.rough.clear();
      this.restAccumMs = 0;
      this.cat.drives.huntDrive = huntBaseline(clamp(this.settings.behavior.cursorPlay, 0, 1));
    }
    // Route preferences follow the (possibly) new personality.
    if (this.mover.setConfig(this.moverConfig())) this.snapNext = true;
    this.markDirty(true);
  }

  clearHistory(): void {
    clearMemory(this.cat.memory, this.wall());
    this.cat.memory.counters.sessions = 1;
    this.restAccumMs = 0;
    this.rough.clear();
    this.markDirty(true);
  }

  /** v1.1.1 surface diagnostics (kinds, counts, reasons; no ids or titles). */
  surfaceDiagnostics(): { nav: NavDiagnostics; decision: DecisionDiagnostics } {
    return {
      nav: this.mover.navDiagnostics(),
      decision: {
        state: this.act.state,
        support: this.supportKind(),
        targetKind: this.targetKind(),
        targets: { ...this.decisionTargets },
        exploreUrge: clamp(this.exploreUrge, 0, 1),
        lastElevatedAt: this.lastElevatedAt,
        excursions: this.excursionCount,
      },
    };
  }

  /** What the cat stands on or clings to right now (diagnostics); in mid-leap it is in the air. */
  protected supportKind(): DecisionDiagnostics['support'] {
    if (this.mode === 'away') return 'none';
    const m = this.mover;
    if (m.held) return 'held';
    if (m.onWall) return m.climbPhase === 'leap' ? 'air' : 'windowSide';
    if (m.airborne) return 'air';
    return m.attachedSurface?.surfaceKind ?? 'floor';
  }

  /**
   * Kind of surface the cat is on its way to: the goal the mover is pursuing for the current
   * activity (or for the one a jump interrupted), or null while it does not travel. An
   * activity's target is not used, some only look at it (watching the user, a curious look), but
   * for the walk that starts this tick, whose goal the mover gets on the next.
   */
  protected targetKind(): DecisionDiagnostics['targetKind'] {
    const a = this.act;
    const g = this.mover.hasGoal ? this.goalPoint : a.state === 'walking' && a.goalStatus === 'none' ? a.target : null;
    if (g === null) return null;
    // There already, or as close as it gets: it is not heading anywhere.
    const status = this.act.goalStatus;
    if (!PHYSICAL_STATES.has(this.act.state) && (status === 'arrived' || status === 'unreachable')) return null;
    const p = this.mover.surfacePointFor(g);
    return p.surface.kind === 'floor' ? 'floor' : (p.surface.surfaceKind ?? null);
  }

  /** v1.1.1 on-desktop surface visualization segments (physical px). */
  surfaceDebugLines(): SurfaceDebugLine[] {
    return this.mover.debugLines();
  }

  /** v1.2 session behaviour profile (kinds, counts, durations; ADR 0003 §11). */
  behaviorProfile(): BehaviorProfileSnapshot {
    return this.profile.snapshot(this.now);
  }

  debugInfo(): Record<string, unknown> {
    const recent = this.changeTimes.filter((t) => t > this.now - STATE_CHANGE_WINDOW_MS).length;
    return {
      state: this.act.state,
      phase: this.act.phase,
      variant: this.act.variant,
      mode: this.mode,
      activityAgeMs: Math.round(this.now - this.act.startedAt),
      dwellMs: Math.round(this.act.dwellMs),
      done: this.act.done,
      pending: this.pending?.state ?? null,
      suspended: this.suspended?.state ?? null,
      support: this.mover.support.kind,
      // Kinds and counts only: no window ids or geometry.
      surface: this.mover.attachedSurface?.surfaceKind ?? null,
      surfaces: { listed: this.surfaceIndex.size, ...this.mover.graphInfo() },
      moverMode: this.mover.mode,
      displayId: this.mover.displayId,
      worldVersion: this.mover.fullWorldModel.version,
      fallbackWorld: this.mover.fullWorldModel.usedFallback,
      stats: { ...this.cat.stats },
      changesLast10s: recent,
      transitionsTotal: this.transitionsTotal,
      invalidRequests: this.invalidRequests,
      commandsIgnored: this.commandsIgnored,
      screen: this.currentScreen(),
      invalidSamples: [...this.invalidSamples],
      eventErrors: this.eventErrors,
      lastTransitions: this.log.slice(-16).map((r) => ({ at: Math.round(r.at), from: r.from, to: r.to, cause: r.cause })),
    };
  }

  /**
   * Where to come back after a restart. Surfaces (taskbars, windows, tab strips) are gone or
   * elsewhere by then, so a cat on one is restored on the floor below the same spot.
   */
  protected lastPosition(): PersistedCat['lastPosition'] {
    const m = this.mover;
    const d = m.fullWorldModel.display(m.displayId);
    if (!d) return null;
    const xFrac = clamp((m.x - d.workAreaPx.x) / d.workAreaPx.width, 0, 1);
    const kind = m.support.kind;
    const support = kind === 'floor' || kind === 'surface' ? 'floor' : 'air';
    return { displayKey: d.id.slice(0, 64), xFrac: Number.isFinite(xFrac) ? xFrac : 0.5, support };
  }

  // ---- output ---------------------------------------------------------------------------

  protected computeLook(): Point | null {
    const s = this.act.state;
    if (ASLEEP_STATES.has(s) || s === 'away' || s === 'held' || s === 'beingPetted' || PHYSICAL_STATES.has(s)) return null;
    // A cat walking along a window top or strip can still turn its head (a tab change, §1.8).
    if (this.glance && this.now < this.glance.until && (!ACTIVE_STATES.has(s) || (s === 'walking' && this.onStay()))) return this.glance.target;
    const p = this.lookForState();
    return isFinitePoint(p) ? p : null;
  }

  protected computeClip(): AnimClip {
    const a = this.act;
    const m = this.mover;
    if (this.oneShot && this.now >= this.oneShot.until) this.oneShot = null;
    // v1.2: the scramble of a deliberate slip (front paws catch the edge, then it pulls up): never
    // on a wall, where it keeps the climb pose and stays within the wall line.
    if (this.now < this.slipClipUntil && !m.airborne && !m.held && !m.onWall) return 'slip';
    // On a wall the body is in the vertical climbing pose while getting on and climbing. During
    // the corner pull-up and the step-off the renderer cross-fades back to a ground clip (its
    // off-wall fade is tuned to the pull-up duration), so the cat does not glide rigidly.
    if (m.onWall) {
      const phase = m.climbPhase;
      // Leaping onto the side (v1.1.1): the jump pose (the renderer shapes it by vy), then onto the wall.
      if (phase === 'leap') return 'jump';
      return phase === 'pullUp' || phase === 'dismount' ? 'walk' : 'climb';
    }
    if (this.oneShot && CALM_STATES.has(a.state)) return this.oneShot.clip;
    // v1.2: a hunting pounce flies in the pounce pose (the renderer shapes it by vy).
    if (a.state === 'jumping' && this.pounceFlight && m.airborne) return 'pounce';
    const scale = m.scale;
    const clip = clipFor(a.state, a.phase, {
      groundSpeed: m.groundSpeed,
      runThreshold: 140 * this.settings.behavior.movementSpeed * scale,
      moveThreshold: 6 * scale,
      vy: m.vy,
    });
    // The poses of a place (ADR 0003 §8): looking down from the edge, keeping its balance on a narrow ledge.
    if (clip === 'sit' && a.state === 'inspectingWindow' && a.variant === 'edge') return 'edgeSit';
    if ((clip === 'sit' || clip === 'stand') && m.grounded && m.balance > 0) return 'balance';
    return clip;
  }

  /**
   * Approximate body bounds, px (also the overlay's click-through fallback until the renderer
   * reports its hit region). Upright: one body width across and one body height above the
   * anchor. On a wall the body hangs outside the window, about one body length up from the
   * grip at the anchor and one body height out from the wall line; the box covers that
   * vertical pose and the upright footprint (so the presence margins the renderer is tested
   * against still contain the drawing while it blends between poses), but never reaches into
   * the window past the paws on the wall line, except while it crosses the top corner.
   */
  protected bodyBounds(): Rect {
    const m = this.mover;
    const bw = m.bodyWidth;
    const bh = m.bodyHeight;
    const upright = { x0: m.x - bw / 2, y0: m.y - bh, x1: m.x + bw / 2, y1: m.y };
    // In mid-leap it is airborne, in the upright jump pose: the hanging pose starts at the catch.
    const wall = m.onWall && m.climbPhase !== 'leap' ? m.wall : null;
    if (!wall) return { x: upright.x0, y: upright.y0, width: bw, height: bh };
    const out = wall.side === 'left' ? -1 : 1;
    const outer = m.x + out * 0.95 * bh;
    const inner = m.x - out * 0.15 * bh;
    let x0 = Math.min(upright.x0, outer, inner);
    let x1 = Math.max(upright.x1, outer, inner);
    const phase = m.climbPhase;
    if (phase !== 'pullUp' && phase !== 'swing') {
      const paws = WALL_PAW_REACH_BL * bw;
      if (out < 0) x1 = Math.max(x0, Math.min(x1, wall.x + paws));
      else x0 = Math.min(x1, Math.max(x0, wall.x - paws));
    }
    const y0 = Math.min(upright.y0, m.y - bw);
    return { x: x0, y: y0, width: x1 - x0, height: upright.y1 - y0 };
  }

  protected fadeTarget(): number {
    if (this.mode === 'away') return 0;
    return this.mode === 'quiet' ? 0.5 : 1;
  }

  protected nextTickMs(): number {
    if (Math.abs(this.fade - this.fadeTarget()) > 0.005) return 33;
    if (this.mode === 'away') return SLOWEST_TICK_MS;
    if (this.quitting) return 33;
    const s = this.act.state;
    const env = this.env;
    const m = this.mover;
    // Carried by its support (eased onto / off a taskbar, riding a window being dragged), asleep or not.
    const on = m.attachedSurface;
    if (m.settling || (on !== null && this.movingWindows.has(on.ownerId))) return 33;
    if (s === 'sleeping') return this.mode === 'normal' ? 150 : SLOWEST_TICK_MS;
    if (!m.grounded || m.groundSpeed > 1 || env?.cursorOverCat || env?.dragCursor) return 33;
    return Math.min(STATE_SPECS[s].tickMs, SLOWEST_TICK_MS);
  }

  protected compose(snap: boolean): SimOutput {
    const m = this.mover;
    const now = this.now;
    this.emotes.update(now);
    const clip = this.computeClip();
    if (clip !== this.clip || this.restartClip) {
      this.clip = clip;
      this.clipStartedAt = now;
      this.restartClip = false;
    }
    const bw = m.bodyWidth;
    const bh = m.bodyHeight;
    // Gait rate: along the ground, or along the wall while climbing.
    const speedBl = m.grounded ? m.groundSpeed / bw : m.onWall ? m.climbSpeed / bw : 0;
    const k = 1 - Math.exp(-this.dt / 600);
    const st = this.cat.stats;
    this.arousal += (clamp(AROUSAL[this.act.state] + 0.3 * st.fear, 0, 1) - this.arousal) * k;
    const contentTarget = clamp(baseContentment(st) + (CONTENTMENT_BIAS[this.act.state] ?? 0), 0, 1);
    this.contentment += (contentTarget - this.contentment) * (1 - Math.exp(-this.dt / 1000));
    const ft = this.fadeTarget();
    const fstep = this.dt / FADE_MS;
    this.fade = this.fade < ft ? Math.min(ft, this.fade + fstep) : Math.max(ft, this.fade - fstep);
    const visible = this.fade > 0.01;
    const look = this.computeLook();

    const requests = this.requests;
    const s = this.act.state;
    const userIntervalMs = this.settings.perception.minIntervalSec * 1000;
    const perceptionGapMs = Number.isFinite(userIntervalMs) ? Math.max(PERCEPTION_FLOOR_MS, userIntervalMs) : PERCEPTION_FLOOR_MS;
    if ((s === 'curious' || s === 'watchingUser') && this.mode === 'normal' && now - this.lastPerceptionAt >= perceptionGapMs) {
      requests.push({ type: 'perception', reason: s === 'curious' ? 'curious' : 'watching', focus: look ?? { x: m.x, y: m.y - bh / 2 } });
      this.lastPerceptionAt = now;
    }
    if (this.dirty && now - this.lastSaveAt >= SAVE_MIN_INTERVAL_MS) {
      requests.push({ type: 'save' });
      this.dirty = false;
      this.lastSaveAt = now;
    }

    return {
      x: m.x,
      y: m.y,
      facing: m.facing,
      state: s,
      clip: this.clip,
      clipStartedAt: this.clipStartedAt,
      speed: speedBl < 0.02 ? 0 : speedBl,
      vy: m.airborne || m.climbPhase === 'leap' ? m.vy : 0,
      look,
      arousal: clamp(this.arousal, 0, 1),
      contentment: clamp(this.contentment, 0, 1),
      emote: visible ? this.emotes.emote : null,
      emoteStartedAt: this.emotes.emoteStartedAt,
      opacity: clamp(this.settings.appearance.opacity, 0, 1) * this.fade,
      visible,
      snap,
      displayId: m.displayId,
      support: m.support,
      boundsPx: this.bodyBounds(),
      nextTickMs: this.nextTickMs(),
      requests,
      reaction: visible && this.reaction && now - this.reaction.at < REACTION_HOLD_MS ? { ...this.reaction } : null,
      // v1.2 render hints (ADR 0003 §6, §8, §10).
      jumpKind: m.jumpKind,
      impact: s === 'landing' ? clamp(this.impactHint, 0, 1) : 0,
      balance: clamp(m.balance, 0, 1),
      sound: visible ? this.sound : null,
    };
  }
}

/** Factory with test/diagnostic hooks (transition observer). */
export function createInstrumentedCatSim(opts: CatSimOptions, hooks: SimHooks): CatSimImpl {
  return new CatSimImpl(opts, hooks);
}
