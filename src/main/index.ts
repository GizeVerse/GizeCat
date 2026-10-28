// Main-process entry. Order matters: userData must be set before the single
// instance lock (the lock is keyed on it) and before anything reads paths;
// scheme privileges, sandboxing and the GPU switch must happen before 'ready'.
import fs from 'node:fs';
import path from 'node:path';
import { app, dialog } from 'electron';
import { startApp, type RunningApp } from './app';
import { createLogger, type LogLevel, type RootLogger } from './diagnostics/logger';
import { appVersion } from './lifecycle/appInfo';
import { createCrashGuard } from './lifecycle/crashGuard';
import { hasFlag, isTestMode, LAUNCHED_AT_LOGIN_FLAG, parseTimeScale, parseUserDataOverride } from './lifecycle/launchArgs';
import { registerAppSchemePrivileges } from './protocol';
import { createJsonStore } from './store/jsonStore';
import { createSettingsStore } from './store/settingsStore';

export const APP_USER_MODEL_ID = 'io.github.enesiltas.desktopcat';

/**
 * A process that fails to start must exit: with no tray or window it would be invisible,
 * yet it holds the single-instance lock, so every later launch would silently hand over
 * to it. Outside tests the user is told (showErrorBox is safe before 'ready').
 */
function exitAfterStartupFailure(err: unknown, logger: RootLogger | null, test: boolean): void {
  try {
    if (logger) {
      logger.child('boot').error('startup failed', { error: err });
      logger.flushSync();
    } else {
      console.error('Desktop Cat: startup failed', err);
    }
  } catch {
    /* exiting anyway */
  }
  if (!test) {
    try {
      const where = logger?.logDir ? `\n\nDetails were written to the log in:\n${logger.logDir}` : '';
      dialog.showErrorBox('Desktop Cat could not start', `Desktop Cat ran into a problem while starting and has closed.${where}`);
    } catch {
      /* exiting anyway */
    }
  }
  app.exit(1);
}

function main(): void {
  const test = isTestMode(process.env);
  const boot: { logger: RootLogger | null } = { logger: null };
  try {
    start(test, boot);
  } catch (err) {
    exitAfterStartupFailure(err, boot.logger, test);
  }
}

/** Everything up to 'ready' (startApp runs after it). Throws on failure; boot.logger is set as soon as it exists. */
function start(test: boolean, boot: { logger: RootLogger | null }): void {
  const startedAt = Date.now();
  const dev = hasFlag(process.argv, '--dev');
  const launchedAtLogin = hasFlag(process.argv, LAUNCHED_AT_LOGIN_FLAG);

  const userDataOverride = parseUserDataOverride(process.env, process.argv);
  if (userDataOverride) {
    fs.mkdirSync(userDataOverride, { recursive: true });
    app.setPath('userData', userDataOverride);
  }
  app.setAppUserModelId(APP_USER_MODEL_ID);

  if (!app.requestSingleInstanceLock({ kind: 'desktop-cat:second-instance' })) {
    // The running instance surfaces the cat (second-instance event); nothing else to do here.
    app.exit(0);
    return;
  }

  // Registered first, so a second launch reaches this process even while it is still starting.
  let running: RunningApp | null = null;
  let pendingSecondInstance = false;
  app.on('second-instance', () => {
    if (running) running.onSecondInstance();
    else pendingSecondInstance = true;
  });

  registerAppSchemePrivileges();
  app.enableSandbox();

  const userData = app.getPath('userData');
  const mirror = dev || test ? (level: LogLevel, line: string) => (level === 'error' || level === 'warn' ? console.error(line) : console.log(line)) : undefined;
  const logger = createLogger({ dir: path.join(userData, 'logs'), level: 'info', mirror });
  boot.logger = logger;
  const log = logger.child('boot');

  const crashGuard = createCrashGuard({
    historyFile: path.join(userData, 'relaunch-history.json'),
    relaunch: () => app.relaunch(),
    exit: (code) => app.exit(code),
    // Under test a relaunched process would escape the test runner's control: exit instead.
    maxRelaunches: test ? 0 : 3,
  });
  crashGuard.setLogger(logger.child('crash'));
  crashGuard.setFlusher(() => logger.flushSync());
  process.on('uncaughtException', (err) => crashGuard.handle('uncaughtException', err));
  process.on('unhandledRejection', (reason) => crashGuard.handle('unhandledRejection', reason));

  // Settings are read before 'ready' because the GPU switch must be applied now.
  const settings = createSettingsStore({
    store: createJsonStore({ filePath: path.join(userData, 'settings.json'), logger: logger.child('store') }),
    logger: logger.child('settings'),
  });
  const loaded = settings.load();
  logger.setLevel(loaded.settings.diagnostics.logLevel);
  if (!loaded.settings.diagnostics.hardwareAcceleration) {
    app.disableHardwareAcceleration();
    log.info('hardware acceleration disabled by setting');
  }
  log.info('starting', { version: appVersion(() => app.getVersion()), electron: process.versions.electron, packaged: app.isPackaged, dev, test, launchedAtLogin, settings: loaded.status });

  app
    .whenReady()
    .then(() => {
      const started = startApp({
        logger,
        settings,
        settingsLoadStatus: loaded.status,
        crashGuard,
        userData,
        flags: { dev, test, launchedAtLogin },
        timeScale: test ? parseTimeScale(process.env) : 1,
        startedAt,
      });
      running = started;
      crashGuard.setStarted();
      if (pendingSecondInstance) started.onSecondInstance();
    })
    .catch((err: unknown) => exitAfterStartupFailure(err, logger, test));
}

main();
