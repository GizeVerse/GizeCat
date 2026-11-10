// The floating cat's page side (1.4.1): what the web bundle does when it runs inside the
// transparent overlay window of the Android foreground service (`index.html?surface=overlay`).
//
// The engine is the same one the app and the browser run (createCatSim, createCatHost,
// OverlayRuntime, the gesture recognizer). Only the "screen" differs:
// - the world is the whole physical screen (overlayDisplay.ts), reported by native in dp;
// - the renderer's canvas is just the small window around the cat. The cat is always drawn at the
//   same place inside it, and the WINDOW moves: every frame the cat is shown, this surface fixes the
//   window's origin from the cat's footprint (so the renderer's overlay-local coordinates are the
//   cat's, constant) and tells native where the window goes. Native moves it with WindowManager;
//   nothing is drawn outside it;
// - touches are not DOM events: native reads them in the window's coordinate-free, raw screen space
//   (a moving window would shift client coordinates under a finger) and sends them as 'ptr'
//   messages, which are turned into the pointer events the router already understands;
// - lifecycle commands (pause, hide, nap while the screen is off, save before the service stops,
//   re-read settings changed in the app) arrive as 'cmd' messages.
//
// Pure apart from the injected bridge and clock: no DOM types, no globals.
import { BODY_MARGIN_BOTTOM_DIP, BODY_MARGIN_SIDE_DIP, BODY_MARGIN_TOP_DIP, EMOTE_MARGIN_TOP_DIP } from '../main/overlay/renderMapping';
import { CAT_BASE_HEIGHT_DIP, CAT_BASE_WIDTH_DIP } from '../shared/cat';
import type { Point, Rect } from '../shared/geometry';
import type { Settings } from '../shared/settings';
import type { SimOutput } from '../shared/sim';
import type { OverlayCommand, OverlayInbound, OverlayOutbound, PointerKind, ScreenMetrics } from './floatingProtocol';
import { createOverlayDisplayService, type OverlayDisplayService } from './overlayDisplay';
import type { RoutedEvent } from './pointerRouter';

/** Size of the window that holds the cat, dp: the footprint plus the room the renderer may draw into (renderMapping.presenceRectPx). */
export function windowSizeDip(appearance: Pick<Settings['appearance'], 'size' | 'emotes'>): { width: number; height: number } {
  const k = appearance.size;
  const top = appearance.emotes ? EMOTE_MARGIN_TOP_DIP : BODY_MARGIN_TOP_DIP;
  return {
    width: (CAT_BASE_WIDTH_DIP + 2 * BODY_MARGIN_SIDE_DIP) * k,
    height: (CAT_BASE_HEIGHT_DIP + top + BODY_MARGIN_BOTTOM_DIP) * k,
  };
}

/**
 * The window's rectangle for a cat whose footprint is `bounds` (world dp): the footprint plus the
 * margins, snapped to whole device pixels (`density` px per dp) so that the cat is drawn at the same
 * sub-pixel position every frame and a window that native rounds to pixels never jitters against it.
 * The origin is rounded to the nearest pixel, the size up.
 */
export function windowRectFor(bounds: Rect, appearance: Pick<Settings['appearance'], 'size' | 'emotes'>, density: number): Rect {
  const k = appearance.size;
  const d = Number.isFinite(density) && density > 0 ? density : 1;
  const size = windowSizeDip(appearance);
  const top = appearance.emotes ? EMOTE_MARGIN_TOP_DIP : BODY_MARGIN_TOP_DIP;
  const snap = (v: number): number => Math.round(v * d) / d;
  const up = (v: number): number => Math.ceil(v * d - 1e-6) / d;
  return { x: snap(bounds.x - BODY_MARGIN_SIDE_DIP * k), y: snap(bounds.y - top * k), width: up(size.width), height: up(size.height) };
}

/** The bridge the surface talks through (floatingBridges.ts connects it to window.gizecatOverlay). */
export interface OverlayPort {
  post(message: OverlayOutbound): void;
  /** Subscribes to native's messages; returns the unsubscribe. */
  onMessage(cb: (m: OverlayInbound) => void): () => void;
}

/** What the surface drives in the page (main.ts passes the real objects). */
export interface OverlayTargets {
  setPaused(paused: boolean): void;
  setHidden(hidden: boolean): void;
  /** The screen went off or on: the same signals a suspended computer sends. */
  onSystem(kind: 'suspend' | 'resume'): void;
  /** Writes the cat to storage now, synchronously; false when it could not. */
  saveNow(): boolean;
  /** Re-reads the settings from storage (changed in the app) and applies them. */
  reloadSettings(): void;
  /** The router's entry point and cancel (a lost or foreign press must end). */
  router: { handle(ev: RoutedEvent): void; cancel(): void };
  getAppearance(): Pick<Settings['appearance'], 'size' | 'emotes'>;
}

export interface OverlaySurface {
  /** The display service for createWebOverlays / createCatHost / the sim's world. */
  readonly display: OverlayDisplayService;
  /** createWebOverlays' onPresence: the cat is drawn (out) or not (null). Fixes the window and reports it. */
  onPresence(out: SimOutput | null): void;
  /** Starts listening to native and says hello. Call once the cat runs. */
  connect(targets: OverlayTargets): () => void;
}

const NOOP_EVENT = { preventDefault() {}, stopPropagation() {} } as const;

/** One native touch as the pointer event the router reads. */
function pointerEvent(kind: PointerKind, id: number, p: Point): RoutedEvent {
  const base = { ...NOOP_EVENT, pointerId: id, pointerType: 'touch', clientX: p.x, clientY: p.y, button: 0 };
  switch (kind) {
    case 'down':
      return { ...base, type: 'pointerdown', buttons: 1 };
    case 'move':
      return { ...base, type: 'pointermove', buttons: 1 };
    case 'up':
      return { ...base, type: 'pointerup', buttons: 0 };
    case 'cancel':
      return { ...base, type: 'pointercancel', buttons: 0 };
  }
}

export function createOverlaySurface(
  initial: ScreenMetrics,
  port: OverlayPort,
  getAppearance: () => Pick<Settings['appearance'], 'size' | 'emotes'>,
  /** The cat takes touches right now (not paused, interactions on, ...); false lets native pass touches through. */
  touchable: () => boolean = () => true,
): OverlaySurface {
  const display = createOverlayDisplayService(initial);
  let lastWin: { x: number; y: number; w: number; h: number; vis: boolean; touch: boolean } | null = null;

  function report(rect: Rect | null): void {
    const size = windowSizeDip(getAppearance());
    const touch = touchable();
    const next = rect
      ? { x: rect.x, y: rect.y, w: rect.width, h: rect.height, vis: true, touch }
      : // Not drawn: keep the last place and size, so native can park the window there, hidden.
        { x: lastWin?.x ?? 0, y: lastWin?.y ?? 0, w: lastWin?.w ?? Math.ceil(size.width), h: lastWin?.h ?? Math.ceil(size.height), vis: false, touch };
    if (lastWin && lastWin.x === next.x && lastWin.y === next.y && lastWin.w === next.w && lastWin.h === next.h && lastWin.vis === next.vis && lastWin.touch === next.touch) return;
    lastWin = next;
    port.post({ t: 'win', ...next });
  }

  /** After a command that can change touchability (pause, resume, ...): say so even when the cat has not moved (a paused host does not tick). */
  function repost(): void {
    if (!lastWin) return;
    const touch = touchable();
    if (touch === lastWin.touch) return;
    lastWin = { ...lastWin, touch };
    port.post({ t: 'win', ...lastWin });
  }

  return {
    display,
    onPresence(out) {
      if (!out) {
        report(null);
        return;
      }
      const rect = windowRectFor(out.boundsPx, getAppearance(), display.metrics.density);
      // Before the renderer's mapping reads it: the cat is then drawn at the same spot of the window every frame.
      display.setOrigin({ x: rect.x, y: rect.y });
      report(rect);
    },
    connect(targets) {
      // A press that native lost (the window was removed, the service stopped) must not leave the cat held.
      const off = port.onMessage((m) => {
        switch (m.t) {
          case 'metrics':
            display.update(m.metrics);
            return;
          case 'ptr':
            targets.router.handle(pointerEvent(m.k, m.id, { x: m.x, y: m.y }));
            return;
          case 'cmd':
            runCommand(m.c, targets, port);
            repost();
            return;
        }
      });
      port.post({ t: 'hello', v: 1 });
      return () => {
        off();
        targets.router.cancel();
      };
    },
  };
}

function runCommand(c: OverlayCommand, t: OverlayTargets, port: OverlayPort): void {
  switch (c) {
    case 'pause':
      t.router.cancel();
      t.setPaused(true);
      return;
    case 'resume':
      t.setPaused(false);
      return;
    case 'hide':
      t.router.cancel();
      t.setHidden(true);
      return;
    case 'show':
      t.setHidden(false);
      return;
    case 'suspend':
      t.router.cancel();
      t.onSystem('suspend');
      return;
    case 'wake':
      t.onSystem('resume');
      return;
    case 'save': {
      // Native waits for this before it destroys the WebView (the service is stopping).
      const ok = ((): boolean => {
        try {
          return t.saveNow();
        } catch {
          return false;
        }
      })();
      port.post({ t: 'saved', ok });
      return;
    }
    case 'reloadSettings':
      t.reloadSettings();
      return;
  }
}
