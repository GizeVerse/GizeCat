// Contract between the main-process host and the pure cat simulation (src/core).
// All coordinates here are PHYSICAL virtual-screen pixels ("px").
import type { AnimClip, BehaviorState, CatReaction, Emote, Facing } from './cat';
import type { PersistedCat } from './catState';
import type { Point, Rect } from './geometry';
import type { SceneReport, VisualSummary } from './perception';
import type { Settings } from './settings';
import type { DecisionDiagnostics, NavDiagnostics, SurfaceDebugLine } from './surfaceDiagnostics';
import type { Surface, TaskbarEdge } from './surfaces';
import type { AppCategory, WindowInfo, WorldGeometry } from './world';

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
}

export type SimSupport =
  | { kind: 'floor'; displayId: string }
  | { kind: 'window'; windowId: string }
  /** Attached to an environmental surface (v1.1): standing on a ledge or clinging to a wall. */
  | { kind: 'surface'; surfaceId: string; surfaceKind: Surface['kind']; orientation: Surface['orientation'] }
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
}

export type CreateCatSim = (opts: CatSimOptions) => CatSim;
