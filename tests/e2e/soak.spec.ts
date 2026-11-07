// Interaction soak (docs/gizeverse/13-interaction-reliability.md, diagnosis §3.E): the real app on this
// desktop takes a random gesture every few seconds for DESKTOP_CAT_SOAK_MIN minutes (default 30) while it
// is perturbed: an own maximized window on and off, hide/show, pause/resume, a 4 s renderer freeze, a
// short CPU hog, suspend/resume and lock/unlock through the app's own power handlers, and a nap command.
// Opt-in, because it puts the cat and an own maximized window on the desk:
//   npm run build   (through: node scripts/with-lock.mjs build -- npm run build)
//   DESKTOP_CAT_E2E_SOAK=1 DESKTOP_CAT_SOAK_MIN=3 node scripts/with-lock.mjs soak -- npx playwright test tests/e2e/soak.spec.ts
// Optional: DESKTOP_CAT_SOAK_SCALE (sim time scale between gestures, default 3), DESKTOP_CAT_SOAK_SEED,
// DESKTOP_CAT_SOAK_ONLY (comma-separated gesture kinds for the main loop), DESKTOP_CAT_SOAK_PERTURB (0: no
// perturbations; or comma-separated perturbation kinds), DESKTOP_CAT_SOAK_OS_MOUSE=1 (do not hold the overlay click-through during gestures; see below).
//
// During a gesture the overlay is held click-through (forceInteractive(false)): CDP input reaches the page
// anyway, and the real mouse cannot. Otherwise the injected cursor on the cat and the press make the whole
// overlay take the real mouse wherever it is (the desk is blocked for the gesture), and any real mouse move
// Windows then sends the overlay carries the button up, which ends a synthetic drag as a release. (CDP input
// never reaches GetAsyncKeyState: Win32 never sees these presses down, so main treats their button state as
// unknown and keeps the everywhere-capture while the renderer reports moves.) With real input the OS move
// carries the held button. Click-through is measured separately, with the app's own routing (probes, freezes).
//
// Like tests/e2e/lively.spec.ts:
//   - an own userData (tests/e2e/fixtures.ts), which also isolates Electron's single-instance lock, so
//     an installed Desktop Cat running for the user is never handed this launch, and vice versa;
//   - own windows only (tests/e2e/ownWindows.ts) and restrictSurfacesToPids([own pid]), so the user's
//     windows never become surfaces; only our window is moved, re-asserted as topmost and closed;
//   - input is CDP mouse events on the overlay page (never the OS cursor) with injectCursor alongside,
//     as the host reads the cursor while dragging; nothing is sent to the OS.
// Measured and attached as soak-report.json: success per gesture type (counters from the saved cat
// state, falls from the behaviour profile), latency from mouse.down to the sim being held, the
// interaction counters (overlay press path, click guard, lock/suspend bookkeeping), click-through
// correctness with the injected cursor on and off the cat, recreates, main event-loop delay, and the
// main and renderer heaps at start and end.
// Pass: every gesture outside a designed guard state succeeds; nothing sticks (after each gesture
// main holds no press or drag, the sim lets go, and the cat takes the mouse again); the overlay never
// takes the mouse off the cat (T8); bounded heap growth; no tick errors or error log lines.
// Labels: the app, its renderer input path, IPC, gestures, sim and click-through decision are REAL once
// this has run here; the pointer and cursor input are SIMULATED (CDP and injectCursor); the power
// events are SIMULATED (the app's own handlers, no OS signal). CDP input never reaches
// GetAsyncKeyState: the real button reads "up" throughout, so a still hold of more than 1.5 s is not
// a scenario this soak can run (it needs real OS input; diagnosis H1a).
import { spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { CDPSession, ElectronApplication, Page, TestInfo } from '@playwright/test';
import type { BehaviorProfileSnapshot } from '../../src/shared/behaviorProfile';
import type { Counters } from '../../src/shared/catState';
import type { Point, Rect } from '../../src/shared/geometry';
import type { SimOutput } from '../../src/shared/sim';
import type { InteractionStatsReport } from '../../src/main/testHooks';
import type { OverlayInfo, OverlayInteractionStats } from '../../src/main/overlay/overlayManager';
import { enablePerMonitorDpiAwareness } from '../integration/uia/realBrowser';
import { expect, hook, launchApp, quitApp, readLogLines, test, waitForCat } from './fixtures';
import { keepTopmost, openOwnWindow, type OwnWindow } from './ownWindows';

const SOAK = process.env.DESKTOP_CAT_E2E_SOAK === '1';
const SOAK_MIN = Math.max(1, Number(process.env.DESKTOP_CAT_SOAK_MIN ?? '30') || 30);
const SCALE = Math.min(10, Math.max(1, Number(process.env.DESKTOP_CAT_SOAK_SCALE ?? '3') || 3));
const SEED = Number(process.env.DESKTOP_CAT_SOAK_SEED ?? '1') || 1;
const PERTURB_ENV = (process.env.DESKTOP_CAT_SOAK_PERTURB ?? '').trim();
const PERTURB = PERTURB_ENV !== '0';
const OS_MOUSE = process.env.DESKTOP_CAT_SOAK_OS_MOUSE === '1';

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
const PHYSICAL = new Set(['held', 'jumping', 'falling', 'landing']);
/** The sim lets go of a cat whose drag the host stopped reporting (DRAG_LOST_MS), plus the longest flight and a landing. */
const LET_GO_MS = 1500 + 6000 + 1500;
/** After a gesture: main holds no press or drag within this. */
const PRESS_CLEAR_MS = 3000;
/** Wall time per gesture kind's settle wait for a fall to be counted. */
const FALL_WAIT_MS = 9000;

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const GESTURES = ['tap', 'doubleTap', 'stroke', 'drag', 'throw', 'slowDrag', 'slowThrow', 'rightClick'] as const;
type Gesture = (typeof GESTURES)[number];
const ONLY: readonly Gesture[] = (process.env.DESKTOP_CAT_SOAK_ONLY ?? '')
  .split(',')
  .map((x) => x.trim())
  .filter((x): x is Gesture => (GESTURES as readonly string[]).includes(x));
const LOOP_GESTURES: readonly Gesture[] = ONLY.length > 0 ? ONLY : GESTURES;
const PERTURBATIONS = ['maxWindow', 'hideShow', 'pauseResume', 'freeze', 'cpuHog', 'suspendResume', 'lockUnlock', 'nap'] as const;
type Perturbation = (typeof PERTURBATIONS)[number];
const PERTURB_ONLY: readonly Perturbation[] = PERTURB_ENV.split(',')
  .map((x) => x.trim())
  .filter((x): x is Perturbation => (PERTURBATIONS as readonly string[]).includes(x));
const LOOP_PERTURBATIONS: readonly Perturbation[] = PERTURB_ONLY.length > 0 ? PERTURB_ONLY : PERTURBATIONS;

interface GestureResult {
  attempts: number;
  ok: number;
  /** Refused by design: the cat hidden, or in a state where the press means nothing (held, airborne, landing). */
  designed: number;
  /**
   * Not a valid gesture as the page received it (a "double tap" 500 ms apart, a flick under the throw
   * speed, a cat that walked off the strokes): the harness's input, not the app, so not judged. Counted
   * apart from the designed states, with samples, so the report shows how much was not judged.
   */
  harness: number;
  harnessSamples: Array<Record<string, unknown>>;
  failed: Array<Record<string, unknown>>;
}

interface Snapshot {
  out: SimOutput | null;
  profile: BehaviorProfileSnapshot;
  counters: Counters;
  stats: InteractionStatsReport | null;
}

function record(info: TestInfo, what: string, data: unknown): void {
  const text = JSON.stringify(data);
  info.annotations.push({ type: what, description: text.length > 4000 ? `${text.slice(0, 4000)}...` : text });
  console.log(`[measure] ${what}: ${text.length > 2000 ? `${text.slice(0, 2000)}...` : text}`);
}

function annotate(info: TestInfo, type: 'REAL' | 'UNVERIFIED' | 'SIMULATED', description: string): void {
  info.annotations.push({ type, description });
  console.log(`[label] ${type}: ${description}`);
}

function falls(p: BehaviorProfileSnapshot, cause: 'thrown' | 'dropped'): number {
  return (p.falls.byCause as Record<string, number>)[cause] ?? 0;
}

/** Rejects after `ms` (a native menu that blocked main would otherwise hang the evaluate). */
function withTimeout<T>(p: Promise<T>, ms: number, what: string): Promise<T> {
  return Promise.race([p, new Promise<T>((_, reject) => setTimeout(() => reject(new Error(`${what}: no answer within ${ms} ms`)), ms))]);
}

const center = (r: Rect): Point => ({ x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) });
const inside = (r: Rect, p: Point): boolean => p.x >= r.x && p.x < r.x + r.width && p.y >= r.y && p.y < r.y + r.height;
const percentile = (v: readonly number[], q: number): number => {
  const s = [...v].sort((a, b) => a - b);
  return s.length === 0 ? 0 : (s[Math.min(s.length - 1, Math.floor(q * s.length))] as number);
};

/**
 * A passive listener in the overlay page's main world: pointer moves without the primary button while
 * it is down (what the recogniser reads as a lost release). Test instrumentation only; returns at once
 * when already installed.
 */
const STRAY_PROBE = `(() => {
  if (window.__soakStray) return true;
  const s = { down: false, events: [] };
  window.__soakStray = s;
  document.addEventListener('pointerdown', (e) => { if (e.button === 0) s.down = true; }, true);
  document.addEventListener('pointerup', (e) => { if (e.button === 0) s.down = false; }, true);
  document.addEventListener('pointermove', (e) => {
    if (s.down && (e.buttons & 1) === 0 && s.events.length < 20) s.events.push({ t: Math.round(performance.now()), x: Math.round(e.clientX), y: Math.round(e.clientY), screenX: e.screenX, screenY: e.screenY, trusted: e.isTrusted });
  }, true);
  return true;
})()`;
const STRAY_TAKE = `(() => { const s = window.__soakStray; return s ? s.events.splice(0) : []; })()`;

/**
 * What the page actually received for the primary button (down, held moves with their coalesced
 * samples, up), with each event's own timestamp. CDP input arrives with the harness's own timing: on a
 * loaded machine a "double tap" can reach the page 500 ms apart, or a flick at a walking pace. The
 * oracle judges the app against the input it was given, not against what the harness meant to send.
 */
const DELIVERED_PROBE = `(() => {
  if (window.__soakIn) return true;
  const s = { events: [] };
  window.__soakIn = s;
  const push = (k, e) => { if (s.events.length < 600) s.events.push({ k, t: e.timeStamp, x: e.clientX, y: e.clientY }); };
  document.addEventListener('pointerdown', (e) => { if (e.button === 0) push('down', e); }, true);
  document.addEventListener('pointerup', (e) => { if (e.button === 0) push('up', e); }, true);
  document.addEventListener('pointermove', (e) => {
    if ((e.buttons & 1) === 0) return;
    let list = [];
    try { list = typeof e.getCoalescedEvents === 'function' ? e.getCoalescedEvents() : []; } catch { list = []; }
    if (list.length > 0) for (const c of list) push('move', c); else push('move', e);
  }, true);
  return true;
})()`;
const DELIVERED_TAKE = `(() => { const s = window.__soakIn; return s ? s.events.splice(0) : []; })()`;

/** Gesture thresholds the oracle applies to the delivered input (src/core/interaction/gestures.ts defaults, THROW_SPEED_DIP). */
const DOUBLE_TAP_MS = 350;
const TAP_MAX_MS = 600;
const VELOCITY_WINDOW_MS = 100;
const THROW_SPEED_DIP = 1100;

interface InSample {
  k: 'down' | 'move' | 'up';
  t: number;
  x: number;
  y: number;
}

/** The delivered presses: each down with the samples up to and including its up (if it came). */
function deliveredPresses(ev: readonly InSample[]): InSample[][] {
  const out: InSample[][] = [];
  let cur: InSample[] | null = null;
  for (const e of ev) {
    if (e.k === 'down') {
      cur = [e];
      out.push(cur);
    } else if (cur) {
      cur.push(e);
      if (e.k === 'up') cur = null;
    }
  }
  return out;
}

/**
 * The release speed (DIP/s; overlay pages are in DIP) of a delivered press, by the app's own rule
 * (gestures.ts releaseVelocity): the samples in the last 100 ms before the up, first to up.
 */
function deliveredReleaseSpeed(press: readonly InSample[]): { speed: number; windowSamples: number; flickSpanMs: number } | null {
  const up = press[press.length - 1];
  if (!up || up.k !== 'up') return null;
  const win = press.slice(1).filter((s) => up.t - s.t <= VELOCITY_WINDOW_MS);
  const first = win[0];
  const dt = first ? up.t - first.t : 0;
  const speed = first && win.length >= 2 && dt >= 8 ? (Math.hypot(up.x - first.x, up.y - first.y) / dt) * 1000 : 0;
  return { speed: Math.round(speed), windowSamples: win.length, flickSpanMs: Math.round(dt) };
}

/** The cat's overlay (the one whose display the cat is on) and its page. */
async function catOverlay(app: ElectronApplication, out: SimOutput): Promise<{ ov: OverlayInfo; page: Page; scale: number } | null> {
  const overlays = await hook(app, 'getOverlays');
  const ov = overlays.find((o) => o.displayId === out.displayId) ?? overlays.find((o) => inside(o.boundsPx, { x: out.x, y: out.y }));
  if (!ov) return null;
  const page = app.windows().find((w) => {
    if (!w.url().includes('/renderer/overlay/')) return false;
    try {
      return new URL(w.url()).searchParams.get('display') === ov.displayId;
    } catch {
      return false;
    }
  });
  if (!page) return null;
  return { ov, page, scale: ov.bounds.width > 0 ? ov.boundsPx.width / ov.bounds.width : 1 };
}

test.describe('interaction soak: the real app under random gestures and perturbations (app REAL, input SIMULATED)', () => {
  test.skip(!SOAK, 'opt-in: DESKTOP_CAT_E2E_SOAK=1 (puts the cat and an own maximized window on the desk for DESKTOP_CAT_SOAK_MIN minutes)');

  test('soak: every gesture lands, nothing sticks, the overlay never blocks the desk', async ({ userData }, info) => {
    test.setTimeout((SOAK_MIN + 6) * 60_000);
    enablePerMonitorDpiAwareness();
    const rnd = mulberry32(SEED);
    const between = (a: number, b: number): number => a + rnd() * (b - a);
    const pick = <T,>(xs: readonly T[]): T => xs[Math.floor(rnd() * xs.length)] as T;

    let own: OwnWindow = openOwnWindow({ layout: 'hidden' });
    // Harness incidents (not app failures): the own-window helper ending or not answering. The soak
    // reopens it and goes on; they are counted in the report (a 120-min run lost its whole result to one).
    const harnessIncidents: string[] = [];
    let app: ElectronApplication | null = null;
    // Mutable from the helpers below (a holder, so the finally block sees what they set).
    const live: { stopTopmost: (() => void) | null; cdpFreeze: CDPSession | null } = { stopTopmost: null, cdpFreeze: null };
    const hogs: ChildProcess[] = [];
    try {
      let win = await own.next();
      app = await launchApp(userData);
      const a = app;
      await waitForCat(a);
      const startup = await hook(a, 'getStartup');
      // The launch must be ours: our temp userData (so the single-instance lock is ours too).
      expect(path.resolve(startup.userData)).toBe(path.resolve(userData));
      const patched = await hook(a, 'patchSettings', { general: { firstRunCompleted: true }, interaction: { enabled: true, petting: true, dragging: true, throwing: true } });
      expect(patched.ok).toBe(true);
      await hook(a, 'restrictSurfacesToPids', [win.pid]);
      await hook(a, 'injectUserIdle', 30_000);
      record(info, 'pids', { app: a.process().pid, ownWindow: win.pid, userData: startup.userData });

      // ---- capability checks: hooks this build may lack are reported, never faked -------------
      let statsAvailable = true;
      let overlayStatsAvailable = true;
      let loopDelayAvailable = true;
      let systemAvailable = true;
      /**
       * The interaction counters. `full`: when app.ts does not wire the overlay manager into the test
       * hooks, its counters are read from the diagnostics export instead (heavier: not in polling loops).
       */
      const stats = async (full = false): Promise<InteractionStatsReport | null> => {
        if (!statsAvailable) return null;
        let s: InteractionStatsReport;
        try {
          s = await hook(a, 'interactionStats');
        } catch {
          statsAvailable = false;
          annotate(info, 'UNVERIFIED', 'interactionStats test hook missing in this build: press-path counters not measured');
          return null;
        }
        if (s.overlay !== null || !full) return s;
        const exported = (await hook(a, 'getDiagnosticsReport'))['interaction'] as { overlays?: OverlayInteractionStats } | null | undefined;
        return exported?.overlays ? { ...s, overlay: exported.overlays } : s;
      };
      const raw0 = await stats();
      if (raw0 && raw0.overlay === null) {
        overlayStatsAvailable = false;
        annotate(info, 'UNVERIFIED', 'app.ts does not pass interactionOverlays to the test hooks: pressed/dragging not measured; overlay counters read from the diagnostics export');
      }
      const s0 = await stats(true);
      try {
        await hook(a, 'eventLoopDelay', true);
      } catch {
        loopDelayAvailable = false;
        annotate(info, 'UNVERIFIED', 'eventLoopDelay test hook missing in this build: main event-loop delay not measured');
      }
      try {
        // Checks the hook is wired. It runs the app's real onResume (the host re-reads the lock state, the
        // overlays reset their input state); at start-up, with no press under way, that changes nothing.
        await hook(a, 'systemEvent', 'resume');
      } catch (err) {
        systemAvailable = false;
        annotate(info, 'UNVERIFIED', `systemEvent test hook not usable (${String(err).slice(0, 160)}): suspend/resume and lock/unlock perturbations skipped`);
      }
      // The context menu is a real native menu: remember each one the app pops up, so the test can close it.
      await a.evaluate(({ Menu }) => {
        const g = globalThis as Record<string, unknown>;
        if (g.__soakMenuPatched) return;
        g.__soakMenuPatched = true;
        g.__soakMenus = 0;
        const proto = Menu.prototype as unknown as { popup: (o?: unknown) => void };
        const orig = proto.popup;
        proto.popup = function (this: unknown, o?: unknown) {
          g.__soakLastMenu = this;
          g.__soakMenus = (g.__soakMenus as number) + 1;
          return orig.call(this, o);
        };
      });
      const menusOpened = (): Promise<number> => withTimeout(a.evaluate(() => (globalThis as Record<string, unknown>).__soakMenus as number), 5000, 'menu count');
      const closeMenu = (): Promise<void> =>
        withTimeout(
          a.evaluate(() => {
            const m = (globalThis as Record<string, unknown>).__soakLastMenu as { closePopup?: () => void } | undefined;
            m?.closePopup?.();
          }),
          5000,
          'close menu',
        );

      // ---- observation -----------------------------------------------------------------------
      const counters = async (): Promise<Counters> => {
        await hook(a, 'saveNow');
        const raw = JSON.parse(fs.readFileSync(path.join(userData, 'cat-state.json'), 'utf8')) as { memory: { counters: Counters } };
        return raw.memory.counters;
      };
      /** Why the cat is where it is: the sim's mode and last transitions, the host's hidden/paused/locked flags. */
      const context = async (): Promise<Record<string, unknown>> => {
        const r = await hook(a, 'getDiagnosticsReport');
        const cat = (r['cat'] ?? {}) as { mode?: unknown; state?: unknown; lastTransitions?: unknown[] };
        const host = await hook(a, 'getHostDebug');
        return { mode: cat.mode, state: cat.state, transitions: (cat.lastTransitions ?? []).slice(-8), host: { hidden: host.hidden, paused: host.paused, locked: host.locked, simNow: Math.round(host.simNow) } };
      };
      const snapshot = async (): Promise<Snapshot> => ({ out: await hook(a, 'getSimOutput'), profile: await hook(a, 'getBehaviorProfile'), counters: await counters(), stats: await stats(true) });
      const heaps = async (): Promise<{ mainHeapMb: number; mainRssMb: number; rendererHeapMb: number[] }> => {
        const mem = await a.evaluate(() => process.memoryUsage());
        const rendererHeapMb: number[] = [];
        for (const p of a.windows().filter((w) => w.url().includes('/renderer/overlay/'))) {
          try {
            const cdp = await a.context().newCDPSession(p);
            const h = (await cdp.send('Runtime.getHeapUsage')) as { usedSize: number };
            rendererHeapMb.push(Math.round((h.usedSize / 1048576) * 10) / 10);
            await cdp.detach();
          } catch {
            rendererHeapMb.push(-1);
          }
        }
        return { mainHeapMb: Math.round((mem.heapUsed / 1048576) * 10) / 10, mainRssMb: Math.round((mem.rss / 1048576) * 10) / 10, rendererHeapMb };
      };

      const soakStart = Date.now();
      const heapStart = await heaps();
      const profile0 = await hook(a, 'getBehaviorProfile');
      const stats0 = s0;
      const results = Object.fromEntries(GESTURES.map((g): [Gesture, GestureResult] => [g, { attempts: 0, ok: 0, designed: 0, harness: 0, harnessSamples: [], failed: [] }])) as Record<Gesture, GestureResult>;
      const latencyMs: number[] = [];
      const loopSamples: Array<{ p50Ms: number; p99Ms: number; maxMs: number }> = [];
      const stuck: Array<Record<string, unknown>> = [];
      /** Buttonless pointer moves the page saw while the primary button was down (by gesture). */
      const strayMoves: Array<Record<string, unknown>> = [];
      const clickThrough = { probes: 0, onCatInteractive: 0, onCatDeniedByDesign: 0, onCatDenied: [] as Array<Record<string, unknown>>, offCatBlocking: [] as Array<Record<string, unknown>> };
      const perturbations: Record<string, number> = {};
      const freezes: Array<Record<string, unknown>> = [];
      let hidden = false;
      let maximized = false;

      // ---- helpers ---------------------------------------------------------------------------
      const scaled = async (on: boolean): Promise<void> => {
        await hook(a, 'setTimeScale', on ? SCALE : 1);
      };
      /** Waits until main holds no press or drag and the sim is not held; a miss is a stuck state. */
      const settle = async (what: string): Promise<void> => {
        const t0 = Date.now();
        let s: InteractionStatsReport | null;
        let out: SimOutput | null;
        for (;;) {
          s = await stats();
          out = await hook(a, 'getSimOutput');
          const pressFree = !overlayStatsAvailable || (s?.pressed === false && s.dragging === false);
          const simFree = out?.state !== 'held';
          if (pressFree && simFree) return;
          if (Date.now() - t0 > (simFree ? PRESS_CLEAR_MS : LET_GO_MS)) break;
          await sleep(50);
        }
        stuck.push({ what, pressed: s?.pressed ?? null, dragging: s?.dragging ?? null, state: out?.state ?? null, afterMs: Date.now() - t0 });
      };
      /** One gesture's pre-state verdict: designed guard (hidden, physical) or a press that must land. */
      const designedGuard = (out: SimOutput | null, g: Gesture): string | null => {
        if (!out || !out.visible || hidden) return 'hidden';
        if ((g === 'tap' || g === 'doubleTap' || g === 'stroke') && PHYSICAL.has(out.state)) return `physical:${out.state}`;
        return null;
      };
      let bounds: Rect = { x: 0, y: 0, width: 1, height: 1 };
      const clampIn = (p: Point): Point => ({ x: Math.min(bounds.x + bounds.width - 12, Math.max(bounds.x + 12, p.x)), y: Math.min(bounds.y + bounds.height - 12, Math.max(bounds.y + 12, p.y)) });
      /** Set by pathMove's held trace: when (ms after it started) and in what state the sim first stopped holding the cat. */
      let leftHeld: { afterMs: number; state: string | null; context: Record<string, unknown> } | null = null;
      const pathMove = async (page: Page, toLocal: (p: Point) => Point, from: Point, to: Point, steps: number, gapMs: number, traceHeld = false): Promise<Point> => {
        let p = from;
        const end = clampIn(to);
        const t0 = Date.now();
        for (let i = 1; i <= steps; i++) {
          p = { x: Math.round(from.x + ((end.x - from.x) * i) / steps), y: Math.round(from.y + ((end.y - from.y) * i) / steps) };
          const l = toLocal(p);
          await Promise.all([hook(a, 'injectCursor', p), page.mouse.move(l.x, l.y)]);
          if (traceHeld && leftHeld === null) {
            const o = await hook(a, 'getSimOutput');
            if (o?.state !== 'held') leftHeld = { afterMs: Date.now() - t0, state: o?.state ?? null, context: await context() };
          }
          if (gapMs > 0) await sleep(gapMs);
        }
        return p;
      };
      /**
       * A flick: five CDP moves about 10 ms apart (a hand's 40-60 ms flick, over several frames), with
       * no test-hook round trip in between: on a loaded machine a hook call can take 100+ ms, which
       * stretched flicks and turned throws into drops. The injected cursor follows after the release.
       */
      const flick = async (page: Page, toLocal: (p: Point) => Point, from: Point, to: Point): Promise<Point> => {
        const end = clampIn(to);
        let p = from;
        for (let i = 1; i <= 5; i++) {
          p = { x: Math.round(from.x + ((end.x - from.x) * i) / 5), y: Math.round(from.y + ((end.y - from.y) * i) / 5) };
          const l = toLocal(p);
          await page.mouse.move(l.x, l.y);
          if (i < 5) await sleep(10);
        }
        return p;
      };
      /** Polls until the sim is held (ms since `t0`), or null after 1.5 s. */
      const heldWithin = async (t0: number): Promise<number | null> => {
        for (;;) {
          const out = await hook(a, 'getSimOutput');
          if (out?.state === 'held') return Date.now() - t0;
          if (Date.now() - t0 > 1500) return null;
          await sleep(15);
        }
      };
      const awaitFall = async (before: BehaviorProfileSnapshot): Promise<{ thrown: number; dropped: number }> => {
        const t0 = Date.now();
        for (;;) {
          const p = await hook(a, 'getBehaviorProfile');
          const d = { thrown: falls(p, 'thrown') - falls(before, 'thrown'), dropped: falls(p, 'dropped') - falls(before, 'dropped') };
          if (d.thrown + d.dropped > 0 || Date.now() - t0 > FALL_WAIT_MS) return d;
          await sleep(100);
        }
      };

      const runGesture = async (g: Gesture): Promise<void> => {
        const res = results[g];
        res.attempts++;
        await scaled(false);
        await sleep(150);
        const pre = await snapshot();
        let why = designedGuard(pre.out, g);
        const located = pre.out ? await catOverlay(a, pre.out) : null;
        if (!pre.out || !located) {
          res.designed++;
          return;
        }
        const { ov, page, scale } = located;
        bounds = ov.boundsPx;
        const toLocal = (p: Point): Point => ({ x: (p.x - ov.boundsPx.x) / scale, y: (p.y - ov.boundsPx.y) / scale });
        const c = center(pre.out.boundsPx);
        const side = c.x < ov.boundsPx.x + ov.boundsPx.width / 2 ? 1 : -1;
        const detail: Record<string, unknown> = { g, state: pre.out.state, support: pre.out.support.kind === 'surface' ? pre.out.support.surfaceKind : pre.out.support.kind, at: c };
        let ok = false;
        await page.evaluate(STRAY_PROBE).catch(() => undefined);
        await page.evaluate(STRAY_TAKE).catch(() => undefined);
        await page.evaluate(DELIVERED_PROBE).catch(() => undefined);
        await page.evaluate(DELIVERED_TAKE).catch(() => undefined);
        const takeDelivered = async (): Promise<InSample[]> => ((await page.evaluate(DELIVERED_TAKE).catch(() => [])) as InSample[]);
        const mainPresses = async (): Promise<number | null> => {
          const s1 = await stats(true);
          return s1?.overlay && pre.stats?.overlay ? s1.overlay.presses - pre.stats.overlay.presses : null;
        };
        try {
          if (!OS_MOUSE) await hook(a, 'forceInteractive', false);
          await hook(a, 'injectCursor', c);
          await page.mouse.move(toLocal(c).x, toLocal(c).y);
          switch (g) {
            case 'tap':
            case 'doubleTap': {
              await page.mouse.down();
              await sleep(between(50, 140));
              await page.mouse.up();
              if (g === 'doubleTap') {
                await sleep(between(80, 160));
                await page.mouse.down();
                await sleep(between(40, 90));
                await page.mouse.up();
              }
              const post = await hook(a, 'getSimOutput');
              // The cat may take off between the look and the press: a press on a physical state is refused by design.
              if (why === null && post && PHYSICAL.has(post.state)) why = `physical:${post.state}`;
              await sleep(300);
              const after = await counters();
              detail.clicks = after.clicks - pre.counters.clicks;
              detail.doubleClicks = after.doubleClicks - pre.counters.doubleClicks;
              detail.mainPresses = await mainPresses();
              ok = g === 'tap' ? after.clicks > pre.counters.clicks : after.doubleClicks > pre.counters.doubleClicks;
              // Judge against the input the page received (its own event times), not the harness's intent.
              const ps = deliveredPresses(await takeDelivered());
              const ups = ps.map((q) => q[q.length - 1]!).filter((s) => s.k === 'up');
              detail.delivered = ps.map((q) => ({ pressMs: Math.round(q[q.length - 1]!.t - q[0]!.t), released: q[q.length - 1]!.k === 'up' }));
              const need = g === 'tap' ? 1 : 2;
              if (why === null && !ok) {
                if (ps.length < need || ups.length < ps.length) why = `harness: ${ps.length} press(es) and ${ups.length} release(s) reached the page`;
                else if (ps.some((q) => q[q.length - 1]!.t - q[0]!.t > TAP_MAX_MS)) why = `harness: a press reached the page lasting over ${TAP_MAX_MS} ms`;
                else if (g === 'doubleTap' && ups[1]!.t - ups[0]!.t > DOUBLE_TAP_MS) why = `harness: the releases reached the page ${Math.round(ups[1]!.t - ups[0]!.t)} ms apart (a double tap is within ${DOUBLE_TAP_MS} ms)`;
              }
              break;
            }
            case 'stroke': {
              // Hover strokes over the cat (no button): 6 px every ~25 ms, reversing every ~48 px.
              let x = c.x - 24;
              let dir = 1;
              const until = Date.now() + between(1300, 2400);
              while (Date.now() < until) {
                x += dir * 6 * scale;
                if (Math.abs(x - c.x) >= 24 * scale) dir = -dir;
                const p = { x: Math.round(x), y: c.y };
                await Promise.all([hook(a, 'injectCursor', p), page.mouse.move(toLocal(p).x, toLocal(p).y)]);
                await sleep(25);
              }
              const post = await hook(a, 'getSimOutput');
              if (why === null && post && PHYSICAL.has(post.state)) why = `physical:${post.state}`;
              await sleep(300);
              const after = await counters();
              detail.pets = after.pets - pre.counters.pets;
              ok = after.pets > pre.counters.pets;
              // The strokes stay where the cat was at the start: a cat that walked off them was not stroked.
              if (why === null && !ok && post) {
                const b = post.boundsPx;
                const onPath = c.y >= b.y && c.y <= b.y + b.height && c.x + 24 * scale >= b.x && c.x - 24 * scale <= b.x + b.width;
                detail.catAfter = b;
                if (!onPath) why = 'harness: the cat moved off the stroke path';
              }
              break;
            }
            case 'drag':
            case 'slowDrag':
            case 'slowThrow':
            case 'throw': {
              const t0 = Date.now();
              let before: BehaviorProfileSnapshot | null = null;
              await page.mouse.down();
              let p = await pathMove(page, toLocal, c, { x: c.x, y: c.y - 14 * scale }, 2, 16);
              const latency = await heldWithin(t0);
              detail.heldMs = latency;
              if (latency !== null) latencyMs.push(latency);
              const lostBefore = pre.stats?.overlay ? Object.values(pre.stats.overlay.lostPresses).reduce((x, y) => x + y, 0) : null;
              if (g === 'slowDrag') {
                // Longer than the old 400 ms lost-press window, moving all the time (a real held drag reports every move).
                const ms = between(900, 2600);
                const steps = Math.max(8, Math.round(ms / 70));
                leftHeld = null;
                p = await pathMove(page, toLocal, p, { x: p.x + side * 120 * scale, y: p.y - 60 * scale }, steps, 70, true);
                const mid = await hook(a, 'getSimOutput');
                detail.heldBeforeUp = mid?.state === 'held';
                detail.slowMs = Math.round(ms);
                if (leftHeld) detail.leftHeld = leftHeld;
              } else if (g === 'slowThrow') {
                // Held more than a second while moving (past both the 400 ms and the 1.5 s lost-press
                // bounds of Win32 "up" alone; CDP never reaches GetAsyncKeyState), then the flick: a throw.
                const ms = between(1100, 2200);
                const steps = Math.max(10, Math.round(ms / 70));
                leftHeld = null;
                p = await pathMove(page, toLocal, p, { x: p.x - side * 60 * scale, y: p.y - 40 * scale }, steps, 70, true);
                const mid = await hook(a, 'getSimOutput');
                detail.heldBeforeUp = mid?.state === 'held';
                detail.slowMs = Math.round(ms);
                if (leftHeld) detail.leftHeld = leftHeld;
                const step = between(90, 150) * scale;
                before = await hook(a, 'getBehaviorProfile');
                p = await flick(page, toLocal, p, { x: p.x + side * step * 5, y: p.y - step * 3.5 });
              } else if (g === 'throw') {
                // A wind-up of ~0.3-0.7 s, then the flick: the release speed comes from the last ~100 ms.
                p = await pathMove(page, toLocal, p, { x: p.x - side * 30 * scale, y: p.y + 10 * scale }, Math.round(between(5, 10)), 60);
                const step = between(90, 150) * scale;
                before = await hook(a, 'getBehaviorProfile');
                p = await flick(page, toLocal, p, { x: p.x + side * step * 5, y: p.y - step * 3.5 });
              } else {
                p = await pathMove(page, toLocal, p, { x: p.x + side * 30 * scale, y: p.y - 90 * scale }, 6, 40);
                await pathMove(page, toLocal, p, { x: p.x + side * 2, y: p.y - 2 }, 3, 40);
              }
              // Taken before the flick for throws: a hook round trip between the flick and the release is a
              // pause of the hand, and a hand that stops before letting go drops the cat (by design).
              before ??= await hook(a, 'getBehaviorProfile');
              await page.mouse.up();
              await hook(a, 'injectCursor', p);
              const d = await awaitFall(before);
              const mid = await stats(true);
              const lostAfter = mid?.overlay ? Object.values(mid.overlay.lostPresses).reduce((x, y) => x + y, 0) : null;
              detail.falls = d;
              detail.lostPressesDuringHold = lostBefore !== null && lostAfter !== null ? lostAfter - lostBefore : null;
              const landed = d.thrown + d.dropped >= 1;
              const presses = deliveredPresses(await takeDelivered());
              const last = presses[presses.length - 1];
              // The longest stretch the page received nothing during the press (CDP input waits on a
              // starved renderer; main's "cursor moved, no pointer event" rule then sees silence).
              detail.maxDeliveredGapMs = last && last.length > 1 ? Math.round(Math.max(...last.slice(1).map((s, i) => s.t - last[i]!.t))) : null;
              detail.mainPresses = await mainPresses();
              if (g === 'throw' || g === 'slowThrow') {
                // The release speed the page received, by the app's own rule: a flick that reached it under
                // the throw speed is a drop by design, whatever the harness meant to send.
                const rel = last ? deliveredReleaseSpeed(last) : null;
                detail.delivered = rel;
                if (why === null && d.thrown === 0 && rel && rel.speed < THROW_SPEED_DIP) why = `harness: the flick reached the page at ${rel.speed} DIP/s (a throw is over ${THROW_SPEED_DIP})`;
              }
              if (g === 'throw') ok = latency !== null && d.thrown >= 1;
              else if (g === 'slowThrow') ok = latency !== null && d.thrown >= 1 && detail.heldBeforeUp === true && (detail.lostPressesDuringHold ?? 0) === 0;
              else if (g === 'slowDrag') ok = latency !== null && landed && detail.heldBeforeUp === true && (detail.lostPressesDuringHold ?? 0) === 0;
              else ok = latency !== null && landed;
              break;
            }
            case 'rightClick': {
              const m0 = await menusOpened();
              const duringDrag = rnd() < 0.5;
              if (duringDrag) {
                // A context menu during a drag ends the drag (diagnosis H3): the cat is dropped, the next click is a tap.
                await page.mouse.down();
                const p = await pathMove(page, toLocal, c, { x: c.x, y: c.y - 40 * scale }, 4, 30);
                detail.heldBeforeMenu = (await heldWithin(Date.now())) !== null;
                await page.mouse.move(toLocal(p).x, toLocal(p).y);
              }
              const l = toLocal(duringDrag ? clampIn({ x: c.x, y: c.y - 40 * scale }) : c);
              await page.mouse.click(l.x, l.y, { button: 'right' });
              await sleep(between(300, 800));
              const opened = (await menusOpened()) > m0;
              await closeMenu();
              if (duringDrag) await page.mouse.up();
              await sleep(400);
              const s = await stats(true);
              const out = await hook(a, 'getSimOutput');
              detail.menuOpened = opened;
              detail.duringDrag = duringDrag;
              detail.contextCancels = s?.overlay && pre.stats?.overlay ? s.overlay.contextCancels - pre.stats.overlay.contextCancels : null;
              detail.stateAfter = out?.state ?? null;
              // Then a plain click must be a tap again.
              const c2 = out ? center(out.boundsPx) : c;
              const before = await counters();
              await hook(a, 'injectCursor', c2);
              await page.mouse.move(toLocal(c2).x, toLocal(c2).y);
              await page.mouse.down();
              await sleep(80);
              await page.mouse.up();
              await sleep(300);
              const after = await counters();
              const physical = out ? PHYSICAL.has(out.state) : false;
              detail.tapAfter = after.clicks - before.clicks;
              ok = opened && out?.state !== 'held' && (physical || after.clicks > before.clicks);
              break;
            }
          }
        } finally {
          await hook(a, 'injectCursor', null);
          if (!OS_MOUSE) await hook(a, 'forceInteractive', null);
        }
        const strays = (await page.evaluate(STRAY_TAKE).catch(() => [])) as unknown[];
        if (strays.length > 0) {
          strayMoves.push(...strays.map((x) => ({ g, ...(x as Record<string, unknown>) })));
          detail.strayButtonlessMoves = strays;
        }
        await settle(g);
        if (why !== null && !ok) {
          if (why.startsWith('harness:')) {
            res.harness++;
            if (res.harnessSamples.length < 10) res.harnessSamples.push({ ...detail, why, tS: Math.round((Date.now() - soakStart) / 1000) });
          } else res.designed++;
          return;
        }
        if (ok) res.ok++;
        else {
          detail.tS = Math.round((Date.now() - soakStart) / 1000);
          detail.guard = (await hook(a, 'getHostDebug')).clickGuard;
          detail.after = await context();
          res.failed.push(detail);
        }
      };

      /** Click-through with the injected cursor on the cat (interactive unless a designed guard) and off it (never interactive). */
      const probeClickThrough = async (): Promise<void> => {
        const out = await hook(a, 'getSimOutput');
        if (!out || !out.visible || hidden) return;
        clickThrough.probes++;
        await scaled(false);
        // A few points on the body (the bounds' centre can miss the hit region in some poses), re-aimed as the cat moves.
        const bodyPoints = (r: Rect): Point[] => {
          const c = center(r);
          return [c, { x: c.x, y: Math.round(c.y + r.height * 0.2) }, { x: Math.round(c.x - r.width * 0.2), y: c.y }, { x: Math.round(c.x + r.width * 0.2), y: c.y }];
        };
        let last: SimOutput | null = out;
        let interactive = false;
        for (let i = 0; i < 4 && !interactive && last; i++) {
          await hook(a, 'injectCursor', bodyPoints(last.boundsPx)[i]!);
          await sleep(300);
          const ovs = await hook(a, 'getOverlays');
          interactive = ovs.some((o) => !o.ignoreMouse);
          last = await hook(a, 'getSimOutput');
        }
        const dbg = await hook(a, 'getHostDebug');
        // Designed click-through over the cat: the T8 guard active or failing closed, a physical state, clinging to a wall.
        const guarded = dbg.clickGuard.state === 'active' || dbg.clickGuard.state === 'failClosed' || !last || PHYSICAL.has(last.state) || (last.support.kind === 'surface' && last.support.orientation === 'wall');
        if (interactive) clickThrough.onCatInteractive++;
        else if (guarded) clickThrough.onCatDeniedByDesign++;
        else clickThrough.onCatDenied.push({ state: last?.state, support: last?.support.kind, guard: dbg.clickGuard, overlays: (await hook(a, 'getOverlays')).map((o) => ({ healthy: o.healthy, ready: o.ready })) });
        // Off the cat: a point on the cat's display at least 300 px from it.
        const located = last ? await catOverlay(a, last) : null;
        if (located && last) {
          const b = located.ov.boundsPx;
          const far = { x: last.x < b.x + b.width / 2 ? b.x + b.width - 60 : b.x + 60, y: b.y + 60 };
          await hook(a, 'injectCursor', far);
          await sleep(300);
          const now = await hook(a, 'getSimOutput');
          const ovs = await hook(a, 'getOverlays');
          const catNear = now ? Math.hypot(now.x - far.x, now.y - far.y) < 300 : false;
          if (!catNear && ovs.some((o) => !o.ignoreMouse)) clickThrough.offCatBlocking.push({ far, cat: now ? { x: now.x, y: now.y, state: now.state } : null });
        }
        await hook(a, 'injectCursor', null);
      };

      const freeze = async (): Promise<void> => {
        const out = await hook(a, 'getSimOutput');
        const located = out ? await catOverlay(a, out) : null;
        if (!located || !out) return;
        const stBefore = await stats(true);
        await hook(a, 'injectCursor', center(out.boundsPx));
        let how = 'cdp-debugger-pause';
        try {
          live.cdpFreeze = await a.context().newCDPSession(located.page);
          await live.cdpFreeze.send('Debugger.enable');
          await live.cdpFreeze.send('Debugger.pause');
        } catch {
          how = 'busy-loop';
          live.cdpFreeze = null;
          void located.page.evaluate('(() => { const t = performance.now(); while (performance.now() - t < 4000) {} })()').catch(() => undefined);
        }
        await sleep(2500);
        const during = await hook(a, 'getOverlays');
        const frozenInteractive = during.find((o) => o.displayId === located.ov.displayId)?.ignoreMouse === false;
        await sleep(1500);
        if (live.cdpFreeze) {
          await live.cdpFreeze.send('Debugger.resume').catch(() => undefined);
          await live.cdpFreeze.send('Debugger.disable').catch(() => undefined);
          await live.cdpFreeze.detach().catch(() => undefined);
          live.cdpFreeze = null;
        }
        // Back within a few seconds: healthy, and interactive over the cat again.
        const t0 = Date.now();
        let back = false;
        while (Date.now() - t0 < 8000 && !back) {
          const o = await hook(a, 'getSimOutput');
          if (o) await hook(a, 'injectCursor', center(o.boundsPx));
          await sleep(250);
          const ovs = await hook(a, 'getOverlays');
          back = ovs.length > 0 && ovs.every((x) => x.healthy && x.ready) && ovs.some((x) => !x.ignoreMouse);
        }
        await hook(a, 'injectCursor', null);
        const stAfter = await stats(true);
        freezes.push({ how, frozenInteractive, recoveredMs: back ? Date.now() - t0 : null, recreates: stBefore?.overlay && stAfter?.overlay ? stAfter.overlay.recreates - stBefore.overlay.recreates : null });
      };

      const cpuHog = async (): Promise<void> => {
        const n = Math.max(1, Math.min(4, Math.floor(os.cpus().length / 2)));
        for (let i = 0; i < n; i++) hogs.push(spawn(process.execPath, ['-e', 'const e = Date.now() + 6000; while (Date.now() < e) {}'], { stdio: 'ignore', windowsHide: true }));
        await runGesture(pick(['drag', 'throw', 'slowDrag', 'slowThrow'] as const));
        await runGesture(pick(['tap', 'stroke'] as const));
        for (const h of hogs.splice(0)) if (h.exitCode === null && h.signalCode === null) h.kill();
      };

      const reopenOwn = async (why: string): Promise<void> => {
        harnessIncidents.push(`${new Date().toISOString()} ${why}`);
        live.stopTopmost?.();
        live.stopTopmost = null;
        await own.close().catch(() => undefined);
        own = openOwnWindow({ layout: 'hidden' });
        maximized = false;
        try {
          win = await own.next();
          await hook(a, 'restrictSurfacesToPids', [win.pid]);
        } catch (err) {
          // Still no own window: the next maxWindow draw tries again; the run goes on either way.
          harnessIncidents.push(`${new Date().toISOString()} reopening the own window failed: ${err instanceof Error ? err.message : String(err)}`);
        }
      };
      const helperGone = (why: string): string => `${why}${own.closedFromOutside() ? ' (its window was closed from outside the test)' : ''}`;

      const perturb = async (k: Perturbation): Promise<void> => {
        perturbations[k] = (perturbations[k] ?? 0) + 1;
        switch (k) {
          case 'maxWindow': {
            // A draw that only reopens the helper is a harness incident, not a maximize perturbation.
            if (own.proc.exitCode !== null) {
              perturbations[k] = (perturbations[k] ?? 1) - 1;
              await reopenOwn(helperGone(`own window helper had exited (code ${String(own.proc.exitCode)})`));
              break;
            }
            maximized = !maximized;
            own.send({ op: maximized ? 'maximize' : 'minimize' });
            try {
              await own.next();
            } catch (err) {
              perturbations[k] = (perturbations[k] ?? 1) - 1;
              await reopenOwn(helperGone(`own window did not answer: ${err instanceof Error ? err.message : String(err)}`));
              break;
            }
            live.stopTopmost?.();
            live.stopTopmost = maximized ? keepTopmost([win.hwnd], (await hook(a, 'getOverlays')).map((o) => o.hwnd)) : null;
            break;
          }
          case 'hideShow':
            await hook(a, 'runAction', 'hide');
            hidden = true;
            await sleep(between(1500, 4000));
            await runGesture(pick(GESTURES)); // designed: a hidden cat takes no press
            await hook(a, 'runAction', 'show');
            hidden = false;
            await sleep(1200);
            await runGesture(pick(['drag', 'tap'] as const));
            break;
          case 'pauseResume':
            await hook(a, 'runAction', 'pause');
            await sleep(between(1500, 4000));
            await runGesture(pick(['drag', 'throw', 'tap'] as const)); // a paused cat can still be picked up
            await hook(a, 'runAction', 'resume');
            await sleep(800);
            break;
          case 'freeze':
            await freeze();
            await runGesture(pick(['tap', 'drag'] as const));
            break;
          case 'cpuHog':
            await cpuHog();
            break;
          case 'suspendResume':
            if (!systemAvailable) break;
            await hook(a, 'systemEvent', 'suspend');
            await sleep(between(1000, 3000));
            await hook(a, 'systemEvent', 'resume');
            await sleep(800);
            await runGesture(pick(['drag', 'tap', 'throw'] as const));
            break;
          case 'lockUnlock':
            if (!systemAvailable) break;
            // Windows' order on a lid close: lock, suspend, resume, then the user unlocks.
            await hook(a, 'systemEvent', 'lock');
            if (rnd() < 0.5) {
              await hook(a, 'systemEvent', 'suspend');
              await sleep(between(800, 2000));
              await hook(a, 'systemEvent', 'resume');
            }
            await sleep(between(1000, 3000));
            await hook(a, 'systemEvent', 'unlock');
            await sleep(1000);
            await runGesture(pick(['drag', 'tap', 'throw'] as const));
            break;
          case 'nap':
            await hook(a, 'injectEvent', { type: 'command.sleep' });
            await sleep(2500);
            await runGesture(pick(GESTURES));
            break;
        }
      };

      // ---- the soak ----------------------------------------------------------------------------
      const t0 = Date.now();
      const deadline = t0 + SOAK_MIN * 60_000;
      let nextPerturbation = t0 + between(20_000, 45_000);
      let nextProbe = t0 + 10_000;
      let nextLoop = t0 + 10_000;
      while (Date.now() < deadline) {
        await scaled(true);
        await sleep(between(1500, 4500));
        if (Date.now() >= nextLoop && loopDelayAvailable) {
          const d = await hook(a, 'eventLoopDelay', true);
          loopSamples.push({ p50Ms: d.p50Ms, p99Ms: d.p99Ms, maxMs: d.maxMs });
          nextLoop = Date.now() + 10_000;
        }
        if (Date.now() >= nextProbe) {
          await probeClickThrough();
          nextProbe = Date.now() + between(15_000, 30_000);
        }
        if (PERTURB && Date.now() >= nextPerturbation) {
          await perturb(pick(LOOP_PERTURBATIONS));
          nextPerturbation = Date.now() + between(30_000, 80_000);
          continue;
        }
        await runGesture(pick(LOOP_GESTURES));
      }
      if (maximized && own.proc.exitCode === null) {
        own.send({ op: 'minimize' });
        // A helper that no longer answers here must not cost the run its report.
        await own.next().catch((err: unknown) => harnessIncidents.push(`${new Date().toISOString()} ${helperGone(`own window did not answer the final minimize: ${err instanceof Error ? err.message : String(err)}`)}`));
      }
      live.stopTopmost?.();
      live.stopTopmost = null;
      await scaled(false);

      // ---- report --------------------------------------------------------------------------------
      const heapEnd = await heaps();
      const profile1 = await hook(a, 'getBehaviorProfile');
      const stats1 = await stats(true);
      const dbg = await hook(a, 'getHostDebug');
      const hours = (Date.now() - t0) / 3_600_000;
      const delta = (k: keyof NonNullable<InteractionStatsReport['overlay']>): unknown => {
        const x = stats0?.overlay?.[k];
        const y = stats1?.overlay?.[k];
        if (x === undefined || y === undefined) return null;
        if (typeof x === 'number' && typeof y === 'number') return y - x;
        return Object.fromEntries(Object.keys(y).map((kk) => [kk, (y as Record<string, number>)[kk]! - ((x as Record<string, number>)[kk] ?? 0)]));
      };
      const report = {
        harnessIncidents,
        minutes: Math.round(hours * 600) / 10,
        seed: SEED,
        timeScale: SCALE,
        options: { only: ONLY, perturb: PERTURB ? LOOP_PERTURBATIONS : [], osMouse: OS_MOUSE },
        gestures: Object.fromEntries(
          GESTURES.map((g) => {
            const r = results[g];
            const judged = r.attempts - r.designed - r.harness;
            return [g, { attempts: r.attempts, ok: r.ok, designed: r.designed, harness: r.harness, failed: r.failed.length, rate: judged > 0 ? Math.round((r.ok / judged) * 1000) / 10 : null }];
          }),
        ),
        failures: GESTURES.flatMap((g) => results[g].failed.slice(0, 40)),
        harnessSamples: GESTURES.flatMap((g) => results[g].harnessSamples),
        // The whole run's main log by level, scope and message (no debug): hangs, lost presses, guard
        // episodes and recoveries over all of it, where the attached tail covers only the last minutes.
        log: readLogLines(userData).reduce<Record<string, number>>((acc, l) => {
          if (l.l !== 'debug') acc[`${l.l} ${l.s}: ${l.m}`] = (acc[`${l.l} ${l.s}: ${l.m}`] ?? 0) + 1;
          return acc;
        }, {}),
        heldLatencyMs: { n: latencyMs.length, p50: percentile(latencyMs, 0.5), p95: percentile(latencyMs, 0.95), max: latencyMs.length ? Math.max(...latencyMs) : null },
        falls: { thrown: falls(profile1, 'thrown') - falls(profile0, 'thrown'), dropped: falls(profile1, 'dropped') - falls(profile0, 'dropped') },
        interaction: stats1 ? { presses: delta('presses'), lostPresses: delta('lostPresses'), win32Disagreements: delta('win32Disagreements'), contextCancels: delta('contextCancels'), failClosedPolls: delta('failClosedPolls'), ignoreToggles: delta('ignoreToggles'), recreates: delta('recreates'), staleRegionDenials: delta('staleRegionDenials'), clickGuard: stats1.clickGuard, lifecycle: stats1.lifecycle } : null,
        clickThrough: { ...clickThrough, onCatDenied: clickThrough.onCatDenied.slice(0, 10), offCatBlocking: clickThrough.offCatBlocking.slice(0, 10) },
        stuck,
        strayButtonlessMoves: { n: strayMoves.length, sample: strayMoves.slice(0, 10) },
        perturbations,
        freezes,
        eventLoop: loopSamples.length ? { samples: loopSamples.length, p99Median: percentile(loopSamples.map((s) => s.p99Ms), 0.5), p99Max: Math.max(...loopSamples.map((s) => s.p99Ms)), maxMs: Math.max(...loopSamples.map((s) => s.maxMs)) } : null,
        heap: { start: heapStart, end: heapEnd },
        host: { ticks: dbg.ticks, tickErrors: dbg.tickErrors, droppedEvents: dbg.droppedEvents },
        capabilities: { interactionStats: statsAvailable, overlayStats: overlayStatsAvailable, eventLoopDelay: loopDelayAvailable, systemEvent: systemAvailable },
      };
      await info.attach('soak-report.json', { body: JSON.stringify(report, null, 2), contentType: 'application/json' });
      // The line reporter keeps only the console: the whole report also goes to a file in the test's
      // output folder (out/e2e-results/<test>/), which stays until the next Playwright run.
      record(info, 'soak', report);
      const reportFile = info.outputPath('soak-report.json');
      fs.writeFileSync(reportFile, JSON.stringify(report, null, 2));
      record(info, 'soak-report-file', reportFile);

      // ---- pass criteria -----------------------------------------------------------------------
      for (const g of GESTURES) expect(results[g].failed, `${g}: every attempt outside a designed guard state lands`).toEqual([]);
      // The oracle may set aside input the page did not receive as a valid gesture; the run must still
      // judge most of each kind, or it says little about that kind.
      for (const g of GESTURES) expect(results[g].harness, `${g}: at most a quarter set aside as harness input (${results[g].attempts} attempts)`).toBeLessThanOrEqual(Math.max(3, Math.floor(results[g].attempts / 4)));
      expect(stuck, 'no press, drag or hold left behind after a gesture').toEqual([]);
      expect(clickThrough.offCatBlocking, 'T8: the overlay never takes the mouse off the cat').toEqual([]);
      expect(clickThrough.onCatDenied, 'the cat takes the mouse when no designed guard says otherwise').toEqual([]);
      for (const f of freezes) expect(f.recoveredMs, `renderer freeze (${String(f.how)}) recovered`).not.toBeNull();
      // T8 during a freeze: a frozen renderer's overlay is click-through (the press path fails closed).
      for (const f of freezes) expect(f.frozenInteractive, 'a frozen renderer does not take the mouse').toBe(false);
      const allowMb = 48 + 32 * hours;
      expect(heapEnd.mainHeapMb - heapStart.mainHeapMb, `main heap growth (start ${heapStart.mainHeapMb} MB)`).toBeLessThan(allowMb);
      heapEnd.rendererHeapMb.forEach((mb, i) => {
        const start = heapStart.rendererHeapMb[i];
        if (mb >= 0 && start !== undefined && start >= 0) expect(mb - start, 'renderer heap growth').toBeLessThan(allowMb);
      });
      expect(dbg.tickErrors, 'tick errors').toBe(0);
      expect(readLogLines(userData).filter((l) => l.l === 'error').map((l) => `${l.s}: ${l.m}`)).toEqual([]);
      annotate(info, 'SIMULATED', 'pointer input through CDP mouse events on the overlay page plus injectCursor; power events through the app own handlers; the renderer input path, IPC, gestures, sim and click-through decision are the real app');
    } finally {
      for (const h of hogs.splice(0)) if (h.exitCode === null && h.signalCode === null) h.kill();
      if (live.cdpFreeze) {
        await live.cdpFreeze.send('Debugger.resume').catch(() => undefined);
        await live.cdpFreeze.detach().catch(() => undefined);
      }
      live.stopTopmost?.();
      if (app) {
        await hook(app, 'injectCursor', null).catch(() => undefined);
        await hook(app, 'forceInteractive', null).catch(() => undefined);
        const code = await quitApp(app).catch(() => null);
        record(info, 'closed', { appExit: code });
        const logFile = path.join(userData, 'logs', 'main.log');
        if (fs.existsSync(logFile)) {
          const lines = fs.readFileSync(logFile, 'utf8').split(/\r?\n/).filter(Boolean);
          await info.attach('main-log.jsonl', { body: lines.slice(-600).join('\n'), contentType: 'application/x-ndjson' }).catch(() => undefined);
        }
      }
      await own.close();
    }
  });
});
