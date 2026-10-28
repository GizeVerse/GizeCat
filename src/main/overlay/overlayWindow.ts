// Construction of one per-display overlay window. The window is created at its
// display's work area and is never hidden, minimised or moved afterwards
// (Electron #41063, #27651, #54627); the renderer simply draws nothing when the
// cat is elsewhere.
import { BrowserWindow } from 'electron';
import { OVERLAY_URL } from '../../shared/ipc';
import type { DisplayGeometry } from '../../shared/world';

export interface OverlayWindowOptions {
  display: DisplayGeometry;
  preloadPath: string;
  devTools: boolean;
  contentProtection: boolean;
}

export function overlayUrl(displayId: string): string {
  return `${OVERLAY_URL}?display=${encodeURIComponent(displayId)}`;
}

export function createOverlayWindow(opts: OverlayWindowOptions): BrowserWindow {
  const wa = opts.display.workAreaDip;
  const win = new BrowserWindow({
    x: Math.round(wa.x),
    y: Math.round(wa.y),
    width: Math.round(wa.width),
    height: Math.round(wa.height),
    show: false,
    frame: false,
    transparent: true,
    backgroundColor: '#00000000',
    hasShadow: false,
    roundedCorners: false,
    thickFrame: false,
    resizable: false,
    movable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    focusable: false,
    skipTaskbar: true,
    // WS_EX_TOOLWINDOW: never listed in Alt-Tab.
    type: 'toolbar',
    alwaysOnTop: true,
    title: 'Desktop Cat',
    enableLargerThanScreen: false,
    webPreferences: {
      preload: opts.preloadPath,
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      webSecurity: true,
      backgroundThrottling: false,
      spellcheck: false,
      devTools: opts.devTools,
    },
  });
  // 'floating' (the default) sits below the taskbar; 'screen-saver' stays above it.
  win.setAlwaysOnTop(true, 'screen-saver');
  win.setIgnoreMouseEvents(true);
  win.setContentProtection(opts.contentProtection);
  return win;
}
