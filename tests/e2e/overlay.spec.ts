import type { ElectronApplication } from '@playwright/test';
import type { Logger } from '../../src/main/contracts';
import type { TaskbarEdge } from '../../src/shared/surfaces';
import { loadWin32Native } from '../../src/main/win32/native';
import { createTaskbarTracker } from '../../src/main/win32/taskbar';
import { expect, hook, launchApp, quitApp, readLogLines, test, waitForCat } from './fixtures';
import { win32Probe, WS_EX_NOACTIVATE, WS_EX_TOOLWINDOW, WS_EX_TOPMOST, WS_EX_TRANSPARENT } from './win32Probe';

const center = (r: { x: number; y: number; width: number; height: number }) => ({ x: r.x + r.width / 2, y: r.y + r.height / 2 });
type PxRect = { x: number; y: number; width: number; height: number };

/** Logger for the test-process tracker: warnings and errors are collected and asserted on. */
function collectingLogger(problems: string[], scope = 'e2e'): Logger {
  return {
    error: (msg) => problems.push(`${scope} error: ${msg}`),
    warn: (msg) => problems.push(`${scope} warn: ${msg}`),
    info: () => undefined,
    debug: () => undefined,
    child: (c) => collectingLogger(problems, `${scope}.${c}`),
  };
}

interface TaskbarWatch {
  /** Changes of the primary taskbar's live rect (and marks), ms since the watch started. */
  timeline: Array<{ t: number; what: string }>;
  /** Positions of its inner edge seen along the docked axis: one value while it never moved. */
  positions: Set<number>;
  /** The cursor was in the auto-hide reveal zone (the user may have revealed it). */
  cursorAtEdge: boolean;
  mark(what: string): void;
  stop(): void;
}

/**
 * Samples the primary taskbar's live window rect and the cursor (REAL GetWindowRect/GetCursorPos,
 * under a microsecond each) every 10 ms: shows when, if ever, the taskbar moved. Reads only.
 * `zone` is the band (px) along the monitor side in which a cursor counts as revealing the taskbar.
 */
function watchTaskbar(tray: bigint, monitor: PxRect, edge: TaskbarEdge, zone: number): TaskbarWatch {
  const n = loadWin32Native();
  const t0 = performance.now();
  const w: TaskbarWatch = { timeline: [], positions: new Set(), cursorAtEdge: false, mark: () => undefined, stop: () => undefined };
  let last = '';
  const read = (): void => {
    const c = n.getCursorPos();
    if (c && c.x >= monitor.x && c.x < monitor.x + monitor.width && c.y >= monitor.y && c.y < monitor.y + monitor.height) {
      const d = { bottom: monitor.y + monitor.height - 1 - c.y, top: c.y - monitor.y, left: c.x - monitor.x, right: monitor.x + monitor.width - 1 - c.x }[edge];
      if (d <= zone) w.cursorAtEdge = true;
    }
    const r = n.getWindowRect(tray);
    if (r !== null) w.positions.add(edge === 'left' || edge === 'right' ? r.left : r.top);
    const k = r === null ? 'unreadable' : `left=${r.left} top=${r.top} right=${r.right} bottom=${r.bottom}`;
    if (k !== last && w.timeline.length < 200) {
      last = k;
      w.timeline.push({ t: Math.round(performance.now() - t0), what: k });
    }
  };
  read();
  const timer = setInterval(read, 10);
  w.mark = (what) => {
    read();
    w.timeline.push({ t: Math.round(performance.now() - t0), what });
  };
  w.stop = () => clearInterval(timer);
  return w;
}

/** The outermost pixel row/column of a monitor side: the auto-hide reveal strip. */
function revealPoint(monitor: PxRect, edge: string): { x: number; y: number } {
  const midX = Math.round(monitor.x + monitor.width / 2);
  const midY = Math.round(monitor.y + monitor.height / 2);
  if (edge === 'bottom') return { x: midX, y: monitor.y + monitor.height - 1 };
  if (edge === 'top') return { x: midX, y: monitor.y };
  if (edge === 'left') return { x: monitor.x, y: midY };
  return { x: monitor.x + monitor.width - 1, y: midY };
}

async function cursorOverCat(app: ElectronApplication): Promise<boolean> {
  const out = await hook(app, 'getSimOutput');
  const cursor = await app.evaluate(({ screen }) => screen.dipToScreenPoint(screen.getCursorScreenPoint()));
  if (!out) return false;
  const b = out.boundsPx;
  return cursor.x >= b.x - 20 && cursor.x <= b.x + b.width + 20 && cursor.y >= b.y - 20 && cursor.y <= b.y + b.height + 20;
}

test.describe('overlay windows', () => {
  test('one transparent, non-focusable, topmost, click-through overlay per display', async ({ userData }) => {
    const app = await launchApp(userData);
    try {
      await waitForCat(app);
      const displays = await app.evaluate(({ screen }) => screen.getAllDisplays().map((d) => ({ id: String(d.id), workArea: d.workArea })));
      const overlays = await hook(app, 'getOverlays');
      expect(overlays).toHaveLength(displays.length);
      const overCat = await cursorOverCat(app);
      const probe = win32Probe();
      for (const o of overlays) {
        const d = displays.find((x) => x.id === o.displayId);
        expect(d, `display for overlay ${o.displayId}`).toBeTruthy();
        expect(o.bounds).toEqual(d!.workArea);
        expect(o.visible).toBe(true);
        expect(o.focusable).toBe(false);
        expect(o.alwaysOnTop).toBe(true);
        expect(o.backgroundColor.toLowerCase()).toMatch(/^#0{6}(00)?$|^#00000000$/);
        if (!overCat) expect(o.ignoreMouse).toBe(true);
        const ex = probe.exStyle(o.hwnd);
        expect(ex & WS_EX_TOOLWINDOW, 'hidden from Alt-Tab').toBe(WS_EX_TOOLWINDOW);
        expect(ex & WS_EX_NOACTIVATE, 'never takes focus').toBe(WS_EX_NOACTIVATE);
        expect(ex & WS_EX_TOPMOST, 'topmost').toBe(WS_EX_TOPMOST);
        if (!overCat) expect(ex & WS_EX_TRANSPARENT, 'click-through').toBe(WS_EX_TRANSPARENT);
      }
      // Overlay windows are bundled pages on our scheme only.
      const urls = app.windows().map((p) => p.url());
      for (const u of urls) expect(u.startsWith('desktop-cat://app/renderer/')).toBe(true);
    } finally {
      await quitApp(app);
    }
  });

  test('OS hit-testing passes through the overlay except where the cat is interactive', async ({ userData }) => {
    const app = await launchApp(userData);
    try {
      await waitForCat(app);
      await expect.poll(async () => (await hook(app, 'getSimOutput'))?.visible ?? false, { timeout: 20_000 }).toBe(true);
      const out = (await hook(app, 'getSimOutput'))!;
      const overlays = await hook(app, 'getOverlays');
      const ours = new Set(overlays.map((o) => o.hwnd));
      const home = overlays.find((o) => o.displayId === out.displayId) ?? overlays.find((o) => o.active)!;
      const probe = win32Probe();

      // A point on the cat's overlay far away from the cat.
      const cat = center(out.boundsPx);
      const b = home.boundsPx;
      const far = { x: cat.x < b.x + b.width / 2 ? b.x + b.width - 30 : b.x + 30, y: cat.y < b.y + b.height / 2 ? b.y + b.height - 30 : b.y + 30 };
      await hook(app, 'forceInteractive', false);
      await expect.poll(() => ours.has(probe.rootWindowAt(far.x, far.y) ?? '')).toBe(false);
      await expect.poll(() => ours.has(probe.rootWindowAt(cat.x, cat.y) ?? '')).toBe(false);

      await hook(app, 'forceInteractive', true);
      await expect.poll(() => ours.has(probe.rootWindowAt(cat.x, cat.y) ?? '')).toBe(true);
      await expect.poll(() => probe.rootWindowAt(far.x, far.y)).toBe(home.hwnd);
      await expect.poll(async () => (await hook(app, 'getOverlays')).every((o) => !o.ignoreMouse)).toBe(true);

      await hook(app, 'forceInteractive', null);
      // Back to routing: far from the cat the desktop underneath receives the mouse again.
      await expect.poll(() => ours.has(probe.rootWindowAt(far.x, far.y) ?? '')).toBe(false);
    } finally {
      await quitApp(app);
    }
  });

  test('live overlay renderers keep their heartbeat: never flagged as hung or recreated', async ({ userData }) => {
    const app = await launchApp(userData);
    try {
      await waitForCat(app);
      await expect.poll(async () => (await hook(app, 'getSimOutput'))?.visible ?? false, { timeout: 20_000 }).toBe(true);
      const before = await hook(app, 'getOverlays');
      // Longer than the watchdog's silence limit plus its recreate grace period.
      for (let i = 0; i < 10; i++) {
        await new Promise((r) => setTimeout(r, 1000));
        for (const o of await hook(app, 'getOverlays')) expect(o.healthy, `overlay ${o.displayId} at ${i + 1} s`).toBe(true);
      }
      const after = await hook(app, 'getOverlays');
      expect(after.map((o) => [o.displayId, o.webContentsId, o.crashes])).toEqual(before.map((o) => [o.displayId, o.webContentsId, 0]));
      expect(readLogLines(userData).filter((l) => l.m.includes('hung'))).toEqual([]);
    } finally {
      await quitApp(app);
    }
  });

  test('a hung overlay renderer is made click-through and then recreated', async ({ userData }) => {
    const app = await launchApp(userData);
    try {
      await waitForCat(app);
      await expect.poll(async () => (await hook(app, 'getSimOutput'))?.visible ?? false, { timeout: 20_000 }).toBe(true);
      const out = (await hook(app, 'getSimOutput'))!;
      const overlays = await hook(app, 'getOverlays');
      const home = overlays.find((o) => o.displayId === out.displayId && o.active) ?? overlays.find((o) => o.active)!;
      const page = app.windows().find((p) => p.url().includes(`display=${encodeURIComponent(home.displayId)}`))!;
      expect(page, 'page of the overlay showing the cat').toBeTruthy();
      // Wedge the overlay's main thread for good (the promise never settles).
      void page.evaluate(() => {
        for (;;) {
          // spin
        }
      }).catch(() => undefined);
      const find = async () => (await hook(app, 'getOverlays')).find((o) => o.displayId === home.displayId);
      await expect.poll(async () => { const o = await find(); return o ? o.webContentsId !== home.webContentsId || (!o.healthy && o.ignoreMouse) : false; }, { timeout: 10_000 }).toBe(true);
      await expect.poll(async () => { const o = await find(); return o !== undefined && o.webContentsId !== home.webContentsId && o.ready && o.healthy; }, { timeout: 30_000 }).toBe(true);
      expect((await find())!.crashes).toBeGreaterThanOrEqual(1);
      expect(readLogLines(userData).some((l) => l.m.includes('overlay renderer hung'))).toBe(true);
    } finally {
      await quitApp(app);
    }
  });

  // ADR 0002 §2: without NonRudeHWND the full-monitor transparent topmost overlay counts as a
  // fullscreen ("rude") app and Windows strips WS_EX_TOPMOST from Shell_TrayWnd within ~60 ms
  // (measured; scripts/taskbar-probe.mjs --control reproduces it), so an auto-hidden taskbar can no
  // longer be revealed through its edge strip. REAL Win32 oracle in the test process; the test-process
  // tracker is the production createTaskbarTracker over the real shell (the app's own instance is
  // checked through its test hooks below). No input is sent: the cursor position is only read.
  // Second launch on purpose: on a first run the welcome window opens without activation (the app is
  // started by a background process), its taskbar button flashes and Windows keeps an auto-hidden
  // taskbar revealed until it is clicked (measured with scripts/taskbar-probe.mjs --app).
  test('overlays keep the taskbar topmost and its reveal strip hit-testable; the real tracker sees it', async ({ userData }) => {
    test.setTimeout(90_000);
    const probe = win32Probe(); // first: makes this thread per-monitor-v2 (physical px) for the tracker too
    const problems: string[] = [];
    const tracker = createTaskbarTracker(collectingLogger(problems));
    expect(tracker.available).toBe(true);
    tracker.start();
    const dbg = tracker.debugInfo() as { taskbars: Array<{ id: string; primary: boolean; monitor: PxRect; edgeMismatch: boolean }> };
    const primaryDbg = dbg.taskbars.find((t) => t.primary);
    test.skip(primaryDbg === undefined, 'no Explorer taskbar in this session');
    const primary = tracker.taskbars().find((t) => t.id === primaryDbg!.id)!;
    const monitor = primaryDbg!.monitor;
    expect(loadWin32Native().getClassName(BigInt(primary.id))).toBe('Shell_TrayWnd');
    expect(primaryDbg!.edgeMismatch).toBe(false);
    const thickness = primary.edge === 'top' || primary.edge === 'bottom' ? primary.dockedRect.height : primary.dockedRect.width;
    // Sampled like the app's host does: at the delay it asks for, with the real cursor position.
    const native = loadWin32Native();
    const t0 = performance.now();
    const events: string[] = [];
    let sampling = true;
    const sampleLoop = (): void => {
      if (!sampling || performance.now() - t0 > 90_000) return; // also ends if a launch below throws
      const delay = tracker.sample(performance.now(), native.getCursorPos(), false);
      for (const ev of tracker.drainEvents()) events.push(`${Math.round(performance.now() - t0)}ms ${ev.type}`);
      setTimeout(sampleLoop, delay);
    };
    sampleLoop();

    const first = await launchApp(userData);
    try {
      await waitForCat(first);
      expect((await hook(first, 'patchSettings', { general: { firstRunCompleted: true } })).ok).toBe(true);
    } finally {
      await quitApp(first);
    }
    // A taskbar revealed by the first run's welcome window slides back within ~0.5 s of the exit.
    await new Promise((r) => setTimeout(r, 1500));
    events.push(`${Math.round(performance.now() - t0)}ms second launch`);

    const watch = watchTaskbar(BigInt(primary.id), monitor, primary.edge, thickness + 16);
    const app = await launchApp(userData);
    watch.mark('launched');
    try {
      await waitForCat(app);
      watch.mark('cat ready');
      expect(app.windows().some((p) => p.url().includes('/renderer/settings/')), 'no welcome window on the second run').toBe(false);
      const overlays = await hook(app, 'getOverlays');
      for (const o of overlays) expect(o.nonRude, `NonRudeHWND on overlay ${o.displayId}`).toBe(true);
      await hook(app, 'forceInteractive', false); // every overlay fully click-through

      // Topmost and hit-tested for 1.5 s with the app's overlays up (the rude detection acts in ~60 ms).
      const strip = revealPoint(monitor, primary.edge);
      for (let i = 0; i < 30; i++) {
        expect(probe.exStyle(primary.id) & WS_EX_TOPMOST, `taskbar WS_EX_TOPMOST at sample ${i}`).toBe(WS_EX_TOPMOST);
        expect(probe.rootWindowAt(strip.x, strip.y), `reveal strip ${strip.x},${strip.y} hits the taskbar at sample ${i}`).toBe(primary.id);
        await new Promise((r) => setTimeout(r, 50));
      }

      // Auto-hide agrees with Electron's work area; on this machine (auto-hide at the bottom) it stays hidden.
      const area = await app.evaluate(({ screen }) => {
        const d = screen.getPrimaryDisplay();
        return { bounds: screen.dipToScreenRect(null, d.bounds), work: screen.dipToScreenRect(null, d.workArea) };
      });
      const b = area.bounds;
      const w = area.work;
      const reaches = { bottom: w.y + w.height >= b.y + b.height, top: w.y <= b.y, left: w.x <= b.x, right: w.x + w.width >= b.x + b.width }[primary.edge];
      expect(primary.autoHide).toBe(reaches);
      const now = tracker.taskbars().find((t) => t.id === primary.id)!;
      watch.mark(`tracker: ${now.phase} ${now.shownFraction.toFixed(3)}`);
      const state = JSON.stringify({ taskbar: now, timeline: watch.timeline, events });
      if (now.autoHide && watch.cursorAtEdge) {
        test.info().annotations.push({ type: 'taskbar', description: 'the cursor was at the auto-hide edge (the user may have revealed the taskbar): hidden phase not asserted' });
      } else if (now.autoHide) {
        // The running app (overlays, tray icon, hooks) never reveals an auto-hidden taskbar by itself.
        expect([...watch.positions], `the taskbar never moved while the app ran: ${state}`).toHaveLength(1);
        expect(now.phase, state).toBe('hidden');
        expect(now.shownFraction, state).toBeLessThan(0.1);
        expect(tracker.surfaces()).toEqual([]);
        const second = events.findIndex((e) => e.endsWith('second launch'));
        expect(events.slice(second + 1), `no taskbar.shown/hidden during the second run: ${state}`).toEqual([]);
      } else {
        expect(now.phase, state).toBe('shown');
        expect(tracker.surfaces()).toEqual([]); // a docked taskbar is the work-area floor, not a ledge
      }
      expect(problems).toEqual([]);
      await hook(app, 'forceInteractive', null);
    } finally {
      sampling = false;
      tracker.stop();
      await quitApp(app);
      watch.mark('quit');
      watch.stop();
      test.info().annotations.push({ type: 'taskbar timeline', description: JSON.stringify(watch.timeline) });
      test.info().annotations.push({ type: 'taskbar events', description: JSON.stringify(events) });
    }
  });

  test("the app's own taskbar tracker is running and reports the taskbar", async ({ userData }) => {
    const app = await launchApp(userData);
    try {
      await waitForCat(app);
      await expect.poll(async () => (await hook(app, 'getSurfaceStatus')).taskbar, { timeout: 10_000 }).toBe('tracked');
      expect((await hook(app, 'getSurfaceStatus')).taskbars).toBeGreaterThanOrEqual(1);
      // An auto-hidden taskbar (this machine) is no ledge while hidden; a docked one never is.
      const surfaces = await hook(app, 'getSurfaces');
      for (const s of surfaces.filter((x) => x.kind === 'taskbar')) {
        expect(s.orientation).toBe('ledge');
        expect(s.id).toMatch(/^taskbar:\d+$/);
      }
      expect(readLogLines(userData).some((l) => l.m === 'taskbars discovered')).toBe(true);
    } finally {
      await quitApp(app);
    }
  });

  test('interactions disabled keeps every overlay click-through even when forced routing is off', async ({ userData }) => {
    const app = await launchApp(userData);
    try {
      await waitForCat(app);
      expect((await hook(app, 'patchSettings', { interaction: { enabled: false } })).ok).toBe(true);
      await expect.poll(async () => (await hook(app, 'getOverlays')).every((o) => o.ignoreMouse)).toBe(true);
      expect((await hook(app, 'getStatus')).interactionsEnabled).toBe(false);
    } finally {
      await quitApp(app);
    }
  });
});
