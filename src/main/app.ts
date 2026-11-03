// Composition root and lifecycle. Runs after app 'ready' with the logger and
// settings that index.ts prepared before ready.
import os from 'node:os';
import path from 'node:path';
import { app, BaseWindow, BrowserWindow, globalShortcut, ipcMain, Menu, powerMonitor, safeStorage, screen, session, shell } from 'electron';
import { createCatSim, migrateCatState, summarizeCat } from '../core/behavior';
import { simWorld } from '../core/display/simWorld';
import { createGestureRecognizer } from '../core/interaction/gestures';
import type { AppStatus, SettingsViewState } from '../shared/ipc';
import { IPC } from '../shared/ipc';
import type { PerceptionStatus } from '../shared/perception';
import type { Settings } from '../shared/settings';
import { parseSurfaceDiagnostics } from '../shared/surfaceDiagnosticsSchema';
import { createCatHost, type CatHost } from './catHost';
import type { Logger, PerceptionHost, PerceptionService } from './contracts';
import { buildDiagnosticsReport } from './diagnostics/diagnosticsReport';
import { watchDpiAwareness } from './diagnostics/dpiAwareness';
import { exportDiagnosticsToFile } from './diagnostics/exportDiagnostics';
import type { RootLogger } from './diagnostics/logger';
import { createResourceMonitor } from './diagnostics/resourceMonitor';
import { assembleSurfaceDiagnostics, createSurfaceDiagnosticsSource, createSurfaceSummaryLog, surfaceSummary } from './diagnostics/surfaceDiagnostics';
import { createBehaviorLog } from './diagnostics/behaviorLog';
import { createDisplayService } from './display/displayService';
import { createActionRunner, type ActionTargets, type AppAction } from './ipc/actions';
import { registerIpcHandlers } from './ipc/handlers';
import { createThrottle } from './ipc/rateLimit';
import { applyViewState, createViewStateMemory, startupPlan } from './ipc/startupState';
import { appRootFrom, appVersion } from './lifecycle/appInfo';
import type { CrashGuard } from './lifecycle/crashGuard';
import { createLoginItemService, LOGIN_ITEM_NAME } from './lifecycle/loginItem';
import { announceLaunchAtLogin } from './lifecycle/loginItemNotice';
import { catContextMenuModel, type MenuContext } from './lifecycle/menuModel';
import { createQuitSequence } from './lifecycle/quitSequence';
import { createSessionEndSaver, type SessionEndWindow } from './lifecycle/sessionEnd';
import { createShortcutManager } from './lifecycle/shortcuts';
import { createOverlayManager } from './overlay/overlayManager';
import { createSurfaceOutlines } from './overlay/surfaceLines';
import { createPerceptionService } from './perception';
import { installAppProtocol } from './protocol';
import { createWindowRegistry, installSecurity } from './security';
import { createSettingsWindowController } from './settingsWindow';
import { createCatStore } from './store/catStore';
import { createJsonStore, type JsonReadStatus } from './store/jsonStore';
import { createSecretFile, createSecretStore } from './store/secretStore';
import type { SettingsStore } from './store/settingsStore';
import { createSurfaceProvider } from './surfaces';
import { installTestHooks } from './testHooks';
import { createTrayController, toMenuTemplate } from './tray';
import { createTabStripService, resolveUiaHelperPath, UIA_HEALTH_FILE } from './uia';
import { createActivityMonitor, createWin32Api, createWindowTracker, sameWindowExclusions, windowExclusionsFor } from './win32';
import { createLoginItemRegistry } from './win32/registry';
import { createTaskbarTracker } from './win32/taskbar';

export interface AppBootstrap {
  logger: RootLogger;
  settings: SettingsStore;
  settingsLoadStatus: JsonReadStatus;
  crashGuard: CrashGuard;
  userData: string;
  flags: { dev: boolean; test: boolean; launchedAtLogin: boolean };
  timeScale: number;
  startedAt: number;
}

export interface RunningApp {
  /** Another launch was attempted: surface the cat and the settings window. */
  onSecondInstance(): void;
}

const VIEW_STATE_INTERVAL_MS = 250;
const QUIT_ANIMATION_MS = 1500;
/** Longest the quit waits for the UIA helper to exit. */
const TAB_STRIP_DISPOSE_MS = 2500;
/** How often the 'surfaces summary' log line checks for a change (it logs at most once a minute). */
const SURFACE_SUMMARY_CHECK_MS = 10_000;

function offStatus(settings: Settings, reason: string): PerceptionStatus {
  return {
    mode: 'off',
    paused: settings.perception.paused,
    blockedReason: reason,
    lastCaptureAt: null,
    capturesThisHour: 0,
    aiProviderLabel: null,
    lastError: null,
  };
}

function attempt(log: Logger, what: string, fn: () => void): void {
  try {
    fn();
  } catch (err) {
    log.error(`${what} failed`, { error: err });
  }
}

export function startApp(boot: AppBootstrap): RunningApp {
  const { logger, settings } = boot;
  const log = logger.child('app');
  const mainDir = __dirname;
  const rendererRoot = path.join(mainDir, '..', 'renderer');
  const preloadDir = path.join(mainDir, '..', 'preload');
  const appRoot = appRootFrom(mainDir);
  const version = appVersion(() => app.getVersion());

  Menu.setApplicationMenu(null);
  installSecurity(app, session.defaultSession, logger.child('security'));
  installAppProtocol(session.defaultSession, rendererRoot, logger.child('protocol'));

  // Persistence
  const catStore = createCatStore({
    store: createJsonStore({ filePath: path.join(boot.userData, 'cat-state.json'), logger: logger.child('store') }),
    migrate: migrateCatState,
    random: Math.random,
    logger: logger.child('cat-store'),
  });
  const catLoad = catStore.load();
  if (catLoad.recovered) log.warn('cat state recovered', { source: catLoad.source });
  const secrets = createSecretStore({
    // No .bak or quarantined copy: a removed key must not come back from a copy.
    store: createSecretFile(path.join(boot.userData, 'secrets.json'), logger.child('store')),
    cipher: safeStorage,
    logger: logger.child('secrets'),
  });

  // Platform services. The DPI awareness line win32 logs at boot also feeds the surface
  // diagnostics (dpiAwareness.ts): the facade does not expose the value itself.
  let dpiAwareness = 'unknown';
  const win32 = createWin32Api(watchDpiAwareness(logger, (a) => (dpiAwareness = a)));
  if (!win32.available) dpiAwareness = 'unavailable';
  const display = createDisplayService(logger);
  const tracker = createWindowTracker(win32, logger);
  const activity = createActivityMonitor(win32, logger);
  const initial = settings.get();
  // Title patterns only while screen analysis is enabled: otherwise no window title is read.
  const applyWindowExclusions = (s: Settings): void => {
    const ex = windowExclusionsFor(s);
    tracker.setExclusions(ex.processes, ex.titlePatterns);
  };
  attempt(log, 'window exclusions', () => applyWindowExclusions(initial));

  // v1.1 environment surfaces: taskbars (sampled from the host's cursor poll), window tops and
  // sides, and browser tab strips through the UIA helper (fails closed to 'unavailable').
  const surfaceClock = (): number => performance.now();
  const taskbars = createTaskbarTracker(logger, { now: surfaceClock, world: display.world });
  const tabStrips = (() => {
    try {
      return createTabStripService({
        logger: logger.child('tab-strips'),
        settings: initial,
        helperPath: resolveUiaHelperPath({ packaged: app.isPackaged, resourcesPath: process.resourcesPath, appRoot }),
        describeWindow: (id) => win32.describeWindow(id),
        displayAt: (p) => display.displayAt(p),
        now: surfaceClock,
        // v1.2 (PRV): the File Explorer kill switch's strike counter (ADR 0003 §7.2).
        healthFile: path.join(boot.userData, UIA_HEALTH_FILE),
        appVersion: version,
      });
    } catch (err) {
      log.error('tab-strip service unavailable', { error: err });
      return null;
    }
  })();
  const surfaces = createSurfaceProvider({ logger, tracker, win32, taskbars, tabStrips, display, settings: initial, now: surfaceClock });

  const sim = createCatSim({ persisted: catLoad.cat, settings: initial, world: simWorld(display.world), now: 0, random: Math.random, wallClock: Date.now });
  const registry = createWindowRegistry();

  let host: CatHost | null = null;
  const perceptionHost: PerceptionHost = {
    getCatBounds: () => host?.catBoundsPx() ?? null,
    getCatDisplayId: () => host?.catDisplayId() ?? null,
    getForeground: () => tracker.getForeground(),
    isExcludedAt: (p) => tracker.isExcludedAt(p),
    getExcludedRects: () => tracker.getExcludedRects(),
    isForegroundExcluded: () => tracker.isForegroundExcluded(),
    isLocked: () => host?.locked ?? false,
  };
  let perception: PerceptionService | null = null;
  try {
    perception = createPerceptionService({ logger, host: perceptionHost, secrets, settings: initial });
  } catch (err) {
    log.error('perception unavailable', { error: err });
  }

  // v1.1.1 surface diagnostics: why the cat can or cannot leave the floor. Built on demand
  // (Diagnostics page, export, summary log line) and cached briefly; counts and geometry only.
  const surfaceDiagnostics = createSurfaceDiagnosticsSource({
    clock: surfaceClock,
    build: (at) =>
      assembleSurfaceDiagnostics({
        at,
        dpiAwareness,
        world: display.world,
        output: host?.lastOutput ?? null,
        observers: surfaces.status.windowSurfaces,
        provider: () => surfaces.diagnostics(),
        sim: () => sim.surfaceDiagnostics(),
      }),
  });
  const surfaceSummaryLog = createSurfaceSummaryLog({ logger: logger.child('surfaces') });
  // v1.2 (ADR 0003 §11): 'stay ended' / 'behavior summary' lines from the behaviour profile.
  const behaviorLog = createBehaviorLog(logger.child('behavior'));
  let surfaceSummaryTimer: ReturnType<typeof setInterval> | null = null;

  const cursorFallback = () => screen.dipToScreenPoint(screen.getCursorScreenPoint());
  const settingsWindow = createSettingsWindowController({
    preloadPath: path.join(preloadDir, 'settings.js'),
    registry,
    logger: logger.child('settings-window'),
    devTools: boot.flags.dev,
  });

  // Launch at sign-in: reconciled once, before the host starts (two registry reads, microseconds).
  // Only an installed, non-test build may write its entry (see the write gate in loginItemReconcile.ts).
  const loginItem = createLoginItemService({
    writer: app,
    registry: createLoginItemRegistry(LOGIN_ITEM_NAME),
    settings,
    logger: logger.child('login-item'),
    execPath: process.execPath,
    userData: boot.userData,
    logDir: logger.logDir,
    packaged: app.isPackaged,
    test: boot.flags.test,
    launchedAtLogin: boot.flags.launchedAtLogin,
    env: process.env,
    settingsLoadStatus: boot.settingsLoadStatus,
    clock: () => performance.now(),
  });
  loginItem.reconcileAtStartup();

  // Status, UI refresh
  const shortcuts = createShortcutManager(globalShortcut, logger.child('shortcuts'), () => {
    if (host) host.setHidden(!host.hidden);
  });

  const resources = createResourceMonitor({ getMetrics: () => app.getAppMetrics() });

  const requireHost = (): CatHost => {
    if (!host) throw new Error('cat host not started');
    return host;
  };

  function status(): AppStatus {
    const h = requireHost();
    const s = settings.get();
    return {
      version,
      visible: !h.hidden,
      paused: h.paused,
      interactionsEnabled: s.interaction.enabled,
      catState: h.state,
      displayCount: display.world.displays.length,
      perception: perception ? perception.status : offStatus(s, 'Screen analysis is unavailable.'),
      windowAwareness: tracker.mode,
      surfaces: surfaces.status,
      surfaceOutlines: outlines.enabled,
      loginItem: loginItem.status(),
      shortcutRegistered: shortcuts.registered,
      startedAt: boot.startedAt,
    };
  }

  function viewState(): SettingsViewState {
    const s = settings.get();
    return {
      settings: s,
      status: status(),
      cat: summarizeCat(sim, s.general.catName),
      apiKeys: { anthropic: secrets.has('anthropic'), openaiCompatible: secrets.has('openai-compatible') },
      resources: resources.samples(),
      versions: {
        app: version,
        electron: process.versions.electron,
        chrome: process.versions.chrome,
        node: process.versions.node,
        os: `${os.type()} ${os.release()} (${os.arch()})`,
      },
      paths: { userData: boot.userData, logs: logger.logDir ?? '' },
    };
  }

  function menuContext(): MenuContext {
    const s = settings.get();
    const h = requireHost();
    return {
      catName: s.general.catName,
      hidden: h.hidden,
      paused: h.paused,
      state: h.state,
      interactionsEnabled: s.interaction.enabled,
      perceptionConfigured: s.perception.visualMode !== 'off',
      perceptionPaused: s.perception.paused,
      perceptionMode: perception?.status.mode ?? 'off',
    };
  }

  function saveAllSync(): void {
    attempt(log, 'settings save', () => settings.flushSync());
    attempt(log, 'cat save', () => {
      catStore.saveSync();
    });
    attempt(log, 'log flush', () => logger.flushSync());
  }
  boot.crashGuard.setSaver(saveAllSync);

  // Windows reports logoff/shutdown only to top-level windows (see sessionEnd.ts). This one
  // is never shown and has no web contents, so it costs no renderer process.
  const sessionEnd = createSessionEndSaver({
    save: saveAllSync,
    logger: logger.child('session-end'),
    clock: () => performance.now(),
    createWindow: (): SessionEndWindow => {
      const win = new BaseWindow({ show: false, width: 1, height: 1, frame: false, skipTaskbar: true, focusable: false, resizable: false });
      return {
        onSessionEnd: (listener) => {
          win.on('query-session-end', () => listener('query-session-end'));
          win.on('session-end', () => listener('session-end'));
        },
        destroy: () => {
          if (!win.isDestroyed()) win.destroy();
        },
      };
    },
  });

  function buildReport(): Record<string, unknown> {
    const h = requireHost();
    return buildDiagnosticsReport({
      generatedAt: new Date(),
      versions: { app: version, electron: process.versions.electron, chrome: process.versions.chrome, node: process.versions.node, v8: process.versions.v8 },
      os: { platform: process.platform, release: os.release(), arch: os.arch(), totalMemoryMB: Math.round(os.totalmem() / 1048576), locale: app.getLocale() },
      world: display.world,
      settings: settings.get(),
      userProfile: os.homedir(),
      apiKeysStored: { anthropic: secrets.has('anthropic'), openaiCompatible: secrets.has('openai-compatible') },
      status: status(),
      cat: sim.debugInfo(),
      surfaces: surfaceDiagnostics.get().diagnostics,
      behaviorProfile: sim.behaviorProfile(),
      services: {
        host: h.debug(),
        overlays: overlays.info().map(({ hwnd: _hwnd, ...o }) => o),
        windowTracker: tracker.debugInfo(),
        surfaces: surfaces.debugInfo(),
        loginItem: loginItem.debugInfo(),
        win32Available: win32.available,
        encryptionAvailable: secrets.encryptionAvailable,
        startup: { settings: boot.settingsLoadStatus, cat: { recovered: catLoad.recovered, source: catLoad.source } },
        logProblems: logger.problemCount,
      },
      resources: resources.samples(),
      logs: logger.recent(),
    });
  }

  const targets: ActionTargets = {
    // The only paths that change the main-owned loginItem section after boot.
    setLaunchAtLogin: (on) => loginItem.setLaunchAtLogin(on),
    dismissLaunchNotice: () => loginItem.dismissNotice(),
    setSurfaceOutlines: (on) => {
      outlines.setEnabled(on);
      refreshUi();
    },
    setPaused: (p) => requireHost().setPaused(p),
    setHidden: (h) => requireHost().setHidden(h),
    callCat: () => requireHost().callCat(),
    enqueue: (ev) => requireHost().enqueue(ev),
    catAnchor: () => requireHost().catAnchor(),
    resetPersonality: () => {
      sim.resetPersonality();
      void catStore.save();
    },
    clearHistory: () => {
      sim.clearHistory();
      void catStore.save();
    },
    exportDiagnostics: () => {
      const wc = settingsWindow.webContents;
      return exportDiagnosticsToFile({
        parent: wc ? BrowserWindow.fromWebContents(wc) : null,
        defaultDir: app.getPath('documents'),
        build: buildReport,
        logger: logger.child('diagnostics'),
      });
    },
    openLogsFolder: async () => {
      const dir = logger.logDir;
      if (!dir) return { ok: false, message: 'File logging is not active.' };
      const err = await shell.openPath(dir);
      return err ? { ok: false, message: err } : { ok: true };
    },
    openSettings: () => settingsWindow.open(),
    quit: () => app.quit(),
  };
  const actions = createActionRunner({ targets, settings, logger: logger.child('actions') });
  const runAction = (a: AppAction): void => {
    void actions.run(a);
  };

  const overlays = createOverlayManager({
    logger: logger.child('overlay'),
    display,
    registry,
    preloadPath: path.join(preloadDir, 'overlay.js'),
    devTools: boot.flags.dev,
    debugOverlay: boot.flags.dev && process.argv.includes('--debug-overlay'),
    getSettings: () => settings.get(),
    gestures: createGestureRecognizer(),
    onSimEvents: (events) => host?.enqueueAll(events),
    onContextMenu: (win) => {
      const menu = Menu.buildFromTemplate(toMenuTemplate(catContextMenuModel(menuContext()), runAction));
      menu.popup({ window: win });
    },
    onSessionEnd: () => sessionEnd.notify('overlay'),
    // Explorer restarted: new taskbar window handles; v1.2 (PRV) the Explorer tab-strip kill switch.
    onTaskbarCreated: () => {
      taskbars.rediscover('taskbar-created');
      attempt(log, 'tab-strip kill switch', () => tabStrips?.noteTaskbarCreated(surfaceClock()));
    },
    // Taskbars and auto-hide reveal bands always get the mouse, whatever the cat does there; from
    // v1.2 also the host's guard rects (screen-edge obstacles, a covering window during a bail-out).
    // A throw in either source makes the overlay manager fail closed (click-through everywhere).
    excludedRectsPx: () => {
      const extra = host?.clickGuardRectsPx() ?? [];
      const bars = taskbars.clickGuardRects();
      return extra.length === 0 ? bars : [...bars, ...extra];
    },
    isLeftButtonDown: () => (win32.available ? win32.isLeftButtonDown() : null),
    clock: () => performance.now(),
  });
  // v1.1.1 on-desktop surface outlines: session-only debug aid, off at every start (never a setting).
  // They stay off displays with a fullscreen app in front unless the cat ignores those (the overlay
  // manager also blanks them while the cat is hidden or out of sight).
  const outlines = createSurfaceOutlines({
    getLines: () => sim.surfaceDebugLines(),
    getQuietDisplayIds: () => (settings.get().behavior.fullscreenBehavior === 'ignore' ? [] : (host?.fullscreenDisplayIds() ?? [])),
    sink: overlays,
    logger: logger.child('surface-outlines'),
  });

  const tray = (() => {
    try {
      return createTrayController({
        iconDir: path.join(appRoot, 'assets', 'tray'),
        logger: logger.child('tray'),
        onAction: runAction,
        onClick: () => runAction(requireHost().hidden ? 'show' : 'hide'),
      });
    } catch (err) {
      log.error('tray unavailable', { error: err });
      return null;
    }
  })();

  const broadcast = createThrottle(
    () => {
      if (settingsWindow.isOpen) settingsWindow.send(IPC.settingsStateChanged, viewState());
    },
    VIEW_STATE_INTERVAL_MS,
    () => performance.now(),
  );

  function refreshUi(): void {
    if (!host) return;
    attempt(log, 'tray update', () => tray?.update(menuContext()));
    broadcast.trigger();
  }

  // Every way of hiding, showing, pausing or resuming ends in onStatusChange below.
  const viewMemory = createViewStateMemory({ settings, logger: logger.child('startup-state') });

  host = createCatHost({
    sim,
    win32,
    tracker,
    activity,
    perception,
    display,
    overlays,
    catStore,
    logger: logger.child('host'),
    getSettings: () => settings.get(),
    cursorFallback,
    timeScale: boot.timeScale,
    surfaces,
    taskbars,
    onStatusChange: () => {
      const h = host;
      if (h) {
        perception?.setPaused(h.hidden || h.locked);
        attempt(log, 'remember cat state', () => viewMemory.update(h));
      }
      refreshUi();
    },
  });
  catStore.attach(() => sim.serialize());

  const offPerceptionStatus = perception?.onStatusChange(() => refreshUi()) ?? null;
  const offDisplay = display.onChange((world) => {
    attempt(log, 'taskbar world', () => taskbars.setWorld(world));
    host?.onDisplayChanged(world);
    refreshUi();
  });

  function applyShortcuts(s: Settings): void {
    shortcuts.apply(s.general.shortcutsEnabled, s.general.toggleShortcut);
  }

  const offSettings = settings.onChange((next, prev) => {
    // First, so title patterns are in place before analysis can be requested; this also
    // follows mode, consent and pause changes, not only edits of the lists.
    if (!sameWindowExclusions(windowExclusionsFor(prev), windowExclusionsFor(next))) {
      attempt(log, 'window exclusions', () => applyWindowExclusions(next));
    }
    host?.updateSettings(next);
    // Also forwards to the tab-strip service (toggle, cat size).
    attempt(log, 'surface settings', () => surfaces.updateSettings(next));
    attempt(log, 'perception settings', () => perception?.updateSettings(next));
    attempt(log, 'overlay settings', () => overlays.applySettings(next, prev));
    logger.setLevel(next.diagnostics.logLevel);
    if (prev.general.shortcutsEnabled !== next.general.shortcutsEnabled || prev.general.toggleShortcut !== next.general.toggleShortcut) {
      applyShortcuts(next);
    }
    if (prev.diagnostics.hardwareAcceleration !== next.diagnostics.hardwareAcceleration) {
      log.info('hardware acceleration setting changes at next launch', { enabled: next.diagnostics.hardwareAcceleration });
    }
    refreshUi();
  });

  const ipc = registerIpcHandlers({
    ipcMain,
    registry,
    logger: logger.child('ipc'),
    overlays,
    getViewState: viewState,
    settings,
    actions,
    secrets,
    perception,
    onSecretsChanged: () => {
      // A new or removed key: clear the AI circuit breaker and the stale error.
      attempt(log, 'perception credentials', () => perception?.onCredentialsChanged());
      refreshUi();
    },
    getSurfaceDiagnostics: () => surfaceDiagnostics.get().diagnostics,
    clock: () => performance.now(),
  });

  // Power and session events. Windows does not emit before-quit on shutdown/logoff,
  // so state is saved synchronously on every signal that the session may end: suspend
  // here, logoff/shutdown through sessionEnd (powerMonitor 'shutdown' is Linux/macOS only).
  const onSuspend = (): void => {
    host?.onSystem('suspend');
    saveAllSync();
  };
  const onResume = (): void => host?.onSystem('resume');
  const onLock = (): void => {
    host?.onSystem('lock');
    perception?.setPaused(true);
  };
  const onUnlock = (): void => {
    host?.onSystem('unlock');
    if (host) perception?.setPaused(host.hidden);
  };
  powerMonitor.on('suspend', onSuspend);
  powerMonitor.on('resume', onResume);
  powerMonitor.on('lock-screen', onLock);
  powerMonitor.on('unlock-screen', onUnlock);

  async function disposeAll(): Promise<void> {
    const steps: Array<[string, () => void]> = [
      ['host', () => host?.stop()],
      ['surface outlines', () => outlines.dispose()],
      [
        'surfaces summary',
        () => {
          if (surfaceSummaryTimer) clearInterval(surfaceSummaryTimer);
          surfaceSummaryTimer = null;
        },
      ],
      ['taskbar tracker', () => taskbars.stop()],
      ['surface provider', () => void surfaces.dispose()],
      ['resource monitor', () => resources.stop()],
      ['shortcuts', () => shortcuts.dispose()],
      ['ipc', () => ipc.dispose()],
      ['ui throttle', () => broadcast.cancel()],
      ['settings listener', () => offSettings()],
      ['display listener', () => offDisplay()],
      ['perception listener', () => offPerceptionStatus?.()],
      [
        'power monitor',
        () => {
          powerMonitor.removeListener('suspend', onSuspend);
          powerMonitor.removeListener('resume', onResume);
          powerMonitor.removeListener('lock-screen', onLock);
          powerMonitor.removeListener('unlock-screen', onUnlock);
        },
      ],
      ['session-end window', () => sessionEnd.dispose()],
      ['window tracker', () => tracker.stop()],
      ['activity monitor', () => activity.stop()],
      ['perception', () => perception?.dispose()],
      ['cat store', () => catStore.dispose()],
      ['settings store', () => settings.dispose()],
      ['settings window', () => settingsWindow.dispose()],
      ['overlays', () => overlays.dispose()],
      ['tray', () => tray?.dispose()],
      ['display service', () => display.dispose()],
      ['win32', () => win32.dispose()],
    ];
    for (const [what, fn] of steps) attempt(log, `dispose ${what}`, fn);
    // The UIA helper is asked to quit (and killed after its grace period); never block quit on it.
    if (tabStrips) {
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        await Promise.race([tabStrips.dispose(), new Promise<void>((resolve) => (timer = setTimeout(resolve, TAB_STRIP_DISPOSE_MS)))]);
      } catch (err) {
        log.error('dispose tab-strip service failed', { error: err });
      } finally {
        clearTimeout(timer);
      }
    }
    log.info('shutdown complete');
    await logger.dispose();
  }

  const quit = createQuitSequence({
    notifySim: () => requireHost().requestQuit(),
    saveSync: saveAllSync,
    dispose: disposeAll,
    exit: (code) => app.exit(code),
    logger: logger.child('quit'),
    simTimeoutMs: QUIT_ANIMATION_MS,
  });
  app.on('before-quit', (e) => quit.onBeforeQuit(e));
  // The cat lives in the tray: closing the settings window must not quit the app.
  app.on('window-all-closed', () => undefined);

  if (boot.flags.test) installTestHooks({
    getSimOutput: () => requireHost().lastOutput,
    getOverlays: () => overlays.info(),
    getStatus: status,
    getSettings: () => settings.get(),
    getPerceptionStatus: () => perception?.status ?? null,
    getHostDebug: () => requireHost().debug(),
    getStartup: () => ({
      settingsLoad: boot.settingsLoadStatus,
      catLoad: { recovered: catLoad.recovered, source: catLoad.source },
      userData: boot.userData,
      launchedAtLogin: boot.flags.launchedAtLogin,
    }),
    getLogProblems: () => logger.problemCount,
    getRecentLogs: (limit) => logger.recent(limit),
    getDiagnosticsReport: buildReport,
    injectEvent: (ev) => requireHost().enqueue(ev),
    getSurfaces: () => requireHost().lastSurfaces,
    getSurfaceStatus: () => surfaces.status,
    injectSurfaces: (list) => surfaces.injectSurfaces(list, surfaceClock()),
    getSurfaceDiagnostics: () => parseSurfaceDiagnostics(surfaceDiagnostics.get().diagnostics),
    getSurfaceDebugLines: () => sim.surfaceDebugLines(),
    forceInteractive: (v) => overlays.forceInteractive(v),
    getBehaviorProfile: () => sim.behaviorProfile(),
    injectCursor: (p) => requireHost().setInjectedCursor(p),
    restrictSurfacesToPids: (pids) => {
      if (!surfaces.restrictToPids) throw new Error('restrictSurfacesToPids: not implemented yet (ADR 0003 §16 PRV)');
      surfaces.restrictToPids(pids);
    },
    setTimeScale: (s) => requireHost().setTimeScale(s),
    runAction: (a) => actions.run(a),
    patchSettings: (p) => settings.patchUnknown(p),
    openSettings: () => settingsWindow.open(),
    saveNow: saveAllSync,
    quit: () => app.quit(),
  });

  // Start everything. The start state is applied before the first tick, so a cat that
  // starts hidden or paused never appears or moves first.
  const plan = startupPlan(initial.general, boot.flags);
  attempt(log, 'window tracker start', () => tracker.start());
  attempt(log, 'taskbar tracker start', () => taskbars.start());
  // Lazy: the UIA helper is spawned only once a browser window is of interest.
  attempt(log, 'tab-strip service start', () => tabStrips?.start());
  attempt(log, 'activity monitor start', () => activity.start());
  host.updateSettings(initial);
  applyViewState(host, plan.view);
  overlays.start();
  host.start();
  resources.start();
  // The cat's world in main.log from now on: counts by kind, a verdict code, what it stands on and
  // its trips up this session, on change, at most once a minute.
  surfaceSummaryTimer = setInterval(() => {
    attempt(log, 'surfaces summary', () => {
      surfaceSummaryLog.note(surfaceSummary(surfaceDiagnostics.get()), surfaceClock());
    });
    attempt(log, 'behavior log', () => behaviorLog.onProfile(sim.behaviorProfile(), surfaceClock()));
  }, SURFACE_SUMMARY_CHECK_MS);
  applyShortcuts(initial);
  refreshUi();
  log.info('started', {
    version,
    displays: display.world.displays.length,
    windowAwareness: tracker.mode,
    win32: win32.available,
    perception: perception?.status.mode ?? 'unavailable',
    launchedAtLogin: boot.flags.launchedAtLogin,
    startState: plan.view,
    test: boot.flags.test,
  });

  // Opened by the app itself, not by the user: never request the foreground (see OpenOptions.activate).
  if (plan.openWelcome) settingsWindow.open('welcome', { activate: false });
  // Startup turned on by default is announced once outside Settings too (loginItemNotice.ts).
  attempt(log, 'launch at sign-in notice', () => {
    announceLaunchAtLogin({
      status: loginItem.status(),
      test: boot.flags.test,
      launchedAtLogin: boot.flags.launchedAtLogin,
      surface: tray,
      // Also hides the Settings › General callout of an open window.
      markShown: () => {
        loginItem.dismissNotice();
        refreshUi();
      },
      openSettings: () => settingsWindow.open('general'),
      logger: logger.child('login-item'),
    });
  });

  return {
    onSecondInstance() {
      const h = requireHost();
      log.info('second instance launched; surfacing the cat');
      // A start by the user: work a sign-in boot skipped is done now (loginItem.ts).
      attempt(log, 'login item reconcile', () => void loginItem.reconcileOnUserLaunch());
      if (h.hidden) h.setHidden(false);
      h.callCat();
      settingsWindow.open();
    },
  };
}
