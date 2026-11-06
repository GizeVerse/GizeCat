// GizeVerse platform layer (ADR 0004 §3–§7): the factory's per-OS choices, the Electron side of
// the coordinate strategies, runtime capability detection, boot decisions, overlay profiles
// and the X11 compositor probe. Off-Windows behaviour here is SIMULATED (fake screens, fake X11).
import type { Display } from 'electron';
import { describe, expect, it } from 'vitest';
import { createDisplayCoordinates, type ScreenLike } from '../../../src/main/display/coordinates';
import { compositorFromOwner, createX11CompositorProbe } from '../../../src/main/linux/x11Compositor';
import { overlayProfileFor, WIN32_OVERLAY_PROFILE } from '../../../src/main/overlay/overlayProfile';
import { createPlatformServices, PLAINTEXT_SECRET_BACKENDS, probeFromProcess } from '../../../src/main/platform';
import { darwinApplicationMenu } from '../../../src/main/platform/appMenu';
import { explicitOzone, sandboxDecision } from '../../../src/main/platform/boot';
import { NO_DISPLAY_REASON, runtimeCapabilities, type RuntimeObservations } from '../../../src/main/platform/runtime';
import { PLATFORM_IDS, type PlatformId } from '../../../src/shared/platform';

function fakeDisplay(id: number, scaleFactor: number, bounds: Display['bounds'], workArea: Display['workArea'] = bounds): Display {
  return { id, scaleFactor, bounds, workArea } as Display;
}

function fakeScreen(displays: Display[], opts: { win32?: boolean; cursor?: { x: number; y: number } } = {}): ScreenLike & { calls: string[] } {
  const calls: string[] = [];
  const s: ScreenLike & { calls: string[] } = {
    calls,
    getAllDisplays: () => displays,
    getPrimaryDisplay: () => displays[0]!,
    getCursorScreenPoint: () => opts.cursor ?? { x: 10, y: 20 },
  };
  if (opts.win32) {
    // Windows' conversion stand-in: × 1.25 (one display at 125 %), recorded so the test can see it ran.
    s.dipToScreenRect = (_w, r) => {
      calls.push('dipToScreenRect');
      return { x: r.x * 1.25, y: r.y * 1.25, width: r.width * 1.25, height: r.height * 1.25 };
    };
    s.dipToScreenPoint = (p) => {
      calls.push('dipToScreenPoint');
      return { x: p.x * 1.25, y: p.y * 1.25 };
    };
  }
  return s;
}

describe('display coordinates, Electron side', () => {
  it('Windows: exactly the v1.0 conversion (dipToScreenRect for bounds and work area, dipToScreenPoint for the cursor)', () => {
    const screen = fakeScreen([fakeDisplay(7, 1.25, { x: 0, y: 0, width: 1536, height: 960 }, { x: 0, y: 0, width: 1536, height: 960 })], { win32: true, cursor: { x: 100, y: 40 } });
    const c = createDisplayCoordinates('win32', screen);
    expect(c.strategy).toBe('win32-physical');
    const [d] = c.readDisplays();
    expect(d).toEqual({
      id: '7',
      primary: true,
      scaleFactor: 1.25,
      boundsDip: { x: 0, y: 0, width: 1536, height: 960 },
      workAreaDip: { x: 0, y: 0, width: 1536, height: 960 },
      boundsPx: { x: 0, y: 0, width: 1920, height: 1200 },
      workAreaPx: { x: 0, y: 0, width: 1920, height: 1200 },
    });
    expect(c.cursorFallback()).toEqual({ x: 125, y: 50 });
    expect(c.rectToWorld(null, { x: 8, y: 8, width: 8, height: 8 })).toEqual({ x: 10, y: 10, width: 10, height: 10 });
    expect(screen.calls).toEqual(['dipToScreenRect', 'dipToScreenRect', 'dipToScreenPoint', 'dipToScreenRect']);
  });

  it('macOS and Linux: never call the Windows-only methods (they do not exist there) and use the logical world', () => {
    for (const p of ['darwin', 'linux-x11'] as const) {
      const screen = fakeScreen([fakeDisplay(1, 2, { x: 0, y: 0, width: 1512, height: 982 }), fakeDisplay(2, 1, { x: 1512, y: 0, width: 1920, height: 1080 })], { cursor: { x: 1600, y: 300 } });
      const c = createDisplayCoordinates(p, screen);
      expect(c.strategy).toBe('logical');
      const displays = c.readDisplays();
      expect(displays.map((d) => d.scaleFactor)).toEqual([1, 1]);
      expect(displays[1]!.boundsPx).toEqual({ x: 1512, y: 0, width: 1920, height: 1080 });
      expect(c.cursorFallback()).toEqual({ x: 1600, y: 300 });
      expect(screen.calls).toEqual([]);
    }
  });

  it('Windows without the conversion methods: the cursor fallback reports null instead of throwing', () => {
    const c = createDisplayCoordinates('win32', fakeScreen([fakeDisplay(1, 1, { x: 0, y: 0, width: 10, height: 10 })]));
    expect(c.cursorFallback()).toBeNull();
  });
});

describe('platform services factory', () => {
  const services = (id: PlatformId) => {
    const probes: Record<PlatformId, Parameters<typeof createPlatformServices>[0]> = {
      win32: { os: 'win32', waylandDisplay: false, x11Display: false, ozonePlatform: null },
      darwin: { os: 'darwin', waylandDisplay: false, x11Display: false, ozonePlatform: null },
      'linux-x11': { os: 'linux', waylandDisplay: false, x11Display: true, ozonePlatform: null },
      'linux-xwayland': { os: 'linux', waylandDisplay: true, x11Display: true, ozonePlatform: 'x11' },
      'linux-wayland': { os: 'linux', waylandDisplay: true, x11Display: true, ozonePlatform: null },
      web: { os: 'web', waylandDisplay: false, x11Display: false, ozonePlatform: null },
      android: { os: 'android', waylandDisplay: false, x11Display: false, ozonePlatform: null },
      ios: { os: 'ios', waylandDisplay: false, x11Display: false, ozonePlatform: null },
    };
    return createPlatformServices(probes[id], fakeScreen([fakeDisplay(1, 1, { x: 0, y: 0, width: 100, height: 100 })], { win32: true }));
  };

  it('Windows keeps every Windows behaviour: session-end window, balloons, login items, AUMID, no app menu, the v1.2 overlay profile', () => {
    const w = services('win32');
    expect(w.id).toBe('win32');
    expect(w.overlayProfile).toBe(WIN32_OVERLAY_PROFILE);
    expect([w.sessionEndWindow, w.trayBalloons, w.loginItemSupported, w.appUserModelId]).toEqual([true, true, true, true]);
    expect([w.saveOnPowerShutdown, w.x11CompositorRequired, w.activateOpensSettings]).toEqual([false, false, false]);
    expect(w.applicationMenu).toBe('none');
    expect(w.secretBackendAllowed(null)).toBe(true);
  });

  it('macOS: app menu, activate opens Settings, no Windows-only features, saves on power shutdown', () => {
    const m = services('darwin');
    expect(m.applicationMenu).toBe('darwin-minimal');
    expect(m.activateOpensSettings).toBe(true);
    expect([m.sessionEndWindow, m.trayBalloons, m.loginItemSupported, m.appUserModelId]).toEqual([false, false, false, false]);
    expect(m.saveOnPowerShutdown).toBe(true);
  });

  it('Linux: a compositor is required on X11 only, and plaintext keyrings are refused on every Linux id', () => {
    expect(services('linux-x11').x11CompositorRequired).toBe(true);
    expect(services('linux-xwayland').x11CompositorRequired).toBe(false);
    for (const id of ['linux-x11', 'linux-xwayland', 'linux-wayland'] as const) {
      const l = services(id);
      expect(l.id).toBe(id);
      for (const b of PLAINTEXT_SECRET_BACKENDS) expect(l.secretBackendAllowed(b)).toBe(false);
      expect(l.secretBackendAllowed(null)).toBe(false);
      expect(l.secretBackendAllowed('gnome_libsecret')).toBe(true);
      expect(l.secretBackendAllowed('kwallet5')).toBe(true);
    }
  });

  it('probeFromProcess: session presence from names only; WAYLAND_SOCKET and XDG_SESSION_TYPE count as Wayland', () => {
    expect(probeFromProcess('linux', { DISPLAY: ':0' }, null)).toEqual({ os: 'linux', waylandDisplay: false, x11Display: true, ozonePlatform: null });
    expect(probeFromProcess('linux', { WAYLAND_SOCKET: '3' }, null).waylandDisplay).toBe(true);
    expect(probeFromProcess('linux', { XDG_SESSION_TYPE: 'Wayland' }, null).waylandDisplay).toBe(true);
    expect(probeFromProcess('linux', { DISPLAY: '' }, '').x11Display).toBe(false);
    expect(probeFromProcess('linux', {}, '').ozonePlatform).toBeNull();
  });

  it('the macOS menu uses roles only (no custom handlers or key listeners)', () => {
    expect(darwinApplicationMenu()).toEqual([{ role: 'appMenu' }, { role: 'editMenu' }, { role: 'windowMenu' }]);
  });
});

describe('overlay profiles', () => {
  it('the Windows profile is the v1.2 window: toolbar type, screen-saver level, shell extras, session-end events', () => {
    expect(WIN32_OVERLAY_PROFILE).toEqual({
      create: true,
      reason: null,
      windowType: 'toolbar',
      topmostLevel: 'screen-saver',
      acceptFirstMouse: false,
      hiddenInMissionControl: false,
      shellIntegration: true,
      sessionEndEvents: true,
    });
  });

  it('macOS uses a panel that accepts the first click; Linux X11 sets no type; Wayland, XWayland and unknown ids create nothing', () => {
    expect(overlayProfileFor('darwin')).toMatchObject({ create: true, windowType: 'panel', acceptFirstMouse: true, hiddenInMissionControl: true, shellIntegration: false });
    expect(overlayProfileFor('linux-x11')).toMatchObject({ create: true, windowType: null, shellIntegration: false });
    for (const id of PLATFORM_IDS) {
      if (id === 'win32' || id === 'darwin' || id === 'linux-x11') continue;
      expect(overlayProfileFor(id).create, id).toBe(false);
      expect(overlayProfileFor(id).reason, id).toBeTruthy();
    }
  });
});

describe('runtime capabilities', () => {
  const base: RuntimeObservations = {
    overlayAllowed: true,
    overlayBlockedReason: null,
    displayCount: 1,
    nativeCursor: true,
    windowAwareness: 'event-hooks',
    taskbarsAvailable: true,
    tabStripsAvailable: true,
    secretStorageReason: null,
    trayCreated: true,
    shortcutRegistered: true,
    loginItemWritable: true,
    loginItemReason: null,
    sandboxed: true,
  };

  it('a healthy Windows install reports what the table declares', () => {
    const r = runtimeCapabilities('win32', base);
    expect(r.id).toBe('win32');
    expect(r.capabilities.overlay).toEqual({ available: true, reason: null });
    expect(r.capabilities.touchInput.available).toBe(false);
  });

  it('narrows by observation: no displays, no tray, keyring refused, shortcut taken', () => {
    const r = runtimeCapabilities('linux-x11', { ...base, displayCount: 0, trayCreated: false, secretStorageReason: 'No keyring', shortcutRegistered: false });
    expect(r.capabilities.characterView).toEqual({ available: false, reason: NO_DISPLAY_REASON });
    expect(r.capabilities.tray.available).toBe(false);
    expect(r.capabilities.secretStorage).toEqual({ available: false, reason: 'No keyring' });
    expect(r.capabilities.globalShortcut.available).toBe(false);
  });

  it('a withheld overlay (no compositor, Wayland) takes the character view and click-through with it, with the reason', () => {
    const r = runtimeCapabilities('linux-x11', { ...base, overlayAllowed: false, overlayBlockedReason: 'No compositor' });
    for (const id of ['characterView', 'overlay', 'clickThrough'] as const) expect(r.capabilities[id]).toEqual({ available: false, reason: 'No compositor' });
  });

  it('never upgrades a capability the table declares unavailable', () => {
    const r = runtimeCapabilities('darwin', base);
    expect(r.capabilities.windowSurfaces.available).toBe(false);
    expect(r.capabilities.loginItem.available).toBe(false);
    expect(r.capabilities.perception.available).toBe(false);
  });

  it('reports the missing sandbox', () => {
    expect(runtimeCapabilities('win32', { ...base, sandboxed: false }).capabilities.characterView.available).toBe(false);
  });
});

describe('boot decisions', () => {
  it('explicitOzone reads --ozone-platform, then a concrete --ozone-platform-hint', () => {
    const sw = (m: Record<string, string>) => (n: string) => m[n] ?? '';
    expect(explicitOzone(sw({}))).toBeNull();
    expect(explicitOzone(sw({ 'ozone-platform': 'X11' }))).toBe('x11');
    expect(explicitOzone(sw({ 'ozone-platform-hint': 'wayland' }))).toBe('wayland');
    expect(explicitOzone(sw({ 'ozone-platform-hint': 'auto' }))).toBeNull();
  });

  it('a packaged build refuses --no-sandbox; a development build only warns', () => {
    expect(sandboxDecision(true, false)).toBe('ok');
    expect(sandboxDecision(true, true)).toBe('refuse');
    expect(sandboxDecision(false, true)).toBe('warn');
  });
});

describe('X11 compositor probe (fake libX11)', () => {
  const fakeX11 = (owner: number | bigint, opts: { open?: boolean; throwOn?: string } = {}) => {
    const log: string[] = [];
    return {
      log,
      bind: () => ({
        XOpenDisplay: () => {
          log.push('open');
          return opts.open === false ? null : { dpy: 1 };
        },
        XDefaultScreen: () => 0,
        XInternAtom: (_d: unknown, name: string) => {
          log.push(`atom:${name}`);
          if (opts.throwOn === 'atom') throw new Error('boom');
          return 42;
        },
        XGetSelectionOwner: () => owner,
        XCloseDisplay: () => {
          log.push('close');
          return 0;
        },
      }),
    };
  };

  it('present when _NET_WM_CM_S<screen> has an owner, absent when not; the connection is always closed', () => {
    const p = fakeX11(0x1200003);
    expect(createX11CompositorProbe(p.bind).check()).toBe('present');
    expect(p.log).toEqual(['open', 'atom:_NET_WM_CM_S0', 'close']);
    expect(createX11CompositorProbe(fakeX11(0n).bind).check()).toBe('absent');
  });

  it('fails closed: no display, a throwing call or a missing libX11 is "unknown" with a reason', () => {
    const noDisplay = createX11CompositorProbe(fakeX11(1, { open: false }).bind);
    expect(noDisplay.check()).toBe('unknown');
    expect(noDisplay.error).toBe('XOpenDisplay failed');
    const throwing = fakeX11(1, { throwOn: 'atom' });
    const t = createX11CompositorProbe(throwing.bind);
    expect(t.check()).toBe('unknown');
    expect(throwing.log).toContain('close');
    const missing = createX11CompositorProbe(() => {
      throw new Error('libX11.so.6: cannot open shared object file');
    });
    expect(missing.check()).toBe('unknown');
    expect(missing.error).toMatch(/libX11/);
  });

  it('compositorFromOwner', () => {
    expect(compositorFromOwner(null)).toBe('unknown');
    expect(compositorFromOwner(0)).toBe('absent');
    expect(compositorFromOwner(5n)).toBe('present');
  });
});
