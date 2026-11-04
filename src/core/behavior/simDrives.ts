// The cat simulation, layer 2: per-second drives, sleep pressure, the rhythm and what the cat
// learns (memory).
import { activityClassOf } from '../../shared/behaviorProfile';
import { clamp } from '../../shared/geometry';
import type { SimEnv } from '../../shared/sim';
import { userIdleForSleep } from './decide';
import { boredomDisplay, DRIVE_STEP_MS, stepDrives, zEff } from './drives';
import { BUSY_HAND_PRESSES } from './hunt';
import { decayRate, learnSpot } from './memory';
import type { RhythmContext } from './rhythm';
import { ACTIVE_STATES, ASLEEP_STATES, CALM_STATES, PHYSICAL_STATES, STATE_SPECS } from './states';
import { SimCore } from './simCore';
import { PET_RATE_TAU_MS, PLACE_RECENT_MS, SPOT_LEARN_MIN_MS, SPOT_FLUSH_MS } from './simCore';

const unit = (v: number, fallback: number): number => (Number.isFinite(v) ? clamp(v, 0, 1) : fallback);

export abstract class SimDrives extends SimCore {
  // ---- v1.2 drives and rhythm (ADR 0003 §1.2, §1.6) ----------------------------------------

  /** Counts mouse-button presses (content-free) for the button gate. */
  protected notePresses(env: SimEnv): void {
    const p = env.pointerButtonPresses;
    if (typeof p !== 'number' || !Number.isFinite(p)) return;
    if (this.lastPresses !== null && p > this.lastPresses) {
      this.lastPressAt = this.now;
      this.recentPressAt.push(this.now);
      if (this.recentPressAt.length > BUSY_HAND_PRESSES) this.recentPressAt.shift();
      const c = env.cursor;
      this.lastPressPoint = c && Number.isFinite(c.x) && Number.isFinite(c.y) ? { x: c.x, y: c.y } : null;
    }
    this.lastPresses = p;
  }

  /** Drives step at 1 Hz on sim time (an accumulator), so the host tick size does not matter. */
  protected stepDriveClock(dt: number): void {
    if (!(dt > 0)) return;
    this.trackRest();
    if (this.mode === 'quit') return;
    this.driveAccMs += dt;
    while (this.driveAccMs >= DRIVE_STEP_MS) {
      this.driveAccMs -= DRIVE_STEP_MS;
      this.stepDrivesOnce(DRIVE_STEP_MS);
    }
  }

  /** Effective sleepiness now. */
  protected zEffNow(): number {
    return zEff(this.cat.drives.sleepiness, this.cat.stats.energy);
  }

  protected stepDrivesOnce(ms: number): void {
    const s = this.act.state;
    const a = this.act;
    const away = this.mode === 'away';
    const asleep = s === 'sleeping' || (away && this.awayWasAsleep);
    const b = this.settings.behavior;
    const d = this.cat.drives;
    const hour = this.env?.localHour ?? 12;
    stepDrives(
      d,
      {
        awake: !ASLEEP_STATES.has(s) && !away && s !== 'wakingUp',
        asleep,
        resting: s === 'resting',
        beingPetted: s === 'beingPetted',
        held: s === 'held',
        playing: s === 'playing' || s === 'chasingCursor',
        zoomies: s === 'playing' && (a.variant === 'zoomies' || a.variant === 'tailChase'),
        inspecting: s === 'curious' || s === 'inspectingWindow',
        opportunity: this.exploreOpportunity(),
        traits: this.cat.traits,
        stats: this.cat.stats,
        autonomy: unit(b.autonomy, 0.6),
        exploration: unit(b.exploration, 0.6),
        mischief: unit(b.mischief, 0.4),
        attentionSeeking: unit(b.attentionSeeking, 0.35),
        patience: unit(this.settings.interaction.patience, 0.5),
        night: hour >= 23 || hour < 6,
        darkBias: this.darkBias(),
      },
      ms,
    );
    // v1.1 boredom stays a display value (a 1.1.1 downgrade reads a sensible number).
    this.cat.stats.boredom = boredomDisplay(d);
    if (this.mode === 'normal' && this.rhythm.update(this.random, this.now, this.rhythmContext())) this.onEpisodeStart();
    this.syncJumpLimits();
  }

  /** A novel reachable elevated target exists (the explore need grows x1, else x0.3). */
  protected exploreOpportunity(): boolean {
    const sc = this.scan;
    const fresh = (owner: string | null | undefined): boolean => {
      if (typeof owner !== 'string') return true;
      const at = this.placeVisits.get(`w:${owner}`);
      return at === undefined || this.now - at > PLACE_RECENT_MS;
    };
    return (sc.perch !== null && fresh(sc.perch.windowId)) || (sc.climb?.dir === 'up' && fresh(sc.climb.ownerId)) || (sc.strip !== null && fresh(sc.strip.ownerId)) || this.clearEdgeBand();
  }

  protected abstract clearEdgeBand(): boolean;

  /** On the floor with no window top, side or strip to go up to (the look of the last scan, cooldowns aside). */
  protected nothingWithinReach(): boolean {
    const sc = this.scan;
    return this.mover.attachedSurface === null && sc.perch === null && sc.climb?.dir !== 'up' && sc.strip === null;
  }

  protected rhythmContext(): RhythmContext {
    const d = this.cat.drives;
    const env = this.env;
    const b = this.settings.behavior;
    const fg = env?.foreground && !env.foreground.minimized ? env.foreground : null;
    const video = (fg !== null && (fg.category === 'video' || fg.category === 'game' || fg.category === 'media')) || this.screenIsVideo();
    const hour = env?.localHour ?? 12;
    return {
      autonomy: unit(b.autonomy, 0.6),
      energy: this.cat.stats.energy,
      energyLevel: this.cat.traits.energyLevel,
      playNeed: d.playNeed,
      exploreNeed: d.exploreNeed,
      mischief: d.mischief,
      huntDrive: d.huntDrive,
      zEff: this.zEffNow(),
      typing: this.typing,
      typingIntensity: b.reactToTyping && env && Number.isFinite(env.typingIntensity) ? clamp(env.typingIntensity, 0, 1) : 0,
      busySwitching: this.now < this.busyUntil,
      video,
      night: hour >= 23 || hour < 6,
      nothingToClimb: fg?.maximized === true || this.nothingWithinReach(),
    };
  }

  protected screenIsVideo(): boolean {
    return this.screen !== null && this.now < this.screen.until && this.screen.kind === 'video';
  }

  /**
   * A new rhythm episode began. An active one cuts a calm autonomous activity short (the next
   * decision comes now); a calm one lets the running activity finish.
   */
  protected onEpisodeStart(): void {
    const a = this.act;
    if (this.rhythm.episode !== 'active' || a.done || a.cause !== 'autonomous') return;
    if (activityClassOf(a.state, a.variant) !== 'calm') return;
    a.dwellMs = Math.min(a.dwellMs, Math.max(this.now - a.startedAt, STATE_SPECS[a.state].dwellMs[0]));
  }

  /** Contiguous rest or sleep (a stretch after >= 60 s of it). */
  protected trackRest(): void {
    const s = this.act.state;
    const resting = s === 'resting' || s === 'sleeping' || s === 'fallingAsleep';
    if (resting) {
      this.restSince ??= this.now;
    } else if (this.restSince !== null) {
      this.lastRestMs = this.now - this.restSince;
      this.restSince = null;
      this.restEndedAt = this.now;
    }
  }

  /** ms of rest or sleep that ended within the last 30 s (0 otherwise). */
  protected restedMs(): number {
    return this.now - this.restEndedAt <= 30_000 ? this.lastRestMs : 0;
  }

  // ---- per-tick drives --------------------------------------------------------------

  protected drives(): void {
    const env = this.env;
    if (!env || this.mode !== 'normal' || this.now < this.nextDriveAt) return;
    this.nextDriveAt = this.now + 1000;
    const s = this.act.state;
    const a = this.act;
    if (userIdleForSleep({ userIdleMs: env.userIdleMs, behavior: this.settings.behavior }) && !ASLEEP_STATES.has(s) && !PHYSICAL_STATES.has(s)) {
      const interruptible = CALM_STATES.has(s) || s === 'walking' || a.done;
      if (interruptible && !(s === 'walking' && a.variant === 'favorite')) {
        const spot = this.favoriteSpotTarget();
        const status =
          spot && spot.distBodyLengths > 1.5 && spot.distBodyLengths < 25 && s !== 'walking'
            ? this.request('walking', 'stimulus', { variant: 'favorite', target: spot.point, then: { state: 'fallingAsleep', init: { variant: 'idleSleep' } } })
            : 'blocked';
        if (status !== 'ok') this.request('fallingAsleep', 'stimulus', { variant: 'idleSleep' });
      }
      return;
    }
    // While the user types the cat settles down instead of running around.
    if (this.typing && ACTIVE_STATES.has(s) && a.cause !== 'command' && a.cause !== 'interaction' && this.now - a.startedAt > 1500 && !a.done && !(s === 'walking' && (a.variant === 'leave' || a.variant === 'screenEdge'))) {
      this.finish();
    }
  }

  // ---- memory ---------------------------------------------------------------------------

  protected learn(dt: number): void {
    const s = this.act.state;
    const mem = this.cat.memory;
    if (this.mode !== 'away' && !ASLEEP_STATES.has(s)) mem.totalAwakeMs = Math.min(Number.MAX_SAFE_INTEGER, mem.totalAwakeMs + dt);
    if (this.mode !== 'away' && (this.env?.userIdleMs ?? Infinity) < 60_000) {
      mem.preferences.petRatePerHour = decayRate(mem.preferences.petRatePerHour, dt, PET_RATE_TAU_MS);
    }
    // Favourite spots come from rests the cat takes in normal life, not from sleep imposed while the
    // session is locked, a fullscreen app keeps it quiet, the user paused it or the app is quitting.
    if (this.mode === 'normal' && (s === 'resting' || s === 'sleeping') && this.mover.grounded) {
      this.restAccumMs += dt;
      if (this.restAccumMs >= SPOT_FLUSH_MS) this.flushRestSpot();
    }
  }

  protected flushRestSpot(): void {
    const ms = this.restAccumMs;
    this.restAccumMs = 0;
    if (ms < SPOT_LEARN_MIN_MS || !this.mover.grounded) return;
    const m = this.mover;
    const d = m.fullWorldModel.display(m.displayId);
    if (!d) return;
    const xFrac = clamp((m.x - d.workAreaPx.x) / d.workAreaPx.width, 0, 1);
    // A spot on a window top or tab strip is a 'window' spot; on a taskbar it is the floor it covers.
    const on = m.attachedSurface;
    const kind = on && on.surfaceKind !== 'taskbar' ? 'window' : 'floor';
    learnSpot(this.cat.memory, { displayKey: d.id, xFrac, kind }, ms / 60_000, this.wall());
    this.markDirty();
  }
}
