// The single settings/onboarding window. Created on demand, focused if already
// open, destroyed on close. Nothing about the cat depends on it.
import { BrowserWindow, nativeTheme, type NativeImage, type WebContents } from 'electron';
import type { Logger } from './contracts';
import { BRAND } from '../shared/brand';
import { SETTINGS_URL } from '../shared/ipc';
import type { WindowRegistry } from './security';

/** Page ids understood by the settings renderer's hash router. */
export type SettingsPage =
  | 'welcome'
  | 'general'
  | 'appearance'
  | 'behavior'
  | 'interaction'
  | 'privacy'
  | 'ai'
  | 'personality'
  | 'diagnostics'
  | 'about';

export interface OpenOptions {
  /**
   * false = show without asking for the foreground. Use it when the app opens the window on its own
   * (first-run Welcome): if Windows refuses a focus request from a process the user did not just
   * interact with, it flashes the taskbar button and keeps an auto-hide taskbar revealed until the
   * window is clicked (observed on Windows 11 26200). Default true for user-initiated opens.
   */
  activate?: boolean;
}

export interface SettingsWindowController {
  open(page?: SettingsPage, opts?: OpenOptions): void;
  close(): void;
  readonly isOpen: boolean;
  readonly webContents: WebContents | null;
  /** Sends to the settings renderer if it is open and loaded. */
  send(channel: string, payload: unknown): void;
  dispose(): void;
}

export interface SettingsWindowOptions {
  preloadPath: string;
  registry: WindowRegistry;
  logger: Logger;
  devTools: boolean;
  icon?: NativeImage;
}

export function createSettingsWindowController(opts: SettingsWindowOptions): SettingsWindowController {
  const log = opts.logger;
  let win: BrowserWindow | null = null;
  let loaded = false;

  const background = (): string => (nativeTheme.shouldUseDarkColors ? '#1f1f23' : '#f6f5f3');
  const onThemeUpdated = (): void => {
    if (win && !win.isDestroyed()) win.setBackgroundColor(background());
  };
  nativeTheme.on('updated', onThemeUpdated);

  function urlFor(page: SettingsPage | undefined): string {
    return page ? `${SETTINGS_URL}#${page}` : SETTINGS_URL;
  }

  function reveal(target: BrowserWindow, activate: boolean): void {
    if (activate) {
      target.show();
      target.focus();
    } else {
      target.showInactive();
    }
  }

  function open(page?: SettingsPage, openOpts: OpenOptions = {}): void {
    const activate = openOpts.activate !== false;
    if (win && !win.isDestroyed()) {
      // Same-document (fragment) navigation: the page sees a hashchange, no reload.
      if (page) win.loadURL(urlFor(page)).catch((err: unknown) => log.warn('settings page navigation failed', { error: err }));
      if (win.isMinimized()) win.restore();
      reveal(win, activate);
      return;
    }
    loaded = false;
    const w = new BrowserWindow({
      width: 900,
      height: 640,
      minWidth: 760,
      minHeight: 520,
      show: false,
      frame: true,
      title: `${BRAND.product} — Settings`,
      backgroundColor: background(),
      autoHideMenuBar: true,
      icon: opts.icon,
      webPreferences: {
        preload: opts.preloadPath,
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false,
        webSecurity: true,
        spellcheck: false,
        devTools: opts.devTools,
      },
    });
    win = w;
    w.setMenu(null);
    opts.registry.register(w.webContents, 'settings');
    w.once('ready-to-show', () => {
      if (!w.isDestroyed()) reveal(w, activate);
    });
    w.webContents.on('did-finish-load', () => {
      loaded = true;
    });
    w.webContents.on('render-process-gone', (_e, details) => {
      log.error('settings renderer gone', { reason: details.reason, exitCode: details.exitCode });
      if (!w.isDestroyed()) w.destroy();
    });
    w.webContents.on('did-fail-load', (_e, code, description, _url, isMainFrame) => {
      if (isMainFrame) log.error('settings page failed to load', { code, description });
    });
    w.on('closed', () => {
      if (win === w) {
        win = null;
        loaded = false;
      }
    });
    w.loadURL(urlFor(page)).catch((err: unknown) => log.error('loading settings page failed', { error: err }));
  }

  return {
    open,
    close() {
      if (win && !win.isDestroyed()) win.close();
    },
    get isOpen() {
      return win !== null && !win.isDestroyed();
    },
    get webContents() {
      return win && !win.isDestroyed() ? win.webContents : null;
    },
    send(channel, payload) {
      if (!win || win.isDestroyed() || !loaded) return;
      try {
        win.webContents.send(channel, payload);
      } catch (err) {
        log.warn('send to settings failed', { channel, error: err });
      }
    },
    dispose() {
      nativeTheme.off('updated', onThemeUpdated);
      if (win && !win.isDestroyed()) win.destroy();
      win = null;
    },
  };
}
