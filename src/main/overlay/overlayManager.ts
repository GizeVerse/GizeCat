// Owns the per-display overlay windows: lifecycle (create/recreate on display
// changes and renderer crashes), render dispatch, hit regions, pointer input and
// click-through routing. Windows stay shown for their whole life; only what the
// renderer draws changes.
import { screen, type BrowserWindow } from 'electron';
import type { CatRenderState, HitRegion } from '../../shared/cat';
import { distance, type Point, type Rect } from '../../shared/geometry';
import { IPC, type OverlayConfig, type OverlayPointerEvent } from '../../shared/ipc';
import type { Settings } from '../../shared/settings';
import type { SimEvent, SimOutput } from '../../shared/sim';
import type { SurfaceLinesPayload } from '../../shared/surfaceDiagnosticsSchema';
import type { DisplayGeometry, WorldGeometry } from '../../shared/world';
import type { DisplayService, Logger, Unsubscribe } from '../contracts';
import type { WindowRegistry } from '../security';
import { crashBackoff, boundsDiffer, planOverlaySync } from './displayDiff';
import { cursorInHitZone, decideInteractive, DEFAULT_CLICK_THROUGH, EVERYWHERE } from '../../core/interaction/clickThrough';
import { SCREEN_EDGE_KIND } from '../../shared/surfaces';
import type { GesturePointerEvent, GestureRecognizer } from '../../core/interaction/gestures';
import { WIN32_OVERLAY_PROFILE, type OverlayProfile } from './overlayProfile';
import { createOverlayShell, createOverlayWindow, overlayUrl, type OverlayShell } from './overlayWindow';
import { displaysShowingCat, hiddenRenderState, mapRenderState } from './renderMapping';
import { surfaceLinesForDisplay, type SurfaceLinesSink } from './surfaceLines';

const DISPLAY_DEBOUNCE_MS = 300;
const TOPMOST_CHECK_MS = 10_000;
/** Reported hit regions are trusted while fresh or while the cat has not moved since. */
const HIT_REGION_FRESH_MS = 300;
const HIT_REGION_MOVE_TOLERANCE_PX = 4;
/**
 * Lost-press detection (diagnosis H1). The renderer is authoritative while it is alive: a press
 * ends with its own 'up', 'cancel' or a buttonless move. Main ends it on its own only when the
 * Win32 button state says "up" for this long AND the pressing renderer has sent nothing for as long.
 * Win32's "up" counts only for a press it has seen down at least once: GetAsyncKeyState can read 0
 * for a whole press (H1a), and then its state is unknown for that press (see LOST_PRESS_MOVE_DIP).
 */
const LOST_PRESS_MS = 400;
/**
 * ... and once the renderer has reported a move with the primary button held during the press (a
 * drag under way), Win32 needs this long: the drag may have paused into a still hold, which sends
 * no events. The 'down' itself does not count: it always carries the button.
 */
const LOST_PRESS_HELD_MS = 1500;
/**
 * Without a button state (no Win32, the read failed, or Win32 never saw this press down): while the
 * button is held the pressing overlay has the mouse captured and reports every movement, so a cursor
 * that moved this far (DIP) with no pointer event for LOST_PRESS_MS means the release was lost.
 */
const LOST_PRESS_MOVE_DIP = 12;
/**
 * A kept overlay (display change, resume) whose window drifted further than this from its work area
 * is recreated; fractional scale factors move a window by 1-2 px on their own (electron#55245).
 */
const BOUNDS_DRIFT_TOLERANCE = 2;
/**
 * Silence and button-up time counted towards a lost press per cursor poll are capped (above the
 * slowest poll interval), so a stall of main itself, with the release still queued, never counts.
 */
const PRESS_STEP_MAX_MS = 130;
const MAX_TOPMOST_REASSERTS_PER_MIN = 6;
/**
 * Hang watchdog. A ready overlay showing the cat re-reports its hit region every
 * ~0.5 s (renderer heartbeat). Without a press, silence beyond the hit-region age limit (the
 * point where the region stops being trusted) marks the renderer hung, so an overlay is never
 * left click-through over the cat without recovery under way; a press keeps its captured
 * pointer for up to HANG_SILENCE_MS. Hung: click-through at once (ending any press) and
 * recreated if it stays silent or unresponsive for HANG_RECREATE_MS more.
 */
const HANG_SILENCE_MS = 3000;
const HANG_IDLE_SILENCE_MS = DEFAULT_CLICK_THROUGH.maxRegionAgeMs;
const HANG_RECREATE_MS = 5000;
/** A created overlay whose page never reports ready within this (poll-counted) time is recreated. */
const READY_TIMEOUT_MS = 30_000;
/** Silence counted per watchdog check is capped, so main's own stalls never count against a renderer. */
const WATCHDOG_MAX_STEP_MS = 250;
/**
 * After the crash budget is exhausted the display is retried after this delay, doubling per failed
 * round up to EXHAUSTED_RETRY_MAX_MS; resume, unlock and display changes retry at once.
 */
const EXHAUSTED_RETRY_MS = 60_000;
const EXHAUSTED_RETRY_MAX_MS = 30 * 60_000;
/**
 * Renderer → main clock mapping: the offset is the minimum (least-latency) observation over a
 * sliding window of one to two buckets, so one outlier or a clock step is forgotten.
 */
const OFFSET_BUCKET_MS = 5000;
/**
 * Mapped times never run backwards per overlay and keep at least the renderer's own spacing between
 * events, up to this much: above every gesture timing (tap 600 ms, double tap 350 ms, stroke timeout
 * 400 ms), so a drop in the offset estimate never merges or reorders a gesture.
 */
const RENDERER_SPACING_MAX_MS = 1000;
/** Info lines of one kind at most this often; the suppressed ones are counted into the next. */
const LOG_EVERY_MS = 10_000;
/** A run of fail-closed denials with the cursor on the cat is reported once it lasts this long. */
const FAIL_CLOSED_STREAK_LOG_MS = 2000;
const PRIMARY_MASK = 1;
/** Every overlay receives the TaskbarCreated broadcast: forward one notification per broadcast. */
const TASKBAR_CREATED_DEDUPE_MS = 1000;
const NO_RECTS: readonly Rect[] = Object.freeze([]);
/** Platforms without the Windows shell extras (ADR 0004 §5): nothing to set or hook. */
const NO_SHELL: OverlayShell = Object.freeze({ beforeShow: () => false, beforeDestroy: () => false, hookTaskbarCreated: () => false });
/**
 * v1.2 hover dwell (ADR 0003 §6.1): a cat clinging to a screen edge takes the mouse only after the
 * cursor has rested on it this long, so a passing click goes to the window behind it.
 */
export const CLING_HOVER_DWELL_MS = 300;

export interface OverlayInfo {
  displayId: string;
  webContentsId: number;
  hwnd: string;
  bounds: Rect;
  boundsPx: Rect;
  expectedBounds: Rect;
  visible: boolean;
  ignoreMouse: boolean;
  focusable: boolean;
  alwaysOnTop: boolean;
  backgroundColor: string;
  ready: boolean;
  active: boolean;
  healthy: boolean;
  crashes: number;
  /** NonRudeHWND was set on this overlay before it was shown. */
  nonRude: boolean;
  /** The TaskbarCreated broadcast is hooked on this overlay. */
  taskbarCreatedHook: boolean;
}

export interface OverlayManagerOptions {
  logger: Logger;
  display: DisplayService;
  registry: WindowRegistry;
  preloadPath: string;
  devTools: boolean;
  debugOverlay: boolean;
  getSettings: () => Settings;
  gestures: GestureRecognizer;
  /** Gesture results for the simulation. */
  onSimEvents: (events: SimEvent[]) => void;
  onContextMenu: (win: BrowserWindow) => void;
  /** Windows session ending: persist immediately. */
  onSessionEnd: () => void;
  /** Physical primary-button state; null when unknown (no Win32). */
  isLeftButtonDown: () => boolean | null;
  /** Monotonic ms. */
  clock: () => number;
  /** Shell integration (NonRudeHWND, TaskbarCreated); defaults to the koffi-backed one. */
  shell?: OverlayShell;
  /** Explorer re-created the taskbar (TaskbarCreated broadcast): e.g. the taskbar tracker's rediscover. */
  onTaskbarCreated?: () => void;
  /**
   * Screen areas (px) the overlays never take the mouse over, whatever the cat does: the taskbar
   * tracker's on-screen taskbars and auto-hide reveal bands. Read on every cursor poll, so it must
   * be cheap (no OS call). A throwing source counts as the whole screen for that poll: no overlay
   * takes the mouse (an ongoing drag keeps its captured pointer).
   */
  excludedRectsPx?: () => readonly Rect[];
  /** Platform window profile (ADR 0004 §5); the Windows profile when absent. */
  profile?: OverlayProfile;
  /** DIP rect of an overlay → world px for info(); Windows' screen.dipToScreenRect when absent. */
  rectToWorld?: (win: BrowserWindow, rect: Rect) => Rect;
  /**
   * Run-time condition for having overlays at all (X11: a compositing manager runs; review H3).
   * Checked at start and with the periodic topmost check: closing destroys every overlay, opening
   * re-creates them. A throwing gate counts as closed. Absent: always open (Windows, macOS).
   */
  allowOverlays?: () => { allowed: boolean; reason: string | null };
}

/** Why main ended a press on its own (interactionStats().lostPresses). */
export type LostPressReason = 'buttonUp' | 'silent' | 'moved';

/** Press-path counters since start (diagnostics; diagnosis F8). */
export interface OverlayInteractionStats {
  /** Primary presses received from the renderers. */
  presses: number;
  /**
   * Presses main ended without their release: Win32 said "up" and the renderer stayed silent
   * (buttonUp); the renderer hung, crashed or failed to load mid-press (silent); the cursor moved
   * on with no pointer event while the button state was unknown (moved).
   */
  lostPresses: { buttonUp: number; silent: number; moved: number };
  /** Presses during which Win32 said "up" for over LOST_PRESS_MS while the renderer's latest event said held. */
  win32Disagreements: number;
  /** Presses or drags ended by a context menu. */
  contextCancels: number;
  /** Polls with the cursor on the cat that a failing exclusion source denied (EVERYWHERE). */
  failClosedPolls: number;
  /** setIgnoreMouseEvents calls. */
  ignoreToggles: number;
  /** Overlays re-created after a crash, hang, load failure, unexpected close, not-ready page or bounds drift (retries included). */
  recreates: number;
  /** Polls with the cursor on the cat denied because the renderer's region was stale or the renderer hung. */
  staleRegionDenials: number;
}

export interface OverlayManager extends SurfaceLinesSink {
  start(): void;
  render(out: SimOutput, simNow: number, hidden: boolean): void;
  /** Click-through routing for one cursor sample. */
  updateInteractivity(cursorPx: Point | null, blocked: boolean): void;
  isCursorOverCat(cursorPx: Point | null): boolean;
  readonly pressed: boolean;
  readonly dragging: boolean;
  /** Any overlay currently accepts the mouse. */
  readonly interactive: boolean;
  handleReady(webContentsId: number): void;
  handlePointer(webContentsId: number, ev: OverlayPointerEvent): void;
  handleHitRegion(webContentsId: number, region: HitRegion): void;
  handleRendererError(webContentsId: number, message: string): void;
  applySettings(next: Settings, prev: Settings | null): void;
  /** Test hook: true/false forces every overlay interactive/click-through; null restores routing. */
  forceInteractive(value: boolean | null): void;
  /**
   * After system resume or unlock: forgets the renderer clock offsets, the hover dwell and the
   * poll timing, ends any press left from before (no release can have survived it) and retries
   * displays waiting out an exhausted recreate budget.
   */
  noteResume(): void;
  interactionStats(): OverlayInteractionStats;
  info(): OverlayInfo[];
  readonly count: number;
  dispose(): void;
}

interface Entry {
  displayId: string;
  geometry: DisplayGeometry;
  win: BrowserWindow;
  wcId: number;
  ready: boolean;
  active: boolean;
  activatedAt: number;
  needSnap: boolean;
  lastState: CatRenderState | null;
  ignoreMouse: boolean;
  healthy: boolean;
  crashed: boolean;
  boundsChecked: boolean;
  hitRectsPx: Rect[] | null;
  /** Main time of the last hit-region report (renderer heartbeat while active). */
  hitAt: number;
  hitAnchor: Point | null;
  /** Renderer → main clock offset: minimum of the current and the previous bucket (null: none yet). */
  offCur: number | null;
  offPrev: number | null;
  offAt: number;
  /** Offset frozen for the press in progress, so its durations and speeds are the renderer's own. */
  pressOffset: number | null;
  pressed: boolean;
  /** Main time the press was received. */
  pressAt: number;
  /** Main time of the last poll in this press where Win32 reported the button down (pressAt at first). */
  win32DownAt: number;
  /** Win32 reported the button down on at least one poll of this press (else its "up" proves nothing). */
  win32SawDown: boolean;
  /** Main time Win32 first reported "up" since it last reported "down" in this press (null: not). */
  upSince: number | null;
  /** Win32 "up" time and renderer pointer silence counted towards a lost press (capped per poll). */
  upMs: number;
  quietMs: number;
  /** A Win32/renderer disagreement was counted for this press. */
  disagreed: boolean;
  /** The renderer reported a move with the primary button held during this press. */
  moveHeld: boolean;
  /** Main receipt time, px position, mapped (main-aligned renderer) time and buttons of the last pointer event. */
  pointerAt: number;
  pointerPx: Point | null;
  pointerT: number;
  pointerButtons: number;
  /** The latest time fed to the recogniser for this overlay: mapped times never run backwards. */
  lastFedT: number;
  /** The renderer timestamp of the last pointer event mapped (its spacing is kept on a step back). */
  lastRendererT: number;
  /** Watchdog: silence (ms) while a heartbeat was expected. */
  silentMs: number;
  /** Watchdog: time (ms) spent created but not ready. */
  unreadyMs: number;
  /** Time spent hung (silent or 'unresponsive'), null while live. */
  hungMs: number | null;
  disposing: boolean;
  nonRude: boolean;
  taskbarHooked: boolean;
  /** Surface outline segments the renderer currently shows (0 = none: an empty frame need not be sent). */
  outlineLines: number;
  /** v1.2 hover dwell: main time since which the cursor rests in this overlay's hit zone (null: not). */
  hoverSince: number | null;
}

export function createOverlayManager(opts: OverlayManagerOptions): OverlayManager {
  const log = opts.logger;
  const entries = new Map<string, Entry>();
  const byWc = new Map<number, Entry>();
  const crashHistory = new Map<string, number[]>();
  const pendingRecreate = new Map<string, ReturnType<typeof setTimeout>>();
  let seq = 0;
  let lastOutput: SimOutput | null = null;
  let lastSimNow = 0;
  let lastHidden = false;
  let forced: boolean | null = null;
  let dragging = false;
  let displayTimer: ReturnType<typeof setTimeout> | null = null;
  let topmostTimer: ReturnType<typeof setInterval> | null = null;
  let offDisplay: Unsubscribe | null = null;
  let disposed = false;
  /** allowOverlays() at the last check (ADR 0004 §5). */
  let gateOpen = true;
  let lastWatchdogAt: number | null = null;
  let lastTaskbarCreatedAt: number | null = null;
  let excludedErrors = 0;
  /**
   * v1.2 global sound dedupe (ADR 0003 §10): the `at` of the last cue sent, and the display whose
   * overlay held the anchor when it was first emitted. Each cue goes out once, to that overlay only,
   * whatever later renders (display changes, recreated overlays, a cat straddling two displays) do.
   */
  let lastSoundAt: number | null = null;
  let soundDisplayId: string | null = null;
  const topmostReasserts: number[] = [];
  /** The overlay whose events opened the recogniser's press (one recogniser, one cursor). */
  let pressOwner: Entry | null = null;
  let lastPollAt: number | null = null;
  /** Displays whose pending recreate is a retry after the crash budget ran out, and their failed rounds. */
  const exhaustedRetry = new Set<string>();
  const exhaustedRounds = new Map<string, number>();
  /** Displays that lost their overlay to a failure: the next overlay created there counts as a recreate. */
  const awaitingRecovery = new Set<string>();
  /** Polls in a row with the cursor on the cat that a failing source denied (null: none). */
  let failStreak: { since: number; polls: number; logged: boolean } | null = null;
  const logGate = new Map<string, { at: number; suppressed: number }>();
  const stats: OverlayInteractionStats = {
    presses: 0,
    lostPresses: { buttonUp: 0, silent: 0, moved: 0 },
    win32Disagreements: 0,
    contextCancels: 0,
    failClosedPolls: 0,
    ignoreToggles: 0,
    recreates: 0,
    staleRegionDenials: 0,
  };
  const profile = opts.profile ?? WIN32_OVERLAY_PROFILE;
  const shell = opts.shell ?? (profile.shellIntegration ? createOverlayShell(log.child('shell')) : NO_SHELL);
  const rectToWorld = opts.rectToWorld ?? ((win: BrowserWindow, rect: Rect): Rect => screen.dipToScreenRect(win, rect));

  function hwndOf(win: BrowserWindow): string {
    try {
      return win.getNativeWindowHandle().readBigUInt64LE(0).toString();
    } catch {
      return '0';
    }
  }

  function alive(e: Entry): boolean {
    return !e.disposing && !e.win.isDestroyed();
  }

  function send(e: Entry, channel: string, payload: unknown): void {
    if (!alive(e) || e.crashed) return;
    try {
      e.win.webContents.send(channel, payload);
    } catch (err) {
      log.warn('overlay send failed', { displayId: e.displayId, channel, error: err });
    }
  }

  /**
   * Rate limit for info lines of one kind: null while within LOG_EVERY_MS of the last line of that
   * kind (the line is then counted), else the number suppressed since.
   */
  function logSlot(key: string, now: number): number | null {
    const g = logGate.get(key);
    if (g && now - g.at < LOG_EVERY_MS) {
      g.suppressed++;
      return null;
    }
    logGate.set(key, { at: now, suppressed: 0 });
    return g?.suppressed ?? 0;
  }

  function setIgnore(e: Entry, ignore: boolean): void {
    if (e.ignoreMouse === ignore || !alive(e)) return;
    e.ignoreMouse = ignore;
    stats.ignoreToggles++;
    try {
      e.win.setIgnoreMouseEvents(ignore);
    } catch (err) {
      log.warn('setIgnoreMouseEvents failed', { displayId: e.displayId, error: err });
    }
  }

  function reassertTopmost(e: Entry, reason: string): void {
    if (!alive(e)) return;
    const now = opts.clock();
    while (topmostReasserts.length > 0 && now - (topmostReasserts[0] ?? 0) > 60_000) topmostReasserts.shift();
    if (topmostReasserts.length >= MAX_TOPMOST_REASSERTS_PER_MIN) return;
    topmostReasserts.push(now);
    log.debug('re-asserting always-on-top', { displayId: e.displayId, reason });
    e.win.setAlwaysOnTop(true, profile.topmostLevel);
  }

  function configFor(e: Entry): OverlayConfig {
    return { displayId: e.displayId, scaleFactor: e.geometry.scaleFactor, debug: opts.debugOverlay };
  }

  /** Once after creation, before the overlay has been in use. */
  function verifyBounds(e: Entry): void {
    if (e.boundsChecked || !alive(e)) return;
    e.boundsChecked = true;
    const actual = e.win.getBounds();
    const expected = e.geometry.workAreaDip;
    if (boundsDiffer(actual, expected)) {
      log.warn('overlay bounds differ after creation; correcting once', { displayId: e.displayId, actual, expected });
      e.win.setBounds({ x: Math.round(expected.x), y: Math.round(expected.y), width: Math.round(expected.width), height: Math.round(expected.height) });
      const after = e.win.getBounds();
      if (boundsDiffer(after, expected)) log.warn('overlay bounds still differ', { displayId: e.displayId, after });
    }
  }

  /**
   * A display change or resume kept the overlay (`why`): a window that drifted from its work area is
   * recreated, never moved (setBounds on a live transparent overlay grows or offsets it, see
   * displayDiff.ts), through the recreate path and within its budget. Past the budget it stays as it is.
   */
  function checkDrift(e: Entry, why: string): void {
    if (!e.boundsChecked || !alive(e) || pendingRecreate.has(e.displayId)) return;
    const actual = e.win.getBounds();
    const expected = e.geometry.workAreaDip;
    if (!boundsDiffer(actual, expected, BOUNDS_DRIFT_TOLERANCE)) return;
    const now = opts.clock();
    const b = crashBackoff(crashHistory.get(e.displayId) ?? [], now);
    if (!b.allowed) {
      const suppressed = logSlot(`drift:${e.displayId}`, now);
      if (suppressed !== null) log.warn('overlay bounds drifted; recreate budget exhausted, leaving it as it is', { displayId: e.displayId, why, actual, expected, suppressed });
      return;
    }
    crashHistory.set(e.displayId, b.recent);
    log.warn('overlay bounds drifted; recreating it', { displayId: e.displayId, why, actual, expected, delayMs: b.delayMs, attempt: b.recent.length });
    armRecreate(e.displayId, b.delayMs, false, e);
  }

  function readGate(): { allowed: boolean; reason: string | null } {
    if (!opts.allowOverlays) return { allowed: true, reason: null };
    try {
      return opts.allowOverlays();
    } catch (err) {
      return { allowed: false, reason: err instanceof Error ? err.message : String(err) };
    }
  }

  /** Re-reads the gate; withdraws or restores every overlay when it changed. */
  function applyGate(): void {
    const g = readGate();
    if (g.allowed === gateOpen) return;
    gateOpen = g.allowed;
    if (!g.allowed) {
      log.warn('overlays withdrawn', { reason: g.reason });
      for (const t of pendingRecreate.values()) clearTimeout(t);
      pendingRecreate.clear();
      exhaustedRetry.clear();
      exhaustedRounds.clear();
      awaitingRecovery.clear();
      for (const e of [...entries.values()]) destroyEntry(e);
    } else {
      log.info('overlays allowed again');
      sync(opts.display.world);
    }
  }

  function create(d: DisplayGeometry): void {
    if (disposed || !gateOpen || entries.has(d.id)) return;
    let win: BrowserWindow;
    try {
      win = createOverlayWindow({
        display: d,
        preloadPath: opts.preloadPath,
        devTools: opts.devTools,
        contentProtection: opts.getSettings().appearance.hideFromScreenCapture,
        profile,
      });
    } catch (err) {
      log.error('creating overlay failed', { displayId: d.id, error: err });
      scheduleRecreate(d.id, 'create-failed');
      return;
    }
    const e: Entry = {
      displayId: d.id,
      geometry: d,
      win,
      wcId: win.webContents.id,
      ready: false,
      active: false,
      activatedAt: 0,
      needSnap: true,
      lastState: null,
      ignoreMouse: true,
      healthy: true,
      crashed: false,
      boundsChecked: false,
      hitRectsPx: null,
      hitAt: 0,
      hitAnchor: null,
      offCur: null,
      offPrev: null,
      offAt: 0,
      pressOffset: null,
      pressed: false,
      pressAt: 0,
      win32DownAt: 0,
      win32SawDown: false,
      upSince: null,
      upMs: 0,
      quietMs: 0,
      disagreed: false,
      moveHeld: false,
      pointerAt: 0,
      pointerPx: null,
      pointerT: 0,
      pointerButtons: 0,
      lastFedT: Number.NEGATIVE_INFINITY,
      lastRendererT: Number.NEGATIVE_INFINITY,
      silentMs: 0,
      unreadyMs: 0,
      hungMs: null,
      disposing: false,
      nonRude: false,
      taskbarHooked: false,
      outlineLines: 0,
      hoverSince: null,
    };
    entries.set(d.id, e);
    byWc.set(e.wcId, e);
    opts.registry.register(win.webContents, 'overlay');
    wire(e);
    if (opts.onTaskbarCreated) e.taskbarHooked = shell.hookTaskbarCreated(win, () => taskbarCreated(e.displayId));
    win.loadURL(overlayUrl(d.id)).catch((err: unknown) => log.error('loading overlay page failed', { displayId: d.id, error: err }));
    const recovery = awaitingRecovery.delete(d.id);
    if (recovery) stats.recreates++;
    log.info('overlay created', { displayId: d.id, workAreaDip: d.workAreaDip, scaleFactor: d.scaleFactor, ...(recovery ? { recreates: stats.recreates } : {}) });
  }

  function wire(e: Entry): void {
    const { win } = e;
    const wc = win.webContents;
    win.once('ready-to-show', () => {
      if (!alive(e)) return;
      // Right before showing: a full-monitor topmost overlay must not count as a fullscreen app.
      e.nonRude = shell.beforeShow(win, e.displayId);
      win.showInactive();
      verifyBounds(e);
    });
    win.on('always-on-top-changed', (_ev, isOnTop) => {
      if (!isOnTop) reassertTopmost(e, 'always-on-top-changed');
    });
    if (profile.sessionEndEvents) {
      win.on('query-session-end', () => opts.onSessionEnd());
      win.on('session-end', () => opts.onSessionEnd());
    }
    // Closed from outside (WM_CLOSE from another process): 'closed' only fires once the window is
    // gone, so the property is removed here, before Electron destroys it. Our own paths go through
    // destroyEntry, which calls destroy() and never emits 'close'.
    win.on('close', () => {
      if (!e.nonRude || win.isDestroyed()) return;
      shell.beforeDestroy(win, e.displayId);
      e.nonRude = false;
    });
    win.on('closed', () => {
      byWc.delete(e.wcId);
      if (entries.get(e.displayId) === e) entries.delete(e.displayId);
      if (!e.disposing && !disposed) {
        log.warn('overlay closed unexpectedly', { displayId: e.displayId });
        scheduleRecreate(e.displayId, 'closed');
      }
    });
    wc.on('unresponsive', () => markHung(e, 'unresponsive'));
    wc.on('responsive', () => noteAlive(e));
    wc.on('render-process-gone', (_ev, details) => {
      log.error('overlay renderer gone', { displayId: e.displayId, reason: details.reason, exitCode: details.exitCode });
      e.crashed = true;
      e.healthy = false;
      setIgnore(e, true);
      destroyEntry(e, 'silent');
      scheduleRecreate(e.displayId, details.reason);
    });
    wc.on('did-fail-load', (_ev, code, description, _url, isMainFrame) => {
      if (!isMainFrame || !alive(e) || e.crashed) return;
      // The page never runs: no heartbeat is expected from it, so nothing else would ever recover it.
      log.error('overlay page failed to load; recreating it', { displayId: e.displayId, code, description });
      e.healthy = false;
      e.crashed = true;
      setIgnore(e, true);
      if (ownsPress(e)) endPress(e, 'cancel', 'silent');
      scheduleRecreate(e.displayId, 'load-failed');
      // Destroyed outside the webContents event that reported it.
      setTimeout(() => {
        if (alive(e)) destroyEntry(e);
      }, 0);
    });
    wc.on('console-message', (details) => {
      if (details.level === 'error') log.warn('overlay console error', { displayId: e.displayId, message: details.message });
    });
  }

  /** `lost`: the overlay is destroyed because its renderer failed (a press it held counts as lost). */
  function destroyEntry(e: Entry, lost?: LostPressReason): void {
    if (ownsPress(e)) endPress(e, 'cancel', lost);
    e.disposing = true;
    byWc.delete(e.wcId);
    if (entries.get(e.displayId) === e) entries.delete(e.displayId);
    opts.registry.unregister(e.wcId);
    if (!e.win.isDestroyed()) {
      if (e.nonRude) {
        shell.beforeDestroy(e.win, e.displayId);
        e.nonRude = false;
      }
      try {
        e.win.destroy();
      } catch (err) {
        log.warn('destroying overlay failed', { displayId: e.displayId, error: err });
      }
    }
  }

  /** TaskbarCreated reaches every overlay; one notification per broadcast. Runs inside the window procedure: keep it cheap. */
  function taskbarCreated(displayId: string): void {
    const now = opts.clock();
    if (lastTaskbarCreatedAt !== null && now - lastTaskbarCreatedAt < TASKBAR_CREATED_DEDUPE_MS) return;
    lastTaskbarCreatedAt = now;
    log.info('taskbar re-created by the shell (TaskbarCreated)', { displayId });
    try {
      opts.onTaskbarCreated?.();
    } catch (err) {
      log.error('TaskbarCreated handler failed', { error: err });
    }
  }

  /** Renderer is processing messages: clears a hang. */
  function noteAlive(e: Entry): void {
    e.silentMs = 0;
    if (e.hungMs === null) return;
    e.hungMs = null;
    const suppressed = logSlot(`alive:${e.displayId}`, opts.clock());
    if (suppressed !== null) log.info('overlay renderer responsive again', { displayId: e.displayId, suppressed });
  }

  /** Hung renderer: click-through at once and end its press (the drag with it); recreated after a grace period. */
  function markHung(e: Entry, reason: string): void {
    if (e.hungMs !== null || !alive(e)) return;
    const suppressed = logSlot(`hung:${e.displayId}`, opts.clock());
    if (suppressed !== null) log.warn('overlay renderer hung; forcing click-through', { displayId: e.displayId, reason, pressed: e.pressed, suppressed });
    e.hungMs = 0;
    if (ownsPress(e)) endPress(e, 'cancel', 'silent');
    setIgnore(e, true);
  }

  function live(e: Entry): boolean {
    return e.healthy && e.hungMs === null && !e.crashed && e.ready;
  }

  /** A ready overlay that main shows the cat on must send its heartbeat. */
  function expectsHeartbeat(e: Entry): boolean {
    return e.ready && e.active && !e.crashed && e.lastState !== null && e.lastState.visible;
  }

  function watchdog(now: number): void {
    const step = lastWatchdogAt === null ? 0 : Math.min(WATCHDOG_MAX_STEP_MS, Math.max(0, now - lastWatchdogAt));
    lastWatchdogAt = now;
    for (const e of [...entries.values()]) {
      if (!alive(e) || e.crashed) continue;
      if (!e.ready) {
        e.unreadyMs += step;
        if (e.unreadyMs > READY_TIMEOUT_MS) {
          log.error('overlay page never became ready; recreating it', { displayId: e.displayId });
          e.crashed = true;
          destroyEntry(e);
          scheduleRecreate(e.displayId, 'not-ready');
        }
        continue;
      }
      if (e.hungMs !== null) {
        e.hungMs += step;
        if (e.hungMs > HANG_RECREATE_MS) {
          log.error('overlay renderer did not recover; recreating it', { displayId: e.displayId });
          e.crashed = true;
          destroyEntry(e);
          scheduleRecreate(e.displayId, 'hung');
        }
        continue;
      }
      e.silentMs = expectsHeartbeat(e) ? e.silentMs + step : 0;
      if (e.silentMs > (e.pressed ? HANG_SILENCE_MS : HANG_IDLE_SILENCE_MS)) markHung(e, 'no heartbeat');
    }
  }

  function scheduleRecreate(displayId: string, reason: string): void {
    if (disposed || pendingRecreate.has(displayId)) return;
    awaitingRecovery.add(displayId);
    const b = crashBackoff(crashHistory.get(displayId) ?? [], opts.clock());
    if (!b.allowed) {
      // Never for good: a display without its overlay is retried later (and at once on resume,
      // unlock or a display change), with the delay doubling per failed round.
      const rounds = exhaustedRounds.get(displayId) ?? 0;
      const delayMs = Math.min(EXHAUSTED_RETRY_MAX_MS, EXHAUSTED_RETRY_MS * 2 ** rounds);
      exhaustedRounds.set(displayId, rounds + 1);
      log.error('overlay recreate budget exhausted; retrying later', { displayId, reason, retryInMs: delayMs, round: rounds + 1 });
      armRecreate(displayId, delayMs, true);
      return;
    }
    crashHistory.set(displayId, b.recent);
    log.warn('recreating overlay', { displayId, reason, delayMs: b.delayMs, attempt: b.recent.length });
    armRecreate(displayId, b.delayMs, false);
  }

  /** `replace`: a live overlay to swap for the new one when the timer fires (bounds drift), if it is still the display's. */
  function armRecreate(displayId: string, delayMs: number, exhausted: boolean, replace: Entry | null = null): void {
    const t = setTimeout(() => {
      pendingRecreate.delete(displayId);
      exhaustedRetry.delete(displayId);
      if (replace !== null && entries.get(displayId) === replace) {
        awaitingRecovery.add(displayId);
        destroyEntry(replace);
      }
      const d = opts.display.world.displays.find((x) => x.id === displayId);
      if (d && !entries.has(displayId)) create(d);
    }, delayMs);
    pendingRecreate.set(displayId, t);
    if (exhausted) exhaustedRetry.add(displayId);
  }

  /** Drops the wait of displays retrying after an exhausted budget; the caller's sync() creates them. */
  function rearmExhausted(reason: string): void {
    for (const id of exhaustedRetry) {
      const t = pendingRecreate.get(id);
      if (t) clearTimeout(t);
      pendingRecreate.delete(id);
      exhaustedRounds.delete(id);
      log.info('retrying overlay after an exhausted recreate budget', { displayId: id, reason });
    }
    exhaustedRetry.clear();
  }

  function sync(world: WorldGeometry): void {
    if (disposed) return;
    const existing = new Map<string, DisplayGeometry>();
    for (const [id, e] of entries) existing.set(id, e.geometry);
    const plan = planOverlaySync(existing, world.displays);
    for (const id of plan.remove) {
      const e = entries.get(id);
      if (e) {
        log.info('display removed; destroying overlay', { displayId: id });
        destroyEntry(e);
      }
      const t = pendingRecreate.get(id);
      if (t) clearTimeout(t);
      pendingRecreate.delete(id);
      exhaustedRetry.delete(id);
      exhaustedRounds.delete(id);
      awaitingRecovery.delete(id);
    }
    for (const d of plan.recreate) {
      const e = entries.get(d.id);
      if (e) {
        log.info('display geometry changed; recreating overlay', { displayId: d.id });
        destroyEntry(e);
      }
      create(d);
    }
    for (const d of plan.keep) {
      const e = entries.get(d.id);
      if (!e) continue;
      e.geometry = d;
      // Same geometry, but Windows may have moved or resized the window itself (DPI, layout).
      checkDrift(e, 'display-change');
      reassertTopmost(e, 'display-change');
    }
    for (const d of plan.create) {
      // A crashed overlay waiting out its backoff is recreated by its timer.
      if (!pendingRecreate.has(d.id)) create(d);
    }
    if (lastOutput) render(lastOutput, lastSimNow, lastHidden);
  }

  function render(out: SimOutput, simNow: number, hidden: boolean): void {
    lastOutput = out;
    lastSimNow = simNow;
    lastHidden = hidden;
    const settingsNow = opts.getSettings();
    const appearance = settingsNow.appearance;
    const movementSpeed = settingsNow.behavior.movementSpeed;
    const world = opts.display.world;
    const showing = displaysShowingCat(out, world.displays, appearance, hidden);
    const now = opts.clock();
    // A cue is new on its first emission only (by `at`): it then belongs to the overlay holding the
    // anchor and is never sent again, also when the same output is rendered again.
    const cue = out.sound ?? null;
    const newCue = cue !== null && Number.isFinite(cue.at) && cue.at !== lastSoundAt;
    if (newCue) {
      lastSoundAt = cue.at;
      soundDisplayId = out.displayId;
    }
    for (const e of entries.values()) {
      if (!alive(e)) continue;
      // The overlay that took the press keeps the pointer captured for the whole drag,
      // also after the cat crossed onto another display: it stays active (and
      // interactive) so it still delivers the moves and the release.
      const holdsPress = e.pressed && e.active && out.visible && !hidden;
      if (showing.has(e.displayId) || holdsPress) {
        const geo = world.displays.find((d) => d.id === e.displayId) ?? e.geometry;
        const forceSnap = !e.active || e.needSnap;
        const state = mapRenderState(out, appearance, {
          seq: ++seq,
          toLocalDip: (p) => opts.display.toLocalDip(e.displayId, p),
          scaleFactor: geo.scaleFactor,
          forceSnap,
          hidden,
          simNow,
          movementSpeed,
          // v1.2: a sound cue goes once, to the one overlay that held the anchor when it was first
          // emitted (global dedupe), only while sound is on and that overlay can receive it now.
          soundOwner: settingsNow.sound.enabled && newCue && e.displayId === soundDisplayId && e.ready && !e.crashed,
          soundVolume: settingsNow.sound.volume,
        });
        if (!e.active) {
          e.active = true;
          e.activatedAt = now;
          e.hitRectsPx = null;
        }
        // Never kept for a re-send (ready, recreate): a cue is played once.
        e.lastState = state.sound ? { ...state, sound: null } : state;
        if (e.ready) {
          send(e, IPC.overlayRender, state);
          e.needSnap = false;
        }
      } else if (e.active) {
        e.active = false;
        e.hitRectsPx = null;
        if (ownsPress(e)) endPress(e, 'cancel');
        if (e.lastState) {
          const final = hiddenRenderState(e.lastState, ++seq, simNow);
          e.lastState = final;
          if (e.ready) send(e, IPC.overlayRender, final);
        }
        e.needSnap = true;
        setIgnore(e, true);
      }
    }
  }

  /**
   * The cat's hit area on this overlay: the renderer-reported region while it is
   * trustworthy, else the simulation's approximate bounds (which are always current).
   * The age is the time since the renderer last reported (its heartbeat re-reports an
   * unchanged region), or since activation before its first report, so a renderer that
   * went silent ages out of interactivity in decideInteractive.
   */
  function effectiveRegions(e: Entry, now: number): { rects: Rect[]; ageMs: number } {
    const out = lastOutput;
    if (!e.active || !out || !out.visible || lastHidden) return { rects: [], ageMs: Infinity };
    const reported = e.hitRectsPx !== null && e.hitAt >= e.activatedAt;
    const ageMs = Math.max(0, now - (reported ? e.hitAt : e.activatedAt));
    if (reported && e.hitRectsPx) {
      const moved = e.hitAnchor ? distance(e.hitAnchor, { x: out.x, y: out.y }) : Infinity;
      // The renderer reports changes at a limited rate, so the region of a cat that has not moved since is still current.
      if (moved <= HIT_REGION_MOVE_TOLERANCE_PX || ageMs <= HIT_REGION_FRESH_MS) return { rects: e.hitRectsPx, ageMs };
    }
    return { rects: [out.boundsPx], ageMs };
  }

  /** The recogniser holds a press or drag. */
  function recognizerBusy(): boolean {
    return opts.gestures.dragging || opts.gestures.pressed === true;
  }

  /** `e` holds the press in progress: its own flag, the recogniser's press it opened, or a recogniser press nobody holds. */
  function ownsPress(e: Entry): boolean {
    return e.pressed || pressOwner === e || (pressOwner === null && recognizerBusy());
  }

  /**
   * Ends the press `e` holds, in the recogniser too, so no stale press or drag outlives it.
   * 'release' (a lost release): an 'up' at the renderer's last sample, stamped when Win32 first
   * saw the button up if that came after the sample and Win32 had seen this press down (a throw
   * keeps its speed, a lost tap stays a tap), else now (no speed). 'cancel' (context menu, hang,
   * crash, hidden cat, resume): no throw. Both use the renderer's time base, never earlier than
   * what this overlay fed before, so a late real 'up' is a harmless no-op.
   */
  function endPress(e: Entry, mode: 'release' | 'cancel', lost?: LostPressReason): void {
    const wasPressed = e.pressed;
    e.pressed = false;
    e.pressOffset = null;
    if (pressOwner !== null && pressOwner !== e) return;
    pressOwner = null;
    if (lost && wasPressed) stats.lostPresses[lost]++;
    const now = opts.clock();
    const at = e.pointerPx ?? (lastOutput ? { x: lastOutput.x, y: lastOutput.y } : { x: 0, y: 0 });
    let ev: GesturePointerEvent;
    if (mode === 'release' && e.pointerPx) {
      const t = e.win32SawDown && e.upSince !== null && e.upSince >= e.pointerT ? e.upSince : Math.max(e.pointerT, now);
      ev = { kind: 'up', x: at.x, y: at.y, button: 0, buttons: 0, t: Math.max(t, e.lastFedT) };
    } else {
      ev = { kind: 'cancel', x: at.x, y: at.y, button: 0, buttons: 0, t: Math.max(e.pointerPx ? e.pointerT : now, e.lastFedT) };
    }
    e.lastFedT = ev.t;
    const events = opts.gestures.feed(ev);
    if (dragging && !events.some((x) => x.type === 'pointer.dragEnd')) events.push({ type: 'pointer.dragEnd', at, velocity: { x: 0, y: 0 } });
    deliver(events);
  }

  function deliver(events: SimEvent[]): void {
    if (events.length === 0) return;
    for (const ev of events) {
      if (ev.type === 'pointer.dragStart') dragging = true;
      else if (ev.type === 'pointer.dragEnd') dragging = false;
    }
    opts.onSimEvents(events);
  }

  /**
   * Why the press on `e` is over although no release arrived; null while it is not. Win32 never
   * overrides a renderer that is still talking: "up" only counts once the renderer has been silent
   * as long (diagnosis H1), and only for a press Win32 saw down at least once: one it never saw
   * (GetAsyncKeyState reading 0 throughout, H1a) has an unknown button state. Both clocks advance by
   * at most PRESS_STEP_MAX_MS per poll.
   */
  function pressLost(e: Entry, buttonDown: boolean | null, cursorPx: Point | null, now: number, step: number): LostPressReason | null {
    e.quietMs = Math.min(e.quietMs + step, Math.max(0, now - e.pointerAt));
    if (buttonDown === true) {
      e.win32DownAt = now;
      e.win32SawDown = true;
      e.upSince = null;
      e.upMs = 0;
      return null;
    }
    if (buttonDown === false) {
      e.upSince ??= now;
      e.upMs = Math.min(e.upMs + step, Math.max(0, now - Math.max(e.pressAt, e.win32DownAt)));
      if ((e.pointerButtons & PRIMARY_MASK) !== 0 && !e.disagreed && e.upMs > LOST_PRESS_MS) {
        // The v1.2 heuristic would have ended this press here, whatever the renderer said.
        e.disagreed = true;
        stats.win32Disagreements++;
        const suppressed = logSlot('disagree', now);
        if (suppressed !== null) log.info('Win32 reports the button up while the renderer reports it held', { displayId: e.displayId, quietMs: e.quietMs, upMs: e.upMs, win32SawDown: e.win32SawDown, suppressed });
      }
      if (e.win32SawDown) {
        const bound = e.moveHeld ? LOST_PRESS_HELD_MS : LOST_PRESS_MS;
        return e.upMs > bound && e.quietMs > bound ? 'buttonUp' : null;
      }
      // Never seen down in this press: its "up" proves nothing; the movement rule below decides.
    }
    // Button state unknown (no Win32, the read failed, or never seen down): a captured press reports
    // every movement, so a cursor that moved on unreported means the release was lost.
    if (!cursorPx || !e.pointerPx || e.quietMs <= LOST_PRESS_MS) return null;
    return distance(cursorPx, e.pointerPx) > LOST_PRESS_MOVE_DIP * e.geometry.scaleFactor ? 'moved' : null;
  }

  function noteLostPress(e: Entry, reason: LostPressReason, now: number): void {
    const suppressed = logSlot('lost', now);
    if (suppressed === null) return;
    log.info('pointer press lost; ending it', {
      displayId: e.displayId,
      reason,
      dragging,
      quietMs: e.quietMs,
      upMs: e.upMs,
      heldAtLastEvent: (e.pointerButtons & PRIMARY_MASK) !== 0,
      lostPresses: { ...stats.lostPresses, [reason]: stats.lostPresses[reason] + 1 },
      suppressed,
    });
  }

  /** A poll with the cursor on the cat that a failing source denied: counted, and a long run reported once. */
  function noteFailClosed(now: number): void {
    stats.failClosedPolls++;
    failStreak ??= { since: now, polls: 0, logged: false };
    failStreak.polls++;
    if (failStreak.logged || now - failStreak.since < FAIL_CLOSED_STREAK_LOG_MS) return;
    const suppressed = logSlot('failClosed', now);
    if (suppressed === null) return;
    failStreak.logged = true;
    log.info('click-through exclusions failing closed with the cursor on the cat', { forMs: now - failStreak.since, polls: failStreak.polls, total: stats.failClosedPolls, suppressed });
  }

  function endFailStreak(now: number): void {
    if (failStreak?.logged) log.info('click-through exclusions answering again', { afterMs: now - failStreak.since, polls: failStreak.polls });
    failStreak = null;
  }

  /** Screen areas no overlay takes the mouse over (taskbars); all of it when the source failed. */
  function excludedRects(): readonly Rect[] {
    if (!opts.excludedRectsPx) return NO_RECTS;
    try {
      return opts.excludedRectsPx();
    } catch (err) {
      excludedErrors++;
      if (excludedErrors <= 3 || excludedErrors % 1000 === 0) log.warn('click-through exclusions failed; staying click-through', { error: err, count: excludedErrors });
      return EVERYWHERE;
    }
  }

  function updateInteractivity(cursorPx: Point | null, blocked: boolean): void {
    const now = opts.clock();
    const step = lastPollAt === null ? 0 : Math.min(PRESS_STEP_MAX_MS, Math.max(0, now - lastPollAt));
    lastPollAt = now;
    watchdog(now);
    const buttonDown = opts.isLeftButtonDown();
    // Asked once, and only with the cursor on a hit region of an overlay that may take the mouse:
    // anywhere else it cannot change the decision, and the host's guard would read the windows for it.
    let excluded: readonly Rect[] | null = null;
    let failedClosed = false;
    // v1.2: clinging to a screen edge, the cat takes the mouse only after the hover dwell.
    const support = lastOutput?.support;
    const clinging = support?.kind === 'surface' && support.surfaceKind === SCREEN_EDGE_KIND;
    for (const e of entries.values()) {
      if (!alive(e)) continue;
      if (e.pressed) {
        const lost = pressLost(e, buttonDown, cursorPx, now, step);
        if (lost) {
          noteLostPress(e, lost, now);
          endPress(e, 'release', lost);
        }
      }
      let interactive: boolean;
      if (forced !== null) interactive = forced;
      else {
        const region = effectiveRegions(e, now);
        const zone = { cursor: cursorPx, hitRects: region.rects, interactive: !e.ignoreMouse };
        const onCat = !blocked && cursorInHitZone(zone);
        const excludeRects = onCat ? (excluded ??= excludedRects()) : NO_RECTS;
        // A failing source (EVERYWHERE) denies the poll but says nothing about the cursor.
        const failClosed = excludeRects === EVERYWHERE;
        const input = {
          ...zone,
          excludeRects,
          interactionsEnabled: !blocked,
          visible: e.active,
          rendererHealthy: live(e),
          // A press keeps the captured pointer (interactive everywhere) unless Win32 has said "up"
          // AND the renderer has been silent for longer than LOST_PRESS_MS: then it may be a lost
          // release, and the overlay takes the mouse over the cat alone until the press is resolved
          // (T8). A renderer still reporting moves proves the button held and the capture live, so a
          // drag whose cursor runs ahead of the cat's (lagging) hit region is never toggled.
          dragging: e.pressed && !(buttonDown === false && e.upMs > LOST_PRESS_MS && e.quietMs > LOST_PRESS_MS),
          hitRegionAgeMs: region.ageMs,
        };
        // The dwell clock runs while the cursor rests in the (clipped) hit zone; leaving it restarts
        // it. A fail-closed poll keeps it running: the cursor did not leave (diagnosis H2).
        if (clinging && onCat && (failClosed || cursorInHitZone(input))) e.hoverSince ??= now;
        else e.hoverSince = null;
        interactive = decideInteractive({
          ...input,
          hoverDwellMs: clinging ? CLING_HOVER_DWELL_MS : 0,
          ...(e.hoverSince !== null ? { hoveredMs: now - e.hoverSince } : {}),
        });
        if (!interactive && onCat && e.active && !e.pressed) {
          if (failClosed) {
            failedClosed = true;
            noteFailClosed(now);
          } else if (region.ageMs > DEFAULT_CLICK_THROUGH.maxRegionAgeMs || e.hungMs !== null) stats.staleRegionDenials++;
        }
      }
      setIgnore(e, !interactive);
    }
    if (!failedClosed && failStreak) endFailStreak(now);
  }

  function toPx(e: Entry, x: number, y: number): Point {
    return opts.display.fromLocalDip(e.displayId, { x, y });
  }

  /**
   * Maps a renderer timestamp (performance.now() time base) onto the main clock. The offset is the
   * least-latency observation of a sliding window (one to two OFFSET_BUCKET_MS buckets), not of the
   * renderer's lifetime, so an outlier or a clock step is forgotten; a press keeps the offset it
   * started with. The result never runs backwards per overlay (like the web router's lastFedT): a
   * low-latency event after renderer jank lowers the estimate, and the recogniser would otherwise
   * forget its last tap and stroke on the step back (gestures.ts).
   */
  function mainTime(e: Entry, t: number, now: number): number {
    const offset = now - t;
    if (e.offCur === null || now - e.offAt >= OFFSET_BUCKET_MS) {
      e.offPrev = e.offCur !== null && now - e.offAt < 2 * OFFSET_BUCKET_MS ? e.offCur : null;
      e.offCur = offset;
      e.offAt = now;
    } else if (offset < e.offCur) e.offCur = offset;
    const estimate = e.offPrev === null ? e.offCur : Math.min(e.offCur, e.offPrev);
    const raw = Math.min(now, t + (e.pressed && e.pressOffset !== null ? e.pressOffset : estimate));
    // At least the renderer's own spacing from the previous event (up to RENDERER_SPACING_MAX_MS) and
    // never past now. With a steady estimate that is the raw mapping itself; when the estimate drops
    // it keeps the order and the gesture timings, and the correction fades over any pause instead of
    // persisting (events a second or more apart never collapse onto one time).
    const mapped = Math.min(now, Math.max(raw, e.lastFedT + Math.min(RENDERER_SPACING_MAX_MS, Math.max(0, t - e.lastRendererT))));
    e.lastFedT = mapped;
    e.lastRendererT = t;
    return mapped;
  }

  function offsetEstimate(e: Entry): number | null {
    if (e.offCur === null) return null;
    return e.offPrev === null ? e.offCur : Math.min(e.offCur, e.offPrev);
  }

  return {
    start() {
      // G5: a platform that cannot guarantee click-through gets no overlay at all.
      if (!profile.create) {
        log.warn('overlays are not created on this platform', { reason: profile.reason });
        return;
      }
      const g = readGate();
      gateOpen = g.allowed;
      if (!gateOpen) log.warn('overlays withheld', { reason: g.reason });
      for (const d of opts.display.world.displays) create(d);
      offDisplay = opts.display.onChange((world) => {
        if (displayTimer) clearTimeout(displayTimer);
        displayTimer = setTimeout(() => {
          displayTimer = null;
          // A new display layout may well fix what exhausted the budget: retry now.
          rearmExhausted('display-change');
          sync(world);
        }, DISPLAY_DEBOUNCE_MS);
      });
      topmostTimer = setInterval(() => {
        if (opts.allowOverlays) applyGate();
        for (const e of entries.values()) {
          if (alive(e) && !e.win.isAlwaysOnTop()) reassertTopmost(e, 'periodic');
        }
      }, TOPMOST_CHECK_MS);
    },
    render,
    updateInteractivity,
    isCursorOverCat(cursorPx) {
      if (!cursorPx) return false;
      const now = opts.clock();
      // Over a taskbar the pointer belongs to the taskbar, not to the cat's paws drawn over it.
      let excluded: readonly Rect[] | null = null;
      for (const e of entries.values()) {
        const zone = { cursor: cursorPx, hitRects: effectiveRegions(e, now).rects, interactive: false };
        if (cursorInHitZone(zone) && cursorInHitZone({ ...zone, excludeRects: (excluded ??= excludedRects()) })) return true;
      }
      return false;
    },
    get pressed() {
      for (const e of entries.values()) if (e.pressed) return true;
      return false;
    },
    get dragging() {
      return dragging;
    },
    get interactive() {
      for (const e of entries.values()) if (!e.ignoreMouse) return true;
      return false;
    },
    handleReady(wcId) {
      const e = byWc.get(wcId);
      if (!e || !alive(e)) return;
      e.ready = true;
      e.healthy = true;
      noteAlive(e);
      send(e, IPC.overlayConfig, configFor(e));
      if (e.active && e.lastState) {
        send(e, IPC.overlayRender, { ...e.lastState, seq: ++seq, snap: true });
        e.needSnap = false;
      }
      log.debug('overlay ready', { displayId: e.displayId });
    },
    handlePointer(wcId, ev) {
      const e = byWc.get(wcId);
      if (!e || !alive(e)) return;
      // Input queued while the renderer was hung is stale: it only proves the renderer is back.
      const wasHung = e.hungMs !== null;
      noteAlive(e);
      if (wasHung || !e.healthy) return;
      const now = opts.clock();
      const p = toPx(e, ev.x, ev.y);
      const primary = ev.button === 0;
      // A new press is mapped with the current estimate, never with an earlier press's offset.
      if (ev.kind === 'down' && primary) e.pressOffset = null;
      const t = mainTime(e, ev.t, now);
      e.pointerAt = now;
      e.pointerPx = p;
      e.pointerT = t;
      e.pointerButtons = ev.buttons;
      e.quietMs = 0;
      if (ev.kind === 'context') {
        // The menu's modal loop swallows the primary release: end the press and any drag first, in
        // the recogniser too (before v1.3 a drag survived the menu and ate the next click).
        if (ownsPress(e)) {
          stats.contextCancels++;
          endPress(e, 'cancel');
        }
        try {
          opts.onContextMenu(e.win);
        } catch (err) {
          log.error('context menu failed', { error: err });
        }
        return;
      }
      if (ev.kind === 'down' && primary) {
        e.pressed = true;
        e.pressAt = now;
        e.win32DownAt = now;
        e.win32SawDown = false;
        e.upSince = null;
        e.upMs = 0;
        e.disagreed = false;
        e.moveHeld = false;
        e.pressOffset = offsetEstimate(e);
        stats.presses++;
      } else if (ev.kind === 'move' && (ev.buttons & PRIMARY_MASK) !== 0) {
        // A held move: the drag under way (the 'down' always carries the button, so it proves nothing).
        if (e.pressed) e.moveHeld = true;
      } else if ((ev.kind === 'up' && primary) || ev.kind === 'cancel' || (ev.kind === 'move' && (ev.buttons & PRIMARY_MASK) === 0)) {
        // Released, cancelled, or a move without the primary button (the release itself was lost).
        // Another button's release ends nothing: the primary press goes on.
        e.pressed = false;
        e.pressOffset = null;
      }
      const events = opts.gestures.feed({ kind: ev.kind, x: p.x, y: p.y, button: ev.button, buttons: ev.buttons, t });
      if (ev.kind === 'down' && primary && recognizerBusy()) pressOwner = e;
      else if (pressOwner === e && !recognizerBusy()) pressOwner = null;
      deliver(events);
    },
    handleHitRegion(wcId, region) {
      const e = byWc.get(wcId);
      if (!e || !alive(e)) return;
      noteAlive(e);
      if (!e.active) return;
      const rects: Rect[] = [];
      for (const r of region.rects) {
        if (r.width <= 0 || r.height <= 0) continue;
        const a = toPx(e, r.x, r.y);
        const b = toPx(e, r.x + r.width, r.y + r.height);
        rects.push({ x: Math.min(a.x, b.x), y: Math.min(a.y, b.y), width: Math.abs(b.x - a.x), height: Math.abs(b.y - a.y) });
      }
      e.hitRectsPx = rects;
      e.hitAt = opts.clock();
      e.hitAnchor = lastOutput ? { x: lastOutput.x, y: lastOutput.y } : null;
    },
    renderSurfaceLines(lines, quietDisplayIds = []) {
      const world = opts.display.world;
      // Hiding the cat (shortcut, tray) or the sim taking it out of sight clears the screen: the
      // outlines go too (one clearing frame, then nothing) and come back when the cat does.
      const outOfSight = lastHidden || lastOutput?.visible === false;
      for (const e of entries.values()) {
        if (!alive(e) || !e.ready) continue;
        const geo = world.displays.find((d) => d.id === e.displayId) ?? e.geometry;
        // Nothing is drawn over a fullscreen app either (quietDisplayIds).
        const quiet = outOfSight || quietDisplayIds.includes(e.displayId);
        // The cat's render state uses this same mapping (render() above).
        const local = quiet ? [] : surfaceLinesForDisplay(lines, geo.workAreaPx, (p) => opts.display.toLocalDip(e.displayId, p));
        if (local.length === 0 && e.outlineLines === 0) continue;
        const payload: SurfaceLinesPayload = { lines: local };
        send(e, IPC.overlaySurfaceLines, payload);
        e.outlineLines = local.length;
      }
    },
    clearSurfaceLines() {
      for (const e of entries.values()) {
        if (!alive(e) || e.outlineLines === 0) continue;
        const payload: SurfaceLinesPayload = { lines: [] };
        send(e, IPC.overlaySurfaceLines, payload);
        e.outlineLines = 0;
      }
    },
    handleRendererError(wcId, message) {
      const e = byWc.get(wcId);
      log.warn('overlay renderer reported an error', { displayId: e?.displayId ?? null, message });
    },
    applySettings(next, prev) {
      if (prev && prev.appearance.hideFromScreenCapture === next.appearance.hideFromScreenCapture) return;
      for (const e of entries.values()) {
        if (alive(e)) e.win.setContentProtection(next.appearance.hideFromScreenCapture);
      }
    },
    forceInteractive(value) {
      forced = value;
    },
    noteResume() {
      if (disposed) return;
      // Poll and watchdog timing restart: the time asleep or locked counts against nothing.
      lastPollAt = null;
      lastWatchdogAt = null;
      let endedPress = false;
      for (const e of [...entries.values()]) {
        e.offCur = null;
        e.offPrev = null;
        e.pressOffset = null;
        e.hoverSince = null;
        e.silentMs = 0;
        if (alive(e) && ownsPress(e)) {
          endedPress = true;
          endPress(e, 'cancel');
        }
        checkDrift(e, 'resume');
      }
      // A press or drag no live overlay holds any more.
      if (recognizerBusy() || dragging) {
        endedPress = true;
        const owner = pressOwner;
        pressOwner = null;
        const at = owner?.pointerPx ?? (lastOutput ? { x: lastOutput.x, y: lastOutput.y } : { x: 0, y: 0 });
        const t = owner?.pointerPx ? Math.max(owner.pointerT, owner.lastFedT) : opts.clock();
        if (owner) owner.lastFedT = t;
        const events = opts.gestures.feed({ kind: 'cancel', x: at.x, y: at.y, button: 0, buttons: 0, t });
        if (dragging && !events.some((x) => x.type === 'pointer.dragEnd')) events.push({ type: 'pointer.dragEnd', at, velocity: { x: 0, y: 0 } });
        deliver(events);
      }
      if (failStreak) endFailStreak(opts.clock());
      const retrying = exhaustedRetry.size;
      rearmExhausted('resume');
      log.info('overlay input state reset after resume/unlock', { overlays: entries.size, endedPress, retrying });
      if (retrying > 0) sync(opts.display.world);
    },
    interactionStats() {
      return { ...stats, lostPresses: { ...stats.lostPresses } };
    },
    info() {
      const out: OverlayInfo[] = [];
      for (const e of entries.values()) {
        if (!alive(e)) continue;
        const bounds = e.win.getBounds();
        out.push({
          displayId: e.displayId,
          webContentsId: e.wcId,
          hwnd: hwndOf(e.win),
          bounds,
          boundsPx: rectToWorld(e.win, bounds),
          expectedBounds: e.geometry.workAreaDip,
          visible: e.win.isVisible(),
          ignoreMouse: e.ignoreMouse,
          focusable: e.win.isFocusable(),
          alwaysOnTop: e.win.isAlwaysOnTop(),
          backgroundColor: e.win.getBackgroundColor(),
          ready: e.ready,
          active: e.active,
          healthy: e.healthy && e.hungMs === null,
          crashes: crashHistory.get(e.displayId)?.length ?? 0,
          nonRude: e.nonRude,
          taskbarCreatedHook: e.taskbarHooked,
        });
      }
      return out;
    },
    get count() {
      return entries.size;
    },
    dispose() {
      disposed = true;
      offDisplay?.();
      offDisplay = null;
      if (displayTimer) clearTimeout(displayTimer);
      if (topmostTimer) clearInterval(topmostTimer);
      for (const t of pendingRecreate.values()) clearTimeout(t);
      pendingRecreate.clear();
      exhaustedRetry.clear();
      for (const e of [...entries.values()]) destroyEntry(e);
      entries.clear();
      byWc.clear();
    },
  };
}
