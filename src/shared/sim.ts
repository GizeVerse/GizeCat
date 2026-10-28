// Contract between the main-process host and the pure cat simulation (src/core).
// All coordinates here are PHYSICAL virtual-screen pixels ("px").
import type { AnimClip, BehaviorState, Emote, Facing } from './cat';
import type { PersistedCat } from './catState';
import type { Point, Rect } from './geometry';
import type { SceneReport, VisualSummary } from './perception';
import type { Settings } from './settings';
import type { AppCategory, Platform, WindowInfo, WorldGeometry } from './world';

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
  | { type: 'window.closed'; id: string; rect: Rect | null; category: AppCategory }
  | { type: 'window.foreground'; window: WindowInfo | null; switchesPerMinute: number }
  | { type: 'window.moveStart'; id: string }
  | { type: 'window.moveEnd'; id: string; rect: Rect | null }
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
  | { type: 'lifecycle.quitRequested' };

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
  /** Visible top edges of app windows (z-order aware), refreshed by the host. */
  platforms: readonly Platform[];
  /** Fresh rectangle of a window (px), null if gone/minimized/hidden. Cheap; used for riding a perch. */
  getWindowRect: (id: string) => Rect | null;
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
}

export type CreateCatSim = (opts: CatSimOptions) => CatSim;
