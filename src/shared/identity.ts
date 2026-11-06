// Frozen identifiers (ADR 0004 §9; audit §4.1). These are NOT display names: each one names
// something that already exists on users' machines (folders, registry values, file tags, shortcuts)
// or that code and tools match on. Renaming one loses users' cats, settings, API keys, startup
// entries or downgrade protection, so none of them follows the product name in brand.ts.
// tests/unit/shared/identity.test.ts pins every entry against its source of truth (package.json,
// electron-builder.yml, build/installer.nsh and the code). Ask the owner before changing any.

export const IDENTITY = Object.freeze({
  /**
   * electron-builder `appId`. The NSIS GUID is derived from it (UUIDv5), so a new value makes an
   * upgrade miss the old install: a second Apps entry, and uninstalling the stale one can remove
   * the shared data folder and the startup entry.
   */
  appId: 'io.github.enesiltas.desktopcat',
  /**
   * Windows AppUserModelID (src/main/index.ts), stamped on the installer's shortcuts: taskbar pins
   * and grouping, and notification settings, are keyed on it.
   */
  appUserModelId: 'io.github.enesiltas.desktopcat',
  /**
   * Value name of the HKCU Run / StartupApproved\Run entry (src/main/lifecycle/loginItem.ts), also
   * removed by build/installer.nsh. A new name turns launch-at-login off while the old entry keeps
   * launching the app, and loses a Task Manager "Disabled" choice.
   */
  loginItemName: 'io.github.enesiltas.desktopcat',
  /**
   * package.json `name`: the Linux executable and .desktop name, and electron-updater's cache
   * folder (%LOCALAPPDATA%\desktop-cat-updater).
   */
  packageName: 'desktop-cat',
  /**
   * package.json `productName` = app.getName(): the default userData folder, the macOS bundle
   * (`Desktop Cat.app`), its Keychain item (`Desktop Cat Safe Storage`) and the Linux os_crypt name.
   * Changing it loses the encrypted API key and, without the userData pin, everything else.
   */
  productName: 'Desktop Cat',
  /**
   * The userData folder under appData (%APPDATA%\Desktop Cat): settings, the cat's memories, the
   * encrypted API key, logs and the uninstall marker live there, and the single-instance lock is
   * keyed on it. src/main/index.ts pins it explicitly so a later productName change cannot move it.
   */
  userDataFolder: 'Desktop Cat',
  /**
   * electron-builder `win.executableName` (DesktopCat.exe, "Uninstall DesktopCat.exe"): the install
   * folder, the Run entry's command line and taskbar pins point at it.
   */
  windowsExecutable: 'DesktopCat',
  /** electron-builder `linux.executableName`: launchers and autostart entries made later point at it. */
  linuxExecutable: 'desktop-cat',
  /**
   * File the uninstaller leaves in the userData folder (build/installer.nsh); a reinstall reads a
   * missing startup entry with this marker as "reinstalled", not as an opt-out.
   */
  uninstallMarkerFile: 'login-item-removed-by-uninstall',
  /** `kind` of behavior-opt-outs.json (src/main/store/optOutSidecar.ts): the v1.2 downgrade protection for opt-outs. */
  optOutSidecarKind: 'desktop-cat-opt-outs',
  /** `kind` of an exported diagnostics report (src/main/diagnostics/diagnosticsReport.ts): tools and bug reports match on it. */
  diagnosticsKind: 'desktop-cat-diagnostics',
  /**
   * The data a second launch hands to the running instance with the single-instance lock
   * (src/main/index.ts). The running copy may be an older or newer build, so the tag stays.
   */
  singleInstanceLockKind: 'desktop-cat:second-instance',
  /** The renderer scheme (src/shared/ipc.ts, desktop-cat://): the navigation and IPC sender checks in security code match on it. */
  scheme: 'desktop-cat',
  /** Environment variables users and tools set: an opt-out or a portable data path must keep working. */
  env: Object.freeze({
    /** A userData override for tests and portable runs (src/main/lifecycle/launchArgs.ts). */
    userData: 'DESKTOP_CAT_USER_DATA',
    /** `off` keeps any build from writing the startup entry (src/main/lifecycle/loginItem.ts). */
    loginItem: 'DESKTOP_CAT_LOGIN_ITEM',
    /** `1` installs the end-to-end test surface in unpackaged builds (launchArgs.ts). */
    test: 'DESKTOP_CAT_TEST',
    /** Simulation time multiplier for long-run tests (launchArgs.ts). */
    timeScale: 'DESKTOP_CAT_TIME_SCALE',
  }),
  /** The overlay preload's global (`window.desktopCat`, src/preload/overlay.ts); the overlay renderer reads it. */
  overlayGlobal: 'desktopCat',
  /** The settings preload's global (`window.desktopCatSettings`, src/preload/settings.ts); the settings renderer and E2E tests read it. */
  settingsGlobal: 'desktopCatSettings',
  /** The E2E test surface (`globalThis.__desktopCatTest`, src/main/testHooks.ts); Playwright reaches it by name. */
  testHookGlobal: '__desktopCatTest',
  /** The UI Automation helper (src/main/uia/index.ts), shipped as resources/native/DesktopCatUia.exe. */
  uiaHelperExe: 'DesktopCatUia.exe',
  /** The log file in userData/logs (src/main/diagnostics/logger.ts); support instructions and tools name it. */
  logFile: 'main.log',
} as const);

export type Identity = typeof IDENTITY;
