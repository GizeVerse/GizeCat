// Where the web host runs (src/web/hostMode.ts): the Android app's origin, an installed web app, a
// browser tab; what that turns on or off. SIMULATED environments (plain objects, real user-agent shapes).
import { describe, expect, it } from 'vitest';
import { IDENTITY } from '../../../src/shared/identity';
import {
  detectHostMode,
  installHint,
  readHostEnv,
  shouldRegisterServiceWorker,
  shouldRequestPersistence,
  showEvictionNote,
  type HostEnv,
} from '../../../src/web/hostMode';

const IPAD_DESKTOP_UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15';
const ANDROID_TABLET_UA = 'Mozilla/5.0 (Linux; Android 14; SM-X710) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36';
const WINDOWS_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36';

const env = (over: Partial<HostEnv> = {}): HostEnv => ({
  origin: 'https://example.test',
  protocol: 'https:',
  secureContext: true,
  displayStandalone: false,
  navigatorStandalone: undefined,
  userAgent: WINDOWS_UA,
  maxTouchPoints: 0,
  ...over,
});

describe('host mode', () => {
  it('is the Android app on its WebView origin: app wording, no service worker, no install or eviction hints', () => {
    const m = detectHostMode(env({ origin: IDENTITY.androidWebOrigin, userAgent: ANDROID_TABLET_UA, maxTouchPoints: 10 }));
    expect(m).toEqual({ kind: 'android-app', standalone: true, apple: false, place: 'app' });
    expect(shouldRegisterServiceWorker(m, env({ origin: IDENTITY.androidWebOrigin }), true)).toBe(false);
    expect(installHint(m, true)).toBe('none');
    expect(showEvictionNote(m)).toBe(false);
    expect(shouldRequestPersistence(m)).toBe(false);
  });

  it('a desktop browser tab: browser wording, the menu hint (or the prompt), no eviction note', () => {
    const m = detectHostMode(env());
    expect(m).toEqual({ kind: 'browser', standalone: false, apple: false, place: 'browser' });
    expect(installHint(m, false)).toBe('menu');
    expect(installHint(m, true)).toBe('prompt');
    expect(showEvictionNote(m)).toBe(false);
  });

  it('a Safari tab on an iPad (desktop-class user agent with touch): the Share hint and the 7-day note', () => {
    const m = detectHostMode(env({ userAgent: IPAD_DESKTOP_UA, maxTouchPoints: 5, navigatorStandalone: false }));
    expect(m).toEqual({ kind: 'browser', standalone: false, apple: true, place: 'browser' });
    expect(installHint(m, false)).toBe('apple');
    expect(showEvictionNote(m)).toBe(true);
    expect(shouldRequestPersistence(m)).toBe(false);
  });

  it('the installed Home Screen app on an iPad: app wording, installed, asks to persist, no eviction note', () => {
    const m = detectHostMode(env({ userAgent: IPAD_DESKTOP_UA, maxTouchPoints: 5, navigatorStandalone: true }));
    expect(m).toEqual({ kind: 'browser', standalone: true, apple: true, place: 'app' });
    expect(installHint(m, false)).toBe('installed');
    expect(showEvictionNote(m)).toBe(false);
    expect(shouldRequestPersistence(m)).toBe(true);
  });

  it('an installed app on an Android tablet (display-mode standalone)', () => {
    const m = detectHostMode(env({ userAgent: ANDROID_TABLET_UA, maxTouchPoints: 10, displayStandalone: true }));
    expect(m).toEqual({ kind: 'browser', standalone: true, apple: false, place: 'app' });
    expect(installHint(m, true)).toBe('installed');
  });

  it('registers the service worker only in production, on a secure http(s) origin, in a browser', () => {
    const m = detectHostMode(env());
    expect(shouldRegisterServiceWorker(m, env(), true)).toBe(true);
    expect(shouldRegisterServiceWorker(m, env(), false)).toBe(false);
    expect(shouldRegisterServiceWorker(m, env({ secureContext: false, protocol: 'http:' }), true)).toBe(false);
    expect(shouldRegisterServiceWorker(m, env({ protocol: 'http:' }), true)).toBe(true);
    expect(shouldRegisterServiceWorker(m, env({ protocol: 'file:', origin: 'null' }), true)).toBe(false);
  });

  it('reads the environment defensively (no matchMedia, a throwing one, a non-boolean standalone)', () => {
    const base = { location: { origin: 'https://example.test', protocol: 'https:' }, isSecureContext: true, navigator: { userAgent: WINDOWS_UA } };
    expect(readHostEnv(base).displayStandalone).toBe(false);
    expect(
      readHostEnv({
        ...base,
        matchMedia: () => {
          throw new Error('no');
        },
      }).displayStandalone,
    ).toBe(false);
    expect(readHostEnv({ ...base, matchMedia: () => ({ matches: true }) }).displayStandalone).toBe(true);
    expect(readHostEnv({ ...base, navigator: { userAgent: WINDOWS_UA, standalone: 'yes' } }).navigatorStandalone).toBeUndefined();
    expect(readHostEnv({ ...base, navigator: { userAgent: WINDOWS_UA, standalone: true, maxTouchPoints: 5 } })).toMatchObject({ navigatorStandalone: true, maxTouchPoints: 5 });
  });
});
