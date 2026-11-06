// Frozen identifiers (ADR 0004 §9, audit §4.1): every entry of src/shared/identity.ts is pinned
// to the literal value 1.x installs use AND to its source of truth (package.json,
// electron-builder.yml, build/installer.nsh, the code). A rename for branding must fail here.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { createLogger } from '../../../src/main/diagnostics/logger';
import { isTestMode, parseTimeScale, parseUserDataOverride } from '../../../src/main/lifecycle/launchArgs';
import { LOGIN_ITEM_ENV, LOGIN_ITEM_NAME, UNINSTALL_MARKER_FILE, UNINSTALLER_FILE } from '../../../src/main/lifecycle/loginItem';
import { OPT_OUT_SIDECAR_KIND } from '../../../src/main/store/optOutSidecar';
import { TEST_HOOK_GLOBAL } from '../../../src/main/testHooks';
import { UIA_HELPER_EXE } from '../../../src/main/uia';
import { IDENTITY } from '../../../src/shared/identity';
import { APP_SCHEME, OVERLAY_URL, SETTINGS_URL } from '../../../src/shared/ipc';

const ROOT = path.resolve(__dirname, '..', '..', '..');
const read = (...parts: string[]): string => fs.readFileSync(path.join(ROOT, ...parts), 'utf8');

/** What every 1.x install already has on disk and in the registry. Never edit to match a rename. */
const FROZEN = {
  appId: 'io.github.enesiltas.desktopcat',
  appUserModelId: 'io.github.enesiltas.desktopcat',
  loginItemName: 'io.github.enesiltas.desktopcat',
  packageName: 'desktop-cat',
  productName: 'Desktop Cat',
  userDataFolder: 'Desktop Cat',
  windowsExecutable: 'DesktopCat',
  linuxExecutable: 'desktop-cat',
  uninstallMarkerFile: 'login-item-removed-by-uninstall',
  optOutSidecarKind: 'desktop-cat-opt-outs',
  diagnosticsKind: 'desktop-cat-diagnostics',
  singleInstanceLockKind: 'desktop-cat:second-instance',
  scheme: 'desktop-cat',
  env: { userData: 'DESKTOP_CAT_USER_DATA', loginItem: 'DESKTOP_CAT_LOGIN_ITEM', test: 'DESKTOP_CAT_TEST', timeScale: 'DESKTOP_CAT_TIME_SCALE' },
  overlayGlobal: 'desktopCat',
  settingsGlobal: 'desktopCatSettings',
  testHookGlobal: '__desktopCatTest',
  uiaHelperExe: 'DesktopCatUia.exe',
  logFile: 'main.log',
};

/** A top-level scalar of electron-builder.yml. */
function ymlTop(yml: string, key: string): string | undefined {
  return new RegExp(`^${key}:[ \\t]*(.+?)[ \\t]*$`, 'm').exec(yml)?.[1];
}

/** The indented block under a top-level key of electron-builder.yml. */
function ymlSection(yml: string, key: string): string {
  const lines = yml.split(/\r?\n/);
  const start = lines.indexOf(`${key}:`);
  if (start < 0) throw new Error(`electron-builder.yml has no ${key}: section`);
  const body: string[] = [];
  for (const line of lines.slice(start + 1)) {
    if (/^[^\s#]/.test(line)) break;
    body.push(line);
  }
  return body.join('\n');
}

const sectionValue = (section: string, key: string): string | undefined => new RegExp(`^[ \\t]+${key}:[ \\t]*(.+?)[ \\t]*$`, 'm').exec(section)?.[1];

describe('frozen identifiers (identity.ts)', () => {
  it('hold the values every 1.x install uses, and cannot be changed at run time', () => {
    expect(IDENTITY).toEqual(FROZEN);
    expect(Object.isFrozen(IDENTITY)).toBe(true);
    expect(Object.isFrozen(IDENTITY.env)).toBe(true);
  });

  it('package.json: name and productName (= app.getName(), the default userData folder)', () => {
    const pkg = JSON.parse(read('package.json')) as { name: string; productName: string };
    expect(pkg.name).toBe(FROZEN.packageName);
    expect(pkg.productName).toBe(FROZEN.productName);
    // Electron's default userData is <appData>/<productName>; the pin in index.ts names the same folder.
    expect(FROZEN.userDataFolder).toBe(pkg.productName);
  });

  it('electron-builder.yml: appId, productName, win and linux executable names, the UIA helper', () => {
    const yml = read('electron-builder.yml');
    expect(ymlTop(yml, 'appId')).toBe(FROZEN.appId);
    expect(ymlTop(yml, 'productName')).toBe(FROZEN.productName);
    const win = ymlSection(yml, 'win');
    expect(sectionValue(win, 'executableName')).toBe(FROZEN.windowsExecutable);
    expect(win).toContain(`to: native/${FROZEN.uiaHelperExe}`);
    expect(sectionValue(ymlSection(yml, 'linux'), 'executableName')).toBe(FROZEN.linuxExecutable);
    // The Linux executable is the npm name (ADR 0004 §9).
    expect(FROZEN.linuxExecutable).toBe(FROZEN.packageName);
  });

  it('build/installer.nsh: the Run value name and the marker in the userData folder', () => {
    const nsh = read('build', 'installer.nsh');
    // Read, StartupApproved check and both deletions name the same value.
    const names = nsh.match(/io\.github\.[\w.]+/g) ?? [];
    expect(names).toHaveLength(4);
    expect(new Set(names)).toEqual(new Set([FROZEN.loginItemName]));
    expect(nsh).toContain(`ReadRegStr $R8 HKCU "Software\\Microsoft\\Windows\\CurrentVersion\\Run" "${FROZEN.loginItemName}"`);
    // Every %APPDATA% path is the userData folder, and the marker is written there.
    const folders = [...nsh.matchAll(/\$APPDATA\\([^\\"]+)\\/g)].map((m) => m[1]);
    expect(folders.length).toBeGreaterThanOrEqual(2);
    expect(new Set(folders)).toEqual(new Set([FROZEN.userDataFolder]));
    expect(nsh).toContain(`FileOpen $R7 "$APPDATA\\${FROZEN.userDataFolder}\\${FROZEN.uninstallMarkerFile}" w`);
  });

  it('src/main/index.ts: the AppUserModelID, the lock data and the userData pin come from identity.ts', () => {
    // index.ts starts the app on import, so its source is checked (startup.test.ts runs it against a fake app).
    const index = read('src', 'main', 'index.ts');
    expect(index).toContain('APP_USER_MODEL_ID = IDENTITY.appUserModelId;');
    expect(index).toContain('app.requestSingleInstanceLock({ kind: IDENTITY.singleInstanceLockKind })');
    expect(index).toContain("path.join(app.getPath('appData'), IDENTITY.userDataFolder)");
    expect(index).not.toMatch(/io\.github\.|desktop-cat:/);
  });

  it('the login item: value name, environment switch, uninstall marker and uninstaller', () => {
    expect(LOGIN_ITEM_NAME).toBe(FROZEN.loginItemName);
    expect(LOGIN_ITEM_ENV).toBe(FROZEN.env.loginItem);
    expect(UNINSTALL_MARKER_FILE).toBe(FROZEN.uninstallMarkerFile);
    expect(UNINSTALLER_FILE).toBe(`Uninstall ${FROZEN.windowsExecutable}.exe`);
    // Electron names the Run value after the AppUserModelID when none is given.
    expect(FROZEN.loginItemName).toBe(FROZEN.appUserModelId);
    expect(FROZEN.appUserModelId).toBe(FROZEN.appId);
  });

  it('the opt-out sidecar kind and the renderer scheme', () => {
    expect(OPT_OUT_SIDECAR_KIND).toBe(FROZEN.optOutSidecarKind);
    expect(APP_SCHEME).toBe(FROZEN.scheme);
    expect(OVERLAY_URL.startsWith(`${FROZEN.scheme}://app/`)).toBe(true);
    expect(SETTINGS_URL.startsWith(`${FROZEN.scheme}://app/`)).toBe(true);
  });

  it('the environment variables users and tools set', () => {
    const dir = path.join(os.tmpdir(), 'portable-cat');
    expect(parseUserDataOverride({ [FROZEN.env.userData]: dir }, [])).toBe(path.resolve(dir));
    expect(isTestMode({ [FROZEN.env.test]: '1' })).toBe(true);
    expect(parseTimeScale({ [FROZEN.env.timeScale]: '4' })).toBe(4);
  });

  it('preload globals, the test hook, the UIA helper and the log file', async () => {
    expect(read('src', 'preload', 'overlay.ts')).toContain(`contextBridge.exposeInMainWorld('${FROZEN.overlayGlobal}', api)`);
    expect(read('src', 'preload', 'settings.ts')).toContain(`contextBridge.exposeInMainWorld('${FROZEN.settingsGlobal}', api)`);
    expect(read('src', 'renderer', 'overlay', 'main.ts')).toContain(`window.${FROZEN.overlayGlobal};`);
    expect(read('src', 'renderer', 'settings', 'main.ts')).toContain(`window.${FROZEN.settingsGlobal};`);
    expect(TEST_HOOK_GLOBAL).toBe(FROZEN.testHookGlobal);
    expect(UIA_HELPER_EXE).toBe(FROZEN.uiaHelperExe);
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dcat-identity-'));
    try {
      const log = createLogger({ dir });
      expect(log.logFile).toBe(path.join(dir, FROZEN.logFile));
      await log.dispose();
    } finally {
      fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5 });
    }
  });
});
