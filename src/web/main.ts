// GizeCat web host entry point (bundled to out/web/main.js; ADR 0004 §8). Composes the real cat in
// the browser viewport: createCatSim and createCatHost, the real overlay renderer (OverlayRuntime)
// over an in-page OverlayApi, the real gesture recognizer behind the page's pointer router, and the
// renderMapping rules, on one logical display (the viewport). The cat walks on the bottom of the
// viewport only: no window surfaces, taskbars or perception; the window tracker and activity
// monitor run on the unavailable Win32 stand-in (never win32/index.ts or native.ts, which reach
// koffi), with idle time taken from the page's own pointer events (never key events).
//
// 1.4.0, the installable tablet app (the same bundle is the Android app's payload, hostMode.ts):
// a manifest and a versioned service worker (registered only in a browser, production builds,
// secure origins); the layout viewport and the bottom safe-area inset shape the cat's room; a
// toolbar and a settings sheet (settingsPanel.ts) that win over the cat; one gesture-unlocked
// AudioContext (audioUnlock.ts); "Start over" and persistence requests (storage.ts).
// First: configures zod before any schema is built (see zodConfig.ts).
import './zodConfig';
import { createCatSim } from '../core/behavior';
import { simWorld } from '../core/display/simWorld';
import { createGestureRecognizer } from '../core/interaction/gestures';
import type { Point } from '../shared/geometry';
import type { SimEvent } from '../shared/sim';
import { createCatHost, type CatHost } from '../main/catHost';
import { createActivityMonitor } from '../main/win32/activityMonitor';
import { createUnavailableWin32Api } from '../main/win32/win32Api';
import { createWindowTracker } from '../main/win32/windowTracker';
import { OverlayRuntime } from '../renderer/overlay/runtime';
import { browserAudioMaker, createSharedAudio } from './audioUnlock';
import { createWebDisplayService } from './display';
import { detectHostMode, installHint, readHostEnv, shouldRegisterServiceWorker, shouldRequestPersistence } from './hostMode';
import { createWebLogger } from './logger';
import { createPointerRouter, type RouterTarget } from './pointerRouter';
import { readSafeAreaInsets } from './safeArea';
import { applyWebPatch, patchFor, resetWebSettings, type WebPatchResult } from './settingsModel';
import { createSettingsPanel, type SettingsPanel } from './settingsPanel';
import { describeCat, isAsleep } from './status';
import { createWebCatStore, openWebStorage, requestPersistence, type PersistenceState } from './storage';
import { WS } from './strings';
import { registerServiceWorker } from './swRegister';
import { installTestHook, type WebTestRecorder } from './testHook';
import { createWebOverlays } from './webOverlays';

declare const __DEV__: boolean;
declare const __APP_VERSION__: string;
/** True only in the --web-test build (out/web-test); esbuild drops the test hook from out/web. */
declare const __WEB_TEST__: boolean;
/** True in production builds (out/web, out/web-test): the service worker exists only there. */
declare const __WEB_SW__: boolean;

/** The live region announces at most this often (ms): the cat changes what it does often. */
const STATUS_MIN_INTERVAL_MS = 3000;
/** Pinch-zoomed in past this, the cat takes no touches (the visual viewport no longer matches the room). */
const ZOOMED_SCALE = 1.01;

/** Chromium's install prompt event (not in the DOM lib). */
interface BeforeInstallPromptLike {
  preventDefault(): void;
  prompt(): Promise<unknown>;
}

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

  // ---- where the page runs: a browser tab, the installed web app, or the Android app
  const hostEnv = readHostEnv(window);
  const mode = detectHostMode(hostEnv);

  // ---- persistence (corrupt or blocked storage: a fresh cat, never a crash)
  const storage = openWebStorage(() => window.localStorage, log.child('storage'));
  let settings = storage.loadSettings();
  const catLoad = storage.loadCat(Math.random, Date.now());

  // ---- platform stand-ins: one logical display; no windows, taskbars, perception or keyboard.
  // The layout viewport (the document never scrolls, so iOS toolbars do not collapse, and neither
  // pinch zoom nor an on-screen keyboard changes it); the canvas is sized from the same source.
  const root = document.documentElement;
  const viewport = (): { width: number; height: number } => ({ width: root.clientWidth || window.innerWidth, height: root.clientHeight || window.innerHeight });
  const probe = document.getElementById('safe-area-probe');
  const display = createWebDisplayService({
    viewport,
    insets: () => readSafeAreaInsets(probe, (el) => window.getComputedStyle(el)),
    listen: (cb) => {
      const orientation = (screen as { orientation?: EventTarget }).orientation;
      window.addEventListener('resize', cb);
      orientation?.addEventListener('change', cb);
      return () => {
        window.removeEventListener('resize', cb);
        orientation?.removeEventListener('change', cb);
      };
    },
    timers: { setTimeout: (fn, ms) => window.setTimeout(fn, ms), clearTimeout: (h) => window.clearTimeout(h as number) },
    logger: log.child('display'),
  });
  const win32 = createUnavailableWin32Api();
  const tracker = createWindowTracker(win32, log);

  let host: CatHost | null = null;
  let suspended = false;
  let panel: SettingsPanel | null = null;
  /** Test build only (see installTestHook below). */
  let recorder: WebTestRecorder | null = null;

  const zoomed = (): boolean => (window.visualViewport?.scale ?? 1) > ZOOMED_SCALE;
  const overlays = createWebOverlays({
    display,
    getSettings: () => settings,
    clock,
    logger: log.child('overlay'),
    blocked: () =>
      !host || host.hidden || host.paused || host.locked || suspended || !settings.interaction.enabled || (panel?.isOpen ?? false) || zoomed(),
    onCatGone: () => router.cancel(),
  });
  const deliverSimEvents = (events: SimEvent[]): void => {
    host?.enqueueAll(events);
    recorder?.noteEvents(events);
  };
  // The toolbar's buttons win over the cat: a press on them is the page's, wherever the cat is.
  const controls = document.querySelector('.bar .controls');
  const insideBar = (p: Point): boolean => {
    if (!controls) return false;
    const r = controls.getBoundingClientRect();
    return p.x >= r.left && p.x <= r.right && p.y >= r.top && p.y <= r.bottom;
  };
  const router = createPointerRouter({
    gestures: createGestureRecognizer(),
    hitTest: (p, hovering) => !insideBar(p) && overlays.hitTest(p, hovering),
    onSimEvents: deliverSimEvents,
    now: clock,
    timers: { setTimeout: (fn, ms) => window.setTimeout(fn, ms), clearTimeout: (h) => window.clearTimeout(h as number) },
    onStateChange: (s) => {
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

  // ---- sound: one AudioContext, unlocked inside user gestures (iPadOS Safari needs one)
  const audio = createSharedAudio(browserAudioMaker(window));
  const unlockAudioOnGesture = (): void => {
    if (settings.sound.enabled && audio.state !== 'running') audio.unlock();
  };
  // Passive, capture phase, registered before the pointer router so the router's stopPropagation on
  // the cat's own clicks cannot hide them. Pointer and touch only: never keys.
  document.addEventListener('click', unlockAudioOnGesture, { capture: true, passive: true });
  document.addEventListener('touchend', unlockAudioOnGesture, { capture: true, passive: true });

  // ---- page controls and the polite status line
  const status = byId('cat-status', HTMLElement);
  const btnCall = byId('btn-call', HTMLButtonElement);
  const btnSleep = byId('btn-sleep', HTMLButtonElement);
  const btnPause = byId('btn-pause', HTMLButtonElement);
  const btnSound = byId('btn-sound', HTMLButtonElement);
  const btnSettings = byId('btn-settings', HTMLButtonElement);
  let statusShownAt = Number.NEGATIVE_INFINITY;
  let statusTimer: number | null = null;

  function setText(el: HTMLElement | null, text: string): void {
    if (el && el.textContent !== text) el.textContent = text;
  }

  function refreshUi(): void {
    const h = host;
    if (!h) return;
    setText(btnSleep, isAsleep(h.state) ? WS.toolbar.wake : WS.toolbar.sleep);
    setText(btnPause, h.paused ? WS.toolbar.resume : WS.toolbar.pause);
    setText(btnSound, settings.sound.enabled ? WS.toolbar.soundOff : WS.toolbar.soundOn);
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

  // ---- settings: every change through the web allow-list, then screen analysis and AI forced off
  function applyPatch(patch: unknown, save: boolean): WebPatchResult {
    const r = applyWebPatch(settings, patch);
    if (!r.ok) {
      log.warn('settings change refused', { error: r.error });
      return r;
    }
    settings = r.settings;
    catHost.updateSettings(settings);
    if (save) storage.saveSettings(settings);
    refreshUi();
    return r;
  }

  let persistence: PersistenceState | null = null;
  let installPrompt: BeforeInstallPromptLike | null = null;
  const storageText = (): string => {
    if (!storage.available) return WS.storage.unavailable(mode.place);
    if (mode.kind === 'android-app') return WS.storage.androidApp;
    return WS.storage.status(mode.place, persistence);
  };

  function startOver(): boolean {
    // Synchronous from here to the reload: no pagehide save can run in between, and the frozen
    // store would refuse it anyway, so the old cat is never written back.
    if (storage.available && !storage.clearAll()) return false;
    catStore.freeze();
    window.location.reload();
    return true;
  }

  const dialogEl = document.getElementById('settings');
  if (dialogEl) {
    panel = createSettingsPanel({
      dialog: dialogEl as HTMLDialogElement,
      getSettings: () => settings,
      apply: (patch, save) => applyPatch(patch, save),
      onSoundGesture: () => audio.unlock(),
      onResetSettings: () => {
        settings = resetWebSettings();
        catHost.updateSettings(settings);
        storage.saveSettings(settings);
        refreshUi();
      },
      onStartOver: startOver,
      host: mode,
      installHint: () => installHint(mode, installPrompt !== null),
      onInstall: () => {
        const p = installPrompt;
        installPrompt = null;
        if (!p) return;
        void p
          .prompt()
          .catch((err: unknown) => log.warn('the install prompt failed', { error: err instanceof Error ? err.message : String(err) }))
          .finally(() => panel?.refresh());
      },
      storageText,
      version: __APP_VERSION__,
      onOpenChange: (open) => {
        // An open sheet owns the screen: the cat's press ends and it takes no pointer (blocked).
        if (open) router.cancel();
        root.classList.toggle('gizecat-sheet-open', open);
      },
    });
  } else {
    log.error('the #settings sheet is missing');
  }
  const settingsPanel = panel;

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
    const on = !settings.sound.enabled;
    // Inside the click: the one moment iPadOS lets audio start.
    if (on) audio.unlock();
    const patch = patchFor({ field: 'soundEnabled', value: on });
    if (patch) applyPatch(patch, true);
    settingsPanel?.refresh();
  });
  btnSettings?.addEventListener('click', () => {
    router.cancel();
    settingsPanel?.open();
  });

  // ---- installing: Chromium's prompt (kept for the sheet's Install button); never in the Android app
  if (mode.kind === 'browser') {
    window.addEventListener('beforeinstallprompt', (e) => {
      e.preventDefault();
      installPrompt = e as unknown as BeforeInstallPromptLike;
      settingsPanel?.refresh();
    });
    window.addEventListener('appinstalled', () => {
      installPrompt = null;
      settingsPanel?.refresh();
    });
  }

  // ---- keeping the data: ask once when installed (Safari grants it to Home Screen apps by heuristics); else only read it
  if (storage.available && mode.kind === 'browser') {
    const manager = (navigator as { storage?: { persist?: () => Promise<boolean>; persisted?: () => Promise<boolean> } }).storage;
    void requestPersistence(manager, shouldRequestPersistence(mode)).then((p) => {
      persistence = p;
      settingsPanel?.refresh();
    });
  }

  // ---- offline: the service worker (production, browser, secure origin; never in the Android app)
  if (shouldRegisterServiceWorker(mode, hostEnv, __WEB_SW__)) {
    registerServiceWorker({
      container: 'serviceWorker' in navigator ? navigator.serviceWorker : undefined,
      whenLoaded: (cb) => {
        if (document.readyState === 'complete') cb();
        else window.addEventListener('load', () => cb(), { once: true });
      },
      warn: (msg, data) => log.warn(msg, data),
      onUpdateReady: () => settingsPanel?.showUpdateReady(),
    });
  }

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
      // A rotation or a Split View change while hidden may have sent no resize.
      display.refresh();
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
    runtime = new OverlayRuntime(canvas, overlays.api, { audio: audio.factory, viewport });
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
      sheetOpen: () => settingsPanel?.isOpen ?? false,
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
