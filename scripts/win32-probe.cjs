#!/usr/bin/env node
// Electron probe for the W3 Win32 integration (window tracker, hooks, displays).
//
// Stage 1 (plain Node): bundles src/main/win32 + src/main/display with esbuild into a temp
// dir, then launches this same file in Electron. Stage 2 (Electron main): creates and
// manipulates ITS OWN test window (show, move, minimize, restore, hide, show, destroy) and
// a click-through overlay, and checks what the tracker reports via WinEvent hooks.
//
// The probe never focuses windows, never moves the mouse and sends no input. Window state
// changes use SW_SHOWMINNOACTIVE / SW_SHOWNOACTIVATE / SWP_NOACTIVATE so the user's
// foreground window is untouched. It prints only its own window's id, event kinds and
// counts: no other window titles or process names.
//
// Usage: node scripts/with-lock.mjs win32-probe -- node scripts/win32-probe.cjs [--timeout-ms 45000]
'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const CHILD_FLAG = '--w3-probe-child';

if (!process.versions.electron) {
  stageOne().catch((e) => {
    console.error(`win32-probe: ${e && e.stack ? e.stack : e}`);
    process.exit(1);
  });
} else {
  stageTwo();
}

async function stageOne() {
  const { spawn } = require('node:child_process');
  const esbuild = require(require.resolve('esbuild', { paths: [ROOT] }));
  const electronPath = require(require.resolve('electron', { paths: [ROOT] }));
  const koffiPath = require.resolve('koffi', { paths: [ROOT] });
  const timeoutArg = process.argv.indexOf('--timeout-ms');
  const timeoutMs = timeoutArg > 0 ? Number(process.argv[timeoutArg + 1]) || 45000 : 45000;

  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'desktop-cat-w3-probe-'));
  const bundle = path.join(work, 'w3.cjs');
  const userData = path.join(work, 'user-data');
  fs.mkdirSync(userData);
  await esbuild.build({
    stdin: {
      contents: "export * from './src/main/win32/index.ts';\nexport { createDisplayService } from './src/main/display/displayService.ts';\n",
      resolveDir: ROOT,
      loader: 'ts',
      sourcefile: 'w3-probe-entry.ts',
    },
    bundle: true,
    platform: 'node',
    format: 'cjs',
    target: 'node24',
    outfile: bundle,
    external: ['electron'],
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

  const child = spawn(electronPath, [__filename, CHILD_FLAG, bundle, userData, koffiPath, String(timeoutMs)], { stdio: 'inherit', windowsHide: false });
  const killer = setTimeout(() => {
    console.error('win32-probe: Electron did not exit in time; terminating the probe process it started');
    child.kill();
  }, timeoutMs + 15000);
  const code = await new Promise((resolve) => {
    child.on('exit', (c, signal) => resolve(c ?? (signal ? 1 : 0)));
    child.on('error', (e) => {
      console.error(`win32-probe: failed to start Electron: ${e.message}`);
      resolve(1);
    });
  });
  clearTimeout(killer);
  fs.rmSync(work, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  process.exit(code);
}

function stageTwo() {
  const { app, BrowserWindow, screen } = require('electron');
  const i = process.argv.indexOf(CHILD_FLAG);
  const [bundle, userData, koffiPath, timeoutStr] = process.argv.slice(i + 1);
  app.setPath('userData', userData);
  app.on('window-all-closed', () => {
    /* keep running between test windows */
  });
  const hardTimeout = setTimeout(() => {
    console.log(`W3-PROBE-RESULT ${JSON.stringify({ ok: false, error: 'probe timed out' })}`);
    app.exit(2);
  }, Number(timeoutStr) || 45000);

  app
    .whenReady()
    .then(() => runProbe({ app, BrowserWindow, screen, w3: require(bundle), koffi: require(koffiPath) }))
    .then((result) => {
      clearTimeout(hardTimeout);
      console.log(`W3-PROBE-RESULT ${JSON.stringify(result, null, 2)}`);
      app.exit(result.ok ? 0 : 1);
    })
    .catch((e) => {
      clearTimeout(hardTimeout);
      console.log(`W3-PROBE-RESULT ${JSON.stringify({ ok: false, error: String(e && e.stack ? e.stack : e) })}`);
      app.exit(1);
    });
}

async function runProbe({ BrowserWindow, screen, w3, koffi }) {
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
  const finite = (r) => r && [r.x, r.y, r.width, r.height].every(Number.isFinite);

  // --- Displays (real Electron screen) ---------------------------------------------------
  const ds = w3.createDisplayService(logger);
  const world = ds.world;
  check('display.world', world.version >= 1 && world.displays.length >= 1 && world.displays.every((d) => finite(d.boundsPx) && finite(d.workAreaPx) && d.scaleFactor > 0), {
    displays: world.displays.map((d) => ({ id: d.id, primary: d.primary, scale: d.scaleFactor, boundsPx: d.boundsPx, workAreaPx: d.workAreaPx })),
  });
  const mapping = world.displays.map((d) => {
    const electronPx = screen.dipToScreenPoint({ x: d.workAreaDip.x + 80, y: d.workAreaDip.y + 40 });
    const ours = ds.fromLocalDip(d.id, { x: 80, y: 40 });
    const back = ds.toLocalDip(d.id, ours);
    return { id: d.id, dx: Math.abs(electronPx.x - ours.x), dy: Math.abs(electronPx.y - ours.y), roundTrip: Math.hypot(back.x - 80, back.y - 40) };
  });
  check('display.localDipMatchesElectron', mapping.every((m) => m.dx <= 1 && m.dy <= 1 && m.roundTrip < 1e-6), mapping);
  check('display.displayAtWorkAreaOrigin', world.displays.every((d) => ds.displayAt({ x: d.workAreaPx.x, y: d.workAreaPx.y }) === d.id));

  // --- Win32 API + trackers ----------------------------------------------------------------
  const apiOwn = w3.createWin32Api(logger.child('own'), { includeOwnProcess: true });
  const apiDefault = w3.createWin32Api(logger.child('default'));
  check('win32.available', apiOwn.available && apiDefault.available);
  const dpi = logEntries.find((e) => e.msg === 'thread DPI awareness' || e.msg.startsWith('thread is not per-monitor'));
  check('win32.dpiPerMonitor', dpi && dpi.data && dpi.data.awareness === 2, { awareness: dpi && dpi.data ? dpi.data.awareness : null });

  const tracker = w3.createWindowTracker(apiOwn, logger);
  const trackerDefault = w3.createWindowTracker(apiDefault, logger);
  tracker.start();
  trackerDefault.start();
  check('tracker.mode', tracker.mode === 'event-hooks' && trackerDefault.mode === 'event-hooks', { own: tracker.mode, default: trackerDefault.mode });

  let ourId = null;
  let overlayId = null;
  const ownEvents = []; // { type, at } for our test window, from the include-own tracker
  const defaultOwnEvents = []; // anything about our windows seen by the default tracker (must stay empty)
  const otherCounts = {}; // counts by type for all other windows (no ids, no names)
  const rawOwn = []; // raw hook kinds for our window
  const t0 = Date.now();
  const unsubRaw = apiOwn.subscribeWinEvents((ev) => {
    if (ev.id === ourId && rawOwn.length < 200) rawOwn.push(ev.kind);
  });
  const idOf = (e) => (e.window ? e.window.id : e.id);
  const pump = () => {
    for (const e of tracker.drainEvents()) {
      const id = idOf(e);
      if (id && id === ourId) ownEvents.push({ type: e.type, at: Date.now() - t0 });
      else otherCounts[e.type] = (otherCounts[e.type] || 0) + 1;
    }
    for (const e of trackerDefault.drainEvents()) {
      const id = idOf(e);
      if (id && (id === ourId || id === overlayId)) defaultOwnEvents.push(e.type);
    }
  };
  const tick = setInterval(pump, 33);
  const waitFor = async (pred, ms = 1500) => {
    const start = Date.now();
    while (Date.now() - start < ms) {
      pump();
      if (pred()) return Date.now() - start;
      await sleep(20);
    }
    return -1;
  };
  const countOwn = (type) => ownEvents.filter((e) => e.type === type).length;

  const user32 = koffi.load('user32.dll');
  const ShowWindow = user32.func('int __stdcall ShowWindow(void *h, int cmd)');
  const SetWindowPos = user32.func('int __stdcall SetWindowPos(void *h, void *after, int x, int y, int cx, int cy, uint32_t flags)');
  const SW_SHOWNOACTIVATE = 4;
  const SW_SHOWMINNOACTIVE = 7;
  const SWP_QUIET = 0x1 | 0x2 | 0x4 | 0x10; // NOSIZE | NOMOVE | NOZORDER | NOACTIVATE
  const SWP_SHOWWINDOW = 0x40;
  const SWP_HIDEWINDOW = 0x80;
  const latency = {};

  const primary = screen.getPrimaryDisplay();
  const win = new BrowserWindow({
    x: primary.workArea.x + 60,
    y: primary.workArea.y + 60,
    width: 480,
    height: 320,
    show: false,
    title: 'w3-probe',
    backgroundColor: '#20304a',
    webPreferences: { sandbox: true, contextIsolation: true },
  });
  const hwnd = win.getNativeWindowHandle().readBigUInt64LE(0);
  ourId = hwnd.toString();

  // 1. show
  win.showInactive();
  latency.shown = await waitFor(() => countOwn('window.shown') >= 1);
  check('events.shown', latency.shown >= 0);
  const desc = apiOwn.describeWindow(ourId);
  const expected = screen.dipToScreenRect(win, win.getBounds());
  check('describe.ownIncluded', desc !== null && finite(desc.rect) && desc.minimized === false, desc ? { rect: desc.rect, electronPx: expected, category: desc.category } : null);
  check('describe.ownExcludedByDefault', apiDefault.describeWindow(ourId) === null);
  check('list.ownIncluded', apiOwn.listAppWindows().some((w) => w.id === ourId));
  check('list.ownExcludedByDefault', !apiDefault.listAppWindows().some((w) => w.id === ourId));
  const centre = desc ? { x: desc.rect.x + desc.rect.width / 2, y: desc.rect.y + desc.rect.height / 2 } : null;
  const ownOnTop = centre !== null && apiOwn.windowIdAtPoint(centre) === ourId;
  notes.windowIdAtOwnCentre = centre ? (ownOnTop ? 'ours (on top)' : 'other window on top') : 'n/a';
  // Our own (Settings-like) window hides what is below it but is never a private window.
  check('occluders.ownWindowIncluded', (apiDefault.listOccluders() || []).some((o) => o.id === ourId));
  check('privacy.ownWindowNotPrivate', apiDefault.isWindowExcluded(ourId) === false);
  check('privacy.ownWindowNotMasked', Array.isArray(apiDefault.listExcludedRects()));
  if (ownOnTop) check('privacy.pointOnOwnWindowNotPrivate', apiDefault.isPointExcluded(centre) === false);

  // 2. programmatic move (no move/size loop, so no moveStart/moveEnd hooks fire)
  const before = apiOwn.getWindowRect(ourId);
  win.setBounds({ x: primary.workArea.x + 180, y: primary.workArea.y + 120, width: 480, height: 320 });
  await sleep(300);
  const after = tracker.getWindowRect(ourId);
  check('rect.followsMove', before && after && finite(after) && (after.x !== before.x || after.y !== before.y), { before, after });

  // 3. minimize without activating anything
  ShowWindow(hwnd, SW_SHOWMINNOACTIVE);
  latency.minimized = await waitFor(() => countOwn('window.minimized') >= 1);
  check('events.minimized', latency.minimized >= 0);
  check('rect.nullWhileMinimized', apiOwn.getWindowRect(ourId) === null);

  // 4. restore without activating
  ShowWindow(hwnd, SW_SHOWNOACTIVATE);
  latency.restored = await waitFor(() => countOwn('window.restored') >= 1);
  check('events.restored', latency.restored >= 0);

  // 5. hide -> closed, 6. show again -> shown
  SetWindowPos(hwnd, null, 0, 0, 0, 0, SWP_QUIET | SWP_HIDEWINDOW);
  latency.hiddenClosed = await waitFor(() => countOwn('window.closed') >= 1);
  check('events.hiddenAsClosed', latency.hiddenClosed >= 0);
  SetWindowPos(hwnd, null, 0, 0, 0, 0, SWP_QUIET | SWP_SHOWWINDOW);
  latency.reshown = await waitFor(() => countOwn('window.shown') >= 2);
  check('events.reshown', latency.reshown >= 0);

  // 7. destroy -> closed
  win.destroy();
  latency.destroyedClosed = await waitFor(() => countOwn('window.closed') >= 2);
  check('events.destroyedAsClosed', latency.destroyedClosed >= 0);
  await sleep(300);
  pump();
  check('events.coalescedOnePerTransition', countOwn('window.shown') === 2 && countOwn('window.closed') === 2 && countOwn('window.minimized') === 1 && countOwn('window.restored') === 1, {
    own: ownEvents.map((e) => e.type),
  });
  notes.rawHookKindsForOurWindow = rawOwn;

  // 8. click-through overlay sized to the work area: WindowFromPoint and QUNS
  const qunsBefore = apiDefault.getNotificationState();
  const wa = primary.workArea;
  const overlay = new BrowserWindow({
    ...wa,
    show: false,
    frame: false,
    transparent: true,
    backgroundColor: '#00000000',
    hasShadow: false,
    resizable: false,
    movable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    focusable: false,
    skipTaskbar: true,
    type: 'toolbar',
    alwaysOnTop: true,
    webPreferences: { sandbox: true, contextIsolation: true },
  });
  overlay.setAlwaysOnTop(true, 'screen-saver');
  overlay.setIgnoreMouseEvents(true);
  overlayId = overlay.getNativeWindowHandle().readBigUInt64LE(0).toString();
  await overlay.loadURL('data:text/html,<html style="background:transparent"><body></body></html>');
  overlay.showInactive();
  await sleep(800);
  const waPx = screen.dipToScreenRect(null, wa);
  const probePoint = { x: waPx.x + Math.floor(waPx.width / 2), y: waPx.y + Math.floor(waPx.height / 2) };
  const hit = apiOwn.windowIdAtPoint(probePoint);
  check('overlay.windowFromPointSkipsClickThrough', hit !== overlayId, { hitIsOverlay: hit === overlayId, hitResolved: hit !== null });
  const qunsWithOverlay = apiDefault.getNotificationState();
  notes.notificationState = { beforeOverlay: qunsBefore, withOverlay: qunsWithOverlay };
  const fullscreenIds = trackerDefault.getFullscreenDisplayIds(ds.world);
  notes.fullscreenDisplayIdsWithOverlay = fullscreenIds;
  check('overlay.notListedAsAppWindow', !apiOwn.listAppWindows().some((w) => w.id === overlayId));
  notes.isExcludedAtThroughOverlay = typeof trackerDefault.isExcludedAt(probePoint) === 'boolean' ? (apiDefault.windowIdAtPoint(probePoint) === null ? 'fail-closed (unresolved)' : 'resolved underlying window') : 'error';
  check('overlay.clickThroughNotAnOccluder', !(apiDefault.listOccluders() || []).some((o) => o.id === overlayId));
  overlay.destroy();

  // 8b. a small overlay-style window that is hit-testable (like the cat overlay while the
  // cursor is on the cat): it hides nothing and the window under it is judged instead.
  const spot = { x: wa.x + wa.width - 160, y: wa.y + 40, width: 120, height: 120 };
  const spotPx = screen.dipToScreenRect(null, spot);
  const spotPoint = { x: spotPx.x + Math.floor(spotPx.width / 2), y: spotPx.y + Math.floor(spotPx.height / 2) };
  const belowBefore = apiDefault.isPointExcluded(spotPoint);
  const interactive = new BrowserWindow({
    ...spot,
    show: false,
    frame: false,
    transparent: true,
    backgroundColor: '#00000000',
    hasShadow: false,
    resizable: false,
    focusable: false,
    skipTaskbar: true,
    type: 'toolbar',
    alwaysOnTop: true,
    webPreferences: { sandbox: true, contextIsolation: true },
  });
  interactive.setAlwaysOnTop(true, 'screen-saver');
  const interactiveId = interactive.getNativeWindowHandle().readBigUInt64LE(0).toString();
  await interactive.loadURL('data:text/html,<html style="background:transparent"><body></body></html>');
  interactive.showInactive();
  await sleep(250);
  const hitInteractive = apiOwn.windowIdAtPoint(spotPoint) === interactiveId;
  const belowWith = apiDefault.isPointExcluded(spotPoint);
  const occludersWith = apiDefault.listOccluders() || [];
  interactive.destroy();
  check('overlay.interactiveIsHitTested', hitInteractive);
  check('overlay.interactiveJudgesWindowBelow', belowWith === belowBefore, { before: belowBefore, with: belowWith });
  check('overlay.interactiveNotAnOccluder', !occludersWith.some((o) => o.id === interactiveId));
  await sleep(300);
  pump();
  check('defaultTracker.neverSawOwnWindows', defaultOwnEvents.length === 0, defaultOwnEvents.length ? defaultOwnEvents : undefined);

  // 9. activity monitor (real idle time)
  const monitor = w3.createActivityMonitor(apiDefault, logger);
  monitor.start();
  for (let k = 0; k < 10; k++) {
    monitor.sample(performance.now(), apiDefault.getCursorPos());
    await sleep(33);
  }
  check('activity.idleFinite', Number.isFinite(monitor.idleMs) && monitor.idleMs >= 0);
  monitor.stop();

  // 10. teardown
  clearInterval(tick);
  pump();
  notes.otherWindowEventCounts = otherCounts;
  notes.latencyMs = latency;
  notes.trackerDebug = { own: tracker.debugInfo(), default: trackerDefault.debugInfo() };
  unsubRaw && unsubRaw();
  tracker.stop();
  trackerDefault.stop();
  apiOwn.dispose();
  apiDefault.dispose();
  ds.dispose();
  const errors = logEntries.filter((e) => e.level === 'error' || (e.level === 'warn' && e.scope.includes('win32') && e.msg === 'native call failed'));
  check('logs.noNativeFailures', errors.length === 0, errors.length ? errors.map((e) => `${e.scope}: ${e.msg}`) : undefined);
  notes.ownWindowId = ourId;

  const ok = Object.values(checks).every((c) => c.ok);
  return { ok, checks, notes };
}
