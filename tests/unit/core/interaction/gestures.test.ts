import { describe, expect, it } from 'vitest';
import type { SimEvent } from '../../../../src/shared/sim';
import { createGestureRecognizer } from '../../../../src/core/interaction/gestures';
import type { GesturePointerEvent, GesturePointerKind } from '../../../../src/core/interaction/gestures';

function driver(opts: Parameters<typeof createGestureRecognizer>[0] = {}) {
  const g = createGestureRecognizer(opts);
  const events: SimEvent[] = [];
  let t = 1000;
  let x = 100;
  let y = 100;
  let buttons = 0;
  const send = (kind: GesturePointerKind, patch: Partial<GesturePointerEvent> = {}) => {
    const e: GesturePointerEvent = { kind, x, y, t, button: kind === 'down' || kind === 'up' ? 0 : -1, buttons, ...patch };
    const out = g.feed(e);
    events.push(...out);
    return out;
  };
  return {
    g,
    events,
    types: () => events.map((e) => e.type),
    wait: (ms: number) => {
      t += ms;
    },
    enter: () => send('enter'),
    leave: () => send('leave'),
    down: () => {
      buttons = 1;
      return send('down');
    },
    up: () => {
      buttons = 0;
      return send('up');
    },
    moveTo: (nx: number, ny: number, dt = 16) => {
      t += dt;
      x = nx;
      y = ny;
      return send('move');
    },
    /** Moves in small steps at `speed` px/s. */
    glide: (dx: number, dy: number, speed: number, stepMs = 16) => {
      const dist = Math.hypot(dx, dy);
      const steps = Math.max(1, Math.round(((dist / speed) * 1000) / stepMs));
      const sx = x;
      const sy = y;
      for (let i = 1; i <= steps; i++) {
        t += stepMs;
        x = sx + (dx * i) / steps;
        y = sy + (dy * i) / steps;
        send('move');
      }
    },
    send,
    pos: () => ({ x, y }),
  };
}

describe('hover', () => {
  it('emits hoverStart/hoverEnd once per transition', () => {
    const d = driver();
    d.enter();
    d.enter();
    d.leave();
    d.leave();
    expect(d.events).toEqual([{ type: 'pointer.hoverStart', at: { x: 100, y: 100 } }, { type: 'pointer.hoverEnd' }]);
  });
});

describe('taps', () => {
  it('recognises a tap', () => {
    const d = driver();
    d.enter();
    d.down();
    d.wait(80);
    expect(d.up()).toEqual([{ type: 'pointer.tap', at: { x: 100, y: 100 } }]);
  });

  it('turns a second quick tap nearby into a double tap, then starts over', () => {
    const d = driver();
    d.down();
    d.wait(60);
    d.up();
    d.wait(150);
    d.moveTo(104, 102, 0);
    d.down();
    d.wait(60);
    d.up();
    d.wait(150);
    d.down();
    d.wait(60);
    d.up();
    expect(d.types()).toEqual(['pointer.tap', 'pointer.doubleTap', 'pointer.tap']);
  });

  it('keeps slow or distant second taps as single taps', () => {
    const slow = driver();
    slow.down();
    slow.wait(50);
    slow.up();
    slow.wait(400);
    slow.down();
    slow.wait(50);
    slow.up();
    expect(slow.types()).toEqual(['pointer.tap', 'pointer.tap']);

    const far = driver();
    far.down();
    far.up();
    far.wait(100);
    far.moveTo(140, 100, 0);
    far.down();
    far.up();
    expect(far.types()).toEqual(['pointer.tap', 'pointer.tap']);
  });

  it('does not tap after a long press', () => {
    const d = driver();
    d.down();
    d.wait(900);
    expect(d.up()).toEqual([]);
  });

  it('ignores non-primary buttons and context events', () => {
    const d = driver();
    d.send('down', { button: 2, buttons: 2 });
    d.send('up', { button: 2, buttons: 0 });
    d.send('context');
    expect(d.events).toEqual([]);
  });
});

describe('drag', () => {
  it('starts after the press moves beyond the threshold, at the press point', () => {
    const d = driver();
    d.down();
    expect(d.moveTo(104, 103)).toEqual([]);
    expect(d.moveTo(110, 100)).toEqual([{ type: 'pointer.dragStart', at: { x: 100, y: 100 } }]);
    expect(d.g.dragging).toBe(true);
  });

  it('reports the release velocity from recent samples', () => {
    const d = driver();
    d.down();
    d.glide(300, 0, 1000); // 1000 px/s to the right
    const out = d.up();
    expect(d.types()).toEqual(['pointer.dragStart', 'pointer.dragEnd']);
    const end = out[0];
    expect(end?.type).toBe('pointer.dragEnd');
    if (end?.type !== 'pointer.dragEnd') return;
    expect(end.at).toEqual(d.pos());
    expect(end.velocity.x).toBeGreaterThan(900);
    expect(end.velocity.x).toBeLessThan(1100);
    expect(Math.abs(end.velocity.y)).toBeLessThan(1);
    expect(d.g.dragging).toBe(false);
  });

  it('reports ~zero velocity when the pointer rested before release', () => {
    const d = driver();
    d.down();
    d.glide(200, 100, 1500);
    d.wait(250);
    const end = d.up()[0];
    expect(end?.type === 'pointer.dragEnd' ? end.velocity : null).toEqual({ x: 0, y: 0 });
  });

  it('clamps absurd release speeds', () => {
    const d = driver({ maxReleaseSpeed: 3000 });
    d.down();
    d.moveTo(110, 100, 16);
    d.moveTo(500, 100, 8);
    const end = d.up()[0];
    const v = end?.type === 'pointer.dragEnd' ? end.velocity : { x: 0, y: 0 };
    expect(Math.hypot(v.x, v.y)).toBeCloseTo(3000, 5);
  });

  it('treats a move without the primary button as a lost release', () => {
    const d = driver();
    d.down();
    d.moveTo(130, 100);
    d.send('move', { buttons: 0, t: 1100 });
    expect(d.types()).toEqual(['pointer.dragStart', 'pointer.dragEnd']);
    expect(d.g.dragging).toBe(false);
  });

  it('ends a drag on cancel with zero velocity', () => {
    const d = driver();
    d.down();
    d.glide(100, 0, 2000);
    const out = d.send('cancel');
    expect(out).toEqual([{ type: 'pointer.dragEnd', at: d.pos(), velocity: { x: 0, y: 0 } }]);
    expect(d.g.dragging).toBe(false);
  });

  it('a drag does not count toward a double tap', () => {
    const d = driver();
    d.down();
    d.up();
    d.wait(50);
    d.down();
    d.moveTo(120, 100);
    d.up();
    expect(d.types()).toEqual(['pointer.tap', 'pointer.dragStart', 'pointer.dragEnd']);
  });
});

describe('petting', () => {
  // ~150 px/s: a calm stroke; 50 px takes ~330 ms, above the 250 ms pet rate limit.
  const stroke = (d: ReturnType<typeof driver>, n: number, width = 50, speed = 150) => {
    for (let i = 0; i < n; i++) d.glide(i % 2 === 0 ? width : -width, 0, speed);
  };

  it('emits one pet per completed back-and-forth stroke', () => {
    const d = driver();
    d.enter();
    stroke(d, 5);
    // Five strokes = four reversals; the last stroke has not reversed yet.
    const pets = d.events.filter((e) => e.type === 'pointer.pet');
    expect(pets).toHaveLength(4);
    for (const p of pets) {
      const strength = p.type === 'pointer.pet' ? p.strength : -1;
      expect(strength).toBeGreaterThan(0);
      expect(strength).toBeLessThanOrEqual(1);
    }
  });

  it('does not pet when the cursor just passes across', () => {
    const d = driver();
    d.enter();
    d.glide(120, 0, 600);
    d.leave();
    expect(d.types()).toEqual(['pointer.hoverStart', 'pointer.hoverEnd']);
  });

  it('requires hover, no buttons and horizontal motion', () => {
    const noHover = driver();
    stroke(noHover, 4);
    expect(noHover.events).toEqual([]);

    const vertical = driver();
    vertical.enter();
    for (let i = 0; i < 4; i++) vertical.glide(i % 2 === 0 ? 20 : -20, i % 2 === 0 ? 60 : -60, 400);
    expect(vertical.types()).toEqual(['pointer.hoverStart']);

    const pressed = driver();
    pressed.enter();
    pressed.down();
    pressed.send('move', { buttons: 1 });
    expect(pressed.types()).toEqual(['pointer.hoverStart']);
  });

  it('rate-limits very fast wiggles', () => {
    const d = driver();
    d.enter();
    for (let i = 0; i < 10; i++) d.glide(i % 2 === 0 ? 24 : -24, 0, 1500, 8);
    const pets = d.events.filter((e) => e.type === 'pointer.pet').length;
    expect(pets).toBeGreaterThan(0);
    expect(pets).toBeLessThan(9);
  });

  it('gives longer strokes more strength than tiny ones', () => {
    const strength = (width: number) => {
      const d = driver();
      d.enter();
      stroke(d, 2, width);
      const p = d.events.find((e) => e.type === 'pointer.pet');
      return p?.type === 'pointer.pet' ? p.strength : -1;
    };
    expect(strength(100)).toBeGreaterThan(strength(25));
    expect(strength(100)).toBeCloseTo(1, 5);
    expect(strength(10)).toBe(-1);
  });

  it('discards a stroke interrupted by a long pause', () => {
    const d = driver();
    d.enter();
    d.glide(50, 0, 400);
    d.wait(600);
    d.glide(-50, 0, 400);
    expect(d.types()).toEqual(['pointer.hoverStart']);
  });
});

describe('robustness', () => {
  it('ignores non-finite input', () => {
    const d = driver();
    expect(d.send('down', { x: NaN })).toEqual([]);
    expect(d.send('up', { t: Infinity })).toEqual([]);
  });

  it('forgets double-tap timing when the time base jumps backwards', () => {
    const d = driver();
    d.down();
    d.up();
    d.send('down', { t: 10 });
    d.send('up', { t: 50, buttons: 0 });
    expect(d.types()).toEqual(['pointer.tap', 'pointer.tap']);
  });

  it('reset clears drag and hover state without events', () => {
    const d = driver();
    d.enter();
    d.down();
    d.moveTo(140, 100);
    d.g.reset();
    expect(d.g.dragging).toBe(false);
    expect(d.g.hovering).toBe(false);
    expect(d.up()).toEqual([]);
  });
});
