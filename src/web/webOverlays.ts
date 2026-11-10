// The web host's overlay: one in-page "overlay" (the viewport canvas) for createCatHost. It is the
// HostOverlays the host renders to and the OverlayApi the real overlay renderer (OverlayRuntime)
// talks to, with no IPC in between. Mirrors the render, hit-region and click-through rules of
// src/main/overlay/overlayManager.ts for a single display (that file imports Electron, so its rules
// are restated here, not shared; ADR 0004 §8, M4):
// - render: mapRenderState for the one display while the cat is on it (a snap on the first frame
//   after activation, a display change or the renderer becoming ready), the final hidden frame
//   when it leaves, a sound cue once (only while sound is on);
// - hit regions: what the renderer reports is trusted while fresh (HIT_REGION_FRESH_MS) or while
//   the cat has not moved since; otherwise the sim's bounds; a renderer that stopped reporting
//   (its heartbeat) ages out of interactivity through decideInteractive, as on the desktop;
// - pointer input does not come through sendPointer (the canvas has pointer-events: none): the
//   pointer router asks hitTest() and owns presses; pressed/dragging reflect it.
// The world is logical (world px = CSS px), so overlay-local DIP and world px coincide.
import { cursorInHitZone, decideInteractive } from '../core/interaction/clickThrough';
import type { CatRenderState } from '../shared/cat';
import { distance, type Point, type Rect } from '../shared/geometry';
import { HitRegionSchema, type OverlayApi, type OverlayConfig } from '../shared/ipc';
import type { Settings } from '../shared/settings';
import type { SimOutput } from '../shared/sim';
import type { HostOverlays } from '../main/catHost';
import type { DisplayService, Logger } from '../main/contracts';
import { displaysShowingCat, displaysShowingProps, hiddenRenderState, mapRenderState } from '../main/overlay/renderMapping';
import type { PresenceInfo } from './overlaySurface';

/**
 * What the host adds to one frame (CatHost passes it only while it has something to say; structurally the
 * desktop's OverlayRenderExtras): the laser dot in world px (null: Laser Mode is on but there is no pointer)
 * and the OS reduced-motion preference. `laserQuietDisplayIds` is the desktop's fullscreen rule: unused here.
 */
export interface WebRenderExtras {
  laser?: Point | null;
  laserQuietDisplayIds?: readonly string[];
  reducedMotion?: boolean;
}

/** Reported hit regions are trusted while fresh or while the cat has not moved since (overlayManager). */
export const HIT_REGION_FRESH_MS = 300;
export const HIT_REGION_MOVE_TOLERANCE_PX = 4;
const MAX_ERROR_LOGS = 20;

/** What the pointer router tells the overlay (HostOverlays.pressed / dragging). */
export interface OverlayInputState {
  readonly pressed: boolean;
  readonly dragging: boolean;
}

export interface WebOverlaysOptions {
  display: DisplayService;
  getSettings: () => Settings;
  /** Monotonic ms, the clock the renderer and the router use too (performance.now). */
  clock: () => number;
  logger: Logger;
  /** The cat takes no pointer right now (hidden, paused, interactions off); read live by hitTest. */
  blocked?: () => boolean;
  /** The cat left the page (hidden, out of sight): the router ends its press. */
  onCatGone?: () => void;
  /** Draw hit regions and debug info (OverlayConfig.debug). */
  debug?: boolean;
  /**
   * The floating cat (overlaySurface.ts): called on every render, before the snapshot is mapped to
   * overlay-local coordinates, with the cat's output while the cat or its world-event props are drawn
   * and with null while nothing is (hidden or out of the work area). It may change the display's
   * origin; returning true says it jumped, so this frame snaps (nothing interpolates across a re-origin).
   */
  onPresence?: (out: SimOutput | null, info: PresenceInfo) => boolean | void;
}

export interface WebOverlaysDebug {
  ready: boolean;
  active: boolean;
  renders: number;
  hitReports: number;
  rejectedHitReports: number;
  rendererErrors: number;
  hitRegionAgeMs: number | null;
}

export interface WebOverlays extends HostOverlays {
  /** The in-page bridge for OverlayRuntime (the desktop's preload API, without IPC). */
  readonly api: OverlayApi;
  /** A pointer at `p` (CSS px) goes to the cat: the rules of a desktop overlay deciding to take the mouse. */
  /**
   * `pad` (CSS px, default 0) widens the hit zone: the reported hit regions and the cat's footprint,
   * each grown by it. The floating cat's touch window uses it, so a finger anywhere on that window
   * (the footprint plus a pad) is on the cat.
   */
  hitTest(p: Point, hovering?: boolean, pad?: number): boolean;
  /** The hit region in use right now (CSS px) and its age. */
  effectiveRegion(): { rects: readonly Rect[]; ageMs: number };
  /** The router's press state (HostOverlays.pressed / dragging). */
  bindInput(input: OverlayInputState): void;
  /** The viewport changed: the next frame snaps (the desktop recreates its overlay windows then). */
  onDisplayChanged(): void;
  readonly ready: boolean;
  readonly active: boolean;
  debug(): WebOverlaysDebug;
}

const NO_INPUT: OverlayInputState = Object.freeze({ pressed: false, dragging: false });

export function createWebOverlays(opts: WebOverlaysOptions): WebOverlays {
  const log = opts.logger;
  const renderListeners = new Set<(s: CatRenderState) => void>();
  const configListeners = new Set<(c: OverlayConfig) => void>();
  let input: OverlayInputState = NO_INPUT;
  let ready = false;
  let active = false;
  let activatedAt = 0;
  let needSnap = true;
  let seq = 0;
  let lastOutput: SimOutput | null = null;
  let lastHidden = false;
  let lastState: CatRenderState | null = null;
  let hitRects: Rect[] | null = null;
  let hitAt = 0;
  let hitAnchor: Point | null = null;
  let lastBlocked = false;
  let interactive = false;
  let lastSoundAt: number | null = null;
  let renders = 0;
  let hitReports = 0;
  let rejectedHitReports = 0;
  let rendererErrors = 0;

  function display(): { id: string; scaleFactor: number } | null {
    const d = opts.display.world.displays[0];
    return d ? { id: d.id, scaleFactor: d.scaleFactor } : null;
  }

  function emit<T>(listeners: Set<(v: T) => void>, value: T, what: string): void {
    for (const cb of [...listeners]) {
      try {
        cb(value);
      } catch (err) {
        log.warn(`overlay ${what} listener failed`, { error: err });
      }
    }
  }

  function configFor(): OverlayConfig {
    const d = display();
    return { displayId: d?.id ?? '', scaleFactor: d?.scaleFactor ?? 1, debug: opts.debug === true };
  }

  function blockedNow(): boolean {
    if (!opts.blocked) return lastBlocked;
    try {
      return opts.blocked();
    } catch {
      return true;
    }
  }

  function render(out: SimOutput, simNow: number, hidden: boolean, extras?: WebRenderExtras): void {
    lastOutput = out;
    lastHidden = hidden;
    const settings = opts.getSettings();
    const appearance = settings.appearance;
    const d = opts.display.world.displays[0];
    const catShowing = d ? displaysShowingCat(out, [d], appearance, hidden) : new Set<string>();
    // World-event props are drawn whether or not the cat is on this display (its presence rect is not theirs).
    const propsShowing = d ? displaysShowingProps(out, [d], hidden) : new Set<string>();
    const showing = new Set<string>([...catShowing, ...propsShowing]);
    const catHere = d !== undefined && catShowing.has(d.id);
    const now = opts.clock();
    // A cue is new on its first emission only (by `at`); it is never sent again.
    const cue = out.sound ?? null;
    const newCue = cue !== null && Number.isFinite(cue.at) && cue.at !== lastSoundAt;
    if (newCue) lastSoundAt = cue.at;
    const shown = d !== undefined && showing.has(d.id);
    // Only while Laser Mode is on does the host pass a dot at all; the position is never kept here.
    const laser = extras && extras.laser !== undefined ? extras.laser : undefined;
    try {
      if (opts.onPresence?.(shown ? out : null, { cat: catHere, laser: laser ?? null }) === true) needSnap = true;
    } catch (err) {
      log.warn('overlay presence listener failed', { error: err });
    }
    if (d && showing.has(d.id)) {
      const mapped = mapRenderState(out, appearance, {
        seq: ++seq,
        toLocalDip: (p) => opts.display.toLocalDip(d.id, p),
        scaleFactor: d.scaleFactor,
        forceSnap: !active || needSnap,
        hidden,
        simNow,
        movementSpeed: settings.behavior.movementSpeed,
        soundOwner: settings.sound.enabled && newCue && ready,
        soundVolume: settings.sound.volume,
        displayBoundsPx: d.workAreaPx,
        ...(laser !== undefined ? { laser } : {}),
        // The OS preference (Android: "remove animations") or the user's own switch.
        reducedMotion: extras?.reducedMotion === true || settings.companion.reducedMotion,
      });
      // Props without the cat on this display: still a visible frame, so the renderer draws the props.
      const state = !catHere && !hidden ? { ...mapped, visible: true } : mapped;
      if (!active) {
        active = true;
        activatedAt = now;
        hitRects = null;
      }
      // Never kept for a re-send (ready): a cue is played once.
      lastState = state.sound ? { ...state, sound: null } : state;
      if (ready) {
        emit(renderListeners, state, 'render');
        renders++;
        needSnap = false;
      }
    } else if (active) {
      active = false;
      hitRects = null;
      interactive = false;
      if (lastState) {
        const final = hiddenRenderState(lastState, ++seq, simNow);
        lastState = final;
        if (ready) {
          emit(renderListeners, final, 'render');
          renders++;
        }
      }
      needSnap = true;
      try {
        opts.onCatGone?.();
      } catch (err) {
        log.warn('cat-gone listener failed', { error: err });
      }
    }
  }

  /** overlayManager.effectiveRegions for the one overlay. */
  function effectiveRegion(now: number): { rects: Rect[]; ageMs: number } {
    const out = lastOutput;
    if (!active || !out || !out.visible || lastHidden) return { rects: [], ageMs: Infinity };
    const reported = hitRects !== null && hitAt >= activatedAt;
    const ageMs = Math.max(0, now - (reported ? hitAt : activatedAt));
    if (reported && hitRects) {
      const moved = hitAnchor ? distance(hitAnchor, { x: out.x, y: out.y }) : Infinity;
      if (moved <= HIT_REGION_MOVE_TOLERANCE_PX || ageMs <= HIT_REGION_FRESH_MS) return { rects: hitRects, ageMs };
    }
    return { rects: [out.boundsPx], ageMs };
  }

  function hitTest(p: Point, hovering = false, pad = 0): boolean {
    if (!Number.isFinite(p.x) || !Number.isFinite(p.y)) return false;
    const region = effectiveRegion(opts.clock());
    let rects: readonly Rect[] = region.rects;
    if (pad > 0 && Number.isFinite(pad) && region.rects.length > 0 && lastOutput) {
      // Only while the cat is there to touch (an empty region means hidden, out of view or not yet drawn).
      const grow = (r: Rect): Rect => ({ x: r.x - pad, y: r.y - pad, width: r.width + 2 * pad, height: r.height + 2 * pad });
      rects = [...region.rects, lastOutput.boundsPx].map(grow);
    }
    return decideInteractive({
      cursor: p,
      hitRects: rects,
      interactive: hovering,
      interactionsEnabled: !blockedNow(),
      visible: active,
      // The renderer runs in this page: it is healthy once it is up; a stalled one stops its
      // heartbeat and ages out through hitRegionAgeMs.
      rendererHealthy: ready,
      // The router owns presses; this only decides where one may start.
      dragging: false,
      hitRegionAgeMs: region.ageMs,
    });
  }

  const api: OverlayApi = {
    onRender(cb) {
      renderListeners.add(cb);
      return () => renderListeners.delete(cb);
    },
    onConfig(cb) {
      configListeners.add(cb);
      return () => configListeners.delete(cb);
    },
    // No surface outlines on the web (no window surfaces).
    onSurfaceLines() {
      return () => undefined;
    },
    ready() {
      ready = true;
      emit(configListeners, configFor(), 'config');
      if (active && lastState) {
        emit(renderListeners, { ...lastState, seq: ++seq, snap: true }, 'render');
        renders++;
        needSnap = false;
      }
    },
    // The canvas never receives pointer events (pointer-events: none): the router feeds the gestures.
    sendPointer() {
      return undefined;
    },
    sendHitRegion(region) {
      const parsed = HitRegionSchema.safeParse(region);
      if (!parsed.success) {
        rejectedHitReports++;
        return;
      }
      if (!active) return;
      const d = display();
      const rects: Rect[] = [];
      for (const r of parsed.data.rects) {
        if (r.width <= 0 || r.height <= 0) continue;
        const a = d ? opts.display.fromLocalDip(d.id, { x: r.x, y: r.y }) : { x: r.x, y: r.y };
        const b = d ? opts.display.fromLocalDip(d.id, { x: r.x + r.width, y: r.y + r.height }) : { x: r.x + r.width, y: r.y + r.height };
        rects.push({ x: Math.min(a.x, b.x), y: Math.min(a.y, b.y), width: Math.abs(b.x - a.x), height: Math.abs(b.y - a.y) });
      }
      hitRects = rects;
      hitAt = opts.clock();
      hitAnchor = lastOutput ? { x: lastOutput.x, y: lastOutput.y } : null;
      hitReports++;
    },
    reportError(message) {
      rendererErrors++;
      if (rendererErrors <= MAX_ERROR_LOGS || rendererErrors % 1000 === 0) {
        log.warn('overlay renderer reported an error', { message: String(message).slice(0, 500), count: rendererErrors });
      }
    },
  };

  return {
    api,
    render,
    updateInteractivity(cursorPx, blocked) {
      // Bookkeeping only: there is no window style to switch; the router asks hitTest() per event.
      lastBlocked = blocked;
      interactive = input.pressed || (cursorPx !== null && !blocked && hitTest(cursorPx, interactive));
    },
    isCursorOverCat(cursorPx) {
      if (!cursorPx) return false;
      return cursorInHitZone({ cursor: cursorPx, hitRects: effectiveRegion(opts.clock()).rects, interactive: false });
    },
    get dragging() {
      return input.dragging;
    },
    get pressed() {
      return input.pressed;
    },
    get interactive() {
      return interactive;
    },
    hitTest,
    effectiveRegion: () => effectiveRegion(opts.clock()),
    bindInput(next) {
      input = next;
    },
    onDisplayChanged() {
      needSnap = true;
      if (ready) emit(configListeners, configFor(), 'config');
    },
    get ready() {
      return ready;
    },
    get active() {
      return active;
    },
    debug() {
      const region = effectiveRegion(opts.clock());
      return {
        ready,
        active,
        renders,
        hitReports,
        rejectedHitReports,
        rendererErrors,
        hitRegionAgeMs: Number.isFinite(region.ageMs) ? region.ageMs : null,
      };
    },
  };
}
