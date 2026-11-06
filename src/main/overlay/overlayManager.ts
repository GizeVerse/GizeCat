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
import { cursorInHitZone, decideInteractive, EVERYWHERE } from '../../core/interaction/clickThrough';
import { SCREEN_EDGE_KIND } from '../../shared/surfaces';
import type { GestureRecognizer } from '../../core/interaction/gestures';
import { WIN32_OVERLAY_PROFILE, type OverlayProfile } from './overlayProfile';
import { createOverlayShell, createOverlayWindow, overlayUrl, type OverlayShell } from './overlayWindow';
import { displaysShowingCat, hiddenRenderState, mapRenderState } from './renderMapping';
import { surfaceLinesForDisplay, type SurfaceLinesSink } from './surfaceLines';

const DISPLAY_DEBOUNCE_MS = 300;
const TOPMOST_CHECK_MS = 10_000;
/** Reported hit regions are trusted while fresh or while the cat has not moved since. */
const HIT_REGION_FRESH_MS = 300;
const HIT_REGION_MOVE_TOLERANCE_PX = 4;
/** A press with no physical button held for this long is considered lost. */
const LOST_PRESS_MS = 400;
/**
 * Without Win32 button state: while the button is held the pressing overlay has the
 * mouse captured and reports every movement, so a cursor that moved this far (DIP)
 * with no pointer event for LOST_PRESS_MS means the release was lost.
 */
const LOST_PRESS_MOVE_DIP = 12;
const MAX_TOPMOST_REASSERTS_PER_MIN = 6;
/**
 * Hang watchdog. A ready overlay showing the cat re-reports its hit region every
 * ~0.5 s (renderer heartbeat); this much silence means its renderer is hung: it is made
 * click-through at once (ending any press) and recreated if it stays silent or
 * unresponsive for HANG_RECREATE_MS more.
 */
const HANG_SILENCE_MS = 3000;
const HANG_RECREATE_MS = 5000;
/** Silence counted per watchdog check is capped, so main's own stalls never count against a renderer. */
const WATCHDOG_MAX_STEP_MS = 250;
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
  timeOffset: number | null;
  pressed: boolean;
  pressAt: number;
  buttonSeenAt: number;
  /** Main time and px position of the last pointer event. */
  pointerAt: number;
  pointerPx: Point | null;
  /** Watchdog: silence (ms) while a heartbeat was expected. */
  silentMs: number;
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

  function setIgnore(e: Entry, ignore: boolean): void {
    if (e.ignoreMouse === ignore || !alive(e)) return;
    e.ignoreMouse = ignore;
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
      timeOffset: null,
      pressed: false,
      pressAt: 0,
      buttonSeenAt: 0,
      pointerAt: 0,
      pointerPx: null,
      silentMs: 0,
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
    log.info('overlay created', { displayId: d.id, workAreaDip: d.workAreaDip, scaleFactor: d.scaleFactor });
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
      destroyEntry(e);
      scheduleRecreate(e.displayId, details.reason);
    });
    wc.on('did-fail-load', (_ev, code, description, _url, isMainFrame) => {
      if (!isMainFrame) return;
      log.error('overlay page failed to load', { displayId: e.displayId, code, description });
      e.healthy = false;
      setIgnore(e, true);
    });
    wc.on('console-message', (details) => {
      if (details.level === 'error') log.warn('overlay console error', { displayId: e.displayId, message: details.message });
    });
  }

  function destroyEntry(e: Entry): void {
    e.disposing = true;
    byWc.delete(e.wcId);
    if (entries.get(e.displayId) === e) entries.delete(e.displayId);
    opts.registry.unregister(e.wcId);
    if (e.pressed) endLostPress(e);
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
    log.info('overlay renderer responsive again', { displayId: e.displayId });
  }

  /** Hung renderer: click-through at once and end its press (the drag with it); recreated after a grace period. */
  function markHung(e: Entry, reason: string): void {
    if (e.hungMs !== null || !alive(e)) return;
    log.warn('overlay renderer hung; forcing click-through', { displayId: e.displayId, reason });
    e.hungMs = 0;
    if (e.pressed) endLostPress(e);
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
      if (!alive(e)) continue;
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
      if (e.silentMs > HANG_SILENCE_MS) markHung(e, 'no heartbeat');
    }
  }

  function scheduleRecreate(displayId: string, reason: string): void {
    if (disposed || pendingRecreate.has(displayId)) return;
    const b = crashBackoff(crashHistory.get(displayId) ?? [], opts.clock());
    if (!b.allowed) {
      log.error('overlay recreate budget exhausted; leaving display without an overlay', { displayId, reason });
      return;
    }
    crashHistory.set(displayId, b.recent);
    log.warn('recreating overlay', { displayId, reason, delayMs: b.delayMs, attempt: b.recent.length });
    const t = setTimeout(() => {
      pendingRecreate.delete(displayId);
      const d = opts.display.world.displays.find((x) => x.id === displayId);
      if (d && !entries.has(displayId)) create(d);
    }, b.delayMs);
    pendingRecreate.set(displayId, t);
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
        if (e.pressed) endLostPress(e);
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

  function endLostPress(e: Entry): void {
    e.pressed = false;
    const at = lastOutput ? { x: lastOutput.x, y: lastOutput.y } : { x: 0, y: 0 };
    const events = opts.gestures.feed({ kind: 'cancel', x: at.x, y: at.y, button: 0, buttons: 0, t: opts.clock() });
    if (dragging) {
      dragging = false;
      if (!events.some((ev) => ev.type === 'pointer.dragEnd')) events.push({ type: 'pointer.dragEnd', at, velocity: { x: 0, y: 0 } });
    }
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

  /** True when the press on `e` is over although no release arrived. */
  function pressLost(e: Entry, buttonDown: boolean | null, cursorPx: Point | null, now: number): boolean {
    if (buttonDown === true) {
      e.buttonSeenAt = now;
      return false;
    }
    if (buttonDown === false) return now - Math.max(e.pressAt, e.buttonSeenAt) > LOST_PRESS_MS;
    // Button state unknown (no Win32): a captured press reports every movement.
    if (!cursorPx || !e.pointerPx || now - e.pointerAt <= LOST_PRESS_MS) return false;
    return distance(cursorPx, e.pointerPx) > LOST_PRESS_MOVE_DIP * e.geometry.scaleFactor;
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
    watchdog(now);
    const buttonDown = opts.isLeftButtonDown();
    // Asked once, and only with the cursor on a hit region of an overlay that may take the mouse:
    // anywhere else it cannot change the decision, and the host's guard would read the windows for it.
    let excluded: readonly Rect[] | null = null;
    // v1.2: clinging to a screen edge, the cat takes the mouse only after the hover dwell.
    const support = lastOutput?.support;
    const clinging = support?.kind === 'surface' && support.surfaceKind === SCREEN_EDGE_KIND;
    for (const e of entries.values()) {
      if (!alive(e)) continue;
      if (e.pressed && pressLost(e, buttonDown, cursorPx, now)) {
        log.debug('pointer press lost; ending it', { displayId: e.displayId });
        endLostPress(e);
      }
      let interactive: boolean;
      if (forced !== null) interactive = forced;
      else {
        const region = effectiveRegions(e, now);
        const zone = { cursor: cursorPx, hitRects: region.rects, interactive: !e.ignoreMouse };
        const input = {
          ...zone,
          excludeRects: !blocked && cursorInHitZone(zone) ? (excluded ??= excludedRects()) : NO_RECTS,
          interactionsEnabled: !blocked,
          visible: e.active,
          rendererHealthy: live(e),
          dragging: e.pressed,
          hitRegionAgeMs: region.ageMs,
        };
        // The dwell clock runs while the cursor rests in the (clipped) hit zone; leaving it restarts it.
        if (clinging && !blocked && cursorInHitZone(input)) e.hoverSince ??= now;
        else e.hoverSince = null;
        interactive = decideInteractive({
          ...input,
          hoverDwellMs: clinging ? CLING_HOVER_DWELL_MS : 0,
          ...(e.hoverSince !== null ? { hoveredMs: now - e.hoverSince } : {}),
        });
      }
      setIgnore(e, !interactive);
    }
  }

  function toPx(e: Entry, x: number, y: number): Point {
    return opts.display.fromLocalDip(e.displayId, { x, y });
  }

  /** Maps a renderer performance.now() timestamp onto the main clock (minimum observed offset). */
  function mainTime(e: Entry, t: number): number {
    const now = opts.clock();
    const offset = now - t;
    if (e.timeOffset === null || offset < e.timeOffset) e.timeOffset = offset;
    return Math.min(now, t + e.timeOffset);
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
      const p = toPx(e, ev.x, ev.y);
      const t = mainTime(e, ev.t);
      e.pointerAt = opts.clock();
      e.pointerPx = p;
      if (ev.kind === 'down') {
        if (ev.button === 0) {
          e.pressed = true;
          e.pressAt = t;
          e.buttonSeenAt = t;
        }
      } else if (ev.kind === 'up' || ev.kind === 'cancel') {
        e.pressed = false;
      } else if (ev.kind === 'move' && (ev.buttons & 1) === 0) {
        // The primary button is no longer held: the release itself was lost.
        e.pressed = false;
      }
      deliver(opts.gestures.feed({ kind: ev.kind, x: p.x, y: p.y, button: ev.button, buttons: ev.buttons, t }));
      if (ev.kind === 'context') {
        e.pressed = false;
        try {
          opts.onContextMenu(e.win);
        } catch (err) {
          log.error('context menu failed', { error: err });
        }
      }
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
      for (const e of [...entries.values()]) destroyEntry(e);
      entries.clear();
      byWc.clear();
    },
  };
}
