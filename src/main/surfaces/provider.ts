// SurfaceProvider (src/main/contracts.ts): one occlusion-aware set of environmental surfaces
// for the sim, in physical px.
//
// - Taskbar ledges come straight from the TaskbarTracker (always fresh; it is sampled by the
//   host's cursor poll).
// - Window tops and sides are built from DWM extended frame bounds against a z-order
//   snapshot (listOccluders: owned dialogs, tool windows, our Settings window and the
//   taskbar cut spans). The snapshot is re-enumerated at most every maxAgeMs and on z-order
//   (foreground) changes; in between, settled window-tracker changes update it in place and
//   windows being dragged are re-read live. Only windows touched by a change are recomputed,
//   and unchanged surfaces keep their object identity.
// - Browser tab strips (TabStripService) replace their window's top ledge, cut to the open
//   part of the edge and shifted with the window while it moves.
// - getSurface(id) re-reads that one owner live (GetWindowRect/DWM) for the cat riding it.
// Privacy: windows matching the exclusions are flagged `excluded` (the verdict comes from the
// tracker: process rules always, title rules only while analysis is on); tab-strip interest
// and tab events are never forwarded for them. No window title is read here.
import os from 'node:os';
import type { Rect } from '../../shared/geometry';
import type { Settings } from '../../shared/settings';
import type { SimEvent } from '../../shared/sim';
import type { LedgeSurface, Surface, SurfacePhase, SurfaceStatus } from '../../shared/surfaces';
import type { WindowInfo } from '../../shared/world';
import type { DisplayService, Logger, SurfaceProvider, TabStripService, TaskbarTracker, Unsubscribe, Win32Api, WindowTracker } from '../contracts';
import type { Occluder } from '../win32/platforms';
import { hasWin32Extensions } from '../win32/win32Api';
import type { WindowChange, WindowTrackerExtras } from '../win32/windowTracker';
import {
  ATTACH_TOLERANCE_PX,
  buildWindowSurfaces,
  computeOpenSpans,
  defaultCornerRadiusDip,
  EMPTY_WINDOW_SURFACES,
  offersSurfaces,
  parseSurfaceId,
  scaleForRect,
  stripId,
  type Attachment,
  type BuiltWindowSurfaces,
  type StripPlacement,
  type SurfaceMeta,
  type WindowOpenSpans,
  type WindowSurfaceOptions,
} from './windowSurfaces';

/** What the provider needs from the window tracker beyond the WindowTracker contract. */
export type SurfaceTracker = WindowTracker & Pick<WindowTrackerExtras, 'running' | 'onChange' | 'windowInfo' | 'listWindows' | 'isMoving'>;

export interface SurfaceProviderOptions extends Omit<WindowSurfaceOptions, 'climbWindows'> {
  /** How long a window that was just shown/restored reports phase 'entering' (ms). */
  enteringMs: number;
  /** Longest a minimizing/hiding window keeps reporting phase 'leaving' without its burst settling (ms). */
  leavingMaxMs: number;
  /** Browser windows whose top edge is this close to the cat are of tab-strip interest (DIP, scaled). */
  interestRadiusDip: number;
  /** Interest refresh period (ms). */
  interestIntervalMs: number;
  /** Bound on the windows passed to setInterest. */
  maxInterest: number;
}

export const DEFAULT_SURFACE_OPTIONS: Readonly<SurfaceProviderOptions> = Object.freeze({
  cornerRadiusDip: defaultCornerRadiusDip(os.release()),
  minLedgeWidthPx: 80,
  minWallHeightDip: 96,
  wallClearanceDip: 40,
  enteringMs: 300,
  leavingMaxMs: 1000,
  interestRadiusDip: 300,
  interestIntervalMs: 500,
  maxInterest: 4,
});

export interface SurfaceProviderDeps {
  logger: Logger;
  tracker: SurfaceTracker;
  win32: Win32Api;
  taskbars: TaskbarTracker;
  tabStrips: TabStripService | null;
  display: DisplayService;
  settings: Settings;
  /** Monotonic clock (ms), for change notices that carry no time of their own. */
  now?: () => number;
  options?: Partial<SurfaceProviderOptions>;
}

/** Where the cat is (px) and which surface it is attached to; fed by the host every tick. */
export interface CatPosition {
  x: number;
  y: number;
  surfaceId: string | null;
}

// A type alias (not an interface) so it is assignable to the contract's Record<string, unknown>.
export type SurfaceProviderDebug = {
  windowSurfaces: 'tracked' | 'unavailable';
  windows: number;
  occluders: number;
  surfaces: number;
  snapshots: number;
  incrementalUpdates: number;
  recomputes: number;
  liveReads: number;
  snapshotAgeMs: number | null;
  injected: number | null;
  interest: number;
  errors: number;
  taskbar: Record<string, unknown> | null;
  tabStrips: Record<string, unknown> | null;
};

export interface SurfaceProviderExtras {
  /** Host feedback each tick: the cat's position and attachment (null while hidden). */
  noteCat(cat: CatPosition | null): void;
  /** Test mode only (E2E): replaces every surface with `list` (SIMULATED geometry); null restores the real ones. */
  injectSurfaces(list: readonly Surface[] | null, now: number): void;
  debugInfo(): SurfaceProviderDebug;
}

interface Motion {
  x: number;
  y: number;
  right: number;
  at: number;
  changedAt: number;
  vx: number;
  vy: number;
  vxRight: number;
}

interface Entry {
  id: string;
  info: WindowInfo;
  /** Frame (px) the current surfaces were built from. */
  rect: Rect;
  readAt: number;
  confidence: number;
  spans: WindowOpenSpans | null;
  built: BuiltWindowSurfaces;
  enteringUntil: number;
  leavingSince: number | null;
  motion: Motion;
  live: { at: number; rect: Rect | null } | null;
}

/** Live reads of the same window within this window of time are shared (sim sub-steps). */
const LIVE_READ_REUSE_MS = 4;
/** Velocity estimates need samples at most this far apart (ms). */
const MOTION_MAX_GAP_MS = 500;
/** A window not seen moving for this long is at rest (ms). */
const MOTION_REST_MS = 200;
const MOTION_SMOOTHING = 0.6;
const CONFIDENCE_FRESH = 1;
const CONFIDENCE_MODEL = 0.9;
const CONFIDENCE_ENTERING = 0.7;
const CONFIDENCE_LEAVING = 0.3;
const CONFIDENCE_STRIP_SHIFTED = 0.8;
const CONFIDENCE_STRIP_RESIZED = 0.6;
const CONFIDENCE_STRIP_FALLBACK = 0.5;
/** Raw hook events that announce a window is about to disappear. */
const LEAVING_RAW: ReadonlySet<string> = new Set(['minimizeStart', 'hide', 'cloaked', 'destroy']);
const TASKBAR_EVENTS: ReadonlySet<SimEvent['type']> = new Set(['taskbar.shown', 'taskbar.hidden']);
const NO_TABS_REASON = 'Tab-strip discovery is not available in this build.';

const isEnabled = (s: Settings, b: Settings['behavior']['disabledBehaviors'][number]): boolean => !s.behavior.disabledBehaviors.includes(b);

const sameRect = (a: Rect, b: Rect): boolean => a.x === b.x && a.y === b.y && a.width === b.width && a.height === b.height;

const intersects = (a: Rect, b: Rect, margin: number): boolean =>
  a.x - margin < b.x + b.width && b.x < a.x + a.width + margin && a.y - margin < b.y + b.height && b.y < a.y + a.height + margin;

const sameRest = (a: LedgeSurface['rest'], b: LedgeSurface['rest']): boolean => (a === null || b === null ? a === b : a.x0 === b.x0 && a.x1 === b.x1);

/** Field-by-field equality of two surfaces (used to keep unchanged objects stable). */
function sameSurface(a: Surface | null, b: Surface | null): boolean {
  if (a === null || b === null) return a === b;
  if (a.id !== b.id || a.phase !== b.phase || a.vx !== b.vx || a.vy !== b.vy || a.confidence !== b.confidence || a.excluded !== b.excluded || a.displayId !== b.displayId) return false;
  if (a.validatedAt !== b.validatedAt) return false;
  if (a.orientation === 'ledge' && b.orientation === 'ledge') return a.y === b.y && a.x0 === b.x0 && a.x1 === b.x1 && a.focusX === b.focusX && sameRest(a.rest, b.rest);
  if (a.orientation === 'wall' && b.orientation === 'wall') return a.x === b.x && a.y0 === b.y0 && a.y1 === b.y1 && a.topLedgeId === b.topLedgeId;
  return false;
}

/** Keeps the previous object for every surface whose content did not change. */
function stabilize(prev: BuiltWindowSurfaces, next: BuiltWindowSurfaces): { built: BuiltWindowSurfaces; changed: boolean } {
  const pick = <T extends Surface>(p: T | null, n: T | null): T | null => (sameSurface(p, n) ? p : n);
  const built: BuiltWindowSurfaces = {
    windowTop: pick(prev.windowTop, next.windowTop),
    strip: pick(prev.strip, next.strip),
    left: pick(prev.left, next.left),
    right: pick(prev.right, next.right),
  };
  const changed = built.windowTop !== prev.windowTop || built.strip !== prev.strip || built.left !== prev.left || built.right !== prev.right;
  return { built: changed ? built : prev, changed };
}

/** Same ids in the same order: the snapshots differ only in rects (or not at all). */
function reorderedRects(prev: readonly Occluder[], next: readonly Occluder[]): Rect[] {
  const nextIds = new Set(next.map((o) => o.id));
  const prevIds = new Set(prev.map((o) => o.id));
  const out: Rect[] = [];
  const prevById = new Map(prev.map((o) => [o.id, o.rect]));
  for (const o of prev) if (!nextIds.has(o.id)) out.push(o.rect);
  for (const o of next) {
    const before = prevById.get(o.id);
    if (!before) out.push(o.rect);
    else if (!sameRect(before, o.rect)) out.push(before, o.rect);
  }
  // Relative order of the windows present in both: every position where the sequences
  // disagree marks a window whose stacking changed (e.g. one brought to the front).
  const a = prev.filter((o) => nextIds.has(o.id));
  const b = next.filter((o) => prevIds.has(o.id));
  for (let i = 0; i < a.length && i < b.length; i++) {
    const pa = a[i]!;
    const pb = b[i]!;
    if (pa.id !== pb.id) out.push(pa.rect, pb.rect);
  }
  return out;
}

export function createSurfaceProvider(deps: SurfaceProviderDeps): SurfaceProvider & SurfaceProviderExtras {
  const log = deps.logger.child('surfaces');
  const clock = deps.now ?? (() => performance.now());
  const opts: SurfaceProviderOptions = { ...DEFAULT_SURFACE_OPTIONS, ...deps.options };
  const { tracker, win32, taskbars, tabStrips, display } = deps;
  const extended = hasWin32Extensions(win32) ? win32 : null;

  let climbWindows = isEnabled(deps.settings, 'climbWindows');
  let taskbarPlay = isEnabled(deps.settings, 'taskbarPlay');
  let tabStripsOn = isEnabled(deps.settings, 'tabStrips');

  let order: Occluder[] = [];
  let entries = new Map<string, Entry>();
  let snapshotAt = -Infinity;
  let needSnapshot = true;
  let recomputeAll = true;
  const dirtyIds = new Set<string>();
  const leavingIds = new Map<string, number>();
  const enteringIds = new Map<string, number>();
  const recompute = new Set<string>();
  let affected: Rect[] = [];
  let attach: Attachment | null = null;
  let catPos: CatPosition | null = null;

  let windowVersion = 0;
  let composedWindows: { version: number; list: Surface[] } = { version: -1, list: [] };
  let composed: { windows: Surface[]; taskbars: readonly LedgeSurface[] | null; list: readonly Surface[] } | null = null;
  let strips: readonly LedgeSurface[] = [];
  const stripBases = new Map<string, { validatedAt: number; rect: Rect }>();

  let injected: { list: readonly Surface[]; byId: Map<string, Surface> } | null = null;
  const injectedEvents: SimEvent[] = [];

  let interestAt = -Infinity;
  let interest: string[] = [];
  let snapshots = 0;
  let incrementalUpdates = 0;
  let recomputes = 0;
  let liveReads = 0;
  let errors = 0;
  let disposed = false;

  function report(op: string, e: unknown): void {
    errors++;
    if (errors <= 5 || errors % 1000 === 0) log.warn('surface provider step failed', { op, count: errors, error: e instanceof Error ? e.message : String(e) });
  }

  const windowTracking = (): boolean => win32.available && tracker.mode !== 'unavailable' && tracker.running;

  function onTrackerChange(c: WindowChange): void {
    switch (c.kind) {
      case 'all':
        needSnapshot = true;
        recomputeAll = true;
        break;
      case 'zorder':
        // Foreground changes reorder windows: occlusion must be re-read from the OS.
        needSnapshot = true;
        break;
      case 'window':
        dirtyIds.add(c.id);
        leavingIds.delete(c.id);
        if (c.change === 'shown' || c.change === 'restored') enteringIds.set(c.id, c.at + opts.enteringMs);
        break;
      case 'raw':
        if (LEAVING_RAW.has(c.raw) && entries.has(c.id)) leavingIds.set(c.id, c.at);
        break;
    }
  }

  const offTracker: Unsubscribe = tracker.onChange(onTrackerChange);
  const offDisplay: Unsubscribe = display.onChange(() => {
    needSnapshot = true;
    recomputeAll = true;
  });

  function phaseOf(e: Entry, now: number): SurfacePhase {
    if (e.leavingSince !== null && now - e.leavingSince < opts.leavingMaxMs) return 'leaving';
    if (e.enteringUntil > now) return 'entering';
    return 'stable';
  }

  function observeMotion(e: Entry, r: Rect, t: number): void {
    const m = e.motion;
    const right = r.x + r.width;
    if (m.at === -Infinity) {
      Object.assign(m, { x: r.x, y: r.y, right, at: t, changedAt: -Infinity, vx: 0, vy: 0, vxRight: 0 });
      return;
    }
    const dx = r.x - m.x;
    const dy = r.y - m.y;
    const dr = right - m.right;
    const dt = t - m.at;
    if (dx !== 0 || dy !== 0 || dr !== 0) {
      if (dt > 0 && dt <= MOTION_MAX_GAP_MS) {
        const perSec = 1000 / dt;
        const k = MOTION_SMOOTHING;
        m.vx = m.vx * (1 - k) + dx * perSec * k;
        m.vy = m.vy * (1 - k) + dy * perSec * k;
        m.vxRight = m.vxRight * (1 - k) + dr * perSec * k;
      } else {
        // A jump (snap, restore) or samples too sparse to estimate a speed.
        m.vx = 0;
        m.vy = 0;
        m.vxRight = 0;
      }
      m.changedAt = t;
    } else if (t - m.changedAt >= MOTION_REST_MS) {
      m.vx = 0;
      m.vy = 0;
      m.vxRight = 0;
    }
    m.x = r.x;
    m.y = r.y;
    m.right = right;
    m.at = Math.max(m.at, t);
  }

  function newEntry(info: WindowInfo, rect: Rect, now: number): Entry {
    return {
      id: info.id,
      info,
      rect,
      readAt: now,
      confidence: CONFIDENCE_FRESH,
      spans: null,
      built: EMPTY_WINDOW_SURFACES,
      enteringUntil: enteringIds.get(info.id) ?? -Infinity,
      leavingSince: null,
      motion: { x: 0, y: 0, right: 0, at: -Infinity, changedAt: -Infinity, vx: 0, vy: 0, vxRight: 0 },
      live: null,
    };
  }

  function meta(e: Entry, now: number): SurfaceMeta {
    const phase = phaseOf(e, now);
    const m = e.motion;
    const resting = now - m.changedAt >= MOTION_REST_MS;
    return {
      phase,
      confidence: phase === 'leaving' ? CONFIDENCE_LEAVING : phase === 'entering' ? Math.min(e.confidence, CONFIDENCE_ENTERING) : e.confidence,
      validatedAt: e.readAt,
      excluded: e.info.excluded,
      vx: resting ? 0 : m.vx,
      vy: resting ? 0 : m.vy,
      vxRight: resting ? 0 : m.vxRight,
    };
  }

  /** The window's tab strip, shifted from where it was measured to the window's current frame. */
  function stripPlacement(e: Entry): StripPlacement | null {
    const s = strips.find((x) => x.ownerId === e.id);
    if (!s) return null;
    let base = stripBases.get(e.id);
    if (!base || base.validatedAt !== s.validatedAt) {
      base = { validatedAt: s.validatedAt, rect: e.rect };
      stripBases.set(e.id, base);
    }
    const dx = e.rect.x - base.rect.x;
    const dy = e.rect.y - base.rect.y;
    const resized = e.rect.width !== base.rect.width || e.rect.height !== base.rect.height;
    const confidence = Math.min(s.confidence, resized ? CONFIDENCE_STRIP_RESIZED : dx !== 0 || dy !== 0 ? CONFIDENCE_STRIP_SHIFTED : 1);
    return {
      source: s,
      y: s.y + dy,
      x0: s.x0 + dx,
      x1: s.x1 + dx,
      rest: s.rest ? { x0: s.rest.x0 + dx, x1: s.rest.x1 + dx } : null,
      focusX: s.focusX === null ? null : s.focusX + dx,
      confidence,
    };
  }

  function aboveRects(id: string): Rect[] {
    const out: Rect[] = [];
    for (const o of order) {
      if (o.id === id) break;
      out.push(o.rect);
    }
    return out;
  }

  /** Recomputes one window's surfaces; true when any listed surface changed. */
  function computeEntry(e: Entry, now: number): boolean {
    recomputes++;
    const displays = display.world.displays;
    let next: BuiltWindowSurfaces = EMPTY_WINDOW_SURFACES;
    e.spans = null;
    if (offersSurfaces(e.info, e.rect, displays)) {
      e.spans = computeOpenSpans(e.rect, aboveRects(e.id), displays, { ...opts, climbWindows });
      next = buildWindowSurfaces(e.id, e.rect, e.spans, displays, meta(e, now), stripPlacement(e), attach);
    }
    const r = stabilize(e.built, next);
    e.built = r.built;
    if (r.changed) windowVersion++;
    return r.changed;
  }

  function markAffected(...rects: Rect[]): void {
    for (const r of rects) affected.push(r);
  }

  /** Settled tracker changes: update the snapshot in place (no enumeration). */
  function applyModelChanges(now: number): void {
    if (dirtyIds.size === 0) return;
    incrementalUpdates++;
    for (const id of dirtyIds) {
      const info = tracker.windowInfo(id);
      const idx = order.findIndex((o) => o.id === id);
      const old = idx >= 0 ? order[idx]!.rect : null;
      if (!info || info.minimized || !(info.rect.width > 0 && info.rect.height > 0)) {
        if (idx >= 0) order.splice(idx, 1);
        const e = entries.get(id);
        if (e) {
          entries.delete(id);
          stripBases.delete(id);
          if (e.built !== EMPTY_WINDOW_SURFACES) windowVersion++;
        }
        if (old) markAffected(old);
        continue;
      }
      const rect = info.rect;
      if (idx >= 0) order[idx] = { id, rect };
      // A window the snapshot has not seen yet: new windows open on top; the next
      // enumeration places it exactly.
      else order.unshift({ id, rect });
      let e = entries.get(id);
      if (!e) {
        e = newEntry(info, rect, now);
        entries.set(id, e);
      }
      e.info = info;
      e.rect = rect;
      e.readAt = now;
      e.confidence = CONFIDENCE_MODEL;
      e.leavingSince = null;
      e.live = null;
      const until = enteringIds.get(id);
      if (until !== undefined) e.enteringUntil = until;
      observeMotion(e, rect, now);
      recompute.add(id);
      markAffected(rect);
      if (old && !sameRect(old, rect)) markAffected(old);
    }
    dirtyIds.clear();
  }

  /** Re-enumerates the z-order (listOccluders, else the app-window list) and diffs it. */
  function refreshSnapshot(now: number): void {
    snapshots++;
    needSnapshot = false;
    snapshotAt = now;
    let next: Occluder[];
    const infos = new Map<string, WindowInfo>();
    const occ = extended ? extended.listOccluders() : null;
    if (occ) {
      next = occ.filter((o) => o.rect.width > 0 && o.rect.height > 0).map((o) => ({ id: o.id, rect: { ...o.rect } }));
      for (const o of next) {
        const info = tracker.windowInfo(o.id);
        // Listed occluders are shown: a stale "minimized" model flag is overridden.
        if (info) infos.set(o.id, info.minimized ? { ...info, minimized: false } : info);
      }
    } else {
      const list = tracker.listWindows(0);
      next = [];
      for (const w of list) {
        if (w.minimized || !(w.rect.width > 0 && w.rect.height > 0)) continue;
        next.push({ id: w.id, rect: { ...w.rect } });
        infos.set(w.id, w);
      }
    }
    // The taskbars are topmost: their live rects lead the z-order (replacing stale listings).
    const bars = taskbars.available ? taskbars.taskbars().filter((t) => t.shownFraction > 0 && t.rect.width > 0 && t.rect.height > 0) : [];
    if (bars.length > 0) {
      const ids = new Set(bars.map((t) => t.id));
      next = [...bars.map((t) => ({ id: t.id, rect: { ...t.rect } })), ...next.filter((o) => !ids.has(o.id))];
    }
    markAffected(...reorderedRects(order, next));
    order = next;

    const nextEntries = new Map<string, Entry>();
    for (const o of order) {
      const info = infos.get(o.id);
      if (!info) continue;
      let e = entries.get(o.id);
      if (!e) {
        e = newEntry(info, o.rect, now);
        recompute.add(o.id);
      } else if (!sameRect(e.rect, o.rect) || e.info.excluded !== info.excluded || e.info.maximized !== info.maximized || e.info.fullscreen !== info.fullscreen) {
        recompute.add(o.id);
      }
      e.info = info;
      if (!sameRect(e.rect, o.rect)) e.live = null;
      e.rect = o.rect;
      e.readAt = now;
      e.confidence = CONFIDENCE_FRESH;
      observeMotion(e, o.rect, now);
      nextEntries.set(o.id, e);
    }
    for (const [id, e] of entries) {
      if (nextEntries.has(id)) continue;
      stripBases.delete(id);
      if (e.built !== EMPTY_WINDOW_SURFACES) windowVersion++;
    }
    entries = nextEntries;
  }

  /** Windows being dragged or sized raise no events until the drag ends: re-read them live. */
  function trackMoving(now: number): void {
    for (const e of entries.values()) {
      if (!tracker.isMoving(e.id)) continue;
      const r = liveRect(e, now);
      if (r === null) {
        dirtyIds.add(e.id);
        continue;
      }
      if (!sameRect(r, e.rect)) moveEntry(e, r, now);
    }
  }

  function moveEntry(e: Entry, r: Rect, now: number): void {
    markAffected(e.rect, r);
    const idx = order.findIndex((o) => o.id === e.id);
    if (idx >= 0) order[idx] = { id: e.id, rect: r };
    e.rect = r;
    e.readAt = now;
    e.confidence = CONFIDENCE_FRESH;
    observeMotion(e, r, now);
    recompute.add(e.id);
  }

  function liveRect(e: Entry, now: number): Rect | null {
    if (e.live && now - e.live.at >= 0 && now - e.live.at < LIVE_READ_REUSE_MS) return e.live.rect;
    liveReads++;
    let r: Rect | null;
    try {
      r = tracker.getWindowRect(e.id);
    } catch (err) {
      report('rect', err);
      r = null;
    }
    e.live = { at: now, rect: r };
    return r;
  }

  /** Tab strips changed (new list): recompute their owners. */
  function refreshStrips(): void {
    let next: readonly LedgeSurface[] = [];
    if (tabStrips && tabStripsOn) {
      try {
        next = tabStrips.surfaces();
      } catch (e) {
        report('tabStrips', e);
        next = [];
      }
    }
    if (next === strips) return;
    for (const s of strips) recompute.add(s.ownerId);
    for (const s of next) recompute.add(s.ownerId);
    strips = next;
    // Which top ledge is listed depends on the strip set itself, not only on rebuilt surfaces.
    windowVersion++;
    const owners = new Set(next.map((s) => s.ownerId));
    for (const id of stripBases.keys()) if (!owners.has(id)) stripBases.delete(id);
  }

  /** Phases and velocities change with time alone. */
  function refreshTimed(now: number): void {
    for (const [id, since] of leavingIds) {
      const e = entries.get(id);
      if (!e) {
        leavingIds.delete(id);
        continue;
      }
      if (e.leavingSince === null) {
        e.leavingSince = since;
        recompute.add(id);
      } else if (now - e.leavingSince >= opts.leavingMaxMs) {
        e.leavingSince = null;
        leavingIds.delete(id);
        recompute.add(id);
      }
    }
    for (const [id, until] of enteringIds) {
      const e = entries.get(id);
      if (e && e.enteringUntil !== until) {
        e.enteringUntil = until;
        recompute.add(id);
      }
      if (until <= now) {
        enteringIds.delete(id);
        if (e) recompute.add(id);
      }
    }
    for (const e of entries.values()) {
      const m = e.motion;
      if ((m.vx !== 0 || m.vy !== 0 || m.vxRight !== 0) && now - m.changedAt >= MOTION_REST_MS) {
        m.vx = 0;
        m.vy = 0;
        m.vxRight = 0;
        recompute.add(e.id);
      }
    }
  }

  function recomputeAffected(now: number): void {
    if (recomputeAll) {
      recomputeAll = false;
      for (const e of entries.values()) computeEntry(e, now);
    } else if (recompute.size > 0 || affected.length > 0) {
      const margin = Math.ceil(opts.wallClearanceDip * maxScale()) + 2;
      for (const e of entries.values()) {
        if (recompute.has(e.id) || affected.some((a) => intersects(a, e.rect, margin))) computeEntry(e, now);
      }
    }
    recompute.clear();
    affected = [];
  }

  function maxScale(): number {
    let s = 1;
    for (const d of display.world.displays) if (d.scaleFactor > s) s = d.scaleFactor;
    return s;
  }

  function windowSurfacesList(): Surface[] {
    if (composedWindows.version === windowVersion) return composedWindows.list;
    const list: Surface[] = [];
    for (const o of order) {
      const e = entries.get(o.id);
      if (!e) continue;
      const b = e.built;
      const top = b.strip ?? (strips.some((s) => s.ownerId === e.id) ? null : b.windowTop);
      if (top) list.push(top);
      if (b.left) list.push(b.left);
      if (b.right) list.push(b.right);
    }
    composedWindows = { version: windowVersion, list };
    return list;
  }

  function taskbarSurfaces(): readonly LedgeSurface[] | null {
    if (!taskbarPlay || !taskbars.available) return null;
    try {
      return taskbars.surfaces();
    } catch (e) {
      report('taskbars', e);
      return null;
    }
  }

  function compose(): readonly Surface[] {
    const windows = windowSurfacesList();
    const bars = taskbarSurfaces();
    if (composed && composed.windows === windows && composed.taskbars === bars) return composed.list;
    const list: readonly Surface[] = bars && bars.length > 0 ? [...bars, ...windows] : windows;
    composed = { windows, taskbars: bars, list };
    return list;
  }

  function updateInterest(now: number): void {
    if (!tabStrips) return;
    if (now - interestAt < opts.interestIntervalMs) return;
    interestAt = now;
    const ids: string[] = [];
    if (tabStripsOn && windowTracking()) {
      const add = (id: string): void => {
        if (!ids.includes(id) && ids.length < opts.maxInterest) ids.push(id);
      };
      const usable = (info: WindowInfo | null): info is WindowInfo => info !== null && info.category === 'browser' && !info.excluded && !info.minimized;
      if (catPos?.surfaceId) {
        const p = parseSurfaceId(catPos.surfaceId);
        if (p && p.kind !== 'taskbar' && usable(tracker.windowInfo(p.owner))) add(p.owner);
      }
      let fg: WindowInfo | null = null;
      try {
        fg = tracker.getForeground();
      } catch (e) {
        report('foreground', e);
      }
      if (usable(fg) && entries.has(fg.id)) add(fg.id);
      if (catPos) {
        const cat = catPos;
        const near: Array<{ id: string; d: number }> = [];
        for (const e of entries.values()) {
          if (!usable(e.info)) continue;
          const r = e.rect;
          const dx = cat.x < r.x ? r.x - cat.x : cat.x > r.x + r.width ? cat.x - (r.x + r.width) : 0;
          const d = Math.hypot(dx, cat.y - r.y);
          if (d <= opts.interestRadiusDip * scaleForRect(display.world.displays, r)) near.push({ id: e.id, d });
        }
        near.sort((a, b) => a.d - b.d);
        for (const n of near) add(n.id);
      }
    }
    if (ids.length === 0 && interest.length === 0) return;
    interest = ids;
    try {
      tabStrips.setInterest(ids, now);
    } catch (e) {
      report('interest', e);
    }
  }

  /** Live geometry of one window surface for the cat riding it. */
  function liveWindowSurface(kind: 'windowTop' | 'tabStrip' | 'windowSide', owner: string, side: 'left' | 'right' | null, now: number): Surface | null {
    if (!windowTracking()) return null;
    const e = entries.get(owner);
    if (!e) return null;
    if (kind === 'windowSide' && !climbWindows) return null;
    const r = liveRect(e, now);
    if (r === null) {
      // Gone, minimized or cloaked: the tracker settles it; drop it from listings meanwhile.
      dirtyIds.add(owner);
      return null;
    }
    if (!sameRect(r, e.rect)) {
      moveEntry(e, r, now);
      computeEntry(e, now);
      recompute.delete(owner);
    } else {
      e.readAt = now;
      e.confidence = CONFIDENCE_FRESH;
    }
    if (!e.spans) return null;
    const displays = display.world.displays;
    // Strict: if the cat's attachment point on this surface is covered, the surface is lost.
    const strict = buildWindowSurfaces(e.id, e.rect, e.spans, displays, { ...meta(e, now), validatedAt: now }, stripPlacement(e), attach, true);
    switch (kind) {
      case 'windowTop':
        // Also while a tab strip replaces it in listings: the edge is physically still there.
        return strict.windowTop;
      case 'tabStrip': {
        if (strict.strip) return strict.strip;
        // The strip vanished (helper restarted, tabs re-laid out) under a riding cat: keep the
        // ledge continuous on the window's top edge under the same id.
        const top = strict.windowTop;
        return top ? { ...top, id: stripId(owner), kind: 'tabStrip', confidence: Math.min(top.confidence, CONFIDENCE_STRIP_FALLBACK) } : null;
      }
      case 'windowSide':
        return side === 'left' ? strict.left : strict.right;
    }
  }

  function injectedTaskbarEvents(prev: readonly Surface[], next: readonly Surface[]): void {
    const tb = (list: readonly Surface[]): Map<string, LedgeSurface> => {
      const m = new Map<string, LedgeSurface>();
      for (const s of list) if (s.kind === 'taskbar' && s.orientation === 'ledge') m.set(s.id, s);
      return m;
    };
    const a = tb(prev);
    const b = tb(next);
    for (const [id, s] of b) if (!a.has(id)) injectedEvents.push({ type: 'taskbar.shown', surfaceId: id, displayId: s.displayId, edge: s.edge ?? 'bottom' });
    for (const [id, s] of a) if (!b.has(id)) injectedEvents.push({ type: 'taskbar.hidden', surfaceId: id, displayId: s.displayId, edge: s.edge ?? 'bottom' });
  }

  return {
    get status(): SurfaceStatus {
      let count = 0;
      try {
        count = taskbars.available ? taskbars.taskbars().length : 0;
      } catch (e) {
        report('status', e);
      }
      return {
        taskbar: taskbars.available ? 'tracked' : 'unavailable',
        taskbars: count,
        windowSurfaces: win32.available && tracker.mode !== 'unavailable' ? 'tracked' : 'unavailable',
        tabStrips: tabStrips ? tabStrips.status : 'unavailable',
        tabStripReason: tabStrips ? tabStrips.statusReason : NO_TABS_REASON,
      };
    },

    getSurfaces(now: number, maxAgeMs: number): readonly Surface[] {
      if (disposed) return [];
      if (injected) return injected.list;
      try {
        if (!windowTracking()) {
          if (entries.size > 0 || order.length > 0) {
            entries = new Map();
            order = [];
            windowVersion++;
          }
          needSnapshot = true;
        } else {
          applyModelChanges(now);
          // Full rebuild at most every maxAgeMs (fresh validatedAt everywhere); an event-driven
          // re-enumeration (z-order change) recomputes only the windows whose stacking changed.
          const periodic = now - snapshotAt >= maxAgeMs || now < snapshotAt;
          if (needSnapshot || periodic) {
            refreshSnapshot(now);
            if (periodic) recomputeAll = true;
          }
          trackMoving(now);
          refreshStrips();
          refreshTimed(now);
          recomputeAffected(now);
        }
        updateInterest(now);
        return compose();
      } catch (e) {
        report('getSurfaces', e);
        return composed?.list ?? [];
      }
    },

    getSurface(id: string, now: number): Surface | null {
      if (disposed) return null;
      if (injected) return injected.byId.get(id) ?? null;
      const p = parseSurfaceId(id);
      if (!p) return null;
      try {
        if (p.kind === 'taskbar') {
          const bars = taskbarSurfaces();
          return bars?.find((s) => s.id === id) ?? null;
        }
        return liveWindowSurface(p.kind, p.owner, p.kind === 'windowSide' ? p.side : null, now);
      } catch (e) {
        report('getSurface', e);
        return null;
      }
    },

    drainEvents(): SimEvent[] {
      const out: SimEvent[] = [];
      let bars: SimEvent[] = [];
      let tabs: SimEvent[] = [];
      try {
        bars = taskbars.drainEvents();
      } catch (e) {
        report('taskbarEvents', e);
      }
      try {
        tabs = tabStrips ? tabStrips.drainEvents() : [];
      } catch (e) {
        report('tabEvents', e);
      }
      if (injected || disposed) {
        // Real observers are drained (so nothing piles up) but the injected world rules.
        out.push(...injectedEvents.splice(0));
        return out;
      }
      out.push(...injectedEvents.splice(0));
      if (taskbarPlay) for (const ev of bars) if (TASKBAR_EVENTS.has(ev.type)) out.push(ev);
      if (tabStripsOn) {
        for (const ev of tabs) {
          if (ev.type !== 'tabs.changed') continue;
          // Fail closed: tab activity of private (or unknown) windows never reaches the sim.
          const info = tracker.windowInfo(ev.ownerId);
          if (info && !info.excluded) out.push(ev);
        }
      }
      return out;
    },

    updateSettings(settings: Settings): void {
      const climb = isEnabled(settings, 'climbWindows');
      const play = isEnabled(settings, 'taskbarPlay');
      const tabsOn = isEnabled(settings, 'tabStrips');
      if (climb !== climbWindows) {
        climbWindows = climb;
        recomputeAll = true;
      }
      if (play !== taskbarPlay) {
        taskbarPlay = play;
        composed = null;
      }
      if (tabsOn !== tabStripsOn) {
        tabStripsOn = tabsOn;
        interestAt = -Infinity;
      }
      try {
        tabStrips?.updateSettings(settings);
      } catch (e) {
        report('tabStripSettings', e);
      }
    },

    noteCat(cat: CatPosition | null): void {
      catPos = cat && Number.isFinite(cat.x) && Number.isFinite(cat.y) ? { ...cat } : null;
      const next = catPos && catPos.surfaceId ? { surfaceId: catPos.surfaceId, x: catPos.x, y: catPos.y } : null;
      const owner = (a: Attachment | null): string | null => {
        const p = a ? parseSurfaceId(a.surfaceId) : null;
        return p && p.kind !== 'taskbar' ? p.owner : null;
      };
      const before = owner(attach);
      const after = owner(next);
      // Span choice depends on where the cat is: re-evaluate the windows it left or joined,
      // and the one it rides when it moved past the edge of its span.
      if (before !== after) {
        if (before) recompute.add(before);
        if (after) recompute.add(after);
      } else if (after && next && attach && (next.x !== attach.x || next.y !== attach.y)) {
        const e = entries.get(after);
        const listed = e ? [e.built.windowTop, e.built.strip, e.built.left, e.built.right].find((s) => s?.id === next.surfaceId) : undefined;
        if (listed && (listed.orientation === 'ledge' ? next.x < listed.x0 - ATTACH_TOLERANCE_PX || next.x > listed.x1 + ATTACH_TOLERANCE_PX : next.y < listed.y0 - ATTACH_TOLERANCE_PX || next.y > listed.y1 + ATTACH_TOLERANCE_PX)) {
          recompute.add(after);
        }
      }
      attach = next;
    },

    injectSurfaces(list: readonly Surface[] | null, now: number): void {
      const prev = injected?.list ?? [];
      if (list === null) {
        injected = null;
        injectedTaskbarEvents(prev, []);
        composed = null;
        log.info('surface injection ended');
        return;
      }
      const copy = list.map((s) => Object.freeze({ ...s, validatedAt: now }) as Surface);
      injectedTaskbarEvents(prev, copy);
      injected = { list: Object.freeze(copy), byId: new Map(copy.map((s) => [s.id, s])) };
      log.info('surfaces injected (test mode)', { count: copy.length });
    },

    debugInfo(): SurfaceProviderDebug {
      const now = clock();
      let taskbar: Record<string, unknown> | null = null;
      let tabs: Record<string, unknown> | null = null;
      try {
        taskbar = taskbars.debugInfo();
      } catch (e) {
        report('taskbarDebug', e);
      }
      try {
        tabs = tabStrips ? tabStrips.debugInfo() : null;
      } catch (e) {
        report('tabDebug', e);
      }
      return {
        windowSurfaces: win32.available && tracker.mode !== 'unavailable' ? 'tracked' : 'unavailable',
        windows: entries.size,
        occluders: order.length,
        surfaces: composed?.list.length ?? 0,
        snapshots,
        incrementalUpdates,
        recomputes,
        liveReads,
        snapshotAgeMs: Number.isFinite(snapshotAt) ? Math.max(0, Math.round(now - snapshotAt)) : null,
        injected: injected ? injected.list.length : null,
        interest: interest.length,
        errors,
        taskbar,
        tabStrips: tabs,
      };
    },

    dispose(): Promise<void> {
      if (disposed) return Promise.resolve();
      disposed = true;
      try {
        offTracker();
        offDisplay();
      } catch (e) {
        report('dispose', e);
      }
      entries.clear();
      order = [];
      injected = null;
      injectedEvents.length = 0;
      stripBases.clear();
      composed = null;
      return Promise.resolve();
    },
  };
}
