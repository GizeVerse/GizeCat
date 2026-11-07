// v1.2 "lively cat" REAL E2E (ADR 0003 §15.4): the real app on this desktop with OWN windows only.
// Run one scenario at a time under the lock, for example:
//   DESKTOP_CAT_E2E_LIVELY=1 node scripts/with-lock.mjs e2e -- npx playwright test tests/e2e/lively.spec.ts -g "window:"
// Every spec
//   - starts its own windows (tests/e2e/ownWindows.ts) and calls restrictSurfacesToPids([own pids]),
//     so the user's windows never become surfaces;
//   - keeps its windows topmost and the app's overlays above them (re-asserted every second), and
//     checks the z-order before every WindowFromPoint, so neither the user's windows nor ours can
//     make a click-through check vacuous;
//   - observes the sim with hooks only: the cat's position and state are never assigned;
//   - moves the cursor only through injectCursor (never the real cursor) and sends no OS input;
//   - closes only what it opened.
// Opt-in, because these put windows over the desk: DESKTOP_CAT_E2E_LIVELY=1 (window, hunt, throws,
// screen edge, covered support, sound), DESKTOP_CAT_REAL_BROWSER=1 (own Edge and Chrome, or only the
// one named by DESKTOP_CAT_REAL_BROWSER_KIND), DESKTOP_CAT_E2E_TERMINAL=1 (own Terminal window),
// DESKTOP_CAT_E2E_EXPLORER=1 (own Explorer window), DESKTOP_CAT_E2E_EXPLORER_SOAK=1 (>= 2 h).
// Labels: what a spec asserts on is REAL once it has run here, except the cursor and drag input,
// which are SIMULATED (the app they reach is real). A case it cannot set up is annotated UNVERIFIED
// and skipped, never passed. A person at the desk is recorded as a confounder, never passed over.
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import type { ElectronApplication, Page, TestInfo } from '@playwright/test';
import koffi from 'koffi';
import type { BehaviorProfileSnapshot, ExcursionRecord } from '../../src/shared/behaviorProfile';
import { CAT_BASE_HEIGHT_DIP, CAT_BASE_WIDTH_DIP } from '../../src/shared/cat';
import type { Point, Rect } from '../../src/shared/geometry';
import type { SimOutput } from '../../src/shared/sim';
import type { LedgeSurface } from '../../src/shared/surfaces';
import { closeBrowser, enablePerMonitorDpiAwareness, findBrowser, instancePids, launchBrowser, openTabs, waitForBrowserWindow, type BrowserInstance, type BrowserKind } from '../integration/uia/realBrowser';
import { expect, hook, launchApp, quitApp, readLogLines, test, waitForCat } from './fixtures';
import { frameOf, keepTopmost, moveOwnWindow, openExplorerWindow, openOwnWindow, openTerminalWindow, rectOf, type OwnWindow, type OwnWindowReport } from './ownWindows';
import { win32Probe, WS_EX_TRANSPARENT } from './win32Probe';

const LIVELY = process.env.DESKTOP_CAT_E2E_LIVELY === '1';
const BROWSER = process.env.DESKTOP_CAT_REAL_BROWSER === '1';
const BROWSER_KIND = process.env.DESKTOP_CAT_REAL_BROWSER_KIND ?? null;
const TERMINAL = process.env.DESKTOP_CAT_E2E_TERMINAL === '1';
const EXPLORER = process.env.DESKTOP_CAT_E2E_EXPLORER === '1';
const SOAK = process.env.DESKTOP_CAT_E2E_EXPLORER_SOAK === '1';
const SOAK_MIN = Math.max(1, Number(process.env.DESKTOP_CAT_E2E_SOAK_MIN ?? '120') || 120);

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
const attachedId = (out: SimOutput | null): string | null => (out && out.support.kind === 'surface' ? out.support.surfaceId : null);
const supportKind = (out: SimOutput | null): string | null => (out && out.support.kind === 'surface' ? out.support.surfaceKind : (out?.support.kind ?? null));
const center = (r: Rect): Point => ({ x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) });
const median = (v: readonly number[]): number => {
  const s = [...v].sort((a, b) => a - b);
  return s.length === 0 ? 0 : (s[Math.floor(s.length / 2)] as number);
};
const round1 = (v: number): number => Math.round(v * 10) / 10;

interface Obs {
  simNow: number;
  out: SimOutput | null;
  profile: BehaviorProfileSnapshot;
}

async function observe(app: ElectronApplication): Promise<Obs> {
  return app.evaluate(() => {
    const api = (globalThis as Record<string, unknown>)['__desktopCatTest'] as { getSimOutput(): SimOutput | null; getHostDebug(): { simNow: number }; getBehaviorProfile(): BehaviorProfileSnapshot };
    return { simNow: api.getHostDebug().simNow, out: api.getSimOutput(), profile: api.getBehaviorProfile() };
  });
}

/** Records a measurement on the test (the list reporter prints the [measure] line). */
function record(info: TestInfo, what: string, data: unknown): void {
  const text = JSON.stringify(data);
  info.annotations.push({ type: what, description: text });
  console.log(`[measure] ${what}: ${text}`);
}

function annotate(info: TestInfo, type: 'REAL' | 'UNVERIFIED' | 'SIMULATED', description: string): void {
  info.annotations.push({ type, description });
  console.log(`[label] ${type}: ${description}`);
}

/** Skip with the reason recorded (so every environment skip is visible in the report). */
function skipBecause(info: TestInfo, reason: string): void {
  annotate(info, 'UNVERIFIED', reason);
  test.skip(true, reason);
}

/** The app's overlay windows (to keep them above our own topmost test windows). */
async function overlayHwnds(app: ElectronApplication): Promise<string[]> {
  return (await hook(app, 'getOverlays')).map((o) => o.hwnd);
}

/** The overlay is in front of our window (so WindowFromPoint can only see our window if the overlay is click-through there). */
function overlayInFront(overlays: readonly string[], ours: string): boolean {
  const p = win32Probe();
  const zo = Math.min(...overlays.map((h) => p.zIndex(h)).filter((z) => z >= 0));
  const zw = p.zIndex(ours);
  return zo >= 0 && zw >= 0 && zo < zw;
}

/**
 * A normal fresh cat (nothing seeded). Only the first-run flow is marked done and, unless a test is
 * about the mouse, two things a person at this PC could do to the run are kept out: the cat does not
 * fall asleep because they have been away (real idle time is not scaled), and it cannot be picked up
 * by hand (the overlay stays click-through; the sim's autonomous behaviour does not depend on it).
 */
async function startApp(userData: string, pids: number[], o: { interaction?: boolean } = {}): Promise<ElectronApplication> {
  const app = await launchApp(userData);
  await waitForCat(app);
  const patched = await hook(app, 'patchSettings', { general: { firstRunCompleted: true }, behavior: { sleepAfterIdleMinutes: 120 }, interaction: { enabled: o.interaction === true } });
  expect(patched.ok).toBe(true);
  await hook(app, 'restrictSurfacesToPids', pids);
  await keepPresentAtEmptyDesk(app);
  return app;
}

/** Bound once per worker: koffi refuses a second struct with the same name ('Duplicate type name'). */
let lastInputApi: (() => number) | null = null;

/** Real ms since the last input on this desk (GetLastInputInfo through user32 in this process; nothing is sent). */
function realDeskIdleMs(): number {
  if (!lastInputApi) {
    const user32 = koffi.load('user32.dll');
    const kernel32 = koffi.load('kernel32.dll');
    const INFO = koffi.struct('DCAT_E2E_LASTINPUT', { cbSize: 'uint32_t', dwTime: 'uint32_t' });
    const GetLastInputInfo = user32.func('__stdcall', 'GetLastInputInfo', 'int', [koffi.inout(koffi.pointer(INFO))]);
    const GetTickCount = kernel32.func('__stdcall', 'GetTickCount', 'uint32_t', []);
    lastInputApi = () => {
      const info = { cbSize: koffi.sizeof(INFO), dwTime: 0 };
      if (!GetLastInputInfo(info)) return 0;
      return ((GetTickCount() as number) - info.dwTime) >>> 0;
    };
  }
  return lastInputApi();
}

/** The user-presence input the run was started with: real, or SIMULATED once the desk has been empty for an hour. */
let presence: { realIdleMin: number; simulated: boolean } = { realIdleMin: 0, simulated: false };

/**
 * The app sends an idle desk's cat to sleep (120 real minutes at most, and an idle sleep lasts until
 * someone comes back), so at an empty desk a time-scaled run says nothing about what an awake cat does.
 * From an hour of real idle time the sim is told someone last touched the PC a minute and a half ago:
 * a moment "just back" to end an idle sleep, then that.
 */
async function keepPresentAtEmptyDesk(app: ElectronApplication): Promise<void> {
  const idle = realDeskIdleMs();
  presence = { realIdleMin: Math.round(idle / 60_000), simulated: idle >= 60 * 60_000 };
  console.log(`[measure] userPresence: ${JSON.stringify(presence)}`);
  if (!presence.simulated) return;
  await hook(app, 'injectUserIdle', 1000);
  await sleep(4000);
  await hook(app, 'injectUserIdle', 90_000);
}

/** An own window's first report; one closed from outside before it (e.g. someone at the desk) skips the run. */
async function ownReport(info: TestInfo, own: OwnWindow, what: string): Promise<OwnWindowReport> {
  try {
    return await own.next();
  } catch (err) {
    if (own.closedFromOutside()) skipBecause(info, `environment: ${what} was closed from outside the test before the run started`);
    throw err;
  }
}

/** Precondition: our own window is really in front at its top edge and sides; otherwise the run says nothing. */
async function requireInFront(info: TestInfo, hwnd: string, what: string, own?: OwnWindow): Promise<void> {
  const w32 = win32Probe();
  await sleep(500);
  const f = frameOf(hwnd);
  // Closed from outside (its close button, Alt+F4 or another program; e.g. someone at the desk):
  // the run says nothing about the app, so it is skipped, not failed.
  if (!f && own?.closedFromOutside()) skipBecause(info, `environment: ${what} was closed from outside the test before the run started`);
  if (!f) throw new Error(`${what}: no frame`);
  const points: Array<[number, number]> = [
    [f.x + f.width / 2, f.y + 4],
    [f.x + 4, f.y + f.height / 2],
    [f.x + f.width - 4, f.y + f.height / 2],
  ];
  const covered = (): number => points.filter(([x, y]) => w32.rootWindowAt(Math.round(x), Math.round(y)) !== hwnd).length;
  let c = covered();
  if (c > 0) {
    w32.setOwnWindowTopmost(hwnd, true);
    await sleep(500);
    c = covered();
  }
  if (c > 0) skipBecause(info, `environment: ${what} is covered at ${c} of 3 edge points (a window above the topmost band, e.g. fullscreen)`);
}

function profileDelta(a: BehaviorProfileSnapshot, b: BehaviorProfileSnapshot, cause: string): number {
  return ((b.falls.byCause as Record<string, number>)[cause] ?? 0) - ((a.falls.byCause as Record<string, number>)[cause] ?? 0);
}

async function scaleOf(app: ElectronApplication): Promise<{ scale: number; bw: number; bh: number }> {
  const scale = await app.evaluate(({ screen }) => screen.getPrimaryDisplay().scaleFactor);
  const size = (await hook(app, 'getSettings')).appearance.size;
  return { scale, bw: CAT_BASE_WIDTH_DIP * scale * size, bh: CAT_BASE_HEIGHT_DIP * scale * size };
}

function alive(pid: number | undefined): boolean {
  if (pid === undefined) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

// ------------------------------------------------------------------ the tracker

interface TrackedStay {
  id: string;
  fromSim: number;
  toSim: number;
  /** Walked along the surface (px, relative to the window, so the window's own moves do not count). */
  pathPx: number;
  /** Own geometry updates applied while the cat stood here. */
  updates: number;
  open: boolean;
}

interface StaySummary {
  n: number;
  medianS: number;
  minS: number;
  maxS: number;
  byKind: Record<string, number>;
  byReason: Record<string, number>;
  byLeave: Record<string, number>;
  byArrivedBy: Record<string, number>;
  overdue: number;
}

function summarizeStays(recs: readonly ExcursionRecord[]): StaySummary {
  const add = (m: Record<string, number>, k: string | null | undefined): void => {
    m[k ?? 'none'] = (m[k ?? 'none'] ?? 0) + 1;
  };
  const s: StaySummary = { n: recs.length, medianS: 0, minS: 0, maxS: 0, byKind: {}, byReason: {}, byLeave: {}, byArrivedBy: {}, overdue: 0 };
  const d = recs.map((r) => r.dwellMs / 1000);
  s.medianS = round1(median(d));
  s.minS = round1(d.length ? Math.min(...d) : 0);
  s.maxS = round1(d.length ? Math.max(...d) : 0);
  for (const r of recs) {
    add(s.byKind, r.surfaceKind);
    add(s.byReason, r.endReason);
    if (r.leaveKind) add(s.byLeave, r.leaveKind);
    add(s.byArrivedBy, r.arrivedBy);
    if (r.overdue) s.overdue++;
  }
  return s;
}

/**
 * Follows the cat through polls of the sim output (~60 ms of wall time): stays seen from outside
 * (walked px relative to the window, own geometry updates survived), finished stays as the profile
 * records them, clips and states seen, and the confounders: held by hand, our window moved by
 * something else, typing.
 */
class Tracker {
  readonly stays: TrackedStay[] = [];
  readonly records = new Map<number, ExcursionRecord>();
  readonly clips = new Map<string, number>();
  readonly jumpKinds = new Set<string>();
  readonly states = new Set<string>();
  readonly heldAtS: number[] = [];
  readonly unexpectedMoveAtS: number[] = [];
  polls = 0;
  /** Polls with the cat hidden (a fullscreen app in front, the PC locked): nothing it does counts then. */
  invisiblePolls = 0;
  last: Obs | null = null;
  first: Obs | null = null;
  private cur: (TrackedStay & { lastRelX: number }) | null = null;
  private readonly w0 = Date.now();
  private expected: string | null = null;

  constructor(
    private readonly app: ElectronApplication,
    private readonly hwnd: string | null,
  ) {
    if (hwnd) this.expected = JSON.stringify(rectOf(hwnd));
  }

  /** A geometry update this test made itself: not a confounder, and it counts for the stay it happened in. */
  ownMove(): void {
    if (this.hwnd) this.expected = JSON.stringify(rectOf(this.hwnd));
    if (this.cur) this.cur.updates++;
  }

  /** A change of the own window this test made through its own instance (a new tab). */
  ownUpdate(): void {
    if (this.cur) this.cur.updates++;
  }

  get currentStay(): TrackedStay | null {
    return this.cur;
  }

  private simS(o: Obs): number {
    return Math.round((o.simNow - (this.first?.simNow ?? o.simNow)) / 1000);
  }

  feed(o: Obs): void {
    this.first ??= o;
    this.last = o;
    this.polls++;
    const out = o.out;
    for (const r of o.profile.recentStays) if (!this.records.has(r.at)) this.records.set(r.at, r);
    if (out) {
      if (!out.visible) this.invisiblePolls++;
      this.clips.set(out.clip, (this.clips.get(out.clip) ?? 0) + 1);
      this.states.add(out.state);
      if (out.jumpKind) this.jumpKinds.add(out.jumpKind);
      if (out.support.kind === 'held' && this.heldAtS[this.heldAtS.length - 1] !== this.simS(o)) this.heldAtS.push(this.simS(o));
    }
    if (this.hwnd) {
      const rect = rectOf(this.hwnd);
      const key = JSON.stringify(rect);
      if (rect && this.expected !== null && key !== this.expected) {
        this.unexpectedMoveAtS.push(this.simS(o));
        this.expected = key;
      }
    }
    const id = attachedId(out);
    const elevated = id !== null && (id.startsWith('windowTop:') || id.startsWith('tabStrip:'));
    const originX = this.hwnd ? (rectOf(this.hwnd)?.x ?? 0) : 0;
    if (elevated && out && this.cur && this.cur.id === id) {
      const rel = out.x - originX;
      const d = Math.abs(rel - this.cur.lastRelX);
      if (d >= 0.5) this.cur.pathPx += d;
      this.cur.lastRelX = rel;
      this.cur.toSim = o.simNow;
      return;
    }
    if (this.cur) {
      const { lastRelX: _drop, ...done } = this.cur;
      this.stays.push({ ...done, open: false });
      this.cur = null;
    }
    if (elevated && out) this.cur = { id: id, fromSim: o.simNow, toSim: o.simNow, pathPx: 0, updates: 0, open: true, lastRelX: out.x - originX };
  }

  /** Polls until `pred` holds or a budget runs out. */
  async until(pred: (o: Obs) => boolean, simBudgetMs: number, wallBudgetMs: number, each?: (o: Obs) => void | Promise<void>): Promise<boolean> {
    const start = await observe(this.app);
    this.feed(start);
    const w0 = Date.now();
    for (;;) {
      const o = await observe(this.app);
      this.feed(o);
      if (each) await each(o);
      if (pred(o)) return true;
      if (o.simNow - start.simNow > simBudgetMs || Date.now() - w0 > wallBudgetMs) return false;
      await sleep(60);
    }
  }

  /** Finished stays the cat got to by itself. */
  ownRecords(): ExcursionRecord[] {
    return [...this.records.values()].filter((r) => r.arrivedBy !== 'carried');
  }

  /** The tracked stay a finished record belongs to (nearest end). */
  stayOf(r: ExcursionRecord): TrackedStay | null {
    let best: TrackedStay | null = null;
    for (const s of this.stays) if (best === null || Math.abs(s.toSim - r.at) < Math.abs(best.toSim - r.at)) best = s;
    return best;
  }

  /** What the report needs to tell a clean run from one with a person at the desk. */
  confounders(): Record<string, unknown> {
    const a = this.first?.profile;
    const b = this.last?.profile;
    return {
      userPresence: presence,
      heldAtS: this.heldAtS,
      windowMovedByOthersAtS: this.unexpectedMoveAtS,
      invisiblePolls: this.invisiblePolls,
      typingSimS: a && b ? Math.round((b.context.typing - a.context.typing) / 1000) : null,
      foregroundMaximizedSimS: a && b ? Math.round((b.context.foregroundMaximized - a.context.foregroundMaximized) / 1000) : null,
      cursorInReachSimS: a && b ? Math.round((b.context.cursorInReach - a.context.cursorInReach) / 1000) : null,
    };
  }

  report(): Record<string, unknown> {
    const a = this.first;
    const b = this.last;
    return {
      simS: a && b ? Math.round((b.simNow - a.simNow) / 1000) : 0,
      wallS: Math.round((Date.now() - this.w0) / 1000),
      polls: this.polls,
      stays: summarizeStays(this.ownRecords()),
      arrivals: b?.profile.excursions.arrivals ?? 0,
      falls: b?.profile.falls.byCause ?? {},
      stuckResets: b?.profile.stuckResets ?? 0,
      confounders: this.confounders(),
    };
  }
}

function assertNoPhysicsErrors(p: BehaviorProfileSnapshot): void {
  expect((p.falls.byCause as Record<string, number>).physics ?? 0, 'physics falls').toBe(0);
  expect((p.falls.byCause as Record<string, number>).covered ?? 0, 'covered free falls').toBe(0);
  expect(p.stuckResets, 'stuck resets').toBe(0);
}

function assertStayLogLines(userData: string): void {
  const lines = readLogLines(userData).filter((l) => l.m === 'stay ended');
  for (const l of lines) expect((l.d as { reason?: unknown } | undefined)?.reason, 'every stay ended line has a reason').toBeTruthy();
}

function assertNoErrorLines(userData: string): void {
  expect(readLogLines(userData).filter((l) => l.l === 'error').map((l) => `${l.s}: ${l.m}`)).toEqual([]);
}

// ------------------------------------------------------------------ (1) window: trip, walk, stay, voluntary leave; close

test.describe('v1.2 lively: an own typical window (REAL)', () => {
  test.skip(!LIVELY, 'opt-in: DESKTOP_CAT_E2E_LIVELY=1 (puts own windows over the desk)');

  test('window: the cat goes up by itself, walks, stays, leaves by itself; separately, closing the window under it lands it safely', async ({ userData }, info) => {
    test.setTimeout(20 * 60_000);
    enablePerMonitorDpiAwareness();
    const win = openOwnWindow({ layout: 'typical' });
    let app: ElectronApplication | null = null;
    let stop: (() => void) | null = null;
    try {
      const r = await ownReport(info, win, 'the own window');
      app = await startApp(userData, [r.pid]);
      stop = keepTopmost([r.hwnd], await overlayHwnds(app));
      record(info, 'pids', { app: app.process().pid, window: r.pid });
      await requireInFront(info, r.hwnd, 'the own window', win);
      const { scale, bw } = await scaleOf(app);
      const f = frameOf(r.hwnd)!;
      const topId = `windowTop:${r.hwnd}`;
      await expect.poll(async () => (await hook(app!, 'getSurfaces')).some((s) => s.id === topId), { timeout: 15_000 }).toBe(true);
      await expect.poll(async () => (await observe(app!)).out?.support.kind, { timeout: 20_000 }).toBe('floor');
      const floorY = (await observe(app)).out!.y;
      record(info, 'setup', { frame: f, scale, bw, floorY, topAboveFloorPx: floorY - f.y, listed: (await hook(app, 'getSurfaceDiagnostics'))?.provider.listed });
      expect(floorY - f.y, 'a window top out of a jump\'s reach').toBeGreaterThan(420 * scale);

      await hook(app, 'setTimeScale', 12);
      const tr = new Tracker(app, r.hwnd);
      const voluntary = (): ExcursionRecord | undefined =>
        tr.ownRecords().find((x) => x.endReason === 'leave' && x.leaveKind !== null && (tr.stayOf(x)?.pathPx ?? 0) >= 2 * bw);
      const done = await tr.until(() => voluntary() !== undefined && tr.ownRecords().length >= 3, 120 * 60_000, 11 * 60_000);
      const during = await hook(app, 'getSurfaceDiagnostics');
      record(info, 'trip', { ...tr.report(), climbs: during?.nav.climbs, stays: tr.stays.map((s) => ({ id: s.id.split(':')[0], simS: round1((s.toSim - s.fromSim) / 1000), walkedPx: Math.round(s.pathPx) })), records: tr.ownRecords().map((x) => ({ kind: x.surfaceKind, dwellS: round1(x.dwellMs / 1000), plannedS: round1(x.plannedMs / 1000), reason: x.endReason, leave: x.leaveKind, by: x.arrivedBy })), clips: Object.fromEntries(tr.clips), jumpKinds: [...tr.jumpKinds] });
      if (!done && (tr.heldAtS.length > 0 || tr.unexpectedMoveAtS.length > 0)) skipBecause(info, `environment: the desk was in use (${JSON.stringify(tr.confounders())}); the run is not evidence either way`);
      expect(done, 'three stays and a voluntary leave after a walk of 2 bw along the top, within the budget').toBe(true);
      const v = voluntary()!;
      expect(['climb', 'leap', 'jump', 'hop', 'wallJump'], 'arrived by a real leap or climb').toContain(v.arrivedBy);
      expect(v.dwellMs, 'a stay of at least the short branch\'s 20 s').toBeGreaterThanOrEqual(20_000);
      expect((during?.nav.climbs.leaps ?? 0) + (during?.nav.climbs.mounts ?? 0), 'leaps or mounts onto a side').toBeGreaterThanOrEqual(1);
      expect(tr.last!.profile.falls.byCause, 'no fall caused by the voluntary leave').toEqual(expect.not.objectContaining({ gone: expect.anything() }));
      assertNoPhysicsErrors(tr.last!.profile);

      // Separately: back up there, then the window closes under the cat.
      const up = await tr.until((o) => attachedId(o.out) === topId && o.out?.state !== 'jumping', 60 * 60_000, 6 * 60_000);
      if (!up) {
        annotate(info, 'UNVERIFIED', 'the cat did not go back up within 60 sim-min: the close-the-window detachment was not run');
      } else {
        await hook(app, 'setTimeScale', 1);
        await sleep(500);
        const before = (await observe(app)).profile;
        const upAtClose = attachedId((await observe(app)).out) === topId;
        const t0 = Date.now();
        await win.close();
        let landedWallMs: number | null = null;
        await expect
          .poll(
            async () => {
              const out = (await observe(app!)).out;
              const ok = out !== null && out.support.kind === 'floor' && Math.abs(out.y - floorY) <= 1;
              if (ok && landedWallMs === null) landedWallMs = Date.now() - t0;
              return ok;
            },
            { timeout: 6_000, intervals: [50] },
          )
          .toBe(true);
        await sleep(1000);
        const after = (await observe(app)).profile;
        const last = after.recentStays[after.recentStays.length - 1] ?? null;
        record(info, 'afterClose', { upAtClose, landedWallMs, lastStay: last, fallsBefore: before.falls.byCause, fallsAfter: after.falls.byCause });
        if (upAtClose) {
          expect(last?.endReason, 'a stay cut by the closed window').toBe('gone');
        }
        expect(profileDelta(before, after, 'physics'), 'physics falls on close').toBe(0);
        expect(profileDelta(before, after, 'covered'), 'covered falls on close').toBe(0);
        await expect.poll(async () => (await hook(app!, 'getSurfaces')).some((s) => s.ownerId === r.hwnd), { timeout: 5_000 }).toBe(false);
      }
      expect(await hook(app, 'getHostDebug')).toMatchObject({ tickErrors: 0 });
      assertStayLogLines(userData);
      annotate(info, 'REAL', 'real app, own window, autonomous selection at x12; close at x1');
    } finally {
      stop?.();
      await win.close();
      const pid = app?.process().pid;
      const code = app ? await quitApp(app).catch(() => null) : null;
      record(info, 'closed', { appExit: code, appAlive: alive(pid), windowAlive: alive(win.proc.pid) });
    }
    assertNoErrorLines(userData);
  });
});

// ------------------------------------------------------------------ (2) browser dwell (ADR 0003 §15.4, B3, B4, B9)

const BROWSERS: BrowserKind[] = ['edge', 'chrome'];

for (const kind of BROWSERS) {
  test.describe(`v1.2 lively: browser dwell on an own ${kind} (REAL)`, () => {
    test.skip(!BROWSER, 'opt-in: DESKTOP_CAT_REAL_BROWSER=1 (starts an own browser with a temp profile)');
    test.skip(BROWSER_KIND !== null && BROWSER_KIND !== kind, `DESKTOP_CAT_REAL_BROWSER_KIND is ${BROWSER_KIND ?? ''}`);

    test(`browser ${kind}: strip found on the floor, stays through geometry updates, walks, leaves by itself`, async ({ userData }, info) => {
      test.setTimeout(35 * 60_000);
      enablePerMonitorDpiAwareness();
      const exe = findBrowser(kind);
      if (exe === null) {
        skipBecause(info, `environment: ${kind} is not installed in a standard location`);
        return;
      }
      let inst: BrowserInstance | null = launchBrowser(kind, exe, { x: 230, y: 144, width: 1075, height: 672, urls: ['about:blank', 'about:blank', 'about:blank'] });
      let app: ElectronApplication | null = null;
      let stop: (() => void) | null = null;
      let churn: NodeJS.Timeout | null = null;
      try {
        const w = await waitForBrowserWindow(inst, 30_000);
        const pids = [...(await instancePids(inst))];
        record(info, 'pids', { launcher: inst.launcherPid, browser: pids });
        if (win32Probe().isZoomed(w.hwnd)) skipBecause(info, `environment: ${kind} opened maximized`);
        app = await startApp(userData, pids);
        record(info, 'pids', { app: app.process().pid });
        stop = keepTopmost([w.hwnd], await overlayHwnds(app));
        await requireInFront(info, w.hwnd, `the own ${kind} window`);
        const { bw } = await scaleOf(app);
        const f = frameOf(w.hwnd)!;
        const stripId = `tabStrip:${w.hwnd}`;

        // A real strip, discovered while the cat is on the floor.
        await expect.poll(async () => (await observe(app!)).out?.support.kind, { timeout: 20_000 }).toBe('floor');
        const t0 = Date.now();
        let listedOnFloor: boolean | null = null;
        await expect
          .poll(
            async () => {
              const s = (await hook(app!, 'getSurfaces')).find((x) => x.id === stripId);
              if (s && listedOnFloor === null) listedOnFloor = (await observe(app!)).out?.support.kind === 'floor';
              return s !== undefined;
            },
            { timeout: 30_000, intervals: [100] },
          )
          .toBe(true);
        const strip = (await hook(app, 'getSurfaces')).find((x) => x.id === stripId) as LedgeSurface;
        const diag = await hook(app, 'getSurfaceDiagnostics');
        record(info, 'strip', { listedAfterWallMs: Date.now() - t0, listedOnFloor, y: strip.y, x0: strip.x0, x1: strip.x1, frame: f, tabStrips: diag?.provider.tabStrips });
        expect(listedOnFloor, 'the strip was listed while the cat was on the floor').toBe(true);
        expect(strip.x0).toBeGreaterThan(f.x);
        expect(strip.x1).toBeLessThan(f.x + f.width);

        // Ordinary geometry updates through our own instance, in real time: a 3 px move or 4 px resize
        // every 4 s, a 40 px move every 32 s, a new tab (a second launch with the same profile) every 40 s.
        const tr = new Tracker(app, w.hwnd);
        const own = inst;
        const base = rectOf(w.hwnd)!;
        let k = 0;
        let moves = 0;
        let tabs = 0;
        churn = setInterval(() => {
          k++;
          const big = k % 8 === 0;
          const r = big ? { ...base, y: base.y + (k % 16 === 0 ? 0 : 40) } : k % 2 ? { ...base, x: base.x + 3 } : { ...base, width: base.width + 4 };
          if (moveOwnWindow(w.hwnd, r)) moves++;
          tr.ownMove();
          if (k % 10 === 0) {
            tabs++;
            void openTabs(own, ['about:blank']).then(() => tr.ownUpdate());
          }
        }, 4000);

        await hook(app, 'setTimeScale', 8);
        const enough = (): boolean => tr.ownRecords().length >= 5 && tr.ownRecords().some((x) => x.surfaceKind === 'tabStrip' && x.endReason === 'leave');
        const done = await tr.until(enough, 100 * 60_000, 13 * 60_000);
        const during = await hook(app, 'getSurfaceDiagnostics');
        const stays = tr.ownRecords();
        const summary = summarizeStays(stays);
        const walked = tr.stays.filter((s) => s.id === stripId).map((s) => Math.round(s.pathPx));
        record(info, 'stays x8', {
          ...tr.report(),
          summary,
          list: stays.map((x) => ({ kind: x.surfaceKind, dwellS: round1(x.dwellMs / 1000), plannedS: round1(x.plannedMs / 1000), reason: x.endReason, leave: x.leaveKind, by: x.arrivedBy, walkedPx: Math.round(tr.stayOf(x)?.pathPx ?? 0), updates: tr.stayOf(x)?.updates ?? 0 })),
          stripWalkedPx: walked,
          moves,
          tabs,
          tabStrips: during?.provider.tabStrips,
          climbs: during?.nav.climbs,
        });
        if (!done && (tr.heldAtS.length > 0 || tr.unexpectedMoveAtS.length > 0)) skipBecause(info, `environment: the desk was in use (${JSON.stringify(tr.confounders())}); the run is not evidence either way`);
        expect(done, `at least 5 stays with a voluntary leave off the strip; got ${JSON.stringify(summary)}`).toBe(true);
        expect(summary.medianS, 'median stay, sim-s').toBeGreaterThanOrEqual(90);
        expect(summary.byReason.gone ?? 0, 'stays lost to a geometry update').toBe(0);
        expect(summary.byReason.covered ?? 0, 'stays lost to a cover').toBe(0);
        // Voluntary departures happened (`done` needs them). Variety is band B4 on a two-window layout: one
        // tall window offers only climbDown and climbLeap, so 3 departures can all be the likelier one.
        expect(Object.keys(summary.byLeave).length, 'departure kinds').toBeGreaterThanOrEqual(1);
        for (const k of Object.keys(summary.byLeave)) expect(['climbDown', 'climbLeap', 'jumpDown', 'hop', 'walkOff'], 'a known way off').toContain(k);
        expect(Math.max(0, ...walked), 'walked along the strip (px)').toBeGreaterThanOrEqual(bw);
        expect(tr.stays.filter((s) => s.id === stripId).reduce((n, s) => n + s.updates, 0), 'geometry updates while the cat stood on the strip').toBeGreaterThan(0);
        assertNoPhysicsErrors(tr.last!.profile);
        assertStayLogLines(userData);

        // One more stay in real time: the numbers above are sim-seconds at x8; this one is wall-clock.
        const back = await tr.until((o) => attachedId(o.out) === stripId, 40 * 60_000, 5 * 60_000);
        if (!back) annotate(info, 'UNVERIFIED', 'no further arrival on the strip: the x1 stay was not measured');
        else {
          await hook(app, 'setTimeScale', 1);
          const startRecords = tr.records.size;
          const wallStart = Date.now();
          const ended = await tr.until(() => attachedId(tr.last?.out ?? null) !== stripId, 7 * 60_000, 7 * 60_000);
          const wallS = round1((Date.now() - wallStart) / 1000);
          await sleep(300);
          tr.feed(await observe(app));
          const rec = [...tr.records.values()].slice(startRecords)[0] ?? null;
          record(info, 'stay x1', { ended, wallS, record: rec });
          if (ended && rec) expect(['gone', 'covered'], 'the real-time stay ended by itself').not.toContain(rec.endReason);
        }
        record(info, 'confounders', tr.confounders());
        if (churn) clearInterval(churn);
        churn = null;

        // Our browser closes while the cat may be up: it lands on the floor.
        const upAtClose = attachedId((await observe(app)).out)?.includes(w.hwnd) ?? false;
        inst = null;
        const closed = await closeBrowser(own);
        record(info, 'closed', { browser: closed, upAtClose });
        expect(closed.leftOver).toBe(0);
        await expect.poll(async () => (await observe(app!)).out?.support.kind, { timeout: 15_000, intervals: [50] }).toBe('floor');
        expect(await hook(app, 'getHostDebug')).toMatchObject({ tickErrors: 0 });
        annotate(info, 'REAL', `own ${kind} ${exe}, x8 then x1, new tabs by second launch, moves and resizes by SetWindowPos`);
      } finally {
        if (churn) clearInterval(churn);
        stop?.();
        if (inst) record(info, 'closed', { browser: await closeBrowser(inst) });
        const pid = app?.process().pid;
        const code = app ? await quitApp(app).catch(() => null) : null;
        record(info, 'closed', { appExit: code, appAlive: alive(pid) });
      }
    });
  });
}

// ------------------------------------------------------------------ (3) TabView strips (ADR 0003 §7)

async function processPrivateMB(pid: number): Promise<number | null> {
  return new Promise((resolve) => {
    execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', `(Get-Process -Id ${pid}).PrivateMemorySize64`], { windowsHide: true, timeout: 20_000 }, (err, out) => {
      const n = Number(String(out).trim());
      resolve(err || !Number.isFinite(n) ? null : n / 1048576);
    });
  });
}

test.describe('v1.2 lively: TabView strips on own windows (REAL)', () => {
  test('terminal: a tabview strip, owner memory +<= 2 MB, the cat walks on it, <= 2 helper reads/s under a printing tab', async ({ userData }, info) => {
    test.skip(!TERMINAL, 'opt-in: DESKTOP_CAT_E2E_TERMINAL=1 (opens an own named Terminal window)');
    test.setTimeout(15 * 60_000);
    enablePerMonitorDpiAwareness();
    // Self-ending tabs; only one is left when the window closes (more would make it ask first).
    const term = await openTerminalWindow(['ping', '-n', '900', '127.0.0.1']);
    if (term === null) {
      skipBecause(info, 'environment: no wt.exe, or the Terminal process already hosts the user\'s windows (restricting surfaces to it would include them)');
      return;
    }
    const t = term;
    let app: ElectronApplication | null = null;
    let stop: (() => void) | null = null;
    try {
      moveOwnWindow(t.hwnd, { x: 300, y: 200, width: 1100, height: 700 });
      await t.newTab(['cmd', '/c', 'timeout', '/t', '25', '/nobreak']);
      const mem0 = await processPrivateMB(t.pid);
      app = await startApp(userData, [t.pid]);
      record(info, 'pids', { app: app.process().pid, terminal: t.pid });
      stop = keepTopmost([t.hwnd], await overlayHwnds(app));
      await requireInFront(info, t.hwnd, 'the own Terminal window');
      const { bw } = await scaleOf(app);
      await expect.poll(async () => (await hook(app!, 'getSurfaceDiagnostics'))?.provider.tabStrips.byKind?.tabview ?? 0, { timeout: 60_000 }).toBeGreaterThanOrEqual(1);
      const stripId = `tabStrip:${t.hwnd}`;
      const reads0 = (await hook(app, 'getSurfaceDiagnostics'))?.provider.tabStrips.reads ?? 0;
      const w0 = Date.now();
      await hook(app, 'setTimeScale', 8);
      const tr = new Tracker(app, t.hwnd);
      const walkedEnough = (): boolean => tr.currentStay?.id === stripId ? tr.currentStay.pathPx >= bw : tr.stays.some((s) => s.id === stripId && s.pathPx >= bw);
      const on = await tr.until(walkedEnough, 60 * 60_000, 7.5 * 60_000);
      const d = await hook(app, 'getSurfaceDiagnostics');
      const perSec = ((d?.provider.tabStrips.reads ?? 0) - reads0) / Math.max(1, (Date.now() - w0) / 1000);
      const walked = [...tr.stays, ...(tr.currentStay ? [tr.currentStay] : [])].filter((s) => s.id === stripId).map((s) => ({ simS: round1((s.toSim - s.fromSim) / 1000), walkedPx: Math.round(s.pathPx) }));
      record(info, 'terminal', { ...tr.report(), on, walked, readsPerSec: round1(perSec), tabStrips: d?.provider.tabStrips });
      expect(perSec, 'helper reads per second with a tab printing').toBeLessThanOrEqual(2);
      annotate(info, 'UNVERIFIED', 'UIA event rate is approximated by helper reads/s: the coalesced event count is not exposed');
      if (!on && (tr.heldAtS.length > 0 || tr.unexpectedMoveAtS.length > 0)) skipBecause(info, `environment: the desk was in use (${JSON.stringify(tr.confounders())})`);
      expect(on, 'the cat walked at least 1 bw along the Terminal strip').toBe(true);
      const mem1 = await processPrivateMB(t.pid);
      record(info, 'terminalMemoryMB', { before: mem0, after: mem1 });
      if (mem0 !== null && mem1 !== null) expect(mem1 - mem0, 'Terminal private MB growth').toBeLessThanOrEqual(2);
      else annotate(info, 'UNVERIFIED', 'Terminal memory not readable');
      assertNoPhysicsErrors(tr.last!.profile);
      annotate(info, 'REAL', 'own named Terminal window, x8');
    } finally {
      stop?.();
      const pid = app?.process().pid;
      const code = app ? await quitApp(app).catch(() => null) : null;
      t.close();
      record(info, 'closed', { appExit: code, appAlive: alive(pid) });
    }
  });

  test('Explorer: a tabview strip on an own folder window (own process), closed with SC_CLOSE', async ({ userData }, testInfo) => {
    test.skip(!EXPLORER, 'opt-in: DESKTOP_CAT_E2E_EXPLORER=1 (opens an own Explorer window in its own process)');
    test.setTimeout(10 * 60_000);
    enablePerMonitorDpiAwareness();
    const ex = await openExplorerWindow();
    test.skip(ex === null, 'no own Explorer window, or it opened in the shell process (UNVERIFIED)');
    const e = ex!;
    let app: ElectronApplication | null = null;
    let stop: (() => void) | null = null;
    try {
      moveOwnWindow(e.hwnd, { x: 300, y: 200, width: 1100, height: 700 });
      const mem0 = await processPrivateMB(e.pid);
      app = await startApp(userData, [e.pid]);
      await hook(app, 'setTimeScale', 8);
      stop = keepTopmost([e.hwnd], await overlayHwnds(app));
      await expect.poll(async () => (await hook(app!, 'getSurfaceDiagnostics'))?.provider.tabStrips.byKind?.tabview ?? 0, { timeout: 60_000 }).toBeGreaterThanOrEqual(1);
      const mem1 = await processPrivateMB(e.pid);
      if (mem0 !== null && mem1 !== null) expect(mem1 - mem0, 'Explorer (own process) private MB growth').toBeLessThanOrEqual(2);
      const logs = readLogLines(userData);
      expect(logs.filter((l) => /TaskbarCreated|taskbar recreated/i.test(l.m)), 'no TaskbarCreated while reading Explorer').toEqual([]);
      annotate(testInfo, 'REAL', 'Explorer tab strip read on an own window in its own explorer.exe');
    } finally {
      stop?.();
      if (app) await quitApp(app).catch(() => undefined);
      const r = await e.close();
      if (!r.processExited) annotate(testInfo, 'UNVERIFIED', 'own Explorer process still running after SC_CLOSE (best effort; never killed)');
    }
  });

  test.fixme('never queried: a VS Code window present never reaches the helper (counts-only request log)', () => {
    // Needs PRV's counts-only request log in the diagnostics (ADR 0003 §15.4): with surfaces restricted to own pids the user's
    // VS Code is filtered before the helper anyway, so the check must read where UIA_NEVER_QUERY applies.
  });
});

// ------------------------------------------------------------------ (4) hunting with the injected cursor (ADR 0003 §4)

/** Clips of a hunt's strike: the cursor holds still through them, so the clearance is the cat's own doing. */
const STRIKE_CLIPS = new Set(['crouch', 'pounce', 'pawAt', 'swat']);

const distToRect = (p: Point, r: Rect): number => {
  const dx = Math.max(r.x - p.x, 0, p.x - (r.x + r.width));
  const dy = Math.max(r.y - p.y, 0, p.y - (r.y + r.height));
  return Math.hypot(dx, dy);
};

test.describe('v1.2 lively: hunting the injected cursor (app REAL, input SIMULATED)', () => {
  test.skip(!LIVELY, 'opt-in: DESKTOP_CAT_E2E_LIVELY=1');

  test('hunt: stalk, crouch, pounce and bat in the sim output, with a clearance from the hotspot', async ({ userData }, info) => {
    test.setTimeout(25 * 60_000);
    enablePerMonitorDpiAwareness();
    // No surfaces at all (this test process owns no windows): the floor is the hunting ground.
    const app = await startApp(userData, [process.pid], { interaction: true });
    try {
      record(info, 'pids', { app: app.process().pid });
      const { scale, bw, bh } = await scaleOf(app);
      const display = (await hook(app, 'getOverlays'))[0]!.boundsPx;
      await hook(app, 'setTimeScale', 5);
      const tr = new Tracker(app, null);
      let cursor: Point = { x: display.x + display.width / 2, y: display.y + display.height - bh };
      let anchorX: number | null = null;
      let anchorAt = 0;
      const t0 = Date.now();
      const seen = new Set<string>();
      const strikes: Array<{ clip: string; clearanceDip: number; overlayInteractive: boolean }> = [];
      const interactiveDetail: Array<Record<string, unknown>> = [];
      let inStrike = false;
      const huntSeq: string[] = [];
      const seenAll = (): boolean => ['stalk', 'crouch', 'pounce'].every((c) => seen.has(c)) && (seen.has('pawAt') || seen.has('swat'));
      const done = await tr.until(
        (o) => seenAll() && o.profile.hunts.pounces >= 1,
        120 * 60_000,
        22 * 60_000,
        async (o) => {
          const out = o.out;
          if (!out) return;
          // In the air a pounce reads as state 'jumping' (jumpKind and clip 'pounce').
          const hunting = out.state === 'chasingCursor' || out.jumpKind === 'pounce' || out.clip === 'pounce';
          if (hunting) {
            seen.add(out.clip);
            if (huntSeq[huntSeq.length - 1] !== out.clip) huntSeq.push(out.clip);
          } else if (huntSeq.length > 0 && huntSeq[huntSeq.length - 1] !== '|') huntSeq.push('|');
          const strike = hunting && (STRIKE_CLIPS.has(out.clip) || out.jumpKind === 'pounce');
          if (hunting && (out.clip === 'pawAt' || out.clip === 'swat' || (inStrike && !strike) || out.clip === 'pounce')) {
            const ov = await hook(app, 'getOverlays');
            const clearanceDip = round1(distToRect(cursor, out.boundsPx) / scale);
            let overlayInteractive = ov.some((x) => !x.ignoreMouse);
            if (overlayInteractive) {
              // The renderer reports its hit rects a frame late, and at this time scale a frame is many px of
              // travel: look again once it has reported, and keep the detail either way.
              await sleep(150);
              const later = await observe(app);
              const laterOv = await hook(app, 'getOverlays');
              const stillInteractive = laterOv.some((x) => !x.ignoreMouse);
              const laterClearanceDip = later.out ? round1(distToRect(cursor, later.out.boundsPx) / scale) : null;
              interactiveDetail.push({ clip: out.clip, clearanceDip, cursor, boundsPx: out.boundsPx, stillInteractive, laterClip: later.out?.clip ?? null, laterClearanceDip });
              overlayInteractive = stillInteractive && laterClearanceDip !== null && laterClearanceDip > 0;
            }
            strikes.push({ clip: out.clip, clearanceDip, overlayInteractive });
          }
          inStrike = strike;
          if (strike) return; // a still cursor through the strike
          const t = (Date.now() - t0) / 1000;
          if (anchorX === null || Math.abs(out.x - anchorX) > 9 * bw || t - anchorAt > 25) {
            const side = out.x < display.x + display.width / 2 ? 1 : -1;
            anchorX = Math.min(display.x + display.width - 3 * bw, Math.max(display.x + 3 * bw, out.x + side * 5 * bw));
            anchorAt = t;
          }
          cursor = { x: Math.round(anchorX + 1.6 * bw * Math.sin(t * 1.3) + 0.6 * bw * Math.sin(t * 4.1)), y: Math.round(out.y - 0.7 * bh) };
          await hook(app, 'injectCursor', cursor);
        },
      );
      await hook(app, 'injectCursor', null);
      const p = tr.last!.profile;
      const strikeClear = strikes.filter((s) => s.clip === 'pawAt' || s.clip === 'swat').map((s) => s.clearanceDip);
      record(info, 'hunt', { ...tr.report(), interactiveDetail: interactiveDetail.slice(0, 8), done, hunts: p.hunts, clipsInHunts: [...seen], sequence: huntSeq.join(' ').slice(0, 800), jumpKinds: [...tr.jumpKinds], strikes: strikes.length, minClearanceAllDip: strikes.length ? Math.min(...strikes.map((s) => s.clearanceDip)) : null, minClearanceStrikeDip: strikeClear.length ? Math.min(...strikeClear) : null, interactiveDuringStrike: strikes.filter((s) => s.overlayInteractive).length, sample: strikes.slice(0, 12) });
      if (!done && tr.heldAtS.length > 0) skipBecause(info, `environment: the desk was in use (${JSON.stringify(tr.confounders())})`);
      expect(seen.has('stalk'), 'stalk seen').toBe(true);
      expect(seen.has('crouch'), 'crouch seen').toBe(true);
      expect(seen.has('pounce') || tr.jumpKinds.has('pounce'), 'pounce seen').toBe(true);
      expect(p.hunts.pounces, 'pounces counted').toBeGreaterThanOrEqual(1);
      expect(seen.has('pawAt') || seen.has('swat'), 'bat seen').toBe(true);
      expect(strikes.filter((s) => s.overlayInteractive).length, 'samples with the overlay taking the mouse at a strike').toBe(0);
      assertNoPhysicsErrors(p);
      annotate(info, 'SIMULATED', 'cursor input through injectCursor; the sim, overlay and click-through decision are the real app');
    } finally {
      const pid = app.process().pid;
      const code = await quitApp(app).catch(() => null);
      record(info, 'closed', { appExit: code, appAlive: alive(pid) });
    }
    assertNoErrorLines(userData);
  });
});

// ------------------------------------------------------------------ (5) throws through the real drag path (ADR 0003 §5)

async function overlayPage(app: ElectronApplication): Promise<Page> {
  await expect.poll(() => app.windows().some((w) => w.url().includes('/renderer/overlay/')), { timeout: 15_000 }).toBe(true);
  return app.windows().find((w) => w.url().includes('/renderer/overlay/'))!;
}

/**
 * One throw through the renderer's real pointer path: CDP mouse events on the overlay page (never
 * the OS cursor), the injected cursor alongside them, as the host reads it while dragging. Like a
 * hand, it winds up for about 0.6 s before the flick, so the press lasts well past 400 ms. The real
 * button is not down: CDP never reaches GetAsyncKeyState, so Win32 never sees this press down and
 * main treats its button state as unknown for the press (overlayManager): no release is made up from
 * Win32's "up" (neither the 400 ms LOST_PRESS_MS nor the 1.5 s LOST_PRESS_HELD_MS bound applies), and
 * only a cursor that moves on with no pointer event for 400 ms would end it. The renderer reports
 * every move (one every 70 ms here), which keeps the press and its everywhere-capture alive, as for a
 * real slow drag.
 * The overlay is held click-through meanwhile (CDP input reaches the page anyway): with the injected
 * cursor on the cat the press makes the whole overlay take the mouse, and any real mouse move Windows
 * then sends the page carries the button up, which ends the drag as a release (seen in
 * tests/e2e/soak.spec.ts; see docs/gizeverse/13-interaction-reliability.md).
 */
async function throwOnce(app: ElectronApplication, page: Page, ov: { boundsPx: Rect }, scale: number, stepPx: Point): Promise<{ gestureMs: number; flickMs: number }> {
  const o = (await observe(app)).out!;
  const c = center(o.boundsPx);
  const b = ov.boundsPx;
  const inside = (p: Point): Point => ({ x: Math.min(b.x + b.width - 12, Math.max(b.x + 12, p.x)), y: Math.min(b.y + b.height - 12, Math.max(b.y + 12, p.y)) });
  const local = (p: Point): Point => ({ x: (p.x - b.x) / scale, y: (p.y - b.y) / scale });
  await hook(app, 'forceInteractive', false);
  try {
    await hook(app, 'injectCursor', c);
    await page.mouse.move(local(c).x, local(c).y);
    const t0 = Date.now();
    await page.mouse.down();
    // The wind-up: a small horizontal pull back, one move about every 70 ms.
    const from = inside({ x: c.x - stepPx.x * 0.4, y: c.y });
    for (let i = 1; i <= 8; i++) {
      const p = { x: c.x + ((from.x - c.x) * i) / 8, y: c.y };
      await Promise.all([hook(app, 'injectCursor', p), page.mouse.move(local(p).x, local(p).y)]);
      await sleep(70);
    }
    // The flick to where the throw used to end: the release speed comes from the last ~100 ms of samples.
    // CDP moves back to back, with no test-hook round trip in between: on a loaded machine each hook call
    // takes 100+ ms, which stretched the flick to about a second and turned throws into drops (a hand's
    // flick is not slowed by IPC). The injected cursor follows once, at the end.
    const to = { x: c.x + stepPx.x * 5, y: c.y + stepPx.y * 5 };
    const tFlick = Date.now();
    let last = from;
    for (let i = 1; i <= 5; i++) {
      last = inside({ x: from.x + ((to.x - from.x) * i) / 5, y: from.y + ((to.y - from.y) * i) / 5 });
      await page.mouse.move(local(last).x, local(last).y);
    }
    await page.mouse.up();
    const flickMs = Date.now() - tFlick;
    await hook(app, 'injectCursor', last);
    return { gestureMs: Date.now() - t0, flickMs };
  } finally {
    await hook(app, 'forceInteractive', null);
  }
}

test.describe('v1.2 lively: throws through the real drag path (app REAL, input SIMULATED)', () => {
  test.skip(!LIVELY, 'opt-in: DESKTOP_CAT_E2E_LIVELY=1');

  test('throws: several throws give varied reactions and the cat recovers', async ({ userData }, info) => {
    test.setTimeout(12 * 60_000);
    enablePerMonitorDpiAwareness();
    const app = await startApp(userData, [process.pid], { interaction: true });
    try {
      record(info, 'pids', { app: app.process().pid });
      const { scale } = await scaleOf(app);
      const page = await overlayPage(app);
      const ov = (await hook(app, 'getOverlays'))[0]!;
      const far: Point = { x: ov.boundsPx.x + ov.boundsPx.width / 2, y: ov.boundsPx.y + 40 };
      await hook(app, 'injectCursor', far);
      const tr = new Tracker(app, null);
      const results: Array<Record<string, unknown>> = [];
      const reactionTotal = (p: BehaviorProfileSnapshot): number => Object.values(p.reactions).reduce<number>((a, b) => a + (b ?? 0), 0);
      const N = 10;
      for (let i = 0; i < N; i++) {
        // Wait (quickly) until it is calm on the floor again.
        await hook(app, 'setTimeScale', 6);
        const ready = await tr.until((o) => o.out?.support.kind === 'floor' && !['hiding', 'startled', 'annoyed', 'falling', 'landing', 'held', 'jumping', 'sleeping', 'fallingAsleep', 'wakingUp'].includes(o.out.state) && o.out.visible, 3 * 60_000, 40_000);
        if (!ready) results.push({ i, notReady: tr.last?.out?.state ?? null });
        await hook(app, 'setTimeScale', 1);
        await sleep(100);
        const before = (await observe(app)).profile;
        const side = tr.last!.out!.x < ov.boundsPx.x + ov.boundsPx.width / 2 ? 1 : -1; // towards the middle of the screen
        const speed = 90 + (i % 3) * 35; // px per step: from a fair throw to a hard one
        const { gestureMs, flickMs } = await throwOnce(app, page, ov, scale, { x: side * speed, y: -speed * 0.7 });
        await hook(app, 'injectCursor', far);
        const t0 = Date.now();
        const reacted = await tr.until((o) => reactionTotal(o.profile) > reactionTotal(before) || (profileDelta(before, o.profile, 'thrown') > 0 && o.out?.support.kind === 'floor' && Date.now() - t0 > 2500), 8_000, 8_000);
        const after = tr.last!.profile;
        const kinds = Object.keys(after.reactions).filter((k) => ((after.reactions as Record<string, number>)[k] ?? 0) > ((before.reactions as Record<string, number>)[k] ?? 0));
        results.push({ i, stepPx: speed, gestureMs, flickMs, reacted, thrown: profileDelta(before, after, 'thrown'), dropped: profileDelta(before, after, 'dropped'), kinds, state: tr.last?.out?.state });
      }
      const p = tr.last!.profile;
      record(info, 'throws', { results, reactions: p.reactions, falls: p.falls, states: [...tr.states] });
      const thrown = (p.falls.byCause as Record<string, number>).thrown ?? 0;
      expect(thrown, 'throws that reached the sim through the drag path').toBeGreaterThanOrEqual(N - 2);
      const distinct = Object.keys(p.reactions);
      expect(distinct.length, `reaction kinds: ${JSON.stringify(p.reactions)}`).toBeGreaterThanOrEqual(3);
      const total = reactionTotal(p);
      for (const [k, v] of Object.entries(p.reactions)) if (total >= 8) expect(v ?? 0, `${k} does not dominate`).toBeLessThanOrEqual(Math.ceil(total * 0.6));

      // Recovery: ten sim-minutes later it is itself again (ADR 0003 B8 wants fear < 0.05).
      await hook(app, 'setTimeScale', 12);
      await tr.until(() => false, 10 * 60_000, 60_000);
      const report = await hook(app, 'getDiagnosticsReport');
      const cat = report['cat'] as { stats?: Record<string, number> } | undefined;
      const end = (await observe(app)).out!;
      record(info, 'recovery', { state: end.state, support: end.support.kind, fear: cat?.stats?.fear ?? null, moodMs: tr.last!.profile.moodMs, visible: end.visible });
      expect(end.visible, 'visible again').toBe(true);
      expect(end.state, 'not hiding ten sim-minutes on').not.toBe('hiding');
      expect(cat?.stats?.fear ?? 1, 'fear ten sim-minutes on').toBeLessThan(0.05);
      assertNoPhysicsErrors(tr.last!.profile);
      expect(await hook(app, 'getHostDebug')).toMatchObject({ tickErrors: 0 });
      annotate(info, 'SIMULATED', 'drag input through CDP mouse events on the overlay page plus injectCursor; the renderer input path, IPC, gestures, sim and reactions are the real app');
    } finally {
      const pid = app.process().pid;
      const code = await quitApp(app).catch(() => null);
      record(info, 'closed', { appExit: code, appAlive: alive(pid) });
    }
    assertNoErrorLines(userData);
  });
});

// ------------------------------------------------------------------ (6) screen edge (ADR 0003 §6.1, B11, T8)

/** How long a visit to a screen edge lasts from here (wall ms at x1), how high it goes, and its clips. */
async function clingTrace(app: ElectronApplication, maxMs: number): Promise<{ ended: boolean; ms: number; risePx: number; trace: Array<Record<string, unknown>> }> {
  const t0 = Date.now();
  const trace: Array<Record<string, unknown>> = [];
  let footY = -Infinity;
  let topY = Infinity;
  for (;;) {
    const o = (await observe(app)).out;
    const ms = Date.now() - t0;
    if (!o || supportKind(o) !== 'screenEdge') return { ended: true, ms, risePx: Math.round(footY - topY), trace };
    footY = Math.max(footY, o.y);
    topY = Math.min(topY, o.y);
    if (trace.length === 0 || trace[trace.length - 1]!['clip'] !== o.clip) trace.push({ ms, y: Math.round(o.y), clip: o.clip, state: o.state });
    if (ms > maxMs) return { ended: false, ms, risePx: Math.round(footY - topY), trace };
    await sleep(60);
  }
}

test.describe('v1.2 lively: screen edge next to an own maximized window (REAL)', () => {
  test.skip(!LIVELY, 'opt-in: DESKTOP_CAT_E2E_LIVELY=1 (puts an own maximized window over the desk)');

  test('edge: clinging over the own window stays click-through; off means no climbs', async ({ userData }, info) => {
    test.setTimeout(20 * 60_000);
    enablePerMonitorDpiAwareness();
    const front = openOwnWindow({ layout: 'maximized' });
    let app: ElectronApplication | null = null;
    let stop: (() => void) | null = null;
    try {
      const win = await ownReport(info, front, 'the own maximized window');
      record(info, 'window', { state: win.state, frame: frameOf(win.hwnd) });
      expect(win.state).toBe('maximized');
      app = await startApp(userData, [win.pid], { interaction: true });
      record(info, 'pids', { app: app.process().pid, window: win.pid });
      // The setting on (ADR 0003 §9.4: screenEdges is a v1.2 opt-out; nothing disabled = on).
      expect((await hook(app, 'patchSettings', { behavior: { disabledExtras: [] } })).ok).toBe(true);
      const overlays = await overlayHwnds(app);
      stop = keepTopmost([win.hwnd], overlays);
      await requireInFront(info, win.hwnd, 'the own maximized window', front);
      await hook(app, 'setTimeScale', 12);
      const tr = new Tracker(app, null);
      const cling = await tr.until((o) => supportKind(o.out) === 'screenEdge', 80 * 60_000, 7 * 60_000);
      const firstAtSim = (tr.last!.simNow - tr.first!.simNow) / 1000;
      const { bh } = await scaleOf(app);
      const host = await hook(app, 'getHostDebug');
      record(info, 'firstCling', { cling, firstAtSim: Math.round(firstAtSim), diag: (await hook(app, 'getSurfaceDiagnostics'))?.provider.screenEdges, confounders: tr.confounders(), timeMs: tr.last!.profile.timeMs, decisions: tr.last!.profile.decisions, clips: Object.fromEntries(tr.clips), states: [...tr.states], host: { hidden: host.hidden, locked: host.locked, paused: host.paused }, quns: win32Probe().notificationState(), visible: tr.last!.out?.visible });
      if (!cling) {
        skipBecause(info, 'no screen-edge climb within 80 sim-min next to the own maximized window');
        return;
      }
      // A first visit left alone, in real time: a covered band only gets a short, low peek (<= 2 bh, <= 8 s).
      await hook(app, 'setTimeScale', 1);
      const peek = await clingTrace(app, 30_000);
      record(info, 'peek alone', peek);
      expect(peek.ended, 'the peek ended by itself').toBe(true);
      expect(peek.ms, 'a covered-band peek, wall ms').toBeLessThanOrEqual(9000);
      expect(peek.risePx, 'a covered-band peek stays low (px)').toBeLessThanOrEqual(2.1 * bh);

      // The next one, in real time from the moment it starts. Over the clinging cat the mouse must reach the
      // window, also past the 300 ms hover dwell, and the cat climbs down from a cursor that close.
      await hook(app, 'setTimeScale', 12);
      const again = await tr.until((o) => supportKind(o.out) === 'screenEdge', 40 * 60_000, 4 * 60_000);
      if (!again) {
        skipBecause(info, 'no second screen-edge climb within 40 sim-min: the click-through check was not run');
        return;
      }
      await hook(app, 'setTimeScale', 1);
      const probe = win32Probe();
      let checks = 0;
      const wrong: Array<Record<string, unknown>> = [];
      const trace: Array<Record<string, unknown>> = [];
      // Up the wall first (a cat just mounted simply steps off again), then the cursor comes.
      const footY = tr.last!.out!.y;
      await tr.until((o) => supportKind(o.out) !== 'screenEdge' || o.out!.y < footY - 0.6 * bh, 5000, 5000);
      const t0 = Date.now();
      let held = 0;
      let lastCursor: Point | null = null;
      while (Date.now() - t0 < 30_000) {
        const o = (await observe(app)).out;
        if (!o || supportKind(o) !== 'screenEdge') break;
        if (trace.length === 0 || trace[trace.length - 1]!['clip'] !== o.clip) trace.push({ ms: Date.now() - t0, y: Math.round(o.y), clip: o.clip, state: o.state });
        const c = center(o.boundsPx);
        // The cursor comes to rest over the cat: if the dwell were to open the overlay, this is when.
        if (lastCursor === null || Math.hypot(c.x - lastCursor.x, c.y - lastCursor.y) > 6) {
          await hook(app, 'injectCursor', c);
          lastCursor = c;
          held = Date.now();
        }
        await sleep(40);
        if (!overlayInFront(overlays, win.hwnd)) continue;
        checks++;
        const overlay = (await hook(app, 'getOverlays')).find((x) => c.x >= x.boundsPx.x && c.x < x.boundsPx.x + x.boundsPx.width);
        const clickThrough = overlay ? (probe.exStyle(overlay.hwnd) & WS_EX_TRANSPARENT) === WS_EX_TRANSPARENT : false;
        const at = probe.rootWindowAt(c.x, c.y);
        // Only while it still clings: a cat that stepped off meanwhile is on the floor, where it is clickable (review RES-1).
        const still = (await observe(app)).out;
        if (!still || supportKind(still) !== 'screenEdge') break;
        if (!clickThrough || at !== win.hwnd) wrong.push({ ms: Date.now() - t0, restedMs: Date.now() - held, clickThrough, atOwnWindow: at === win.hwnd });
      }
      const clingMs = Date.now() - t0;
      await hook(app, 'injectCursor', null);
      const diag = await hook(app, 'getSurfaceDiagnostics');
      const dbg = await hook(app, 'getHostDebug');
      record(info, 'clickThrough', { checks, wrong: wrong.length, sample: wrong.slice(0, 5), clingMs, trace: trace.slice(0, 12), screenEdges: diag?.provider.screenEdges, clickGuard: dbg.clickGuard });
      expect(checks, 'WindowFromPoint checks with the overlay in front').toBeGreaterThan(0);
      expect(wrong, 'the injected cursor over the clinging cat hit the overlay').toEqual([]);
      expect(clingMs, 'the cat climbed down from the cursor, wall ms').toBeLessThan(15_000);
      annotate(info, 'UNVERIFIED', 'the clear-band hover dwell needs a clear band and the cat on it; beside a maximized window every band is covered');

      // A measured on-phase, then the same length off (B11: 2-8 /h on, 0 off).
      await hook(app, 'setTimeScale', 12);
      const before = (await observe(app)).profile;
      await tr.until(() => false, 30 * 60_000, 170_000);
      const mid = tr.last!.profile;
      const on = mid.screenEdgeVisits - before.screenEdgeVisits;
      expect((await hook(app, 'patchSettings', { behavior: { disabledExtras: ['screenEdges'] } })).ok).toBe(true);
      // One under way when the setting went off may finish.
      await tr.until((o) => supportKind(o.out) !== 'screenEdge', 2 * 60_000, 20_000);
      const off0 = (await observe(app)).profile.screenEdgeVisits;
      let clungWhileOff = 0;
      await tr.until(
        () => false,
        30 * 60_000,
        170_000,
        (o) => {
          if (supportKind(o.out) === 'screenEdge') clungWhileOff++;
        },
      );
      const off1 = tr.last!.profile;
      record(info, 'edgeVisits', { onSim30Min: on, offVisits: off1.screenEdgeVisits - off0, clungWhileOff, peeks: off1.screenEdgePeeks, total: off1.screenEdgeVisits, report: tr.report() });
      expect(off1.screenEdgeVisits - off0, 'screen-edge visits with the setting off').toBe(0);
      expect(clungWhileOff, 'samples clinging with the setting off').toBe(0);
      assertNoPhysicsErrors(off1);
      annotate(info, 'REAL', 'screen-edge cling next to an own maximized window: click-through and WindowFromPoint with the injected cursor (the cursor is SIMULATED)');
    } finally {
      stop?.();
      const pid = app?.process().pid;
      const code = app ? await quitApp(app).catch(() => null) : null;
      await front.close();
      record(info, 'closed', { appExit: code, appAlive: alive(pid), windowAlive: alive(front.proc.pid) });
    }
  });
});

// ------------------------------------------------------------------ (7) covered support (ADR 0003 §3, B13)

test.describe('v1.2 lively: covered support bails out (REAL)', () => {
  test.skip(!LIVELY, 'opt-in: DESKTOP_CAT_E2E_LIVELY=1 (puts own windows over the desk)');

  test('covered: an own window maximized over the cat on another own one gives a bail-out, no free fall, and clicks go to the cover', async ({ userData }, info) => {
    test.setTimeout(14 * 60_000);
    enablePerMonitorDpiAwareness();
    const support = openOwnWindow({ layout: 'typical' });
    const cover: OwnWindow = openOwnWindow({ layout: 'hidden' });
    let app: ElectronApplication | null = null;
    let stop: (() => void) | null = null;
    try {
      const sup = await ownReport(info, support, 'the own support window');
      const cov = await ownReport(info, cover, 'the own cover window');
      app = await startApp(userData, [sup.pid, cov.pid], { interaction: true });
      record(info, 'pids', { app: app.process().pid, support: sup.pid, cover: cov.pid });
      const overlays = await overlayHwnds(app);
      stop = keepTopmost([sup.hwnd], overlays);
      await requireInFront(info, sup.hwnd, 'the own support window', support);
      await hook(app, 'setTimeScale', 12);
      const topId = `windowTop:${sup.hwnd}`;
      const tr = new Tracker(app, sup.hwnd);
      const up = await tr.until((o) => attachedId(o.out) === topId && o.out?.state !== 'jumping', 60 * 60_000, 6 * 60_000);
      if (!up) {
        skipBecause(info, 'the cat did not get onto the own window within 60 sim-min');
        return;
      }
      // Real time from here: the bail-out takes <= 0.6 s of sim time.
      await hook(app, 'setTimeScale', 1);
      await sleep(1500);
      const beforeO = await observe(app);
      const before = beforeO.profile;
      const onTop = attachedId(beforeO.out) === topId;
      record(info, 'beforeCover', { onTop, state: beforeO.out?.state, stays: before.excursions.arrivals });
      if (!onTop) {
        skipBecause(info, 'the cat left the window top in the 1.5 s before the cover');
        return;
      }
      cover.send({ op: 'maximize' });
      const coveredAt = Date.now();
      stop();
      stop = keepTopmost([sup.hwnd, cov.hwnd], overlays, 100);
      const probe = win32Probe();
      // From the moment the cover is up until the landing, the cursor over the cat must reach the
      // covering window (the click guard). Before the cover is up, and on the floor after the landing,
      // the overlay takes the mouse over the cat as usual: the latter is this check's positive control.
      // Asked of the z-order, not of WindowFromPoint: an interactive overlay answers for the whole display.
      const coverIsUp = (): boolean => probe.isZoomed(cov.hwnd) && probe.zIndex(cov.hwnd) < probe.zIndex(sup.hwnd);
      const phases = { beforeCover: { checks: 0, overlay: 0 }, guarded: { checks: 0, overlay: 0 }, landed: { checks: 0, overlay: 0 } };
      const wrong: Array<Record<string, unknown>> = [];
      const trace: Array<Record<string, unknown>> = [];
      let coverUpAtMs: number | null = null;
      let guardAtMs: number | null = null;
      while (Date.now() - coveredAt < 3200) {
        const o = (await observe(app)).out;
        if (o && o.visible) {
          const c = center(o.boundsPx);
          await hook(app, 'injectCursor', c);
          await sleep(25);
          if (trace.length === 0 || trace[trace.length - 1]!['support'] !== supportKind(o)) trace.push({ ms: Date.now() - coveredAt, support: supportKind(o), state: o.state, jumpKind: o.jumpKind ?? null });
          if (overlayInFront(overlays, cov.hwnd) && overlayInFront(overlays, sup.hwnd)) {
            const at = probe.rootWindowAt(c.x, c.y);
            const ms = Date.now() - coveredAt;
            const up = coverIsUp();
            if (up && coverUpAtMs === null) coverUpAtMs = ms;
            const onOverlay = at !== null && overlays.includes(at);
            const phase = !up ? phases.beforeCover : supportKind(o) === 'floor' ? phases.landed : phases.guarded;
            phase.checks++;
            if (onOverlay) phase.overlay++;
            if (phase === phases.guarded) {
              // The guard needs the sim to report the cover first: a short lag, then never the overlay.
              if (at === cov.hwnd) guardAtMs ??= ms;
              else if (guardAtMs !== null) wrong.push({ ms, support: supportKind(o), overlay: onOverlay });
            }
          }
        }
        await sleep(15);
      }
      expect(probe.isZoomed(cov.hwnd), 'the cover is maximized').toBe(true);
      // Positive control: the cat on the floor still takes the mouse (somewhere on its body; the middle of the
      // approximate bounds can be a gap between the hit rects), so the guard's "never the overlay" says something.
      let controlHits = 0;
      let controlChecks = 0;
      for (const [fx, fy] of [[0.5, 0.5], [0.3, 0.6], [0.7, 0.6], [0.5, 0.75], [0.3, 0.8], [0.7, 0.8], [0.5, 0.35], [0.5, 0.9]] as const) {
        const b = (await observe(app)).out?.boundsPx;
        if (!b) continue;
        const p = { x: Math.round(b.x + fx * b.width), y: Math.round(b.y + fy * b.height) };
        await hook(app, 'injectCursor', p);
        await sleep(150);
        controlChecks++;
        const at = probe.rootWindowAt(p.x, p.y);
        if (at !== null && overlays.includes(at)) controlHits++;
      }
      const guardDebug = { ...(await hook(app, 'getHostDebug')).clickGuard, catBounds: (await observe(app)).out?.boundsPx, display: (await hook(app, 'getOverlays'))[0]?.boundsPx, screenEdges: (await hook(app, 'getSurfaceDiagnostics'))?.provider.screenEdges };
      await hook(app, 'injectCursor', null);
      await sleep(1000);
      const after = (await observe(app)).profile;
      const out = (await observe(app)).out;
      const last = after.recentStays[after.recentStays.length - 1] ?? null;
      record(info, 'bailOut', { phases, coverUpAtMs, guardAtMs, wrong: wrong.length, sample: wrong.slice(0, 5), trace, last, supportAfter: supportKind(out), fallsBefore: before.falls.byCause, fallsAfter: after.falls.byCause, impact: after.falls.byImpact, control: { controlHits, controlChecks, guardDebug } });
      expect(phases.guarded.checks, 'WindowFromPoint checks between the cover and the landing, with the overlay in front').toBeGreaterThan(0);
      expect(guardAtMs, 'the mouse over the cat reached the cover during the bail-out').not.toBeNull();
      expect(guardAtMs! - coverUpAtMs!, 'from the cover coming up to the click guard (ms)').toBeLessThanOrEqual(500);
      expect(wrong, 'injected cursor over the bailing-out cat did not reach the covering window').toEqual([]);
      // Wherever it landed, even next to a screen side (review RES-1): a cat on the floor is clickable.
      expect(controlHits, 'positive control: on the floor afterwards the overlay takes the mouse over the cat').toBeGreaterThan(0);
      expect(profileDelta(before, after, 'covered'), 'covered free falls').toBe(0);
      expect(profileDelta(before, after, 'physics'), 'physics falls').toBe(0);
      expect(last?.endReason).toBe('covered');
      expect(last?.bailOut ?? null, 'covered end has a bailOut').not.toBeNull();
      expect(supportKind(out), 'on the floor afterwards').toBe('floor');
      assertStayLogLines(userData);
      annotate(info, 'REAL', 'bail-out from an own window covered by an own maximized window; WindowFromPoint with the injected cursor (the cursor is SIMULATED)');
    } finally {
      stop?.();
      const pid = app?.process().pid;
      const code = app ? await quitApp(app).catch(() => null) : null;
      await cover.close();
      await support.close();
      record(info, 'closed', { appExit: code, appAlive: alive(pid), supportAlive: alive(support.proc.pid), coverAlive: alive(cover.proc.pid) });
    }
  });
});

// ------------------------------------------------------------------ (8) sound (ADR 0003 §10)

test.describe('v1.2 lively: sound releases the audio device (REAL renderer, OS check when allowed)', () => {
  test.skip(!LIVELY, 'opt-in: DESKTOP_CAT_E2E_LIVELY=1 (makes the cat audible, quietly)');

  test('sound: the AudioContext is closed after the idle gap and when sound goes off; powercfg /requests where readable', async ({ userData }, info) => {
    test.setTimeout(3 * 60_000);
    const app = await startApp(userData, [process.pid], { interaction: true });
    try {
      const page = await overlayPage(app);
      // Counts only: wraps the page's AudioContext before the player's first cue creates one.
      await page.evaluate(() => {
        const g = globalThis as unknown as { AudioContext: new () => { close(): Promise<void> }; __dcatAudio?: { created: number; closed: number } };
        const log = { created: 0, closed: 0 };
        g.__dcatAudio = log;
        const Base = g.AudioContext;
        g.AudioContext = class extends Base {
          constructor() {
            super();
            log.created++;
          }
          override close(): Promise<void> {
            log.closed++;
            return super.close();
          }
        };
      });
      const audio = (): Promise<{ created: number; closed: number }> => page.evaluate(() => (globalThis as unknown as { __dcatAudio: { created: number; closed: number } }).__dcatAudio);
      const ok = await hook(app, 'patchSettings', { sound: { enabled: true, volume: 0.05 } });
      expect(ok.ok).toBe(true);
      await hook(app, 'setTimeScale', 4);
      // Cues come from what the cat does: a call, and hard landings from throws through the real drag path.
      const { scale } = await scaleOf(app);
      const ov = (await hook(app, 'getOverlays'))[0]!;
      const t0 = Date.now();
      let cues = 0;
      let throws = 0;
      while ((await audio()).created === 0 && Date.now() - t0 < 90_000) {
        await hook(app, 'injectEvent', { type: 'command.callCat', at: { x: 900, y: 600 } });
        const o = (await observe(app)).out;
        if (o?.sound) cues++;
        if (o?.support.kind === 'floor' && !['held', 'falling', 'landing', 'jumping'].includes(o.state)) {
          await throwOnce(app, page, ov, scale, { x: (throws % 2 === 0 ? 1 : -1) * 160, y: -112 });
          throws++;
        }
        await sleep(1000);
      }
      const opened = await audio();
      record(info, 'audioOpened', { ...opened, wallMs: Date.now() - t0, cuesSeen: cues });
      if (opened.created === 0) {
        skipBecause(info, 'no cue within 90 s: the sound path was not exercised');
        return;
      }
      // Off: released at once (the settings change reaches the player), and no more cues.
      expect((await hook(app, 'patchSettings', { sound: { enabled: false } })).ok).toBe(true);
      await expect.poll(async () => { const a = await audio(); return a.closed >= a.created; }, { timeout: 15_000 }).toBe(true);
      const closed = await audio();
      record(info, 'audioReleased', closed);
      const out = await new Promise<string | null>((resolve) => execFile('powercfg.exe', ['/requests'], { windowsHide: true, timeout: 20_000 }, (err, o) => resolve(err ? null : String(o))));
      if (out === null) annotate(info, 'UNVERIFIED', 'powercfg /requests needs elevation here: the OS-level audio request was not read; the REAL evidence is the renderer closing its AudioContext');
      else {
        const section = /AUDIO:\s*([\s\S]*?)(?:\r?\n[A-Z]+:|$)/.exec(out)?.[1] ?? '';
        expect(section.toLowerCase(), 'audio power requests').not.toMatch(/electron|desktop cat/);
        annotate(info, 'REAL', 'powercfg /requests lists no audio request from this app');
      }
    } finally {
      await quitApp(app).catch(() => undefined);
    }
  });
});

// ------------------------------------------------------------------ Explorer soak (ADR 0003 §7.2 gate, Q8)

test.describe('v1.2 lively: Explorer soak (REAL, >= 2 h)', () => {
  test.skip(!SOAK, 'opt-in: DESKTOP_CAT_E2E_EXPLORER_SOAK=1 (DESKTOP_CAT_E2E_SOAK_MIN, default 120)');

  test('the cat on own Explorer strips: no TaskbarCreated, <= 1 helper timeout per hour', async ({ userData }, testInfo) => {
    test.setTimeout((SOAK_MIN + 15) * 60_000);
    enablePerMonitorDpiAwareness();
    const ex = await openExplorerWindow();
    test.skip(ex === null, 'no own Explorer window (UNVERIFIED)');
    const e = ex!;
    let app: ElectronApplication | null = null;
    let stop: (() => void) | null = null;
    try {
      moveOwnWindow(e.hwnd, { x: 300, y: 200, width: 1100, height: 700 });
      app = await startApp(userData, [e.pid]);
      stop = keepTopmost([e.hwnd], await overlayHwnds(app));
      const t0 = Date.now();
      let onStripMs = 0;
      let last = Date.now();
      while (Date.now() - t0 < SOAK_MIN * 60_000) {
        const o = await observe(app);
        const now = Date.now();
        if (attachedId(o.out) === `tabStrip:${e.hwnd}`) onStripMs += now - last;
        last = now;
        await sleep(5000);
      }
      const logs = readLogLines(userData);
      const recreated = logs.filter((l) => /TaskbarCreated|taskbar recreated/i.test(l.m)).length;
      const timeouts = logs.filter((l) => /helper.*timeout|timeout.*helper/i.test(l.m)).length;
      const hours = SOAK_MIN / 60;
      fs.writeFileSync(path.join(testInfo.outputDir, 'explorer-soak.json'), JSON.stringify({ minutes: SOAK_MIN, onStripMin: Math.round(onStripMs / 60_000), recreated, timeouts }, null, 1));
      expect(recreated, 'TaskbarCreated during the soak').toBe(0);
      expect(timeouts / hours, 'helper timeouts per hour').toBeLessThanOrEqual(1);
      annotate(testInfo, 'REAL', `Explorer soak ${SOAK_MIN} min, on the strip ${Math.round(onStripMs / 60_000)} min`);
    } finally {
      stop?.();
      if (app) await quitApp(app).catch(() => undefined);
      await e.close();
    }
  });
});
