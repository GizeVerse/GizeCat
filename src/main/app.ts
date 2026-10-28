// Composition root and lifecycle. Runs after app 'ready' with the logger and
// settings that index.ts prepared before ready.
import os from 'node:os';
import path from 'node:path';
import { app, BrowserWindow, globalShortcut, ipcMain, Menu, powerMonitor, safeStorage, screen, session, shell } from 'electron';
import { createCatSim, migrateCatState, summarizeCat } from '../core/behavior';
import { createGestureRecognizer } from '../core/interaction/gestures';
import type { AppStatus, SettingsViewState } from '../shared/ipc';
import { IPC } from '../shared/ipc';
import type { PerceptionStatus } from '../shared/perception';
import type { Settings } from '../shared/settings';
import { createCatHost, type CatHost } from './catHost';
import type { Logger, PerceptionHost, PerceptionService } from './contracts';
import { buildDiagnosticsReport } from './diagnostics/diagnosticsReport';
import { exportDiagnosticsToFile } from './diagnostics/exportDiagnostics';
import type { RootLogger } from './diagnostics/logger';
import { createResourceMonitor } from './diagnostics/resourceMonitor';
import { createDisplayService } from './display/displayService';
import { createActionRunner, type ActionTargets, type AppAction } from './ipc/actions';
import { registerIpcHandlers } from './ipc/handlers';
import { createThrottle } from './ipc/rateLimit';
import { appRootFrom, appVersion } from './lifecycle/appInfo';
import type { CrashGuard } from './lifecycle/crashGuard';
import { createLoginItemController } from './lifecycle/loginItem';
import { catContextMenuModel, type MenuContext } from './lifecycle/menuModel';
import { createQuitSequence } from './lifecycle/quitSequence';
import { createShortcutManager } from './lifecycle/shortcuts';
import { createOverlayManager } from './overlay/overlayManager';
import { createPerceptionService } from './perception';
import { installAppProtocol } from './protocol';
import { createWindowRegistry, installSecurity } from './security';
import { createSettingsWindowController } from './settingsWindow';
import { createCatStore } from './store/catStore';
import { createJsonStore, type JsonReadStatus } from './store/jsonStore';
import { createSecretStore } from './store/secretStore';
import type { SettingsStore } from './store/settingsStore';
import { installTestHooks } from './testHooks';
import { createTrayController, toMenuTemplate } from './tray';
import { createActivityMonitor, createWin32Api, createWindowTracker } from './win32';

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
    store: createJsonStore({ filePath: path.join(boot.userData, 'secrets.json'), logger: logger.child('store') }),
    cipher: safeStorage,
    logger: logger.child('secrets'),
  });

  // Platform services
  const win32 = createWin32Api(logger);
  const display = createDisplayService(logger);
  const tracker = createWindowTracker(win32, logger);
  const activity = createActivityMonitor(win32, logger);
  const initial = settings.get();
  attempt(log, 'window exclusions', () => tracker.setExclusions(initial.perception.excludedProcesses, initial.perception.excludedTitlePatterns));

  const sim = createCatSim({ persisted: catLoad.cat, settings: initial, world: display.world, now: 0, random: Math.random, wallClock: Date.now });
  const registry = createWindowRegistry();

  let host: CatHost | null = null;
  const perceptionHost: PerceptionHost = {
    getCatBounds: () => host?.catBoundsPx() ?? null,
    getCatDisplayId: () => host?.catDisplayId() ?? null,
    getForeground: () => tracker.getForeground(),
    isExcludedAt: (p) => tracker.isExcludedAt(p),
    isLocked: () => host?.locked ?? false,
  };
  let perception: PerceptionService | null = null;
  try {
    perception = createPerceptionService({ logger, host: perceptionHost, secrets, settings: initial });
  } catch (err) {
    log.error('perception unavailable', { error: err });
  }

  const cursorFallback = () => screen.dipToScreenPoint(screen.getCursorScreenPoint());
  const settingsWindow = createSettingsWindowController({
    preloadPath: path.join(preloadDir, 'settings.js'),
    registry,
    logger: logger.child('settings-window'),
    devTools: boot.flags.dev,
  });

  // Status, UI refresh
  const loginItem = createLoginItemController({
    api: app,
    logger: logger.child('login-item'),
    execPath: process.execPath,
    appPathArg: app.isPackaged ? null : appRoot,
    writesEnabled: !boot.flags.test,
  });
  let loginActive = loginItem.isActive();
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
      launchAtLoginActive: loginActive,
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

  function buildReport(): Record<string, unknown> {
    const h = requireHost();
    return buildDiagnosticsReport({
      generatedAt: new Date(),
      versions: { app: version, electron: process.versions.electron, chrome: process.versions.chrome, node: process.versions.node, v8: process.versions.v8 },
      os: { platform: process.platform, release: os.release(), arch: os.arch(), totalMemoryMB: Math.round(os.totalmem() / 1048576), locale: app.getLocale() },
      world: display.world,
      settings: settings.get(),
      apiKeysStored: { anthropic: secrets.has('anthropic'), openaiCompatible: secrets.has('openai-compatible') },
      status: status(),
      cat: sim.debugInfo(),
      services: {
        host: h.debug(),
        overlays: overlays.info().map(({ hwnd: _hwnd, ...o }) => o),
        windowTracker: tracker.debugInfo(),
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
    onSessionEnd: saveAllSync,
    isLeftButtonDown: () => (win32.available ? win32.isLeftButtonDown() : null),
    clock: () => performance.now(),
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
    onStatusChange: () => {
      if (host) perception?.setPaused(host.hidden || host.locked);
      refreshUi();
    },
  });
  catStore.attach(() => sim.serialize());

  const offPerceptionStatus = perception?.onStatusChange(() => refreshUi()) ?? null;
  const offDisplay = display.onChange((world) => {
    host?.onDisplayChanged(world);
    refreshUi();
  });

  function applyShortcuts(s: Settings): void {
    shortcuts.apply(s.general.shortcutsEnabled, s.general.toggleShortcut);
  }

  const offSettings = settings.onChange((next, prev) => {
    host?.updateSettings(next);
    attempt(log, 'perception settings', () => perception?.updateSettings(next));
    attempt(log, 'overlay settings', () => overlays.applySettings(next, prev));
    logger.setLevel(next.diagnostics.logLevel);
    if (prev.general.shortcutsEnabled !== next.general.shortcutsEnabled || prev.general.toggleShortcut !== next.general.toggleShortcut) {
      applyShortcuts(next);
    }
    if (prev.general.launchAtLogin !== next.general.launchAtLogin) {
      loginItem.onSettingChanged(next.general.launchAtLogin);
      loginActive = loginItem.isActive();
    }
    if (
      JSON.stringify(prev.perception.excludedProcesses) !== JSON.stringify(next.perception.excludedProcesses) ||
      JSON.stringify(prev.perception.excludedTitlePatterns) !== JSON.stringify(next.perception.excludedTitlePatterns)
    ) {
      attempt(log, 'window exclusions', () => tracker.setExclusions(next.perception.excludedProcesses, next.perception.excludedTitlePatterns));
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
      attempt(log, 'perception settings', () => perception?.updateSettings(settings.get()));
      refreshUi();
    },
    clock: () => performance.now(),
  });

  // Power and session events. Windows does not emit before-quit on shutdown/logoff,
  // so state is saved synchronously on every signal that the session may end.
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
  powerMonitor.on('shutdown', saveAllSync);

  async function disposeAll(): Promise<void> {
    const steps: Array<[string, () => void]> = [
      ['host', () => host?.stop()],
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
          powerMonitor.removeListener('shutdown', saveAllSync);
        },
      ],
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

  installTestHooks({
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
    forceInteractive: (v) => overlays.forceInteractive(v),
    setTimeScale: (s) => requireHost().setTimeScale(s),
    runAction: (a) => actions.run(a),
    patchSettings: (p) => settings.patchUnknown(p),
    openSettings: () => settingsWindow.open(),
    saveNow: saveAllSync,
    quit: () => app.quit(),
  });

  // Start everything.
  attempt(log, 'window tracker start', () => tracker.start());
  attempt(log, 'activity monitor start', () => activity.start());
  host.updateSettings(initial);
  overlays.start();
  host.start();
  resources.start();
  applyShortcuts(initial);
  refreshUi();
  log.info('started', {
    version,
    displays: display.world.displays.length,
    windowAwareness: tracker.mode,
    win32: win32.available,
    perception: perception?.status.mode ?? 'unavailable',
    launchedAtLogin: boot.flags.launchedAtLogin,
    test: boot.flags.test,
  });

  if (!initial.general.firstRunCompleted && !boot.flags.launchedAtLogin) settingsWindow.open('welcome');

  return {
    onSecondInstance() {
      const h = requireHost();
      log.info('second instance launched; surfacing the cat');
      if (h.hidden) h.setHidden(false);
      h.callCat();
      settingsWindow.open();
    },
  };
}
