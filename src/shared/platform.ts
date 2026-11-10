// GizeVerse capability model (ADR 0004 §2). Pure data: what the project CLAIMS about each
// capability on each platform (declared status, with evidence) and the shape of what a running
// app DETECTS on this machine (runtime availability). Settings, diagnostics and the generated
// docs/gizeverse/capability-matrix.md all read this table; tests enforce its honesty rules.

export const PLATFORM_IDS = ['win32', 'darwin', 'linux-x11', 'linux-xwayland', 'linux-wayland', 'web', 'android', 'ios'] as const;
export type PlatformId = (typeof PLATFORM_IDS)[number];

export const PLATFORM_LABELS: Readonly<Record<PlatformId, string>> = {
  win32: 'Windows 10/11',
  darwin: 'macOS',
  'linux-x11': 'Linux (X11 session)',
  'linux-xwayland': 'Linux (Wayland session, app under XWayland)',
  'linux-wayland': 'Linux (Wayland session, native)',
  web: 'Web browser (desktop)',
  android: 'Android',
  ios: 'iOS / iPadOS',
};

export const CAPABILITY_IDS = [
  'characterView',
  'overlay',
  'clickThrough',
  'globalCursor',
  'multiDisplay',
  'windowSurfaces',
  'taskbarSurfaces',
  'tabStrips',
  'activityIdle',
  'fullscreenAware',
  'loginItem',
  'tray',
  'globalShortcut',
  'secretStorage',
  'perception',
  'touchInput',
  'sound',
  'persistence',
] as const;
export type CapabilityId = (typeof CAPABILITY_IDS)[number];

export const CAPABILITY_LABELS: Readonly<Record<CapabilityId, string>> = {
  characterView: 'The character is shown and animated',
  overlay: 'Drawn over other apps (transparent, always on top)',
  clickThrough: 'Clicks pass through everywhere except the character',
  globalCursor: 'Sees the pointer outside its own window',
  multiDisplay: 'Several displays, mixed scaling',
  windowSurfaces: "Climbs and walks on other apps' windows",
  taskbarSurfaces: 'Rides the taskbar / dock',
  tabStrips: 'Walks on browser tab strips',
  activityIdle: 'Notices when you are away',
  fullscreenAware: 'Gets out of the way of fullscreen apps',
  loginItem: 'Starts when you sign in',
  tray: 'Tray / menu-bar icon',
  globalShortcut: 'Show/hide shortcut',
  secretStorage: 'Encrypted API-key storage',
  perception: 'Optional screen perception (opt-in)',
  touchInput: 'Touch gestures (pet, drag, throw)',
  sound: 'Optional sound',
  persistence: 'Remembers the character between runs',
};

/** The brief's six statuses (ADR 0004 §2.1). */
export const VERIFICATION_STATUSES = [
  'IMPLEMENTED_AND_LOCALLY_VERIFIED',
  'IMPLEMENTED_BUT_NOT_PLATFORM_VERIFIED',
  'ARCHITECTURALLY_VALIDATED',
  'SIMULATED_OR_MOCK_TESTED',
  'BLOCKED_BY_PLATFORM_OR_PERMISSION',
  'NOT_IMPLEMENTED',
] as const;
export type VerificationStatus = (typeof VERIFICATION_STATUSES)[number];

export interface CapabilityClaim {
  readonly status: VerificationStatus;
  /** One short sentence: what exists, or what blocks it. */
  readonly note: string;
  /** Report anchor (docs path#anchor) backing a LOCALLY_VERIFIED or SIMULATED claim. */
  readonly evidence?: string;
}

/**
 * Platforms whose real desktop this repository's machine cannot run (ADR 0004 §12): their
 * capabilities can never be LOCALLY_VERIFIED. Linux runs here only in containers (Xvfb, no real
 * desktop session), which is SIMULATED_OR_MOCK_TESTED at best (review L2).
 */
export const UNREACHABLE_PLATFORMS: ReadonlySet<PlatformId> = new Set<PlatformId>(['darwin', 'linux-x11', 'linux-xwayland', 'linux-wayland', 'android', 'ios']);

const V = (note: string, evidence: string): CapabilityClaim => ({ status: 'IMPLEMENTED_AND_LOCALLY_VERIFIED', note, evidence });
const U = (note: string): CapabilityClaim => ({ status: 'IMPLEMENTED_BUT_NOT_PLATFORM_VERIFIED', note });
const A = (note: string): CapabilityClaim => ({ status: 'ARCHITECTURALLY_VALIDATED', note });
const S = (note: string, evidence: string): CapabilityClaim => ({ status: 'SIMULATED_OR_MOCK_TESTED', note, evidence });
const B = (note: string): CapabilityClaim => ({ status: 'BLOCKED_BY_PLATFORM_OR_PERMISSION', note });
const N = (note: string): CapabilityClaim => ({ status: 'NOT_IMPLEMENTED', note });

const WIN_REPORT = 'docs/TEST_REPORT.md#v120-2026-11-05-a-lively-cat';
const WEB_REPORT = 'docs/gizeverse/07-web-host.md#results';
const LINUX_XVFB = 'docs/gizeverse/05-linux.md#the-app-under-xvfb-simulated-desktop';
const WIN_V11 = 'docs/TEST_REPORT.md';

/**
 * Declared status per platform and capability. Change a cell only together with the evidence
 * (a report section) or the code that justifies it; `npm run capability-matrix` regenerates the docs.
 */
export const CAPABILITY_MATRIX: Readonly<Record<PlatformId, Readonly<Record<CapabilityId, CapabilityClaim>>>> = {
  win32: {
    characterView: V('Procedural rig in per-display overlays (run on x64 hardware; the 1.4.0 ARM64 build has never run).', WIN_REPORT),
    overlay: V('Transparent, topmost, non-focusable toolbar windows; NonRudeHWND keeps the taskbar topmost.', WIN_REPORT),
    clickThrough: V('Interactive only over the hit region while the renderer is healthy (T8).', WIN_REPORT),
    globalCursor: V('GetCursorPos poll in main.', WIN_REPORT),
    multiDisplay: U('Per-display overlays with physical-px world; unit-tested with synthetic layouts, no multi-monitor hardware here.'),
    windowSurfaces: V('Window tops and sides via DWM frame bounds and WinEvent hooks.', WIN_REPORT),
    taskbarSurfaces: V('Auto-hiding bottom taskbar as a moving ledge (riding a physically revealed taskbar: not observed).', WIN_V11),
    tabStrips: V('Edge and Chrome tab strips via the bundled UI Automation helper (geometry only).', WIN_REPORT),
    activityIdle: V('GetLastInputInfo; typing-like activity inferred without a keyboard hook.', WIN_V11),
    fullscreenAware: V('SHQueryUserNotificationState.', WIN_V11),
    loginItem: V('Per-user Run entry written by the installed app; opt-outs respected.', WIN_V11),
    tray: V('Tray icon and menu.', WIN_V11),
    globalShortcut: V('Ctrl+Alt+Shift+C (configurable).', WIN_V11),
    secretStorage: V('safeStorage (DPAPI).', WIN_V11),
    perception: V('Opt-in, off by default; privacy gate in main; exclusions by executable name.', WIN_V11),
    touchInput: N('The desktop overlay is driven by the mouse; no touchscreen was available to test.'),
    sound: V('Optional WebAudio cues, off by default.', WIN_REPORT),
    persistence: V('Versioned JSON in %APPDATA%, corrupt-file recovery.', WIN_V11),
  },
  darwin: {
    characterView: U('Same renderer; overlays use logical coordinates (points). On the floor of the work area only (no window climbing). Never run on a Mac.'),
    overlay: U("Panel at the floating level (below menus, the menu bar and the Dock); on every Space and above fullscreen apps by Electron's panel behaviour; accepts the first click; hidden from Mission Control. Never run on a Mac."),
    clickThrough: U('setIgnoreMouseEvents plus the shared hit-region poll. Never run on a Mac.'),
    globalCursor: U('screen.getCursorScreenPoint (documented to need no permission).'),
    multiDisplay: U('Logical coordinates (points) avoid mixed-scale overlap; synthetic layouts only.'),
    windowSurfaces: N('Floor only in 1.4.0: the only permission-free source of window bounds (CGWindowListCopyWindowInfo) needs native code that has never run.'),
    taskbarSurfaces: N('The Dock is not modelled as a surface.'),
    tabStrips: N('Windows UI Automation only.'),
    activityIdle: U('powerMonitor.getSystemIdleTime.'),
    fullscreenAware: N('No detection; panel overlays also show over fullscreen apps, so the fullscreen setting has no effect.'),
    loginItem: U('SMAppService via setLoginItemSettings; opt-in (off by default), needs the app in /Applications; never run on a Mac.'),
    tray: U('Template menu-bar icon (a different shape per state); a click opens the menu; the Dock icon is on by default and can be turned off in Settings.'),
    globalShortcut: U('Electron globalShortcut (Control+Option+Shift+C); the shortcut field also accepts Command. Never run on a Mac.'),
    secretStorage: U('safeStorage (Keychain); with no key stored, status checks do not touch the Keychain. Never run on a Mac.'),
    perception: B('Fails closed: exclusions are Windows executable names and capture needs a Screen Recording consent design; 1.4.0 asks for no macOS permission.'),
    touchInput: N('Desktop overlay is pointer-driven.'),
    sound: U('Same WebAudio cues.'),
    persistence: U('JSON in ~/Library/Application Support.'),
  },
  'linux-x11': {
    characterView: S('Ran under Xvfb in a container (Chromium sandbox on): created with a compositing manager, on the floor only. No real desktop session.', LINUX_XVFB),
    overlay: S('Override-redirect window, created only while a compositing manager owns _NET_WM_CM_S<n>, withdrawn when it stops (Xvfb + xcompmgr).', LINUX_XVFB),
    clickThrough: S('X-server click routing passes through the overlay, except one pixel: Chromium leaves a 1x1 input rectangle at the window origin (a click at the top-left corner is swallowed).', LINUX_XVFB),
    globalCursor: U('screen.getCursorScreenPoint (X11 pointer query).'),
    multiDisplay: U('Logical coordinates; synthetic layouts only.'),
    windowSurfaces: N('_NET_CLIENT_LIST_STACKING could provide geometry; not implemented.'),
    taskbarSurfaces: N('Panels are not modelled as surfaces.'),
    tabStrips: N('Windows UI Automation only.'),
    activityIdle: U('powerMonitor.getSystemIdleTime.'),
    fullscreenAware: N('No fullscreen detection off Windows yet.'),
    loginItem: N('XDG autostart not implemented yet (ADR 0004 §7); nothing is written.'),
    tray: U('StatusNotifier tray; GNOME needs the AppIndicator extension.'),
    globalShortcut: U('Electron globalShortcut (X11 key grab).'),
    secretStorage: U('safeStorage via libsecret or KWallet; the plaintext basic_text backend is refused.'),
    perception: B('Fails closed: no per-OS process identity for privacy exclusions yet.'),
    touchInput: N('Desktop overlay is pointer-driven.'),
    sound: U('Same WebAudio cues.'),
    persistence: U('JSON in ~/.config.'),
  },
  'linux-xwayland': {
    characterView: B('No overlay under XWayland: X11 apps do not see the pointer over Wayland windows, so a stale position could make the overlay take clicks (T8). Use an X11 session.'),
    overlay: B('Disabled until verified on real hardware (review H2).'),
    clickThrough: B('See overlay.'),
    globalCursor: B('XWayland reports the pointer only over X11 windows.'),
    multiDisplay: B('No overlay.'),
    windowSurfaces: B('Wayland windows are not visible to X11 clients.'),
    taskbarSurfaces: B('Shell geometry is not exposed.'),
    tabStrips: B('Windows UI Automation only.'),
    activityIdle: U('powerMonitor.getSystemIdleTime.'),
    fullscreenAware: B('Not exposed to X11 clients for Wayland windows.'),
    loginItem: N('XDG autostart not implemented yet.'),
    tray: U('StatusNotifier tray (desktop dependent).'),
    globalShortcut: U('X11 key grab; may only work while an X11 window has focus.'),
    secretStorage: U('safeStorage via libsecret or KWallet; basic_text refused.'),
    perception: B('No per-OS privacy identity; fails closed.'),
    touchInput: N('No overlay.'),
    sound: U('Same WebAudio cues (Settings only).'),
    persistence: U('JSON in ~/.config.'),
  },
  'linux-wayland': {
    characterView: B('No overlay on native Wayland (see overlay); sign in to an X11 session.'),
    overlay: B('Wayland gives clients no always-on-top or positioning; a full-screen overlay could block clicks (T8), so none is created.'),
    clickThrough: B('Input regions may apply late on Mutter; the overlay is not created.'),
    globalCursor: B('Wayland does not expose the global pointer to clients.'),
    multiDisplay: B('Window positioning is not available to clients.'),
    windowSurfaces: B('Other windows are not visible to clients by design.'),
    taskbarSurfaces: B('Shell geometry is not exposed.'),
    tabStrips: B('Windows UI Automation only.'),
    activityIdle: U('powerMonitor.getSystemIdleTime (may report 0 on some compositors).'),
    fullscreenAware: B('Not exposed to clients.'),
    loginItem: N('XDG autostart not implemented yet.'),
    tray: U('StatusNotifier tray (desktop dependent).'),
    globalShortcut: B('Global key grabs need the GlobalShortcuts portal; not implemented.'),
    secretStorage: U('safeStorage via libsecret or KWallet; basic_text refused.'),
    perception: B('Needs the ScreenCast portal and a per-OS privacy identity.'),
    touchInput: N('Desktop overlay is not created.'),
    sound: U('Same WebAudio cues (Settings only).'),
    persistence: U('JSON in ~/.config.'),
  },
  web: {
    characterView: V('The real sim, host and renderer in a page (Chrome 156 and Edge 156 on Windows 11, 1.3.0); the 1.4.0 installable web app has not run in a browser.', WEB_REPORT),
    overlay: B('A web page cannot draw over other apps; the character lives inside the page.'),
    clickThrough: V('In-page: the page keeps its clicks outside the hit region; a press on the cat stays with the cat (1.3.0 run; the 1.4.0 toolbar has not run).', WEB_REPORT),
    globalCursor: B('Browsers report the pointer only over the page.'),
    multiDisplay: B('One viewport.'),
    windowSurfaces: B('Browsers do not expose other windows.'),
    taskbarSurfaces: B('Not exposed to pages.'),
    tabStrips: B('Not exposed to pages.'),
    activityIdle: U('Idle from page pointer events; a hidden tab suspends the host (tested with a faked visibilityState only).'),
    fullscreenAware: B('Not exposed to pages.'),
    loginItem: B('Not available to web pages.'),
    tray: B('Not available to web pages.'),
    globalShortcut: B('Pages receive keys only while focused; no key listeners by design.'),
    secretStorage: B('No secrets: the web host has no AI or network features.'),
    perception: B('Not offered on the web host (no screen access, no network).'),
    touchInput: U('Touch routing exists and passed under device emulation (see Android); no touch-screen PC was tested.'),
    sound: U('The same WebAudio cues as the desktop, started by a tap (Sound button or Settings); not tested in the web host.'),
    persistence: V('localStorage, validated with the desktop migrations; a reload keeps the cat (1.3.0 run; the 1.4.0 storage changes have not run).', WEB_REPORT),
  },
  android: {
    characterView: S("1.3.0: the web host under desktop Chrome's Pixel 7 emulation. 1.4.0 adds the installable web app and a native WebView app around the same bundle; neither has run on a device or emulator.", WEB_REPORT),
    overlay: U('1.4.1: a foreground service draws the cat in a small transparent TYPE_APPLICATION_OVERLAY window that follows it, behind "Display over other apps" (opt-in, opened from the app only on request). Compiled, never run on a device or emulator.'),
    clickThrough: B('Android gives an app window no input region and, since Android 12, passes touches through another app\'s overlay only at ≤ 80 % opacity. The window is only the cat and a margin (about 44 dp at size 1), so touches elsewhere reach the apps beneath; touches in the margin are consumed.'),
    globalCursor: B('Touch devices have no hovering pointer outside the app.'),
    multiDisplay: B('Not applicable to the in-page host.'),
    windowSurfaces: B('Other apps are not visible.'),
    taskbarSurfaces: B('Not exposed.'),
    tabStrips: B('Not exposed.'),
    activityIdle: U('Same web code (page pointer idle) in the browser and the app; not run on Android.'),
    fullscreenAware: B('Not exposed.'),
    loginItem: B('Not applicable.'),
    tray: B('Not applicable.'),
    globalShortcut: B('Not applicable.'),
    secretStorage: B('No secrets: the web app and the Android app have no AI or network features.'),
    perception: B('MediaProjection needs per-session consent; not offered.'),
    touchInput: S('1.3.0: tap, stroke-to-pet and hold-to-drag passed under Pixel 7 emulation (touch through the DevTools protocol); the 1.4.0 app has not run on a touch device.', WEB_REPORT),
    sound: U('Same web code, started by a tap; not run on Android.'),
    persistence: S("1.3.0: a reload kept the cat under Pixel 7 emulation. 1.4.0: Chrome's storage, or the app's private WebView storage with no cloud backup; not run on Android.", WEB_REPORT),
  },
  ios: {
    characterView: U('The installable web app (Safari, Add to Home Screen) is plain web code, but it has never run in WebKit or Safari.'),
    overlay: B('iOS and iPadOS have no public API for drawing over other apps.'),
    clickThrough: B('See overlay.'),
    globalCursor: B('Not exposed.'),
    multiDisplay: B('Not applicable to the in-page host.'),
    windowSurfaces: B('Other apps are not visible.'),
    taskbarSurfaces: B('Not exposed.'),
    tabStrips: B('Not exposed.'),
    activityIdle: U('Same web code; never run in Safari.'),
    fullscreenAware: B('Not exposed.'),
    loginItem: B('Not applicable.'),
    tray: B('Not applicable.'),
    globalShortcut: B('Not applicable.'),
    secretStorage: B('No secrets: the web app has no AI or network features.'),
    perception: B('Not available to apps or pages.'),
    touchInput: U('Same touch routing; never run in Safari (WebKit touch and pointer events untested).'),
    sound: U('Same web code; Safari needs a tap to start audio, which the Sound button and Settings provide (untested).'),
    persistence: U('localStorage; a Safari tab may lose it after 7 days without a visit; a Home Screen app has separate storage (reported; untested).'),
  },
};

// ARCHITECTURALLY_VALIDATED is part of the vocabulary but no cell uses it today.
void A;

/** What a running app detected on this machine (ADR 0004 §2.2). */
export interface RuntimeCapability {
  readonly available: boolean;
  /** Why not, in one user-facing sentence; null when available. */
  readonly reason: string | null;
}
export type RuntimeCapabilities = Readonly<Record<CapabilityId, RuntimeCapability>>;

export interface PlatformReport {
  readonly id: PlatformId;
  readonly label: string;
  readonly capabilities: RuntimeCapabilities;
}

export interface PlatformProbe {
  /** process.platform */
  readonly os: string;
  /** A Wayland session is present (WAYLAND_DISPLAY, WAYLAND_SOCKET or XDG_SESSION_TYPE=wayland) / DISPLAY is set. Values are never reported. */
  readonly waylandDisplay: boolean;
  readonly x11Display: boolean;
  /** The ozone platform this process runs on ('x11', 'wayland'), or null when not chosen explicitly. */
  readonly ozonePlatform: string | null;
}

/**
 * The desktop platform an Electron process runs on. On Linux an explicit ozone choice decides
 * (x11 also means XWayland); without one, a set WAYLAND_DISPLAY means native Wayland.
 */
export function resolvePlatformId(probe: PlatformProbe): PlatformId {
  switch (probe.os) {
    case 'win32':
      return 'win32';
    case 'darwin':
      return 'darwin';
    case 'linux':
    case 'freebsd':
    case 'openbsd': {
      const ozone = probe.ozonePlatform?.trim().toLowerCase() ?? null;
      // X11 inside a Wayland session is XWayland: no overlay (review H2).
      if (ozone === 'x11') return probe.waylandDisplay ? 'linux-xwayland' : 'linux-x11';
      if (ozone === 'wayland') return 'linux-wayland';
      // Electron's default (--ozone-platform-hint=auto, since 38.2) picks Wayland whenever a
      // Wayland display is set: without an explicit x11 choice that is native Wayland.
      if (probe.waylandDisplay) return 'linux-wayland';
      return 'linux-x11';
    }
    default:
      // Unknown platforms fail closed: no overlay.
      return 'linux-wayland';
  }
}

/** True for statuses that mean "code for this exists". */
export function isImplemented(status: VerificationStatus): boolean {
  return status === 'IMPLEMENTED_AND_LOCALLY_VERIFIED' || status === 'IMPLEMENTED_BUT_NOT_PLATFORM_VERIFIED' || status === 'SIMULATED_OR_MOCK_TESTED';
}

/** A runtime record that starts from the declared table: implemented capabilities are presumed available until a probe says otherwise. */
export function declaredRuntime(id: PlatformId): Record<CapabilityId, RuntimeCapability> {
  const out = {} as Record<CapabilityId, RuntimeCapability>;
  for (const cap of CAPABILITY_IDS) {
    const claim = CAPABILITY_MATRIX[id][cap];
    out[cap] = isImplemented(claim.status) ? { available: true, reason: null } : { available: false, reason: claim.note };
  }
  return out;
}
