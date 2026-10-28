// Launch-at-login. The registry entry is written only when the user changes the
// setting: writing it on every start would override a "Disabled" choice the user
// made in Task Manager (setLoginItemSettings with enabled:true clears it).
import type { Logger } from '../contracts';
import { LAUNCHED_AT_LOGIN_FLAG } from './launchArgs';

export interface LoginItemApi {
  getLoginItemSettings(options?: { path?: string; args?: string[] }): { openAtLogin: boolean; executableWillLaunchAtLogin?: boolean };
  setLoginItemSettings(settings: { openAtLogin: boolean; path?: string; args?: string[] }): void;
}

export interface LoginItemController {
  /** Whether Windows will actually start the app at login (reads the registry state). */
  isActive(): boolean;
  /** Call when the setting changed from `prev` to `next`. */
  onSettingChanged(next: boolean): void;
}

export interface LoginItemOptions {
  api: LoginItemApi;
  logger: Logger;
  execPath: string;
  /** Unpackaged runs must pass the app directory to electron.exe. */
  appPathArg: string | null;
  /** Test runs never touch the real registry. */
  writesEnabled: boolean;
}

export function createLoginItemController(opts: LoginItemOptions): LoginItemController {
  const args = opts.appPathArg ? [`"${opts.appPathArg}"`, LAUNCHED_AT_LOGIN_FLAG] : [LAUNCHED_AT_LOGIN_FLAG];
  const query = { path: opts.execPath, args };

  return {
    isActive() {
      try {
        const s = opts.api.getLoginItemSettings(query);
        return s.openAtLogin && s.executableWillLaunchAtLogin !== false;
      } catch (err) {
        opts.logger.warn('reading login item failed', { error: err });
        return false;
      }
    },
    onSettingChanged(next) {
      if (!opts.writesEnabled) {
        opts.logger.info('login item change skipped (test mode)', { openAtLogin: next });
        return;
      }
      try {
        opts.api.setLoginItemSettings({ openAtLogin: next, path: opts.execPath, args });
        opts.logger.info('login item updated', { openAtLogin: next });
      } catch (err) {
        opts.logger.error('updating login item failed', { error: err });
      }
    },
  };
}
