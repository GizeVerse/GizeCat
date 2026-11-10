// The cat simulation, layer 9: the Living Companion. It owns the world-event engine (src/core/events),
// feeds it the cat's situation every tick, and carries out what the engine invites the cat to do
// WITHOUT stealing control: the user's drag, throw, tap and petting, and every physical state, always win;
// a sleeping cat only wakes for something loud; a busy cat ignores gentle invitations. It also derives the
// temporary mood and the sleep depth, writes event history and the journal into the persisted world
// memory, and applies the chosen personality's traits and knobs (the knobs are neutral for 'auto', so
// those cats behave exactly as before).
//
// The body of an event is an ordinary activity (idle, walking, playing, resting or hiding) with the
// variant 'event': the existing Mover, clips and state table do the work, and the activity is released the
// moment no event holds it any more. Nothing here ever catches anything: props are never prey (no pounce
// at a prop, no 'caught', no hunt counters), and the hold-still zone and the cursor clearance of goTo()
// apply to every move.
//
// Randomness: the engine and this layer draw only from their own stream (seeded from the cat id, the
// session counter and the wall clock), never from the main one, so every seeded run that has no event keeps
// its sequence. An event's body takes no main-stream draw while it is held.
import type { AnimClip, BehaviorState } from '../../shared/cat';
import { resolveClip } from '../../shared/animationCatalog';
import { WORLD_SOUND_CUES } from '../../shared/cat';
import type { AnyEventId, JournalEntry, Mood, PersonalityId, RenderProp, WorldEventSnapshot } from '../../shared/companion';
import type { Point, Rect } from '../../shared/geometry';
import { clamp, isFiniteRect } from '../../shared/geometry';
import type { Settings } from '../../shared/settings';
import type { CatSimOptions, SimEnv, SimEvent } from '../../shared/sim';
import type { Pace } from '../movement';
import { createWorldEventEngine } from '../events/engine';
import type { EventIntent, EventTemperament, EventTickInput, WorldEventEngine } from '../events/types';
import type { Activity } from './activity';
import type { Phase } from './clips';
import { MoodTracker, moodFor, sleepDepthFor } from './mood';
import { effectiveTraits, knobsFor, nearestPersonality, temperamentFor } from './personalityProfiles';
import type { Random } from './random';
import { mulberry32 } from './random';
import { SimActivities } from './simActivities';
import type { SimHooks } from './simCore';
import { ASLEEP_STATES, PHYSICAL_STATES } from './states';
import { addFear } from './drives';
import { appendEventHistory, appendJournal, clearWorldMemory } from './worldMemory';

/** The effective traits and knobs are recomputed this often (counters drift slowly: minutes are plenty). */
export const PERSONALITY_RECHECK_MS = 3 * 60_000;
/** An event body's dwell is topped up by this much on every tick an event holds it. */
const BODY_DWELL_MS = 60_000;
/** No intent for this long: the body is released (hitches in the host's tick cadence are far shorter). */
const BODY_STALE_MS = 600;
/** After another behaviour took the body from an event, the event waits this long before asking again. */
const YIELD_MS = 4000;
/** The user touched the cat (hover, tap, pet, drag) this recently: no new event starts. */
const USER_BUSY_MS = 4000;
/** A command or an interaction owns the cat's activity for this long: events leave it alone. */
const USER_HOLD_MS = 8000;
/** Raw typing at or above this intensity (0..1) keeps events from starting and winds a running one down. */
const TYPING_HARD = 0.5;
/** Intents at or above this urgency (a wave, thunder, a startle) may wake a sleeping cat and override a busy one. */
const URGENT = 0.5;
/** A sleeping cat is woken for an event at most this often. */
const WAKE_GAP_MS = 5000;
/** A held one-shot clip is refreshed every tick; it lapses by itself this long after the last one. */
const HOLD_CLIP_MS = 500;
/** Two event hops are at least this far apart, and the hop's physics may not wind the event down for this long. */
const HOP_GAP_MS = 1200;
const HOP_ALLOWED_MS = 1800;
/** A hiding cat released from an event stays hidden this much longer. */
const HIDE_TAIL_MS = 1500;
/** The event stage reaches about this many body widths above the floor when the host gives none. */
const STAGE_HEIGHT_BODIES = 5;
/** Mood pushes of one mood are at most this often (the engine re-emits the intent's mood every tick). */
const MOOD_PUSH_GAP_MS = 600;
/** Default stand-off (body widths) when an intent names none. */
const DEFAULT_STANDOFF_BW = 1.2;
/** A prop this close (stand-off plus this many body widths) is near enough to play with or inspect from where the cat stands. */
const NEAR_BW = 2.5;

const NO_PROPS: readonly RenderProp[] = Object.freeze([]);

const NEUTRAL_TEMPERAMENT: EventTemperament = Object.freeze({
  interest: 0.5,
  boldness: 0.5,
  persistence: 1,
  startle: 0.5,
  playfulness: 0.5,
  calm: 0.5,
  mischief: 0.5,
  alertness: 1,
  energy: 0.5,
});

/** States a gentle invitation may take over (the cat is free: calm or wandering). */
const FREE_STATES: ReadonlySet<BehaviorState> = new Set<BehaviorState>(['idle', 'walking', 'resting', 'grooming', 'watchingUser', 'watchingCursor', 'curious', 'inspectingWindow']);
/** States only an urgent invitation may take over (the cat is busy with something of its own). */
const BUSY_STATES: ReadonlySet<BehaviorState> = new Set<BehaviorState>(['playing', 'chasingCursor', 'seekingAttention']);
/** Walks of its own that an event may interrupt (never a trip up, a leave, a reaction's retreat or a call). */
const FREE_WALKS: ReadonlySet<string | null> = new Set<string | null>([null, 'wander', 'favorite', 'nearby', 'corner', 'look']);

type BodyState = 'idle' | 'walking' | 'playing' | 'resting' | 'hiding';

/** What the event asks of the body this tick, resolved against what the cat can do where it stands. */
interface BodyPlan {
  state: BodyState;
  /** Phase to hold (null: leave the activity's own, as hiding does). */
  phase: Phase | null;
  look: Point | null;
  /** A clip held as a one-shot over an idle body (anything the idle phases do not draw). */
  clip: AnimClip | null;
  /** Walking only: where to stand and how fast; null stops. */
  goal: { x: number; pace: Pace; radius: number } | null;
  hop: boolean;
}

/** Exhaustiveness check of a switch over IntentKind: a new kind fails to compile here. */
const none = (_kind: never): null => null;

const finitePoint = (p: Point | undefined | null): Point | null => (p && Number.isFinite(p.x) && Number.isFinite(p.y) ? { x: p.x, y: p.y } : null);

/** FNV-1a over a few parts: the seed of this layer's own random stream. */
function hashSeed(...parts: Array<string | number>): number {
  let h = 0x811c9dc5;
  for (const part of parts) {
    const s = String(part);
    for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 0x01000193);
    h = Math.imul(h ^ 0x7c, 0x01000193);
  }
  return h >>> 0;
}

export abstract class SimCompanion extends SimActivities {
  protected readonly events: WorldEventEngine;
  /** Own stream: the main one is never drawn from for events, so seeded runs without events are unchanged. */
  private readonly companionRandom: Random;
  private readonly moodTracker = new MoodTracker();
  protected mood: Mood = 'relaxed';
  protected props: readonly RenderProp[] = NO_PROPS;
  protected sleepDepth = 0;
  private asleepSince: number | null = null;
  private worldSnap: WorldEventSnapshot | null = null;
  private journalOut: JournalEntry | null = null;
  /** Session-only pause of the schedule (the menu / panel). */
  private eventsPaused = false;
  private personalityAt = -Infinity;
  private personalityKey = '';
  private userTouchAt = -Infinity;
  private companionMode = 'normal';
  private temperament: EventTemperament = NEUTRAL_TEMPERAMENT;
  // ---- the body ----
  private bodyLive = false;
  private bodyAt = -Infinity;
  private bodyRequestedAt = -Infinity;
  private yieldUntil = -Infinity;
  private lastHopAt = -Infinity;
  private hopUntil = -Infinity;
  private lastWakeAt = -Infinity;
  private moodPushAt = -Infinity;
  private lastPushedMood: Mood | null = null;
  private goal: BodyPlan['goal'] = null;
  private holdingClip = false;

  constructor(opts: CatSimOptions, hooks: SimHooks = {}) {
    super(opts, hooks);
    this.companionRandom = mulberry32(hashSeed(this.cat.catId, this.cat.memory.counters.sessions, Math.floor(this.wall() / 1000)));
    this.events = createWorldEventEngine({ now: this.now, random: this.companionRandom, memory: { history: this.cat.world.events } });
    this.syncPersonality();
  }

  // ---- personality ------------------------------------------------------------------------------

  /**
   * Recomputes the traits and knobs the sim acts on from the chosen personality: 'auto' keeps the born
   * traits (effTraits null, neutral knobs); a named one gets its profile's traits plus the bounded drift
   * of the cat's experience. The persisted traits and the user's choice are never touched.
   */
  protected syncPersonality(): void {
    const choice = this.settings.companion.personality;
    this.personalityAt = this.now;
    this.knobs = knobsFor(choice);
    this.effTraits = choice === 'auto' ? null : effectiveTraits(choice, this.cat.traits, this.cat.memory.counters);
    const key = choice === 'auto' ? 'auto' : `${choice}:${Object.values(this.effTraits ?? {}).map((v) => Math.round(v * 1000)).join(',')}`;
    if (key === this.personalityKey) return;
    this.personalityKey = key;
    // Route preferences and effort follow the traits; a trait change never moves the cat (only a size change does).
    if (this.mover.setConfig(this.moverConfig())) this.snapNext = true;
  }

  /** The host changed the settings: personality now, and a running event ends when events were switched off. */
  protected onCompanionSettings(prev: Settings): void {
    this.syncPersonality();
    if (prev.companion.events.enabled && !this.settings.companion.events.enabled) this.events.interrupt('settings');
  }

  /** A different cat (profile import, reset) is now the cat: its world memory and personality replace the old ones, nothing stale runs on. */
  protected onCatReplaced(): void {
    this.personalityKey = '';
    this.syncPersonality();
    this.events.restore({ history: this.cat.world.events });
    this.dropEventState();
  }

  /** Forgets the whole world (history, counters, journal) and any running event. */
  protected forgetWorld(): void {
    this.cat.world = clearWorldMemory();
    this.events.restore({ history: [] });
    this.dropEventState();
    this.markDirty(true);
  }

  private dropEventState(): void {
    this.props = NO_PROPS;
    this.worldSnap = null;
    this.journalOut = null;
    this.moodTracker.clear();
    this.goal = null;
    this.eventLook = null;
    this.bodyLive = false;
    this.setHeldClip(null);
    const a = this.act;
    if (a.variant === 'event' && !a.done) {
      if (a.state === 'hiding') a.variant = null;
      else {
        this.stop();
        this.finish();
      }
    }
  }

  // ---- the CatSim accessors ----------------------------------------------------------------------

  companionStatus(): { mood: Mood; event: AnyEventId | null; nextEventInMs: number | null; nearestPersonality: PersonalityId; personalityIsAuto: boolean } {
    const choice = this.settings.companion.personality;
    const running = this.worldSnap?.id ?? null;
    const counting = this.settings.companion.events.enabled && !this.eventsPaused && running === null;
    const left = counting ? this.events.msUntilNext(this.now) : null;
    return {
      mood: this.mood,
      event: running,
      nextEventInMs: left === null || !Number.isFinite(left) ? null : Math.max(0, Math.round(left)),
      nearestPersonality: choice === 'auto' ? nearestPersonality(this.cat.traits) : choice,
      personalityIsAuto: choice === 'auto',
    };
  }

  /** The running event for SimOutput.worldEvent (a copy), or null. */
  protected worldEventSnapshot(): WorldEventSnapshot | null {
    const w = this.worldSnap;
    return w ? { id: w.id, rare: w.rare, startedAt: w.startedAt } : null;
  }

  /** The journal line written this tick, for SimOutput.journalEntry (cleared at the start of the next tick). */
  protected takeJournalEntry(): JournalEntry | null {
    return this.journalOut;
  }

  journal(): readonly JournalEntry[] {
    return this.cat.world.journal.map((e) => ({ id: e.id, at: e.at, outcome: e.outcome }));
  }

  /** The journal, the event history behind it and the counters are forgotten (nothing else). */
  clearJournal(): void {
    this.forgetWorld();
  }

  /**
   * Starts an event now (diagnostics and tests: the schedule alone needs 5 to 30 minutes). False when
   * one is running, the id is not offered here (a stage too small, events off) or no tick has run yet.
   */
  debugTriggerEvent(id: AnyEventId): boolean {
    const env = this.env;
    if (!env) return false;
    return this.events.trigger(id, this.eventInput(env));
  }

  // ---- events from the host --------------------------------------------------------------------------

  protected override handleEvent(ev: SimEvent): void {
    switch (ev.type) {
      case 'pointer.tap':
      case 'pointer.doubleTap':
      case 'pointer.pet':
        this.userTouchAt = this.now;
        this.events.interrupt('user');
        break;
      case 'pointer.dragStart':
        this.userTouchAt = this.now;
        this.events.interrupt('drag');
        break;
      case 'pointer.dragEnd':
      case 'pointer.hoverStart':
        this.userTouchAt = this.now;
        break;
      case 'command.callCat':
      case 'command.play':
      case 'command.wake':
        this.events.interrupt('user');
        break;
      case 'display.changed':
        this.events.interrupt('display');
        break;
      case 'system.lock':
        this.events.interrupt('lock');
        break;
      case 'system.suspend':
        this.events.interrupt('suspend');
        break;
      case 'command.sleep':
        this.events.interrupt('sleep');
        break;
      case 'command.eventsPause':
        this.eventsPaused = true;
        this.events.interrupt('pause');
        break;
      case 'command.eventsResume':
        this.eventsPaused = false;
        break;
      default:
        break;
    }
    super.handleEvent(ev);
  }

  // ---- the per-tick step ---------------------------------------------------------------------------------

  /** Once per tick, before the activity is updated: mood, the engine, then the body. */
  protected stepCompanion(): void {
    const env = this.env;
    if (!env) return;
    this.journalOut = null;
    if (this.now - this.personalityAt >= PERSONALITY_RECHECK_MS) this.syncPersonality();
    this.noteModeEdges();
    this.updateSleepDepth();
    const st = this.cat.stats;
    this.mood = moodFor({ stats: st, drives: this.cat.drives, state: this.act.state, push: this.moodTracker.strongest(this.now), previous: this.mood });

    const input = this.eventInput(env);
    const out = this.events.tick(input);
    this.props = out.props.length > 0 ? out.props : NO_PROPS;
    this.worldSnap = out.active;
    if (out.finished) {
      this.cat.world = appendEventHistory(this.cat.world, out.finished.history);
      if (out.finished.journal && this.settings.companion.journal.enabled) {
        this.cat.world = appendJournal(this.cat.world, out.finished.journal);
        this.journalOut = { id: out.finished.journal.id, at: out.finished.journal.at, outcome: out.finished.journal.outcome };
      }
      this.markDirty();
    }
    this.noteYield();
    if (out.intent) this.applyIntent(out.intent);
  }

  /** The mode changes that wind an event down for a reason the engine treats differently from "not allowed". */
  private noteModeEdges(): void {
    const mode = this.mode;
    if (mode === this.companionMode) return;
    this.companionMode = mode;
    if (mode === 'paused') this.events.interrupt('pause');
    else if (mode === 'away') this.events.interrupt(this.onFullscreenDisplay() ? 'fullscreen' : 'hidden');
    else if (mode === 'quiet') this.events.interrupt('fullscreen');
  }

  private updateSleepDepth(): void {
    const asleep = ASLEEP_STATES.has(this.act.state) || (this.mode === 'away' && this.awayWasAsleep && this.act.state === 'away');
    if (!asleep) {
      this.asleepSince = null;
      this.sleepDepth = 0;
      return;
    }
    this.asleepSince ??= this.now;
    this.sleepDepth = sleepDepthFor({ asleepMs: this.now - this.asleepSince, sleepiness: this.zEffNow(), energy: this.cat.stats.energy });
  }

  // ---- what the engine is told ----------------------------------------------------------------------------

  protected eventInput(env: SimEnv): EventTickInput {
    const m = this.mover;
    const s = this.act.state;
    const bw = m.bodyWidth;
    const stage = this.eventStage(env, bw);
    const companion = this.settings.companion;
    const asleep = ASLEEP_STATES.has(s) || s === 'wakingUp';
    const hopping = this.now < this.hopUntil;
    const busy = (PHYSICAL_STATES.has(s) && !hopping) || m.held || s === 'beingPetted' || s === 'away' || this.mode === 'away';
    const localHour = Number.isFinite(env.localHour) ? env.localHour : 12;
    this.temperament = temperamentFor({ choice: companion.personality, traits: this.traits, stats: this.cat.stats, drives: this.cat.drives, mood: this.mood, asleep, localHour });
    return {
      now: this.now,
      dt: this.dt,
      wallNow: this.wall(),
      localHour,
      random: this.companionRandom,
      stage,
      cat: {
        x: m.x,
        y: m.y,
        facing: m.facing,
        bodyW: bw,
        scale: m.scale,
        state: s,
        asleep,
        busy,
        mood: this.mood,
        floorLeft: Math.max(0, m.x - stage.x),
        floorRight: Math.max(0, stage.x + stage.width - m.x),
      },
      temperament: this.temperament,
      choices: {
        enabled: companion.events.enabled,
        rare: companion.events.rare,
        pace: companion.events.pace,
        disabled: companion.events.disabled,
        reducedMotion: companion.reducedMotion || env.reducedMotion === true,
      },
      allowed: this.eventsAllowed(env, hopping),
      userBusy: env.cursorOverCat === true || env.dragCursor !== null || this.now - this.userTouchAt < USER_BUSY_MS,
    };
  }

  /** May an event run (or start) right now? Anything else than a plain, free cat on a visible desktop says no. */
  private eventsAllowed(env: SimEnv, hopping: boolean): boolean {
    // Laser Mode is the user's own game with the cat: no world event starts or goes on beside it.
    if (this.eventsPaused || this.mode !== 'normal' || env.hidden || env.paused || env.laserMode === true) return false;
    const m = this.mover;
    if (m.held || (m.airborne && !hopping)) return false;
    if (PHYSICAL_STATES.has(this.act.state) && !hopping) return false;
    const fs: unknown = env.fullscreenDisplayIds;
    if (Array.isArray(fs) && fs.includes(m.displayId)) return false;
    return !(Number.isFinite(env.typingIntensity) && env.typingIntensity >= TYPING_HARD);
  }

  /** The stage: the host's, else the floor of the display the cat is on, about five body widths high. */
  protected eventStage(env: SimEnv, bw: number): Rect {
    const given = env.eventStage;
    if (given && isFiniteRect(given) && given.width >= 1 && given.height >= 1) return { x: given.x, y: given.y, width: given.width, height: given.height };
    const m = this.mover;
    const world = m.fullWorldModel;
    const display = world.display(m.displayId);
    const floor = world.floorFor(m.displayId);
    const piece = floor?.pieces.find((p) => p.displayId === m.displayId) ?? floor?.pieces[0];
    if (piece) {
      const top = Math.max(piece.y - STAGE_HEIGHT_BODIES * bw, display ? display.workAreaPx.y : -Infinity);
      return { x: piece.left, y: top, width: Math.max(1, piece.right - piece.left), height: Math.max(1, piece.y - top) };
    }
    if (display) {
      const wa = display.workAreaPx;
      const height = Math.min(wa.height, STAGE_HEIGHT_BODIES * bw);
      return { x: wa.x, y: wa.y + wa.height - height, width: wa.width, height };
    }
    return { x: m.x - STAGE_HEIGHT_BODIES * bw, y: m.y - STAGE_HEIGHT_BODIES * bw, width: 2 * STAGE_HEIGHT_BODIES * bw, height: STAGE_HEIGHT_BODIES * bw };
  }

  // ---- applying an intent -----------------------------------------------------------------------------------

  /** Another behaviour took the body from the event (a reaction, a call): it asks again only after a pause. */
  private noteYield(): void {
    if (!this.bodyLive || this.act.variant === 'event') return;
    if (this.pending?.init.variant === 'event' || this.suspended?.variant === 'event') return;
    if (this.now - this.bodyRequestedAt < 800) return;
    this.bodyLive = false;
    this.goal = null;
    this.eventLook = null;
    this.yieldUntil = this.now + YIELD_MS;
  }

  private applyIntent(intent: EventIntent): void {
    const urgent = intent.urgency >= URGENT;
    const a = this.act;
    const asleep = ASLEEP_STATES.has(a.state);
    // The world's own sounds (thunder, splash, chime) happen whatever the cat does, but never wake it gently.
    if (intent.sound && WORLD_SOUND_CUES.has(intent.sound) && (!asleep || urgent)) this.playSound(intent.sound);
    if (this.mode !== 'normal') return;
    if (asleep) {
      this.wakeFor(urgent);
      return;
    }
    if (!this.bodyMayTake(urgent)) {
      // Mid-hop the body is on the way back: the event still holds it.
      if (PHYSICAL_STATES.has(a.state) && this.suspended?.variant === 'event') this.bodyAt = this.now;
      return;
    }
    if (intent.sound && !WORLD_SOUND_CUES.has(intent.sound)) this.playSound(intent.sound);
    if (intent.emote) this.emotes.show(intent.emote, this.now);
    this.pushMood(intent);
    if (intent.kind === 'climb' && urgent && this.tryEdgeClimb()) return;
    const plan = this.planFor(intent);
    if (plan) this.runPlan(plan);
    else if (a.variant === 'event') this.bodyAt = this.now;
  }

  /** A sleeping cat only wakes for something loud: a startle for a jumpy one, a stretch for a calm one. */
  private wakeFor(urgent: boolean): void {
    const a = this.act;
    if (!urgent || a.variant === 'intro' || this.now - this.lastWakeAt < WAKE_GAP_MS || this.pending) return;
    this.lastWakeAt = this.now;
    if (this.temperament.startle >= 0.35) {
      if (this.request('startled', 'stimulus', { variant: 'jolt', dwellMs: 900 }) === 'ok') addFear(this.cat.stats, this.traits, 0.06 * this.temperament.startle);
    } else {
      this.request('wakingUp', 'stimulus', { dwellMs: 2600 });
    }
  }

  /** May an event take the body now? Never from a reaction, the user or the physics; gentle ones never from a busy or drowsy cat. */
  private bodyMayTake(urgent: boolean): boolean {
    const a = this.act;
    const s = a.state;
    const m = this.mover;
    if (this.pending && this.pending.init.variant !== 'event') return false;
    if (PHYSICAL_STATES.has(s) || s === 'away' || s === 'beingPetted' || m.held || m.airborne || m.onWall) return false;
    if (a.variant === 'event') return true;
    if (s === 'startled' || s === 'annoyed' || s === 'hiding') return false;
    if ((a.cause === 'command' || a.cause === 'interaction') && this.now - a.startedAt < USER_HOLD_MS) return false;
    if (this.now < this.yieldUntil || this.edgeVisit !== null || this.stay?.leaving) return false;
    if (s === 'walking' && !FREE_WALKS.has(a.variant)) return false;
    if (BUSY_STATES.has(s)) return urgent;
    if (!FREE_STATES.has(s)) return false;
    // A drowsy cat ignores gentle invitations (the engine already made it slow to notice).
    return urgent || (s !== 'wakingUp' && this.temperament.alertness >= 0.3);
  }

  private pushMood(intent: EventIntent): void {
    const mp = intent.mood;
    if (!mp || (mp.mood === this.lastPushedMood && this.now - this.moodPushAt < MOOD_PUSH_GAP_MS)) return;
    this.lastPushedMood = mp.mood;
    this.moodPushAt = this.now;
    this.moodTracker.push(mp.mood, mp.strength, this.now);
  }

  /**
   * A climb to get out of the way, with the existing screen-edge machinery: only with the host's edge
   * bands, a full climb (never a peek) and the scanner's own gates (cooldown, typing, cursor clearance).
   * False when it does not apply: the caller falls back to moving away or a hop.
   */
  private tryEdgeClimb(): boolean {
    if (!this.edgesOn || this.edgeVisit !== null || !this.mover.grounded || this.mover.attachedSurface !== null) return false;
    const t = this.scanEdge();
    if (!t || t.peek) return false;
    if (this.request('walking', 'stimulus', { variant: 'screenEdge', target: t.point, dwellMs: 30_000 }) !== 'ok') return false;
    // The edge visit is the cat's own activity from here: the event lets go of the body until it is done.
    this.bodyLive = false;
    this.goal = null;
    this.eventLook = null;
    this.yieldUntil = this.now + 20_000;
    return true;
  }

  // ---- intent -> body plan ----------------------------------------------------------------------------------

  private planFor(intent: EventIntent): BodyPlan | null {
    const m = this.mover;
    const bw = m.bodyWidth;
    const reduced = this.settings.companion.reducedMotion || this.env?.reducedMotion === true;
    const t = finitePoint(intent.target);
    const floorLevel = m.grounded && !m.onWall && m.attachedSurface === null;
    const urgent = intent.urgency >= URGENT;
    const standoff = clamp(Number.isFinite(intent.standoffPx) ? (intent.standoffPx as number) : DEFAULT_STANDOFF_BW * bw, 0.4 * bw, 14 * bw);
    const walk = (look: Point | null, gx: number | null, pace: Pace, phase: Phase): BodyPlan => ({
      state: 'walking',
      phase,
      look,
      clip: null,
      goal: gx === null ? null : { x: gx, pace, radius: 0.3 * bw },
      hop: false,
    });
    const still = (look: Point | null, fallback: AnimClip): BodyPlan => this.stillPlan(look, intent.clip ?? fallback);

    switch (intent.kind) {
      case 'watch':
        return still(t, 'sit');
      case 'brace':
        return still(t, 'crouch');
      case 'shake':
        return still(t, 'shake');
      case 'react':
        return intent.clip ? this.stillPlan(t, intent.clip) : null;
      case 'hide':
        return { state: 'hiding', phase: null, look: null, clip: null, goal: null, hop: false };
      case 'hop':
        return { state: 'playing', phase: 'crouch', look: t, clip: null, goal: null, hop: floorLevel };
      case 'sneak':
      case 'approach':
      case 'chase': {
        if (!t || !floorLevel) return still(t, 'sit');
        const gx = this.standoffGoalX(t.x, standoff);
        const pace: Pace = intent.kind === 'sneak' ? 'stalk' : intent.pace === 'run' && !reduced ? 'run' : intent.pace === 'slow' ? 'slow' : 'walk';
        return walk(t, gx, pace, intent.kind === 'sneak' ? 'stalk' : 'approach');
      }
      case 'flee':
      case 'climb': {
        if (!t || !floorLevel) return still(t, 'crouch');
        const away = m.x >= t.x ? 1 : -1;
        const want = Math.max(standoff, 6 * bw);
        const r = m.walkRange;
        const gx = r ? clamp(t.x + away * want, r.x0, r.x1) : m.x;
        // Safe already, or cornered with nowhere to go: hunker down where it is.
        if ((m.x - t.x) * away >= want) return still(t, 'sit');
        if (Math.abs(gx - m.x) < 0.8 * bw) return still(t, 'crouch');
        const fast = intent.kind === 'climb' || urgent || intent.pace === 'run';
        if (fast && !reduced) return walk(t, gx, urgent ? 'sprint' : 'run', urgent ? 'sprint' : 'approach');
        return walk(t, gx, 'slow', 'slink');
      }
      case 'play': {
        if (!t || !floorLevel) return still(t, 'sit');
        if (Math.abs(m.x - t.x) > standoff + NEAR_BW * bw) return walk(t, this.standoffGoalX(t.x, standoff), 'walk', 'approach');
        const clip = intent.clip ?? 'pawAt';
        const phase: Phase = clip === 'pawAt' ? 'pawAt' : clip === 'swat' ? 'swat' : clip === 'rollOver' ? 'rollOver' : 'crouch';
        return { state: 'playing', phase, look: t, clip: null, goal: null, hop: false };
      }
      case 'inspect':
      case 'settle': {
        const stand = clamp(Number.isFinite(intent.standoffPx) ? (intent.standoffPx as number) : (intent.kind === 'settle' ? 0.5 : 0.8) * bw, 0.4 * bw, 14 * bw);
        if (t && floorLevel && Math.abs(m.x - t.x) > stand + 1.5 * bw) return walk(t, this.standoffGoalX(t.x, stand), 'slow', 'approach');
        if (intent.kind === 'settle') {
          const clip = intent.clip ?? 'loaf';
          if (clip === 'loaf') return { state: 'resting', phase: 'loaf', look: t, clip: null, goal: null, hop: false };
          return this.stillPlan(t, clip);
        }
        return still(t, 'sit');
      }
      default:
        return none(intent.kind);
    }
  }

  /** An idle body: the sit and stand phases are drawn by the activity, any other clip is held as a one-shot. */
  private stillPlan(look: Point | null, requested: AnimClip): BodyPlan {
    const clip = resolveClip(requested, { walls: false, ledges: this.mover.attachedSurface !== null });
    const phase: Phase = clip === 'stand' ? 'stand' : 'sit';
    const held = clip === 'sit' || clip === 'stand' ? null : clip;
    return { state: 'idle', phase, look, clip: held, goal: null, hop: false };
  }

  /**
   * Where to stand to keep `standoff` from a point: on the cat's own side of it, never closer than the
   * cat already is. Null: already there (or closer), or nowhere to walk.
   */
  private standoffGoalX(tx: number, standoff: number): number | null {
    const m = this.mover;
    const r = m.walkRange;
    if (!r) return null;
    const side = m.x >= tx ? 1 : -1;
    if ((m.x - tx) * side <= standoff + 0.2 * m.bodyWidth) return null;
    const gx = clamp(tx + side * standoff, r.x0, r.x1);
    return Math.abs(gx - m.x) < 0.3 * m.bodyWidth ? null : gx;
  }

  // ---- carrying a plan out -----------------------------------------------------------------------------------

  private runPlan(plan: BodyPlan): void {
    let a: Activity = this.act;
    if (!(a.variant === 'event' && a.state === plan.state)) {
      // Waiting on a path through a neutral state: the pending request carries on by itself.
      if (this.pending) return;
      // 'completion' skips the stimulus cooldowns and interrupt priorities (bodyMayTake already refused every state an event may not take) but keeps the anti-thrash budget.
      if (this.request(plan.state, 'completion', { variant: 'event', dwellMs: BODY_DWELL_MS }) !== 'ok') return;
      this.bodyRequestedAt = this.now;
      this.bodyLive = true;
      a = this.act;
      if (!(a.variant === 'event' && a.state === plan.state)) return;
    }
    this.bodyLive = true;
    this.bodyAt = this.now;
    a.dwellMs = Math.max(a.dwellMs, this.now - a.startedAt + BODY_DWELL_MS);
    this.eventLook = plan.look;
    this.goal = plan.goal;
    // A hide keeps the flee target and phases enterHiding chose; a walk's target is its stand-off point.
    if (plan.state === 'walking') a.target = plan.goal ? { x: plan.goal.x, y: this.mover.y } : null;
    if (plan.phase !== null && a.phase !== plan.phase) this.phase(a, plan.phase);
    this.setHeldClip(plan.clip);
    if (plan.hop) this.tryHop();
  }

  /** The world event's walk: toward the stand-off point, or standing and facing the prop. */
  protected override updEventWalk(_a: Activity): void {
    const m = this.mover;
    const g = this.goal;
    if (g) this.goTo({ x: g.x, y: m.y }, g.pace, false, g.radius);
    else this.stop();
    if (this.eventLook) m.faceToward(this.eventLook.x, this.now);
  }

  /** The world event's stillness (watching, playing, resting): no goal, facing the prop. */
  protected override updEventStill(_a: Activity): void {
    this.stop();
    if (this.eventLook) this.mover.faceToward(this.eventLook.x, this.now);
  }

  /** Hands the body back when no event held it for a moment: the activity ends and the cat decides again. */
  protected override releaseStaleEventBody(a: Activity): boolean {
    if (this.bodyLive && this.now - this.bodyAt <= BODY_STALE_MS) return false;
    this.bodyLive = false;
    this.goal = null;
    this.eventLook = null;
    this.setHeldClip(null);
    if (a.state === 'hiding') {
      // The hide plays out its last moments by itself.
      a.variant = null;
      a.dwellMs = Math.min(a.dwellMs, this.now - a.startedAt + HIDE_TAIL_MS);
      return false;
    }
    this.stop();
    this.finish();
    return true;
  }

  /** A one-shot clip held over an idle body; null lets go of it (only a clip this layer holds). */
  private setHeldClip(clip: AnimClip | null): void {
    if (clip === null) {
      if (this.holdingClip) {
        this.oneShot = null;
        this.holdingClip = false;
      }
      return;
    }
    if (!this.oneShot || this.oneShot.clip !== clip) {
      this.oneShot = { clip, until: this.now + HOLD_CLIP_MS };
      this.restartClip = true;
    } else {
      this.oneShot.until = this.now + HOLD_CLIP_MS;
    }
    this.holdingClip = true;
  }

  /** A small hop at the prop, from the playing body (the state table lets only playing and walking jump). */
  private tryHop(): void {
    const m = this.mover;
    if (this.now - this.lastHopAt < HOP_GAP_MS || !m.grounded || m.onWall || this.mode !== 'normal' || this.typingGate() || this.act.state !== 'playing') return;
    this.lastHopAt = this.now;
    if (m.hop(this.now) && this.request('jumping', 'physical', { suspend: true }) === 'ok') {
      this.fallReason = 'jump';
      this.hopUntil = this.now + HOP_ALLOWED_MS;
    } else {
      m.cancelCrouch();
    }
  }
}

