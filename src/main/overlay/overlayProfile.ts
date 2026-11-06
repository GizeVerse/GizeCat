// Per-platform overlay window profile (ADR 0004 §5). The Windows profile is exactly what the
// overlay always used; other platforms differ in the window type, a few macOS window options
// and the Windows shell extras. Native Wayland and XWayland get no overlay at all (G5, review
// H2): a full-screen window that could take clicks it should pass through would block the
// desktop (T8). Linux X11 also needs a compositing manager at run time (app.ts, review H3).
import type { PlatformId } from '../../shared/platform';

export type OverlayWindowType = 'toolbar' | 'panel';
export type OverlayTopmostLevel = 'screen-saver' | 'floating';

export interface OverlayProfile {
  /** False: no overlay window is created on this platform. */
  readonly create: boolean;
  /** Why not (user-facing), when create is false. */
  readonly reason: string | null;
  /** BrowserWindow `type`; null leaves the platform default. */
  readonly windowType: OverlayWindowType | null;
  readonly topmostLevel: OverlayTopmostLevel;
  /**
   * macOS: deliver the first click to the non-activating panel (acceptFirstMouse defaults to
   * false there, so a non-focusable overlay would never receive it; review M2).
   */
  readonly acceptFirstMouse: boolean;
  /** macOS: keep the overlay out of Mission Control. */
  readonly hiddenInMissionControl: boolean;
  /** NonRudeHWND and the TaskbarCreated hook (Windows shell only). */
  readonly shellIntegration: boolean;
  /** Windows' query-session-end / session-end window events. */
  readonly sessionEndEvents: boolean;
}

export const WIN32_OVERLAY_PROFILE: OverlayProfile = Object.freeze({
  create: true,
  reason: null,
  // WS_EX_TOOLWINDOW: never listed in Alt-Tab.
  windowType: 'toolbar',
  // 'floating' (the default) sits below the taskbar; 'screen-saver' stays above it.
  topmostLevel: 'screen-saver',
  acceptFirstMouse: false,
  hiddenInMissionControl: false,
  shellIntegration: true,
  sessionEndEvents: true,
});

const DARWIN_OVERLAY_PROFILE: OverlayProfile = Object.freeze({
  create: true,
  reason: null,
  // NSPanel: a non-activating utility window, the documented route for overlays. No
  // setVisibleOnAllWorkspaces: it would show the Dock icon and briefly hide the window (review M1).
  windowType: 'panel',
  topmostLevel: 'screen-saver',
  acceptFirstMouse: true,
  hiddenInMissionControl: true,
  shellIntegration: false,
  sessionEndEvents: false,
});

const X11_OVERLAY_PROFILE: OverlayProfile = Object.freeze({
  create: true,
  reason: null,
  // Electron documents focusable:false on Linux as taking the window out of window-manager control,
  // so it stays on top on all workspaces; the window type would not apply, so none is set.
  windowType: null,
  topmostLevel: 'screen-saver',
  acceptFirstMouse: false,
  hiddenInMissionControl: false,
  shellIntegration: false,
  sessionEndEvents: false,
});

export const WAYLAND_NO_OVERLAY_REASON =
  'On a Wayland session apps cannot stay on top or pass clicks through reliably, so the cat is not shown. Sign in to an X11 session (for example "GNOME on Xorg") to see it.';

const NO_OVERLAY_PROFILE: OverlayProfile = Object.freeze({
  create: false,
  reason: WAYLAND_NO_OVERLAY_REASON,
  windowType: null,
  topmostLevel: 'screen-saver',
  acceptFirstMouse: false,
  hiddenInMissionControl: false,
  shellIntegration: false,
  sessionEndEvents: false,
});

export function overlayProfileFor(platform: PlatformId): OverlayProfile {
  switch (platform) {
    case 'win32':
      return WIN32_OVERLAY_PROFILE;
    case 'darwin':
      return DARWIN_OVERLAY_PROFILE;
    case 'linux-x11':
      return X11_OVERLAY_PROFILE;
    default:
      return NO_OVERLAY_PROFILE;
  }
}
