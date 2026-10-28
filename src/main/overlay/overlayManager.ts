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
import type { DisplayGeometry, WorldGeometry } from '../../shared/world';
import type { DisplayService, Logger, Unsubscribe } from '../contracts';
import type { WindowRegistry } from '../security';
import { crashBackoff, boundsDiffer, planOverlaySync } from './displayDiff';
import { decideInteractive } from '../../core/interaction/clickThrough';
import type { GestureRecognizer } from '../../core/interaction/gestures';
import { createOverlayWindow, overlayUrl } from './overlayWindow';
import { displaysShowingCat, hiddenRenderState, mapRenderState } from './renderMapping';

const DISPLAY_DEBOUNCE_MS = 300;
const TOPMOST_CHECK_MS = 10_000;
/** Reported hit regions are trusted while fresh or while the cat has not moved since. */
const HIT_REGION_FRESH_MS = 300;
const HIT_REGION_MOVE_TOLERANCE_PX = 4;
/** A press with no physical button held for this long is considered lost. */
const LOST_PRESS_MS = 400;
const MAX_TOPMOST_REASSERTS_PER_MIN = 6;

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
}

export interface OverlayManager {
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
  hitAt: number;
  hitAnchor: Point | null;
  timeOffset: number | null;
  pressed: boolean;
  pressAt: number;
  buttonSeenAt: number;
  disposing: boolean;
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
  const topmostReasserts: number[] = [];

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
    e.win.setAlwaysOnTop(true, 'screen-saver');
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

  function create(d: DisplayGeometry): void {
    if (disposed || entries.has(d.id)) return;
    let win: BrowserWindow;
    try {
      win = createOverlayWindow({
        display: d,
        preloadPath: opts.preloadPath,
        devTools: opts.devTools,
        contentProtection: opts.getSettings().appearance.hideFromScreenCapture,
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
      disposing: false,
    };
    entries.set(d.id, e);
    byWc.set(e.wcId, e);
    opts.registry.register(win.webContents, 'overlay');
    wire(e);
    win.loadURL(overlayUrl(d.id)).catch((err: unknown) => log.error('loading overlay page failed', { displayId: d.id, error: err }));
    log.info('overlay created', { displayId: d.id, workAreaDip: d.workAreaDip, scaleFactor: d.scaleFactor });
  }

  function wire(e: Entry): void {
    const { win } = e;
    const wc = win.webContents;
    win.once('ready-to-show', () => {
      if (!alive(e)) return;
      win.showInactive();
      verifyBounds(e);
    });
    win.on('always-on-top-changed', (_ev, isOnTop) => {
      if (!isOnTop) reassertTopmost(e, 'always-on-top-changed');
    });
    win.on('query-session-end', () => opts.onSessionEnd());
    win.on('session-end', () => opts.onSessionEnd());
    win.on('closed', () => {
      byWc.delete(e.wcId);
      if (entries.get(e.displayId) === e) entries.delete(e.displayId);
      if (!e.disposing && !disposed) {
        log.warn('overlay closed unexpectedly', { displayId: e.displayId });
        scheduleRecreate(e.displayId, 'closed');
      }
    });
    wc.on('unresponsive', () => {
      log.warn('overlay renderer unresponsive', { displayId: e.displayId });
      e.healthy = false;
      e.pressed = false;
      setIgnore(e, true);
    });
    wc.on('responsive', () => {
      log.info('overlay renderer responsive again', { displayId: e.displayId });
      e.healthy = true;
    });
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
      try {
        e.win.destroy();
      } catch (err) {
        log.warn('destroying overlay failed', { displayId: e.displayId, error: err });
      }
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
    const appearance = opts.getSettings().appearance;
    const world = opts.display.world;
    const showing = displaysShowingCat(out, world.displays, appearance, hidden);
    const now = opts.clock();
    for (const e of entries.values()) {
      if (!alive(e)) continue;
      if (showing.has(e.displayId)) {
        const geo = world.displays.find((d) => d.id === e.displayId) ?? e.geometry;
        const forceSnap = !e.active || e.needSnap;
        const state = mapRenderState(out, appearance, {
          seq: ++seq,
          toLocalDip: (p) => opts.display.toLocalDip(e.displayId, p),
          scaleFactor: geo.scaleFactor,
          forceSnap,
          hidden,
          simNow,
        });
        if (!e.active) {
          e.active = true;
          e.activatedAt = now;
          e.hitRectsPx = null;
        }
        e.lastState = state;
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
   */
  function effectiveRegions(e: Entry, now: number): { rects: Rect[]; ageMs: number } {
    const out = lastOutput;
    if (!e.active || !out || !out.visible || lastHidden) return { rects: [], ageMs: Infinity };
    if (e.hitRectsPx && e.hitAt >= e.activatedAt) {
      const ageMs = now - e.hitAt;
      const moved = e.hitAnchor ? distance(e.hitAnchor, { x: out.x, y: out.y }) : Infinity;
      // The renderer reports only on change, so an old region of a cat that has not moved is still current.
      if (moved <= HIT_REGION_MOVE_TOLERANCE_PX) return { rects: e.hitRectsPx, ageMs: 0 };
      if (ageMs <= HIT_REGION_FRESH_MS) return { rects: e.hitRectsPx, ageMs };
    }
    return { rects: [out.boundsPx], ageMs: 0 };
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

  function updateInteractivity(cursorPx: Point | null, blocked: boolean): void {
    const now = opts.clock();
    const buttonDown = opts.isLeftButtonDown();
    for (const e of entries.values()) {
      if (!alive(e)) continue;
      if (e.pressed) {
        if (buttonDown !== false) e.buttonSeenAt = now;
        else if (now - Math.max(e.pressAt, e.buttonSeenAt) > LOST_PRESS_MS) {
          log.debug('pointer press lost; ending it', { displayId: e.displayId });
          endLostPress(e);
        }
      }
      let interactive: boolean;
      if (forced !== null) interactive = forced;
      else {
        const region = effectiveRegions(e, now);
        interactive = decideInteractive({
          cursor: cursorPx,
          hitRects: region.rects,
          interactive: !e.ignoreMouse,
          interactionsEnabled: !blocked,
          visible: e.active,
          rendererHealthy: e.healthy && !e.crashed && e.ready,
          dragging: e.pressed,
          hitRegionAgeMs: region.ageMs,
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
      for (const d of opts.display.world.displays) create(d);
      offDisplay = opts.display.onChange((world) => {
        if (displayTimer) clearTimeout(displayTimer);
        displayTimer = setTimeout(() => {
          displayTimer = null;
          sync(world);
        }, DISPLAY_DEBOUNCE_MS);
      });
      topmostTimer = setInterval(() => {
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
      for (const e of entries.values()) {
        for (const r of effectiveRegions(e, now).rects) {
          if (cursorPx.x >= r.x && cursorPx.x < r.x + r.width && cursorPx.y >= r.y && cursorPx.y < r.y + r.height) return true;
        }
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
      send(e, IPC.overlayConfig, configFor(e));
      if (e.active && e.lastState) {
        send(e, IPC.overlayRender, { ...e.lastState, seq: ++seq, snap: true });
        e.needSnap = false;
      }
      log.debug('overlay ready', { displayId: e.displayId });
    },
    handlePointer(wcId, ev) {
      const e = byWc.get(wcId);
      if (!e || !alive(e) || !e.healthy) return;
      const p = toPx(e, ev.x, ev.y);
      const t = mainTime(e, ev.t);
      if (ev.kind === 'down') {
        e.pressed = true;
        e.pressAt = t;
        e.buttonSeenAt = t;
      } else if (ev.kind === 'up' || ev.kind === 'cancel') {
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
      if (!e || !alive(e) || !e.active) return;
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
          boundsPx: screen.dipToScreenRect(e.win, bounds),
          expectedBounds: e.geometry.workAreaDip,
          visible: e.win.isVisible(),
          ignoreMouse: e.ignoreMouse,
          focusable: e.win.isFocusable(),
          alwaysOnTop: e.win.isAlwaysOnTop(),
          backgroundColor: e.win.getBackgroundColor(),
          ready: e.ready,
          active: e.active,
          healthy: e.healthy,
          crashes: crashHistory.get(e.displayId)?.length ?? 0,
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
