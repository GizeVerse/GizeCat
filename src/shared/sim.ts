// Contract between the main-process host and the pure cat simulation (src/core).
// All coordinates here are PHYSICAL virtual-screen pixels ("px").
import type { BehaviorProfileSnapshot } from './behaviorProfile';
import type { AnimClip, BehaviorState, CatReaction, CatSoundCue, Emote, Facing, JumpKind } from './cat';
import type { PersistedCat } from './catState';
import type { Point, Rect } from './geometry';
import type { SceneReport, VisualSummary } from './perception';
import type { Settings } from './settings';
import type { DecisionDiagnostics, NavDiagnostics, SurfaceDebugLine } from './surfaceDiagnostics';
import type { ScreenEdgeBand, Surface, SupportSurfaceKind, TaskbarEdge } from './surfaces';
import type { AppCategory, WindowInfo, WorldGeometry } from './world';
import type { AnyEventId, JournalEntry, Mood, PersonalityId, RenderProp, WorldEventSnapshot } from './companion';

/** Discrete stimuli delivered to the simulation since the previous tick. */
export type SimEvent =
  // Direct interaction (from the overlay gesture recogniser)
  | { type: 'pointer.hoverStart'; at: Point }
  | { type: 'pointer.hoverEnd' }
  | { type: 'pointer.tap'; at: Point }
  | { type: 'pointer.doubleTap'; at: Point }
  | { type: 'pointer.pet'; at: Point; strength: number }
  | { type: 'pointer.dragStart'; at: Point }
  | { type: 'pointer.dragEnd'; at: Point; velocity: Point }
  // Window / desktop awareness (Tier A)
  | { type: 'window.shown'; window: WindowInfo }
  | { type: 'window.closed'; id: string; rect: Rect | null; category: AppCategory; excluded?: boolean }
  | { type: 'window.foreground'; window: WindowInfo | null; switchesPerMinute: number }
  | { type: 'window.moveStart'; id: string; excluded?: boolean }
  | { type: 'window.moveEnd'; id: string; rect: Rect | null; excluded?: boolean }
  | { type: 'window.minimized'; id: string }
  | { type: 'window.restored'; window: WindowInfo }
  // User activity (coarse, content-free)
  | { type: 'activity.typingStart' }
  | { type: 'activity.typingEnd'; durationMs: number }
  | { type: 'activity.userIdle'; idleMs: number }
  | { type: 'activity.userReturned'; idleMs: number }
  | { type: 'cursor.flick'; speed: number; at: Point }
  // Environment
  | { type: 'display.changed' }
  | { type: 'system.lock' }
  | { type: 'system.unlock' }
  | { type: 'system.suspend' }
  | { type: 'system.resume' }
  // Optional perception (Tier B / C)
  | { type: 'perception.visual'; summary: VisualSummary }
  | { type: 'perception.ai'; report: SceneReport; regionPx: Rect }
  // Commands from tray / context menu
  | { type: 'command.callCat'; at: Point }
  | { type: 'command.sleep' }
  | { type: 'command.wake' }
  | { type: 'command.play' }
  /**
   * Living Companion, session-only: hold the world-event schedule (the user paused events from the menu or
   * panel) / let it run again. A running event winds down gracefully. Never persisted; a new session
   * starts with events running (settings.companion.events.enabled still governs).
   */
  | { type: 'command.eventsPause' }
  | { type: 'command.eventsResume' }
  | { type: 'lifecycle.quitRequested' }
  // Environment surfaces (v1.1)
  /** An auto-hide (or newly discovered) taskbar slid into view; `surfaceId` names its ledge in env.surfaces. */
  | { type: 'taskbar.shown'; surfaceId: string; displayId: string | null; edge: TaskbarEdge }
  /** A taskbar started sliding out / disappeared; its ledge leaves env.surfaces. */
  | { type: 'taskbar.hidden'; surfaceId: string; displayId: string | null; edge: TaskbarEdge }
  /** Observable change of a browser tab strip (geometry only; no tab names are ever read). */
  | { type: 'tabs.changed'; surfaceId: string; ownerId: string; change: 'added' | 'removed' | 'selected' | 'geometry'; focusX: number | null };

export type SimEventType = SimEvent['type'];

/** Continuous sensor snapshot, sampled by the host every tick. */
export interface SimEnv {
  /** Monotonic simulation clock in ms. */
  now: number;
  /** ms since the previous tick (host clamps to <= 250). */
  dt: number;
  /** Cursor position (px) and smoothed speed (px/s), or null when unavailable. */
  cursor: { x: number; y: number; speed: number } | null;
  /** True while the cursor is over the cat's hit region. */
  cursorOverCat: boolean;
  /** Time since the last user input of any kind (ms). */
  userIdleMs: number;
  /** Coarse keyboard-like activity (input without cursor motion). No key data. */
  typing: boolean;
  /** 0..1 share of the last ~30 s with keyboard-like activity. */
  typingIntensity: number;
  foreground: WindowInfo | null;
  /**
   * Every currently usable environmental surface (taskbars, window tops and sides, tab strips),
   * z-order/occlusion aware, refreshed by the host (taskbars every host tick).
   */
  surfaces: readonly Surface[];
  /** Fresh geometry of one surface by id (live OS read for the surface the cat is attached to), or null if gone. */
  getSurface: (id: string) => Surface | null;
  /** Displays on which a fullscreen app is in front. */
  fullscreenDisplayIds: readonly string[];
  /** User pressed Pause: the cat settles where it is and stops autonomous behaviour. */
  paused: boolean;
  /** User hid the cat (tray / shortcut). */
  hidden: boolean;
  /** While dragged: cursor position in px. */
  dragCursor: Point | null;
  /** Local wall-clock hour 0..24 for a gentle daily rhythm. */
  localHour: number;
  // ---- v1.2 (ADR 0003), optional: absent means the stated default ----------------
  /**
   * A mouse button is held (the user is clicking, selecting or dragging something). The cat never
   * stalks or pounces at a cursor whose button is down. Content-free (button state only). Default false.
   */
  pointerButtonDown?: boolean;
  /** ms since the cursor last moved more than ~2 DIP; a still cursor stops being prey. Default: derived from speed. */
  cursorIdleMs?: number;
  /**
   * Outer screen edges' cling bands and where they are clear of app windows (T8 guard). Absent =
   * no host guard (an older host, a test host, no Win32): the sim never climbs a screen edge at all
   * (cfg.screenEdges stays off), so an unguarded host can never make the cat cling over app controls.
   */
  edgeBands?: readonly ScreenEdgeBand[];
  /**
   * Android floating cat (1.4.2): the left edge is a full-height climb like the right one, not the
   * desktop's short peek (the peek rule protects a visible desktop's sidebars and scrollbars, which a
   * phone screen has not). Absent or false: the desktop rule, unchanged.
   */
  edgeFullBothSides?: boolean;
  /**
   * Android floating cat (1.4.2): multiplies the pause between screen-edge visits (default 1: the
   * desktop's 4 to 8 minutes), clamped to 0.05..1, so a pet that lives on a phone screen visits its
   * edges often enough to be seen. Absent: the desktop pause, unchanged.
   */
  edgeCooldownScale?: number;
  /**
   * v1.2 (review C2): monotonic count of mouse-button presses (down edges, any button) since the host
   * started. Content-free (no position, no which-button); the sim only compares it with the previous
   * tick's value: a press ends a running hunt and blocks hunt starts for a few seconds (ADR 0003 §4.3).
   * Absent: unknown (no button gate beyond pointerButtonDown).
   */
  pointerButtonPresses?: number;
  // ---- Living Companion, optional: absent means the stated default ---------------------------
  /**
   * Laser Mode is on (the user turned it on from the cat's menu or the panel). The cat chases the
   * cursor position as if it were a light: it never pounces on it, never catches it and never counts
   * it as prey ('caught'), and the opt-outs for cursor play still apply. Default false.
   */
  laserMode?: boolean;
  /**
   * The user asked for reduced motion: calmer clips (no long sprints or big jumps by choice), slower
   * and fewer event props, no flashes. Default false.
   */
  reducedMotion?: boolean;
  /**
   * Work area of the display the cat is on that a world event may use as its stage, in the same
   * px as the cat (floor y is its bottom). Absent: the sim derives it from the world geometry.
   */
  eventStage?: Rect;
}

export type SimSupport =
  | { kind: 'floor'; displayId: string }
  | { kind: 'window'; windowId: string }
  /** Attached to an environmental surface (v1.1): standing on a ledge or clinging to a wall. */
  | { kind: 'surface'; surfaceId: string; surfaceKind: SupportSurfaceKind; orientation: Surface['orientation'] }
  | { kind: 'air' }
  | { kind: 'held' };

export type SimRequest =
  | { type: 'perception'; reason: 'curious' | 'watching' | 'periodic'; focus: Point }
  | { type: 'save' }
  | { type: 'quitReady' };

/** Per-tick output in world space; the host maps it into each overlay. */
export interface SimOutput {
  /** Ground anchor (between the feet), px. */
  x: number;
  y: number;
  facing: Facing;
  state: BehaviorState;
  clip: AnimClip;
  clipStartedAt: number;
  /** Body-lengths per second (gait rate). */
  speed: number;
  /** px/s, positive = downwards, while airborne. */
  vy: number;
  look: Point | null;
  arousal: number;
  contentment: number;
  emote: Emote | null;
  emoteStartedAt: number;
  opacity: number;
  visible: boolean;
  /** Position jumped discontinuously this tick (no interpolation). */
  snap: boolean;
  /** Display containing the anchor. */
  displayId: string | null;
  support: SimSupport;
  /** Approximate cat bounds (px) for hit-testing until the renderer reports an exact region. */
  boundsPx: Rect;
  /** Preferred delay before the next tick (ms): ~33 awake, ~100+ asleep, ~500 hidden. */
  nextTickMs: number;
  requests: SimRequest[];
  /** Short, one-off body-language reaction (e.g. an ear flick on a tap); the renderer plays it once per distinct `at`. */
  reaction?: CatReaction | null;
  // ---- v1.2 render hints (ADR 0003 §6, §8, §10), optional ----------------------------
  /** Kind of the current flight while airborne, else null/absent. */
  jumpKind?: JumpKind | null;
  /** 0..1 hardness of the landing being played. */
  impact?: number;
  /** 0..1 how hard the cat balances (narrow ledge, top corner of a screen edge). */
  balance?: number;
  /** One-off procedural sound (only while settings.sound.enabled); the host routes it to one overlay. */
  sound?: CatSoundCue | null;
  // ---- Living Companion render hints, optional ----------------------------------------------
  /** World-event props to draw (world px; at most MAX_PROPS). Absent or empty: none. */
  props?: readonly RenderProp[];
  /** The cat's current temporary mood (derived, never persisted). */
  mood?: Mood;
  /** 0..1 how deeply it sleeps (0 just dozing, 1 deep sleep); only meaningful while asleep. */
  sleepDepth?: number;
  /** The world event that is running, for status displays and the journal; null/absent: none. */
  worldEvent?: WorldEventSnapshot | null;
  /** A short event line to write in the journal this tick (the host appends it to the persisted journal; the sim also keeps it). */
  journalEntry?: JournalEntry | null;
}

export interface CatSimOptions {
  persisted: PersistedCat | null;
  settings: Settings;
  world: WorldGeometry;
  now: number;
  /** Uniform [0,1) RNG; inject a seeded one in tests. */
  random?: () => number;
  /** Wall clock (epoch ms) for persisted timestamps; injectable for tests. */
  wallClock?: () => number;
}

export interface CatSim {
  tick(env: SimEnv, events: readonly SimEvent[]): SimOutput;
  updateSettings(settings: Settings): void;
  setWorld(world: WorldGeometry): void;
  serialize(): PersistedCat;
  resetPersonality(): void;
  clearHistory(): void;
  /** Current behaviour state, for status displays. */
  readonly state: BehaviorState;
  /** Non-sensitive debug info for diagnostics export. */
  debugInfo(): Record<string, unknown>;
  /** v1.1.1: why the cat can or cannot get off the floor (kinds, counts, reasons; no ids or titles). */
  surfaceDiagnostics(): { nav: NavDiagnostics; decision: DecisionDiagnostics };
  /** v1.1.1: segments for the optional on-desktop surface visualization (physical px). */
  surfaceDebugLines(): SurfaceDebugLine[];
  /** v1.2: session behaviour profile (kinds, counts, durations; ADR 0003 §11). */
  behaviorProfile(): BehaviorProfileSnapshot;
  /**
   * Living Companion: the live status for the Companion page and status displays (ids and numbers
   * only). nextEventInMs is null while an event runs, events are off or paused, or the schedule is frozen.
   */
  companionStatus(): { mood: Mood; event: AnyEventId | null; nextEventInMs: number | null; nearestPersonality: PersonalityId; personalityIsAuto: boolean };
  /** Living Companion: the persisted journal, oldest first (bounded; a copy). */
  journal(): readonly JournalEntry[];
  /** Living Companion: clears the journal and the event history behind it (nothing else); marks the cat dirty. */
  clearJournal(): void;
}

export type CreateCatSim = (opts: CatSimOptions) => CatSim;
