// Where the web host runs (1.4.0). The same out/web bundle is
// - a page in a browser tab, or the installed web app (Home Screen / "Install app": display-mode
//   standalone, or navigator.standalone on iPadOS and iOS Safari), served from any HTTPS origin;
// - the Android app's payload, served by its native WebView from IDENTITY.androidWebOrigin.
// The page works the same in every mode and never depends on a native bridge. The mode only decides
// the wording ("this browser" or "this app"), whether the service worker is registered (not in the
// Android app, which ships its files inside the APK), and which install hint, if any, is shown.
//
// Pure: the environment is passed in (readHostEnv reads it from the page).
import { IDENTITY } from '../shared/identity';

export type HostKind = 'android-app' | 'browser';

export interface HostEnv {
  /** location.origin */
  origin: string;
  /** location.protocol, e.g. 'https:' */
  protocol: string;
  /** window.isSecureContext */
  secureContext: boolean;
  /** matchMedia('(display-mode: standalone)').matches (false when unsupported). */
  displayStandalone: boolean;
  /** navigator.standalone: true or false on iPadOS and iOS Safari, undefined elsewhere. */
  navigatorStandalone: boolean | undefined;
  userAgent: string;
  maxTouchPoints: number;
}

export interface HostMode {
  kind: HostKind;
  /** Running as an installed web app (or as the Android app). */
  standalone: boolean;
  /**
   * Apple touch device (iPadOS or iOS) by heuristics: navigator.standalone exists, an iPad, iPhone
   * or iPod user agent, or a "Macintosh" user agent with a touch screen (iPadOS asks for desktop
   * sites by default). UNVERIFIED on a device.
   */
  apple: boolean;
  /** "this app" or "this browser" in user-facing text. */
  place: 'app' | 'browser';
}

export function detectHostMode(env: HostEnv): HostMode {
  if (env.origin === IDENTITY.androidWebOrigin) return { kind: 'android-app', standalone: true, apple: false, place: 'app' };
  const ua = env.userAgent || '';
  const apple =
    env.navigatorStandalone !== undefined || /\b(iPad|iPhone|iPod)\b/.test(ua) || (/\bMacintosh\b/.test(ua) && Number.isFinite(env.maxTouchPoints) && env.maxTouchPoints > 1);
  const standalone = env.displayStandalone || env.navigatorStandalone === true;
  return { kind: 'browser', standalone, apple, place: standalone ? 'app' : 'browser' };
}

/**
 * The service worker (offline copy of the app's own files) is registered only in a browser, on a
 * secure origin over http(s) (never file:, never the Android app), and only in production builds.
 */
export function shouldRegisterServiceWorker(mode: HostMode, env: Pick<HostEnv, 'protocol' | 'secureContext'>, production: boolean): boolean {
  if (!production || mode.kind !== 'browser' || !env.secureContext) return false;
  return env.protocol === 'https:' || env.protocol === 'http:';
}

/** navigator.storage.persist() is asked once, only for the installed web app (Safari grants it to Home Screen apps by heuristics). */
export function shouldRequestPersistence(mode: HostMode): boolean {
  return mode.kind === 'browser' && mode.standalone;
}

/**
 * What the sheet offers for installing:
 * - none: the Android app (already an app);
 * - installed: running as an installed web app;
 * - prompt: the browser offered an install prompt (beforeinstallprompt, Chromium): an Install button;
 * - apple: Safari: Share, then Add to Home Screen;
 * - menu: elsewhere: the browser menu's Install app or Add to Home screen.
 */
export type InstallHint = 'none' | 'installed' | 'prompt' | 'apple' | 'menu';

export function installHint(mode: HostMode, canPrompt: boolean): InstallHint {
  if (mode.kind === 'android-app') return 'none';
  if (mode.standalone) return 'installed';
  if (canPrompt) return 'prompt';
  return mode.apple ? 'apple' : 'menu';
}

/** Safari may delete a site's storage after 7 days without a visit; the installed app keeps its own count (WebKit, 2020). */
export function showEvictionNote(mode: HostMode): boolean {
  return mode.kind === 'browser' && mode.apple && !mode.standalone;
}

/** The structural slice of window that readHostEnv reads. */
export interface HostWindowLike {
  location: { origin: string; protocol: string };
  isSecureContext: boolean;
  matchMedia?: (query: string) => { matches: boolean };
  navigator: { userAgent: string; maxTouchPoints?: number; standalone?: unknown };
}

/** Reads the HostEnv from the page; anything unreadable falls back to the browser-tab defaults. */
export function readHostEnv(win: HostWindowLike): HostEnv {
  let displayStandalone: boolean;
  try {
    displayStandalone = win.matchMedia?.('(display-mode: standalone)').matches === true;
  } catch {
    displayStandalone = false;
  }
  const s = win.navigator.standalone;
  return {
    origin: win.location.origin,
    protocol: win.location.protocol,
    secureContext: win.isSecureContext === true,
    displayStandalone,
    navigatorStandalone: typeof s === 'boolean' ? s : undefined,
    userAgent: String(win.navigator.userAgent ?? ''),
    maxTouchPoints: Number(win.navigator.maxTouchPoints ?? 0),
  };
}
