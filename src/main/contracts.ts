// Interfaces between main-process services. Implementations live in their own
// folders; src/main/app.ts composes them. Coordinates are physical px unless noted.
import type { Point, Rect } from '../shared/geometry';
import type { VisualSummary, SceneReport, PerceptionStatus } from '../shared/perception';
import type { Settings } from '../shared/settings';
import type { SimEvent } from '../shared/sim';
import type { LedgeSurface, Surface, SurfaceStatus, TaskbarEdge } from '../shared/surfaces';
import type { Platform, WindowInfo, WorldGeometry } from '../shared/world';

export type Unsubscribe = () => void;

export interface Logger {
  error(msg: string, data?: Record<string, unknown>): void;
  warn(msg: string, data?: Record<string, unknown>): void;
  info(msg: string, data?: Record<string, unknown>): void;
  debug(msg: string, data?: Record<string, unknown>): void;
  child(scope: string): Logger;
}

/** Thin, synchronous Win32 facade (koffi). Every method must be safe to call at any time and never throw. */
export interface Win32Api {
  readonly available: boolean;
  getCursorPos(): Point | null;
  /** ms since last input of any kind (GetLastInputInfo, wrap-safe). */
  getIdleMs(): number | null;
  isLeftButtonDown(): boolean;
  getForegroundWindowId(): string | null;
  /** Describes a top-level window; null if it is not an app window or is gone. Titles stay inside. */
  describeWindow(id: string): WindowInfo | null;
  /** Visible extended frame bounds of a window, null if gone/minimized/cloaked. */
  getWindowRect(id: string): Rect | null;
  /** App windows in z-order, top first (Alt-Tab-like filtering). */
  listAppWindows(): WindowInfo[];
  /** Topmost root window at a physical point (OS hit-testing). */
  windowIdAtPoint(p: Point): string | null;
  /** SHQueryUserNotificationState: fullscreen/presentation/D3D exclusive. */
  getNotificationState(): 'fullscreen' | 'presentation' | 'd3d-fullscreen' | 'busy' | 'normal' | 'unknown';
  /** Subscribes to WinEvent hooks; returns false when hooks are unavailable. */
  subscribeWinEvents(handler: (ev: RawWinEvent) => void): Unsubscribe | null;
  dispose(): void;
}

export interface RawWinEvent {
  kind: 'foreground' | 'moveStart' | 'moveEnd' | 'minimizeStart' | 'minimizeEnd' | 'show' | 'hide' | 'destroy' | 'cloaked' | 'uncloaked';
  id: string;
  at: number;
}

/** Tracks windows and produces SimEvents + platforms. */
export interface WindowTracker {
  readonly mode: 'event-hooks' | 'polling' | 'unavailable';
  start(): void;
  stop(): void;
  /** Drains events accumulated since the last call (bounded queue, coalesced). */
  drainEvents(): SimEvent[];
  getForeground(): WindowInfo | null;
  /** Visible top edges of app windows, cached; refreshed at most every `maxAgeMs`. */
  getPlatforms(maxAgeMs: number): readonly Platform[];
  getWindowRect(id: string): Rect | null;
  /** Ids of displays where a fullscreen app is in front. */
  getFullscreenDisplayIds(world: WorldGeometry): string[];
  /**
   * True when the window shown at p is excluded (or cannot be cleared). This app's windows
   * are never private: under its overlay the window below is judged. Privacy check.
   */
  isExcludedAt(p: Point): boolean;
  /**
   * True when the real foreground window (any kind: owned dialog, tool window, popup) or a
   * window in its owner chain is excluded, or when that cannot be determined; false while
   * this app is in front. Privacy check for the capture gate.
   */
  isForegroundExcluded(): boolean;
  /**
   * Rects (px) of every shown top-level window (dialogs, tool windows and popups included)
   * matching privacy exclusions; masked out of every frame. When they cannot be located,
   * one rect covering everything.
   */
  getExcludedRects(): Rect[];
  /** Title patterns make window titles be read (in memory only); pass none to read no titles. */
  setExclusions(processes: readonly string[], titlePatterns: readonly string[]): void;
}

/** Coarse user-activity signals. Never records keys, text or clipboard. */
export interface ActivityMonitor {
  start(): void;
  stop(): void;
  /** Called by the host every tick with the latest cursor sample. */
  sample(now: number, cursor: Point | null): void;
  drainEvents(): SimEvent[];
  /** Threshold for the second activity.userIdle event (the cat's sleep threshold). */
  setSleepThresholdMs(ms: number): void;
  readonly idleMs: number;
  readonly typing: boolean;
  readonly typingIntensity: number;
  readonly cursorSpeed: number;
}

export interface DisplayService {
  readonly world: WorldGeometry;
  onChange(cb: (world: WorldGeometry) => void): Unsubscribe;
  /** Physical -> overlay-local DIP for a given display. */
  toLocalDip(displayId: string, p: Point): Point;
  /** Overlay-local DIP -> physical. */
  fromLocalDip(displayId: string, p: Point): Point;
  displayAt(p: Point): string | null;
  /** Re-reads the topology (e.g. after resume); true if it changed. */
  refresh(): boolean;
  dispose(): void;
}

export interface PerceptionHost {
  /** Cat's current bounds (px) so it can be masked out of frames. */
  getCatBounds(): Rect | null;
  getCatDisplayId(): string | null;
  getForeground(): WindowInfo | null;
  isExcludedAt(p: Point): boolean;
  /** Visible excluded windows (px); they are blacked out before analysis. */
  getExcludedRects(): readonly Rect[];
  /** True when the real foreground window (or a window it belongs to) is private, or cannot be cleared. */
  isForegroundExcluded(): boolean;
  isLocked(): boolean;
}

export interface PerceptionService {
  readonly status: PerceptionStatus;
  updateSettings(settings: Settings): void;
  /** Ask for an analysis; rate limits, consent and exclusions are enforced inside. */
  request(reason: 'curious' | 'watching' | 'periodic' | 'event', focus: Point | null): void;
  drainEvents(): SimEvent[];
  setPaused(paused: boolean): void;
  /** An API key was stored or removed: earlier provider failures (circuit breaker, last error) are forgotten. */
  onCredentialsChanged(): void;
  /**
   * One capture now, not stored. The image is the masked analysis frame (PNG) or,
   * while AI vision runs, the masked JPEG exactly as it would be sent (it is not sent).
   */
  preview(): Promise<{ ok: boolean; imageDataUrl?: string; summary?: VisualSummary; blockedReason?: string }>;
  testAi(): Promise<{ ok: boolean; message: string; latencyMs?: number; report?: SceneReport }>;
  listModels(): Promise<{ ok: boolean; models: string[]; error?: string }>;
  onStatusChange(cb: (s: PerceptionStatus) => void): Unsubscribe;
  dispose(): void;
}

/** Encrypted secret storage (Electron safeStorage / DPAPI). Values never reach renderers or logs. */
export interface SecretStore {
  has(name: 'anthropic' | 'openai-compatible'): boolean;
  get(name: 'anthropic' | 'openai-compatible'): string | null;
  set(name: 'anthropic' | 'openai-compatible', value: string | null): boolean;
}

// ---------------------------------------------------------------------------
// v1.1 environment surfaces
// ---------------------------------------------------------------------------

/** One taskbar (primary Shell_TrayWnd or a Shell_SecondaryTrayWnd), physical px. */
export interface TaskbarState {
  /** HWND (decimal string) of the taskbar window. */
  id: string;
  displayId: string | null;
  edge: TaskbarEdge;
  autoHide: boolean;
  /** Live window rect (moves off-screen while auto-hidden; a 1-2 px strip stays). */
  rect: Rect;
  /** Fully docked rect (where it is when shown). */
  dockedRect: Rect;
  /** 0..1 how much of its thickness is on screen. */
  shownFraction: number;
  phase: 'hidden' | 'showing' | 'shown' | 'hiding';
  /** Edge-normal speed of the visible edge, px/s (negative = moving up for a bottom taskbar). */
  speed: number;
  validatedAt: number;
}

/**
 * Observes taskbars with cheap, adaptive geometry sampling (no screen capture). Samples
 * fast only while something is changing, the cursor is near an auto-hide edge, or the cat
 * is on/near a taskbar.
 */
export interface TaskbarTracker {
  readonly available: boolean;
  start(): void;
  stop(): void;
  /** Called by the host with the cursor (px) and whether the cat is on/near a taskbar; returns the suggested next sample delay (ms). */
  sample(now: number, cursor: Point | null, catNear: boolean): number;
  taskbars(): readonly TaskbarState[];
  /** Ledge surfaces for taskbars that currently support the cat. */
  surfaces(): readonly LedgeSurface[];
  drainEvents(): SimEvent[];
  debugInfo(): Record<string, unknown>;
}

/** Browser tab-strip discovery via the UI Automation helper (geometry only, never names). */
export interface TabStripService {
  readonly status: SurfaceStatus['tabStrips'];
  readonly statusReason: string | null;
  start(): void;
  stop(): void;
  updateSettings(settings: Settings): void;
  /** Hint which browser windows matter now (e.g. near the cat / foreground). Bounded; cheap. */
  setInterest(windowIds: readonly string[], now: number): void;
  /** Current tab-strip ledges (already clipped to safe walking spans). */
  surfaces(): readonly LedgeSurface[];
  drainEvents(): SimEvent[];
  debugInfo(): Record<string, unknown>;
  dispose(): Promise<void>;
}

/** Aggregates taskbars, window tops/sides and tab strips into one occlusion-aware surface set. */
export interface SurfaceProvider {
  readonly status: SurfaceStatus;
  /** All usable surfaces, refreshed at most every maxAgeMs (taskbars always fresh). */
  getSurfaces(now: number, maxAgeMs: number): readonly Surface[];
  /** Fresh geometry of one surface (live OS read). */
  getSurface(id: string, now: number): Surface | null;
  drainEvents(): SimEvent[];
  updateSettings(settings: Settings): void;
  debugInfo(): Record<string, unknown>;
  dispose(): Promise<void>;
}
