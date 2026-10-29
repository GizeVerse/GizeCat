// Headless end-to-end pipeline for surface traversal (v1.1.1). SIMULATED geometry through REAL code:
// the composition of src/main/app.ts on one virtual clock —
//   createKoffiWin32Api over a scripted native layer (MOCKED OS: FakeNative replays a z-order),
//   the real window tracker, activity monitor and taskbar tracker (fake TaskbarNative: an
//   auto-hide bottom taskbar, hidden), the real TabStripService with an in-process stand-in for
//   DesktopCatUia.exe (MOCKED helper speaking the real JSON-lines protocol; strip geometry from
//   the REAL uia-probe of Edge on this machine), the real surface provider, the real cat sim
//   (Sim + Mover) and the real createCatHost, plus the real diagnostics assembly and verdict.
// Global timers are virtualised during a run so in-module timers (the tab-strip service's pump,
// the helper client's quit grace) follow the same clock. Deterministic: seeded RNG, no wall time.
// Only kinds, ids, geometry and timings are recorded; no window title exists anywhere here.
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createCatSim, mulberry32, newPersistedCat } from '../../../src/core/behavior';
import { simWorld } from '../../../src/core/display/simWorld';
import { MOVEMENT } from '../../../src/core/movement/constants';
import { WorldModel } from '../../../src/core/movement/world';
import { createCatHost, type CatHost, type HostOverlays } from '../../../src/main/catHost';
import type { DisplayService, Logger } from '../../../src/main/contracts';
import { assembleSurfaceDiagnostics, type AssembledSurfaceDiagnostics } from '../../../src/main/diagnostics/surfaceDiagnostics';
import { createSurfaceProvider, type SurfaceProviderHandle } from '../../../src/main/surfaces';
import type { ChildProcessLike } from '../../../src/main/uia/client';
import type { WireStrip } from '../../../src/main/uia/protocol';
import { createTabStripService, type TabStripServiceImpl } from '../../../src/main/uia';
import { createActivityMonitor } from '../../../src/main/win32/activityMonitor';
import {
  EVENT_OBJECT_DESTROY,
  EVENT_OBJECT_HIDE,
  EVENT_SYSTEM_FOREGROUND,
  EVENT_SYSTEM_MINIMIZESTART,
  EVENT_SYSTEM_MOVESIZEEND,
  EVENT_SYSTEM_MOVESIZESTART,
} from '../../../src/main/win32/constants';
import { windowExclusionsFor } from '../../../src/main/win32/exclusionPolicy';
import type { RawRect } from '../../../src/main/win32/native';
import { createTaskbarTracker, type TaskbarNative } from '../../../src/main/win32/taskbar';
import { createKoffiWin32Api } from '../../../src/main/win32/win32Api';
import { createWindowTracker } from '../../../src/main/win32/windowTracker';
import { CAT_BASE_HEIGHT_DIP, CAT_BASE_WIDTH_DIP } from '../../../src/shared/cat';
import type { PersistedCat, Stats, Traits } from '../../../src/shared/catState';
import type { Point } from '../../../src/shared/geometry';
import { defaultSettings, type Settings } from '../../../src/shared/settings';
import type { SimEvent, SimOutput } from '../../../src/shared/sim';
import type { DecisionDiagnostics, NavDiagnostics } from '../../../src/shared/surfaceDiagnostics';
import type { Surface, SupportSurfaceKind } from '../../../src/shared/surfaces';
import type { DisplayGeometry, WorldGeometry } from '../../../src/shared/world';
import { FakeNative, raw } from '../../unit/win32/fakes';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

// ------------------------------------------------------------------ the user's screen

/** The reporting user's machine: one 1920x1200 display at 125 %, auto-hide bottom taskbar (work area = the whole screen). */
export const SCALE = 1.25;
export const SCREEN = { x: 0, y: 0, width: 1920, height: 1200 };
const MON: RawRect = { left: 0, top: 0, right: 1920, bottom: 1200 };
export const DISPLAY: DisplayGeometry = {
  id: '1',
  primary: true,
  scaleFactor: SCALE,
  boundsDip: { x: 0, y: 0, width: 1536, height: 960 },
  workAreaDip: { x: 0, y: 0, width: 1536, height: 960 },
  boundsPx: { ...SCREEN },
  workAreaPx: { ...SCREEN },
};
export const WORLD: WorldGeometry = { version: 1, displays: [DISPLAY] };
/** One body length / height at size 1 on this display (px). */
export const BODY_PX = CAT_BASE_WIDTH_DIP * SCALE;
export const BODY_H_PX = CAT_BASE_HEIGHT_DIP * SCALE;
/** The floor the sim walks on (work-area bottom minus the app's floor inset), px. */
export const FLOOR_Y = new WorldModel(simWorld(WORLD), 1, true).firstFloor.y;

const OWN_PID = 4242;
const TRAY_HWND = 65868n;
const TICK0 = 50_000_000;
/** 2026-10-29 13:10 local (a weekday afternoon): the daily rhythm is awake. */
export const WALL0 = new Date(2026, 9, 29, 13, 10, 0).getTime();

/** The user's cat (cat-state.json; docs/research/v1.1.1-floor-only-diagnosis.md). */
export const USER_TRAITS: Traits = { curiosity: 0.65, playfulness: 0.38, affection: 0.44, confidence: 0.51, energyLevel: 0.54, laziness: 0.33, startleSensitivity: 0.5 };
export const USER_STATS: Partial<Stats> = { energy: 0.74, boredom: 0.02 };

// ------------------------------------------------------------------ windows

export type Frame = [x: number, y: number, width: number, height: number];

export interface WinSpec {
  hwnd: string;
  exe: string;
  cls: string;
  /** DWM extended frame bounds (the visible edge), px. */
  frame: Frame;
  /** GetWindowRect (with the invisible resize borders), px. */
  rect: Frame;
  zoomed?: boolean;
  topmost?: boolean;
  tool?: boolean;
  noact?: boolean;
  /** A window of this app (its overlay or Settings window). */
  own?: boolean;
}

/** An ordinary app window as Windows 11 draws it: invisible 8 px resize borders on the left, right and bottom. */
export function appWindow(hwnd: string, exe: string, frame: Frame, o: Partial<WinSpec> = {}): WinSpec {
  const [x, y, w, h] = frame;
  const cls = /^(chrome|msedge)\.exe$/i.test(exe) ? 'Chrome_WidgetWin_1' : 'AppWindow';
  return { hwnd, exe, cls, frame, rect: [x - 8, y, w + 16, h + 8], ...o };
}

/** Topmost shell windows and the overlay (front), then the desktop (back), as on the user's machine. */
export const SHELL_FRONT: readonly WinSpec[] = [
  { hwnd: String(TRAY_HWND), exe: 'shell.exe', cls: 'Shell_TrayWnd', frame: [0, 1198, 1920, 60], rect: [0, 1198, 1920, 60], topmost: true, tool: true },
  { hwnd: '24449594', exe: 'self.exe', cls: 'Chrome_WidgetWin_1', frame: [0, 0, 1920, 1200], rect: [0, 0, 1920, 1200], topmost: true, tool: true, noact: true, own: true },
];
export const SHELL_BACK: readonly WinSpec[] = [{ hwnd: '65940', exe: 'shell.exe', cls: 'Progman', frame: [0, 0, 1920, 1200], rect: [0, 0, 1920, 1200], tool: true }];

/** The captured layout (tests/fixtures/user-layout-2026-10-29.json), front first. */
export interface UserLayoutWindow extends WinSpec {
  z: number;
  fg: boolean;
}

export function userLayout(): UserLayoutWindow[] {
  const doc = JSON.parse(fs.readFileSync(path.join(ROOT, 'tests', 'fixtures', 'user-layout-2026-10-29.json'), 'utf8')) as { windows: UserLayoutWindow[] };
  return doc.windows.map((w) => ({ ...w, frame: [...w.frame] as Frame, rect: [...w.rect] as Frame }));
}

const WS_EX_TOPMOST = 0x8;
const WS_EX_TRANSPARENT = 0x20;
const WS_EX_TOOLWINDOW = 0x80;
const WS_EX_LAYERED = 0x80000;
const WS_EX_NOACTIVATE = 0x08000000;
const WS_OVERLAPPEDWINDOW_VISIBLE = 0x16cf0000;
const WS_MAXIMIZE = 0x01000000;

const rawOf = (f: Frame): RawRect => raw(f[0], f[1], f[2], f[3]);

/** FakeNative whose input clock follows the virtual clock. */
class PipelineNative extends FakeNative {
  constructor(
    private readonly clock: () => number,
    private readonly lastInput: () => number,
  ) {
    super(OWN_PID);
  }
  override getTickCount(): number {
    return (TICK0 + Math.floor(this.clock())) >>> 0;
  }
  override getLastInputTick(): number {
    return this.lastInput() >>> 0;
  }
}

function addWindow(native: FakeNative, pids: Map<string, number>, w: WinSpec, at: 'end' | number = 'end'): void {
  let pid = w.own ? OWN_PID : pids.get(w.exe);
  if (pid === undefined) {
    pid = 1000 + pids.size;
    pids.set(w.exe, pid);
  }
  // The overlay (a topmost tool window of this app) is click-through except over the cat.
  const overlay = w.own === true && w.tool === true && w.topmost === true;
  const exStyle = (w.topmost ? WS_EX_TOPMOST : 0) | (w.tool ? WS_EX_TOOLWINDOW : 0) | (w.noact ? WS_EX_NOACTIVATE : 0) | (overlay ? WS_EX_TRANSPARENT | WS_EX_LAYERED : 0);
  const h = BigInt(w.hwnd);
  native.add(
    h,
    {
      pid,
      exStyle,
      style: WS_OVERLAPPEDWINDOW_VISIBLE | (w.zoomed ? WS_MAXIMIZE : 0),
      className: w.cls,
      title: '',
      iconic: false,
      zoomed: w.zoomed === true,
      frame: rawOf(w.frame),
      windowRect: rawOf(w.rect),
      monitor: { monitor: { ...MON }, work: { ...MON } },
    },
    `C:\\Apps\\${w.exe}`,
  );
  if (at !== 'end') {
    native.zOrder = native.zOrder.filter((x) => x !== h);
    native.zOrder.splice(at, 0, h);
  }
}

function fakeTaskbarNative(): TaskbarNative {
  // The captured Shell_TrayWnd: auto-hide, bottom, 60 px thick, hidden (2 px strip on screen).
  const hidden: RawRect = { left: 0, top: 1198, right: 1920, bottom: 1258 };
  return {
    findWindow: (cls) => (cls === 'Shell_TrayWnd' ? TRAY_HWND : null),
    findNextWindow: (cls, after) => (cls === 'Shell_TrayWnd' && after === null ? TRAY_HWND : null),
    isWindow: (h) => h === TRAY_HWND,
    isWindowVisible: (h) => h === TRAY_HWND,
    getWindowRect: (h) => (h === TRAY_HWND ? { ...hidden } : null),
    getMonitorRects: () => ({ monitor: { ...MON }, work: { ...MON } }),
    appBarState: () => 0x1,
    appBarTaskbarPos: () => ({ edge: 3, rect: { left: 0, top: 1140, right: 1920, bottom: 1200 } }),
    getExStyle: () => WS_EX_TOPMOST | WS_EX_TOOLWINDOW,
  };
}

function fakeDisplay(): DisplayService {
  return {
    world: WORLD,
    onChange: () => () => undefined,
    toLocalDip: (_id, p) => ({ x: p.x / SCALE, y: p.y / SCALE }),
    fromLocalDip: (_id, p) => ({ x: p.x * SCALE, y: p.y * SCALE }),
    displayAt: (p) => (p.x >= 0 && p.x < 1920 && p.y >= 0 && p.y < 1200 ? '1' : null),
    refresh: () => false,
    dispose: () => undefined,
  };
}

// ------------------------------------------------------------------ tab strips (helper stand-in)

/**
 * The REAL uia-probe of Edge 156 on this machine (125 %, 3 tabs): frame [133,125,1359,867], left
 * button +6 (40x45), tabs at +41/+340/+638 (320x52), new-tab button +953 (40x52), grab area +993
 * (193x52), caption buttons right-anchored (173x49). Placed on `frame`; a narrower frame shrinks
 * the tabs (as the browser does) so the controls keep their measured sizes.
 */
export function probeStrip(frame: RawRect, maximized: boolean, selected = 0): WireStrip {
  const fw = frame.right - frame.left;
  const fh = frame.bottom - frame.top;
  const capW = 173;
  const nbW = 40;
  const grabMin = 60;
  const start = 41;
  const measuredNb = 953;
  // Narrower than measured: the tabs shrink so the new-tab button, a grab area and the captions fit.
  const avail = fw - capW - grabMin - nbW;
  const k = measuredNb <= avail ? 1 : Math.max(0.1, (avail - start) / (measuredNb - start));
  const rel = (x: number): number => Math.round(start + (x - start) * k);
  const tabW = Math.round(320 * k);
  const nbX = rel(measuredNb);
  const grabX = nbX + nbW;
  const capX = fw - capW;
  const a = (x: number, y: number, w: number, h: number) => ({ x: frame.left + x, y: frame.top + y, w: Math.max(0, w), h });
  return {
    frame: { x: frame.left, y: frame.top, w: fw, h: fh },
    work: { x: 0, y: 0, w: 1920, h: 1200 },
    dpi: 120,
    container: a(start, 0, rel(959) - start, 52),
    tabs: [41, 340, 638].map((x, i) => ({ ...a(rel(x), 0, tabW, 52), selected: i === selected })),
    count: 3,
    leftButton: a(6, 0, 40, 45),
    newTab: a(nbX, 0, nbW, 52),
    grab: a(grabX, 0, capX - grabX, 52),
    captions: a(capX, 1, capW, 49),
    maximized,
    vertical: false,
    path: 'class',
    ms: 0.9,
  };
}

/** How the stand-in helper behaves. */
export type HelperMode =
  /** Answers like the real helper, with probe-shaped strips for browser windows. */
  | 'probe'
  /** Starts and answers ping, then hangs inside the first strip read (a stuck browser), like the real single-threaded helper. */
  | 'hung'
  /** Not installed (resolveUiaHelperPath found nothing). */
  | 'missing';

export interface HelperStats {
  spawns: number;
  requests: Record<string, number>;
  stripReads: Array<{ at: number; hwnd: string }>;
}

function fakeHelperSpawn(mode: HelperMode, native: FakeNative, vt: VirtualTime, stats: HelperStats, realSetImmediate: typeof setImmediate): (p: string) => ChildProcessLike {
  return () => {
    stats.spawns++;
    const child = new EventEmitter() as EventEmitter & Record<string, unknown>;
    const stdout = new EventEmitter() as EventEmitter & Record<string, unknown>;
    const stderr = new EventEmitter() as EventEmitter & Record<string, unknown>;
    const stdin = new EventEmitter() as EventEmitter & Record<string, unknown>;
    stdout.setEncoding = () => stdout;
    stderr.setEncoding = () => stderr;
    stdin.destroyed = false;
    stdin.writable = true;
    let closed = false;
    let stuck = false;
    const close = (code: number | null): void => {
      if (closed) return;
      closed = true;
      stdin.writable = false;
      stdin.destroyed = true;
      vt.asyncDirty = true;
      realSetImmediate(() => child.emit('close', code, null));
    };
    const send = (obj: unknown): void => {
      stdout.emit('data', `${JSON.stringify(obj)}\n`);
      vt.asyncDirty = true;
    };
    const handle = (line: string): void => {
      const req = JSON.parse(line) as { id?: number; op?: string; hwnd?: string; hwnds?: string[] };
      const op = req.op ?? '?';
      stats.requests[op] = (stats.requests[op] ?? 0) + 1;
      if (op === 'quit') {
        close(0);
        return;
      }
      if (stuck) return;
      if (op === 'ping') send({ id: req.id, ok: true, pong: true, version: 1, dpi: 'permonitorv2', watching: 0, prunedRender: 0, prunedOther: 0 });
      else if (op === 'watch') send({ id: req.id, ok: true, watching: (req.hwnds ?? []).length, failed: [] });
      else if (op === 'strip') {
        const hwnd = req.hwnd ?? '';
        stats.stripReads.push({ at: vt.now, hwnd });
        if (mode === 'hung') {
          stuck = true;
          return;
        }
        const w = /^[0-9]+$/.test(hwnd) ? native.windows.get(BigInt(hwnd)) : undefined;
        const exe = w ? (native.processes.get(w.pid) ?? '') : '';
        if (!w || !w.frame || w.visible !== true) send({ id: req.id, ok: false, error: 'gone', detail: null });
        else if (!/(chrome|msedge)\.exe$/i.test(exe)) send({ id: req.id, ok: false, error: 'rejected', detail: null });
        else send({ id: req.id, ok: true, strip: probeStrip(w.frame, w.zoomed === true) });
      } else send({ id: req.id ?? null, ok: false, error: 'bad-op', detail: null });
    };
    stdin.write = (s: string) => {
      for (const line of s.split('\n')) if (line.length > 0) handle(line);
      return true;
    };
    stdin.end = () => close(0);
    child.kill = () => {
      close(null);
      return true;
    };
    child.pid = 90_000 + stats.spawns;
    child.stdin = stdin;
    child.stdout = stdout;
    child.stderr = stderr;
    return child as unknown as ChildProcessLike;
  };
}

// ------------------------------------------------------------------ virtual time

interface TimerEntry {
  at: number;
  seq: number;
  fn: () => void;
  interval: number | null;
}

/** A timer heap on a virtual clock; yields to the real event loop when async work is pending. */
class VirtualTime {
  now = 0;
  asyncDirty = false;
  stop = false;
  private seq = 0;
  private heap: TimerEntry[] = [];
  private live = new Map<number, TimerEntry>();

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
  private pop(): TimerEntry | undefined {
    const h = this.heap;
    if (h.length === 0) return undefined;
    const top = h[0]!;
    const last = h.pop()!;
    if (h.length > 0) {
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
    return top;
  }
  setTimeout(fn: () => void, ms: number, interval: number | null = null): number {
    const id = ++this.seq;
    const e: TimerEntry = { at: this.now + Math.max(0, Number.isFinite(ms) ? ms : 0), seq: id, fn, interval };
    this.live.set(id, e);
    this.push(e);
    return id;
  }
  clearTimeout(id: unknown): void {
    const n = typeof id === 'number' ? id : typeof id === 'object' && id !== null && 'vid' in id ? (id as { vid: number }).vid : NaN;
    this.live.delete(n);
  }
  /** Fires timers due up to `end` (or until `stop` is set by one of them). */
  async runUntil(end: number, yieldNow: () => Promise<void>): Promise<void> {
    this.stop = false;
    let sinceYield = 0;
    for (;;) {
      const top = this.heap[0];
      if (!top || top.at > end) break;
      this.pop();
      if (this.live.get(top.seq) !== top) continue;
      this.live.delete(top.seq);
      this.now = Math.max(this.now, top.at);
      top.fn();
      if (top.interval !== null && !this.live.has(top.seq)) {
        const again: TimerEntry = { at: this.now + Math.max(1, top.interval), seq: top.seq, fn: top.fn, interval: top.interval };
        this.live.set(top.seq, again);
        this.push(again);
      }
      if (this.asyncDirty || ++sinceYield >= 2000) {
        this.asyncDirty = false;
        sinceYield = 0;
        await yieldNow();
      }
      if (this.stop) return;
    }
    this.now = Math.max(this.now, end);
  }
}

// ------------------------------------------------------------------ the pipeline

/** One host tick as the overlays saw it. */
export interface Sample {
  /** Sim clock (ms). */
  t: number;
  x: number;
  y: number;
  state: string;
  clip: string;
  /** 'floor', 'air', 'held', 'window', or the surface kind the cat is attached to. */
  support: 'floor' | 'air' | 'held' | 'window' | SupportSurfaceKind;
  surfaceId: string | null;
  snap: boolean;
  visible: boolean;
}

export interface PipelineOptions {
  /** App windows front first (the shell's topmost windows and desktop are added around them). */
  windows: readonly WinSpec[];
  /** Use `windows` as the complete z-order (a captured layout), without the shell windows. */
  completeZOrder?: boolean;
  foreground?: string | null;
  seed: number;
  /** Persisted cat; default a fresh cat from the seed. */
  cat?: PersistedCat;
  settings?: Settings;
  helper?: HelperMode;
  /**
   * 'present': the user works with the mouse in the far top-right corner (no typing, never near
   * the cat); 'idle': no input at all.
   */
  input?: 'present' | 'idle';
  /** The host's sim time multiplier (the E2E suite runs the real app at 10-20). Default 1. */
  timeScale?: number;
}

const realSetImmediate = setImmediate;
const yieldMacro = (): Promise<void> => new Promise((r) => realSetImmediate(r));

export function freshCat(seed: number, o: { traits?: Partial<Traits>; stats?: Partial<Stats> } = {}): PersistedCat {
  const cat = newPersistedCat(mulberry32(1000 + seed), WALL0 - 3600_000);
  Object.assign(cat.traits, o.traits ?? {});
  Object.assign(cat.stats, o.stats ?? {});
  cat.lastPosition = null;
  return cat;
}

export function userCat(seed: number): PersistedCat {
  return freshCat(seed, { traits: USER_TRAITS, stats: USER_STATS });
}

export class Pipeline {
  readonly vt = new VirtualTime();
  readonly native: PipelineNative;
  readonly settings: Settings;
  readonly provider: SurfaceProviderHandle;
  readonly tabs: TabStripServiceImpl;
  readonly host: CatHost;
  readonly sim: ReturnType<typeof createCatSim>;
  readonly samples: Sample[] = [];
  readonly helper: HelperStats = { spawns: 0, requests: {}, stripReads: [] };
  readonly logs: Array<{ t: number; l: string; s: string; m: string }> = [];
  /** Checked after every host tick; a true result stops the current run there. */
  private until: ((s: Sample) => boolean) | null = null;
  private restoreTimers: () => void;
  private lastInputTick = TICK0;
  private drift = 0;
  private dragging = false;
  private pids = new Map<string, number>();
  private disposed = false;

  constructor(o: PipelineOptions) {
    const vt = this.vt;
    this.restoreTimers = patchGlobalTimers(vt);
    const clock = (): number => vt.now;
    const logger = makeLogger(vt, this.logs);
    this.settings = o.settings ?? defaultSettings();
    const settings = this.settings;
    this.native = new PipelineNative(clock, () => this.lastInputTick);
    const native = this.native;
    const order = o.completeZOrder ? o.windows : [...SHELL_FRONT, ...o.windows, ...SHELL_BACK];
    for (const w of order) addWindow(native, this.pids, w);
    native.foreground = o.foreground === null ? null : BigInt(o.foreground ?? o.windows.find((w) => !w.own && !w.tool)?.hwnd ?? '0') || null;
    native.cursor = { x: 1860, y: 30 };

    const win32 = createKoffiWin32Api(native, logger, { now: clock });
    const tracker = createWindowTracker(win32, logger, { now: clock });
    const ex = windowExclusionsFor(settings);
    tracker.setExclusions(ex.processes, ex.titlePatterns);
    const activity = createActivityMonitor(win32, logger, { now: clock });
    const display = fakeDisplay();
    const taskbars = createTaskbarTracker(logger, { now: clock, native: fakeTaskbarNative(), world: display.world });
    const mode = o.helper ?? 'probe';
    this.tabs = createTabStripService({
      logger: logger.child('tab-strips'),
      settings,
      helperPath: mode === 'missing' ? null : 'C:\\pipeline\\DesktopCatUia.exe',
      describeWindow: (id) => win32.describeWindow(id),
      displayAt: (p) => display.displayAt(p),
      now: clock,
      spawnHelper: fakeHelperSpawn(mode, native, vt, this.helper, realSetImmediate),
    });
    this.provider = createSurfaceProvider({ logger, tracker, win32, taskbars, tabStrips: this.tabs, display, settings, now: clock });
    this.sim = createCatSim({ persisted: o.cat ?? freshCat(o.seed), settings, world: simWorld(display.world), now: 0, random: mulberry32(o.seed), wallClock: () => WALL0 + vt.now });

    const render = (out: SimOutput, simNow: number): void => {
      const s = sampleOf(out, simNow);
      this.samples.push(s);
      if (this.until && this.until(s)) vt.stop = true;
    };
    const dragging = (): boolean => this.dragging;
    const overlays: HostOverlays = {
      render,
      updateInteractivity: () => undefined,
      isCursorOverCat: () => false,
      get dragging() {
        return dragging();
      },
      pressed: false,
      interactive: false,
    };
    this.host = createCatHost({
      sim: this.sim,
      win32,
      tracker,
      activity,
      perception: null,
      display,
      overlays,
      catStore: { markDirty: () => undefined, save: () => Promise.resolve(true) },
      logger: logger.child('host'),
      getSettings: () => settings,
      cursorFallback: () => null,
      clock,
      wallClock: () => new Date(WALL0 + vt.now),
      timers: { setTimeout: (fn, ms) => vt.setTimeout(fn, ms), clearTimeout: (h) => vt.clearTimeout(h) },
      timeScale: o.timeScale ?? 1,
      surfaces: this.provider,
      taskbars,
    });
    // Start order of src/main/app.ts.
    tracker.start();
    taskbars.start();
    this.tabs.start();
    activity.start();
    this.host.updateSettings(settings);
    this.host.start();
    if ((o.input ?? 'present') === 'present') {
      vt.setTimeout(
        () => {
          if (this.dragging) return;
          this.drift++;
          native.cursor = { x: 1840 + ((this.drift * 3) % 60), y: 20 + ((this.drift >> 4) % 20) };
          this.lastInputTick = TICK0 + Math.floor(vt.now);
        },
        250,
        250,
      );
    }
  }

  get now(): number {
    return this.vt.now;
  }
  get last(): Sample {
    const s = this.samples[this.samples.length - 1];
    if (!s) throw new Error('no host tick yet');
    return s;
  }

  async run(ms: number): Promise<void> {
    this.until = null;
    await this.vt.runUntil(this.vt.now + ms, yieldMacro);
  }

  /** Runs until `pred` holds for a host tick (returns it) or `maxMs` pass (returns null). */
  async runUntil(pred: (s: Sample) => boolean, maxMs: number): Promise<Sample | null> {
    const from = this.samples.length;
    this.until = pred;
    try {
      await this.vt.runUntil(this.vt.now + maxMs, yieldMacro);
    } finally {
      this.until = null;
    }
    for (let i = this.samples.length - 1; i >= from; i--) if (pred(this.samples[i]!)) return this.samples[i]!;
    return null;
  }

  /** What the sim saw on the last tick. */
  get surfaces(): readonly Surface[] {
    return this.host.lastSurfaces;
  }

  surfaceDiagnostics(): { nav: NavDiagnostics; decision: DecisionDiagnostics } {
    return this.sim.surfaceDiagnostics();
  }

  /** The Diagnostics page's object and verdict code, assembled exactly as app.ts does. */
  diagnostics(): AssembledSurfaceDiagnostics {
    return assembleSurfaceDiagnostics({
      at: this.vt.now,
      dpiAwareness: 'per-monitor-v2',
      world: WORLD,
      output: this.host.lastOutput,
      observers: this.provider.status.windowSurfaces,
      provider: () => this.provider.diagnostics(),
      sim: () => this.sim.surfaceDiagnostics(),
    });
  }

  // ---- the desktop (what the OS would do and report) ----------------------------

  private win(hwnd: string) {
    const w = this.native.windows.get(BigInt(hwnd));
    if (!w) throw new Error(`no window ${hwnd}`);
    return w;
  }

  frame(hwnd: string): RawRect {
    const f = this.win(hwnd).frame;
    if (!f) throw new Error(`window ${hwnd} has no frame`);
    return { ...f };
  }

  /** Activates a window: it moves to the top of the non-topmost z-order and becomes the foreground window. */
  bringToFront(hwnd: string): void {
    const h = BigInt(hwnd);
    const n = this.native;
    const rest = n.zOrder.filter((x) => x !== h);
    const firstNormal = rest.findIndex((x) => ((n.windows.get(x)?.exStyle ?? 0) & WS_EX_TOPMOST) === 0);
    rest.splice(firstNormal < 0 ? rest.length : firstNormal, 0, h);
    n.zOrder = rest;
    n.foreground = h;
    n.fire(EVENT_SYSTEM_FOREGROUND, h);
  }

  /** Opens a new window (front, foreground). */
  openWindow(w: WinSpec): void {
    addWindow(this.native, this.pids, w, 0);
    this.bringToFront(w.hwnd);
  }

  /**
   * A user drag (or edge resize) from the current frame to `to` over `ms`: move-size start, the
   * frame changing every 16 ms, move-size end — what Windows reports while a window is dragged.
   */
  async moveSize(hwnd: string, to: RawRect, ms: number): Promise<void> {
    const h = BigInt(hwnd);
    const from = this.frame(hwnd);
    this.native.fire(EVENT_SYSTEM_MOVESIZESTART, h);
    const steps = Math.max(1, Math.round(ms / 16));
    for (let i = 1; i <= steps; i++) {
      const k = i / steps;
      const lerp = (a: number, b: number) => Math.round(a + (b - a) * k);
      this.setFrame(hwnd, { left: lerp(from.left, to.left), top: lerp(from.top, to.top), right: lerp(from.right, to.right), bottom: lerp(from.bottom, to.bottom) });
      await this.run(16);
    }
    this.native.fire(EVENT_SYSTEM_MOVESIZEEND, h);
  }

  private setFrame(hwnd: string, f: RawRect): void {
    const w = this.win(hwnd);
    w.frame = { ...f };
    w.windowRect = { left: f.left - 8, top: f.top, right: f.right + 8, bottom: f.bottom + 8 };
    this.frameLog.push({ t: this.vt.now, hwnd, frame: { ...f } });
  }

  /** Frames set by moveSize, in order. */
  readonly frameLog: Array<{ t: number; hwnd: string; frame: RawRect }> = [];

  /** The frame `hwnd` had at virtual time t (from moveSize's log; null before any change). */
  frameAt(hwnd: string, t: number): RawRect | null {
    let best: RawRect | null = null;
    for (const e of this.frameLog) if (e.hwnd === hwnd && e.t <= t) best = e.frame;
    return best;
  }

  minimize(hwnd: string): void {
    const h = BigInt(hwnd);
    this.win(hwnd).iconic = true;
    this.native.fire(EVENT_SYSTEM_MINIMIZESTART, h);
  }

  /** Maximizes a window in place (no WinEvent for it: the periodic z-order read picks it up). */
  maximize(hwnd: string): void {
    const w = this.win(hwnd);
    w.zoomed = true;
    w.style = (w.style ?? 0) | WS_MAXIMIZE;
    w.frame = { ...MON };
    w.windowRect = { left: -9, top: -9, right: 1929, bottom: 1209 };
  }

  /** Closes a window: hidden, then destroyed. */
  close(hwnd: string): void {
    const h = BigInt(hwnd);
    this.win(hwnd).visible = false;
    this.native.fire(EVENT_OBJECT_HIDE, h);
    this.native.windows.delete(h);
    this.native.zOrder = this.native.zOrder.filter((x) => x !== h);
    if (this.native.foreground === h) this.native.foreground = null;
    this.native.fire(EVENT_OBJECT_DESTROY, h);
  }

  // ---- the user's hand on the cat ----------------------------------------------

  /** Grabs the cat where it is: the overlay reports a drag start and the cursor follows it. */
  grab(): Point {
    const at = { x: this.last.x, y: this.last.y - BODY_H_PX / 2 };
    this.native.cursor = { ...at };
    this.dragging = true;
    this.lastInputTick = TICK0 + Math.floor(this.vt.now);
    this.host.enqueue({ type: 'pointer.dragStart', at });
    return at;
  }

  /** Moves the held cat to `to` over `ms`. */
  async carry(to: Point, ms: number): Promise<void> {
    const from = { ...(this.native.cursor ?? to) };
    const steps = Math.max(1, Math.round(ms / 16));
    for (let i = 1; i <= steps; i++) {
      const k = i / steps;
      this.native.cursor = { x: Math.round(from.x + (to.x - from.x) * k), y: Math.round(from.y + (to.y - from.y) * k) };
      this.lastInputTick = TICK0 + Math.floor(this.vt.now);
      await this.run(16);
    }
  }

  /** Lets go with `velocity` (px/s): a throw, or a drop when slow. */
  release(velocity: Point): void {
    const at = { ...(this.native.cursor ?? { x: this.last.x, y: this.last.y }) };
    this.dragging = false;
    this.host.enqueue({ type: 'pointer.dragEnd', at, velocity });
  }

  enqueue(ev: SimEvent): void {
    this.host.enqueue(ev);
  }

  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    try {
      this.host.stop();
      await this.provider.dispose();
      this.tabs.stop();
      await this.vt.runUntil(this.vt.now + 3000, yieldMacro);
    } finally {
      this.restoreTimers();
    }
  }
}

function sampleOf(out: SimOutput, t: number): Sample {
  const s = out.support;
  const support: Sample['support'] = s.kind === 'surface' ? s.surfaceKind : s.kind;
  return { t, x: out.x, y: out.y, state: out.state, clip: out.clip, support, surfaceId: s.kind === 'surface' ? s.surfaceId : null, snap: out.snap, visible: out.visible };
}

function patchGlobalTimers(vt: VirtualTime): () => void {
  const g = globalThis as unknown as Record<string, unknown>;
  const saved = { setTimeout: g.setTimeout, clearTimeout: g.clearTimeout, setInterval: g.setInterval, clearInterval: g.clearInterval };
  const handle = (vid: number) => ({
    vid,
    unref() {
      return this;
    },
    ref() {
      return this;
    },
    hasRef: () => false,
    [Symbol.toPrimitive]: () => vid,
  });
  g.setTimeout = (fn: () => void, ms?: number) => handle(vt.setTimeout(fn, ms ?? 0));
  g.setInterval = (fn: () => void, ms?: number) => handle(vt.setTimeout(fn, ms ?? 0, ms ?? 0));
  g.clearTimeout = (h: unknown) => vt.clearTimeout(h);
  g.clearInterval = (h: unknown) => vt.clearTimeout(h);
  return () => Object.assign(g, saved);
}

function makeLogger(vt: VirtualTime, sink: Array<{ t: number; l: string; s: string; m: string }>): Logger {
  const make = (scope: string): Logger => {
    const put = (l: string) => (m: string) => {
      if (sink.length < 20_000) sink.push({ t: Math.round(vt.now), l, s: scope, m });
    };
    return { error: put('error'), warn: put('warn'), info: put('info'), debug: put('debug'), child: (c) => make(`${scope}.${c}`) };
  };
  return make('main');
}

// ------------------------------------------------------------------ measurements

export const ELEVATED: ReadonlySet<string> = new Set(['windowTop', 'windowSide', 'tabStrip']);
export const STANDING_UP: ReadonlySet<string> = new Set(['windowTop', 'tabStrip']);

/** One uninterrupted stay on one ledge (top or strip). */
export interface Stay {
  surfaceId: string;
  kind: string;
  from: number;
  to: number;
  /** Horizontal path walked while on it (px). */
  pathPx: number;
  /** Furthest apart two positions on it were (px). */
  spanPx: number;
}

/** Stays on window tops / tab strips in `samples` (consecutive ticks on the same surface). */
export function stays(samples: readonly Sample[]): Stay[] {
  const out: Stay[] = [];
  let cur: (Stay & { minX: number; maxX: number; lastX: number }) | null = null;
  for (const s of samples) {
    if (cur && s.surfaceId === cur.surfaceId) {
      cur.pathPx += Math.abs(s.x - cur.lastX);
      cur.lastX = s.x;
      cur.minX = Math.min(cur.minX, s.x);
      cur.maxX = Math.max(cur.maxX, s.x);
      cur.to = s.t;
      continue;
    }
    if (cur) out.push(finish(cur));
    cur = s.surfaceId !== null && STANDING_UP.has(s.support) ? { surfaceId: s.surfaceId, kind: s.support, from: s.t, to: s.t, pathPx: 0, spanPx: 0, minX: s.x, maxX: s.x, lastX: s.x } : null;
  }
  if (cur) out.push(finish(cur));
  return out;
  function finish(c: Stay & { minX: number; maxX: number }): Stay {
    return { surfaceId: c.surfaceId, kind: c.kind, from: c.from, to: c.to, pathPx: Math.round(c.pathPx), spanPx: Math.round(c.maxX - c.minX) };
  }
}

/** Largest per-tick displacement (px) and speed (px/s) between consecutive visible ticks, and the ticks flagged as a position jump. */
export function motion(samples: readonly Sample[]): { maxStepPx: number; maxSpeed: number; snaps: number } {
  let maxStepPx = 0;
  let maxSpeed = 0;
  let snaps = 0;
  for (let i = 1; i < samples.length; i++) {
    const a = samples[i - 1]!;
    const b = samples[i]!;
    if (!a.visible || !b.visible) continue;
    if (b.snap) snaps++;
    const d = Math.hypot(b.x - a.x, b.y - a.y);
    maxStepPx = Math.max(maxStepPx, d);
    const dt = b.t - a.t;
    if (dt > 0) maxSpeed = Math.max(maxSpeed, (d * 1000) / dt);
  }
  return { maxStepPx: Math.round(maxStepPx * 10) / 10, maxSpeed: Math.round(maxSpeed), snaps };
}

export const onWindow = (hwnd: string) => (s: Sample): boolean => s.surfaceId !== null && s.surfaceId.split(':')[1] === hwnd;
export const onTopOf = (hwnd: string) => (s: Sample): boolean => onWindow(hwnd)(s) && STANDING_UP.has(s.support);
export const sideOf = (hwnd: string) => (s: Sample): boolean => onWindow(hwnd)(s) && s.support === 'windowSide';
export const onFloor = (s: Sample): boolean => s.support === 'floor';

/** Free-fall speed from the top of this screen to the floor (px/s): no motion of an unthrown cat is faster. */
export const FALL_MAX_SPEED = Math.sqrt(2 * MOVEMENT.gravityDip * SCALE * FLOOR_Y);
/** Fastest the cat moves on its own on a support (px/s): running. */
export const RUN_SPEED = MOVEMENT.runDip * SCALE;
