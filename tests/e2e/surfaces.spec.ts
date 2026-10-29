// Environment surfaces through the real app (v1.1).
// - REAL: the provider over real Win32 (status, well-formed surfaces) and the surfaces of a
//   throwaway window this suite creates in its own process (never the user's windows).
// - SIMULATED: a fake auto-hide taskbar ledge is injected through the test hook (which replaces
//   every real surface), slid up under the cat and retracted again, while the real host, sim
//   and overlays run.
// No input is sent and no real taskbar or user window is touched.
import { spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { ElectronApplication } from '@playwright/test';
// Pure modules only (no koffi/Electron in the Playwright process).
import { parseInjectedSurfaces } from '../../src/main/surfaces/validate';
import { defaultCornerRadiusDip, parseSurfaceId } from '../../src/main/surfaces/windowSurfaces';
import type { Rect } from '../../src/shared/geometry';
import type { SimOutput } from '../../src/shared/sim';
import type { LedgeSurface, Surface, WallSurface } from '../../src/shared/surfaces';
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
app.whenReady().then(() => {
  const w = new BrowserWindow({ x: 240, y: 260, width: 560, height: 360, show: true, alwaysOnTop: true, backgroundColor: '#ffffff', title: 'dcat-e2e' });
  w.loadURL('about:blank');
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

function openProbeWindow(dir: string): ProbeWindow {
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
  Object.assign(env, { DCAT_KOFFI: path.join(ROOT, 'node_modules', 'koffi'), DCAT_PROBE_OUT: outFile, DCAT_PROBE_CMD: cmdFile, ELECTRON_ENABLE_LOGGING: '0' });
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
});
