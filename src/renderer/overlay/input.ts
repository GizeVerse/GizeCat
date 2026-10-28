// Raw pointer forwarding: the overlay reports pointer events in overlay-local DIP and
// main recognises gestures. Moves are coalesced to the latest one per animation frame
// and sent at most every MOVE_MIN_INTERVAL_MS, so a 240/360 Hz display does not send
// a move per refresh; every other kind is sent at once (after the pending move).
import type { OverlayPointerEvent } from '../../shared/ipc';

type Kind = OverlayPointerEvent['kind'];

/** At most ~166 moves per second, whatever the refresh rate (main budgets per time). */
export const MOVE_MIN_INTERVAL_MS = 6;

const clampInt = (v: number, lo: number, hi: number): number => (Number.isFinite(v) ? Math.min(hi, Math.max(lo, Math.round(v))) : lo);
const clampCoord = (v: number): number => (Number.isFinite(v) ? Math.min(100000, Math.max(-100000, v)) : 0);

export function toPointerEvent(kind: Kind, x: number, y: number, button: number, buttons: number, t: number): OverlayPointerEvent {
  return {
    kind,
    x: clampCoord(x),
    y: clampCoord(y),
    button: clampInt(button, -1, 4),
    buttons: clampInt(buttons, 0, 31),
    t: Number.isFinite(t) && t > 0 ? t : 0,
  };
}

/** Wires pointer events on `target`; returns a function that removes all listeners. */
export function attachPointerInput(
  target: HTMLElement,
  send: (e: OverlayPointerEvent) => void,
  raf: (cb: FrameRequestCallback) => number = (cb) => requestAnimationFrame(cb),
  cancelRaf: (id: number) => void = (id) => cancelAnimationFrame(id),
): () => void {
  let pendingMove: OverlayPointerEvent | null = null;
  let rafId = 0;
  let lastMoveFrame = Number.NEGATIVE_INFINITY;

  const emit = (e: OverlayPointerEvent): void => {
    try {
      send(e);
    } catch {
      // The bridge can throw while the window is being torn down; input is best effort.
    }
  };
  const flush = (): void => {
    if (rafId !== 0) {
      cancelRaf(rafId);
      rafId = 0;
    }
    if (pendingMove) {
      const m = pendingMove;
      pendingMove = null;
      emit(m);
    }
  };
  const onFrame = (frameTime: number): void => {
    rafId = 0;
    if (!pendingMove) return;
    // Frame timestamps are vsync-aligned, so the rate settles on a whole number of frames.
    if (frameTime - lastMoveFrame < MOVE_MIN_INTERVAL_MS) {
      rafId = raf(onFrame);
      return;
    }
    lastMoveFrame = frameTime;
    flush();
  };
  const make = (kind: Kind, e: PointerEvent | MouseEvent): OverlayPointerEvent =>
    toPointerEvent(kind, e.clientX, e.clientY, kind === 'move' ? -1 : e.button, e.buttons, performance.now());

  const onDown = (e: PointerEvent): void => {
    flush();
    try {
      target.setPointerCapture(e.pointerId);
    } catch {
      // Capture can fail for synthetic or already-released pointers; events still flow.
    }
    emit(make('down', e));
  };
  const onMove = (e: PointerEvent): void => {
    pendingMove = make('move', e);
    if (rafId === 0) rafId = raf(onFrame);
  };
  const onUp = (e: PointerEvent): void => {
    flush();
    emit(make('up', e));
  };
  const onCancel = (e: PointerEvent): void => {
    flush();
    emit(make('cancel', e));
  };
  const onEnter = (e: PointerEvent): void => {
    emit(make('enter', e));
  };
  const onLeave = (e: PointerEvent): void => {
    flush();
    emit(make('leave', e));
  };
  const onContext = (e: MouseEvent): void => {
    e.preventDefault();
    flush();
    emit(make('context', e));
  };

  target.addEventListener('pointerdown', onDown);
  target.addEventListener('pointermove', onMove);
  target.addEventListener('pointerup', onUp);
  target.addEventListener('pointercancel', onCancel);
  target.addEventListener('pointerenter', onEnter);
  target.addEventListener('pointerleave', onLeave);
  target.addEventListener('contextmenu', onContext);
  return () => {
    if (rafId !== 0) cancelRaf(rafId);
    rafId = 0;
    pendingMove = null;
    target.removeEventListener('pointerdown', onDown);
    target.removeEventListener('pointermove', onMove);
    target.removeEventListener('pointerup', onUp);
    target.removeEventListener('pointercancel', onCancel);
    target.removeEventListener('pointerenter', onEnter);
    target.removeEventListener('pointerleave', onLeave);
    target.removeEventListener('contextmenu', onContext);
  };
}
