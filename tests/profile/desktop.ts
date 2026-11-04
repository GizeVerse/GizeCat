// The simulated desktop of the behaviour profile (ADR 0003 §14 layouts): windows, a measured tab
// strip, an auto-hide bottom taskbar and the screen-edge bands, on the reporting user's screen
// (one 1920x1200 display at 125 %, auto-hide bottom taskbar, work area = whole screen).
//
// SIMULATED geometry through the app's own code: provider-shaped surfaces from
// providerSurfacesFromWindows (corner insets, occlusion, a measured tab strip in place of its
// window top), tab strips from the REAL Edge 156 UIA probe geometry through the app's segment
// code, the REAL taskbar tracker over a fake TaskbarNative whose window slides like the user's
// auto-hide taskbar. MOCKED: which windows exist and when they change (scripted per layout),
// and the screen-edge bands (computed here until PRV's computeEdgeBands lands, see edgeBandsFor).
// Never a window title: windows are ids, rects and a process name.
import { BODY_MARGIN_SIDE_DIP } from '../../src/main/overlay/renderMapping';
import { fromWireRect } from '../../src/main/uia/protocol';
import { catExtentPx, computeTabStripSegment, type StripGeometry } from '../../src/main/uia/segment';
import type { RawRect } from '../../src/main/win32/native';
import type { TaskbarNative } from '../../src/main/win32/taskbar';
import { CAT_BASE_WIDTH_DIP } from '../../src/shared/cat';
import type { Point, Rect } from '../../src/shared/geometry';
import type { SimEvent } from '../../src/shared/sim';
import { MAX_EDGE_SPANS, type ScreenEdgeBand, type Surface } from '../../src/shared/surfaces';
import type { WindowInfo } from '../../src/shared/world';
import { probeStrip, WORLD } from '../integration/surfaces/pipeline';
import { providerSurfacesFromWindows, type StripSpec } from '../unit/core/behavior/fixtures';
import { TYPICAL_FRAME } from '../unit/core/behavior/liveness';
import type { VirtualClock } from './clock';
import { MIN } from './metrics';

export const SCREEN_W = 1920;
export const SCREEN_H = 1200;
export const SCALE = 1.25;
export const DISPLAY_ID = WORLD.displays[0]!.id;

/**
 * L1 floating browser with a strip; L2 floating editor; L3 L1 alternating every 10 min with a
 * maximized window in front; L4 nothing reachable but the screen edges (no app window);
 * L4b a maximized window in front most of the time (the user's commonest state);
 * L3c fast churn of the strip's window (covered by another window, maximized, minimized; B13);
 * L1d the browser dragged around every 20-60 s (window-drag churn; B9, B14);
 * L5 two floating windows side by side, low enough to jump from (B4: one tall window offers two ways down, §6.3).
 */
export type LayoutId = 'L1' | 'L2' | 'L3' | 'L4' | 'L4b' | 'L3c' | 'L1d' | 'L5';
export const LAYOUT_IDS: readonly LayoutId[] = ['L1', 'L2', 'L3', 'L4', 'L4b', 'L3c', 'L1d', 'L5'];

// Not integer-like: providerSurfacesFromWindows reads its windows front first in key order, and JS
// orders integer-like keys numerically, not by insertion ('1003' would land behind '1001').
export const CHROME_ID = 'w-browser';
export const APP_ID = 'w-app';
export const SECOND_ID = 'w-second';
export const MAX_ID = 'w-max';
export const COVER_ID = 'w-cover';
/** L1/L3: a floating Chrome-like window in front (TYPICAL_FRAME: sides end ~235 px above the floor, top ~1075 px up). */
export const BROWSER_FRAME: Rect = TYPICAL_FRAME;
/** L2: a typical floating app window (an editor; its tabs are not discovered): bottom ~155 px above the floor, top ~1035 px up. */
export const APP_FRAME: Rect = { x: 240, y: 160, width: 1240, height: 880 };
/** L5: the window in front and the lower one next to it, a hop apart. */
export const L5_FRONT_FRAME: Rect = { x: 980, y: 715, width: 620, height: 480 };
export const L5_SECOND_FRAME: Rect = { x: 360, y: 815, width: 520, height: 380 };
export const FULL: Rect = { x: 0, y: 0, width: SCREEN_W, height: SCREEN_H };
/** L3: a maximized window comes in front for 10 min, then the browser for 10 min, and so on (browser first). */
export const L3_SWAP_MS = 10 * MIN;
/** L4b: maximized in front for U(20, 45) min, then the floating browser for U(3, 8) min (about 85 % maximized). */
export const L4B_MAXIMIZED_MS: readonly [number, number] = [20 * MIN, 45 * MIN];
export const L4B_FLOATING_MS: readonly [number, number] = [3 * MIN, 8 * MIN];
/** L3c: a churn event every U(30, 90) s, each lasting U(5, 30) s. */
export const L3C_GAP_MS: readonly [number, number] = [30_000, 90_000];
export const L3C_HOLD_MS: readonly [number, number] = [5_000, 30_000];
/** L1d: a window drag every U(20, 60) s, U(0.6, 2) s long, by U(80, 300) px on each axis. */
export const L1D_GAP_MS: readonly [number, number] = [20_000, 60_000];

export const LAYOUT_DESCRIPTIONS: Readonly<Record<LayoutId, string>> = {
  L1: `floating Chrome-like window [${BROWSER_FRAME.x},${BROWSER_FRAME.y},${BROWSER_FRAME.width}x${BROWSER_FRAME.height}] in front, tab strip from the Edge 156 UIA probe geometry (3 tabs), tab selections`,
  L2: `floating app window [${APP_FRAME.x},${APP_FRAME.y},${APP_FRAME.width}x${APP_FRAME.height}] (editor; no tab strip discovered)`,
  L3: 'L1 for 10 min, then a maximized window in front for 10 min, alternating (50 %)',
  L4: 'no app window: only the screen edges are reachable (bands clear)',
  L4b: 'a maximized window in front U(20,45) min, then L1 for U(3,8) min, alternating (~85 % maximized)',
  L3c: 'L1 with churn every U(30,90) s for U(5,30) s: another window covers the strip (40 %), the browser is maximized (30 %) or minimized (30 %)',
  L1d: 'L1 with the browser dragged every U(20,60) s by U(80,300) px per axis over U(0.6,2) s (moveStart/moveEnd, moving surfaces)',
  L5: `two floating windows a hop apart [${L5_FRONT_FRAME.x},${L5_FRONT_FRAME.y},${L5_FRONT_FRAME.width}x${L5_FRONT_FRAME.height}] in front, [${L5_SECOND_FRAME.x},${L5_SECOND_FRAME.y},${L5_SECOND_FRAME.width}x${L5_SECOND_FRAME.height}] next to it`,
};

const info = (id: string, rect: Rect, processName: string, category: WindowInfo['category'], maximized: boolean): WindowInfo => ({
  id,
  rect,
  processName,
  category,
  minimized: false,
  maximized,
  fullscreen: false,
  excluded: false,
});

/** A browser's tab strip as the app computes it from the helper's reading (probe geometry placed on `frame`, tab `selected` active). */
export function stripSpecFor(frame: Rect, selected: number): StripSpec | null {
  const w = probeStrip({ left: frame.x, top: frame.y, right: frame.x + frame.width, bottom: frame.y + frame.height }, false, selected);
  const g: StripGeometry = {
    frame: fromWireRect(w.frame),
    work: w.work ? fromWireRect(w.work) : null,
    dpi: w.dpi,
    container: w.container ? fromWireRect(w.container) : null,
    tabs: w.tabs.map((t) => ({ x: t.x, y: t.y, width: t.w, height: t.h, selected: t.selected })),
    count: w.count,
    leftButton: w.leftButton ? fromWireRect(w.leftButton) : null,
    newTab: w.newTab ? fromWireRect(w.newTab) : null,
    grab: w.grab ? fromWireRect(w.grab) : null,
    captions: w.captions ? fromWireRect(w.captions) : null,
    maximized: w.maximized,
    vertical: w.vertical,
  };
  const seg = computeTabStripSegment(g, catExtentPx(1, w.dpi));
  return seg.ok ? { x0: seg.x0, x1: seg.x1, rest: seg.rest, focusX: seg.focusX } : null;
}

/** The cling footprint of the cat at `size` (px): bw x size + 2 x the overlay's side margin (ADR 0003 §6.1(b)). */
export const edgeFootprintPx = (size: number): number => (CAT_BASE_WIDTH_DIP * size + 2 * BODY_MARGIN_SIDE_DIP) * SCALE;

/**
 * Screen-edge bands of the one display: the left and right edges (no neighbour, no side taskbar),
 * with the vertical spans that no obstacle (app window, shown taskbar) overlaps within the
 * footprint. A harness stand-in for PRV's computeEdgeBands (src/main/surfaces/edgeBands.ts,
 * ADR 0003 §16.2), same shape and rule; INT-b switches to the real function in wave 3.
 */
export function edgeBandsFor(obstacles: readonly Rect[], footprintPx: number): ScreenEdgeBand[] {
  const wa = WORLD.displays[0]!.workAreaPx;
  const bands: ScreenEdgeBand[] = [];
  for (const side of ['left', 'right'] as const) {
    const x0 = side === 'left' ? wa.x : wa.x + wa.width - footprintPx;
    const x1 = x0 + footprintPx;
    const cuts = obstacles
      .filter((r) => r.width > 0 && r.height > 0 && r.x < x1 && r.x + r.width > x0)
      .map((r) => ({ y0: Math.max(wa.y, r.y), y1: Math.min(wa.y + wa.height, r.y + r.height) }))
      .filter((c) => c.y1 > c.y0)
      .sort((a, b) => a.y0 - b.y0);
    const spans: Array<{ y0: number; y1: number }> = [];
    let y = wa.y;
    for (const c of cuts) {
      if (c.y0 > y + 1) spans.push({ y0: y, y1: c.y0 });
      y = Math.max(y, c.y1);
    }
    if (wa.y + wa.height > y + 1) spans.push({ y0: y, y1: wa.y + wa.height });
    bands.push({ displayId: DISPLAY_ID, side, clearSpans: spans.slice(0, MAX_EDGE_SPANS) });
  }
  return bands;
}

// ------------------------------------------------------------------ the auto-hide taskbar

const TRAY_HWND = 65868n;
const WS_EX_TOPMOST = 0x8;
const WS_EX_TOOLWINDOW = 0x80;
/** The user's Shell_TrayWnd: bottom, 60 px thick, auto-hide (2 px on screen while hidden). */
const TASKBAR_THICKNESS = 60;
const TASKBAR_HIDDEN_TOP = SCREEN_H - 2;
const TASKBAR_SHOWN_TOP = SCREEN_H - TASKBAR_THICKNESS;
/** Slide time and the hide delay once the cursor has left it (Windows' auto-hide feel). */
export const TASKBAR_SLIDE_MS = 200;
export const TASKBAR_HIDE_DELAY_MS = 600;

/**
 * The taskbar's own behaviour (what Windows does), stepped lazily on the virtual clock: the cursor
 * at the bottom edge slides it in, it stays while the cursor is over it, and slides out
 * TASKBAR_HIDE_DELAY_MS after the cursor leaves. The REAL tracker reads it through native().
 */
export class TaskbarSim {
  /** 0 hidden .. 1 shown. */
  private fraction = 0;
  private target = 0;
  private lastStep = 0;
  private outsideSince: number | null = null;
  reveals = 0;
  shownMs = 0;

  constructor(
    private readonly now: () => number,
    private readonly cursorAt: (t: number) => Point,
  ) {}

  step(): void {
    const t = this.now();
    const dt = Math.max(0, t - this.lastStep);
    this.lastStep = t;
    const c = this.cursorAt(t);
    const top = this.top();
    const over = c.y >= Math.min(top, TASKBAR_HIDDEN_TOP) && c.y < SCREEN_H;
    if (this.target === 0 && c.y >= TASKBAR_HIDDEN_TOP) {
      this.target = 1;
      this.reveals++;
    }
    if (this.target === 1) {
      if (over) this.outsideSince = null;
      else if (this.outsideSince === null) this.outsideSince = t;
      else if (t - this.outsideSince >= TASKBAR_HIDE_DELAY_MS) {
        this.target = 0;
        this.outsideSince = null;
      }
    }
    const k = dt / TASKBAR_SLIDE_MS;
    this.fraction = this.target > this.fraction ? Math.min(this.target, this.fraction + k) : Math.max(this.target, this.fraction - k);
    if (this.fraction > 0) this.shownMs += dt;
  }

  private top(): number {
    return Math.round(TASKBAR_HIDDEN_TOP + (TASKBAR_SHOWN_TOP - TASKBAR_HIDDEN_TOP) * this.fraction);
  }

  /** On-screen part of the taskbar (px), or null while hidden. */
  visibleRect(): Rect | null {
    if (this.fraction <= 0) return null;
    const top = this.top();
    return { x: 0, y: top, width: SCREEN_W, height: SCREEN_H - top };
  }

  get shown(): boolean {
    return this.fraction > 0;
  }

  native(): TaskbarNative {
    const rect = (): RawRect => {
      this.step();
      const top = this.top();
      return { left: 0, top, right: SCREEN_W, bottom: top + TASKBAR_THICKNESS };
    };
    const mon: RawRect = { left: 0, top: 0, right: SCREEN_W, bottom: SCREEN_H };
    return {
      findWindow: (cls) => (cls === 'Shell_TrayWnd' ? TRAY_HWND : null),
      findNextWindow: (cls, after) => (cls === 'Shell_TrayWnd' && after === null ? TRAY_HWND : null),
      isWindow: (h) => h === TRAY_HWND,
      isWindowVisible: (h) => h === TRAY_HWND,
      getWindowRect: (h) => (h === TRAY_HWND ? rect() : null),
      getMonitorRects: () => ({ monitor: { ...mon }, work: { ...mon } }),
      appBarState: () => 0x1,
      appBarTaskbarPos: () => ({ edge: 3, rect: { left: 0, top: TASKBAR_SHOWN_TOP, right: SCREEN_W, bottom: SCREEN_H } }),
      getExStyle: () => WS_EX_TOPMOST | WS_EX_TOOLWINDOW,
    };
  }
}

// ------------------------------------------------------------------ the desktop

interface WindowMove {
  id: string;
  from: Rect;
  to: Rect;
  t0: number;
  t1: number;
}

/** Counts of what the layout did (for the report and the harness tests). */
export interface DesktopLog {
  swaps: number;
  tabSwitches: number;
  covers: number;
  maximizes: number;
  minimizes: number;
  drags: number;
  maximizedFrontMs: number;
  noWindowMs: number;
}

/** The desktop as the provider and tracker report it. */
export class Desktop {
  readonly windowEvents: SimEvent[] = [];
  readonly surfaceEvents: SimEvent[] = [];
  listed: readonly Surface[] = [];
  private byId = new Map<string, Surface>();
  private bare = new Map<string, Surface>();
  /** Front first. */
  windows: Record<string, Rect> = {};
  strips: Record<string, StripSpec> = {};
  foreground: WindowInfo | null = null;
  maximizedFront = false;
  browserFrame: Rect = BROWSER_FRAME;
  tab = 0;
  readonly log: DesktopLog = { swaps: 0, tabSwitches: 0, covers: 0, maximizes: 0, minimizes: 0, drags: 0, maximizedFrontMs: 0, noWindowMs: 0 };
  private browserState: 'normal' | 'covered' | 'maximized' | 'minimized' = 'normal';
  private coverRect: Rect | null = null;
  private move: WindowMove | null = null;
  private lastUpdate = 0;
  private bandsCache: { key: string; bands: ScreenEdgeBand[] } | null = null;

  constructor(
    readonly layout: LayoutId,
    private readonly now: () => number,
    private readonly rng: () => number,
    readonly taskbar: TaskbarSim | null,
    private readonly footprintPx: number,
  ) {
    this.setPhase(layout === 'L4b', true);
  }

  private range(a: number, b: number): number {
    return a + (b - a) * this.rng();
  }

  /** Schedules the layout's own changes on the clock. */
  start(clock: VirtualClock): void {
    if (this.layout === 'L3') {
      const swap = (): void => {
        this.setPhase(!this.maximizedFront);
        clock.setTimeout(swap, L3_SWAP_MS);
      };
      clock.setTimeout(swap, L3_SWAP_MS);
    } else if (this.layout === 'L4b') {
      const swap = (): void => {
        this.setPhase(!this.maximizedFront);
        const [lo, hi] = this.maximizedFront ? L4B_MAXIMIZED_MS : L4B_FLOATING_MS;
        clock.setTimeout(swap, this.range(lo, hi));
      };
      clock.setTimeout(swap, this.range(L4B_MAXIMIZED_MS[0], L4B_MAXIMIZED_MS[1]));
    } else if (this.layout === 'L3c') {
      const churn = (): void => {
        const r = this.rng();
        const kind = r < 0.4 ? 'covered' : r < 0.7 ? 'maximized' : 'minimized';
        this.setBrowserState(kind);
        clock.setTimeout(
          () => {
            this.setBrowserState('normal');
            clock.setTimeout(churn, this.range(L3C_GAP_MS[0], L3C_GAP_MS[1]));
          },
          this.range(L3C_HOLD_MS[0], L3C_HOLD_MS[1]),
        );
      };
      clock.setTimeout(churn, this.range(L3C_GAP_MS[0], L3C_GAP_MS[1]));
    } else if (this.layout === 'L1d') {
      const drag = (): void => {
        this.beginDrag();
        clock.setTimeout(drag, this.range(L1D_GAP_MS[0], L1D_GAP_MS[1]));
      };
      clock.setTimeout(drag, this.range(L1D_GAP_MS[0], L1D_GAP_MS[1]));
    }
  }

  get browserFront(): boolean {
    return (this.layout === 'L1' || this.layout === 'L3' || this.layout === 'L4b' || this.layout === 'L3c' || this.layout === 'L1d') && !this.maximizedFront && this.browserState === 'normal';
  }

  /** L3 / L4b: a maximized window in front (true) or the floating browser (false). */
  setPhase(maxFront: boolean, initial = false): void {
    this.maximizedFront = maxFront;
    if (this.layout === 'L5') {
      this.windows = { [SECOND_ID]: L5_SECOND_FRAME, [APP_ID]: L5_FRONT_FRAME };
      this.strips = {};
      this.foreground = info(APP_ID, L5_FRONT_FRAME, 'code.exe', 'code', false);
    } else if (this.layout === 'L2') {
      this.windows = { [APP_ID]: APP_FRAME };
      this.strips = {};
      this.foreground = info(APP_ID, APP_FRAME, 'code.exe', 'code', false);
    } else if (this.layout === 'L4') {
      this.windows = {};
      this.strips = {};
      this.foreground = null;
    } else {
      const strip = stripSpecFor(this.browserFrame, this.tab);
      this.strips = strip ? { [CHROME_ID]: strip } : {};
      if (maxFront) {
        this.windows = { [MAX_ID]: FULL, [CHROME_ID]: this.browserFrame };
        this.foreground = info(MAX_ID, FULL, 'code.exe', 'code', true);
      } else {
        this.windows = { [CHROME_ID]: this.browserFrame };
        this.foreground = info(CHROME_ID, this.browserFrame, 'chrome.exe', 'browser', false);
      }
    }
    this.rebuild();
    if (!initial) {
      this.log.swaps++;
      this.windowEvents.push({ type: 'window.foreground', window: this.foreground, switchesPerMinute: 1 });
    }
  }

  /** L3c: the strip's window is covered by another window, maximized, minimized, or back to normal. */
  private setBrowserState(next: 'normal' | 'covered' | 'maximized' | 'minimized'): void {
    const prev = this.browserState;
    if (prev === next) return;
    this.browserState = next;
    const browser = (): WindowInfo => info(CHROME_ID, this.browserFrame, 'chrome.exe', 'browser', false);
    const ev = this.windowEvents;
    // Undo the previous state.
    if (prev === 'covered' && this.coverRect) {
      ev.push({ type: 'window.closed', id: COVER_ID, rect: this.coverRect, category: 'other' });
      this.coverRect = null;
    } else if (prev === 'maximized') {
      ev.push({ type: 'window.moveStart', id: CHROME_ID }, { type: 'window.moveEnd', id: CHROME_ID, rect: this.browserFrame });
    } else if (prev === 'minimized') {
      ev.push({ type: 'window.restored', window: browser() });
    }
    const f = this.browserFrame;
    const strip = stripSpecFor(f, this.tab);
    this.strips = strip ? { [CHROME_ID]: strip } : {};
    switch (next) {
      case 'normal':
        this.windows = { [CHROME_ID]: f };
        this.foreground = browser();
        break;
      case 'covered': {
        const x = Math.round(f.x + this.range(-200, 0.6 * f.width));
        const y = Math.round(Math.max(0, f.y - this.range(40, 200)));
        const cover: Rect = { x, y, width: Math.round(this.range(500, 1000)), height: Math.round(this.range(400, 700)) };
        this.coverRect = cover;
        this.windows = { [COVER_ID]: cover, [CHROME_ID]: f };
        this.foreground = info(COVER_ID, cover, 'notepad.exe', 'other', false);
        ev.push({ type: 'window.shown', window: this.foreground });
        this.log.covers++;
        break;
      }
      case 'maximized':
        this.windows = { [CHROME_ID]: FULL };
        this.strips = {};
        this.foreground = info(CHROME_ID, FULL, 'chrome.exe', 'browser', true);
        ev.push({ type: 'window.moveStart', id: CHROME_ID }, { type: 'window.moveEnd', id: CHROME_ID, rect: FULL });
        this.log.maximizes++;
        break;
      case 'minimized':
        this.windows = {};
        this.strips = {};
        this.foreground = null;
        ev.push({ type: 'window.minimized', id: CHROME_ID });
        this.log.minimizes++;
        break;
    }
    ev.push({ type: 'window.foreground', window: this.foreground, switchesPerMinute: 2 });
    this.rebuild();
  }

  /** L1d: the user drags the browser by its caption (geometry only; the cursor model is not involved). */
  private beginDrag(): void {
    if (this.move || this.browserState !== 'normal') return;
    const f = this.browserFrame;
    const sign = (): number => (this.rng() < 0.5 ? -1 : 1);
    const clampX = (x: number): number => Math.min(SCREEN_W - f.width, Math.max(0, x));
    const clampY = (y: number): number => Math.min(SCREEN_H - f.height - 150, Math.max(100, y));
    const to: Rect = { ...f, x: Math.round(clampX(f.x + sign() * this.range(80, 300))), y: Math.round(clampY(f.y + sign() * this.range(80, 300))) };
    const t0 = this.now();
    this.move = { id: CHROME_ID, from: f, to, t0, t1: t0 + this.range(600, 2000) };
    this.windowEvents.push({ type: 'window.moveStart', id: CHROME_ID });
    this.log.drags++;
  }

  /** Advances window moves and the taskbar to `now` (called on every provider read). */
  update(): void {
    const t = this.now();
    const dt = Math.max(0, t - this.lastUpdate);
    this.lastUpdate = t;
    if (this.maximizedFront || this.browserState === 'maximized') this.log.maximizedFrontMs += dt;
    if (Object.keys(this.windows).length === 0) this.log.noWindowMs += dt;
    this.taskbar?.step();
    const m = this.move;
    if (!m) return;
    const k = Math.min(1, (t - m.t0) / Math.max(1, m.t1 - m.t0));
    const r: Rect = { ...m.from, x: Math.round(m.from.x + (m.to.x - m.from.x) * k), y: Math.round(m.from.y + (m.to.y - m.from.y) * k) };
    this.browserFrame = r;
    this.windows = { [CHROME_ID]: r };
    this.foreground = info(CHROME_ID, r, 'chrome.exe', 'browser', false);
    const strip = stripSpecFor(r, this.tab);
    this.strips = strip ? { [CHROME_ID]: strip } : {};
    const done = k >= 1;
    const v = done ? { vx: 0, vy: 0 } : { vx: ((m.to.x - m.from.x) * 1000) / (m.t1 - m.t0), vy: ((m.to.y - m.from.y) * 1000) / (m.t1 - m.t0) };
    this.rebuild(v);
    if (done) {
      this.move = null;
      this.windowEvents.push({ type: 'window.moveEnd', id: CHROME_ID, rect: r });
    }
  }

  /** The user selects another tab: the strip's resting span moves to it and the helper reports the change. */
  selectTab(i: number): void {
    if (!this.browserFront || i === this.tab) return;
    this.tab = i;
    const strip = stripSpecFor(this.browserFrame, i);
    if (!strip) return;
    this.strips = { [CHROME_ID]: strip };
    this.rebuild();
    this.log.tabSwitches++;
    this.surfaceEvents.push({ type: 'tabs.changed', surfaceId: `tabStrip:${CHROME_ID}`, ownerId: CHROME_ID, change: 'selected', focusX: strip.focusX });
  }

  private rebuild(motion: { vx: number; vy: number } = { vx: 0, vy: 0 }): void {
    const now = this.now();
    const moving = (s: Surface): Surface => (motion.vx !== 0 || motion.vy !== 0) && s.ownerId === CHROME_ID ? { ...s, vx: motion.vx, vy: motion.vy } : s;
    this.listed = providerSurfacesFromWindows(this.windows, WORLD, { walls: true, now, tabStrips: this.strips }).map(moving);
    this.byId = new Map(this.listed.map((s) => [s.id, s] as const));
    // A covered window still exists: getSurface serves its own (unlisted) edges, so a cat on it leaves calmly.
    this.bare.clear();
    for (const [id, r] of Object.entries(this.windows)) {
      const strip = this.strips[id];
      for (const s of providerSurfacesFromWindows({ [id]: r }, WORLD, { walls: true, now, tabStrips: strip ? { [id]: strip } : undefined })) this.bare.set(s.id, moving(s));
    }
  }

  getSurface(id: string): Surface | null {
    return this.byId.get(id) ?? this.bare.get(id) ?? null;
  }

  /** The screen-edge bands for the current windows and taskbar (cached per geometry). */
  edgeBands(): ScreenEdgeBand[] {
    const obstacles: Rect[] = Object.values(this.windows);
    const tb = this.taskbar?.visibleRect();
    if (tb) obstacles.push(tb);
    const key = JSON.stringify(obstacles);
    if (this.bandsCache?.key !== key) this.bandsCache = { key, bands: edgeBandsFor(obstacles, this.footprintPx) };
    return this.bandsCache.bands;
  }

  /** A ledge to put the cat on (the user lifts it onto the window), or null. */
  ledgeToPlaceOn(): { x0: number; x1: number; y: number } | null {
    for (const s of this.listed) {
      if (s.orientation !== 'ledge' || (s.kind !== 'tabStrip' && s.kind !== 'windowTop')) continue;
      const span = s.kind === 'tabStrip' && s.rest ? s.rest : { x0: s.x0, x1: s.x1 };
      return { x0: span.x0, x1: span.x1, y: s.y };
    }
    return null;
  }

  drainWindowEvents(): SimEvent[] {
    return this.windowEvents.splice(0);
  }
  drainSurfaceEvents(): SimEvent[] {
    return this.surfaceEvents.splice(0);
  }
}
