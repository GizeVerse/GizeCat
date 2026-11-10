// The service worker's decisions (src/web/swCore.ts): what it answers from its cache, which caches
// it deletes, and the clean copy it makes of a redirected response. Pure: requests are plain
// objects; responses are the runtime's Response.
import { describe, expect, it } from 'vitest';
import { routeRequest, scopeCachePrefix, scopeHash, SHELL_CACHE_PREFIX, shellCacheName, staleCaches, withoutRedirect } from '../../../src/web/swCore';

const FILES = ['index.html', 'main.js', 'web.css', 'manifest.webmanifest', 'icons/icon-192.png'];
const SCOPE = 'https://example.test/gizecat/';
const get = (url: string, mode = 'no-cors') => ({ method: 'GET', url, mode });
const pass = { kind: 'pass' };

describe('service worker routing', () => {
  it("answers loads of the app's own page (the scope root and its index.html) with the shell", () => {
    expect(routeRequest(get(SCOPE, 'navigate'), SCOPE, FILES)).toEqual({ kind: 'navigate' });
    expect(routeRequest(get(`${SCOPE}?source=pwa#x`, 'navigate'), SCOPE, FILES)).toEqual({ kind: 'navigate' });
    expect(routeRequest(get(`${SCOPE}index.html?x=1`, 'navigate'), SCOPE, FILES)).toEqual({ kind: 'navigate' });
    expect(routeRequest(get(`${SCOPE}index%2Ehtml`, 'navigate'), SCOPE, FILES)).toEqual({ kind: 'navigate' });
  });

  it('answers a load of the licenses page from the shell, only when the build has it', () => {
    const withPage = [...FILES, 'licenses.html'];
    expect(routeRequest(get(`${SCOPE}licenses.html`, 'navigate'), SCOPE, withPage)).toEqual({ kind: 'shell', key: 'licenses.html' });
    expect(routeRequest(get(`${SCOPE}licenses.html?x=1`, 'navigate'), SCOPE, withPage)).toEqual({ kind: 'shell', key: 'licenses.html' });
    expect(routeRequest(get(`${SCOPE}licenses.html`, 'navigate'), SCOPE, FILES)).toEqual(pass);
    // Under a project-site subpath, the same: a nested path or another project is not this page.
    expect(routeRequest(get(`${SCOPE}next/licenses.html`, 'navigate'), SCOPE, withPage)).toEqual(pass);
    expect(routeRequest(get('https://example.test/other-app/licenses.html', 'navigate'), SCOPE, withPage)).toEqual(pass);
  });

  it('answers a load of the privacy page from the shell, only when the build has it', () => {
    const withPage = [...FILES, 'privacy.html'];
    expect(routeRequest(get(`${SCOPE}privacy.html`, 'navigate'), SCOPE, withPage)).toEqual({ kind: 'shell', key: 'privacy.html' });
    expect(routeRequest(get(`${SCOPE}privacy.html`, 'navigate'), SCOPE, FILES)).toEqual(pass);
    expect(routeRequest(get(`${SCOPE}next/privacy.html`, 'navigate'), SCOPE, withPage)).toEqual(pass);
  });

  it('passes every other page load in the scope to the network: other sites, nested copies, missing pages', () => {
    // GizeCat at the root of a shared origin (scope '/'): another project site and the host's 404 page stay theirs.
    const root = 'https://owner.example.test/';
    expect(routeRequest(get(`${root}other-project/`, 'navigate'), root, FILES)).toEqual(pass);
    expect(routeRequest(get(`${root}other-project/index.html`, 'navigate'), root, FILES)).toEqual(pass);
    expect(routeRequest(get(`${root}no-such-page`, 'navigate'), root, FILES)).toEqual(pass);
    // A nested, newer copy loads its own page.
    expect(routeRequest(get(`${SCOPE}next/`, 'navigate'), SCOPE, FILES)).toEqual(pass);
    expect(routeRequest(get(`${SCOPE}next/index.html`, 'navigate'), SCOPE, FILES)).toEqual(pass);
    // Opening a shell file or anything else in a tab is not a load of the app's page.
    expect(routeRequest(get(`${SCOPE}main.js`, 'navigate'), SCOPE, FILES)).toEqual(pass);
    expect(routeRequest(get(`${SCOPE}secret.html`, 'navigate'), SCOPE, FILES)).toEqual(pass);
    expect(routeRequest(get(`${SCOPE}%E0%A4%A`, 'navigate'), SCOPE, FILES)).toEqual(pass);
  });

  it('answers the shell files from the cache, by their path relative to the scope', () => {
    expect(routeRequest(get(`${SCOPE}main.js`), SCOPE, FILES)).toEqual({ kind: 'shell', key: 'main.js' });
    expect(routeRequest(get(`${SCOPE}icons/icon-192.png`), SCOPE, FILES)).toEqual({ kind: 'shell', key: 'icons/icon-192.png' });
    expect(routeRequest(get(SCOPE), SCOPE, FILES)).toEqual({ kind: 'shell', key: 'index.html' });
  });

  it('passes everything else through: other methods, origins, paths outside the scope, files not in the shell', () => {
    expect(routeRequest({ method: 'POST', url: `${SCOPE}main.js`, mode: 'cors' }, SCOPE, FILES)).toEqual(pass);
    expect(routeRequest({ method: 'POST', url: SCOPE, mode: 'navigate' }, SCOPE, FILES)).toEqual(pass);
    expect(routeRequest(get('https://other.test/gizecat/main.js'), SCOPE, FILES)).toEqual(pass);
    expect(routeRequest(get('https://example.test/other-app/main.js'), SCOPE, FILES)).toEqual(pass);
    expect(routeRequest(get('https://example.test/other-app/', 'navigate'), SCOPE, FILES)).toEqual(pass);
    expect(routeRequest(get(`${SCOPE}sw.js`), SCOPE, FILES)).toEqual(pass);
    expect(routeRequest(get(`${SCOPE}secret.json`), SCOPE, FILES)).toEqual(pass);
    expect(routeRequest(get('not a url'), SCOPE, FILES)).toEqual(pass);
    expect(routeRequest(get(`${SCOPE}%E0%A4%A`), SCOPE, FILES)).toEqual(pass);
  });
});

describe('service worker caches', () => {
  const OTHER = 'https://example.test/gizecat-beta/';

  it('hashes the scope to 8 stable hex digits (FNV-1a), different for different paths', () => {
    expect(scopeHash('')).toBe('811c9dc5');
    expect(scopeHash('a')).toBe('e40c292c');
    expect(scopeHash(SCOPE)).toMatch(/^[0-9a-f]{8}$/);
    expect(scopeHash(SCOPE)).toBe(scopeHash(SCOPE));
    expect(scopeHash(SCOPE)).not.toBe(scopeHash(OTHER));
    expect(scopeHash(SCOPE)).not.toBe(scopeHash(`${SCOPE}next/`));
  });

  it('names each shell version under the app prefix and its scope', () => {
    expect(shellCacheName(SCOPE, '1.4.0-abcdef0123456789')).toBe(`gizecat-shell-${scopeHash(SCOPE)}-1.4.0-abcdef0123456789`);
    expect(shellCacheName(SCOPE, 'x').startsWith(SHELL_CACHE_PREFIX)).toBe(true);
    expect(shellCacheName(SCOPE, 'x').startsWith(scopeCachePrefix(SCOPE))).toBe(true);
    expect(shellCacheName(SCOPE, 'x')).not.toBe(shellCacheName(OTHER, 'x'));
  });

  it("deletes only its own scope's older caches, never another copy's or another app's on the same origin", () => {
    const current = shellCacheName(SCOPE, '1.4.0-b');
    const names = [
      shellCacheName(SCOPE, '1.3.0-a'),
      current,
      shellCacheName(SCOPE, '1.4.0-a'),
      shellCacheName(OTHER, '1.4.0-a'),
      shellCacheName(OTHER, '1.5.0-c'),
      shellCacheName(`${SCOPE}next/`, '1.5.0-c'),
      'gizecat-shell-1.4.0-c7a2cb344d77f7e8',
      'other-app-v1',
      'workbox-precache-v2',
      'gizecat-other',
    ];
    expect(staleCaches(names, SCOPE, current)).toEqual([shellCacheName(SCOPE, '1.3.0-a'), shellCacheName(SCOPE, '1.4.0-a')]);
    expect(staleCaches([current], SCOPE, current)).toEqual([]);
    // Two copies on one origin activating in turn keep each other's current cache.
    const otherCurrent = shellCacheName(OTHER, '1.5.0-c');
    expect(staleCaches([current, otherCurrent], SCOPE, current)).toEqual([]);
    expect(staleCaches([current, otherCurrent], OTHER, otherCurrent)).toEqual([]);
  });
});

describe('redirected responses', () => {
  it('rebuilds a redirected response with the same body, status and headers, and no redirect', async () => {
    const original = new Response('<!doctype html><title>GizeCat</title>', {
      status: 200,
      statusText: 'OK',
      headers: { 'content-type': 'text/html; charset=utf-8', 'x-host': 'pages' },
    });
    // A Response cannot be constructed as redirected; the flag is what withoutRedirect reads.
    Object.defineProperty(original, 'redirected', { value: true });
    expect(original.redirected).toBe(true);
    const clean = withoutRedirect(original);
    expect(clean).not.toBe(original);
    expect(clean.redirected).toBe(false);
    expect(clean.status).toBe(200);
    expect(clean.statusText).toBe('OK');
    expect(clean.headers.get('content-type')).toBe('text/html; charset=utf-8');
    expect(clean.headers.get('x-host')).toBe('pages');
    expect(await clean.text()).toBe('<!doctype html><title>GizeCat</title>');
  });

  it('returns any other response as it is', () => {
    const plain = new Response('x', { status: 200 });
    expect(withoutRedirect(plain)).toBe(plain);
  });
});
