// The web host's pointer router (src/web/pointerRouter.ts): what the cat owns and what reaches the
// page, the touch translation into the (unchanged) gesture recognizer, and click suppression.
import { describe, expect, it } from 'vitest';
import { createGestureRecognizer, type GestureRecognizer, type GesturePointerEvent } from '../../../src/core/interaction/gestures';
import type { Point } from '../../../src/shared/geometry';
import type { SimEvent } from '../../../src/shared/sim';
import { CLICK_SUPPRESS_MS, createPointerRouter, ROUTED_EVENT_TYPES, TOUCH_HOLD_MS, type RoutedEvent, type RouterTarget } from '../../../src/web/pointerRouter';
import { fakeEvent, manualTime } from './helpers';

/** The cat's hit region in these tests (CSS px). */
const CAT = { x: 100, y: 500, width: 100, height: 80 };
const onCat = (p: Point): boolean => p.x >= CAT.x && p.x < CAT.x + CAT.width && p.y >= CAT.y && p.y < CAT.y + CAT.height;

function setup(hit: (p: Point) => boolean = onCat) {
  const time = manualTime(1000);
  const fed: GesturePointerEvent[] = [];
  const real = createGestureRecognizer();
  const gestures: GestureRecognizer = {
    feed: (e) => {
      fed.push(e);
      return real.feed(e);
    },
    get dragging() {
      return real.dragging;
    },
    get hovering() {
      return real.hovering;
    },
    reset: () => real.reset(),
  };
  const sim: SimEvent[] = [];
  const router = createPointerRouter({ gestures, hitTest: hit, onSimEvents: (evs) => sim.push(...evs), now: time.now, timers: time.timers });
  const send = (type: string, init: Partial<RoutedEvent> = {}) => {
    const e = fakeEvent(type, init);
    router.handle(e);
    return e;
  };
  const mouse = {
    down: (x: number, y: number, button = 0) => send('pointerdown', { clientX: x, clientY: y, button, buttons: button === 0 ? 1 : 2 }),
    move: (x: number, y: number, buttons = 0) => send('pointermove', { clientX: x, clientY: y, button: -1, buttons }),
    up: (x: number, y: number, button = 0) => send('pointerup', { clientX: x, clientY: y, button, buttons: 0 }),
  };
  const touch = {
    down: (x: number, y: number, id = 11) => send('pointerdown', { pointerType: 'touch', pointerId: id, clientX: x, clientY: y, button: 0, buttons: 1 }),
    move: (x: number, y: number, id = 11) => send('pointermove', { pointerType: 'touch', pointerId: id, clientX: x, clientY: y, button: -1, buttons: 1 }),
    up: (x: number, y: number, id = 11) => send('pointerup', { pointerType: 'touch', pointerId: id, clientX: x, clientY: y, button: 0, buttons: 0 }),
    cancel: (id = 11) => send('pointercancel', { pointerType: 'touch', pointerId: id }),
    start: (x: number, y: number, identifier = 7) => send('touchstart', { changedTouches: [{ identifier, clientX: x, clientY: y }] }),
    end: (identifier = 7) => send('touchend', { changedTouches: [{ identifier, clientX: 0, clientY: 0 }] }),
  };
  const kinds = () => fed.map((e) => e.kind);
  const types = () => sim.map((e) => e.type);
  return { time, fed, sim, router, send, mouse, touch, kinds, types };
}

/** Back-and-forth hover strokes across the cat at y, `n` legs of `len` px, a move every 30 ms. */
function strokes(move: (x: number, y: number) => unknown, advance: (ms: number) => void, y: number, n = 3, x0 = 115, len = 60): void {
  let x = x0;
  let dir = 1;
  for (let leg = 0; leg < n; leg++) {
    for (let i = 0; i < len / 10; i++) {
      x += 10 * dir;
      advance(30);
      move(x, y);
    }
    dir = -dir;
  }
}

describe('web pointer router: mouse', () => {
  it('leaves a press, its moves and its click on the page untouched when it starts off the cat', () => {
    const h = setup();
    const d = h.mouse.down(600, 100);
    h.time.advance(50);
    const m = h.mouse.move(150, 540, 1);
    const u = h.mouse.up(150, 540);
    const c = h.send('click', { clientX: 150, clientY: 540 });
    for (const e of [d, m, u, c]) expect([e.type, e.prevented, e.stopped]).toEqual([e.type, false, false]);
    // A press held on the page never hovers or pets the cat it passes over.
    expect(h.fed).toEqual([]);
    expect(h.router.pressed).toBe(false);
  });

  it('owns a press on the cat: down and up are consumed, the recognizer taps, the click that follows is swallowed', () => {
    const h = setup();
    const d = h.mouse.down(150, 540);
    expect(d.prevented && d.stopped).toBe(true);
    expect(h.router.pressed).toBe(true);
    h.time.advance(80);
    const u = h.mouse.up(150, 540);
    expect(u.prevented && u.stopped).toBe(true);
    expect(h.types()).toEqual(['pointer.hoverStart', 'pointer.tap']);
    const click = h.send('click', { clientX: 150, clientY: 540 });
    const dbl = h.send('dblclick', { clientX: 150, clientY: 540, detail: 2 });
    expect(click.prevented && click.stopped).toBe(true);
    expect(dbl.prevented && dbl.stopped).toBe(true);
    // Later clicks are the page's again.
    h.time.advance(CLICK_SUPPRESS_MS + 1);
    expect(h.send('click', { clientX: 600, clientY: 100 }).prevented).toBe(false);
  });

  it('gives a page press made right after a press on the cat its click', () => {
    const h = setup();
    h.mouse.down(150, 540);
    h.mouse.up(150, 540);
    h.send('click', { clientX: 150, clientY: 540 });
    h.time.advance(100);
    h.mouse.down(600, 100);
    h.mouse.up(600, 100);
    const c = h.send('click', { clientX: 600, clientY: 100 });
    expect(c.prevented || c.stopped).toBe(false);
  });

  it('never swallows a click from the keyboard or assistive technology (detail 0)', () => {
    const h = setup();
    h.mouse.down(150, 540);
    h.mouse.up(150, 540);
    const k = h.send('click', { clientX: 0, clientY: 0, detail: 0 });
    expect(k.prevented || k.stopped).toBe(false);
  });

  it('drags and throws: dragStart past the threshold, dragEnd with the release velocity', () => {
    const h = setup();
    h.mouse.down(150, 540);
    h.time.advance(16);
    h.mouse.move(160, 530, 1);
    expect(h.types()).toContain('pointer.dragStart');
    expect(h.router.dragging).toBe(true);
    for (const [x, y] of [
      [230, 460],
      [300, 390],
      [370, 320],
    ] as const) {
      h.time.advance(16);
      const m = h.mouse.move(x, y, 1);
      expect(m.prevented && m.stopped).toBe(true);
    }
    h.time.advance(16);
    h.mouse.up(400, 290);
    const end = h.sim.find((e) => e.type === 'pointer.dragEnd');
    expect(end?.type).toBe('pointer.dragEnd');
    const v = end && end.type === 'pointer.dragEnd' ? end.velocity : { x: 0, y: 0 };
    expect(Math.hypot(v.x, v.y)).toBeGreaterThan(1000);
    expect(v.y).toBeLessThan(0);
    expect(h.router.dragging).toBe(false);
    expect(h.router.pressed).toBe(false);
  });

  it('pets on back-and-forth hover: enter, button-less moves, a pet; leaving ends the hover', () => {
    const h = setup();
    const first = h.mouse.move(115, 540);
    // Hover over the cat is the cat's: stopped, but not default-prevented.
    expect([first.stopped, first.prevented]).toEqual([true, false]);
    strokes(h.mouse.move, h.time.advance, 540);
    expect(h.types()[0]).toBe('pointer.hoverStart');
    expect(h.types()).toContain('pointer.pet');
    expect(h.fed.filter((e) => e.kind === 'move').every((e) => e.buttons === 0)).toBe(true);
    const away = h.mouse.move(600, 100);
    expect(away.stopped).toBe(false);
    expect(h.types().at(-1)).toBe('pointer.hoverEnd');
    expect(h.router.hovering).toBe(false);
  });

  it('ends a press whose release was lost (a move without the primary button)', () => {
    const h = setup();
    h.mouse.down(150, 540);
    h.time.advance(40);
    h.mouse.move(151, 541, 0);
    expect(h.router.pressed).toBe(false);
  });

  it('ends a drag on pointercancel with a zero-velocity dragEnd', () => {
    const h = setup();
    h.mouse.down(150, 540);
    h.time.advance(16);
    h.mouse.move(170, 520, 1);
    h.send('pointercancel', { pointerId: 1 });
    expect(h.sim.at(-2)?.type === 'pointer.dragEnd' || h.sim.at(-1)?.type === 'pointer.dragEnd').toBe(true);
    const end = h.sim.find((e) => e.type === 'pointer.dragEnd');
    expect(end && end.type === 'pointer.dragEnd' ? end.velocity : null).toEqual({ x: 0, y: 0 });
    expect([h.router.pressed, h.router.dragging]).toEqual([false, false]);
  });

  it('prevents the browser menu over the cat and leaves it alone elsewhere', () => {
    const h = setup();
    const over = h.send('contextmenu', { clientX: 150, clientY: 540, button: 2 });
    const off = h.send('contextmenu', { clientX: 600, clientY: 100, button: 2 });
    expect(over.prevented && over.stopped).toBe(true);
    expect(off.prevented || off.stopped).toBe(false);
    expect(h.kinds()).not.toContain('context');
  });

  it('forgets the cursor when the pointer leaves the page, but not during the cat press', () => {
    const h = setup();
    h.mouse.move(120, 540);
    expect(h.router.cursor).toEqual({ x: 120, y: 540 });
    h.send('pointerout', { relatedTarget: null, clientX: 120, clientY: 540 });
    expect(h.router.cursor).toBeNull();
    expect(h.types().at(-1)).toBe('pointer.hoverEnd');
    h.mouse.down(150, 540);
    h.send('pointerout', { relatedTarget: null, clientX: 150, clientY: 540 });
    expect(h.router.cursor).toEqual({ x: 150, y: 540 });
    expect(h.router.lastInputAt).toBe(h.time.now());
  });
});

describe('web pointer router: touch translation', () => {
  it('taps: a touch released before the hold without moving feeds down then up (a tap), and its touch events are prevented', () => {
    const h = setup();
    const d = h.touch.down(150, 540);
    const ts = h.touch.start(150, 540);
    expect(d.prevented && d.stopped).toBe(true);
    expect(ts.prevented && ts.stopped).toBe(true);
    expect(h.router.touchMode).toBe('pending');
    h.time.advance(100);
    const u = h.touch.up(151, 540);
    const te = h.touch.end();
    expect(u.prevented && te.prevented).toBe(true);
    expect(h.kinds()).toEqual(['down', 'up']);
    expect(h.fed[0]?.t).toBe(1000);
    expect(h.types()).toEqual(['pointer.tap']);
    expect(h.time.pendingCount).toBe(0);
    // A later touch on the page is the page's.
    expect(h.touch.start(600, 100, 8).prevented).toBe(false);
  });

  it('strokes: a touch that moves before the hold pets with button-less moves and never picks the cat up', () => {
    const h = setup();
    h.touch.down(115, 540);
    h.touch.start(115, 540);
    h.time.advance(40);
    h.touch.move(125, 540);
    expect(h.router.touchMode).toBe('stroke');
    strokes((x, y) => h.touch.move(x, y), h.time.advance, 540, 3, 125);
    h.touch.up(125, 540);
    h.touch.end();
    h.time.advance(TOUCH_HOLD_MS * 3);
    expect(h.kinds()).not.toContain('down');
    expect(h.fed.filter((e) => e.kind === 'move').every((e) => e.buttons === 0)).toBe(true);
    expect(h.types()[0]).toBe('pointer.hoverStart');
    expect(h.types()).toContain('pointer.pet');
    expect(h.types().at(-1)).toBe('pointer.hoverEnd');
    expect(h.types()).not.toContain('pointer.dragStart');
    expect(h.types()).not.toContain('pointer.tap');
  });

  it('holds and drags: still for the hold time, then moves with the primary button; a fast release throws', () => {
    const h = setup();
    h.touch.down(150, 540);
    h.touch.start(150, 540);
    h.time.advance(TOUCH_HOLD_MS);
    expect(h.router.touchMode).toBe('drag');
    expect(h.fed[0]).toMatchObject({ kind: 'down', x: 150, y: 540, t: 1000, button: 0, buttons: 1 });
    for (const y of [520, 470, 420, 370]) {
      h.time.advance(16);
      const m = h.touch.move(150, y);
      expect(m.prevented).toBe(true);
    }
    expect(h.types()).toContain('pointer.dragStart');
    expect(h.fed.filter((e) => e.kind === 'move').every((e) => e.buttons === 1)).toBe(true);
    h.time.advance(16);
    h.touch.up(150, 330);
    const end = h.sim.find((e) => e.type === 'pointer.dragEnd');
    const v = end && end.type === 'pointer.dragEnd' ? end.velocity : { x: 0, y: 0 };
    expect(v.y).toBeLessThan(-1000);
    expect(h.router.touchMode).toBeNull();
    expect(h.router.dragging).toBe(false);
  });

  it('a hold released without moving is a tap within the tap time, nothing after it', () => {
    const quick = setup();
    quick.touch.down(150, 540);
    quick.time.advance(400);
    quick.touch.up(150, 540);
    expect(quick.types()).toEqual(['pointer.tap']);
    const slow = setup();
    slow.touch.down(150, 540);
    slow.time.advance(700);
    slow.touch.up(150, 540);
    expect(slow.types()).toEqual([]);
  });

  it('prevents and ignores a touch long-press contextmenu', () => {
    const h = setup();
    h.touch.down(150, 540);
    h.time.advance(TOUCH_HOLD_MS + 200);
    const c = h.send('contextmenu', { pointerType: 'touch', clientX: 150, clientY: 540, button: 0 });
    expect(c.prevented && c.stopped).toBe(true);
    expect(h.kinds()).not.toContain('context');
    expect(h.router.touchMode).toBe('drag');
  });

  it('leaves touches off the cat to the page: not prevented, not fed, no hover', () => {
    const h = setup();
    const d = h.touch.down(600, 100, 12);
    const ts = h.touch.start(600, 100, 9);
    const m = h.touch.move(150, 540, 12);
    const u = h.touch.up(150, 540, 12);
    for (const e of [d, ts, m, u]) expect(e.prevented || e.stopped).toBe(false);
    expect(h.fed).toEqual([]);
  });

  it('swallows a second finger on the cat without feeding it; a second finger on the page passes', () => {
    const h = setup();
    h.touch.down(150, 540, 11);
    const second = h.touch.down(160, 550, 12);
    const page = h.touch.down(600, 100, 13);
    expect(second.prevented && second.stopped).toBe(true);
    expect(page.prevented || page.stopped).toBe(false);
    h.time.advance(50);
    h.touch.up(150, 540, 11);
    expect(h.kinds()).toEqual(['down', 'up']);
  });

  it('pointercancel ends a stroke (hoverEnd) and a pending touch quietly', () => {
    const h = setup();
    h.touch.down(115, 540);
    h.time.advance(30);
    h.touch.move(130, 540);
    h.touch.cancel();
    expect(h.types().at(-1)).toBe('pointer.hoverEnd');
    expect(h.router.pressed).toBe(false);
    const p = setup();
    p.touch.down(150, 540);
    p.touch.cancel();
    p.time.advance(TOUCH_HOLD_MS * 2);
    expect(p.fed).toEqual([]);
  });

  it('cancel() ends a touch drag with a dragEnd and clears the hover', () => {
    const h = setup();
    h.touch.down(150, 540);
    h.time.advance(TOUCH_HOLD_MS);
    h.time.advance(16);
    h.touch.move(150, 500);
    expect(h.router.dragging).toBe(true);
    h.router.cancel();
    expect(h.types().at(-1)).toBe('pointer.dragEnd');
    expect([h.router.pressed, h.router.dragging, h.router.hovering]).toEqual([false, false, false]);
  });
});

describe('web pointer router: listeners', () => {
  it('listens in the capture phase, non-passive, to pointer, click and touch events only (never keys)', () => {
    const added: Array<{ type: string; capture: boolean; passive?: boolean }> = [];
    const removed: string[] = [];
    const target: RouterTarget = {
      addEventListener: (type, _l, o) => added.push({ type, capture: o.capture, passive: o.passive }),
      removeEventListener: (type) => removed.push(type),
    };
    const h = setup();
    const detach = h.router.attach(target);
    expect(added.map((a) => a.type)).toEqual([...ROUTED_EVENT_TYPES]);
    expect(added.every((a) => a.capture && a.passive === false)).toBe(true);
    expect(added.some((a) => /^key/i.test(a.type))).toBe(false);
    for (const t of ['pointerdown', 'pointermove', 'pointerup', 'pointercancel', 'contextmenu', 'click', 'touchstart', 'touchmove']) expect(added.map((a) => a.type)).toContain(t);
    detach();
    expect(removed).toEqual([...ROUTED_EVENT_TYPES]);
  });

  it('a failing hit test never throws into the page (the event is left to the page)', () => {
    const h = setup(() => {
      throw new Error('boom');
    });
    const d = h.mouse.down(150, 540);
    expect(d.prevented).toBe(false);
  });
});
