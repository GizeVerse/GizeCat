// Construction of one per-display overlay window. The window is created at its
// display's work area and is never hidden, minimised or moved afterwards
// (Electron #41063, #27651, #54627); the renderer simply draws nothing when the
// cat is elsewhere.
import { BrowserWindow } from 'electron';
import { OVERLAY_URL } from '../../shared/ipc';
import type { DisplayGeometry } from '../../shared/world';
import type { Logger } from '../contracts';
import type { Hwnd } from '../win32/native';
import { loadOverlayShellNative, type OverlayShellNative } from '../win32/taskbar/windowProps';
import { WIN32_OVERLAY_PROFILE, type OverlayProfile } from './overlayProfile';

export interface OverlayWindowOptions {
  display: DisplayGeometry;
  preloadPath: string;
  devTools: boolean;
  contentProtection: boolean;
  /** Platform window profile (ADR 0004 §5); the Windows profile when absent. */
  profile?: OverlayProfile;
}

export function overlayUrl(displayId: string): string {
  return `${OVERLAY_URL}?display=${encodeURIComponent(displayId)}`;
}

export function createOverlayWindow(opts: OverlayWindowOptions): BrowserWindow {
  const profile = opts.profile ?? WIN32_OVERLAY_PROFILE;
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
    // Windows: 'toolbar' = WS_EX_TOOLWINDOW, never listed in Alt-Tab (overlayProfile.ts).
    ...(profile.windowType ? { type: profile.windowType } : {}),
    ...(profile.acceptFirstMouse ? { acceptFirstMouse: true } : {}),
    ...(profile.hiddenInMissionControl ? { hiddenInMissionControl: true } : {}),
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
  win.setAlwaysOnTop(true, profile.topmostLevel);
  win.setIgnoreMouseEvents(true);
  win.setContentProtection(opts.contentProtection);
  return win;
}

/**
 * Shell integration of the overlay windows (ADR 0002 §2). Every method is non-fatal: failures
 * are logged and reported as false, and the overlay works on without it.
 */
export interface OverlayShell {
  /**
   * Call right before showInactive(): sets NonRudeHWND so Windows does not treat the
   * full-monitor transparent topmost overlay as a fullscreen app, which would strip the
   * taskbar's always-on-top style and break the auto-hide reveal.
   */
  beforeShow(win: BrowserWindow, displayId: string): boolean;
  /** Call right before destroy(): removes NonRudeHWND (SetPropW requires it). */
  beforeDestroy(win: BrowserWindow, displayId: string): boolean;
  /** Calls `cb` when Explorer broadcasts TaskbarCreated (taskbar re-created, e.g. Explorer restarted). */
  hookTaskbarCreated(win: BrowserWindow, cb: () => void): boolean;
}

function hwndOf(win: BrowserWindow): Hwnd | null {
  const buf = win.getNativeWindowHandle();
  if (!Buffer.isBuffer(buf) || buf.length < 8) return null;
  const h = buf.readBigUInt64LE(0);
  return h === 0n ? null : h;
}

/** `native` is injectable for tests; by default the koffi bindings are loaded on first use. */
export function createOverlayShell(logger: Logger, native?: OverlayShellNative | null): OverlayShell {
  let shell: OverlayShellNative | null | undefined = native;
  const failures = new Map<string, number>();

  function get(): OverlayShellNative | null {
    if (shell === undefined) {
      try {
        shell = loadOverlayShellNative();
      } catch (e) {
        shell = null;
        logger.warn('overlay shell integration unavailable (NonRudeHWND, TaskbarCreated)', { error: e instanceof Error ? e.message : String(e) });
      }
    }
    return shell;
  }

  function fail(op: string, data: Record<string, unknown>): false {
    const n = (failures.get(op) ?? 0) + 1;
    failures.set(op, n);
    if (n <= 3 || n % 100 === 0) logger.warn(`overlay ${op} failed`, { ...data, count: n });
    return false;
  }

  return {
    beforeShow(win, displayId) {
      const s = get();
      if (s === null) return false;
      try {
        const h = hwndOf(win);
        if (h === null) return fail('NonRudeHWND set', { displayId, reason: 'no window handle' });
        if (!s.setNonRude(h)) return fail('NonRudeHWND set', { displayId, reason: 'SetPropW returned 0' });
        logger.debug('overlay marked NonRudeHWND', { displayId });
        return true;
      } catch (e) {
        return fail('NonRudeHWND set', { displayId, error: e instanceof Error ? e.message : String(e) });
      }
    },
    beforeDestroy(win, displayId) {
      const s = get();
      if (s === null) return false;
      try {
        const h = hwndOf(win);
        if (h === null) return fail('NonRudeHWND removal', { displayId, reason: 'no window handle' });
        return s.clearNonRude(h);
      } catch (e) {
        return fail('NonRudeHWND removal', { displayId, error: e instanceof Error ? e.message : String(e) });
      }
    },
    hookTaskbarCreated(win, cb) {
      const s = get();
      if (s === null) return false;
      try {
        const msg = s.taskbarCreatedMessage();
        if (msg === null) return fail('TaskbarCreated hook', { reason: 'RegisterWindowMessageW failed' });
        win.hookWindowMessage(msg, () => cb());
        return true;
      } catch (e) {
        return fail('TaskbarCreated hook', { error: e instanceof Error ? e.message : String(e) });
      }
    },
  };
}
