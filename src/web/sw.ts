// GizeCat's service worker (1.4.0), built by scripts/build.mjs into out/web/sw.js (a classic
// script, IIFE). It makes the installed app start offline: on install it caches the app's own files
// (the list and the version are compiled in, so sw.js changes byte for byte whenever any file
// changes); afterwards loads of the app's page and those files come from the cache, falling back to
// the network. Nothing else is cached or touched: no runtime caching, no messages, no requests of
// its own after install except the browser's update checks of sw.js. Decisions are in swCore.ts
// (unit-tested).
//
// Type-checked with the DOM lib (no WebWorker tsconfig): the worker global is described
// structurally and cast from `self`.
import { routeRequest, shellCacheName, staleCaches, withoutRedirect } from './swCore';

declare const __SHELL_VERSION__: string;
declare const __SHELL_FILES__: readonly string[];

interface ExtendableEventLike {
  waitUntil(p: Promise<unknown>): void;
}
interface FetchEventLike extends ExtendableEventLike {
  readonly request: Request;
  respondWith(r: Promise<Response>): void;
}
interface ServiceWorkerGlobalLike {
  readonly registration: { readonly scope: string };
  skipWaiting(): Promise<void>;
  readonly clients: { claim(): Promise<void> };
  addEventListener(type: 'install' | 'activate', listener: (e: ExtendableEventLike) => void): void;
  addEventListener(type: 'fetch', listener: (e: FetchEventLike) => void): void;
}

const sw = self as unknown as ServiceWorkerGlobalLike;
const FILES: readonly string[] = __SHELL_FILES__;
// The scope is in the name: CacheStorage is shared per origin, and two copies at different paths
// must not delete each other's caches on activation.
const CACHE = shellCacheName(sw.registration.scope, __SHELL_VERSION__);

/**
 * Fetches every shell file and stores it, failing the install when any file fails (as
 * cache.addAll does). A redirected response (a host that redirects /index.html to /) is stored as
 * a clean copy, so it can later answer a navigation.
 */
async function precache(): Promise<void> {
  const cache = await caches.open(CACHE);
  const fetched = await Promise.all(
    FILES.map(async (f) => {
      // cache: 'reload' skips the HTTP cache, so a new version never precaches an old file.
      const request = new Request(f, { cache: 'reload' });
      const response = await fetch(request);
      if (!response.ok) throw new Error(`precache: ${f} answered HTTP ${response.status}`);
      return { request, response: withoutRedirect(response) };
    }),
  );
  await Promise.all(fetched.map(({ request, response }) => cache.put(request, response)));
}

sw.addEventListener('install', (e) => {
  e.waitUntil(
    (async () => {
      await precache();
      await sw.skipWaiting();
    })(),
  );
});

sw.addEventListener('activate', (e) => {
  e.waitUntil(
    (async () => {
      const names = await caches.keys();
      await Promise.all(staleCaches(names, sw.registration.scope, CACHE).map((n) => caches.delete(n)));
      await sw.clients.claim();
    })(),
  );
});

async function fromShell(key: string, request: Request): Promise<Response> {
  try {
    const cache = await caches.open(CACHE);
    const hit = await cache.match(new URL(key, sw.registration.scope).href);
    // Never a redirected response: as the answer to a navigation it would be a network error.
    if (hit) return withoutRedirect(hit);
  } catch {
    // A broken cache is the same as a missing file: the network answers.
  }
  return fetch(request);
}

sw.addEventListener('fetch', (e) => {
  const req = e.request;
  const route = routeRequest({ method: req.method, url: req.url, mode: req.mode }, sw.registration.scope, FILES);
  if (route.kind === 'pass') return;
  e.respondWith(fromShell(route.kind === 'navigate' ? 'index.html' : route.key, req));
});
