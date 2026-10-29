// Behaviour-profile harness (v1.2 baseline; re-run unchanged after the v1.2 behaviour work).
//
// SIMULATED through REAL code, on one virtual clock, on the reporting user's screen (one
// 1920x1200 display at 125 %, auto-hide bottom taskbar hidden: work area = whole screen):
//   - the real cat simulation (src/core/behavior Sim + Mover), seeded;
//   - the real host loop (src/main/catHost.ts createCatHost): it ticks at the sim's nextTickMs
//     within [16, 1000] ms, catches gaps up in <= 250 ms sub-steps, hands events to the first
//     sub-step and is nudged by pointer events, exactly as in the app;
//   - the real activity monitor (src/main/win32/activityMonitor.ts) fed a synthetic input stream
//     (cursor position, last-input time, left button) in place of GetCursorPos/GetLastInputInfo,
//     so typing, typing intensity, cursor speed, flicks and idle events come from the app's code;
//   - provider-shaped surfaces built with the app's own geometry code (corner insets, occlusion,
//     a measured tab strip listed in place of its window top, with its landing span:
//     tests/unit/core/behavior/fixtures.ts providerSurfacesFromWindows), tab strips from the REAL
//     Edge 156 UIA probe geometry (tests/integration/surfaces/pipeline.ts probeStrip) through the
//     app's segment code (src/main/uia/segment.ts); a covered window's surface is still served by
//     getSurface (bare edge, unlisted), as src/main/surfaces/provider.ts does.
// MOCKED: the OS side (window tracker, display service, overlays/hit-testing, cat store, surface
// provider) as small stubs. Not simulated: perception events (local-stats summaries), taskbar
// reveals, other monitors, window moves/resizes, browser tab add/close (only tab selection).
//
// Instrumentation reads a few private sim fields (act, excursion, fallReason, cat,
// decisionTargets) and wraps two private methods on the instance (decisionView,
// requestCandidate) to see every autonomous decision. Each probe reports 'missing' in the result
// instead of failing if a later version renames it (see RunResult.probes). Decision
// probabilities are recomputed from the captured DecisionView with the exported scorer
// (scoreCandidates, applyRepetitionPenalty, DECISION_TEMPERATURE, DECISION_TOP_K), which is pure.
// Only kinds, counts, timings and geometry are recorded; no window title exists anywhere here.
import { createInstrumentedCatSim, mulberry32, newPersistedCat, type TransitionRecord } from '../../src/core/behavior';
import type { Activity } from '../../src/core/behavior/activity';
import { applyRepetitionPenalty, DECISION_TEMPERATURE, DECISION_TOP_K, scoreCandidates, type Candidate, type DecisionView } from '../../src/core/behavior/decide';
import type { CatSimImpl } from '../../src/core/behavior/sim';
import { simWorld } from '../../src/core/display/simWorld';
import { createCatHost, type HostOverlays, type HostSurfaceProvider } from '../../src/main/catHost';
import type { DisplayService, Logger, Win32Api, WindowTracker } from '../../src/main/contracts';
import { fromWireRect } from '../../src/main/uia/protocol';
import { catExtentPx, computeTabStripSegment, type StripGeometry } from '../../src/main/uia/segment';
import { createActivityMonitor } from '../../src/main/win32/activityMonitor';
import type { BehaviorState } from '../../src/shared/cat';
import type { PersistedCat, Stats } from '../../src/shared/catState';
import type { Point, Rect } from '../../src/shared/geometry';
import { defaultSettings, type Settings } from '../../src/shared/settings';
import type { CatSim, SimEnv, SimEvent, SimOutput } from '../../src/shared/sim';
import type { Surface } from '../../src/shared/surfaces';
import type { WindowInfo } from '../../src/shared/world';
import { BODY_H_PX, BODY_PX, FLOOR_Y, probeStrip, WORLD } from '../integration/surfaces/pipeline';
import { providerSurfacesFromWindows, type StripSpec } from '../unit/core/behavior/fixtures';
import { TYPICAL_FRAME, USER_TRAITS } from '../unit/core/behavior/liveness';

export const HARNESS_VERSION = 1;
export const MIN = 60_000;
export const HOUR = 3_600_000;
const BL = BODY_PX;
const BH = BODY_H_PX;
const SCREEN_W = 1920;
const SCREEN_H = 1200;

// ------------------------------------------------------------------ profiles

export type ProfileId = 'P1' | 'P2';
export type LayoutId = 'L1' | 'L2' | 'L3';
export const PROFILE_IDS: readonly ProfileId[] = ['P1', 'P2'];
export const LAYOUT_IDS: readonly LayoutId[] = ['L1', 'L2', 'L3'];

/** The reporting user's cat now (installed 1.1.1, cat-state.json read 2026-10-29; traits as in liveness.ts). */
export const USER_STATS_NOW: Stats = { energy: 0.95, boredom: 0.013, bond: 0.6, annoyance: 0, fear: 0 };

/**
 * REAL evidence from the user's installed 1.1.1 (counters after 189 awake minutes), per awake hour.
 * pets counts seconds of stroking (the sim bumps it at most once per second), drags include throws,
 * throws are the hard ones only (the sim counts no others).
 */
export const USER_EVIDENCE_PER_AWAKE_HOUR = {
  awakeMin: 189,
  pets: (145 / 189) * 60,
  drags: (61 / 189) * 60,
  throws: (26 / 189) * 60,
  chasesStarted: (1 / 189) * 60,
  chasesEngaged: 0,
  windowsInspected: (2 / 189) * 60,
  naps: (12 / 189) * 60,
};

/** P1: the user's settings. P2: defaults. */
export function profileSettings(p: ProfileId): Settings {
  const s = defaultSettings();
  if (p === 'P1') {
    Object.assign(s.behavior, { autonomy: 0.8, cursorPlay: 0.7, attentionSeeking: 0.5, activitySensitivity: 0.95, sleepAfterIdleMinutes: 30, chaseDurationSec: 5, movementSpeed: 1, disabledBehaviors: [] });
    // Mirrors the user's consented local statistics; no perception events are simulated.
    s.perception.visualMode = 'local-stats';
    s.perception.consentAt = '2026-10-29T15:31:00.000Z';
  }
  return s;
}

/** P1: the user's traits and current stats. P2: a fresh cat (traits drawn from the seed, default stats). */
export function profileCat(p: ProfileId, seed: number, wall0: number): PersistedCat {
  const cat = newPersistedCat(mulberry32(1000 + seed), wall0 - HOUR);
  if (p === 'P1') {
    Object.assign(cat.traits, USER_TRAITS);
    Object.assign(cat.stats, USER_STATS_NOW);
  }
  cat.lastPosition = null;
  return cat;
}

// ------------------------------------------------------------------ layouts

// Not integer-like: providerSurfacesFromWindows reads its windows front first in key order, and JS
// orders integer-like keys numerically, not by insertion ('1003' would land behind '1001').
export const CHROME_ID = 'w-browser';
export const APP_ID = 'w-app';
export const MAX_ID = 'w-max';
/** L1/L3: a floating Chrome-like window in front (TYPICAL_FRAME: sides end ~235 px above the floor, top ~1075 px up). */
export const BROWSER_FRAME: Rect = TYPICAL_FRAME;
/** L2: a typical floating app window (an editor; its tabs are not discovered in v1.1.1): bottom ~155 px above the floor, top ~1035 px up. */
export const APP_FRAME: Rect = { x: 240, y: 160, width: 1240, height: 880 };
const FULL: Rect = { x: 0, y: 0, width: SCREEN_W, height: SCREEN_H };
/** L3: a maximized window comes in front for 10 min, then the browser for 10 min, and so on (browser first). */
export const L3_SWAP_MS = 10 * MIN;

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

/** The desktop as the provider and tracker report it. */
class Desktop {
  readonly windowEvents: SimEvent[] = [];
  readonly surfaceEvents: SimEvent[] = [];
  listed: readonly Surface[] = [];
  private byId = new Map<string, Surface>();
  private bare = new Map<string, Surface>();
  windows: Record<string, Rect> = {};
  strips: Record<string, StripSpec> = {};
  foreground: WindowInfo | null = null;
  maximizedFront = false;
  swaps = 0;
  tab = 0;
  tabSwitches = 0;

  constructor(
    readonly layout: LayoutId,
    private readonly now: () => number,
  ) {
    this.setPhase(false, true);
  }

  get browserFront(): boolean {
    return this.layout !== 'L2' && !this.maximizedFront;
  }

  setPhase(maxFront: boolean, initial = false): void {
    this.maximizedFront = maxFront;
    if (this.layout === 'L2') {
      this.windows = { [APP_ID]: APP_FRAME };
      this.strips = {};
      this.foreground = info(APP_ID, APP_FRAME, 'code.exe', 'code', false);
    } else {
      const strip = stripSpecFor(BROWSER_FRAME, this.tab);
      this.strips = strip ? { [CHROME_ID]: strip } : {};
      if (maxFront) {
        this.windows = { [MAX_ID]: FULL, [CHROME_ID]: BROWSER_FRAME };
        this.foreground = info(MAX_ID, FULL, 'code.exe', 'code', true);
      } else {
        this.windows = { [CHROME_ID]: BROWSER_FRAME };
        this.foreground = info(CHROME_ID, BROWSER_FRAME, 'chrome.exe', 'browser', false);
      }
    }
    this.rebuild();
    if (!initial) {
      this.swaps++;
      this.windowEvents.push({ type: 'window.foreground', window: this.foreground, switchesPerMinute: 1 });
    }
  }

  /** The user selects another tab: the strip's resting span moves to it and the helper reports the change. */
  selectTab(i: number): void {
    if (!this.browserFront || i === this.tab) return;
    this.tab = i;
    const strip = stripSpecFor(BROWSER_FRAME, i);
    if (!strip) return;
    this.strips = { [CHROME_ID]: strip };
    this.rebuild();
    this.tabSwitches++;
    this.surfaceEvents.push({ type: 'tabs.changed', surfaceId: `tabStrip:${CHROME_ID}`, ownerId: CHROME_ID, change: 'selected', focusX: strip.focusX });
  }

  private rebuild(): void {
    const now = this.now();
    this.listed = providerSurfacesFromWindows(this.windows, WORLD, { walls: true, now, tabStrips: this.strips });
    this.byId = new Map(this.listed.map((s) => [s.id, s] as const));
    // A covered window still exists: getSurface serves its own (unlisted) edges, so a cat on it leaves calmly.
    this.bare.clear();
    for (const [id, r] of Object.entries(this.windows)) {
      const strip = this.strips[id];
      for (const s of providerSurfacesFromWindows({ [id]: r }, WORLD, { walls: true, now, tabStrips: strip ? { [id]: strip } : undefined })) this.bare.set(s.id, s);
    }
  }

  getSurface(id: string): Surface | null {
    return this.byId.get(id) ?? this.bare.get(id) ?? null;
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

// ------------------------------------------------------------------ virtual time

interface TimerEntry {
  at: number;
  seq: number;
  fn: () => void;
}

/** A synchronous timer heap on a virtual clock (the host, the activity sampling and the user all run on it). */
class VirtualClock {
  now = 0;
  private seq = 0;
  private heap: TimerEntry[] = [];
  private live = new Set<number>();

  setTimeout(fn: () => void, ms: number): number {
    const id = ++this.seq;
    this.live.add(id);
    this.push({ at: this.now + Math.max(0, Number.isFinite(ms) ? ms : 0), seq: id, fn });
    return id;
  }
  clearTimeout(h: unknown): void {
    if (typeof h === 'number') this.live.delete(h);
  }
  runUntil(end: number): void {
    for (;;) {
      const top = this.heap[0];
      if (!top || top.at > end) break;
      this.pop();
      if (!this.live.delete(top.seq)) continue;
      this.now = Math.max(this.now, top.at);
      top.fn();
    }
    this.now = Math.max(this.now, end);
  }
  private less(a: TimerEntry, b: TimerEntry): boolean {
    return a.at < b.at || (a.at === b.at && a.seq < b.seq);
  }
  private push(e: TimerEntry): void {
    const h = this.heap;
    h.push(e);
    let i = h.length - 1;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (!this.less(h[i]!, h[p]!)) break;
      [h[i], h[p]] = [h[p]!, h[i]!];
      i = p;
    }
  }
  private pop(): void {
    const h = this.heap;
    const last = h.pop();
    if (h.length === 0 || !last) return;
    h[0] = last;
    let i = 0;
    for (;;) {
      const l = 2 * i + 1;
      const r = l + 1;
      let m = i;
      if (l < h.length && this.less(h[l]!, h[m]!)) m = l;
      if (r < h.length && this.less(h[r]!, h[m]!)) m = r;
      if (m === i) break;
      [h[i], h[m]] = [h[m]!, h[i]!];
      i = m;
    }
  }
}

// ------------------------------------------------------------------ the user

/** The usage model (seeded): an active user at the desk. */
export interface UsageModel {
  /** Petting sessions, drags (gentle carry and release) and throws per hour of presence. */
  petsPerHour: number;
  dragsPerHour: number;
  throwsPerHour: number;
  /** Share of throws released above the app's hard-throw speed (the rest are brisk but below it). */
  hardThrowShare: number;
  /** Share of drags that put the cat onto the front window's top / tab strip. */
  placeOnTopShare: number;
  /** Share of mouse moves that end near the cat (on its level), and anywhere on screen (else inside the front window). */
  nearCatMoveShare: number;
  anywhereMoveShare: number;
  /** Tab selections per hour while the browser is in front and the user uses the mouse. */
  tabSwitchesPerHour: number;
  /** One idle stretch longer than the sleep threshold per run. */
  longIdle: boolean;
}

export const DEFAULT_USAGE: UsageModel = {
  petsPerHour: 10,
  dragsPerHour: 4,
  throwsPerHour: 3,
  hardThrowShare: 0.7,
  placeOnTopShare: 0.2,
  nearCatMoveShare: 0.08,
  anywhereMoveShare: 0.12,
  tabSwitchesPerHour: 15,
  longIdle: true,
};

type Mode = 'mouse' | 'typing' | 'pause' | 'idle' | 'longIdle' | 'hand';

interface CursorPath {
  from: number;
  to: number;
  at: (t: number) => Point;
}

export interface Release {
  at: number;
  kind: 'drag' | 'throw';
  speedDip: number;
  /** Counted as a hard throw by the sim. */
  thrown: boolean | null;
}

export interface UserLog {
  modeMs: Record<Mode, number>;
  petSessions: number;
  petEvents: number;
  drags: number;
  throws: number;
  placedOnTop: number;
  shortIdles: number;
  longIdles: number;
  deferred: number;
  moves: number;
  nearCatMoves: number;
  releases: Release[];
}

const smooth = (k: number): number => (k <= 0 ? 0 : k >= 1 ? 1 : k * k * k * (10 + k * (6 * k - 15)));
const clampScreen = (p: Point): Point => ({ x: Math.min(SCREEN_W - 1, Math.max(0, p.x)), y: Math.min(SCREEN_H - 1, Math.max(0, p.y)) });

class User {
  mode: Mode = 'mouse';
  dragging = false;
  private gen = 0;
  private path: CursorPath | null = null;
  private rest: Point = { x: 1100, y: 520 };
  private lastInput = 0;
  private leftUntil = -1;
  private modeSince = 0;
  private longIdleDone = false;
  private keys = 0;
  readonly log: UserLog = {
    modeMs: { mouse: 0, typing: 0, pause: 0, idle: 0, longIdle: 0, hand: 0 },
    petSessions: 0,
    petEvents: 0,
    drags: 0,
    throws: 0,
    placedOnTop: 0,
    shortIdles: 0,
    longIdles: 0,
    deferred: 0,
    moves: 0,
    nearCatMoves: 0,
    releases: [],
  };

  constructor(
    private readonly rng: () => number,
    private readonly clock: VirtualClock,
    private readonly desk: Desktop,
    private readonly usage: UsageModel,
    private readonly sleepThresholdMs: number,
    private readonly runMs: number,
    private readonly cat: () => SimOutput | null,
    private readonly enqueue: (ev: SimEvent) => void,
    private readonly onRelease: (r: Release) => void,
  ) {}

  start(): void {
    this.startMode('mouse');
    this.schedule('pet', this.usage.petsPerHour);
    this.schedule('drag', this.usage.dragsPerHour);
    this.schedule('throw', this.usage.throwsPerHour);
    this.scheduleTabs();
    if (this.usage.longIdle) this.clock.setTimeout(() => this.beginLongIdle(), this.range(0.35, 0.6) * this.runMs);
  }

  finish(): void {
    this.log.modeMs[this.mode] += this.clock.now - this.modeSince;
    this.modeSince = this.clock.now;
  }

  // ---- what the OS reports

  cursorAt(t: number): Point {
    const p = this.path;
    if (p && t <= p.to) return clampScreen(p.at(Math.max(p.from, t)));
    return this.rest;
  }
  idleMs(t: number): number {
    const p = this.path;
    if (p && t >= p.from && t <= p.to) return 0;
    return Math.max(0, t - this.lastInput);
  }
  leftDown(t: number): boolean {
    return this.dragging || t <= this.leftUntil;
  }
  get present(): boolean {
    return this.mode !== 'idle' && this.mode !== 'longIdle';
  }

  // ---- helpers

  private range(a: number, b: number): number {
    return a + (b - a) * this.rng();
  }
  private now(): number {
    return this.clock.now;
  }
  private after(ms: number, g: number, fn: () => void): void {
    this.clock.setTimeout(() => {
      if (g === this.gen) fn();
    }, ms);
  }
  private catPoint(): Point | null {
    const o = this.cat();
    if (!o || !o.visible) return null;
    return { x: o.x, y: o.y - 0.5 * BH };
  }
  /** Ends the current path where it is now (the hand stops there). */
  private settle(): void {
    const t = this.now();
    const p = this.path;
    if (p) {
      this.rest = clampScreen(p.at(Math.min(Math.max(p.from, t), p.to)));
      if (t >= p.from) this.lastInput = Math.min(t, p.to);
    }
    this.path = null;
  }
  private setPath(ms: number, at: (t: number) => Point): void {
    this.settle();
    const from = this.now();
    const to = from + Math.max(1, ms);
    const path: CursorPath = { from, to, at };
    this.path = path;
    this.clock.setTimeout(() => {
      if (this.path === path) this.settle();
    }, to - from);
  }
  private moveTo(target: Point | (() => Point | null), ms: number): void {
    const start = this.cursorAt(this.now());
    const t0 = this.now();
    let last = typeof target === 'function' ? (target() ?? start) : target;
    this.setPath(ms, (t) => {
      if (typeof target === 'function') last = target() ?? last;
      const k = smooth((t - t0) / ms);
      return { x: start.x + (last.x - start.x) * k, y: start.y + (last.y - start.y) * k };
    });
  }

  // ---- the mode machine

  private startMode(m: Mode, ms?: number): void {
    const t = this.now();
    this.log.modeMs[this.mode] += t - this.modeSince;
    this.modeSince = t;
    const g = ++this.gen;
    this.mode = m;
    if (m === 'hand') return;
    const thr = this.sleepThresholdMs;
    const dur =
      ms ??
      (m === 'mouse'
        ? this.range(20_000, 150_000)
        : m === 'typing'
          ? this.range(60_000, 360_000)
          : m === 'pause'
            ? this.range(5_000, 60_000)
            : this.range(Math.min(45_000, 0.3 * thr), Math.min(0.5 * thr, 6 * MIN)));
    if (m === 'idle') this.log.shortIdles++;
    if (m === 'mouse') this.mouseStep(g);
    if (m === 'typing') this.typeStep(g);
    this.after(dur, g, () => this.nextMode());
  }

  private nextMode(): void {
    const r = this.rng();
    switch (this.mode) {
      case 'mouse':
        this.startMode(r < 0.45 ? 'typing' : r < 0.78 ? 'pause' : r < 0.85 ? 'idle' : 'mouse');
        return;
      case 'typing':
        this.startMode(r < 0.6 ? 'mouse' : r < 0.9 ? 'pause' : 'idle');
        return;
      case 'pause':
        this.startMode(r < 0.55 ? 'mouse' : 'typing');
        return;
      default:
        this.startMode('mouse');
    }
  }

  private beginLongIdle(): void {
    if (this.longIdleDone) return;
    if (this.mode === 'hand') {
      this.clock.setTimeout(() => this.beginLongIdle(), 10_000);
      return;
    }
    this.longIdleDone = true;
    this.log.longIdles++;
    this.settle();
    this.startMode('longIdle', this.sleepThresholdMs + this.range(5 * MIN, 15 * MIN));
  }

  private mouseStep(g: number): void {
    const r = this.rng();
    let target: Point;
    const cat = this.cat();
    if (r < this.usage.nearCatMoveShare && cat?.visible) {
      const side = this.rng() < 0.5 ? -1 : 1;
      target = clampScreen({ x: cat.x + side * this.range(1, 5) * BL, y: cat.y - this.range(0.3, 3) * BH });
      this.log.nearCatMoves++;
    } else if (r < this.usage.nearCatMoveShare + this.usage.anywhereMoveShare) {
      target = { x: this.range(10, SCREEN_W - 10), y: this.range(10, SCREEN_H - 10) };
    } else {
      const w = this.desk.foreground?.rect ?? FULL;
      target = clampScreen({ x: this.range(w.x + 20, w.x + w.width - 20), y: this.range(w.y + 40, w.y + w.height - 20) });
    }
    this.log.moves++;
    const from = this.cursorAt(this.now());
    const d = Math.hypot(target.x - from.x, target.y - from.y);
    const ms = Math.min(1800, Math.max(120, 100 + (d / this.range(700, 3200)) * 1000));
    this.moveTo(target, ms);
    this.after(ms, g, () => {
      if (this.rng() < 0.5) {
        this.lastInput = this.now();
        this.leftUntil = this.now() + 90;
      }
      this.after(this.range(150, 2500), g, () => this.mouseStep(g));
    });
  }

  private typeStep(g: number): void {
    this.lastInput = this.now();
    this.keys++;
    let gap = this.range(90, 260);
    if (this.keys % 6 === 0) gap += this.range(200, 700);
    if (this.rng() < 0.012) gap += this.range(2000, 9000);
    this.after(gap, g, () => this.typeStep(g));
  }

  private scheduleTabs(): void {
    const rate = this.usage.tabSwitchesPerHour / HOUR;
    if (!(rate > 0)) return;
    this.clock.setTimeout(
      () => {
        if (this.mode === 'mouse' && this.desk.browserFront) {
          const others = [0, 1, 2].filter((i) => i !== this.desk.tab);
          this.desk.selectTab(others[Math.floor(this.rng() * others.length)] ?? 0);
        }
        this.scheduleTabs();
      },
      -Math.log(1 - this.rng()) / rate,
    );
  }

  // ---- the hand on the cat

  private schedule(kind: 'pet' | 'drag' | 'throw', perHour: number): void {
    const rate = perHour / HOUR;
    if (!(rate > 0)) return;
    this.clock.setTimeout(() => this.attempt(kind, perHour), -Math.log(1 - this.rng()) / rate);
  }

  private interactable(o: SimOutput | null, pet: boolean): boolean {
    if (!o || !o.visible) return false;
    if (['held', 'jumping', 'falling', 'landing', 'away'].includes(o.state)) return false;
    if (o.support.kind === 'air' || o.support.kind === 'held') return false;
    if (pet && o.support.kind === 'surface' && o.support.surfaceKind === 'windowSide') return false;
    return true;
  }

  private attempt(kind: 'pet' | 'drag' | 'throw', perHour: number): void {
    if (!this.present || this.mode === 'hand' || !this.interactable(this.cat(), kind === 'pet')) {
      // Away or busy: the same intention a little later (presence-time rate).
      this.log.deferred++;
      this.clock.setTimeout(() => this.attempt(kind, perHour), this.range(5_000, 30_000));
      return;
    }
    this.startMode('hand');
    const g = this.gen;
    const approach = this.range(400, 900);
    this.moveTo(() => this.catPoint(), approach);
    this.after(approach, g, () => {
      const p = this.catPoint();
      if (!p || !this.interactable(this.cat(), kind === 'pet')) {
        this.after(500, g, () => this.startMode('mouse'));
        this.schedule(kind, perHour);
        return;
      }
      this.enqueue({ type: 'pointer.hoverStart', at: this.cursorAt(this.now()) });
      if (kind === 'pet') this.pet(g);
      else this.drag(g, kind);
      this.schedule(kind, perHour);
    });
  }

  private pet(g: number): void {
    this.log.petSessions++;
    const dur = this.range(3000, 10_000);
    const period = this.range(600, 900);
    const amp = this.range(25, 45);
    const t0 = this.now();
    this.setPath(dur, (t) => {
      const c = this.catPoint() ?? this.rest;
      return { x: c.x + amp * Math.sin((2 * Math.PI * (t - t0)) / period), y: c.y };
    });
    const stroke = (): void => {
      if (this.now() - t0 >= dur) {
        this.enqueue({ type: 'pointer.hoverEnd' });
        const w = this.desk.foreground?.rect ?? FULL;
        this.moveTo(clampScreen({ x: this.range(w.x + 20, w.x + w.width - 20), y: this.range(w.y + 40, w.y + w.height - 20) }), 500);
        this.after(500, g, () => this.startMode('mouse'));
        return;
      }
      if (this.isOverCat(this.cursorAt(this.now()))) {
        this.enqueue({ type: 'pointer.pet', at: this.cursorAt(this.now()), strength: this.range(0.55, 0.9) });
        this.log.petEvents++;
      }
      this.after(period / 2, g, stroke);
    };
    this.after(period / 4, g, stroke);
  }

  private drag(g: number, kind: 'drag' | 'throw'): void {
    const start = this.cursorAt(this.now());
    this.enqueue({ type: 'pointer.dragStart', at: start });
    this.dragging = true;
    let dest: Point = { x: this.range(200, SCREEN_W - 200), y: this.range(250, 1000) };
    const ledge = kind === 'drag' && this.rng() < this.usage.placeOnTopShare ? this.desk.ledgeToPlaceOn() : null;
    if (ledge) {
      dest = { x: this.range(ledge.x0, ledge.x1), y: ledge.y - this.range(40, 110) };
      this.log.placedOnTop++;
    }
    if (kind === 'drag') this.log.drags++;
    else this.log.throws++;
    const carry = this.range(700, 2000);
    this.moveTo(dest, carry);
    this.after(carry, g, () => {
      let velocity: Point;
      let flingMs = 0;
      if (kind === 'throw') {
        const hard = this.rng() < this.usage.hardThrowShare;
        const speed = hard ? this.range(1500, 5000) : this.range(700, 1350);
        const ang = (this.range(-60, 25) * Math.PI) / 180;
        const dir = this.rng() < 0.5 ? -1 : 1;
        velocity = { x: dir * speed * Math.cos(ang), y: speed * Math.sin(ang) };
        flingMs = 110;
        const from = this.cursorAt(this.now());
        const f0 = this.now();
        this.setPath(flingMs, (t) => ({ x: from.x + (velocity.x * (t - f0)) / 1000, y: from.y + (velocity.y * (t - f0)) / 1000 }));
      } else {
        const speed = this.range(0, 250);
        const ang = this.range(0, 2 * Math.PI);
        velocity = { x: speed * Math.cos(ang), y: speed * Math.sin(ang) };
      }
      this.after(flingMs, g, () => {
        const at = this.cursorAt(this.now());
        this.settle();
        this.enqueue({ type: 'pointer.dragEnd', at, velocity });
        this.dragging = false;
        this.enqueue({ type: 'pointer.hoverEnd' });
        const r: Release = { at: this.now(), kind, speedDip: Math.hypot(velocity.x, velocity.y) / WORLD.displays[0]!.scaleFactor, thrown: null };
        this.log.releases.push(r);
        this.onRelease(r);
        this.after(this.range(300, 1500), g, () => this.startMode('mouse'));
      });
    });
  }

  isOverCat(c: Point | null): boolean {
    const o = this.cat();
    if (!c || !o || !o.visible) return false;
    const b = o.boundsPx;
    return c.x >= b.x - 4 && c.x <= b.x + b.width + 4 && c.y >= b.y - 4 && c.y <= b.y + b.height + 4;
  }
}

// ------------------------------------------------------------------ instrumentation

/** Private sim members the recorder reads (all optional: a missing one disables its metric). */
interface SimInternals {
  act?: Activity;
  excursion?: { kind: string; act: Activity; from: string | null; fromElevated: boolean; leftGround: boolean; arrived: boolean } | null;
  fallReason?: string | null;
  cat?: PersistedCat;
  decisionTargets?: Record<string, string>;
  exploreUrge?: number;
  decisionView?: () => DecisionView;
  requestCandidate?: (c: Candidate, cause: string) => string;
}

type Counter = Record<string, number>;
const inc = (c: Counter, k: string, by = 1): void => {
  c[k] = (c[k] ?? 0) + by;
};

const STATE_CATEGORY: Record<BehaviorState, string> = {
  sleeping: 'asleep',
  fallingAsleep: 'asleep',
  wakingUp: 'asleep',
  idle: 'calm',
  resting: 'calm',
  grooming: 'calm',
  watchingUser: 'calm',
  watchingCursor: 'calm',
  curious: 'calm',
  inspectingWindow: 'calm',
  walking: 'active',
  running: 'active',
  chasingCursor: 'active',
  playing: 'active',
  seekingAttention: 'active',
  jumping: 'active',
  beingPetted: 'interaction',
  held: 'interaction',
  startled: 'reaction',
  annoyed: 'reaction',
  hiding: 'reaction',
  falling: 'physical',
  landing: 'physical',
  away: 'away',
};

const PHYSICAL = new Set<string>(['held', 'jumping', 'falling', 'landing']);
const UNSETTLED = new Set<string>(['held', 'jumping', 'falling', 'landing', 'startled', 'annoyed', 'hiding']);
const ELEVATED_LEDGE = new Set<string>(['windowTop', 'tabStrip']);
const ELEVATED = new Set<string>(['windowTop', 'tabStrip', 'windowSide']);
const TRIP_BUCKET = 'tripUp';

function supportKey(o: SimOutput): string {
  const s = o.support;
  return s.kind === 'surface' ? s.surfaceKind : s.kind;
}

export interface Dist {
  n: number;
  min: number;
  median: number;
  p90: number;
  max: number;
  mean: number;
}

export function dist(values: readonly number[]): Dist {
  const v = [...values].filter(Number.isFinite).sort((a, b) => a - b);
  const q = (p: number): number => (v.length === 0 ? 0 : v[Math.min(v.length - 1, Math.max(0, Math.round(p * (v.length - 1))))]!);
  const r = (x: number): number => Math.round(x * 10) / 10;
  return { n: v.length, min: r(v[0] ?? 0), median: r(q(0.5)), p90: r(q(0.9)), max: r(v[v.length - 1] ?? 0), mean: r(v.length ? v.reduce((a, b) => a + b, 0) / v.length : 0) };
}

export interface LedgeStay {
  kind: string;
  /** How it got on: pullUp (from a side), jumpUp, userPlaced, moved (from another top/strip), fellOnto, other. */
  how: string;
  /** Activity that took it up (state/variant:cause), at the arrival. */
  via: string;
  at: number;
  dwellMs: number;
  /** Why it ended: user:drag, voluntary:jumpDown|jumpAcross|stepOff|climbDown, moved, supportLost:calm|startle|settle, runEnd, other. */
  end: string;
  /** Activity it was in when it left (state/variant:cause). */
  leftDuring: string;
  walkedBl: number;
}

export interface Visit {
  at: number;
  firstKind: string;
  dwellMs: number;
  end: string;
}

export interface Attempt {
  kind: string;
  at: number;
  ms: number;
  ok: boolean;
  reason: string;
}

export interface FallRec {
  at: number;
  reason: string;
  from: string;
  fromSupport: string;
  recoveryMs: number | null;
}

export interface JumpRec {
  at: number;
  kind: string;
  fromSupport: string;
  toSupport: string;
  dy: number;
}

export interface ThrowReaction {
  kind: 'drag' | 'throw';
  speedDip: number;
  thrown: boolean | null;
  first: string;
  states: string[];
  hid: boolean;
  fearMax: number;
  recoveryMs: number | null;
}

class Recorder {
  readonly stateMs: Counter = {};
  readonly variantMs: Counter = {};
  readonly clipMs: Counter = {};
  readonly supportMs: Counter = {};
  readonly categoryMs: Counter = {};
  movingMs = 0;
  simMs = 0;
  awakeMs = 0;
  readonly transitions: Counter = {};
  readonly transitionCauses: Counter = {};
  readonly dwellByState: Record<string, number[]> = {};
  readonly phaseEntries: Counter = {};
  // decisions
  decisions = 0;
  decisionsNull = 0;
  readonly picks: Counter = {};
  readonly pickResults: Counter = {};
  readonly pBucket: Record<'floor' | 'elevated', Counter> = { floor: {}, elevated: {} };
  readonly eligibleBucket: Record<'floor' | 'elevated', Counter> = { floor: {}, elevated: {} };
  readonly decisionsWhere: Counter = {};
  readonly cooldownBlocked: Counter = {};
  readonly targetStatus: Record<string, Counter> = { perch: {}, climb: {}, tabStrip: {} };
  readonly picksElevated: Counter = {};
  urgeAtDecision: number[] = [];
  // locomotion
  readonly bouts: Counter = {};
  readonly boutCauses: Counter = {};
  boutsN = 0;
  boutDistPx: number[] = [];
  // elevation
  readonly stays: LedgeStay[] = [];
  readonly visits: Visit[] = [];
  firstArrivalAt: number | null = null;
  readonly attempts: Attempt[] = [];
  readonly attemptStarts: Counter = {};
  // physics
  readonly falls: FallRec[] = [];
  readonly jumps: JumpRec[] = [];
  readonly reactions: ThrowReaction[] = [];
  // cursor
  chaseStarts = 0;
  readonly chaseStartPhase: Counter = {};
  pounces = 0;
  watchStarts = 0;
  cursorBandMs = 0;
  cursorBandMovingMs = 0;
  // screen edges, floor x coverage (deciles)
  readonly floorX: number[] = Array.from({ length: 10 }, () => 0);
  /** Sim time and time up on windows, by what is in front (L3 alternates). */
  readonly frontMs: Counter = {};
  readonly frontElevatedMs: Counter = {};
  edgeMs = 0;
  floorMs = 0;
  // stats trajectories
  readonly series: Record<string, number[]> = { energy: [], boredom: [], bond: [], annoyance: [], fear: [], urge: [] };
  readonly probes: Record<string, 'ok' | 'missing'> = {};
  layoutSwapsAtFall = 0;

  private last: SimOutput | null = null;
  private lastSup = 'floor';
  private prevAct = '-';
  private stay: (LedgeStay & { id: string; x0: number }) | null = null;
  private visit: Visit | null = null;
  private bout: { t0: number; last: number; dist: number; key: string; cause: string } | null = null;
  private pendingFall: { at: number; reason: string; from: string; fromSupport: string } | null = null;
  private lastFallRec: FallRec | null = null;
  private lastJump: { at: number; kind: string; fromSupport: string; fromY: number; rec: JumpRec | null } | null = null;
  private openFalls: FallRec[] = [];
  private ex: { ref: NonNullable<SimInternals['excursion']>; at: number; climbs: { reversed: number; letGo: number }; swaps: number; user: number; lastCause: string } | null = null;
  private pendingView: { v: DecisionView; where: 'floor' | 'elevated'; blocked: string[] } | null = null;
  private nextSampleAt = 0;
  private chasePhase: string | null = null;
  private chaseJustStarted = false;
  /** A stay that ended with a jump: its end reason gets the jump's direction once it lands. */
  private jumpStay: LedgeStay | null = null;
  private watchPhase: string | null = null;
  private trackedReactions: Array<{ r: ThrowReaction; release: Release; landedAt: number | null; until: number; throwsBefore: number }> = [];
  private stepTransitions: TransitionRecord[] = [];
  userInteractions = 0;

  constructor(
    private readonly sim: CatSimImpl,
    private readonly inner: SimInternals,
    private readonly desk: Desktop,
  ) {
    this.probes.act = inner.act ? 'ok' : 'missing';
    this.probes.excursion = 'excursion' in inner ? 'ok' : 'missing';
    this.probes.fallReason = 'fallReason' in inner ? 'ok' : 'missing';
    this.probes.cat = inner.cat ? 'ok' : 'missing';
    this.probes.decisionTargets = inner.decisionTargets ? 'ok' : 'missing';
    this.probes.decisionView = typeof inner.decisionView === 'function' ? 'ok' : 'missing';
    this.probes.requestCandidate = typeof inner.requestCandidate === 'function' ? 'ok' : 'missing';
  }

  private actKey(): string {
    const a = this.inner.act;
    return a ? `${a.state}/${a.variant ?? '-'}:${a.cause}` : '?';
  }

  counters(): Record<string, number> {
    return { ...(this.inner.cat?.memory.counters ?? this.sim.serialize().memory.counters) };
  }

  stats(): Stats {
    return { ...(this.inner.cat?.stats ?? (this.sim.debugInfo().stats as Stats)) };
  }

  // ---- hooks

  onTransition(r: TransitionRecord): void {
    this.stepTransitions.push(r);
    inc(this.transitions, `${r.from}>${r.to}`);
    inc(this.transitionCauses, r.cause);
    (this.dwellByState[r.from] ??= []).push(r.dwellMs);
    const fromSup = this.last ? supportKey(this.last) : 'floor';
    if (r.to === 'falling') {
      const reason = r.from === 'held' ? (this.inner.fallReason ?? 'drop') : (this.inner.fallReason ?? (this.probes.fallReason === 'ok' ? 'none' : 'unknown'));
      this.pendingFall = { at: r.at, reason, from: r.from, fromSupport: fromSup };
    }
    if (r.to === 'jumping') {
      const kind = r.from === 'chasingCursor' || r.from === 'watchingCursor' ? 'pounce' : r.from === 'playing' ? 'hop' : 'route';
      if (kind === 'pounce') this.pounces++;
      this.lastJump = { at: r.at, kind, fromSupport: fromSup, fromY: this.last?.y ?? FLOOR_Y, rec: null };
    }
    // Starts only: a chase resumed after its own pounce (landing -> chasingCursor) is the same chase.
    if (r.to === 'chasingCursor' && !PHYSICAL.has(r.from)) {
      this.chaseStarts++;
      this.chaseJustStarted = true;
    }
    if (r.to === 'watchingCursor' && !PHYSICAL.has(r.from)) this.watchStarts++;
    if (this.ex && !PHYSICAL.has(r.to) && r.cause !== 'physical') this.ex.lastCause = r.cause;
    // Recovery: the first settled state after a fall.
    if (!UNSETTLED.has(r.to)) {
      for (const f of this.openFalls) f.recoveryMs = r.at - f.at;
      this.openFalls = [];
    }
    for (const tr of this.trackedReactions) {
      if (r.at > tr.until) continue;
      if (r.to === 'landing' && tr.landedAt === null) {
        tr.landedAt = r.at;
        tr.until = r.at + 30_000;
        continue;
      }
      if (tr.landedAt === null || PHYSICAL.has(r.to)) continue;
      if (tr.r.first === '-') tr.r.first = r.to;
      tr.r.states.push(r.to);
      if (r.to === 'hiding') tr.r.hid = true;
      if (tr.r.recoveryMs === null && !UNSETTLED.has(r.to)) tr.r.recoveryMs = r.at - tr.landedAt;
    }
  }

  onView(v: DecisionView): void {
    this.flushView();
    const blocked: string[] = [];
    const where: 'floor' | 'elevated' = v.standingOn === 'windowTop' || v.standingOn === 'tabStrip' ? 'elevated' : 'floor';
    const probe: DecisionView = {
      ...v,
      isCoolingDown: (s) => {
        const c = v.isCoolingDown(s);
        if (c) blocked.push(s);
        return c;
      },
    };
    const scored = applyRepetitionPenalty(scoreCandidates(probe), v.recentStates, v.current);
    const catY = this.last?.y ?? FLOOR_Y;
    const eligible = new Set<string>();
    for (const c of scored) if (c.score > 0 && Number.isFinite(c.score)) eligible.add(bucketOf(c.item, v, catY));
    const top = scored
      .filter((c) => Number.isFinite(c.score) && c.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, Math.max(1, DECISION_TOP_K));
    const best = top[0]?.score ?? 0;
    const w = top.map((c) => Math.exp((c.score - best) / Math.max(1e-3, DECISION_TEMPERATURE)));
    const sum = w.reduce((a, b) => a + b, 0);
    top.forEach((c, i) => inc(this.pBucket[where], bucketOf(c.item, v, catY), sum > 0 ? w[i]! / sum : 0));
    for (const b of eligible) inc(this.eligibleBucket[where], b);
    inc(this.decisionsWhere, where);
    for (const s of new Set(blocked)) inc(this.cooldownBlocked, s);
    const targets = this.inner.decisionTargets;
    if (targets) for (const k of ['perch', 'climb', 'tabStrip']) inc(this.targetStatus[k]!, targets[k] ?? '?');
    if (where === 'floor') this.urgeAtDecision.push(v.exploreUrge);
    this.decisions++;
    this.pendingView = { v, where, blocked };
  }

  onRequest(c: Candidate, cause: string, result: string): void {
    if (cause !== 'autonomous') return;
    const pv = this.pendingView;
    this.pendingView = null;
    const key = `${c.state}/${c.variant ?? '-'}`;
    inc(this.picks, key);
    inc(this.pickResults, result);
    if (pv?.where === 'elevated') inc(this.picksElevated, `${key}${pv ? ` [${bucketOf(c, pv.v, this.last?.y ?? FLOOR_Y)}]` : ''}`);
  }

  private flushView(): void {
    if (this.pendingView) this.decisionsNull++;
    this.pendingView = null;
  }

  onRelease(r: Release): void {
    this.userInteractions++;
    const before = this.counters().throws ?? 0;
    const tr = { r: { kind: r.kind, speedDip: Math.round(r.speedDip), thrown: null, first: '-', states: [] as string[], hid: false, fearMax: 0, recoveryMs: null }, release: r, landedAt: null, until: r.at + 10_000, throwsBefore: before };
    this.trackedReactions.push(tr);
    this.reactions.push(tr.r);
  }

  /** After every sim sub-step (the host may run several per host tick). */
  onStep(env: SimEnv, events: readonly SimEvent[], out: SimOutput): void {
    const dt = env.dt;
    const t = env.now;
    if (this.pendingView) this.flushView();
    const a = this.inner.act;
    const variant = a?.variant ?? '-';
    const sup = supportKey(out);
    this.simMs += dt;
    inc(this.stateMs, out.state, dt);
    inc(this.variantMs, `${out.state}/${variant}`, dt);
    inc(this.clipMs, out.clip, dt);
    inc(this.supportMs, sup, dt);
    const cat = STATE_CATEGORY[out.state] ?? 'other';
    inc(this.categoryMs, cat, dt);
    if (cat !== 'asleep' && cat !== 'away') this.awakeMs += dt;
    for (const ev of events) if (ev.type === 'pointer.dragStart' || ev.type === 'pointer.pet') this.userInteractions++;
    // A new grab ends the observation of earlier releases (their reaction is over or cut short).
    if (events.some((e) => e.type === 'pointer.dragStart')) for (const tr of this.trackedReactions) if (tr.landedAt !== null) tr.until = Math.min(tr.until, t - 1);
    const front = this.desk.maximizedFront ? 'maximizedFront' : 'windowFront';
    inc(this.frontMs, front, dt);
    if (ELEVATED.has(sup)) inc(this.frontElevatedMs, front, dt);

    // Movement and locomotion bouts.
    const prev = this.last;
    const d = prev ? Math.hypot(out.x - prev.x, out.y - prev.y) : 0;
    const moving = d > 0.5 && sup !== 'held' && !out.snap;
    if (moving) {
      this.movingMs += dt;
      if (!this.bout) this.bout = { t0: t, last: t, dist: 0, key: `${out.state}/${variant}`, cause: a?.cause ?? '?' };
      this.bout.dist += d;
      this.bout.last = t;
    } else if (this.bout && (t - this.bout.last > 1500 || sup === 'held')) {
      this.endBout();
    }

    // Phases inside cursor play.
    const phase = a?.phase ?? null;
    if (out.state === 'chasingCursor') {
      if (this.chaseJustStarted) {
        inc(this.chaseStartPhase, String(phase));
        this.chaseJustStarted = false;
      }
      if (phase !== this.chasePhase) inc(this.phaseEntries, `chasingCursor/${String(phase)}`);
      this.chasePhase = phase;
    } else if (!PHYSICAL.has(out.state)) this.chasePhase = null;
    if (out.state === 'watchingCursor') {
      if (phase !== this.watchPhase) inc(this.phaseEntries, `watchingCursor/${String(phase)}`);
      this.watchPhase = phase;
    } else this.watchPhase = null;
    if (out.state === 'playing' && prev?.state !== 'playing') inc(this.phaseEntries, `playing/${variant}`);

    // Cursor within the band where the cat may chase it (sim.cursorInfo 'reachable', on its level).
    const c = env.cursor;
    if (c && cat !== 'asleep' && (sup === 'floor' || ELEVATED_LEDGE.has(sup))) {
      if (c.y >= out.y - 3.5 * BH && c.y <= out.y + 0.5 * BH) {
        this.cursorBandMs += dt;
        if (c.speed / WORLD.displays[0]!.scaleFactor > 150) this.cursorBandMovingMs += dt;
      }
    }
    if (sup === 'floor') {
      this.floorMs += dt;
      const i = Math.min(9, Math.max(0, Math.floor((out.x / SCREEN_W) * 10)));
      this.floorX[i] = (this.floorX[i] ?? 0) + dt;
      if (out.x < 2 * BL || out.x > SCREEN_W - 2 * BL) this.edgeMs += dt;
    }

    // Falls (classified when the transition happened during this step).
    if (this.pendingFall) {
      const f: FallRec = { ...this.pendingFall, recoveryMs: null };
      this.falls.push(f);
      this.openFalls.push(f);
      this.lastFallRec = f;
      this.pendingFall = null;
    }
    // Jumps end when it is no longer in the jumping state.
    const j = this.lastJump;
    if (j && !j.rec && out.state !== 'jumping' && t > j.at) {
      j.rec = { at: j.at, kind: j.kind, fromSupport: j.fromSupport, toSupport: sup, dy: Math.round(out.y - j.fromY) };
      this.jumps.push(j.rec);
      if (this.jumpStay) {
        const dir = j.rec.dy > 0.5 * BH ? 'jumpDown' : j.rec.dy < -0.5 * BH ? 'jumpUp' : 'jumpAcross';
        this.jumpStay.end = `voluntary:${dir}:${j.kind}`;
        this.jumpStay = null;
      }
    }

    this.trackElevation(t, out, sup);
    this.trackExcursion(t);

    // Throw/drop reactions: did the sim count it as thrown, and how did the cat take it.
    for (const tr of this.trackedReactions) {
      if (tr.r.thrown === null && events.some((e) => e.type === 'pointer.dragEnd')) tr.r.thrown = (this.counters().throws ?? 0) > tr.throwsBefore;
      if (t <= tr.until) tr.r.fearMax = Math.max(tr.r.fearMax, Math.round(this.stats().fear * 100) / 100);
    }
    this.trackedReactions = this.trackedReactions.filter((tr) => t <= tr.until);

    if (t >= this.nextSampleAt) {
      this.nextSampleAt = t + 5000;
      const s = this.stats();
      for (const k of ['energy', 'boredom', 'bond', 'annoyance', 'fear'] as const) this.series[k]!.push(s[k]);
      this.series.urge!.push(this.inner.exploreUrge ?? this.sim.surfaceDiagnostics().decision.exploreUrge);
    }

    this.prevAct = this.actKey();
    this.lastSup = sup;
    this.last = out;
    this.stepTransitions = [];
  }

  private endBout(): void {
    const b = this.bout;
    this.bout = null;
    if (!b || b.dist < BL) return;
    this.boutsN++;
    inc(this.bouts, b.key);
    inc(this.boutCauses, b.cause);
    this.boutDistPx.push(Math.round(b.dist));
  }

  private trackElevation(t: number, out: SimOutput, sup: string): void {
    const s = out.support;
    const onLedge = s.kind === 'surface' && ELEVATED_LEDGE.has(s.surfaceKind);
    const id = s.kind === 'surface' ? s.surfaceId : null;
    const cur = this.stay;
    if (cur && !(onLedge && id === cur.id)) {
      cur.dwellMs = t - cur.at;
      cur.end = this.leaveReason(t, sup, onLedge);
      cur.leftDuring = this.prevAct;
      const done = stripStay(cur);
      this.stays.push(done);
      if (done.end.startsWith('voluntary:jump')) this.jumpStay = done;
      this.stay = null;
    }
    if (this.stay) this.stay.walkedBl = Math.max(this.stay.walkedBl, Math.round((Math.abs(out.x - this.stay.x0) / BL) * 10) / 10);
    if (!this.stay && onLedge && id) {
      const how = this.arrivalHow(t);
      this.stay = { kind: s.surfaceKind, how, via: this.prevAct, at: t, dwellMs: 0, end: 'runEnd', leftDuring: '-', walkedBl: 0, id, x0: out.x };
      if (!this.visit) {
        this.visit = { at: t, firstKind: s.surfaceKind, dwellMs: 0, end: 'runEnd' };
        if (how !== 'userPlaced' && this.firstArrivalAt === null) this.firstArrivalAt = t;
      }
    }
    const v = this.visit;
    if (v && !ELEVATED.has(sup) && sup !== 'air') {
      v.dwellMs = t - v.at;
      v.end = this.stays[this.stays.length - 1]?.end ?? 'other';
      if (sup === 'held') v.end = 'user:drag';
      this.visits.push(v);
      this.visit = null;
    }
  }

  private arrivalHow(t: number): string {
    const p = this.lastSup;
    if (p === 'windowSide') return 'pullUp';
    if (ELEVATED_LEDGE.has(p)) return 'moved';
    if (p === 'air') {
      const f = this.lastFallRec;
      if (f && (f.reason === 'drop' || f.reason === 'throw') && t - f.at < 8000) return 'userPlaced';
      if (this.lastJump && t - this.lastJump.at < 5000) return `jumpUp:${this.lastJump.kind}`;
      return 'fellOnto';
    }
    return `from:${p}`;
  }

  private leaveReason(t: number, sup: string, onLedge: boolean): string {
    if (sup === 'held') return 'user:drag';
    if (onLedge) return 'moved';
    if (sup === 'windowSide') return 'voluntary:climbDown';
    if (sup === 'air') {
      const f = this.falls[this.falls.length - 1];
      if (this.lastJump && !this.lastJump.rec) return `voluntary:jump:${this.lastJump.kind}`;
      if (f && t - f.at <= 1000) {
        if (f.reason === 'step') return 'voluntary:stepOff';
        if (f.reason === 'perch') return 'supportLost:startle';
        if (f.reason === 'retracted') return 'supportLost:calm';
        return `fall:${f.reason}`;
      }
      return `air:${String(this.last?.state)}`;
    }
    if (sup === 'floor') return 'supportLost:settle';
    return `to:${sup}`;
  }

  private trackExcursion(t: number): void {
    const e = this.inner.excursion;
    if (e === undefined) return;
    if (this.ex && this.ex.ref !== e) {
      const x = this.ex;
      this.ex = null;
      const ok = x.ref.arrived;
      let reason = 'arrived';
      if (!ok) {
        const climbs = this.sim.surfaceDiagnostics().nav.climbs;
        const act = x.ref.act;
        if (this.desk.swaps !== x.swaps) reason = 'layoutChanged';
        else if (this.userInteractions !== x.user) reason = 'user';
        else if (x.lastCause === 'stimulus' || x.lastCause === 'interaction' || x.lastCause === 'lifecycle' || x.lastCause === 'command') reason = `interrupted:${x.lastCause}`;
        else if (climbs.reversed > x.climbs.reversed) reason = 'climbReversed';
        else if (climbs.letGo > x.climbs.letGo) reason = 'letGo';
        else if (act.goalStatus === 'unreachable') reason = 'unreachable';
        else if (x.ref.leftGround) reason = 'fellBack';
        else if (act.approachMs > 0 && t - act.startedAt >= act.approachMs - 50) reason = 'timeout';
        else reason = `ended:${act.goalStatus}`;
      }
      this.attempts.push({ kind: x.ref.kind, at: x.at, ms: t - x.at, ok, reason });
    }
    if (e && !this.ex) {
      const climbs = this.sim.surfaceDiagnostics().nav.climbs;
      this.ex = { ref: e, at: t, climbs: { reversed: climbs.reversed, letGo: climbs.letGo }, swaps: this.desk.swaps, user: this.userInteractions, lastCause: e.act.cause };
      inc(this.attemptStarts, `${e.kind}${e.fromElevated ? ':fromElevated' : ''}`);
    }
  }

  finish(t: number): void {
    this.flushView();
    this.endBout();
    if (this.stay) {
      this.stay.dwellMs = t - this.stay.at;
      this.stays.push(stripStay(this.stay));
      this.stay = null;
    }
    if (this.visit) {
      this.visit.dwellMs = t - this.visit.at;
      this.visits.push(this.visit);
      this.visit = null;
    }
  }
}

function stripStay(s: LedgeStay & { id: string; x0: number }): LedgeStay {
  return { kind: s.kind, how: s.how, via: s.via, at: s.at, dwellMs: s.dwellMs, end: s.end, leftDuring: s.leftDuring, walkedBl: s.walkedBl };
}

/** Which kind of option a decision candidate is (for probability mass per kind). */
export function bucketOf(c: Candidate, v: DecisionView, catY: number): string {
  const elevated = v.standingOn === 'windowTop' || v.standingOn === 'tabStrip';
  if (c.state === 'inspectingWindow') return c.variant === 'explore' ? TRIP_BUCKET : 'edgeLook';
  if (c.state === 'walking') {
    if (c.variant === 'climb') return c.then === 'walking' ? TRIP_BUCKET : 'goDown';
    if (c.variant === 'tabStrip') return v.standingOn === 'tabStrip' ? 'stripWalk' : TRIP_BUCKET;
    if (elevated && c.target && c.target.y > catY + BH) return 'goDown';
    if (c.variant === 'favorite') return 'sleep';
    return 'wander';
  }
  switch (c.state) {
    case 'chasingCursor':
      return 'chase';
    case 'watchingCursor':
      return 'watchCursor';
    case 'playing':
      return 'play';
    case 'fallingAsleep':
      return 'sleep';
    case 'seekingAttention':
      return 'social';
    case 'hiding':
    case 'startled':
      return 'wary';
    default:
      return 'calm';
  }
}

// ------------------------------------------------------------------ one run

export interface ProfileScenario {
  profile: ProfileId;
  layout: LayoutId;
  seed: number;
  hours: number;
  /** Local hour the run starts at (the user's evidence session started 18:31). */
  startHour?: number;
  usage?: Partial<UsageModel>;
}

export interface RunResult {
  profile: ProfileId;
  layout: LayoutId;
  seed: number;
  simMs: number;
  awakeMs: number;
  traits: Record<string, number>;
  probes: Record<string, 'ok' | 'missing'>;
  time: { state: Counter; variant: Counter; clip: Counter; support: Counter; category: Counter; movingMs: number; floorXDeciles: number[]; floorEdgeMs: number; floorMs: number; front: Counter; frontElevated: Counter };
  transitions: Counter;
  transitionCauses: Counter;
  dwellByState: Record<string, Dist>;
  decisions: {
    total: number;
    nullChoices: number;
    picks: Counter;
    results: Counter;
    where: Counter;
    /** Sum over decisions of the probability of each kind of option (= expected picks). */
    expected: Record<'floor' | 'elevated', Counter>;
    /** Decisions at which at least one option of the kind scored > 0. */
    eligible: Record<'floor' | 'elevated', Counter>;
    picksElevated: Counter;
    cooldownBlocked: Counter;
    targets: Record<string, Counter>;
    urgeAtFloorDecision: Dist;
  };
  locomotion: { bouts: number; byActivity: Counter; byCause: Counter; distPx: Dist };
  exploration: { starts: Counter; attempts: Attempt[] };
  elevated: { firstArrivalMs: number | null; stays: LedgeStay[]; visits: Visit[]; diagExcursions: number };
  cursor: { chaseStarts: number; chaseStartPhase: Counter; pounces: number; watchStarts: number; phaseEntries: Counter; bandMs: number; bandMovingMs: number };
  falls: FallRec[];
  jumps: JumpRec[];
  releases: ThrowReaction[];
  stats: Record<string, { min: number; mean: number; max: number; end: number }>;
  counters: Record<string, number>;
  nav: { climbs: Record<string, number> };
  user: Omit<UserLog, 'releases'> & { tabSwitches: number; layoutSwaps: number };
  integrity: { hostTicks: number; hostTickErrors: number; droppedEvents: number; invalidRequests: number; eventErrors: number; logErrors: number; wallMs: number };
}

const noop = (): void => undefined;

export function runProfile(sc: ProfileScenario): RunResult {
  const wallStart = Date.now();
  const usage: UsageModel = { ...DEFAULT_USAGE, ...(sc.usage ?? {}) };
  const runMs = sc.hours * HOUR;
  const startHour = sc.startHour ?? 18.5;
  const wall0 = new Date(2026, 9, 29, Math.floor(startHour), Math.round((startHour % 1) * 60), 0).getTime();
  const clock = new VirtualClock();
  const settings = profileSettings(sc.profile);
  const persisted = profileCat(sc.profile, sc.seed, wall0);
  const desk = new Desktop(sc.layout, () => clock.now);
  let logErrors = 0;
  const logger: Logger = {
    error: () => void logErrors++,
    warn: () => void logErrors++,
    info: noop,
    debug: noop,
    child: () => logger,
  };

  let recorder: Recorder | null = null;
  const sim = createInstrumentedCatSim(
    { persisted, settings, world: simWorld(WORLD), now: 0, random: mulberry32(sc.seed), wallClock: () => wall0 + clock.now },
    { onTransition: (r) => recorder?.onTransition(r) },
  );
  const inner = sim as unknown as SimInternals;
  const rec = new Recorder(sim, inner, desk);
  recorder = rec;
  const dv = inner.decisionView;
  if (typeof dv === 'function') {
    inner.decisionView = function decisionViewProbe(): DecisionView {
      const v = dv.call(sim);
      rec.onView(v);
      return v;
    };
  }
  const rc = inner.requestCandidate;
  if (typeof rc === 'function') {
    inner.requestCandidate = function requestCandidateProbe(c: Candidate, cause: string): string {
      const r = rc.call(sim, c, cause);
      rec.onRequest(c, cause, r);
      return r;
    };
  }
  const traits = { ...persisted.traits };
  const counters0 = rec.counters();
  const climbs0 = { ...sim.surfaceDiagnostics().nav.climbs };

  let lastOut: SimOutput | null = null;
  const hostSim: CatSim = {
    tick(env, events) {
      const out = sim.tick(env, events);
      lastOut = out;
      rec.onStep(env, events, out);
      return out;
    },
    updateSettings: (s) => sim.updateSettings(s),
    setWorld: (w) => sim.setWorld(w),
    serialize: () => sim.serialize(),
    resetPersonality: () => sim.resetPersonality(),
    clearHistory: () => sim.clearHistory(),
    get state() {
      return sim.state;
    },
    debugInfo: () => sim.debugInfo(),
    surfaceDiagnostics: () => sim.surfaceDiagnostics(),
    surfaceDebugLines: () => sim.surfaceDebugLines(),
  };

  // The host is created below; the user only enqueues once the clock runs.
  const user = new User(
    mulberry32(0x5eed + sc.seed * 7919),
    clock,
    desk,
    usage,
    settings.behavior.sleepAfterIdleMinutes * MIN,
    runMs,
    () => lastOut,
    (ev) => host.enqueue(ev),
    (r) => rec.onRelease(r),
  );
  const win32 = {
    available: true,
    getCursorPos: () => user.cursorAt(clock.now),
    getIdleMs: () => user.idleMs(clock.now),
    isLeftButtonDown: () => user.leftDown(clock.now),
  } as unknown as Win32Api;
  const tracker = {
    mode: 'event-hooks',
    start: noop,
    stop: noop,
    drainEvents: () => desk.drainWindowEvents(),
    getForeground: () => desk.foreground,
    getPlatforms: () => [],
    getWindowRect: () => null,
    getFullscreenDisplayIds: () => [],
    isExcludedAt: () => false,
    isForegroundExcluded: () => false,
    getExcludedRects: () => [],
    setExclusions: noop,
  } as unknown as WindowTracker;
  const display: DisplayService = {
    world: WORLD,
    onChange: () => noop,
    toLocalDip: (_id, p) => ({ x: p.x / 1.25, y: p.y / 1.25 }),
    fromLocalDip: (_id, p) => ({ x: p.x * 1.25, y: p.y * 1.25 }),
    displayAt: (p) => (p.x >= 0 && p.x < SCREEN_W && p.y >= 0 && p.y < SCREEN_H ? '1' : null),
    refresh: () => false,
    dispose: noop,
  };
  const overlays: HostOverlays = {
    render: noop,
    updateInteractivity: noop,
    isCursorOverCat: (c) => user.isOverCat(c),
    get dragging() {
      return user.dragging;
    },
    pressed: false,
    interactive: false,
  };
  const provider = {
    getSurfaces: () => desk.listed,
    getSurface: (id: string) => desk.getSurface(id),
    drainEvents: () => desk.drainSurfaceEvents(),
  } as unknown as HostSurfaceProvider;
  const activity = createActivityMonitor(win32, logger, { now: () => clock.now });
  const host = createCatHost({
    sim: hostSim,
    win32,
    tracker,
    activity,
    perception: null,
    display,
    overlays,
    catStore: { markDirty: noop, save: () => Promise.resolve(true) },
    logger,
    getSettings: () => settings,
    cursorFallback: () => null,
    clock: () => clock.now,
    wallClock: () => new Date(wall0 + clock.now),
    timers: { setTimeout: (fn, ms) => clock.setTimeout(fn, ms), clearTimeout: (h) => clock.clearTimeout(h) },
    timeScale: 1,
    surfaces: provider,
    taskbars: null,
  });

  // Start order of src/main/app.ts.
  activity.start();
  host.updateSettings(settings);
  host.start();
  user.start();
  if (sc.layout === 'L3') {
    const swap = (): void => {
      desk.setPhase(!desk.maximizedFront);
      clock.setTimeout(swap, L3_SWAP_MS);
    };
    clock.setTimeout(swap, L3_SWAP_MS);
  }
  clock.runUntil(runMs);
  host.stop();
  user.finish();
  rec.finish(rec.simMs);

  // Throws counted by the sim but released while the counter check had no event in view.
  const counters1 = rec.counters();
  const counters: Record<string, number> = {};
  for (const [k, v] of Object.entries(counters1)) counters[k] = v - (counters0[k] ?? 0);
  const climbs1 = sim.surfaceDiagnostics().nav.climbs;
  const climbs: Record<string, number> = {};
  for (const [k, v] of Object.entries(climbs1)) climbs[k] = v - ((climbs0 as Record<string, number>)[k] ?? 0);
  const stats: RunResult['stats'] = {};
  for (const [k, s] of Object.entries(rec.series)) {
    stats[k] = { min: round3(Math.min(...s)), mean: round3(s.reduce((a, b) => a + b, 0) / Math.max(1, s.length)), max: round3(Math.max(...s)), end: round3(s[s.length - 1] ?? 0) };
  }
  const dbg = sim.debugInfo();
  const hostDbg = host.debug();
  const { releases: _r, ...userLog } = user.log;
  const dwellByState: Record<string, Dist> = {};
  for (const [k, v] of Object.entries(rec.dwellByState)) dwellByState[k] = dist(v.map((x) => x / 1000));
  return {
    profile: sc.profile,
    layout: sc.layout,
    seed: sc.seed,
    simMs: Math.round(rec.simMs),
    awakeMs: Math.round(rec.awakeMs),
    traits,
    probes: rec.probes,
    time: {
      state: roundAll(rec.stateMs),
      variant: roundAll(rec.variantMs),
      clip: roundAll(rec.clipMs),
      support: roundAll(rec.supportMs),
      category: roundAll(rec.categoryMs),
      movingMs: Math.round(rec.movingMs),
      floorXDeciles: rec.floorX.map(Math.round),
      floorEdgeMs: Math.round(rec.edgeMs),
      floorMs: Math.round(rec.floorMs),
      front: roundAll(rec.frontMs),
      frontElevated: roundAll(rec.frontElevatedMs),
    },
    transitions: rec.transitions,
    transitionCauses: rec.transitionCauses,
    dwellByState,
    decisions: {
      total: rec.decisions,
      nullChoices: rec.decisionsNull,
      picks: rec.picks,
      results: rec.pickResults,
      where: rec.decisionsWhere,
      expected: { floor: round3All(rec.pBucket.floor), elevated: round3All(rec.pBucket.elevated) },
      eligible: rec.eligibleBucket,
      picksElevated: rec.picksElevated,
      cooldownBlocked: rec.cooldownBlocked,
      targets: rec.targetStatus,
      urgeAtFloorDecision: dist(rec.urgeAtDecision),
    },
    locomotion: { bouts: rec.boutsN, byActivity: rec.bouts, byCause: rec.boutCauses, distPx: dist(rec.boutDistPx) },
    exploration: { starts: rec.attemptStarts, attempts: rec.attempts },
    elevated: { firstArrivalMs: rec.firstArrivalAt, stays: rec.stays, visits: rec.visits, diagExcursions: sim.surfaceDiagnostics().decision.excursions },
    cursor: {
      chaseStarts: rec.chaseStarts,
      chaseStartPhase: rec.chaseStartPhase,
      pounces: rec.pounces,
      watchStarts: rec.watchStarts,
      phaseEntries: rec.phaseEntries,
      bandMs: Math.round(rec.cursorBandMs),
      bandMovingMs: Math.round(rec.cursorBandMovingMs),
    },
    falls: rec.falls,
    jumps: rec.jumps,
    releases: rec.reactions,
    stats,
    counters,
    nav: { climbs },
    user: { ...userLog, tabSwitches: desk.tabSwitches, layoutSwaps: desk.swaps },
    integrity: {
      hostTicks: hostDbg.ticks,
      hostTickErrors: hostDbg.tickErrors,
      droppedEvents: hostDbg.droppedEvents,
      invalidRequests: Number(dbg.invalidRequests ?? 0),
      eventErrors: Number(dbg.eventErrors ?? 0),
      logErrors,
      wallMs: Date.now() - wallStart,
    },
  };
}

const round3 = (x: number): number => Math.round(x * 1000) / 1000;
function roundAll(c: Counter): Counter {
  const o: Counter = {};
  for (const [k, v] of Object.entries(c)) o[k] = Math.round(v);
  return o;
}
function round3All(c: Counter): Counter {
  const o: Counter = {};
  for (const [k, v] of Object.entries(c)) o[k] = round3(v);
  return o;
}

// ------------------------------------------------------------------ many runs, aggregated

export interface ProfileConfig {
  label: string;
  hours: number;
  seeds: number[];
  profiles: ProfileId[];
  layouts: LayoutId[];
  startHour?: number;
  usage?: Partial<UsageModel>;
}

export function configFromEnv(env: Record<string, string | undefined>): ProfileConfig {
  const list = (v: string | undefined, all: readonly string[]): string[] => (v ? v.split(',').map((s) => s.trim()).filter((s) => all.includes(s)) : [...all]);
  // Defaults = the v1.2 baseline (3 sim-h x 8 seeds per cell), so a plain re-run is comparable.
  const seedsRaw = env.DESKTOP_CAT_PROFILE_SEEDS ?? '8';
  const seeds = seedsRaw.includes(',') ? seedsRaw.split(',').map(Number).filter(Number.isFinite) : Array.from({ length: Math.max(1, Number(seedsRaw) || 8) }, (_, i) => i + 1);
  return {
    label: (env.DESKTOP_CAT_PROFILE_LABEL ?? 'profile').replace(/[^A-Za-z0-9._-]/g, '_'),
    hours: Math.max(0.05, Number(env.DESKTOP_CAT_PROFILE_HOURS ?? '3') || 3),
    seeds,
    profiles: list(env.DESKTOP_CAT_PROFILE_PROFILES, PROFILE_IDS) as ProfileId[],
    layouts: list(env.DESKTOP_CAT_PROFILE_LAYOUTS, LAYOUT_IDS) as LayoutId[],
    ...(env.DESKTOP_CAT_PROFILE_START_HOUR ? { startHour: Number(env.DESKTOP_CAT_PROFILE_START_HOUR) } : {}),
  };
}

const perHour = (n: number, ms: number): number => (ms > 0 ? Math.round(((n * HOUR) / ms) * 100) / 100 : 0);
const share = (n: number, d: number): number => (d > 0 ? Math.round((1000 * n) / d) / 10 : 0);
const addInto = (dst: Counter, src: Counter): void => {
  for (const [k, v] of Object.entries(src)) inc(dst, k, v);
};

/** Pooled numbers for one (profile, layout) over its seeds: the tables of the report. */
export function summarizeCell(runs: readonly RunResult[]): Record<string, unknown> {
  const simMs = runs.reduce((a, r) => a + r.simMs, 0);
  const awakeMs = runs.reduce((a, r) => a + r.awakeMs, 0);
  const sum = (f: (r: RunResult) => Counter): Counter => {
    const c: Counter = {};
    for (const r of runs) addInto(c, f(r));
    return c;
  };
  const pctOf = (c: Counter, total: number): Counter => {
    const o: Counter = {};
    for (const [k, v] of Object.entries(c).sort((a, b) => b[1] - a[1])) o[k] = share(v, total);
    return o;
  };
  const category = sum((r) => r.time.category);
  const state = sum((r) => r.time.state);
  const variant = sum((r) => r.time.variant);
  const clip = sum((r) => r.time.clip);
  const support = sum((r) => r.time.support);
  const moving = runs.reduce((a, r) => a + r.time.movingMs, 0);
  const stays = runs.flatMap((r) => r.elevated.stays);
  const visits = runs.flatMap((r) => r.elevated.visits);
  const attempts = runs.flatMap((r) => r.exploration.attempts);
  const falls = runs.flatMap((r) => r.falls);
  const jumps = runs.flatMap((r) => r.jumps);
  const releases = runs.flatMap((r) => r.releases);
  const decisions = runs.reduce((a, r) => a + r.decisions.total, 0);
  const where = sum((r) => r.decisions.where);
  const byKind = (k: string): LedgeStay[] => stays.filter((s) => s.kind === k);
  const stayTable: Record<string, unknown> = {};
  for (const k of ['windowTop', 'tabStrip']) {
    const ks = byKind(k);
    const own = ks.filter((s) => s.how !== 'userPlaced' && s.how !== 'moved');
    const ends: Counter = {};
    for (const s of ks) inc(ends, s.end);
    const how: Counter = {};
    for (const s of ks) inc(how, s.how);
    const left: Counter = {};
    for (const s of ks) inc(left, s.leftDuring);
    stayTable[k] = {
      stays: ks.length,
      ownArrivalsPerHour: perHour(own.length, simMs),
      allPerHour: perHour(ks.length, simMs),
      dwellSec: dist(ks.map((s) => s.dwellMs / 1000)),
      dwellOwnSec: dist(own.map((s) => s.dwellMs / 1000)),
      how,
      endReasons: ends,
      leftDuring: Object.fromEntries(Object.entries(left).sort((a, b) => b[1] - a[1]).slice(0, 8)),
      walkedBl: dist(ks.map((s) => s.walkedBl)),
      dwellSecByEnd: Object.fromEntries(
        ['voluntary', 'user', 'supportLost', 'moved', 'runEnd'].map((cls) => [cls, dist(ks.filter((s) => s.end.split(':')[0] === cls).map((s) => s.dwellMs / 1000))]),
      ),
    };
  }
  const attemptTable: Record<string, unknown> = {};
  for (const k of [...new Set(attempts.map((a) => a.kind))]) {
    const ks = attempts.filter((a) => a.kind === k);
    const reasons: Counter = {};
    for (const a of ks) inc(reasons, a.reason);
    attemptTable[k] = { attempts: ks.length, perHour: perHour(ks.length, simMs), ok: ks.filter((a) => a.ok).length, successPct: share(ks.filter((a) => a.ok).length, ks.length), reasons, msToArrive: dist(ks.filter((a) => a.ok).map((a) => a.ms / 1000)) };
  }
  const fallsBy: Counter = {};
  for (const f of falls) inc(fallsBy, `${f.reason}${ELEVATED.has(f.fromSupport) ? '@elevated' : f.fromSupport === 'held' ? '' : `@${f.fromSupport}`}`);
  const recovery: Record<string, Dist> = {};
  for (const reason of [...new Set(falls.map((f) => f.reason))]) recovery[reason] = dist(falls.filter((f) => f.reason === reason && f.recoveryMs !== null).map((f) => (f.recoveryMs as number) / 1000));
  const jumpsBy: Counter = {};
  for (const j of jumps) {
    const dir = j.dy < -0.5 * BH ? 'up' : j.dy > 0.5 * BH ? 'down' : 'level';
    inc(jumpsBy, `${j.kind}:${ELEVATED.has(j.fromSupport) ? 'fromElevated' : `from:${j.fromSupport}`}:${dir}->${j.toSupport}`);
  }
  const voluntaryJumpDowns = jumps.filter((j) => ELEVATED.has(j.fromSupport) && j.dy > 0.5 * BH).length;
  const relBy: Record<string, unknown> = {};
  const relClass = (r: ThrowReaction): string => (r.kind === 'drag' ? 'drag' : r.thrown ? 'throw:hard' : 'throw:belowHard');
  for (const cls of ['drag', 'throw:belowHard', 'throw:hard']) {
    const rs = releases.filter((r) => relClass(r) === cls);
    const first: Counter = {};
    for (const r of rs) inc(first, r.first);
    const seq: Counter = {};
    for (const r of rs) inc(seq, r.states.slice(0, 3).join('>') || '-');
    relBy[cls] = {
      n: rs.length,
      firstReaction: first,
      sequences: Object.fromEntries(Object.entries(seq).sort((a, b) => b[1] - a[1]).slice(0, 6)),
      hidPct: share(rs.filter((r) => r.hid).length, rs.length),
      fearMax: dist(rs.map((r) => r.fearMax)),
      recoverySec: dist(rs.filter((r) => r.recoveryMs !== null).map((r) => (r.recoveryMs as number) / 1000)),
      speedDip: dist(rs.map((r) => r.speedDip)),
    };
  }
  const statsTable: Record<string, unknown> = {};
  for (const k of ['energy', 'boredom', 'bond', 'annoyance', 'fear', 'urge']) {
    const ss = runs.map((r) => r.stats[k]).filter((s): s is NonNullable<typeof s> => !!s);
    statsTable[k] = { min: round3(Math.min(...ss.map((s) => s.min))), mean: round3(ss.reduce((a, s) => a + s.mean, 0) / Math.max(1, ss.length)), max: round3(Math.max(...ss.map((s) => s.max))) };
  }
  const counters = sum((r) => r.counters);
  const countersPerAwakeHour: Counter = {};
  for (const [k, v] of Object.entries(counters)) countersPerAwakeHour[k] = perHour(v, awakeMs);
  const expectedFloor = sum((r) => r.decisions.expected.floor);
  const expectedElev = sum((r) => r.decisions.expected.elevated);
  const eligibleFloor = sum((r) => r.decisions.eligible.floor);
  const eligibleElev = sum((r) => r.decisions.eligible.elevated);
  const nFloor = where.floor ?? 0;
  const nElev = where.elevated ?? 0;
  const targets: Record<string, Counter> = {};
  for (const k of ['perch', 'climb', 'tabStrip']) targets[k] = pctOf(sum((r) => r.decisions.targets[k] ?? {}), decisions);
  const cursorBand = runs.reduce((a, r) => a + r.cursor.bandMs, 0);
  const cursorBandMoving = runs.reduce((a, r) => a + r.cursor.bandMovingMs, 0);
  const floorMs = runs.reduce((a, r) => a + r.time.floorMs, 0);
  const deciles = Array.from({ length: 10 }, (_, i) => share(runs.reduce((a, r) => a + (r.time.floorXDeciles[i] ?? 0), 0), floorMs));
  const picks = sum((r) => r.decisions.picks);
  const locoPicks = Object.entries(picks)
    .filter(([k]) => /^(walking|running|chasingCursor|seekingAttention)\//.test(k) || k === 'inspectingWindow/explore' || k === 'playing/zoomies')
    .reduce((a, [, v]) => a + v, 0);
  const firsts = runs.map((r) => (r.elevated.firstArrivalMs === null ? null : Math.round(r.elevated.firstArrivalMs / 1000)));
  return {
    runs: runs.length,
    simHours: Math.round((simMs / HOUR) * 100) / 100,
    awakeHours: Math.round((awakeMs / HOUR) * 100) / 100,
    timeSharePct: {
      category: pctOf(category, simMs),
      calmPlusAsleep: share((category.calm ?? 0) + (category.asleep ?? 0), simMs),
      active: share(category.active ?? 0, simMs),
      moving: share(moving, simMs),
      elevated: share((support.windowTop ?? 0) + (support.tabStrip ?? 0) + (support.windowSide ?? 0), simMs),
      /** Share of the time with a floating window in front / a maximized one in front, and the share of each spent up on windows. */
      front: pctOf(sum((r) => r.time.front), simMs),
      elevatedWhileWindowFront: share(
        runs.reduce((a, r) => a + (r.time.frontElevated.windowFront ?? 0), 0),
        runs.reduce((a, r) => a + (r.time.front.windowFront ?? 0), 0),
      ),
      elevatedWhileMaximizedFront: share(
        runs.reduce((a, r) => a + (r.time.frontElevated.maximizedFront ?? 0), 0),
        runs.reduce((a, r) => a + (r.time.front.maximizedFront ?? 0), 0),
      ),
      support: pctOf(support, simMs),
      state: pctOf(state, simMs),
      topVariants: Object.fromEntries(Object.entries(pctOf(variant, simMs)).slice(0, 20)),
      clip: pctOf(clip, simMs),
    },
    decisions: {
      total: decisions,
      perAwakeMin: Math.round((decisions / Math.max(1, awakeMs / MIN)) * 100) / 100,
      nullChoices: runs.reduce((a, r) => a + r.decisions.nullChoices, 0),
      results: sum((r) => r.decisions.results),
      picksPct: Object.fromEntries(Object.entries(pctOf(picks, Object.values(picks).reduce((a, b) => a + b, 0))).slice(0, 20)),
      floor: { n: nFloor, expectedPickPct: pctOf(expectedFloor, nFloor), eligiblePct: pctOf(eligibleFloor, nFloor) },
      elevated: { n: nElev, expectedPickPct: pctOf(expectedElev, nElev), eligiblePct: pctOf(eligibleElev, nElev), picks: sum((r) => r.decisions.picksElevated) },
      cooldownBlockedPctOfDecisions: pctOf(sum((r) => r.decisions.cooldownBlocked), decisions),
      targetStatusPct: targets,
      urgeAtFloorDecisionMedianPerRun: runs.map((r) => r.decisions.urgeAtFloorDecision.median),
    },
    locomotion: {
      autonomousLocomotionPicksPerHour: perHour(locoPicks, simMs),
      boutsPerHour: perHour(runs.reduce((a, r) => a + r.locomotion.bouts, 0), simMs),
      boutsByActivity: Object.fromEntries(Object.entries(sum((r) => r.locomotion.byActivity)).sort((a, b) => b[1] - a[1]).slice(0, 12)),
      boutsByCause: sum((r) => r.locomotion.byCause),
    },
    exploration: { starts: sum((r) => r.exploration.starts), byKind: attemptTable },
    elevated: {
      firstArrivalSec: firsts,
      diagExcursionsPerHour: perHour(runs.reduce((a, r) => a + r.elevated.diagExcursions, 0), simMs),
      byKind: stayTable,
      visits: { n: visits.length, perHour: perHour(visits.length, simMs), dwellSec: dist(visits.map((v) => v.dwellMs / 1000)) },
    },
    cursor: {
      chaseStartsPerHour: perHour(runs.reduce((a, r) => a + r.cursor.chaseStarts, 0), simMs),
      chaseStartPhase: sum((r) => r.cursor.chaseStartPhase),
      pouncesPerHour: perHour(runs.reduce((a, r) => a + r.cursor.pounces, 0), simMs),
      watchStartsPerHour: perHour(runs.reduce((a, r) => a + r.cursor.watchStarts, 0), simMs),
      phaseEntriesPerHour: Object.fromEntries(Object.entries(sum((r) => r.cursor.phaseEntries)).map(([k, v]) => [k, perHour(v, simMs)])),
      cursorInReachBandPctOfAwake: share(cursorBand, awakeMs),
      cursorInBandAndMovingPctOfAwake: share(cursorBandMoving, awakeMs),
    },
    falls: {
      byReason: fallsBy,
      perHour: perHour(falls.length, simMs),
      recoverySec: recovery,
      jumps: jumpsBy,
      voluntaryJumpDownsPerHour: perHour(voluntaryJumpDowns, simMs),
    },
    releases: relBy,
    stats: statsTable,
    countersPerAwakeHour,
    floor: { xDecilesPct: deciles, nearScreenEdgePct: share(runs.reduce((a, r) => a + r.time.floorEdgeMs, 0), floorMs) },
    user: {
      petSessionsPerHour: perHour(runs.reduce((a, r) => a + r.user.petSessions, 0), simMs),
      dragsPerHour: perHour(runs.reduce((a, r) => a + r.user.drags, 0), simMs),
      throwsPerHour: perHour(runs.reduce((a, r) => a + r.user.throws, 0), simMs),
      modeSharePct: pctOf(sum((r) => r.user.modeMs), simMs),
      tabSwitchesPerHour: perHour(runs.reduce((a, r) => a + r.user.tabSwitches, 0), simMs),
    },
    nav: sum((r) => r.nav.climbs),
    integrity: {
      hostTickErrors: runs.reduce((a, r) => a + r.integrity.hostTickErrors, 0),
      invalidRequests: runs.reduce((a, r) => a + r.integrity.invalidRequests, 0),
      eventErrors: runs.reduce((a, r) => a + r.integrity.eventErrors, 0),
      logErrors: runs.reduce((a, r) => a + r.integrity.logErrors, 0),
      wallSec: Math.round(runs.reduce((a, r) => a + r.integrity.wallMs, 0) / 1000),
    },
  };
}

export interface ProfileReport {
  meta: {
    harnessVersion: number;
    label: string;
    createdAt: string;
    config: ProfileConfig;
    usage: UsageModel;
    screen: string;
    layouts: Record<LayoutId, string>;
    userEvidencePerAwakeHour: typeof USER_EVIDENCE_PER_AWAKE_HOUR;
    labels: string;
  };
  cells: Record<string, Record<string, unknown>>;
  runs: RunResult[];
}

export function runProfiles(cfg: ProfileConfig, log: (msg: string) => void = noop): ProfileReport {
  const runs: RunResult[] = [];
  for (const profile of cfg.profiles) {
    for (const layout of cfg.layouts) {
      for (const seed of cfg.seeds) {
        const r = runProfile({ profile, layout, seed, hours: cfg.hours, ...(cfg.startHour !== undefined ? { startHour: cfg.startHour } : {}), ...(cfg.usage ? { usage: cfg.usage } : {}) });
        runs.push(r);
        const ex = r.elevated.stays.filter((s) => s.how !== 'userPlaced' && s.how !== 'moved').length;
        log(`profile ${profile}/${layout} seed ${seed}: ${(r.simMs / HOUR).toFixed(2)} sim-h in ${(r.integrity.wallMs / 1000).toFixed(1)} s; ${r.decisions.total} decisions, ${ex} own arrivals up, ${r.cursor.chaseStarts} chases`);
      }
    }
  }
  const cells: Record<string, Record<string, unknown>> = {};
  for (const profile of cfg.profiles) for (const layout of cfg.layouts) cells[`${profile}/${layout}`] = summarizeCell(runs.filter((r) => r.profile === profile && r.layout === layout));
  return {
    meta: {
      harnessVersion: HARNESS_VERSION,
      label: cfg.label,
      createdAt: new Date().toISOString(),
      config: cfg,
      usage: { ...DEFAULT_USAGE, ...(cfg.usage ?? {}) },
      screen: '1920x1200 px @125 % (1536x960 DIP), auto-hide bottom taskbar hidden (work area = screen), app floor inset',
      layouts: {
        L1: `floating Chrome-like window [${BROWSER_FRAME.x},${BROWSER_FRAME.y},${BROWSER_FRAME.width}x${BROWSER_FRAME.height}] in front, tab strip from the Edge 156 UIA probe geometry (3 tabs), tab selections`,
        L2: `floating app window [${APP_FRAME.x},${APP_FRAME.y},${APP_FRAME.width}x${APP_FRAME.height}] (editor; no tab strip discovered)`,
        L3: `L1 for 10 min, then a maximized window in front for 10 min, alternating (50 %)`,
      },
      userEvidencePerAwakeHour: USER_EVIDENCE_PER_AWAKE_HOUR,
      labels: 'SIMULATED: real Sim/Mover/host loop/activity monitor with synthetic input and provider-shaped surfaces; MOCKED OS stubs; not the real desktop',
    },
    cells,
    runs,
  };
}
