// Long-run press path (diagnosis synthesis §3.A; fixes F1, F3, F4, F8): the real overlay manager
// and the real gesture recogniser over MOCKED Electron windows (the FakeWindow rig of
// overlayManager.test.ts), with seeded randomness and an injected main clock. Renderer events carry
// their own renderer-clock timestamps and reach main after a simulated IPC latency; Win32's button
// state is scripted. SIMULATED: no real renderer, IPC, Win32 input or Electron window is involved.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Point } from '../../../src/shared/geometry';
import type { OverlayPointerEvent } from '../../../src/shared/ipc';
import { defaultSettings } from '../../../src/shared/settings';
import type { SimEvent, SimOutput } from '../../../src/shared/sim';
import type { DisplayGeometry, WorldGeometry } from '../../../src/shared/world';
import type { DisplayService } from '../../../src/main/contracts';
import type { WindowRegistry } from '../../../src/main/security';
import { createGestureRecognizer } from '../../../src/core/interaction/gestures';
import { EVERYWHERE } from '../../../src/core/interaction/clickThrough';
import { createOverlayManager, type OverlayManager, type OverlayManagerOptions } from '../../../src/main/overlay/overlayManager';
import { memoryLogger } from './helpers';

const fakes = vi.hoisted(() => {
  type Handler = (...args: unknown[]) => void;
  class Emitter {
    private readonly handlers = new Map<string, Handler[]>();
    on(ev: string, fn: Handler): this {
      this.handlers.set(ev, [...(this.handlers.get(ev) ?? []), fn]);
      return this;
    }
    once(ev: string, fn: Handler): this {
      return this.on(ev, fn);
    }
    emit(ev: string, ...args: unknown[]): void {
      for (const fn of this.handlers.get(ev) ?? []) fn(...args);
    }
  }
  let nextId = 1;
  class FakeWebContents extends Emitter {
    readonly id = nextId++;
    send(): void {}
  }
  type Bounds = { x: number; y: number; width: number; height: number };
  class FakeWindow extends Emitter {
    readonly webContents = new FakeWebContents();
    ignoreMouse = true;
    destroyed = false;
    readonly setBoundsCalls: Bounds[] = [];
    constructor(
      readonly displayId: string,
      public bounds: Bounds,
    ) {
      super();
    }
    setIgnoreMouseEvents(v: boolean): void {
      this.ignoreMouse = v;
    }
    loadURL(): Promise<void> {
      return Promise.resolve();
    }
    isDestroyed(): boolean {
      return this.destroyed;
    }
    destroy(): void {
      this.destroyed = true;
      this.emit('closed');
    }
    getBounds(): Bounds {
      return { ...this.bounds };
    }
    setBounds(b: Bounds): void {
      this.setBoundsCalls.push(b);
      this.bounds = { ...b };
    }
    showInactive(): void {}
    setAlwaysOnTop(): void {}
    isAlwaysOnTop(): boolean {
      return true;
    }
    setContentProtection(): void {}
    getNativeWindowHandle(): Uint8Array {
      return new Uint8Array(8);
    }
    isVisible(): boolean {
      return true;
    }
    isFocusable(): boolean {
      return false;
    }
    getBackgroundColor(): string {
      return '#00000000';
    }
  }
  const windows: FakeWindow[] = [];
  const shell = { beforeShow: () => true, beforeDestroy: () => true, hookTaskbarCreated: () => true };
  return { FakeWindow, windows, shell };
});

vi.mock('electron', () => ({ screen: { dipToScreenRect: (_w: unknown, r: unknown) => r } }));
vi.mock('../../../src/main/overlay/overlayWindow', () => ({
  createOverlayShell: () => fakes.shell,
  overlayUrl: (id: string) => `desktop-cat://app/renderer/overlay/index.html?display=${id}`,
  createOverlayWindow: (o: { display: DisplayGeometry }) => {
    const w = new fakes.FakeWindow(o.display.id, { ...o.display.workAreaDip });
    fakes.windows.push(w);
    return w;
  },
}));

type FakeWindow = InstanceType<typeof fakes.FakeWindow>;
type DragEnd = Extract<SimEvent, { type: 'pointer.dragEnd' }>;

/** Seeded PRNG (mulberry32). */
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const A: DisplayGeometry = {
  id: 'A',
  primary: true,
  scaleFactor: 1,
  boundsDip: { x: 0, y: 0, width: 1600, height: 900 },
  workAreaDip: { x: 0, y: 0, width: 1600, height: 860 },
  boundsPx: { x: 0, y: 0, width: 1600, height: 900 },
  workAreaPx: { x: 0, y: 0, width: 1600, height: 860 },
};
const world: WorldGeometry = { version: 1, displays: [A] };
const registry: WindowRegistry = { register: () => undefined, unregister: () => undefined, kindOf: () => 'overlay', ids: () => [] };

/** The cat's feet at home, the cursor resting on its body, and a point far from it (px = local DIP on A). */
const HOME: Point = { x: 800, y: 860 };
const OVER: Point = { x: 800, y: 830 };
const AWAY: Point = { x: 1400, y: 200 };
const POINTER_TYPES = new Set(['pointer.tap', 'pointer.doubleTap', 'pointer.dragStart', 'pointer.dragEnd']);

function output(p: Point, over: Partial<SimOutput> = {}): SimOutput {
  return {
    x: p.x,
    y: p.y,
    facing: 1,
    state: 'idle',
    clip: 'stand',
    clipStartedAt: 0,
    speed: 0,
    vy: 0,
    look: null,
    arousal: 0,
    contentment: 0.5,
    emote: null,
    emoteStartedAt: 0,
    opacity: 1,
    visible: true,
    snap: false,
    displayId: 'A',
    support: { kind: 'floor', displayId: 'A' },
    boundsPx: { x: p.x - 42, y: p.y - 64, width: 84, height: 64 },
    nextTickMs: 33,
    requests: [],
    ...over,
  };
}

interface PointerInit {
  kind: OverlayPointerEvent['kind'];
  x: number;
  y: number;
  /** Renderer timestamp (the renderer's performance.now()). */
  t: number;
  buttons?: number;
  button?: number;
}

interface Rig {
  mgr: OverlayManager;
  events: SimEvent[];
  log: ReturnType<typeof memoryLogger>;
  readonly now: number;
  /** The renderer's clock: a different time origin than main, plus optional drift and steps. */
  rnow(): number;
  rendererClock(at: number): number;
  skew: number;
  driftPpm: number;
  to(t: number): void;
  advance(ms: number): void;
  setButton(v: boolean | null): void;
  win(): FakeWindow;
  send(ev: PointerInit): void;
  /** The renderer's heartbeat: its hit region around the cat. */
  report(cat?: Point): void;
  show(cat: Point, over?: Partial<SimOutput>): void;
  /** One cursor poll; true when overlay A takes the mouse. */
  poll(cursor: Point | null, blocked?: boolean): boolean;
  cat: Point;
  ready(): void;
  displayChanged(): void;
  excluded: { rects: readonly { x: number; y: number; width: number; height: number }[] | null };
}

let rig: Rig;

function makeRig(extra: Partial<OverlayManagerOptions> = {}): Rig {
  let now = 1000;
  const t0 = now;
  let button: boolean | null = false;
  const events: SimEvent[] = [];
  const log = memoryLogger();
  const displayListeners: Array<(w: WorldGeometry) => void> = [];
  const display: DisplayService = {
    world,
    onChange: (fn) => {
      displayListeners.push(fn);
      return () => undefined;
    },
    toLocalDip: (_id, p) => ({ x: p.x, y: p.y }),
    fromLocalDip: (_id, p) => ({ x: p.x, y: p.y }),
    displayAt: () => 'A',
    refresh: () => false,
    dispose: () => undefined,
  };
  const excluded: Rig['excluded'] = { rects: null };
  const mgr = createOverlayManager({
    logger: log,
    display,
    registry,
    preloadPath: 'preload.js',
    devTools: false,
    debugOverlay: false,
    getSettings: () => defaultSettings(),
    gestures: createGestureRecognizer(),
    onSimEvents: (evs) => events.push(...evs),
    onContextMenu: () => undefined,
    onSessionEnd: () => undefined,
    isLeftButtonDown: () => button,
    clock: () => now,
    excludedRectsPx: () => excluded.rects ?? [],
    ...extra,
  });
  mgr.start();
  const win = (): FakeWindow => [...fakes.windows].reverse().find((w) => w.displayId === 'A' && !w.destroyed)!;
  mgr.handleReady(win().webContents.id);
  const r: Rig = {
    mgr,
    events,
    log,
    excluded,
    get now() {
      return now;
    },
    skew: -987_654.321,
    driftPpm: 0,
    rendererClock(at) {
      return at + r.skew + ((at - t0) * r.driftPpm) / 1e6;
    },
    rnow() {
      return r.rendererClock(now);
    },
    to(t) {
      if (t <= now) return;
      const d = t - now;
      now = t;
      vi.advanceTimersByTime(d);
    },
    advance(ms) {
      r.to(now + ms);
    },
    setButton(v) {
      button = v;
    },
    win,
    send(ev) {
      const buttons = ev.buttons ?? (ev.kind === 'down' || ev.kind === 'move' ? 1 : 0);
      const btn = ev.button ?? (ev.kind === 'move' ? -1 : 0);
      mgr.handlePointer(win().webContents.id, { kind: ev.kind, x: ev.x, y: ev.y, button: btn, buttons, t: ev.t });
    },
    cat: HOME,
    report(cat = r.cat) {
      mgr.handleHitRegion(win().webContents.id, { rects: [{ x: cat.x - 40, y: cat.y - 60, width: 80, height: 60 }] });
    },
    show(cat, over = {}) {
      r.cat = cat;
      mgr.render(output(cat, over), now, false);
    },
    poll(cursor, blocked = false) {
      mgr.updateInteractivity(cursor, blocked);
      return !(win()?.ignoreMouse ?? true);
    },
    ready() {
      mgr.handleReady(win().webContents.id);
    },
    displayChanged() {
      for (const fn of displayListeners) fn(world);
      r.advance(300);
    },
  };
  return r;
}

beforeEach(() => {
  vi.useFakeTimers();
  fakes.windows.length = 0;
  rig = makeRig();
});

afterEach(() => {
  rig.mgr.dispose();
  vi.useRealTimers();
});

const pointerTypes = (evs: SimEvent[]): string[] => evs.filter((e) => POINTER_TYPES.has(e.type)).map((e) => e.type);
const dragEnds = (evs: SimEvent[]): DragEnd[] => evs.filter((e): e is DragEnd => e.type === 'pointer.dragEnd');

/** Ordered actions at main times; each runs with the main clock moved to its time. */
class Timeline {
  private items: { at: number; seq: number; run: () => void }[] = [];
  private seq = 0;
  add(at: number, run: () => void): void {
    this.items.push({ at, seq: this.seq++, run });
  }
  run(r: Rig): void {
    this.items.sort((a, b) => a.at - b.at || a.seq - b.seq);
    for (const it of this.items) {
      r.to(it.at);
      it.run();
    }
    this.items = [];
  }
}

/** Shows the cat at home with a fresh region and rests the cursor on it until the overlay takes the mouse. */
function settleOnCat(): void {
  rig.show(HOME);
  rig.report(HOME);
  rig.advance(16);
  rig.poll(OVER);
  rig.advance(16);
  expect(rig.poll(OVER), 'a floor cat with a live renderer takes the mouse').toBe(true);
}

/** A plain press on the cat (renderer clock = arrival), held `ms`, optionally dragged by `dx`; Win32 truthful. */
function click(ms: number, dx = 0): SimEvent[] {
  const start = rig.events.length;
  settleOnCat();
  rig.setButton(true);
  rig.send({ kind: 'down', ...OVER, t: rig.rnow() });
  const steps = Math.max(1, Math.round(ms / 16));
  for (let i = 1; i <= steps; i++) {
    rig.advance(ms / steps);
    if (dx !== 0) {
      const p = { x: OVER.x + (dx * i) / steps, y: OVER.y };
      rig.send({ kind: 'move', ...p, t: rig.rnow() });
      if (rig.mgr.dragging) rig.show({ x: p.x, y: HOME.y });
      rig.poll(p);
    } else rig.poll(OVER);
  }
  rig.setButton(false);
  rig.send({ kind: 'up', x: OVER.x + dx, y: OVER.y, t: rig.rnow() });
  rig.advance(16);
  rig.poll(AWAY);
  return rig.events.slice(start);
}

function expectSettled(why: string): void {
  expect(rig.mgr.pressed, `${why}: pressed`).toBe(false);
  expect(rig.mgr.dragging, `${why}: dragging`).toBe(false);
  rig.advance(16);
  expect(rig.poll(AWAY), `${why}: click-through once the cursor left`).toBe(false);
}

describe('long run: 5,000 random presses with IPC latency, poll jitter and Win32 truthful, always "up" or unknown (§3.A.1)', () => {
  it('every press ends as the renderer said, with the right speed, and nothing sticks', () => {
    const rand = rng(20261107);
    const modes = ['truthful', 'alwaysUp', 'unknown'] as const;
    const counts = { tap: 0, none: 0, drag: 0 };
    for (let cycle = 0; cycle < 5000; cycle++) {
      const mode = modes[cycle % 3]!;
      rig.setButton(mode === 'unknown' ? null : false);
      settleOnCat();
      const start = rig.events.length;
      const tl = new Timeline();
      const T0 = rig.now + 1 + rand() * 10;
      const D = 20 + rand() * 880;
      const roll = rand();
      const motion = roll < 0.3 ? 'still' : roll < 0.5 ? 'jitter' : 'drag';
      const dx = (rand() < 0.5 ? -1 : 1) * (20 + rand() * 380);
      const dy = (rand() - 0.5) * 120;
      const jitter = (): Point => {
        const a = rand() * Math.PI * 2;
        const r = rand() * 4;
        return { x: OVER.x + Math.cos(a) * r, y: OVER.y + Math.sin(a) * r };
      };
      const at = (t: number): Point => (motion === 'drag' ? { x: OVER.x + (dx * (t - T0)) / D, y: OVER.y + (dy * (t - T0)) / D } : motion === 'jitter' ? jitter() : OVER);
      // The physical samples the renderer sends (moves already coalesced, 8-16 ms apart).
      const samples: { kind: OverlayPointerEvent['kind']; p: Point; at: number; buttons: number }[] = [{ kind: 'down', p: OVER, at: T0, buttons: 1 }];
      if (motion !== 'still') for (let t = T0 + 8 + rand() * 8; t < T0 + D; t += 8 + rand() * 8) samples.push({ kind: 'move', p: at(t), at: t, buttons: 1 });
      const release = motion === 'drag' ? at(T0 + D) : (samples.at(-1)?.p ?? OVER);
      samples.push({ kind: 'up', p: release, at: T0 + D, buttons: 0 });
      // Win32: truthful (down while held), always "up" (GetAsyncKeyState reads 0), or unknown (null).
      if (mode === 'truthful') {
        tl.add(T0, () => rig.setButton(true));
        tl.add(T0 + D, () => rig.setButton(false));
      }
      let cursor: Point = OVER;
      for (const s of samples) tl.add(s.at, () => (cursor = s.p));
      const leaveAt = T0 + D + 420 + rand() * 100;
      tl.add(leaveAt, () => (cursor = AWAY));
      // IPC: in order, 0-20 ms usually, up to 350 ms now and then.
      let delivered = 0;
      for (const s of samples) {
        const lat = rand() < 0.8 ? rand() * 20 : rand() * 350;
        delivered = Math.max(delivered, s.at + lat);
        tl.add(delivered, () => rig.send({ kind: s.kind, x: s.p.x, y: s.p.y, buttons: s.buttons, t: rig.rendererClock(s.at) }));
      }
      tl.add(leaveAt + 5, () => rig.send({ kind: 'leave', x: AWAY.x, y: AWAY.y, buttons: 0, t: rig.rendererClock(leaveAt) }));
      for (let t = T0 - 5; t < leaveAt + 120; t += 8 + rand() * 32) {
        tl.add(t, () => {
          // The sim glues a held cat to the cursor.
          if (rig.mgr.dragging) rig.show({ x: cursor.x, y: cursor.y + 30 });
          rig.poll(cursor);
        });
      }
      for (let t = T0 + 250; t < leaveAt + 120; t += 500) tl.add(t, () => rig.report());
      tl.run(rig);

      // Oracle: the same renderer samples, renderer timestamps, through a fresh recogniser.
      const ref = createGestureRecognizer();
      const expected: SimEvent[] = [];
      for (const s of samples) expected.push(...ref.feed({ kind: s.kind, x: s.p.x, y: s.p.y, button: s.kind === 'move' ? -1 : 0, buttons: s.buttons, t: rig.rendererClock(s.at) }));
      const got = rig.events.slice(start);
      const label = `cycle ${cycle} (${mode}, ${motion}, ${Math.round(D)} ms)`;
      expect(pointerTypes(got), label).toEqual(pointerTypes(expected));
      const maxMove = Math.max(...samples.map((s) => Math.hypot(s.p.x - OVER.x, s.p.y - OVER.y)));
      if (maxMove <= 6) {
        expect(pointerTypes(got), label).toEqual(D <= 600 ? ['pointer.tap'] : []);
        counts[D <= 600 ? 'tap' : 'none']++;
      } else {
        expect(pointerTypes(got), label).toEqual(['pointer.dragStart', 'pointer.dragEnd']);
        const v = dragEnds(got)[0]!.velocity;
        const vr = dragEnds(expected)[0]!.velocity;
        expect(Math.abs(v.x - vr.x), `${label} vx ${v.x} vs ${vr.x}`).toBeLessThanOrEqual(30 + 0.05 * Math.abs(vr.x));
        expect(Math.abs(v.y - vr.y), `${label} vy ${v.y} vs ${vr.y}`).toBeLessThanOrEqual(30 + 0.05 * Math.abs(vr.y));
        counts.drag++;
      }
      expect(rig.mgr.pressed, label).toBe(false);
      expect(rig.mgr.dragging, label).toBe(false);
      expect(rig.win().ignoreMouse, `${label}: click-through once the cursor left`).toBe(true);
      rig.show(HOME);
    }
    const stats = rig.mgr.interactionStats();
    expect(stats.presses).toBe(5000);
    expect(stats.lostPresses).toEqual({ buttonUp: 0, silent: 0, moved: 0 });
    expect(stats.contextCancels).toBe(0);
    // Every kind of outcome was exercised.
    expect(counts.tap).toBeGreaterThan(300);
    expect(counts.none).toBeGreaterThan(100);
    expect(counts.drag).toBeGreaterThan(2000);
    // GetAsyncKeyState reading 0 during long presses is counted, never acted on while the renderer talks.
    expect(stats.win32Disagreements).toBeGreaterThan(100);
  });
});

describe('long run: a release that never arrives (§3.A.2)', () => {
  function dragThenSilence(): number {
    settleOnCat();
    rig.setButton(true);
    rig.send({ kind: 'down', ...OVER, t: rig.rnow() });
    for (let i = 1; i <= 12; i++) {
      rig.advance(8);
      const p = { x: OVER.x + i * 10, y: OVER.y };
      rig.send({ kind: 'move', ...p, t: rig.rnow() });
      rig.show({ x: p.x, y: HOME.y });
      rig.poll(p);
    }
    // Released while moving at 1250 px/s; the renderer's 'up' is lost (its heartbeat goes on).
    rig.setButton(false);
    const releasedAt = rig.now;
    return releasedAt;
  }

  it('Win32 "up" plus a silent renderer ends the press within the bound, as one throw that keeps its speed', () => {
    const releasedAt = dragThenSilence();
    let endedAfter: number | null = null;
    for (let i = 0; i < 200 && endedAfter === null; i++) {
      rig.advance(16);
      if (i % 30 === 0) rig.report();
      if (i === 30) {
        // T8: while main waits for the renderer, a press Win32 calls released no longer holds the
        // whole overlay: away from the cat the click goes to the desktop.
        expect(rig.mgr.pressed).toBe(true);
        expect(rig.poll(AWAY)).toBe(false);
      }
      rig.poll({ x: 920, y: 830 });
      if (dragEnds(rig.events).length > 0) endedAfter = rig.now - releasedAt;
    }
    expect(endedAfter).not.toBeNull();
    expect(endedAfter!).toBeGreaterThan(1500);
    expect(endedAfter!).toBeLessThan(1700);
    expect(pointerTypes(rig.events)).toEqual(['pointer.dragStart', 'pointer.dragEnd']);
    expect(dragEnds(rig.events)[0]!.velocity.x).toBeGreaterThan(900);
    expect(rig.mgr.interactionStats().lostPresses.buttonUp).toBe(1);
    expect(rig.log.entries.some((e) => e.level === 'info' && e.msg.startsWith('pointer press lost') && e.data?.reason === 'buttonUp')).toBe(true);
    // The real 'up', arriving after all, is a no-op; the next press works.
    rig.send({ kind: 'up', x: 920, y: 830, t: rig.rendererClock(releasedAt) });
    expect(dragEnds(rig.events)).toHaveLength(1);
    expect(pointerTypes(click(80))).toEqual(['pointer.tap']);
    expectSettled('after a lost release');
  });

  it('a lost release of a quick tap still ends as that tap, once', () => {
    settleOnCat();
    rig.setButton(true);
    const t = rig.rnow();
    rig.send({ kind: 'down', ...OVER, t });
    rig.advance(16);
    rig.poll(OVER);
    rig.advance(74);
    rig.setButton(false);
    for (let i = 0; i < 120; i++) {
      rig.advance(16);
      if (i % 30 === 0) rig.report();
      rig.poll(OVER);
    }
    expect(pointerTypes(rig.events)).toEqual(['pointer.tap']);
    expect(rig.mgr.pressed).toBe(false);
  });

  it('a renderer that hangs while the button is still held ends the drag once (silent) and the overlay recovers', () => {
    dragThenSilence();
    // Still held (Win32 truthful), and the renderer silent altogether, heartbeat too: the hang
    // watchdog ends the press.
    rig.setButton(true);
    for (let i = 0; i < 300; i++) {
      rig.advance(16);
      rig.poll({ x: 920, y: 830 });
    }
    expect(pointerTypes(rig.events)).toEqual(['pointer.dragStart', 'pointer.dragEnd']);
    expect(rig.mgr.interactionStats().lostPresses).toEqual({ buttonUp: 0, silent: 1, moved: 0 });
    rig.setButton(false);
    expectSettled('after a hang');
    rig.advance(1000);
    rig.ready();
    expect(pointerTypes(click(60))).toEqual(['pointer.tap']);
  });
});

describe('long run: GetAsyncKeyState reads "up" while the button is held (§3.A.3, H1a)', () => {
  it('a drag survives as long as the renderer reports the held button, and so does a still hold within it', () => {
    rig.setButton(false);
    settleOnCat();
    rig.send({ kind: 'down', ...OVER, t: rig.rnow() });
    let x = OVER.x;
    // 1.5 s of moving with buttons=1, polled every 16 ms.
    for (let i = 0; i < 190; i++) {
      rig.advance(8);
      x += 2;
      rig.send({ kind: 'move', x, y: OVER.y, t: rig.rnow() });
      if (i % 2 === 0) {
        rig.show({ x, y: HOME.y });
        rig.poll({ x, y: OVER.y });
      }
      if (i % 60 === 0) rig.report();
    }
    // Holds still for 1.2 s (a captured press sends nothing then).
    for (let i = 0; i < 75; i++) {
      rig.advance(16);
      if (i % 30 === 0) rig.report();
      rig.poll({ x, y: OVER.y });
    }
    expect(pointerTypes(rig.events)).toEqual(['pointer.dragStart']);
    expect(rig.mgr.dragging).toBe(true);
    // Over the held cat the overlay keeps the mouse.
    expect(rig.win().ignoreMouse).toBe(false);
    // Then throws: a fast trail and the release.
    for (let i = 0; i < 8; i++) {
      rig.advance(8);
      x += 12;
      rig.send({ kind: 'move', x, y: OVER.y, t: rig.rnow() });
      rig.poll({ x, y: OVER.y });
    }
    rig.send({ kind: 'up', x, y: OVER.y, t: rig.rnow() });
    expect(pointerTypes(rig.events)).toEqual(['pointer.dragStart', 'pointer.dragEnd']);
    expect(dragEnds(rig.events)[0]!.velocity.x).toBeGreaterThan(1000);
    const stats = rig.mgr.interactionStats();
    expect(stats.lostPresses).toEqual({ buttonUp: 0, silent: 0, moved: 0 });
    expect(stats.win32Disagreements).toBe(1);
    expect(rig.log.entries.filter((e) => e.level === 'info' && e.msg.startsWith('Win32 reports the button up'))).toHaveLength(1);
  });

  it('Win32 stuck at "up": a press held still for 2 s is neither a tap nor cut, and the drag after it works (review findings 4, 5)', () => {
    rig.setButton(false);
    settleOnCat();
    rig.send({ kind: 'down', ...OVER, t: rig.rnow() });
    // A still hold sends nothing; Win32 never sees this press down, so its "up" proves nothing.
    for (let i = 0; i < 125; i++) {
      rig.advance(16);
      if (i % 30 === 0) rig.report();
      rig.poll(OVER);
    }
    expect(pointerTypes(rig.events), 'no tap made up at the first "up" poll, no cut').toEqual([]);
    expect(rig.mgr.pressed).toBe(true);
    // Over the cat the overlay keeps the mouse.
    expect(rig.win().ignoreMouse).toBe(false);
    // Then the drag: it starts, follows and throws as the renderer reports it.
    let x = OVER.x;
    for (let i = 0; i < 30; i++) {
      rig.advance(8);
      x += 8;
      rig.send({ kind: 'move', x, y: OVER.y, t: rig.rnow() });
      if (rig.mgr.dragging) rig.show({ x, y: HOME.y });
      rig.poll({ x, y: OVER.y });
    }
    rig.send({ kind: 'up', x, y: OVER.y, t: rig.rnow() });
    expect(pointerTypes(rig.events)).toEqual(['pointer.dragStart', 'pointer.dragEnd']);
    expect(dragEnds(rig.events)[0]!.velocity.x).toBeGreaterThan(800);
    expect(rig.mgr.interactionStats().lostPresses).toEqual({ buttonUp: 0, silent: 0, moved: 0 });
    expectSettled('after the still hold and the drag');
  });

  it('a fast drag whose cursor runs ahead of the cat keeps the whole overlay while moves arrive (review finding 2, T8 safeguard)', () => {
    rig.setButton(false);
    settleOnCat();
    rig.send({ kind: 'down', ...OVER, t: rig.rnow() });
    const toggles = rig.mgr.interactionStats().ignoreToggles;
    // 1.6 s at 1500 px/s, back and forth; the renderer reports a move every 8 ms. The cat drawn (and
    // its reported region) trails the cursor by 200 ms and updates at 15 Hz, as in the real app.
    const path: Point[] = [];
    let x = OVER.x;
    let dir = 1;
    let offCat = 0;
    let lastShow = Number.NEGATIVE_INFINITY;
    for (let i = 0; i < 200; i++) {
      rig.advance(8);
      x += dir * 12;
      if (x > 1300 || x < 300) dir = -dir;
      const p = { x, y: OVER.y };
      path.push(p);
      rig.send({ kind: 'move', ...p, t: rig.rnow() });
      if (rig.now - lastShow >= 66) {
        lastShow = rig.now;
        const lag = path[Math.max(0, path.length - 1 - 25)]!;
        rig.show({ x: lag.x, y: HOME.y });
        rig.report({ x: lag.x, y: HOME.y });
      }
      if (i % 2 === 1) {
        if (Math.abs(p.x - rig.cat.x) > 44) offCat++;
        expect(rig.poll(p), `poll ${i}: the press keeps the overlay`).toBe(true);
      }
    }
    expect(offCat, 'the cursor was off the cat for most polls').toBeGreaterThan(60);
    expect(rig.mgr.interactionStats().ignoreToggles).toBe(toggles);
    rig.send({ kind: 'up', x, y: OVER.y, t: rig.rnow() });
    expect(pointerTypes(rig.events)).toEqual(['pointer.dragStart', 'pointer.dragEnd']);
    expectSettled('after the fast drag');
  });
});

describe('long run: a genuinely lost release keeps the 400 ms bound (review finding 5)', () => {
  it('Win32 saw the press down, then "up", and the renderer stays silent: the press ends within LOST_PRESS_MS', () => {
    settleOnCat();
    rig.setButton(true);
    rig.send({ kind: 'down', ...OVER, t: rig.rnow() });
    // A still hold of 720 ms (no moves: the 'down' alone says nothing about a drag), Win32 truthful.
    for (let i = 0; i < 45; i++) {
      rig.advance(16);
      if (i % 30 === 0) rig.report();
      rig.poll(OVER);
    }
    rig.setButton(false);
    const releasedAt = rig.now;
    let endedAfter: number | null = null;
    for (let i = 0; i < 150 && endedAfter === null; i++) {
      rig.advance(16);
      if (i % 30 === 0) rig.report();
      rig.poll(OVER);
      if (!rig.mgr.pressed) endedAfter = rig.now - releasedAt;
    }
    expect(endedAfter).not.toBeNull();
    expect(endedAfter!).toBeGreaterThan(400);
    expect(endedAfter!).toBeLessThanOrEqual(400 + 32);
    // Held 720 ms: no tap.
    expect(pointerTypes(rig.events)).toEqual([]);
    expect(rig.mgr.interactionStats().lostPresses).toEqual({ buttonUp: 1, silent: 0, moved: 0 });
    expect(pointerTypes(click(60))).toEqual(['pointer.tap']);
  });
});

describe('long run: main stalls between press and release (§3.A.4)', () => {
  for (const stall of [450, 800, 1500]) {
    it(`a ${stall} ms stall keeps a 90 ms click a tap, with the cursor poll running before the queued release`, () => {
      settleOnCat();
      const t0 = rig.rnow();
      // Physical press at T0, release at T0 + 90; main handles the down, then stalls.
      rig.send({ kind: 'down', ...OVER, t: t0 });
      rig.advance(stall);
      // After the stall the poll runs first (button long up), twice, then the queued 'up'.
      rig.poll(OVER);
      rig.advance(16);
      rig.poll(OVER);
      rig.send({ kind: 'up', ...OVER, t: t0 + 90 });
      expect(pointerTypes(rig.events)).toEqual(['pointer.tap']);
      expectSettled(`stall ${stall}`);
    });

    it(`a ${stall} ms stall with both press and release queued keeps the tap`, () => {
      settleOnCat();
      const t0 = rig.rnow();
      rig.advance(stall);
      rig.poll(OVER);
      rig.send({ kind: 'down', ...OVER, t: t0 });
      rig.poll(OVER);
      rig.send({ kind: 'up', ...OVER, t: t0 + 90 });
      expect(pointerTypes(rig.events)).toEqual(['pointer.tap']);
    });

    it(`a ${stall} ms stall right after the last handled move keeps the throw's speed`, () => {
      settleOnCat();
      rig.setButton(true);
      rig.send({ kind: 'down', ...OVER, t: rig.rnow() });
      for (let i = 1; i <= 10; i++) {
        rig.advance(16);
        rig.send({ kind: 'move', x: OVER.x + i * 20, y: OVER.y, t: rig.rnow() });
        rig.show({ x: OVER.x + i * 20, y: HOME.y });
        rig.poll({ x: OVER.x + i * 20, y: OVER.y });
      }
      // Two more moves and the release happen during the stall; their IPC waits.
      const t = rig.rnow();
      rig.setButton(false);
      rig.advance(stall);
      rig.poll({ x: 1040, y: 830 });
      rig.advance(16);
      rig.poll({ x: 1040, y: 830 });
      rig.send({ kind: 'move', x: 1020, y: OVER.y, t: t + 16 });
      rig.send({ kind: 'move', x: 1040, y: OVER.y, t: t + 32 });
      rig.send({ kind: 'up', x: 1040, y: OVER.y, t: t + 33 });
      expect(pointerTypes(rig.events)).toEqual(['pointer.dragStart', 'pointer.dragEnd']);
      expect(dragEnds(rig.events)[0]!.velocity.x).toBeGreaterThan(1100);
      expect(rig.mgr.interactionStats().lostPresses).toEqual({ buttonUp: 0, silent: 0, moved: 0 });
    });
  }
});

describe('long run: a late release (§3.A.5)', () => {
  function throwWithLateUp(lateMs: number): { releasedAt: number } {
    settleOnCat();
    rig.setButton(true);
    rig.send({ kind: 'down', ...OVER, t: rig.rnow() });
    for (let i = 1; i <= 10; i++) {
      rig.advance(8);
      rig.send({ kind: 'move', x: OVER.x + i * 20, y: OVER.y, t: rig.rnow() });
      rig.show({ x: OVER.x + i * 20, y: HOME.y });
      rig.poll({ x: OVER.x + i * 20, y: OVER.y });
    }
    const releasedAt = rig.rnow();
    rig.setButton(false);
    // The renderer is busy: main keeps polling at 16 ms while the 'up' is in flight.
    for (let t = 0; t < lateMs; t += 16) {
      rig.advance(16);
      if (t % 480 === 0) rig.report();
      rig.poll({ x: 1000, y: 830 });
    }
    return { releasedAt };
  }

  it("an 'up' 450 ms late keeps the throw", () => {
    const { releasedAt } = throwWithLateUp(450);
    expect(rig.mgr.dragging).toBe(true);
    rig.send({ kind: 'up', x: 1000, y: 830, t: releasedAt + 1 });
    expect(pointerTypes(rig.events)).toEqual(['pointer.dragStart', 'pointer.dragEnd']);
    expect(dragEnds(rig.events)[0]!.velocity.x).toBeGreaterThan(2000);
    expect(rig.mgr.interactionStats().lostPresses.buttonUp).toBe(0);
  });

  it("an 'up' later than the bound: the release main makes up keeps the throw, and the real one changes nothing", () => {
    const { releasedAt } = throwWithLateUp(1700);
    expect(pointerTypes(rig.events)).toEqual(['pointer.dragStart', 'pointer.dragEnd']);
    expect(dragEnds(rig.events)[0]!.velocity.x).toBeGreaterThan(1800);
    rig.send({ kind: 'up', x: 1000, y: 830, t: releasedAt + 1 });
    expect(pointerTypes(rig.events)).toEqual(['pointer.dragStart', 'pointer.dragEnd']);
    expectSettled('late up');
  });
});

describe('long run: leaving the cat during a drag (§3.A.6)', () => {
  it('a leave mid-drag and a release outside give exactly one dragEnd', () => {
    settleOnCat();
    rig.send({ kind: 'enter', ...OVER, buttons: 0, t: rig.rnow() });
    rig.setButton(true);
    rig.send({ kind: 'down', ...OVER, t: rig.rnow() });
    for (let i = 1; i <= 30; i++) {
      rig.advance(8);
      const p = { x: OVER.x + i * 15, y: OVER.y - i * 5 };
      if (i === 10) rig.send({ kind: 'leave', ...p, buttons: 1, t: rig.rnow() });
      rig.send({ kind: 'move', ...p, t: rig.rnow() });
      rig.poll(p);
    }
    rig.setButton(false);
    rig.send({ kind: 'up', x: OVER.x + 450, y: OVER.y - 150, t: rig.rnow() });
    expect(pointerTypes(rig.events)).toEqual(['pointer.dragStart', 'pointer.dragEnd']);
    expect(rig.events.filter((e) => e.type === 'pointer.hoverEnd')).toHaveLength(1);
    expectSettled('leave during drag');
  });

  it('a leave mid-drag whose release is lost outside still ends once', () => {
    settleOnCat();
    rig.setButton(true);
    rig.send({ kind: 'down', ...OVER, t: rig.rnow() });
    for (let i = 1; i <= 10; i++) {
      rig.advance(8);
      rig.send({ kind: 'move', x: OVER.x + i * 15, y: OVER.y, t: rig.rnow() });
      rig.poll({ x: OVER.x + i * 15, y: OVER.y });
    }
    rig.send({ kind: 'leave', x: 950, y: 830, buttons: 1, t: rig.rnow() });
    rig.setButton(false);
    for (let i = 0; i < 150; i++) {
      rig.advance(16);
      if (i % 30 === 0) rig.report();
      rig.poll({ x: 1300, y: 300 });
    }
    expect(pointerTypes(rig.events)).toEqual(['pointer.dragStart', 'pointer.dragEnd']);
    expectSettled('lost release outside');
  });
});

describe('long run: a context menu during a press (§3.A.7, H3)', () => {
  it('a right-click during a still press ends it, and the next click is a tap', () => {
    settleOnCat();
    rig.setButton(true);
    rig.send({ kind: 'down', ...OVER, t: rig.rnow() });
    rig.advance(100);
    rig.send({ kind: 'context', ...OVER, button: 2, buttons: 1, t: rig.rnow() });
    expect(rig.mgr.pressed).toBe(false);
    // The menu's modal loop swallows the left release.
    rig.setButton(false);
    for (let i = 0; i < 20; i++) {
      rig.advance(100);
      rig.report();
      rig.poll(OVER);
    }
    expect(pointerTypes(click(60))).toEqual(['pointer.tap']);
    expect(rig.mgr.interactionStats().contextCancels).toBe(1);
  });

  it('a right-click mid-drag ends the drag at once (no throw), even across an overlay recreate', () => {
    settleOnCat();
    rig.setButton(true);
    rig.send({ kind: 'down', ...OVER, t: rig.rnow() });
    for (let i = 1; i <= 6; i++) {
      rig.advance(8);
      rig.send({ kind: 'move', x: OVER.x + i * 10, y: OVER.y, t: rig.rnow() });
    }
    // A right button's own release (button 2) ends nothing: the primary press goes on.
    rig.send({ kind: 'up', x: 860, y: 830, button: 2, buttons: 1, t: rig.rnow() });
    expect(rig.mgr.pressed).toBe(true);
    rig.send({ kind: 'context', x: 860, y: 830, button: 2, buttons: 1, t: rig.rnow() });
    expect(pointerTypes(rig.events)).toEqual(['pointer.dragStart', 'pointer.dragEnd']);
    expect(dragEnds(rig.events)[0]!.velocity).toEqual({ x: 0, y: 0 });
    expect(rig.mgr.dragging).toBe(false);
    rig.setButton(false);
    // The renderer then hangs and is recreated: nothing stale survives it.
    for (let i = 0; i < 120; i++) {
      rig.advance(100);
      rig.poll({ x: 860, y: 830 });
    }
    expect(rig.mgr.dragging).toBe(false);
    expect(pointerTypes(rig.events)).toEqual(['pointer.dragStart', 'pointer.dragEnd']);
    rig.ready();
    expect(pointerTypes(click(60))).toEqual(['pointer.tap']);
  });
});

describe('long run: renderer hang mid-drag, recovery and the recreate budget (§3.A.8, F4)', () => {
  /** Drags, then lets the renderer go silent until the overlay is destroyed; returns the hung window. */
  function hangMidDrag(): FakeWindow {
    settleOnCat();
    rig.setButton(true);
    rig.send({ kind: 'down', ...OVER, t: rig.rnow() });
    for (let i = 1; i <= 8; i++) {
      rig.advance(8);
      rig.send({ kind: 'move', x: OVER.x + i * 10, y: OVER.y, t: rig.rnow() });
      rig.poll({ x: OVER.x + i * 10, y: OVER.y });
    }
    const hung = rig.win();
    let clickThroughAt: number | null = null;
    const start = rig.now;
    while (!hung.destroyed && rig.now - start < 20_000) {
      rig.advance(50);
      rig.poll({ x: 880, y: 830 });
      if (clickThroughAt === null && hung.ignoreMouse) clickThroughAt = rig.now - start;
    }
    rig.setButton(false);
    expect(hung.destroyed).toBe(true);
    expect(clickThroughAt).not.toBeNull();
    expect(clickThroughAt!).toBeLessThanOrEqual(3100);
    return hung;
  }

  it('one dragEnd and click-through at the hang; after the recreate 100 presses work', () => {
    const hung = hangMidDrag();
    expect(pointerTypes(rig.events)).toEqual(['pointer.dragStart', 'pointer.dragEnd']);
    rig.advance(1000);
    expect(rig.win()).not.toBe(hung);
    rig.ready();
    const rand = rng(8);
    for (let i = 0; i < 100; i++) {
      const drag = rand() < 0.5;
      const out = click(drag ? 120 : 60, drag ? 80 : 0);
      expect(pointerTypes(out), `cycle ${i}`).toEqual(drag ? ['pointer.dragStart', 'pointer.dragEnd'] : ['pointer.tap']);
      rig.advance(400);
    }
    expectSettled('after recovery');
    const stats = rig.mgr.interactionStats();
    expect(stats.recreates).toBe(1);
    expect(stats.lostPresses.silent).toBe(1);
  });

  it('six hangs exhaust the budget; the display is retried later, not left without its cat', () => {
    for (let n = 0; n < 6; n++) {
      if (n > 0) {
        // Wait out the backoff of the previous recreate and bring the new renderer up.
        for (let i = 0; i < 40 && rig.mgr.count === 0; i++) rig.advance(1000);
        expect(rig.mgr.count, `recreated after hang ${n}`).toBe(1);
        rig.ready();
      }
      hangMidDrag();
    }
    expect(rig.log.entries.some((e) => e.msg.startsWith('overlay recreate budget exhausted'))).toBe(true);
    rig.advance(59_000);
    expect(rig.mgr.count).toBe(0);
    rig.advance(2000);
    expect(rig.mgr.count).toBe(1);
    rig.ready();
    expect(pointerTypes(click(60))).toEqual(['pointer.tap']);
    expect(rig.mgr.interactionStats().recreates).toBe(6);
  });

  it('resume and display changes retry an exhausted display at once', () => {
    for (let n = 0; n < 6; n++) {
      if (n > 0) {
        for (let i = 0; i < 40 && rig.mgr.count === 0; i++) rig.advance(1000);
        rig.ready();
      }
      hangMidDrag();
    }
    expect(rig.mgr.count).toBe(0);
    rig.mgr.noteResume();
    expect(rig.mgr.count).toBe(1);
    rig.ready();
    // Exhausted again: a display change retries too.
    hangMidDrag();
    expect(rig.mgr.count).toBe(0);
    rig.displayChanged();
    expect(rig.mgr.count).toBe(1);
  });

  it('a renderer that sends its heartbeat only every 2 s is never left healthy but click-through over the cat (§3.A.12)', () => {
    settleOnCat();
    rig.report();
    let deadZone = 0;
    let interactiveStale = 0;
    let lastReport = rig.now;
    for (let t = 0; t < 20_000; t += 16) {
      rig.advance(16);
      if (rig.now - lastReport >= 2000) {
        rig.report();
        lastReport = rig.now;
      }
      const interactive = rig.poll(OVER);
      const healthy = rig.mgr.info()[0]!.healthy;
      if (!interactive && healthy) deadZone++;
      if (interactive && rig.now - lastReport > 1500) interactiveStale++;
    }
    expect(deadZone).toBe(0);
    expect(interactiveStale).toBe(0);
    expect(rig.mgr.interactionStats().staleRegionDenials).toBeGreaterThan(50);
    // Logged, but rate-limited.
    expect(rig.log.entries.filter((e) => e.msg.startsWith('overlay renderer hung')).length).toBeLessThanOrEqual(3);
  });
});

describe('long run: page load failures (§3.A.9, F4)', () => {
  it('a main-frame did-fail-load recreates the overlay; a subframe failure does not', () => {
    const first = rig.win();
    first.webContents.emit('did-fail-load', {}, -105, 'ERR_NAME_NOT_RESOLVED', 'x', false);
    rig.advance(100);
    expect(first.destroyed).toBe(false);
    first.webContents.emit('did-fail-load', {}, -6, 'ERR_FILE_NOT_FOUND', 'x', true);
    expect(first.ignoreMouse).toBe(true);
    rig.advance(1);
    expect(first.destroyed).toBe(true);
    rig.advance(1000);
    const fresh = rig.win();
    expect(fresh).not.toBe(first);
    rig.ready();
    expect(pointerTypes(click(60))).toEqual(['pointer.tap']);
    expect(rig.mgr.interactionStats().recreates).toBe(1);
  });

  it('a page that never reports ready is recreated after the ready timeout', () => {
    // A bare manager whose page never answers.
    rig.mgr.dispose();
    fakes.windows.length = 0;
    let now = 1000;
    const mgr = createOverlayManager({
      logger: memoryLogger(),
      display: { world, onChange: () => () => undefined, toLocalDip: (_i, p) => p, fromLocalDip: (_i, p) => p, displayAt: () => 'A', refresh: () => false, dispose: () => undefined },
      registry,
      preloadPath: 'p',
      devTools: false,
      debugOverlay: false,
      getSettings: () => defaultSettings(),
      gestures: createGestureRecognizer(),
      onSimEvents: () => undefined,
      onContextMenu: () => undefined,
      onSessionEnd: () => undefined,
      isLeftButtonDown: () => false,
      clock: () => now,
    });
    mgr.start();
    const first = fakes.windows[0]!;
    for (let i = 0; i < 31 * 20; i++) {
      now += 50;
      vi.advanceTimersByTime(50);
      mgr.updateInteractivity(AWAY, false);
    }
    expect(first.destroyed).toBe(true);
    now += 1000;
    vi.advanceTimersByTime(1000);
    expect(fakes.windows.filter((w) => !w.destroyed)).toHaveLength(1);
    expect(mgr.interactionStats().recreates).toBe(1);
    mgr.dispose();
  });
});

describe('long run: display changes and resume keep the overlay where it belongs (§3.A.10, review finding 3)', () => {
  it('a kept overlay whose window drifted is recreated, never moved, within the recreate budget; 1-2 px of rounding is left alone', () => {
    let w = rig.win();
    w.emit('ready-to-show');
    expect(w.setBoundsCalls).toHaveLength(0);
    // Fractional-scale rounding (electron#55245): no recreate, no move.
    w.bounds = { x: 1, y: 0, width: 1598, height: 862 };
    rig.displayChanged();
    rig.mgr.noteResume();
    rig.advance(5000);
    expect(rig.win()).toBe(w);
    expect(rig.mgr.interactionStats().recreates).toBe(0);
    // Real drift, found alternately on a display change and on resume: each time the window is swapped
    // for a new one after the recreate backoff (1, 2, 4, 8, 16 s), never moved.
    const backoff = [1000, 2000, 4000, 8000, 16_000];
    for (let n = 0; n < backoff.length; n++) {
      w.bounds = n % 2 === 0 ? { x: 0, y: 40, width: 1600, height: 820 } : { x: 12, y: 0, width: 1588, height: 860 };
      if (n % 2 === 0) rig.displayChanged();
      else rig.mgr.noteResume();
      expect(rig.win(), `drift ${n + 1}: kept until the backoff ends`).toBe(w);
      rig.advance(backoff[n]! + 1);
      expect(w.destroyed, `drift ${n + 1}: swapped`).toBe(true);
      const next = rig.win();
      expect(next).not.toBe(w);
      w = next;
      rig.ready();
      w.emit('ready-to-show');
      expect(pointerTypes(click(60)), `drift ${n + 1}: the new overlay works`).toEqual(['pointer.tap']);
      rig.events.length = 0;
    }
    expect(rig.mgr.interactionStats().recreates).toBe(5);
    // Budget spent (5 in 10 min): the drifted window is left as it is, still never moved.
    w.bounds = { x: 0, y: 40, width: 1600, height: 820 };
    rig.displayChanged();
    rig.advance(60_000);
    expect(rig.win()).toBe(w);
    expect(rig.log.entries.some((e) => e.msg === 'overlay bounds drifted; recreate budget exhausted, leaving it as it is')).toBe(true);
    expect(fakes.windows.every((x) => x.setBoundsCalls.length === 0), 'no overlay window was ever moved').toBe(true);
  });
});

describe('long run: renderer jank, then a low-latency event (review finding 7)', () => {
  it('mapped time never runs backwards per overlay: a double tap across the latency drop is still a double tap', () => {
    settleOnCat();
    const T = rig.now;
    const at = (physical: number): number => rig.rendererClock(physical);
    // Tap 1, queued behind 300 ms of renderer jank: pressed at T, handled at T + 300.
    rig.to(T + 300);
    rig.send({ kind: 'down', ...OVER, t: at(T) });
    // The jank clears: a 2 px wobble is handled at once (the offset estimate drops by 300 ms).
    rig.to(T + 310);
    rig.send({ kind: 'move', x: OVER.x + 2, y: OVER.y, t: at(T + 310) });
    // The release lands in another 300 ms spike, and the second tap, 100 ms later, right behind it.
    rig.to(T + 650);
    rig.send({ kind: 'up', x: OVER.x + 2, y: OVER.y, t: at(T + 350) });
    rig.to(T + 651);
    rig.send({ kind: 'down', ...OVER, t: at(T + 450) });
    rig.to(T + 652);
    rig.send({ kind: 'up', ...OVER, t: at(T + 500) });
    expect(pointerTypes(rig.events)).toEqual(['pointer.tap', 'pointer.doubleTap']);
  });
});

describe('long run: renderer clock outliers (diagnosis M3)', () => {
  it('one event stamped 5 s ahead never pushes later presses into the past', () => {
    settleOnCat();
    rig.send({ kind: 'move', ...OVER, buttons: 0, t: rig.rnow() + 5000 });
    for (const wait of [1000, 4000, 12_000]) {
      rig.advance(wait);
      settleOnCat();
      const start = rig.events.length;
      const t = rig.rnow();
      rig.send({ kind: 'down', ...OVER, t });
      // The poll after the physical release runs before the 'up' arrives (Win32 already "up").
      rig.advance(20);
      rig.poll(OVER);
      rig.send({ kind: 'up', ...OVER, t: t + 15 });
      expect(pointerTypes(rig.events.slice(start)), `${wait} ms after the outlier`).toEqual(['pointer.tap']);
    }
  });
});

describe('long run: 24 simulated hours (§3.A.11, §3.A.13)', () => {
  it('taps stay taps through ±5 s renderer clock steps and 200 ppm drift', () => {
    const rand = rng(11);
    rig.driftPpm = 200;
    let taps = 0;
    for (let minute = 0; minute < 24 * 60; minute++) {
      if (minute % 180 === 90) rig.skew += minute % 360 === 90 ? 5000 : -5000;
      rig.advance(60_000 - 400);
      rig.show(HOME);
      rig.report(HOME);
      // A hover move (with its usual small latency) first, then a quick click.
      rig.send({ kind: 'move', ...OVER, buttons: 0, t: rig.rnow() - rand() * 5 });
      rig.poll(OVER);
      rig.advance(16);
      rig.poll(OVER);
      const t = rig.rnow();
      rig.setButton(true);
      rig.advance(rand() * 10);
      rig.send({ kind: 'down', ...OVER, t });
      const held = 40 + rand() * 120;
      rig.advance(held);
      rig.setButton(false);
      // The poll after the physical release runs before the 'up' arrives.
      rig.advance(5);
      rig.poll(OVER);
      rig.advance(5);
      rig.send({ kind: 'up', ...OVER, t: t + held });
      rig.advance(16);
      rig.poll(AWAY);
      const n = rig.events.filter((e) => e.type === 'pointer.tap' || e.type === 'pointer.doubleTap').length;
      expect(n, `minute ${minute}`).toBe(taps + 1);
      taps = n;
    }
    expect(rig.mgr.interactionStats().lostPresses).toEqual({ buttonUp: 0, silent: 0, moved: 0 });
  });

  it('hover, taps, drags, blocked spells, failing exclusions and resumes every minute: interactive over the cat, click-through elsewhere, never stuck', () => {
    const rand = rng(13);
    let blockedChecks = 0;
    for (let minute = 0; minute < 24 * 60; minute++) {
      rig.advance(60_000 - 1000);
      settleOnCat();
      const action = Math.floor(rand() * 6);
      if (action === 0) {
        // Hover only: interactive over the cat for a while.
        for (let i = 0; i < 10; i++) {
          rig.advance(16);
          expect(rig.poll({ x: OVER.x + i, y: OVER.y }), `minute ${minute} hover`).toBe(true);
        }
      } else if (action === 1) {
        expect(pointerTypes(click(60))).toEqual(['pointer.tap']);
      } else if (action === 2) {
        expect(pointerTypes(click(150, 90))).toEqual(['pointer.dragStart', 'pointer.dragEnd']);
      } else if (action === 3) {
        // Paused / interactions off: click-through over the cat too.
        for (let i = 0; i < 5; i++) {
          rig.advance(16);
          expect(rig.poll(OVER, true), `minute ${minute} blocked`).toBe(false);
          blockedChecks++;
        }
      } else if (action === 4) {
        // A failing exclusion source: click-through over the cat while it fails, interactive after.
        rig.excluded.rects = EVERYWHERE;
        for (let i = 0; i < 5; i++) {
          rig.advance(16);
          expect(rig.poll(OVER), `minute ${minute} fail-closed`).toBe(false);
        }
        rig.excluded.rects = null;
        rig.advance(16);
        expect(rig.poll(OVER)).toBe(true);
      } else {
        rig.mgr.noteResume();
        rig.report();
        rig.advance(16);
        expect(rig.poll(OVER), `minute ${minute} after resume`).toBe(true);
      }
      expectSettled(`minute ${minute}`);
    }
    expect(blockedChecks).toBeGreaterThan(0);
    const stats = rig.mgr.interactionStats();
    expect(stats.lostPresses).toEqual({ buttonUp: 0, silent: 0, moved: 0 });
    expect(stats.failClosedPolls).toBeGreaterThan(100);
    expect(stats.recreates).toBe(0);
  });
});

describe('noteResume', () => {
  it('ends a press left from before the suspend (no release survives it) and forgets the clock offset', () => {
    settleOnCat();
    rig.setButton(true);
    rig.send({ kind: 'down', ...OVER, t: rig.rnow() });
    for (let i = 1; i <= 5; i++) {
      rig.advance(8);
      rig.send({ kind: 'move', x: OVER.x + i * 10, y: OVER.y, t: rig.rnow() });
    }
    expect(rig.mgr.dragging).toBe(true);
    rig.setButton(false);
    rig.advance(3_600_000);
    // The renderer clock stepped while asleep.
    rig.skew -= 7000;
    rig.mgr.noteResume();
    expect(pointerTypes(rig.events)).toEqual(['pointer.dragStart', 'pointer.dragEnd']);
    expect(rig.mgr.pressed).toBe(false);
    expect(rig.log.entries.some((e) => e.level === 'info' && e.msg.startsWith('overlay input state reset'))).toBe(true);
    rig.ready();
    expect(pointerTypes(click(60))).toEqual(['pointer.tap']);
  });
});
