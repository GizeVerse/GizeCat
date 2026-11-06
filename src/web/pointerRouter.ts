// Pointer routing for the web host (ADR 0004 §8, M4): the page-level counterpart of the desktop
// overlay manager's click-through rule (T8). The cat's canvas never takes pointer events
// (`pointer-events: none`); this router listens on the document in the capture phase instead:
//
// - A press that starts inside the cat's (fresh) hit region belongs to the cat until it ends: its
//   events are stopped and default-prevented, and the click (and dblclick/auxclick) that follows is
//   swallowed. Every other press, tap, click and hover reaches the page untouched.
// - Mouse and pen hover moves over the cat feed the gesture recognizer as button-less moves, so a
//   back-and-forth stroke pets the cat as on the desktop. Hover is observed, not taken: the page
//   still sees CSS :hover under the cat (only pointer events on the canvas could take that).
// - Touch is translated into the recognizer's mouse vocabulary (gestures.ts is unchanged): a touch
//   that moves more than TOUCH_SLOP_PX before TOUCH_HOLD_MS strokes (pets); one held still for
//   TOUCH_HOLD_MS picks the cat up (a `down`, then moves with the primary button held; a fast
//   release throws); one released earlier is a tap. A touch `contextmenu` (Android long-press) is
//   prevented and ignored. The cat's own touches also have their touch events default-prevented
//   (no page scroll, pull-to-refresh or emulated mouse events under the cat), which needs
//   non-passive touch listeners.
// - Every pointer event updates the cursor the host samples and the time of the last input (the
//   activity monitor's idle source). Keyboard events are never listened to.
//
// Pure: no DOM types; events are read structurally, time and timers are injected.
import type { GestureRecognizer, GesturePointerKind } from '../core/interaction/gestures';
import type { Point } from '../shared/geometry';
import type { SimEvent } from '../shared/sim';

/** A touch held this long without moving picks the cat up (ms). */
export const TOUCH_HOLD_MS = 350;
/** A touch that moves farther than this before the hold strokes the cat (px). */
export const TOUCH_SLOP_PX = 6;
/** After a press the cat owned ends, the click that follows is swallowed for this long (ms). */
export const CLICK_SUPPRESS_MS = 600;
/** A touchstart is matched to the cat's touch pointer within this distance (px). */
const TOUCH_BIND_PX = 24;

/** The fields the router reads from pointer, mouse and touch events (DOM events satisfy it). */
export interface RoutedEvent {
  readonly type: string;
  readonly pointerId?: number;
  readonly pointerType?: string;
  readonly clientX?: number;
  readonly clientY?: number;
  readonly button?: number;
  readonly buttons?: number;
  /** Mouse events: 0 for a click from the keyboard or assistive technology. */
  readonly detail?: number;
  readonly relatedTarget?: unknown;
  readonly changedTouches?: ArrayLike<{ readonly identifier: number; readonly clientX: number; readonly clientY: number }>;
  preventDefault(): void;
  stopPropagation(): void;
  stopImmediatePropagation?(): void;
}

export interface RouterTimers {
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}

export interface RouterState {
  hovering: boolean;
  pressed: boolean;
  dragging: boolean;
}

export interface PointerRouterOptions {
  gestures: GestureRecognizer;
  /** The cat takes a pointer at `p` (CSS px): fresh hit region, visible, healthy, not blocked. `hovering` asks for the hysteresis margin. */
  hitTest: (p: Point, hovering: boolean) => boolean;
  /** Gesture results for the simulation. */
  onSimEvents: (events: SimEvent[]) => void;
  /** Monotonic ms (performance.now in the page). */
  now: () => number;
  timers: RouterTimers;
  /** Hover, press or drag changed (e.g. for the CSS cursor). */
  onStateChange?: (state: RouterState) => void;
  holdMs?: number;
  slopPx?: number;
  clickSuppressMs?: number;
}

/** Where the router listens (the document). */
export interface RouterTarget {
  addEventListener(type: string, listener: (ev: never) => void, options: { capture: boolean; passive?: boolean }): void;
  removeEventListener(type: string, listener: (ev: never) => void, options: { capture: boolean }): void;
}

/**
 * Event types the router listens to, all non-passive (a passive listener cannot prevent the
 * default; the touch ones must not be passive, see the header). No key events, ever.
 */
export const ROUTED_EVENT_TYPES: readonly string[] = Object.freeze([
  'pointerdown',
  'pointermove',
  'pointerup',
  'pointercancel',
  'pointerout',
  'contextmenu',
  'click',
  'dblclick',
  'auxclick',
  'touchstart',
  'touchmove',
  'touchend',
  'touchcancel',
  'selectstart',
  'dragstart',
]);

export type TouchMode = 'pending' | 'stroke' | 'drag';

export interface PointerRouter {
  handle(ev: RoutedEvent): void;
  /** Ends the cat's press and hover without a release (page hidden, window blurred, cat gone). */
  cancel(): void;
  /** Adds the capture-phase listeners to `target`; returns the function that removes them. */
  attach(target: RouterTarget): () => void;
  dispose(): void;
  /** Last pointer position (CSS px), null before the first event or after the pointer left the page. */
  readonly cursor: Point | null;
  /** Time (now()) of the last pointer event of any kind. */
  readonly lastInputAt: number | null;
  readonly hovering: boolean;
  /** The cat owns a press. */
  readonly pressed: boolean;
  /** The cat is being dragged (between the recognizer's dragStart and dragEnd). */
  readonly dragging: boolean;
  /** The kind of the cat's current touch press, null without one. */
  readonly touchMode: TouchMode | null;
}

interface Press {
  id: number;
  kind: 'mouse' | 'touch';
  /** 'mouse' for mouse and pen presses. */
  mode: 'mouse' | TouchMode;
  start: Point;
  t0: number;
  last: Point;
  button: number;
  /** The touchstart that belongs to this press has not been seen yet. */
  bindTouch: boolean;
}

const finite = (v: number | undefined, d: number): number => (typeof v === 'number' && Number.isFinite(v) ? v : d);
const pointOf = (e: RoutedEvent): Point => ({ x: finite(e.clientX, 0), y: finite(e.clientY, 0) });
const dist = (a: Point, b: Point): number => Math.hypot(a.x - b.x, a.y - b.y);

function consume(e: RoutedEvent): void {
  e.preventDefault();
  e.stopPropagation();
  e.stopImmediatePropagation?.();
}

export function createPointerRouter(opts: PointerRouterOptions): PointerRouter {
  const holdMs = opts.holdMs ?? TOUCH_HOLD_MS;
  const slopPx = opts.slopPx ?? TOUCH_SLOP_PX;
  const suppressMs = opts.clickSuppressMs ?? CLICK_SUPPRESS_MS;
  const { gestures, timers } = opts;

  let press: Press | null = null;
  let hovering = false;
  let dragging = false;
  let cursor: Point | null = null;
  let lastInputAt: number | null = null;
  let holdTimer: unknown = null;
  /** The cat's press started a click-suppression window (open while the press lasts, then until suppressUntil). */
  let suppressing = false;
  let suppressUntil = Number.NEGATIVE_INFINITY;
  let lastFedT = Number.NEGATIVE_INFINITY;
  /** Pointers pressed on the page (not the cat): their moves never hover-pet. */
  const pagePresses = new Set<number>();
  /** Touch identifiers of the cat's touches, until their touchend/touchcancel. */
  const ownedTouches = new Set<number>();
  let reported: RouterState = { hovering: false, pressed: false, dragging: false };
  let detach: (() => void) | null = null;

  function notify(): void {
    const next: RouterState = { hovering, pressed: press !== null, dragging };
    if (next.hovering === reported.hovering && next.pressed === reported.pressed && next.dragging === reported.dragging) return;
    reported = next;
    try {
      opts.onStateChange?.(next);
    } catch {
      // A listener's failure must not break input routing.
    }
  }

  function deliver(events: SimEvent[]): void {
    if (events.length === 0) return;
    for (const ev of events) {
      if (ev.type === 'pointer.dragStart') dragging = true;
      else if (ev.type === 'pointer.dragEnd') dragging = false;
    }
    opts.onSimEvents(events);
  }

  /** Feeds the recognizer; timestamps never go backwards (it would forget its timing state). */
  function feed(kind: GesturePointerKind, p: Point, button: number, buttons: number, t = opts.now()): void {
    const at = Math.max(t, lastFedT);
    lastFedT = at;
    deliver(gestures.feed({ kind, x: p.x, y: p.y, t: at, button, buttons }));
  }

  function enterHover(p: Point): void {
    if (hovering) return;
    hovering = true;
    feed('enter', p, -1, 0);
  }

  function leaveHover(p: Point): void {
    if (!hovering) return;
    hovering = false;
    feed('leave', p, -1, 0);
  }

  function clearHold(): void {
    if (holdTimer === null) return;
    timers.clearTimeout(holdTimer);
    holdTimer = null;
  }

  function noteInput(): void {
    lastInputAt = opts.now();
  }

  /** The press is over; the click that follows it is still swallowed for a moment. */
  function finishPress(): void {
    clearHold();
    press = null;
    suppressUntil = opts.now() + suppressMs;
  }

  /** Ends the cat's press without a release (pointercancel, cancel()). */
  function abortPress(p: Press): void {
    clearHold();
    switch (p.mode) {
      case 'mouse':
      case 'drag':
        feed('cancel', p.last, 0, 0);
        break;
      case 'stroke':
        leaveHover(p.last);
        break;
      case 'pending':
        break;
    }
    if (p.kind === 'mouse') leaveHover(p.last);
    // As the desktop's lost press: a drag always ends, with or without the recognizer's dragEnd.
    if (dragging) deliver([{ type: 'pointer.dragEnd', at: { x: p.last.x, y: p.last.y }, velocity: { x: 0, y: 0 } }]);
    finishPress();
  }

  function onHold(): void {
    holdTimer = null;
    const p = press;
    if (!p || p.mode !== 'pending') return;
    p.mode = 'drag';
    // The press began when the finger came down: a release within the tap time is still a tap.
    feed('down', p.start, 0, 1, p.t0);
    notify();
  }

  function onDown(e: RoutedEvent): void {
    noteInput();
    const p = pointOf(e);
    const id = finite(e.pointerId, 0);
    const touch = e.pointerType === 'touch';
    if (press) {
      // One press at a time. Another pointer on the cat is swallowed (it is over the cat), not fed.
      if (id === press.id || opts.hitTest(p, true)) consume(e);
      else pagePresses.add(id);
      return;
    }
    cursor = p;
    if (!opts.hitTest(p, hovering && !touch)) {
      pagePresses.add(id);
      // A press on the page: its click must go through, also right after a press on the cat.
      suppressing = false;
      if (!touch) leaveHover(p);
      return;
    }
    consume(e);
    suppressing = true;
    const t0 = opts.now();
    if (touch) {
      press = { id, kind: 'touch', mode: 'pending', start: p, t0, last: p, button: 0, bindTouch: true };
      holdTimer = timers.setTimeout(onHold, holdMs);
    } else {
      const button = finite(e.button, 0);
      press = { id, kind: 'mouse', mode: 'mouse', start: p, t0, last: p, button, bindTouch: false };
      enterHover(p);
      feed('down', p, button, finite(e.buttons, button === 0 ? 1 : 0), t0);
    }
    notify();
  }

  function onMove(e: RoutedEvent): void {
    noteInput();
    const p = pointOf(e);
    const id = finite(e.pointerId, 0);
    const touch = e.pointerType === 'touch';
    const own = press;
    if (own) {
      if (id !== own.id) return;
      consume(e);
      cursor = p;
      own.last = p;
      switch (own.mode) {
        case 'mouse': {
          const buttons = finite(e.buttons, 0);
          feed('move', p, -1, buttons);
          // The primary button is no longer held: the release was lost (the recognizer took this move as it).
          if (own.button === 0 && (buttons & 1) === 0) {
            finishPress();
            if (!opts.hitTest(p, true)) leaveHover(p);
          }
          break;
        }
        case 'pending':
          if (dist(p, own.start) > slopPx) {
            clearHold();
            own.mode = 'stroke';
            enterHover(own.start);
            feed('move', own.start, -1, 0);
            feed('move', p, -1, 0);
          }
          break;
        case 'stroke':
          feed('move', p, -1, 0);
          break;
        case 'drag':
          feed('move', p, -1, 1);
          break;
      }
      notify();
      return;
    }
    cursor = p;
    // Touch moves of page presses (scrolling) never hover; a mouse or pen held down on the page does not either.
    if (touch) return;
    const buttons = finite(e.buttons, 0);
    if (pagePresses.has(id) || buttons !== 0) {
      leaveHover(p);
      notify();
      return;
    }
    if (opts.hitTest(p, hovering)) {
      enterHover(p);
      feed('move', p, -1, 0);
      // Hover over the cat belongs to the cat: the page's pointermove listeners do not see it.
      e.stopPropagation();
      e.stopImmediatePropagation?.();
    } else {
      leaveHover(p);
    }
    notify();
  }

  function onUp(e: RoutedEvent): void {
    noteInput();
    const p = pointOf(e);
    const id = finite(e.pointerId, 0);
    pagePresses.delete(id);
    const own = press;
    if (!own || id !== own.id) {
      if (e.pointerType !== 'touch') cursor = p;
      return;
    }
    consume(e);
    cursor = p;
    own.last = p;
    switch (own.mode) {
      case 'mouse':
        feed('up', p, finite(e.button, own.button), finite(e.buttons, 0));
        break;
      case 'pending':
        clearHold();
        feed('down', own.start, 0, 1, own.t0);
        feed('up', p, 0, 0);
        break;
      case 'stroke':
        feed('move', p, -1, 0);
        leaveHover(p);
        break;
      case 'drag':
        feed('up', p, 0, 0);
        break;
    }
    finishPress();
    if (own.kind === 'mouse' && !opts.hitTest(p, true)) leaveHover(p);
    notify();
  }

  function onCancel(e: RoutedEvent): void {
    const id = finite(e.pointerId, 0);
    pagePresses.delete(id);
    const own = press;
    if (!own || id !== own.id) return;
    e.stopPropagation();
    e.stopImmediatePropagation?.();
    abortPress(own);
    notify();
  }

  /** pointerout to nowhere: the pointer left the page (or a touch ended). */
  function onOut(e: RoutedEvent): void {
    if (e.relatedTarget !== null && e.relatedTarget !== undefined) return;
    // A press keeps the pointer (the browser keeps delivering moves and the release).
    if (press && finite(e.pointerId, 0) === press.id) return;
    if (e.pointerType !== 'touch') leaveHover(cursor ?? pointOf(e));
    cursor = null;
    notify();
  }

  function onContextMenu(e: RoutedEvent): void {
    // During the cat's press (a touch long-press raises one on Android) and over the cat: no browser
    // menu and nothing for the page. The web host has no menu of its own, so it is ignored.
    if (press || opts.hitTest(pointOf(e), true)) consume(e);
  }

  function onClick(e: RoutedEvent): void {
    // A click from the keyboard or assistive technology (detail 0) never comes from the cat's press.
    if (!suppressing || e.detail === 0) return;
    if (press !== null || opts.now() <= suppressUntil) consume(e);
    else suppressing = false;
  }

  function onTouch(e: RoutedEvent): void {
    const touches = e.changedTouches;
    if (!touches) return;
    const own = press;
    if (e.type === 'touchstart' && own && own.kind === 'touch' && own.bindTouch) {
      // The pointerdown comes first: bind the touch that started where the cat's press did.
      let best: number | null = null;
      let bestD = TOUCH_BIND_PX;
      for (let i = 0; i < touches.length; i++) {
        const t = touches[i];
        if (!t) continue;
        const d = dist({ x: t.clientX, y: t.clientY }, own.start);
        if (d <= bestD) {
          bestD = d;
          best = t.identifier;
        }
      }
      if (best !== null) {
        ownedTouches.add(best);
        own.bindTouch = false;
      }
    }
    let ours = false;
    for (let i = 0; i < touches.length; i++) {
      const t = touches[i];
      if (t && ownedTouches.has(t.identifier)) ours = true;
    }
    if (!ours) return;
    // No scrolling, zooming, emulated mouse events or click for the cat's touch.
    consume(e);
    if (e.type === 'touchend' || e.type === 'touchcancel') {
      for (let i = 0; i < touches.length; i++) {
        const t = touches[i];
        if (t) ownedTouches.delete(t.identifier);
      }
    }
  }

  function handle(e: RoutedEvent): void {
    switch (e.type) {
      case 'pointerdown':
        return onDown(e);
      case 'pointermove':
        return onMove(e);
      case 'pointerup':
        return onUp(e);
      case 'pointercancel':
        return onCancel(e);
      case 'pointerout':
        return onOut(e);
      case 'contextmenu':
        return onContextMenu(e);
      case 'click':
      case 'dblclick':
      case 'auxclick':
        return onClick(e);
      case 'touchstart':
      case 'touchmove':
      case 'touchend':
      case 'touchcancel':
        return onTouch(e);
      case 'selectstart':
      case 'dragstart':
        // No text selection or native drag starts from the cat's press.
        if (press) consume(e);
        return;
      default:
        return;
    }
  }

  function cancel(): void {
    const own = press;
    if (own) abortPress(own);
    if (hovering) leaveHover(cursor ?? { x: 0, y: 0 });
    notify();
  }

  return {
    handle(e) {
      try {
        handle(e);
      } catch {
        // Routing must never break the page: a failure here leaves the event to the page.
      }
    },
    cancel,
    attach(target) {
      detach?.();
      const listener = (ev: never): void => {
        try {
          handle(ev);
        } catch {
          // As handle(): the page keeps the event.
        }
      };
      for (const type of ROUTED_EVENT_TYPES) target.addEventListener(type, listener, { capture: true, passive: false });
      detach = () => {
        for (const type of ROUTED_EVENT_TYPES) target.removeEventListener(type, listener, { capture: true });
        detach = null;
      };
      return detach;
    },
    dispose() {
      cancel();
      detach?.();
      pagePresses.clear();
      ownedTouches.clear();
    },
    get cursor() {
      return cursor;
    },
    get lastInputAt() {
      return lastInputAt;
    },
    get hovering() {
      return hovering;
    },
    get pressed() {
      return press !== null;
    },
    get dragging() {
      return dragging;
    },
    get touchMode() {
      return press && press.kind === 'touch' && press.mode !== 'mouse' ? press.mode : null;
    },
  };
}
