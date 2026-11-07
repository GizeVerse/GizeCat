// The service worker's decisions (src/web/swCore.ts): what it answers from its cache and which
// caches it deletes. Pure: requests are plain objects.
import { describe, expect, it } from 'vitest';
import { routeRequest, SHELL_CACHE_PREFIX, shellCacheName, staleCaches } from '../../../src/web/swCore';

const FILES = ['index.html', 'main.js', 'web.css', 'manifest.webmanifest', 'icons/icon-192.png'];
const SCOPE = 'https://example.test/gizecat/';
const get = (url: string, mode = 'no-cors') => ({ method: 'GET', url, mode });

describe('service worker routing', () => {
  it('answers page loads inside the scope with the shell (index.html)', () => {
    expect(routeRequest(get(SCOPE, 'navigate'), SCOPE, FILES)).toEqual({ kind: 'navigate' });
    expect(routeRequest(get(`${SCOPE}index.html?x=1`, 'navigate'), SCOPE, FILES)).toEqual({ kind: 'navigate' });
  });

  it('answers the shell files from the cache, by their path relative to the scope', () => {
    expect(routeRequest(get(`${SCOPE}main.js`), SCOPE, FILES)).toEqual({ kind: 'shell', key: 'main.js' });
    expect(routeRequest(get(`${SCOPE}icons/icon-192.png`), SCOPE, FILES)).toEqual({ kind: 'shell', key: 'icons/icon-192.png' });
    expect(routeRequest(get(SCOPE), SCOPE, FILES)).toEqual({ kind: 'shell', key: 'index.html' });
  });

  it('passes everything else through: other methods, origins, paths outside the scope, files not in the shell', () => {
    const pass = { kind: 'pass' };
    expect(routeRequest({ method: 'POST', url: `${SCOPE}main.js`, mode: 'cors' }, SCOPE, FILES)).toEqual(pass);
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
  it('names each shell version under the app prefix', () => {
    expect(shellCacheName('1.4.0-abcdef0123456789')).toBe('gizecat-shell-1.4.0-abcdef0123456789');
    expect(shellCacheName('x').startsWith(SHELL_CACHE_PREFIX)).toBe(true);
  });

  it('deletes only its own older caches, never another app on the same origin', () => {
    const current = shellCacheName('1.4.0-b');
    const names = [shellCacheName('1.3.0-a'), current, shellCacheName('1.4.0-a'), 'other-app-v1', 'workbox-precache-v2', 'gizecat-other'];
    expect(staleCaches(names, current)).toEqual([shellCacheName('1.3.0-a'), shellCacheName('1.4.0-a')]);
    expect(staleCaches([current], current)).toEqual([]);
  });
});
