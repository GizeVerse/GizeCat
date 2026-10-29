// Overlay manager with Electron mocked: cross-display drags, the renderer hang
// watchdog, lost presses without Win32 button state, the shell integration
// (NonRudeHWND around show/destroy, TaskbarCreated forwarding; MOCKED shell) and the
// taskbar click guard (the real TaskbarTracker over a MOCKED Win32 taskbar).
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Point } from '../../../src/shared/geometry';
import type { OverlayPointerEvent } from '../../../src/shared/ipc';
import { defaultSettings } from '../../../src/shared/settings';
import type { SimEvent, SimOutput } from '../../../src/shared/sim';
import type { DisplayGeometry, WorldGeometry } from '../../../src/shared/world';
import type { DisplayService } from '../../../src/main/contracts';
import type { WindowRegistry } from '../../../src/main/security';
import { createGestureRecognizer } from '../../../src/core/interaction/gestures';
import { createOverlayManager, type OverlayManager, type OverlayManagerOptions } from '../../../src/main/overlay/overlayManager';
import type { Hwnd, RawRect } from '../../../src/main/win32/native';
import { createTaskbarTracker, type TaskbarNative } from '../../../src/main/win32/taskbar';
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
  /** Ordered record of show / destroy / shell calls across all windows. */
  const calls: string[] = [];
  class FakeWebContents extends Emitter {
    readonly id = nextId++;
    readonly sent: { channel: string; payload: unknown }[] = [];
    send(channel: string, payload: unknown): void {
      this.sent.push({ channel, payload });
    }
  }
  class FakeWindow extends Emitter {
    readonly webContents = new FakeWebContents();
    ignoreMouse = true;
    destroyed = false;
    constructor(readonly displayId: string, private readonly bounds: { x: number; y: number; width: number; height: number }) {
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
      calls.push(`destroy:${this.displayId}`);
      this.destroyed = true;
      this.emit('closed');
    }
    /** WM_CLOSE from outside: Electron emits 'close', destroys the window, then emits 'closed'. */
    closeFromOutside(): void {
      this.emit('close', { preventDefault: () => undefined });
      calls.push(`closedFromOutside:${this.displayId}`);
      this.destroyed = true;
      this.emit('closed');
    }
    getBounds() {
      return { ...this.bounds };
    }
    setBounds(): void {}
    showInactive(): void {
      calls.push(`show:${this.displayId}`);
    }
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
  const shell = {
    failSet: false,
    throwOnHook: false,
    hooks: [] as Array<{ displayId: string; cb: () => void }>,
    beforeShow(win: FakeWindow, displayId: string): boolean {
      calls.push(`nonRude:${displayId}`);
      return !shell.failSet;
    },
    beforeDestroy(win: FakeWindow, displayId: string): boolean {
      calls.push(`clearNonRude:${displayId}`);
      return true;
    },
    hookTaskbarCreated(win: FakeWindow, cb: () => void): boolean {
      shell.hooks.push({ displayId: win.displayId, cb });
      return true;
    },
  };
  return { FakeWindow, windows, calls, shell };
});

vi.mock('electron', () => ({ screen: { dipToScreenRect: (_w: unknown, r: unknown) => r } }));
vi.mock('../../../src/main/overlay/overlayWindow', () => ({
  createOverlayShell: () => fakes.shell,
  overlayUrl: (id: string) => `desktop-cat://app/renderer/overlay/index.html?display=${id}`,
  createOverlayWindow: (o: { display: DisplayGeometry }) => {
    const w = new fakes.FakeWindow(o.display.id, o.display.workAreaDip);
    fakes.windows.push(w);
    return w;
  },
}));

type FakeWindow = InstanceType<typeof fakes.FakeWindow>;

function display(id: string, x: number): DisplayGeometry {
  return {
    id,
    primary: x === 0,
    scaleFactor: 1,
    boundsDip: { x, y: 0, width: 1600, height: 900 },
    workAreaDip: { x, y: 0, width: 1600, height: 860 },
    boundsPx: { x, y: 0, width: 1600, height: 900 },
    workAreaPx: { x, y: 0, width: 1600, height: 860 },
  };
}

const world: WorldGeometry = { version: 1, displays: [display('A', 0), display('B', 1600)] };

function serviceFor(w: WorldGeometry): DisplayService {
  return {
    world: w,
    onChange: () => () => undefined,
    toLocalDip: (id, p) => {
      const d = w.displays.find((x) => x.id === id)!;
      return { x: (p.x - d.workAreaPx.x) / d.scaleFactor, y: (p.y - d.workAreaPx.y) / d.scaleFactor };
    },
    fromLocalDip: (id, p) => {
      const d = w.displays.find((x) => x.id === id)!;
      return { x: d.workAreaPx.x + p.x * d.scaleFactor, y: d.workAreaPx.y + p.y * d.scaleFactor };
    },
    displayAt: (p) => w.displays.find((d) => p.x >= d.boundsPx.x && p.x < d.boundsPx.x + d.boundsPx.width)?.id ?? null,
    refresh: () => false,
    dispose: () => undefined,
  };
}

const displayService = serviceFor(world);

const registry: WindowRegistry = { register: () => undefined, unregister: () => undefined, kindOf: () => 'overlay', ids: () => [] };

/** Sim output with the cat's anchor (feet) at `p`, px. */
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
    displayId: p.x < 1600 ? 'A' : 'B',
    support: { kind: 'floor', displayId: 'A' },
    boundsPx: { x: p.x - 42, y: p.y - 64, width: 84, height: 64 },
    nextTickMs: 33,
    requests: [],
    ...over,
  };
}

interface Rig {
  mgr: OverlayManager;
  events: SimEvent[];
  win(id: string): FakeWindow;
  advance(ms: number): void;
  readonly now: number;
  setButton(v: boolean | null): void;
  /** Renderer pointer event from the overlay of `id`, overlay-local DIP. */
  pointer(id: string, kind: OverlayPointerEvent['kind'], x: number, y: number, buttons?: number): void;
  /** Renderer heartbeat / hit-region report around the cat at local (x, y). */
  report(id: string, x: number, y: number): void;
  log: ReturnType<typeof memoryLogger>;
}

let rig: Rig;

function makeRig(extra: Partial<OverlayManagerOptions> = {}): Rig {
  let now = 1000;
  let button: boolean | null = false;
  const events: SimEvent[] = [];
  const log = memoryLogger();
  const mgr = createOverlayManager({
    logger: log,
    display: displayService,
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
    ...extra,
  });
  mgr.start();
  const win = (id: string): FakeWindow => [...fakes.windows].reverse().find((w) => w.displayId === id && !w.destroyed)!;
  for (const d of (extra.display ?? displayService).world.displays) mgr.handleReady(win(d.id).webContents.id);
  return {
    mgr,
    events,
    win,
    log,
    advance(ms) {
      now += ms;
      vi.advanceTimersByTime(ms);
    },
    get now() {
      return now;
    },
    setButton(v) {
      button = v;
    },
    pointer(id, kind, x, y, buttons = kind === 'down' || kind === 'move' ? 1 : 0) {
      mgr.handlePointer(win(id).webContents.id, { kind, x, y, button: kind === 'move' ? -1 : 0, buttons, t: now });
    },
    report(id, x, y) {
      mgr.handleHitRegion(win(id).webContents.id, { rects: [{ x: x - 40, y: y - 60, width: 80, height: 60 }] });
    },
  };
}

const types = (evs: SimEvent[]): string[] => evs.map((e) => e.type);

beforeEach(() => {
  vi.useFakeTimers();
  fakes.windows.length = 0;
  fakes.calls.length = 0;
  fakes.shell.failSet = false;
  fakes.shell.hooks.length = 0;
  rig = makeRig();
});

afterEach(() => {
  rig.mgr.dispose();
  vi.useRealTimers();
});

describe('overlay manager: drags across displays', () => {
  it('keeps the pressing overlay active and the drag alive until the release on the other display', () => {
    const { mgr } = rig;
    let cat = { x: 800, y: 860 };
    mgr.render(output(cat), 1, false);
    rig.report('A', cat.x, cat.y);
    rig.setButton(true);
    rig.pointer('A', 'down', 800, 830);
    mgr.updateInteractivity({ x: 800, y: 830 }, false);
    expect(rig.win('A').ignoreMouse).toBe(false);
    // Drag right across the seam at x = 1600 and on into display B, button held.
    for (let x = 810; x <= 1900; x += 10) {
      rig.advance(8);
      rig.pointer('A', 'move', x, 830);
      cat = { x, y: 860 };
      mgr.render(output(cat), rig.now, false);
      mgr.updateInteractivity({ x, y: 830 }, false);
      if (x % 400 === 0) rig.report('A', x, 860);
    }
    expect(types(rig.events)).toEqual(['pointer.dragStart']);
    expect(mgr.dragging).toBe(true);
    // The cat is entirely on B; A still holds the captured pointer and stays interactive.
    expect(mgr.info().find((o) => o.displayId === 'A')!.active).toBe(true);
    expect(rig.win('A').ignoreMouse).toBe(false);
    expect(mgr.info().find((o) => o.displayId === 'B')!.active).toBe(true);

    // Released over B: the captured 'up' still comes from A (local x beyond A's width).
    rig.advance(8);
    rig.pointer('A', 'up', 1900, 830);
    rig.setButton(false);
    expect(types(rig.events)).toEqual(['pointer.dragStart', 'pointer.dragEnd']);
    const end = rig.events[1] as Extract<SimEvent, { type: 'pointer.dragEnd' }>;
    expect(end.at.x).toBe(1900);
    expect(end.velocity.x).toBeGreaterThan(500);
    expect(mgr.dragging).toBe(false);
    mgr.render(output(cat), rig.now, false);
    mgr.updateInteractivity({ x: 1900, y: 830 }, false);
    expect(mgr.info().find((o) => o.displayId === 'A')!.active).toBe(false);
    expect(rig.win('A').ignoreMouse).toBe(true);
  });

  it('still ends the press when the cat is hidden mid-drag', () => {
    const { mgr } = rig;
    mgr.render(output({ x: 800, y: 860 }), 1, false);
    rig.setButton(true);
    rig.pointer('A', 'down', 800, 830);
    for (let x = 810; x <= 900; x += 10) rig.pointer('A', 'move', x, 830);
    mgr.render(output({ x: 900, y: 860 }), 2, true);
    expect(types(rig.events)).toEqual(['pointer.dragStart', 'pointer.dragEnd']);
    expect(mgr.pressed).toBe(false);
  });
});

describe('overlay manager: hung renderer watchdog', () => {
  /** Shows the cat on A and polls for `ms`, the renderer heartbeating every 500 ms while `beating`. */
  function run(ms: number, opts: { beating: boolean; cursor?: Point; cat?: Point }): void {
    const cat = opts.cat ?? { x: 800, y: 860 };
    for (let t = 0; t < ms; t += 50) {
      rig.advance(50);
      rig.mgr.render(output(cat), rig.now, false);
      if (opts.beating && t % 500 === 0) rig.report('A', cat.x, cat.y);
      rig.mgr.updateInteractivity(opts.cursor ?? { x: 100, y: 100 }, false);
    }
  }

  it('never flags a renderer that keeps its heartbeat, even across a main-process stall', () => {
    run(30_000, { beating: true });
    // Main itself stalls for 20 s (no polls): that silence is not the renderer's.
    rig.advance(20_000);
    rig.mgr.updateInteractivity({ x: 100, y: 100 }, false);
    run(1000, { beating: true });
    expect(rig.win('A').destroyed).toBe(false);
    expect(rig.mgr.info().find((o) => o.displayId === 'A')!.healthy).toBe(true);
    expect(rig.log.entries.filter((e) => e.msg.includes('hung'))).toEqual([]);
  });

  it('stops trusting a silent renderer for hover within the region age limit', () => {
    const cat = { x: 800, y: 860 };
    run(1000, { beating: true, cat });
    const over = { x: 800, y: 830 };
    rig.mgr.updateInteractivity(over, false);
    expect(rig.win('A').ignoreMouse).toBe(false);
    run(2000, { beating: false, cat, cursor: over });
    expect(rig.win('A').ignoreMouse).toBe(true);
    expect(rig.mgr.isCursorOverCat(over)).toBe(true);
  });

  it('ends a drag, forces click-through and recreates the overlay when the renderer goes silent mid-drag', () => {
    const { mgr } = rig;
    run(1000, { beating: true });
    rig.setButton(true);
    rig.pointer('A', 'down', 800, 830);
    for (let x = 810; x <= 900; x += 10) rig.pointer('A', 'move', x, 830);
    expect(mgr.dragging).toBe(true);
    const hungWin = rig.win('A');
    // The renderer hangs; the user keeps holding the button over the frozen cat.
    run(3500, { beating: false, cursor: { x: 900, y: 830 } });
    expect(types(rig.events)).toEqual(['pointer.dragStart', 'pointer.dragEnd']);
    expect(mgr.dragging).toBe(false);
    expect(mgr.pressed).toBe(false);
    expect(hungWin.ignoreMouse).toBe(true);
    expect(hungWin.destroyed).toBe(false);
    // Still silent after the grace period: destroyed and recreated with the crash backoff.
    run(5500, { beating: false, cursor: { x: 900, y: 830 } });
    expect(hungWin.destroyed).toBe(true);
    rig.advance(1000);
    const fresh = rig.win('A');
    expect(fresh).not.toBe(hungWin);
    expect(mgr.count).toBe(2);
  });

  it("ends the drag on 'unresponsive' and recreates unless 'responsive' follows", () => {
    const { mgr } = rig;
    run(500, { beating: true });
    rig.setButton(true);
    rig.pointer('A', 'down', 800, 830);
    for (let x = 810; x <= 900; x += 10) rig.pointer('A', 'move', x, 830);
    const a = rig.win('A');
    a.webContents.emit('unresponsive');
    expect(types(rig.events)).toEqual(['pointer.dragStart', 'pointer.dragEnd']);
    expect(mgr.dragging).toBe(false);
    expect(a.ignoreMouse).toBe(true);
    // Recovers within the grace period: kept.
    run(2000, { beating: false });
    a.webContents.emit('responsive');
    run(8000, { beating: true });
    expect(a.destroyed).toBe(false);
    // Hangs again for good: recreated.
    a.webContents.emit('unresponsive');
    run(6000, { beating: false });
    expect(a.destroyed).toBe(true);
  });

  it('drops input that was queued while hung and treats it as proof of life only', () => {
    run(500, { beating: true });
    const a = rig.win('A');
    a.webContents.emit('unresponsive');
    rig.pointer('A', 'down', 800, 830);
    expect(rig.mgr.pressed).toBe(false);
    rig.pointer('A', 'down', 800, 830);
    expect(rig.mgr.pressed).toBe(true);
  });
});

describe('overlay manager: lost release without Win32 button state', () => {
  beforeEach(() => {
    rig.setButton(null);
    rig.mgr.render(output({ x: 800, y: 860 }), 1, false);
    rig.report('A', 800, 860);
    rig.pointer('A', 'down', 800, 830);
    for (let x = 810; x <= 900; x += 10) {
      rig.advance(8);
      rig.pointer('A', 'move', x, 830);
    }
    rig.mgr.render(output({ x: 900, y: 860 }), 2, false);
    // ... and the 'up' never arrives.
  });

  it('a move without the primary button ends the press', () => {
    rig.advance(16);
    rig.pointer('A', 'move', 905, 830, 0);
    expect(rig.mgr.pressed).toBe(false);
    rig.mgr.updateInteractivity({ x: 1500, y: 200 }, false);
    expect(rig.win('A').ignoreMouse).toBe(true);
  });

  it('a cursor that moves on with no pointer events ends the press', () => {
    for (let i = 0; i < 20; i++) {
      rig.advance(50);
      rig.mgr.updateInteractivity({ x: 1500, y: 200 }, false);
    }
    expect(rig.mgr.pressed).toBe(false);
    expect(rig.mgr.dragging).toBe(false);
    expect(rig.win('A').ignoreMouse).toBe(true);
  });

  it('a still, held press is kept', () => {
    for (let i = 0; i < 200; i++) {
      rig.advance(50);
      if (i % 10 === 0) rig.report('A', 900, 860);
      rig.mgr.updateInteractivity({ x: 902, y: 831 }, false);
    }
    expect(rig.mgr.pressed).toBe(true);
    expect(rig.mgr.dragging).toBe(true);
  });
});

describe('overlay manager: shell integration (NonRudeHWND, TaskbarCreated)', () => {
  it('sets NonRudeHWND right before showInactive and removes it right before destroy', () => {
    rig.win('A').emit('ready-to-show');
    rig.win('B').emit('ready-to-show');
    expect(fakes.calls).toEqual(['nonRude:A', 'show:A', 'nonRude:B', 'show:B']);
    expect(rig.mgr.info().map((o) => [o.displayId, o.nonRude])).toEqual([
      ['A', true],
      ['B', true],
    ]);
    fakes.calls.length = 0;
    rig.mgr.dispose();
    expect(fakes.calls).toEqual(['clearNonRude:A', 'destroy:A', 'clearNonRude:B', 'destroy:B']);
  });

  it('removes the property when the overlay is closed from outside, before Electron destroys it, and once only', () => {
    const a = rig.win('A');
    a.emit('ready-to-show');
    fakes.calls.length = 0;
    a.closeFromOutside(); // e.g. WM_CLOSE from another process: 'close', native destroy, 'closed'
    expect(fakes.calls).toEqual(['clearNonRude:A', 'closedFromOutside:A']);
    expect(rig.log.entries.some((e) => e.msg === 'overlay closed unexpectedly')).toBe(true);
    // Recreated after the backoff; the new window gets (and later loses) its own property.
    rig.advance(1000);
    const fresh = rig.win('A');
    expect(fresh).not.toBe(a);
    fresh.emit('ready-to-show');
    fakes.calls.length = 0;
    rig.mgr.dispose();
    expect(fakes.calls.filter((c) => c.endsWith(':A'))).toEqual(['clearNonRude:A', 'destroy:A']);
  });

  it('removes the property before the window of a crashed renderer is destroyed', () => {
    const a = rig.win('A');
    a.emit('ready-to-show');
    fakes.calls.length = 0;
    a.webContents.emit('render-process-gone', {}, { reason: 'crashed', exitCode: 1 });
    expect(fakes.calls).toEqual(['clearNonRude:A', 'destroy:A']);
  });

  it('shows the overlay anyway when setting the property fails, and does not remove what was never set', () => {
    fakes.shell.failSet = true;
    const a = rig.win('A');
    a.emit('ready-to-show');
    expect(fakes.calls).toEqual(['nonRude:A', 'show:A']);
    expect(rig.mgr.info().find((o) => o.displayId === 'A')!.nonRude).toBe(false);
    fakes.calls.length = 0;
    rig.mgr.dispose();
    expect(fakes.calls.filter((c) => c.startsWith('clearNonRude'))).toEqual([]);
  });

  it('does not hook TaskbarCreated without a consumer', () => {
    expect(fakes.shell.hooks).toEqual([]);
    expect(rig.mgr.info().every((o) => !o.taskbarCreatedHook)).toBe(true);
  });

  it('forwards TaskbarCreated once per broadcast although every overlay receives it', () => {
    rig.mgr.dispose();
    fakes.shell.hooks.length = 0;
    let notified = 0;
    rig = makeRig({ onTaskbarCreated: () => notified++ });
    expect(fakes.shell.hooks.map((h) => h.displayId)).toEqual(['A', 'B']);
    expect(rig.mgr.info().every((o) => o.taskbarCreatedHook)).toBe(true);
    for (const h of fakes.shell.hooks) h.cb();
    expect(notified).toBe(1);
    rig.advance(1500);
    for (const h of fakes.shell.hooks) h.cb();
    expect(notified).toBe(2);
    expect(rig.log.entries.filter((e) => e.msg.startsWith('taskbar re-created'))).toHaveLength(2);
  });

  it('contains a failing TaskbarCreated consumer', () => {
    rig.mgr.dispose();
    fakes.shell.hooks.length = 0;
    rig = makeRig({
      onTaskbarCreated: () => {
        throw new Error('consumer failed');
      },
    });
    expect(() => fakes.shell.hooks[0]!.cb()).not.toThrow();
    expect(rig.log.entries.some((e) => e.level === 'error' && e.msg === 'TaskbarCreated handler failed')).toBe(true);
  });
});

// The probe machine: one 1920x1200 display at 125 %, auto-hide taskbar at the bottom, so the
// work area (and the overlay) is the whole screen and the overlay covers the taskbar.
const MON: RawRect = { left: 0, top: 0, right: 1920, bottom: 1200 };
const TB_HIDDEN: RawRect = { left: 0, top: 1198, right: 1920, bottom: 1258 };
const TB_SHOWN: RawRect = { left: 0, top: 1140, right: 1920, bottom: 1200 };
const P: DisplayGeometry = {
  id: 'P',
  primary: true,
  scaleFactor: 1.25,
  boundsDip: { x: 0, y: 0, width: 1536, height: 960 },
  workAreaDip: { x: 0, y: 0, width: 1536, height: 960 },
  boundsPx: { x: 0, y: 0, width: 1920, height: 1200 },
  workAreaPx: { x: 0, y: 0, width: 1920, height: 1200 },
};
const autoHideWorld: WorldGeometry = { version: 1, displays: [P] };
/** The floor on this display: 4 DIP (5 px) above the screen edge (simWorld). */
const FLOOR_Y = 1195;
/** How far the renderer's hit rects reach below the feet (DIP, measured): stand, sit, sleep, climb. */
const REACHES = [4.6, 7.0, 8.2, 12.5];

/** One primary Shell_TrayWnd whose live rect the test moves (MOCKED Win32). */
function oneTaskbar(rect: RawRect): TaskbarNative & { rect: RawRect } {
  const n = {
    rect,
    findWindow: (cls: string): Hwnd | null => (cls === 'Shell_TrayWnd' ? 100n : null),
    findNextWindow: (): Hwnd | null => null,
    isWindow: () => true,
    isWindowVisible: () => true,
    getWindowRect: (): RawRect => ({ ...n.rect }),
    getMonitorRects: () => ({ monitor: MON, work: MON }),
    appBarState: () => 1,
    appBarTaskbarPos: () => ({ edge: 3, rect: TB_SHOWN }),
    getExStyle: () => 0x88,
  };
  return n;
}

describe('overlay manager: taskbars always get the mouse (click guard)', () => {
  let native: ReturnType<typeof oneTaskbar>;
  let tracker: ReturnType<typeof createTaskbarTracker>;
  /** false: the guard is not wired (the behaviour before it), to show what the cat's region covers. */
  let guard = true;

  beforeEach(() => {
    rig.mgr.dispose();
    fakes.windows.length = 0;
    native = oneTaskbar(TB_HIDDEN);
    guard = true;
    tracker = createTaskbarTracker(memoryLogger(), { native, world: autoHideWorld, now: () => rig.now });
    rig = makeRig({ display: serviceFor(autoHideWorld), excludedRectsPx: () => (guard ? tracker.clickGuardRects() : []) });
    tracker.start();
  });

  /** The taskbar window is moved to `rect` and sampled, as the host does on its poll. */
  function taskbarAt(rect: RawRect): void {
    native.rect = rect;
    rig.advance(16);
    tracker.sample(rig.now, null, true);
  }

  /** Fully revealed and settled (the jump from hidden is eased over 150 ms). */
  function revealed(): void {
    for (let i = 0; i < 12; i++) taskbarAt(TB_SHOWN);
    expect(tracker.taskbars()[0]!.phase).toBe('shown');
  }

  /**
   * Shows the cat with its feet at `feet` (px) and reports a region shaped like the renderer's:
   * head and body, and the legs rect whose paws reach `reach` DIP below the feet.
   */
  function catAt(feet: Point, reach: number, support: SimOutput['support'] = { kind: 'floor', displayId: 'P' }): void {
    rig.mgr.render(output(feet, { displayId: 'P', support, boundsPx: { x: feet.x - 52.5, y: feet.y - 80, width: 105, height: 80 } }), rig.now, false);
    const x = feet.x / 1.25;
    const y = feet.y / 1.25;
    rig.mgr.handleHitRegion(rig.win('P').webContents.id, {
      rects: [
        { x: x - 34, y: y - 60, width: 68, height: 46 },
        { x: x - 30, y: y - 14, width: 60, height: 14 + reach },
      ],
    });
  }

  /** One cursor poll at (x, y); true when the overlay takes the mouse. */
  function poll(x: number, y: number): boolean {
    rig.mgr.updateInteractivity({ x, y }, false);
    return !rig.win('P').ignoreMouse;
  }

  it('keeps the reveal strip of a hidden auto-hide taskbar click-through under a cat standing on the floor', () => {
    expect(tracker.taskbars()[0]).toMatchObject({ autoHide: true, phase: 'hidden' });
    for (const reach of REACHES) {
      catAt({ x: 960, y: FLOOR_Y }, reach);
      // Unguarded, the paws own the 2 px strip (rows 1198-1199): the taskbar could not be revealed there.
      guard = false;
      expect(poll(960, 1199), `unguarded strip, reach ${reach}`).toBe(true);
      guard = true;
      // Guarded: the cursor coming down over the cat (interactive, hysteresis on) onto the strip.
      expect(poll(960, 1150)).toBe(true);
      for (let x = 930; x <= 990; x += 6) {
        // The strip plus the 6 DIP (8 px at 125 %) margin above it.
        for (let y = 1192; y <= 1199; y++) {
          expect(poll(x, y), `${x},${y} reach ${reach}`).toBe(false);
          expect(rig.mgr.isCursorOverCat({ x, y })).toBe(false);
        }
      }
      // Just above the band the legs are the cat's again.
      expect(poll(960, 1191)).toBe(true);
      expect(poll(960, 1192)).toBe(false); // also within the 3 px hysteresis
    }
  });

  it('lets clicks reach a revealed taskbar that slides in under a floor cat (taskbarPlay off: nothing lifts it)', () => {
    catAt({ x: 960, y: FLOOR_Y }, 8.2);
    expect(poll(960, 1150)).toBe(true);
    // Halfway in: its rows are the taskbar's, the cat's rows above it still the cat's.
    taskbarAt({ left: 0, top: 1170, right: 1920, bottom: 1230 });
    expect(poll(960, 1169)).toBe(true);
    expect(poll(960, 1170)).toBe(false);
    revealed();
    // Head and back stick out above the taskbar and stay the cat's.
    expect(poll(960, 1130)).toBe(true);
    for (let x = 920; x <= 1000; x += 8) {
      for (let y = 1140; y < 1200; y += 3) {
        expect(poll(x, y), `${x},${y}`).toBe(false);
        expect(rig.mgr.isCursorOverCat({ x, y })).toBe(false);
      }
    }
    // Hidden again: the whole cat is clickable except the reveal band.
    taskbarAt(TB_HIDDEN);
    expect(poll(960, 1185)).toBe(true);
    expect(poll(960, 1195)).toBe(false);
  });

  it('cuts the taskbar out of the hit region of a cat riding it with its feet at top - 1', () => {
    revealed();
    const ledge = tracker.surfaces()[0]!;
    expect(ledge.y).toBe(1139);
    for (const reach of REACHES) {
      catAt({ x: 960, y: ledge.y }, reach, { kind: 'surface', surfaceId: ledge.id, surfaceKind: 'taskbar', orientation: 'ledge' });
      guard = false;
      expect(poll(960, 1143), `unguarded: paws inside the taskbar, reach ${reach}`).toBe(true);
      guard = true;
      expect(poll(960, 1130)).toBe(true);
      for (let x = 930; x <= 990; x += 6) {
        // Every row the paws reach into (up to 1139 + 12.5 * 1.25), plus the 3 px hysteresis.
        for (let y = 1140; y <= 1158; y++) {
          expect(poll(x, y), `${x},${y} reach ${reach}`).toBe(false);
          expect(rig.mgr.isCursorOverCat({ x, y })).toBe(false);
        }
      }
      expect(poll(960, 1139)).toBe(true);
    }
  });

  it('stays click-through while the exclusion source fails, and says so', () => {
    rig.mgr.dispose();
    fakes.windows.length = 0;
    rig = makeRig({
      display: serviceFor(autoHideWorld),
      excludedRectsPx: () => {
        throw new Error('no taskbar state');
      },
    });
    catAt({ x: 960, y: FLOOR_Y }, 4.6);
    expect(poll(960, 1150)).toBe(false);
    expect(rig.mgr.isCursorOverCat({ x: 960, y: 1150 })).toBe(false);
    expect(rig.log.entries.some((e) => e.level === 'warn' && e.msg.startsWith('click-through exclusions failed'))).toBe(true);
  });
});
