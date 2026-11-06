// Platform services (ADR 0004 §3): the one place that decides what differs per OS for the
// Electron shell. The Windows adapters that already guard themselves (win32/, uia/, the
// login-item registry) are still constructed in app.ts exactly as before; this factory owns
// the per-OS choices GizeVerse adds: coordinates, overlay profile, menus, Dock, session end,
// tray notices, secret-storage policy and the platform identity.
import { createDisplayCoordinates, type DisplayCoordinates, type ScreenLike } from '../display/coordinates';
import { overlayProfileFor, type OverlayProfile } from '../overlay/overlayProfile';
import { PLATFORM_LABELS, resolvePlatformId, type PlatformId, type PlatformProbe } from '../../shared/platform';

export interface PlatformServices {
  readonly id: PlatformId;
  readonly label: string;
  readonly coordinates: DisplayCoordinates;
  readonly overlayProfile: OverlayProfile;
  /** Windows reports logoff/shutdown to top-level windows only (sessionEnd.ts). */
  readonly sessionEndWindow: boolean;
  /** powerMonitor 'shutdown' saves state (macOS, Linux): Windows uses the session-end window. */
  readonly saveOnPowerShutdown: boolean;
  /** X11: a transparent overlay needs a compositing manager, or it may render opaque over the desktop (review H3). */
  readonly x11CompositorRequired: boolean;
  /** Tray balloons (displayBalloon) exist on Windows only. */
  readonly trayBalloons: boolean;
  /** macOS needs an application menu with an Edit role for copy/paste in Settings. */
  readonly applicationMenu: 'none' | 'darwin-minimal';
  /**
   * macOS: a click on the Dock icon or a launch from Finder while running emits 'activate', not
   * 'second-instance'; it surfaces the cat and Settings like a second launch. The Dock icon stays
   * (review M3: a menu-bar icon hidden by the notch would otherwise leave the app unreachable).
   */
  readonly activateOpensSettings: boolean;
  /** Registering launch at sign-in is implemented (Windows only, ADR 0004 §7). */
  readonly loginItemSupported: boolean;
  /** Windows' AppUserModelID (taskbar grouping, notifications). */
  readonly appUserModelId: boolean;
  /** A safeStorage backend may hold API keys (Linux refuses the plaintext ones, audit R6). */
  secretBackendAllowed(backend: string | null): boolean;
}

/** safeStorage backends that do not encrypt (Linux): API keys are refused rather than stored in effect in plaintext. */
export const PLAINTEXT_SECRET_BACKENDS: ReadonlySet<string> = new Set(['basic_text', 'unknown']);

export const SECRET_BACKEND_REFUSED_REASON =
  'No system keyring is available (the only storage would be plaintext), so API keys cannot be saved. Install and unlock a Secret Service keyring (for example GNOME Keyring or KWallet).';

export function probeFromProcess(os: string, env: Readonly<Record<string, string | undefined>>, ozoneSwitch: string | null): PlatformProbe {
  const set = (v: string | undefined): boolean => typeof v === 'string' && v.length > 0;
  const waylandSession = set(env.WAYLAND_DISPLAY) || set(env.WAYLAND_SOCKET) || (env.XDG_SESSION_TYPE ?? '').toLowerCase() === 'wayland';
  return { os, waylandDisplay: waylandSession, x11Display: set(env.DISPLAY), ozonePlatform: ozoneSwitch && ozoneSwitch.length > 0 ? ozoneSwitch : null };
}

export function createPlatformServices(probe: PlatformProbe, screen: ScreenLike): PlatformServices {
  const id = resolvePlatformId(probe);
  const linux = id === 'linux-x11' || id === 'linux-xwayland' || id === 'linux-wayland';
  return {
    id,
    label: PLATFORM_LABELS[id],
    coordinates: createDisplayCoordinates(id, screen),
    overlayProfile: overlayProfileFor(id),
    sessionEndWindow: id === 'win32',
    saveOnPowerShutdown: id === 'darwin' || linux,
    x11CompositorRequired: id === 'linux-x11',
    trayBalloons: id === 'win32',
    applicationMenu: id === 'darwin' ? 'darwin-minimal' : 'none',
    activateOpensSettings: id === 'darwin',
    loginItemSupported: id === 'win32',
    appUserModelId: id === 'win32',
    secretBackendAllowed(backend) {
      if (!linux) return true;
      return backend !== null && !PLAINTEXT_SECRET_BACKENDS.has(backend);
    },
  };
}
