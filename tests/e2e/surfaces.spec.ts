// Environment surfaces through the real app (v1.1).
// - REAL: the provider over real Win32 (status, well-formed surfaces) and the surfaces of a
//   throwaway window this suite creates in its own process (never the user's windows).
// - SIMULATED: a fake auto-hide taskbar ledge is injected through the test hook (which replaces
//   every real surface), slid up under the cat and retracted again, while the real host, sim
//   and overlays run.
// - REAL traversal (v1.1.1): a fresh cat, at a raised sim time scale, gets onto a throwaway
//   window of typical size by itself and walks along its top; the window closes under it.
//   Opt-in (DESKTOP_CAT_REAL_BROWSER=1): the same with our own Edge instance's tab strip.
// No input is sent and no real taskbar or user window is touched (the only windows this suite
// changes are its own throwaway ones).
import { spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { ElectronApplication, TestInfo } from '@playwright/test';
// Pure modules only (no koffi/Electron in the Playwright process), except the Win32 probes below.
import { parseInjectedSurfaces } from '../../src/main/surfaces/validate';
import { defaultCornerRadiusDip, parseSurfaceId } from '../../src/main/surfaces/windowSurfaces';
import { CAT_BASE_WIDTH_DIP } from '../../src/shared/cat';
import type { Rect } from '../../src/shared/geometry';
import type { SimOutput } from '../../src/shared/sim';
import type { SurfaceDiagnostics } from '../../src/shared/surfaceDiagnostics';
import type { LedgeSurface, Surface, WallSurface } from '../../src/shared/surfaces';
import { closeBrowser, enablePerMonitorDpiAwareness, findBrowser, instancePids, launchBrowser, waitForBrowserWindow, type BrowserInstance } from '../integration/uia/realBrowser';
import { electronBinary, expect, hook, launchApp, quitApp, readLogLines, ROOT, test, waitForCat } from './fixtures';
import { win32Probe, WS_EX_TOPMOST } from './win32Probe';

const LEDGE_ID = 'taskbar:e2e';
/** How far above the floor the fake taskbar rises (px; below the cat's lift limit at any scale). */
const RISE_PX = 36;
const STEP_PX = 6;
const STEP_MS = 30;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function output(app: ElectronApplication): Promise<SimOutput> {
  const out = await hook(app, 'getSimOutput');
  if (!out) throw new Error('no sim output');
  return out;
}

const onLedge = (out: SimOutput): boolean => out.support.kind === 'surface' && out.support.surfaceId === LEDGE_ID;

// A throwaway always-on-top window in a separate Electron process: it is an ordinary app
// window to the cat (another process), above every normal window, and reports its HWND and
// DWM extended frame bounds (the visible edge) after each command. Commands and reports go
// through two files in the test's temp directory (no reliance on the child's stdio), and any
// error ends the process instead of raising Electron's error dialog.
const PROBE_WINDOW_SCRIPT = String.raw`
const fs = require('node:fs');
const { app, BrowserWindow } = require('electron');
const out = process.env.DCAT_PROBE_OUT;
const cmdFile = process.env.DCAT_PROBE_CMD;
const write = (o) => fs.appendFileSync(out, JSON.stringify(o) + '\n');
process.on('uncaughtException', (e) => {
  try { write({ error: String((e && e.stack) || e) }); } finally { app.exit(1); }
});
const koffi = require(process.env.DCAT_KOFFI);
const RECT = koffi.struct('DCAT_S3_RECT', { left: 'int32_t', top: 'int32_t', right: 'int32_t', bottom: 'int32_t' });
const dwm = koffi.load('dwmapi.dll');
const DwmGetWindowAttribute = dwm.func('__stdcall', 'DwmGetWindowAttribute', 'int32_t', ['intptr_t', 'uint32_t', koffi.out(koffi.pointer(RECT)), 'uint32_t']);
// 'typical' (DCAT_PROBE_LAYOUT): about 70 % of the primary work area, centred, its bottom edge
// ~180 px above the bottom of the work area; otherwise a small window near the top-left.
function bounds() {
  if (process.env.DCAT_PROBE_LAYOUT !== 'typical') return { x: 240, y: 260, width: 560, height: 360 };
  const d = require('electron').screen.getPrimaryDisplay();
  const wa = d.workArea;
  const width = Math.round(wa.width * 0.7);
  const bottom = wa.y + wa.height - Math.round(180 / d.scaleFactor);
  const height = Math.min(Math.round(wa.height * 0.7), bottom - wa.y - Math.round(120 / d.scaleFactor));
  return { x: wa.x + Math.round((wa.width - width) / 2), y: bottom - height, width, height };
}
app.whenReady().then(() => {
  // Shown without activation: a background process cannot take the foreground, and a refused
  // activation flashes the taskbar button, which keeps an auto-hide taskbar revealed.
  // The typical probe sits on a desk that may be in use: it cannot be moved, resized, minimized
  // or maximized by hand (the test moves it with setPosition), and says what it is.
  const typical = process.env.DCAT_PROBE_LAYOUT === 'typical';
  const fixed = typical ? { movable: false, resizable: false, minimizable: false, maximizable: false } : {};
  const w = new BrowserWindow({ ...bounds(), ...fixed, show: false, alwaysOnTop: true, backgroundColor: '#ffffff', title: 'dcat-e2e' });
  w.showInactive();
  w.loadURL(typical ? 'data:text/html,' + encodeURIComponent('<!doctype html><meta charset="utf-8"><body style="font:20px sans-serif;margin:40px">Desktop Cat end-to-end test window. It closes by itself within a few minutes; please leave it where it is.</body>') : 'about:blank');
  const hwnd = w.getNativeWindowHandle().readBigUInt64LE(0);
  let seq = 0;
  const report = () => {
    const r = {};
    const hr = DwmGetWindowAttribute(hwnd, 9, r, koffi.sizeof(RECT));
    const scale = require('electron').screen.getDisplayMatching(w.getBounds()).scaleFactor;
    write({ seq, hwnd: hwnd.toString(), frame: hr === 0 ? { x: r.left, y: r.top, width: r.right - r.left, height: r.bottom - r.top } : null, minimized: w.isMinimized(), scale });
  };
  setTimeout(report, 800);
  let done = 0;
  setInterval(() => {
    let lines = [];
    try { lines = fs.readFileSync(cmdFile, 'utf8').split('\n').filter(Boolean); } catch { return; }
    for (; done < lines.length; done++) {
      const c = JSON.parse(lines[done]);
      if (c.op === 'quit') return app.exit(0);
      if (c.op === 'move') w.setPosition(c.x, c.y);
      if (c.op === 'minimize') w.minimize();
      seq = done + 1;
      setTimeout(report, 400);
    }
  }, 100);
});
`;

interface ProbeReport {
  seq: number;
  hwnd: string;
  frame: Rect | null;
  minimized: boolean;
  scale: number;
}

interface ProbeWindow {
  proc: ChildProcess;
  /** The report that answers the latest command (or the first one). */
  next(): Promise<ProbeReport>;
  send(cmd: Record<string, unknown>): void;
  /** Asks the window process to quit, kills it if it does not, and resolves once it has exited. */
  close(): Promise<void>;
}

function openProbeWindow(dir: string, layout: 'small' | 'typical' = 'small'): ProbeWindow {
  const script = path.join(dir, 'probe-window.cjs');
  const outFile = path.join(dir, 'probe-out.jsonl');
  const cmdFile = path.join(dir, 'probe-cmd.jsonl');
  fs.writeFileSync(script, PROBE_WINDOW_SCRIPT);
  fs.writeFileSync(outFile, '');
  fs.writeFileSync(cmdFile, '');
  const env: Record<string, string> = {};
  // Not the test runner's Node options (its TS loader) nor this app's switches.
  const skip = (k: string): boolean => /^(ELECTRON_RUN_AS_NODE|NODE_OPTIONS)$/i.test(k) || k.toUpperCase().startsWith('DESKTOP_CAT_');
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined && !skip(k)) env[k] = v;
  Object.assign(env, { DCAT_KOFFI: path.join(ROOT, 'node_modules', 'koffi'), DCAT_PROBE_OUT: outFile, DCAT_PROBE_CMD: cmdFile, DCAT_PROBE_LAYOUT: layout, ELECTRON_ENABLE_LOGGING: '0' });
  const proc = spawn(electronBinary(), [script, `--user-data-dir=${path.join(dir, 'probe-profile')}`], { env, stdio: 'ignore' });
  const exited = new Promise<void>((resolve) => proc.once('exit', () => resolve()));
  let sent = 0;
  const reports = (): Array<ProbeReport | { error: string }> =>
    fs
      .readFileSync(outFile, 'utf8')
      .split('\n')
      .flatMap((l) => {
        // A line still being written is skipped until it is complete.
        try {
          return l ? [JSON.parse(l) as ProbeReport | { error: string }] : [];
        } catch {
          return [];
        }
      });
  return {
    proc,
    next: async () => {
      const deadline = Date.now() + 15_000;
      for (;;) {
        const all = reports();
        const failed = all.find((r): r is { error: string } => 'error' in r);
        if (failed) throw new Error(`probe window failed: ${failed.error}`);
        const r = all.find((x): x is ProbeReport => 'seq' in x && x.seq === sent);
        if (r) return r;
        if (proc.exitCode !== null || Date.now() > deadline) throw new Error(`probe window did not report (exit ${String(proc.exitCode)})`);
        await sleep(100);
      }
    },
    send: (cmd) => {
      sent++;
      fs.appendFileSync(cmdFile, `${JSON.stringify(cmd)}\n`);
    },
    close: async () => {
      if (proc.exitCode !== null || proc.signalCode !== null) return;
      fs.appendFileSync(cmdFile, '{"op":"quit"}\n');
      const quit = await Promise.race([exited.then(() => true), sleep(5000).then(() => false)]);
      if (!quit) {
        proc.kill();
        await exited;
      }
    },
  };
}

async function surfacesById(app: ElectronApplication): Promise<Map<string, Surface>> {
  return new Map((await hook(app, 'getSurfaces')).map((s) => [s.id, s]));
}

// ------------------------------------------------------------------ v1.1.1 traversal helpers

/** Sim time scale for the traversal tests: minutes of cat life in seconds of wall time. */
const TIME_SCALE = 12;
/** Bound on the sim time to the first arrival. SIMULATED replay of a probe-like window: 135-317 sim-s over 40 fresh cats. */
const MAX_SIM_TO_ARRIVE_MS = 900_000;
const MIN_STAY_SIM_MS = 10_000;

/** The sim output and the host's sim clock in one round trip. */
async function observe(app: ElectronApplication): Promise<{ simNow: number; out: SimOutput | null }> {
  return app.evaluate(() => {
    const api = (globalThis as Record<string, unknown>)['__desktopCatTest'] as { getSimOutput(): SimOutput | null; getHostDebug(): { simNow: number } };
    return { simNow: api.getHostDebug().simNow, out: api.getSimOutput() };
  });
}

const attachedId = (out: SimOutput | null): string | null => (out && out.support.kind === 'surface' ? out.support.surfaceId : null);

interface Stay {
  fromSim: number;
  toSim: number;
  pathPx: number;
  samples: number;
  /** Still on it when the watch ended. */
  open: boolean;
}

interface Trip {
  /** Sim ms (since the watch started) of the first tick seen on one of the window's sides / its destination ledge. */
  firstSide: number | null;
  firstUp: number | null;
  wallToFirstUpMs: number | null;
  stays: Stay[];
  /** Kinds of other surfaces the cat used meanwhile (the user's own windows, taskbars). */
  elsewhere: string[];
  /** About every 2 s of wall time: what the sim was offered and why it did (not) go (kinds, counts, reasons). */
  timeline: Array<Record<string, unknown>>;
  /**
   * Confounders from a person using this desk: sim times (s) at which the cat was being held by
   * hand (nothing in this suite drags it), arrivals that came right after such a carry (they do
   * not count), and changes of our window's rect that this test did not make.
   */
  heldAtS: number[];
  carriedUpAtS: number[];
  windowMovedAtS: number[];
  polls: number;
  simMs: number;
  wallMs: number;
}

/**
 * Polls the cat (about every 60 ms of wall time) until it has stood on `upId` for at least
 * MIN_STAY_SIM_MS and walked `minPathPx` along it (returning while it is still up there), or the
 * sim/wall budget runs out.
 */
async function watchTrip(app: ElectronApplication, o: { hwnd: string; upId: string; minPathPx: number; maxWallMs: number }): Promise<Trip> {
  const w0 = Date.now();
  const s0 = (await observe(app)).simNow;
  const trip: Trip = { firstSide: null, firstUp: null, wallToFirstUpMs: null, stays: [], elsewhere: [], timeline: [], heldAtS: [], carriedUpAtS: [], windowMovedAtS: [], polls: 0, simMs: 0, wallMs: 0 };
  const other = new Set<string>();
  let cur: (Stay & { lastX: number }) | null = null;
  let nextLineAt = 0;
  const w32 = win32Probe();
  const rectKey = (): string => JSON.stringify(w32.windowRect(o.hwnd));
  let lastRect = rectKey();
  /** Picked up by hand and not yet back on the floor: an arrival now is a carry, not a climb. */
  let carried = false;
  for (;;) {
    const { simNow, out } = await observe(app);
    trip.polls++;
    const t = simNow - s0;
    trip.simMs = t;
    trip.wallMs = Date.now() - w0;
    if (out?.support.kind === 'held') {
      carried = true;
      const s = Math.round(t / 1000);
      if (trip.heldAtS[trip.heldAtS.length - 1] !== s) trip.heldAtS.push(s);
    } else if (out?.support.kind === 'floor') carried = false;
    const rect = rectKey();
    if (rect !== lastRect) {
      trip.windowMovedAtS.push(Math.round(t / 1000));
      lastRect = rect;
    }
    if (trip.wallMs >= nextLineAt) {
      nextLineAt = trip.wallMs + 2000;
      const list = await hook(app, 'getSurfaces');
      const d = await hook(app, 'getSurfaceDiagnostics');
      trip.timeline.push({
        simS: Math.round(t / 1000),
        window: w32.windowRect(o.hwnd),
        state: out?.state ?? null,
        support: attachedId(out)?.split(':')[0] ?? out?.support.kind ?? null,
        mine: list.filter((s) => s.ownerId === o.hwnd).map((s) => s.kind),
        others: list.filter((s) => s.ownerId !== o.hwnd).map((s) => (s.orientation === 'ledge' ? `${s.kind}@${Math.round(s.y)}` : s.kind)),
        reachable: d?.nav.reachable,
        rejected: d?.nav.rejected,
        targets: d?.decision.targets,
        urge: d ? Math.round(d.decision.exploreUrge * 100) / 100 : null,
        skipped: d?.provider.skipped,
        frontMaximized: d?.provider.frontMaximized,
      });
    }
    const id = attachedId(out);
    if (id !== null && id.startsWith(`windowSide:${o.hwnd}:`) && trip.firstSide === null) trip.firstSide = t;
    if (id !== null && parseSurfaceId(id)?.owner !== o.hwnd) other.add(id.split(':')[0] ?? '?');
    if (id === o.upId && out && carried && !cur) {
      // Put up there by hand: not an arrival of its own (it counts once it has been down again).
      const s = Math.round(t / 1000);
      if (trip.carriedUpAtS[trip.carriedUpAtS.length - 1] !== s) trip.carriedUpAtS.push(s);
    } else if (id === o.upId && out) {
      if (trip.firstUp === null) {
        trip.firstUp = t;
        trip.wallToFirstUpMs = trip.wallMs;
      }
      if (!cur) cur = { fromSim: t, toSim: t, pathPx: 0, samples: 0, open: true, lastX: out.x };
      cur.pathPx += Math.abs(out.x - cur.lastX);
      cur.lastX = out.x;
      cur.toSim = t;
      cur.samples++;
      if (cur.toSim - cur.fromSim >= MIN_STAY_SIM_MS && cur.pathPx >= o.minPathPx) break;
    } else if (cur) {
      trip.stays.push({ ...cur, open: false });
      cur = null;
    }
    if (t > MAX_SIM_TO_ARRIVE_MS + 120_000 || trip.wallMs > o.maxWallMs) break;
    if (trip.firstUp === null && t > MAX_SIM_TO_ARRIVE_MS) break;
    await sleep(60);
  }
  if (cur) trip.stays.push({ fromSim: cur.fromSim, toSim: cur.toSim, pathPx: cur.pathPx, samples: cur.samples, open: true });
  trip.elsewhere = [...other];
  return trip;
}

/** Diagnostics kinds/counts summary for the report (no ids, no titles). */
function diagSummary(d: SurfaceDiagnostics | null): Record<string, unknown> | null {
  if (!d) return null;
  return { verdict: d.verdict, listed: d.provider.listed, reachable: d.nav.reachable, accepted: d.nav.accepted, rejected: d.nav.rejected, climbs: d.nav.climbs, support: d.decision.support, targets: d.decision.targets, tabStrips: d.provider.tabStrips };
}

/** Records a measurement on the test (shown by the list reporter's annotations and in the JSON log). */
function record(info: TestInfo, what: string, data: unknown): void {
  const text = JSON.stringify(data);
  info.annotations.push({ type: what, description: text });
  console.log(`[measure] ${info.title.slice(0, 40)} | ${what}: ${text}`);
}

/** Skip with the reason recorded (so every environment skip is visible in the report). */
function skipBecause(info: TestInfo, reason: string): void {
  record(info, 'skip', reason);
  test.skip(true, reason);
}

/** Which windows are in front of our own window at its top edge and both sides (process, flags and geometry only; never a title). */
function coversOf(hwnd: string, f: Rect, pids: Record<string, number | undefined>) {
  const w32 = win32Probe();
  return [
    [f.x + f.width / 2, f.y + 4],
    [f.x + 4, f.y + f.height / 2],
    [f.x + f.width - 4, f.y + f.height / 2],
  ].flatMap(([x, y]) => {
    const h = w32.rootWindowAt(Math.round(x!), Math.round(y!));
    if (h === hwnd) return [];
    const pid = h === null ? 0 : w32.ownerPid(h);
    const who = Object.entries(pids).find(([, p]) => p !== undefined && p === pid)?.[0] ?? (h === null ? 'nothing' : 'another process');
    return [
      {
        at: [Math.round(x!), Math.round(y!)],
        who,
        topmost: h !== null && (w32.exStyle(h) & WS_EX_TOPMOST) !== 0,
        exStyle: h === null ? null : `0x${(w32.exStyle(h) >>> 0).toString(16)}`,
        band: h === null ? null : w32.windowBand(h),
        z: h === null ? null : w32.zIndex(h),
        rect: h === null ? null : w32.windowRect(h),
        zoomed: h !== null && w32.isZoomed(h),
      },
    ];
  });
}

/**
 * Precondition: our own throwaway window must really be in front at its edges (a topmost window
 * normally is). If it is not, it is made topmost once more (our own window only) and checked
 * again; still covered, the test is skipped with what was in front recorded.
 */
async function requireInFront(app: ElectronApplication, info: TestInfo, hwnd: string, f: Rect, pids: Record<string, number | undefined>, what: string): Promise<void> {
  const w32 = win32Probe();
  await sleep(500);
  let covers = coversOf(hwnd, f, pids);
  const first = covers;
  let reasserted: boolean | null = null;
  if (covers.length > 0) {
    reasserted = w32.setOwnWindowTopmost(hwnd, true);
    await sleep(500);
    covers = coversOf(hwnd, f, pids);
  }
  const host = await hook(app, 'getHostDebug');
  const listedByApp = [...(await surfacesById(app)).values()].filter((s) => s.ownerId === hwnd).map((s) => s.kind);
  record(info, 'inFront', {
    what,
    topmost: (w32.exStyle(hwnd) & WS_EX_TOPMOST) !== 0,
    band: w32.windowBand(hwnd),
    z: w32.zIndex(hwnd),
    state: w32.enabledAndVisible(hwnd),
    coveredFirst: first,
    reassertedTopmost: reasserted,
    coveredAfter: covers,
    quns: w32.notificationState(),
    hostLocked: host.locked,
    hostHidden: host.hidden,
    listedByApp,
  });
  if (covers.length > 0) skipBecause(info, `environment: ${what} is covered at ${covers.length} of 3 edge points by ${JSON.stringify(covers.map((c) => ({ who: c.who, topmost: c.topmost, band: c.band, zoomed: c.zoomed, rect: c.rect })))}`);
}

/**
 * A person at this desk picked the cat up or moved our window, and the run did not show what it
 * is about (`ok`): it cannot tell a regression from the interference (a window dragged low is
 * reached with a plain jump), so it is skipped with the confounders recorded. Interference in a
 * run that passed anyway is only recorded.
 */
function skipIfDeskInUse(info: TestInfo, trip: Trip, ok: boolean): void {
  const interfered = trip.heldAtS.length > 0 || trip.windowMovedAtS.length > 0;
  if (interfered) record(info, 'confounders', { heldAtS: trip.heldAtS, carriedUpAtS: trip.carriedUpAtS, windowMovedAtS: trip.windowMovedAtS });
  if (interfered && !ok) {
    skipBecause(info, `environment: the desk was in use (cat held by hand at sim ${JSON.stringify(trip.heldAtS)} s, our window moved at sim ${JSON.stringify(trip.windowMovedAtS)} s); the run is not evidence either way`);
  }
}

async function settingsForTraversal(app: ElectronApplication): Promise<void> {
  // A normal fresh cat (nothing seeded). Only the first-run flow is marked done, and two things a
  // person at this PC could do to the run are kept out: the cat does not fall asleep because they
  // have been away for 5 minutes (real idle time is not scaled), and it cannot be picked up by hand
  // (the overlay stays click-through; the sim's autonomous behaviour does not depend on it).
  const patched = await hook(app, 'patchSettings', { general: { firstRunCompleted: true }, behavior: { sleepAfterIdleMinutes: 120 }, interaction: { enabled: false } });
  expect(patched.ok).toBe(true);
}

test.describe('environment surfaces (real app)', () => {
  test('reports surface status and the surfaces the sim saw', async ({ userData }) => {
    const app = await launchApp(userData);
    try {
      await waitForCat(app);
      const status = await hook(app, 'getSurfaceStatus');
      expect(['tracked', 'unavailable']).toContain(status.taskbar);
      expect(['tracked', 'unavailable']).toContain(status.windowSurfaces);
      expect(['active', 'idle', 'off', 'unavailable']).toContain(status.tabStrips);
      expect((await hook(app, 'getStatus')).surfaces).toEqual(status);
      const list = await hook(app, 'getSurfaces');
      expect(Array.isArray(list)).toBe(true);
      // Real surfaces never carry titles or other extra fields.
      for (const s of list) expect(Object.keys(s).every((k) => !/title|name/i.test(k))).toBe(true);
      await expect(hook(app, 'injectSurfaces', [{ id: 'bad' } as unknown as Surface])).rejects.toThrow(/injectSurfaces/);
    } finally {
      expect(await quitApp(app)).toBe(0);
    }
  });

  test('real observers (REAL Win32): every listed surface is well-formed and attributed', async ({ userData }) => {
    const app = await launchApp(userData);
    try {
      await waitForCat(app);
      const status = await hook(app, 'getSurfaceStatus');
      expect(status.windowSurfaces).toBe('tracked');
      expect(status.taskbar).toBe('tracked');
      expect(status.taskbars).toBeGreaterThanOrEqual(1);
      // A few host ticks with the real provider.
      await sleep(1500);
      const list = await hook(app, 'getSurfaces');
      const displays = new Set((await hook(app, 'getOverlays')).map((o) => o.displayId));
      for (const s of list) {
        // Same schema the injection hook enforces (finite numbers, no extra fields).
        expect(() => parseInjectedSurfaces([s])).not.toThrow();
        expect(parseSurfaceId(s.id), s.id).not.toBeNull();
        expect(s.id.split(':')[1]).toBe(s.ownerId);
        if (s.displayId !== null) expect(displays.has(s.displayId)).toBe(true);
      }
      expect(new Set(list.map((s) => s.id)).size).toBe(list.length);
    } finally {
      expect(await quitApp(app)).toBe(0);
    }
  });

  test('REAL window surfaces: a throwaway window offers its visible top edge and sides, follows a move and drops out when minimized', async ({ userData }) => {
    test.setTimeout(90_000);
    const app = await launchApp(userData);
    const probe = openProbeWindow(userData);
    try {
      await waitForCat(app);
      let r = await probe.next();
      const f = r.frame;
      if (f === null) throw new Error('probe window has no DWM frame');
      const topId = `windowTop:${r.hwnd}`;
      // Precondition: the probe must really be the topmost window at its own top edge. A fullscreen or
      // full-monitor window the user has in front can stop Windows from making it topmost; then the
      // provider is right not to offer a covered edge, and the scenario cannot run on this desktop.
      {
        const w32 = win32Probe();
        await new Promise((res) => setTimeout(res, 500));
        const coveredBy = w32.rootWindowAt(Math.round(f.x + f.width / 2), Math.round(f.y + 4));
        const probeTopmost = (w32.exStyle(r.hwnd) & WS_EX_TOPMOST) !== 0;
        test.skip(!probeTopmost || coveredBy !== r.hwnd, `environment: the probe window is ${probeTopmost ? 'covered' : 'not topmost'} (another window is in front, e.g. a fullscreen app)`);
      }
      try {
        await expect.poll(async () => (await surfacesById(app)).has(topId), { timeout: 10_000 }).toBe(true);
      } catch (err) {
        // Attach what the app saw, so an environment-dependent failure can be told from a regression.
        const seen = [...(await surfacesById(app)).values()].map((s) => `${s.kind}:${s.ownerId}`);
        const report = await hook(app, 'getDiagnosticsReport');
        const services = (report['services'] ?? {}) as Record<string, unknown>;
        throw new Error(`probe ${r.hwnd}; surfaces seen: ${JSON.stringify(seen)}; provider: ${JSON.stringify(services['surfaces']).slice(0, 600)}`, { cause: err });
      }
      const inset = Math.round(defaultCornerRadiusDip(os.release()) * r.scale);
      const byId = await surfacesById(app);
      const top = byId.get(topId) as LedgeSurface;
      // Feet on the DWM frame top (the visible edge), corners kept clear; topmost, so nearly whole.
      expect(top).toMatchObject({ kind: 'windowTop', ownerId: r.hwnd, y: f.y, excluded: false });
      expect(top.x0).toBeGreaterThanOrEqual(f.x + inset);
      expect(top.x1).toBeLessThanOrEqual(f.x + f.width - inset);
      expect(top.x1 - top.x0).toBeGreaterThan(f.width / 2);
      for (const side of ['left', 'right'] as const) {
        const w = byId.get(`windowSide:${r.hwnd}:${side}`) as WallSurface | undefined;
        expect(w, side).toBeDefined();
        expect(w!.x).toBe(side === 'left' ? f.x : f.x + f.width);
        expect(w!.y0).toBeGreaterThanOrEqual(f.y + inset);
        expect(w!.y1).toBeLessThanOrEqual(f.y + f.height - inset);
      }

      // A programmatic move raises no move events: the periodic z-order read picks it up.
      probe.send({ op: 'move', x: 320, y: 330 });
      r = await probe.next();
      const moved = r.frame!;
      expect(moved.y).not.toBe(f.y);
      await expect.poll(async () => ((await surfacesById(app)).get(topId) as LedgeSurface | undefined)?.y, { timeout: 5_000 }).toBe(moved.y);

      probe.send({ op: 'minimize' });
      r = await probe.next();
      expect(r.minimized).toBe(true);
      await expect.poll(async () => [...(await surfacesById(app)).values()].some((s) => s.ownerId === r.hwnd), { timeout: 5_000 }).toBe(false);
      expect(await hook(app, 'getHostDebug')).toMatchObject({ tickErrors: 0 });
    } finally {
      await probe.close();
      expect(await quitApp(app)).toBe(0);
    }
  });

  test('SIMULATED taskbar ledge: rising under the cat lifts it, retracting sets it back on the floor calmly', async ({ userData }) => {
    test.setTimeout(90_000);
    const app = await launchApp(userData);
    try {
      await waitForCat(app);
      // Keep the cat on the floor: no window perching, climbing, tab strips or chasing.
      const patched = await hook(app, 'patchSettings', {
        general: { firstRunCompleted: true },
        behavior: { disabledBehaviors: ['perchOnWindows', 'inspectWindows', 'climbWindows', 'tabStrips', 'zoomies', 'chaseCursor', 'pawAtCursor', 'seekAttention'] },
      });
      expect(patched.ok).toBe(true);
      await hook(app, 'injectSurfaces', []);
      await expect
        .poll(async () => {
          const out = await output(app);
          return out.visible && out.support.kind === 'floor' && out.vy === 0;
        }, { timeout: 30_000 })
        .toBe(true);
      const start = await output(app);
      const floorY = start.y;
      const overlays = await hook(app, 'getOverlays');
      const home = overlays.find((o) => o.displayId === start.displayId) ?? overlays[0]!;
      const ledge = (y: number, phase: LedgeSurface['phase'], vy: number): LedgeSurface => ({
        id: LEDGE_ID,
        kind: 'taskbar',
        orientation: 'ledge',
        ownerId: 'e2e',
        displayId: start.displayId,
        phase,
        vx: 0,
        vy,
        confidence: 1,
        validatedAt: 0,
        excluded: false,
        y,
        x0: home.boundsPx.x,
        x1: home.boundsPx.x + home.boundsPx.width,
        rest: null,
        focusX: null,
        edge: 'bottom',
      });

      // Slide in: from just above the floor (it covers the floor) up to RISE_PX above it.
      const vyIn = -(STEP_PX * 1000) / STEP_MS;
      for (let dy = 3; dy <= RISE_PX; dy += STEP_PX) {
        await hook(app, 'injectSurfaces', [ledge(floorY - dy, 'entering', vyIn)]);
        await sleep(STEP_MS);
      }
      const top = floorY - RISE_PX;
      await hook(app, 'injectSurfaces', [ledge(top, 'stable', 0)]);
      expect((await hook(app, 'getSurfaces')).map((s) => s.id)).toContain(LEDGE_ID);
      await expect.poll(async () => onLedge(await output(app)), { timeout: 10_000 }).toBe(true);
      await expect.poll(async () => Math.abs((await output(app)).y - top), { timeout: 5_000 }).toBeLessThanOrEqual(2);
      // It rides the ledge: still on it a moment later.
      await sleep(500);
      expect(onLedge(await output(app))).toBe(true);

      // Slide out and disappear; the cat ends on the floor without a startle.
      const states = new Set<string>();
      for (let dy = RISE_PX; dy >= 3; dy -= STEP_PX) {
        await hook(app, 'injectSurfaces', [ledge(floorY - dy, 'leaving', -vyIn)]);
        states.add((await output(app)).state);
        await sleep(STEP_MS);
      }
      await hook(app, 'injectSurfaces', []);
      await expect
        .poll(async () => {
          const out = await output(app);
          states.add(out.state);
          return out.support.kind === 'floor' && Math.abs(out.y - floorY) <= 1;
        }, { timeout: 10_000 })
        .toBe(true);
      expect([...states]).not.toContain('startled');

      // Real observers again.
      await hook(app, 'injectSurfaces', null);
      await expect.poll(async () => (await hook(app, 'getSurfaces')).some((s) => s.id === LEDGE_ID)).toBe(false);
      expect(await hook(app, 'getHostDebug')).toMatchObject({ tickErrors: 0 });
      expect((await hook(app, 'getLogProblems')).error).toBe(0);
    } finally {
      expect(await quitApp(app)).toBe(0);
    }
    expect(readLogLines(userData).filter((l) => l.l === 'error').map((l) => `${l.s}: ${l.m}`)).toEqual([]);
  });

  test('REAL traversal: a fresh cat gets onto a typical window by itself, walks along its top, and lands safely when the window closes', async ({ userData }, info) => {
    test.setTimeout(240_000);
    const app = await launchApp(userData);
    const appProc = app.process();
    const probe = openProbeWindow(userData, 'typical');
    record(info, 'pids', { app: appProc.pid, probeWindow: probe.proc.pid });
    try {
      await waitForCat(app);
      await settingsForTraversal(app);
      const r = await probe.next();
      const f = r.frame;
      if (f === null) throw new Error('probe window has no DWM frame');
      const topId = `windowTop:${r.hwnd}`;
      record(info, 'startSupport', (await observe(app)).out?.support ?? null);
      // The floor below the cat (the work-area bottom minus the app's inset), as the diagnostics report it.
      await expect.poll(async () => (await hook(app, 'getSurfaceDiagnostics'))?.coordinates.cat.floorYPx ?? null, { timeout: 10_000 }).not.toBeNull();
      const floorY = (await hook(app, 'getSurfaceDiagnostics'))!.coordinates.cat.floorYPx!;
      const bodyPx = CAT_BASE_WIDTH_DIP * r.scale;
      record(info, 'probe', { frame: f, scale: r.scale, floorY, topAboveFloorPx: floorY - f.y, bottomAboveFloorPx: floorY - (f.y + f.height) });
      // Our own window must have the shape this test is about: a top far beyond a jump (420 DIP),
      // its bottom 100-250 px above the floor (sides that end out of a step's reach).
      expect(floorY - f.y).toBeGreaterThan(420 * r.scale * 1.5);
      expect(floorY - (f.y + f.height)).toBeGreaterThanOrEqual(100);
      expect(floorY - (f.y + f.height)).toBeLessThanOrEqual(250);
      await requireInFront(app, info, r.hwnd, f, { app: appProc.pid, probe: probe.proc.pid }, 'the probe window');
      await expect.poll(async () => (await surfacesById(app)).has(topId), { timeout: 10_000 }).toBe(true);
      const others = (await hook(app, 'getSurfaces')).filter((s) => s.ownerId !== r.hwnd && s.kind !== 'taskbar').map((s) => s.kind);
      record(info, 'otherWindowSurfaces', others);
      // On the floor, with the probe listed: the floor reaches it, and the Diagnostics page says so.
      await expect.poll(async () => (await observe(app)).out?.support.kind, { timeout: 15_000 }).toBe('floor');
      await expect.poll(async () => (await hook(app, 'getSurfaceDiagnostics'))?.nav.reachable.windowSide ?? 0, { timeout: 10_000 }).toBeGreaterThanOrEqual(1);
      const before = await hook(app, 'getSurfaceDiagnostics');
      record(info, 'diagnosticsOnFloor', diagSummary(before));
      expect(before!.nav.reachable.windowTop).toBeGreaterThanOrEqual(1);
      expect(before!.provider.listed.windowTop).toBeGreaterThanOrEqual(1);
      expect(before!.decision.support).toBe('floor');
      expect(before!.verdict.length).toBeGreaterThan(10);
      record(info, 'catStatsAtStart', ((await hook(app, 'getDiagnosticsReport'))['cat'] as Record<string, unknown> | undefined)?.['stats'] ?? null);

      await hook(app, 'setTimeScale', TIME_SCALE);
      const trip = await watchTrip(app, { hwnd: r.hwnd, upId: topId, minPathPx: 2 * bodyPx, maxWallMs: 150_000 });
      const during = await hook(app, 'getSurfaceDiagnostics');
      record(info, 'trip', { ...trip, timeScale: TIME_SCALE, bodyPx });
      record(info, 'probeFrontAfter', { z: win32Probe().zIndex(r.hwnd), topmost: (win32Probe().exStyle(r.hwnd) & WS_EX_TOPMOST) !== 0, covers: coversOf(r.hwnd, f, { app: appProc.pid, probe: probe.proc.pid }) });
      record(info, 'diagnosticsUp', diagSummary(during));
      const best = trip.stays.reduce<Stay | null>((b, s) => (b === null || s.toSim - s.fromSim > b.toSim - b.fromSim ? s : b), null);
      const climbedUp = (during?.nav.climbs.leaps ?? 0) + (during?.nav.climbs.mounts ?? 0) >= 1 && (during?.nav.climbs.pulledUp ?? 0) >= 1;
      const ok = trip.firstUp !== null && climbedUp && best !== null && best.toSim - best.fromSim >= MIN_STAY_SIM_MS && best.pathPx >= 2 * bodyPx;
      skipIfDeskInUse(info, trip, ok);
      expect(trip.firstUp, `reached the probe's top within ${MAX_SIM_TO_ARRIVE_MS / 1000} sim-s`).not.toBeNull();
      // Up the side (leap/step, climb, pull-up): the top is out of jump reach.
      expect((during?.nav.climbs.leaps ?? 0) + (during?.nav.climbs.mounts ?? 0)).toBeGreaterThanOrEqual(1);
      expect(during?.nav.climbs.pulledUp ?? 0).toBeGreaterThanOrEqual(1);
      expect(best!.toSim - best!.fromSim, 'attached to the top').toBeGreaterThanOrEqual(MIN_STAY_SIM_MS);
      expect(best!.pathPx, 'walked along the top').toBeGreaterThanOrEqual(2 * bodyPx);

      // The window closes under the cat (if it is still up there): a fall, then the floor.
      const upAtClose = attachedId((await observe(app)).out) === topId;
      const closedAt = Date.now();
      await probe.close();
      let landedWallMs: number | null = null;
      await expect
        .poll(
          async () => {
            const out = (await observe(app)).out;
            const ok = out !== null && out.support.kind === 'floor' && Math.abs(out.y - floorY) <= 1;
            if (ok && landedWallMs === null) landedWallMs = Date.now() - closedAt;
            return ok;
          },
          { timeout: 5_000, intervals: [50] },
        )
        .toBe(true);
      record(info, 'afterClose', { upAtClose, landedWallMs });
      await expect.poll(async () => [...(await surfacesById(app)).values()].some((s) => s.ownerId === r.hwnd), { timeout: 5_000 }).toBe(false);
      await sleep(1500);
      const end = await observe(app);
      expect(end.out?.visible).toBe(true);
      expect(attachedId(end.out)?.includes(r.hwnd) ?? false).toBe(false);
      expect((await hook(app, 'getSurfaceDiagnostics'))?.decision.support).not.toBe('windowTop');
      expect(await hook(app, 'getHostDebug')).toMatchObject({ tickErrors: 0 });
    } finally {
      await probe.close();
      record(info, 'closed', { probeWindowExit: probe.proc.exitCode ?? probe.proc.signalCode });
      const code = await quitApp(app);
      record(info, 'closed', { appExit: code });
      expect(code).toBe(0);
    }
    expect(readLogLines(userData).filter((l) => l.l === 'error').map((l) => `${l.s}: ${l.m}`)).toEqual([]);
  });

  test('REAL browser (opt-in): our own floating Edge window\'s tab strip reaches the sim while the cat is on the floor, and the cat gets onto it', async ({ userData }, info) => {
    test.setTimeout(240_000);
    if (process.platform !== 'win32' || process.env.DESKTOP_CAT_REAL_BROWSER !== '1') {
      skipBecause(info, 'opt-in: set DESKTOP_CAT_REAL_BROWSER=1 (opens a throwaway Edge window on the desktop)');
      return;
    }
    const exe = findBrowser('edge');
    if (exe === null) {
      skipBecause(info, 'environment: Microsoft Edge is not installed in a standard location');
      return;
    }
    const app = await launchApp(userData);
    record(info, 'pids', { app: app.process().pid });
    let inst: BrowserInstance | null = null;
    try {
      await waitForCat(app);
      await settingsForTraversal(app);
      enablePerMonitorDpiAwareness();
      // A normal floating size (about 70 % of a 1536x960 DIP work area), never maximized.
      inst = launchBrowser('edge', exe, { x: 230, y: 144, width: 1075, height: 672, urls: ['about:blank', 'about:blank', 'about:blank'] });
      const win = await waitForBrowserWindow(inst, 30_000);
      record(info, 'pids', { edgeLauncher: inst.launcherPid, edgeProcesses: [...(await instancePids(inst))] });
      const w32 = win32Probe();
      const f = win.frame;
      record(info, 'edge', { frame: f, zoomed: w32.isZoomed(win.hwnd) });
      if (w32.isZoomed(win.hwnd)) skipBecause(info, 'environment: Edge opened maximized');
      // Our own window in front of the user's normal windows (never another application's window).
      record(info, 'edgeTopmost', w32.setOwnWindowTopmost(win.hwnd, true));
      const edgePids = Object.fromEntries([...(await instancePids(inst))].map((p, i) => [`edge${i}`, p]));
      await requireInFront(app, info, win.hwnd, f, { app: app.process().pid, ...edgePids }, 'our Edge window');

      const stripId = `tabStrip:${win.hwnd}`;
      const t0 = Date.now();
      let listedOnFloor: boolean | null = null;
      await expect
        .poll(
          async () => {
            const s = (await surfacesById(app)).get(stripId);
            if (s && listedOnFloor === null) listedOnFloor = (await observe(app)).out?.support.kind === 'floor';
            return s !== undefined;
          },
          { timeout: 20_000, intervals: [100] },
        )
        .toBe(true);
      const strip = (await surfacesById(app)).get(stripId) as LedgeSurface;
      const diag = await hook(app, 'getSurfaceDiagnostics');
      record(info, 'strip', { listedAfterWallMs: Date.now() - t0, listedOnFloor, y: strip.y, x0: strip.x0, x1: strip.x1, land: strip.land ?? null, frameTop: f.y });
      record(info, 'diagnosticsOnFloor', diagSummary(diag));
      expect(listedOnFloor, 'the strip was listed while the cat was on the floor').toBe(true);
      expect(strip.y).toBe(f.y);
      expect(strip.x0).toBeGreaterThan(f.x);
      expect(strip.x1).toBeLessThan(f.x + f.width);
      expect(diag!.provider.tabStrips.strips).toBeGreaterThanOrEqual(1);
      expect(diag!.nav.reachable.tabStrip).toBeGreaterThanOrEqual(1);

      await hook(app, 'setTimeScale', TIME_SCALE);
      const scale = await app.evaluate(({ screen }) => screen.getPrimaryDisplay().scaleFactor);
      const trip = await watchTrip(app, { hwnd: win.hwnd, upId: stripId, minPathPx: CAT_BASE_WIDTH_DIP * scale, maxWallMs: 150_000 });
      record(info, 'trip', { ...trip, timeScale: TIME_SCALE });
      record(info, 'diagnosticsUp', diagSummary(await hook(app, 'getSurfaceDiagnostics')));
      const longest = Math.max(0, ...trip.stays.map((s) => s.toSim - s.fromSim));
      skipIfDeskInUse(info, trip, trip.firstUp !== null && longest >= MIN_STAY_SIM_MS);
      expect(trip.firstUp, `reached the tab strip within ${MAX_SIM_TO_ARRIVE_MS / 1000} sim-s`).not.toBeNull();
      expect(longest).toBeGreaterThanOrEqual(MIN_STAY_SIM_MS);
      expect(await hook(app, 'getHostDebug')).toMatchObject({ tickErrors: 0 });

      // Edge closes (WM_CLOSE to our own window) while the cat may still be up: it lands on the floor.
      const upAtClose = attachedId((await observe(app)).out) === stripId;
      const own = inst;
      inst = null;
      const closed = await closeBrowser(own);
      record(info, 'closed', { edge: closed, edgeProcessesLeft: (await instancePids(own)).size, upAtClose });
      expect(closed.leftOver).toBe(0);
      expect(closed.profileRemoved).toBe(true);
      await expect.poll(async () => (await observe(app)).out?.support.kind, { timeout: 5_000, intervals: [50] }).toBe('floor');
      expect(await hook(app, 'getHostDebug')).toMatchObject({ tickErrors: 0 });
    } finally {
      if (inst) {
        const closed = await closeBrowser(inst);
        record(info, 'closed', { edge: closed, edgeProcessesLeft: (await instancePids(inst)).size });
        expect(closed.leftOver).toBe(0);
        expect(closed.profileRemoved).toBe(true);
      }
      const code = await quitApp(app);
      record(info, 'closed', { appExit: code });
      expect(code).toBe(0);
    }
  });
});
