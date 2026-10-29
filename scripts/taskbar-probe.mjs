#!/usr/bin/env node
// REAL probe of the v1.1 taskbar work (ADR 0002 §2, docs/research/v1.1/taskbar.md):
// the overlay "rude window" fix and the TaskbarTracker, on this machine's real shell.
//
// Stage 1 (plain Node): bundles the production modules (createOverlayWindow + createOverlayShell,
// createTaskbarTracker, the koffi bindings, the display service) with esbuild into a temp dir and
// launches this same file in Electron. Stage 2 (Electron main, a per-monitor-v2 thread):
//   1. the real tracker discovers the taskbars (class names only, never titles);
//   2. baseline: Shell_TrayWnd has WS_EX_TOPMOST and WindowFromPoint on its outer reveal row is
//      the taskbar (otherwise something else, e.g. a real fullscreen app, is in front: inconclusive);
//   3. optional control (--control, off by default): one overlay WITHOUT NonRudeHWND, to show the
//      check discriminates (Windows strips the taskbar's topmost style while it exists; restored
//      when it is destroyed, measured in the research);
//   4. the real overlay config on every display, NonRudeHWND set right before showInactive()
//      exactly as the overlay manager does; the taskbar must stay topmost and keep hit-testing;
//   5. passive observation (--observe-ms, default 15000): the tracker is sampled at the cadence it
//      asks for with the real cursor position, and every taskbar geometry/phase change and event is
//      logged. The probe never moves the mouse and sends no input: a show/hide transition is only
//      seen if the user happens to reveal the taskbar meanwhile;
//   6. teardown: RemovePropW before destroy (the property must be gone), taskbar still topmost.
//
//   --tray (diagnostic, off by default): adds a notification-area icon like the app does and records
//      the raw taskbar rect timeline, to see whether that reveals an auto-hidden taskbar.
//   --paint (diagnostic): the probe overlays draw an opaque block instead of nothing.
//   --parts (diagnostic): adds the app's other startup pieces one by one (see 5a).
//   --app <out/main/index.js> (diagnostic): see appTimeline() below. Measured 2026-10-29: a FIRST run
//      reveals an auto-hidden taskbar ~0.5 s after launch and keeps it revealed until the app exits;
//      the app then owns a visible, unowned 900x640 DIP window (the welcome page) while the
//      foreground stays with another process. INFERRED: started by a background process, the
//      welcome window is denied activation and its taskbar button flashes, which holds the taskbar
//      open. Same without NonRudeHWND (--app-variant no-nonrude, where the taskbar also loses
//      WS_EX_TOPMOST); the overlays, tray icon, shortcut, hooks and power listeners alone do not
//      reveal it (--parts, --tray, --paint).
// Usage: node scripts/with-lock.mjs taskbar-probe -- node scripts/taskbar-probe.mjs [--observe-ms 15000] [--control] [--tray] [--paint] [--parts]
//        node scripts/with-lock.mjs taskbar-probe -- node scripts/taskbar-probe.mjs --app out/main/index.js [--app-ms 8000] [--app-test-mode] [--app-variant no-nonrude]
// Output: one line "TASKBAR-PROBE-RESULT {json}"; exit code 0 when every check passed.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const SELF = fileURLToPath(import.meta.url);
const ROOT = path.resolve(path.dirname(SELF), '..');
const CHILD_FLAG = '--taskbar-probe-child';
const RESULT_TAG = 'TASKBAR-PROBE-RESULT';

const WS_EX_TOPMOST = 0x8;
const GWL_EXSTYLE = -20;
const GA_ROOT = 2;
const GW_HWNDNEXT = 2;
const ABS_AUTOHIDE = 1;

if (process.versions.electron) stageTwo();
else
  (process.argv.includes('--app') ? appTimeline() : stageOne()).catch((e) => {
    console.error(`taskbar-probe: ${e && e.stack ? e.stack : e}`);
    process.exit(1);
  });

function argValue(name, fallback) {
  const i = process.argv.indexOf(name);
  if (i < 0) return fallback;
  const v = Number(process.argv[i + 1]);
  return Number.isFinite(v) && v >= 0 ? v : fallback;
}

/**
 * --app <main.js> [--app-ms 8000] [--app-test-mode]: launches the BUILT app (its own throwaway
 * userData) as a child of this probe and records the primary taskbar's raw window rect every 10 ms
 * while it runs and for 3 s after this probe terminates that child. Shows whether the running app
 * reveals (or keeps revealed) an auto-hidden taskbar. Only the child this probe started is stopped.
 */
async function appTimeline() {
  const mainJs = path.resolve(process.argv[process.argv.indexOf('--app') + 1] || path.join(ROOT, 'out', 'main', 'index.js'));
  if (!fs.existsSync(mainJs)) throw new Error(`${mainJs} missing: run "node scripts/build.mjs" first`);
  const runMs = argValue('--app-ms', 8000);
  const electronPath = require(require.resolve('electron', { paths: [ROOT] }));
  const koffi = require(require.resolve('koffi', { paths: [ROOT] }));
  const user32 = koffi.load('user32.dll');
  // Physical px, like Electron's main thread (DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2).
  user32.func('__stdcall', 'SetThreadDpiAwarenessContext', 'intptr_t', ['intptr_t'])(-4);
  const RECT = koffi.struct('DCAT_TASKBAR_PROBE_RECT', { left: 'int32_t', top: 'int32_t', right: 'int32_t', bottom: 'int32_t' });
  const GetWindowRect = user32.func('__stdcall', 'GetWindowRect', 'int', ['void *', koffi.out(koffi.pointer(RECT))]);
  const FindWindowW = user32.func('void * __stdcall FindWindowW(const char16_t *cls, const char16_t *title)');
  const GetWindowLongPtrW = user32.func('intptr_t __stdcall GetWindowLongPtrW(void *h, int idx)');
  const GetForegroundWindow = user32.func('void * __stdcall GetForegroundWindow()');
  const GetWindowThreadProcessId = user32.func('uint32_t __stdcall GetWindowThreadProcessId(void *h, _Out_ uint32_t *pid)');
  const tray = FindWindowW('Shell_TrayWnd', null);
  if (!tray) throw new Error('no Shell_TrayWnd');
  let childPid = -1;
  /** Who is in the foreground, coarsely: this app, the taskbar, something else (never which window). */
  const foreground = () => {
    const fg = GetForegroundWindow();
    if (!fg) return 'none';
    if (fg === tray) return 'taskbar';
    const pid = [0];
    GetWindowThreadProcessId(fg, pid);
    return pid[0] === childPid ? 'app' : 'other';
  };
  const t0 = performance.now();
  const timeline = [];
  let last = '';
  const read = (what) => {
    const r = {};
    const ok = GetWindowRect(tray, r) !== 0;
    const topmost = (Number(GetWindowLongPtrW(tray, GWL_EXSTYLE)) & WS_EX_TOPMOST) !== 0;
    const k = `${ok ? `top=${r.top} topmost=${topmost}` : 'unreadable'} fg=${foreground()}`;
    if ((what || k !== last) && timeline.length < 300) {
      last = k;
      timeline.push({ t: Math.round(performance.now() - t0), what: what ? `${what} (${k})` : k });
    }
  };
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'desktop-cat-taskbar-app-'));
  // --app-variant no-nonrude (diagnostic): the same build with the overlay manager's NonRudeHWND
  // call replaced by `false`, bundled into the temp dir next to copies of the built renderer/preload.
  let entry = mainJs;
  const variant = process.argv.includes('--app-variant') ? process.argv[process.argv.indexOf('--app-variant') + 1] : null;
  if (variant === 'no-nonrude') {
    const outRoot = path.resolve(path.dirname(mainJs), '..');
    const vroot = path.join(work, 'variant');
    for (const dir of ['renderer', 'preload']) fs.cpSync(path.join(outRoot, dir), path.join(vroot, dir), { recursive: true });
    const esbuild = require(require.resolve('esbuild', { paths: [ROOT] }));
    const koffiPath = require.resolve('koffi', { paths: [ROOT] });
    const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
    let replaced = 0;
    await esbuild.build({
      entryPoints: { 'main/index': path.join(ROOT, 'src', 'main', 'index.ts') },
      bundle: true,
      platform: 'node',
      format: 'cjs',
      target: 'node24',
      outdir: vroot,
      external: ['electron'],
      define: { __DEV__: 'false', __APP_VERSION__: JSON.stringify(pkg.version), 'process.env.NODE_ENV': JSON.stringify('production') },
      logLevel: 'warning',
      plugins: [
        {
          name: 'variant',
          setup(b) {
            b.onResolve({ filter: /^koffi$/ }, () => ({ path: koffiPath, external: true }));
            b.onLoad({ filter: /overlayManager\.ts$/ }, (args) => {
              const src = fs.readFileSync(args.path, 'utf8');
              const out = src.replace('e.nonRude = shell.beforeShow(win, e.displayId);', 'e.nonRude = false;');
              if (out !== src) replaced++;
              return { contents: out, loader: 'ts' };
            });
          },
        },
      ],
    });
    if (replaced !== 1) throw new Error('variant: the NonRudeHWND call was not found in overlayManager.ts');
    entry = path.join(vroot, 'main', 'index.js');
  } else if (variant !== null) throw new Error(`unknown --app-variant ${variant}`);
  // The production tracker in this (per-monitor-v2) Node process, sampled at the cadence it asks for
  // with the real cursor: shows how its state machine follows whatever the taskbar does meanwhile.
  const trackerBundle = path.join(work, 'tracker.cjs');
  {
    const esbuild = require(require.resolve('esbuild', { paths: [ROOT] }));
    const koffiPath = require.resolve('koffi', { paths: [ROOT] });
    await esbuild.build({
      stdin: {
        contents: "export { createTaskbarTracker } from './src/main/win32/taskbar.ts';\nexport { loadWin32Native } from './src/main/win32/native.ts';\n",
        resolveDir: ROOT,
        loader: 'ts',
        sourcefile: 'taskbar-probe-tracker.ts',
      },
      bundle: true,
      platform: 'node',
      format: 'cjs',
      target: 'node24',
      outfile: trackerBundle,
      logLevel: 'warning',
      plugins: [{ name: 'koffi-absolute', setup: (b) => b.onResolve({ filter: /^koffi$/ }, () => ({ path: koffiPath, external: true })) }],
    });
  }
  const tm = require(trackerBundle);
  const trackerLog = [];
  const tlog = (scope) => ({
    error: (msg) => trackerLog.push(`error ${scope}: ${msg}`),
    warn: (msg) => trackerLog.push(`warn ${scope}: ${msg}`),
    info: (msg) => trackerLog.push(`info ${scope}: ${msg}`),
    debug: () => undefined,
    child: (c) => tlog(`${scope}.${c}`),
  });
  const tracker = tm.createTaskbarTracker(tlog('probe'));
  const wn = tm.loadWin32Native();
  tracker.start();
  const trackerTimeline = [];
  let lastState = '';
  let sampling = true;
  const sampleTracker = () => {
    if (!sampling) return;
    const now = performance.now();
    const delay = tracker.sample(now, wn.getCursorPos(), false);
    const tb = tracker.taskbars()[0];
    const ledge = tracker.surfaces()[0];
    const st = tb ? `${tb.phase} f=${tb.shownFraction.toFixed(2)} v=${Math.round(tb.speed)}${ledge ? ` ledge y=${ledge.y.toFixed(1)} ${ledge.phase} c=${ledge.confidence}` : ''}` : 'none';
    const evs = tracker.drainEvents().map((e) => e.type);
    if ((st !== lastState || evs.length > 0) && trackerTimeline.length < 300) {
      lastState = st;
      trackerTimeline.push({ t: Math.round(now - t0), delay, state: st, ...(evs.length ? { events: evs } : {}) });
    }
    setTimeout(sampleTracker, delay);
  };
  sampleTracker();

  read(`before launch${variant ? ` (variant ${variant})` : ''}`);
  const timer = setInterval(() => read(null), 10);
  const env = { ...process.env, DESKTOP_CAT_USER_DATA: path.join(work, 'user-data'), ELECTRON_ENABLE_LOGGING: '0' };
  if (process.argv.includes('--app-test-mode')) env.DESKTOP_CAT_TEST = '1';
  else delete env.DESKTOP_CAT_TEST;
  const launchedAtWall = Date.now();
  const child = spawn(electronPath, [entry], { cwd: ROOT, env, stdio: 'ignore', windowsHide: false });
  childPid = child.pid ?? -1;
  read(`launched pid ${child.pid}`);
  const exited = new Promise((resolve) => child.once('exit', (code) => resolve(code)));
  await new Promise((r) => setTimeout(r, Math.min(3000, runMs)));
  // The app's OWN top-level windows (filtered by the child's pid; nothing of other processes is
  // kept): which of them could own a taskbar button (visible, unowned or WS_EX_APPWINDOW, no WS_EX_TOOLWINDOW).
  const ownWindows = [];
  {
    const WNDENUMPROC = koffi.proto('__stdcall', 'DCAT_TASKBAR_PROBE_ENUMPROC', 'int', ['void *', 'intptr_t']);
    const EnumWindows = user32.func('__stdcall', 'EnumWindows', 'int', [koffi.pointer(WNDENUMPROC), 'intptr_t']);
    const GetClassNameW = user32.func('int __stdcall GetClassNameW(void *h, void *buf, int max)');
    const IsWindowVisible = user32.func('int __stdcall IsWindowVisible(void *h)');
    const GetWindow = user32.func('void * __stdcall GetWindow(void *h, uint32_t cmd)');
    const buf = Buffer.alloc(512);
    const cb = koffi.register((h) => {
      const pid = [0];
      GetWindowThreadProcessId(h, pid);
      if (pid[0] === childPid && ownWindows.length < 64) {
        const n = GetClassNameW(h, buf, 256);
        const ex = Number(GetWindowLongPtrW(h, GWL_EXSTYLE));
        const r = {};
        GetWindowRect(h, r);
        ownWindows.push({ cls: buf.toString('utf16le', 0, n * 2), visible: IsWindowVisible(h) !== 0, exStyle: `0x${(ex >>> 0).toString(16)}`, owned: GetWindow(h, 4) !== null, size: `${r.right - r.left}x${r.bottom - r.top}` });
      }
      return 1;
    }, koffi.pointer(WNDENUMPROC));
    EnumWindows(cb, 0);
    koffi.unregister(cb);
  }
  await new Promise((r) => setTimeout(r, Math.max(0, runMs - 3000)));
  read('terminating the app this probe started');
  child.kill();
  await Promise.race([exited, new Promise((r) => setTimeout(r, 5000))]);
  read('app exited');
  await new Promise((r) => setTimeout(r, 3000));
  clearInterval(timer);
  sampling = false;
  tracker.stop();
  read('end');
  let log = [];
  try {
    log = fs
      .readFileSync(path.join(work, 'user-data', 'logs', 'main.log'), 'utf8')
      .split(/\r?\n/)
      .filter(Boolean)
      .map((l) => JSON.parse(l))
      .map((l) => `${Math.round(Date.parse(l.t) - launchedAtWall)}ms ${l.l} ${l.s}: ${l.m}`)
      .slice(0, 120);
  } catch (e) {
    log = [`log unreadable: ${e.message}`];
  }
  fs.rmSync(work, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 });
  console.log(`${RESULT_TAG} ${JSON.stringify({ mode: 'app', mainJs: entry, variant, runMs, timeline, trackerTimeline, trackerLog, ownWindows, log }, null, 1)}`);
}

async function stageOne() {
  const esbuild = require(require.resolve('esbuild', { paths: [ROOT] }));
  const electronPath = require(require.resolve('electron', { paths: [ROOT] }));
  const koffiPath = require.resolve('koffi', { paths: [ROOT] });
  const observeMs = argValue('--observe-ms', 15000);
  const control = process.argv.includes('--control');
  const trayExperiment = process.argv.includes('--tray');
  const paint = process.argv.includes('--paint');
  const parts = process.argv.includes('--parts');
  const timeoutMs = observeMs + 60000;

  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'desktop-cat-taskbar-probe-'));
  const bundle = path.join(work, 'taskbar-probe.cjs');
  const userData = path.join(work, 'user-data');
  const preload = path.join(work, 'empty-preload.js');
  fs.mkdirSync(userData);
  fs.writeFileSync(preload, '// intentionally empty: the probe overlay loads a blank transparent page\n');
  await esbuild.build({
    stdin: {
      contents: [
        "export { createTaskbarTracker } from './src/main/win32/taskbar.ts';",
        "export { loadWin32Native, loadShellNative } from './src/main/win32/native.ts';",
        "export { NON_RUDE_PROP } from './src/main/win32/taskbar/windowProps.ts';",
        "export { createOverlayWindow, createOverlayShell } from './src/main/overlay/overlayWindow.ts';",
        "export { createDisplayService } from './src/main/display/displayService.ts';",
        "export { createWin32Api, createWindowTracker, createActivityMonitor } from './src/main/win32/index.ts';",
      ].join('\n'),
      resolveDir: ROOT,
      loader: 'ts',
      sourcefile: 'taskbar-probe-entry.ts',
    },
    bundle: true,
    platform: 'node',
    format: 'cjs',
    target: 'node24',
    outfile: bundle,
    external: ['electron'],
    define: { __DEV__: 'false', __APP_VERSION__: JSON.stringify('0.0.0-probe') },
    logLevel: 'warning',
    plugins: [
      {
        // The bundle lives in a temp dir: point koffi at the repo's copy by absolute path.
        name: 'koffi-absolute',
        setup(b) {
          b.onResolve({ filter: /^koffi$/ }, () => ({ path: koffiPath, external: true }));
        },
      },
    ],
  });

  const args = [SELF, CHILD_FLAG, bundle, userData, koffiPath, preload, String(observeMs), control ? '1' : '0', String(timeoutMs), trayExperiment ? '1' : '0', paint ? '1' : '0', parts ? '1' : '0'];
  const child = spawn(electronPath, args, { stdio: 'inherit', windowsHide: false });
  const killer = setTimeout(() => {
    console.error('taskbar-probe: Electron did not exit in time; terminating the probe process it started');
    child.kill();
  }, timeoutMs + 15000);
  const code = await new Promise((resolve) => {
    child.on('exit', (c, signal) => resolve(c ?? (signal ? 1 : 0)));
    child.on('error', (e) => {
      console.error(`taskbar-probe: failed to start Electron: ${e.message}`);
      resolve(1);
    });
  });
  clearTimeout(killer);
  fs.rmSync(work, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  process.exit(code);
}

function stageTwo() {
  const { app, BaseWindow, BrowserWindow, globalShortcut, Menu, nativeImage, powerMonitor, screen, Tray } = require('electron');
  const i = process.argv.indexOf(CHILD_FLAG);
  const [bundle, userData, koffiPath, preload, observeStr, controlStr, timeoutStr, trayStr, paintStr, partsStr] = process.argv.slice(i + 1);
  app.setPath('userData', userData);
  app.on('window-all-closed', () => {
    /* keep running between probe windows */
  });
  const hardTimeout = setTimeout(() => {
    console.log(`${RESULT_TAG} ${JSON.stringify({ ok: false, error: 'probe timed out' })}`);
    app.exit(2);
  }, Number(timeoutStr) || 75000);

  app
    .whenReady()
    .then(() =>
      runProbe({
        BrowserWindow,
        screen,
        m: require(bundle),
        koffi: require(koffiPath),
        preload,
        observeMs: Number(observeStr) || 0,
        control: controlStr === '1',
        trayExperiment: trayStr === '1' ? { Tray, nativeImage } : null,
        paint: paintStr === '1',
        parts: partsStr === '1' ? { app, BaseWindow, globalShortcut, Menu, nativeImage, powerMonitor, Tray } : null,
      }),
    )
    .then((result) => {
      clearTimeout(hardTimeout);
      console.log(`${RESULT_TAG} ${JSON.stringify(result, null, 2)}`);
      app.exit(result.ok ? 0 : 1);
    })
    .catch((e) => {
      clearTimeout(hardTimeout);
      console.log(`${RESULT_TAG} ${JSON.stringify({ ok: false, error: String(e && e.stack ? e.stack : e) })}`);
      app.exit(1);
    });
}

async function runProbe({ BrowserWindow, screen, m, koffi, preload, observeMs, control, trayExperiment, paint, parts }) {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const logEntries = [];
  const makeLogger = (scope) => ({
    error: (msg, data) => logEntries.push({ level: 'error', scope, msg, data }),
    warn: (msg, data) => logEntries.push({ level: 'warn', scope, msg, data }),
    info: (msg, data) => logEntries.push({ level: 'info', scope, msg, data }),
    debug: (msg, data) => logEntries.push({ level: 'debug', scope, msg, data }),
    child: (c) => makeLogger(`${scope}.${c}`),
  });
  const logger = makeLogger('probe');
  const checks = {};
  const notes = {};
  const check = (name, ok, detail) => {
    checks[name] = detail === undefined ? { ok: Boolean(ok) } : { ok: Boolean(ok), detail };
  };
  const inconclusive = (name, why) => {
    notes[`${name}.inconclusive`] = why;
  };

  const native = m.loadWin32Native();
  const user32 = koffi.load('user32.dll');
  // Read-only property query; the probe only ever sets/removes the property on its OWN windows (via the product code).
  const GetPropW = user32.func('intptr_t __stdcall GetPropW(void *h, const char16_t *name)');
  const propOf = (h) => Number(GetPropW(h, m.NON_RUDE_PROP));
  const hwndOf = (win) => win.getNativeWindowHandle().readBigUInt64LE(0);
  const trayHwnd = () => m.loadShellNative().findWindow('Shell_TrayWnd');
  const topmostOf = (h) => (h ? (native.getWindowLong(h, GWL_EXSTYLE) & WS_EX_TOPMOST) !== 0 : null);
  const rootAt = (p) => {
    const h = native.windowFromPoint(Math.round(p.x), Math.round(p.y));
    return h === null ? null : native.getAncestor(h, GA_ROOT);
  };
  /** Steps from `from` down the z-order until `to` (null when not found within the limit). */
  const zSteps = (from, to, limit = 4096) => {
    let h = from;
    for (let k = 0; k < limit && h !== null; k++) {
      if (h === to) return k;
      h = native.getWindow(h, GW_HWNDNEXT);
    }
    return null;
  };

  // --- 1. displays + the real tracker -------------------------------------------------------
  const ds = m.createDisplayService(logger);
  const world = ds.world;
  notes.displays = world.displays.map((d) => ({ id: d.id, primary: d.primary, scale: d.scaleFactor, boundsPx: d.boundsPx, workAreaPx: d.workAreaPx }));
  notes.threadDpiAwareness = native.getThreadDpiAwareness();
  check('thread.perMonitorV2', notes.threadDpiAwareness === 2, { awareness: notes.threadDpiAwareness });

  const tracker = m.createTaskbarTracker(logger.child('tracker'), { world });
  check('tracker.available', tracker.available === true);
  tracker.start();
  const bars = tracker.taskbars();
  const dbg0 = tracker.debugInfo();
  const primaryDbg = (dbg0.taskbars || []).find((t) => t.primary) || null;
  const primary = primaryDbg ? bars.find((b) => b.id === primaryDbg.id) || null : null;
  notes.taskbarsAtStart = bars;
  notes.trackerDebugAtStart = dbg0;
  check('tracker.foundPrimaryTaskbar', primary !== null, { count: bars.length });
  const tray = trayHwnd();
  check('tracker.primaryIsShellTrayWnd', primary !== null && tray !== null && primary.id === tray.toString());
  if (primary && primaryDbg) {
    check('tracker.edgeAgreesWithAppBar', primaryDbg.edgeMismatch === false, { edge: primary.edge, appBarEdge: primaryDbg.appBarEdge });
    // Independent cross-check of auto-hide: Electron's work area of the taskbar's display reaches the docked edge.
    const disp = world.displays.find((d) => d.id === primary.displayId) || world.displays.find((d) => d.primary);
    const b = disp.boundsPx;
    const w = disp.workAreaPx;
    const reaches = { bottom: w.y + w.height >= b.y + b.height, top: w.y <= b.y, left: w.x <= b.x, right: w.x + w.width >= b.x + b.width }[primary.edge];
    const abmAutoHide = typeof dbg0.appBar?.state === 'number' ? (dbg0.appBar.state & ABS_AUTOHIDE) !== 0 : null;
    check('tracker.autoHideMatchesElectronWorkArea', primary.autoHide === reaches, { autoHide: primary.autoHide, electronWorkAreaReachesEdge: reaches, abmGetStateAutoHide: abmAutoHide });
  }

  // The outer reveal row/column of the primary taskbar (the 2 px strip of an auto-hidden one).
  const revealPoint = (() => {
    if (!primary) return null;
    const disp = world.displays.find((d) => d.id === primary.displayId) || world.displays.find((d) => d.primary);
    const b = disp.boundsPx;
    const r = primary.rect;
    const midX = Math.round(Math.max(b.x, r.x) + (Math.min(b.x + b.width, r.x + r.width) - Math.max(b.x, r.x)) / 2);
    const midY = Math.round(Math.max(b.y, r.y) + (Math.min(b.y + b.height, r.y + r.height) - Math.max(b.y, r.y)) / 2);
    switch (primary.edge) {
      case 'bottom':
        return { x: midX, y: b.y + b.height - 1 };
      case 'top':
        return { x: midX, y: b.y };
      case 'left':
        return { x: b.x, y: midY };
      default:
        return { x: b.x + b.width - 1, y: midY };
    }
  })();
  notes.revealPoint = revealPoint;
  const hitsTray = () => (revealPoint && tray ? rootAt(revealPoint) === tray : null);

  // --- 2. baseline --------------------------------------------------------------------------
  const baseline = { topmost: topmostOf(tray), hit: hitsTray(), notificationState: native.queryUserNotificationState() };
  notes.baseline = baseline;
  const conclusive = baseline.topmost === true && baseline.hit === true;
  if (!conclusive) inconclusive('overlay', 'the taskbar was not topmost / not hit-tested before any probe window existed (another fullscreen window in front?)');

  const shell = m.createOverlayShell(logger.child('shell'));
  // --paint (diagnostic): an opaque 160x120 block at the bottom-left, like a cat on the floor.
  const page = paint
    ? 'data:text/html,<html style="background:transparent"><body style="margin:0;background:transparent"><div style="position:fixed;left:200px;bottom:0;width:160px;height:120px;background:%23c08040"></div></body></html>'
    : 'data:text/html,<html style="background:transparent"><body style="margin:0;background:transparent"></body></html>';

  /** Creates one overlay with the production config and shows it like the overlay manager does. */
  async function showOverlay(display, nonRude) {
    const win = m.createOverlayWindow({ display, preloadPath: preload, devTools: false, contentProtection: false });
    const shown = new Promise((resolve) => {
      win.once('ready-to-show', () => {
        const set = nonRude ? shell.beforeShow(win, display.id) : false;
        win.showInactive();
        resolve(set);
      });
    });
    await win.loadURL(page);
    const nonRudeSet = await Promise.race([shown, sleep(5000).then(() => 'timeout')]);
    return { win, hwnd: hwndOf(win), displayId: display.id, nonRudeSet };
  }

  /** Watches the taskbar's topmost bit and the reveal hit-test for `ms` after a show. */
  async function watchTaskbar(ms) {
    const samples = [];
    const t0 = performance.now();
    while (performance.now() - t0 < ms) {
      const r = tray ? native.getWindowRect(tray) : null;
      samples.push({ t: Math.round(performance.now() - t0), topmost: topmostOf(tray), hit: hitsTray(), top: r ? r.top : null });
      await sleep(50);
    }
    const lostAt = samples.find((s) => s.topmost === false);
    return {
      samples: samples.length,
      alwaysTopmost: samples.every((s) => s.topmost === true),
      alwaysHit: samples.every((s) => s.hit === true),
      firstLostTopmostMs: lostAt ? lostAt.t : null,
      last: samples.at(-1) ?? null,
      // Live taskbar rect tops seen (an auto-hidden taskbar that gets revealed moves up).
      tops: [...new Set(samples.map((s) => s.top))],
    };
  }

  // --- 3. control: no NonRudeHWND (opt-in) --------------------------------------------------
  if (control && conclusive && primary) {
    const disp = world.displays.find((d) => d.id === primary.displayId) || world.displays[0];
    const o = await showOverlay(disp, false);
    const watched = await watchTaskbar(1500);
    o.win.destroy();
    await sleep(500);
    const restored = { topmost: topmostOf(tray), hit: hitsTray() };
    notes.control = { watched, afterDestroy: restored };
    // Expected (research): the taskbar loses WS_EX_TOPMOST within ~60 ms and gets it back after destroy.
    check('control.withoutFixTaskbarLosesTopmost', watched.alwaysTopmost === false, watched);
    check('control.restoredAfterDestroy', restored.topmost === true && restored.hit === true, restored);
  }

  // --- 4. the fix: real overlay config + NonRudeHWND on every display -----------------------
  const overlays = [];
  for (const d of world.displays) overlays.push(await showOverlay(d, true));
  check('overlay.nonRudeSetBeforeShow', overlays.every((o) => o.nonRudeSet === true), overlays.map((o) => ({ displayId: o.displayId, set: o.nonRudeSet })));
  check('overlay.nonRudePropertyPresent', overlays.every((o) => propOf(o.hwnd) === 1), overlays.map((o) => ({ displayId: o.displayId, value: propOf(o.hwnd) })));
  check('overlay.visible', overlays.every((o) => o.win.isVisible()));
  const watched = await watchTaskbar(2500);
  notes.withFix = watched;
  if (conclusive) {
    check('overlay.taskbarKeepsTopmost', watched.alwaysTopmost, watched);
    check('overlay.revealRowStillHitsTaskbar', watched.alwaysHit, { revealPoint, last: watched.last });
  }
  const home = overlays.find((o) => primary && o.displayId === primary.displayId) || overlays[0];
  if (home && tray) {
    // Diagnostics: where our overlay sits relative to the taskbar (z-order is never re-asserted by the app).
    const below = zSteps(home.hwnd, tray);
    notes.zOrder = below !== null ? { overlayAboveTaskbarBySteps: below } : { taskbarAboveOverlayBySteps: zSteps(tray, home.hwnd) };
  }

  // --- 5. passive observation ---------------------------------------------------------------
  const timeline = [];
  const cadence = {};
  let events = [];
  let observedSamples = 0;
  let topmostLost = 0;
  const key = (t) => `${t.phase}|${t.rect.x},${t.rect.y},${t.rect.width},${t.rect.height}`;
  const lastKey = new Map(bars.map((t) => [t.id, key(t)]));
  const tObs = performance.now();
  let nextTopmostCheck = 0;
  while (performance.now() - tObs < observeMs) {
    const now = performance.now();
    const delay = tracker.sample(now, native.getCursorPos(), false);
    observedSamples++;
    const reason = tracker.debugInfo().cadence?.reason ?? 'idle';
    cadence[reason] = (cadence[reason] || 0) + 1;
    for (const t of tracker.taskbars()) {
      const k = key(t);
      if (lastKey.get(t.id) !== k) {
        lastKey.set(t.id, k);
        if (timeline.length < 400) timeline.push({ t: Math.round(now - tObs), id: t.id, phase: t.phase, rect: t.rect, shownFraction: Math.round(t.shownFraction * 1000) / 1000, speed: Math.round(t.speed) });
      }
    }
    const surfaces = tracker.surfaces();
    if (surfaces.length > 0 && timeline.length < 400) timeline.push({ t: Math.round(now - tObs), ledges: surfaces.map((s) => ({ id: s.id, y: s.y, x0: s.x0, x1: s.x1, phase: s.phase, vy: Math.round(s.vy), confidence: s.confidence })) });
    for (const ev of tracker.drainEvents()) events.push({ t: Math.round(now - tObs), ...ev });
    if (now - tObs >= nextTopmostCheck) {
      nextTopmostCheck += 1000;
      if (topmostOf(tray) === false) topmostLost++;
    }
    await sleep(Math.max(1, Math.min(1000, delay)));
  }
  events = events.slice(0, 100);
  notes.observation = { ms: observeMs, samples: observedSamples, cadenceReasons: cadence, timeline, events, topmostLostSamples: topmostLost };
  if (conclusive && observeMs > 0) check('observation.taskbarStayedTopmost', topmostLost === 0, { topmostLost });
  const after = tracker.taskbars();
  notes.taskbarsAtEnd = after;
  if (primary) {
    const p = after.find((t) => t.id === primary.id);
    // Diagnostics: the raw window rect read now, next to the tracker's last sample.
    notes.rawPrimaryRectAtEnd = tray ? native.getWindowRect(tray) : null;
    check('tracker.stillTracksPrimary', p !== undefined);
  }

  // --- 5a. optional bisection (--parts, diagnostic): the app's other startup pieces, one at a time,
  // with the overlays up; records whether the auto-hidden taskbar moves after each.
  if (parts && tray) {
    const e = parts;
    const disposers = [];
    const steps = [
      ['app user model id', () => e.app.setAppUserModelId('io.github.enesiltas.desktopcat.taskbarprobe')],
      ['tray icon + menu + tooltip', () => {
        const t = new e.Tray(e.nativeImage.createFromPath(path.join(ROOT, 'build', 'icon.png')).resize({ width: 32, height: 32 }));
        t.setToolTip('taskbar-probe');
        t.setContextMenu(e.Menu.buildFromTemplate([{ label: 'taskbar-probe' }]));
        disposers.push(() => t.destroy());
      }],
      ['global shortcut', () => {
        const acc = 'Control+Alt+Shift+F11';
        e.globalShortcut.register(acc, () => undefined);
        disposers.push(() => e.globalShortcut.unregister(acc));
      }],
      ['hidden session-end window', () => {
        const w = new e.BaseWindow({ show: false, width: 1, height: 1, frame: false, skipTaskbar: true, focusable: false, resizable: false });
        disposers.push(() => w.destroy());
      }],
      ['win32 window tracker (WinEvent hooks) + activity monitor', () => {
        const api = m.createWin32Api(logger.child('parts'));
        const wt = m.createWindowTracker(api, logger.child('parts'));
        wt.start();
        const am = m.createActivityMonitor(api, logger.child('parts'));
        am.start();
        disposers.push(() => {
          am.stop();
          wt.stop();
          api.dispose();
        });
      }],
      ['power monitor listeners', () => {
        const f = () => undefined;
        e.powerMonitor.on('suspend', f);
        e.powerMonitor.on('lock-screen', f);
        disposers.push(() => {
          e.powerMonitor.removeListener('suspend', f);
          e.powerMonitor.removeListener('lock-screen', f);
        });
      }],
    ];
    const results = [];
    for (const [name, apply] of steps) {
      let error = null;
      try {
        apply();
      } catch (err) {
        error = String(err);
      }
      const w = await watchTaskbar(2500);
      results.push({ part: name, error, tops: w.tops, alwaysTopmost: w.alwaysTopmost });
    }
    for (const d of disposers.reverse()) d();
    await sleep(1500);
    const r = native.getWindowRect(tray);
    notes.parts = { results, topAfterDispose: r ? r.top : null };
  }

  // --- 5b. optional experiment (--tray): does adding a notification-area icon (as the app does at
  // startup) reveal the auto-hidden taskbar? Timeline of the raw taskbar rect at 10 ms.
  if (trayExperiment && tray) {
    const tl = [];
    let last = '';
    const t0 = performance.now();
    const read = (what) => {
      const r = native.getWindowRect(tray);
      const k = r ? `top=${r.top}` : 'gone';
      if (what || k !== last) {
        last = k;
        tl.push({ t: Math.round(performance.now() - t0), what: what ? `${what} (${k})` : k });
      }
    };
    read('before tray');
    const timer = setInterval(() => read(null), 10);
    const icon = trayExperiment.nativeImage.createFromPath(path.join(ROOT, 'build', 'icon.png')).resize({ width: 32, height: 32 });
    const trayIcon = new trayExperiment.Tray(icon);
    trayIcon.setToolTip('taskbar-probe');
    read('tray created');
    await sleep(8000);
    read('destroying tray');
    trayIcon.destroy();
    await sleep(3000);
    clearInterval(timer);
    read('end');
    notes.trayExperiment = tl.slice(0, 200);
  }

  // --- 6. teardown --------------------------------------------------------------------------
  const removal = [];
  for (const o of overlays) {
    const removed = shell.beforeDestroy(o.win, o.displayId);
    removal.push({ displayId: o.displayId, removed, propAfter: propOf(o.hwnd) });
    o.win.destroy();
  }
  check('teardown.nonRudeRemovedBeforeDestroy', removal.every((r) => r.removed === true && r.propAfter === 0), removal);
  await sleep(500);
  const end = { topmost: topmostOf(tray), hit: hitsTray() };
  notes.afterTeardown = end;
  if (conclusive) check('teardown.taskbarTopmost', end.topmost === true && end.hit === true, end);
  tracker.stop();
  ds.dispose();

  const problems = logEntries.filter((e) => e.level === 'error' || (e.level === 'warn' && e.msg !== 'taskbar edge from geometry disagrees with SHAppBarMessage; using geometry'));
  check('logs.noWarningsOrErrors', problems.length === 0, problems.length ? problems.map((e) => `${e.scope}: ${e.msg} ${JSON.stringify(e.data ?? {})}`) : undefined);
  notes.trackerLog = logEntries.filter((e) => e.scope.includes('tracker') && e.level !== 'debug').map((e) => ({ level: e.level, msg: e.msg, data: e.data }));
  notes.conclusive = conclusive;
  notes.mouseNeverMoved = 'the probe sends no input; the cursor position is only read (GetCursorPos)';

  const ok = Object.values(checks).every((c) => c.ok);
  return { ok, checks, notes };
}
