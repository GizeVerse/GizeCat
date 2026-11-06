// GizeCat web host entry point (bundled to out/web/main.js; ADR 0004 §8). Composes the real cat in
// the browser viewport: createCatSim and createCatHost, the real overlay renderer (OverlayRuntime)
// over an in-page OverlayApi, the real gesture recognizer behind the page's pointer router, and the
// renderMapping rules, on one logical display (the viewport). The cat walks on the bottom of the
// viewport only: no window surfaces, taskbars or perception; the window tracker and activity
// monitor run on the unavailable Win32 stand-in (never win32/index.ts or native.ts, which reach
// koffi), with idle time taken from the page's own pointer events (never key events).
// First: configures zod before any schema is built (see zodConfig.ts).
import './zodConfig';
import { createCatSim } from '../core/behavior';
import { simWorld } from '../core/display/simWorld';
import { createGestureRecognizer } from '../core/interaction/gestures';
import type { SimEvent } from '../shared/sim';
import { createCatHost, type CatHost } from '../main/catHost';
import { createActivityMonitor } from '../main/win32/activityMonitor';
import { createUnavailableWin32Api } from '../main/win32/win32Api';
import { createWindowTracker } from '../main/win32/windowTracker';
import { OverlayRuntime } from '../renderer/overlay/runtime';
import { createWebDisplayService } from './display';
import { createWebLogger } from './logger';
import { createPointerRouter, type RouterTarget } from './pointerRouter';
import { describeCat, isAsleep } from './status';
import { createWebCatStore, openWebStorage } from './storage';
import { installTestHook, type WebTestRecorder } from './testHook';
import { createWebOverlays } from './webOverlays';

declare const __DEV__: boolean;
/** True only in the --web-test build (out/web-test); esbuild drops the test hook from out/web. */
declare const __WEB_TEST__: boolean;

/** The live region announces at most this often (ms): the cat changes what it does often. */
const STATUS_MIN_INTERVAL_MS = 3000;

function byId<T extends HTMLElement>(id: string, ctor: { new (): T }): T | null {
  const el = document.getElementById(id);
  return el instanceof ctor ? el : null;
}

function boot(): void {
  const log = createWebLogger(console, __DEV__);
  const clock = (): number => performance.now();
  const bootAt = clock();
  const canvas = byId('cat', HTMLCanvasElement);
  if (!canvas) {
    log.error('the #cat canvas is missing');
    return;
  }

  // ---- persistence (corrupt or blocked storage: a fresh cat, never a crash)
  const storage = openWebStorage(() => window.localStorage, log.child('storage'));
  let settings = storage.loadSettings();
  const catLoad = storage.loadCat(Math.random, Date.now());

  // ---- platform stand-ins: one logical display; no windows, taskbars, perception or keyboard
  const display = createWebDisplayService({
    viewport: () => ({ width: window.innerWidth, height: window.innerHeight }),
    listen: (cb) => {
      window.addEventListener('resize', cb);
      return () => window.removeEventListener('resize', cb);
    },
    timers: { setTimeout: (fn, ms) => window.setTimeout(fn, ms), clearTimeout: (h) => window.clearTimeout(h as number) },
    logger: log.child('display'),
  });
  const win32 = createUnavailableWin32Api();
  const tracker = createWindowTracker(win32, log);

  let host: CatHost | null = null;
  let suspended = false;
  /** Test build only (see installTestHook below). */
  let recorder: WebTestRecorder | null = null;

  const overlays = createWebOverlays({
    display,
    getSettings: () => settings,
    clock,
    logger: log.child('overlay'),
    blocked: () => !host || host.hidden || host.paused || host.locked || suspended || !settings.interaction.enabled,
    onCatGone: () => router.cancel(),
  });
  const deliverSimEvents = (events: SimEvent[]): void => {
    host?.enqueueAll(events);
    recorder?.noteEvents(events);
  };
  const router = createPointerRouter({
    gestures: createGestureRecognizer(),
    hitTest: (p, hovering) => overlays.hitTest(p, hovering),
    onSimEvents: deliverSimEvents,
    now: clock,
    timers: { setTimeout: (fn, ms) => window.setTimeout(fn, ms), clearTimeout: (h) => window.clearTimeout(h as number) },
    onStateChange: (s) => {
      const root = document.documentElement;
      root.classList.toggle('gizecat-hover', s.hovering && !s.pressed);
      root.classList.toggle('gizecat-hold', s.pressed);
    },
  });
  overlays.bindInput(router);

  // Idle time: since the page's last pointer event (the web has no system idle time; keys are never read).
  // Typing is never inferred (a resolution of 500 ms or coarser turns that off, ADR 0004 §3).
  const activity = createActivityMonitor(win32, log, {
    idleProvider: () => clock() - (router.lastInputAt ?? bootAt),
    idleResolutionMs: 500,
    sleepThresholdMs: settings.behavior.sleepAfterIdleMinutes * 60_000,
  });

  const sim = createCatSim({ persisted: catLoad.cat, settings, world: simWorld(display.world), now: 0, random: Math.random, wallClock: Date.now });
  const catStore = createWebCatStore({
    storage,
    snapshot: () => sim.serialize(),
    logger: log.child('cat-store'),
    setInterval: (fn, ms) => window.setInterval(fn, ms),
    clearInterval: (h) => window.clearInterval(h as number),
  });

  // ---- page controls and the polite status line
  const status = byId('cat-status', HTMLElement);
  const btnCall = byId('btn-call', HTMLButtonElement);
  const btnSleep = byId('btn-sleep', HTMLButtonElement);
  const btnPause = byId('btn-pause', HTMLButtonElement);
  const btnSound = byId('btn-sound', HTMLButtonElement);
  let statusShownAt = Number.NEGATIVE_INFINITY;
  let statusTimer: number | null = null;

  function setText(el: HTMLElement | null, text: string): void {
    if (el && el.textContent !== text) el.textContent = text;
  }

  function refreshUi(): void {
    const h = host;
    if (!h) return;
    setText(btnSleep, isAsleep(h.state) ? 'Wake' : 'Sleep');
    setText(btnPause, h.paused ? 'Resume' : 'Pause');
    setText(btnSound, settings.sound.enabled ? 'Turn sound off' : 'Turn sound on');
    if (!status) return;
    const text = describeCat({ name: settings.general.catName, state: h.state, paused: h.paused });
    if (status.textContent === text) return;
    const wait = STATUS_MIN_INTERVAL_MS - (clock() - statusShownAt);
    if (wait <= 0) {
      status.textContent = text;
      statusShownAt = clock();
    } else if (statusTimer === null) {
      statusTimer = window.setTimeout(() => {
        statusTimer = null;
        refreshUi();
      }, wait);
    }
  }

  host = createCatHost({
    sim,
    win32,
    tracker,
    activity,
    perception: null,
    display,
    overlays,
    catStore,
    logger: log.child('host'),
    getSettings: () => settings,
    cursorFallback: () => router.cursor,
    clock,
    onStatusChange: () => {
      if (host) recorder?.noteState(host.state);
      refreshUi();
    },
  });
  const catHost = host;
  display.onChange((world) => {
    overlays.onDisplayChanged();
    catHost.onDisplayChanged(world);
  });

  btnCall?.addEventListener('click', () => {
    // To the button (keyboard activation has no pointer): the cat walks over to it.
    const r = btnCall.getBoundingClientRect();
    catHost.callCat({ x: r.left + r.width / 2, y: r.top + r.height / 2 });
  });
  btnSleep?.addEventListener('click', () => {
    catHost.enqueue(isAsleep(catHost.state) ? { type: 'command.wake' } : { type: 'command.sleep' });
  });
  btnPause?.addEventListener('click', () => {
    catHost.setPaused(!catHost.paused);
  });
  btnSound?.addEventListener('click', () => {
    settings = { ...settings, sound: { ...settings.sound, enabled: !settings.sound.enabled } };
    catHost.updateSettings(settings);
    storage.saveSettings(settings);
    refreshUi();
  });

  // ---- a hidden page: the cat naps (system suspend), not "paused by the user" (see the note below)
  function onVisibility(): void {
    if (document.visibilityState === 'hidden') {
      if (suspended) return;
      suspended = true;
      catStore.saveSync();
      router.cancel();
      catHost.onSystem('suspend');
    } else if (suspended) {
      suspended = false;
      catHost.onSystem('resume');
    }
  }
  // setPaused(true) would show the cat as paused by the user (the Pause button, the status line,
  // env.paused) and a user pause would have to be told apart on return. onSystem('suspend') is the
  // computer-asleep signal: the sim settles the cat asleep (its 'locked' mode) and wakes it on
  // resume, the host keeps no flag of its own, and the browser throttles the hidden page's timers,
  // so the slower asleep ticks cost next to nothing.
  document.addEventListener('visibilitychange', onVisibility);
  window.addEventListener('pagehide', () => catStore.saveSync());
  // A press can lose its release when the window loses focus mid-drag.
  window.addEventListener('blur', () => router.cancel());

  let runtime: OverlayRuntime | null = null;
  try {
    runtime = new OverlayRuntime(canvas, overlays.api);
  } catch (err) {
    log.error('the cat renderer could not start', { error: err instanceof Error ? err.message : String(err) });
  }

  // A constant-false branch in the production build: esbuild drops it, and the hook module with it.
  if (__WEB_TEST__) {
    recorder = installTestHook(window, {
      host: catHost,
      overlays,
      router,
      storage,
      catSource: catLoad.source,
      catId: () => catLoad.cat.catId,
      suspended: () => suspended,
    });
    recorder.noteState(catHost.state);
  }

  tracker.start();
  activity.start();
  runtime?.start();
  catHost.start();
  catStore.start();
  // RouterTarget is structural (the router has no DOM types); a Document listens the same way.
  router.attach(document as unknown as RouterTarget);
  if (catLoad.source === 'recovered') catStore.markDirty();
  if (document.visibilityState === 'hidden') onVisibility();
  refreshUi();
}

boot();
